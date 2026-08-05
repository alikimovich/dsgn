import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorState, type Extension, StateEffect, StateField } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, keymap } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import { svelte } from '@replit/codemirror-lang-svelte'
import { basicSetup } from 'codemirror'
import { ChevronLeft, ChevronRight, Save, SquareArrowOutUpRight, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { SourceView } from '../../../shared/api'
import { useCodeDrawer, usePanelInset } from '../store'
import { zedSearch } from './editor-search'
import FileTreePanel from './FileTreePanel'

/** Default (collapsed) height of the drawer + the native-preview strip it reserves. */
const DRAWER_H = 300
/** Smallest the drawer can be dragged down to (still shows a couple of lines + chrome). */
const MIN_DRAWER_H = 120
/** Slice of preview kept visible when the drawer is dragged tall (so it isn't hidden). */
const MIN_PREVIEW = 160
/** Hard ceiling on the drawer: it may never grow past this share of the window height. */
const MAX_VIEWPORT_FRACTION = 0.8

/** Pop-out file-tree sidebar: default/min/max width (drag its right edge) + persistence key. */
const TREE_W_DEFAULT = 224
const TREE_W_MIN = 160
const TREE_W_MAX = 520
const TREE_W_KEY = 'praxis.editorTreeWidth'

/** Clamp the drawer height to [MIN_DRAWER_H, cap]. */
function clampHeight(h: number, cap: number): number {
  return Math.max(MIN_DRAWER_H, Math.min(h, cap))
}

/** Clamp the sidebar width to [TREE_W_MIN, TREE_W_MAX]. */
function clampTreeW(w: number): number {
  return Math.max(TREE_W_MIN, Math.min(w, TREE_W_MAX))
}

/** CodeMirror language extension for a file, by extension (empty = plain text). */
function langFor(file: string): Extension[] {
  const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase()
  if (ext === 'ts' || ext === 'tsx') return [javascript({ typescript: true, jsx: ext === 'tsx' })]
  if (ext === 'jsx') return [javascript({ jsx: true })]
  if (ext === 'js' || ext === 'mjs' || ext === 'cjs') return [javascript()]
  // Svelte needs its own grammar: approximating it with HTML breaks on Svelte
  // expressions — e.g. an {@html `<script …>…<\/script>`} template literal reads
  // as a real, never-closed script tag, and the rest of the file tokenizes as JS.
  if (ext === 'svelte') return [svelte()]
  if (ext === 'vue' || ext === 'html') return [html()]
  if (ext === 'css') return [css()]
  return []
}

// Editor chrome painted from the app's own design tokens (via CSS custom
// properties), so the drawer matches the surrounding surfaces and flips with the
// light/dark theme automatically — no separate CodeMirror dark theme to drift.
const praxisTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '12px',
    backgroundColor: 'var(--background)',
    color: 'var(--foreground)'
  },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    lineHeight: '1.6'
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--muted-foreground)',
    border: 'none'
  },
  '.cm-activeLine': { backgroundColor: 'color-mix(in oklab, var(--muted) 55%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--foreground)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--foreground)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'color-mix(in oklab, var(--primary) 22%, transparent)'
  },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in oklab, var(--primary) 14%, transparent)' }
})

// Syntax palette matched 1:1 to the highlight.js theme in styles.css (the same
// colors the chat's markdown code blocks use), so every code surface in the app
// reads the same. Tags left unmapped fall back to the plain foreground color.
const praxisHighlight = HighlightStyle.define([
  {
    tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
    color: '#8a8a8a',
    fontStyle: 'italic'
  },
  {
    tag: [
      t.keyword,
      t.moduleKeyword,
      t.controlKeyword,
      t.operatorKeyword,
      t.definitionKeyword,
      t.modifier,
      t.self
    ],
    color: '#a626a4'
  },
  // Quoted literals only — strings, regexes, and the *values* of HTML attributes.
  { tag: [t.string, t.special(t.string), t.regexp, t.attributeValue], color: '#50a14f' },
  // Attribute names read as their own token (atom-one-light `.hljs-attr`), not
  // fused into the green of the value they precede.
  { tag: [t.attributeName], color: '#986801' },
  { tag: [t.number, t.bool, t.atom, t.null], color: '#b76b01' },
  {
    tag: [
      t.function(t.variableName),
      t.function(t.propertyName),
      t.definition(t.function(t.variableName))
    ],
    color: '#4078f2'
  },
  { tag: [t.typeName, t.className], color: '#c18401' },
  // HTML/JSX/Svelte tag names — the element the user is inspecting (<div>, <h1>).
  // Without this they fall through to the type color and read like a class name.
  { tag: [t.tagName], color: '#e45649' }
])

const stampLine = Decoration.line({ class: 'cm-stamp-line' })

/** Line decorations for the stamped element's [start, end] span (1-based, inclusive). */
function stampDeco(doc: EditorState['doc'], start: number, end: number): DecorationSet {
  const marks = []
  for (let ln = start; ln <= end; ln++) {
    if (ln >= 1 && ln <= doc.lines) marks.push(stampLine.range(doc.line(ln).from))
  }
  return Decoration.set(marks)
}

/**
 * v9 phase 2 — the editable code drawer. CodeMirror 6 mounted under the preview
 * (a DOM panel can't float over the native WebContentsView, so PreviewPane
 * shrinks the native view's height by the drawer height via usePanelInset and the
 * drawer fills the freed strip). The whole file is loaded, scrolled to the stamped
 * element with its line span highlighted; Cmd+S saves through source.write →
 * commitEdit, so undo/redo, on-disk conflict detection, and HMR all come for free.
 * Drag the top edge to resize (up to a MIN_PREVIEW strip of live preview), and
 * "open in editor" jumps to the file in the user's own editor.
 */
export default function CodeDrawer({
  root,
  source,
  onClose,
  variant = 'drawer'
}: {
  root: string
  source: string
  onClose: () => void
  /** 'drawer' = docked strip under the preview; 'window' = fills a pop-out window. */
  variant?: 'drawer' | 'window'
}): React.JSX.Element {
  // In 'window' mode the editor owns a whole native window: it fills the viewport,
  // reserves no preview inset, and drops the drawer-only resize handle. The native
  // title bar handles resizing and dragging.
  const isWindow = variant === 'window'
  const rootRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  // Window-level listeners installed per editor build (cmd-link affordance).
  const cleanupRef = useRef<() => void>(() => {})
  // The file content as last read from / written to disk — the save baseline and
  // the dirty comparison. A ref so the save keybinding always sees the latest.
  const baselineRef = useRef<string>('')
  const [meta, setMeta] = useState<{ file: string; line: number } | null>(null)
  const [dirty, setDirty] = useState(false)
  const [status, setStatus] = useState<'idle' | 'saving' | 'conflict' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)
  // Pop-out only: the file-tree sidebar width, drag-adjustable and persisted.
  const [treeWidth, setTreeWidth] = useState(() => {
    if (typeof window === 'undefined') return TREE_W_DEFAULT
    const saved = Number(window.localStorage.getItem(TREE_W_KEY))
    return Number.isFinite(saved) && saved > 0 ? clampTreeW(saved) : TREE_W_DEFAULT
  })
  // Explicit height set by dragging the top edge. null = follow expand/collapse.
  // Stored unclamped; the render-time clamp keeps it inside the live bounds so a
  // window/container resize can't strand it out of range.
  const [dragHeight, setDragHeight] = useState<number | null>(null)
  // Cmd+click jump history (browser semantics) — lives in the drawer store.
  const navIndex = useCodeDrawer((s) => s.index)
  const navLen = useCodeDrawer((s) => s.stack.length)
  // Height of the drawer's positioning container (.previewcard__body), tracked so
  // "expand" can fill it while leaving a MIN_PREVIEW strip of native preview above.
  const [containerH, setContainerH] = useState(0)
  // Window height, tracked so the 80%-of-viewport ceiling follows resizes.
  const [viewportH, setViewportH] = useState(() =>
    typeof window === 'undefined' ? 0 : window.innerHeight
  )

  useEffect(() => {
    const el = rootRef.current?.offsetParent as HTMLElement | null
    if (!el) return undefined
    const update = (): void => setContainerH(el.clientHeight)
    update()
    let ro: ResizeObserver | undefined
    try {
      ro = new ResizeObserver(update)
      ro.observe(el)
    } catch {
      /* no ResizeObserver (tests) — the one-shot read above still applies */
    }
    return () => ro?.disconnect()
  }, [])

  useEffect(() => {
    const onResize = (): void => setViewportH(window.innerHeight)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // The tallest the drawer may get: never past 80% of the window, and never so
  // tall it hides the whole preview (leave a MIN_PREVIEW strip when we know the
  // container size).
  const maxHeight = Math.max(
    MIN_DRAWER_H,
    Math.min(
      viewportH > 0 ? viewportH * MAX_VIEWPORT_FRACTION : Infinity,
      containerH > 0 ? containerH - MIN_PREVIEW : Infinity
    )
  )
  const height =
    dragHeight != null ? clampHeight(dragHeight, maxHeight) : Math.min(DRAWER_H, maxHeight)

  // Reserve the bottom strip of the native preview for as long as the drawer is
  // open, tracking its current (drag-adjusted) height. A pop-out window owns its
  // own native surface, so it reserves nothing.
  useEffect(() => {
    if (isWindow) return undefined
    usePanelInset.getState().setBottom(height)
    return () => usePanelInset.getState().setBottom(0)
  }, [height, isWindow])

  // A ref-indirected save so the CodeMirror keymap (built once) always runs the
  // current closure.
  const saveRef = useRef<() => void>(() => {})
  const save = async (): Promise<void> => {
    const view = viewRef.current
    if (!view) return
    const content = view.state.doc.toString()
    if (content === baselineRef.current) return
    setStatus('saving')
    setErrorMsg(null)
    const res = await window.api.source.write(root, source, baselineRef.current, content)
    if (res.ok) {
      baselineRef.current = content
      setDirty(false)
      setStatus('idle')
    } else if (res.conflict) {
      setStatus('conflict')
    } else {
      setStatus('error')
      setErrorMsg(res.error ?? 'Could not save.')
    }
  }
  saveRef.current = () => void save()

  const openEditor = async (): Promise<void> => {
    setOpenError(null)
    const res = await window.api.source.openInEditor(root, source)
    if (!res.ok) setOpenError(res.error ?? 'Could not open an editor.')
  }

  // Pop the drawer out into its own window showing the same file, then close the
  // docked drawer (the window takes over). No-op in the already-popped window.
  const popOut = (): void => {
    void window.api.source.popout(root, source)
    onClose()
  }

  // Build the editor once the file is read. Re-runs when the selected source
  // changes (picking a different element while the drawer is open).
  useEffect(() => {
    let disposed = false
    setMeta(null)
    setDirty(false)
    setStatus('idle')
    setErrorMsg(null)
    setOpenError(null)
    cleanupRef.current()
    cleanupRef.current = () => {}
    viewRef.current?.destroy()
    viewRef.current = null

    window.api.source.read(root, source).then((view: SourceView | null) => {
      if (disposed || !hostRef.current) return
      if (!view) {
        setStatus('error')
        setErrorMsg('Could not read the source file.')
        return
      }
      baselineRef.current = view.code
      setMeta({ file: view.file, line: view.line })

      const start = view.elementStart ?? view.line
      const end = Math.max(view.elementEnd ?? start, start)
      const stampField = StateField.define<DecorationSet>({
        create: (state) => stampDeco(state.doc, start, end),
        update: (deco, tr) => (tr.docChanged ? deco.map(tr.changes) : deco),
        provide: (f) => EditorView.decorations.from(f)
      })

      // Cmd+hover/click affordance: while ⌘ is held over a capitalized
      // identifier that RESOLVES to a component file, underline it and show a
      // pointer (VSCode-style); click jumps there. Resolutions are cached per
      // name for this file.
      const linkMark = Decoration.mark({ class: 'cm-cmdlink' })
      const setLink = StateEffect.define<{ from: number; to: number } | null>()
      const linkField = StateField.define<DecorationSet>({
        create: () => Decoration.none,
        update: (deco, tr) => {
          for (const e of tr.effects) {
            if (e.is(setLink)) {
              return e.value
                ? Decoration.set([linkMark.range(e.value.from, e.value.to)])
                : Decoration.none
            }
          }
          return tr.docChanged ? Decoration.none : deco
        },
        provide: (f) => EditorView.decorations.from(f)
      })
      const resolveCache = new Map<string, string | null>()
      let linkShown: { from: number; to: number } | null = null
      const clearLink = (v: EditorView): void => {
        if (linkShown) {
          linkShown = null
          v.dispatch({ effects: setLink.of(null) })
        }
      }
      const resolveName = (name: string): Promise<string | null> => {
        const hit = resolveCache.get(name)
        if (hit !== undefined) return Promise.resolve(hit)
        return window.api.source.resolveComponent(root, view.file, name).then((file) => {
          resolveCache.set(name, file)
          return file
        })
      }
      const wordAtEvent = (
        v: EditorView,
        e: MouseEvent
      ): { from: number; to: number; name: string } | null => {
        const pos = v.posAtCoords({ x: e.clientX, y: e.clientY })
        if (pos == null) return null
        const word = v.state.wordAt(pos)
        if (!word) return null
        const name = v.state.doc.sliceString(word.from, word.to)
        return /^[A-Z][A-Za-z0-9_$]*$/.test(name) ? { from: word.from, to: word.to, name } : null
      }

      const state = EditorState.create({
        doc: view.code,
        extensions: [
          // Zed-style search panel — must come with basicSetup, which brings the
          // searchKeymap (⌘F) but leaves the panel to the facet default.
          zedSearch(),
          basicSetup,
          ...langFor(view.file),
          stampField,
          linkField,
          // Cmd+click a capitalized tag/identifier (<Workplace …/>) → resolve it
          // through this file's imports and open that component in the drawer.
          EditorView.domEventHandlers({
            mousedown: (e, v) => {
              if (!(e.metaKey || e.ctrlKey) || e.button !== 0) return false
              const w = wordAtEvent(v, e)
              if (!w) return false
              e.preventDefault()
              void resolveName(w.name).then((file) => {
                if (file) useCodeDrawer.getState().open(`${file}:1`)
              })
              return true
            },
            mousemove: (e, v) => {
              if (!e.metaKey && !e.ctrlKey) {
                clearLink(v)
                return false
              }
              const w = wordAtEvent(v, e)
              if (!w) {
                clearLink(v)
                return false
              }
              void resolveName(w.name).then((file) => {
                // Only decorate once the name is KNOWN to resolve, and only if
                // this is still the hovered word.
                if (!file) {
                  if (linkShown && linkShown.from === w.from) clearLink(v)
                  return
                }
                if (linkShown?.from === w.from && linkShown?.to === w.to) return
                linkShown = { from: w.from, to: w.to }
                v.dispatch({ effects: setLink.of(linkShown) })
              })
              return false
            }
          }),
          keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => (saveRef.current(), true) }]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) setDirty(u.state.doc.toString() !== baselineRef.current)
          }),
          praxisTheme,
          syntaxHighlighting(praxisHighlight)
        ]
      })
      const editor = new EditorView({ state, parent: hostRef.current })
      viewRef.current = editor
      const dropLink = (e?: KeyboardEvent): void => {
        if (e && e.key !== 'Meta' && e.key !== 'Control') return
        clearLink(editor)
      }
      const dropOnBlur = (): void => clearLink(editor)
      window.addEventListener('keyup', dropLink)
      window.addEventListener('blur', dropOnBlur)
      cleanupRef.current = () => {
        window.removeEventListener('keyup', dropLink)
        window.removeEventListener('blur', dropOnBlur)
      }

      // Park the stamped element a third of the way down the viewport.
      const pos = editor.state.doc.line(Math.min(start, editor.state.doc.lines)).from
      editor.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 60 })
      })
      editor.focus()
    })

    return () => {
      disposed = true
      cleanupRef.current()
      cleanupRef.current = () => {}
      viewRef.current?.destroy()
      viewRef.current = null
    }
  }, [root, source])

  // Reload from disk after a conflict (or to discard local edits), re-baselining.
  const reload = async (): Promise<void> => {
    const view = viewRef.current
    if (!view) return
    const fresh = await window.api.source.read(root, source)
    if (!fresh) return
    baselineRef.current = fresh.code
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: fresh.code } })
    setDirty(false)
    setStatus('idle')
    setErrorMsg(null)
  }

  // Drag the top edge to resize. Height is captured at drag start and updated by
  // the pointer's vertical delta (up = taller); the render-time clamp enforces the
  // MIN_DRAWER_H..80%-of-viewport bounds. Listeners live on window so the drag
  // survives the pointer leaving the thin handle.
  const startDrag = (e: React.PointerEvent): void => {
    e.preventDefault()
    const startY = e.clientY
    const startH = height
    const onMove = (ev: PointerEvent): void => setDragHeight(startH + (startY - ev.clientY))
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'ns-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  // Keyboard resize for the handle (Up/Down grow/shrink; browser convention).
  const nudge = (delta: number): void => {
    setDragHeight(clampHeight((dragHeight ?? height) + delta, maxHeight))
  }

  // Pop-out: drag the divider to resize the file tree. Width is captured at drag
  // start, updated by the pointer's horizontal delta, and persisted on release.
  const startTreeDrag = (e: React.PointerEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startW = treeWidth
    let last = startW
    const onMove = (ev: PointerEvent): void => {
      last = clampTreeW(startW + (ev.clientX - startX))
      setTreeWidth(last)
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.localStorage.setItem(TREE_W_KEY, String(last))
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  // Keyboard resize for the tree divider (Left/Right shrink/grow); persist after.
  const nudgeTree = (delta: number): void => {
    setTreeWidth((w) => {
      const next = clampTreeW(w + delta)
      window.localStorage.setItem(TREE_W_KEY, String(next))
      return next
    })
  }

  const isMac = typeof navigator !== 'undefined' && navigator.platform.startsWith('Mac')
  return (
    <div
      ref={rootRef}
      className={
        isWindow
          ? 'codedrawer codedrawer--window flex h-screen bg-background'
          : 'codedrawer absolute inset-x-0 bottom-0 z-50 flex flex-col rounded-t-2xl border-t bg-background shadow-[0_-4px_18px_rgba(0,0,0,0.08)]'
      }
      style={isWindow ? undefined : { height }}
      aria-label="Code editor"
    >
      {/* Drag-to-resize handle straddling the top border (docked drawer only). */}
      {!isWindow && (
        <div
          className="codedrawer__resize absolute inset-x-0 -top-1 z-10 h-2 cursor-ns-resize"
          onPointerDown={startDrag}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp') e.preventDefault(), nudge(24)
            else if (e.key === 'ArrowDown') e.preventDefault(), nudge(-24)
          }}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize code editor"
          tabIndex={0}
        />
      )}
      {/* Pop-out only: the file-tree sidebar. On macOS the traffic lights float
          over its top-left, so a draggable spacer clears them (the header no
          longer needs to reserve room for them). */}
      {isWindow && (
        <>
          <aside
            className="codedrawer__tree flex shrink-0 flex-col bg-background"
            style={{ width: treeWidth }}
          >
            {isMac && (
              <div
                className="h-9 shrink-0"
                style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
              />
            )}
            <FileTreePanel root={root} />
          </aside>
          {/* Drag the divider to resize the tree; the 1px line is the seam and the
              wider hit area (with hover tint) makes it easy to grab. */}
          <div
            className="codedrawer__treeresize group relative w-1 shrink-0 cursor-col-resize border-r"
            onPointerDown={startTreeDrag}
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft') e.preventDefault(), nudgeTree(-24)
              else if (e.key === 'ArrowRight') e.preventDefault(), nudgeTree(24)
            }}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize file tree"
            aria-valuenow={Math.round(treeWidth)}
            aria-valuemin={TREE_W_MIN}
            aria-valuemax={TREE_W_MAX}
            tabIndex={0}
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <span className="absolute inset-y-0 -left-1 -right-1 group-hover:bg-accent/40" />
          </div>
        </>
      )}
      <div className="codedrawer__main flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="codedrawer__head flex items-center gap-2 border-b py-1.5 pl-3 pr-3">
          {/* Cmd+click jumps build history — navigate it like a browser. */}
          <Button
            variant="ghost"
            size="icon"
            className="codedrawer__back size-6 text-muted-foreground"
            onClick={() => useCodeDrawer.getState().back()}
            disabled={navIndex <= 0}
            aria-label="Back"
            title="Back"
          >
            <ChevronLeft className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="codedrawer__fwd -ml-1.5 size-6 text-muted-foreground"
            onClick={() => useCodeDrawer.getState().forward()}
            disabled={navIndex >= navLen - 1}
            aria-label="Forward"
            title="Forward"
          >
            <ChevronRight className="size-3.5" />
          </Button>
          <span
            className="codedrawer__file min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[11.5px] text-muted-foreground"
            style={isWindow ? ({ WebkitAppRegion: 'drag' } as React.CSSProperties) : undefined}
          >
            {meta ? `${meta.file}:${meta.line}` : 'Loading…'}
            {dirty && (
              <span className="codedrawer__dirty ml-1.5 text-amber-600" title="Unsaved changes">
                ●
              </span>
            )}
          </span>
          {status === 'conflict' && (
            <span className="codedrawer__conflict flex items-center gap-1.5 text-[11px] text-amber-700">
              File changed on disk.
              <button className="underline underline-offset-2" onClick={() => void reload()}>
                Reload
              </button>
            </span>
          )}
          {status === 'error' && errorMsg && (
            <span className="codedrawer__error text-[11px] text-red-700">{errorMsg}</span>
          )}
          {openError && (
            <span className="codedrawer__openerror text-[11px] text-amber-700">{openError}</span>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="codedrawer__open h-6 px-2 text-[11.5px] text-muted-foreground"
            onClick={() => void openEditor()}
            title="Open this file in your IDE"
          >
            IDE
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="codedrawer__save size-6"
            onClick={() => void save()}
            disabled={!dirty || status === 'saving'}
            aria-label={status === 'saving' ? 'Saving…' : 'Save'}
            title={status === 'saving' ? 'Saving…' : 'Save (⌘S)'}
          >
            <Save className="size-3.5" />
          </Button>
          {!isWindow && (
            <Button
              variant="ghost"
              size="icon"
              className="codedrawer__popout size-6"
              onClick={popOut}
              aria-label="Open code editor in a separate window"
              title="Pop out into its own window"
            >
              <SquareArrowOutUpRight className="size-3.5" />
            </Button>
          )}
          {/* Pop-out window closes via its native traffic lights, so only the
            docked drawer needs an explicit close button. */}
          {!isWindow && (
            <Button
              variant="ghost"
              size="icon"
              className="codedrawer__close size-6"
              onClick={onClose}
              aria-label="Close code editor"
            >
              <X className="size-3.5" />
            </Button>
          )}
        </div>
        <div
          ref={hostRef}
          className="codedrawer__editor min-h-0 flex-1 overflow-hidden text-[12px]"
        />
      </div>
    </div>
  )
}
