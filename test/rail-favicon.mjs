/**
 * Rail project glyph — a project's OWN favicon replaces the folder icon.
 *
 * Opens two fixtures side by side: `selectable-app` ships
 * `public/favicon.svg`, `static-app` ships no icon at all. Asserts the first
 * row's glyph is an <img> carrying an inlined data: URL and the second's is
 * still the lucide folder, so both branches are proven in one screenshot
 * (19-rail-favicon.png — the favicon is a loud magenta disc, unmistakable
 * against the grey folder next to it).
 *
 * Run with: bun run test:rail-favicon
 */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'
import { _electron as electron } from 'playwright'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const withIcon = join(root, 'test', 'fixtures', 'selectable-app')
const withoutIcon = join(root, 'test', 'fixtures', 'static-app')
const artifacts = join(root, 'test', 'artifacts')
mkdirSync(artifacts, { recursive: true })

/** The glyph a project row is currently painting. */
const glyphOf = (win, nameFragment) =>
  win.evaluate((frag) => {
    const item = [...document.querySelectorAll('.rail__item')].find((li) =>
      li.querySelector('.rail__name')?.textContent?.includes(frag)
    )
    if (!item) return { found: false }
    const img = item.querySelector('.rail__glyph img.rail__favicon')
    return {
      found: true,
      // An <img> means the project's own favicon; an <svg> means the fallback.
      kind: img ? 'favicon' : item.querySelector('.rail__glyph svg.rail__folder') ? 'folder' : 'none',
      src: img?.getAttribute('src') ?? null,
      // Proof it actually DECODED — a broken data: URL still renders an <img>.
      width: img?.naturalWidth ?? 0,
      height: img?.naturalHeight ?? 0
    }
  }, nameFragment)

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

  // Open the project that HAS a favicon.
  await stubDialog(withIcon)
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.send('menu:action', 'open-project')
  )
  await waitRunning()
  await win.waitForSelector('.rail', { timeout: 5000 })

  // The icon arrives over IPC a tick after the row does, so wait for the swap
  // rather than reading the first paint (which is legitimately the folder).
  await win.waitForFunction(
    () => !!document.querySelector('.rail__glyph img.rail__favicon'),
    undefined,
    { timeout: 10000 }
  )

  const iconGlyph = await glyphOf(win, 'selectable')
  if (iconGlyph.kind !== 'favicon') {
    throw new Error(`a project with public/favicon.svg should show it, got ${iconGlyph.kind}`)
  }
  if (!iconGlyph.src?.startsWith('data:image/svg+xml;base64,')) {
    throw new Error(`favicon should be an inlined svg data URL, got ${iconGlyph.src?.slice(0, 40)}`)
  }
  // naturalWidth is 0 for an <img> whose source failed to decode, so this is
  // what separates "we rendered an img tag" from "the user sees the icon".
  if (iconGlyph.width === 0 || iconGlyph.height === 0) {
    throw new Error('the favicon <img> never decoded — the data URL is broken')
  }

  // Open the project that has NO favicon, keeping the first one warm.
  await stubDialog(withoutIcon)
  await win.click('.rail__action[title^="Open an existing"]')
  await win.waitForFunction(() => document.querySelectorAll('.rail__name').length === 2, {
    timeout: 60000
  })
  await waitRunning()

  // Its glyph must stay the folder — and, since the store caches per project,
  // it must not inherit the other project's icon.
  const folderGlyph = await glyphOf(win, 'praxis-fixture-static')
  if (folderGlyph.kind !== 'folder') {
    throw new Error(`a project with no favicon should keep the folder, got ${folderGlyph.kind}`)
  }

  // …and the first project still shows its own, so the two don't collide.
  const stillIcon = await glyphOf(win, 'selectable')
  if (stillIcon.kind !== 'favicon' || stillIcon.src !== iconGlyph.src) {
    throw new Error("opening a second project disturbed the first project's favicon")
  }

  await win.screenshot({ path: join(artifacts, '19-rail-favicon.png') })
  console.log('RAIL FAVICON OK — project favicon replaces the folder; iconless project keeps it')
} catch (err) {
  console.error('RAIL FAVICON FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  await app?.close()
}
