/**
 * v3 handoff test — drives the annotation flow through real IPC and UI:
 *
 *   seed a selected element + project root → "Note" in the inspector → save →
 *   the note persists to <root>/.praxis/annotations.json AND shows in the notes
 *   panel → remove clears both. No dev server / auth needed.
 *
 * Run with: bun run test:annotations
 */
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = join(root, 'test', 'artifacts')
mkdirSync(artifacts, { recursive: true })
const projectRoot = mkdtempSync(join(tmpdir(), 'praxis-annot-'))
const sidecar = join(projectRoot, '.praxis', 'annotations.json')
const NOTE = 'Tighten the hero spacing before ship'

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

  // Seed a running project + a selected element (no source → only the Note path).
  await win.evaluate(
    (args) => {
      window.__praxisSession.getState().setProjectRoot(args.root)
      window.__praxisSelection.getState().setSelected({
        tag: 'div',
        id: 'hero',
        classes: ['hero'],
        selector: '#hero',
        source: null,
        text: 'Welcome',
        rect: { x: 0, y: 0, width: 0, height: 0 },
        styles: {}
      })
    },
    { root: projectRoot }
  )

  // Add a note through the annotations engine (the UI path — the in-preview
  // annotate composer — is covered end-to-end by test/comment-mode.mjs).
  await win.evaluate(
    async (args) => {
      const list = await window.api.annotations.add(args.root, {
        source: null,
        selector: '#hero',
        tag: 'div',
        text: args.note
      })
      window.__praxisAnnotations.getState().setList(list)
    },
    { root: projectRoot, note: NOTE }
  )

  // It shows in the notes panel...
  await win.waitForSelector('.notes__item', { timeout: 5000 })
  const text = (await win.textContent('.notes__text'))?.trim()
  if (text !== NOTE) throw new Error(`note text in panel: "${text}"`)
  await win.screenshot({ path: join(artifacts, '11-annotations.png') })

  // ...and persisted to the sidecar.
  if (!existsSync(sidecar)) throw new Error('.praxis/annotations.json was not written')
  const saved = JSON.parse(readFileSync(sidecar, 'utf8'))
  if (!Array.isArray(saved) || saved.length !== 1) throw new Error('sidecar should hold 1 note')
  if (saved[0].text !== NOTE || saved[0].selector !== '#hero') {
    throw new Error(`sidecar note wrong: ${JSON.stringify(saved[0])}`)
  }

  // Remove clears both the panel and the sidecar.
  await win.click('.notes__remove')
  await win.waitForFunction(() => !document.querySelector('.notes__item'), { timeout: 5000 })
  const after = JSON.parse(readFileSync(sidecar, 'utf8'))
  if (after.length !== 0) throw new Error('sidecar should be empty after remove')

  console.log('ANNOTATIONS OK — note saved to .praxis sidecar, shown, and removed')
} catch (err) {
  console.error('ANNOTATIONS FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  rmSync(projectRoot, { recursive: true, force: true })
  await app?.close()
}
