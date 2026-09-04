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
}

/** Edit durable project decisions shared by every chat for this project. */
export default function ProjectMemoryDialog({
  root,
  name,
  open,
  onOpenChange
}: Props): React.JSX.Element {
  const [shown, setShown] = useState(false)
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      setShown(false)
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

  return (
    <Dialog open={open && shown} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{name} memory</DialogTitle>
          <DialogDescription>
            Praxis learns durable decisions from completed chats and shares them with every chat and
            background agent. You can review or edit them here anytime.
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
