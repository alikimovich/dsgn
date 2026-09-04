/**
 * Alt/Option spacing measurement, end to end in the real preview:
 *
 *   open fixture → Select mode → trusted click on the heading → hold Option and
 *   hover the card → the overlay draws the gap between the two, labelled with
 *   the real pixel distance → releasing Option clears it.
 *
 * The overlay lives in the preview WebContentsView (a separate CDP target), so
 * everything here is driven through the main process, and the screenshot comes
 * from `capturePage()` rather than the renderer page.
 *
 * Run with: bun run test:measure-alt
 */
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = join(root, 'test', 'fixtures', 'selectable-app')
const artifacts = join(root, 'test', 'artifacts')
mkdirSync(artifacts, { recursive: true })

const EXPECTED_SOURCE = 'src/components/Hero.tsx:7'

const GET_CENTER = `(() => {
  const el = document.querySelector('#hero-title')
  if (!el) return null
  const b = el.getBoundingClientRect()
  return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }
})()`

// Hover `.card` with Option down/up. onMove reads e.altKey off the event, so a
// synthetic move is enough to drive the gesture (unlike the pick, which the
// preload rejects unless the event is trusted).
const hover = (alt) => `(() => {
  const el = document.querySelector('.card')
  el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, altKey: ${alt} }))
  const layer = document
    .querySelector('[data-praxis-overlay]')
    ?.shadowRoot?.querySelector('[data-praxis-measure]')
  const labels = [...(layer?.querySelectorAll('[data-praxis-measure-label]') ?? [])]
  const geometry = [...(layer?.children ?? [])].filter(
    (node) => !node.hasAttribute('data-praxis-measure-label')
  )
  const a = document.querySelector('#hero-title').getBoundingClientRect()
  const b = el.getBoundingClientRect()
  return {
    labels: labels.map((l) => l.textContent),
    labelBackgrounds: labels.map((l) => getComputedStyle(l).backgroundColor),
    geometryBackgrounds: geometry.map((node) => getComputedStyle(node).backgroundColor),
    lines: layer ? layer.childElementCount - labels.length : 0,
    gap: b.top - a.bottom
  }
})()`

let app
try {
  app = await electron.launch({
    executablePath: electronPath,
    args: [join(root, 'out', 'main', 'index.js')],
    cwd: root
  })

  const win = await app.firstWindow()
  await win.waitForSelector('.empty__open', { timeout: 15000 })

  const inPreview = (code) =>
    app.evaluate(async ({ webContents }, c) => {
      const wc = webContents
        .getAllWebContents()
        .find((w) => /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+/.test(w.getURL()))
      if (!wc) return null
      return wc.executeJavaScript(c, true)
    }, code)

  await app.evaluate(async ({ dialog }, fixturePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixturePath] })
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

  await win.click('button[aria-label="Select"]')
  await win.waitForSelector('button[aria-label="Select"][aria-pressed="true"]', { timeout: 5000 })

  // Pick the heading with a real input event (the preload ignores synthetic clicks).
  let picked = false
  for (let i = 0; i < 40 && !picked; i++) {
    const result = await app.evaluate(async ({ webContents }, code) => {
      const wc = webContents
        .getAllWebContents()
        .find((w) => /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+/.test(w.getURL()))
      if (!wc) return 'no-preview'
      const c = await wc.executeJavaScript(code, true)
      if (!c) return 'no-element'
      wc.focus()
      wc.sendInputEvent({ type: 'mouseMove', x: c.x, y: c.y })
      wc.sendInputEvent({ type: 'mouseDown', x: c.x, y: c.y, button: 'left', clickCount: 1 })
      wc.sendInputEvent({ type: 'mouseUp', x: c.x, y: c.y, button: 'left', clickCount: 1 })
      return 'clicked'
    }, GET_CENTER)
    if (result !== 'clicked') {
      await new Promise((r) => setTimeout(r, 300))
      continue
    }
    picked = await win
      .waitForFunction(
        (src) => document.querySelector('.inspector__source')?.textContent?.includes(src),
        EXPECTED_SOURCE,
        { timeout: 1000 }
      )
      .then(() => true)
      .catch(() => false)
  }
  if (!picked) throw new Error('never picked the heading — nothing to measure from')

  // Option held: the vertical gap between the heading and the card, labelled.
  const held = await inPreview(hover(true))
  if (!held) throw new Error('no preview webContents')
  if (held.labels.length !== 1) {
    throw new Error(`expected one distance label, got ${JSON.stringify(held.labels)}`)
  }
  // The label rounds to one decimal, so allow half of that against the raw gap.
  if (!(Math.abs(Number(held.labels[0]) - held.gap) <= 0.05)) {
    throw new Error(`label should read the real gap (${held.gap}), got ${held.labels[0]}`)
  }
  // The span itself plus its two end caps.
  if (held.lines !== 3) throw new Error(`expected a span with two caps, got ${held.lines} lines`)
  const measurementRed = 'rgb(242, 72, 34)'
  if (
    held.labelBackgrounds.some((color) => color !== measurementRed) ||
    held.geometryBackgrounds.some((color) => color !== measurementRed)
  ) {
    throw new Error(
      `label and line fills must share measurement red: ${JSON.stringify({
        labels: held.labelBackgrounds,
        geometry: held.geometryBackgrounds
      })}`
    )
  }

  const png = await app.evaluate(async ({ webContents }) => {
    const wc = webContents
      .getAllWebContents()
      .find((w) => /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+/.test(w.getURL()))
    if (!wc) return null
    return (await wc.capturePage()).toPNG().toString('base64')
  })
  if (png) writeFileSync(join(artifacts, 'measure-alt.png'), Buffer.from(png, 'base64'))

  // Option released: nothing measured, the rest of the overlay untouched.
  const released = await inPreview(hover(false))
  if (released.labels.length || released.lines) {
    throw new Error(`measurement should clear without Option: ${JSON.stringify(released)}`)
  }
  const stillSelected = await inPreview(`(() => {
    const shadow = document.querySelector('[data-praxis-overlay]')?.shadowRoot
    return !!shadow?.querySelector('[data-praxis-selbox]')
  })()`)
  if (!stillSelected) throw new Error('clearing the measurement must not clear the selection')

  console.log('MEASURE-ALT OK — gap', held.labels[0], 'px between the heading and the card')
} catch (err) {
  console.error('MEASURE-ALT FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  await app?.close()
}
