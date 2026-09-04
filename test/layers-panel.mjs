/**
 * Layers panel test — exercises the tree read, selection, and drag-to-reorder
 * engine end to end through real IPC on a real preview:
 *
 *   open the layers fixture as a project → toggle the Layers panel open →
 *   the tree renders rows matching the fixture's stamped elements (including
 *   the "mapped" rows sharing one stamp) → clicking a row selects that
 *   element (the normal `useSelection` pipeline) → a UI-DRIVEN drag (real
 *   PointerEvents dispatched at the row's own coordinates, driving the actual
 *   `LayersTree` pointer-gesture code) reorders two DISTINCT siblings and
 *   writes it into `src/Layers.tsx` → the same drag between two "mapped" rows
 *   (sharing one `data-praxis-source` stamp) reports `needsAgent` instead and
 *   seeds the composer, leaving the file untouched → `edits.undo` restores
 *   the direct move.
 *
 * Run with: bun run test:layers-panel
 */
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = join(root, 'test', 'fixtures', 'layers-app')
const layersFile = join(fixture, 'src', 'Layers.tsx')
const artifacts = join(root, 'test', 'artifacts')
mkdirSync(artifacts, { recursive: true })

const original = readFileSync(layersFile, 'utf8')

let app
try {
  app = await electron.launch({
    executablePath: electronPath,
    args: [join(root, 'out', 'main', 'index.js')],
    cwd: root
  })
  const win = await app.firstWindow()
  await win.waitForSelector('.empty__open', { timeout: 15000 })

  // --- Open the fixture as a REAL project (its static server serves the
  // stamped HTML — a live preview is what the tree read reads from). ---
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

  // --- Toggle the Layers panel open via its real toolbar button. Dispatched
  // via a DOM .click() (not Playwright's win.click, whose actionability
  // protocol hits a focus/stability quirk in some Electron/CI environments and
  // stalls for its full default timeout) — same click() the button's onClick
  // handler receives either way. ---
  await win.evaluate(() => {
    const btn = document.querySelector('button[aria-label="Layers"]')
    if (!(btn instanceof HTMLElement)) throw new Error('Layers toggle button not found')
    btn.click()
  })
  await win.waitForSelector('button[aria-label="Layers"][aria-pressed="true"]', { timeout: 5000 })

  // The tree read is an async IPC round trip through the preview — wait for
  // rows, not just the panel container.
  await win.waitForFunction(
    () => document.querySelectorAll('.layerstree__row').length >= 6,
    { timeout: 15000 }
  )
  await win.screenshot({ path: join(artifacts, 'layers-panel.png') })

  // --- The tree reflects the fixture's real structure. ---
  const labels = await win.evaluate(() =>
    [...document.querySelectorAll('.layerstree__row .layerstree__label')].map((e) => e.textContent)
  )
  for (const want of ['ul#static-list', 'li#li-alpha', 'li#li-beta', 'li#li-gamma', 'ul#mapped-list']) {
    if (!labels.includes(want)) {
      throw new Error(`Layers tree missing "${want}" row; got ${JSON.stringify(labels)}`)
    }
  }
  // The three "mapped" rows all render (DOM has 3 elements) even though they
  // share one source stamp — the tree reflects live DOM, not source templates.
  // Those rows also carry a compiler style-scope class (`s-p0FWuf5vgUnM`) in
  // the fixture; the label is "li.mapped", never "li.mapped.s-p0FWuf5vgUnM".
  const mappedCount = labels.filter((l) => l === 'li.mapped').length
  if (mappedCount !== 3) throw new Error(`expected 3 "li.mapped" rows, got ${mappedCount}`)
  if (labels.some((l) => l?.includes('s-p0FWuf5vgUnM'))) {
    throw new Error(`scope class leaked into a row label; got ${JSON.stringify(labels)}`)
  }

  // --- Clicking a row selects it — the normal useSelection pipeline. ---
  await win.evaluate((args) => {
    const rows = [...document.querySelectorAll('.layerstree__row')]
    const row = rows.find((r) => r.querySelector('.layerstree__label')?.textContent === args.label)
    row?.click()
  }, { label: 'li#li-beta' })
  await win.waitForFunction(
    () => window.__praxisSelection.getState().selected?.source === 'src/Layers.tsx:8:6',
    { timeout: 5000 }
  )

  // --- UI-driven drag: real PointerEvents at the rows' own coordinates,
  // through the REAL LayersTree pointer-gesture code (no direct engine call). ---
  const dragRow = async (fromLabel, fromNth, toLabel, toNth, positionFrac) => {
    const ok = await win.evaluate(
      (args) => {
        const rows = [...document.querySelectorAll('.layerstree__row')]
        const byLabel = (label, nth) =>
          rows.filter((r) => r.querySelector('.layerstree__label')?.textContent === label)[nth] ??
          null
        const fromEl = byLabel(args.fromLabel, args.fromNth)
        const toEl = byLabel(args.toLabel, args.toNth)
        if (!fromEl || !toEl) return false
        const fr = fromEl.getBoundingClientRect()
        const tr = toEl.getBoundingClientRect()
        fromEl.dispatchEvent(
          new PointerEvent('pointerdown', {
            bubbles: true,
            cancelable: true,
            button: 0,
            clientX: fr.left + 8,
            clientY: fr.top + fr.height / 2
          })
        )
        const midX = tr.left + 8
        const midY = tr.top + tr.height * args.frac
        window.dispatchEvent(
          new PointerEvent('pointermove', { bubbles: true, clientX: midX, clientY: midY })
        )
        window.dispatchEvent(
          new PointerEvent('pointerup', { bubbles: true, clientX: midX, clientY: midY })
        )
        return true
      },
      { fromLabel, fromNth, toLabel, toNth, frac: positionFrac }
    )
    if (!ok) throw new Error(`drag rows not found: ${fromLabel}[${fromNth}] → ${toLabel}[${toNth}]`)
  }

  // --- Direct-move case: drag Gamma to just BEFORE Alpha (frac ~0.1 = top
  // third of the row = "before"). Both are distinct JSX literals in
  // src/Layers.tsx, so this must land as a real file write. ---
  await dragRow('li#li-gamma', 0, 'li#li-alpha', 0, 0.1)
  let afterMove = ''
  for (let i = 0; i < 40; i++) {
    afterMove = readFileSync(layersFile, 'utf8')
    if (afterMove !== original) break
    await new Promise((r) => setTimeout(r, 150))
  }
  const expected = original.replace(
    '      <li>Alpha</li>\n      <li>Beta</li>\n      <li>Gamma</li>',
    '      <li>Gamma</li>\n      <li>Alpha</li>\n      <li>Beta</li>'
  )
  if (afterMove !== expected) {
    throw new Error(
      `direct move did not reorder as expected.\n--- got ---\n${afterMove}\n--- expected ---\n${expected}`
    )
  }

  // --- The "mapped" rows share ONE source stamp (both render from the single
  // <li> literal inside .map()) — the panel's own `dupStamp` pre-flight hint
  // must disable dragging on them BEFORE any IPC round trip: attempting the
  // same pointer gesture used above must be a complete no-op (no file write,
  // no dragging-state class), because `beginDrag` bails out early on a
  // dupStamp row without ever calling `onDrop`. ---
  const beforeMappedDrag = readFileSync(layersFile, 'utf8')
  await dragRow('li.mapped', 0, 'li.mapped', 1, 0.9)
  await new Promise((r) => setTimeout(r, 500)) // let any (unexpected) async path settle
  if (readFileSync(layersFile, 'utf8') !== beforeMappedDrag) {
    throw new Error('dragging a dupStamp ("mapped") row must never write the file')
  }
  const draggingClassAppeared = await win.evaluate(
    () => !!document.querySelector('.layerstree__row.opacity-40')
  )
  if (draggingClassAppeared) {
    throw new Error('a dupStamp row should never enter the dragging state at all')
  }

  // --- The engine's OWN same-stamp gate (independent of the UI's pre-flight
  // hint above — main never trusts the renderer for correctness, only for
  // UX): drive `window.api.layers.move` directly and confirm `needsAgent`
  // with a prompt naming the shared-template cause, and that it never writes. ---
  const engineRes = await win.evaluate(
    (args) =>
      window.api.layers.move(args.fixture, {
        dragged: { source: 'src/Layers.tsx:18:8' },
        target: { source: 'src/Layers.tsx:18:8' },
        position: 'before',
        sessionId: 'test-session-1'
      }),
    { fixture }
  )
  if (engineRes.applied || !engineRes.needsAgent || !/same place in the code/i.test(engineRes.agentPrompt ?? '')) {
    throw new Error(`expected a "same place in the code" needsAgent result, got ${JSON.stringify(engineRes)}`)
  }
  if (readFileSync(layersFile, 'utf8') !== beforeMappedDrag) {
    throw new Error('a same-stamp move must never write the file, even called directly')
  }

  // --- Undo restores the direct move exactly — via the REAL user path. A
  // physical Cmd+Z lands as the Edit menu's accelerator → `menu:action 'undo'`
  // from main (native menu accelerators intercept the key before any renderer
  // keydown, so sending the action IS what the keystroke produces). The drag
  // focused the row (not a text field), so the renderer must route this to
  // the source-edit stack, not a field's native undo. ---
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.send('menu:action', 'undo')
  )
  let afterUndo = ''
  for (let i = 0; i < 40; i++) {
    afterUndo = readFileSync(layersFile, 'utf8')
    if (afterUndo === original) break
    await new Promise((r) => setTimeout(r, 150))
  }
  if (afterUndo !== original) {
    throw new Error('menu-driven undo did not restore the original fixture source')
  }

  // --- The other routing branch: with a TEXT FIELD focused, the same menu
  // action must go to the field's native undo, NOT the source-edit stack —
  // otherwise Cmd+Z while typing would silently revert file edits. Redo the
  // move, focus the composer, send the action, and assert the file stays
  // moved; then blur and undo for real to restore. ---
  await dragRow('li#li-gamma', 0, 'li#li-alpha', 0, 0.1)
  let movedAgain = ''
  for (let i = 0; i < 40; i++) {
    movedAgain = readFileSync(layersFile, 'utf8')
    if (movedAgain !== original) break
    await new Promise((r) => setTimeout(r, 150))
  }
  if (movedAgain === original) throw new Error('second drag did not apply')
  await win.evaluate(() => document.querySelector('.composer__input').focus())
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.send('menu:action', 'undo')
  )
  await new Promise((r) => setTimeout(r, 800)) // let any (wrong) revert land
  if (readFileSync(layersFile, 'utf8') !== movedAgain) {
    throw new Error('menu undo with a focused text field must NOT touch source files')
  }
  await win.evaluate(() => document.querySelector('.composer__input').blur())
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.send('menu:action', 'undo')
  )
  for (let i = 0; i < 40; i++) {
    if (readFileSync(layersFile, 'utf8') === original) break
    await new Promise((r) => setTimeout(r, 150))
  }
  if (readFileSync(layersFile, 'utf8') !== original) {
    throw new Error('post-blur menu undo did not restore the original source')
  }

  console.log(
    'LAYERS-PANEL OK — tree matches the fixture (incl. 3 same-stamp "mapped" rows), ' +
      'row click selects, UI-driven drag reorders distinct siblings in src/Layers.tsx, ' +
      'a same-stamp drag is inert client-side + needsAgent from the engine, ' +
      'and Edit-menu undo (the real Cmd+Z path) restores the move'
  )
} catch (err) {
  console.error('LAYERS-PANEL FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  writeFileSync(layersFile, original) // leave the fixture pristine
  await app?.close()
}
