/**
 * Code drawer test (v9 phase 2) — the editable CodeMirror drawer under the
 * preview, through real IPC (no dev server, no auth needed):
 *
 *   source.write saves the whole file through commitEdit — refusing a stale
 *   baseline (conflict) and recording an undo step on success; edits.undo reverts
 *   it. The UI: the peek's "Edit" opens the drawer, CodeMirror mounts with the
 *   stamp span highlighted, the native preview reserves a bottom inset while it's
 *   open, and closing releases it.
 *
 * The fixture file is mutated then restored (write → undo) so the repo stays clean.
 *
 * Run with: bun run test:codedrawer
 */
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = join(root, 'test', 'fixtures', 'propedit-app')
const SRC = 'src/Badge.tsx:17'
const FILE = join(fixture, 'src', 'Badge.tsx')
const artifacts = join(root, 'test', 'artifacts')
mkdirSync(artifacts, { recursive: true })

const disk = () => readFileSync(FILE, 'utf8')

let app
const baseline = disk() // capture BEFORE anything runs, to restore on any exit
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

  // --- Engine: conflict guard — a stale baseline is refused, file untouched. ---
  const conflict = await win.evaluate(
    (a) => window.api.source.write(a.fixture, a.src, 'NOT THE REAL CONTENT', 'x'),
    { fixture, src: SRC }
  )
  if (conflict.ok || !conflict.conflict) throw new Error('stale baseline must conflict')
  if (disk() !== baseline) throw new Error('conflicting write must not touch the file')

  // --- Engine: a good save writes the whole file + records an undo step. ---
  const next = baseline + '\n// praxis-drawer-test\n'
  const saved = await win.evaluate(
    (a) => window.api.source.write(a.fixture, a.src, a.baseline, a.next),
    { fixture, src: SRC, baseline, next }
  )
  if (!saved.ok) throw new Error(`save failed: ${saved.error ?? saved.conflict}`)
  if (disk() !== next) throw new Error('save did not write the new content')

  // A second save with the now-STALE original baseline must conflict (disk moved).
  const stale = await win.evaluate(
    (a) => window.api.source.write(a.fixture, a.src, a.baseline, a.baseline),
    { fixture, src: SRC, baseline }
  )
  if (stale.ok || !stale.conflict) throw new Error('second save with old baseline must conflict')

  // --- Engine: undo reverts the drawer save (F3b history). ---
  const undo = await win.evaluate((a) => window.api.edits.undo(a.fixture), { fixture })
  if (!undo.ok) throw new Error(`undo failed: ${JSON.stringify(undo)}`)
  if (disk() !== baseline) throw new Error('undo did not restore the file')

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

  // CodeMirror mounts, the stamp span is highlighted, and the bottom inset is reserved.
  await win.waitForSelector('.codedrawer .cm-editor', { timeout: 5000 })
  await win.waitForFunction(() => document.querySelectorAll('.codedrawer .cm-stamp-line').length > 0, undefined, {
    timeout: 5000
  })
  const bottom = await win.evaluate(() => window.__praxisPanelInset.getState().bottom)
  if (!(bottom > 0)) throw new Error(`drawer did not reserve a bottom inset (got ${bottom})`)
  const drawerText = await win.$eval('.codedrawer .cm-content', (el) => el.textContent ?? '')
  if (!drawerText.includes('variant')) throw new Error('drawer did not load the file source')
  await win.screenshot({ path: join(artifacts, '13-code-drawer.png') })

  // --- Drag the top edge to resize; the reserved inset grows but is capped at
  // 80% of the window height. ---
  const beforeDrag = await win.evaluate(() => window.__praxisPanelInset.getState().bottom)
  const handle = await win.waitForSelector('.codedrawer__resize', { timeout: 5000 })
  const box = await handle.boundingBox()
  if (!box) throw new Error('resize handle has no bounding box')
  await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await win.mouse.down()
  await win.mouse.move(box.x + box.width / 2, 0, { steps: 8 }) // drag to the very top
  await win.mouse.up()
  const afterDrag = await win.evaluate(() => window.__praxisPanelInset.getState().bottom)
  const cap = await win.evaluate(() => window.innerHeight * 0.8)
  if (!(afterDrag > beforeDrag)) throw new Error(`drag did not grow the drawer (${beforeDrag} → ${afterDrag})`)
  if (afterDrag > cap + 1) throw new Error(`drawer exceeded the 80% cap (${afterDrag} > ${cap})`)

  // Close releases the inset.
  await win.$eval('.codedrawer__close', (el) => el.click())
  await win.waitForFunction(() => window.__praxisPanelInset.getState().bottom === 0, undefined, {
    timeout: 5000
  })
  if (await win.$('.codedrawer')) throw new Error('drawer did not unmount on close')

  // --- Media: a PNG previews instead of being decoded as utf8 (LKM-73). The
  // fixture is deliberately named .PNG — an uppercase extension must still hit
  // the media path. ---
  const shot = await win.evaluate((f) => window.api.source.read(f, 'src/Logo.PNG:1'), fixture)
  if (!shot?.media) throw new Error(`PNG did not read as media: ${JSON.stringify(shot)}`)
  if (shot.media.kind !== 'image' || shot.media.mediaType !== 'image/png') {
    throw new Error(`wrong media descriptor: ${JSON.stringify(shot.media)}`)
  }
  if (!shot.media.url.startsWith('praxis-media://')) throw new Error(`bad url: ${shot.media.url}`)
  if (shot.code !== '') throw new Error('media must not ship the file as text')
  if (!(shot.bytes > 0)) throw new Error(`media must report its size (got ${shot.bytes})`)
  // Saving one is refused outright — a utf8 round-trip would corrupt it.
  const wrote = await win.evaluate(
    (f) => window.api.source.write(f, 'src/Logo.PNG:1', '', 'nope'),
    fixture
  )
  if (wrote.ok) throw new Error('an image must not be writable as text')

  // The protocol itself: whole-file GET, a range request (what <video> seeking
  // needs), and an unknown token. Driven from MAIN — the renderer's CSP allows
  // praxis-media: for <img>/<video>, not for fetch().
  const served = await app.evaluate(async ({ net }, url) => {
    const whole = await net.fetch(url)
    const bytes = (await whole.arrayBuffer()).byteLength
    const part = await net.fetch(url, { headers: { Range: 'bytes=0-7' } })
    const sig = [...new Uint8Array(await part.arrayBuffer())]
    const missing = await net.fetch(url.replace(/[^/]+$/, 'deadbeef'))
    return {
      status: whole.status,
      type: whole.headers.get('content-type'),
      ranges: whole.headers.get('accept-ranges'),
      bytes,
      partStatus: part.status,
      contentRange: part.headers.get('content-range'),
      sig,
      missingStatus: missing.status
    }
  }, shot.media.url)
  if (served.status !== 200 || served.type !== 'image/png') {
    throw new Error(`media GET: ${JSON.stringify(served)}`)
  }
  if (served.bytes !== shot.bytes) {
    throw new Error(`media GET served ${served.bytes} of ${shot.bytes} bytes`)
  }
  if (served.ranges !== 'bytes') throw new Error('media response must advertise byte ranges')
  if (served.partStatus !== 206 || served.contentRange !== `bytes 0-7/${shot.bytes}`) {
    throw new Error(`range request: ${JSON.stringify(served)}`)
  }
  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (String(served.sig) !== String(PNG_SIG)) throw new Error(`range served ${served.sig}`)
  if (served.missingStatus !== 404) throw new Error('an unregistered token must 404')

  // …and in the UI it's a picture, with no editor and nothing to save.
  await win.evaluate(() => window.__praxisCodeDrawer.getState().open('src/Logo.PNG:1'))
  const img = await win.waitForSelector('.codedrawer__media img', { timeout: 5000 })
  await win.waitForFunction(
    () => {
      const el = document.querySelector('.codedrawer__media img')
      return !!el && el.naturalWidth > 0
    },
    undefined,
    { timeout: 5000 }
  )
  const natural = await img.evaluate((el) => [el.naturalWidth, el.naturalHeight])
  if (natural[0] !== 96 || natural[1] !== 96) throw new Error(`image did not decode: ${natural}`)
  if (await win.$('.codedrawer .cm-editor')) throw new Error('a preview must not mount CodeMirror')
  if (await win.$('.codedrawer__save')) throw new Error('a preview must not offer Save')
  const label = await win.$eval('.codedrawer__file', (el) => el.textContent ?? '')
  if (!label.includes('Logo.PNG') || label.includes(':1')) {
    throw new Error(`preview header should show the path alone: ${label}`)
  }
  await win.screenshot({ path: join(artifacts, '13c-media-preview.png') })
  await win.$eval('.codedrawer__close', (el) => el.click())
  await win.waitForFunction(() => !document.querySelector('.codedrawer'), undefined, { timeout: 5000 })

  // --- Pop out: the button opens a second BrowserWindow running the editor and
  // closes the docked drawer. ---
  await win.evaluate((src) => window.__praxisCodeDrawer.getState().open(src), SRC)
  await win.waitForSelector('.codedrawer__popout', { timeout: 5000 })
  const windowsBefore = app.windows().length
  await win.$eval('.codedrawer__popout', (el) => el.click())
  // The docked drawer unmounts and its inset is released…
  await win.waitForFunction(() => !document.querySelector('.codedrawer'), undefined, { timeout: 5000 })
  if (await win.evaluate(() => window.__praxisPanelInset.getState().bottom)) {
    throw new Error('pop-out did not release the drawer inset')
  }
  // …and a new window appears, running the full-window editor variant.
  const editorWin = await app.waitForEvent('window', { timeout: 5000 })
  await editorWin.waitForSelector('.codedrawer--window .cm-editor', { timeout: 8000 })
  if (await editorWin.$('.codedrawer__resize')) {
    throw new Error('window variant must not render the drag-resize handle')
  }
  if (app.windows().length <= windowsBefore) throw new Error('pop-out did not open a new window')
  await editorWin.screenshot({ path: join(artifacts, '13b-code-editor-window.png') })
  // The window variant has no in-editor close button (it closes via the native
  // traffic lights); closing the window tears the popped-out editor down.
  await editorWin.close()
  await editorWin.waitForEvent('close', { timeout: 5000 }).catch(() => {})

  if (disk() !== baseline) throw new Error('fixture left modified')
  // --- Cmd+click resolution engine + drawer nav history. ---
  const resolved = await win.evaluate(
    (f) => window.api.source.resolveComponent(f, 'src/Card.tsx', 'Button'),
    fixture
  )
  if (resolved !== 'src/Button.tsx') throw new Error(`resolveComponent: ${resolved}`)
  const bare = await win.evaluate(
    (f) => window.api.source.resolveComponent(f, 'src/Card.tsx', 'React'),
    fixture
  )
  if (bare !== null) throw new Error(`bare package import must not resolve: ${bare}`)
  const nav = await win.evaluate(() => {
    const d = () => window.__praxisCodeDrawer.getState()
    d().open('src/Card.tsx:3')
    d().open('src/Button.tsx:1')
    d().back()
    const afterBack = d().source
    d().forward()
    const afterFwd = d().source
    d().close()
    return { afterBack, afterFwd }
  })
  if (nav.afterBack !== 'src/Card.tsx:3' || nav.afterFwd !== 'src/Button.tsx:1') {
    throw new Error(`drawer nav history wrong: ${JSON.stringify(nav)}`)
  }

  console.log('CODE-DRAWER OK — conflict guard + save + undo, drawer mount/inset/close')
} catch (err) {
  console.error('CODE-DRAWER FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  // Belt-and-suspenders: restore the fixture even if an assertion left it dirty.
  try {
    const { writeFileSync } = await import('node:fs')
    if (disk() !== baseline) writeFileSync(FILE, baseline)
  } catch {
    /* ignore */
  }
  await app?.close()
}
