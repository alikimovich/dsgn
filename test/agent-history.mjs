/**
 * Agent-session history capture + persistence (v5-D) through real IPC, no Claude
 * creds needed. We don't run a real turn; we prove the record is captured and
 * persisted on teardown, and listable afterward:
 *
 *   open A, tag branch, send a prompt   → user message recorded synchronously
 *   close A                             → session persisted as the current Main slot
 *   sessions.list(A)                    → empty (Main is not History)
 *   open A again                        → workspace snapshot paints the same transcript
 *   clearMainContext                    → that thread is archived into History
 *   sessions.get(id) / remove(id)       → round-trip + cleanup
 *
 * Run with: bun run test:agenthistory
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'
import { _electron as electron } from 'playwright'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const A = join(root, 'test', 'fixtures', 'static-app')

let app
try {
  app = await electron.launch({
    executablePath: electronPath,
    args: [join(root, 'out', 'main', 'index.js')],
    cwd: root
  })
  const win = await app.firstWindow()
  await win.waitForSelector('.empty__open', { timeout: 15000 })
  await win.evaluate(() =>
    window.__praxisWorkspace.getState().openOrActivate('/tmp/praxis-test-project')
  )
  await win.waitForSelector('.composer__input', { timeout: 15000 })

  const list = (d) => win.evaluate((p) => window.api.sessions.list(p), d)
  const get = (id) => win.evaluate((i) => window.api.sessions.get(i), id)
  const remove = (id) => win.evaluate((i) => window.api.sessions.remove(i), id)
  const assert = (cond, msg) => {
    if (!cond) throw new Error(msg)
  }

  // Records from prior runs key on the same fixture path — snapshot existing ids
  // so we can isolate (and clean up) the one this run creates.
  const before = new Set((await list(A)).map((r) => r.id))

  // Open, tag a branch, send a prompt (the turn 401s without creds; the user
  // message is recorded synchronously before any SDK interaction), then close.
  await win.evaluate((p) => window.api.agent.openProject(p), A)
  await win.evaluate((p) => window.api.agent.tagSession(p, { branch: 'praxis/history-test' }), A)
  await win.evaluate((p) => window.api.agent.send('make the header blue'), A)
  await new Promise((r) => setTimeout(r, 300))
  await win.evaluate((p) => window.api.agent.closeProject(p), A)
  await new Promise((r) => setTimeout(r, 200))

  // Closed Main is the current thread, not a History row.
  const afterClose = await list(A)
  assert(
    afterClose.filter((r) => !before.has(r.id)).length === 0,
    `closed Main must not appear in History, got ${afterClose.filter((r) => !before.has(r.id)).length}`
  )

  // Reopen restores that thread onto Main.
  await win.evaluate((p) => window.api.agent.openProject(p), A)
  const snap = await win.evaluate(() => window.api.agent.workspaceSnapshot())
  const live = snap.projects
    .find((p) => p.root === A)
    ?.chats.find((c) => !c.sessionKey.includes('#'))
  assert(live, 'reopen restores a live Main chat')
  assert(
    live.record.transcript.some((t) => t.role === 'user' && t.text === 'make the header blue'),
    'reopened Main keeps the prompt'
  )
  assert(
    live.record.branch === 'praxis/history-test',
    `branch tag survived reopen (got ${live.record.branch})`
  )

  // Clear context archives it into History.
  const cleared = await win.evaluate((p) => window.api.agent.clearMainContext(p), A)
  assert(cleared.ok, `clearMainContext ok (got ${cleared.error ?? 'ok'})`)
  await new Promise((r) => setTimeout(r, 200))
  const after = await list(A)
  const fresh = after.filter((r) => !before.has(r.id))
  assert(fresh.length === 1, `expected exactly one archived record, got ${fresh.length}`)
  const rec = fresh[0]
  assert(rec.branch === 'praxis/history-test', `branch tag persisted (got ${rec.branch})`)
  assert(typeof rec.endedAt === 'number', 'endedAt set on teardown')
  assert(rec.projectKey && rec.projectRoot === A, 'project identity recorded')
  assert(
    rec.transcript.some((t) => t.role === 'user' && t.text === 'make the header blue'),
    'user prompt captured in transcript'
  )
  assert(!rec.slot, 'archived Main is no longer the current slot')

  // get() round-trips by id; remove() cleans up.
  const byId = await get(rec.id)
  assert(byId && byId.id === rec.id, 'sessions.get returns the record by id')
  await remove(rec.id)
  assert((await get(rec.id)) === null, 'sessions.remove deletes the record')

  console.log('AGENT-HISTORY OK — Main persists across close/open, clear archives to History')
} catch (err) {
  console.error('AGENT-HISTORY FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  await app?.close()
}
