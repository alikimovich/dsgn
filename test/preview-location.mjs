/**
 * The preview's current page is mirrored into a global store
 * (usePreviewLocation) — main's `preview:url-changed` (did-navigate /
 * did-navigate-in-page) is reported and the renderer keeps it in sync. The
 * composer, however, no longer prepends this location as hidden context on
 * every send: the agent now has a `preview_location` tool (main-process) it
 * can call itself when it needs to know the current page. This test checks
 * the store still mirrors navigation, and — as the regression guard for the
 * removed prefix — that the composer sends the user's typed text UNCHANGED,
 * with no page-location text prepended.
 *
 * Run with: bun run test:preview-location
 */
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let app
try {
  app = await electron.launch({
    executablePath: electronPath,
    args: [join(root, 'out', 'main', 'index.js')],
    cwd: root
  })
  const win = await app.firstWindow()
  await win.waitForSelector('.empty__open', { timeout: 15000 })
  const key = await win.evaluate(() =>
    window.__praxisWorkspace.getState().openOrActivate('/tmp/praxis-test-project')
  )
  await win.waitForSelector('.composer__input', { timeout: 15000 })

  const assert = (cond, msg) => {
    if (!cond) throw new Error(msg)
  }

  // Give the project a dev-server base (unused by the composer now, but keeps
  // the workspace state realistic).
  await win.evaluate((k) => {
    window.__praxisWorkspace.getState().patchEntry(k, { url: 'http://localhost:5173' })
  }, key)

  // Nothing shown yet — no navigation reported.
  const before = await win.evaluate(() => window.__praxisPreviewLocation.getState().url)
  assert(before === null, `expected no preview location yet, got ${before}`)

  // Main reports a navigation (mirrors did-navigate / did-navigate-in-page).
  await app.evaluate(({ BrowserWindow }, url) => {
    BrowserWindow.getAllWindows()[0].webContents.send('preview:url-changed', url)
  }, 'http://localhost:5173/about?tab=team')
  await win.waitForFunction(() => window.__praxisPreviewLocation.getState().url !== null)

  const url = await win.evaluate(() => window.__praxisPreviewLocation.getState().url)
  assert(url === 'http://localhost:5173/about?tab=team', `store should mirror the reported url, got ${url}`)

  // The composer must send the user's typed words verbatim — no hidden
  // page-location prefix. (The agent gets the current page via its own
  // `preview_location` tool now, built main-process side.) Spy on agent:send
  // in MAIN, since the contextBridge freezes `window.api` (no real provider
  // turn needed).
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('agent:send')
    ipcMain.handle('agent:send', (_e, text) => {
      globalThis.__praxisSentTexts = [...(globalThis.__praxisSentTexts ?? []), text]
    })
  })
  await win.fill('.composer__input', 'make the heading bigger')
  await win.click('.composer__send')
  // The renderer appends the visible user message synchronously; the spied IPC
  // lands async in main — poll for it.
  await win.waitForFunction(() =>
    window.__praxisStore.getState().messages.some((m) => m.role === 'user')
  )
  let sent = null
  for (let i = 0; i < 50 && !sent; i++) {
    sent = await app.evaluate(() => globalThis.__praxisSentTexts?.[0] ?? null)
    if (!sent) await new Promise((r) => setTimeout(r, 100))
  }
  assert(
    sent === 'make the heading bigger',
    `composer should send the user's words with no preview-location prefix, got "${sent}"`
  )
  // The visible transcript matches what was sent — nothing hidden either way.
  const shown = await win.evaluate(
    () =>
      window.__praxisStore
        .getState()
        .messages.filter((m) => m.role === 'user')
        .at(-1).text
  )
  assert(shown === 'make the heading bigger', `unexpected transcript text, got "${shown}"`)

  console.log('PREVIEW-LOCATION OK — store mirrors navigation; composer no longer prepends it')
} catch (err) {
  console.error('PREVIEW-LOCATION FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  await app?.close()
}
