/**
 * Rail chat-list overflow — a project's previous chats are capped at 5 rows
 * (MAX_CHAT_ROWS, minus any live/working rows), with a muted "Show N more" row
 * that expands to the full list and a "Show less" that re-tucks it. History is
 * seeded straight into the exposed useHistory store (no real sessions needed).
 *
 * Run with: bun run test:rail-overflow
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

const rows = (win) =>
  win.evaluate(() => ({
    chats: document.querySelectorAll('.rail__chats .rail__chat-item').length,
    more: document.querySelector('.rail__chat--more .rail__chat-name')?.textContent ?? null
  }))

let app
try {
  app = await electron.launch({
    executablePath: electronPath,
    args: [join(root, 'out', 'main', 'index.js')],
    cwd: root
  })
  const win = await app.firstWindow()
  await win.waitForSelector('.empty__open', { timeout: 15000 })
  await app.evaluate(async ({ dialog }, f) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] })
  }, fixture)
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.send('menu:action', 'open-project')
  )
  // The chats list starts EMPTY (zero height = "hidden" to Playwright) — wait
  // for attachment, not visibility.
  await win.waitForSelector('.rail__chats', { state: 'attached', timeout: 60000 })

  // Seed 9 fake previous chats for the active project. App re-runs
  // useHistory.load() on several triggers and each resolve REPLACES byKey with
  // the real (empty) list — stub load first so the seed survives.
  await win.evaluate((fixtureRoot) => {
    window.__praxisHistory.setState({ load: async () => {} })
    const key = window.__praxisWorkspace.getState().activeKey
    const recs = Array.from({ length: 9 }, (_, i) => ({
      id: `fake-${i}`,
      projectRoot: fixtureRoot,
      title: `Fake chat ${i + 1}`,
      transcript: [],
      filesTouched: [],
      startedAt: 1754300000000 - i * 60000
    }))
    window.__praxisHistory.setState((s) => ({ byKey: { ...s.byKey, [key]: recs } }))
  }, fixture)

  // Capped: 5 chat rows (no live chats — none has messages) + the toggle row.
  await win.waitForFunction(
    () => document.querySelectorAll('.rail__chats .rail__chat-item').length === 6,
    undefined,
    { timeout: 3000 }
  )
  const capped = await rows(win)
  if (capped.more !== 'Show 4 more') throw new Error(`toggle row reads "${capped.more}"`)
  await win.screenshot({ path: join(artifacts, '19-rail-overflow-capped.png') })

  // JS-click: the rail re-renders on unrelated store ticks, so Playwright's
  // stability wait sees the button perpetually "detached" (same reason
  // code-drawer.mjs JS-clicks). The DOM handler runs fine.
  const clickMore = () =>
    win.evaluate(() => {
      const b = document.querySelector('.rail__chat--more')
      if (!b) throw new Error('toggle row missing')
      b.click()
    })
  const waitRows = (n) =>
    win.waitForFunction(
      (want) => document.querySelectorAll('.rail__chats .rail__chat-item').length === want,
      n,
      { timeout: 3000 }
    )

  // Expand → all 9 + "Show less".
  await clickMore()
  await waitRows(10)
  const expanded = await rows(win)
  if (expanded.more !== 'Show less') throw new Error(`expanded toggle reads "${expanded.more}"`)
  await win.screenshot({ path: join(artifacts, '20-rail-overflow-expanded.png') })

  // Collapse back.
  await clickMore()
  await waitRows(6)

  console.log('RAIL-OVERFLOW OK — 5 capped + toggle, 9 expanded, re-tucked')
} catch (err) {
  console.error('RAIL-OVERFLOW FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  await app?.close()
}
