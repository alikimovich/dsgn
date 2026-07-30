import { ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { numericValue, STYLE_PROP_META, toCssText } from '@/lib/css-values'
import type { TokenCandidate } from '../../../../../shared/token-match'
import type { RowCtx } from '../row-ctx'
import ScrubInput from '../ScrubInput'
import { ReadoutRow } from './primitives'
import { TokenRow } from './TokenRow'

const SIDES = ['top', 'right', 'bottom', 'left'] as const

/**
 * The scrub track's readout: the design token's NAME when the value the track
 * is showing is still the committed one, and the plain css text the moment a
 * scrub moves off it (mid-drag the row is no longer that token, and freezing
 * the name there would misreport what's about to be committed). Undefined
 * hands ScrubInput back its default rendering.
 */
function tokenFormatter(
  prop: string,
  ctx: RowCtx,
  committed: number
): ((v: number) => string) | undefined {
  const name = ctx.tokenFor(prop)?.match.token.name
  if (!name) return undefined
  return (v) => (v === committed ? name : toCssText(prop, v))
}

/** Numeric scrub row; non-numeric computed text degrades to a readout. */
export function NumberRow({ prop, ctx }: { prop: string; ctx: RowCtx }): React.JSX.Element {
  const meta = STYLE_PROP_META[prop]
  const n = numericValue(prop, ctx.values)
  if (!meta || n === null) return <ReadoutRow label={prop} value={ctx.values[prop] ?? '—'} />
  return (
    <TokenRow prop={prop} ctx={ctx}>
      {(toggle) => (
        <ScrubInput
          label={prop}
          value={n}
          min={meta.min ?? 0}
          max={meta.max ?? 1000}
          step={meta.step ?? 1}
          unit={meta.unit}
          disabled={ctx.disabled}
          formatValue={tokenFormatter(prop, ctx, n)}
          trailing={toggle}
          onScrub={(v) => ctx.preview(prop, toCssText(prop, v))}
          onInput={(v) => ctx.preview(prop, toCssText(prop, v))}
          onCommit={(v) => void ctx.commit(prop, toCssText(prop, v))}
          onCancel={() => ctx.cancel(prop)}
        />
      )}
    </TokenRow>
  )
}

/**
 * padding/margin: one linked scrubber while all four computed sides are equal
 * (chevron expands to per-side); unequal sides always render per-side (a
 * linked value would lie about three of them).
 */
export function SideRows({
  base,
  ctx
}: {
  base: 'padding' | 'margin'
  ctx: RowCtx
}): React.JSX.Element {
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
  // One undo step for the whole gesture: the four longhands commit under
  // DIFFERENT coalesce keys, so only a shared edit-history group can batch
  // them (unique per gesture — a static group would chain gestures together).
  const sidesGroup = (): string => `style-sides:${base}:${Date.now()}`
  const commitAll = async (v: number): Promise<void> => {
    const group = sidesGroup()
    // Sequential: four longhand writes into the same file/class list must not race.
    for (const p of props) await ctx.commit(p, toCssText(p, v), group)
  }
  /** A token picked on the LINKED row applies to all four sides, one undo step. */
  const commitTokenAll = async (candidate: TokenCandidate): Promise<void> => {
    const group = sidesGroup()
    for (const p of props) await ctx.commitToken(p, candidate, group)
  }

  if (allEqual && !open) {
    return (
      <TokenRow
        prop={props[0]}
        ctx={ctx}
        previewProps={props}
        onPick={(c) => void commitTokenAll(c)}
      >
        {(toggle) => (
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
                formatValue={tokenFormatter(props[0], ctx, nums[0] as number)}
                trailing={toggle}
                onScrub={previewAll}
                onInput={previewAll}
                onCommit={(v) => void commitAll(v)}
                onCancel={cancelAll}
              />
            </div>
          </div>
        )}
      </TokenRow>
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
            <TokenRow key={p} prop={p} ctx={ctx}>
              {(toggle) => (
                <ScrubInput
                  label={p}
                  value={nums[i] as number}
                  min={meta.min ?? 0}
                  max={meta.max ?? 400}
                  step={meta.step ?? 1}
                  unit={meta.unit}
                  disabled={ctx.disabled}
                  formatValue={tokenFormatter(p, ctx, nums[i] as number)}
                  trailing={toggle}
                  onScrub={(v) => ctx.preview(p, toCssText(p, v))}
                  onInput={(v) => ctx.preview(p, toCssText(p, v))}
                  onCommit={(v) => void ctx.commit(p, toCssText(p, v))}
                  onCancel={() => ctx.cancel(p)}
                />
              )}
            </TokenRow>
          )
        )}
      </div>
    </div>
  )
}
