/**
 * Simulator Phase-2 (interaction) — transport + coordinate mapping + degrade,
 * exercised off-macOS with the test bridge (no real simulator / idb needed):
 *
 *   fractionToPoints / parseControlCommand   → pure mapping + input validation
 *   POST /control on an interactive bridge    → recorded as a ControlCommand
 *   the bridge page                           → carries the capture script (globals)
 *   POST /control with NO controller          → { degraded: true }, nothing run
 *
 * The /control POSTs run INSIDE the preview WebContentsView (same origin as the
 * bridge — no CORS/CSP), the same seam sim-frame.mjs uses. A live idb tap on a
 * booted device stays macOS-gated (like sim-e2e).
 *
 * Run with: bun run test:sim-control
 */
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg)
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
  await win.evaluate(() => window.__praxisWorkspace.getState().openOrActivate('/tmp/praxis-test-project'))
  await win.waitForSelector('.composer__input', { timeout: 15000 })

  // Run JS in the preview WebContentsView once it has navigated to `url` (its page
  // is the bridge origin, so a fetch('/control') is same-origin).
  const previewExec = async (url, js) => {
    const base = url.split('?')[0]
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      const out = await app.evaluate(
        async ({ webContents }, a) => {
          const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith(a.base))
          if (!wc) return { pending: true }
          try {
            return { value: await wc.executeJavaScript(a.js) }
          } catch (e) {
            return { error: String(e) }
          }
        },
        { base, js }
      )
      if (!out.pending) {
        if (out.error) throw new Error(out.error)
        return out.value
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    throw new Error(`preview never loaded ${base}`)
  }
  const loadPreview = (url) => win.evaluate((u) => window.api.preview.load(u), url)
  // The page bakes in its per-bridge token as window.__PRAXIS_SIM_TOKEN; ride it on
  // the same-origin /control call the way the page's own post() does.
  const postCtl = (url, cmd) =>
    previewExec(
      url,
      `fetch('/control?token='+encodeURIComponent(window.__PRAXIS_SIM_TOKEN),{method:'POST',body:JSON.stringify(${JSON.stringify(cmd)})}).then(r=>r.json())`
    )

  // --- pure mapping + input validation ---
  const m = await app.evaluate(() => {
    const s = globalThis.__praxisSimMap
    return {
      mid: s.fractionToPoints(0.5, 0.5, { width: 390, height: 844 }),
      clamp: s.fractionToPoints(1.5, -1, { width: 100, height: 100 }),
      tap: s.parseControlCommand({ type: 'tap', x: 0.1, y: 0.2 }),
      badX: s.parseControlCommand({ type: 'tap', x: 'nope', y: 0.2 }),
      evil: s.parseControlCommand({ type: 'rm-rf', x: 0, y: 0 }),
      swipe: s.parseControlCommand({ type: 'swipe', x: 0, y: 0, x2: 0.5, y2: 0.9 }),
      tapArgs: s.idbUiArgs('U-1', { type: 'tap', x: 0.5, y: 0.5 }, { width: 390, height: 844 }),
      textArgs: s.idbUiArgs('U-1', { type: 'text', text: 'hi' }, { width: 390, height: 844 })
    }
  })
  assert(m.mid.x === 195 && m.mid.y === 422, `fractionToPoints mid: ${JSON.stringify(m.mid)}`)
  assert(m.clamp.x === 100 && m.clamp.y === 0, `fractionToPoints clamp: ${JSON.stringify(m.clamp)}`)
  assert(m.tap && m.tap.type === 'tap', 'valid tap should parse')
  assert(m.swipe && m.swipe.type === 'swipe', 'valid swipe should parse')
  assert(m.badX === null, 'non-numeric coord must be rejected')
  assert(m.evil === null, 'unknown command type must be rejected')
  // --udid must FOLLOW the `ui <cmd>` subcommand — as a leading global flag idb's
  // argparse rejects the whole invocation (a usage error that exits 0-visible only
  // on stderr, i.e. interaction dies silently). Lock the order.
  assert(
    m.tapArgs.join(' ') === 'ui tap --udid U-1 195 422',
    `idbUiArgs tap order: ${JSON.stringify(m.tapArgs)}`
  )
  assert(
    m.textArgs.join(' ') === 'ui text --udid U-1 hi',
    `idbUiArgs text order: ${JSON.stringify(m.textArgs)}`
  )

  // --- interactive bridge: a /control POST is replayed (recorded here) ---
  const interactive = await app.evaluate(() => globalThis.__praxisStartTestBridge(true))
  await loadPreview(interactive.url)
  const okBody = await postCtl(interactive.url, { type: 'tap', x: 0.5, y: 0.5 })
  assert(okBody && okBody.ok === true, `control POST should succeed: ${JSON.stringify(okBody)}`)
  const recorded = await app.evaluate(() => globalThis.__praxisTestControl())
  assert(
    recorded.length === 1 && recorded[0].type === 'tap' && recorded[0].x === 0.5,
    `controller should have recorded the tap: ${JSON.stringify(recorded)}`
  )

  // --- a /control POST WITHOUT the token is rejected (403) ---
  const noTok = await previewExec(
    interactive.url,
    `fetch('/control',{method:'POST',body:JSON.stringify({type:'tap',x:0.5,y:0.5})}).then(r=>r.status)`
  )
  assert(noTok === 403, `token-less /control must be rejected: got ${noTok}`)
  const recordedAfterNoTok = await app.evaluate(() => globalThis.__praxisTestControl())
  assert(
    recordedAfterNoTok.length === 1,
    `token-less POST must not run a command: ${JSON.stringify(recordedAfterNoTok)}`
  )

  // --- the bridge page carries the capture script (globals present, flag on) ---
  const flags = await previewExec(
    interactive.url,
    `({ interactive: typeof INTERACTIVE !== 'undefined' && INTERACTIVE, hasPost: typeof post === 'function' })`
  )
  assert(flags.interactive === true && flags.hasPost === true, `capture script: ${JSON.stringify(flags)}`)

  // --- no controller (no idb) → degraded, nothing runs ---
  const viewOnly = await app.evaluate(() => globalThis.__praxisStartTestBridge(false))
  await loadPreview(viewOnly.url)
  const degBody = await postCtl(viewOnly.url, { type: 'tap', x: 0.5, y: 0.5 })
  assert(degBody && degBody.degraded === true, `view-only should be degraded: ${JSON.stringify(degBody)}`)
  const recorded2 = await app.evaluate(() => globalThis.__praxisTestControl())
  assert(recorded2.length === 0, 'view-only bridge must not run any command')
  const flag2 = await previewExec(viewOnly.url, `(typeof INTERACTIVE !== 'undefined' && INTERACTIVE)`)
  assert(flag2 === false, 'view-only page should flag INTERACTIVE=false')

  // --- Phase 3: testID parse + accessibility-tree stamp search (pure) ---
  const sel = await app.evaluate(() => {
    const s = globalThis.__praxisSimMap
    return {
      good: s.parseTestId('praxis:src/App.tsx:10:4'),
      noPrefix: s.parseTestId('my-button'),
      malformed: s.parseTestId('praxis:not a source'),
      found: s.findPraxisStamp({ type: 'View', AXLabel: 'x', children: [{ AXUniqueId: 'praxis:src/A.tsx:3:1' }] }),
      none: s.findPraxisStamp({ type: 'View', AXLabel: 'plain' })
    }
  })
  assert(sel.good && sel.good.source === 'src/App.tsx:10:4', `parseTestId: ${JSON.stringify(sel.good)}`)
  assert(sel.noPrefix === null && sel.malformed === null, 'parseTestId must reject non-stamps')
  assert(sel.found === 'praxis:src/A.tsx:3:1', `findPraxisStamp (nested): ${sel.found}`)
  assert(sel.none === null, 'findPraxisStamp returns null with no stamp')

  // --- Phase 3: a tap in SELECT mode becomes a pick (hit-test), not a tap-through.
  // The renderer receives the pick via simulator.onElementPicked. ---
  const sel3 = await app.evaluate(() => globalThis.__praxisStartTestBridge(true))
  await loadPreview(sel3.url)
  // Capture element-picked events in the renderer, then arm select mode.
  await win.evaluate(() => {
    window.__simPicks = []
    window.api.simulator.onElementPicked((p) => window.__simPicks.push(p))
  })
  await win.evaluate(() => window.api.simulator.setSelectMode(true))
  const selBody = await postCtl(sel3.url, { type: 'tap', x: 0.5, y: 0.5 })
  assert(selBody && selBody.selected === true, `select-mode tap → selected: ${JSON.stringify(selBody)}`)
  const picksMain = await app.evaluate(() => globalThis.__praxisTestPicks())
  assert(picksMain.length === 1 && picksMain[0].source === 'src/App.tsx:10:4', `pick recorded: ${JSON.stringify(picksMain)}`)
  const tapsInSelect = await app.evaluate(() => globalThis.__praxisTestControl())
  assert(tapsInSelect.length === 0, 'a select-mode tap must NOT be forwarded as a tap')
  // The renderer got the pick.
  await win.waitForFunction(() => (window.__simPicks?.length ?? 0) > 0, { timeout: 5000 })
  const rendererPick = await win.evaluate(() => window.__simPicks[0])
  assert(rendererPick.source === 'src/App.tsx:10:4', `renderer pick: ${JSON.stringify(rendererPick)}`)
  await win.evaluate(() => window.api.simulator.setSelectMode(false))

  console.log(
    'SIM-CONTROL OK — control transport, degrade, testID parse/search, select-mode pick → renderer'
  )
} catch (err) {
  console.error('SIM-CONTROL FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  await app?.close()
}
