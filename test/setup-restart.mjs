/**
 * Auto-restart-after-setup test — exercises the real restart path without a live
 * agent turn. We open a fixture project (owned dev server), then drive the setup
 * store the way the finished setup turn does (`verifying` + `restartRequested`).
 * App's effect must restart the dev server, reload the preview, and — because the
 * static fixture has no stamps — land the zero-stamp verdict (verification fired,
 * not silent success).
 *
 * Run with: bun run test:restart
 */
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = join(root, 'test', 'fixtures', 'static-app')

const localhost = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+/

async function currentPreviewUrl(app) {
  const urls = await app.evaluate(({ webContents }) =>
    webContents.getAllWebContents().map((w) => w.getURL())
  )
  return urls.find((u) => localhost.test(u)) ?? null
}

let app
try {
  app = await electron.launch({
    executablePath: electronPath,
    args: [join(root, 'out', 'main', 'index.js')],
    cwd: root
  })
  const win = await app.firstWindow()
  await win.waitForSelector('.empty__open', { timeout: 15000 })

  await app.evaluate(async ({ dialog }, fixturePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixturePath] })
  }, fixture)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:action', 'open-project'))

  // Wait for the initial preview to come up.
  const deadline = Date.now() + 60000
  let firstUrl = null
  while (Date.now() < deadline) {
    firstUrl = await currentPreviewUrl(app)
    if (firstUrl) break
    await new Promise((r) => setTimeout(r, 500))
  }
  if (!firstUrl) throw new Error('preview never came up on open')

  // Let the initial page's readiness ticks (the preload re-samples up to 3000ms
  // after load) settle, so they can't consume `verifying` before the restart and
  // make the verdict assertion pass against the wrong (pre-restart) readiness.
  await new Promise((r) => setTimeout(r, 3500))

  // Drive the store exactly as a finished setup turn does: arm verification and
  // request the restart. App's effect should pick it up and relaunch.
  await win.evaluate(() => {
    const s = window.__praxisSetup.getState()
    s.setVerifying(true)
    s.setRestartRequested(true)
  })

  // The one-shot flag must be consumed (set back to false) by App's effect.
  await win.waitForFunction(() => window.__praxisSetup.getState().restartRequested === false, {
    timeout: 10000
  })

  // Wait for the relaunch to finish — the "Preview restarted at" log line only
  // appears once the new server is up and the preview reloaded. (Polling the
  // WebContents URL is unreliable here: a killed page keeps its last URL string.)
  const logLines = () =>
    win.evaluate(() =>
      window.__praxisLog
        .getState()
        .lines.map((l) => l.text)
        .join('\n')
    )
  await win.waitForFunction(
    () =>
      window.__praxisLog
        .getState()
        .lines.some((l) => l.text.includes('Preview restarted at')),
    { timeout: 60000 }
  )
  const logText = await logLines()
  if (!logText.includes('Restarting dev server')) {
    throw new Error(`console missing "Restarting dev server"; got:\n${logText}`)
  }

  // The preview is navigated to a reachable localhost URL again.
  const restarted = await currentPreviewUrl(app)
  if (!restarted) throw new Error('preview has no localhost URL after restart')

  // The post-restart readiness report is the verdict. The static fixture has zero
  // stamps, so verification must fire (verifying cleared) and warn — not report
  // silent success.
  await win.waitForFunction(() => window.__praxisSetup.getState().verifying === false, {
    timeout: 20000
  })
  const status = await win.evaluate(() => window.__praxisSetup.getState().status ?? '')
  if (!/no elements got stamped/i.test(status)) {
    throw new Error(`expected zero-stamp verdict after restart, got status: "${status}"`)
  }

  console.log('SETUP-RESTART OK — restart relaunched the server, reloaded preview, verdict fired')
} catch (err) {
  console.error('SETUP-RESTART FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  await app?.close()
}
