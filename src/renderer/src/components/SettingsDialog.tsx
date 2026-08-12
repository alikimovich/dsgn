import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { ProviderConnection } from '../../../shared/api'
import { useProviders } from '../providers-store'
import { openWithPreviewFreeze, usePreviewFreeze } from '../store'
import ProviderForm from './ProviderForm'

/**
 * App settings (Cmd+, from the app menu, or the model picker's "Manage
 * providers…"). Tabbed so more panes can land later; v10 ships just
 * "Models & Providers": the saved `ProviderConnection`s, and the add/edit form
 * (ProviderForm) that owns the key-bearing state.
 *
 * The form is MOUNTED only while it's open — leaving it unmounts the component
 * holding the typed API key, which is what guarantees the key never outlives the
 * form. Nothing key-shaped is ever put in the store; main only returns `hasKey`.
 */
export default function SettingsDialog(): React.JSX.Element {
  const open = useProviders((s) => s.settingsOpen)
  const setOpen = useProviders((s) => s.setSettingsOpen)
  const connections = useProviders((s) => s.connections)

  /** null = the list; 'new' = adding; a connection = editing that one. */
  const [editing, setEditing] = useState<ProviderConnection | 'new' | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // The dialog is renderer DOM and the native preview paints ABOVE all DOM —
  // freeze-frame the preview while open and gate rendering on the freeze, exactly
  // like the feedback + connect sheets.
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!open) {
      setShown(false)
      usePreviewFreeze.getState().setFrozen(false)
      // Unmounts ProviderForm → drops any key typed into it.
      setEditing(null)
      setConfirmDelete(null)
      setError(null)
      return
    }
    openWithPreviewFreeze(() => setShown(true))
  }, [open])

  // Every open starts on the list, against a freshly-read set of connections.
  useEffect(() => {
    if (!shown) return
    setEditing(null)
    setConfirmDelete(null)
    setError(null)
    void useProviders.getState().refresh()
  }, [shown])

  const remove = async (id: string): Promise<void> => {
    setConfirmDelete(null)
    setError(null)
    try {
      await window.api.providers.remove(id)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t delete that connection.')
    }
    // Refresh either way: the picker must reflect whatever main actually has.
    await useProviders.getState().refresh()
  }

  return (
    <Dialog open={open && shown} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Praxis’s own Claude and Codex seats sign in with your subscription. Add a connection to
            run chats against another OpenAI-compatible endpoint with your own API key.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="models">
          <TabsList>
            <TabsTrigger value="models">Models &amp; Providers</TabsTrigger>
          </TabsList>

          <TabsContent value="models" className="flex flex-col gap-3 pt-1 text-sm">
            {editing ? (
              <ProviderForm
                // Remount (fresh draft, no leftover key) per connection edited.
                key={editing === 'new' ? 'new' : editing.id}
                connection={editing === 'new' ? undefined : editing}
                onDone={() => setEditing(null)}
              />
            ) : (
              <>
                {connections.length === 0 ? (
                  <p className="text-muted-foreground">
                    No connections yet. The built-in Claude and Codex models stay available either
                    way.
                  </p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {connections.map((c) => (
                      <li
                        key={c.id}
                        className="flex flex-col gap-2 rounded-md border border-border p-3"
                      >
                        <div className="flex items-start gap-2">
                          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <div className="flex items-center gap-2">
                              <span className="truncate font-medium">{c.label}</span>
                              <Badge variant="outline">
                                {c.preset === 'gateway' ? 'AI Gateway' : 'Custom'}
                              </Badge>
                            </div>
                            <span className="truncate text-xs text-muted-foreground">
                              {c.baseUrl} · {c.models.length} model
                              {c.models.length === 1 ? '' : 's'} ·{' '}
                              {c.hasKey ? 'key saved' : 'no key'}
                            </span>
                          </div>
                          <Button variant="outline" size="sm" onClick={() => setEditing(c)}>
                            Edit
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setConfirmDelete(c.id)}
                          >
                            Delete
                          </Button>
                        </div>
                        {confirmDelete === c.id && (
                          <div className="flex items-center gap-2 rounded-md bg-muted/50 p-2">
                            <span className="flex-1 text-xs text-muted-foreground">
                              Delete “{c.label}”? Its stored API key is removed too, and chats using
                              its models fall back to the default.
                            </span>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setConfirmDelete(null)}
                            >
                              Cancel
                            </Button>
                            <Button size="sm" onClick={() => void remove(c.id)}>
                              Delete
                            </Button>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {error && <p className="text-sm text-destructive whitespace-pre-wrap">{error}</p>}
                <div>
                  <Button variant="outline" onClick={() => setEditing('new')}>
                    Add connection
                  </Button>
                </div>
              </>
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
