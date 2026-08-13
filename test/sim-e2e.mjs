/**
 * Real iOS-Simulator end-to-end — boots a sim and streams it. macOS + Xcode +
 * a bootable simulator only; SKIPs (exit 0) everywhere else, like agent-e2e.mjs.
 *
 * Full app-boot (expo run:ios) is heavy and needs a real Expo fixture, so this
 * gates behind PRAXIS_SIM_E2E=1 + PRAXIS_SIM_FIXTURE=<path to an Expo app>. Without
 * those it still verifies preflight succeeds on a capable Mac, then SKIPs the boot.
 *
 * Run with: bun run test:sim-e2e
 */
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const skip = (why) => {
  console.log(`SIM-E2E SKIP — ${why}`)
  process.exit(0)
}

if (process.platform !== 'darwin') skip('not macOS')

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

  const pf = await win.evaluate(() => window.api.simulator.preflight())
  if (!pf.ok) {
    await app.close()
    skip(`preflight not ok: ${pf.reason}`)
  }
  console.log(`preflight ok — ${pf.devices.length} device(s), runtimes: ${pf.runtimes.join(', ')}`)

  const fixture = process.env.PRAXIS_SIM_FIXTURE
  if (process.env.PRAXIS_SIM_E2E !== '1' || !fixture) {
    await app.close()
    skip('set PRAXIS_SIM_E2E=1 and PRAXIS_SIM_FIXTURE=<expo app path> to boot a real app')
  }

  console.log(`Booting + launching ${fixture} …`)
  const sim = await win.evaluate((f) => window.api.simulator.start({ root: f }), fixture)
  if (!/^http:\/\/127\.0\.0\.1:\d+\/\?praxisSim=1$/.test(sim.url)) {
    throw new Error(`unexpected sim url: ${sim.url}`)
  }
  await win.evaluate((u) => window.api.preview.load(u), sim.url)

  const png = await app.evaluate(async ({ webContents }, target) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith(target.split('?')[0]))
    if (!wc) return null
    const img = await wc.capturePage()
    return img.isEmpty() ? null : img.toPNG().length
  }, sim.url)
  if (!png) throw new Error('simulator preview never rendered a frame')

  await win.evaluate(() => window.api.simulator.stop())
  console.log('SIM-E2E OK — booted a simulator and streamed a frame')
} catch (err) {
  console.error('SIM-E2E FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  await app?.close()
}
