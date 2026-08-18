/**
 * Workspace + chat restore after a hard renderer reload (crash-recovery / sleep).
 * The MAIN process survives a renderer reload with its live agent sessions; the
 * fresh renderer must reattach to them and repaint the chat transcripts, and when
 * main has nothing (a real relaunch) it must not wedge on a stale persisted
 * workspace. We drive this through REAL main state (no Claude creds needed —
 * openProject registers a session, and agent:send records the user turn on the
 * live record before the turn 401s), plus store-level checks of the seeding path.
 *
 * Covered here:
 *   A. messagesFromTranscript + hydrate: seeds a slice, honors the only-if-empty
 *      guard, and (isRunning) opens a streaming message that continuing deltas
 *      append to — no double render.
 *   B. Reattach: a live main session + persisted workspace, hard-reload the
 *      renderer, and assert the project + its chat transcript come back.
 *   C. Resilience: a persisted-but-DEAD workspace (nothing live in main, no
 *      launchSpec) stays on Welcome instead of wedging.
 *
 * Run with: bun run test:restore
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'
import { _electron as electron } from 'playwright'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = join(root, 'test', 'fixtures', 'static-app')

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg)
}
const reload = (app) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.reload())

let app
try {
  app = await electron.launch({
    executablePath: electronPath,
    args: [join(root, 'out', 'main', 'index.js')],
    cwd: root
  })
  let win = await app.firstWindow()
  await win.waitForSelector('.empty__open', { timeout: 15000 })

  // ── A. hydrate: transcript → messages, only-if-empty guard, streaming tail ──
  const a = await win.evaluate(() => {
    const chat = window.__praxisStore.getState()
    const toMsgs = window.__praxisMessagesFromTranscript
    const msgs = toMsgs([
      { role: 'user', text: 'change the title', at: 1 },
      { role: 'assistant', text: 'Sure.', at: 2 },
      { role: 'status', text: 'Edit App.tsx', at: 3 }
    ])
    chat.setActiveChat('K')
    chat.hydrate('K', msgs, false)
    const seeded = window.__praxisStore.getState().byKey['K'].messages.map((m) => ({
      role: m.role,
      text: m.text
    }))
    // Guard: a second seed with different content must NOT clobber the populated slice.
    chat.hydrate('K', toMsgs([{ role: 'user', text: 'DIFFERENT', at: 9 }]), false)
    const afterGuard = window.__praxisStore.getState().byKey['K'].messages.map((m) => m.text)
    return { seeded, afterGuard }
  })
  assert(a.seeded.length === 2, `seed → user + assistant messages, got ${a.seeded.length}`)
  assert(
    a.seeded[0].role === 'user' && a.seeded[0].text === 'change the title',
    'user message seeded'
  )
  assert(
    a.seeded[1].role === 'assistant' && a.seeded[1].text === 'Sure.',
    'assistant message seeded'
  )
  assert(!a.afterGuard.includes('DIFFERENT'), 'only-if-empty guard: populated slice not clobbered')

  // isRunning seed opens a streaming assistant message; a continuing delta appends
  // to IT (continuation, not a duplicate of the seeded history).
  const b = await win.evaluate(() => {
    const chat = window.__praxisStore.getState()
    const toMsgs = window.__praxisMessagesFromTranscript
    chat.hydrate('R', toMsgs([{ role: 'user', text: 'go', at: 1 }]), true)
    const before = window.__praxisStore.getState().byKey['R']
    chat.setActiveChat('R')
    chat.appendDelta('streamed', 'R')
    const after = window.__praxisStore.getState().byKey['R']
    return {
      running: before.isRunning,
      hadStreamId: !!before.streamingId,
      msgCount: after.messages.length,
      tailText: after.messages.at(-1).text
    }
  })
  assert(b.running === true, 'isRunning slice restored as running')
  assert(b.hadStreamId, 'a streaming assistant message was opened for continuing deltas')
  assert(b.msgCount === 2, `user + one streaming assistant message, got ${b.msgCount}`)
  assert(
    b.tailText === 'streamed',
    'continuing delta appends to the streaming tail (no double render)'
  )

  // ── B. Reattach to a live main session across a hard reload ──────────────────
  // Register a live session in main + record a user turn on its live record. The
  // session runs 'acceptEdits' — the persisted entry below claims 'auto', so the
  // restore has to take main's word for it (a picker that keeps showing the stale
  // value would be telling the user the agent asks less than it really does).
  await win.evaluate(
    (f) => window.api.agent.openProject(f, { permissionMode: 'acceptEdits' }),
    fixture
  )
  await win.evaluate(() => window.api.agent.send('hello from before the reload'))
  // Persist a workspace entry for it (no launchSpec/url → the reattach path uses
  // the live session; applyProject won't try to relaunch a dev server).
  const key = await win.evaluate((f) => {
    const ws = window.__praxisWorkspace.getState()
    const k = ws.openOrActivate(f)
    const entry = window.__praxisWorkspace.getState().projects.find((p) => p.key === k)
    const stale = {
      ...entry,
      chatSettings: {
        [k]: { model: 'default', effort: 'high', provider: 'claude', permissionMode: 'auto' }
      }
    }
    localStorage.setItem('praxis:workspace', JSON.stringify({ projects: [stale], activeKey: k }))
    return k
  }, fixture)

  await reload(app)
  win = await app.firstWindow()
  // Restore is async (workspaceSnapshot → applyProject); wait for it to land.
  await win.waitForFunction(
    (k) => {
      const ws = window.__praxisWorkspace?.getState?.()
      const slice = window.__praxisStore?.getState?.().byKey?.[k]
      return !!ws && ws.projects.some((p) => p.key === k) && !!slice
    },
    key,
    { timeout: 15000 }
  )
  await win.waitForSelector('.composer__input', { timeout: 15000 })
  const reattach = await win.evaluate((k) => {
    const ws = window.__praxisWorkspace.getState()
    const slice = window.__praxisStore.getState().byKey[k]
    return {
      hasProject: ws.projects.some((p) => p.key === k),
      activeKey: ws.activeKey,
      userMsg: slice?.messages.find((m) => m.role === 'user')?.text ?? null,
      mode: window.__praxisPermissions.getState().mode,
      stored: ws.projects.find((p) => p.key === k)?.chatSettings?.[k]?.permissionMode ?? null
    }
  }, key)
  assert(reattach.hasProject, 'reattached: the live project is back in the rail')
  assert(reattach.activeKey === key, 'reattached: the live project is active')
  assert(
    reattach.userMsg === 'hello from before the reload',
    `reattached chat transcript seeded from the live record, got "${reattach.userMsg}"`
  )
  assert(
    reattach.stored === 'acceptEdits',
    `reattached: the chat's stored mode comes from main's live session, got "${reattach.stored}"`
  )
  assert(
    reattach.mode === 'acceptEdits',
    `reattached: the composer's picker shows the session's real mode, got "${reattach.mode}"`
  )
  // The seeded transcript actually renders in the chat pane.
  const dom = await win.textContent('.pane--chat')
  assert(dom.includes('hello from before the reload'), 'seeded transcript renders in the chat DOM')

  // ── B2. Full teardown then reopen must restore Main, not dump it to History ─
  await win.evaluate((f) => window.api.agent.closeProject(f), fixture)
  await win.evaluate((f) => window.api.agent.openProject(f), fixture)
  const reopened = await win.evaluate((k) => {
    return window.api.agent.workspaceSnapshot().then((snap) => {
      const chat = snap.projects
        .find((p) => p.projectKey === k)
        ?.chats.find((c) => c.sessionKey === k)
      return chat?.record.transcript.find((t) => t.role === 'user')?.text ?? null
    })
  }, key)
  const historyAfterReopen = await win.evaluate((f) => window.api.sessions.list(f), fixture)
  assert(
    reopened === 'hello from before the reload',
    `reopen restores Main's transcript, got "${reopened}"`
  )
  assert(
    !historyAfterReopen.some((r) =>
      r.transcript.some((t) => t.text === 'hello from before the reload')
    ),
    'restored Main must not also appear as a History row'
  )

  // ── C. A persisted-but-dead workspace must not wedge the app ─────────────────
  await win.evaluate((f) => window.api.agent.closeProject(f), fixture)
  await win.evaluate(() => {
    localStorage.setItem(
      'praxis:workspace',
      JSON.stringify({
        projects: [
          {
            root: '/tmp/praxis-dead-proj',
            key: '/tmp/praxis-dead-proj',
            name: 'dead',
            url: null,
            previewKind: 'web',
            branch: null,
            launchSpec: null,
            touchedAt: 1,
            sessionKeys: ['/tmp/praxis-dead-proj'],
            activeSessionKey: '/tmp/praxis-dead-proj'
          }
        ],
        activeKey: '/tmp/praxis-dead-proj'
      })
    )
  })
  await reload(app)
  win = await app.firstWindow()
  await win.waitForSelector('.empty__open', { timeout: 15000 })
  // Give restore a beat to (not) reopen, then confirm the rail stayed empty.
  await new Promise((r) => setTimeout(r, 800))
  const dead = await win.evaluate(() => window.__praxisWorkspace.getState().projects.length)
  assert(dead === 0, `persisted-but-dead workspace stays on Welcome, got ${dead} project(s)`)

  console.log(
    'RESTORE-RELOAD OK — seed guard + streaming tail, live reattach seeds chat, Main survives close/open, dead workspace no-wedge'
  )
} catch (err) {
  console.error('RESTORE-RELOAD FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  // Don't leak persisted workspace/recents into sibling tests (shared userData).
  try {
    const w = await app?.firstWindow()
    await w?.evaluate(() => {
      localStorage.removeItem('praxis:workspace')
      localStorage.removeItem('praxis:recent-projects')
    })
  } catch {
    /* app may already be gone */
  }
  await app?.close()
}
