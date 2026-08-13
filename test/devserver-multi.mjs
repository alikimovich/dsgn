/**
 * Multi-instance dev servers (v5-A) — through real IPC. Starts two fixtures'
 * dev servers concurrently and asserts:
 *  - they get distinct ports and are both reachable (concurrent, not one-at-a-time),
 *  - stop(rootA) tears down only A, leaving B running (per-root stop).
 *
 * Run with: bun run test:devmulti
 */
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixtureA = join(root, 'test', 'fixtures', 'static-app')
const fixtureB = join(root, 'test', 'fixtures', 'selectable-app')

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

  // GET a URL from the MAIN process (Node global fetch — no renderer CORS games).
  const reachable = (url) =>
    app.evaluate(async (_m, u) => {
      try {
        const ctrl = new AbortController()
        const t = setTimeout(() => ctrl.abort(), 2500)
        const res = await fetch(u, { signal: ctrl.signal })
        clearTimeout(t)
        return (res.status ?? 0) > 0
      } catch {
        return false
      }
    }, url)

  const startServer = (dir) =>
    win.evaluate(async (d) => {
      const p = await window.api.project.detect(d)
      return window.api.devServer.start({ root: d, command: p.devCommand, framework: p.framework })
    }, dir)

  // Start both concurrently — the multi-instance backend must keep both.
  const [a, b] = await Promise.all([startServer(fixtureA), startServer(fixtureB)])
  if (!a?.url || !b?.url) throw new Error(`both servers should start: ${JSON.stringify({ a, b })}`)
  if (a.url === b.url) throw new Error(`servers must get distinct ports: ${a.url} === ${b.url}`)

  if (!(await reachable(a.url))) throw new Error(`server A not reachable at ${a.url}`)
  if (!(await reachable(b.url))) throw new Error(`server B not reachable at ${b.url}`)

  // Per-root stop: tear down A only.
  await win.evaluate((d) => window.api.devServer.stop(d), fixtureA)
  // Poll until A is gone (SIGTERM to a process group is async — a fixed sleep
  // would be flaky on a loaded box).
  let aDown = false
  for (let i = 0; i < 25 && !aDown; i++) {
    if (!(await reachable(a.url))) aDown = true
    else await new Promise((r) => setTimeout(r, 200))
  }
  if (!aDown) throw new Error('server A should be stopped, still reachable')
  if (!(await reachable(b.url))) throw new Error('server B should still be running after stopping A')

  // Cleanup.
  await win.evaluate((d) => window.api.devServer.stop(d), fixtureB)

  console.log('DEVSERVER-MULTI OK — concurrent servers, distinct ports, per-root stop')
} catch (err) {
  console.error('DEVSERVER-MULTI FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  await app?.close()
}
