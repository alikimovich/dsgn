/**
 * v9 per-chat git-worktree isolation — Electron tier. Three layers, all
 * deterministic (no model/creds needed — we never send a real turn):
 *
 *  A. Opening a project on a RUNTIME-CREATED temp git repo gives its default
 *     chat a private `praxis/chat-<id>` worktree under
 *     `<PRAXIS_USER_DATA>/praxis/worktrees/<id>`, and `agent:workspace-snapshot`
 *     reports its isolation state. Its recovery branch is ephemeral: absent while the
 *     chat is idle, recreated at turn start, and deleted after a successful landing.
 *     (agent.ts's `isolatedCwd`/`adoptSession` calling into `chat-isolation.ts`).
 *  B. Feeding synthetic `isolation` `AgentEvent`s (mirrors spawn-comment.mjs's
 *     event-injection pattern, using a fake project key so no real backend is
 *     needed) drives the renderer: the composer's header chip flips
 *     Isolated/Parked, a status note is appended, and a `parked` event routes
 *     the sidebar's history reload (the same `useHistory.load` seam
 *     spawn-finished uses).
 *  C. `closeChat` on that same real repo's default chat (no edits made, so
 *     nothing to merge) tears the checkout AND its `praxis/chat-*` branch down.
 *
 * Existing fixtures under test/fixtures/ live inside the praxis repo itself, so
 * `isRepoRoot` is false for them and agent-multi/spawn-comment/restore-reload
 * keep running on the plain live-cwd path, unaffected by this feature.
 *
 * Run with: bun run test:chat-isolation
 */
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'praxis-chat-isolation-'))
// This test asserts paths under PRAXIS_USER_DATA, so provision our own throwaway
// userData dir regardless of how the test is invoked (run.mjs already gives every
// electron test one, but a solo `bun run test:chat-isolation` would not).
const userData = mkdtempSync(join(tmpdir(), 'praxis-chat-isolation-ud-'))
const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// A standalone temp git repo (worktrees need a real repo TOP LEVEL).
const repo = join(work, 'app')
mkdirSync(repo, { recursive: true })
g(repo, 'init', '-q', '-b', 'main')
g(repo, 'config', 'user.name', 'Test')
g(repo, 'config', 'user.email', 't@t')
// Like a real project: gitignore node_modules/.env so the worktree's symlinks to
// them (created best-effort on every worktree, see worktrees.ts) never enter a
// turn's commit as untracked adds — matches spawn-comment.mjs's fixture repo.
writeFileSync(join(repo, '.gitignore'), 'node_modules\n.env\n')
writeFileSync(join(repo, 'app.txt'), 'hello\n')
g(repo, 'add', '-A')
g(repo, 'commit', '-qm', 'init')

const FAKE_ROOT = '/tmp/praxis-test-project' // never touched on disk — just gets the
// renderer past the empty state (composer visibility only needs a workspace entry)

let app
try {
  app = await electron.launch({
    executablePath: electronPath,
    args: [join(root, 'out', 'main', 'index.js')],
    cwd: root,
    env: { ...process.env, PRAXIS_USER_DATA: userData }
  })
  const win = await app.firstWindow()
  await win.waitForSelector('.empty__open', { timeout: 15000 })
  await win.evaluate((p) => window.__praxisWorkspace.getState().openOrActivate(p), FAKE_ROOT)
  await win.waitForSelector('.composer__input', { timeout: 15000 })

  // --- A: open a runtime-created temp repo -> a checkout exists under
  // PRAXIS_USER_DATA/praxis/worktrees and the live snapshot reports isolation ---
  await win.evaluate((p) => window.api.agent.openProject(p), repo)
  const snap1 = await win.evaluate(() => window.api.agent.workspaceSnapshot())
  const proj = snap1.projects.find((p) => p.root === repo)
  assert(proj, `opened repo should appear in the workspace snapshot: ${JSON.stringify(snap1)}`)
  assert(proj.chats.length === 1, `expected exactly one live chat, got ${proj.chats.length}`)
  const chat = proj.chats[0]
  assert(
    chat.isolation && chat.isolation.state === 'isolated',
    `default chat on a repo root should be isolated: ${JSON.stringify(chat.isolation)}`
  )
  assert(
    chat.isolation.branch && chat.isolation.branch.startsWith('praxis/chat-'),
    `isolation branch should be praxis/chat-<id>: ${chat.isolation.branch}`
  )
  const branch = chat.isolation.branch
  const wtId = branch.replace('praxis/chat-', '')
  const wtDir = join(userData, 'praxis', 'worktrees', wtId)
  assert(existsSync(wtDir), `worktree checkout should exist on disk at ${wtDir}`)
  assert(g(repo, 'branch', '--list', branch).length === 0, `idle branch ${branch} should be retired`)
  // The checkout is a REAL linked worktree of `repo` (not a stray directory).
  assert(
    g(repo, 'worktree', 'list').includes(wtId),
    'git worktree list should show the chat checkout'
  )

  console.log('CHAT-ISOLATION OK (A) — open-project forks a detached chat worktree without a stale branch')

  // --- B: synthetic isolation events -> store state, merged note, parked
  // ConflictCard (mirrors spawn-comment.mjs's event injection: a fake key, no
  // real backend needed). Reuse FAKE_ROOT as the key so the parked handler's
  // `projectKey(root) === event.projectKey` guard (which gates the history
  // reload) is satisfied without importing projectKey() into this page. ---
  const KEY = FAKE_ROOT
  await win.evaluate((key) => {
    window.__praxisStore.getState().setActiveChat(key)
    window.__praxisStore.getState().clearChat(key)
    window.__praxisSession.getState().setProjectRoot(key)
    // Seed a sentinel record so we can tell a real `sessions:list` refresh apart
    // from our seed (the parked note should trigger useHistory.load, replacing it).
    window.__praxisHistory.setState({
      byKey: {
        [key]: [
          {
            id: 'sentinel-record',
            projectKey: key,
            projectRoot: key,
            projectName: 'sentinel',
            startedAt: 0,
            endedAt: 0,
            filesTouched: [],
            transcript: []
          }
        ]
      }
    })
  }, KEY)

  const conflictCardVisible = () => win.evaluate(() => !!document.querySelector('.conflict'))
  assert(!(await conflictCardVisible()), 'no ConflictCard before any isolation event')

  // 'merged' — the happy per-turn path: a subtle note is appended (no active
  // streaming message exists post-`done`, so appendStatus would be a no-op —
  // ChatPanel uses appendNote instead). No chip/card for the happy path.
  await app.evaluate(
    ({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('agent:event', ev),
    { type: 'isolation', state: 'merged', projectKey: KEY, branch: 'praxis/chat-synthtest', files: ['a.txt'] }
  )
  await sleep(300)
  const afterMerged = await win.evaluate(
    (key) => window.__praxisStore.getState().byKey[key]?.isolation,
    KEY
  )
  assert(afterMerged === 'isolated', `'merged' should set isolation to 'isolated', got ${afterMerged}`)
  assert(!(await conflictCardVisible()), 'a clean merge must not show the ConflictCard')
  const noteAfterMerged = await win.evaluate(
    (key) => (window.__praxisStore.getState().byKey[key]?.messages ?? []).map((m) => m.text).join('\n'),
    KEY
  )
  assert(
    /Merged into your branch/.test(noteAfterMerged),
    `a merged turn should post a status note: ${noteAfterMerged}`
  )

  // 'parked' — a conflicted turn: the ConflictCard pins above the composer
  // (with the affected files), and (since this event's projectKey matches
  // useSession's projectRoot) the sidebar's history reloads.
  await app.evaluate(
    ({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('agent:event', ev),
    { type: 'isolation', state: 'parked', projectKey: KEY, branch: 'praxis/chat-synthtest', files: ['a.txt'] }
  )
  await win
    .waitForFunction(
      (key) => window.__praxisStore.getState().byKey[key]?.isolation === 'parked',
      KEY,
      { timeout: 4000 }
    )
    .catch(() => {})
  const afterParked = await win.evaluate(
    (key) => window.__praxisStore.getState().byKey[key]?.isolation,
    KEY
  )
  assert(afterParked === 'parked', `'parked' should set isolation to 'parked', got ${afterParked}`)
  assert(await conflictCardVisible(), 'a parked turn should pin the ConflictCard above the composer')
  const cardFiles = await win.evaluate(() =>
    Array.from(document.querySelectorAll('.conflict__file')).map((f) => f.textContent.trim())
  )
  assert(cardFiles.includes('a.txt'), `the ConflictCard should list the affected files: ${cardFiles}`)
  // The parked note's routing: useHistory.load(root) was called, replacing our
  // sentinel with a real (empty, for this never-real project) list from main.
  await win
    .waitForFunction(
      (key) => {
        const list = window.__praxisHistory.getState().byKey[key]
        return !list?.some((r) => r.id === 'sentinel-record')
      },
      KEY,
      { timeout: 4000 }
    )
    .catch(() => {})
  const historyAfterParked = await win.evaluate(
    (key) => window.__praxisHistory.getState().byKey[key],
    KEY
  )
  assert(
    Array.isArray(historyAfterParked) && !historyAfterParked.some((r) => r.id === 'sentinel-record'),
    `a parked isolation event should route to a history reload (sentinel should be gone): ${JSON.stringify(historyAfterParked)}`
  )

  console.log(
    'CHAT-ISOLATION OK (B) — synthetic isolation events drive the store + merged note, a parked ' +
      'turn pins the ConflictCard (with files) and routes the sidebar history reload'
  )

  // --- C: closeChat on the real repo's default chat with NO edits made ->
  // the checkout and its praxis/chat-* branch are both gone ---
  const closeRes = await win.evaluate(
    (a) => window.api.agent.closeChat(a.root, a.sessionKey),
    { root: repo, sessionKey: chat.sessionKey }
  )
  assert(closeRes.ok, `closeChat should report ok: ${JSON.stringify(closeRes)}`)

  let torndown = false
  for (let i = 0; i < 20 && !torndown; i++) {
    await sleep(250)
    torndown = !existsSync(wtDir) && g(repo, 'branch', '--list', branch) === ''
  }
  assert(!existsSync(wtDir), `closeChat with no changes should remove the checkout at ${wtDir}`)
  assert(
    g(repo, 'branch', '--list', branch) === '',
    `closeChat with no changes should delete the branch ${branch}`
  )

  console.log('CHAT-ISOLATION OK (C) — closeChat with no changes tears down the checkout + branch')
} catch (err) {
  console.error('CHAT-ISOLATION FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  rmSync(work, { recursive: true, force: true })
  rmSync(userData, { recursive: true, force: true })
  await app?.close()
}
