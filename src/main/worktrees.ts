import { execFile } from 'child_process'
import { mkdir, symlink, writeFile, readFile, rm, readdir, stat } from 'fs/promises'
import { randomUUID } from 'crypto'
import { join, dirname, resolve } from 'path'
import { promisify } from 'util'
import { normalizeBranchName } from './git'

/**
 * Git-worktree management for F1 (comment → parallel agent session). Each spawned
 * comment agent runs in its OWN `git worktree` on a `praxis/comment-<id>` branch — a
 * private on-disk checkout that shares the repo's object store — so N comments edit
 * the repo truly in parallel with zero cross-writes, and the user's live preview
 * (which stays on the main working tree) is undisturbed until they accept one.
 *
 * Pure (child_process + git + fs only, no electron) so it's unit-testable against a
 * temp repo. Mirrors git.ts's style.
 */

const execFileP = promisify(execFile)
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const SAFE_ENV_TEMPLATES = new Set([
  '.env.example',
  '.env.sample',
  '.env.template',
  '.env.defaults'
])

/** Paths that belong to the machine/tooling, not to an agent turn. */
export function excludedWorktreePath(raw: string): boolean {
  const rel = raw.replaceAll('\\', '/').replace(/^\.\//, '')
  const parts = rel.split('/').filter(Boolean)
  if (parts.includes('node_modules')) return true
  if (parts[0] === '.praxis' || parts[0] === '.dsgn') return true
  const name = parts.at(-1) ?? ''
  if (name.endsWith('.tsbuildinfo')) return true
  if (name === '.env') return true
  return name.startsWith('.env.') && !SAFE_ENV_TEMPLATES.has(name)
}

/** Reset excluded staged paths back to HEAD in either the real or a temporary index. */
async function unstageExcluded(cwd: string, env?: NodeJS.ProcessEnv): Promise<void> {
  const staged = (await git(cwd, ['diff', '--cached', '--name-only'], env)).stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  const excluded = staged.filter(excludedWorktreePath)
  if (excluded.length) await git(cwd, ['reset', '-q', 'HEAD', '--', ...excluded], env)
}

const git = (
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  timeout = 15000
): Promise<{ stdout: string; stderr: string }> =>
  execFileP('git', args, {
    cwd,
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    ...(env ? { env: { ...process.env, ...env } } : {})
  }) as Promise<{ stdout: string; stderr: string }>

// Runtime deps a worktree needs to build/typecheck but that must NEVER enter a
// commit, snapshot, or merge: they're symlinked into every worktree (see
// `doCreateWorktree`) and are enormous/churning. We can't rely on the target repo's
// `.gitignore` to keep them out, because the common `node_modules/` (trailing-slash,
// directory-only) pattern does NOT match the SYMLINK we create — git never treats a
// symlink as a directory — so `git add -A` would stage the symlink, and the merge-back
// then chokes reading it (`EISDIR`) and parks every turn. So we exclude these paths
// explicitly at every stage instead. Consumers also spare them from `git clean` (`-e`).
export const RUNTIME_DEPS = ['node_modules', '.env'] as const

// `git worktree add` mutates shared admin state under .git/worktrees and is NOT
// concurrency-safe (firing several comment spawns at once can race). Serialize the
// create path behind a single in-process chain — creates are fast, so this is cheap.
let createChain: Promise<unknown> = Promise.resolve()

export interface Worktree {
  /** Short unique id; also the worktree directory name and the branch suffix. */
  id: string
  repoRoot: string
  /** The on-disk checkout (under worktreesDir). */
  path: string
  /** `praxis/comment-<id>`. */
  branch: string
  /** The commit the worktree forked from (main-tree HEAD + any uncommitted WIP). */
  baseSha: string
}

/**
 * Snapshot the live tree's FULL current state — tracked modifications AND brand-new
 * untracked files — into a dangling base commit, WITHOUT touching the live tree or
 * its index. `git stash create` omits untracked files (no `-u`), and the praxis
 * interactive agent constantly creates new files, so we build the snapshot in a
 * throwaway index instead: seed it from HEAD, `add -A` the whole working tree,
 * explicitly remove machine-only/sensitive paths (including runtime symlinks that
 * escape a trailing-slash ignore pattern), write a tree, and commit it off HEAD.
 * A clean tree just yields HEAD.
 */
export async function captureBase(repoRoot: string, indexFile: string): Promise<string> {
  const head = (await git(repoRoot, ['rev-parse', 'HEAD'])).stdout.trim()
  const env: NodeJS.ProcessEnv = {
    GIT_INDEX_FILE: indexFile,
    GIT_AUTHOR_NAME: 'Praxis',
    GIT_AUTHOR_EMAIL: 'praxis@local',
    GIT_COMMITTER_NAME: 'Praxis',
    GIT_COMMITTER_EMAIL: 'praxis@local'
  }
  try {
    await git(repoRoot, ['read-tree', 'HEAD'], env)
    await git(repoRoot, ['add', '-A'], env)
    await unstageExcluded(repoRoot, env)
    const tree = (await git(repoRoot, ['write-tree'], env)).stdout.trim()
    if (!tree) return head
    const commit = (
      await git(repoRoot, ['commit-tree', tree, '-p', head, '-m', 'praxis: spawn base (WIP snapshot)'], env)
    ).stdout.trim()
    return commit || head
  } finally {
    await rm(indexFile, { force: true }).catch(() => {})
  }
}

/**
 * Create a fresh worktree forked from the main tree's CURRENT state — including the
 * interactive agent's uncommitted WIP (tracked + untracked, via `captureBase`).
 * node_modules / .env are gitignored (so absent in a fresh checkout) — symlink them
 * in so a spawned agent can typecheck/run. Serialized (see `createChain`) because
 * `git worktree add` races on shared admin state.
 */
export function createWorktree(
  repoRoot: string,
  worktreesDir: string,
  opts: { label?: string; id?: string; branchName?: (id: string) => string } = {}
): Promise<Worktree> {
  const run = createChain.then(() => doCreateWorktree(repoRoot, worktreesDir, opts))
  createChain = run.catch(() => {}) // keep the chain alive even if one create fails
  return run
}

async function doCreateWorktree(
  repoRoot: string,
  worktreesDir: string,
  opts: { label?: string; id?: string; branchName?: (id: string) => string }
): Promise<Worktree> {
  // The id may be assigned up front (so a queued spawn's rail row keeps a stable id
  // before its worktree exists); otherwise generate one.
  const id = opts.id ?? randomUUID().slice(0, 8)
  // Callers other than comment-spawn (e.g. per-chat isolation) can supply their own
  // branch-name scheme; default keeps today's `praxis/comment-<id>` naming.
  const branch = normalizeBranchName((opts.branchName ?? ((i) => `comment-${i}`))(id))
  const dir = join(worktreesDir, id)
  await mkdir(worktreesDir, { recursive: true })

  const baseSha = await captureBase(repoRoot, join(worktreesDir, `.index-${id}`))
  await git(repoRoot, ['worktree', 'add', '-b', branch, dir, baseSha])

  // Symlink gitignored runtime deps so the spawn can build (best-effort). Never add
  // an unignored symlink: if `.gitignore` changes during a turn it would become part
  // of the patch (the root cause of issue #203's committed `.env` symlink).
  for (const name of RUNTIME_DEPS) {
    try {
      await git(repoRoot, ['check-ignore', '-q', '--', name])
      await symlink(join(repoRoot, name), join(dir, name))
    } catch {
      /* absent or already present — fine */
    }
  }
  return { id, repoRoot, path: dir, branch, baseSha }
}

/**
 * Stage + commit everything the spawn changed in its worktree, so the run leaves a
 * durable branch. Returns whether anything was committed (an empty diff → no commit)
 * and the authoritative list of files it touched (from git, not a tool heuristic).
 */
export async function commitWorktree(
  wt: Worktree,
  message: string
): Promise<{ committed: boolean; files: string[] }> {
  // Collapse EVERYTHING the spawn produced into a single commit off the fork
  // point — the uncommitted WIP AND any commits the agent made on its own (the
  // spawn runs bypassPermissions and nothing forbids `git commit`). A soft reset
  // to baseSha keeps the index+worktree but moves the branch ref back, so the one
  // commit below captures the whole change. Without this, an agent that committed
  // and left a clean tree would stage nothing → be reported as "no changes" and
  // have its branch deleted (data loss); and a multi-commit branch would defeat
  // `branchPatch`'s `branch^..branch`. The reset is a no-op when HEAD == baseSha.
  await git(wt.path, ['reset', '--soft', wt.baseSha]).catch(() => {})
  await git(wt.path, ['add', '-A'])
  await unstageExcluded(wt.path)
  const staged = (await git(wt.path, ['diff', '--cached', '--name-only'])).stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  if (staged.length === 0) return { committed: false, files: [] }
  // Identity is forced inline so a spawn commits even if the repo has no user.name.
  // `--no-verify` skips the target repo's pre-commit/commit-msg hooks (husky,
  // lint-staged) — WIP won't pass them and a failing hook would silently abort
  // the spawn's finalization, losing the work.
  await git(wt.path, [
    '-c',
    'user.name=Praxis',
    '-c',
    'user.email=praxis@local',
    'commit',
    '--no-verify',
    '-m',
    message || 'Praxis comment edit'
  ])
  return { committed: true, files: staged }
}

/** The spawn's full change as an applyable patch (its branch vs the fork point).
 *  `--full-index`/`--binary` so `git apply --3way` can locate the base blobs (it
 *  reconstructs the merge ancestor from the patch's blob SHAs). */
export async function diffWorktree(wt: Worktree): Promise<string> {
  return (
    await git(wt.path, ['diff', '--full-index', '--binary', `${wt.baseSha}..HEAD`])
  ).stdout
}

/**
 * The spawn's net change read back from its branch AFTER the worktree is gone (v8 F1
 * Phase 2 — Apply/PR). A spawn makes exactly one commit on top of its WIP-snapshot
 * base, so `<branch>^..<branch>` is precisely the spawn's edits (excluding the base
 * WIP, which is already in the live tree). Empty if the branch is missing.
 */
export async function branchPatch(repoRoot: string, branch: string): Promise<string> {
  try {
    return (
      await git(repoRoot, ['diff', '--full-index', '--binary', `${branch}^..${branch}`])
    ).stdout
  } catch {
    return ''
  }
}

/** Delete a spawn's branch (v8 F1 Phase 2 — Discard). Never throws. */
export async function deleteBranch(repoRoot: string, branch: string): Promise<void> {
  await git(repoRoot, ['branch', '-D', branch]).catch(() => {})
}

/**
 * Re-create and attach a chat's ephemeral branch before a turn can edit its worktree.
 * Successful turns retire the branch immediately; attaching at the next turn boundary
 * keeps crash recovery durable while avoiding one permanent branch per idle chat.
 */
export async function attachWorktreeBranch(wt: Worktree): Promise<void> {
  const current = (await git(wt.path, ['branch', '--show-current'])).stdout.trim()
  if (current === wt.branch) return
  await git(wt.path, ['checkout', '-B', wt.branch, 'HEAD'])
}

/**
 * Detach a clean/landed worktree and delete its now-redundant branch. The worktree
 * remains available as the session cwd; `attachWorktreeBranch` recreates the branch
 * before the next turn. Parked branches never call this helper.
 */
export async function retireWorktreeBranch(wt: Worktree): Promise<void> {
  const current = (await git(wt.path, ['branch', '--show-current'])).stdout.trim()
  if (current === wt.branch) await git(wt.path, ['checkout', '--detach', 'HEAD'])
  await deleteBranch(wt.repoRoot, wt.branch)
}

/** Does this branch exist locally? */
export async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  try {
    await git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
    return true
  } catch {
    return false
  }
}

/**
 * Apply a spawn's patch onto the LIVE working tree — NOT `git merge` (which fails
 * when the interactive agent has uncommitted WIP). Strategy:
 *  1. plain `git apply` (working-tree based) — clean when the live tree still
 *     matches the spawn's fork point, the common case, and tolerates the dirty WIP.
 *  2. on failure, `git apply --3way` (index/HEAD based) — handles real context
 *     drift (e.g. another spawn already landed) and, on textual overlap, leaves
 *     conflict markers for the user to resolve in the ConflictPanel.
 * An empty patch is a no-op success.
 */
export async function applyToWorkingTree(
  repoRoot: string,
  patchText: string,
  tmpDir: string
): Promise<{ ok: boolean; conflict: boolean; error?: string }> {
  if (!patchText.trim()) return { ok: true, conflict: false }
  await mkdir(tmpDir, { recursive: true })
  const patchFile = join(tmpDir, `apply-${randomUUID().slice(0, 8)}.patch`)
  const applyIndex = join(tmpDir, `.index-apply-${randomUUID().slice(0, 8)}`)
  const captureIndex = join(tmpDir, `.index-capture-${randomUUID().slice(0, 8)}`)
  await writeFile(patchFile, patchText, 'utf8')
  try {
    try {
      await git(repoRoot, ['apply', '--whitespace=nowarn', patchFile])
      return { ok: true, conflict: false }
    } catch {
      // Context drifted — fall back to a 3-way merge against the index.
    }
    try {
      // `--3way` normally consults the user's real index, which may legitimately
      // differ from their working tree. That produced the recurring "does not match
      // index" resolver failures. Snapshot the current working tree and run the
      // three-way apply through a throwaway index instead; the user's staged work is
      // never read or mutated.
      const live = await captureBase(repoRoot, captureIndex)
      const env = { GIT_INDEX_FILE: applyIndex }
      await git(repoRoot, ['read-tree', live], env)
      await git(repoRoot, ['update-index', '--refresh'], env)
      await git(repoRoot, ['apply', '--3way', '--whitespace=nowarn', patchFile], env)
      return { ok: true, conflict: false }
    } catch (e) {
      // `git apply --3way` exits non-zero on overlap but still writes the markers.
      const text = msg(e)
      const conflict = /with conflicts|U \w|<<<<<<</.test(text)
      return { ok: false, conflict, error: text }
    }
  } finally {
    await rm(patchFile, { force: true }).catch(() => {})
    await rm(applyIndex, { force: true }).catch(() => {})
    await rm(captureIndex, { force: true }).catch(() => {})
  }
}

/**
 * Auto-apply a finished spawn's change straight onto the LIVE working tree as plain
 * file writes (v8 F1 redesign) — so a comment lands on the branch the user works in,
 * with no separate branch / PR / manual Apply, and is undoable via Cmd+Z. Reads each
 * changed file's FINAL content from the worktree and writes it onto the live tree,
 * but only when SAFE: the live file must be unchanged since the spawn forked
 * (== the base blob) or already at the target. If it drifted (the user edited it
 * concurrently), we refuse the WHOLE batch so nothing is clobbered, and the caller
 * keeps the branch for the manual review fallback. Text only; a binary/deleted
 * change → refuse. Returns the before/after pairs for the undo history.
 */
export async function autoApplyWorktree(
  parentRoot: string,
  wt: Worktree,
  files: string[]
): Promise<{ applied: boolean; edits: { file: string; before: string; after: string }[] }> {
  const fail = { applied: false, edits: [] as { file: string; before: string; after: string }[] }
  const edits: { file: string; before: string; after: string }[] = []
  for (const rel of files) {
    let after: string
    try {
      after = await readFile(join(wt.path, rel), 'utf8') // committed change is in the checkout
    } catch {
      return fail // deleted / renamed / unreadable — let the manual path handle it
    }
    if (after.includes('\0')) return fail // binary — don't round-trip through utf8
    let base = ''
    try {
      base = (await git(parentRoot, ['show', `${wt.baseSha}:${rel}`])).stdout
    } catch {
      base = '' // not in the fork point → a new file the spawn created
    }
    let before = ''
    try {
      before = await readFile(join(parentRoot, rel), 'utf8')
    } catch {
      before = '' // not on disk yet → new file
    }
    // Refuse if the live file changed under us to something other than the target.
    if (before !== base && before !== after) return fail
    edits.push({ file: join(parentRoot, rel), before, after })
  }
  for (const e of edits) {
    if (e.before === e.after) continue
    try {
      await writeFile(e.file, e.after, 'utf8')
    } catch {
      return fail
    }
  }
  return { applied: edits.some((e) => e.before !== e.after), edits }
}

/**
 * Tear down a worktree: remove its checkout and (unless `keepBranch`) delete its
 * branch. Never throws — teardown runs in finalizers. `keepBranch` is set when the
 * spawn committed real work (the branch is the durable record for PR/Apply/Discard).
 */
export async function removeWorktree(
  repoRoot: string,
  wt: Worktree,
  opts: { keepBranch?: boolean } = {}
): Promise<void> {
  try {
    await git(repoRoot, ['worktree', 'remove', '--force', wt.path])
  } catch {
    await rm(wt.path, { recursive: true, force: true }).catch(() => {})
  }
  try {
    await git(repoRoot, ['worktree', 'prune'])
  } catch {
    /* ignore */
  }
  if (!opts.keepBranch) {
    await git(repoRoot, ['branch', '-D', wt.branch]).catch(() => {})
  }
}

/** The branch a leftover checkout is on and its OWNING repo root — both discoverable
 *  only BEFORE the checkout is removed. The owning repo may differ from the project
 *  being opened (the worktrees dir is shared across projects), so crash-recovery keys
 *  its record to this repo, not the opener's. Nulls on any failure (not a worktree). */
async function orphanMeta(dir: string): Promise<{ branch: string | null; repoRoot: string | null }> {
  let branch: string | null = null
  let repoRoot: string | null = null
  try {
    branch = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim() || null
  } catch {
    /* detached / not a worktree */
  }
  try {
    // `--git-common-dir` is the MAIN repo's `.git` (shared across its linked
    // worktrees); its parent is the owning repo root.
    const common = (await git(dir, ['rev-parse', '--git-common-dir'])).stdout.trim()
    if (common) repoRoot = dirname(resolve(dir, common))
  } catch {
    /* not a worktree */
  }
  return { branch, repoRoot }
}

/**
 * Startup recovery: a crash/quit can leave checkouts in worktreesDir whose admin
 * entries git no longer tracks. Prune stale entries, then for each leftover commit
 * any dirty work to its branch (so a crashed-mid-run spawn/chat isn't lost) and remove
 * the checkout. `skip` names ids that are CURRENTLY ACTIVE (a live spawn/chat this
 * session) — never touch those. Branches are kept; we only reclaim the on-disk
 * checkouts. Returns each reclaimed id with `dirty` (whether the worktree had
 * uncommitted changes at reclaim time — checked via `status --porcelain` BEFORE the
 * recovery add/commit, not inferred from commit success) plus its `branch` and owning
 * `repoRoot` (both captured before removal, for the caller's crash-recovery records).
 * Never throws.
 */
export async function pruneOrphans(
  repoRoot: string,
  worktreesDir: string,
  skip: Set<string> = new Set(),
  /** True when a persisted `chatpark-<id>` record exists for this worktree id (the
   *  branch was PARKED). Only then is a dirty per-chat orphan's recovery commit folded
   *  into the parked squash — see the fold block below. Defaults to "never parked". */
  isParked: (id: string) => boolean = () => false
): Promise<Array<{ id: string; dirty: boolean; branch: string | null; repoRoot: string | null }>> {
  try {
    await git(repoRoot, ['worktree', 'prune'])
  } catch {
    /* ignore */
  }
  let entries: string[] = []
  try {
    entries = await readdir(worktreesDir)
  } catch {
    return [] // dir doesn't exist yet — nothing to reclaim
  }
  const reclaimed: Array<{ id: string; dirty: boolean; branch: string | null; repoRoot: string | null }> = []
  for (const id of entries) {
    if (skip.has(id)) continue // a live spawn/chat this session — leave it alone
    const dir = join(worktreesDir, id)
    try {
      if (!(await stat(dir)).isDirectory()) continue
    } catch {
      continue
    }
    // Capture branch + owning repo BEFORE removal (both are lost with the checkout).
    const { branch, repoRoot: ownRoot } = await orphanMeta(dir)
    let dirty = false
    try {
      const status = (await git(dir, ['status', '--porcelain'])).stdout
      dirty = status.trim().length > 0
    } catch {
      /* not a worktree — treat as clean */
    }
    // For a per-chat orphan that was actually PARKED (a persisted `chatpark-<id>` record
    // exists → its tip is the cumulative parked squash), FOLD the dirty recovery commit
    // into that squash — soft-reset HEAD^ first — so the branch stays a single commit and
    // `branchPatch(branch^..branch)` still yields the full pending diff. A stacked
    // recovery commit would otherwise hide the parked work from the park record's Apply.
    //
    // Gating on the park record (not author/message) is essential: a chat branch gains one
    // commit per MERGED turn and `baseSha` advances to the tip on each merge, so a crash
    // mid-turn after a merged turn leaves tip = a praxis-authored, non-base commit that is
    // ALREADY LIVE. Folding that (as an author/message heuristic would) splices merged
    // content into the recovery commit, and the record's Apply then re-applies live changes
    // → spurious 3-way conflicts. Un-parked (merged-tip) orphans just get the WIP committed
    // ON TOP, so branchPatch = only the genuinely-unmerged crash WIP. Comment-spawn orphans
    // have no park record either, so they are unaffected (unchanged prune behavior).
    if (dirty && branch?.startsWith('praxis/chat-') && isParked(id)) {
      await git(dir, ['reset', '--soft', 'HEAD^']).catch(() => {})
    }
    // Best-effort: commit any dirty leftover to its branch before removing the dir,
    // so a crashed-mid-run spawn's work isn't lost.
    try {
      await git(dir, [
        '-c',
        'user.name=Praxis',
        '-c',
        'user.email=praxis@local',
        'add',
        '-A'
      ])
      await git(dir, [
        '-c',
        'user.name=Praxis',
        '-c',
        'user.email=praxis@local',
        'commit',
        '--no-verify',
        '-m',
        'Praxis: recovered orphaned worktree'
      ]).catch(() => {})
    } catch {
      /* not a worktree / already clean */
    }
    try {
      await git(repoRoot, ['worktree', 'remove', '--force', dir])
    } catch {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
    reclaimed.push({ id, dirty, branch, repoRoot: ownRoot })
  }
  try {
    await git(repoRoot, ['worktree', 'prune'])
  } catch {
    /* ignore */
  }
  return reclaimed
}
