import { ChevronDown, ChevronRight } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  type Bezier,
  formatBezier,
  formatCssNumber,
  formatMs,
  normalizeMs,
  parseBezier,
  parseCssNumber,
  STYLE_PROP_META,
  snapBezierPreset
} from '@/lib/css-values'
import type {
  ControlKind,
  PropInspection,
  PropKind,
  ResolvedControlPanel,
  ResolvedControlParam,
  SelectedElement
} from '../../../shared/api'
import { sameCssValue } from './StylePanel'
import BezierEditor, { displayBezierPreset } from './styles/BezierEditor'
import ColorControl from './styles/ColorControl'
import ScrubInput from './styles/ScrubInput'

interface Props {
  root: string
  element: SelectedElement
  inspection: PropInspection | null
  /** The selection's resolved panels (already tombstone-filtered by PanelApp). */
  panels: ResolvedControlPanel[]
  /** Seed a chat prompt for params the panel can't apply directly. */
  onSeedPrompt: (text: string) => void
  /** Broken param → ask the agent to regenerate that panel (a real turn). */
  onRegenerate: (panelId: string) => void
  /** "Remove panel" — the caller persists (controls.remove) and hides it. */
  onRemove: (panelId: string) => void
}

type Val = string | number | boolean

/** Trailing throttle for file-write scrubs (literal/prop): the write through
 *  HMR IS the preview — no CSS injection exists for an arbitrary constant. */
const WRITE_THROTTLE_MS = 250

/** Post-commit settle time before reconciling a style param (matches StylePanel). */
const RECONCILE_MS = 600
const RECONCILE_TRIES = 5

/** PropEdit kind for each control kind (the prop-strategy mapping). */
const PROP_KIND: Record<ControlKind, PropKind> = {
  number: 'number',
  toggle: 'boolean',
  select: 'enum',
  text: 'string',
  color: 'string',
  bezier: 'string'
}

/** An in-flight throttled committer for one param (keyed `${panelId}:${paramId}`). */
interface PendingWrite {
  latest: Val
  commit: (v: Val) => Promise<void>
  timer: number | null
  busy: boolean
  /** Release/Enter asked for this value now — skip the throttle for one flush. */
  force: boolean
}

/** '.17, .67, .83, .67' — compact readout (mirrors StylePanel's shortBezier). */
function shortBezier(b: Bezier): string {
  return [b.x1, b.y1, b.x2, b.y2].map((n) => String(n).replace(/^(-?)0\./, '$1.')).join(', ')
}

/**
 * The Custom tab body (v10 Custom Controls) — content-only, rendered inside
 * IslandCard's custom TabsContent. Each ResolvedControlPanel becomes a titled
 * group whose params render with the same primitives as the Styles tab.
 *
 * Value + apply routing per strategy:
 * - `literal` — value comes resolved from the manifest lookup; applies through
 *   `controls.applyLiteral`. NO live-preview channel exists (a constant can
 *   affect anything), so scrubs commit trailing-throttled at ~250ms plus a
 *   final commit on release — within edit-history's 500ms coalesce window, so
 *   a burst stays one Cmd+Z.
 * - `prop` — value looked up in the live PropInspection by propName; applies
 *   through `props.apply` at the inspection's edit site (componentSource ??
 *   source). No usable inspection/prop → an "edit via chat" row.
 * - `style` — value from the element's styles snapshot; same discipline as
 *   StylePanel: live `styles.preview` while scrubbing, `styles.apply` commit,
 *   then lift-and-read reconciliation.
 *
 * After a successful apply the local value is patched optimistically — App only
 * re-fetches resolved values on selection change / controls:updated / agent
 * done, so a committed scrub would otherwise snap back on the next state push.
 */
export default function CustomPanel({
  root,
  element,
  inspection,
  panels,
  onSeedPrompt,
  onRegenerate,
  onRemove
}: Props): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const [applied, setAppliedRaw] = useState<Record<string, Val>>({})
  const appliedRef = useRef(applied)
  const setApplied = (key: string, v: Val): void => {
    appliedRef.current = { ...appliedRef.current, [key]: v }
    setAppliedRaw(appliedRef.current)
  }

  /** Throttled literal/prop write queues, keyed per param. */
  const pendingRef = useRef(new Map<string, PendingWrite>())
  /** rAF-coalesced style preview queue (StylePanel's trailing-edge pattern). */
  const previewQueueRef = useRef(new Map<string, string>())
  const rafRef = useRef<number | null>(null)
  /** Pending style reconcile timers — cancelled on selection change. */
  const reconcileRef = useRef(new Set<number>())
  /** Last resolved literal value seen per param — tells a fresh resolution
   *  (the value moved without us) from a repeat of one we already had. */
  const seenRef = useRef(new Map<string, Val | null>())

  // Selection identity, not object identity (state pushes re-create objects).
  const elKey = `${element.source ?? ''}|${element.selector}`

  // biome-ignore lint/correctness/useExhaustiveDependencies: elKey is the selection identity — optimistic values and queues reset only then.
  useEffect(() => {
    appliedRef.current = {}
    setAppliedRaw({})
    seenRef.current.clear()
    setError(null)
    return () => {
      for (const p of pendingRef.current.values())
        if (p.timer !== null) window.clearTimeout(p.timer)
      pendingRef.current.clear()
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      previewQueueRef.current.clear()
      for (const t of reconcileRef.current) window.clearTimeout(t)
      reconcileRef.current.clear()
    }
  }, [elKey])

  // An optimistic patch only covers the gap until the write lands and a refetch
  // confirms it. Once a resolution arrives that either agrees with the patch or
  // carries genuinely new information (the value moved without us — undo, an
  // agent edit, a hand edit) and no write for that param is still in flight, the
  // resolved value is the truth and the patch must go; otherwise a stale patch
  // would mask every later change until the element is re-selected.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the panels payload — `applied` is read through its ref.
  useEffect(() => {
    const next = { ...appliedRef.current }
    let changed = false
    for (const panel of panels) {
      for (const param of panel.params) {
        const key = `${panel.manifest.id}:${param.id}`
        const resolved = param.apply.strategy === 'literal' ? param.value : undefined
        if (resolved === undefined) continue
        const fresh = seenRef.current.has(key) && seenRef.current.get(key) !== resolved
        seenRef.current.set(key, resolved)
        const patch = next[key]
        if (patch === undefined) continue
        const p = pendingRef.current.get(key)
        if (p && (p.busy || p.timer !== null)) continue
        if (patch === resolved || fresh) {
          delete next[key]
          changed = true
        }
      }
    }
    if (changed) {
      appliedRef.current = next
      setAppliedRaw(next)
    }
  }, [panels])

  // -------------------------------------------------------------------------
  // literal / prop: trailing-throttled write-through (the HMR-cadence tier)
  // -------------------------------------------------------------------------

  const flush = async (key: string): Promise<void> => {
    const p = pendingRef.current.get(key)
    if (!p || p.busy) return
    if (p.timer !== null) {
      window.clearTimeout(p.timer)
      p.timer = null
    }
    const v = p.latest
    p.busy = true
    p.force = false
    try {
      await p.commit(v)
    } finally {
      p.busy = false
    }
    // The scrub moved on while the write was in flight. Re-arm the throttle
    // rather than recursing straight away: an immediate chase would commit at
    // IPC speed for as long as the drag lasts, and every one of those writes is
    // a file write + HMR round trip.
    if (p.latest !== v) {
      if (p.force) void flush(key)
      else arm(key)
    }
  }

  /** Start the trailing-edge timer for `key` unless one is already running. */
  const arm = (key: string): void => {
    const p = pendingRef.current.get(key)
    if (!p || p.timer !== null) return
    p.timer = window.setTimeout(() => {
      const cur = pendingRef.current.get(key)
      if (cur) cur.timer = null
      void flush(key)
    }, WRITE_THROTTLE_MS)
  }

  const queueWrite = (key: string, v: Val, commit: (v: Val) => Promise<void>): void => {
    let p = pendingRef.current.get(key)
    if (!p) {
      p = { latest: v, commit, timer: null, busy: false, force: false }
      pendingRef.current.set(key, p)
    }
    p.latest = v
    p.commit = commit
    if (!p.busy) arm(key)
  }

  /** Release/Enter: make `v` the tail and flush it now (the final commit). */
  const flushWrite = (key: string, v: Val, commit: (v: Val) => Promise<void>): void => {
    queueWrite(key, v, commit)
    const p = pendingRef.current.get(key)
    if (p) p.force = true
    void flush(key)
  }

  const cancelWrite = (key: string): void => {
    const p = pendingRef.current.get(key)
    if (p?.timer != null) {
      window.clearTimeout(p.timer)
      p.timer = null
    }
  }

  // -------------------------------------------------------------------------
  // style: live preview + apply + reconcile (StylePanel's discipline)
  // -------------------------------------------------------------------------

  const previewStyle = (prop: string, css: string): void => {
    previewQueueRef.current.set(prop, css)
    if (rafRef.current !== null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      for (const [p, v] of previewQueueRef.current) window.api.styles.preview(p, v)
      previewQueueRef.current.clear()
    })
  }

  /** Drop a style prop's live override AND its queued preview frame. */
  const dropStylePreview = (prop: string): void => {
    previewQueueRef.current.delete(prop)
    if (previewQueueRef.current.size === 0 && rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    window.api.styles.clearPreview(prop)
  }

  /** Lift the override, read the underlying value, and only stay cleared when
   *  the committed source provides it (see StylePanel.scheduleReconcile). */
  const scheduleReconcile = (prop: string, committed: string, tries = RECONCILE_TRIES): void => {
    const id = window.setTimeout(async () => {
      reconcileRef.current.delete(id)
      window.api.styles.clearPreview(prop)
      const res = await window.api.styles.read([prop])
      const fresh = res?.values[prop]
      if (fresh === undefined) return
      if (sameCssValue(prop, fresh, committed)) return
      window.api.styles.preview(prop, committed) // not landed yet — restore it
      if (tries > 1) scheduleReconcile(prop, committed, tries - 1)
    }, RECONCILE_MS)
    reconcileRef.current.add(id)
  }

  // -------------------------------------------------------------------------
  // unified apply
  // -------------------------------------------------------------------------

  /** The prop-strategy edit site: the inspected source, else the component
   *  call site, else the element's own stamp. */
  const propSource = inspection?.source ?? element.componentSource ?? element.source

  /** The prop's live field, only from a real schema-backed inspection. */
  const findField = (
    name: string
  ): { value?: Val; default?: Val; expression?: boolean } | undefined =>
    inspection?.hasSchema ? inspection.fields.find((f) => f.name === name) : undefined

  const seedParam = (panel: ResolvedControlPanel, param: ResolvedControlParam): void =>
    onSeedPrompt(
      `In ${panel.manifest.file}, change "${param.label}" (the \`${param.id}\` control of the ${panel.manifest.component} panel).`
    )

  const applyParam = async (
    panel: ResolvedControlPanel,
    param: ResolvedControlParam,
    v: Val
  ): Promise<void> => {
    const key = `${panel.manifest.id}:${param.id}`
    const apply = param.apply
    setError(null)
    try {
      if (apply.strategy === 'literal') {
        const res = await window.api.controls.applyLiteral(root, panel.manifest.id, param.id, v)
        if (res.applied) setApplied(key, v)
        else setError(res.error ?? 'Could not apply the change.')
      } else if (apply.strategy === 'prop') {
        if (!propSource) return
        const res = await window.api.props.apply(root, {
          source: propSource,
          name: apply.propName,
          kind: PROP_KIND[param.kind],
          value: v
        })
        if (res.applied) setApplied(key, v)
        else if (res.needsAgent)
          onSeedPrompt(
            res.agentPrompt ??
              `In ${propSource}, set the \`${apply.propName}\` prop to \`${String(v)}\`.`
          )
        else setError(res.error ?? 'Could not apply the change.')
      } else {
        const css = String(v)
        if (!element.source) {
          seedParam(panel, param)
          return
        }
        previewStyle(apply.styleProp, css) // non-scrub commits show instantly too
        const res = await window.api.styles.apply(root, {
          source: element.source,
          prop: apply.styleProp,
          value: css,
          classes: element.classes
        })
        if (res.applied) {
          setApplied(key, css)
          scheduleReconcile(apply.styleProp, css)
        } else if (res.needsAgent) {
          onSeedPrompt(
            res.agentPrompt ??
              `In ${element.source}, set \`${apply.styleProp}\` to \`${css}\` on the <${element.tag}> element.`
          )
          dropStylePreview(apply.styleProp)
        } else {
          setError(res.error ?? 'Could not apply the change.')
          dropStylePreview(apply.styleProp)
        }
      }
    } catch {
      setError('The edit could not be sent.')
      if (apply.strategy === 'style') dropStylePreview(apply.styleProp)
    }
  }

  // -------------------------------------------------------------------------
  // per-param rendering
  // -------------------------------------------------------------------------

  /** Current value: the optimistic patch, else the strategy's source of truth. */
  const resolveValue = (panel: ResolvedControlPanel, param: ResolvedControlParam): Val | null => {
    const patched = applied[`${panel.manifest.id}:${param.id}`]
    if (patched !== undefined) return patched
    const apply = param.apply
    if (apply.strategy === 'literal') return param.value
    if (apply.strategy === 'prop') {
      const f = findField(apply.propName)
      return f?.value ?? f?.default ?? null
    }
    return element.styles[apply.styleProp] ?? null
  }

  const renderParam = (
    panel: ResolvedControlPanel,
    param: ResolvedControlParam
  ): React.JSX.Element => {
    const key = `${panel.manifest.id}:${param.id}`
    if (!param.valid)
      return (
        <InvalidRow
          key={param.id}
          label={param.label}
          reason={param.reason}
          onRegenerate={() => onRegenerate(panel.manifest.id)}
        />
      )
    const apply = param.apply
    const strategy = apply.strategy
    // A prop param is only usable when the live inspection still carries the
    // prop as a literal target — otherwise it's an honest edit-via-chat row.
    if (strategy === 'prop') {
      const f = findField(apply.propName)
      if (!propSource || !f || f.expression)
        return (
          <ChatRow key={param.id} label={param.label} onClick={() => seedParam(panel, param)} />
        )
    }
    const value = resolveValue(panel, param)
    const commit = (v: Val): Promise<void> => applyParam(panel, param, v)

    if (param.kind === 'number') {
      const unit =
        param.unit ?? (strategy === 'style' ? (STYLE_PROP_META[apply.styleProp]?.unit ?? '') : '')
      const toCss = (v: number): string =>
        unit === 'ms' ? formatMs(v) : formatCssNumber({ n: v, unit })
      const n =
        strategy === 'style'
          ? unit === 'ms'
            ? normalizeMs(String(value ?? ''))
            : (parseCssNumber(String(value ?? ''))?.n ?? null)
          : typeof value === 'number'
            ? value
            : value != null && Number.isFinite(Number(value))
              ? Number(value)
              : null
      if (n === null || !Number.isFinite(n))
        return (
          <ChatRow key={param.id} label={param.label} onClick={() => seedParam(panel, param)} />
        )
      const scrub =
        strategy === 'style'
          ? (v: number): void => previewStyle(apply.styleProp, toCss(v))
          : (v: number): void => queueWrite(key, v, commit)
      return (
        <ScrubInput
          key={param.id}
          label={param.label}
          value={n}
          // Bounds are optional in a manifest. Widen the defaults around the
          // authored value so an unbounded param whose real value is negative
          // or large isn't clamped the moment it's scrubbed.
          min={param.min ?? Math.min(0, n)}
          max={param.max ?? Math.max(1000, n)}
          step={param.step ?? 1}
          unit={unit}
          onScrub={scrub}
          onInput={scrub}
          onCommit={(v) =>
            strategy === 'style' ? void commit(toCss(v)) : flushWrite(key, v, commit)
          }
          onCancel={() =>
            strategy === 'style' ? dropStylePreview(apply.styleProp) : cancelWrite(key)
          }
        />
      )
    }

    if (param.kind === 'color') {
      return (
        <RowShell key={param.id} label={param.label}>
          <ColorControl
            value={String(value ?? '')}
            onChange={(c) => {
              if (strategy === 'style') previewStyle(apply.styleProp, c)
              else if (strategy === 'literal') queueWrite(key, c, commit)
            }}
            onCommit={(c) => (strategy === 'literal' ? flushWrite(key, c, commit) : void commit(c))}
            onNeedsAgent={() => seedParam(panel, param)}
          />
        </RowShell>
      )
    }

    if (param.kind === 'select') {
      // NATIVE select on purpose — the island view hugs the card, so a portal
      // dropdown would clip at the view edge (see StylePanel's
      // TransitionPropertyRow); the OS popup of a native select isn't.
      const options = param.options ?? []
      const current = String(value ?? '')
      return (
        <RowShell key={param.id} label={param.label}>
          <select
            className="custompanel__select select h-7 w-[128px] justify-self-end rounded-md border bg-transparent px-1.5 text-xs"
            value={current}
            onChange={(e) => void commit(e.target.value)}
          >
            {!options.includes(current) && (
              <option value={current} disabled>
                {current || '—'}
              </option>
            )}
            {options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </RowShell>
      )
    }

    if (param.kind === 'toggle') {
      return (
        <RowShell key={param.id} label={param.label}>
          <input
            type="checkbox"
            className="custompanel__toggle justify-self-end"
            checked={value === true || value === 'true'}
            onChange={(e) => void commit(e.target.checked)}
          />
        </RowShell>
      )
    }

    if (param.kind === 'bezier') {
      const b = parseBezier(String(value ?? ''))
      // Out-of-canvas y (the editor models y ∈ [-1,2]) → chat, like TimingRow.
      if (!b || b.y1 < -1 || b.y1 > 2 || b.y2 < -1 || b.y2 > 2)
        return (
          <ChatRow key={param.id} label={param.label} onClick={() => seedParam(panel, param)} />
        )
      return (
        <BezierRow
          key={param.id}
          label={param.label}
          value={b}
          onPreview={(nb) => {
            if (strategy === 'style') previewStyle(apply.styleProp, formatBezier(nb))
            // Literal drags write through at HMR cadence — the file IS the preview.
            else if (strategy === 'literal') queueWrite(key, formatBezier(nb), commit)
          }}
          onCommit={(nb) => {
            // Only the style path may snap to a keyword — a keyword rendered
            // into a numeric/array literal would not lex back.
            const css =
              strategy === 'style' ? (snapBezierPreset(nb) ?? formatBezier(nb)) : formatBezier(nb)
            if (strategy === 'literal') flushWrite(key, css, commit)
            else void commit(css)
          }}
        />
      )
    }

    // 'text'
    return (
      <TextRow
        key={param.id}
        label={param.label}
        value={String(value ?? '')}
        onCommit={(t) => void commit(t)}
      />
    )
  }

  return (
    <>
      {error && (
        <div className="custompanel__error mx-3 mt-1 text-[11.5px] text-red-700">{error}</div>
      )}
      <div className="custompanel__rows flex flex-1 flex-col gap-1 overflow-y-auto px-3 pb-3 pt-1.5">
        {panels.map((panel) => (
          <section key={panel.manifest.id} className="custompanel__group flex flex-col gap-1">
            <h3 className="custompanel__grouptitle pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80">
              {panel.manifest.title}
            </h3>
            {panel.params.map((param) => renderParam(panel, param))}
            <div className="custompanel__groupfoot flex justify-end">
              <button
                type="button"
                className="custompanel__remove text-[10.5px] text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
                onClick={() => onRemove(panel.manifest.id)}
                title="Delete this panel's manifest from the repo"
              >
                Remove panel
              </button>
            </div>
          </section>
        ))}
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// rows (module-level so their local state survives re-renders)
// ---------------------------------------------------------------------------

function RowShell({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="custompanel__row grid min-h-7 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2">
      <span
        className="custompanel__name select-none overflow-hidden text-ellipsis whitespace-nowrap text-[12px] text-muted-foreground"
        title={label}
      >
        {label}
      </span>
      {children}
    </div>
  )
}

/** A param whose target no longer resolves: disabled + reason + Regenerate. */
function InvalidRow({
  label,
  reason,
  onRegenerate
}: {
  label: string
  reason?: string
  onRegenerate: () => void
}): React.JSX.Element {
  return (
    <div className="custompanel__row custompanel__row--invalid grid min-h-7 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 opacity-80">
      <span
        className="custompanel__name select-none overflow-hidden text-ellipsis whitespace-nowrap text-[12px] text-muted-foreground/60 line-through"
        title={reason ? `${label} — ${reason}` : label}
      >
        {label}
      </span>
      <span className="flex items-center gap-1.5 justify-self-end">
        <span
          className="custompanel__reason max-w-[84px] overflow-hidden text-ellipsis whitespace-nowrap text-[10.5px] text-amber-700"
          title={reason}
        >
          {reason ?? 'target lost'}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="custompanel__regen h-7 px-2 text-[11.5px]"
          onClick={onRegenerate}
          title="Ask the AI to re-instrument the source and fix this panel"
        >
          Regenerate
        </Button>
      </span>
    </div>
  )
}

/** A param the island can't apply directly — hand the edit to the agent. */
function ChatRow({ label, onClick }: { label: string; onClick: () => void }): React.JSX.Element {
  return (
    <RowShell label={label}>
      <Button
        variant="outline"
        size="sm"
        className="custompanel__agent h-7 justify-self-end px-2 text-[11.5px]"
        onClick={onClick}
      >
        edit via chat
      </Button>
    </RowShell>
  )
}

/** Free-text param — commit on Enter/blur, Escape reverts the draft. */
function TextRow({
  label,
  value,
  onCommit
}: {
  label: string
  value: string
  onCommit: (text: string) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = (): void => {
    if (draft !== value) onCommit(draft)
  }
  return (
    <RowShell label={label}>
      <Input
        className="custompanel__input h-7 w-[128px] justify-self-end px-2 text-xs"
        type="text"
        value={draft}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            setDraft(value)
          }
        }}
      />
    </RowShell>
  )
}

/**
 * Bezier param: collapsed readout (preset name or compact coords) + chevron
 * that expands the BezierEditor inline — a simplified TimingRow (no replay;
 * `onPreview` fires per drag move, `onCommit` on release/preset/nudge).
 */
function BezierRow({
  label,
  value,
  onPreview,
  onCommit
}: {
  label: string
  value: Bezier
  onPreview: (b: Bezier) => void
  onCommit: (b: Bezier) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  /** In-flight drag echo, tagged with the value it overrode (a fresh committed
   *  value supersedes a stale echo without an effect — TimingRow's pattern). */
  const [drag, setDrag] = useState<{ over: string; b: Bezier } | null>(null)
  const raw = formatBezier(value)
  const live = drag && drag.over === raw ? drag.b : null
  const preset = displayBezierPreset(value)
  return (
    <div className="custompanel__bezier flex flex-col gap-1">
      <div className="custompanel__row grid min-h-7 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-1">
        <Button
          variant="ghost"
          size="icon"
          className="custompanel__beziertoggle size-5 shrink-0 text-muted-foreground"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={open ? 'Hide the easing editor' : 'Edit the easing curve'}
          title={open ? 'Hide the easing editor' : 'Edit the easing curve'}
        >
          {open ? (
            <ChevronDown className="size-3.5" aria-hidden="true" />
          ) : (
            <ChevronRight className="size-3.5" aria-hidden="true" />
          )}
        </Button>
        <span
          className="custompanel__name select-none overflow-hidden text-ellipsis whitespace-nowrap text-[12px] text-muted-foreground"
          title={label}
        >
          {label}
        </span>
        <span
          className="custompanel__bezierreadout max-w-[128px] justify-self-end overflow-hidden text-ellipsis whitespace-nowrap text-xs text-muted-foreground/80"
          title={raw}
        >
          {preset ?? shortBezier(value)}
        </span>
      </div>
      {open && (
        <div className="custompanel__beziereditor">
          <BezierEditor
            value={live ?? value}
            onChange={(nb) => {
              setDrag({ over: raw, b: nb })
              onPreview(nb)
            }}
            onCommit={(nb) => {
              setDrag(null)
              onCommit(nb)
            }}
          />
        </div>
      )}
    </div>
  )
}
