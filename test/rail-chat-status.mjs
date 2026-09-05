/**
 * Rail chat statuses + inline rename (LKM-65).
 *
 * Each chat row leads with a status dot: hollow = stale/idle, filled grey and
 * blinking = a turn in flight, filled green = a turn finished while the user was
 * looking at another chat (go check it). The dots sit in the folder icon's own
 * 16px slot, so they share its centre line while the chat NAMES keep their old
 * indent — both are asserted numerically here, since that's the whole point of
 * the layout. The hover pencil then renames a chat in place.
 *
 * Chat slices are seeded straight into the exposed stores (no real agent turns).
 *
 * Run with: bun run test:rail-status
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'
import { _electron as electron } from 'playwright'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = join(root, 'test', 'fixtures', 'static-app')
const artifacts = join(root, 'test', 'artifacts')
mkdirSync(artifacts, { recursive: true })
const userData = mkdtempSync(join(tmpdir(), 'praxis-rail-status-'))

let app
try {
  app = await electron.launch({
    executablePath: electronPath,
    args: [join(root, 'out', 'main', 'index.js')],
    cwd: root,
    env: { ...process.env, PRAXIS_USER_DATA: userData }
  })
  const win = await app.firstWindow()
  await win.waitForSelector('.empty__open', { timeout: 30000 })
  await app.evaluate(async ({ dialog }, f) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] })
  }, fixture)
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.send('menu:action', 'open-project')
  )
  await win.waitForSelector('.rail__chats', { state: 'attached', timeout: 60000 })

  // The rail mounts before openProject finishes loading annotations and writing
  // its final sessionKeys snapshot. Seed only after that snapshot has a URL.
  await win.waitForFunction(
    (root) => window.__praxisWorkspace.getState().projects.some((p) => p.root === root && p.url),
    fixture,
    { timeout: 60000 }
  )

  // Three live chats — one per status — plus a past chat (always stale).
  await win.evaluate((fixtureRoot) => {
    window.__praxisHistory.setState({ load: async () => {} })
    const key = window.__praxisWorkspace.getState().activeKey
    const msg = (text) => [{ id: `s-${text}`, role: 'user', text, statuses: [], segments: [] }]
    const slice = (extra) => ({
      messages: msg(extra.title),
      isRunning: false,
      streamingId: null,
      isolation: 'live',
      usage: { input: 0, output: 0, cached: 0 },
      workedMs: 0,
      turnStartedAt: null,
      needsReview: false,
      ...extra
    })
    const keys = [key, `${key}#done`, `${key}#working`]
    window.__praxisStore.setState((s) => ({
      byKey: {
        ...s.byKey,
        [key]: slice({ title: 'Stale chat' }),
        [`${key}#done`]: slice({ title: 'Finished chat', needsReview: true }),
        [`${key}#working`]: slice({ title: 'Thinking chat', isRunning: true })
      }
    }))
    window.__praxisWorkspace.getState().patchEntry(key, {
      sessionKeys: keys,
      activeSessionKey: key
    })
    window.__praxisSpawns.getState().add(`${key}#working`, {
      id: 'nested-agent',
      branch: 'praxis/comment-nested',
      label: 'Review mobile layout',
      modelLabel: 'Claude sonnet',
      status: 'running'
    })
    window.__praxisHistory.setState((s) => ({
      byKey: {
        ...s.byKey,
        [key]: [
          {
            id: 'fake-past-1',
            projectRoot: fixtureRoot,
            projectKey: key,
            title: 'Past chat',
            transcript: [],
            filesTouched: [],
            startedAt: 1754300000000
          }
        ]
      }
    }))
  }, fixture)

  await win.waitForFunction(
    () =>
      document.querySelectorAll('.rail__chats > .rail__chat-item').length === 3 &&
      document.querySelectorAll('.rail__agents .rail__chat-item').length === 1 &&
      document.querySelector('.rail__section-toggle'),
    undefined,
    { timeout: 5000 }
  )
  // History folds shut by default — unfold it so its rows are on screen.
  await win.evaluate(() => document.querySelector('.rail__section-toggle').click())
  await win.waitForFunction(
    () => document.querySelectorAll('.rail__history .rail__chat-item').length === 1,
    undefined,
    { timeout: 3000 }
  )

  // All live chats are peers and render newest-first. History is separate.
  const seen = await win.evaluate(() =>
    [...document.querySelectorAll('.rail__chats > .rail__chat-item')].map((li) => ({
      name: li.querySelector('.rail__chat-name')?.textContent ?? '',
      status:
        [...(li.querySelector('.rail__chat-status')?.classList ?? [])]
          .find((c) => c.startsWith('rail__chat-status--'))
          ?.replace('rail__chat-status--', '') ?? null
    }))
  )
  const want = [
    ['Thinking chat', 'working'],
    ['Finished chat', 'done'],
    ['Stale chat', 'idle']
  ]
  for (const [i, [name, status]] of want.entries()) {
    if (seen[i]?.name !== name || seen[i]?.status !== status)
      throw new Error(
        `row ${i}: expected ${name}/${status}, got ${seen[i]?.name}/${seen[i]?.status}`
      )
  }
  if (await win.locator('.rail__model, .rail__section-label:not(.rail__section-toggle)').count())
    throw new Error('chat lists should have no model labels or Chats heading')
  const historyName = await win.textContent('.rail__history .rail__chat-name')
  if (historyName !== 'Past chat') throw new Error(`history expected Past chat, got ${historyName}`)
  const nested = await win.evaluate(() => ({
    name: document.querySelector('.rail__agents .rail__chat-name')?.textContent,
    model: document.querySelector('.rail__agents .rail__model')?.textContent
  }))
  if (nested.name !== 'Review mobile layout' || nested.model !== undefined) {
    throw new Error(`nested agent missing or mislabeled: ${JSON.stringify(nested)}`)
  }

  // Alignment: EVERY leading glyph in a project's block — the status dots, the
  // History fold chevron — centres on the active project's
  // folder glyph, and every label starts at the project name's indent.
  const geom = await win.evaluate(() => {
    const mid = (el) => {
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, left: r.left }
    }
    const glyph = (sel) => mid(document.querySelector(sel)).x
    // The section headings are bare text inside their box (padding, and for the
    // History toggle a leading chevron, sit between the border box and the first
    // glyph), so measure the text itself rather than the element's rect.
    const textLeft = (sel) => {
      const el = document.querySelector(sel)
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      let node = walker.nextNode()
      while (node && !node.textContent.trim()) node = walker.nextNode()
      const range = document.createRange()
      range.selectNode(node)
      return range.getBoundingClientRect().left
    }
    // Nested background-agent rows are deliberately indented under their parent
    // chat, so they're not part of this grid.
    const flat = '.rail__chats > .rail__chat-item, .rail__history > .rail__chat-item'
    return {
      folder: glyph('.rail__item--active .rail__glyph'),
      glyphs: [
        ...[...document.querySelectorAll(flat)].map(
          (li) => mid(li.querySelector('.rail__chat-status')).x
        ),
        glyph('.rail__section-chevron')
      ],
      labelLefts: [
        ...[...document.querySelectorAll(flat)].map(
          (li) => mid(li.querySelector('.rail__chat-name')).left
        ),
        textLeft('.rail__section-toggle')
      ],
      projectNameLeft: mid(document.querySelector('.rail__item--active .rail__name')).left
    }
  })
  for (const x of geom.glyphs) {
    if (Math.abs(x - geom.folder) > 0.5)
      throw new Error(`rail glyph centre ${x} ≠ folder centre ${geom.folder}`)
  }
  for (const left of geom.labelLefts) {
    if (Math.abs(left - geom.projectNameLeft) > 0.5)
      throw new Error(`rail label left ${left} ≠ project name left ${geom.projectNameLeft}`)
  }

  // Every chat row's trailing meta ends on one line; peer rows all have the same
  // actions, which overlay the meta instead of shortening it.
  const metaRights = await win.evaluate(() =>
    [
      ...document.querySelectorAll(
        '.rail__chats > .rail__chat-item, .rail__history > .rail__chat-item'
      )
    ]
      .map((li) => li.querySelector('.rail__model, .rail__chat-time, .rail__chat-badge'))
      .filter(Boolean)
      .map((el) => el.getBoundingClientRect().right)
  )
  if (metaRights.length < 1)
    throw new Error(`expected several meta chips, got ${metaRights.length}`)
  for (const right of metaRights) {
    if (Math.abs(right - metaRights[0]) > 0.5)
      throw new Error(`chat meta right edge ${right} ≠ ${metaRights[0]}`)
  }

  await win.screenshot({ path: join(artifacts, '20-rail-chat-status.png') })

  // Hovering a row with actions reveals them OVER its meta (which fades out) and
  // arms them for clicks — they're pointer-events:none while hidden so an
  // invisible × can't eat a click meant for the row itself.
  // A nested agent list is a sibling between the first and second chat rows,
  // so :nth-child(2) would select that list rather than Finished chat.
  const finishedSelector =
    '.rail__chats > .rail__chat-item:has(> .rail__chat[title="Finished chat"])'
  await win.locator(finishedSelector).hover({ position: { x: 40, y: 8 } })
  await win.waitForFunction(
    (selector) => {
      const li = document.querySelector(selector)
      const cs = (sel) => getComputedStyle(li.querySelector(sel))
      return (
        cs('.rail__chat-actions').opacity === '1' &&
        cs('.rail__chat-actions').pointerEvents === 'auto'
      )
    },
    finishedSelector,
    { timeout: 3000 }
  )
  await win.screenshot({ path: join(artifacts, '20-rail-chat-hover.png') })
  // Every peer chat has both actions.
  await win.evaluate(() => {
    const rows = [...document.querySelectorAll('.rail__chats > .rail__chat-item')]
    if (rows.some((li) => !li.classList.contains('rail__chat-item--actions')))
      throw new Error('every live chat should carry the same row actions')
  })

  // Opening a finished chat clears its green dot — reading it IS the review.
  await win.evaluate(() => {
    const key = window.__praxisWorkspace.getState().activeKey
    window.__praxisStore.getState().setActiveChat(`${key}#done`)
  })
  await win.waitForFunction(() => !document.querySelector('.rail__chat-status--done'), undefined, {
    timeout: 3000
  })

  // Any peer chat can be renamed.
  await win.evaluate(() => {
    document.querySelector('.rail__chats .rail__chat-rename').click()
  })
  await win.waitForSelector('.rail__chat-input', { timeout: 3000 })
  await win.fill('.rail__chat-input', 'Renamed by hand')
  await win.press('.rail__chat-input', 'Enter')
  await win.waitForFunction(
    () =>
      [...document.querySelectorAll('.rail__chats .rail__chat-name')].some(
        (node) => node.textContent === 'Renamed by hand'
      ),
    undefined,
    { timeout: 3000 }
  )
  await win.waitForFunction(() => !document.querySelector('.rail__chat-input'), undefined, {
    timeout: 3000
  })

  // Escape reverts instead of committing.
  await win.evaluate(() => {
    document.querySelector('.rail__chats .rail__chat-rename').click()
  })
  await win.waitForSelector('.rail__chat-input', { timeout: 3000 })
  await win.fill('.rail__chat-input', 'Should not stick')
  await win.press('.rail__chat-input', 'Escape')
  await win.waitForFunction(
    () =>
      !document.querySelector('.rail__chat-input') &&
      [...document.querySelectorAll('.rail__chats .rail__chat-name')].some(
        (node) => node.textContent === 'Renamed by hand'
      ),
    undefined,
    { timeout: 3000 }
  )

  console.log('rail-chat-status: OK')
} finally {
  await app?.close()
  rmSync(userData, { recursive: true, force: true })
}
