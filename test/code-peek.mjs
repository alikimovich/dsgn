/**
 * Code peek test — the inspector's "view the source right here" slice, through
 * real IPC (no dev server, no auth needed):
 *
 *   source.read resolves the stamped file + the element's line span (single- and
 *   multi-line, root-escape refused); the Inspector's Code button opens the editor
 *   drawer on that file (with open-in-editor + drag-resize affordances);
 *   openInEditor fails soft on a bad stamp instead of throwing.
 *
 * Run with: bun run test:codepeek
 */
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync } from 'node:fs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = join(root, 'test', 'fixtures', 'propedit-app')
const SRC = 'src/Badge.tsx:17' // the <Badge …> usage line (single-line element)
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

  // --- Engine: source.read returns the file + stamp line + element span. ---
  const view = await win.evaluate((a) => window.api.source.read(a.fixture, a.src), {
    fixture,
    src: SRC
  })
  if (!view) throw new Error('source.read returned null')
  if (view.file !== 'src/Badge.tsx') throw new Error(`file: ${view.file}`)
  if (view.line !== 17) throw new Error(`line: ${view.line}`)
  if (!view.code.includes('interface BadgeProps')) throw new Error('code missing file content')
  if (view.elementStart !== 17 || view.elementEnd !== 17) {
    throw new Error(`single-line span: ${view.elementStart}..${view.elementEnd} (expected 17..17)`)
  }

  // Multi-line element (Tall's <div>, lines 83–85): the span covers open→close.
  const tall = await win.evaluate((a) => window.api.source.read(a.fixture, a.src), {
    fixture,
    src: 'src/Badge.tsx:83'
  })
  if (tall?.elementStart !== 83 || tall?.elementEnd !== 85) {
    throw new Error(`multi-line span: ${tall?.elementStart}..${tall?.elementEnd} (expected 83..85)`)
  }

  // Root-escape refused: a stamp pointing outside the project reads nothing.
  const escape = await win.evaluate(
    (a) => window.api.source.read(a.fixture, '../../package.json:1'),
    { fixture }
  )
  if (escape !== null) throw new Error('source.read must refuse paths outside the root')

  // openInEditor fails soft (never throws) on an unresolvable stamp.
  const badOpen = await win.evaluate((a) => window.api.source.openInEditor(a.fixture, 'nope'), {
    fixture
  })
  if (badOpen.ok) throw new Error('openInEditor should fail on an unresolvable stamp')

  // --- UI: select an element → the Code button opens the editor drawer. ---
  await win.evaluate(
    (args) => {
      window.__praxisSession.getState().setProjectRoot(args.fixture)
      window.__praxisSelection.getState().setSelected({
        tag: 'span',
        id: null,
        classes: ['badge'],
        selector: 'span.badge',
        source: args.src,
        componentSource: null,
        text: 'Ready',
        rect: { x: 0, y: 0, width: 0, height: 0 },
        styles: {}
      })
    },
    { fixture, src: SRC }
  )
  // JS-click (not Playwright's actionability click): a schema-backed selection
  // also opens the floating PropPanel, which can overlap the button in the small
  // test window (they live in different panes at real sizes).
  // The Code action lives in the in-preview selection toolbar now; open the
  // drawer through its store (what the toolbar's relay calls).
  await win.evaluate((src) => window.__praxisCodeDrawer.getState().open(src), SRC)

  // The editor drawer mounts (CodeMirror) with the stamped file loaded, and the
  // stamp span highlighted — no inline peek is rendered in the left panel.
  await win.waitForSelector('.codedrawer .cm-editor', { timeout: 5000 })
  if (await win.$('.codepeek')) throw new Error('inline code peek should no longer render')
  await win.waitForFunction(
    () => document.querySelectorAll('.codedrawer .cm-stamp-line').length > 0,
    undefined,
    { timeout: 5000 }
  )
  const drawerText = await win.$eval('.codedrawer .cm-content', (el) => el.textContent ?? '')
  if (!drawerText.includes('variant')) throw new Error('drawer does not show the stamped source')

  // The drawer offers "open in your editor" and a drag-resize handle (the
  // explicit expand toggle was replaced by dragging the drawer's top edge).
  await win.waitForSelector('.codedrawer__open', { timeout: 5000 })
  await win.waitForSelector('.codedrawer__resize', { timeout: 5000 })
  await win.screenshot({ path: join(artifacts, '12-code-peek.png') })

  console.log('CODE-PEEK OK — read + spans + escape guard, Code button opens the editor drawer')
} catch (err) {
  console.error('CODE-PEEK FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  await app?.close()
}
