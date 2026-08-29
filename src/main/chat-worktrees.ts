import { execFile } from 'child_process'
import { readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { promisify } from 'util'
import {
  applyToWorkingTree,
  attachWorktreeBranch,
  autoApplyWorktree,
  captureBase,
  commitWorktree,
  createWorktree,
  diffWorktree,
  excludedWorktreePath,
  RUNTIME_DEPS,
  type Worktree
} from './worktrees'

/**
 * Per-CHAT git-worktree isolation (v9). Generalizes the comment-spawn worktree
 * machinery (`worktrees.ts`) to interactive chats: every chat on a git repo root
 * runs in its own long-lived `praxis/chat-<id>` worktree, and after each completed
 * agent turn its work auto-merges back onto the LIVE checkout so the preview (which
 * always serves the live tree) updates between turns. On mid-turn drift the turn
 * parks on the branch for review instead of clobbering the user's edit.
 *
 * Pure (child_process + git + fs via worktrees.ts, no electron) so it's unit-testable
 * against temp repos. The Electron glue lives in `chat-isolation.ts`.
 *
 * Base-advance contract: git-state operations that MUST re-point the fork point
 * (`syncFromLive`) mutate `wt.baseSha` in place; turn/apply operations return the new
 * base as `newBase` and let the caller (`chat-isolation.ts`) own the mutation, so the
 * advance only happens on a successful merge/apply.
 */

const execFileP = promisify(execFile)

const git = (
  cwd: string,
  args: string[],
  timeout = 15000
): Promise<{ stdout: string; stderr: string }> =>
  execFileP('git', args, { cwd, timeout, maxBuffer: 16 * 1024 * 1024 }) as Promise<{
    stdout: string
    stderr: string
  }>

// `git clean -fd` that spares the symlinked runtime deps. They're untracked (kept out
// of every commit — see RUNTIME_DEPS) AND may not be gitignored in a way that matches
// the symlink, so a bare `clean -fd` would delete them and break the next build. `-e`
// re-excludes each so the checkout keeps its node_modules/.env across resets.
const cleanArgs = (): string[] => ['clean', '-fd', ...RUNTIME_DEPS.flatMap((d) => ['-e', d])]

/** Binary-safe `git show <ref>:<path>` — `null` when the path didn't exist at that ref. */
const readBlobAt = async (cwd: string, ref: string, rel: string): Promise<Buffer | null> => {
  try {
    const res = (await execFileP('git', ['show', `${ref}:${rel}`], {
      cwd,
      timeout: 15000,
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'buffer'
    })) as unknown as { stdout: Buffer }
    return res.stdout
  } catch {
    return null
  }
}

const revParse = async (cwd: string, rev: string): Promise<string> =>
  (await git(cwd, ['rev-parse', rev])).stdout.trim()

/** Repo-relative files changed between the worktree's fork point and its HEAD. */
async function changedFiles(wt: Worktree): Promise<string[]> {
  return (await git(wt.path, ['diff', '--name-only', `${wt.baseSha}..HEAD`])).stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Git-style unresolved markers must never cross from a resolution worktree to live. */
export async function conflictMarkerFiles(wt: Worktree, files: string[]): Promise<string[]> {
  const marked: string[] = []
  for (const rel of files) {
    let text: string
    try {
      text = await readFile(join(wt.path, rel), 'utf8')
    } catch {
      continue
    }
    if (/^<<<<<<< .+$/m.test(text) && /^=======$/m.test(text) && /^>>>>>>> .+$/m.test(text)) {
      marked.push(rel)
    }
  }
  return marked
}

/**
 * Fork a fresh worktree for a chat on branch `praxis/chat-<id>`, forking from the live
 * tree's CURRENT state (uncommitted WIP included, via `captureBase`) and symlinking
 * node_modules/.env — exactly like comment spawns, only the branch-name scheme differs.
 */
export function createChatWorktree(
  liveRoot: string,
  id: string,
  worktreesDir: string
): Promise<Worktree> {
  return createWorktree(liveRoot, worktreesDir, { id, branchName: (i) => `chat-${i}` })
}

/**
 * Turn-start drift sync (live → worktree). Snapshot the live tree; if the worktree's
 * HEAD tree already matches it there's no drift — no-op. Otherwise reset the worktree
 * hard onto the fresh live snapshot (`clean` first drops any stray files but spares the
 * symlinked runtime deps via `-e` — see `cleanArgs`). The caller guarantees the worktree
 * is CLEAN at turn start (everything was committed at the previous turn's `done`), so
 * the reset can never conflict. Advances `wt.baseSha` in place to the new fork point.
 */
export async function syncFromLive(liveRoot: string, wt: Worktree): Promise<{ synced: boolean }> {
  const indexFile = join(dirname(wt.path), `.index-sync-${wt.id}`)
  const live = await captureBase(liveRoot, indexFile)
  const liveTree = await revParse(liveRoot, `${live}^{tree}`)
  const wtTree = await revParse(wt.path, 'HEAD^{tree}')
  if (liveTree === wtTree) {
    await attachWorktreeBranch(wt)
    return { synced: false }
  }
  await git(wt.path, cleanArgs())
  await git(wt.path, ['reset', '--hard', live])
  wt.baseSha = live
  await attachWorktreeBranch(wt)
  return { synced: true }
}

export interface TurnOutcome {
  outcome: 'noop' | 'merged' | 'parked'
  files: string[]
  edits: { file: string; before: string; after: string }[]
  /** Worktree HEAD after a merge — the caller advances `wt.baseSha` to it. */
  newBase?: string
}

/**
 * Turn-end commit + merge. Squash the turn's work into one commit off `baseSha` (soft
 * reset means successive parked turns re-squash into ONE cumulative commit, so the
 * branch is always the full pending diff), then auto-apply onto the live tree:
 *  - nothing committed            → `noop`
 *  - applied onto the live tree   → `merged` (+ `edits` for the undo history, `newBase`)
 *  - refused (live drifted)       → `parked` (work stays on the branch for review)
 *  - already at target (no write) → `noop`
 */
export async function completeTurn(
  liveRoot: string,
  wt: Worktree,
  message: string,
  opts: { land?: boolean } = {}
): Promise<TurnOutcome> {
  const { committed, files } = await commitWorktree(wt, message)
  if (!committed) {
    const newBase = await revParse(wt.path, 'HEAD')
    return { outcome: 'noop', files: [], edits: [], newBase }
  }
  // Failed/interrupted turns are durable on their recovery branch but never land
  // automatically. The user can inspect, resolve or discard the partial result.
  if (opts.land === false) return { outcome: 'parked', files, edits: [] }
  if ((await conflictMarkerFiles(wt, files)).length) {
    return { outcome: 'parked', files, edits: [] }
  }
  const { applied, edits } = await autoApplyWorktree(liveRoot, wt, files)
  if (applied) {
    const newBase = await revParse(wt.path, 'HEAD')
    return { outcome: 'merged', files, edits, newBase }
  }
  // autoApplyWorktree returns `applied:false` with an EMPTY edits list only when it
  // refused the batch (drift/binary/delete); a non-empty edits list with no write means
  // the live tree already matched the target — a no-op, not a park.
  if (edits.length === 0) return { outcome: 'parked', files, edits: [] }
  const newBase = await revParse(wt.path, 'HEAD')
  return { outcome: 'noop', files, edits: [], newBase }
}

export interface ApplyOutcome {
  ok: boolean
  conflict: boolean
  files: string[]
  /** Worktree HEAD when the apply landed cleanly — caller advances `wt.baseSha`. */
  newBase?: string
  error?: string
}

/**
 * Explicit user "Apply" of a PARKED chat: 3-way apply the branch's cumulative diff onto
 * the live tree (tolerates the user's uncommitted WIP; may leave conflict markers, which
 * is acceptable for an explicit action). On a clean apply, return `newBase` so the caller
 * advances the fork point and unparks.
 */
export async function applyParked(liveRoot: string, wt: Worktree): Promise<ApplyOutcome> {
  const patch = await diffWorktree(wt)
  const files = await changedFiles(wt)
  const tmpDir = join(dirname(wt.path), '.apply-tmp')
  const res = await applyToWorkingTree(liveRoot, patch, tmpDir)
  if (res.ok) {
    const newBase = await revParse(wt.path, 'HEAD')
    return { ok: true, conflict: false, files, newBase }
  }
  return { ok: false, conflict: res.conflict, files, error: res.error }
}

export interface ResolvePrep {
  /** Files left carrying `<<<<<<<` conflict markers — the agent must reconcile these.
   *  Empty ⇒ the two sides merged with no textual overlap (no agent turn needed). */
  conflicted: string[]
  /** Every file the chat's branch touched (the resolution turn's blast radius). */
  files: string[]
  clean: boolean
}

/**
 * Prepare a PARKED chat's worktree for AI (or clean) conflict resolution. A park means
 * the user edited the same files live that the chat edited, so the auto-merge refused.
 * To let the agent reconcile BOTH sides it must SEE both: reset the worktree onto the
 * user's current live tree, then re-lay the chat's own diff on top with a 3-way apply —
 * which merges cleanly where the two didn't overlap and drops `<<<<<<<`/`>>>>>>>` markers
 * where they did. Advances `wt.baseSha` to the live snapshot so the eventual merge-back
 * (after the agent resolves) is a clean, driftless apply. The chat's diff is captured
 * BEFORE the reset (the reset would erase it). Returns the marker-bearing files.
 *
 * Binary files (images etc.) can never carry `<<<<<<<` markers, so a genuine binary
 * conflict — live and chat both changed the same file to DIFFERENT bytes — produces no
 * marker for the scan below to find. Left alone, `applyToWorkingTree`'s 3-way apply
 * either fast-forwards cleanly or silently leaves the live bytes in place, which reads
 * as "clean" while quietly dropping the chat's own change. Detect that case by comparing
 * the post-apply file against the chat's own target blob (captured via `chatHead`, its
 * HEAD before the reset below) and, when they differ, resolve by policy: keep the chat's
 * version — there's no way to "merge" two PNGs, and that's what the review UI already
 * tells the user Resolve does.
 */
export async function stageResolve(liveRoot: string, wt: Worktree): Promise<ResolvePrep> {
  const porcelain = (await git(wt.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all']))
    .stdout
    .split('\0')
    .filter(Boolean)
  const meaningful = porcelain.filter((entry) => {
    // The first path in each record carries the two-byte status prefix; a second
    // rename/copy path does not. Machine-only paths are excluded from every
    // snapshot/commit and must not make a runtime-dep symlink look like an edit.
    const rel = /^[ MADRCU?!]{2} /.test(entry) ? entry.slice(3) : entry
    return !excludedWorktreePath(rel)
  })
  if (meaningful.length) {
    throw new Error(
      'the chat worktree changed after it was parked; finish this turn first, then prepare the cumulative conflict on the next turn'
    )
  }
  const chatHead = await revParse(wt.path, 'HEAD') // the chat's own cumulative work, before we move the ref
  const patch = await diffWorktree(wt) // chat's cumulative changes — capture before reset
  const files = await changedFiles(wt)
  const tip = await revParse(wt.path, 'HEAD') // the parked squash — sole restore point
  const oldBase = wt.baseSha
  const indexFile = join(dirname(wt.path), `.index-resolve-${wt.id}`)
  const live = await captureBase(liveRoot, indexFile) // snapshot the user's live tree
  await git(wt.path, cleanArgs())
  await git(wt.path, ['reset', '--hard', live]) // worktree := live
  wt.baseSha = live
  const tmpDir = join(dirname(wt.path), '.resolve-tmp')
  const laid = await applyToWorkingTree(wt.path, patch, tmpDir) // re-lay chat changes (3-way markers ok)
  if (!laid.ok && !laid.conflict) {
    // Hard apply failure (not a marker-conflict): the reset above already moved
    // the branch to the live snapshot, so without restoring, the parked work
    // would exist NOWHERE. Put the branch back and report instead of returning
    // a bogus "clean" that would silently merge nothing.
    await git(wt.path, ['reset', '--hard', tip]).catch(() => {})
    wt.baseSha = oldBase
    throw new Error(
      `couldn't re-apply this chat's changes onto the current project state${laid.error ? `: ${laid.error.slice(0, 200)}` : ''}`
    )
  }
  const conflicted: string[] = []
  for (const rel of files) {
    let text = ''
    try {
      text = await readFile(join(wt.path, rel), 'utf8')
    } catch {
      continue // deleted/renamed — no marker to find
    }
    if (text.includes('<<<<<<<') && text.includes('>>>>>>>')) {
      conflicted.push(rel)
      continue
    }
    const target = await readBlobAt(wt.path, chatHead, rel)
    if (!target || !target.includes(0)) continue // text, or removed on the chat's side — marker scan already covers it
    const current = await readFile(join(wt.path, rel)).catch(() => null)
    if (!current || !target.equals(current)) await writeFile(join(wt.path, rel), target)
  }
  return { conflicted, files, clean: conflicted.length === 0 }
}

/**
 * Explicit user "Discard" of a PARKED chat: reset the worktree back to its fork point
 * and drop any stray files. The branch is intentionally NOT deleted — the chat is still
 * live and its worktree keeps the branch checked out (a `git branch -D` would fail).
 */
export async function discardParked(wt: Worktree): Promise<void> {
  await git(wt.path, ['reset', '--hard', wt.baseSha]).catch(() => {})
  await git(wt.path, cleanArgs()).catch(() => {})
}
