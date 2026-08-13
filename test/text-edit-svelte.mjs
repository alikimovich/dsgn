/**
 * Svelte inline text-edit test — the `.svelte` counterpart of text-edit.mjs,
 * through real IPC (no dev server/auth):
 *  - text.apply rewrites a plain-text element's content in .svelte source.
 *  - a mixed text+element child (<p>Label <Badge/></p>) falls back to the agent.
 *
 * Run with: bun run test:text-svelte
 */
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = join(root, 'test', 'fixtures', 'svelte-app')
const card = join(fixture, 'src', 'Card.svelte')
const original = readFileSync(card, 'utf8')

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

  // Plain-text <h1 class="title">Original</h1> at Card.svelte:6 → rewritten in source.
  const res = await win.evaluate(
    (args) => window.api.text.apply(args.fixture, { source: 'src/Card.svelte:6', text: 'Renamed' }),
    { fixture }
  )
  if (!res.applied) throw new Error(`svelte text apply not applied: ${JSON.stringify(res)}`)
  const after = readFileSync(card, 'utf8')
  if (!after.includes('>Renamed<')) throw new Error('svelte source text was not rewritten')
  if (after.includes('>Original<')) throw new Error('old svelte text still present')

  // Mixed child <p class="row">Label <Badge/></p> at :8:2 → can't splice, agent.
  const mixed = await win.evaluate(
    (args) => window.api.text.apply(args.fixture, { source: 'src/Card.svelte:8:2', text: 'nope' }),
    { fixture }
  )
  if (mixed.applied || !mixed.needsAgent) {
    throw new Error(`mixed svelte content should need the agent: ${JSON.stringify(mixed)}`)
  }

  // Splice-unsafe new text (contains '<') on a pure-text element → agent, never
  // a raw write that could open a tag.
  const unsafe = await win.evaluate(
    (args) => window.api.text.apply(args.fixture, { source: 'src/Card.svelte:6', text: 'a<b' }),
    { fixture }
  )
  if (unsafe.applied || !unsafe.needsAgent) {
    throw new Error(`splice-unsafe text should need the agent: ${JSON.stringify(unsafe)}`)
  }

  // Whitespace preservation: <h2>  spaced  </h2> at :11 → lead/trail kept.
  const ws = await win.evaluate(
    (args) => window.api.text.apply(args.fixture, { source: 'src/Card.svelte:11', text: 'tight' }),
    { fixture }
  )
  if (!ws.applied) throw new Error(`whitespace case not applied: ${JSON.stringify(ws)}`)
  const final = readFileSync(card, 'utf8')
  if (!final.includes('>  tight  <')) throw new Error('surrounding whitespace was not preserved')

  console.log(
    'TEXT-EDIT-SVELTE OK — plain text rewritten, mixed/unsafe → agent, whitespace preserved'
  )
} catch (err) {
  console.error('TEXT-EDIT-SVELTE FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  writeFileSync(card, original) // leave the fixture pristine
  await app?.close()
}
