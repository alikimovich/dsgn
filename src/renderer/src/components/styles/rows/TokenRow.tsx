import { ChevronDown } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import type { TokenCandidate } from '../../../../../shared/token-match'
import type { RowCtx } from '../row-ctx'
import TokenPicker from '../TokenPicker'

/**
 * Gives a Styles row its design-token affordance: a chevron that expands the
 * inline TokenPicker underneath.
 *
 * The chevron is NOT rendered here — it's handed to `children` as a node so
 * each control can place it INSIDE its own value field (right edge), where it
 * reads as a select's dropdown arrow rather than as an unrelated expander
 * sitting out beside the property label. `children` is a function purely so
 * the three call sites (NumberRow, SideRows, ColorRow) stay explicit about
 * where the toggle lands; there is no context/cloning indirection.
 *
 * When the project has no token offerable for this property the wrapper
 * renders NOTHING of its own and passes `null` — the row comes through
 * byte-identical, so token-less projects keep their exact layout.
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
  children: (toggle: React.ReactNode | null) => React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const has = ctx.tokensFor(prop).length > 0
  if (!has) return <>{children(null)}</>

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

  /**
   * Sits inside the value field, so every pointer/key event it handles must be
   * stopped from reaching the field's own handlers — ScrubInput's track starts
   * a pointer-lock scrub on pointerdown and opens its exact-value editor on
   * Enter, either of which would fire alongside the toggle otherwise.
   */
  const toggleNode = (
    <button
      type="button"
      className="stylepanel__token-toggle -mr-1 flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        toggle()
      }}
      onKeyDown={(e) => e.stopPropagation()}
      aria-expanded={open}
      aria-label={open ? `Hide ${prop} tokens` : `Pick a ${prop} design token`}
      title={open ? 'Hide design tokens' : 'Pick a design token'}
    >
      <ChevronDown
        className={cn('size-3 transition-transform', open && 'rotate-180')}
        aria-hidden="true"
      />
    </button>
  )

  return (
    <div className="stylepanel__tokenrow flex flex-col gap-1">
      {children(toggleNode)}
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
