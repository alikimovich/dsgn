/**
 * Unit test for the per-machine diagnosis memory (no electron). Run via bun:
 * bun run test:diag-cache
 */
import assert from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recall, remember, setStatus, signatureFor } from '../src/main/diag-cache.ts'

// Signature normalizes volatile bits: same error class → same key despite paths.
const a = signatureFor("Cannot find module '@ai-sdk/xai' imported from /Users/x/dev/lkmv.ch/chat.ts")
const b = signatureFor("Cannot find module '@ai-sdk/xai' imported from /Users/y/other/chat.ts")
assert.equal(a, b, 'same error class → same signature despite different paths')
assert.notEqual(
  a,
  signatureFor("Cannot find module '@ai-sdk/openai' imported from /Users/x/chat.ts"),
  'different module → different signature'
)

const dir = mkdtempSync(join(tmpdir(), 'praxis-diag-'))
const root = '/proj/a'
const err = "Cannot find module '@ai-sdk/xai' imported from /Users/x/chat.ts"
const diag = {
  signature: signatureFor(err),
  summary: 'Missing dependency',
  detail: 'install it',
  steps: [{ text: 'install @ai-sdk/xai', command: 'bun add @ai-sdk/xai', scope: 'repo' }],
  seenBefore: false,
  status: 'proposed'
}

// Nothing remembered yet.
assert.equal(await recall(dir, root, err), null)

// remember → recall round-trips with seenBefore flipped.
await remember(dir, root, diag)
const got = await recall(dir, root, err)
assert.equal(got?.summary, 'Missing dependency')
assert.equal(got?.seenBefore, true)
assert.equal(got?.steps[0].command, 'bun add @ai-sdk/xai')

// Keyed per-project: another root doesn't recall it.
assert.equal(await recall(dir, '/proj/b', err), null)

// setStatus updates the remembered outcome.
await setStatus(dir, root, diag.signature, 'applied')
assert.equal((await recall(dir, root, err))?.status, 'applied')

rmSync(dir, { recursive: true, force: true })
console.log('DIAG-CACHE OK — signature normalization, recall/remember, per-project, status')
