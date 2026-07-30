import { useState } from 'react'
import ColorControl from '../ColorControl'
import type { RowCtx } from '../row-ctx'
import { RowShell } from './primitives'
import { TokenRow } from './TokenRow'

/**
 * A color row whose value IS a design token shows the token's NAME and swatch
 * instead of the hex — the point of the feature: `--color-text`, not
 * `#6c6c6c`. The hex field stays one click away behind the picker's
 * "Custom value…", and the swatch still opens the native color picker, so the
 * raw-value escape hatch is never more than one interaction deep.
 */
function TokenChip({
  prop,
  ctx,
  trailing,
  onCustom
}: {
  prop: string
  ctx: RowCtx
  trailing?: React.ReactNode
  onCustom: () => void
}): React.JSX.Element {
  const res = ctx.tokenFor(prop)
  const token = res?.match.token
  const value = token ? ctx.tokenValue(token) : (ctx.values[prop] ?? '')
  return (
    <div className="colorctl colorctl--token flex items-center gap-1.5 justify-self-end">
      <button
        type="button"
        className="colorctl__swatch size-7 shrink-0 rounded-md border shadow-xs disabled:pointer-events-none disabled:opacity-50"
        style={{ background: value }}
        disabled={ctx.disabled}
        onClick={onCustom}
        title={`${token?.name} — ${value}. Click to edit as a raw value.`}
        aria-label={`Current color ${token?.name}`}
      />
      {/* Mirrors ColorControl's hex field box (same h/w/border) so the row
          doesn't shift when a value flips between token and raw. */}
      <div
        className="flex h-7 w-28 items-center gap-1 rounded-md border px-2"
        title={`${token?.name} — ${value}`}
      >
        <span className="stylepanel__token min-w-0 flex-1 truncate font-mono text-xs">
          {token?.name}
        </span>
        {trailing}
      </div>
    </div>
  )
}

export function ColorRow({
  prop,
  ctx,
  onNeedsAgent
}: {
  prop: string
  ctx: RowCtx
  onNeedsAgent: () => void
}): React.JSX.Element {
  // "Custom value…" forces the raw control for this row until the selection
  // changes (ColorRow remounts) or another token is picked.
  const [custom, setCustom] = useState(false)
  const asToken = !custom && ctx.tokenFor(prop) !== null
  const pick = (c: Parameters<RowCtx['commitToken']>[1]): void => {
    setCustom(false) // a fresh pick re-enters token mode
    void ctx.commitToken(prop, c)
  }
  return (
    <TokenRow prop={prop} ctx={ctx} onPick={pick}>
      {(toggle) => (
        <RowShell label={prop}>
          {asToken ? (
            <TokenChip
              prop={prop}
              ctx={ctx}
              trailing={toggle}
              onCustom={() => setCustom(true)}
            />
          ) : (
            <ColorControl
              value={ctx.values[prop] ?? ''}
              disabled={ctx.disabled}
              trailing={toggle}
              onChange={(c) => ctx.preview(prop, c)}
              onCommit={(c) => void ctx.commit(prop, c)}
              onNeedsAgent={onNeedsAgent}
            />
          )}
        </RowShell>
      )}
    </TokenRow>
  )
}
