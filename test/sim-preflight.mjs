/**
 * Simulator preflight — through real IPC. Asserts the SimPreflight shape and that
 * a non-macOS host degrades cleanly: ok:false, isMac:false, a human `reason`
 * (never a thrown crash). On macOS it just asserts the shape (capability varies).
 *
 * Run with: bun run test:sim-preflight
 */
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
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

  const pf = await win.evaluate(() => window.api.simulator.preflight())

  assert(typeof pf.ok === 'boolean', `ok should be boolean: ${JSON.stringify(pf)}`)
  assert(typeof pf.isMac === 'boolean', `isMac should be boolean: ${JSON.stringify(pf)}`)
  assert(typeof pf.hasXcode === 'boolean', `hasXcode should be boolean`)
  assert(Array.isArray(pf.runtimes), 'runtimes should be an array')
  assert(Array.isArray(pf.devices), 'devices should be an array')

  if (process.platform !== 'darwin') {
    assert(pf.ok === false, `non-mac should not be ok: ${JSON.stringify(pf)}`)
    assert(pf.isMac === false, `non-mac isMac should be false: ${JSON.stringify(pf)}`)
    assert(typeof pf.reason === 'string' && pf.reason.length > 0, `non-mac needs a reason: ${JSON.stringify(pf)}`)
    assert(/mac/i.test(pf.reason), `reason should explain macOS-only: ${pf.reason}`)
    console.log('SIM-PREFLIGHT OK — non-macOS degrades cleanly:', pf.reason)
  } else {
    console.log(`SIM-PREFLIGHT OK — macOS, ok=${pf.ok}, devices=${pf.devices.length}`)
  }
} catch (err) {
  console.error('SIM-PREFLIGHT FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  await app?.close()
}
