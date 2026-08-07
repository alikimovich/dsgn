import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProviderConnection, ProviderConnectionInput } from '../shared/api'

/**
 * On-disk store for user-added model endpoints (v10 "connections" — see
 * `ProviderConnection`). Unlike sessions-store's file-per-record layout, every
 * connection lives in ONE `<baseDir>/providers.json`: there are a handful of them,
 * they're always read together (the picker needs all of them to build its groups),
 * and a whole-file rewrite of ~1KB is cheaper than a directory walk on every
 * `choices()` call. Writes go through a tmp+rename so a crash mid-write can't
 * leave a half-file — with a single file that would cost the user EVERY connection,
 * which is exactly the failure sessions-store dodges by sharding.
 *
 * `baseDir` is injected (the app passes the same `<userData>/praxis` dir agent.ts
 * uses); tests point it at a temp dir. So is the `SecretCipher` — that keeps
 * `electron.safeStorage` out of this module entirely, so the whole thing is a pure
 * unit test with a fake cipher (see test/providers-store.mjs).
 *
 * KEY DISCIPLINE: the encrypted key blob lives only in the on-disk record and is
 * never part of `ProviderConnection`. `list()`/`get()` return the renderer-safe
 * shape (`hasKey` only); `secretFor()` is the single door to plaintext and is
 * main-only. A key is never written unencrypted — if the platform has no keyring,
 * `save()` throws rather than degrading to plaintext.
 */
export interface SecretCipher {
  /** False when the OS has no usable credential store (a Linux box with no
   *  keyring). Callers must refuse to store a key rather than write it plainly. */
  available: boolean
  /** Plaintext → an opaque base64 blob, so the store stays plain JSON. */
  encrypt: (plain: string) => string
  /** Inverse of `encrypt`; null when the blob can't be decrypted (different
   *  machine/user, rotated OS key, hand-edited file). */
  decrypt: (blob: string) => string | null
}

export interface ProviderStore {
  /** Every connection, newest last (creation order), ALWAYS key-stripped. */
  list: () => ProviderConnection[]
  get: (id: string) => ProviderConnection | null
  /** Create (no `id`) or update (with `id`). Throws with a user-readable message
   *  on a bad draft or on an un-storable key. */
  save: (input: ProviderConnectionInput) => ProviderConnection
  remove: (id: string) => void
  /**
   * The plaintext API key for a connection, or null when there is none / it can't
   * be decrypted. MAIN-PROCESS ONLY — this value must NEVER be returned over IPC,
   * put in an `AgentEvent`, or logged. The renderer only ever learns `hasKey`.
   */
  secretFor: (id: string) => string | null
}

/**
 * Ids are generated (`randomUUID`), but a hand-edited or IPC-supplied id reaches
 * `save`/`remove`/`secretFor` too. Hold the same charset sessions-store enforces:
 * it keeps an id safe to use as a path segment if this store ever shards, and it
 * keeps junk out of the `value` strings `choices()` builds from it.
 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/

/** The disk shape: a connection plus its encrypted key. `hasKey` is derived on
 *  read, never stored, so the two can't disagree. */
type StoredConnection = Omit<ProviderConnection, 'hasKey'> & { secret?: string }

interface StoreFile {
  version: 1
  connections: StoredConnection[]
}

/** Well past anything this store writes (a key blob is ~hundreds of bytes) — a
 *  bigger file is corrupt, not merely big. */
const MAX_STORE_BYTES = 512 * 1024

export function createProviderStore(baseDir: string, cipher: SecretCipher): ProviderStore {
  const file = join(baseDir, 'providers.json')

  // Every field `toPublic` passes through has to be checked here, not just the
  // ones used for lookup: a truncated or hand-edited file with `"models": "gpt-5"`
  // would otherwise reach `choices()`, which iterates it — filling the model picker
  // with one entry per CHARACTER, under an `undefined` group heading.
  const isStored = (v: unknown): v is StoredConnection => {
    const c = v as StoredConnection | null
    return (
      !!c &&
      typeof c.id === 'string' &&
      SAFE_ID.test(c.id) &&
      typeof c.baseUrl === 'string' &&
      typeof c.label === 'string' &&
      Array.isArray(c.models) &&
      c.models.every((m) => typeof m === 'string')
    )
  }

  /** Read the store. `corrupt` distinguishes "no file yet" (fine, empty) from
   *  "a file we couldn't understand" — the latter gets preserved before a write
   *  instead of being silently overwritten with the user's other connections. */
  const load = (): { connections: StoredConnection[]; corrupt: boolean } => {
    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch {
      return { connections: [], corrupt: false } // not created yet
    }
    if (raw.length > MAX_STORE_BYTES) return { connections: [], corrupt: true }
    try {
      const parsed = JSON.parse(raw) as StoreFile
      if (!parsed || !Array.isArray(parsed.connections)) return { connections: [], corrupt: true }
      // Drop individual junk entries without failing the whole read — one
      // hand-edited record shouldn't hide every other connection.
      return { connections: parsed.connections.filter(isStored), corrupt: false }
    } catch {
      return { connections: [], corrupt: true }
    }
  }

  const write = (connections: StoredConnection[], corrupt: boolean): void => {
    mkdirSync(baseDir, { recursive: true })
    if (corrupt) {
      // Never destroy something we failed to parse: a bad file may still hold a
      // key the user can recover by hand. Best-effort — a failed rename must not
      // block the save.
      try {
        renameSync(file, `${file}.corrupt`)
      } catch {
        /* nothing to move, or no permission — proceed */
      }
    }
    const body: StoreFile = { version: 1, connections }
    const tmp = `${file}.tmp`
    // 0600: the file holds encrypted key blobs, so it has no business being
    // world-readable even though the contents are ciphertext.
    writeFileSync(tmp, JSON.stringify(body, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, file)
  }

  const toPublic = (c: StoredConnection): ProviderConnection => ({
    id: c.id,
    label: c.label,
    preset: c.preset,
    baseUrl: c.baseUrl,
    // Coerced on READ as well as write, so a hand-edited providers.json carrying
    // the retired 'chat' value can't propagate an unusable connection downstream.
    wireApi: 'responses',
    models: c.models,
    hasKey: !!c.secret
  })

  const list = (): ProviderConnection[] => load().connections.map(toPublic)

  const get = (id: string): ProviderConnection | null => {
    if (!SAFE_ID.test(id)) return null
    const found = load().connections.find((c) => c.id === id)
    return found ? toPublic(found) : null
  }

  const save = (input: ProviderConnectionInput): ProviderConnection => {
    const id = input.id?.trim() || randomUUID()
    if (!SAFE_ID.test(id)) throw new Error(`unsafe connection id: ${id}`)
    const label = (input.label ?? '').trim()
    if (!label) throw new Error('Give this connection a name.')
    // Trailing slashes would double up in every URL derived from this (the
    // catalog probe AND the baseUrl handed to the Codex SDK), so normalize once,
    // here, rather than at each use site.
    const baseUrl = (input.baseUrl ?? '').trim().replace(/\/+$/, '')
    if (!baseUrl) throw new Error('Enter the endpoint URL.')

    const { connections, corrupt } = load()
    const previous = connections.find((c) => c.id === id)

    // A key present ⇒ replace; absent ⇒ keep whatever is stored. An EMPTY string
    // counts as absent: a dialog that re-renders a masked, empty key field and
    // submits it must not be able to wipe a working key — that's the exact
    // "editing the label ate my key" bug this rule exists to prevent. Clearing a
    // key is `remove()` + re-add, which is explicit.
    const plain = typeof input.apiKey === 'string' ? input.apiKey.trim() : ''
    // SECURITY — a key is only ever kept for the ORIGIN it was entered against.
    // Re-pointing a saved connection at another host while silently carrying its
    // key over would let a caller redirect a credential it can't read to a server
    // it chooses (the key is handed to the Codex SDK on the next turn). Changing
    // the origin therefore drops the stored secret, and the connection reads as
    // keyless until the user enters one for the new host. Path-only edits
    // (…/v1 → …/v1beta) keep it — same server, same credential.
    let secret = previous && !sameOrigin(previous.baseUrl, baseUrl) ? undefined : previous?.secret
    if (plain) {
      if (!cipher.available) {
        throw new Error(
          'No OS credential store is available, so Praxis cannot store this API key ' +
            '(it will never write a key to disk in plain text). On Linux, install/unlock ' +
            'a keyring (gnome-keyring, kwallet) and try again.'
        )
      }
      secret = cipher.encrypt(plain)
    }

    const next: StoredConnection = {
      id,
      label,
      preset: input.preset === 'custom' ? 'custom' : 'gateway',
      baseUrl,
      // Always 'responses' — the bundled `codex` CLI rejects `wire_api = "chat"`
      // outright, so there is no second value to honor (see ProviderConnection).
      wireApi: 'responses',
      models: uniqueStrings(input.models),
      ...(secret ? { secret } : {})
    }

    const merged = previous
      ? connections.map((c) => (c.id === id ? next : c))
      : [...connections, next]
    write(merged, corrupt)
    return toPublic(next)
  }

  const remove = (id: string): void => {
    if (!SAFE_ID.test(id)) return
    const { connections, corrupt } = load()
    // Nothing to delete → don't rewrite (in particular, deleting an unknown id
    // must not be what finally clobbers an unparseable file).
    if (!connections.some((c) => c.id === id)) return
    write(
      connections.filter((c) => c.id !== id),
      corrupt
    )
  }

  const secretFor = (id: string): string | null => {
    if (!SAFE_ID.test(id)) return null
    const found = load().connections.find((c) => c.id === id)
    if (!found?.secret) return null
    try {
      return cipher.decrypt(found.secret)
    } catch {
      // A cipher that throws (wrong machine, rotated OS key) is the same story as
      // one that returns null: the key is gone, the caller degrades.
      return null
    }
  }

  return { list, get, save, remove, secretFor }
}

/** Trimmed, de-duplicated, order-preserving string list (model ids from a draft). */
function uniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  const out: string[] = []
  for (const v of values) {
    if (typeof v !== 'string') continue
    const s = v.trim()
    if (s && !out.includes(s)) out.push(s)
  }
  return out
}

/**
 * Blank a secret out of a string before it can be shown or persisted.
 *
 * The last line of defence for the "a key never reaches an error message" rule.
 * Needed wherever text we didn't compose can carry one — notably a spawned CLI's
 * stderr, whose environment holds the key. A no-op when `secret` is empty, so
 * callers can apply it unconditionally.
 */
export function scrubSecret(message: string, secret: string | null | undefined): string {
  return secret && message.includes(secret) ? message.split(secret).join('***') : message
}

/**
 * Do two endpoint URLs share a protocol+host+port?
 *
 * This is the single rule deciding whether a stored API key may follow a URL
 * edit — used by `save` (drop the secret when the origin changes) and by the
 * catalog probe (refuse a stored key aimed at a different host). A credential
 * belongs to the host it was issued for; letting it follow an arbitrary URL
 * change is how a caller that cannot READ a key still gets it SENT somewhere.
 * Unparseable input reads as different, so the failure mode is "ask for the key
 * again" rather than "send it anyway".
 */
export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}

/**
 * The catalog URL for an endpoint root: `<baseUrl>/models`.
 *
 * Deliberately NOT clever about `/v1`. An OpenAI-compatible baseUrl already IS
 * the versioned root (`https://ai-gateway.vercel.sh/v1`), and the same string is
 * later handed to the Codex SDK — so injecting a `/v1` the user didn't type would
 * make the probe validate a URL the actual turns never call, turning "Connect
 * worked" into a mystery 404 at chat time. A root that already ends in `/v1`
 * therefore needs no special case, and one that doesn't is taken at its word.
 * Tolerates trailing slashes, and is idempotent if the user pastes the full
 * `/models` URL (a natural thing to copy out of a provider's docs).
 */
export function modelsUrl(baseUrl: string): string {
  const trimmed = (baseUrl ?? '').trim().replace(/\/+$/, '')
  if (/\/models$/i.test(trimmed)) return trimmed
  return `${trimmed}/models`
}

/**
 * Model ids out of a `/models` response body. The standard OpenAI shape is
 * `{data:[{id}]}`, but "OpenAI-compatible" hosts are only compatible up to a
 * point: some answer with `{models:[…]}` and some with a bare array, and entries
 * come as either objects or plain strings. Accept all of them, ignore anything
 * malformed (never throw — this parses a hostile/unknown body), and return sorted
 * unique ids so the dialog's checkbox list has a stable order.
 */
export function parseModelCatalog(json: unknown): string[] {
  const root = json as { data?: unknown; models?: unknown } | null
  const entries = Array.isArray(json)
    ? json
    : Array.isArray(root?.data)
      ? root.data
      : Array.isArray(root?.models)
        ? root.models
        : []
  const ids = new Set<string>()
  for (const entry of entries) {
    let id: unknown
    if (typeof entry === 'string') id = entry
    else if (entry && typeof entry === 'object') {
      // `name` covers the local-runtime shapes (Ollama/LM Studio native lists),
      // which otherwise parse to an empty catalog.
      const e = entry as { id?: unknown; name?: unknown }
      id = typeof e.id === 'string' ? e.id : e.name
    }
    if (typeof id !== 'string') continue
    const trimmed = id.trim()
    if (trimmed) ids.add(trimmed)
  }
  return [...ids].sort()
}
