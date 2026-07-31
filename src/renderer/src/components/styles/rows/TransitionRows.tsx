import { ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  type Bezier,
  clampBezier,
  displayBezierPreset,
  formatBezier,
  parseBezier,
  STYLE_PROP_META,
  sameBezier,
  snapBezierPreset
} from '@/lib/css-values'
import BezierEditor from '../BezierEditor'
import type { RowCtx } from '../row-ctx'
import { RowShell } from './primitives'

/**
 * transition-property picker. A NATIVE select on purpose: the island
 * WebContentsView is sized to hug the card (PanelApp reports its rect), so a
 * portal dropdown (radix Select) would be clipped at the view edge — the OS
 * popup of a native select isn't. Options are REAL css values from
 * STYLE_PROP_META (they feed the commit path verbatim); optionLabels prettify
 * the unwieldy ones. A computed value outside the set (e.g. 'none', a custom
 * list) shows as a disabled leading option until the user picks one of ours.
 */
export function TransitionPropertyRow({ ctx }: { ctx: RowCtx }): React.JSX.Element {
  const meta = STYLE_PROP_META['transition-property']
  const options = meta.options ?? []
  const labels = meta.optionLabels ?? {}
  const current = ctx.values['transition-property'] ?? ''
  const known = options.includes(current)
  return (
    <RowShell label="transition-property">
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
    </RowShell>
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
export function TimingRow({
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
      <RowShell label="timing-function" title={TIMING_PROP} className="stylepanel__row--readonly">
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
      </RowShell>
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
