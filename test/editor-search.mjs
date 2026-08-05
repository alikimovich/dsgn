/**
 * Zed-style editor search panel (editor-search.ts) — drives the code drawer's
 * CodeMirror through real keys: ⌘F opens OUR top-mounted panel (not CM's stock
 * bottom bar), typing live-updates the match count + highlights, Enter steps
 * the selection through matches, the replace row toggles, Esc closes.
 *
 * Run with: bun run test:editor-search
 */
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync } from 'node:fs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = join(root, 'test', 'fixtures', 'propedit-app')
const SRC = 'src/Badge.tsx:17'
const artifacts = join(root, 'test', 'artifacts')
mkdirSync(artifacts, { recursive: true })

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
  await win.evaluate((f) => window.__praxisSession.getState().setProjectRoot(f), fixture)
  await win.evaluate((src) => window.__praxisCodeDrawer.getState().open(src), SRC)
  await win.waitForSelector('.codedrawer .cm-editor', { timeout: 5000 })

  // ⌘F on the focused editor → our panel, top-mounted, search box focused.
  await win.click('.codedrawer .cm-content')
  await win.keyboard.press('Meta+f')
  await win.waitForSelector('.cm-zed-search', { timeout: 3000 })
  const shape = await win.evaluate(() => ({
    top: !!document.querySelector('.cm-panels-top .cm-zed-search'),
    stock: !!document.querySelector('.cm-search'), // CM's default panel must be gone
    focused: document.activeElement?.classList.contains('cm-zed-search__input') ?? false,
    replaceOpen: !!document.querySelector('.cm-zed-search__replace.is-open')
  }))
  if (!shape.top) throw new Error('panel is not top-mounted')
  if (shape.stock) throw new Error("CM's stock search panel rendered — createPanel not applied")
  if (!shape.focused) throw new Error('search input not focused on open')
  if (shape.replaceOpen) throw new Error('replace row should start closed')

  // Type a query with matches in Badge.tsx → live count + highlights.
  await win.keyboard.type('variant')
  await win.waitForFunction(
    () => {
      const c = document.querySelector('.cm-zed-search__count')?.textContent ?? ''
      return /\/[1-9]/.test(c) // total > 0
    },
    undefined,
    { timeout: 3000 }
  )
  const counted = await win.evaluate(() => ({
    count: document.querySelector('.cm-zed-search__count')?.textContent,
    highlights: document.querySelectorAll('.codedrawer .cm-searchMatch').length
  }))
  if (!(counted.highlights > 0)) throw new Error('no .cm-searchMatch highlights for the query')

  // Enter selects the next match after the cursor — current goes 0 → some n ≥ 1.
  await win.keyboard.press('Enter')
  const stepped = await win.evaluate(
    () => document.querySelector('.cm-zed-search__count')?.textContent ?? ''
  )
  if (!/^[1-9]\d*\//.test(stepped)) throw new Error(`Enter did not step to a match (count "${stepped}")`)
  await win.screenshot({ path: join(artifacts, '17-editor-search.png') })

  // Replace row toggles open; Esc closes the whole panel.
  await win.click('[title="Toggle replace"]')
  const replaceOpen = await win.evaluate(() => !!document.querySelector('.cm-zed-search__replace.is-open'))
  if (!replaceOpen) throw new Error('replace row did not open')
  await win.screenshot({ path: join(artifacts, '18-editor-search-replace.png') })
  await win.keyboard.press('Escape')
  const closed = await win.evaluate(() => !document.querySelector('.cm-zed-search'))
  if (!closed) throw new Error('Esc did not close the panel')

  console.log(`EDITOR-SEARCH OK — count ${stepped}, ${counted.highlights} highlights, replace + Esc fine`)
} catch (err) {
  console.error('EDITOR-SEARCH FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  await app?.close()
}
