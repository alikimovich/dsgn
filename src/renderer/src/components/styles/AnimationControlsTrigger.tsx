import { Sparkles } from 'lucide-react'
import { useState } from 'react'
import { Input } from '@/components/ui/input'

export default function AnimationControlsTrigger({
  onTrigger
}: {
  onTrigger: (hint?: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [hint, setHint] = useState('')

  const submit = (): void => {
    onTrigger(hint.trim() || undefined)
    setOpen(false)
    setHint('')
  }

  if (open) {
    return (
      <Input
        autoFocus
        className="stylepanel__animationhint h-7 px-2 text-[11.5px]"
        placeholder="describe the animation… (Enter)"
        value={hint}
        onChange={(event) => setHint(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            submit()
          } else if (event.key === 'Escape') {
            setOpen(false)
            setHint('')
          }
        }}
      />
    )
  }

  return (
    <button
      type="button"
      className="stylepanel__animationtrigger flex items-center gap-1.5 self-start text-[11.5px] text-muted-foreground hover:text-foreground"
      title="Ask Praxis to add an animation and expose its parameters as live controls"
      onClick={() => setOpen(true)}
    >
      <Sparkles className="size-3" aria-hidden="true" />
      Generate animation controls
    </button>
  )
}
