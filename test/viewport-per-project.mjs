/**
 * Viewport is a PER-PROJECT choice. Selecting Mobile on one project must not
 * leak into the next: a fresh open starts at desktop, and switching between
 * warm projects restores each one's own viewport.
 *
 * Run with: bun run test:viewport
 */
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixtureA = join(root, 'test', 'fixtures', 'static-app')
// Second project = a copy of the fixture (distinct root → distinct workspace entry).
const fixtureB = mkdtempSync(join(tmpdir(), 'praxis-viewport-b-'))
cpSync(fixtureA, fixtureB, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let app
let failed = false
try {
  app = await electron.launch({
    executablePath: electronPath,
    args: [join(root, 'out', 'main', 'index.js')],
    cwd: root
  })
  const win = await app.firstWindow()
  await win.waitForSelector('.empty__open', { timeout: 15000 })

  const openVia = async (path) => {
    await app.evaluate(async ({ dialog }, p) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] })
    }, path)
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.send('menu:action', 'open-project')
    )
  }
  // Port-agnostic: the runner takes the first FREE port ≥ 7777, so a live app
  // session (or anything else) squatting on 7777 must not fail the test. Wait
  // for any localhost URL in the bar (optionally different from the previous
  // project's) and remember it for the switch-back assertions.
  const URL_RE = /http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+/
  const waitNewUrl = async (notUrl) => {
    await win.waitForFunction(
      (args) => {
        const t = document.querySelector('.previewbar__url')?.textContent ?? ''
        const m = t.match(/http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+/)
        return !!m && (!args || m[0] !== args)
      },
      notUrl ?? null,
      { timeout: 60000 }
    )
    return await win.evaluate(() =>
      (document.querySelector('.previewbar__url')?.textContent ?? '').match(
        /http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+/
      )[0]
    )
  }
  const waitUrl = (url) =>
    win.waitForFunction(
      (u) => (document.querySelector('.previewbar__url')?.textContent ?? '').includes(u),
      url,
      { timeout: 60000 }
    )
  const expect = async (label, want) => {
    await sleep(600)
    const got = await win.evaluate(() => ({
      store: window.__praxisViewport.getState().viewport,
      mobileDom: !!document.querySelector('.preview-slot--mobile')
    }))
    const ok = got.store === want && got.mobileDom === (want === 'mobile')
    if (!ok) {
      failed = true
      console.error(`  ✗ ${label}: want ${want}, got ${JSON.stringify(got)}`)
    }
  }
  const switchProject = () =>
    win.click('.rail__item:not(.rail__item--active) .rail__open')

  await openVia(fixtureA)
  const urlA = await waitNewUrl()
  await expect('A opens at desktop', 'desktop')

  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.send('menu:action', 'viewport:mobile')
  )
  await expect('A toggles to mobile', 'mobile')

  await openVia(fixtureB)
  const urlB = await waitNewUrl(urlA)
  await expect('B opens at desktop (no leak from A)', 'desktop')

  await switchProject()
  await waitUrl(urlA)
  await expect('back on A: its mobile restored', 'mobile')

  await switchProject()
  await waitUrl(urlB)
  await expect('back on B: still desktop', 'desktop')

  if (failed) throw new Error('per-project viewport assertions failed')
  console.log('VIEWPORT-PER-PROJECT OK — mobile stays with its project; fresh opens start desktop')
} catch (err) {
  console.error('VIEWPORT-PER-PROJECT FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  await app?.close()
}
