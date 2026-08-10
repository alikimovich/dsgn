/**
 * v5-D "previous agents" renderer UI — drives the stores directly (the
 * chat-render.mjs pattern), no Claude creds. Seeds a project + a fake history
 * record, then asserts the rail's previous-sessions list renders and the
 * SessionReview modal opens with the record's branch / PR / files / transcript.
 * Also covers the modal↔native-preview contract: the native view hides under
 * the open modal (freeze-frame), a preview:load landing mid-modal must NOT
 * unhide it over the modal, and closing restores it.
 *
 * The backend capture/persist is covered cred-free by agent-history.mjs; this is
 * purely the rendered DOM from seeded store state.
 *
 * Run with: bun run test:historyui
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
  await win.evaluate(() => window.__praxisWorkspace.getState().openOrActivate('/tmp/praxis-test-project'))
  await win.waitForSelector('.composer__input', { timeout: 15000 })
  const assert = (cond, msg) => {
    if (!cond) throw new Error(msg)
  }

  // Seed an open project (so the rail renders it as active) + a past session in
  // useHistory keyed by that project's projectKey.
  const key = await win.evaluate(() => {
    const ws = window.__praxisWorkspace.getState()
    ws.reset()
    const k = ws.openOrActivate('/fake/proj', { name: 'proj' })
    window.__praxisStore.getState().setActiveChat(k)
    const now = Date.now()
    window.__praxisHistory.setState({
      byKey: {
        [k]: [
          {
            id: 'h1',
            projectKey: k,
            projectRoot: '/fake/proj',
            projectName: 'proj',
            startedAt: now - 3_600_000,
            endedAt: now - 3_500_000,
            branch: 'praxis/history-x',
            prUrl: 'https://github.com/x/y/pull/1',
            filesTouched: ['src/App.tsx'],
            transcript: [
              { role: 'user', text: 'make the header blue', at: now - 3_600_000 },
              { role: 'status', text: 'Edit · src/App.tsx', at: now - 3_550_000 },
              { role: 'assistant', text: 'Done — header is now blue.', at: now - 3_500_000 }
            ]
          }
        ]
      }
    })
    return k
  })
  assert(key, 'workspace should produce a project key')

  // The History section starts folded — unfold it to get at the past chat rows.
  await win.waitForSelector('.rail__section-toggle', { timeout: 5000 })
  await win.evaluate(() => document.querySelector('.rail__section-toggle').click())

  // The rail shows the past chat row: an auto-generated name (from the first
  // user prompt) + a compact trailing "time ago", no status dot.
  const pastChat = '.rail__chat:has(.rail__chat-time)'
  await win.waitForSelector(pastChat, { timeout: 5000 })
  const name = (await win.textContent(`${pastChat} .rail__chat-name`))?.trim() ?? ''
  assert(
    name.includes('make the header blue'),
    `chat row should be named from its first prompt (got "${name}")`
  )
  const time = (await win.textContent(`${pastChat} .rail__chat-time`))?.trim() ?? ''
  assert(/^\d+(m|h|d|mo|y)$/.test(time), `chat row should show a compact time (got "${time}")`)
  await win.screenshot({ path: join(artifacts, 'history-rail.png') })

  // Click the row → the review modal opens with branch chip, PR link, files, transcript.
  await win.click(pastChat)
  await win.waitForSelector('.review', { timeout: 5000 })
  const meta = (await win.textContent('.review__meta')) ?? ''
  assert(meta.includes('praxis/history-x'), `review should show the branch chip (got "${meta}")`)
  assert(meta.toLowerCase().includes('pr'), 'review should show the PR link chip')
  assert(meta.includes('1 file'), `review should show files-touched count (got "${meta}")`)
  const tx = (await win.textContent('.review__transcript')) ?? ''
  assert(tx.includes('make the header blue'), 'transcript shows the user prompt')
  assert(tx.includes('header is now blue'), 'transcript shows the assistant reply')
  assert(
    (await win.$('.review__line--user')) && (await win.$('.review__line--assistant')),
    'transcript renders role-tagged lines'
  )
  await win.screenshot({ path: join(artifacts, 'history-review.png') })

  // The modal is renderer DOM and the native preview always paints over DOM, so
  // while the modal is open the native view must be hidden (the freeze-frame
  // <img> stands in for it). Read visibility from the main process — the panel
  // view is the one whose URL carries praxisPanel; the preview is the other child.
  const previewVisible = () =>
    app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      const pv = win.contentView.children.find(
        (v) => v.webContents && !(v.webContents.getURL() ?? '').includes('praxisPanel')
      )
      return pv ? pv.getVisible() : null
    })
  const waitVisible = async (want) => {
    for (let i = 0; i < 30; i++) {
      if ((await previewVisible()) === want) return true
      await new Promise((r) => setTimeout(r, 100))
    }
    return false
  }
  assert(await waitVisible(false), 'native preview hides under the open review modal')
  // A project launch finishing NOW (preview:load lands while the modal is up)
  // must not punch the native view back through the modal.
  await win.evaluate(() => window.api.preview.load('http://127.0.0.1:59999/'))
  await new Promise((r) => setTimeout(r, 300))
  assert(
    (await previewVisible()) === false,
    'a preview:load landing under the open modal must not unhide the native view'
  )

  // Escape closes the modal.
  await win.keyboard.press('Escape')
  await win.waitForFunction(() => !document.querySelector('.review'), { timeout: 5000 })
  // …and closing releases the freeze: the live preview comes back.
  assert(await waitVisible(true), 'closing the review modal restores the native preview')

  // Delete the row → it leaves the rail (drives useHistory.remove; the main-side
  // sessions:remove is a harmless no-op on a fake id).
  // JS-click: the row's actions are a hover-revealed overlay (pointer-events off
  // until the row is hovered), so drive the handler directly.
  await win.evaluate(() =>
    document.querySelector('.rail__chat-item:has(.rail__chat-time) .rail__chat-x').click()
  )
  await win.waitForFunction(
    () => !document.querySelector('.rail__chat-time'),
    { timeout: 5000 }
  )

  console.log(
    'HISTORY-UI OK — rail lists previous chats, review modal renders (preview frozen under it, load respects the hide), delete removes'
  )
} catch (err) {
  console.error('HISTORY-UI FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  await app?.close()
}
