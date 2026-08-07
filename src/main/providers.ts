import { join } from 'node:path'
import { app, ipcMain, safeStorage } from 'electron'
import type {
  ModelCatalogInput,
  ModelCatalogResult,
  ModelChoice,
  ProviderConnection,
  ProviderConnectionInput
} from '../shared/api'
import { discoverCodexModels } from './codex-models'
import {
  type CatalogBackend,
  type CatalogModel,
  createModelCatalog,
  type ModelCatalog,
  setModelCatalog
} from './model-catalog'
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
// Same lazy shape, same reason: `getDataDir` isn't final (and `app.getPath`
// throws) until `registerProviderIpc` has run.
let _modelCatalog: ModelCatalog | null = null
const modelCatalog = (): ModelCatalog =>
  (_modelCatalog ??= createModelCatalog({ baseDir: getDataDir() }))

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
// Built-in seats: live model discovery
//
// The halves this orchestrates live elsewhere: `model-catalog.ts` (pure — the
// parsers and the TTL/disk cache) and `codex-models.ts` (finding and running the
// CLI). What's here is WHEN to ask: one probe in flight, a floor between
// attempts, never on the render path. The Claude half needs no scheduler —
// `backends/claude.ts` volunteers its answer whenever a session exists.
// ---------------------------------------------------------------------------

/** Don't re-spawn a failing CLI on every picker render. A machine with no Codex
 *  set up answers `[]` forever, which leaves the entry stale forever, so
 *  staleness alone can't be the gate. */
const CODEX_RETRY_MS = 5 * 60_000
/** How long a COLD `providers:choices` may wait on the first probe (see the IPC
 *  handler). Only ever paid once, before any list has been cached to disk. */
const COLD_START_WAIT_MS = 2_500

let codexProbe: Promise<void> | null = null
let codexProbedAt = 0

/**
 * Refresh the Codex list if it's due, at most one probe in flight. Returns a
 * promise that settles when the current probe does (already-resolved when
 * nothing needed doing), so the cold-start path can wait on it — but it is
 * never REQUIRED to be awaited, and it never rejects.
 */
function refreshCodexModels(): Promise<void> {
  if (codexProbe) return codexProbe
  try {
    if (!modelCatalog().isStale('codex')) return Promise.resolve()
  } catch {
    return Promise.resolve()
  }
  if (codexProbedAt && Date.now() - codexProbedAt < CODEX_RETRY_MS) return Promise.resolve()
  codexProbedAt = Date.now()
  codexProbe = discoverCodexModels()
    .then((models) => {
      modelCatalog().set('codex', models) // a no-op for the empty (failed) list
    })
    .catch(() => {
      /* discoverCodexModels already swallows; belt-and-braces */
    })
    .finally(() => {
      codexProbe = null
    })
  return codexProbe
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
 * LAST-RESORT fallbacks — used only when a seat has never been discovered
 * successfully (see `model-catalog.ts`): no cache on disk, and either the Codex
 * CLI can't be asked or no Claude session has ever run on this install.
 *
 * These are NOT curation. A hardcoded list is exactly the bug this change
 * exists to fix: the picker went on offering "GPT-5 Codex"/"GPT-5" for months
 * after the CLI had moved to the GPT-5.6 family, so users' first act was to pick
 * a model that no longer existed. Both harnesses can be asked — `codex debug
 * models` and the Agent SDK's `Query.supportedModels()` — and the answer is
 * cached to disk, so these arrays should be reached ~once per install at most.
 *
 * They are a snapshot of what discovery returned on 2026-08-07 and WILL rot.
 * When they're wrong the seat is almost certainly unusable anyway (no working
 * CLI / never-authenticated account), so they exist to keep the picker from
 * rendering empty, not to be right.
 */
const CLAUDE_FALLBACK: Array<[modelId: string, label: string]> = [
  // Left exactly as the curated array had them (minus the sentinel, which
  // `builtinChoices` now prepends): these short aliases are what shipped, and a
  // fallback that quietly drops a model the user could pick before would be its
  // own regression. Discovery returns the fuller ids (`claude-fable-5[1m]`, …).
  ['fable', 'Fable'],
  ['opus', 'Opus'],
  ['sonnet', 'Sonnet'],
  ['haiku', 'Haiku']
]
const CODEX_FALLBACK: Array<[modelId: string, label: string]> = [
  ['gpt-5.6-sol', 'GPT-5.6-Sol'],
  ['gpt-5.6-terra', 'GPT-5.6-Terra'],
  ['gpt-5.6-luna', 'GPT-5.6-Luna'],
  ['gpt-5.5', 'GPT-5.5']
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
 * One built-in seat's group: the "Default" sentinel, then whatever discovery
 * found — or the last-resort array when it has never found anything.
 *
 * The sentinel is prepended here rather than living in the lists, because BOTH
 * sources of truth can carry their own: the Agent SDK's `supportedModels()`
 * leads with `{value: 'default', displayName: 'Default (recommended)'}`, whose
 * value collides exactly with ours. Two choices sharing a `value` would be a
 * duplicate React key and an ambiguous `resolveChoice` match, so a discovered
 * `default` is dropped in favour of praxis's own entry — which the renderer and
 * `agentModelId` ("modelId === 'default' ⇒ send no model") depend on being first.
 */
function builtinChoices(
  provider: CatalogBackend,
  group: string,
  fallback: Array<[modelId: string, label: string]>
): ModelChoice[] {
  // Total by construction: a catalog read never throws, but `modelCatalog()`
  // itself reaches `app.getPath` on first use, and `choices()` must never throw.
  let discovered: CatalogModel[] | null = null
  try {
    discovered = modelCatalog().get(provider)
  } catch {
    /* data dir not resolvable yet — use the fallback */
  }
  const models = discovered?.length
    ? discovered
    : fallback.map(([id, label]) => ({ id, label }) as CatalogModel)
  return [
    { id: DEFAULT_MODEL, label: 'Default' },
    ...models.filter((m) => m.id !== DEFAULT_MODEL)
  ].map((m) => ({
    value: choiceValue(provider, m.id),
    label: m.label,
    provider,
    modelId: m.id,
    group
  }))
}

/** The stored connections, or none if the store can't be read at all. Same
 *  totality rule as `builtinChoices`: `choices()` must never throw. */
function connections(): ProviderConnection[] {
  try {
    return store().list()
  } catch {
    return []
  }
}

/**
 * Every model the chat picker should offer: the two built-in seats first, then one
 * group per connection (labelled with the connection's own name). Recomputed per
 * call, so it always reflects the store — including a connection deleted a moment
 * ago. Keyless connections are still listed: hiding a user's own configuration is
 * more confusing than the turn-time error, and the backend gates on
 * `resolveConnection` anyway.
 *
 * FAST AND TOTAL. Every read here is off an already-loaded cache or a small
 * JSON file, and nothing in it can throw or await: this runs on the picker's
 * render path, so discovery happens BEHIND it (`refreshCodexModels`, and
 * `backends/claude.ts` handing back `supportedModels()`), never inside it.
 */
export function choices(): ModelChoice[] {
  const out: ModelChoice[] = [
    ...builtinChoices('claude', 'Claude', CLAUDE_FALLBACK),
    ...builtinChoices('codex', 'Codex', CODEX_FALLBACK)
  ]
  for (const conn of connections()) {
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
  // From here on `getDataDir` is final, so the catalog can be built and shared.
  // `backends/claude.ts` feeds the Claude half through it (`recordClaudeModels`)
  // — the SDK will only name its models from inside a live query.
  setModelCatalog(modelCatalog())
  // Warm the Codex half NOW, at app start, rather than waiting for the first
  // picker render: the probe is a ~1s subprocess, and this runs long before a
  // window exists, so by the time the renderer asks the answer is already there.
  void refreshCodexModels()

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

  // `choices()` is synchronous and serves whatever is cached; the refresh runs
  // behind it. The ONE exception is a genuinely COLD catalog (first-ever launch,
  // nothing on disk), where answering instantly would pin the last-resort list
  // for the whole session — the renderer's providers-store fetches once and keeps
  // the result. There, briefly wait on the probe already running since
  // registration. Bounded twice (the execFile timeout AND this race), and the
  // timer is unref'd, so a wedged CLI can neither hang the picker nor hold the
  // event loop open.
  ipcMain.handle('providers:choices', async (): Promise<ModelChoice[]> => {
    let cold = false
    try {
      cold = modelCatalog().get('codex') === null
    } catch {
      /* no data dir yet — treat as warm and just serve the fallback */
    }
    const refreshing = refreshCodexModels()
    if (cold) {
      await Promise.race([
        refreshing,
        new Promise<void>((resolve) => {
          setTimeout(resolve, COLD_START_WAIT_MS).unref?.()
        })
      ])
    }
    return choices()
  })
}
