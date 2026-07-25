/**
 * Integration test for vanilla-JS inline text editing (Tier 2), through the real
 * `text:apply` IPC. Proves the preview→source write-back for a plain HTML file:
 * a stamped text leaf splices its new text into the file; an element with child
 * elements falls back to the agent (needsAgent) instead of corrupting the markup.
 *
 * Run with: bun run test:html-text-edit
 */
import electronPath from 'electron'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg)
}

const repoRoot = process.cwd()
const work = mkdtempSync(join(tmpdir(), 'praxis-htmledit-'))
// <h1> is on line 2 col 1; the <p> wraps a <strong>, so it's mixed content.
writeFileSync(
  join(work, 'index.html'),
  `<!doctype html><html><body>
<h1>Hello</h1>
<p>Some <strong>bold</strong> text</p>
</body></html>`
)

let app
try {
  app = await electron.launch({
    executablePath: electronPath,
    args: [join(repoRoot, 'out', 'main', 'index.js')],
    cwd: repoRoot,
    env: { ...process.env, PRAXIS_USER_DATA: mkdtempSync(join(tmpdir(), 'praxis-ud-')) }
  })
  const win = await app.firstWindow()

  // 1) Plain-text leaf → direct splice into the HTML file.
  const ok = await win.evaluate(
    (root) => window.api.text.apply(root, { source: 'index.html:2:1', text: 'Goodbye' }),
    work
  )
  assert(ok?.applied === true, `h1 edit should apply: ${JSON.stringify(ok)}`)
  const after = readFileSync(join(work, 'index.html'), 'utf8')
  assert(/<h1>Goodbye<\/h1>/.test(after), `h1 text should be rewritten: ${after}`)

  // 2) Mixed content (<p> with a <strong> child) → agent fallback, file untouched.
  const mixed = await win.evaluate(
    (root) => window.api.text.apply(root, { source: 'index.html:3:1', text: 'nope' }),
    work
  )
  assert(
    mixed?.needsAgent === true,
    `mixed content should fall back to agent: ${JSON.stringify(mixed)}`
  )
  const after2 = readFileSync(join(work, 'index.html'), 'utf8')
  assert(/<p>Some <strong>bold<\/strong> text<\/p>/.test(after2), 'mixed <p> left untouched')

  console.log('HTML-TEXT-EDIT OK — direct HTML text splice + agent fallback')
} catch (err) {
  console.error('HTML-TEXT-EDIT FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  await app?.close()
}
