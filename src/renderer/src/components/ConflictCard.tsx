import { Button } from '@/components/ui/button'
import { Loader2 } from 'lucide-react'

interface Props {
  /** The unmerged files (may be empty right after a reload — the list is then omitted). */
  files: string[]
  /** The AI resolution is in flight (either staging the merge or the reconcile turn). */
  resolving: boolean
  /** The discard is in flight. */
  discarding: boolean
  onResolve: () => void
  onDiscard: () => void
}

/**
 * v9 per-chat isolation — the "couldn't merge" card. A chat's turn edited files that
 * had ALSO changed in the user's project, so Praxis kept the chat's work on a side
 * branch instead of overwriting them. This explains that in plain language (no git
 * jargon) and offers two ways out: "Resolve it" hands the conflict to the agent to
 * reconcile both sides, and "Discard changes" drops the chat's version. Amber warning
 * surface, mirroring `SetupCard`'s shape. Shown while `isolation === 'parked'`.
 */
export default function ConflictCard({
  files,
  resolving,
  discarding,
  onResolve,
  onDiscard
}: Props): React.JSX.Element {
  const busy = resolving || discarding
  return (
    <div
      className="conflict flex flex-col gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3.5 dark:border-amber-900/50 dark:bg-amber-950/30"
      role="region"
      aria-label="Merge conflict"
    >
      <div className="conflict__title text-sm font-semibold text-amber-900 dark:text-amber-100">
        These changes couldn’t be merged automatically
      </div>
      <div className="conflict__body text-[12.5px] leading-snug text-amber-800 dark:text-amber-200/90">
        This chat edited files that also changed in your project since it started, so its work is
        kept aside instead of overwriting yours.{' '}
        {resolving
          ? 'Praxis is reconciling both versions…'
          : 'Resolve it to have Praxis combine both versions, or discard this chat’s changes.'}
      </div>
      {files.length > 0 && (
        <ul className="conflict__files flex flex-wrap gap-1.5">
          {files.map((f) => (
            <li
              key={f}
              className="conflict__file max-w-full truncate rounded bg-amber-100 px-1.5 py-0.5 font-mono text-[11px] text-amber-900 dark:bg-amber-900/40 dark:text-amber-100"
              title={f}
            >
              {f}
            </li>
          ))}
        </ul>
      )}
      <div className="conflict__actions flex justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          className="conflict__discard"
          onClick={onDiscard}
          disabled={busy}
        >
          {discarding ? (
            <>
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              Discarding…
            </>
          ) : (
            'Discard changes'
          )}
        </Button>
        <Button
          size="sm"
          className="conflict__resolve bg-amber-600 text-white hover:bg-amber-700"
          onClick={onResolve}
          disabled={busy}
        >
          {resolving ? (
            <>
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              Resolving…
            </>
          ) : (
            'Resolve it'
          )}
        </Button>
      </div>
    </div>
  )
}
