/**
 * A failed project open must NOT render any top-of-window card/banner (the old
 * DiagnoseCard broke the frameless layout — LKM-56). The error surfaces through
 * the auto-opened activity console and the preview footer's retry command box.
 *
 * Run with: bun run test:open-fail
 *
 * The throwaway `PRAXIS_USER_DATA` below is load-bearing, not hygiene: without
 * it the app boots against the real workspace, and any project restored from it
 * means the empty state never renders and the `.empty__open` wait dies at 15s.
 * See the "never run an Electron test directly" gotcha in CLAUDE.md.
 */
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = join(root, 'test', 'artifacts')
mkdirSync(artifacts, { recursive: true })
// A folder with no package.json / index.html — project:detect rejects it.
const emptyDir = mkdtempSync(join(tmpdir(), 'praxis-empty-'))

let app
try {
  app = await electron.launch({
    executablePath: electronPath,
    args: [join(root, 'out', 'main', 'index.js')],
    cwd: root,
    // Throwaway userData so a restored workspace from a previous run can't
    // steal the screen mid-attempt.
    env: { ...process.env, PRAXIS_USER_DATA: mkdtempSync(join(tmpdir(), 'praxis-ud-')) }
  })
  const win = await app.firstWindow()
  await win.waitForSelector('.empty__open', { timeout: 15000 })

  // Drive a REAL open attempt through the File > Open Recent IPC path.
  await app.evaluate(({ BrowserWindow }, dir) => {
    BrowserWindow.getAllWindows()[0].webContents.send('menu:open-recent', dir)
  }, emptyDir)

  // The failure lands in the preview footer (error text + retry command box)…
  await win.waitForSelector('.previewcard__errbar', { timeout: 20000 })
  await win.waitForSelector('.previewcard__errinput', { timeout: 5000 })
  // …and the activity console auto-opens with the error line.
  await win.waitForSelector('.console__line--error', { timeout: 5000 })

  // Give any (unwanted) card a beat to appear, then assert there is none.
  await new Promise((r) => setTimeout(r, 1000))
  if (await win.$('.diag')) throw new Error('a .diag card rendered above the panes')
  const bodyText = await win.textContent('body')
  if (bodyText.includes('Diagnosing the problem'))
    throw new Error('the "Diagnosing…" busy banner rendered')

  await win.screenshot({ path: join(artifacts, '20-open-fail-console.png') })
  console.log('OPEN-FAIL-CONSOLE OK — failed open shows console + retry bar, no top card')
} catch (err) {
  console.error('OPEN-FAIL-CONSOLE FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  await app?.close()
}
