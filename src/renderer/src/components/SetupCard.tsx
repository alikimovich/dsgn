import { Button } from '@/components/ui/button'
import { Loader2 } from 'lucide-react'

interface Props {
  busy: boolean
  status: string | null
  onAccept: () => void
  onStop: () => void
  onDismiss: () => void
}

/**
 * The on-open "make this project praxis-ready" dialogue. Shown when the previewed
 * app has no `data-praxis-source` stamps — so praxis can't map elements to source
 * and prop editing is unavailable. Accepting writes the dev-only stamping plugin
 * (deterministic) and asks the agent to wire it in + type the components.
 * shadcn Buttons; Tailwind blue info surface. `.setup*` hooks preserved.
 */
export default function SetupCard({
  busy,
  status,
  onAccept,
  onStop,
  onDismiss
}: Props): React.JSX.Element {
  return (
    <div
      className="setup flex flex-col gap-2 rounded-lg border border-blue-200 bg-blue-50 p-3.5 dark:border-blue-900/50 dark:bg-blue-950/30"
      role="region"
      aria-label="Project setup"
    >
      <div className="setup__title text-sm font-semibold text-blue-900 dark:text-blue-100">
        Set this project up for visual editing?
      </div>
      <div className="setup__body text-[12.5px] leading-snug text-blue-800 dark:text-blue-200/90">
        Its elements aren’t source-mapped yet, so Praxis can only suggest changes via chat. I can add
        a dev-only source-stamping plugin and have the agent type your components so you can edit
        props directly.
      </div>
      {status && <div className="setup__status text-[11.5px] text-muted-foreground">{status}</div>}
      <div className="setup__actions flex justify-end gap-2">
        <Button variant="outline" size="sm" className="setup__no" onClick={onDismiss} disabled={busy}>
          Not now
        </Button>
        {busy ? (
          <Button variant="outline" size="sm" className="setup__yes setup__yes--stop" onClick={onStop}>
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            Stop
          </Button>
        ) : (
          <Button
            size="sm"
            className="setup__yes bg-blue-600 text-white hover:bg-blue-700"
            onClick={onAccept}
          >
            Set it up
          </Button>
        )}
      </div>
    </div>
  )
}
