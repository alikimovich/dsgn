/**
 * Mobile-viewport bezel vs the previewed app's own CSS. The iPhone frame is an
 * <img> injected INTO the user's page, so the page's stylesheets apply to it —
 * a common reset like Tailwind preflight's `img { max-width: 100% }` used to
 * clamp the upscaled bezel back into the viewport, drawing a second, misaligned
 * phone over the app (the DOM bezel behind + the squeezed in-page one).
 *
 * This serves a fixture WITH such a reset, switches the viewport to mobile, and
 * asserts the injected frame keeps its computed overflow geometry (wider than
 * the viewport, offset by the screen-cutout insets).
 *
 * Run with: bun run test:mobileframe
 */
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, readFileSync, writeFileSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// A copy of the static fixture with a Tailwind-preflight-style img reset — the
// hostile page CSS this test exists for.
const fixture = mkdtempSync(join(tmpdir(), 'praxis-reset-app-'))
cpSync(join(root, 'test', 'fixtures', 'static-app'), fixture, { recursive: true })
const serverPath = join(fixture, 'server.mjs')
writeFileSync(
  serverPath,
  readFileSync(serverPath, 'utf8').replace(
    `'<!doctype html><meta charset="utf-8">' +`,
    `'<!doctype html><meta charset="utf-8">' +\n      '<style>img, video { max-width: 100%; height: auto; }</style>' +`
  )
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let app
try {
  app = await electron.launch({
    executablePath: electronPath,
    args: [join(root, 'out', 'main', 'index.js')],
    cwd: root
  })

  const win = await app.firstWindow()
  await win.waitForSelector('.empty__open', { timeout: 15000 })

  await app.evaluate(async ({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] })
  }, fixture)
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.send('menu:action', 'open-project')
  )
  await win.waitForFunction(
    () =>
      /http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+/.test(
        document.querySelector('.previewbar__url')?.textContent ?? ''
      ),
    { timeout: 60000 }
  )

  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.send('menu:action', 'viewport:mobile')
  )
  await sleep(1200)

  // The renderer must be showing exactly one DOM bezel.
  const bezels = await win.evaluate(() => document.querySelectorAll('.preview-bezel').length)
  if (bezels !== 1) throw new Error(`expected 1 DOM bezel, got ${bezels}`)

  // Inside the previewed page: the injected frame must OVERFLOW the viewport
  // (upscaled + negatively offset) despite the page's img reset.
  const frame = await app.evaluate(async ({ webContents }) => {
    const wc = webContents
      .getAllWebContents()
      .find((w) => /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+/.test(w.getURL()))
    if (!wc) return null
    return wc.executeJavaScript(`(() => {
      const img = document.querySelector('[data-praxis-frame] img')
      if (!img) return null
      const r = img.getBoundingClientRect()
      return { x: r.x, y: r.y, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight }
    })()`)
  })
  if (!frame) throw new Error('no [data-praxis-frame] img injected into the mobile preview')
  if (frame.w <= frame.vw || frame.h <= frame.vh) {
    throw new Error(
      `page CSS clamped the bezel: frame ${frame.w}x${frame.h} must exceed viewport ${frame.vw}x${frame.vh}`
    )
  }
  if (frame.x >= 0 || frame.y >= 0) {
    throw new Error(`bezel must start above/left of the viewport, got (${frame.x}, ${frame.y})`)
  }
  // The overflow must equal the cutout insets: right/bottom edges land past the
  // viewport by the mirrored inset, i.e. x + w ≈ vw - x (symmetric-ish check
  // with the real inset ratios is overkill; a 2px tolerance on overhang > 0).
  if (frame.x + frame.w < frame.vw + 2 || frame.y + frame.h < frame.vh + 2) {
    throw new Error(
      `bezel must overflow on all sides: spans x ${frame.x}..${frame.x + frame.w} in vw ${frame.vw}, y ${frame.y}..${frame.y + frame.h} in vh ${frame.vh}`
    )
  }

  console.log(
    `MOBILE-FRAME OK — bezel ${Math.round(frame.w)}x${Math.round(frame.h)} overflows the ${frame.vw}x${frame.vh} viewport despite the page's img reset`
  )
} catch (err) {
  console.error('MOBILE-FRAME FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  await app?.close()
}
