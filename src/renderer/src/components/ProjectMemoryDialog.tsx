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
import { Textarea } from '@/components/ui/textarea'
import { openWithPreviewFreeze, usePreviewFreeze } from '../store'

interface Props {
  root: string | null
  name: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onMainCleared: (root: string) => void
}

/** Edit durable project decisions and reset Main without touching those decisions. */
export default function ProjectMemoryDialog({
  root,
  name,
  open,
  onOpenChange,
  onMainCleared
}: Props): React.JSX.Element {
  const [shown, setShown] = useState(false)
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      setShown(false)
      setConfirmClear(false)
      usePreviewFreeze.getState().setFrozen(false)
      return
    }
    openWithPreviewFreeze(() => setShown(true))
  }, [open])

  useEffect(() => {
    if (!shown || !root) return
    let live = true
    setLoading(true)
    setMessage(null)
    void window.api.projectMemory
      .get(root)
      .then((memory) => {
        if (live) setContent(memory.content)
      })
      .catch((error) => {
        if (live) setMessage(error instanceof Error ? error.message : 'Couldn’t load memory.')
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => {
      live = false
    }
  }, [root, shown])

  const save = async (): Promise<void> => {
    if (!root || saving) return
    setSaving(true)
    setMessage(null)
    try {
      const memory = await window.api.projectMemory.set(root, content)
      setContent(memory.content)
      setMessage('Project memory saved. Open chats receive the update on their next turn.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Couldn’t save memory.')
    } finally {
      setSaving(false)
    }
  }

  const clearMain = async (): Promise<void> => {
    if (!root || saving) return
    setSaving(true)
    setMessage(null)
    try {
      // Clearing creates a new provider context immediately, so persist the
      // editor first and let that fresh context receive exactly what is visible.
      const memory = await window.api.projectMemory.set(root, content)
      setContent(memory.content)
      const result = await window.api.agent.clearMainContext(root)
      if (!result.ok) {
        setMessage(result.error ?? 'Couldn’t clear Main context.')
        return
      }
      onMainCleared(root)
      setConfirmClear(false)
      setMessage('Main now has a fresh context. Its previous conversation is in History.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Couldn’t clear Main context.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open && shown} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{name} memory</DialogTitle>
          <DialogDescription>
            Keep durable product decisions here. Praxis gives them to every new chat and background
            agent; clearing Main never removes them.
          </DialogDescription>
        </DialogHeader>

        <Textarea
          value={content}
          onChange={(event) => setContent(event.target.value)}
          disabled={loading || saving}
          maxLength={16_000}
          rows={14}
          placeholder={'# Decisions\n\n- The integration branch is praxis/master.\n- …'}
          aria-label={`${name} project memory`}
          className="min-h-64 resize-y font-mono text-xs"
        />
        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>{message ?? 'Stored locally by Praxis, outside the repository.'}</span>
          <span className="shrink-0">{content.length.toLocaleString()} / 16,000</span>
        </div>

        <div className="rounded-md border border-border p-3">
          <div className="text-sm font-medium">Main context</div>
          <p className="mt-1 text-xs text-muted-foreground">
            Archive Main’s conversation and restart its model context. Files, secondary chats, and
            project memory stay in place.
          </p>
          {confirmClear ? (
            <div className="mt-3 flex items-center gap-2">
              <Button
                variant="destructive"
                size="sm"
                onClick={() => void clearMain()}
                disabled={saving}
              >
                Clear Main context
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirmClear(false)}
                disabled={saving}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => setConfirmClear(true)}
            >
              Clear context…
            </Button>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button onClick={() => void save()} disabled={loading || saving}>
            {saving ? 'Working…' : 'Save memory'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
