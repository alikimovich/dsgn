import { Button } from '@/components/ui/button'

interface Props {
  scaffolding: boolean
  status: string | null
  onAccept: () => void
  onDismiss: () => void
}

/**
 * First-run offer shown when a project exposes no design tokens (no
 * `.praxis/tokens.json`, Tailwind theme, or CSS custom properties). Accepting
 * writes a starter `.praxis/tokens.json` — a deterministic file write, no agent —
 * which then becomes the editable, canonical token source for the palette.
 * Shares the SetupCard surface; shadcn Buttons. `.setup*` hooks preserved.
 */
export default function TokenOfferCard({
  scaffolding,
  status,
  onAccept,
  onDismiss
}: Props): React.JSX.Element {
  return (
    <div
      className="setup flex flex-col gap-2 rounded-lg border border-blue-200 bg-blue-50 p-3.5 dark:border-blue-900/50 dark:bg-blue-950/30"
      role="region"
      aria-label="Design tokens"
    >
      <div className="setup__title text-sm font-semibold text-blue-900 dark:text-blue-100">
        Add a starter design-token palette?
      </div>
      <div className="setup__body text-[12.5px] leading-snug text-blue-800 dark:text-blue-200/90">
        This project has no design tokens yet. I can create an editable{' '}
        <code>.praxis/tokens.json</code> with starter colors, spacing, and radii — then you can apply
        them from the inspector and tune them to your brand.
      </div>
      {status && <div className="setup__status text-[11.5px] text-muted-foreground">{status}</div>}
      <div className="setup__actions flex justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          className="setup__no"
          onClick={onDismiss}
          disabled={scaffolding}
        >
          Not now
        </Button>
        <Button
          size="sm"
          className="setup__yes bg-blue-600 text-white hover:bg-blue-700"
          onClick={onAccept}
          disabled={scaffolding}
        >
          {scaffolding ? 'Adding…' : 'Add tokens'}
        </Button>
      </div>
    </div>
  )
}
