/**
 * Readiness gating + setup test:
 *  - setup.scaffold writes the dev-only source-stamping plugin (idempotent).
 *  - A component with no resolvable schema is NOT editable — no prop panel, the
 *    chip shows the prompt-only hint + a "set up the project" link.
 *  - The on-open setup dialogue renders with a "Set it up" action.
 *
 * Run with: bun run test:gating
 */
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixtures = join(root, 'test', 'fixtures')
const artifacts = join(root, 'test', 'artifacts')
mkdirSync(artifacts, { recursive: true })
const scaffoldDir = mkdtempSync(join(tmpdir(), 'praxis-setup-'))
// Setup is framework-first now: give it a React package.json so detect() branches
// to the Babel-plugin strategy (full per-framework coverage is in setup-detect.mjs).
writeFileSync(
  join(scaffoldDir, 'package.json'),
  JSON.stringify({ name: 'gating-fixture', dependencies: { react: '^18.2.0' } })
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
  await win.evaluate(() => window.__praxisWorkspace.getState().openOrActivate('/tmp/praxis-test-project'))
  await win.waitForSelector('.composer__input', { timeout: 15000 })

  // The props panel lives in the floating ISLAND (its own webContents,
  // ?praxisPanel=1) — query its DOM there.
  const panelEval = (code) =>
    app.evaluate(async ({ webContents }, c) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL().includes('praxisPanel'))
      if (!wc) return '__no_panel__'
      try { return await wc.executeJavaScript(c) } catch { return '__no_panel__' }
    }, code)
  const waitPanel = async (code, timeout = 10000) => {
    const end = Date.now() + timeout
    for (;;) {
      const r = await panelEval(code)
      if (r !== '__no_panel__' && r) return r
      if (Date.now() > end) throw new Error('island condition timed out: ' + code.slice(0, 100))
      await new Promise((res) => setTimeout(res, 250))
    }
  }
  // Tests assume the expanded card ON THE PROPS TAB. Both are persisted in the
  // shared userData that direct `bun run test:*` runs use, so a previous run
  // (or the style-edit suite / real-app use) may have collapsed the card or
  // left the Styles tab active — and Radix unmounts inactive tab content, so a
  // stale 'styles' tab would make every props-content wait time out. Retried:
  // the island's webContents appears asynchronously, so a one-shot eval could
  // run before it (or its React tree) exists.
  const expandPanel = async () => {
    const end = Date.now() + 10000
    for (;;) {
      const ok = await panelEval(`(() => {
        localStorage.setItem('praxis.proppanel.collapsed', '0')
        localStorage.setItem('praxis.island.tab', 'props')
        document.querySelector('.proppanel__expand')?.click()
        // If the island is already mounted on Styles, click Props (Radix
        // TabsTrigger activates on mousedown — a bare .click() is not enough).
        const t = [...document.querySelectorAll('.proppanel__tab')].find((b) => b.textContent.trim() === 'Props')
        if (t && t.getAttribute('data-state') !== 'active') {
          for (const type of ['mousedown', 'mouseup', 'click']) {
            t.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }))
          }
        }
        return !!t && t.getAttribute('data-state') === 'active'
      })()`)
      if (ok === true) return
      // Give up quietly — the caller's next waitPanel surfaces the real failure.
      if (Date.now() > end) return
      await new Promise((r) => setTimeout(r, 250))
    }
  }

  // --- setup.scaffold writes the stamping plugin (and is idempotent). ---
  const first = await win.evaluate((d) => window.api.setup.scaffold(d), scaffoldDir)
  if (!first.ok || !first.written) throw new Error(`scaffold: ${JSON.stringify(first)}`)
  if (first.framework !== 'react') throw new Error(`expected react detect: ${JSON.stringify(first)}`)
  const pluginPath = join(scaffoldDir, '.praxis', 'praxis-source.cjs')
  if (!existsSync(pluginPath)) throw new Error('plugin file not written')
  if (!readFileSync(pluginPath, 'utf8').includes('data-praxis-source')) {
    throw new Error('plugin missing the stamping logic')
  }
  const second = await win.evaluate((d) => window.api.setup.scaffold(d), scaffoldDir)
  if (second.written) throw new Error('scaffold should not overwrite an existing plugin')

  // --- Gating: a STAMPED host <span> (no component schema) is prompt-only, no
  // panel — and, since it already has a source stamp, it must NOT nag to "set up
  // the project" (the project is clearly set up). It's prompt-only → ask praxis. ---
  await win.evaluate(
    (args) => {
      window.__praxisSession.getState().setProjectRoot(args.fixture)
      window.__praxisSelection.getState().setSelected({
        tag: 'span',
        id: null,
        classes: ['badge'],
        selector: 'span.badge',
        source: 'src/Badge.tsx:13', // the <span> inside Badge — host element, no props schema
        componentSource: null, // not inside a stamped component instance
        text: 'x',
        rect: { x: 0, y: 0, width: 0, height: 0 },
        styles: {}
      })
    },
    { fixture: join(fixtures, 'propedit-app') }
  )
  // The island opens on demand (toolbar props action) and then follows
  // selection changes; a no-schema element shows the prompt-only readiness
  // message inside it (no editable fields).
  await win.evaluate(() => window.__praxisPropsIsland.getState().setOpen(true))
  await expandPanel()
  await waitPanel("!!document.querySelector('.proppanel .proppanel__ready--no')")
  if (await panelEval("document.querySelectorAll('.proppanel__row').length")) {
    throw new Error('a no-schema element should not render editable prop rows')
  }
  const stampedHint = (await panelEval("document.querySelector('.proppanel__ready--no')?.textContent ?? ''")) ?? ''
  if (!/ask Praxis/i.test(stampedHint)) {
    throw new Error(`stamped host element should be prompt-only (ask Praxis): ${stampedHint}`)
  }
  if (await panelEval("document.querySelectorAll('.proppanel__link').length")) {
    throw new Error('a stamped element must NOT show the "set up the project" link')
  }
  await win.screenshot({ path: join(artifacts, '13-gating.png') })

  // --- A genuinely UNSTAMPED element (source: null) is what warrants the setup
  // link — that's the only "not set up for prop editing" case. ---
  await win.evaluate(() => {
    window.__praxisSelection.getState().setSelected({
      tag: 'div',
      id: null,
      classes: [],
      selector: 'div',
      source: null, // no data-praxis-source stamp → project isn't set up
      componentSource: null,
      text: null,
      rect: { x: 0, y: 0, width: 0, height: 0 },
      styles: {}
    })
  })
  await win.evaluate(() => window.__praxisPropsIsland.getState().setOpen(true))
  await waitPanel("!!document.querySelector('.proppanel__link')")

  // Positive case: a schema-backed <Badge> usage DOES open the floating panel
  // (keeps the gate honest in both directions).
  await win.evaluate(
    (args) => {
      window.__praxisSelection.getState().setSelected({
        tag: 'span',
        id: null,
        classes: ['badge'],
        selector: 'span.badge',
        source: 'src/Badge.tsx:17', // the <Badge …/> usage — a typed component
        text: 'Ready',
        rect: { x: 0, y: 0, width: 0, height: 0 },
        styles: {}
      })
    },
    { fixture: join(fixtures, 'propedit-app') }
  )
  await win.evaluate(() => window.__praxisPropsIsland.getState().setOpen(true))
  await waitPanel("!!document.querySelector('.proppanel__row')")

  // --- The on-open setup dialogue renders with the action. ---
  await win.evaluate(() => window.__praxisSetup.getState().setNeeded(true))
  await win.waitForSelector('.setup', { timeout: 5000 })
  const yes = (await win.textContent('.setup__yes'))?.trim()
  if (yes !== 'Set it up') throw new Error(`setup action label: ${yes}`)

  console.log('READY-GATING OK — scaffold writes plugin, no-schema is prompt-only, offer shows')
} catch (err) {
  console.error('READY-GATING FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  rmSync(scaffoldDir, { recursive: true, force: true })
  await app?.close()
}
