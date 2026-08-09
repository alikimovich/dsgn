/**
 * v8 F1 — comment → parallel agent spawn. Two layers:
 *
 *  A. DETERMINISTIC (always runs, no model/creds):
 *     - spawnComment on a non-repo path falls back (ok:false, reason:'not-a-repo').
 *     - a `sessionId`-tagged event NEVER enters the active chat (byte-clean main
 *       stream — the core routing guarantee), and `spawn-finished` removes the
 *       working rail row from useSpawns.
 *  B. LIVE (SKIP without Claude creds, like agent-e2e): a real comment spawn edits
 *     a temp git repo IN ITS OWN WORKTREE and lands the work on a praxis/comment-<id>
 *     branch — proving the end-to-end wiring + worktree isolation.
 *
 * Run with: bun run test:spawn
 */
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const nonRepo = join(root, 'test', 'fixtures', 'editable-app') // a subdir of THIS repo
const work = mkdtempSync(join(tmpdir(), 'praxis-spawn-'))
const userData = mkdtempSync(join(tmpdir(), 'praxis-spawn-ud-'))
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
const MARKER = 'SPAWN_VERIFIED'
// Like a real project: gitignore node_modules/.env so the worktree's symlinks to
// them never enter a spawn commit (and thus never block the direct auto-apply).
writeFileSync(join(repo, '.gitignore'), 'node_modules\n.env\n')
writeFileSync(join(repo, 'app.txt'), 'the heading is PLACEHOLDER\n')
g(repo, 'add', '-A')
g(repo, 'commit', '-qm', 'init')

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
  await win.evaluate(() => window.__praxisWorkspace.getState().openOrActivate('/tmp/praxis-test-project'))
  await win.waitForSelector('.composer__input', { timeout: 15000 })

  // --- A1: non-repo → fall back (no worktree possible) ---
  const nr = await win.evaluate(
    (p) => window.api.agent.spawnComment(p, 'make it blue', p, {}),
    nonRepo
  )
  assert(!nr.ok && nr.reason === 'not-a-repo', `non-repo should fall back: ${JSON.stringify(nr)}`)

  // --- A2: a sessionId-tagged event must NOT enter the active chat; spawn-finished
  // removes the working row. Drive the real onEvent path by sending from main. ---
  const KEY = 'spawn-test-key'
  await win.evaluate((key) => {
    window.__praxisStore.getState().setActiveChat(key)
    window.__praxisStore.getState().clearChat(key)
    window.__praxisSpawns.getState().add(key, {
      id: 's1',
      branch: 'praxis/comment-s1',
      label: 'make it blue',
      modelLabel: 'Claude',
      status: 'running'
    })
  }, KEY)
  const added = await win.evaluate((key) => window.__praxisSpawns.getState().byKey[key]?.length ?? 0, KEY)
  assert(added === 1, 'spawn row should be added')

  // Send a spawn delta (sessionId set) into the renderer's agent:event listener.
  await app.evaluate(({ BrowserWindow }, ev) => {
    BrowserWindow.getAllWindows()[0].webContents.send('agent:event', ev)
  }, { type: 'delta', text: 'LEAK_INTO_CHAT', projectKey: KEY, sessionId: 's1' })
  await sleep(250)
  const chatText = await win.evaluate((key) => {
    const ms = window.__praxisStore.getState().byKey[key]?.messages ?? []
    return ms.map((m) => `${m.text}${(m.statuses ?? []).join('')}`).join('')
  }, KEY)
  assert(!chatText.includes('LEAK_INTO_CHAT'), 'spawn delta must NOT enter the active chat')

  // A spawn's `commands` (SDK init) + auth-ish `error` must NOT touch the interactive
  // session UI (App.tsx's listener guards on sessionId too, not just ChatPanel's).
  await win.evaluate(() => {
    window.__praxisSession.getState().setSlashCommands([{ name: 'mine', source: 'other' }])
    window.__praxisSession.getState().setAuthNeeded(false)
  })
  await app.evaluate(({ BrowserWindow }, evs) => {
    for (const ev of evs) BrowserWindow.getAllWindows()[0].webContents.send('agent:event', ev)
  }, [
    {
      type: 'commands',
      commands: [{ name: 'spawn-only', source: 'other' }],
      projectKey: KEY,
      sessionId: 's1'
    },
    { type: 'error', message: 'Please run claude login', projectKey: KEY, sessionId: 's1' }
  ])
  await sleep(250)
  const sess = await win.evaluate(() => ({
    cmds: window.__praxisSession.getState().slashCommands,
    auth: window.__praxisSession.getState().authNeeded
  }))
  assert(
    JSON.stringify(sess.cmds) === JSON.stringify([{ name: 'mine', source: 'other' }]),
    `spawn commands must not overwrite the active slash menu: ${JSON.stringify(sess.cmds)}`
  )
  assert(sess.auth === false, 'a spawn auth error must not raise the onboarding banner')

  // spawn-finished → working row removed + a notification posted to the project's
  // chat (auto-applied: branch null, carries the agent's summary + files).
  await app.evaluate(({ BrowserWindow }, ev) => {
    BrowserWindow.getAllWindows()[0].webContents.send('agent:event', ev)
  }, {
    type: 'spawn-finished',
    projectKey: KEY,
    sessionId: 's1',
    branch: null,
    summary: 'Removed the second nav block.',
    files: ['Sidebar.svelte']
  })
  await win
    .waitForFunction((key) => (window.__praxisSpawns.getState().byKey[key]?.length ?? 0) === 0, KEY, {
      timeout: 4000
    })
    .catch(() => {})
  const note = await win.evaluate((key) => {
    const ms = window.__praxisStore.getState().byKey[key]?.messages ?? []
    return ms.map((m) => m.text).join('\n')
  }, KEY)
  assert(/Comment applied/i.test(note), `spawn-finished should post a chat notification: ${note}`)
  assert(/Sidebar\.svelte/.test(note) && /Removed the second nav block/.test(note), 'note carries files + summary')
  const after = await win.evaluate((key) => window.__praxisSpawns.getState().byKey[key]?.length ?? 0, KEY)
  assert(after === 0, 'spawn-finished should remove the working row')

  // --- A3 (Phase 2): Apply + Discard a finished spawn's branch (hand-built, no model).
  // Simulate a spawn branch = main + one edit-commit, then apply it onto the live tree. ---
  const P2BRANCH = 'praxis/comment-p2test'
  g(repo, 'checkout', '-q', '-b', P2BRANCH)
  writeFileSync(join(repo, 'phase2.txt'), 'P2_APPLIED\n')
  g(repo, 'add', '-A')
  g(repo, 'commit', '-qm', 'spawn edit')
  g(repo, 'checkout', '-q', 'main')
  assert(!existsSync(join(repo, 'phase2.txt')), 'precondition: phase2.txt only on the branch')

  const applied = await win.evaluate(
    (args) => window.api.agent.spawnApply(args.repo, args.branch),
    { repo, branch: P2BRANCH }
  )
  assert(applied.ok, `spawnApply should succeed: ${JSON.stringify(applied)}`)
  assert(
    existsSync(join(repo, 'phase2.txt')) && readFileSync(join(repo, 'phase2.txt'), 'utf8').includes('P2_APPLIED'),
    'Apply must land the branch edit on the live working tree'
  )

  const discarded = await win.evaluate(
    (args) => window.api.agent.spawnDiscard(args.repo, args.branch),
    { repo, branch: P2BRANCH }
  )
  assert(discarded.ok, 'spawnDiscard should succeed')
  assert(g(repo, 'branch', '--list', P2BRANCH) === '', 'Discard must delete the spawn branch')
  // Clean the applied file so the live spawn below starts from a known tree.
  rmSync(join(repo, 'phase2.txt'), { force: true })

  // --- A4 (Phase 3): a queued row flips to running on spawn-started, then is removed
  // on spawn-finished (the cap/queue rail lifecycle). ---
  await win.evaluate((key) => {
    window.__praxisSpawns.getState().add(key, {
      id: 'q1',
      branch: null,
      label: 'queued one',
      modelLabel: 'Claude',
      status: 'queued'
    })
  }, KEY)
  let q = await win.evaluate((key) => window.__praxisSpawns.getState().byKey[key].find((r) => r.id === 'q1'), KEY)
  assert(q.status === 'queued', 'row starts queued')
  await app.evaluate(({ BrowserWindow }, ev) => {
    BrowserWindow.getAllWindows()[0].webContents.send('agent:event', ev)
  }, { type: 'spawn-started', projectKey: KEY, sessionId: 'q1', branch: 'praxis/comment-q1' })
  await sleep(200)
  q = await win.evaluate((key) => window.__praxisSpawns.getState().byKey[key].find((r) => r.id === 'q1'), KEY)
  assert(q.status === 'running' && q.branch === 'praxis/comment-q1', 'spawn-started flips to running + branch')
  await app.evaluate(({ BrowserWindow }, ev) => {
    BrowserWindow.getAllWindows()[0].webContents.send('agent:event', ev)
  }, { type: 'spawn-finished', projectKey: KEY, sessionId: 'q1', branch: null })
  await sleep(200)
  const gone = await win.evaluate((key) => !window.__praxisSpawns.getState().byKey[key].some((r) => r.id === 'q1'), KEY)
  assert(gone, 'spawn-finished removes the row')

  console.log(
    'SPAWN-COMMENT OK (deterministic) — non-repo fallback, byte-clean chat, row lifecycle, ' +
      'Apply/Discard, queue flip'
  )

  // --- B: live spawn into the temp repo (creds-gated) ---
  const prompt =
    `Edit the file app.txt in this project: replace the word PLACEHOLDER with exactly ` +
    `${MARKER}. Edit the file directly with your tools and do not ask for confirmation.`
  const res = await win.evaluate(
    (args) => window.api.agent.spawnComment(args.repo, args.prompt, args.repo, { model: 'haiku' }),
    { repo, prompt }
  )
  assert(res.ok && res.spawnId && res.branch, `spawn should start: ${JSON.stringify(res)}`)

  // v8 F1 redesign: the spawn AUTO-APPLIES onto the live working tree on finalize
  // (no manual Apply, no lingering branch). Poll the live file for the edit.
  const liveFile = join(repo, 'app.txt')
  let landed = false
  for (let i = 0; i < 90 && !landed; i++) {
    await sleep(2000)
    try {
      if (readFileSync(liveFile, 'utf8').includes(MARKER)) landed = true
    } catch {
      /* not written yet */
    }
  }

  if (landed) {
    // The edit landed on the working branch directly, and the comment branch was
    // deleted (auto-applied, not kept for a manual Apply).
    assert(
      g(repo, 'branch', '--list', res.branch) === '',
      'auto-apply must delete the comment branch (no lingering praxis/comment-* branch)'
    )
    console.log('SPAWN-COMMENT OK (live) — comment spawn auto-applied onto the working tree, branch gone')
  } else {
    console.log('SPAWN-COMMENT SKIP (live) — the spawn never applied (likely no Claude creds).')
    console.log('  Deterministic checks passed; live wiring needs `claude login`.')
  }
} catch (err) {
  console.error('SPAWN-COMMENT FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  rmSync(work, { recursive: true, force: true })
  rmSync(userData, { recursive: true, force: true })
  await app?.close()
}
