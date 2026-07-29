import { Button } from '@/components/ui/button'
import { STYLE_PROP_META } from '@/lib/css-values'
import type { TokenCandidate } from '../../../../shared/token-match'
import type { RowCtx } from './row-ctx'

/**
 * The design-token picker for one Styles row — rendered INLINE, expanded under
 * the row, never as a popover. The island is a transparent WebContentsView
 * sized to hug the card (PanelApp reports its rect), so a portal dropdown would
 * be clipped at the view edge; growing the card instead is what SideRows and
 * BezierEditor already do, and PanelApp's ResizeObserver resizes the view to
 * match.
 *
 * Colors render as a swatch grid (the swatch IS the information); lengths and
 * numbers render as a name/value list. Hovering previews the token live in the
 * page, so you can scan a palette and see it applied; leaving without clicking
 * drops the override.
 */
export default function TokenPicker({
  prop,
  ctx,
  previewProps,
  onPick,
  onCustom
}: {
  prop: string
  ctx: RowCtx
  /** Which properties a hover previews — the linked padding/margin row shows
   *  all four sides at once. Defaults to `prop` alone. */
  previewProps?: string[]
  /** Overridable so SideRows can commit four longhands under one undo group. */
  onPick: (candidate: TokenCandidate) => void
  /** "Custom value…" — collapse back to the raw control. */
  onCustom: () => void
}): React.JSX.Element {
  const candidates = ctx.tokensFor(prop)
  const current = ctx.tokenFor(prop)
  const currentName = current?.match.token.name
  const tiedNames = new Set(current?.ties.map((t) => t.token.name) ?? [])
  const isColor = STYLE_PROP_META[prop]?.control === 'color'

  // Group in the TokenSet's own order — token files are authored meaningfully
  // (a tonal ramp, a spacing scale), so this list is never alphabetized.
  const groups: { name: string; items: TokenCandidate[] }[] = []
  for (const c of candidates) {
    const last = groups[groups.length - 1]
    if (last?.name === c.group) last.items.push(c)
    else groups.push({ name: c.group, items: [c] })
  }

  const targets = previewProps ?? [prop]
  const hover = (c: TokenCandidate): void => {
    for (const p of targets) ctx.preview(p, ctx.tokenValue(c.token))
  }
  const unhover = (): void => {
    for (const p of targets) ctx.cancel(p)
  }

  return (
    <div
      className="stylepanel__tokens flex flex-col gap-1.5 rounded-md border bg-muted/30 p-2"
      onPointerLeave={unhover}
    >
      {groups.map((g) => (
        <div key={g.name} className="flex flex-col gap-1">
          <div className="stylepanel__tokengroup text-[10px] uppercase tracking-wider text-muted-foreground/70">
            {g.name}
          </div>
          <div className={isColor ? 'flex flex-wrap gap-1' : 'flex flex-col gap-0.5'}>
            {g.items.map((c) => {
              const value = ctx.tokenValue(c.token)
              const selected = c.token.name === currentName
              const title = `${c.token.name} — ${value}${
                tiedNames.has(c.token.name) ? ' (same value as the current token)' : ''
              }`
              return isColor ? (
                <button
                  key={c.token.name}
                  type="button"
                  data-token={c.token.name}
                  className={`stylepanel__token-swatch size-6 shrink-0 rounded border shadow-xs ${
                    selected ? 'ring-2 ring-ring ring-offset-1' : ''
                  }`}
                  style={{ background: value }}
                  disabled={ctx.disabled}
                  title={title}
                  aria-label={title}
                  aria-pressed={selected}
                  onPointerEnter={() => hover(c)}
                  onClick={() => onPick(c)}
                />
              ) : (
                <button
                  key={c.token.name}
                  type="button"
                  data-token={c.token.name}
                  className={`stylepanel__token-item flex items-center justify-between gap-2 rounded px-1.5 py-1 text-left text-[11.5px] hover:bg-accent ${
                    selected ? 'bg-accent font-medium' : ''
                  }`}
                  disabled={ctx.disabled}
                  title={title}
                  aria-pressed={selected}
                  onPointerEnter={() => hover(c)}
                  onClick={() => onPick(c)}
                >
                  <span className="truncate">{c.token.name}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">{value}</span>
                </button>
              )
            })}
          </div>
        </div>
      ))}
      <Button
        variant="ghost"
        size="sm"
        className="stylepanel__token-custom h-6 self-start px-1.5 text-[11.5px] text-muted-foreground"
        onClick={onCustom}
      >
        Custom value…
      </Button>
    </div>
  )
}
