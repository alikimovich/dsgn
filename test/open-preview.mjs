/**
 * End-to-end test of the open-project → dev-server → preview path, without a
 * human clicking the native folder dialog. We stub `dialog.showOpenDialog` from
 * the main process to return a zero-dependency fixture project, click
 * "Open project…", and assert the preview WebContentsView navigates to the
 * fixture's dev-server URL.
 *
 * Run with: bun run test:preview
 */
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'

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

  // Make the native folder picker return our fixture (can't click an OS dialog).
  await app.evaluate(async ({ dialog }, fixturePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixturePath] })
  }, fixture)

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:action', 'open-project'))

  // Wait until some webContents has navigated to the fixture's localhost URL.
  const deadline = Date.now() + 60000
  let previewUrl = null
  while (Date.now() < deadline) {
    const urls = await app.evaluate(({ webContents }) =>
      webContents.getAllWebContents().map((w) => w.getURL())
    )
    previewUrl = urls.find((u) => /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+/.test(u)) ?? null
    if (previewUrl) break
    await new Promise((r) => setTimeout(r, 1000))
  }
  if (!previewUrl) throw new Error('preview never navigated to a localhost dev-server URL')
  // The runner assigns a free, browser-loadable port at or above 7777.
  const port = Number(new URL(previewUrl).port)
  if (port < 7777) throw new Error(`preview port ${port} should be >= 7777 (forced free port)`)

  // Titlebar should reflect the running project.
  await win.waitForFunction(
    () =>
      /http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+/.test(
        document.querySelector('.previewbar__url')?.textContent ?? ''
      ),
    { timeout: 10000 }
  )

  await win.screenshot({ path: join(artifacts, '03-open-preview.png') })

  // Capture the native preview WebContentsView itself (not in the page shot).
  const previewPng = await app.evaluate(async ({ webContents }) => {
    const wc = webContents
      .getAllWebContents()
      .find((w) => /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+/.test(w.getURL()))
    if (!wc) return null
    const img = await wc.capturePage()
    return img.isEmpty() ? null : img.toPNG().toString('base64')
  })
  if (previewPng) {
    writeFileSync(join(artifacts, '03b-preview-content.png'), Buffer.from(previewPng, 'base64'))
  } else {
    console.warn('warning: could not capture preview content')
  }

  // Activity console captured the open sequence (detect → server → preview → agent).
  await win.evaluate(() => window.__praxisLog.getState().setOpen(true))
  await win.waitForSelector('.console__line', { timeout: 5000 })
  const logText = await win.evaluate(() =>
    [...document.querySelectorAll('.console__text')].map((e) => e.textContent).join('\n')
  )
  for (const expected of ['Detected', 'Dev server at', 'Preview loaded', 'Ready']) {
    if (!logText.includes(expected)) {
      throw new Error(`console missing "${expected}" line; got:\n${logText}`)
    }
  }
  await win.screenshot({ path: join(artifacts, '03c-console.png') })

  console.log('OPEN-PREVIEW OK — previewing', previewUrl)
} catch (err) {
  console.error('OPEN-PREVIEW FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  await app?.close()
}
