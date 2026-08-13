/**
 * Visual + wiring test for the per-turn "Revert changes" chat action. Drives the
 * exposed store directly (no agent/auth): finishes an assistant turn, tags it with a
 * revert group the way the 'merged' isolation event does, and asserts the Revert
 * button renders next to Copy. Then clicks it to exercise the full renderer→preload→
 * main `edit:revert` round-trip — with no matching group recorded in main it comes
 * back a conflict, so the inline "can't revert" hint is what we assert (the happy-path
 * file restore is covered by the pure edit-history unit test).
 *
 * Run with: node test/revert-action.mjs (after electron-vite build)
 */
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync } from 'node:fs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
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
  await win.evaluate(() => window.__praxisWorkspace.getState().openOrActivate('/tmp/praxis-revert-test'))
  await win.waitForSelector('.composer__input', { timeout: 15000 })
  // RevertAction only renders when a projectRoot is known (it's the revert's `root`).
  await win.evaluate(() =>
    window.__praxisSession.getState().setProjectRoot('/tmp/praxis-revert-test')
  )

  // A finished assistant turn (mirrors chat-render's store driving).
  const key = await win.evaluate(() => {
    const s = window.__praxisStore.getState()
    s.appendUser('Make the primary button teal')
    s.startAssistant()
    s.appendDelta('Done — updated the button color and tightened the padding.')
    s.finish()
    return window.__praxisStore.getState().activeKey
  })

  // Copy is always offered on a finished turn; Revert is NOT — the turn isn't tagged yet.
  await win.waitForSelector('button[aria-label="Copy message"]', { timeout: 5000 })
  if (await win.$('button[aria-label="Revert changes"]')) {
    throw new Error('Revert must not render before the turn is tagged with a revert group')
  }

  // The 'merged' isolation event tags the turn with its edit-history group → Revert appears.
  await win.evaluate((k) => window.__praxisStore.getState().tagRevert(k, 'chat:wt-test:1'), key)
  await win.waitForSelector('button[aria-label="Revert changes"]', { timeout: 5000 })
  // Both actions share one row (Copy + Revert), so both are still present.
  if (!(await win.$('button[aria-label="Copy message"]'))) {
    throw new Error('Copy should stay alongside Revert in the actions row')
  }
  await win.screenshot({ path: join(artifacts, '30-revert-action.png') })

  // Click Revert. No such group is recorded in main for this root, so `edit:revert`
  // returns a non-ok result and the inline conflict hint renders — proving the full
  // renderer→preload→main IPC path is wired, not just the button.
  await win.click('button[aria-label="Revert changes"]')
  const hint = await win.waitForSelector('.msg__action-hint', { timeout: 5000 })
  const hintText = (await hint.textContent())?.toLowerCase() ?? ''
  if (!hintText.includes("can't revert")) {
    throw new Error(`revert conflict hint expected, got: ${hintText}`)
  }
  await win.screenshot({ path: join(artifacts, '31-revert-conflict.png') })

  console.log('REVERT-ACTION OK — button gated on revertGroup, sits by Copy, IPC round-trip + conflict hint')
} catch (err) {
  console.error('REVERT-ACTION FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  await app?.close()
}
