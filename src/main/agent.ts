import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, renameSync } from 'node:fs'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { app, type BrowserWindow, ipcMain } from 'electron'
import type {
  AgentEvent,
  AgentOptions,
  ImageAttachment,
  LiveProjectSnapshot,
  OpenProjectResult,
  PermissionMode,
  QuestionAnswers,
  WorkspaceSnapshot
} from '../shared/api'
import { projectKey } from '../shared/projectKey'
import { pruneAttachments, saveImageAttachment } from './attachments'
import { type ProviderSession, pickProvider } from './backends'
import { seedFromRecord } from './backends/record'
import { EDIT_TOOLS } from './backends/tools'
import type { SpawnContext } from './backends/types'
import {
  adoptSession,
  afterTurn,
  applyParkedBranch,
  beforeTurn,
  discardParkedBranch,
  discardParkedChat,
  dropAll,
  handleReclaimed,
  hasParkRecord,
  initChatIsolation,
  isolatedCwd,
  isolationSnapshot,
  liveChatWorktreeIds,
  releaseChat,
  resolveParkedChat
} from './chat-isolation'
import { clearHistory, recordEdit } from './edit-history'
import { isRepoRoot } from './git'
import { commitLiveTurn } from './live-commit'
import {
  createProjectMemoryStore,
  type ProjectMemoryStore,
  projectMemoryUpdate
} from './project-memory'
import { registerProviderIpc } from './providers'
import { createSessionStore, type SessionStore } from './sessions-store'
import { TurnTerminalTracker } from './turn-terminal'
import {
  applyToWorkingTree,
  autoApplyWorktree,
  branchExists,
  branchPatch,
  commitWorktree,
  createWorktree,
  deleteBranch,
  pruneOrphans,
  removeWorktree,
  type Worktree
} from './worktrees'

const execFileP = promisify(execFile)
const git = (root: string, args: string[]): Promise<{ stdout: string }> =>
  execFileP('git', args, { cwd: root, timeout: 20000 }) as Promise<{ stdout: string }>

// On-disk agent-session history (v5-D). Lazy so it resolves userData after the
// app is ready; under the app's userData dir, out of any user repo.
// `dataDir` migrates the pre-rename `userData/dsgn` dir on first touch: a plain
// rename, then `git worktree repair` per chat worktree — their `.git` files and
// the parent repos' admin records hold absolute paths to the old location.
let _dataDir: string | null = null
function dataDir(): string {
  if (_dataDir) return _dataDir
  const dir = join(app.getPath('userData'), 'praxis')
  const legacy = join(app.getPath('userData'), 'dsgn')
  if (!existsSync(dir) && existsSync(legacy)) {
    try {
      renameSync(legacy, dir)
      const wts = join(dir, 'worktrees')
      if (existsSync(wts)) {
        for (const id of readdirSync(wts)) {
          if (id.startsWith('.')) continue // .index-* snapshots, tmp dirs
          execFile('git', ['worktree', 'repair'], { cwd: join(wts, id) }, () => {})
        }
      }
    } catch (err) {
      console.error('dsgn→praxis userData migration failed:', err)
    }
  }
  _dataDir = dir
  return dir
}
let _store: SessionStore | null = null
const store = (): SessionStore => (_store ??= createSessionStore(dataDir()))
let _memoryStore: ProjectMemoryStore | null = null
const memoryStore = (): ProjectMemoryStore =>
  (_memoryStore ??= createProjectMemoryStore(dataDir()))

/** The memory revision already present in each live provider's context. */
const memoryRevisionBySession = new Map<string, number>()
const contextWithMemory = (
  root: string,
  sessionKey: string | null,
  ctx: SpawnContext
): SpawnContext => {
  const memory = memoryStore().get(root)
  if (sessionKey) memoryRevisionBySession.set(sessionKey, memory.updatedAt)
  return { ...ctx, projectMemory: memory.content }
}

/**
 * Agent sessions — one persistent multi-turn session per open project (keyed by
 * projectKey), each running a `ModelProvider` backend (Claude Agent SDK by
 * default; Codex/etc. behind the v7 seam). This module is backend-agnostic: it
 * owns the per-project `sessions` map, `activeKey`, teardown, the permission-card
 * settle loop, and every `agent:*` IPC handler — all in terms of `ProviderSession`
 * + `AgentEvent`. The provider-specific streaming/tooling lives under `./backends`.
 *
 * Auth: per-user subscription login for every backend (Claude `setup-token` /
 * `login`, Codex sign-in-with-ChatGPT, …) — never API keys committed in-repo.
 */

// v5 (extended v9): one or more persistent sessions per open project, keyed by
// `sessionKey` — `projectKey` itself for the project's default/live chat, and
// `` `${projectKey}#${sdkSessionId or a generated id}` `` for additional chats
// started via `agent:new-chat` or past sessions revived via `agent:resume-session`.
// Only the ACTIVE session (across the whole app, at most one at a time — the one
// the renderer is currently showing) streams events the renderer will actually
// render into a visible chat; the dispose guard keeps backgrounded/replaced
// sessions from leaking events into a chat the renderer isn't showing.
const sessions = new Map<string, ProviderSession>()
/**
 * Hard cap on how long `agent:interrupt` waits for a backend's cancel before
 * resolving anyway. Deliberately longer than any backend's own grace window (see
 * claude.ts's INTERRUPT_GRACE_MS) so a backend that IS handling it properly gets
 * to finish and report `hardStopped`; this only catches one that never answers.
 */
const INTERRUPT_IPC_CAP_MS = 5_000
let activeKey: string | null = null
const activeSession = (): ProviderSession | null =>
  activeKey ? (sessions.get(activeKey) ?? null) : null
// Per-project memory of which of ITS OWN sessionKeys was last active — so
// switching back to a project (agent:set-active) restores whichever chat the
// user was last looking at instead of always resetting to the default session.
// Untouched by projects that never open a second chat: `get(key) === key` then.
const activeSessionKeyByProject = new Map<string, string>()
/** All live sessionKeys belonging to a project (its default + any extra/resumed chats). */
const sessionKeysForProject = (key: string): string[] =>
  [...sessions.keys()].filter((k) => k === key || k.startsWith(`${key}#`))
// The project the renderer LAST asked to make active (via open-project or
// set-active), recorded synchronously. A slow first-time open (the ESM SDK
// `import()`) must not claim `activeKey` if the user has since switched away —
// otherwise `agent:send` (which routes to the active session) would run the next
// turn in the wrong repo. Every open re-checks this before taking `activeKey`.
let intendedKey: string | null = null
// In-flight open-project promises, keyed by projectKey, so two rapid opens of the
// SAME project serialize (the second waits for the first, then replaces it) rather
// than both creating a session and leaking the loser's subprocess.
const opening = new Map<string, Promise<OpenProjectResult>>()

// v9 workspace-snapshot: sessionKeys with a turn currently in flight. Driven by
// provider terminal events, observed through each backend's `ctx.onEvent` hook
// (already wired for spawns; extended here to every interactive session). Providers
// can emit error→done, so `turnTerminals` separately deduplicates finalization. Added on
// `agent:send`, removed on that session's next `done`/`error`, and swept wherever
// a sessionKey leaves the `sessions` map so it can't outlive its session.
const runningKeys = new Set<string>()
const turnTerminals = new TurnTerminalTracker()
const trackRunning =
  (sessionKey: string) =>
  (e: AgentEvent): void => {
    if (e.type === 'done' || e.type === 'error') runningKeys.delete(sessionKey)
  }

// Chats whose auto-name is currently being generated — guards against a second
// `done` firing another title call before the first resolves.
const titling = new Set<string>()

/**
 * Give a chat a meaningful name once it has real content: after a turn finishes,
 * ask the backend to summarise the conversation into a short title (see
 * `ModelProvider.generateTitle`) and push it to the renderer, instead of the rail
 * standing in the opening words of the first prompt. Runs once per chat (guarded
 * by `record.title`), only when both sides have spoken, and never throws — a
 * backend without title support or any failure just leaves the heuristic name.
 */
async function maybeGenerateTitle(sessionKey: string): Promise<void> {
  const session = sessions.get(sessionKey)
  if (!session || session.record.title || titling.has(sessionKey)) return
  session.finalize() // flush the just-finished turn into the transcript
  const transcript = session.record.transcript
  const hasUser = transcript.some((t) => t.role === 'user')
  const hasAssistant = transcript.some((t) => t.role === 'assistant')
  if (!hasUser || !hasAssistant) return
  const generate = pickProvider(session.options).generateTitle
  if (!generate) return
  titling.add(sessionKey)
  try {
    const title = await generate(transcript, session.options)
    // The session may have been closed/replaced while we awaited — re-check, and
    // don't clobber a title set meanwhile.
    const live = sessions.get(sessionKey)
    if (title && live === session && !session.record.title) {
      session.record.title = title
      session.emit({ type: 'title', title })
    }
  } catch {
    /* best-effort — the rail keeps the first-message heuristic */
  } finally {
    titling.delete(sessionKey)
  }
}

/** Interactive-session event hook: running-state bookkeeping + one-time auto-naming. */
const interactiveEvents =
  (sessionKey: string) =>
  (e: AgentEvent): void => {
    trackRunning(sessionKey)(e)
    if (e.type === 'done') void maybeGenerateTitle(sessionKey)
    // Providers disagree about terminal sequences: Codex can emit error→done while
    // Claude may emit only error. Claim one outcome. Success may auto-land; failure
    // persists partial work on the chat branch but never writes it into the project.
    if (e.type === 'done' || e.type === 'error') {
      const terminal = turnTerminals.claim(sessionKey, e.type)
      if (!terminal) return
      const transcript = sessions.get(sessionKey)?.record.transcript ?? []
      const last = [...transcript].reverse().find((t) => t.role === 'user')?.text
      afterTurn(sessionKey, firstLine(last ?? 'praxis chat edit'), transcript, terminal)
    }
  }

// v8 F1: detached comment spawns — background agents each in their OWN git worktree,
// keyed by spawn id. Kept SEPARATE from `sessions` so they never touch `activeKey`
// or the interactive chat stream.
interface Spawn {
  session: ProviderSession
  wt: Worktree
  parentKey: string
  parentSessionKey: string
  parentRoot: string
  text: string
}
const spawns = new Map<string, Spawn>()
// v8 F1 Phase 3: bound concurrent spawns per project; the rest queue (FIFO) and start
// as slots free, so firing many comments can't fork unbounded worktrees/subprocesses.
const MAX_SPAWNS_PER_REPO = 3
interface QueuedSpawn {
  id: string
  root: string
  parentKey: string
  parentSessionKey: string
  text: string
  options: AgentOptions
}
const spawnQueue: QueuedSpawn[] = []
const runningCount = (parentKey: string): number =>
  [...spawns.values()].filter((s) => s.parentKey === parentKey).length
const worktreesDir = (): string => join(dataDir(), 'worktrees')
const firstLine = (t: string): string => (t.split('\n')[0] || 'Praxis comment edit').slice(0, 72)
/** Normalise a user-typed chat name: one line, collapsed whitespace, capped.
 *  Empty (after trimming) means "no rename" — the caller rejects it. */
const cleanTitle = (t: unknown): string =>
  typeof t === 'string' ? t.replace(/\s+/g, ' ').trim().slice(0, 120) : ''

/** Tear down a session: stop it emitting, deny its prompts, provider teardown,
 * then persist it. `main` keeps it as the project's current Main thread (restored
 * in place on the next open); `history` archives it as a previous agent; `none`
 * skips disk (the conversation is being transferred onto a replacement session). */
function closeSession(s: ProviderSession, persist: 'main' | 'history' | 'none' = 'history'): void {
  s.dispose()
  ;[...s.pending.keys()].forEach((id) => resolvePending(s, id, 'deny'))
  // Release any unanswered questions so their SDK callbacks unblock (dismiss).
  if (s.pendingQuestions)
    [...s.pendingQuestions.keys()].forEach((id) => resolveQuestion(s, id, null))
  s.shutdown()
  // Only persist sessions the user actually engaged (≥1 prompt) — skip opened-then
  // -closed empties. Best-effort: a disk hiccup must not break teardown.
  try {
    s.finalize()
    if (persist === 'none') return
    if (s.record.transcript.some((t) => t.role === 'user')) {
      s.record.endedAt = Date.now()
      if (persist === 'main') {
        store().saveMain(s.record)
      } else {
        delete s.record.slot
        store().save(s.record)
      }
    }
  } catch {
    // history is non-critical; never let it interfere with session lifecycle
  }
}

/**
 * A detached comment spawn (v8 F1) reached its terminal event. By default we now
 * AUTO-APPLY its change straight onto the working branch the user is on — no
 * separate `praxis/comment-*` branch, no PR, no manual Apply (that was "too many
 * approvals") — and record it in the undo history so Cmd+Z reverts the whole
 * comment atomically. The branch + checkout are deleted and the record is NOT
 * persisted, so the finished spawn vanishes from the rail instead of lingering as
 * a "previous agent".
 *
 * Only when auto-apply is UNSAFE (the user edited a touched file concurrently,
 * or a binary/delete change) do we fall back to the old behaviour: keep the
 * branch + persist the record so the user can resolve it via the review modal.
 * Best-effort throughout — a finalizer must never throw.
 */
async function finalizeSpawn(id: string, _status: 'done' | 'error'): Promise<void> {
  const spawn = spawns.get(id)
  if (!spawn) return
  spawns.delete(id)
  const { session, wt, parentKey, parentSessionKey, parentRoot, text } = spawn
  try {
    closeSession(session) // finalize + persist the record (removed below if we auto-apply)
    // The agent's closing message → a chat notification the user can reply to.
    const summary = [...session.record.transcript]
      .reverse()
      .find((t) => t.role === 'assistant')?.text
    const { committed, files } = await commitWorktree(wt, firstLine(text))
    let auto: { applied: boolean; edits: { file: string; before: string; after: string }[] } = {
      applied: false,
      edits: []
    }
    if (committed && files.length) {
      try {
        auto = await autoApplyWorktree(parentRoot, wt, files)
      } catch {
        auto = { applied: false, edits: [] }
      }
    }
    if (auto.applied) {
      // Land it on the working branch + make the whole comment ONE Cmd+Z (shared
      // group). Then drop the branch and un-persist the record so the rail clears.
      const group = `comment:${id}`
      for (const e of auto.edits)
        recordEdit(parentRoot, e.file, e.before, e.after, undefined, group)
      // …and as one commit on the live checkout, like an interactive chat's turn, so
      // the spawn shows up in `git log` and can be reverted on its own.
      await commitLiveTurn(parentRoot, files, {
        title: firstLine(text),
        body: 'Praxis comment spawn.'
      })
      await removeWorktree(parentRoot, wt, { keepBranch: false })
      try {
        store().remove(session.record.id)
      } catch {
        /* history is non-critical */
      }
      safeSend(getWindow_, 'agent:event', {
        type: 'spawn-finished',
        projectKey: parentSessionKey,
        sessionId: id,
        branch: null,
        ...(summary ? { summary } : {}),
        files: auto.edits.map((e) => basename(e.file))
      } satisfies AgentEvent)
    } else {
      // Fallback: keep the branch + record for the manual review modal.
      if (committed) {
        session.record.filesTouched = files // git's staged list beats the heuristic
        session.record.endedAt = session.record.endedAt ?? Date.now()
        store().save(session.record)
      }
      await removeWorktree(parentRoot, wt, { keepBranch: committed })
      safeSend(getWindow_, 'agent:event', {
        type: 'spawn-finished',
        projectKey: parentSessionKey,
        sessionId: id,
        branch: committed ? wt.branch : null,
        ...(summary ? { summary } : {}),
        files: committed ? files.map((f) => basename(f)) : []
      } satisfies AgentEvent)
    }
  } catch {
    // Never let spawn teardown break the app; the worktree may linger for prune.
  }
  void pumpQueue(parentKey) // a slot just freed — start the next queued spawn
}

// finalizeSpawn runs outside registerAgentIpc's closure, so it needs the window
// accessor. Captured when IPC is registered.
let getWindow_: () => BrowserWindow | null = () => null

// Agent events stream from async SDK callbacks that keep firing after the
// renderer process is killed (OS display sleep / GPU loss): the window outlives
// its webContents, so a bare `.send()` throws an uncaught "Object has been
// destroyed". Guard isDestroyed() to make a late emit a safe no-op.
function safeSend(get: () => BrowserWindow | null, channel: string, payload: unknown): void {
  const wc = get()?.webContents
  if (wc && !wc.isDestroyed()) wc.send(channel, payload)
}

/**
 * Create the worktree + start a detached session for one spawn. Shared by the
 * immediate path and the queue. On a setup failure it reclaims the worktree and
 * emits `spawn-finished` so the renderer drops the row, then pumps the queue.
 * Returns the branch (immediate path needs it) or null on failure.
 */
async function startSpawn(q: QueuedSpawn): Promise<string | null> {
  let wt: Worktree
  try {
    wt = await createWorktree(q.root, worktreesDir(), { label: q.text, id: q.id })
  } catch {
    safeSend(getWindow_, 'agent:event', {
      type: 'spawn-finished',
      projectKey: q.parentSessionKey,
      sessionId: q.id,
      branch: null
    } satisfies AgentEvent)
    void pumpQueue(q.parentKey)
    return null
  }
  const opts: AgentOptions = { ...q.options, permissionMode: 'bypassPermissions' }
  try {
    const s = await pickProvider(opts).startSession(
      wt.path,
      opts,
      getWindow_,
      contextWithMemory(q.root, null, {
        sessionId: wt.id,
        emitKey: q.parentSessionKey,
        liveRoot: q.root,
        onEvent: (e) => {
          if (e.type === 'done') void finalizeSpawn(wt.id, 'done')
          else if (e.type === 'error') void finalizeSpawn(wt.id, 'error')
        }
      })
    )
    s.record.kind = 'comment'
    s.record.branch = wt.branch
    // The spawn's cwd is its worktree, so createRecordCapture keyed the record to
    // projectKey(wt.path); stamp it back to the parent project (like projectRoot/Name
    // below) so parked spawn records are visible to sessions:list.
    s.record.projectKey = q.parentKey
    s.record.projectRoot = q.root
    s.record.projectName = basename(q.root) || q.root
    s.record.transcript.push({ role: 'user', text: q.text, at: Date.now() })
    spawns.set(wt.id, {
      session: s,
      wt,
      parentKey: q.parentKey,
      parentSessionKey: q.parentSessionKey,
      parentRoot: q.root,
      text: q.text
    })
    s.send(q.text)
    return wt.branch
  } catch {
    await removeWorktree(q.root, wt, { keepBranch: false })
    safeSend(getWindow_, 'agent:event', {
      type: 'spawn-finished',
      projectKey: q.parentSessionKey,
      sessionId: q.id,
      branch: null
    } satisfies AgentEvent)
    void pumpQueue(q.parentKey)
    return null
  }
}

/** Start queued spawns for a project while it has free slots (FIFO). Each dequeued
 *  spawn emits `spawn-started` so the rail flips its row from queued → running. */
async function pumpQueue(parentKey: string): Promise<void> {
  while (runningCount(parentKey) < MAX_SPAWNS_PER_REPO) {
    const idx = spawnQueue.findIndex((q) => q.parentKey === parentKey)
    if (idx === -1) return
    const [q] = spawnQueue.splice(idx, 1)
    const branch = await startSpawn(q)
    if (branch) {
      safeSend(getWindow_, 'agent:event', {
        type: 'spawn-started',
        projectKey: q.parentSessionKey,
        sessionId: q.id,
        branch
      } satisfies AgentEvent)
    }
  }
}

/** Settle a pending prompt and tell the renderer to drop its card. */
function resolvePending(s: ProviderSession, id: string, behavior: 'allow' | 'deny'): void {
  const p = s.pending.get(id)
  if (!p) return
  p.settle(behavior)
  s.emit({ type: 'permission-resolved', id })
}

/** Settle a pending agent question and tell the renderer to drop its card. */
function resolveQuestion(s: ProviderSession, id: string, answers: QuestionAnswers | null): void {
  const q = s.pendingQuestions?.get(id)
  if (!q) return
  q.settle(answers)
  s.emit({ type: 'question-resolved', id })
}

export function registerAgentIpc(getWindow: () => BrowserWindow | null): void {
  getWindow_ = getWindow // share with finalizeSpawn (runs outside this closure)
  // v9 per-chat worktree isolation — deps-injected so this module barely grows.
  initChatIsolation({ worktreesDir, store, getWindow })
  ipcMain.handle('agent:open-project', async (_e, root: string, options: AgentOptions = {}) => {
    const key = projectKey(root)
    // This is the renderer's latest intent — record it synchronously, before any await.
    intendedKey = key
    // Serialize opens of the SAME project: wait for any in-flight open to settle so
    // we don't create two sessions and strand the first (a leaked subprocess whose
    // events keep streaming under the same key).
    const prior = opening.get(key)
    const run = (async (): Promise<OpenProjectResult> => {
      if (prior) await prior.catch(() => {})
      // Replacing a live Main persists it as the current thread so this open (or
      // a later relaunch) can restore it, instead of dumping it into History.
      const existing = sessions.get(key)
      if (existing) {
        const terminal = runningKeys.has(key) ? 'failed' : 'success'
        closeSession(existing, 'main')
        sessions.delete(key)
        memoryRevisionBySession.delete(key)
        runningKeys.delete(key)
        // Merge + tear down the replaced chat's worktree BEFORE forking the new one,
        // so the fresh worktree's captureBase includes the old chat's merged output.
        await releaseChat(key, terminal)
      }
      const priorMain = store().currentMain(key)
      const resumeSessionId = priorMain?.sdkSessionId
      // Isolated chats run in a private `praxis/chat-<id>` worktree (repo roots only);
      // isolatedCwd returns the live root otherwise. adoptSession re-stamps the record
      // back to the live project so history/reattach see it under the real root.
      const cwd = await isolatedCwd(root, key)
      const start = (resume?: string): Promise<ProviderSession> =>
        pickProvider(options).startSession(
          cwd,
          options,
          getWindow,
          contextWithMemory(root, key, {
            emitKey: key,
            liveRoot: root,
            onEvent: interactiveEvents(key),
            ...(resume ? { resumeSessionId: resume } : {})
          })
        )
      let s: ProviderSession
      try {
        s = await start(resumeSessionId)
      } catch (err) {
        // A stale Claude resume id shouldn't block opening the project — fall
        // back to a fresh provider thread and still paint the saved transcript.
        if (!resumeSessionId) throw err
        s = await start()
      }
      adoptSession(key, s.record, root)
      if (priorMain) seedFromRecord(s.record, priorMain, { reuseId: true })
      s.record.endedAt = null
      if (priorMain?.title) s.emit({ type: 'title', title: priorMain.title })
      sessions.set(key, s)
      // Only claim the active slot if the renderer still wants this project active.
      // A later open/set-active for a different project moved `intendedKey` on, and
      // that project's own turn is what should stream.
      if (intendedKey === key) {
        activeKey = key
        activeSessionKeyByProject.set(key, key)
      }
      // v8 F1: reclaim any comment-spawn worktrees orphaned by a prior crash/quit —
      // pruneOrphans commits dirty leftovers to their branch (recovering the work)
      // before removing the checkout. Skip ids of spawns live THIS session (their
      // checkouts are under the same dir). Best-effort, fire-and-forget.
      if (await isRepoRoot(root)) {
        // Skip live spawns AND live chat worktrees (the worktrees dir is global across
        // projects) so a recovery sweep never reclaims a chat's live checkout.
        // handleReclaimed then surfaces any crashed-mid-turn chat's work as a recovery
        // park record (keyed to the orphan's OWN repo) and deletes cleanly-merged
        // leftover chat branches; comment-spawn orphans keep their prior behavior.
        void pruneOrphans(
          root,
          worktreesDir(),
          new Set([...spawns.keys(), ...liveChatWorktreeIds()]),
          hasParkRecord
        )
          .then((reclaimed) => handleReclaimed(reclaimed))
          .catch(() => {})
      }
      return {
        transcript: s.record.transcript,
        ...(s.record.title ? { title: s.record.title } : {})
      }
    })()
    opening.set(key, run)
    void run.finally(() => {
      if (opening.get(key) === run) opening.delete(key)
    })
    return run
  })

  // Close a project's session(s) (renderer single-active teardown; the rail uses
  // this when a project is closed, not merely switched away from). Tears down
  // EVERY sessionKey belonging to this project — its default chat plus any
  // additional/resumed ones (v9) — so closing a project never leaks a live
  // subprocess the renderer no longer shows anywhere.
  ipcMain.handle('agent:close-project', async (_e, root: string) => {
    const key = projectKey(root)
    for (const sk of sessionKeysForProject(key)) {
      const s = sessions.get(sk)
      if (s) {
        const terminal = runningKeys.has(sk) ? 'failed' : 'success'
        closeSession(s, sk === key ? 'main' : 'history')
        sessions.delete(sk)
        memoryRevisionBySession.delete(sk)
        runningKeys.delete(sk)
        void releaseChat(sk, terminal) // running partial work parks; idle work tears down
      }
    }
    activeSessionKeyByProject.delete(key)
    // Closing the active project clears `active` — never auto-promote an arbitrary
    // backgrounded session (it would start emitting into a chat the renderer isn't
    // showing). The renderer re-activates explicitly via open-project.
    if (activeKey && (activeKey === key || activeKey.startsWith(`${key}#`))) activeKey = null
    // Clear intent too, so an open of this project still in flight can't claim the
    // active slot for a project the user just closed.
    if (intendedKey === key) intendedKey = null
    // v8 F3b: drop the project's undo/redo history — a reopened project starts fresh.
    clearHistory(root)
  })

  // Switch the active project to an already-open (warm) session, without
  // recreating it — used by the rail when switching between open projects.
  // Without `sessionKey`, restores whichever of the project's OWN sessionKeys
  // (default, or an additional/resumed chat) was last active for it, defaulting
  // to the plain project key the first time. With `sessionKey` (v9 multi-chat
  // switcher), selects that SPECIFIC one of the project's already-live sessions —
  // a no-op if it isn't actually live (e.g. it was closed elsewhere meanwhile).
  ipcMain.handle('agent:set-active', async (_e, root: string, sessionKey?: string) => {
    const key = projectKey(root)
    // Record intent regardless, so a slow in-flight open of a DIFFERENT project
    // won't steal `activeKey` back after this switch.
    intendedKey = key
    const remembered = activeSessionKeyByProject.get(key)
    const target =
      sessionKey && sessionKeysForProject(key).includes(sessionKey)
        ? sessionKey
        : remembered && sessions.has(remembered)
          ? remembered
          : key
    if (sessions.has(target)) {
      activeKey = target
      activeSessionKeyByProject.set(key, target)
    }
  })

  // v9 resume/multi-chat — start an ADDITIONAL fresh session for a project that
  // already has one open. Unlike agent:open-project, the existing session(s) are
  // left running: this registers the new session under its own sessionKey
  // (`${projectKey}#<id>`), so the renderer's per-key chat store gives it its own
  // slice and the rail can list it as a second, independently-switchable chat.
  ipcMain.handle(
    'agent:new-chat',
    async (
      _e,
      root: string,
      options: AgentOptions = {}
    ): Promise<{ ok: boolean; sessionKey?: string; error?: string }> => {
      const key = projectKey(root)
      if (!sessions.has(key)) {
        return { ok: false, error: 'Open the project before starting another chat.' }
      }
      intendedKey = key
      const sessionKey = `${key}#${randomUUID()}`
      try {
        const cwd = await isolatedCwd(root, sessionKey)
        const s = await pickProvider(options).startSession(
          cwd,
          options,
          getWindow,
          contextWithMemory(root, sessionKey, {
            emitKey: sessionKey,
            liveRoot: root,
            onEvent: interactiveEvents(sessionKey)
          })
        )
        adoptSession(sessionKey, s.record, root)
        sessions.set(sessionKey, s)
        activeSessionKeyByProject.set(key, sessionKey)
        if (intendedKey === key) activeKey = sessionKey
        return { ok: true, sessionKey }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // Codex fixes its model/backend when a thread is created. Restart exactly the
  // selected chat (not the project's default session) so a picker change never
  // alters a sibling chat or leaves an additional chat on its old model.
  //
  // Extracted from the IPC handler because a force-stop needs it too: when Stop has
  // to hard-abort a wedged backend (see `agent:interrupt`), that kills the whole
  // query, not just the turn — so the chat must be rebuilt or it would look alive
  // while silently swallowing every later message.
  const restartChatSession = async (
    root: string,
    sessionKey: string,
    options: AgentOptions = {},
    how: { persist: 'main' | 'history' | 'none'; seed: boolean } = { persist: 'none', seed: true }
  ): Promise<{ ok: boolean; error?: string }> => {
    const key = projectKey(root)
    if (!sessionKeysForProject(key).includes(sessionKey)) {
      return { ok: false, error: 'That chat is no longer open.' }
    }
    const existing = sessions.get(sessionKey)
    if (!existing) return { ok: false, error: 'That chat is no longer open.' }
    const previous = existing.record
    closeSession(existing, how.persist)
    sessions.delete(sessionKey)
    memoryRevisionBySession.delete(sessionKey)
    runningKeys.delete(sessionKey)
    try {
      // Reuse the chat's EXISTING worktree (isolatedCwd is idempotent for a known
      // sessionKey) so a model/backend restart keeps its isolation instead of
      // silently dropping to the live root and leaking the worktree.
      const cwd = await isolatedCwd(root, sessionKey)
      const s = await pickProvider(options).startSession(
        cwd,
        options,
        getWindow,
        contextWithMemory(root, sessionKey, {
          emitKey: sessionKey,
          liveRoot: root,
          onEvent: interactiveEvents(sessionKey)
        })
      )
      adoptSession(sessionKey, s.record, root)
      if (how.seed) seedFromRecord(s.record, previous, { reuseId: true })
      s.record.endedAt = null
      sessions.set(sessionKey, s)
      if (activeKey === sessionKey) activeSessionKeyByProject.set(key, sessionKey)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  ipcMain.handle(
    'agent:restart-chat',
    async (
      _e,
      root: string,
      sessionKey: string,
      options: AgentOptions = {}
    ): Promise<{ ok: boolean; error?: string }> => restartChatSession(root, sessionKey, options)
  )

  // Main is a stable project slot, not an infinitely growing provider thread.
  // Clearing archives its current transcript through closeSession(), then starts
  // a fresh provider context under the SAME projectKey with the same model/posture.
  // Project memory is loaded again by restartChatSession and remains untouched.
  ipcMain.handle(
    'agent:clear-main-context',
    async (_e, root: string): Promise<{ ok: boolean; error?: string }> => {
      const key = projectKey(root)
      const session = sessions.get(key)
      if (!session) return { ok: false, error: 'The Main chat is not open.' }
      if (runningKeys.has(key)) {
        return { ok: false, error: 'Wait for Main to finish before clearing its context.' }
      }
      if (isolationSnapshot(key)?.state === 'parked') {
        return { ok: false, error: 'Resolve or discard Main’s conflict before clearing context.' }
      }
      return restartChatSession(
        root,
        key,
        { ...session.options },
        { persist: 'history', seed: false }
      )
    }
  )

  // v9 resume — hand a past ("previous agent") SessionRecord back to a LIVE SDK
  // query via `options.resume` (Claude-only: the record's `sdkSessionId` doubles
  // as the "this backend supports resume" marker, since only claude.ts sets it).
  // Registered under a sessionKey derived from the SDK's OWN session id, so a
  // repeat resume of the same record reattaches to the same slot instead of
  // spawning a second live query against it.
  ipcMain.handle(
    'agent:resume-session',
    async (
      _e,
      root: string,
      recordId: string,
      options: AgentOptions = {}
    ): Promise<{ ok: boolean; sessionKey?: string; error?: string }> => {
      const key = projectKey(root)
      const rec = store().get(recordId)
      if (!rec) return { ok: false, error: 'That session record no longer exists.' }
      if (!rec.sdkSessionId) {
        return { ok: false, error: 'This session has no resumable id and can’t be resumed.' }
      }
      intendedKey = key
      const sessionKey = `${key}#${rec.sdkSessionId}`
      if (sessions.has(sessionKey)) {
        // Already resumed and still live — just switch to it.
        activeSessionKeyByProject.set(key, sessionKey)
        if (intendedKey === key) activeKey = sessionKey
        return { ok: true, sessionKey }
      }
      try {
        // Resumed chats get a FRESH worktree (their past edits already live in the
        // repo); isolatedCwd falls back to the live root for non-repo projects.
        const cwd = await isolatedCwd(root, sessionKey)
        // Resume is Claude-only (`sdkSessionId` is both the resume id and the
        // "this was Claude" marker), so pin the backend — but keep the caller's
        // model/effort/permission posture. Starting with `{}` here silently ran the
        // resumed chat under main's defaults ('default' = ask for every edit) while
        // the renderer's toolbar still showed the chat's own mode.
        const opts: AgentOptions = { ...options, provider: 'claude' }
        const s = await pickProvider(opts).startSession(
          cwd,
          opts,
          getWindow,
          contextWithMemory(root, sessionKey, {
            emitKey: sessionKey,
            liveRoot: root,
            resumeSessionId: rec.sdkSessionId,
            onEvent: interactiveEvents(sessionKey)
          })
        )
        adoptSession(sessionKey, s.record, root)
        // Seed the fresh live record with the resumed chat's on-disk history. The
        // SDK resumes the conversation context and the renderer paints the past
        // messages from the record it resumed, but `s.record.transcript` starts
        // empty and only accrues NEW turns — so without this a later reattach
        // (agent:workspace-snapshot, after a window close+reopen) would repaint an
        // empty chat. The History record stays on its own id.
        seedFromRecord(s.record, rec)
        if (rec.title) s.emit({ type: 'title', title: rec.title })
        sessions.set(sessionKey, s)
        activeSessionKeyByProject.set(key, sessionKey)
        if (intendedKey === key) activeKey = sessionKey
        return { ok: true, sessionKey }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // v9 multi-chat — close ONE of a project's live chats (its rail × ), leaving the
  // project and its other chats alive. Tears down just that sessionKey's session
  // (closeSession persists it to history, so a closed chat becomes a resumable
  // "previous agent" like any other teardown), then re-points the project's active
  // chat to a survivor. Returns the remaining live sessionKeys + the new active one
  // (null when none remain, so the renderer closes the project instead).
  ipcMain.handle(
    'agent:close-chat',
    async (
      _e,
      root: string,
      sessionKey: string
    ): Promise<{ ok: boolean; remaining: string[]; activeSessionKey: string | null }> => {
      const key = projectKey(root)
      const s = sessions.get(sessionKey)
      if (s) {
        const terminal = runningKeys.has(sessionKey) ? 'failed' : 'success'
        closeSession(s, sessionKey === key ? 'main' : 'history')
        sessions.delete(sessionKey)
        memoryRevisionBySession.delete(sessionKey)
        runningKeys.delete(sessionKey)
        void releaseChat(sessionKey, terminal) // running partial work parks; idle work tears down
      }
      const remaining = sessionKeysForProject(key)
      // Prefer the project's default chat as the survivor, else the first remaining.
      let nextActive = activeSessionKeyByProject.get(key) ?? null
      if (!nextActive || nextActive === sessionKey || !sessions.has(nextActive)) {
        nextActive = remaining.includes(key) ? key : (remaining[0] ?? null)
        if (nextActive) activeSessionKeyByProject.set(key, nextActive)
        else activeSessionKeyByProject.delete(key)
      }
      // If the closed chat was the globally active one, re-point activeKey to the
      // survivor (only while this project is still the intended one — never resurrect
      // a backgrounded session into a chat the renderer isn't showing).
      if (activeKey === sessionKey) activeKey = intendedKey === key ? nextActive : null
      return { ok: true, remaining, activeSessionKey: nextActive }
    }
  )

  // Rename a live chat (rail inline rename). Writing the name onto the session's
  // record is what makes it stick: the record is persisted on teardown, the
  // workspace snapshot replays it after a reload, and `maybeGenerateTitle` skips
  // any chat whose record already carries a name — so a user-chosen name can never
  // be overwritten by the auto-namer. The `title` event keeps every other renderer
  // view (and this window's own store) in step.
  ipcMain.handle('agent:rename-chat', (_e, sessionKey: string, title: string) => {
    const session = sessions.get(sessionKey)
    if (!session) return { ok: false, error: 'no live chat' }
    const name = cleanTitle(title)
    if (!name) return { ok: false, error: 'empty name' }
    session.record.title = name
    // A resumed/parked chat may already have its record on disk — keep that copy
    // in step too. A never-persisted live record stays out of `sessions:list`.
    try {
      if (store().get(session.record.id)) store().save(session.record)
    } catch {
      /* history is non-critical */
    }
    session.emit({ type: 'title', title: name })
    return { ok: true, title: name }
  })

  // Does this project still have a live session? (LRU eviction can suspend a
  // backgrounded project's session; the renderer reopens it on switch-back.)
  ipcMain.handle('agent:is-open', (_e, root: string) => sessions.has(projectKey(root)))

  ipcMain.handle('agent:set-model', async (_e, model: string) => {
    const session = activeSession()
    if (!session) return
    await session.setModel?.(model)
    session.options.model = model
  })

  ipcMain.handle('agent:set-permission-mode', async (_e, mode: PermissionMode) => {
    const session = activeSession()
    if (!session) return
    // Apply to the backend first; only commit our copy if it took (keeps the
    // toolbar and the live agent in agreement).
    await session.setPermissionMode?.(mode)
    session.options.permissionMode = mode
    // Switching to a more permissive posture should also release prompts already
    // on screen — otherwise the user picks "Auto" but the pending card stays.
    if (mode === 'bypassPermissions' || mode === 'acceptEdits') {
      for (const [id, p] of [...session.pending.entries()]) {
        if (mode === 'bypassPermissions' || EDIT_TOOLS.has(p.toolName)) {
          resolvePending(session, id, 'allow')
        }
      }
    }
  })

  ipcMain.handle('agent:respond-permission', async (_e, id: string, behavior: 'allow' | 'deny') => {
    const session = activeSession()
    if (session) resolvePending(session, id, behavior)
  })

  // Answer a pending agent question (AskUserQuestion) — settles the awaiting
  // canUseTool callback with the user's picks (or null = dismissed).
  ipcMain.handle(
    'agent:respond-question',
    async (_e, id: string, answers: QuestionAnswers | null) => {
      const session = activeSession()
      if (session) resolveQuestion(session, id, answers)
    }
  )

  ipcMain.handle('agent:send', async (_e, text: string, images?: ImageAttachment[]) => {
    const session = activeSession()
    if (!session) {
      safeSend(getWindow, 'agent:event', {
        type: 'error',
        message: 'Open a project first — the agent works inside a repo.'
      } satisfies AgentEvent)
      return
    }
    const note = images?.length ? `${text} [${images.length} image(s) attached]`.trim() : text
    session.record.transcript.push({ role: 'user', text: note, at: Date.now() })
    // activeKey is the sessionKey `session` was looked up under (activeSession()
    // derives it from the same variable) — mark it running before the turn starts
    // so a workspace-snapshot taken mid-turn sees it.
    if (activeKey) {
      runningKeys.add(activeKey)
      turnTerminals.begin(activeKey)
    }
    // Turn-start: sync the user's between-turn live edits into this chat's worktree
    // (serialized behind the chat's chain — waits out any in-flight merge). No-op for
    // a non-isolated chat.
    if (activeKey) await beforeTurn(activeKey, text)
    // Memory is part of the provider's initial instructions. If the user edited it
    // while this session remained open, inject the new snapshot exactly once on the
    // next turn (not every turn, which would needlessly inflate context).
    const root = session.record.projectRoot
    const memory = memoryStore().get(root)
    const knownRevision = activeKey ? memoryRevisionBySession.get(activeKey) : undefined
    const prompt = memory.updatedAt !== knownRevision
      ? projectMemoryUpdate(memory.content, text)
      : text
    if (activeKey) memoryRevisionBySession.set(activeKey, memory.updatedAt)
    session.send(prompt, images)
  })

  // Give a PASTED image a path. A dropped image already has one (the renderer
  // recovers it via webUtils), but clipboard bytes exist nowhere on disk, so the
  // agent could see the screenshot and still have no file to copy or point at.
  // The renderer calls this as it sends, then names the path in the prompt.
  ipcMain.handle(
    'attachments:save',
    async (_e, image: ImageAttachment, name?: string): Promise<string> => {
      const dir = join(dataDir(), 'attachments')
      const saved = await saveImageAttachment(dir, image, name, String(Date.now()))
      void pruneAttachments(dir, Date.now())
      return saved
    }
  )

  // Tag the live session with branch / PR metadata for its history record (the
  // renderer knows these; main captures transcript + files). No-op if no session.
  ipcMain.handle(
    'agent:tag-session',
    async (_e, root: string, tag: { branch?: string; prUrl?: string }) => {
      const key = projectKey(root)
      // Prefer whichever of the project's sessions is currently active (an
      // additional/resumed chat, if that's what's live) — falls back to the
      // default session, matching pre-v9 behavior when there's only one.
      const s =
        activeKey && sessionKeysForProject(key).includes(activeKey)
          ? sessions.get(activeKey)
          : sessions.get(key)
      if (!s) return
      if (typeof tag.branch === 'string') s.record.branch = tag.branch
      if (typeof tag.prUrl === 'string') s.record.prUrl = tag.prUrl
    }
  )

  // v8 F1: spawn a detached comment agent in its own git worktree. It runs in the
  // background (bypassPermissions — a headless run has no card UI), edits its private
  // checkout (zero cross-writes with the main agent or other spawns), and on finish
  // commits to a `praxis/comment-<id>` branch + lands in this project's history. Over the
  // per-repo cap (Phase 3) it QUEUES and starts when a slot frees.
  ipcMain.handle(
    'agent:spawn-comment',
    async (
      _e,
      root: string,
      text: string,
      requestedParentSessionKey: string,
      options: AgentOptions = {}
    ) => {
      // Worktrees need a repo TOP LEVEL — a non-repo (or subdir) falls back to chat.
      if (!(await isRepoRoot(root))) return { ok: false, reason: 'not-a-repo' }
      // Only backends that honor SpawnContext can run a detached spawn; on the
      // others a spawn would never finalize (worktree + rail row leak forever),
      // so refuse and let the renderer run the comment in the main chat instead.
      if (!pickProvider(options).supportsSpawn) {
        return { ok: false, reason: 'unsupported-backend' }
      }
      const parentKey = projectKey(root)
      const parentSessionKey = sessionKeysForProject(parentKey).includes(requestedParentSessionKey)
        ? requestedParentSessionKey
        : (activeSessionKeyByProject.get(parentKey) ?? parentKey)
      // Stable id assigned up front so the rail row survives a queued→running flip.
      const id = randomUUID().slice(0, 8)
      const q: QueuedSpawn = { id, root, parentKey, parentSessionKey, text, options }
      if (runningCount(parentKey) >= MAX_SPAWNS_PER_REPO) {
        spawnQueue.push(q) // a slot will free on the next finalizeSpawn → pumpQueue
        return { ok: true, spawnId: id, queued: true }
      }
      const branch = await startSpawn(q)
      if (!branch) return { ok: false, reason: 'Could not start the agent (is it logged in?).' }
      return { ok: true, spawnId: id, branch }
    }
  )

  // v8 F1 Phase 3 — cancel a running OR queued comment spawn (the rail row's ×).
  ipcMain.handle('agent:spawn-interrupt', async (_e, id: string) => {
    const queuedIdx = spawnQueue.findIndex((q) => q.id === id)
    if (queuedIdx !== -1) {
      const [q] = spawnQueue.splice(queuedIdx, 1)
      safeSend(getWindow, 'agent:event', {
        type: 'spawn-finished',
        projectKey: q.parentSessionKey,
        sessionId: id,
        branch: null
      } satisfies AgentEvent)
      return
    }
    const spawn = spawns.get(id)
    if (!spawn) return
    // → emits done → finalizeSpawn commits any work. Interrupting a turn that
    // already finished/aborted makes the SDK throw "Operation aborted" — a stop
    // that arrives late is a no-op, not an error.
    await spawn.session.interrupt?.().catch(() => {})
  })

  // v8 F1 Phase 2 — close the loop from a finished comment spawn to a visible result.
  // APPLY: patch the spawn's branch diff onto the LIVE working tree (the dev server
  // HMRs it). Not `git merge` — patch-apply tolerates the main agent's WIP; on textual
  // overlap it surfaces conflict markers for the user to resolve.
  ipcMain.handle('agent:spawn-apply', async (_e, root: string, branch: string) => {
    // v9: if this branch belongs to a LIVE parked chat, apply it through the isolation
    // path (advance the fork point + unpark) rather than the stock spawn-branch apply.
    // A crash-recovered (dead) chat's branch is not owned by any live chat → falls
    // through to the stock path below unchanged.
    const parked = await applyParkedBranch(root, branch)
    if (parked.handled) {
      if (parked.ok) return { ok: true }
      return {
        ok: false,
        conflict: parked.conflict,
        error: parked.conflict
          ? 'Applied with conflicts — resolve the markers in your editor, then keep going.'
          : (parked.error ?? 'Could not apply the changes.')
      }
    }
    if (!(await isRepoRoot(root))) return { ok: false, error: 'Not a git repository.' }
    if (!(await branchExists(root, branch)))
      return { ok: false, error: 'That branch no longer exists.' }
    const patch = await branchPatch(root, branch)
    if (!patch.trim()) return { ok: false, error: 'That run made no changes to apply.' }
    const res = await applyToWorkingTree(root, patch, worktreesDir())
    if (res.ok) return { ok: true }
    return {
      ok: false,
      conflict: res.conflict,
      error: res.conflict
        ? 'Applied with conflicts — resolve the markers in your editor, then keep going.'
        : (res.error ?? 'Could not apply the changes.')
    }
  })

  // DISCARD: drop the spawn's branch (the renderer also removes the history record).
  ipcMain.handle('agent:spawn-discard', async (_e, root: string, branch: string) => {
    // v9: a LIVE parked chat's branch is reset in place (its worktree still checks it
    // out, so `git branch -D` would fail); only a real/dead spawn branch is deleted.
    const parked = await discardParkedBranch(root, branch)
    if (parked.handled) return { ok: true }
    if (branch) await deleteBranch(root, branch)
    return { ok: true }
  })

  // v9 conflict card — "Resolve it". Stage the active parked chat's worktree so it holds
  // BOTH the user's live edits and the chat's changes (3-way merged). If they overlap,
  // return the conflicted files + a resolution PROMPT for the renderer to run as a normal
  // turn (its `afterTurn` merges + unparks). If they merged cleanly, `resolveParkedChat`
  // already committed + merged + unparked — nothing more to send (`conflicted: []`).
  ipcMain.handle('agent:resolve-conflict', async () => {
    if (!activeKey) return { ok: false, conflicted: [] as string[], error: 'no-session' }
    const res = await resolveParkedChat(activeKey)
    if (!res.ok || res.conflicted.length === 0) return { ...res, conflicted: res.conflicted }
    const list = res.conflicted.join(', ')
    const prompt =
      `The changes from this chat overlapped with edits you made to the same files, so I combined ` +
      `both versions and marked the overlapping spots with conflict markers ` +
      `(\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`) in: ${list}. ` +
      `Please open each of those files, reconcile the two sides into the result that was clearly ` +
      `intended — keeping the recent edits AND the change this chat was making — and remove every ` +
      `conflict marker. Use your best judgment instead of asking me to choose. When you're done, ` +
      `briefly say what you reconciled.`
    return { ok: true, conflicted: res.conflicted, prompt }
  })

  // v9 conflict card — "Discard changes". Drop the active parked chat's unmerged work.
  ipcMain.handle('agent:discard-conflict', async () => {
    if (!activeKey) return { ok: false }
    return discardParkedChat(activeKey)
  })

  // PR: push the spawn's branch + open a PR from it (no checkout — the work is already
  // committed on the branch). Persists prUrl back onto the history record.
  ipcMain.handle(
    'agent:spawn-pr',
    async (_e, root: string, branch: string, title: string, recordId: string) => {
      if (!(await isRepoRoot(root))) return { ok: false, error: 'Not a git repository.' }
      if (!(await branchExists(root, branch)))
        return { ok: false, error: 'That branch no longer exists.' }
      try {
        await git(root, ['remote', 'get-url', 'origin'])
      } catch {
        return { ok: false, error: 'No “origin” remote — add one, then open a PR.' }
      }
      try {
        await execFileP('gh', ['--version'])
      } catch {
        return { ok: false, error: 'GitHub CLI (gh) not found — install it to open a PR.' }
      }
      try {
        await git(root, ['push', '-u', 'origin', branch])
        const body = `Edited by a Praxis comment agent.\n\n🤖 Generated with [Praxis](https://github.com/alikimovich/praxis)`
        const { stdout } = await execFileP(
          'gh',
          [
            'pr',
            'create',
            '--head',
            branch,
            '--title',
            title || 'Praxis comment edit',
            '--body',
            body
          ],
          { cwd: root }
        )
        const prUrl =
          stdout
            .trim()
            .split('\n')
            .find((l) => /^https?:\/\//.test(l)) ?? stdout.trim()
        // Persist prUrl onto the history record (overwrite by id).
        const rec = store().get(recordId)
        if (rec) {
          rec.prUrl = prUrl
          store().save(rec)
        }
        return { ok: true, prUrl }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  // Persisted history ("previous agents", v5-D). Lists past runs (the live session
  // is persisted only on teardown, so it isn't here).
  ipcMain.handle('sessions:list', (_e, root: string) =>
    store()
      .list(projectKey(root))
      .filter((r) => r.slot !== 'main')
  )
  ipcMain.handle('sessions:get', (_e, id: string) => store().get(id))
  ipcMain.handle('sessions:rename', (_e, id: string, title: string) => {
    const name = cleanTitle(title)
    if (!name) return { ok: false, error: 'empty name' }
    const rec = store().get(id)
    if (!rec) return { ok: false, error: 'unknown session' }
    rec.title = name
    store().save(rec)
    return { ok: true, title: name }
  })
  ipcMain.handle('sessions:remove', (_e, id: string) => store().remove(id))

  ipcMain.handle('project-memory:get', (_e, root: string) => memoryStore().get(root))
  ipcMain.handle('project-memory:set', (_e, root: string, content: string) =>
    memoryStore().set(root, typeof content === 'string' ? content : '')
  )

  // User-added model endpoints (v10, `providers:*`). Registered from here, next to
  // the other userData-backed stores, and handed THIS module's `dataDir` so both
  // stores share one directory — and so providers.ts can't create it ahead of the
  // legacy dsgn→praxis migration above and quietly skip it.
  registerProviderIpc(dataDir)

  // v9 reattach: everything still live in main, for a fresh renderer (after a
  // reload) to repaint without tearing anything down. Groups every live
  // sessionKey by its record's canonical projectKey (not by string-parsing the
  // sessionKey) — `record.projectKey` is always the plain projectKey(root) even
  // for an additional/resumed chat (see the comment on `emitKey` above), and
  // `record.projectRoot` recovers the absolute root alongside it.
  ipcMain.handle('agent:workspace-snapshot', (): WorkspaceSnapshot => {
    const byProject = new Map<string, LiveProjectSnapshot>()
    for (const [sessionKey, s] of sessions) {
      const pKey = s.record.projectKey
      let proj = byProject.get(pKey)
      if (!proj) {
        proj = {
          projectKey: pKey,
          root: s.record.projectRoot,
          chats: [],
          activeSessionKey: activeSessionKeyByProject.get(pKey) ?? null
        }
        byProject.set(pKey, proj)
      }
      proj.chats.push({
        sessionKey,
        record: s.record,
        isRunning: runningKeys.has(sessionKey),
        isolation: isolationSnapshot(sessionKey),
        // The posture this chat is really running under (updated in place by
        // set-model / set-permission-mode) — the renderer repoints its pickers at
        // it on reattach rather than trusting its own persisted copy.
        options: { ...s.options }
      })
    }
    const activeRoot = (activeKey && sessions.get(activeKey)?.record.projectRoot) || null
    return { projects: [...byProject.values()], activeRoot }
  })

  ipcMain.handle('agent:interrupt', async () => {
    const session = activeSession()
    if (!session)
      return // Release any open prompts (interrupt may not abort their per-call signal),
      // so cards don't orphan and the backend callbacks unblock.
    ;[...session.pending.keys()].forEach((id) => resolvePending(session, id, 'deny'))
    if (session.pendingQuestions)
      [...session.pendingQuestions.keys()].forEach((id) => resolveQuestion(session, id, null))
    const sessionKey = activeKey
    const root = session.root
    // A stop that lands after the turn already finished/aborted makes the SDK
    // throw "Operation aborted" — treat it as the no-op it is.
    //
    // The outer race is belt-and-braces for the whole seam: a backend is REQUIRED
    // to bound its own cancel, but if a future one forgets, this handler must still
    // resolve or the renderer's Stop sits on a promise that never settles and the
    // button reads as broken — which is exactly how the Claude deadlock presented.
    const outcome = await Promise.race([
      session.interrupt?.().catch(() => undefined) ?? Promise.resolve(undefined),
      new Promise<undefined>((r) => setTimeout(r, INTERRUPT_IPC_CAP_MS, undefined))
    ])
    // The backend killed its query to escape a wedge, so this session is dead:
    // rebuild the chat in place, or it would keep accepting messages into nothing.
    if (outcome && typeof outcome === 'object' && outcome.hardStopped && sessionKey) {
      await restartChatSession(root, sessionKey, session.options)
    }
  })

  // Don't leave any backend subprocess running after praxis quits.
  app.on('before-quit', () => {
    for (const [sessionKey, s] of sessions) {
      closeSession(s, sessionKey === s.record.projectKey ? 'main' : 'history')
    }
    sessions.clear()
    memoryRevisionBySession.clear()
    runningKeys.clear()
    activeKey = null
    // v8 F1: stop any in-flight spawns' subprocesses, but LEAVE their checkouts on
    // disk — committing/removing here would race the process exit (work lost, or a
    // half-removed worktree). The next launch's pruneOrphans commits each dirty
    // leftover to its branch (recovering the work) and reclaims the checkout.
    for (const { session } of spawns.values()) closeSession(session)
    spawns.clear()
    // v9: forget chat-isolation state (mirror of spawns) — checkouts stay on disk for
    // the next launch's crash recovery, never committed/removed during the quit race.
    dropAll()
  })
}
