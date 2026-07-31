/**
 * style-provenance test — REAL browser, not reasoning about DOM/CSSOM behavior
 * from afar. `src/preview/style-provenance.ts` is what proves a property's
 * value comes from a design token instead of merely equalling one
 * (`getComputedStyle` always resolves `var()` away, so it can never tell the
 * two apart); this exercises it against a genuine `document.styleSheets` +
 * `element.matches` + inline-style stack, via headless Chromium (Playwright).
 *
 * Bundled with esbuild to a plain browser global (no Electron/ipcRenderer
 * import chain to fight) and loaded into a real page via `addScriptTag`.
 *
 * LIVE tier, not unit: `_electron`-driven tests need only the Electron binary
 * (already a devDependency), but `chromium.launch()` needs Playwright's own
 * downloaded browser (`npx playwright install chromium`) — a real environment
 * dependency CI does not provision. SKIPs (exit 0) when that binary is
 * missing, same convention as agent-e2e/sim-e2e for missing creds/display.
 *
 * Run with: bun run test:style-provenance
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundleDir = mkdtempSync(join(tmpdir(), 'style-provenance-'))
const bundlePath = join(bundleDir, 'bundle.js')

execFileSync(
  process.execPath,
  [
    join(root, 'node_modules', 'esbuild', 'bin', 'esbuild'),
    join(root, 'src', 'preview', 'style-provenance.ts'),
    '--bundle',
    '--format=iife',
    '--global-name=StyleProvenance',
    `--outfile=${bundlePath}`,
    '--log-level=error'
  ],
  { cwd: root }
)

const HTML = `<!doctype html>
<style>
  .card { color: var(--color-title); }
  @media (min-width: 1px) {
    .boxed { padding: var(--space-md); }
  }
</style>
<div id="literal" style="color: #212121">literal</div>
<div id="inline-var" style="color: var(--color-title)">inline var</div>
<div id="rule-var" class="card">from a stylesheet rule</div>
<div id="media-var" class="boxed">from inside @media</div>
<div id="fallback" style="color: var(--missing, #fff)">var() with a fallback</div>
<div id="unmatched-prop" class="card" style="margin-top: 4px">a var() on a DIFFERENT prop</div>
`

let failed = 0
const ok = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    failed++
  }
}
const eq = (actual, expected, msg) =>
  ok(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  )

let browser
try {
  browser = await chromium.launch({ headless: true })
} catch {
  console.log('STYLE-PROVENANCE SKIP — no Playwright browser installed (run `npx playwright install chromium`)')
  rmSync(bundleDir, { recursive: true, force: true })
  process.exit(0)
}
try {
  const page = await browser.newPage()
  await page.setContent(HTML)
  await page.addScriptTag({ path: bundlePath })

  const declared = await page.evaluate(() => {
    const of = (id, props) => {
      const el = document.getElementById(id)
      return window.StyleProvenance.declaredVarsFor(el, props)
    }
    return {
      literal: of('literal', ['color']),
      inlineVar: of('inline-var', ['color']),
      ruleVar: of('rule-var', ['color']),
      mediaVar: of('media-var', ['padding']),
      fallback: of('fallback', ['color']),
      unmatchedProp: of('unmatched-prop', ['color', 'margin-top'])
    }
  })

  eq(declared.literal, { color: null }, 'a literal value proves nothing')
  eq(declared.inlineVar, { color: '--color-title' }, 'inline var() is proof, exact name')
  eq(declared.ruleVar, { color: '--color-title' }, 'a matched stylesheet rule counts as proof too')
  eq(
    declared.mediaVar,
    { padding: '--space-md' },
    'a declaration inside @media still counts — we do not evaluate the condition'
  )
  eq(
    declared.fallback,
    { color: '--missing' },
    'the OUTERMOST var name wins over its fallback'
  )
  eq(
    declared.unmatchedProp,
    { color: '--color-title', 'margin-top': null },
    'the rule proves color, not an unrelated inline margin-top on the same element'
  )

  // Precedence: inline overrides a same-property matched rule.
  const overridden = await page.evaluate(() => {
    const el = document.getElementById('rule-var')
    el.style.setProperty('color', 'var(--color-override)')
    return window.StyleProvenance.declaredVarsFor(el, ['color'])
  })
  eq(overridden, { color: '--color-override' }, 'inline wins over a matched rule for the same prop')

  eq(
    await page.evaluate(() => window.StyleProvenance.varRefName('var(--x)')),
    '--x',
    'varRefName: plain reference'
  )
  eq(
    await page.evaluate(() => window.StyleProvenance.varRefName('var(--x, 16px)')),
    '--x',
    'varRefName: ignores the fallback'
  )
  eq(
    await page.evaluate(() => window.StyleProvenance.varRefName('16px')),
    null,
    'varRefName: a literal is not a reference'
  )

  // --- @import: the nested sheet hangs off CSSImportRule.styleSheet, NOT
  // .cssRules, so a naive grouping-rule walk skips it entirely. Needs a real
  // same-origin URL (about:blank can't resolve @import, and a cross-origin
  // import's cssRules throws) — fake the origin with route interception.
  const imp = await browser.newPage()
  await imp.route('http://praxis-prov.test/**', (route) => {
    const url = route.request().url()
    if (url.endsWith('imported.css')) {
      return route.fulfill({
        contentType: 'text/css',
        body: '.imp { color: var(--color-imported); }'
      })
    }
    return route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><style>@import url('imported.css');</style><div id="imp" class="imp">imported</div>`
    })
  })
  await imp.goto('http://praxis-prov.test/page.html')
  await imp.addScriptTag({ path: bundlePath })
  // The imported sheet loads async — wait until its rules are actually reachable.
  await imp.waitForFunction(() => {
    try {
      return [...document.styleSheets].some((s) =>
        [...s.cssRules].some((r) => r.styleSheet && r.styleSheet.cssRules.length > 0)
      )
    } catch {
      return false
    }
  })
  eq(
    await imp.evaluate(() =>
      window.StyleProvenance.declaredVarsFor(document.getElementById('imp'), ['color'])
    ),
    { color: '--color-imported' },
    'a rule inside an @import-ed sheet counts as proof'
  )
  await imp.close()
} finally {
  await browser.close()
  rmSync(bundleDir, { recursive: true, force: true })
}

if (failed === 0) {
  console.log('STYLE-PROVENANCE OK — real DOM/CSSOM proof extraction, via headless Chromium')
} else {
  console.error(`STYLE-PROVENANCE: ${failed} assertion(s) failed`)
}
process.exitCode = failed === 0 ? 0 : 1
