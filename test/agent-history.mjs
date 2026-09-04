/**
 * Agent-session history capture + persistence (v5-D) through real IPC, no Claude
 * creds needed. We don't run a real turn; we prove the record is captured and
 * persisted on teardown, and listable afterward:
 *
 *   open A, send in first + second chats → both transcripts record synchronously
 *   close A while second is active       → second becomes current; first enters History
 *   open A again                         → current chat continues under the ordinary first key
 *   sessions.get(id) / remove(id)        → History round-trip + cleanup
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

  // Open, tag a branch, and send in two peer chats (turns may 401 without creds;
  // user messages are recorded synchronously before SDK interaction), then close
  // while the newer chat is active.
  await win.evaluate((p) => window.api.agent.openProject(p), A)
  await win.evaluate((p) => window.api.agent.tagSession(p, { branch: 'praxis/history-test' }), A)
  await win.evaluate(() => window.api.agent.send('first chat prompt'))
  await new Promise((r) => setTimeout(r, 300))
  const added = await win.evaluate((p) => window.api.agent.newChat(p), A)
  assert(added.ok && added.sessionKey, `second peer chat opens (${added.error ?? 'ok'})`)
  await win.evaluate((p) => window.api.agent.tagSession(p, { branch: 'praxis/history-test' }), A)
  await win.evaluate(() => window.api.agent.send('last active chat prompt'))
  await new Promise((r) => setTimeout(r, 300))
  await win.evaluate((p) => window.api.agent.closeProject(p), A)
  await new Promise((r) => setTimeout(r, 200))

  // The inactive peer is History; the last-active peer is the hidden current slot.
  const afterClose = await list(A)
  const newlyArchived = afterClose.filter((r) => !before.has(r.id))
  assert(
    newlyArchived.length === 1,
    `expected one inactive peer in History, got ${newlyArchived.length}`
  )
  assert(
    newlyArchived[0].transcript.some((t) => t.text === 'first chat prompt'),
    'the inactive peer is the chat archived to History'
  )

  // Reopen restores whichever peer was last active, with no Main role in the UI.
  await win.evaluate((p) => window.api.agent.openProject(p), A)
  const snap = await win.evaluate(() => window.api.agent.workspaceSnapshot())
  const live = snap.projects
    .find((p) => p.root === A)
    ?.chats.find((c) => !c.sessionKey.includes('#'))
  assert(live, 'reopen restores a live current chat')
  assert(
    live.record.transcript.some((t) => t.role === 'user' && t.text === 'last active chat prompt'),
    'reopened chat keeps the last-active peer transcript'
  )
  assert(
    live.record.branch === 'praxis/history-test',
    `branch tag survived reopen (got ${live.record.branch})`
  )

  const rec = newlyArchived[0]
  assert(rec.branch === 'praxis/history-test', `branch tag persisted (got ${rec.branch})`)
  assert(typeof rec.endedAt === 'number', 'endedAt set on teardown')
  assert(rec.projectKey && rec.projectRoot === A, 'project identity recorded')
  assert(
    rec.transcript.some((t) => t.role === 'user' && t.text === 'first chat prompt'),
    'user prompt captured in transcript'
  )
  assert(!rec.slot, 'archived peer is not the current slot')

  // get() round-trips by id; remove() cleans up.
  const byId = await get(rec.id)
  assert(byId && byId.id === rec.id, 'sessions.get returns the record by id')
  await remove(rec.id)
  assert((await get(rec.id)) === null, 'sessions.remove deletes the record')

  console.log('AGENT-HISTORY OK — last-active peer persists; inactive peers enter History')
} catch (err) {
  console.error('AGENT-HISTORY FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  await app?.close()
}
