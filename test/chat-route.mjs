/**
 * Per-project chat routing (v5-C core) — agent events tagged with `projectKey`
 * route to that project's chat slice. The active project shows live; a
 * backgrounded project keeps streaming into its own slice (the rail's "working"
 * dot), and its output is there on switch-back. We inject `agent:event`s from
 * main (no Claude creds needed) and assert via the store.
 *
 * Run with: bun run test:chatroute
 */
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const inject = (app, events) =>
  app.evaluate(({ BrowserWindow }, evs) => {
    const wc = BrowserWindow.getAllWindows()[0].webContents
    for (const e of evs) wc.send('agent:event', e)
  }, events)

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

  const assert = (cond, msg) => {
    if (!cond) throw new Error(msg)
  }

  // Two projects with a streaming assistant message each; A is the active chat.
  await win.evaluate(() => {
    const c = window.__praxisStore.getState()
    c.setActiveChat('A')
    c.startAssistant('A')
    c.startAssistant('B')
  })

  // A delta for the active project (A) and one for the backgrounded project (B).
  await inject(app, [
    { type: 'delta', text: 'alpha', projectKey: 'A' },
    { type: 'delta', text: 'beta', projectKey: 'B' },
    { type: 'done', projectKey: 'B' }
  ])
  await new Promise((r) => setTimeout(r, 400))

  const r = await win.evaluate(() => {
    const s = window.__praxisStore.getState()
    return {
      aText: s.byKey['A'].messages.at(-1).text,
      bText: s.byKey['B'].messages.at(-1).text,
      activeText: s.messages.at(-1).text,
      aRunning: s.isRunningFor('A'),
      bRunning: s.isRunningFor('B')
    }
  })
  assert(r.aText === 'alpha', `A should get its own delta, got "${r.aText}"`)
  assert(r.bText === 'beta', `B (background) should accumulate its delta, got "${r.bText}"`)
  assert(r.activeText === 'alpha', `active chat (A) must NOT show B's output, got "${r.activeText}"`)
  assert(r.aRunning === true, 'A is still streaming (no done for A)')
  assert(r.bRunning === false, 'B finished (done routed to B) — its "working" dot clears')

  // Switching to B reveals its accumulated output.
  await win.evaluate(() => window.__praxisStore.getState().setActiveChat('B'))
  const afterText = await win.evaluate(() => window.__praxisStore.getState().messages.at(-1).text)
  assert(afterText === 'beta', `switching to B should show its output, got "${afterText}"`)

  console.log('CHAT-ROUTE OK — events route by project; background accumulates; switch reveals it')
} catch (err) {
  console.error('CHAT-ROUTE FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  await app?.close()
}
