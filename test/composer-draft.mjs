/**
 * Per-chat composer drafts — an unsent message stays with the chat it was typed
 * in. ChatPanel is mounted once for the whole app, so when the composer held its
 * text in component state, switching chats carried that half-written ask into the
 * next chat. This drives the real UI: type, switch, assert blank; type in the
 * second chat, switch back, assert each chat got its own text back.
 *
 * Run with: bun run test:composerdraft
 */
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let app
try {
  app = await electron.launch({
    executablePath: electronPath,
    args: [join(root, 'out', 'main', 'index.js')],
    cwd: root
  })
  const win = await app.firstWindow()
  await win.waitForSelector('.empty__open', { timeout: 15000 })
  await win.evaluate(() =>
    window.__praxisWorkspace.getState().openOrActivate('/tmp/praxis-test-project')
  )
  await win.waitForSelector('.composer__input', { timeout: 15000 })

  const assert = (cond, msg) => {
    if (!cond) throw new Error(msg)
  }
  const composer = win.locator('.composer__input')
  const switchTo = (key) =>
    win.evaluate((k) => window.__praxisStore.getState().setActiveChat(k), key)

  const chatA = await win.evaluate(() => window.__praxisStore.getState().activeKey)

  // Type an ask in chat A and leave without sending it.
  await composer.fill('half-written ask for A')
  await switchTo('draft-chat-B')
  assert(
    (await composer.inputValue()) === '',
    "chat B's composer must open blank, not carrying A's text"
  )

  // Chat B gets its own unsent text; A's is untouched.
  await composer.fill('something else entirely for B')
  await switchTo(chatA)
  assert(
    (await composer.inputValue()) === 'half-written ask for A',
    "switching back to chat A must restore A's own draft"
  )
  await switchTo('draft-chat-B')
  assert(
    (await composer.inputValue()) === 'something else entirely for B',
    "chat B's draft must survive the round trip too"
  )

  // Clearing a draft by hand leaves the chat blank on the next visit.
  await composer.fill('')
  await switchTo(chatA)
  await switchTo('draft-chat-B')
  assert(
    (await composer.inputValue()) === '',
    'an emptied draft stays empty — nothing resurrects it'
  )

  // Closing a chat drops its draft, so a chat that later reuses the key is blank.
  await switchTo(chatA)
  assert((await composer.inputValue()) === 'half-written ask for A', "A's draft is still there")
  await win.evaluate((k) => window.__praxisStore.getState().clearChat(k), chatA)
  await switchTo('draft-chat-B')
  await switchTo(chatA)
  assert(
    (await composer.inputValue()) === '',
    "a closed chat's draft must not come back with its key"
  )

  console.log('composer-draft: PASS')
} catch (err) {
  console.error('composer-draft: FAIL', err)
  process.exitCode = 1
} finally {
  await app?.close()
}
