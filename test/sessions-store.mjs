/**
 * SessionStore unit test (pure — no Electron). The on-disk store for agent-session
 * history (v5-D): save/list/get/remove, per-project filtering, newest-first sort,
 * the per-project prune cap, and defensive id validation. Uses a temp dir.
 *
 * Run with: bun run test:sessionstore
 */
import { createSessionStore } from '../src/main/sessions-store.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const base = mkdtempSync(join(tmpdir(), 'praxis-sessions-'))
let failed = 0
const ok = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    failed++
  }
}

const rec = (id, projectKey, startedAt, extra = {}) => ({
  id,
  projectKey,
  projectRoot: projectKey,
  projectName: 'app',
  startedAt,
  endedAt: startedAt + 10,
  filesTouched: [],
  transcript: [{ role: 'user', text: 'hi', at: startedAt }],
  ...extra
})

try {
  const store = createSessionStore(base)

  // Empty store lists nothing.
  ok(store.list('/p/a').length === 0, 'empty list before any save')
  ok(store.get('nope') === null, 'get of missing id is null')

  // Save + get round-trips.
  store.save(rec('s1', '/p/a', 100, { branch: 'praxis/x', filesTouched: ['src/A.tsx'] }))
  const got = store.get('s1')
  ok(got && got.branch === 'praxis/x', 'get returns saved record with branch')
  ok(got && got.filesTouched[0] === 'src/A.tsx', 'filesTouched persisted')

  // Per-project filtering + newest-first ordering.
  store.save(rec('s2', '/p/a', 300))
  store.save(rec('s3', '/p/a', 200))
  store.save(rec('s4', '/p/b', 999))
  const a = store.list('/p/a')
  ok(a.length === 3, 'list filters to project a (3)')
  ok(
    a[0].id === 's2' && a[1].id === 's3' && a[2].id === 's1',
    'list sorts newest startedAt first'
  )
  ok(store.list('/p/b').length === 1, 'project b isolated')

  // Remove.
  store.remove('s1')
  ok(store.get('s1') === null, 'removed record is gone')
  ok(store.list('/p/a').length === 2, 'list reflects removal')

  // Prune cap: 50 per project — saving the 60th leaves the 50 most recent.
  for (let i = 0; i < 60; i++) store.save(rec(`c${i}`, '/p/c', 1000 + i))
  const c = store.list('/p/c')
  ok(c.length === 50, `prune keeps 50 (got ${c.length})`)
  ok(c[0].id === 'c59', 'newest survives prune')
  ok(!c.some((r) => r.id === 'c0'), 'oldest pruned away')

  // Unsafe ids are rejected on save and ignored on get/remove (id → filename).
  let threw = false
  try {
    store.save(rec('../escape', '/p/a', 1))
  } catch {
    threw = true
  }
  ok(threw, 'save rejects path-traversal id')
  ok(store.get('../escape') === null, 'get of unsafe id is null')

  if (failed === 0) {
    console.log('SESSIONS-STORE OK — save/list/get/remove, per-project, sort, prune cap, id guard')
  } else {
    process.exitCode = 1
  }
} catch (err) {
  console.error('SESSIONS-STORE FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  rmSync(base, { recursive: true, force: true })
}
