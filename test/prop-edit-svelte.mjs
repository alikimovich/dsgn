/**
 * Svelte prop-editor test — the `.svelte` counterpart of prop-edit.mjs. Drives
 * the inspect/apply engine through real IPC (no dev server / auth):
 *
 *   inspect Card.svelte:7 → <Button> schema resolved cross-file from Button.svelte
 *   ($props() + interface Props → variant enum, label/count/rounded), merged with
 *   the live attribute values → apply variant=warn writes the .svelte source.
 *   Plus: host element (<h1>) attrs, and same-line innermost (<Badge> in a <p>).
 *
 * Run with: bun run test:props-svelte
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
const field = (insp, name) => insp.fields.find((f) => f.name === name)

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

  const inspect = (src) =>
    win.evaluate((a) => window.api.props.inspect(a.fixture, a.src), { fixture, src })

  // --- Component: cross-file schema from Button.svelte + live values. ---
  const btn = await inspect('src/Card.svelte:7')
  if (!btn) throw new Error('inspect <Button> returned null')
  if (btn.component !== 'Button') throw new Error(`component: ${btn.component}`)
  const variant = field(btn, 'variant')
  if (variant?.kind !== 'enum' || !variant.options?.includes('warn')) {
    throw new Error(`variant enum not resolved from Props: ${JSON.stringify(variant)}`)
  }
  if (variant.value !== 'ok') throw new Error(`variant live value: ${variant.value}`)
  if (field(btn, 'label')?.kind !== 'string') throw new Error('label not string')
  if (field(btn, 'count')?.value !== 3) throw new Error(`count not 3: ${field(btn, 'count')?.value}`)
  if (field(btn, 'rounded')?.value !== true) throw new Error('rounded not true')

  // --- Apply a literal edit to the .svelte source. ---
  const res = await win.evaluate(
    (a) =>
      window.api.props.apply(a.fixture, {
        source: 'src/Card.svelte:7',
        name: 'variant',
        kind: 'enum',
        value: 'warn'
      }),
    { fixture }
  )
  if (!res.applied) throw new Error(`apply not applied: ${JSON.stringify(res)}`)
  const after = readFileSync(card, 'utf8')
  if (!after.includes('variant="warn"')) throw new Error('source not edited to warn')
  if (after.includes('variant="ok"')) throw new Error('old value still present')

  // --- Host element: literal attributes, no component schema. ---
  const h1 = await inspect('src/Card.svelte:6')
  if (h1?.component !== 'h1') throw new Error(`host component: ${h1?.component}`)
  if (field(h1, 'class')?.value !== 'title') throw new Error('host class attr not read')

  // --- Same-line: <Badge> inside <p> resolves to the innermost element. ---
  const inline = await inspect('src/Card.svelte:8')
  if (inline?.component !== 'Badge') {
    throw new Error(`same-line resolved to "${inline?.component}", expected Badge`)
  }
  // With a column, the stamp disambiguates: col 2 is the <p>, not the inner <Badge>.
  const byCol = await inspect('src/Card.svelte:8:2')
  if (byCol?.component !== 'p') {
    throw new Error(`column-stamped resolved to "${byCol?.component}", expected p`)
  }

  // --- Direct token apply (T2) for .svelte: a tailwind color token swaps the
  // single color utility in a host element's class. (<span>, Card.svelte:13) ---
  const tok = await win.evaluate(
    (a) =>
      window.api.props.applyToken(a.fixture, {
        source: 'src/Card.svelte:13',
        token: { name: 'primary', value: 'oklch(0.5 0.2 270)' },
        group: 'colors',
        tokenSource: 'tailwind',
        classes: ['text-gray-500', 'font-bold']
      }),
    { fixture }
  )
  if (!tok.applied) throw new Error(`svelte token apply not applied: ${JSON.stringify(tok)}`)
  if (!readFileSync(card, 'utf8').includes('class="text-primary font-bold"')) {
    throw new Error('svelte token did not swap text-gray-500 → text-primary')
  }

  // Non-tailwind token source on the same element → agent (no class swap).
  const tokAgent = await win.evaluate(
    (a) =>
      window.api.props.applyToken(a.fixture, {
        source: 'src/Card.svelte:6',
        token: { name: 'primary', value: '#fff' },
        group: 'colors',
        tokenSource: 'manifest',
        classes: ['title']
      }),
    { fixture }
  )
  if (tokAgent.applied || !tokAgent.needsAgent) {
    throw new Error(`non-tailwind svelte token should need the agent: ${JSON.stringify(tokAgent)}`)
  }

  // --- v8 F2: reset-to-default removes an attribute from .svelte source, and it's
  // reversible via the F3b history. Remove `count={3}` from the <Button> usage. ---
  const beforeRm = readFileSync(card, 'utf8')
  if (!beforeRm.includes('count={3}')) throw new Error('precondition: Button should have count={3}')
  const svRm = await win.evaluate(
    (a) => window.api.props.remove(a.fixture, 'src/Card.svelte:7', 'count'),
    { fixture }
  )
  if (!svRm.applied) throw new Error(`svelte reset failed: ${JSON.stringify(svRm)}`)
  const afterRm = readFileSync(card, 'utf8')
  if (afterRm.includes('count={3}')) throw new Error('svelte reset did not remove count={3}')
  if (!/<Button variant="warn" label="Go" rounded=\{true\} \/>/.test(afterRm)) {
    throw new Error(`svelte reset left a malformed usage: ${afterRm.match(/<Button[^>]*\/>/)?.[0]}`)
  }
  const svUndo = await win.evaluate((a) => window.api.edits.undo(a.fixture), { fixture })
  if (!svUndo.ok || readFileSync(card, 'utf8') !== beforeRm) {
    throw new Error('undo did not restore the svelte reset-removed prop')
  }

  console.log(
    'PROP-EDIT-SVELTE OK — cross-file $props schema + literal edit + tailwind token swap + F2 reset/undo'
  )
} catch (err) {
  console.error('PROP-EDIT-SVELTE FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  writeFileSync(card, original)
  await app?.close()
}
