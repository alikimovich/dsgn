import { ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import type { TokenCandidate } from '../../../../../shared/token-match'
import type { RowCtx } from '../row-ctx'
import TokenPicker from '../TokenPicker'

/**
 * Wraps a Styles row with its design-token affordance: a chevron that expands
 * the inline TokenPicker underneath, mirroring how SideRows and TimingRow
 * expand.
 *
 * When the project has no token offerable for this property the wrapper renders
 * NOTHING of its own — the row comes through byte-identical. That keeps
 * token-less projects (and the panel's existing layout/screenshots) untouched.
 */
export function TokenRow({
  prop,
  ctx,
  previewProps,
  onPick,
  children
}: {
  prop: string
  ctx: RowCtx
  /** Properties a hover previews (the linked padding row: all four sides). */
  previewProps?: string[]
  /** Overridable so SideRows can commit four longhands under one undo group. */
  onPick?: (candidate: TokenCandidate) => void
  children: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const has = ctx.tokensFor(prop).length > 0
  if (!has) return <>{children}</>

  const pick = (c: TokenCandidate): void => {
    setOpen(false)
    if (onPick) onPick(c)
    else void ctx.commitToken(prop, c)
  }

  /**
   * Collapsing must drop any hover preview. Closing by chevron (rather than by
   * moving the pointer out) skips the picker's pointerleave, and the injected
   * override would otherwise stay on the element forever — nothing else clears
   * it, since reconciles are only scheduled after a successful apply.
   */
  const toggle = (): void => {
    setOpen((o) => {
      if (o) for (const p of previewProps ?? [prop]) ctx.cancel(p)
      return !o
    })
  }

  return (
    <div className="stylepanel__tokenrow flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="stylepanel__token-toggle size-5 shrink-0 text-muted-foreground"
          onClick={toggle}
          aria-expanded={open}
          aria-label={open ? `Hide ${prop} tokens` : `Pick a ${prop} design token`}
          title={open ? 'Hide design tokens' : 'Pick a design token'}
        >
          {open ? (
            <ChevronDown className="size-3.5" aria-hidden="true" />
          ) : (
            <ChevronRight className="size-3.5" aria-hidden="true" />
          )}
        </Button>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
      {open && (
        <TokenPicker
          prop={prop}
          ctx={ctx}
          previewProps={previewProps}
          onPick={pick}
          onCustom={toggle}
        />
      )}
    </div>
  )
}
