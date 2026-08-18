/**
 * Agent-session history capture + persistence (v5-D) through real IPC, no Claude
 * creds needed. We don't run a real turn; we prove the record is captured and
 * persisted on teardown, and listable afterward:
 *
 *   open A, tag branch, send a prompt   → user message recorded synchronously
 *   close A                             → session persisted as a History row
 *   sessions.list(A)                    → that conversation
 *   open A again                        → live Main is empty (start from new)
 *   sessions.list(A)                    → previous Main still in History
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

  // Closed Main is a History row (continue via Resume; reopen starts a blank Main).
  const afterClose = await list(A)
  const archived = afterClose.filter((r) => !before.has(r.id))
  assert(archived.length === 1, `closed Main must appear in History, got ${archived.length}`)
  const rec = archived[0]
  assert(rec.branch === 'praxis/history-test', `branch tag persisted (got ${rec.branch})`)
  assert(typeof rec.endedAt === 'number', 'endedAt set on teardown')
  assert(rec.projectKey && rec.projectRoot === A, 'project identity recorded')
  assert(
    rec.transcript.some((t) => t.role === 'user' && t.text === 'make the header blue'),
    'user prompt captured in transcript'
  )

  // Reopen starts a blank Main; the previous thread stays in History.
  await win.evaluate((p) => window.api.agent.openProject(p), A)
  const snap = await win.evaluate(() => window.api.agent.workspaceSnapshot())
  const live = snap.projects
    .find((p) => p.root === A)
    ?.chats.find((c) => !c.sessionKey.includes('#'))
  assert(live, 'reopen starts a live Main chat')
  assert(
    !live.record.transcript.some((t) => t.role === 'user' && t.text === 'make the header blue'),
    'reopened Main is empty (previous thread is History, not restored in place)'
  )
  const afterReopen = await list(A)
  assert(
    afterReopen.some((r) => r.id === rec.id),
    'previous Main remains a History row after reopen'
  )

  // get() round-trips by id; remove() cleans up.
  const byId = await get(rec.id)
  assert(byId && byId.id === rec.id, 'sessions.get returns the record by id')
  await remove(rec.id)
  assert((await get(rec.id)) === null, 'sessions.remove deletes the record')

  console.log('AGENT-HISTORY OK — closed Main is History; reopen starts a blank Main')
} catch (err) {
  console.error('AGENT-HISTORY FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  await app?.close()
}
