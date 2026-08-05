import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import type { BrowserWindow } from 'electron'
import type { AgentEvent, SessionRecord, SessionTranscriptEntry } from '../shared/api'
import { projectKey } from '../shared/projectKey'
import {
  applyParked,
  completeTurn,
  createChatWorktree,
  discardParked,
  stageResolve,
  syncFromLive,
  type ResolvePrep
} from './chat-worktrees'
import { recordEdit } from './edit-history'
import { isRepoRoot } from './git'
import { commitLiveTurn } from './live-commit'
import type { SessionStore } from './sessions-store'
import { branchPatch, deleteBranch, removeWorktree, type Worktree } from './worktrees'

const execFileP = promisify(execFile)
const gitOut = async (cwd: string, args: string[]): Promise<string> =>
  (
    (await execFileP('git', args, { cwd, timeout: 15000, maxBuffer: 16 * 1024 * 1024 })) as {
      stdout: string
    }
  ).stdout

/**
 * Per-CHAT git-worktree isolation glue (v9). Generalizes the comment-spawn
 * worktree machinery to interactive chats: every chat on a git repo ROOT gets one
 * long-lived `praxis/chat-<id>` worktree, forked before its session starts and used
 * as the session's `cwd` for the chat's whole life. After each completed agent turn
 * the chat's work auto-merges back onto the LIVE checkout (which the preview always
 * serves) so the preview updates between turns, and the merged files are committed
 * there too (`live-commit.ts`) so every turn is one revertable commit in the user's
 * own history; on mid-turn drift the turn PARKS on
 * its branch for the existing SessionReview UI instead of clobbering the user's edit.
 *
 * Dependency-injected (`initChatIsolation`) so `agent.ts` barely grows — the pure git
 * mechanics live in `chat-worktrees.ts`/`worktrees.ts`, the Electron/store/window seam
 * is passed in here. Non-repo / subdir / non-git projects get no worktree and every
 * hook no-ops (the chat runs on the live root exactly as before).
 *
 * Serialization: each chat has a single promise `chain`. `beforeTurn` (turn-start
 * live→worktree sync) and `afterTurn` (turn-end commit+merge) are both queued on it,
 * so a turn's sync always waits out the previous turn's in-flight merge — no races
 * with the next `agent:send`.
 */

/** In-memory state for one isolated chat, keyed by its `sessionKey` (= emitKey). */
interface ChatState {
  wt: Worktree
  liveRoot: string
  /** A turn's merge refused (mid-turn drift): work stays on the branch for review. */
  parked: boolean
  /** The persisted park `SessionRecord` id while parked, else null. */
  parkRecordId: string | null
  turnNo: number
  /** Per-chat serialization chain (sync + merge queue). */
  chain: Promise<unknown>
  /** The live session's history record (adopted right after startSession). Held by
   *  reference so a later `agent:tag-session` prUrl mutation is seen live — a chat
   *  whose work was pushed & merged (prUrl set) marks its turns non-revertable. */
  record?: SessionRecord
}

interface Deps {
  worktreesDir: () => string
  store: () => SessionStore
  getWindow: () => BrowserWindow | null
}

let deps: Deps | null = null
const states = new Map<string, ChatState>()

/** Wire the module's Electron/store/window seam. Called once at IPC registration. */
export function initChatIsolation(d: Deps): void {
  deps = d
  states.clear()
}

/** Emit an isolation event on the same webContents path other agent:* events use,
 *  tagged with the chat's `sessionKey` (= emitKey) so the renderer routes it to the
 *  right chat. Sent via the window (not `session.emit`) so a final merge after the
 *  session is disposed still reaches the renderer. */
function emitIsolation(
  sessionKey: string,
  state: 'isolated' | 'merged' | 'parked',
  branch?: string,
  files?: string[],
  group?: string,
  revertable?: boolean
): void {
  // Guard a destroyed webContents: this fires from async turn lifecycle hooks,
  // which can land after the renderer process is killed (OS display sleep).
  const wc = deps?.getWindow()?.webContents
  if (wc && !wc.isDestroyed())
    wc.send('agent:event', {
      type: 'isolation',
      state,
      ...(branch ? { branch } : {}),
      ...(files && files.length ? { files } : {}),
      ...(group ? { group } : {}),
      ...(revertable !== undefined ? { revertable } : {}),
      projectKey: sessionKey
    } satisfies AgentEvent)
}

/**
 * The cwd a chat's session should run in: its private worktree when `liveRoot` is a
 * git repo root, else `liveRoot` itself (all hooks then no-op). Idempotent — a known
 * `sessionKey` (e.g. `agent:restart-chat` reusing the same chat) returns its existing
 * worktree rather than forking a second. On any `createWorktree` failure, falls back
 * to `liveRoot` so a broken repo never blocks the chat.
 */
export async function isolatedCwd(liveRoot: string, sessionKey: string): Promise<string> {
  const existing = states.get(sessionKey)
  if (existing) return existing.wt.path
  if (!deps) return liveRoot
  if (!(await isRepoRoot(liveRoot))) return liveRoot
  try {
    const id = randomUUID().slice(0, 8)
    const wt = await createChatWorktree(liveRoot, id, deps.worktreesDir())
    states.set(sessionKey, {
      wt,
      liveRoot,
      parked: false,
      parkRecordId: null,
      turnNo: 0,
      chain: Promise.resolve()
    })
    emitIsolation(sessionKey, 'isolated', wt.branch)
    return wt.path
  } catch {
    return liveRoot // fork failed — run on the live root, hooks no-op
  }
}

/**
 * Re-stamp a chat session's record back to the LIVE project. A chat runs with `cwd`
 * = its worktree, so `createRecordCapture(root, projectKey(root))` keyed the record to
 * `projectKey(wt.path)` — which would hide the record from `sessions:list` and point
 * `agent:workspace-snapshot`'s reattach at the worktree. Called synchronously right
 * after `startSession` resolves, on every chat path. No-op for a non-isolated chat
 * (its cwd already IS `liveRoot`).
 */
export function adoptSession(sessionKey: string, record: SessionRecord, liveRoot: string): void {
  record.projectKey = projectKey(liveRoot)
  record.projectRoot = liveRoot
  record.projectName = basename(liveRoot) || liveRoot
  const st = states.get(sessionKey)
  if (st) st.record = record
}

/**
 * Turn-start hook: sync the live tree into the worktree so the agent sees the user's
 * between-turn edits. Queued on the chat's chain so it waits out any in-flight
 * post-`done` merge. Skipped while parked (never merge live drift into unmerged work).
 * Awaited by `agent:send` before `session.send`.
 */
export async function beforeTurn(sessionKey: string, _text: string): Promise<void> {
  const st = states.get(sessionKey)
  if (!st) return
  const task = st.chain.then(async () => {
    if (st.parked) return
    await syncFromLive(st.liveRoot, st.wt).catch(() => {})
  })
  st.chain = task.catch(() => {})
  await task
}

/** The tail of a transcript from its LAST user message on — the "last turn" a park
 *  record surfaces in the review UI (prompt + the assistant's reply to it). */
function lastTurn(transcript: SessionTranscriptEntry[]): SessionTranscriptEntry[] {
  const idx = transcript.map((t) => t.role).lastIndexOf('user')
  return idx >= 0 ? transcript.slice(idx) : transcript.slice(-4)
}

/**
 * Turn-end hook (fired on `done` AND `error` to salvage interrupted work): commit the
 * turn, merge it onto the live tree, and advance the fork point. Queued on the chat's
 * chain (never awaited by the caller). On `merged`, records the edits as one undo group
 * `chat:<id>:<turnNo>`, commits the merged files on the live checkout (so the turn is
 * one revertable commit in the user's own history), advances `baseSha`, and unparks. On
 * `parked`, upserts the park record (with the last turn's transcript) for the review UI.
 * `noop` does nothing.
 */
export function afterTurn(sessionKey: string, message: string, transcript: SessionTranscriptEntry[] = []): void {
  const st = states.get(sessionKey)
  if (!st) return
  const turn = lastTurn(transcript)
  st.chain = st.chain
    .then(async () => {
      const turnNo = ++st.turnNo
      const outcome = await completeTurn(st.liveRoot, st.wt, message)
      if (outcome.outcome === 'merged') {
        const group = `chat:${st.wt.id}:${turnNo}`
        for (const e of outcome.edits) {
          recordEdit(st.liveRoot, e.file, e.before, e.after, undefined, group)
        }
        if (outcome.newBase) st.wt.baseSha = outcome.newBase
        await commitLiveTurn(st.liveRoot, outcome.files, {
          title: message,
          body: `Praxis turn ${turnNo} (${st.wt.branch}).`
        })
        if (st.parked) {
          st.parked = false
          dropParkRecord(st)
        }
        // Not revertable once this chat's work has been pushed & merged via a PR.
        emitIsolation(sessionKey, 'merged', st.wt.branch, outcome.files, group, !st.record?.prUrl)
      } else if (outcome.outcome === 'parked') {
        st.parked = true
        upsertParkRecord(st, outcome.files, turn)
        emitIsolation(sessionKey, 'parked', st.wt.branch, outcome.files)
      }
    })
    .catch(() => {
      /* a turn's merge failing must never wedge the chain */
    })
}

/**
 * Persist (or refresh) a park `SessionRecord` keyed `chatpark-<wtId>` under its OWNING
 * repo (`repoRoot`, which for crash recovery may differ from the project being opened).
 * Reuses an existing record's `startedAt`/`title` — and its `filesTouched`/`transcript`
 * when the caller has none — so successive parked turns update ONE record. Deliberately
 * carries NO `sdkSessionId` (that would light up Resume on a still-live chat). Returns
 * the record id, or null if history is unavailable. Shared by live-chat parks and
 * crash-recovery records.
 */
function saveParkRecord(opts: {
  wtId: string
  repoRoot: string
  branch: string
  files: string[]
  transcript?: SessionTranscriptEntry[]
  title: string
}): string | null {
  if (!deps) return null
  const id = `chatpark-${opts.wtId}`
  try {
    const store = deps.store()
    const existing = store.get(id)
    const rec: SessionRecord = {
      id,
      projectKey: projectKey(opts.repoRoot),
      projectRoot: opts.repoRoot,
      projectName: basename(opts.repoRoot) || opts.repoRoot,
      startedAt: existing?.startedAt ?? Date.now(),
      endedAt: Date.now(),
      branch: opts.branch,
      filesTouched: opts.files.length ? opts.files : (existing?.filesTouched ?? []),
      transcript: opts.transcript?.length ? opts.transcript : (existing?.transcript ?? []),
      kind: 'comment',
      title: existing?.title ?? opts.title
    }
    store.save(rec)
    return id
  } catch {
    return null // history is non-critical
  }
}

/** Persist (or refresh) the park record a live PARKED chat surfaces in the sidebar,
 *  carrying the last turn's transcript into the review UI. */
function upsertParkRecord(st: ChatState, files: string[], transcript: SessionTranscriptEntry[] = []): void {
  const id = saveParkRecord({
    wtId: st.wt.id,
    repoRoot: st.liveRoot,
    branch: st.wt.branch,
    files,
    transcript,
    title: 'Unmerged chat changes'
  })
  if (id) st.parkRecordId = id
}

/** Persist a recovery park record for a chat worktree reclaimed after a crash (the
 *  chat is no longer live). `filesTouched` is read from the branch's cumulative diff. */
async function recoveryParkRecord(repoRoot: string, wtId: string, branch: string): Promise<void> {
  const files = await gitOut(repoRoot, ['diff', '--name-only', `${branch}^..${branch}`])
    .then((o) => o.split('\n').map((s) => s.trim()).filter(Boolean))
    .catch(() => [] as string[])
  saveParkRecord({ wtId, repoRoot, branch, files, title: 'Recovered chat changes' })
}

/** Drop a chat's park record once its work merges (or on discard). */
function dropParkRecord(st: ChatState): void {
  if (!deps || !st.parkRecordId) return
  try {
    deps.store().remove(st.parkRecordId)
  } catch {
    /* history is non-critical */
  }
  st.parkRecordId = null
}

/** The LIVE chat (if any) whose worktree is on `branch` in `root` — the seam that lets
 *  `agent:spawn-apply`/`agent:spawn-discard` route a parked LIVE chat's branch through
 *  the isolation path (advance base + unpark) instead of the stock spawn path, while a
 *  crash-recovered (dead) chat's branch falls through to that stock path unchanged. */
function findByBranch(root: string, branch: string): [string, ChatState] | undefined {
  const pk = projectKey(root)
  for (const [key, st] of states) {
    if (st.wt.branch === branch && projectKey(st.liveRoot) === pk) return [key, st]
  }
  return undefined
}

/**
 * `agent:spawn-apply` delegation: if `branch` belongs to a live parked chat, 3-way
 * apply its cumulative diff onto the live tree (serialized on the chat's chain); on a
 * clean apply advance the fork point, unpark, and drop the park record. Returns
 * `{ handled: false }` when no live chat owns the branch, so the caller falls through
 * to the stock spawn-branch apply.
 */
export async function applyParkedBranch(
  root: string,
  branch: string
): Promise<{ handled: boolean; ok?: boolean; conflict?: boolean; error?: string }> {
  const found = findByBranch(root, branch)
  if (!found) return { handled: false }
  const [key, st] = found
  const task = st.chain.then(() => applyParked(st.liveRoot, st.wt))
  st.chain = task.catch(() => {})
  try {
    const res = await task
    if (res.ok) {
      if (res.newBase) st.wt.baseSha = res.newBase
      // A 3-way apply onto a dirty tree can leave conflict markers, so unlike the
      // turn path this commits whatever landed — keeping the apply revertable in one
      // step, markers and all, instead of tangling it with the user's other WIP.
      await commitLiveTurn(st.liveRoot, res.files, {
        title: `Apply ${st.wt.branch} changes`,
        body: 'Praxis parked-chat apply.'
      })
      st.parked = false
      dropParkRecord(st)
      emitIsolation(key, 'merged', st.wt.branch, res.files)
    }
    return { handled: true, ok: res.ok, conflict: res.conflict, error: res.error }
  } catch (e) {
    return { handled: true, ok: false, conflict: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * `agent:spawn-discard` delegation: if `branch` belongs to a live parked chat, reset
 * its worktree back to the fork point (KEEPING the branch — it's still checked out by
 * the live worktree, so a `git branch -D` would fail), unpark, and drop the record.
 * Returns `{ handled: false }` when no live chat owns the branch (falls through to the
 * stock `deleteBranch`).
 */
export async function discardParkedBranch(root: string, branch: string): Promise<{ handled: boolean }> {
  const found = findByBranch(root, branch)
  if (!found) return { handled: false }
  const [key, st] = found
  const task = st.chain.then(() => discardParked(st.wt))
  st.chain = task.catch(() => {})
  await task.catch(() => {})
  st.parked = false
  dropParkRecord(st)
  emitIsolation(key, 'isolated', st.wt.branch)
  return { handled: true }
}

/**
 * "Resolve it" backend for a live PARKED chat (the in-chat conflict card). Stage the
 * worktree so it holds BOTH the user's live edits and the chat's own changes 3-way
 * merged (see `stageResolve`), then:
 *  - clean (no textual overlap) → commit + merge back onto the live tree right here and
 *    unpark; the caller runs NO agent turn. Returns `conflicted: []`.
 *  - overlapping → leave the marker-bearing worktree in place (still parked) and return
 *    the conflicted files; the caller fires ONE agent turn to reconcile them, whose
 *    normal `afterTurn` commits + merges + unparks.
 * Serialized on the chat's chain. `{ ok: false }` if the chat isn't parked.
 */
export async function resolveParkedChat(
  sessionKey: string
): Promise<{ ok: boolean; conflicted: string[]; error?: string }> {
  const st = states.get(sessionKey)
  if (!st) return { ok: false, conflicted: [], error: 'no-chat' }
  if (!st.parked) return { ok: false, conflicted: [], error: 'not-parked' }
  const task = st.chain.then(() => stageResolve(st.liveRoot, st.wt))
  st.chain = task.catch(() => {})
  let prep: ResolvePrep
  try {
    prep = await task
  } catch (e) {
    return { ok: false, conflicted: [], error: e instanceof Error ? e.message : String(e) }
  }
  if (!prep.clean) return { ok: true, conflicted: prep.conflicted }
  // No overlap — the sides merged automatically. Commit + merge onto live and unpark now.
  const merge = st.chain.then(async () => {
    const outcome = await completeTurn(st.liveRoot, st.wt, 'Resolve chat/live merge')
    if (outcome.outcome === 'merged') {
      const group = `chat:${st.wt.id}:resolve`
      for (const e of outcome.edits) {
        recordEdit(st.liveRoot, e.file, e.before, e.after, undefined, group)
      }
      if (outcome.newBase) st.wt.baseSha = outcome.newBase
      await commitLiveTurn(st.liveRoot, outcome.files, {
        title: 'Resolve chat/live merge',
        body: `Praxis conflict resolution (${st.wt.branch}).`
      })
      st.parked = false
      dropParkRecord(st)
      emitIsolation(sessionKey, 'merged', st.wt.branch, outcome.files, group, !st.record?.prUrl)
    }
  })
  st.chain = merge.catch(() => {})
  await merge.catch(() => {})
  return { ok: true, conflicted: [] }
}

/** "Discard changes" backend for a live PARKED chat: drop the chat's unmerged work
 *  (reset its worktree to the fork point) and unpark. Thin wrapper over
 *  `discardParkedBranch` keyed by `sessionKey` so the renderer needn't know the branch. */
export async function discardParkedChat(sessionKey: string): Promise<{ ok: boolean }> {
  const st = states.get(sessionKey)
  if (!st) return { ok: false }
  const res = await discardParkedBranch(st.liveRoot, st.wt.branch)
  return { ok: res.handled }
}

/** Ids of every live chat worktree across ALL open projects — the `pruneOrphans`
 *  skip set must include these so a crash-recovery sweep never reclaims a live chat's
 *  checkout (the global worktrees dir is shared across projects). */
export function liveChatWorktreeIds(): string[] {
  return [...states.values()].map((s) => s.wt.id)
}

/**
 * Does a persisted `chatpark-<id>` record exist for this worktree id? Passed to
 * `pruneOrphans` so its recovery fold only fires on branches that were actually PARKED
 * (tip = cumulative parked squash). A branch whose tip is instead a previously-MERGED
 * turn (baseSha having advanced to it) has NO park record, so it isn't folded — folding
 * there would splice already-live content into the recovery commit, making the record's
 * Apply re-apply merged changes and surface spurious 3-way conflicts.
 */
export function hasParkRecord(wtId: string): boolean {
  if (!deps) return false
  try {
    return !!deps.store().get(`chatpark-${wtId}`)
  } catch {
    return false
  }
}

/** Is every file a branch changed already identical in the live tree? True means the
 *  turn was merged before the crash (safe to drop the leftover branch); false means it
 *  holds genuinely unmerged work that must be recovered, not deleted. */
async function branchAlreadyLive(repoRoot: string, branch: string): Promise<boolean> {
  const patch = await branchPatch(repoRoot, branch)
  if (!patch.trim()) return true // no pending diff — nothing to lose
  let names: string[]
  try {
    names = (await gitOut(repoRoot, ['diff', '--name-only', `${branch}^..${branch}`]))
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    return false
  }
  for (const rel of names) {
    let want: string
    try {
      want = await gitOut(repoRoot, ['show', `${branch}:${rel}`])
    } catch {
      return false // deleted/renamed by the turn — treat as unmerged
    }
    let live = ''
    try {
      live = await readFile(join(repoRoot, rel), 'utf8')
    } catch {
      live = '' // not on disk — unmerged new file
    }
    if (live !== want) return false
  }
  return true
}

/**
 * Crash recovery for chat worktrees reclaimed by `pruneOrphans` (called from
 * `agent:open-project`). For each reclaimed `praxis/chat-*` orphan, keyed to its OWN repo
 * (which may differ from the project being opened — the worktrees dir is shared):
 *  - dirty → a crashed-mid-turn chat: surface its work via a recovery park record.
 *  - clean + already recorded → a persisted park: keep its record + branch untouched.
 *  - clean + unrecorded → usually a merged chat's leftover branch (delete it), BUT a
 *    crash between commit and merge leaves a clean branch holding a real unmerged turn;
 *    only delete when its diff is already live, else recover it (never eat the work).
 * Comment-spawn orphans are ignored here (their pre-existing prune behavior stands).
 */
export async function handleReclaimed(
  reclaimed: Array<{ id: string; dirty: boolean; branch: string | null; repoRoot: string | null }>
): Promise<void> {
  if (!deps) return
  for (const r of reclaimed) {
    if (!r.branch?.startsWith('praxis/chat-') || !r.repoRoot) continue
    if (r.dirty) {
      await recoveryParkRecord(r.repoRoot, r.id, r.branch)
      continue
    }
    if (deps.store().get(`chatpark-${r.id}`)) continue // a persisted park — leave it
    if (await branchAlreadyLive(r.repoRoot, r.branch)) {
      await deleteBranch(r.repoRoot, r.branch)
    } else {
      await recoveryParkRecord(r.repoRoot, r.id, r.branch)
    }
  }
}

/**
 * Tear down one chat's worktree (close-chat / close-project / open-project's replace
 * path). Runs one final commit+merge to salvage the last turn, then removes the
 * checkout — keeping the branch only when parked (its work still awaits review).
 * Never throws (teardown runs in finalizers).
 */
export async function releaseChat(sessionKey: string): Promise<void> {
  const st = states.get(sessionKey)
  if (!st) return
  states.delete(sessionKey)
  try {
    await st.chain.catch(() => {})
    if (!st.parked) {
      const turnNo = ++st.turnNo
      const outcome = await completeTurn(st.liveRoot, st.wt, 'praxis chat changes')
      if (outcome.outcome === 'merged') {
        for (const e of outcome.edits) {
          recordEdit(
            st.liveRoot,
            e.file,
            e.before,
            e.after,
            undefined,
            `chat:${st.wt.id}:${turnNo}`
          )
        }
        await commitLiveTurn(st.liveRoot, outcome.files, {
          title: 'Praxis chat changes',
          body: `Praxis final turn (${st.wt.branch}).`
        })
      } else if (outcome.outcome === 'parked') {
        st.parked = true
        upsertParkRecord(st, outcome.files)
      }
    }
    await removeWorktree(st.liveRoot, st.wt, { keepBranch: st.parked })
  } catch {
    /* teardown never throws */
  }
}

/** Forget every chat's in-memory state on quit — a mirror of the spawns map. The
 *  checkouts stay on disk for the next launch's crash recovery (C4). */
export function dropAll(): void {
  states.clear()
}

/** The isolation status of a live chat for `agent:workspace-snapshot` (renderer
 *  reload reattach). Undefined for a non-isolated chat (the renderer treats that as
 *  live). */
export function isolationSnapshot(
  sessionKey: string
): { state: 'live' | 'isolated' | 'parked'; branch?: string } | undefined {
  const st = states.get(sessionKey)
  if (!st) return undefined
  return {
    state: st.parked ? 'parked' : 'isolated',
    ...(st.wt.branch ? { branch: st.wt.branch } : {})
  }
}
