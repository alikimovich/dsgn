import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { sanitizeRepoName } from '../../../shared/github'
import { openWithPreviewFreeze, useGithub, useLog, usePreviewFreeze, useSession } from '../store'

/**
 * "Connect to GitHub" — the first-publish bridge. A scaffolded project is a
 * local-only repo; this sheet creates the GitHub repo (private by default),
 * wires `origin`, and pushes the built work so the repo's default branch shows
 * what the user made (Option B, main/github.ts). Publish takes over from there.
 *
 * gh readiness is handled by guiding, not automating: if the CLI is missing or
 * signed out we show the exact step + a Retry that re-probes, rather than
 * shelling into an interactive login. Mirrors FeedbackDialog's preview-freeze so
 * the sheet can't flash behind the native preview view.
 */
export default function ConnectDialog(): React.JSX.Element {
  const open = useGithub((s) => s.connectOpen)
  const setOpen = useGithub((s) => s.setConnectOpen)
  const status = useGithub((s) => s.status)
  const root = useSession((s) => s.projectRoot)

  const [name, setName] = useState('')
  const [owner, setOwner] = useState('')
  const [isPrivate, setIsPrivate] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!open) {
      setShown(false)
      usePreviewFreeze.getState().setFrozen(false)
      return
    }
    openWithPreviewFreeze(() => setShown(true))
  }, [open])

  // Seed the form from the freshly-probed status each time the sheet opens.
  useEffect(() => {
    if (!shown) return
    setName(status?.suggestedName ?? '')
    setOwner(status?.login ?? '')
    setIsPrivate(true)
    setBusy(false)
    setError(null)
  }, [shown, status])

  const owners = status?.login ? [status.login, ...(status.orgs ?? [])] : []
  const ghReady = status?.gh === 'ok'
  const cleanName = sanitizeRepoName(name)

  const reprobe = async (): Promise<void> => {
    if (!root) return
    setBusy(true)
    try {
      useGithub.getState().setStatus(await window.api.github.status(root))
    } finally {
      setBusy(false)
    }
  }

  const connect = async (): Promise<void> => {
    if (!root || busy || !ghReady || !owner) return
    setBusy(true)
    setError(null)
    try {
      const res = await window.api.github.connect(root, {
        name: cleanName,
        owner,
        private: isPrivate
      })
      if (res.ok) {
        useGithub.getState().setStatus(await window.api.github.status(root))
        useLog
          .getState()
          .append(
            `Connected to GitHub${res.url ? ` — ${res.url}` : ''}. Publish to ship changes.`,
            'success'
          )
        setOpen(false)
      } else {
        setError(res.error ?? 'Couldn’t create the repository.')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t create the repository.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open && shown} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Connect to GitHub</DialogTitle>
          <DialogDescription>
            Creates a GitHub repository, links it, and pushes your project so it’s ready to publish.
          </DialogDescription>
        </DialogHeader>

        {!ghReady ? (
          <div className="flex flex-col gap-3 text-sm">
            {status?.gh === 'missing' ? (
              <p>
                The GitHub CLI isn’t installed. Install{' '}
                <a
                  href="https://cli.github.com"
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  gh
                </a>
                , then retry.
              </p>
            ) : (
              <p>
                You’re not signed in to GitHub. Run{' '}
                <code className="rounded bg-muted px-1 py-0.5">gh auth login</code> in your
                terminal, then retry.
              </p>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-3 text-sm">
            <div className="flex flex-col gap-1">
              <label htmlFor="connect-repo-name" className="text-muted-foreground">
                Repository name
              </label>
              <Input
                id="connect-repo-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
              {cleanName !== name.trim() && (
                <span className="text-xs text-muted-foreground">
                  Will be created as “{cleanName}”.
                </span>
              )}
            </div>
            {owners.length > 1 ? (
              <div className="flex flex-col gap-1">
                <label htmlFor="connect-owner" className="text-muted-foreground">
                  Owner
                </label>
                <select
                  id="connect-owner"
                  value={owner}
                  onChange={(e) => setOwner(e.target.value)}
                  className="h-9 rounded-md border bg-transparent px-2"
                >
                  {owners.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              owner && (
                <p className="text-muted-foreground">
                  Owner: <span className="text-foreground">{owner}</span>
                </p>
              )
            )}
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={isPrivate}
                onChange={(e) => setIsPrivate(e.target.checked)}
              />
              <span>Private repository</span>
            </label>
          </div>
        )}

        {error && <p className="text-sm text-destructive whitespace-pre-wrap">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          {ghReady ? (
            <Button onClick={() => void connect()} disabled={busy || !owner || !cleanName}>
              {busy ? 'Creating…' : 'Create repository'}
            </Button>
          ) : (
            <Button onClick={() => void reprobe()} disabled={busy}>
              {busy ? 'Checking…' : 'Retry'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
