/**
 * Prop editor test — exercises the inspect/apply engine end to end through real
 * IPC (no dev server, no auth needed), plus the editor UI:
 *
 *   inspect Badge.tsx:17 → react-docgen schema (variant enum, label, count,
 *   rounded) merged with the live attribute values → apply variant=warn writes
 *   the source file → assert the file changed. Then drive the renderer's prop
 *   editor and confirm the typed rows render.
 *
 * Run with: bun run test:props
 */
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = join(root, 'test', 'fixtures', 'propedit-app')
const badge = join(fixture, 'src', 'Badge.tsx')
const SRC = 'src/Badge.tsx:17' // the <Badge …> usage line
const artifacts = join(root, 'test', 'artifacts')
mkdirSync(artifacts, { recursive: true })

const original = readFileSync(badge, 'utf8')
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

  // The props panel lives in the floating ISLAND (its own webContents,
  // ?praxisPanel=1) — query its DOM there.
  const panelEval = (code) =>
    app.evaluate(async ({ webContents }, c) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL().includes('praxisPanel'))
      if (!wc) return '__no_panel__'
      try { return await wc.executeJavaScript(c) } catch { return '__no_panel__' }
    }, code)
  const waitPanel = async (code, timeout = 10000) => {
    const end = Date.now() + timeout
    for (;;) {
      const r = await panelEval(code)
      if (r !== '__no_panel__' && r) return r
      if (Date.now() > end) throw new Error('island condition timed out: ' + code.slice(0, 100))
      await new Promise((res) => setTimeout(res, 250))
    }
  }
  // Tests assume the expanded card ON THE PROPS TAB. Both are persisted in the
  // shared userData that direct `bun run test:*` runs use, so a previous run
  // (or the style-edit suite / real-app use) may have collapsed the card or
  // left the Styles tab active — and Radix unmounts inactive tab content, so a
  // stale 'styles' tab would make every props-content wait time out. Retried:
  // the island's webContents appears asynchronously, so a one-shot eval could
  // run before it (or its React tree) exists.
  const expandPanel = async () => {
    const end = Date.now() + 10000
    for (;;) {
      const ok = await panelEval(`(() => {
        localStorage.setItem('praxis.proppanel.collapsed', '0')
        localStorage.setItem('praxis.island.tab', 'props')
        document.querySelector('.proppanel__expand')?.click()
        // If the island is already mounted on Styles, click Props (Radix
        // TabsTrigger activates on mousedown — a bare .click() is not enough).
        const t = [...document.querySelectorAll('.proppanel__tab')].find((b) => b.textContent.trim() === 'Props')
        if (t && t.getAttribute('data-state') !== 'active') {
          for (const type of ['mousedown', 'mouseup', 'click']) {
            t.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }))
          }
        }
        return !!t && t.getAttribute('data-state') === 'active'
      })()`)
      if (ok === true) return
      // Give up quietly — the caller's next waitPanel surfaces the real failure.
      if (Date.now() > end) return
      await new Promise((r) => setTimeout(r, 250))
    }
  }

  // --- UI: render the prop editor for a selected element (original file). ---
  await win.evaluate(
    (args) => {
      window.__praxisSession.getState().setProjectRoot(args.fixture)
      window.__praxisSelection.getState().setSelected({
        tag: 'span',
        id: null,
        classes: ['badge'],
        selector: 'span.badge',
        source: args.src,
        text: 'Ready',
        rect: { x: 0, y: 0, width: 0, height: 0 },
        styles: {}
      })
    },
    { fixture, src: SRC }
  )
  // The island opens EXPLICITLY (toolbar props action) — simulate that.
  await win.evaluate(() => window.__praxisPropsIsland.getState().setOpen(true))
  await expandPanel()
  await waitPanel("!!document.querySelector('.proppanel__row')")
  const enumOptions = await panelEval(
    "[...document.querySelectorAll('.proppanel__row select option')].map((o) => o.value).filter(Boolean)"
  )
  for (const v of ['ok', 'warn', 'error']) {
    if (!enumOptions.includes(v)) {
      throw new Error(`variant enum missing "${v}"; got ${JSON.stringify(enumOptions)}`)
    }
  }
  await win.screenshot({ path: join(artifacts, '10-prop-editor.png') })

  // --- Engine: inspect resolves the react-docgen schema + live values. ---
  const inspection = await win.evaluate(
    (args) => window.api.props.inspect(args.fixture, args.src),
    { fixture, src: SRC }
  )
  if (!inspection) throw new Error('inspect returned null')
  if (inspection.component !== 'Badge') throw new Error(`component: ${inspection.component}`)
  const variant = field(inspection, 'variant')
  if (variant?.kind !== 'enum') throw new Error(`variant kind: ${variant?.kind}`)
  if (variant.value !== 'ok') throw new Error(`variant value: ${variant.value}`)
  if (field(inspection, 'label')?.kind !== 'string') throw new Error('label not string')
  if (field(inspection, 'count')?.value !== 3) throw new Error('count not 3')
  if (field(inspection, 'rounded')?.value !== true) throw new Error('rounded not true')

  // --- Engine: apply a literal edit and confirm the source file changed. ---
  const res = await win.evaluate(
    (args) =>
      window.api.props.apply(args.fixture, {
        source: args.src,
        name: 'variant',
        kind: 'enum',
        value: 'warn'
      }),
    { fixture, src: SRC }
  )
  if (!res.applied) throw new Error(`apply not applied: ${JSON.stringify(res)}`)
  const after = readFileSync(badge, 'utf8')
  if (!after.includes('variant="warn"')) throw new Error('source file was not edited to warn')
  if (after.includes('variant="ok"')) throw new Error('old value still present')

  // Same-line disambiguation: <Badge> inline in a <p> must resolve to Badge
  // (the innermost element on the line), not the parent <p>.
  const inline = await win.evaluate((args) => window.api.props.inspect(args.fixture, args.src), {
    fixture,
    src: 'src/Badge.tsx:21'
  })
  if (inline?.component !== 'Badge') {
    throw new Error(`same-line element resolved to "${inline?.component}", expected Badge`)
  }

  // Cross-file: <Button> used in Card.tsx but defined in Button.tsx — the schema
  // is resolved by following the import.
  const cross = await win.evaluate((args) => window.api.props.inspect(args.fixture, args.src), {
    fixture,
    src: 'src/Card.tsx:4'
  })
  if (cross?.component !== 'Button') throw new Error(`cross-file component: ${cross?.component}`)
  const kind = field(cross, 'kind')
  if (kind?.kind !== 'enum' || !kind.options?.includes('ghost')) {
    throw new Error('cross-file enum schema (kind) not resolved from Button.tsx')
  }
  if (field(cross, 'label')?.value !== 'Go') throw new Error('cross-file live value (label) wrong')

  // Cross-file via a tsconfig PATH ALIAS: <Button> imported as `@/Button` (the
  // shadcn/Vite convention). Resolution must follow the alias to Button.tsx —
  // without it, no imported component in an aliased project surfaces props.
  const aliased = await win.evaluate((args) => window.api.props.inspect(args.fixture, args.src), {
    fixture,
    src: 'src/AliasCard.tsx:6'
  })
  if (aliased?.component !== 'Button') {
    throw new Error(`alias cross-file component: ${aliased?.component} (expected Button)`)
  }
  const aliasedKind = field(aliased, 'kind')
  if (aliasedKind?.kind !== 'enum' || !aliasedKind.options?.includes('ghost')) {
    throw new Error('alias cross-file enum schema (kind) not resolved from Button.tsx via @/ alias')
  }

  // --- Broadened literals: TS-cast (`as const`) + no-substitution template
  // literal read as plain literals, not `expression:true`. (Badge.tsx:31) ---
  const B2 = 'src/Badge.tsx:31'
  const lit = await win.evaluate((a) => window.api.props.inspect(a.fixture, a.b2), { fixture, b2: B2 })
  if (field(lit, 'variant')?.value !== 'ok' || field(lit, 'variant')?.expression) {
    throw new Error(`TS-cast literal not read as enum 'ok': ${JSON.stringify(field(lit, 'variant'))}`)
  }
  if (field(lit, 'label')?.value !== 'Go' || field(lit, 'label')?.expression) {
    throw new Error(`template literal not read as string 'Go': ${JSON.stringify(field(lit, 'label'))}`)
  }
  const litApply = await win.evaluate(
    (a) => window.api.props.apply(a.fixture, { source: a.b2, name: 'label', kind: 'string', value: 'Hey' }),
    { fixture, b2: B2 }
  )
  if (!litApply.applied) throw new Error(`broadened-literal apply failed: ${JSON.stringify(litApply)}`)
  if (!readFileSync(badge, 'utf8').includes('label="Hey"')) {
    throw new Error('template-literal label was not spliced to label="Hey"')
  }

  // --- Token direct apply (T1): a color token whose name is a valid `variant`
  // enum option splices variant="warn" — no agent. (Badge.tsx:31) ---
  const t1 = await win.evaluate(
    (a) =>
      window.api.props.applyToken(a.fixture, {
        source: a.b2,
        token: { name: 'warn', value: '#f59e0b' },
        group: 'colors',
        tokenSource: 'manifest',
        classes: ['badge']
      }),
    { fixture, b2: B2 }
  )
  if (!t1.applied) throw new Error(`token T1 (schema enum) not applied: ${JSON.stringify(t1)}`)
  if (!readFileSync(badge, 'utf8').includes('variant="warn"')) {
    throw new Error('token T1 did not splice variant="warn"')
  }

  // --- Token direct apply (T3): a color token onto a single literal inline-style
  // color property swaps the value directly. (Swatch, Badge.tsx:37) ---
  const t3 = await win.evaluate(
    (a) =>
      window.api.props.applyToken(a.fixture, {
        source: 'src/Badge.tsx:37',
        token: { name: 'brand', value: '#f59e0b' },
        group: 'colors',
        tokenSource: 'manifest',
        classes: ['sw']
      }),
    { fixture }
  )
  if (!t3.applied) throw new Error(`token T3 (inline style) not applied: ${JSON.stringify(t3)}`)
  if (!readFileSync(badge, 'utf8').includes('#f59e0b')) {
    throw new Error('token T3 did not swap the inline-style color value')
  }

  // --- Agent fallback (rare path): a token onto a host element with no schema
  // match and no inline style → needsAgent. (h1, Badge.tsx:25) ---
  const fb = await win.evaluate(
    (a) =>
      window.api.props.applyToken(a.fixture, {
        source: 'src/Badge.tsx:25',
        token: { name: 'brand', value: '#f59e0b' },
        group: 'colors',
        tokenSource: 'manifest',
        classes: ['title']
      }),
    { fixture }
  )
  if (fb.applied || !fb.needsAgent) throw new Error(`ambiguous token should need the agent: ${JSON.stringify(fb)}`)

  // --- Cross-family guard: a colors token must NOT swap a non-color style
  // property (fontWeight). Property-name gating → agent, not a wrong splice.
  // (Weighted, Badge.tsx:43) ---
  const xfam = await win.evaluate(
    (a) =>
      window.api.props.applyToken(a.fixture, {
        source: 'src/Badge.tsx:43',
        token: { name: 'brand', value: '#f59e0b' },
        group: 'colors',
        tokenSource: 'manifest',
        classes: ['wt']
      }),
    { fixture }
  )
  if (xfam.applied || !xfam.needsAgent) {
    throw new Error(`colors token must not swap fontWeight: ${JSON.stringify(xfam)}`)
  }
  if (readFileSync(badge, 'utf8').includes("fontWeight: '#f59e0b'")) {
    throw new Error('colors token wrongly written into fontWeight')
  }

  // --- Token direct apply (T2): a tailwind color token swaps the single color
  // utility in a literal className. (TwColor, Badge.tsx:48) ---
  const t2 = await win.evaluate(
    (a) =>
      window.api.props.applyToken(a.fixture, {
        source: 'src/Badge.tsx:48',
        token: { name: 'primary', value: 'oklch(0.5 0.2 270)' },
        group: 'colors',
        tokenSource: 'tailwind',
        classes: ['text-gray-500', 'font-bold']
      }),
    { fixture }
  )
  if (!t2.applied) throw new Error(`token T2 (tailwind class) not applied: ${JSON.stringify(t2)}`)
  if (!readFileSync(badge, 'utf8').includes('text-primary font-bold')) {
    throw new Error('token T2 did not swap text-gray-500 → text-primary')
  }

  // --- T2 guard: two color utilities is ambiguous → agent, no silent swap.
  // (TwTwo, Badge.tsx:53) ---
  const t2amb = await win.evaluate(
    (a) =>
      window.api.props.applyToken(a.fixture, {
        source: 'src/Badge.tsx:53',
        token: { name: 'primary', value: 'oklch(0.5 0.2 270)' },
        group: 'colors',
        tokenSource: 'tailwind',
        classes: ['text-gray-500', 'bg-blue-100']
      }),
    { fixture }
  )
  if (t2amb.applied || !t2amb.needsAgent) {
    throw new Error(`two color utilities should be ambiguous → agent: ${JSON.stringify(t2amb)}`)
  }

  // --- T2 radius family: a radius token swaps the single rounded-* utility, and
  // leaves the spacing utility (p-4) alone. (TwRadius, Badge.tsx:58) ---
  const t2r = await win.evaluate(
    (a) =>
      window.api.props.applyToken(a.fixture, {
        source: 'src/Badge.tsx:58',
        token: { name: 'card', value: '0.5rem' },
        group: 'radius',
        tokenSource: 'tailwind',
        classes: ['rounded-lg', 'p-4']
      }),
    { fixture }
  )
  if (!t2r.applied) throw new Error(`radius-family class swap not applied: ${JSON.stringify(t2r)}`)
  const radTxt = readFileSync(badge, 'utf8')
  if (!radTxt.includes('rounded-card p-4')) {
    throw new Error('radius token did not swap rounded-lg → rounded-card (or touched p-4)')
  }

  // --- v8 F2: schema DEFAULTS surface in inspection, and reset-to-default removes
  // the attribute from source (reversible). Chip has destructuring defaults that
  // ChipDemo overrides (Badge.tsx:76). ---
  const CHIP = 'src/Badge.tsx:76'
  const chipInsp = await win.evaluate((a) => window.api.props.inspect(a.fixture, a.chip), {
    fixture,
    chip: CHIP
  })
  if (chipInsp?.component !== 'Chip') throw new Error(`Chip inspect: ${JSON.stringify(chipInsp)}`)
  const tone = field(chipInsp, 'tone')
  if (tone?.default !== 'brand') throw new Error(`tone default should be 'brand': ${JSON.stringify(tone)}`)
  if (tone?.value !== 'neutral') throw new Error(`tone live value should be 'neutral': ${JSON.stringify(tone)}`)
  const dot = field(chipInsp, 'dot')
  if (dot?.default !== false) throw new Error(`dot default should be false: ${JSON.stringify(dot)}`)

  // reset (remove) tone → attribute gone, value falls back to the 'brand' default.
  const beforeReset = readFileSync(badge, 'utf8')
  const rm = await win.evaluate((a) => window.api.props.remove(a.fixture, a.chip, 'tone'), {
    fixture,
    chip: CHIP
  })
  if (!rm.applied) throw new Error(`reset tone failed: ${JSON.stringify(rm)}`)
  const afterReset = readFileSync(badge, 'utf8')
  if (afterReset.includes('tone="neutral"')) throw new Error('reset did not remove tone="neutral"')
  if (!afterReset.includes('<Chip text="Hi" dot />')) {
    throw new Error(`reset left a malformed usage: ${afterReset.match(/<Chip[^>]*\/>/)?.[0]}`)
  }

  // reset is reversible via the F3b history — one undo restores the removed attribute.
  const undoReset = await win.evaluate((a) => window.api.edits.undo(a.fixture), { fixture })
  if (!undoReset.ok || readFileSync(badge, 'utf8') !== beforeReset) {
    throw new Error('undo did not restore the reset-removed prop')
  }

  // removing an already-absent prop is a no-op success (not an error).
  const noop = await win.evaluate((a) => window.api.props.remove(a.fixture, a.chip, 'nope'), {
    fixture,
    chip: CHIP
  })
  if (!noop.applied) throw new Error(`removing an absent prop should be a no-op: ${JSON.stringify(noop)}`)

  // --- v8 F3b: undo/redo round-trip through real IPC. A direct prop apply is
  // reversible — undo restores the exact prior source; redo re-applies; and a
  // divergent on-disk edit makes undo report a conflict instead of clobbering. ---
  const beforeApply = readFileSync(badge, 'utf8')
  const u1 = await win.evaluate(
    (a) =>
      window.api.props.apply(a.fixture, { source: a.src, name: 'variant', kind: 'enum', value: 'error' }),
    { fixture, src: SRC }
  )
  if (!u1.applied) throw new Error(`F3b apply failed: ${JSON.stringify(u1)}`)
  const afterApply = readFileSync(badge, 'utf8')
  if (afterApply === beforeApply) throw new Error('F3b apply did not change the file')
  const canAfter = await win.evaluate((a) => window.api.edits.can(a.fixture), { fixture })
  if (!canAfter.undo) throw new Error(`edits.can should report undo available: ${JSON.stringify(canAfter)}`)

  const undid = await win.evaluate((a) => window.api.edits.undo(a.fixture), { fixture })
  if (!undid.ok) throw new Error(`undo not ok: ${JSON.stringify(undid)}`)
  if (readFileSync(badge, 'utf8') !== beforeApply) throw new Error('undo did not restore the prior source')

  const redid = await win.evaluate((a) => window.api.edits.redo(a.fixture), { fixture })
  if (!redid.ok) throw new Error(`redo not ok: ${JSON.stringify(redid)}`)
  if (readFileSync(badge, 'utf8') !== afterApply) throw new Error('redo did not re-apply the edit')

  // Conflict: the user edits the file in their own editor, then hits undo. praxis
  // must refuse to clobber that and report a conflict (the file is left intact).
  writeFileSync(badge, afterApply + '\n// edited elsewhere\n')
  const conflict = await win.evaluate((a) => window.api.edits.undo(a.fixture), { fixture })
  if (conflict.ok || !conflict.conflict) throw new Error(`undo should conflict: ${JSON.stringify(conflict)}`)
  if (!readFileSync(badge, 'utf8').includes('// edited elsewhere')) {
    throw new Error('conflicting undo clobbered the user edit')
  }

  console.log(
    'PROP-EDIT OK — schema, broadened literals, direct token apply (T1/T2/T3), agent fallback, ' +
      'F2 defaults + reset-to-default, F3b undo/redo'
  )
} catch (err) {
  console.error('PROP-EDIT FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  writeFileSync(badge, original) // leave the fixture pristine
  await app?.close()
}
