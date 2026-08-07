/**
 * ProviderStore unit test (pure — no Electron). The v10 store for user-added
 * model endpoints: create/update round-trip, the "omitted apiKey keeps the stored
 * key" rule, the guarantee that a secret never leaves via list()/get(), the refusal
 * to write a key with no cipher available, and degrading to empty on a corrupt
 * file. Also covers the two pure helpers the network layer leans on (modelsUrl,
 * parseModelCatalog). Injects a FAKE cipher and a temp dir — that injection is the
 * whole reason safeStorage lives in providers.ts and not in the store.
 *
 * Run with: bun run test:providers
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createProviderStore,
  modelsUrl,
  parseModelCatalog,
  sameOrigin,
  scrubSecret
} from '../src/main/providers-store.ts'

const base = mkdtempSync(join(tmpdir(), 'praxis-providers-'))
let failed = 0
const ok = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    failed++
  }
}

// A reversible stand-in for safeStorage: base64 with a marker, so a test can tell
// "encrypted" from "plaintext on disk" by eye.
const fakeCipher = (available = true) => ({
  available,
  encrypt: (plain) => `enc:${Buffer.from(plain, 'utf8').toString('base64')}`,
  decrypt: (blob) =>
    blob.startsWith('enc:') ? Buffer.from(blob.slice(4), 'base64').toString('utf8') : null
})

const draft = (extra = {}) => ({
  label: 'AI Gateway',
  preset: 'gateway',
  baseUrl: 'https://ai-gateway.vercel.sh/v1',
  wireApi: 'responses',
  models: ['moonshotai/kimi-k2'],
  ...extra
})

const file = join(base, 'providers.json')

try {
  // --- create / update round-trip -----------------------------------------
  const store = createProviderStore(base, fakeCipher())
  ok(store.list().length === 0, 'empty store lists nothing')
  ok(store.get('nope') === null, 'get of missing id is null')

  const created = store.save(draft({ apiKey: 'sk-secret-1' }))
  ok(!!created.id, 'save generates an id when none is given')
  ok(created.hasKey === true, 'created connection reports hasKey')
  ok(created.baseUrl === 'https://ai-gateway.vercel.sh/v1', 'baseUrl round-trips')
  ok(store.secretFor(created.id) === 'sk-secret-1', 'secretFor decrypts the stored key')

  const updated = store.save(draft({ id: created.id, label: 'Gateway (work)', models: ['a', 'b'] }))
  ok(store.list().length === 1, 'saving with an id updates in place, never duplicates')
  ok(updated.label === 'Gateway (work)', 'label updated')
  ok(updated.models.join() === 'a,b', 'models replaced')

  // --- apiKey omitted preserves the stored key -----------------------------
  ok(updated.hasKey === true, 'update without apiKey keeps hasKey')
  ok(store.secretFor(created.id) === 'sk-secret-1', 'update without apiKey keeps the KEY itself')
  // An empty string counts as "omitted" — a re-submitted blank field must not wipe a key.
  store.save(draft({ id: created.id, apiKey: '   ' }))
  ok(store.secretFor(created.id) === 'sk-secret-1', 'blank apiKey does not wipe the stored key')
  // A real key replaces.
  store.save(draft({ id: created.id, apiKey: 'sk-secret-2' }))
  ok(store.secretFor(created.id) === 'sk-secret-2', 'a new apiKey replaces the stored one')

  // --- a stored key must not follow the URL to another host ----------------
  // The attack this blocks: a caller that cannot READ a key re-points a saved
  // connection at a host it controls and lets the next turn SEND the key there.
  // A path-only edit is the same server, so the key survives that.
  store.save(draft({ id: created.id, baseUrl: 'https://ai-gateway.vercel.sh/v1beta' }))
  ok(
    store.secretFor(created.id) === 'sk-secret-2',
    'a path-only URL edit keeps the stored key (same origin)'
  )
  store.save(draft({ id: created.id, baseUrl: 'https://attacker.example/v1' }))
  ok(
    store.secretFor(created.id) === null,
    'changing the endpoint ORIGIN drops the stored key rather than redirecting it'
  )
  ok(store.get(created.id).hasKey === false, 'the connection then reads as keyless')
  // Supplying a key for the new host in the same call is the supported way through.
  store.save(draft({ id: created.id, baseUrl: 'https://attacker.example/v1', apiKey: 'sk-new' }))
  ok(store.secretFor(created.id) === 'sk-new', 'an explicit key for the new origin is stored')
  // Put it back so later assertions see the original endpoint.
  store.save(draft({ id: created.id, apiKey: 'sk-secret-2' }))

  // --- list()/get() never leak a secret ------------------------------------
  const listed = store.list()[0]
  ok(!('secret' in listed) && !('apiKey' in listed), 'list() strips every key field')
  ok(listed.hasKey === true, 'list() sets hasKey for a connection with a key')
  ok(!JSON.stringify(store.list()).includes('sk-secret'), 'no plaintext key anywhere in list()')
  ok(!JSON.stringify(store.get(created.id)).includes('sk-secret'), 'get() is key-free too')
  const onDisk = readFileSync(file, 'utf8')
  ok(!onDisk.includes('sk-secret-2'), 'the key is NOT stored in plaintext on disk')
  ok(onDisk.includes('enc:'), 'the key is stored through the cipher')

  // A keyless connection reports hasKey false and yields no secret.
  const keyless = store.save(
    draft({ label: 'Local', preset: 'custom', baseUrl: 'http://127.0.0.1:1234/v1/' })
  )
  ok(keyless.hasKey === false, 'connection saved without a key reports hasKey false')
  ok(store.secretFor(keyless.id) === null, 'secretFor is null with no stored key')
  ok(keyless.baseUrl === 'http://127.0.0.1:1234/v1', 'a trailing slash is normalized off baseUrl')

  // --- remove --------------------------------------------------------------
  store.remove(keyless.id)
  ok(store.get(keyless.id) === null, 'removed connection is gone')
  ok(store.list().length === 1, 'list reflects removal')
  store.remove('../escape') // unsafe id: ignored, not thrown
  ok(store.list().length === 1, 'remove of an unsafe id is a no-op')

  // --- validation ----------------------------------------------------------
  const throws = (fn) => {
    try {
      fn()
      return false
    } catch {
      return true
    }
  }
  ok(
    throws(() => store.save(draft({ label: '  ' }))),
    'save rejects an empty label'
  )
  ok(
    throws(() => store.save(draft({ baseUrl: '' }))),
    'save rejects an empty baseUrl'
  )
  ok(
    throws(() => store.save(draft({ id: '../escape' }))),
    'save rejects a path-traversal id'
  )

  // --- no cipher available: refuse rather than write plaintext --------------
  const lockedBase = mkdtempSync(join(tmpdir(), 'praxis-providers-locked-'))
  try {
    const locked = createProviderStore(lockedBase, fakeCipher(false))
    ok(
      throws(() => locked.save(draft({ apiKey: 'sk-plaintext' }))),
      'save throws when a key is supplied but no cipher is available'
    )
    ok(locked.list().length === 0, 'the rejected save wrote nothing at all')
    // Same store, no key → still fine (a connection may be configured before the key).
    const nokey = locked.save(draft())
    ok(nokey.hasKey === false, 'a keyless save works without a cipher')
  } finally {
    rmSync(lockedBase, { recursive: true, force: true })
  }

  // --- corrupt file degrades to empty --------------------------------------
  const badBase = mkdtempSync(join(tmpdir(), 'praxis-providers-bad-'))
  try {
    const badFile = join(badBase, 'providers.json')
    writeFileSync(badFile, '{not json at all', 'utf8')
    const bad = createProviderStore(badBase, fakeCipher())
    ok(bad.list().length === 0, 'corrupt JSON lists as empty rather than throwing')
    ok(bad.get('anything') === null, 'get on a corrupt store is null')
    ok(bad.secretFor('anything') === null, 'secretFor on a corrupt store is null')
    const revived = bad.save(draft({ apiKey: 'sk-after-corruption' }))
    ok(bad.list().length === 1, 'a save recovers the store')
    ok(bad.secretFor(revived.id) === 'sk-after-corruption', 'the recovered store round-trips a key')
    ok(
      readFileSync(`${badFile}.corrupt`, 'utf8') === '{not json at all',
      'the unparseable file is preserved beside the new one, not destroyed'
    )
    // A file whose shape is wrong (valid JSON, no connections array) is corrupt too.
    writeFileSync(badFile, '{"version":1}', 'utf8')
    ok(createProviderStore(badBase, fakeCipher()).list().length === 0, 'wrong-shape store is empty')
    // A single junk ENTRY must not hide its healthy neighbours.
    writeFileSync(
      badFile,
      JSON.stringify({
        version: 1,
        connections: [
          { nope: true },
          {
            id: 'ok1',
            label: 'X',
            preset: 'custom',
            baseUrl: 'https://x/v1',
            wireApi: 'chat',
            models: []
          }
        ]
      }),
      'utf8'
    )
    const partial = createProviderStore(badBase, fakeCipher()).list()
    ok(partial.length === 1 && partial[0].id === 'ok1', 'a junk entry is skipped, the rest survive')
    // That fixture carries the retired wireApi 'chat' (the bundled codex CLI rejects
    // it), so reading it proves the on-read coercion, not just the on-save one.
    ok(partial[0].wireApi === 'responses', 'a retired wireApi on disk is coerced on read')
  } finally {
    rmSync(badBase, { recursive: true, force: true })
  }

  // --- modelsUrl -----------------------------------------------------------
  ok(
    modelsUrl('https://ai-gateway.vercel.sh/v1') === 'https://ai-gateway.vercel.sh/v1/models',
    'joins /models onto a /v1 root'
  )
  ok(
    modelsUrl('https://ai-gateway.vercel.sh/v1/') === 'https://ai-gateway.vercel.sh/v1/models',
    'tolerates a trailing slash'
  )
  ok(
    modelsUrl('https://ai-gateway.vercel.sh/v1///') === 'https://ai-gateway.vercel.sh/v1/models',
    'tolerates repeated trailing slashes'
  )
  ok(
    modelsUrl('https://api.example.com') === 'https://api.example.com/models',
    'does not invent a /v1 segment'
  )
  ok(
    modelsUrl('  http://127.0.0.1:1234/v1  ') === 'http://127.0.0.1:1234/v1/models',
    'trims surrounding whitespace'
  )
  ok(
    modelsUrl('https://api.example.com/v1/models') === 'https://api.example.com/v1/models',
    'is idempotent on a full /models URL'
  )

  // --- parseModelCatalog ---------------------------------------------------
  ok(
    parseModelCatalog({ data: [{ id: 'b' }, { id: 'a' }] }).join() === 'a,b',
    'OpenAI {data:[{id}]} shape, sorted'
  )
  ok(parseModelCatalog({ models: ['z', 'y'] }).join() === 'y,z', 'bare {models:[…]} of strings')
  ok(parseModelCatalog(['gpt-5', 'gpt-4o']).join() === 'gpt-4o,gpt-5', 'bare array fallback')
  ok(
    parseModelCatalog({ models: [{ name: 'llama3' }] }).join() === 'llama3',
    'object entries may use name'
  )
  ok(
    parseModelCatalog({ data: [{ id: 'a' }, 'a', { id: '' }, { id: 5 }, null, 42] }).join() === 'a',
    'malformed entries ignored, ids de-duplicated'
  )
  ok(parseModelCatalog(null).length === 0, 'null body → no models')
  ok(parseModelCatalog('<html>').length === 0, 'a non-JSON-object body → no models')
  ok(parseModelCatalog({ data: {} }).length === 0, 'non-array data → no models')

  // --- sameOrigin (the one rule gating whether a key may follow a URL) ------
  ok(sameOrigin('https://h/v1', 'https://h/v1beta'), 'same host, different path → same origin')
  ok(!sameOrigin('https://h/v1', 'https://other/v1'), 'different host → different origin')
  ok(!sameOrigin('https://h/v1', 'http://h/v1'), 'protocol change counts as different')
  ok(!sameOrigin('https://h/v1', 'https://h:8443/v1'), 'port change counts as different')
  // Fails CLOSED: an unparseable URL must read as different, so the fallout is
  // "ask for the key again" rather than "send it to something we couldn't parse".
  ok(!sameOrigin('not a url', 'not a url'), 'unparseable input reads as a different origin')

  // --- scrubSecret ---------------------------------------------------------
  ok(scrubSecret('boom sk-abc123 boom', 'sk-abc123') === 'boom *** boom', 'the secret is blanked')
  ok(
    !scrubSecret('a sk-k b sk-k c', 'sk-k').includes('sk-k'),
    'every occurrence is blanked, not just the first'
  )
  ok(scrubSecret('nothing to do', 'sk-k') === 'nothing to do', 'untouched when absent')
  ok(scrubSecret('keep me', null) === 'keep me', 'a null secret is a no-op (the ChatGPT seat)')
  ok(scrubSecret('keep me', '') === 'keep me', 'an empty secret is a no-op')

  // --- a malformed entry can't reach the picker ----------------------------
  // `choices()` iterates `models`; a string there would be walked CHARACTER by
  // character, so the shape has to be rejected at the read boundary.
  const junkBase = mkdtempSync(join(tmpdir(), 'praxis-providers-junk-'))
  try {
    writeFileSync(
      join(junkBase, 'providers.json'),
      JSON.stringify({
        version: 1,
        connections: [
          {
            id: 'strmodels',
            label: 'X',
            preset: 'custom',
            baseUrl: 'https://x/v1',
            models: 'gpt-5'
          },
          { id: 'nolabel', preset: 'custom', baseUrl: 'https://x/v1', models: [] },
          { id: 'good', label: 'OK', preset: 'custom', baseUrl: 'https://x/v1', models: ['gpt-5'] }
        ]
      }),
      'utf8'
    )
    const kept = createProviderStore(junkBase, fakeCipher()).list()
    ok(
      kept.length === 1 && kept[0].id === 'good',
      'entries with a bad models/label shape are dropped'
    )
  } finally {
    rmSync(junkBase, { recursive: true, force: true })
  }

  if (failed === 0) {
    console.log(
      'PROVIDERS-STORE OK — CRUD, key preservation, origin-change key drop, no secret leaks, cipher guard, corrupt-file recovery, sameOrigin, scrubSecret, modelsUrl, parseModelCatalog'
    )
  } else {
    process.exitCode = 1
  }
} catch (err) {
  console.error('PROVIDERS-STORE FAILED:', err?.stack ?? err?.message ?? err)
  process.exitCode = 1
} finally {
  rmSync(base, { recursive: true, force: true })
}
