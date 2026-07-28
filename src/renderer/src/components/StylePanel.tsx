import { ChevronDown, ChevronRight, Play } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  type Bezier,
  clampBezier,
  formatBezier,
  formatCssNumber,
  formatMs,
  normalizeMs,
  parseBezier,
  parseCssNumber,
  STYLE_PROP_META,
  snapBezierPreset
} from '@/lib/css-values'
import type { SelectedElement } from '../../../shared/api'
import BezierEditor, { displayBezierPreset, TW_EASE_EQUIV } from './styles/BezierEditor'
import ColorControl from './styles/ColorControl'
import ScrubInput from './styles/ScrubInput'

interface Props {
  root: string
  element: SelectedElement
  /**
   * Can praxis instrument this project for visual editing (supported framework)?
   * When the picked element has no source stamp the panel is read-only; this
   * tailors the guidance — point a framework project at setup, tell a
   * static/runtime-rendered one to ask in chat. Null while unprobed.
   */
  canInstrument: boolean | null
  /** Seed a chat prompt for changes the styles engine can't land as a literal. */
  onSeedPrompt: (text: string) => void
}

/** Every v1 property (incl. the read-only chips) — one fresh read fills the panel. */
const ALL_PROPS = Object.keys(STYLE_PROP_META)

const SIDES = ['top', 'right', 'bottom', 'left'] as const

/** `gap` only means something on these computed display values. */
const FLEX_GRID = new Set(['flex', 'grid', 'inline-flex', 'inline-grid'])

/** Post-commit settle time before reconciling against a fresh read (lets HMR land). */
const RECONCILE_MS = 600

/** Reconcile attempts before conceding — a build slower than ~3s keeps the override. */
const RECONCILE_TRIES = 5

// ---------------------------------------------------------------------------
// pure row helpers
// ---------------------------------------------------------------------------

/**
 * The row's numeric value in its canonical unit, from the computed css text.
 * `normal` gets a scrubbable interpretation where one exists (letter-spacing/
 * gap → 0, line-height → font-size × 1.2); anything else non-numeric → null
 * (the row renders as a readout instead of a scrubber).
 */
function numericValue(prop: string, values: Record<string, string>): number | null {
  const raw = values[prop]
  if (raw === undefined) return null
  const meta = STYLE_PROP_META[prop]
  if (meta?.unit === 'ms') return normalizeMs(raw)
  const p = parseCssNumber(raw)
  if (p) return p.n
  if (raw === 'normal') {
    if (prop === 'letter-spacing' || prop === 'gap') return 0
    if (prop === 'line-height') {
      const fs = parseCssNumber(values['font-size'] ?? '')
      return fs ? Math.round(fs.n * 1.2) : null
    }
  }
  return null
}

/** Scrub value → the css text we preview/commit ('13px', '300ms', '0.5'). */
function toCssText(prop: string, n: number): string {
  const meta = STYLE_PROP_META[prop]
  if (meta?.unit === 'ms') return formatMs(n)
  return formatCssNumber({ n, unit: meta?.unit ?? '' })
}

/** '#rrggbb[aa]' / rgb()/rgba() / transparent → channels; anything else null. */
function parseColorLike(text: string): { r: number; g: number; b: number; a: number } | null {
  const t = text.trim().toLowerCase()
  if (t === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
  if (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(t)) {
    let hex = t.slice(1)
    if (hex.length <= 4) hex = [...hex].map((c) => c + c).join('')
    const int = (at: number): number => parseInt(hex.slice(at, at + 2), 16)
    return { r: int(0), g: int(2), b: int(4), a: hex.length === 8 ? int(6) / 255 : 1 }
  }
  const m = /^rgba?\(([^)]+)\)$/.exec(t)
  if (!m) return null
  const parts = m[1]
    .replace('/', ' ')
    .trim()
    .split(/[\s,]+/)
  if (parts.length !== 3 && parts.length !== 4) return null
  const nums = parts.map(Number)
  if (!nums.every(Number.isFinite)) return null
  return { r: nums[0], g: nums[1], b: nums[2], a: parts.length === 4 ? nums[3] : 1 }
}

/** Coord-wise bezier equality with room for computed-style float noise. */
function sameBezier(a: Bezier, b: Bezier): boolean {
  return (
    Math.abs(a.x1 - b.x1) < 0.005 &&
    Math.abs(a.y1 - b.y1) < 0.005 &&
    Math.abs(a.x2 - b.x2) < 0.005 &&
    Math.abs(a.y2 - b.y2) < 0.005
  )
}

/**
 * Does a fresh computed value (`a`) equal what we committed (`b`)? Textual
 * equality is not enough: we commit '#ff0000' and read back 'rgb(255, 0, 0)',
 * commit '300ms' and read back '0.3s', commit 'ease-out' and read back its
 * (Tailwind) curve. Normalize per control kind before comparing. Exported for
 * CustomPanel, whose style-strategy params reuse the same reconcile discipline.
 */
export function sameCssValue(prop: string, a: string, b: string): boolean {
  if (a === b) return true
  const meta = STYLE_PROP_META[prop]
  if (meta?.control === 'color') {
    const ca = parseColorLike(a)
    const cb = parseColorLike(b)
    if (!ca || !cb) return false
    return ca.r === cb.r && ca.g === cb.g && ca.b === cb.b && Math.abs(ca.a - cb.a) < 0.02
  }
  if (meta?.control === 'bezier') {
    const ba = parseBezier(a)
    if (ba) {
      const bb = parseBezier(b)
      if (bb && sameBezier(ba, bb)) return true
      const tw = TW_EASE_EQUIV[b.trim().toLowerCase()]
      if (tw && sameBezier(ba, tw)) return true
    }
    return a.trim().toLowerCase() === b.trim().toLowerCase()
  }
  if (meta?.unit === 'ms') {
    const ma = normalizeMs(a)
    return ma !== null && ma === normalizeMs(b)
  }
  const na = parseCssNumber(a)
  const nb = parseCssNumber(b)
  if (na && nb) return na.n === nb.n && na.unit === nb.unit
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/** What the row functions need from the panel — threaded to every row. */
interface RowCtx {
  values: Record<string, string>
  disabled: boolean
  preview: (prop: string, css: string) => void
  /** `group` batches a multi-prop gesture (linked sides) into one undo step. */
  commit: (prop: string, css: string, group?: string) => Promise<void>
  /** Drop the prop's live override + queued frame (editor cancelled, apply failed). */
  cancel: (prop: string) => void
}

/**
 * The Styles tab body — content-only, rendered inside IslandCard's styles
 * TabsContent (which is `flex min-h-0 flex-col`, so the rows div scrolls under
 * the card's maxHeight). Fresh computed values come from `styles.read` on
 * mount / selection change — the pick-time `element.styles` snapshot only
 * primes the first paint. Scrubs preview live (rAF-throttled CSS injection);
 * release commits through `styles.apply` (Tailwind rewrite → inline splice →
 * agent seed). Styles always target `element.source` — the host element's own
 * stamp — never `componentSource` (a css edit lands on the element, not the
 * component call site).
 */
export default function StylePanel({
  root,
  element,
  canInstrument,
  onSeedPrompt
}: Props): React.JSX.Element {
  const [values, setValuesRaw] = useState<Record<string, string>>(() => ({ ...element.styles }))
  const [lost, setLost] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Async flows (commit chains, reconcile timers) read through the ref so they
  // never act on a stale snapshot; every write goes through merge/setValues.
  const valuesRef = useRef(values)
  const setValues = (v: Record<string, string>): void => {
    valuesRef.current = v
    setValuesRaw(v)
  }
  const merge = (patch: Record<string, string>): void =>
    setValues({ ...valuesRef.current, ...patch })

  /** Latest un-flushed preview per prop; one rAF flush sends the trailing edge. */
  const pendingRef = useRef(new Map<string, string>())
  const rafRef = useRef<number | null>(null)
  /** Pending post-commit reconcile timers — cancelled on selection change. */
  const timersRef = useRef(new Set<number>())
  /** Last committed change, for Replay (fallback: the opacity demo). */
  const lastCommitRef = useRef<{ prop: string; from: string; to: string } | null>(null)

  const source = element.source
  const disabled = !source

  // Selection identity — NOT the element object (PanelHost re-pushes state for
  // reasons that aren't a new selection, e.g. inspection updates).
  const elKey = `${source ?? ''}|${element.selector}`

  // biome-ignore lint/correctness/useExhaustiveDependencies: elKey is the selection identity; element.styles/read intentionally refresh only then
  useEffect(() => {
    let alive = true
    setLost(false)
    setError(null)
    lastCommitRef.current = null
    setValues({ ...element.styles }) // instant paint from the pick-time snapshot…
    window.api.styles.read(ALL_PROPS).then((res) => {
      if (!alive) return
      if (res)
        merge(res) // …then the fresh truth
      else setLost(true)
    })
    return () => {
      alive = false
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      pendingRef.current.clear()
      for (const t of timersRef.current) window.clearTimeout(t)
      timersRef.current.clear()
    }
  }, [elKey])

  /** rAF-throttled (trailing-edge) live injection — scrubs call this per move. */
  const preview = (prop: string, css: string): void => {
    pendingRef.current.set(prop, css)
    if (rafRef.current !== null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      for (const [p, v] of pendingRef.current) window.api.styles.preview(p, v)
      pendingRef.current.clear()
    })
  }

  /**
   * Clear a prop's live override AND its queued preview frame. Without the
   * queue drain, a pending rAF flush landing after the clear would re-inject
   * the abandoned value — and nothing would ever remove it (reconciles are
   * only scheduled on successful applies).
   */
  const dropPreview = (prop: string): void => {
    pendingRef.current.delete(prop)
    if (pendingRef.current.size === 0 && rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    window.api.styles.clearPreview(prop)
  }

  /**
   * Post-commit reconciliation: do NOT clear the live override immediately
   * (HMR flash); after a settle delay LIFT the override and read the
   * UNDERLYING value — reading through the override would be a self-comparison
   * (the override IS the committed value, so it would always "match" and the
   * clear would fire before slow builds land, snapping the element back).
   * Underlying equals committed → the source provides it now, stay cleared;
   * selection gone → nothing (the override died with the node); mismatch → the
   * build hasn't landed yet: re-inject the override and retry, conceding after
   * RECONCILE_TRIES (the committed source is still correct — keep the override).
   */
  const scheduleReconcile = (prop: string, committed: string, tries = RECONCILE_TRIES): void => {
    const id = window.setTimeout(async () => {
      timersRef.current.delete(id)
      window.api.styles.clearPreview(prop) // lift the override for the read
      const res = await window.api.styles.read([prop])
      const fresh = res?.[prop]
      if (fresh === undefined) return
      if (sameCssValue(prop, fresh, committed)) {
        merge({ [prop]: fresh })
        return
      }
      window.api.styles.preview(prop, committed) // not landed yet — restore it
      if (tries > 1) scheduleReconcile(prop, committed, tries - 1)
    }, RECONCILE_MS)
    timersRef.current.add(id)
  }

  const commit = async (prop: string, css: string, group?: string): Promise<void> => {
    if (!source) return
    setError(null)
    // Tuning a duration/delay with transitions off would commit an invisible
    // change — enable `transition-property: all` first so the tweak is real.
    if (prop === 'transition-duration' || prop === 'transition-delay') {
      const tp = valuesRef.current['transition-property']
      if (!tp || tp === 'none') await commit('transition-property', 'all')
    }
    const prev = valuesRef.current[prop] ?? css
    preview(prop, css) // non-scrub commits (select / Enter) show instantly too
    merge({ [prop]: css })
    // Every not-applied branch uses dropPreview, NOT bare clearPreview: the
    // preview above may still sit in the rAF queue, and a flush after a bare
    // clear would re-inject the never-applied value permanently.
    try {
      const res = await window.api.styles.apply(root, {
        source,
        prop,
        value: css,
        classes: element.classes,
        group
      })
      if (res.applied) {
        lastCommitRef.current = { prop, from: prev, to: css }
        scheduleReconcile(prop, css)
      } else if (res.needsAgent) {
        onSeedPrompt(
          res.agentPrompt ??
            `In ${source}, set \`${prop}\` to \`${css}\` on the <${element.tag}> element.`
        )
        dropPreview(prop)
      } else {
        setError(res.error ?? 'Could not apply the change.')
        dropPreview(prop)
      }
    } catch {
      setError('The edit could not be sent.')
      dropPreview(prop)
    }
  }

  /** Replay the last committed change; before any commit, a small opacity demo. */
  const replay = (): void => {
    const last = lastCommitRef.current
    if (last && last.from !== last.to) window.api.styles.replay(last.prop, last.from, last.to)
    else window.api.styles.replay('opacity', '0.5', valuesRef.current.opacity || '1')
  }

  /** Hand a prop the panel can't edit (non-sRGB color, steps() easing) to chat. */
  const seedStyleEdit = (prop: string): void =>
    onSeedPrompt(
      `In ${source ?? 'the selected element'}, change the \`${prop}\` (currently \`${
        values[prop] ?? 'unset'
      }\`) of the <${element.tag}> element.`
    )

  // No source stamp → style edits can't be written back. Rather than a full set
  // of dead, greyed-out controls, show WHY it's read-only and WHAT to do about
  // it — tailored to whether the project could be set up at all.
  if (disabled) {
    const ask = (): void =>
      onSeedPrompt(`Change the styling of the selected <${element.tag}> element (${element.selector}).`)
    return (
      <div className="stylepanel__rows flex flex-col gap-3 overflow-y-auto px-3 pb-3 pt-2">
        <div className="stylepanel__note text-[12px] leading-snug text-muted-foreground">
          {canInstrument === false ? (
            <>
              Styles here are read-only. This element is built at runtime, so Praxis can’t map it
              back to your source to save changes. Describe the change in chat and Praxis will edit
              the code directly.
            </>
          ) : canInstrument ? (
            <>
              Styles here are read-only until this project is set up for visual editing (there’s an
              offer in the chat) — then Praxis maps elements to your source and you can edit styles
              directly. Meanwhile, ask Praxis in chat to make the change.
            </>
          ) : (
            <>
              Styles here are read-only — this element isn’t mapped to your source, so changes can’t
              be saved. Ask Praxis in chat to make the change and it’ll edit the code.
            </>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="stylepanel__ask h-7 self-start px-2 text-[11.5px]"
          onClick={ask}
        >
          Ask Praxis to restyle it
        </Button>
      </div>
    )
  }

  if (lost) {
    return (
      <div className="stylepanel__rows flex flex-col gap-2 overflow-y-auto px-3 pb-3 pt-1.5">
        <div className="stylepanel__lost text-[12px] text-muted-foreground">
          Selection lost — click the element again.
        </div>
      </div>
    )
  }

  const ctx: RowCtx = { values, disabled, preview, commit, cancel: dropPreview }
  const display = values.display ?? ''

  return (
    <>
      {error && (
        <div className="stylepanel__error mx-3 mt-1 text-[11.5px] text-red-700">{error}</div>
      )}
      <div className="stylepanel__rows flex flex-1 flex-col gap-1 overflow-y-auto px-3 pb-3 pt-1.5">
        <StyleGroup title="Layout">
          <SideRows base="padding" ctx={ctx} />
          <SideRows base="margin" ctx={ctx} />
          {FLEX_GRID.has(display) && <NumberRow prop="gap" ctx={ctx} />}
        </StyleGroup>

        <StyleGroup title="Appearance">
          <ColorRow prop="color" ctx={ctx} onNeedsAgent={() => seedStyleEdit('color')} />
          <ColorRow
            prop="background-color"
            ctx={ctx}
            onNeedsAgent={() => seedStyleEdit('background-color')}
          />
          <NumberRow prop="border-radius" ctx={ctx} />
          <NumberRow prop="opacity" ctx={ctx} />
        </StyleGroup>

        <StyleGroup title="Typography">
          <NumberRow prop="font-size" ctx={ctx} />
          <NumberRow prop="font-weight" ctx={ctx} />
          <NumberRow prop="line-height" ctx={ctx} />
          <NumberRow prop="letter-spacing" ctx={ctx} />
          <ChipRow label="font-family" value={values['font-family'] ?? '—'} />
          <ChipRow label="display" value={display || '—'} />
        </StyleGroup>

        <StyleGroup title="Transition">
          <TransitionPropertyRow ctx={ctx} />
          <NumberRow prop="transition-duration" ctx={ctx} />
          <NumberRow prop="transition-delay" ctx={ctx} />
          <TimingRow
            ctx={ctx}
            onReplay={replay}
            onNeedsAgent={() => seedStyleEdit('transition-timing-function')}
          />
          <div className="stylepanel__row grid min-h-7 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2">
            <span />
            <Button
              variant="outline"
              size="sm"
              className="stylepanel__replay h-7 justify-self-end px-2 text-[11.5px]"
              onClick={replay}
              title="Replay the last change as a transition"
            >
              <Play className="size-3" aria-hidden="true" />
              Replay
            </Button>
          </div>
        </StyleGroup>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// rows
// ---------------------------------------------------------------------------

function StyleGroup({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="stylepanel__group flex flex-col gap-1">
      <h3 className="stylepanel__grouptitle pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80">
        {title}
      </h3>
      {children}
    </section>
  )
}

/** Numeric scrub row; non-numeric computed text degrades to a readout. */
function NumberRow({ prop, ctx }: { prop: string; ctx: RowCtx }): React.JSX.Element {
  const meta = STYLE_PROP_META[prop]
  const n = numericValue(prop, ctx.values)
  if (!meta || n === null) return <ReadoutRow label={prop} value={ctx.values[prop] ?? '—'} />
  return (
    <ScrubInput
      label={prop}
      value={n}
      min={meta.min ?? 0}
      max={meta.max ?? 1000}
      step={meta.step ?? 1}
      unit={meta.unit}
      disabled={ctx.disabled}
      onScrub={(v) => ctx.preview(prop, toCssText(prop, v))}
      onInput={(v) => ctx.preview(prop, toCssText(prop, v))}
      onCommit={(v) => void ctx.commit(prop, toCssText(prop, v))}
      onCancel={() => ctx.cancel(prop)}
    />
  )
}

/**
 * padding/margin: one linked scrubber while all four computed sides are equal
 * (chevron expands to per-side); unequal sides always render per-side (a
 * linked value would lie about three of them).
 */
function SideRows({ base, ctx }: { base: 'padding' | 'margin'; ctx: RowCtx }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const props = SIDES.map((s) => `${base}-${s}`)
  const nums = props.map((p) => numericValue(p, ctx.values))
  const allEqual = nums[0] !== null && nums.every((v) => v === nums[0])
  const meta = STYLE_PROP_META[props[0]]

  const previewAll = (v: number): void => {
    for (const p of props) ctx.preview(p, toCssText(p, v))
  }
  const cancelAll = (): void => {
    for (const p of props) ctx.cancel(p)
  }
  const commitAll = async (v: number): Promise<void> => {
    // One undo step for the whole gesture: the four longhands commit under
    // DIFFERENT coalesce keys, so only a shared edit-history group can batch
    // them (unique per gesture — a static group would chain gestures together).
    const group = `style-sides:${base}:${Date.now()}`
    // Sequential: four longhand writes into the same file/class list must not race.
    for (const p of props) await ctx.commit(p, toCssText(p, v), group)
  }

  if (allEqual && !open) {
    return (
      <div className="stylepanel__sides flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="stylepanel__expand-sides size-5 shrink-0 text-muted-foreground"
          onClick={() => setOpen(true)}
          aria-label={`Edit ${base} sides separately`}
          title="Edit sides separately"
        >
          <ChevronRight className="size-3.5" aria-hidden="true" />
        </Button>
        <div className="min-w-0 flex-1">
          <ScrubInput
            label={base}
            value={nums[0] as number}
            min={meta.min ?? 0}
            max={meta.max ?? 400}
            step={meta.step ?? 1}
            unit={meta.unit}
            disabled={ctx.disabled}
            onScrub={previewAll}
            onInput={previewAll}
            onCommit={(v) => void commitAll(v)}
            onCancel={cancelAll}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="stylepanel__sides flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="stylepanel__collapse-sides size-5 shrink-0 text-muted-foreground"
          onClick={() => setOpen(false)}
          disabled={!allEqual}
          aria-label={`Link ${base} sides`}
          title={allEqual ? 'Link sides' : 'Sides differ — scrub them equal to relink'}
        >
          <ChevronDown className="size-3.5" aria-hidden="true" />
        </Button>
        <span className="select-none text-[12px] text-muted-foreground">{base}</span>
      </div>
      <div className="flex flex-col gap-1 pl-3">
        {props.map((p, i) =>
          nums[i] === null ? (
            <ReadoutRow key={p} label={p} value={ctx.values[p] ?? '—'} />
          ) : (
            <ScrubInput
              key={p}
              label={p}
              value={nums[i] as number}
              min={meta.min ?? 0}
              max={meta.max ?? 400}
              step={meta.step ?? 1}
              unit={meta.unit}
              disabled={ctx.disabled}
              onScrub={(v) => ctx.preview(p, toCssText(p, v))}
              onInput={(v) => ctx.preview(p, toCssText(p, v))}
              onCommit={(v) => void ctx.commit(p, toCssText(p, v))}
              onCancel={() => ctx.cancel(p)}
            />
          )
        )}
      </div>
    </div>
  )
}

function ColorRow({
  prop,
  ctx,
  onNeedsAgent
}: {
  prop: string
  ctx: RowCtx
  onNeedsAgent: () => void
}): React.JSX.Element {
  return (
    <div className="stylepanel__row grid min-h-7 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2">
      <span
        className="stylepanel__name select-none overflow-hidden text-ellipsis whitespace-nowrap text-[12px] text-muted-foreground"
        title={prop}
      >
        {prop}
      </span>
      <ColorControl
        value={ctx.values[prop] ?? ''}
        disabled={ctx.disabled}
        onChange={(c) => ctx.preview(prop, c)}
        onCommit={(c) => void ctx.commit(prop, c)}
        onNeedsAgent={onNeedsAgent}
      />
    </div>
  )
}

/**
 * transition-property picker. A NATIVE select on purpose: the island
 * WebContentsView is sized to hug the card (PanelApp reports its rect), so a
 * portal dropdown (radix Select) would be clipped at the view edge — the OS
 * popup of a native select isn't. Options are REAL css values from
 * STYLE_PROP_META (they feed the commit path verbatim); optionLabels prettify
 * the unwieldy ones. A computed value outside the set (e.g. 'none', a custom
 * list) shows as a disabled leading option until the user picks one of ours.
 */
function TransitionPropertyRow({ ctx }: { ctx: RowCtx }): React.JSX.Element {
  const meta = STYLE_PROP_META['transition-property']
  const options = meta.options ?? []
  const labels = meta.optionLabels ?? {}
  const current = ctx.values['transition-property'] ?? ''
  const known = options.includes(current)
  return (
    <div className="stylepanel__row grid min-h-7 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2">
      <span
        className="stylepanel__name select-none overflow-hidden text-ellipsis whitespace-nowrap text-[12px] text-muted-foreground"
        title="transition-property"
      >
        transition-property
      </span>
      <select
        className="stylepanel__select select h-7 w-[128px] justify-self-end rounded-md border bg-transparent px-1.5 text-xs"
        value={current}
        disabled={ctx.disabled}
        onChange={(e) => void ctx.commit('transition-property', e.target.value)}
      >
        {!known && (
          <option value={current} disabled>
            {current || '—'}
          </option>
        )}
        {options.map((o) => (
          <option key={o} value={o}>
            {labels[o] ?? o}
          </option>
        ))}
      </select>
    </div>
  )
}

const TIMING_PROP = 'transition-timing-function'

/** '.17, .67, .83, .67' — compact coord readout that fits the value column. */
function shortBezier(b: Bezier): string {
  return [b.x1, b.y1, b.x2, b.y2].map((n) => String(n).replace(/^(-?)0\./, '$1.')).join(', ')
}

/**
 * transition-timing-function: collapsed, a readout (the keyword name when the
 * curve matches a CSS preset, else compact coords) + a chevron; expanded, the
 * BezierEditor inline (the island view is content-sized — growth is handled by
 * PanelApp's ResizeObserver). Drags preview live through the rAF-throttled
 * ctx.preview; commits snap to a keyword preset within tolerance, so S1 writes
 * `ease-out` classes instead of arbitrary values when the curve is (close to)
 * a keyword. A computed value the editor can't model — steps(), a per-property
 * list — renders read-only with an edit-via-chat affordance, mirroring
 * ColorControl's non-sRGB branch.
 */
function TimingRow({
  ctx,
  onReplay,
  onNeedsAgent
}: {
  ctx: RowCtx
  onReplay: () => void
  onNeedsAgent: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  /** The in-flight drag's curve — ctx.values only updates on commit, so the
   * editor needs a local echo of onChange for its handles to track. Tagged
   * with the value it was echoing: a fresh committed / reconciled / reselected
   * value supersedes any stale echo without an effect. */
  const [drag, setDrag] = useState<{ over: string; b: Bezier } | null>(null)
  const raw = ctx.values[TIMING_PROP] ?? 'ease'
  const parsed = parseBezier(raw)
  const live = drag && drag.over === raw ? drag.b : null

  // parseBezier only spec-constrains x; CSS allows any finite y, but the
  // editor canvas is y ∈ [-1,2]. Hand an authored curve beyond that to chat
  // like steps(): the editor would clamp it, and the first nudge or drag
  // would then silently rewrite the untouched handle's coordinates too.
  if (!parsed || !sameBezier(parsed, clampBezier(parsed))) {
    return (
      <div className="stylepanel__row stylepanel__row--readonly grid min-h-7 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2">
        <span
          className="stylepanel__name select-none overflow-hidden text-ellipsis whitespace-nowrap text-[12px] text-muted-foreground"
          title={TIMING_PROP}
        >
          timing-function
        </span>
        <div className="flex items-center gap-1.5 justify-self-end">
          <span
            className="stylepanel__readout max-w-[64px] overflow-hidden text-ellipsis whitespace-nowrap text-xs text-muted-foreground/80"
            title={raw}
          >
            {raw}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="stylepanel__timing-agent h-7 px-2 text-[11.5px]"
            onClick={onNeedsAgent}
            disabled={ctx.disabled}
            title={`${raw} — not editable here`}
          >
            edit via chat
          </Button>
        </div>
      </div>
    )
  }

  // Display through the Tailwind-aware snap: after a keyword commit on a
  // Tailwind element, reconcile merges the computed Tailwind curve back in,
  // and the plain CSS snap would flip the readout to raw coords.
  const preset = displayBezierPreset(parsed)
  return (
    <div className="stylepanel__timing flex flex-col gap-1">
      <div className="stylepanel__row grid min-h-7 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-1">
        <Button
          variant="ghost"
          size="icon"
          className="stylepanel__timing-toggle size-5 shrink-0 text-muted-foreground"
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
          className="stylepanel__name select-none overflow-hidden text-ellipsis whitespace-nowrap text-[12px] text-muted-foreground"
          title={TIMING_PROP}
        >
          timing-function
        </span>
        <span
          className="stylepanel__readout max-w-[128px] justify-self-end overflow-hidden text-ellipsis whitespace-nowrap text-xs text-muted-foreground/80"
          title={formatBezier(parsed)}
        >
          {preset ?? shortBezier(parsed)}
        </span>
      </div>
      {open && (
        <div className="stylepanel__beziereditor">
          <BezierEditor
            value={live ?? parsed}
            disabled={ctx.disabled}
            onChange={(nb) => {
              setDrag({ over: raw, b: nb })
              ctx.preview(TIMING_PROP, formatBezier(nb))
            }}
            onCommit={(nb) => {
              setDrag(null)
              void ctx.commit(TIMING_PROP, snapBezierPreset(nb) ?? formatBezier(nb))
            }}
            onReplay={onReplay}
          />
        </div>
      )}
    </div>
  )
}

/** Read-only value row (mono-ish readout; used for non-numeric text). */
function ReadoutRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="stylepanel__row stylepanel__row--readonly grid min-h-7 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2">
      <span
        className="stylepanel__name select-none overflow-hidden text-ellipsis whitespace-nowrap text-[12px] text-muted-foreground"
        title={label}
      >
        {label}
      </span>
      <span
        className="stylepanel__readout max-w-[128px] justify-self-end overflow-hidden text-ellipsis whitespace-nowrap text-xs text-muted-foreground/80"
        title={value}
      >
        {value}
      </span>
    </div>
  )
}

/** Read-only chip row (font-family / display). */
function ChipRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="stylepanel__row stylepanel__row--chip grid min-h-7 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2">
      <span
        className="stylepanel__name select-none overflow-hidden text-ellipsis whitespace-nowrap text-[12px] text-muted-foreground"
        title={label}
      >
        {label}
      </span>
      <Badge
        variant="secondary"
        className="stylepanel__chip max-w-[128px] justify-self-end font-normal"
        title={value}
      >
        <span className="truncate">{value}</span>
      </Badge>
    </div>
  )
}
