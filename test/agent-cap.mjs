/**
 * Agent-session LRU cap mechanism (v5-C2) — through real IPC, no Claude creds.
 * The renderer's evictWarm() bounds the warm footprint by closing the LRU
 * projects' sessions and reopening them on switch-back. This proves the
 * main-process building blocks that path depends on:
 *
 *   agent:is-open      reports per-project session liveness
 *   closeProject(A)    suspends A (is-open → false), leaves the rest open
 *   openProject(A)     reopens A (is-open → true) AND makes it the active session
 *
 * Run with: bun run test:agentcap
 */
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fx = (n) => join(root, 'test', 'fixtures', n)
const [A, B, C, D] = [fx('static-app'), fx('selectable-app'), fx('editable-app'), fx('svelte-app')]

let app
try {
  app = await electron.launch({
    executablePath: electronPath,
    args: [join(root, 'out', 'main', 'index.js')],
    cwd: root
  })
  const win = await app.firstWindow()
  await win.waitForSelector('.empty__open', { timeout: 15000 })
  await win.evaluate(() => window.__praxisWorkspace.getState().openOrActivate('/tmp/praxis-test-project'))
  await win.waitForSelector('.composer__input', { timeout: 15000 })

  await win.evaluate(() => {
    window.__agentEvents = []
    window.api.agent.onEvent((e) => window.__agentEvents.push(e))
  })
  const clear = () => win.evaluate(() => (window.__agentEvents.length = 0))
  const open = (d) => win.evaluate((p) => window.api.agent.openProject(p), d)
  const close = (d) => win.evaluate((p) => window.api.agent.closeProject(p), d)
  const isOpen = (d) => win.evaluate((p) => window.api.agent.isOpen(p), d)
  // A send with no active session emits a synchronous "Open a project first"
  // error — used here to prove reopen re-activates A. Interrupt the turn we may
  // have started so it can't do real work (and 401s fast without creds).
  const sawNoSession = async (text) => {
    await win.evaluate((t) => window.api.agent.send(t), text)
    await new Promise((r) => setTimeout(r, 400))
    const flagged = await win.evaluate(() =>
      window.__agentEvents.some(
        (e) => e.type === 'error' && String(e.message).includes('Open a project first')
      )
    )
    await win.evaluate(() => window.api.agent.interrupt())
    return flagged
  }
  const assert = (cond, msg) => {
    if (!cond) throw new Error(msg)
  }

  // Nothing open → is-open is false for any project.
  assert(!(await isOpen(A)), 'no session should be open before any project')

  // Open four projects → all report open (this is the unbounded state the cap fixes).
  for (const d of [A, B, C, D]) await open(d)
  for (const [d, n] of [[A, 'A'], [B, 'B'], [C, 'C'], [D, 'D']]) {
    assert(await isOpen(d), `${n} should be open after openProject`)
  }

  // Suspend A (what evictWarm does to the LRU project) → A closed, others stay.
  await close(A)
  assert(!(await isOpen(A)), 'A should be suspended (session closed) after evict')
  assert((await isOpen(B)) && (await isOpen(C)) && (await isOpen(D)), 'evicting A must not touch B/C/D')

  // Switch back to A → reopen restores the session AND makes it active.
  await open(A)
  assert(await isOpen(A), 'switching back should reopen A')
  await clear()
  assert(!(await sawNoSession('ping')), 'reopened A should be the active session')

  console.log('AGENT-CAP OK — is-open liveness, LRU suspend leaves peers, reopen re-activates')
} catch (err) {
  console.error('AGENT-CAP FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  await app?.close()
}
