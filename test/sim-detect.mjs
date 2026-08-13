/**
 * React Native / Expo detection — through real IPC (no simulator needed):
 *  - an Expo project (deps.expo) detects framework 'expo', previewKind 'simulator'.
 *  - a bare React Native project (deps.react-native) detects 'react-native',
 *    previewKind 'simulator'.
 *  - a web project (vite) stays previewKind 'web'.
 *
 * Pure package.json detection, so it runs anywhere (no macOS/Xcode).
 *
 * Run with: bun run test:sim-detect
 */
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'praxis-sim-'))

/** Temp project dir with the given deps + scripts. */
function project(name, deps, scripts = { start: 'echo start' }) {
  const dir = join(work, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, dependencies: deps, scripts }, null, 2))
  return dir
}

const expoDir = project('expo-app', { expo: '^51.0.0', react: '18.2.0', 'react-native': '0.74.0' })
const rnDir = project('rn-app', { react: '18.2.0', 'react-native': '0.74.0' })
const webDir = project('web-app', { vite: '^5.0.0', react: '18.2.0' }, { dev: 'vite' })

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

  const detect = (dir) => win.evaluate((d) => window.api.project.detect(d), dir)

  const expo = await detect(expoDir)
  assert(expo.framework === 'expo', `expo framework: ${JSON.stringify(expo)}`)
  assert(expo.previewKind === 'simulator', `expo previewKind: ${JSON.stringify(expo)}`)

  const rn = await detect(rnDir)
  assert(rn.framework === 'react-native', `rn framework: ${JSON.stringify(rn)}`)
  assert(rn.previewKind === 'simulator', `rn previewKind: ${JSON.stringify(rn)}`)

  const web = await detect(webDir)
  assert(web.framework === 'vite', `web framework: ${JSON.stringify(web)}`)
  assert(web.previewKind === 'web', `web previewKind: ${JSON.stringify(web)}`)

  console.log('SIM-DETECT OK — expo/react-native → simulator, vite → web')
} catch (err) {
  console.error('SIM-DETECT FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  rmSync(work, { recursive: true, force: true })
  await app?.close()
}
