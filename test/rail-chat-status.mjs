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

import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'
import { _electron as electron } from 'playwright'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = join(root, 'test', 'fixtures', 'static-app')
const artifacts = join(root, 'test', 'artifacts')
mkdirSync(artifacts, { recursive: true })

let app
try {
  app = await electron.launch({
    executablePath: electronPath,
    args: [join(root, 'out', 'main', 'index.js')],
    cwd: root
  })
  const win = await app.firstWindow()
  // Either the empty state (fresh userData) or an already-restored workspace —
  // opening the fixture below makes it the active project either way.
  await win.waitForSelector('.empty__open, .rail', { timeout: 30000 })
  await app.evaluate(async ({ dialog }, f) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] })
  }, fixture)
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.send('menu:action', 'open-project')
  )
  await win.waitForSelector('.rail__chats', { state: 'attached', timeout: 60000 })

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
      document.querySelectorAll('.rail__history .rail__chat-item').length === 1,
    undefined,
    { timeout: 5000 }
  )

  // Main is pinned first; secondary chats render newest-first. History is separate.
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
    ['Main', 'idle'],
    ['Thinking chat', 'working'],
    ['Finished chat', 'done']
  ]
  for (const [i, [name, status]] of want.entries()) {
    if (seen[i]?.name !== name || seen[i]?.status !== status)
      throw new Error(
        `row ${i}: expected ${name}/${status}, got ${seen[i]?.name}/${seen[i]?.status}`
      )
  }
  const historyName = await win.textContent('.rail__history .rail__chat-name')
  if (historyName !== 'Past chat') throw new Error(`history expected Past chat, got ${historyName}`)
  const nested = await win.evaluate(() => ({
    name: document.querySelector('.rail__agents .rail__chat-name')?.textContent,
    model: document.querySelector('.rail__agents .rail__model')?.textContent
  }))
  if (nested.name !== 'Review mobile layout' || nested.model !== 'Claude sonnet') {
    throw new Error(`nested agent missing or mislabeled: ${JSON.stringify(nested)}`)
  }

  // Alignment: every dot centres on the active project's folder glyph, and the
  // chat names still start where they always did (the project name's indent).
  const geom = await win.evaluate(() => {
    const mid = (el) => {
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, left: r.left }
    }
    return {
      folder: mid(document.querySelector('.rail__item--active .rail__glyph')).x,
      dots: [
        ...document.querySelectorAll('.rail__chats > .rail__chat-item .rail__chat-status')
      ].map((d) => mid(d).x),
      nameLefts: [
        ...document.querySelectorAll('.rail__chats > .rail__chat-item .rail__chat-name')
      ].map((n) => mid(n).left),
      projectNameLeft: mid(document.querySelector('.rail__item--active .rail__name')).left
    }
  })
  for (const x of geom.dots) {
    if (Math.abs(x - geom.folder) > 0.5)
      throw new Error(`status dot centre ${x} ≠ folder centre ${geom.folder}`)
  }
  for (const left of geom.nameLefts) {
    if (Math.abs(left - geom.projectNameLeft) > 0.5)
      throw new Error(`chat name left ${left} ≠ project name left ${geom.projectNameLeft}`)
  }

  await win.screenshot({ path: join(artifacts, '20-rail-chat-status.png') })

  // Opening a finished chat clears its green dot — reading it IS the review.
  await win.evaluate(() => {
    const key = window.__praxisWorkspace.getState().activeKey
    window.__praxisStore.getState().setActiveChat(`${key}#done`)
  })
  await win.waitForFunction(() => !document.querySelector('.rail__chat-status--done'), undefined, {
    timeout: 3000
  })

  // Main is a role and cannot be renamed. Rename the first secondary chat instead.
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
}
