/**
 * v2 select-element test — exercises the full click-to-select path end to end,
 * through the real IPC, without a human clicking the native preview:
 *
 *   open fixture → enable Select mode (renderer → main → preview preload) →
 *   dispatch a click on a stamped element inside the preview WebContentsView →
 *   main relays the pick → renderer shows the inspector with the resolved
 *   `data-praxis-source` → "Ask praxis to change this…" seeds the composer.
 *
 * The preview is a separate CDP target, so we reach it via the main process
 * (`webContents.executeJavaScript`) rather than the renderer page.
 *
 * Run with: bun run test:select
 */
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = join(root, 'test', 'fixtures', 'selectable-app')
const artifacts = join(root, 'test', 'artifacts')
mkdirSync(artifacts, { recursive: true })

const EXPECTED_SOURCE = 'src/components/Hero.tsx:7'

// Runs inside the preview WebContentsView's page: return the hero heading's
// centre point. We then deliver a *trusted* click there via sendInputEvent —
// the preload rejects synthetic (untrusted) DOM events, so a real input event
// is both required and a more faithful proxy for a user click.
const GET_CENTER = `(() => {
  const el = document.querySelector('#hero-title')
  if (!el) return null
  const b = el.getBoundingClientRect()
  return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }
})()`

let app
try {
  app = await electron.launch({
    executablePath: electronPath,
    args: [join(root, 'out', 'main', 'index.js')],
    cwd: root
  })

  const win = await app.firstWindow()
  await win.waitForSelector('.empty__open', { timeout: 15000 })

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

  // Make the native folder picker return our fixture.
  await app.evaluate(async ({ dialog }, fixturePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixturePath] })
  }, fixture)

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:action', 'open-project'))

  // Wait until the project is running (titlebar shows the dev-server URL).
  await win.waitForFunction(
    () =>
      /http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+/.test(
        document.querySelector('.previewbar__url')?.textContent ?? ''
      ),
    { timeout: 60000 }
  )

  // Turn on Select mode (the icon button; aria-pressed flips on).
  await win.click('button[aria-label="Select"]')
  await win.waitForSelector('button[aria-label="Select"][aria-pressed="true"]', { timeout: 5000 })

  // The active toggle must render a filled affordance (guards against the
  // .iconbtn.is-active rule being dead/shadowed) — not the transparent base.
  const activeBg = await win.evaluate(() => {
    const btn = document.querySelector('button[aria-label="Select"][aria-pressed="true"]')
    return btn ? getComputedStyle(btn).backgroundColor : null
  })
  if (!activeBg || activeBg === 'rgba(0, 0, 0, 0)' || activeBg === 'transparent') {
    throw new Error(`active Select button should render a filled background, got ${activeBg}`)
  }

  // Deliver a trusted click at the element's centre, retrying to absorb the
  // set-select-mode IPC round-trip (the preload may not be armed immediately,
  // and input delivery can lag when the window isn't focused under load).
  let picked = false
  for (let i = 0; i < 40 && !picked; i++) {
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
    }, GET_CENTER)
    if (result !== 'clicked') {
      await new Promise((r) => setTimeout(r, 300))
      continue
    }
    picked = await win
      .waitForFunction(
        (src) => document.querySelector('.inspector__source')?.textContent?.includes(src),
        EXPECTED_SOURCE,
        { timeout: 1000 }
      )
      .then(() => true)
      .catch(() => false)
  }

  if (!picked) throw new Error('inspector never showed the picked element + its source')

  // The inspector should identify the element we clicked.
  const tag = (await win.textContent('.inspector__tag'))?.trim()
  if (tag !== 'h1#hero-title') throw new Error(`expected tag "h1#hero-title", got "${tag}"`)

  await win.screenshot({ path: join(artifacts, '06-select-element.png') })

  // Hand off to chat: the selection rides as a PILL in the composer (the element
  // reference is prepended to the prompt invisibly on send) — the visible input
  // stays clean, no selector text is seeded.
  const composed = await win.inputValue('.composer__input')
  if (composed.includes('selected the') || composed.includes(EXPECTED_SOURCE)) {
    throw new Error(`composer must stay clean of selector text, got: ${composed}`)
  }
  // The element-scoped actions appear as a floating toolbar INSIDE the preview,
  // adjacent to the selection (comment/annotate/edit/props/code/delete). `edit`
  // is a text-only leaf action; #hero-title (plain-text <h1>) qualifies, so it
  // renders visible here.
  const toolbarShown = await app.evaluate(async ({ webContents }) => {
    const wc = webContents
      .getAllWebContents()
      .find((w) => /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+/.test(w.getURL()))
    if (!wc) return 'no-preview'
    return wc.executeJavaScript(`(() => {
      const host = document.querySelector('[data-praxis-overlay]')
      const bar = host?.shadowRoot?.querySelector('[data-praxis-toolbar]')
      if (!bar) return 'no-toolbar'
      if (getComputedStyle(bar).display === 'none') return 'hidden'
      // Scope to [data-kind] so the inline-input's Submit button (no data-kind)
      // isn't counted — the pill morphs to hold it in the comment/annotate state.
      const kinds = [...bar.querySelectorAll('button[data-kind]')].map((b) => b.dataset.kind).join(',')
      const editShown =
        getComputedStyle(bar.querySelector('[data-kind="edit"]')).display !== 'none'
      return 'visible:' + kinds + (editShown ? ' edit-shown' : ' edit-hidden')
    })()`)
  })
  if (!/^visible:comment,annotate,edit,props,code,delete edit-shown$/.test(toolbarShown)) {
    throw new Error(`in-preview selection toolbar wrong: ${toolbarShown}`)
  }
  await win.screenshot({ path: join(artifacts, '07-select-handoff.png') })

  // The selection badge names the element AND reports its rendered size, so the
  // pick can be measured without opening the inspector.
  const badgeText = await app.evaluate(async ({ webContents }) => {
    const wc = webContents
      .getAllWebContents()
      .find((w) => /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+/.test(w.getURL()))
    if (!wc) return 'no-preview'
    return wc.executeJavaScript(`(() => {
      const host = document.querySelector('[data-praxis-overlay]')
      const badge = host?.shadowRoot?.querySelector('[data-praxis-selbadge]')
      if (!badge) return 'no-badge'
      if (getComputedStyle(badge).display === 'none') return 'hidden'
      const r = document.getElementById('hero-title').getBoundingClientRect()
      const want = Math.round(r.width) + ' × ' + Math.round(r.height)
      const size = badge.querySelector('[data-praxis-size]')?.textContent ?? ''
      return badge.textContent + '|' + (size === want ? 'ok' : 'want ' + want + ', got ' + size)
    })()`)
  })
  if (!/^h1#hero-title\d+ × \d+\|ok$/.test(badgeText)) {
    throw new Error(`selection badge should read the tag plus its size: ${badgeText}`)
  }

  // The overlay lives in the preview WebContentsView, so it's absent from the
  // renderer screenshots above — capture its own pixels to eyeball the badge.
  const overlayPng = await app.evaluate(async ({ webContents }) => {
    const wc = webContents
      .getAllWebContents()
      .find((w) => /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+/.test(w.getURL()))
    if (!wc) return null
    const img = await wc.capturePage()
    return img.toPNG().toString('base64')
  })
  if (overlayPng) writeFileSync(join(artifacts, '07b-selection-badge.png'), Buffer.from(overlayPng, 'base64'))

  // Clicking Edit-text arms the inline contentEditable on the selected leaf —
  // the discoverable form of the double-click gesture. (Our own overlay button,
  // so a JS .click() drives the same onToolbarButton path a user click does.)
  const editArmed = await app.evaluate(async ({ webContents }) => {
    const wc = webContents
      .getAllWebContents()
      .find((w) => /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+/.test(w.getURL()))
    if (!wc) return 'no-preview'
    return wc.executeJavaScript(`(() => {
      const bar = document.querySelector('[data-praxis-overlay]')?.shadowRoot?.querySelector('[data-praxis-toolbar]')
      bar?.querySelector('[data-kind="edit"]')?.click()
      const el = document.querySelector('#hero-title')
      return el?.getAttribute('contenteditable') ?? 'off'
    })()`)
  })
  if (editArmed !== 'plaintext-only') {
    throw new Error(`Edit-text button did not arm contentEditable, got: ${editArmed}`)
  }
  // Escape cancels the edit (restores text, drops contentEditable) so the pill
  // teardown below starts from a clean state.
  await app.evaluate(async ({ webContents }) => {
    const wc = webContents
      .getAllWebContents()
      .find((w) => /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+/.test(w.getURL()))
    wc?.focus()
    wc?.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    wc?.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  })

  // The pill is removable — × clears the selection AND the in-preview toolbar.
  await win.click('.inspector__close')
  await win.waitForFunction(() => !window.__praxisSelection.getState().selected, { timeout: 5000 })
  const toolbarAfter = await app.evaluate(async ({ webContents }) => {
    const wc = webContents
      .getAllWebContents()
      .find((w) => /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+/.test(w.getURL()))
    return wc?.executeJavaScript(`(() => {
      const bar = document.querySelector('[data-praxis-overlay]')?.shadowRoot?.querySelector('[data-praxis-toolbar]')
      return bar ? getComputedStyle(bar).display : 'gone'
    })()`)
  })
  if (toolbarAfter !== 'none' && toolbarAfter !== 'gone') {
    throw new Error(`toolbar should hide when the pill is cleared, got: ${toolbarAfter}`)
  }
  // Re-select for the owner-jump flow below (the pick flow was proven above).
  await win.evaluate((src) => {
    window.__praxisSelection.getState().setSelected({
      tag: 'h1', id: 'hero-title', classes: [], selector: '#hero-title',
      source: src, componentSource: null, text: 'Welcome',
      rect: { x: 0, y: 0, width: 0, height: 0 }, styles: {}
    })
  }, EXPECTED_SOURCE)

  // --- v8 F3a: click a host that carries a forwarded component-instance stamp.
  // The pick resolves to the host source; the inspector offers "edit owner", which
  // re-points the selection at the component-instance call site. ---
  // Open the props island + the code drawer on the CURRENT selection — picking
  // the next element must reset both (a fresh pick shows just the toolbar).
  await win.evaluate(() => {
    window.__praxisPropsIsland.getState().setOpen(true)
    window.__praxisCodeDrawer.getState().open('src/components/Hero.tsx:7')
  })

  const GET_AMOUNT = `(() => { const el = document.querySelector('#amount'); if (!el) return null;
    const b = el.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`
  let pickedAmount = false
  for (let i = 0; i < 40 && !pickedAmount; i++) {
    const r = await app.evaluate(async ({ webContents }, code) => {
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
    }, GET_AMOUNT)
    if (r !== 'clicked') {
      await new Promise((res) => setTimeout(res, 300))
      continue
    }
    pickedAmount = await win
      .waitForFunction(
        () => document.querySelector('.inspector__source')?.textContent?.includes('src/ui/Field.tsx:4'),
        { timeout: 1000 }
      )
      .then(() => true)
      .catch(() => false)
  }
  if (!pickedAmount) throw new Error('inspector never showed the host source for #amount')

  const resetState = await win.evaluate(() => ({
    island: window.__praxisPropsIsland.getState().open,
    drawer: window.__praxisCodeDrawer.getState().source
  }))
  if (resetState.island || resetState.drawer) {
    throw new Error(`a new pick must close island + drawer: ${JSON.stringify(resetState)}`)
  }

  // The store carries the forwarded component-instance source.
  const cs = await win.evaluate(() => window.__praxisSelection.getState().selected?.componentSource)
  if (cs !== 'src/screens/Wallet.tsx:18') {
    throw new Error(`componentSource should be the instance call site, got "${cs}"`)
  }
  // The "edit owner component" affordance is offered (in the props island), and
  // re-points the selection.
  await win.evaluate(() => window.__praxisPropsIsland.getState().setOpen(true))
  await expandPanel()
  await waitPanel("!!document.querySelector('.proppanel__owner')")
  await panelEval("document.querySelector('.proppanel__owner').click(); true")
  await win.waitForFunction(
    () => window.__praxisSelection.getState().selected?.source === 'src/screens/Wallet.tsx:18',
    { timeout: 5000 }
  )

  console.log('SELECT-ELEMENT OK — picked', EXPECTED_SOURCE, '→ selection pill (clean composer); F3a owner re-select')
} catch (err) {
  console.error('SELECT-ELEMENT FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  await app?.close()
}
