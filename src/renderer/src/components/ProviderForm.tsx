import { Loader2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { ProviderConnection } from '../../../shared/api'
import { useProviders } from '../providers-store'

/** Vercel's documented values for pointing Codex at the AI Gateway. */
export const GATEWAY_BASE_URL = 'https://ai-gateway.vercel.sh/v1'

/**
 * How long the FORM waits for a catalog probe before giving up on it.
 *
 * Deliberately longer than main's own 10s request timeout (providers.ts): main
 * answers a slow/unreachable host with a real error message well inside this, so
 * this only ever fires when the IPC round trip itself never lands — the one case
 * that would otherwise leave the button reading "Connecting…" forever. Two
 * seconds of headroom is enough for the message to win the race.
 */
const PROBE_DEADLINE_MS = 12_000

/** The host a base URL points at, for the in-flight status line. Null if unparseable. */
const hostOf = (url: string): string | null => {
  try {
    return new URL(url.trim()).host
  } catch {
    return null
  }
}

/** The add/edit form's working copy. `id` present ⇒ editing a saved connection. */
interface Draft {
  id?: string
  label: string
  preset: 'gateway' | 'custom'
  baseUrl: string
  wireApi: 'responses'
  models: string[]
}

const GATEWAY_LABEL = 'AI Gateway'

const newDraft = (): Draft => ({
  label: GATEWAY_LABEL,
  preset: 'gateway',
  baseUrl: GATEWAY_BASE_URL,
  wireApi: 'responses',
  models: []
})

const draftFrom = (c: ProviderConnection): Draft => ({
  id: c.id,
  label: c.label,
  preset: c.preset,
  baseUrl: c.baseUrl,
  wireApi: c.wireApi,
  models: [...c.models]
})

/** Free-text model ids → a clean, de-duped list (commas, spaces or newlines). */
const parseIds = (text: string): string[] => [
  ...new Set(
    text
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  )
]

/**
 * A URL's origin (protocol + host + port), or null when it doesn't parse. Origin —
 * not the whole string — is the unit that matters for a credential: an API key is
 * scoped to a HOST, so re-pointing `/v1` at `/v1beta` keeps it valid while moving
 * to another host invalidates it entirely.
 */
const originOf = (url: string): string | null => {
  try {
    return new URL(url.trim()).origin
  } catch {
    return null
  }
}

/**
 * Add or edit one `ProviderConnection` — three steps in one form:
 *
 * 1. Pick a preset. "Vercel AI Gateway" prefills Vercel's documented settings for
 *    connecting Codex (`https://ai-gateway.vercel.sh/v1` on the `responses` API);
 *    "Custom" asks only for a base URL — it must serve that same `responses` API,
 *    since the bundled `codex` CLI rejects the older chat-completions format.
 * 2. Name it and paste a key.
 * 3. Press Connect — ONE `providers.catalog` probe that both validates the
 *    credential and returns the catalog, rendered as a filterable checkbox list.
 *    A host with no `/models` route (`unsupported`) falls back to typing ids by
 *    hand instead of dead-ending.
 *
 * The typed key lives ONLY here, and this component is mounted only while the
 * form is open — closing or cancelling unmounts it, which is what guarantees the
 * key is dropped. It never reaches the store. Editing starts with a blank key
 * field because main never returns one; omitting `apiKey` on save preserves the
 * stored key (see `ProviderConnectionInput`).
 */
export default function ProviderForm({
  connection,
  onDone
}: {
  /** The connection being edited, or undefined when adding a new one. */
  connection?: ProviderConnection
  /** Leave the form (cancelled, or saved successfully). */
  onDone: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<Draft>(() => (connection ? draftFrom(connection) : newDraft()))
  const [apiKey, setApiKey] = useState('')
  /** Model ids to offer as checkboxes — null until a probe (or an edit) supplies them. */
  const [catalog, setCatalog] = useState<string[] | null>(
    connection?.models.length ? [...connection.models] : null
  )
  const [unsupported, setUnsupported] = useState(false)
  const [manualIds, setManualIds] = useState(connection?.models.join('\n') ?? '')
  const [filter, setFilter] = useState('')
  /**
   * The probe currently in flight, or null. Modelled as the REQUEST rather than a
   * `probing` boolean on purpose: "the button says Connecting…" and "a request is
   * outstanding" are then the same fact, so the two can't drift apart. Every exit
   * path (answer, throw, deadline, cancel, preset switch, unmount) clears it, and
   * the only case that deliberately doesn't is a NEWER probe having taken the slot
   * — which then owns clearing it.
   */
  const [inFlight, setInFlight] = useState<{
    token: number
    host: string
    startedAt: number
  } | null>(null)
  const probing = inFlight !== null
  /** Whole seconds the current probe has been waiting — the visible progress. */
  const [waited, setWaited] = useState(0)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A probe raced by a preset switch, a cancel, the deadline (or an unmount) must
  // not land: bumping this token is what disowns whatever is still outstanding.
  const probeToken = useRef(0)
  const live = useRef(true)
  useEffect(
    () => () => {
      live.current = false
    },
    []
  )

  // Tick the "…for Ns" counter while a probe is outstanding. No aria-live: a
  // number changing every second is announcement noise (same call as the chat's
  // status line); the button's own "Connecting…" label carries the state.
  useEffect(() => {
    if (!inFlight) return
    setWaited(0)
    const id = setInterval(
      () => setWaited(Math.round((Date.now() - inFlight.startedAt) / 1000)),
      1000
    )
    return () => clearInterval(id)
  }, [inFlight])

  /** Disown the outstanding probe (if any) and return the form to its idle state. */
  const dropProbe = (): void => {
    probeToken.current += 1
    setInFlight(null)
  }

  /**
   * The "Connect" probe. Takes the draft + key explicitly so it can run straight
   * from the mount effect below without waiting for a state flush. Omitting
   * `apiKey` on a saved connection reuses its stored key (`ModelCatalogInput.id`).
   */
  const probe = async (d: Draft, key: string): Promise<void> => {
    const token = ++probeToken.current
    setInFlight({ token, host: hostOf(d.baseUrl) ?? 'the endpoint', startedAt: Date.now() })
    setError(null)
    const stale = (): boolean => !live.current || token !== probeToken.current
    // Renderer-side backstop for an IPC round trip that never comes back. It
    // disowns this probe, so a late answer can no longer touch the form.
    const deadline = setTimeout(() => {
      if (stale()) return
      dropProbe()
      setError(
        `No answer from ${hostOf(d.baseUrl) ?? 'that endpoint'} after ${PROBE_DEADLINE_MS / 1000} seconds. Check the base URL, then try again.`
      )
    }, PROBE_DEADLINE_MS)
    try {
      const res = await window.api.providers.catalog({
        baseUrl: d.baseUrl.trim(),
        ...(key.trim() ? { apiKey: key.trim() } : {}),
        ...(d.id ? { id: d.id } : {})
      })
      if (stale()) return
      if (res.unsupported) {
        // No catalog route — hand the user a free-text field instead of a dead end.
        setUnsupported(true)
        setCatalog(null)
        setManualIds((prev) => prev || d.models.join('\n'))
        return
      }
      if (!res.ok) {
        setError(res.error ?? 'Couldn’t reach that endpoint.')
        return
      }
      setUnsupported(false)
      setCatalog(res.models)
    } catch (e) {
      if (stale()) return
      setError(e instanceof Error ? e.message : 'Couldn’t reach that endpoint.')
    } finally {
      clearTimeout(deadline)
      // Unconditional except for the one legitimate case: a newer probe owns the
      // slot now. Guarding this on `stale()` (as it used to) meant any path that
      // bumped the token mid-probe left the button on "Connecting…" for good.
      if (live.current) setInFlight((cur) => (cur?.token === token ? null : cur))
    }
  }

  // Editing something with a stored key: re-probe on mount so the full catalog is
  // there to add from. The already-ticked models show meanwhile (and stay put if
  // the probe fails), so the form is never empty while it loads.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only — the form is remounted (keyed) per connection, so `connection` never changes under it.
  useEffect(() => {
    if (connection?.hasKey) void probe(draftFrom(connection), '')
  }, [])

  const setPreset = (preset: 'gateway' | 'custom'): void => {
    if (draft.preset === preset) return
    dropProbe()
    setCatalog(null)
    setUnsupported(false)
    setError(null)
    setDraft(
      preset === 'gateway'
        ? { ...draft, preset, baseUrl: GATEWAY_BASE_URL }
        : {
            ...draft,
            preset,
            // Don't carry the Gateway's prefills into a custom endpoint — but do
            // keep anything the user typed themselves.
            label: draft.label === GATEWAY_LABEL ? '' : draft.label,
            baseUrl: draft.baseUrl === GATEWAY_BASE_URL ? '' : draft.baseUrl
          }
    )
  }

  const toggleModel = (id: string): void => {
    setDraft((d) => ({
      ...d,
      models: d.models.includes(id) ? d.models.filter((m) => m !== id) : [...d.models, id]
    }))
  }

  const save = async (): Promise<void> => {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      const res = await window.api.providers.save({
        ...(draft.id ? { id: draft.id } : {}),
        label: draft.label.trim(),
        preset: draft.preset,
        baseUrl: draft.baseUrl.trim(),
        wireApi: draft.wireApi,
        models: unsupported ? parseIds(manualIds) : draft.models,
        // Omitted ⇒ main keeps the stored key (that's what makes editing safe).
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {})
      })
      if (!res.ok) {
        setError(res.error ?? 'Couldn’t save that connection.')
        return
      }
      // Refresh before leaving so the chat's picker has the new models already.
      await useProviders.getState().refresh()
      if (live.current) onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t save that connection.')
    } finally {
      if (live.current) setSaving(false)
    }
  }

  // Ticked models the endpoint no longer advertises still render, so a stale pick
  // is visible (and untickable) rather than silently dropped on save.
  const allModels = catalog ? [...catalog, ...draft.models.filter((m) => !catalog.includes(m))] : []
  const needle = filter.trim().toLowerCase()
  const visibleModels = needle
    ? allModels.filter((m) => m.toLowerCase().includes(needle))
    : allModels
  const chosenCount = unsupported ? parseIds(manualIds).length : draft.models.length
  const canConnect = !!draft.baseUrl.trim() && (!!apiKey.trim() || !!connection?.hasKey)
  // `providers-store.ts#save` DROPS the stored key when an edit moves a connection to
  // a different origin — a credential must not silently follow its connection to
  // another host. So the form has to ask for a new one up front; otherwise the user
  // saves happily and lands on a keyless connection with nothing explaining why every
  // turn now 401s. An unparseable draft URL (mid-typing, or garbage) reads as changed:
  // we can't prove it's still the same host, and main fails closed on it too.
  const originChanged = !!connection && originOf(draft.baseUrl) !== originOf(connection.baseUrl)
  const canSave =
    !!draft.label.trim() &&
    !!draft.baseUrl.trim() &&
    chosenCount > 0 &&
    (!!apiKey.trim() || (!!draft.id && !originChanged))

  return (
    <>
      {/* 1 — preset */}
      <fieldset className="flex flex-col gap-1.5">
        <legend className="text-muted-foreground">Endpoint</legend>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="provider-preset"
            checked={draft.preset === 'gateway'}
            onChange={() => setPreset('gateway')}
          />
          <span>Vercel AI Gateway</span>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="provider-preset"
            checked={draft.preset === 'custom'}
            onChange={() => setPreset('custom')}
          />
          <span>Custom</span>
        </label>
        {draft.preset === 'gateway' ? (
          <p className="text-xs text-muted-foreground">
            Uses Vercel’s documented settings for Codex:{' '}
            <code className="rounded bg-muted px-1 py-0.5">{GATEWAY_BASE_URL}</code> on the{' '}
            <code className="rounded bg-muted px-1 py-0.5">responses</code> API.
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="provider-base-url" className="text-muted-foreground">
              Base URL
            </label>
            <Input
              id="provider-base-url"
              value={draft.baseUrl}
              placeholder="https://api.example.com/v1"
              onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
            />
            <span className="text-xs text-muted-foreground">
              The host must serve OpenAI’s <code>/responses</code> API. Hosts that offer only the
              older <code>/chat/completions</code> route can’t be used — the bundled{' '}
              <code>codex</code> CLI refuses that wire format.
            </span>
          </div>
        )}
      </fieldset>

      {/* 2 — name + key */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="provider-label" className="text-muted-foreground">
          Name
        </label>
        <Input
          id="provider-label"
          value={draft.label}
          placeholder={GATEWAY_LABEL}
          onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          autoFocus
        />
        <label htmlFor="provider-key" className="text-muted-foreground">
          API key
        </label>
        <Input
          id="provider-key"
          type="password"
          value={apiKey}
          autoComplete="off"
          spellCheck={false}
          placeholder={
            originChanged
              ? 'Enter the key for the new host'
              : connection?.hasKey
                ? 'Leave blank to keep the saved key'
                : 'sk-…'
          }
          onChange={(e) => setApiKey(e.target.value)}
        />
        <span className="text-xs text-muted-foreground">
          {originChanged
            ? 'This endpoint now points at a different host, so the saved key is discarded rather than sent somewhere it wasn’t issued for. Enter the key for the new host to save.'
            : connection?.hasKey
              ? 'A key is saved — leave this blank to keep it. Keys are encrypted on this Mac and never leave the main process.'
              : 'Encrypted on this Mac with the system keychain; it never comes back to the interface.'}
        </span>
      </div>

      {/* 3 — connect, then pick models. A probe can take seconds (main allows the
          host 10), so the wait is legible rather than a frozen button: a spinner,
          which host is being contacted, how long it's been, and a way out. */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          onClick={() => void probe(draft, apiKey)}
          disabled={!canConnect || probing}
        >
          {probing ? (
            <>
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              Connecting…
            </>
          ) : (
            'Connect'
          )}
        </Button>
        {probing && (
          // Stops the form waiting on it; main's own request runs to completion
          // and its answer is simply disowned (see `dropProbe`).
          <Button variant="ghost" size="sm" onClick={dropProbe} aria-label="Cancel connecting">
            Cancel
          </Button>
        )}
        <span className="text-xs text-muted-foreground">
          {inFlight
            ? `Contacting ${inFlight.host}… ${waited}s`
            : 'Checks the key and lists the models this endpoint offers.'}
        </span>
      </div>

      {unsupported && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-muted-foreground">
            This host doesn’t advertise a model catalog, so type the model ids you want — one per
            line (or comma separated).
          </span>
          <Textarea
            value={manualIds}
            onChange={(e) => setManualIds(e.target.value)}
            placeholder={'moonshotai/kimi-k2\ndeepseek/deepseek-v3'}
            className="min-h-20 font-mono text-xs"
            aria-label="Model ids"
          />
        </div>
      )}

      {!unsupported && catalog && (
        <div className="flex flex-col gap-1.5">
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter models…"
            aria-label="Filter models"
            className="h-8"
          />
          <div className="max-h-52 overflow-y-auto rounded-md border border-border p-2">
            {visibleModels.length === 0 ? (
              <p className="text-xs text-muted-foreground">No models match “{filter}”.</p>
            ) : (
              visibleModels.map((m) => (
                <label key={m} className="flex items-center gap-2 py-0.5">
                  <input
                    type="checkbox"
                    checked={draft.models.includes(m)}
                    onChange={() => toggleModel(m)}
                  />
                  <span className="truncate font-mono text-xs">{m}</span>
                </label>
              ))
            )}
          </div>
          <span className="text-xs text-muted-foreground">
            {draft.models.length} of {allModels.length} selected — these are what the chat’s model
            picker offers.
          </span>
        </div>
      )}

      {error && <p className="text-sm text-destructive whitespace-pre-wrap">{error}</p>}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button onClick={() => void save()} disabled={!canSave || saving}>
          {saving ? 'Saving…' : draft.id ? 'Save changes' : 'Save connection'}
        </Button>
      </div>
    </>
  )
}
