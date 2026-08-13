/**
 * Vanilla HTML / static-site support — through real IPC. Proves that plain
 * folders with no dev command are openable via praxis's built-in static server:
 *  - detect() on a folder with only index.html (no package.json) → framework
 *    'static', empty devCommand.
 *  - detect() on a package.json with no dev/start script but an index.html →
 *    also 'static' (many vanilla-JS repos ship a package.json with no scripts).
 *  - detect() on a folder with neither → throws, asking for a launch command.
 *  - devServer.start() serves index.html at the root URL, injects the live-reload
 *    snippet into HTML, serves a nested asset with the right content-type, and
 *    blocks path traversal.
 *  - devServer.running reports the in-process static server; stop() tears it down.
 *
 * Run with: bun run test:static-serve
 */
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'praxis-static-'))

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg)
}

// Fixture 1: pure HTML/JS, no package.json.
const htmlDir = join(work, 'html-site')
mkdirSync(join(htmlDir, 'assets'), { recursive: true })
writeFileSync(
  join(htmlDir, 'index.html'),
  '<!doctype html><html><head><title>Vanilla</title></head><body><h1 id="hi">Hello vanilla</h1><script src="assets/app.js"></script></body></html>'
)
writeFileSync(join(htmlDir, 'assets', 'app.js'), 'document.title = "loaded"')

// Fixture 2: package.json with NO dev/start script, but an index.html.
const noScriptDir = join(work, 'no-script')
mkdirSync(noScriptDir, { recursive: true })
writeFileSync(join(noScriptDir, 'package.json'), JSON.stringify({ name: 'vanilla-pkg' }))
writeFileSync(join(noScriptDir, 'index.html'), '<!doctype html><body>pkg no script</body>')

// Fixture 3: nothing launchable — no package.json, no HTML.
const emptyDir = join(work, 'empty')
mkdirSync(emptyDir, { recursive: true })
writeFileSync(join(emptyDir, 'readme.txt'), 'just text')

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

  const detect = (dir) => win.evaluate((d) => window.api.project.detect(d), dir)
  // Fetch from the MAIN process (Node global fetch — no renderer CORS).
  const get = (url) =>
    app.evaluate(async (_m, u) => {
      try {
        const ctrl = new AbortController()
        const t = setTimeout(() => ctrl.abort(), 3000)
        const res = await fetch(u, { signal: ctrl.signal })
        clearTimeout(t)
        return { status: res.status, type: res.headers.get('content-type'), body: await res.text() }
      } catch (e) {
        return { status: 0, error: String(e) }
      }
    }, url)

  // 1) Pure HTML folder → static framework, no command to spawn.
  const html = await detect(htmlDir)
  assert(html.framework === 'static', `html-site should detect static: ${JSON.stringify(html)}`)
  assert(html.previewKind === 'web', `static previewKind should be web: ${JSON.stringify(html)}`)
  assert(html.devCommand === '', `static devCommand should be empty: ${JSON.stringify(html)}`)

  // 2) package.json w/o dev script but with index.html → static too.
  const noScript = await detect(noScriptDir)
  assert(
    noScript.framework === 'static',
    `no-script should detect static: ${JSON.stringify(noScript)}`
  )

  // 3) Neither package.json nor HTML → throws, asking for a command.
  let threw = null
  await detect(emptyDir).catch((e) => {
    threw = e?.message ?? String(e)
  })
  assert(threw && /command/i.test(threw), `empty folder should ask for a command, got: ${threw}`)

  // Serve the static site and probe it (auto path: empty command + 'static').
  const server = await win.evaluate(
    (d) => window.api.devServer.start({ root: d, command: '', framework: 'static' }),
    htmlDir
  )
  assert(server?.url, `static server should start: ${JSON.stringify(server)}`)

  const index = await get(server.url)
  assert(index.status === 200, `index should be 200: ${JSON.stringify(index)}`)
  assert(
    /Hello vanilla/.test(index.body),
    `index should serve the HTML: ${index.body?.slice(0, 120)}`
  )
  assert(/text\/html/.test(index.type ?? ''), `index content-type should be html: ${index.type}`)
  // Live-reload snippet injected before </body>.
  assert(/__praxis_reload/.test(index.body), 'index should have the live-reload snippet injected')
  // Serve-time source stamp injected so the preview can map the element to source
  // (vanilla projects have no build step to do it). The <h1> keeps its own attrs.
  assert(
    /<h1 data-praxis-source="index\.html:\d+:\d+" id="hi">Hello vanilla<\/h1>/.test(index.body),
    `index <h1> should be source-stamped: ${index.body?.match(/<h1[^>]*>/)?.[0]}`
  )

  // Nested asset with the right content-type.
  const assetJs = await get(`${server.url}/assets/app.js`)
  assert(assetJs.status === 200, `asset should be 200: ${JSON.stringify(assetJs)}`)
  assert(/javascript/.test(assetJs.type ?? ''), `asset content-type should be js: ${assetJs.type}`)
  assert(/document\.title/.test(assetJs.body), 'asset should serve the JS body')

  // Path traversal is blocked (never escapes the served root).
  const escape = await get(`${server.url}/../../../../etc/hosts`)
  assert(
    escape.status !== 200 || !/localhost/.test(escape.body ?? ''),
    `traversal must be blocked: ${JSON.stringify(escape).slice(0, 160)}`
  )

  // running reflects the in-process static server; stop() tears it down.
  const runningBefore = await win.evaluate((d) => window.api.devServer.isRunning(d), htmlDir)
  assert(runningBefore === true, 'static server should report running')
  await win.evaluate((d) => window.api.devServer.stop(d), htmlDir)
  let down = false
  for (let i = 0; i < 25 && !down; i++) {
    const r = await get(server.url)
    if (r.status === 0) down = true
    else await new Promise((r2) => setTimeout(r2, 150))
  }
  assert(down, 'static server should be stopped (unreachable) after stop()')

  console.log(
    'STATIC-SERVE OK — detect static, serve HTML+assets, live-reload, traversal blocked, stop'
  )
} catch (err) {
  console.error('STATIC-SERVE FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  rmSync(work, { recursive: true, force: true })
  await app?.close()
}
