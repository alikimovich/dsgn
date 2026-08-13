/**
 * Sim-bridge frame transport — WITHOUT a simulator. Stands up the bridge with a
 * stub frame source (a static JPEG) via the main-process test hook, points the
 * real preview WebContentsView at the bridge URL through `preview.load`, and
 * asserts a non-empty frame actually rendered (capturePage). This exercises the
 * whole Option-(a) path: bridge → MJPEG → WebContentsView → bounds — the part of
 * the simulator preview that's testable off-macOS.
 *
 * Run with: bun run test:sim-frame
 */
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = join(root, 'test', 'artifacts')
mkdirSync(artifacts, { recursive: true })
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg)
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
  await win.evaluate(() => window.__praxisWorkspace.getState().openOrActivate('/tmp/praxis-test-project'))
  await win.waitForSelector('.composer__input', { timeout: 15000 })

  // Stand up the bridge (main process) and get its local URL.
  const url = await app.evaluate(() => globalThis.__praxisStartTestBridge().then((r) => r.url))
  assert(/^http:\/\/127\.0\.0\.1:\d+\/\?praxisSim=1$/.test(url), `unexpected bridge url: ${url}`)
  const port = Number(new URL(url).port)
  assert(port >= 7800, `bridge port ${port} should be >= 7800`)

  // Point the real preview WebContentsView at it (same path as a dev-server URL).
  await win.evaluate((u) => window.api.preview.load(u), url)

  // The preview WebContentsView should navigate to the bridge page and paint.
  const deadline = Date.now() + 20000
  let png = null
  while (Date.now() < deadline) {
    png = await app.evaluate(async ({ webContents }, target) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith(target.split('?')[0]))
      if (!wc) return null
      const img = await wc.capturePage()
      return img.isEmpty() ? null : img.toPNG().toString('base64')
    }, url)
    if (png) break
    await new Promise((r) => setTimeout(r, 500))
  }
  assert(png, 'preview never rendered a frame from the sim bridge')
  writeFileSync(join(artifacts, 'sim-frame.png'), Buffer.from(png, 'base64'))

  console.log('SIM-FRAME OK — bridge frame rendered into the preview WebContentsView')
} catch (err) {
  console.error('SIM-FRAME FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  await app?.close()
}
