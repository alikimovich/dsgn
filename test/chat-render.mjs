/**
 * Visual test of chat rendering (markdown + tool-status lines) without needing
 * the agent/auth: drives the exposed store directly in the renderer, then
 * screenshots the result.
 *
 * Run with: bun run test:chat
 */
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = join(root, 'test', 'artifacts')
mkdirSync(artifacts, { recursive: true })

const SAMPLE = [
  '## Updated the hero section',
  '',
  "I changed the heading color to **teal** and tightened the spacing. Here's the key edit:",
  '',
  '```tsx',
  'export function Hero() {',
  '  return <h1 className="title">Welcome</h1>',
  '}',
  '```',
  '',
  '- Adjusted `--accent` token to `#0d9488`',
  '- Reduced top padding from `64px` to `48px`',
  '',
  '> Preview should hot-reload automatically.'
].join('\n')

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

  await win.evaluate(async (sample) => {
    const store = window.__praxisStore
    const s = store.getState()
    s.appendUser('Make the hero heading teal and tighten the spacing')
    s.startAssistant()
    s.appendStatus('Read · src/components/Hero.tsx')
    s.appendStatus('Edit · src/components/Hero.tsx')
    // Token deltas as the backend reports them (LKM-62) — the status line sums them.
    s.addUsage({ input: 9800, output: 120, cached: 9000 })
    // Stream the markdown in chunks to mimic real deltas.
    for (let i = 0; i < sample.length; i += 12) {
      store.getState().appendDelta(sample.slice(i, i + 12))
    }
    store.getState().addUsage({ input: 2600, output: 710, cached: 2000 })
  }, SAMPLE)

  await win.waitForSelector('.markdown pre code', { timeout: 5000 })
  // Mid-turn: the running cat is captioned with tokens in/out + working time,
  // NOT the current tool step (which lives in the turn's own step disclosure).
  const running = (await win.textContent('.chat__stats')) ?? ''
  if (!/↑ 12k/.test(running) || !/↓ 830/.test(running) || !/\d+:\d\d/.test(running)) {
    throw new Error(`status line should show tokens + elapsed: ${running}`)
  }
  await win.screenshot({ path: join(artifacts, '04a-chat-status.png') })

  await win.evaluate(() => window.__praxisStore.getState().finish())
  await win.screenshot({ path: join(artifacts, '04-chat-render.png') })

  // LKM-64: a pasted link is one unbreakable token, so a user bubble sized to
  // its content used to grow past the pane and hang off its left edge. The URL
  // renders elided (full URL on the tooltip) and the bubble must fit.
  const LINK =
    'https://embed.figma.com/design/8cJr4hN6UDrSJVQ6YcX9Qf/portfolio?node-id=127-2510&embed-host=share'
  await win.evaluate(
    (link) =>
      window.__praxisStore
        .getState()
        .appendUser(`here, how it started goes right after swiftly: ${link}`),
    LINK
  )
  await win.waitForSelector('.msg__link', { timeout: 5000 })
  const linkCheck = await win.evaluate((link) => {
    const bubbles = [...document.querySelectorAll('.msg--user .msg__text')]
    const bubble = bubbles[bubbles.length - 1]
    const pane = bubble.closest('.pane--chat') ?? document.body
    const el = bubble.querySelector('.msg__link')
    return {
      label: el?.textContent ?? '',
      title: el?.getAttribute('title') ?? '',
      isAnchor: el?.tagName === 'A',
      // Fits the pane both ways: no horizontal spill inside the bubble, and no
      // part of the bubble outside the pane's box.
      overflows: bubble.scrollWidth > bubble.clientWidth + 1,
      outside:
        bubble.getBoundingClientRect().left <
          pane.getBoundingClientRect().left - 1 ||
        bubble.getBoundingClientRect().right >
          pane.getBoundingClientRect().right + 1
    }
  }, LINK)
  if (linkCheck.label !== 'embed.figma.com/…/portfolio') {
    throw new Error(`long url should render elided: ${JSON.stringify(linkCheck.label)}`)
  }
  if (linkCheck.title !== LINK) {
    throw new Error(`elided url should keep the full url on its tooltip: ${linkCheck.title}`)
  }
  if (linkCheck.isAnchor) {
    throw new Error('a user ask is not a link surface — the elided url must not be an <a>')
  }
  if (linkCheck.overflows || linkCheck.outside) {
    throw new Error(`user bubble with a long url must fit the pane: ${JSON.stringify(linkCheck)}`)
  }
  await win.screenshot({ path: join(artifacts, '04b-chat-long-link.png') })

  // v6: the agent's tool steps collapse into a disclosure (latest step + count);
  // expanding reveals the full list. (It starts collapsed once the turn finished —
  // so clicking is what reveals the step lines; if it were open, the click would
  // close it and the wait below would fail.)
  await win.waitForSelector('.msg__steps-trigger', { timeout: 5000 })
  const stepsTrigger = (await win.textContent('.msg__steps-trigger')) ?? ''
  if (!/2 steps/.test(stepsTrigger)) {
    throw new Error(`steps disclosure should summarize the count: ${stepsTrigger}`)
  }
  await win.click('.msg__steps-trigger') // expand
  await win.waitForSelector('.msg__status', { timeout: 3000 })
  const steps = await win.$$eval('.msg__status', (els) => els.map((e) => e.textContent?.trim() ?? ''))
  if (steps.length !== 2 || !steps.some((s) => /Hero\.tsx/.test(s))) {
    throw new Error(`expanded steps wrong: ${JSON.stringify(steps)}`)
  }

  // Toolbar + "/" slash menu: seed commands (the SlashCommandItem shape main now
  // emits — LKM-54) and open the menu. Includes: project skills with/without a
  // description, a duplicate name in both sources, and a very long description.
  await win.evaluate(() => {
    window.__praxisSession.getState().setSlashCommands([
      { name: 'commit', source: 'other' },
      { name: 'compact', source: 'other' },
      { name: 'init', source: 'other' },
      // Same name in both sources: only the project one may render.
      { name: 'design-review', source: 'other' },
      {
        name: 'design-review',
        description:
          'Run the full project design review: check every screen against the token set, ' +
          'measure spacing, contrast and typography, and file annotations for anything off.',
        source: 'project'
      },
      { name: 'accessibility-review', description: 'Audit a11y', source: 'project' },
      { name: 'no-desc-skill', source: 'project' }
    ])
  })
  await win.fill('.composer__input', '/')
  await win.waitForSelector('.slash__item', { timeout: 5000 })
  await win.screenshot({ path: join(artifacts, '05-toolbar-slash.png') })

  // Project skills rank first (in seed order), then the other commands; the
  // duplicate design-review collapses to the single project entry.
  const menuNames = await win.$$eval('.slash__item .slash__name', (els) =>
    els.map((e) => e.textContent?.trim())
  )
  const expectedOrder = [
    '/design-review',
    '/accessibility-review',
    '/no-desc-skill',
    '/commit',
    '/compact',
    '/init'
  ]
  if (JSON.stringify(menuNames) !== JSON.stringify(expectedOrder)) {
    throw new Error(`slash menu order wrong: ${JSON.stringify(menuNames)}`)
  }

  // Each described skill shows its description on a second line, truncated to ONE
  // visual line (ellipsis) no matter how long; an undescribed command stays a
  // single-line item.
  const descCheck = await win.evaluate(() => {
    const items = [...document.querySelectorAll('.slash__item')]
    const byName = (n) =>
      items.find((it) => it.querySelector('.slash__name')?.textContent?.trim() === n)
    const long = byName('/design-review').querySelector('.slash__desc')
    const cs = getComputedStyle(long)
    return {
      dupCount: items.filter(
        (it) => it.querySelector('.slash__name')?.textContent?.trim() === '/design-review'
      ).length,
      longText: long.textContent,
      oneLine:
        cs.whiteSpace === 'nowrap' &&
        cs.textOverflow === 'ellipsis' &&
        cs.overflow === 'hidden' &&
        long.scrollWidth > long.clientWidth &&
        long.clientHeight < 2 * parseFloat(cs.fontSize),
      bareHasNoDesc: !byName('/no-desc-skill').querySelector('.slash__desc'),
      otherHasNoDesc: !byName('/commit').querySelector('.slash__desc')
    }
  })
  if (descCheck.dupCount !== 1) {
    throw new Error(`duplicate name should render once, got ${descCheck.dupCount}`)
  }
  if (!descCheck.longText.includes('design review')) {
    throw new Error(`project skill should show its SKILL.md description: ${descCheck.longText}`)
  }
  if (!descCheck.oneLine) {
    throw new Error('a long description must truncate to a single visual line with an ellipsis')
  }
  if (!descCheck.bareHasNoDesc || !descCheck.otherHasNoDesc) {
    throw new Error('commands without a description should render as single-line items')
  }

  // Keyboard nav + Enter inserts the highlighted (first = project) command.
  await win.focus('.composer__input')
  await win.keyboard.press('ArrowDown') // → accessibility-review
  await win.keyboard.press('Enter')
  const inserted = await win.inputValue('.composer__input')
  if (inserted !== '/accessibility-review ') {
    throw new Error(`Enter should insert the highlighted command: ${JSON.stringify(inserted)}`)
  }

  // Click-to-insert still works.
  await win.fill('.composer__input', '/com')
  await win.waitForSelector('.slash__item', { timeout: 5000 })
  await win.click('.slash__item:has-text("/commit")')
  const clicked = await win.inputValue('.composer__input')
  if (clicked !== '/commit ') {
    throw new Error(`click should insert the command: ${JSON.stringify(clicked)}`)
  }

  // The menu also opens mid-message when "/" follows whitespace (caret at end).
  await win.fill('.composer__input', 'refactor /comp')
  await win.waitForFunction(
    () =>
      [...document.querySelectorAll('.slash__item')].some((b) =>
        b.textContent?.includes('compact'),
      ),
    { timeout: 5000 },
  )
  // But NOT when a non-whitespace char sits right before "/".
  await win.fill('.composer__input', 'refactor/comp')
  await win.waitForSelector('.slash__item', { state: 'detached', timeout: 5000 })
  await win.fill('.composer__input', '')

  // First-run auth onboarding: flipping authNeeded shows the guidance banner.
  await win.fill('.composer__input', '')
  await win.evaluate(() => window.__praxisSession.getState().setAuthNeeded(true))
  await win.waitForSelector('.banner--auth code', { timeout: 5000 })
  const authText = (await win.textContent('.banner--auth'))?.toLowerCase() ?? ''
  if (!authText.includes('setup-token')) {
    throw new Error('auth banner should mention claude setup-token')
  }
  await win.screenshot({ path: join(artifacts, '08-auth-onboarding.png') })
  await win.evaluate(() => window.__praxisSession.getState().setAuthNeeded(false))

  // Permission cards: seed a pending tool prompt, confirm it renders, approve it.
  // NOTE: no project is open here, so clicking Allow only exercises the renderer's
  // optimistic card removal — the main-side respond IPC is a no-op without a
  // session. The full canUseTool round-trip is covered by the live agent-e2e
  // (which needs Claude credentials), not this store-driven visual test.
  await win.evaluate(() => {
    window.__praxisPermissions.getState().addRequest({
      id: 'tu_test',
      toolName: 'Bash',
      title: 'Allow Bash?',
      displayName: 'Run command',
      detail: 'npm run build'
    })
  })
  await win.waitForSelector('.perm', { timeout: 5000 })
  const permTitle = (await win.textContent('.perm__title'))?.trim()
  if (permTitle !== 'Allow Bash?') throw new Error(`unexpected permission title: ${permTitle}`)
  await win.screenshot({ path: join(artifacts, '09-permission-card.png') })
  await win.click('.perm__allow')
  await win.waitForFunction(() => !document.querySelector('.perm'), { timeout: 5000 })

  // The permission-mode selector is present (restored in a612f83) and defaults to
  // Auto (approve-all).
  const permModes = await win.$$eval('select[aria-label="Permission mode"] option', (os) =>
    os.map((o) => o.value)
  )
  if (JSON.stringify(permModes) !== JSON.stringify(['auto', 'acceptEdits', 'default'])) {
    throw new Error(`unexpected permission modes: ${JSON.stringify(permModes)}`)
  }
  const defaultMode = await win.evaluate(() => window.__praxisPermissions.getState().mode)
  if (defaultMode !== 'auto')
    throw new Error(`default permission mode should be auto, got ${defaultMode}`)

  // The picker is TWO <select>s, both derived from main's one `providers.choices()`
  // list: a Provider (the built-in seats, then each saved connection, then an
  // "Add new…" row that opens Settings) and the models of whichever provider is
  // selected. Wait for the choices to land.
  await win.waitForFunction(
    () => (window.__praxisProviders?.getState().choices.length ?? 0) > 0,
    null,
    { timeout: 10000 }
  )
  // Choice `value`s are main's to namespace, and the model IDS are discovered at
  // runtime now (main/model-catalog.ts asks each harness what it actually has),
  // so naming one here would re-pin the very hardcoded list that discovery
  // replaced — and break the day the CLI ships its next family. Take the first
  // real (non-"Default") entry of each built-in group instead.
  const firstRealModel = (provider) =>
    win.evaluate(
      (provider) =>
        window.__praxisProviders
          .getState()
          .choices.find(
            (c) => c.provider === provider && !c.connectionId && c.modelId !== 'default'
          )?.value ?? null,
      provider
    )
  const claudeValue = await firstRealModel('claude')
  const codexValue = await firstRealModel('codex')
  if (!claudeValue || !codexValue)
    throw new Error('built-in seats missing from providers.choices()')
  const optionsOf = (label) =>
    win.$$eval(`select[aria-label="${label}"] option`, (os) =>
      os.map((o) => ({ value: o.value, label: o.textContent?.trim() ?? '' }))
    )
  const providerOptions = await optionsOf('Provider')
  // The two built-in seats lead (labelled by harness), and the Settings row is
  // LAST — any saved connection sits between them.
  if (providerOptions[0]?.value !== 'claude' || providerOptions[1]?.value !== 'codex') {
    throw new Error(
      `provider picker should lead with the built-in seats: ${JSON.stringify(providerOptions)}`
    )
  }
  if (providerOptions[0].label !== 'Claude' || providerOptions[1].label !== 'Codex') {
    throw new Error(`provider rows carry their group label: ${JSON.stringify(providerOptions)}`)
  }
  if (providerOptions[providerOptions.length - 1]?.value !== '__manage-providers__') {
    throw new Error(`"Add new…" must be the last provider row: ${JSON.stringify(providerOptions)}`)
  }
  // The model list is scoped to the selected provider (Claude at rest) — the other
  // harness's models are not in it.
  const claudeModels = (await optionsOf('Model')).map((o) => o.value)
  if (!claudeModels.includes(claudeValue) || claudeModels.includes(codexValue)) {
    throw new Error(
      `model picker should offer only Claude's models: ${JSON.stringify(claudeModels)}`
    )
  }
  // Switching provider re-points the harness and repopulates the models.
  await win.selectOption('select[aria-label="Provider"]', 'codex')
  const derived = await win.evaluate(() => window.__praxisSession.getState().provider)
  if (derived !== 'codex') throw new Error(`picking the Codex provider should set it: ${derived}`)
  const codexModels = (await optionsOf('Model')).map((o) => o.value)
  if (!codexModels.includes(codexValue) || codexModels.includes(claudeValue)) {
    throw new Error(`model picker should follow the provider: ${JSON.stringify(codexModels)}`)
  }
  await win.selectOption('select[aria-label="Model"]', codexValue)
  await win.waitForFunction((v) => window.__praxisSession.getState().model === v, codexValue, {
    timeout: 5000
  })
  // The `codex login` hint is NOT a nag on every switch — an already-connected
  // user shouldn't see it. It only appears after a turn fails to connect.
  if ((await win.$('.provider-hint')) !== null)
    throw new Error('provider hint should stay hidden until a Codex turn fails')
  // A Codex auth/"not connected" failure surfaces the login hint.
  await win.evaluate(() => window.__praxisSession.getState().setCodexAuthNeeded(true))
  await win.waitForSelector('.provider-hint', { timeout: 5000 })
  const hint = (await win.textContent('.provider-hint'))?.toLowerCase() ?? ''
  if (!hint.includes('codex login')) throw new Error(`provider hint should mention codex login: ${hint}`)
  await win.evaluate(() => window.__praxisSession.getState().setCodexAuthNeeded(false))
  await win.selectOption('select[aria-label="Provider"]', 'claude') // reset to Claude
  if ((await win.$('.provider-hint')) !== null) throw new Error('hint should hide for Claude')
  // Switching provider lands on that provider's Default rather than carrying a
  // model id across (it would mean nothing to the other harness).
  const afterSwitch = await win.evaluate(() => {
    const s = window.__praxisSession.getState()
    return {
      provider: s.provider,
      model: s.model,
      modelId: s.modelId,
      connectionId: s.connectionId
    }
  })
  if (afterSwitch.provider !== 'claude' || afterSwitch.modelId !== 'default') {
    throw new Error(`switching provider should select its Default: ${JSON.stringify(afterSwitch)}`)
  }
  // "Add new…" isn't a provider — it opens Settings and leaves the pick be.
  await win.selectOption('select[aria-label="Provider"]', '__manage-providers__')
  const afterManage = await win.evaluate(() => ({
    open: window.__praxisProviders.getState().settingsOpen,
    provider: window.__praxisSession.getState().provider,
    model: window.__praxisSession.getState().model
  }))
  if (
    !afterManage.open ||
    afterManage.provider !== 'claude' ||
    afterManage.model !== afterSwitch.model
  ) {
    throw new Error(`"Add new…" should open settings only: ${JSON.stringify(afterManage)}`)
  }
  // The Settings dialog itself renders its one tab + the empty connections state.
  await win.waitForSelector('[data-slot="dialog-title"]:has-text("Settings")', { timeout: 8000 })
  await win.screenshot({ path: join(artifacts, '09b-settings-dialog.png') })
  await win.evaluate(() => window.__praxisProviders.getState().setSettingsOpen(false))

  // Model ids are DISCOVERED now, so a chat persisted against one the harness has
  // since retired matches no choice at all. It must degrade to that provider's
  // Default rather than render a dead row — while leaving the stored settings
  // exactly as they are (they're only rewritten when the user actually picks).
  await win.evaluate(() =>
    window.__praxisSession.getState().setChatAgentSettings({
      provider: 'claude',
      model: 'claude:retired-in-2026',
      modelId: 'retired-in-2026',
      effort: 'high',
      permissionMode: 'auto'
    })
  )
  const staleId = await win.evaluate(() => {
    const modelSel = document.querySelector('select[aria-label="Model"]')
    return {
      provider: document.querySelector('select[aria-label="Provider"]').value,
      label: modelSel.selectedOptions[0]?.textContent?.trim() ?? '',
      values: [...modelSel.options].map((o) => o.value),
      stored: window.__praxisSession.getState().model
    }
  })
  if (staleId.provider !== 'claude' || staleId.label !== 'Default') {
    throw new Error(
      `a retired model id should fall back to its provider's Default: ${JSON.stringify(staleId)}`
    )
  }
  if (staleId.values.includes('claude:retired-in-2026')) {
    throw new Error('the retired id must not be offered as an option of its own')
  }
  if (staleId.stored !== 'claude:retired-in-2026') {
    throw new Error(`the picker must not rewrite the chat's stored model: ${staleId.stored}`)
  }

  // Model/backend choices are per live chat. Changing the new chat's Codex model
  // must not overwrite the older chat, and switching between their rail rows must
  // restore each picker's own values. No live agent is needed here: the renderer
  // records the setting before its best-effort Codex restart IPC.
  const perChat = await win.evaluate(() => {
    const ws = window.__praxisWorkspace.getState()
    const session = window.__praxisSession.getState()
    ws.reset()
    const key = ws.openOrActivate('/tmp/praxis-per-chat-model')
    const newer = `${key}#new`
    ws.patchEntry(key, {
      sessionKeys: [key, newer],
      activeSessionKey: newer,
      chatSettings: {
        [key]: { provider: 'claude', model: 'sonnet', effort: 'high' },
        [newer]: { provider: 'codex', model: 'default', effort: 'high' }
      }
    })
    window.__praxisStore.getState().setActiveChat(newer)
    session.setProjectRoot('/tmp/praxis-per-chat-model')
    session.setChatAgentSettings({ provider: 'codex', model: 'default', effort: 'high' })
    return { key, newer }
  })
  // LKM-55: a chat with no messages yet has no rail row — it appears only once
  // its first message is sent, so "+" can't fill the rail with "New chat" rows.
  await win.waitForFunction(() => document.querySelectorAll('.rail__chat').length === 0, null, {
    timeout: 5000
  })
  // The older chat gains its first message → its row appears; the still-empty
  // newer chat stays hidden.
  await win.evaluate(({ key }) => {
    window.__praxisStore.getState().appendUser('older chat prompt', key)
  }, perChat)
  await win.waitForFunction(() => document.querySelectorAll('.rail__chat').length === 1, null, {
    timeout: 5000
  })
  // LKM-55: "+" while an empty live chat exists reuses it (here: the already-
  // active `newer`) instead of stacking another session.
  await win.click('.rail__new-chat')
  const afterPlus = await win.evaluate(({ key }) => {
    const p = window.__praxisWorkspace.getState().projects.find((x) => x.key === key)
    return { count: p?.sessionKeys.length, active: p?.activeSessionKey }
  }, perChat)
  if (afterPlus.count !== 2 || afterPlus.active !== perChat.newer) {
    throw new Error(`"+" with an empty chat live should reuse it: ${JSON.stringify(afterPlus)}`)
  }
  // The newer chat's first message lands → both rows show (newest first).
  await win.evaluate(({ newer }) => {
    window.__praxisStore.getState().appendUser('newer chat prompt', newer)
  }, perChat)
  await win.waitForFunction(() => document.querySelectorAll('.rail__chat').length === 2, null, {
    timeout: 5000
  })
  await win.selectOption('select[aria-label="Model"]', codexValue)
  const changedNew = await win.evaluate(({ key, newer }) =>
    window.__praxisWorkspace.getState().projects.find((p) => p.key === key)?.chatSettings?.[newer]?.model,
  perChat)
  if (changedNew !== codexValue) throw new Error(`new chat model was not stored: ${changedNew}`)
  // The rail orders chats newest first, so the second button is the original one.
  await win.locator('.rail__chat').nth(1).click()
  await win.waitForFunction(
    () => window.__praxisSession.getState().model === 'sonnet',
    null,
    { timeout: 5000 },
  )
  const oldPicker = await win.evaluate(() => ({
    provider: window.__praxisSession.getState().provider,
    model: window.__praxisSession.getState().model,
  }))
  if (oldPicker.provider !== 'claude' || oldPicker.model !== 'sonnet') {
    throw new Error(`old chat picker leaked the new chat model: ${JSON.stringify(oldPicker)}`)
  }
  await win.locator('.rail__chat').nth(0).click()
  await win.waitForFunction(
    (expected) => window.__praxisSession.getState().model === expected,
    codexValue,
    { timeout: 5000 },
  )

  // Working-branch pill: shows the branch and opens a switcher dropdown on click;
  // "New branch…" reveals the inline rename editor.
  await win.evaluate(() => window.__praxisSession.getState().setBranch('praxis/main'))
  await win.waitForSelector('.branch', { timeout: 5000 })
  const pill = (await win.textContent('.branch'))?.trim()
  if (!pill?.includes('praxis/main')) throw new Error(`branch pill: ${pill}`)
  await win.click('.branch')
  await win.waitForSelector('[role="menuitem"]', { timeout: 5000 })
  await win.click('text=New branch…')
  await win.waitForSelector('.branch__input', { timeout: 5000 })

  // v5 workspace store: open/activate/close transitions, keyed by projectKey.
  const ws = await win.evaluate(() => {
    const w = window.__praxisWorkspace.getState()
    w.reset()
    const a = w.openOrActivate('/tmp/proj-a/')
    const b = w.openOrActivate('/tmp/proj-b')
    w.openOrActivate('/tmp/proj-a') // dedupe: same key, no new entry
    const afterOpen = window.__praxisWorkspace.getState()
    window.__praxisWorkspace.getState().activate(a)
    const afterActivate = window.__praxisWorkspace.getState().activeKey
    window.__praxisWorkspace.getState().close(a)
    const afterClose = window.__praxisWorkspace.getState()
    return {
      a,
      b,
      count: afterOpen.projects.length,
      activeAfterOpen: afterOpen.activeKey,
      afterActivate,
      remaining: afterClose.projects.map((p) => p.key),
      activeAfterClose: afterClose.activeKey
    }
  })
  if (ws.count !== 2) throw new Error(`workspace should dedupe to 2 projects, got ${ws.count}`)
  if (ws.activeAfterOpen !== ws.a) throw new Error('re-opening A should make A active')
  if (ws.afterActivate !== ws.a) throw new Error('activate(A) failed')
  if (ws.remaining.length !== 1 || ws.remaining[0] !== ws.b) {
    throw new Error(`close(A) should leave only B, got ${JSON.stringify(ws.remaining)}`)
  }
  if (ws.activeAfterClose !== ws.b) throw new Error('closing the active project should fall back to B')

  // Rail collapse: one project (B) is open, so the rail renders. The floating
  // toggle by the traffic lights hides it entirely, then brings it back.
  await win.waitForSelector('.rail', { timeout: 5000 })
  await win.click('button[aria-label="Hide projects sidebar"]')
  // Since #60 the rail stays mounted when collapsed (it slides out); assert the
  // collapsed state + hidden-from-a11y instead of unmounting.
  await win.waitForFunction(
    () => document.querySelector('.rail')?.classList.contains('rail--collapsed'),
    null,
    { timeout: 5000 }
  )
  await win.click('button[aria-label="Show projects sidebar"]')
  await win.waitForFunction(
    () => {
      const r = document.querySelector('.rail')
      return !!r && !r.classList.contains('rail--collapsed')
    },
    null,
    { timeout: 5000 }
  )

  // Paste an image into the composer → a thumbnail attachment chip appears.
  await win.evaluate(() => {
    // 1x1 transparent PNG.
    const b64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const file = new File([bytes], 'pixel.png', { type: 'image/png' })
    const dt = new DataTransfer()
    dt.items.add(file)
    const ta = document.querySelector('.composer__input')
    ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  })
  await win.waitForSelector('.composer__input ~ * img, .composer img', { timeout: 5000 }).catch(() => {})
  const thumb = await win.$('img[alt="attachment"]')
  if (!thumb) throw new Error('pasted image should add a thumbnail attachment')
  // LKM-66: the chip row is left-aligned with the prompt text, not centered
  // (the InputGroup is a flex column with items-center, so a shrink-to-fit row
  // would float to the middle).
  const attachAlign = await win.evaluate(() => {
    const row = document.querySelector('.composer__attachments')
    const chip = row?.firstElementChild
    const ta = document.querySelector('.composer__input')
    if (!row || !chip || !ta) return null
    const style = getComputedStyle(ta)
    return {
      chipLeft: chip.getBoundingClientRect().left,
      textLeft: ta.getBoundingClientRect().left + parseFloat(style.paddingLeft),
      rowWidth: row.getBoundingClientRect().width,
      inputWidth: ta.getBoundingClientRect().width,
    }
  })
  if (!attachAlign) throw new Error('attachment chip row should be in the composer')
  if (Math.abs(attachAlign.chipLeft - attachAlign.textLeft) > 1) {
    throw new Error(
      `attachment chip should start at the prompt text (${attachAlign.textLeft}), got ${attachAlign.chipLeft}`
    )
  }
  if (Math.abs(attachAlign.rowWidth - attachAlign.inputWidth) > 1) {
    throw new Error(
      `attachment row should span the composer like the textarea (${attachAlign.inputWidth}), got ${attachAlign.rowWidth}`
    )
  }
  // Removing it clears the chip.
  await win.click('button[aria-label="Remove image"]')
  await win.waitForFunction(() => !document.querySelector('img[alt="attachment"]'), { timeout: 5000 })

  // Drop a non-image file → a filename card appears. The composer recovers the
  // file's real on-disk path via the preload's webUtils.getPathForFile, which only
  // works for a path-backed File (a synthetic `new File()` has none). So seed a
  // real file through a hidden <input type=file> (Playwright's setInputFiles backs
  // it with a real path), then dispatch the drop carrying that File — exercising
  // the true preload seam, not a stub.
  const droppedPath = join(artifacts, 'dropped-notes.txt')
  writeFileSync(droppedPath, 'hello from a dropped file')
  await win.evaluate(() => {
    const fi = document.createElement('input')
    fi.type = 'file'
    fi.id = '__test_file_input'
    fi.style.display = 'none'
    document.body.appendChild(fi)
  })
  await win.setInputFiles('#__test_file_input', droppedPath)
  await win.evaluate(() => {
    const fi = document.getElementById('__test_file_input')
    const dt = new DataTransfer()
    dt.items.add(fi.files[0])
    const ta = document.querySelector('.composer__input')
    ta.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    fi.remove()
  })
  const fileCard = await win.waitForSelector(`[title="${droppedPath}"]`, { timeout: 5000 })
  const cardText = (await fileCard.textContent())?.trim() ?? ''
  if (!cardText.includes('dropped-notes.txt')) {
    throw new Error(`dropped file card should show its name: ${cardText}`)
  }
  // Removing it clears the card.
  await win.click('button[aria-label="Remove dropped-notes.txt"]')
  await win.waitForFunction((p) => !document.querySelector(`[title="${p}"]`), droppedPath, {
    timeout: 5000
  })

  // Drop an IMAGE file → it becomes a vision thumbnail as before, but it ALSO
  // keeps the file's real on-disk path (LKM-67), which the turn hands to the
  // agent so it can copy/point at the actual file instead of asking where it
  // lives. Same real-preload seam as the file card above.
  const droppedImage = join(artifacts, 'dropped-shot.png')
  writeFileSync(
    droppedImage,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64'
    )
  )
  await win.evaluate(() => {
    const fi = document.createElement('input')
    fi.type = 'file'
    fi.id = '__test_image_input'
    fi.style.display = 'none'
    document.body.appendChild(fi)
  })
  await win.setInputFiles('#__test_image_input', droppedImage)
  await win.evaluate(() => {
    const fi = document.getElementById('__test_image_input')
    const dt = new DataTransfer()
    dt.items.add(fi.files[0])
    const ta = document.querySelector('.composer__input')
    ta.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    fi.remove()
  })
  const imageChip = await win.waitForSelector(`[title="${droppedImage}"]`, { timeout: 5000 })
  if (!(await imageChip.$('img[alt="attachment"]'))) {
    throw new Error('a dropped image should still render as a thumbnail, not a file card')
  }
  await win.click('button[aria-label="Remove image"]')
  await win.waitForFunction((p) => !document.querySelector(`[title="${p}"]`), droppedImage, {
    timeout: 5000
  })

  // A SENT user turn keeps its images + the selected element pill in the bubble
  // (LKM-53) — they used to vanish from the composer without surfacing in the
  // transcript. `appendUser` carries them onto the message.
  await win.evaluate(() => {
    window.__praxisStore.getState().appendUser('Tweak this button', undefined, {
      attachments: [
        { id: 'att1', mediaType: 'image/png', url: 'data:image/png;base64,iVBORw0KGgo=' },
      ],
      selection: { tag: 'button', ident: '.cta', source: 'src/App.tsx:12:3' },
    })
  })
  await win.waitForSelector('.msg--user .msg__attachments img[alt="attachment"]', { timeout: 5000 })
  const selectionPill =
    (await win.textContent('.msg--user .msg__selection'))?.replace(/\s+/g, ' ').trim() ?? ''
  if (!selectionPill.includes('button.cta') || !selectionPill.includes('src/App.tsx:12:3')) {
    throw new Error(`sent bubble should show the selection pill: ${selectionPill}`)
  }

  // Composer responsiveness: at a narrow chat pane the send button stays visible
  // (selects wrap), and the textarea auto-grows up to ~6 lines for a long prompt.
  await win.evaluate(() => {
    document.querySelector('.pane--chat').style.width = '320px'
  })
  await win.fill('.composer__input', 'a\nb\nc\nd\ne\nf\ng\nh')
  await win.waitForFunction(
    () => parseFloat(document.querySelector('.composer__input').style.height) > 90,
    { timeout: 4000 }
  )
  const sendVisible = await win.evaluate(() => {
    const br = document.querySelector('.composer__send').getBoundingClientRect()
    const pr = document.querySelector('.pane--chat').getBoundingClientRect()
    return br.width > 0 && br.right <= pr.right + 1
  })
  if (!sendVisible) throw new Error('send button must stay visible at a narrow chat width')
  await win.fill('.composer__input', '') // reset

  // Thinking-level selector is removed (effort is pinned to high).
  if (await win.$('select[aria-label="Thinking level"]'))
    throw new Error('the Thinking selector should be gone')

  // Theme follows the OS — no in-app toggle in the rail.
  if (await win.$('button[aria-label="Toggle dark mode"]'))
    throw new Error('the theme toggle should be removed (theme matches the OS)')

  // Native Actions menu is installed with the expected items.
  const actions = await app.evaluate(({ Menu }) => {
    const m = Menu.getApplicationMenu()
    const a = m?.items.find((i) => i.label === 'Actions')
    return a?.submenu?.items.map((i) => i.label || i.role || 'separator') ?? null
  })
  if (!actions) throw new Error('Actions menu not installed')
  // Open/New Project moved to the File menu (see test/menu-recents.mjs).
  for (const label of ['Reload Preview', 'Select Element', 'Stop Project', 'Viewport']) {
    if (!actions.some((l) => l === label)) throw new Error(`Actions menu missing "${label}": ${actions}`)
  }

  // A menu:action command from main flips the viewport store (the renderer dispatch).
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('menu:action', 'viewport:mobile')
  })
  await win.waitForFunction(() => window.__praxisViewport.getState().viewport === 'mobile', { timeout: 5000 })
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('menu:action', 'viewport:desktop')
  })
  await win.waitForFunction(() => window.__praxisViewport.getState().viewport === 'desktop', { timeout: 5000 })

  // v9 resume hydration: a persisted transcript (user / assistant / status lines)
  // rebuilds into grouped chat messages and renders as a populated thread — the
  // fix for "resume remembers context but shows an empty chat tree" (LKM-25).
  const hydration = await win.evaluate(() => {
    const key = 'resume-test#sdk-abc'
    const transcript = [
      { role: 'user', text: 'Make the header sticky', at: 1 },
      { role: 'assistant', text: 'Sure, on it.', at: 2 },
      { role: 'status', text: 'Read · src/Header.tsx', at: 3 },
      { role: 'status', text: 'Edit · src/Header.tsx', at: 4 },
      { role: 'assistant', text: 'Done — the header is sticky now.', at: 5 },
      { role: 'user', text: 'Thanks', at: 6 }
    ]
    const msgs = window.__praxisMessagesFromTranscript(transcript)
    window.__praxisStore.getState().hydrate(key, msgs)
    window.__praxisStore.getState().setActiveChat(key)
    return {
      count: msgs.length,
      roles: msgs.map((m) => m.role),
      assistantSegKinds: msgs[1].segments.map((s) => s.kind),
      assistantStatuses: msgs[1].statuses,
      assistantText: msgs[1].text
    }
  })
  // 2 user + 1 grouped assistant turn (both assistant lines + both tool statuses).
  if (JSON.stringify(hydration.roles) !== JSON.stringify(['user', 'assistant', 'user'])) {
    throw new Error(`resume grouping wrong: ${JSON.stringify(hydration.roles)}`)
  }
  if (JSON.stringify(hydration.assistantSegKinds) !== JSON.stringify(['text', 'tools', 'text'])) {
    throw new Error(`assistant segments wrong: ${JSON.stringify(hydration.assistantSegKinds)}`)
  }
  if (hydration.assistantStatuses.length !== 2) {
    throw new Error(`assistant should carry 2 tool statuses: ${JSON.stringify(hydration.assistantStatuses)}`)
  }
  if (!hydration.assistantText.includes('Sure, on it.') || !hydration.assistantText.includes('sticky now')) {
    throw new Error(`assistant flat text lost content: ${hydration.assistantText}`)
  }
  // The rebuilt thread actually renders (past turns visible, not an empty tree).
  await win.waitForFunction(
    () => (document.querySelectorAll('.msg').length ?? 0) >= 3,
    null,
    { timeout: 5000 }
  )
  const threadText = (await win.textContent('.pane--chat')) ?? ''
  if (!threadText.includes('Make the header sticky') || !threadText.includes('sticky now')) {
    throw new Error('resumed thread should show its past user + assistant turns')
  }
  // Re-hydrating a populated slice is a no-op (never clobbers a live chat).
  const guarded = await win.evaluate(() => {
    const key = 'resume-test#sdk-abc'
    window.__praxisStore.getState().hydrate(key, [])
    return window.__praxisStore.getState().byKey[key].messages.length
  })
  if (guarded !== 3) throw new Error(`hydrate should not clobber a populated slice, got ${guarded}`)

  console.log(
    'CHAT-RENDER OK — markdown, toolbar, auth banner, branch pill, workspace store, rail collapse, image paste, file drop, composer responsive, actions menu + viewport, resume hydration'
  )
} catch (err) {
  console.error('CHAT-RENDER FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  await app?.close()
}
