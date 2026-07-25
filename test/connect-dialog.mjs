/**
 * UI test for the "Connect to GitHub" header swap + sheet (the first-publish
 * bridge). Opens a fixture so the preview runs (the Publish/Connect controls
 * only render while `status.kind === 'running'`), then forces the github store
 * into the no-remote state and asserts:
 *   - the header shows "Connect to GitHub" instead of the Publish split button,
 *   - clicking it opens the ConnectDialog with the prefilled repo name,
 *   - flipping the store to connected brings the Publish button back.
 * It never actually creates a repo (that shells out to gh + network); it only
 * exercises the renderer wiring. Branch/repo logic is covered by
 * test/github-connect.mjs.
 *
 * Run with: bun run test:connect-dialog
 */
import assert from 'node:assert'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'
import { _electron as electron } from 'playwright'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = join(root, 'test', 'fixtures', 'static-app')
const artifacts = join(root, 'test', 'artifacts')
mkdirSync(artifacts, { recursive: true })

let app
try {
  app = await electron.launch({
    executablePath: electronPath,
    args: [join(root, 'out', 'main', 'index.js')],
    cwd: root
  })

  const win = await app.firstWindow()
  await win.waitForSelector('.empty__open', { timeout: 15000 })

  // Open the fixture (can't click the native folder dialog).
  await app.evaluate(async ({ dialog }, fixturePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixturePath] })
  }, fixture)
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.send('menu:action', 'open-project')
  )

  // The header controls render once the preview is running.
  await win.waitForSelector('.previewbar__actions', { timeout: 60000 })

  // Force the no-remote state (a real gh connect can't run headlessly). This
  // runs after the open effect's own setStatus, so it wins.
  await win.evaluate(() =>
    window.__praxisGithub.getState().setStatus({
      connected: false,
      gh: 'ok',
      suggestedName: 'static-app',
      login: 'octocat'
    })
  )

  // Header shows Connect, not Publish.
  const connectBtn = win.locator('.previewbar__actions button', { hasText: 'Connect to GitHub' })
  await connectBtn.waitFor({ timeout: 5000 })
  assert.equal(
    await win.locator('.pubgroup').count(),
    0,
    'Publish split button hidden until connected'
  )

  // Clicking opens the sheet with the prefilled, sanitized repo name.
  await connectBtn.click()
  await win.waitForSelector('[data-slot="dialog-title"]', { timeout: 5000 })
  const title = (await win.textContent('[data-slot="dialog-title"]')) ?? ''
  assert.ok(/connect to github/i.test(title), 'dialog title')
  const nameVal = await win.inputValue('#connect-repo-name')
  assert.equal(nameVal, 'static-app', 'repo name prefilled from the folder')
  // Private is the default.
  assert.equal(
    await win.locator('[data-slot="dialog-content"] input[type="checkbox"]').isChecked(),
    true,
    'private repository checked by default'
  )
  await win.screenshot({ path: join(artifacts, 'connect-dialog.png') })

  // Close, flip to connected → the Publish split button returns.
  await win.click('[data-slot="dialog-footer"] button:has-text("Cancel")')
  await win.evaluate(() =>
    window.__praxisGithub.getState().setStatus({
      connected: true,
      gh: 'ok',
      remoteUrl: 'git@github.com:octocat/static-app.git',
      suggestedName: 'static-app'
    })
  )
  await win.waitForSelector('.pubgroup', { timeout: 5000 })
  assert.equal(
    await win.locator('button', { hasText: 'Connect to GitHub' }).count(),
    0,
    'Connect button gone once connected'
  )

  console.log('CONNECT-DIALOG OK')
} catch (err) {
  console.error('CONNECT-DIALOG FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  await app?.close()
}
