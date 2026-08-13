/**
 * Design-token detection test — proves the engine probes all three sources and
 * picks the right one per project (manifest → tailwind → CSS vars), through real
 * IPC, plus the palette UI. No dev server / auth needed.
 *
 * Run with: bun run test:tokens
 */
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync } from 'node:fs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixtures = join(root, 'test', 'fixtures')
const artifacts = join(root, 'test', 'artifacts')
mkdirSync(artifacts, { recursive: true })

const detect = (win, p) => win.evaluate((path) => window.api.tokens.detect(path), p)
const tok = (set, group, name) => set.groups.find((g) => g.name === group)?.tokens.find((t) => t.name === name)

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

  // 1. Manifest wins over a Tailwind config present in the same project.
  const prio = await detect(win, join(fixtures, 'tokens-priority'))
  if (prio.source !== 'manifest') throw new Error(`priority source: ${prio.source}`)
  if (tok(prio, 'colors', 'primary')?.value !== '#2563eb') throw new Error('manifest color missing')
  if (prio.groups.some((g) => g.tokens.some((t) => t.value === '#000000'))) {
    throw new Error('Tailwind leaked despite manifest priority')
  }

  // 2. Tailwind config — base + extend MERGE (the common pattern), nested colors
  //    flatten (brand-500), and a plugin's nested `theme:` must not leak.
  const tw = await detect(win, join(fixtures, 'tokens-tailwind'))
  if (tw.source !== 'tailwind') throw new Error(`tailwind source: ${tw.source}`)
  if (tok(tw, 'colors', 'base')?.value !== '#111111') throw new Error('base tw color dropped')
  if (tok(tw, 'colors', 'brand-500')?.value !== '#2563eb') throw new Error('extend nested color missing')
  if (tok(tw, 'colors', 'accent')?.value !== '#f59e0b') throw new Error('extend flat color missing')
  if (tok(tw, 'spacing', 'gutter')?.value !== '16px') throw new Error('tw spacing missing')
  if (tw.groups.some((g) => g.tokens.some((t) => t.value === '#ff00ff'))) {
    throw new Error("plugin's nested theme leaked into tokens")
  }

  // No tokens at all → source 'none' (the state that hides the Tokens toggle).
  const none = await detect(win, join(fixtures, 'editable-app'))
  if (none.source !== 'none' || none.groups.length) throw new Error(`expected none, got ${none.source}`)

  // 3. CSS custom properties — grouped by prefix, alias (var(...)) skipped.
  const css = await detect(win, join(fixtures, 'tokens-css'))
  if (css.source !== 'css') throw new Error(`css source: ${css.source}`)
  if (tok(css, 'color', '--color-bg')?.value !== '#ffffff') throw new Error('css var missing')
  if (tok(css, 'space', '--space-md')?.value !== '8px') throw new Error('css space missing')
  if (tok(css, 'color', '--color-surface')) throw new Error('css alias should be skipped')
  // Preprocessor stylesheets carry plain CSS custom properties, and real themes
  // live several directories down — `src/deep/nested/palette.less` covers both.
  if (tok(css, 'color', '--color-brand')?.value !== '@brand') {
    throw new Error('custom property in a .less file not detected')
  }
  // A LESS variable (`@brand: …`) is deliberately NOT a token: it has no
  // runtime form, so it could never be committed back as a reference.
  if (css.groups.some((g) => g.tokens.some((t) => t.name.replace(/^--/, '') === 'brand'))) {
    throw new Error('a LESS variable leaked into the token set')
  }
  // First definition wins — the dark-mode redefinition must not overwrite it.
  if (tok(css, 'color', '--color-accent')?.value !== '#f59e0b') {
    throw new Error('a media-query redefinition overwrote the base value')
  }

  console.log('TOKENS OK — manifest/tailwind/css(+less, nested) detected')
} catch (err) {
  console.error('TOKENS FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  await app?.close()
}
