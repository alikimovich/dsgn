/**
 * v5-C rail + switching — end to end. Open project A, then "+ New project" B
 * keeping A warm, then switch back to A via the rail. Asserts:
 *  - both appear in the rail; both dev servers stay running (warm),
 *  - switching swaps the active preview URL to the target project,
 *  - the per-project chat slice swaps with the active project.
 *
 * Run with: bun run test:rail
 */
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync } from 'node:fs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixtureA = join(root, 'test', 'fixtures', 'static-app')
const fixtureB = join(root, 'test', 'fixtures', 'selectable-app')
const artifacts = join(root, 'test', 'artifacts')
mkdirSync(artifacts, { recursive: true })

const localhost = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+/
const port = (u) => {
  try {
    return new URL(u).port
  } catch {
    return null
  }
}

const reachable = (app, url) =>
  app.evaluate(async (_m, u) => {
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 2500)
      const res = await fetch(u, { signal: ctrl.signal })
      clearTimeout(t)
      return (res.status ?? 0) > 0
    } catch {
      return false
    }
  }, url)

const previewUrl = (app) =>
  app.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .map((w) => w.getURL())
      .find((u) => /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+/.test(u))
  )

// Poll until the preview navigates to the expected port (navigation is async).
const waitPreviewPort = async (app, expected) => {
  for (let i = 0; i < 40; i++) {
    if (port(await previewUrl(app)) === expected) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
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

  const stubDialog = (fixture) =>
    app.evaluate(async ({ dialog }, f) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] })
    }, fixture)

  const waitRunning = () =>
    win.waitForFunction(
      () =>
        /http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+/.test(
          document.querySelector('.previewbar__url')?.textContent ?? ''
        ),
      { timeout: 60000 }
    )

  // Open A.
  await stubDialog(fixtureA)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:action', 'open-project'))
  await waitRunning()
  await win.waitForSelector('.rail', { timeout: 5000 })
  let names = await win.evaluate(() =>
    [...document.querySelectorAll('.rail__name')].map((e) => e.textContent)
  )
  if (names.length !== 1) throw new Error(`rail should show 1 project, got ${JSON.stringify(names)}`)

  // Open B via the rail "+", keeping A warm.
  await stubDialog(fixtureB)
  await win.click('.rail__action[title^="Open an existing"]')
  // Wait until two projects are listed and one is running.
  await win.waitForFunction(() => document.querySelectorAll('.rail__name').length === 2, {
    timeout: 60000
  })
  await waitRunning()

  // Both servers warm. `waitRunning` above can be satisfied by A's URL still in
  // the previewbar, so wait for B's own entry to carry a URL before reading them.
  await win.waitForFunction(
    () => window.__praxisWorkspace.getState().projects.filter((p) => p.url).length === 2,
    undefined,
    { timeout: 60000 }
  )
  const ws = await win.evaluate(() => window.__praxisWorkspace.getState())
  const urlA = ws.projects.find((p) => p.name === 'praxis-fixture-static')?.url
  const urlB = ws.projects.find((p) => p.name.includes('selectable'))?.url
  if (!urlA || !urlB || urlA === urlB) {
    throw new Error(`expected two distinct warm URLs, got ${urlA} / ${urlB}`)
  }
  if (!(await reachable(app, urlA))) throw new Error('project A server should stay warm')
  if (!(await reachable(app, urlB))) throw new Error('project B server should be running')

  // Active is B; give B's chat a distinctive message so we can prove the slice swaps.
  await win.evaluate(() => window.__praxisStore.getState().appendUser('hello from B'))
  const bText = await win.evaluate(
    () => window.__praxisStore.getState().messages.at(-1)?.text
  )
  if (bText !== 'hello from B') throw new Error(`B chat should hold its message, got "${bText}"`)

  // Preview is showing B.
  if (!(await waitPreviewPort(app, port(urlB)))) throw new Error("preview should show B after opening it")

  // Switch to A via the rail.
  await win.click('.rail__item:has-text("praxis-fixture-static") .rail__open')
  await win.waitForFunction(
    (u) => document.querySelector('.previewbar__url')?.textContent?.includes(u),
    new URL(urlA).host,
    { timeout: 10000 }
  )
  if (!(await waitPreviewPort(app, port(urlA)))) throw new Error("switching should load A in the preview")
  // A's chat is its OWN slice — it must NOT contain B's message (per-project isolation).
  const aHasBText = await win.evaluate(() =>
    window.__praxisStore.getState().messages.some((m) => m.text.includes('hello from B'))
  )
  if (aHasBText) throw new Error("A's chat leaked B's message — per-project isolation broken")

  // A project's fold is its OWN state: switching to A must NOT collapse B — its
  // chat list (the "hello from B" row) stays on screen, backgrounded but open.
  const itemB = win.locator('.rail__item', { hasText: 'selectable' })
  const chatsB = itemB.locator('.rail__chats .rail__chat-item')
  if ((await chatsB.count()) === 0) {
    throw new Error("B's chats should stay listed after switching away from B")
  }
  await win.screenshot({ path: join(artifacts, '10-rail-folds.png') })

  // The chevron folds only the project it belongs to…
  await itemB.locator('.rail__glyph-btn').click()
  await win.waitForFunction(() => {
    const b = [...document.querySelectorAll('.rail__item')].find((li) =>
      li.textContent?.includes('selectable')
    )
    return b && !b.querySelector('.rail__chats')
  }, undefined, { timeout: 3000 })

  // …and the fold survives becoming the active project again (it used to spring
  // back open, because "expanded" meant "is the active project").
  await win.click('.rail__item:has-text("selectable") .rail__name-btn')
  if (!(await waitPreviewPort(app, port(urlB)))) throw new Error('switching back should load B')
  if ((await chatsB.count()) !== 0) {
    throw new Error("B stayed collapsed only until it was active again — fold state didn't persist")
  }

  await win.screenshot({ path: join(artifacts, '10-rail.png') })
  console.log('RAIL OK — two projects warm, switch swaps preview + per-project chat, folds persist')
} catch (err) {
  console.error('RAIL FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  await app?.close()
}
