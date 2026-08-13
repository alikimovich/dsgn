import { Sparkles } from 'lucide-react'
import { useState } from 'react'
import { Input } from '@/components/ui/input'

interface Props {
  /** The element carries a `data-praxis-source` stamp — without one the AI has no
   *  file to instrument, so the trigger is disabled with an explanation. */
  hasSource: boolean
  /** Fire the `{ kind: 'controls' }` panel action (App builds + sends the prompt). */
  onTrigger: (hint?: string) => void
}

/**
 * The island's footer affordance for AI-surfaced control panels (Custom
 * Controls, v10): a sparkle button that expands to an optional one-line hint
 * ("what do you want to control?"). Submitting (Enter, empty allowed) asks the
 * agent to instrument the source and register a panel manifest.
 */
export default function ControlsTrigger({ hasSource, onTrigger }: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [hint, setHint] = useState('')

  const submit = (): void => {
    onTrigger(hint.trim() || undefined)
    setOpen(false)
    setHint('')
  }

  if (!open) {
    return (
      <button
        type="button"
        className="proppanel__controlstrigger flex items-center gap-1.5 text-[11.5px] text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:hover:text-muted-foreground"
        disabled={!hasSource}
        title={
          hasSource
            ? 'Ask the AI to expose this element’s parameters as live controls'
            : 'Select a source-stamped element first'
        }
        onClick={() => setOpen(true)}
      >
        <Sparkles className="size-3" aria-hidden="true" />
        Surface controls with AI
      </button>
    )
  }
  return (
    <Input
      autoFocus
      className="proppanel__controlshint h-6 px-2 text-[11.5px]"
      placeholder="what do you want to control? (Enter)"
      value={hint}
      onChange={(e) => setHint(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          submit()
        } else if (e.key === 'Escape') {
          setOpen(false)
          setHint('')
        }
      }}
    />
  )
}
