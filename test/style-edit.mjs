/**
 * v10 Styles-tab test — exercises the island's Styles tab + the styles engine
 * end to end through real IPC on a real preview (no auth needed):
 *
 *   open the propedit fixture as a project (its static server serves stamped
 *   HTML) → click-select the Tailwind element → the island's Styles tab renders
 *   its three ordinary groups and keeps inactive transition defaults hidden →
 *   `styles.apply` padding-top 13px commits an S1
 *   class rewrite (`pt-[13px]` lands in src/Styled.tsx) → `styles.preview`
 *   injects a live override the preview's computed style reflects (and
 *   clearPreview reverts exactly) → a UI-DRIVEN commit: Enter on the
 *   border-radius track opens ScrubInput's exact-value editor, typing 13 +
 *   Enter runs the real ScrubInput → StylePanel.commit → styles.apply wiring
 *   (`rounded-[13px]` lands) → select the inline-styled element → a two-apply
 *   same-prop BURST merges `paddingTop` into its `style={{…}}` literal (S2)
 *   and coalesces in edit-history → a BARE element (no class, no style attr)
 *   refuses instead: S2 only ever EXTENDS an existing inline style, so this
 *   falls to S3 with the file untouched and a prompt that forbids the agent
 *   from adding the prop either → ONE `edits.undo` restores the pre-burst
 *   file → island screenshots.
 *
 * Design tokens: select the element whose color happens to EQUAL
 * `--color-text`'s value but never references it → the Styles tab's header
 * names the token source, but the color row shows the raw hex, NOT a chip —
 * value coincidence alone is no longer proof (2026-07-31: this test used to
 * assert the opposite; that was the hallucination). Re-select an element
 * whose inline style IS literally `var(--color-text)` → NOW the chip names it
 * (the specified-declaration read through the sandboxed preload proving real
 * usage, not the resolved computed value). The inline picker still offers
 * ONLY the color tokens (the value-shape gate, through real UI) → clicking
 * `--color-title` still writes `var(--color-title)` — the REFERENCE, not
 * `#212121` — and one undo restores it.
 *
 * v10 phase 4 — transitions: give the live fixture a real positive-duration
 * transition, then re-select the Tailwind element →
 * `transition-duration: 150ms` snaps to the named time scale (`duration-150`)
 * → a non-keyword curve lands as an arbitrary `ease-[cubic-bezier(…)]` class
 * with NO spaces → expand the timing row's chevron in the island UI (the
 * BezierEditor renders inline; screenshot) → an ArrowUp nudge on a handle
 * commits through the REAL BezierEditor → TimingRow → commit path, and the
 * curve (0.25, 0.11, 0.25, 1) is within snap tolerance of the `ease` keyword,
 * so the keyword (Tailwind: `ease-[ease]`) replaces the arbitrary class →
 * the remaining undo chain unwinds every entry back to the pristine file.
 *
 * Run with: bun run test:style-edit
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'
import { _electron as electron } from 'playwright'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = join(root, 'test', 'fixtures', 'propedit-app')
const styled = join(fixture, 'src', 'Styled.tsx')
const TW_SRC = 'src/Styled.tsx:5' // <div className="p-4 rounded-md"> in TwCard
const INLINE_SRC = 'src/Styled.tsx:9' // <div style={{ padding: '8px' }}> in InlineCard
const TOKEN_SRC = 'src/Styled.tsx:21' // <div style={{ color: '#6c6c6c' }}> in TokenCard — coincidence, unproven
const BARE_SRC = 'src/Styled.tsx:46' // <div> in BareCard — no class, no style attr
const PROVEN_TOKEN_SRC = 'src/Styled.tsx:54' // <div style={{ color: 'var(--color-text)' }}> in ProvenTokenCard
const artifacts = join(root, 'test', 'artifacts')
mkdirSync(artifacts, { recursive: true })

const original = readFileSync(styled, 'utf8')

let app
try {
  app = await electron.launch({
    executablePath: electronPath,
    args: [join(root, 'out', 'main', 'index.js')],
    cwd: root
  })
  const win = await app.firstWindow()
  await win.waitForSelector('.empty__open', { timeout: 15000 })

  // The Styles tab lives in the floating ISLAND (its own webContents,
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
  // Tests assume the expanded card (a previous run may have collapsed it).
  const expandPanel = () =>
    panelEval("localStorage.setItem('praxis.proppanel.collapsed','0'); document.querySelector('.proppanel__expand')?.click(); true")
  // Open the island on the Styles tab and wait for its groups. Re-asserts
  // setOpen + the tab click each poll: a straggler click from pickElement's
  // retry loop (input delivery lags when the window is unfocused) can arrive
  // AFTER the first setOpen and close the island again (a fresh pick resets it).
  //
  // The `source` argument is what makes that poll honest. Closing the island
  // only unmounts PanelHost in the main renderer — the island's own
  // webContents lives on with the PREVIOUS selection's card still in its DOM.
  // So "the Styles groups are rendered" is satisfied by a stale, closed island,
  // and every later panelEval would then drive the element we selected BEFORE
  // this one (writing its edits into that source file). Requiring the island's
  // own header to name the current selection is the only proof it is live.
  const openStylesTab = async (source) => {
    const end = Date.now() + 20000
    for (;;) {
      await win.evaluate(() => window.__praxisPropsIsland.getState().setOpen(true))
      await expandPanel()
      // Radix TabsTrigger activates on mousedown (a bare .click() only fires click).
      const ok = await panelEval(`(() => {
        if (document.querySelector('.proppanel__source')?.textContent?.trim() !== ${JSON.stringify(source)}) return false
        const t = [...document.querySelectorAll('.proppanel__tab')].find((b) => b.textContent.trim() === 'Styles')
        if (t) {
          for (const type of ['mousedown', 'mouseup', 'click']) {
            t.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }))
          }
        }
        return document.querySelectorAll('.stylepanel__grouptitle').length >= 3
      })()`)
      if (ok === true) return
      if (Date.now() > end) throw new Error(`the Styles tab never rendered its groups for ${source}`)
      await new Promise((r) => setTimeout(r, 300))
    }
  }

  // Run `code` inside the PREVIEW WebContentsView (a separate CDP target —
  // reachable only via the main process).
  const previewEval = (code) =>
    app.evaluate(async ({ webContents }, c) => {
      const wc = webContents
        .getAllWebContents()
        .find((w) => /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+/.test(w.getURL()))
      if (!wc) return '__no_preview__'
      try { return await wc.executeJavaScript(c, true) } catch { return '__no_preview__' }
    }, code)

  // Click-select a stamped element in the preview via TRUSTED input events (the
  // preload rejects synthetic DOM events), retrying until the inspector shows it.
  const pickElement = async (domId, source) => {
    const getCenter = `(() => {
      const el = document.querySelector(${JSON.stringify('#' + domId)})
      if (!el) return null
      const b = el.getBoundingClientRect()
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }
    })()`
    for (let i = 0; i < 40; i++) {
      const result = await app.evaluate(async ({ webContents }, code) => {
        const wc = webContents
          .getAllWebContents()
          .find((w) => /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+/.test(w.getURL()))
        if (!wc) return 'no-preview'
        const c = await wc.executeJavaScript(code, true)
        if (!c) return 'no-element'
        wc.focus()
        wc.sendInputEvent({ type: 'mouseMove', x: c.x, y: c.y })
        wc.sendInputEvent({ type: 'mouseDown', x: c.x, y: c.y, button: 'left', clickCount: 1 })
        wc.sendInputEvent({ type: 'mouseUp', x: c.x, y: c.y, button: 'left', clickCount: 1 })
        return 'clicked'
      }, getCenter)
      if (result === 'clicked') {
        const ok = await win
          .waitForFunction(
            (src) => document.querySelector('.inspector__source')?.textContent?.includes(src),
            source,
            { timeout: 1000 }
          )
          .then(() => true)
          .catch(() => false)
        if (ok) return
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    throw new Error(`inspector never showed ${source} after clicking #${domId}`)
  }

  // Save the island's own pixels (it's a WebContentsView — absent from
  // renderer-page screenshots).
  const shotIsland = async (name) => {
    const b64 = await app.evaluate(async ({ webContents }) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL().includes('praxisPanel'))
      if (!wc) return null
      const img = await wc.capturePage()
      return img.toPNG().toString('base64')
    })
    if (!b64) throw new Error(`island screenshot failed for ${name}`)
    writeFileSync(join(artifacts, name), Buffer.from(b64, 'base64'))
  }

  // --- Open the fixture as a REAL project (dev server + preview + preload). ---
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

  // --- Select the Tailwind element with a real click. ---
  await win.click('button[aria-label="Select"]')
  await win.waitForSelector('button[aria-label="Select"][aria-pressed="true"]', { timeout: 5000 })
  await pickElement('tw-box', TW_SRC)

  // --- Open the island and switch to the Styles tab. Browser transition
  // defaults (`all 0s ease`) are not a real transition, so only the three
  // ordinary groups render; animation generation is a separate opt-in action. ---
  await openStylesTab(TW_SRC)
  const groups = await panelEval(
    "[...document.querySelectorAll('.stylepanel__grouptitle')].map((e) => e.textContent.trim())"
  )
  for (const g of ['Layout', 'Appearance', 'Typography']) {
    if (!groups.includes(g)) throw new Error(`Styles group "${g}" missing; got ${JSON.stringify(groups)}`)
  }
  if (groups.includes('Transition')) {
    throw new Error(`inactive browser-default transition rendered controls: ${JSON.stringify(groups)}`)
  }
  await waitPanel(
    "document.querySelector('.stylepanel__animationtrigger')?.textContent.includes('Generate animation controls')"
  )
  await panelEval("document.querySelector('.stylepanel__animationtrigger')?.click(); true")
  await waitPanel(
    "document.querySelector('.stylepanel__animationhint')?.placeholder.includes('describe the animation')"
  )
  await panelEval(`document.querySelector('.stylepanel__animationhint')?.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
  ); true`)
  // …with a linked padding scrub row showing the FRESH computed value (16px
  // from .p-4 — proves the styles:read round trip into the sandboxed preload).
  await waitPanel(
    "[...document.querySelectorAll('.stylepanel__sides .scrubinput__track')].some((e) => e.textContent.includes('16'))"
  )
  await shotIsland('style-edit-island.png')

  // --- S1 commit, engine-direct (the UI-driven path is exercised on
  // border-radius below). With the element's utility classes, padding-top 13px
  // must land as a Tailwind arbitrary-value class rewrite in source
  // (13 ∉ the 4px scale). ---
  const twRes = await panelEval(
    `window.api.styles.apply(${JSON.stringify(fixture)}, {
      source: ${JSON.stringify(TW_SRC)},
      prop: 'padding-top',
      value: '13px',
      classes: ['p-4', 'rounded-md']
    })`
  )
  if (!twRes?.applied || twRes.strategy !== 'tailwind') {
    throw new Error(`tailwind apply failed: ${JSON.stringify(twRes)}`)
  }
  const afterTw = readFileSync(styled, 'utf8')
  // The v1 engine commits the padding-top LONGHAND: its Tailwind family is
  // `pt-*`, so with no pt-* class present the rewrite appends `pt-[13px]`
  // (`p-4` is the shorthand family and stays — the longhand wins in Tailwind's
  // cascade). A literal `p-[13px]` could only come from the `padding` shorthand,
  // which is outside STYLE_PROPS.
  if (!afterTw.includes('className="p-4 rounded-md pt-[13px]"')) {
    throw new Error(`S1 class rewrite not on disk; className line: ${afterTw.match(/className="[^"]*"/)?.[0]}`)
  }

  // --- Live preview: styles:preview injects an override the preview's computed
  // style reflects; clearPreview restores the exact prior value. ---
  await panelEval("window.api.styles.preview('padding-top', '33px'); true")
  const readPad = () =>
    previewEval(
      "getComputedStyle(document.querySelector('#tw-box')).getPropertyValue('padding-top')"
    )
  let padNow = ''
  for (let i = 0; i < 20 && padNow !== '33px'; i++) {
    padNow = await readPad()
    if (padNow !== '33px') await new Promise((r) => setTimeout(r, 150))
  }
  if (padNow !== '33px') throw new Error(`live preview did not inject padding-top 33px, computed: ${padNow}`)
  // …and the panel's fresh-read seam sees the override too.
  const readBack = await panelEval("window.api.styles.read(['padding-top'])")
  if (readBack?.values?.['padding-top'] !== '33px') {
    throw new Error(`styles.read should see the live override: ${JSON.stringify(readBack)}`)
  }
  await panelEval('window.api.styles.clearPreview(); true')
  let padAfter = ''
  for (let i = 0; i < 20 && padAfter !== '16px'; i++) {
    padAfter = await readPad()
    if (padAfter !== '16px') await new Promise((r) => setTimeout(r, 150))
  }
  if (padAfter !== '16px') throw new Error(`clearPreview did not restore padding-top, computed: ${padAfter}`)

  // --- UI-driven commit: the REAL ScrubInput → StylePanel.commit path (a
  // wiring regression — onCommit never firing, wrong classes/source threaded —
  // must fail here, not stay green behind a direct api call). Enter on the
  // border-radius track opens the exact-value editor; typing 13 + Enter
  // commits with the element's live classes, so S1 rewrites rounded-md in
  // place (the only rounded-* class). ---
  const editorOpened = await panelEval(`(() => {
    const row = [...document.querySelectorAll('.scrubinput')].find(
      (r) => r.querySelector('.scrubinput__label')?.title === 'border-radius'
    )
    if (!row) return false
    const track = row.querySelector('.scrubinput__track')
    if (!track) return false
    track.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    return true
  })()`)
  if (editorOpened !== true) throw new Error('border-radius scrub row not found in the Styles tab')
  await waitPanel("!!document.querySelector('.scrubinput__input')")
  const typed = await panelEval(`(() => {
    const input = document.querySelector('.scrubinput__input')
    if (!input) return false
    // React's onChange needs the native value setter + an 'input' event (a
    // plain .value assignment is swallowed by React's value tracker).
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    set.call(input, '13')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    return true
  })()`)
  if (typed !== true) throw new Error('the exact-value editor input never rendered')
  let uiAfter = ''
  for (let i = 0; i < 40; i++) {
    uiAfter = readFileSync(styled, 'utf8')
    if (uiAfter.includes('rounded-[13px]')) break
    await new Promise((r) => setTimeout(r, 150))
  }
  if (!uiAfter.includes('rounded-[13px]')) {
    throw new Error(
      `UI-driven commit did not land rounded-[13px]; className line: ${uiAfter.match(/className="[^"]*"/)?.[0]}`
    )
  }

  // --- Select the inline-styled element; S2 must merge into its style object. ---
  await pickElement('inline-box', INLINE_SRC)
  // A fresh pick closes the island — reopen on the new selection.
  await openStylesTab(INLINE_SRC)
  await shotIsland('style-edit-island-inline.png')

  const beforeInline = readFileSync(styled, 'utf8')
  // A same-prop BURST — two applies back-to-back (well inside edit-history's
  // 500ms coalesce window, same `${source}:style:${prop}` key) must collapse
  // into ONE undo entry. Both run in a single island round trip so the burst
  // can't be stretched past the window by IPC latency.
  const inlineRes = await panelEval(
    `(async () => {
      const root = ${JSON.stringify(fixture)}
      const edit = { source: ${JSON.stringify(INLINE_SRC)}, prop: 'padding-top', classes: [] }
      const first = await window.api.styles.apply(root, { ...edit, value: '11px' })
      if (!first.applied) return first
      return window.api.styles.apply(root, { ...edit, value: '12px' })
    })()`
  )
  if (!inlineRes?.applied || inlineRes.strategy !== 'inline') {
    throw new Error(`inline apply failed: ${JSON.stringify(inlineRes)}`)
  }
  const afterInline = readFileSync(styled, 'utf8')
  if (!afterInline.includes(`style={{ padding: '8px', paddingTop: "12px" }}`)) {
    throw new Error(`S2 style-object merge not on disk; style line: ${afterInline.match(/style=\{\{[^}]*\}\}/)?.[0]}`)
  }

  // --- The S2 REFUSAL (the contrast case): a bare <div> — no className, no
  // style attr — has nothing for the ladder to extend. Writing `style={{…}}`
  // would impose an inline-style convention the project never showed, so this
  // must fall to S3 with the file left byte-identical. The prompt assertion
  // matters as much as the refusal: without that sentence the agent just adds
  // the inline prop itself and the whole gate buys nothing. Inert w.r.t. the
  // undo chain below — it makes no edit-history entry. ---
  const beforeBare = readFileSync(styled, 'utf8')
  const bareRes = await panelEval(
    `window.api.styles.apply(${JSON.stringify(fixture)}, ${JSON.stringify({
      source: BARE_SRC,
      prop: 'padding-top',
      value: '12px',
      classes: []
    })})`
  )
  if (bareRes?.applied || !bareRes?.needsAgent) {
    throw new Error(`bare element must route to the agent, got: ${JSON.stringify(bareRes)}`)
  }
  if (!/do NOT add an inline `style` prop/.test(bareRes.agentPrompt ?? '')) {
    throw new Error(`agent prompt must forbid the inline prop, got: ${bareRes.agentPrompt}`)
  }
  if (readFileSync(styled, 'utf8') !== beforeBare) {
    throw new Error('a refused style edit still wrote to disk')
  }

  // --- Undo (real IPC): ONE step reverts the whole coalesced burst exactly —
  // if the two applies made separate entries, this restores the 11px
  // intermediate state instead and the byte comparison fails. ---
  const undid = await win.evaluate((a) => window.api.edits.undo(a.fixture), { fixture })
  if (!undid.ok) throw new Error(`undo not ok: ${JSON.stringify(undid)}`)
  if (readFileSync(styled, 'utf8') !== beforeInline) {
    throw new Error('one undo did not restore the pre-burst source (burst not coalesced?)')
  }

  // --- Design tokens: the element's color EQUALS --color-text's value but
  // never REFERENCES it (a plain literal hex) — the row must show the raw
  // value, NOT a chip. `getComputedStyle` can't distinguish the two; only the
  // specified-declaration read (`declaredVars`, via style-provenance.ts) can,
  // and it correctly reports null here (no var() in play). ---
  await pickElement('token-box', TOKEN_SRC)
  await openStylesTab(TOKEN_SRC)

  // The header line proves the TokenSet reached the island at all (it travels
  // main renderer → panel:state → island, a seam nothing else covers) —
  // unaffected by the naming fix, which only governs a specific row's chip.
  const tokenSource = await waitPanel(
    "document.querySelector('.stylepanel__tokensource')?.textContent ?? ''"
  )
  if (!/tokens/.test(tokenSource) || !tokenSource.includes('CSS file')) {
    throw new Error(`token source line missing or wrong: ${JSON.stringify(tokenSource)}`)
  }
  // EVERY token-able row gets a toggle (padding offers --space-md), so scope
  // every query to the `color` row — a bare document-wide selector picks up the
  // Layout group's rows first.
  const COLOR_ROW = `[...document.querySelectorAll('.stylepanel__tokenrow')].find(
    (r) => r.querySelector('.stylepanel__name')?.title === 'color'
  )`

  // No chip: a coincidentally-equal literal must not be named. The row falls
  // through to ColorControl (the raw hex input), not TokenChip.
  const noChip = await waitPanel(`${COLOR_ROW}?.querySelector('.stylepanel__token') ? 'chip' : 'raw'`)
  if (noChip !== 'raw') {
    throw new Error(`an unproven coincidence must not be named with a chip, got: ${noChip}`)
  }
  const rawShown = await panelEval(`${COLOR_ROW}?.querySelector('.colorctl__hex')?.value ?? ''`)
  if (!/6c6c6c/i.test(rawShown)) {
    throw new Error(`the raw hex should still be shown plainly, got: ${JSON.stringify(rawShown)}`)
  }

  // --- Re-select the PROVEN element: its inline style IS `var(--color-text)`
  // literally. `el.style.getPropertyValue('color')` preserves that unresolved
  // (unlike getComputedStyle), so THIS is what should show the chip. ---
  await pickElement('proven-token-box', PROVEN_TOKEN_SRC)
  await openStylesTab(PROVEN_TOKEN_SRC)

  const chip = await waitPanel(
    `${COLOR_ROW}?.querySelector('.stylepanel__token')?.textContent?.trim() ?? ''`
  )
  if (chip !== '--color-text') {
    throw new Error(`a real var() reference should name the row --color-text, got ${chip}`)
  }

  // Expand the color row's token picker. Click-only-until-rendered: a second
  // click would collapse it again.
  await waitPanel(`(() => {
    const row = ${COLOR_ROW}
    if (!row) return false
    if (row.querySelector('.stylepanel__tokens')) return true
    row.querySelector('.stylepanel__token-toggle')?.click()
    return false
  })()`)
  // Only color tokens are offered — --space-md and --z-modal must be absent,
  // which is the value-shape gate doing its job through the real UI.
  const offered = await panelEval(
    `[...${COLOR_ROW}.querySelectorAll('.stylepanel__tokens [data-token]')].map((e) => e.dataset.token)`
  )
  const expectOffered = ['--color-text', '--color-title', '--color-link']
  if (JSON.stringify(offered) !== JSON.stringify(expectOffered)) {
    throw new Error(`picker should offer exactly the color tokens, got ${JSON.stringify(offered)}`)
  }
  await shotIsland('style-edit-tokens.png')

  const beforeToken = readFileSync(styled, 'utf8')
  const picked = await panelEval(`(() => {
    const b = ${COLOR_ROW}?.querySelector('[data-token="--color-title"]')
    if (!b) return false
    b.click()
    return true
  })()`)
  if (picked !== true) throw new Error('the --color-title swatch was not clickable')
  let afterToken = ''
  for (let i = 0; i < 40; i++) {
    afterToken = readFileSync(styled, 'utf8')
    if (afterToken.includes('var(--color-title)')) break
    await new Promise((r) => setTimeout(r, 150))
  }
  // The REFERENCE, never the resolved value — writing #212121 here would defeat
  // the whole feature.
  if (!afterToken.includes(`color: "var(--color-title)"`)) {
    throw new Error(
      `token pick did not write a var() reference; style line: ${afterToken.match(/style=\{\{ color[^}]*\}\}/)?.[0]}`
    )
  }
  if (afterToken.includes('#212121')) throw new Error('the resolved value was written, not the reference')

  const undoToken = await win.evaluate((a) => window.api.edits.undo(a.fixture), { fixture })
  if (!undoToken.ok) throw new Error(`undo (token) not ok: ${JSON.stringify(undoToken)}`)
  if (readFileSync(styled, 'utf8') !== beforeToken) {
    throw new Error('undo did not restore the pre-token source exactly')
  }

  // --- Transitions (phase 4): back to the Tailwind element. ---
  await previewEval(`(() => {
    const el = document.querySelector('#tw-box')
    el.style.transitionProperty = 'opacity'
    el.style.transitionDuration = '150ms'
    el.style.transitionTimingFunction = 'ease'
    return true
  })()`)
  await pickElement('tw-box', TW_SRC)
  await openStylesTab(TW_SRC)
  await waitPanel(
    "[...document.querySelectorAll('.stylepanel__grouptitle')].some((e) => e.textContent.trim() === 'Transition')"
  )

  // S1 duration: 150ms sits on Tailwind's named time scale → `duration-150`
  // (not `duration-[150ms]`) appends to the class list.
  const durRes = await panelEval(
    `window.api.styles.apply(${JSON.stringify(fixture)}, {
      source: ${JSON.stringify(TW_SRC)},
      prop: 'transition-duration',
      value: '150ms',
      classes: ['p-4', 'rounded-md']
    })`
  )
  if (!durRes?.applied || durRes.strategy !== 'tailwind') {
    throw new Error(`duration apply failed: ${JSON.stringify(durRes)}`)
  }
  const afterDur = readFileSync(styled, 'utf8')
  if (!/className="[^"]*\bduration-150\b[^"]*"/.test(afterDur)) {
    throw new Error(
      `duration-150 not on disk; className line: ${afterDur.match(/className="[^"]*"/)?.[0]}`
    )
  }

  // S1 timing: a non-keyword curve has no named class — it must land as an
  // arbitrary ease-[…] class with the spaces stripped (Tailwind arbitrary
  // values allow none).
  const bezRes = await panelEval(
    `window.api.styles.apply(${JSON.stringify(fixture)}, {
      source: ${JSON.stringify(TW_SRC)},
      prop: 'transition-timing-function',
      value: 'cubic-bezier(0.17, 0.67, 0.83, 0.67)',
      classes: ['p-4', 'rounded-md']
    })`
  )
  if (!bezRes?.applied || bezRes.strategy !== 'tailwind') {
    throw new Error(`timing-function apply failed: ${JSON.stringify(bezRes)}`)
  }
  const beforeSnap = readFileSync(styled, 'utf8')
  if (!beforeSnap.includes('ease-[cubic-bezier(0.17,0.67,0.83,0.67)]')) {
    throw new Error(
      `arbitrary bezier class not on disk; className line: ${beforeSnap.match(/className="[^"]*"/)?.[0]}`
    )
  }

  // --- Expand the timing row in the ISLAND UI: the chevron toggles the inline
  // BezierEditor. Click-only-until-rendered — a re-click would collapse it. ---
  await waitPanel(`(() => {
    if (document.querySelector('.bezier__svg')) return true
    document.querySelector('.stylepanel__timing-toggle')?.click()
    return false
  })()`)
  // Bring the editor fully into the (content-sized, maxHeight-capped) view
  // before capturing, then let the resize + demo dot settle.
  await waitPanel(`(() => {
    const bz = document.querySelector('.bezier')
    if (!bz) return false
    bz.scrollIntoView({ block: 'nearest' })
    const r = bz.getBoundingClientRect()
    return r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight + 1
  })()`)
  await new Promise((r) => setTimeout(r, 500))
  await shotIsland('style-edit-bezier.png')

  // --- UI-driven preset snap: the computed timing on #tw-box is `ease`
  // (0.25, 0.1, 0.25, 1) — the on-disk class never reaches the static preview.
  // An ArrowUp nudge on handle 1 (step 0.01) makes (0.25, 0.11, 0.25, 1),
  // within the 0.01/coord snap tolerance of `ease`, so the REAL BezierEditor →
  // TimingRow → commit path must write the KEYWORD (Tailwind spells it
  // `ease-[ease]`), replacing the arbitrary bezier class — not the raw coords. ---
  const nudged = await panelEval(`(() => {
    const h = document.querySelector('.bezier__handle')
    if (!h) return false
    h.focus()
    h.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
    return true
  })()`)
  if (nudged !== true) throw new Error('bezier handle not found for the keyboard nudge')
  let afterSnap = ''
  for (let i = 0; i < 40; i++) {
    afterSnap = readFileSync(styled, 'utf8')
    if (afterSnap.includes('ease-[ease]')) break
    await new Promise((r) => setTimeout(r, 150))
  }
  if (!afterSnap.includes('ease-[ease]') || afterSnap.includes('ease-[cubic-bezier')) {
    throw new Error(
      `preset snap did not land ease-[ease]; className line: ${afterSnap.match(/className="[^"]*"/)?.[0]}`
    )
  }

  // --- Undo chain: the snap commit first (restores the arbitrary bezier class
  // byte-for-byte), then every remaining entry back to the pristine fixture
  // (the inline burst was already undone above). ---
  const undoSnap = await win.evaluate((a) => window.api.edits.undo(a.fixture), { fixture })
  if (!undoSnap.ok) throw new Error(`undo (snap) not ok: ${JSON.stringify(undoSnap)}`)
  if (readFileSync(styled, 'utf8') !== beforeSnap) {
    throw new Error('undo did not restore the arbitrary bezier class exactly')
  }
  for (let i = 0; i < 8 && readFileSync(styled, 'utf8') !== original; i++) {
    const u = await win.evaluate((a) => window.api.edits.undo(a.fixture), { fixture })
    if (!u.ok) throw new Error(`undo chain broke early: ${JSON.stringify(u)}`)
  }
  if (readFileSync(styled, 'utf8') !== original) {
    throw new Error('the undo chain did not restore the original fixture source')
  }

  console.log(
    'STYLE-EDIT OK — Styles tab groups + fresh read, S1 tailwind rewrite (pt-[13px]), ' +
      'live preview inject/clear, UI-driven ScrubInput commit (rounded-[13px]), ' +
      'S2 inline merge burst, one-undo coalescing, bare-element S2 refusal, ' +
      'design tokens (an unproven coincidence shows raw, a real var() reference ' +
      'names --color-text, picker offers only colors, pick writes var(--color-title)), ' +
      'transitions (duration-150, ease-[cubic-bezier(…)] no-spaces, BezierEditor ' +
      'nudge → ease keyword snap), full undo chain'
  )
} catch (err) {
  console.error('STYLE-EDIT FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  writeFileSync(styled, original) // leave the fixture pristine
  await app?.close()
}
