/**
 * UI test for the in-app feedback dialog (LKM-27): open it from the sidebar's
 * pinned "Send feedback" button, confirm the screenshot capture + attachment
 * toggles render, and that the "attach the conversation" toggle is disabled
 * when there's no chat yet. Never posts (that would shell out to gh); it only
 * exercises the dialog UI.
 *
 * Run with: bun run test:feedback-dialog
 */
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync } from 'node:fs'
import assert from 'node:assert'

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
  // The button lives in the rail, which renders once a project is open — seed a
  // fake workspace entry (no dev server needed; diagnose-card.mjs does the same).
  await win.waitForSelector('.empty', { timeout: 15000 })
  await win.evaluate(() =>
    window.__praxisWorkspace.getState().openOrActivate('/tmp/praxis-feedback-test', { name: 'fake' })
  )
  // The rail pins "Send feedback" at its bottom.
  await win.waitForSelector('.rail__feedback', { timeout: 15000 })
  await win.click('.rail__feedback')

  // Dialog opens with the title + both attachment toggles.
  await win.waitForSelector('[data-slot="dialog-title"]', { timeout: 5000 })
  const title = (await win.textContent('[data-slot="dialog-title"]')) ?? ''
  assert.ok(/send feedback/i.test(title), 'dialog title')

  const checkboxes = win.locator('[data-slot="dialog-content"] input[type="checkbox"]')
  assert.equal(await checkboxes.count(), 2, 'two attachment toggles')

  // No conversation yet → the conversation toggle is disabled.
  const conversationToggle = checkboxes.nth(1)
  assert.equal(await conversationToggle.isDisabled(), true, 'conversation toggle disabled when empty')

  // The Send button is disabled until the user types something.
  const sendBtn = win.locator('[data-slot="dialog-footer"] button', { hasText: 'Send feedback' })
  assert.equal(await sendBtn.isDisabled(), true, 'send disabled without a description')
  await win.fill('[data-slot="dialog-content"] textarea', 'The sidebar toggle is hard to find.')
  assert.equal(await sendBtn.isDisabled(), false, 'send enabled once described')

  await win.screenshot({ path: join(artifacts, 'feedback-dialog.png') })
  console.log('FEEDBACK-DIALOG OK')
} finally {
  await app?.close()
}
