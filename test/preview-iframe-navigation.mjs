/**
 * Preview navigation boundary regression (Electron 43): a cross-origin iframe
 * may follow its own 302 redirect without being mistaken for a main-frame
 * escape. Automatic popup requests remain denied silently, while a top-level
 * navigation to that same second localhost origin is blocked and externalized.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'
import { _electron as electron } from 'playwright'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = mkdtempSync(join(tmpdir(), 'praxis-iframe-navigation-'))
const requests = new Map()

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

const iframeServer = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://fixture.invalid').pathname
  requests.set(path, (requests.get(path) ?? 0) + 1)

  if (path === '/redirect') {
    res.writeHead(302, { Location: '/final' })
    res.end()
    return
  }

  if (path === '/final') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html>
      <html><body>
        <h1 id="redirected">Iframe redirect rendered</h1>
        <script>window.open('https://popup.example.invalid/automatic', '_blank')</script>
      </body></html>`)
    return
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end('<!doctype html><body>top-level target</body>')
})

await new Promise((resolve, reject) => {
  iframeServer.once('error', reject)
  iframeServer.listen(0, '127.0.0.1', resolve)
})
const iframeAddress = iframeServer.address()
if (!iframeAddress || typeof iframeAddress === 'string') {
  throw new Error('iframe fixture server did not expose a TCP port')
}
const iframeOrigin = `http://127.0.0.1:${iframeAddress.port}`
const finalIframeUrl = `${iframeOrigin}/final`
const topLevelTarget = `${iframeOrigin}/top-level`

writeFileSync(
  join(fixture, 'index.html'),
  `<!doctype html><html><body>
    <h1>Preview host</h1>
    <iframe id="external-frame" src="${iframeOrigin}/redirect"></iframe>
  </body></html>`
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

  // Keep this test hermetic: record browser handoffs instead of launching the
  // user's real browser. The stub is installed before the preview is created.
  await app.evaluate(({ shell }) => {
    globalThis.__praxisOpenedExternal = []
    shell.openExternal = async (url) => {
      globalThis.__praxisOpenedExternal.push(url)
    }
  })
  await app.evaluate(async ({ dialog }, fixturePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixturePath] })
  }, fixture)
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.send('menu:action', 'open-project')
  )

  const deadline = Date.now() + 30000
  let previewUrl = null
  let iframeText = null
  while (Date.now() < deadline) {
    const state = await app.evaluate(async ({ webContents }, expectedIframeUrl) => {
      const wc = webContents
        .getAllWebContents()
        .find((candidate) =>
          /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+/.test(candidate.getURL())
        )
      if (!wc) return null
      const frame = wc.mainFrame.framesInSubtree.find(
        (candidate) => candidate.url === expectedIframeUrl
      )
      if (!frame) return { previewUrl: wc.getURL(), iframeText: null }
      return {
        previewUrl: wc.getURL(),
        iframeText: await frame.executeJavaScript(
          "document.querySelector('#redirected')?.textContent ?? null"
        )
      }
    }, finalIframeUrl)
    previewUrl = state?.previewUrl ?? previewUrl
    iframeText = state?.iframeText ?? null
    if (iframeText === 'Iframe redirect rendered') break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  assert(previewUrl, 'preview never loaded the local host fixture')
  assert(
    iframeText === 'Iframe redirect rendered',
    `redirected iframe content did not render (preview ${previewUrl})`
  )
  assert(
    requests.get('/redirect') === 1,
    `iframe redirect endpoint requests: ${requests.get('/redirect')}`
  )
  assert(requests.get('/final') === 1, `iframe final endpoint requests: ${requests.get('/final')}`)

  const openedDuringMount = await app.evaluate(() => globalThis.__praxisOpenedExternal)
  assert(
    openedDuringMount.length === 0,
    `iframe mount/redirect opened external URLs: ${JSON.stringify(openedDuringMount)}`
  )

  const pinnedOrigin = new URL(previewUrl).origin
  await app.evaluate(
    async ({ webContents }, { origin, target }) => {
      const wc = webContents
        .getAllWebContents()
        .find((candidate) => candidate.getURL().startsWith(origin))
      if (!wc) throw new Error(`preview WebContents not found for ${origin}`)
      try {
        await wc.executeJavaScript(`location.assign(${JSON.stringify(target)})`)
      } catch {
        // A cancelled Chromium navigation may reject executeJavaScript.
      }
    },
    { origin: pinnedOrigin, target: topLevelTarget }
  )

  let openedAfterTopLevel = []
  for (let i = 0; i < 50; i++) {
    openedAfterTopLevel = await app.evaluate(() => globalThis.__praxisOpenedExternal)
    if (openedAfterTopLevel.includes(topLevelTarget)) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert(
    openedAfterTopLevel.includes(topLevelTarget),
    `top-level cross-origin URL was not externalized: ${JSON.stringify(openedAfterTopLevel)}`
  )

  const finalPreviewUrl = await app.evaluate(
    ({ webContents }, origin) =>
      webContents
        .getAllWebContents()
        .find((candidate) => candidate.getURL().startsWith(origin))
        ?.getURL() ?? null,
    pinnedOrigin
  )
  assert(
    finalPreviewUrl && new URL(finalPreviewUrl).origin === pinnedOrigin,
    `top-level navigation escaped pinned origin ${pinnedOrigin}: ${finalPreviewUrl}`
  )

  console.log('PREVIEW-IFRAME-NAVIGATION OK — subframe redirect allowed, main frame pinned')
} catch (error) {
  console.error('PREVIEW-IFRAME-NAVIGATION FAILED:', error?.message ?? error)
  process.exitCode = 1
} finally {
  await app?.close()
  await new Promise((resolve) => iframeServer.close(resolve))
  rmSync(fixture, { recursive: true, force: true })
}
