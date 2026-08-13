import { FileTree } from '@pierre/trees'
import { FilePlus, Pencil, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useCodeDrawer } from '../store'

/**
 * The pop-out editor's left sidebar: a `@pierre/trees` file tree of the project.
 * Clicking a file opens it in the code drawer (shared `useCodeDrawer` store), so
 * Cmd+click navigation and back/forward keep working. The vanilla (non-React)
 * entry is used deliberately — it renders into its own shadow root via Preact and
 * is decoupled from the renderer's React 18, sidestepping the package's React 19
 * peer requirement.
 *
 * The tree keys on plain repo-relative paths; the drawer's source is `path:line`,
 * so we bridge the two by stripping / appending the line suffix.
 *
 * It's also a small file MANAGER: new file, rename, delete (`source:create-file`
 * / `rename-file` / `delete-file`). The tree widget owns its own shadow DOM, so
 * none of that chrome lives inside it — the toolbar and the name field sit above
 * the tree in our own React, and each successful op rebuilds the tree from a
 * fresh `source:tree` listing (the widget has no incremental add/remove we can
 * rely on) and re-selects the path the op landed on.
 */

/** Drop the ":line[:col]" suffix from a drawer source to get its file path. */
function sourceToPath(source: string | null): string | null {
  if (!source) return null
  const m = /^(.*?):\d+(?::\d+)?$/.exec(source)
  return m ? m[1] : source
}

/** Everything before the last "/" (inclusive), i.e. the path's directory prefix. */
function dirPrefix(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i + 1)
}

/**
 * The deepest focused element, descending through shadow roots — `activeElement`
 * on the document only ever reports the shadow HOST. Used to tell "double-clicked
 * a row" from "double-clicked inside the tree's own search box".
 */
function deepActiveElement(): Element | null {
  let el: Element | null = document.activeElement
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement
  return el
}

/**
 * How long after a real pointer press a selection callback still counts as that
 * click. Selecting the already-open file is otherwise indistinguishable from the
 * programmatic mirror-select below (Cmd+click navigation, back/forward), and only
 * the user's click should open the rename field.
 */
const CLICK_WINDOW_MS = 600

/** What the name field is being used for: a new file, or renaming an existing one. */
interface Draft {
  /**
   * Identity of this editing session, bumped only when the field OPENS. Typing
   * replaces the whole Draft object, so the focus/select effect has to key on
   * something that survives a keystroke or it would re-select the text — and
   * fight the caret — on every character.
   */
  id: number
  mode: 'create' | 'rename'
  /** The path being renamed (rename only). */
  from?: string
  value: string
}

export default function FileTreePanel({ root }: { root: string }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const treeRef = useRef<FileTree | null>(null)
  // Selected paths that are files (not synthesized directories) — the set the
  // tree was built from, used to ignore directory clicks in onSelectionChange.
  const filesRef = useRef<Set<string>>(new Set())
  // Timestamp of the last pointer press inside the tree (see CLICK_WINDOW_MS).
  const pointerAtRef = useRef(0)
  // Path to select once the tree finishes rebuilding after a file op.
  const pendingSelectRef = useRef<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const source = useCodeDrawer((s) => s.source)

  const [files, setFiles] = useState<Set<string>>(new Set())
  const [draft, setDraft] = useState<Draft | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusyState] = useState(false)
  // Mirrored into a ref so the name field's blur-to-cancel can tell "the user
  // clicked away" from "we disabled/replaced things mid-op" without depending on
  // which render's handler happened to be attached when focus left.
  const busyRef = useRef(false)
  const setBusy = (v: boolean): void => {
    busyRef.current = v
    setBusyState(v)
  }
  // Bumped after every successful op to rebuild the tree from a fresh listing.
  const [version, setVersion] = useState(0)

  const openPath = sourceToPath(source)
  // The file the toolbar acts on: whatever the drawer currently shows, as long as
  // it's still in the tree. Clicking a file opens it, so "open" IS "selected".
  const selected = openPath && files.has(openPath) ? openPath : null

  const draftIdRef = useRef(0)
  const startRename = useCallback((path: string) => {
    setError(null)
    setConfirmDelete(null)
    setDraft({ id: ++draftIdRef.current, mode: 'rename', from: path, value: path })
  }, [])

  // Build the tree once per project root — and again after each file op.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` is the reload key — bumping it is how a file op rebuilds the tree.
  useEffect(() => {
    let disposed = false
    let tree: FileTree | null = null

    void window.api.source.tree(root).then((paths) => {
      if (disposed || !hostRef.current) return
      filesRef.current = new Set(paths)
      setFiles(filesRef.current)
      tree = new FileTree({
        paths,
        // Fully expand small projects; keep large ones tidy (one level deep).
        initialExpansion: paths.length > 300 ? 1 : 'open',
        flattenEmptyDirectories: true,
        search: true,
        onSelectionChange: (selectedPaths) => {
          const path = selectedPaths[selectedPaths.length - 1]
          // Only files open; directory selections are ignored.
          if (!path || !filesRef.current.has(path)) return
          if (path === sourceToPath(useCodeDrawer.getState().source)) {
            // Re-selecting the file that's already open. From a real click that's
            // the second click of Finder's click-then-click → rename; from our own
            // programmatic mirror-select (below) it's just an echo, so ignore it.
            if (Date.now() - pointerAtRef.current < CLICK_WINDOW_MS) startRename(path)
            return
          }
          useCodeDrawer.getState().open(`${path}:1`)
        }
      })
      tree.render({ containerWrapper: hostRef.current })
      treeRef.current = tree
      // Reflect the file this rebuild is meant to land on (the one just created
      // or renamed), else whatever is already open in the drawer.
      const pending = pendingSelectRef.current
      pendingSelectRef.current = null
      const cur = pending ?? sourceToPath(useCodeDrawer.getState().source)
      if (cur && filesRef.current.has(cur)) {
        tree.getItem(cur)?.select()
        tree.scrollToPath(cur, { focus: false })
      }
    })

    return () => {
      disposed = true
      treeRef.current = null
      tree?.cleanUp()
    }
  }, [root, version, startRename])

  // Mirror drawer → tree selection when the open file changes elsewhere (Cmd+click
  // navigation, back/forward). The onSelectionChange guard above breaks the loop.
  useEffect(() => {
    const tree = treeRef.current
    const path = sourceToPath(source)
    if (!tree || !path || !filesRef.current.has(path)) return
    if (tree.getSelectedPaths().includes(path)) return
    tree.getItem(path)?.select()
    tree.scrollToPath(path, { focus: false })
  }, [source])

  // Pointer/double-click bookkeeping on the tree host. Both events are composed,
  // so they cross the widget's shadow boundary and bubble to us; nothing here
  // needs to know the widget's internal DOM.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const onPointerDown = (): void => {
      pointerAtRef.current = Date.now()
    }
    // Fallback for the second click when the widget doesn't re-fire a selection
    // change for an already-selected row: a double-click renames the open file.
    const onDoubleClick = (): void => {
      const tag = deepActiveElement()?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return // the tree's own search box
      const path = sourceToPath(useCodeDrawer.getState().source)
      if (path && filesRef.current.has(path)) startRename(path)
    }
    host.addEventListener('pointerdown', onPointerDown)
    host.addEventListener('dblclick', onDoubleClick)
    return () => {
      host.removeEventListener('pointerdown', onPointerDown)
      host.removeEventListener('dblclick', onDoubleClick)
    }
  }, [startRename])

  // Focus the name field when it OPENS (keyed on the draft id, not its value —
  // see Draft.id), with the basename's stem pre-selected, so typing replaces
  // "Button" in "src/Button.tsx" but keeps the directory and the extension.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the draft id alone by design; the current text is read off the element.
  useEffect(() => {
    const el = inputRef.current
    if (!draft || !el) return
    el.focus()
    const text = el.value
    const start = text.lastIndexOf('/') + 1
    const dot = text.lastIndexOf('.')
    el.setSelectionRange(start, dot > start ? dot : text.length)
  }, [draft?.id])

  const startCreate = (): void => {
    setError(null)
    setConfirmDelete(null)
    // Seed with the selected file's directory so "new file next to this one" is
    // one word of typing.
    setDraft({
      id: ++draftIdRef.current,
      mode: 'create',
      value: selected ? dirPrefix(selected) : ''
    })
  }

  /** Reload the tree and land on `path` (the file the op created/renamed). */
  const reloadOnto = (path: string | undefined): void => {
    pendingSelectRef.current = path ?? null
    setVersion((v) => v + 1)
  }

  const submitDraft = async (): Promise<void> => {
    if (!draft || busy) return
    const value = draft.value.trim()
    if (!value || value.endsWith('/')) {
      setError('Enter a file name.')
      return
    }
    if (draft.mode === 'rename' && value === draft.from) {
      setDraft(null)
      return
    }
    setBusy(true)
    const res =
      draft.mode === 'create'
        ? await window.api.source.createFile(root, value)
        : await window.api.source.renameFile(root, draft.from ?? '', value)
    setBusy(false)
    if (!res.ok || !res.path) {
      setError(res.error ?? 'That did not work.')
      return
    }
    // A new file opens; a rename follows the file if it was the one on screen.
    const drawer = useCodeDrawer.getState()
    if (draft.mode === 'create' || sourceToPath(drawer.source) === draft.from) {
      drawer.open(`${res.path}:1`)
    }
    setDraft(null)
    setError(null)
    reloadOnto(res.path)
  }

  const confirmDeleteNow = async (): Promise<void> => {
    if (!confirmDelete || busy) return
    setBusy(true)
    const res = await window.api.source.deleteFile(root, confirmDelete)
    setBusy(false)
    if (!res.ok) {
      setError(res.error ?? 'That did not work.')
      return
    }
    const drawer = useCodeDrawer.getState()
    if (sourceToPath(drawer.source) === confirmDelete) drawer.close()
    setConfirmDelete(null)
    setError(null)
    reloadOnto(undefined)
  }

  return (
    <div className="filetree flex h-full w-full min-h-0 flex-col">
      <div className="filetree__bar flex items-center gap-0.5 pl-3 pr-1.5 py-1">
        <span className="filetree__title min-w-0 flex-1 truncate text-[10px] uppercase tracking-wide text-muted-foreground">
          Files
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="filetree__new size-6 text-muted-foreground"
          onClick={startCreate}
          disabled={busy}
          aria-label="New file"
          title="New file"
        >
          <FilePlus className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="filetree__rename size-6 text-muted-foreground"
          onClick={() => selected && startRename(selected)}
          disabled={busy || !selected}
          aria-label="Rename file"
          title="Rename (or click the selected file again)"
        >
          <Pencil className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="filetree__delete size-6 text-muted-foreground"
          onClick={() => {
            setError(null)
            setDraft(null)
            setConfirmDelete(selected)
          }}
          disabled={busy || !selected}
          aria-label="Delete file"
          title="Delete file"
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>

      {draft && (
        <form
          className="filetree__draft px-2 pb-1"
          onSubmit={(e) => {
            e.preventDefault()
            void submitDraft()
          }}
        >
          <input
            ref={inputRef}
            className="w-full rounded-sm border bg-background px-1.5 py-1 font-mono text-[11px] outline-none focus:border-ring"
            value={draft.value}
            spellCheck={false}
            autoComplete="off"
            aria-label={draft.mode === 'create' ? 'New file path' : 'New name'}
            placeholder="path/to/File.tsx"
            onChange={(e) => setDraft({ ...draft, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                setDraft(null)
                setError(null)
              }
            }}
            onBlur={() => {
              if (!busyRef.current) setDraft(null)
            }}
          />
        </form>
      )}

      {confirmDelete && (
        <div className="filetree__confirm flex items-center gap-1.5 px-2 pb-1 text-[11px]">
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            Delete {confirmDelete.slice(dirPrefix(confirmDelete).length)}?
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-5 px-1.5 text-[11px]"
            onClick={() => setConfirmDelete(null)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="filetree__confirmdelete h-5 px-1.5 text-[11px] text-red-700"
            onClick={() => void confirmDeleteNow()}
            disabled={busy}
          >
            Delete
          </Button>
        </div>
      )}

      {error && <p className="filetree__error px-2 pb-1 text-[11px] text-red-700">{error}</p>}

      <div
        ref={hostRef}
        className="filetree__tree min-h-0 flex-1 overflow-hidden text-[12px]"
        style={
          {
            color: 'var(--foreground)',
            '--trees-fg-override': 'var(--foreground)',
            '--trees-border-color-override': 'var(--border)',
            '--trees-selected-bg-override': 'color-mix(in srgb, var(--foreground) 12%, transparent)'
          } as React.CSSProperties
        }
      />
    </div>
  )
}
