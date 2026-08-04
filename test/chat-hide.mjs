/**
 * Visual + behavioral check for hiding the chat pane (full-window preview):
 *  - `menu:action` 'toggle-chat' (the ⌘\ menu item) hides the chat: the pane
 *    stays MOUNTED (a running turn keeps streaming into it) but gets
 *    `.pane--chat-hidden` and width 0, and the resize divider unmounts;
 *  - the previewbar's chat toggle button shows it again;
 *  - the preference round-trips through localStorage (praxis:chat-hidden).
 * Screenshots land in test/artifacts/ for eyeballing the full-width preview.
 */
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync } from 'node:fs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = join(root, 'test', 'fixtures', 'static-app')
const artifacts = join(root, 'test', 'artifacts')
mkdirSync(artifacts, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sendMenu = (app, action) =>
  app.evaluate(
    ({ BrowserWindow }, a) => BrowserWindow.getAllWindows()[0].webContents.send('menu:action', a),
    action
  )

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
  await sendMenu(app, 'open-project')

  await win.waitForSelector('.pane--chat', { timeout: 60000 })
  const before = await win.evaluate(() =>
    Math.round(document.querySelector('.pane--chat')?.getBoundingClientRect().width ?? -1)
  )
  if (before < 300) throw new Error(`visible chat width ${before}px — expected ~440`)
  await win.screenshot({ path: join(artifacts, '14-chat-visible.png') })

  // Hide via the menu action (the ⌘\ accelerator's path).
  await sendMenu(app, 'toggle-chat')
  await sleep(150)
  const hidden = await win.evaluate(() => {
    const pane = document.querySelector('.pane--chat')
    return {
      mounted: !!pane,
      hasClass: pane?.classList.contains('pane--chat-hidden') ?? false,
      width: pane ? Math.round(pane.getBoundingClientRect().width) : -1,
      divider: !!document.querySelector('.divider'),
      stored: localStorage.getItem('praxis:chat-hidden')
    }
  })
  if (!hidden.mounted) throw new Error('chat pane unmounted on hide — a running turn would detach')
  if (!hidden.hasClass) throw new Error('chat pane missing .pane--chat-hidden class')
  if (hidden.width > 4) throw new Error(`hidden chat width ${hidden.width}px should be 0`)
  if (hidden.divider) throw new Error('resize divider still mounted while chat is hidden')
  if (hidden.stored !== '1') throw new Error(`praxis:chat-hidden should be "1", got ${hidden.stored}`)
  await win.screenshot({ path: join(artifacts, '15-chat-hidden.png') })

  // Show again via the previewbar button (needs the dev server running).
  await win.waitForSelector('[aria-label="Show chat"]', { timeout: 60000 })
  await win.click('[aria-label="Show chat"]')
  await sleep(150)
  const shown = await win.evaluate(() => {
    const pane = document.querySelector('.pane--chat')
    return {
      hasClass: pane?.classList.contains('pane--chat-hidden') ?? false,
      width: pane ? Math.round(pane.getBoundingClientRect().width) : -1,
      divider: !!document.querySelector('.divider'),
      stored: localStorage.getItem('praxis:chat-hidden')
    }
  })
  if (shown.hasClass) throw new Error('chat still hidden after previewbar re-toggle')
  if (shown.width < 300) throw new Error(`re-shown chat width ${shown.width}px — expected ~440`)
  if (!shown.divider) throw new Error('resize divider missing after re-show')
  if (shown.stored !== '0') throw new Error(`praxis:chat-hidden should be "0", got ${shown.stored}`)
  await win.screenshot({ path: join(artifacts, '16-chat-reshown.png') })

  console.log('CHAT-HIDE OK — hidden width', hidden.width, '→ re-shown', shown.width)
} catch (err) {
  console.error('CHAT-HIDE FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  await app?.close()
}
