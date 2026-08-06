import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/**
 * Per-turn commits on the LIVE checkout.
 *
 * A chat's work is committed on its own `praxis/chat-<id>` worktree branch, but the
 * merge back onto the live tree is a plain file WRITE (`autoApplyWorktree`) — so
 * without this the user's own checkout just accumulated one giant uncommitted diff
 * until Publish. That makes a single turn impossible to review or roll back with git.
 * After every turn that actually changed something, `commitLiveTurn` lands those exact
 * files as one commit on whatever branch the live checkout is on, so `git log` reads as
 * the session's progress and any turn can be undone with `git revert`.
 *
 * Deliberately narrow, because this writes into the user's repo:
 *  - only the files the turn itself touched are staged (never `add -A`), so concurrent
 *    hand edits elsewhere stay uncommitted and a revert can't take them with it;
 *  - the commit is a PATHSPEC (partial) commit, so anything the user had staged for
 *    their own commit is left staged and untouched;
 *  - the praxis-managed `.praxis/` sidecar is never committed (same rule as
 *    `commitWorktree`);
 *  - only inside a git repo ROOT — for a subdirectory project, committing would sweep
 *    up the enclosing repo, which is exactly the surprise `isRepoRoot` exists to avoid;
 *  - best-effort: any git failure (mid-merge partial commit, hooks, missing identity)
 *    returns `committed: false` and never throws. A failed commit just leaves the
 *    change in the working tree, i.e. the behavior before this existed.
 *
 * Pure (child_process + git only, no electron) so it's unit-testable against temp repos.
 */

const execFileP = promisify(execFile)

const git = (root: string, args: string[]): Promise<{ stdout: string }> =>
  execFileP('git', args, { cwd: root, timeout: 15000, maxBuffer: 16 * 1024 * 1024 }) as Promise<{
    stdout: string
  }>

/** Longest commit SUBJECT we write — keeps `git log --oneline` readable when the turn's
 *  prompt was a paragraph. The full prompt is not repeated in the body (the chat has it). */
const MAX_TITLE = 72

/** One line, collapsed whitespace, capped — a user prompt makes the commit subject. */
export function commitTitle(message: string): string {
  const line = (message ?? '').split('\n')[0].replace(/\s+/g, ' ').trim()
  if (!line) return 'Praxis chat edit'
  return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1).trimEnd()}…` : line
}

/** Repo-relative paths this module is willing to commit: no praxis sidecar, no dupes. */
export function committableFiles(files: string[]): string[] {
  const seen = new Set<string>()
  for (const raw of files) {
    const rel = (raw ?? '').trim()
    if (!rel || rel === '.praxis' || rel.startsWith('.praxis/')) continue
    seen.add(rel)
  }
  return [...seen]
}

export interface LiveCommit {
  committed: boolean
  /** The new HEAD when we committed. */
  sha?: string
  /** The files that actually went into the commit (empty when nothing was committed). */
  files: string[]
}

/** Is `root` the TOP LEVEL of a git repo? (Local copy of `git.ts`'s check without the
 *  realpath round-trip: a mismatch here just means we skip the commit.) */
async function atRepoRoot(root: string): Promise<boolean> {
  try {
    const inside = (await git(root, ['rev-parse', '--is-inside-work-tree'])).stdout.trim()
    if (inside !== 'true') return false
    // `--show-cdup` is empty exactly at the top level — cheaper and symlink-proof
    // compared with comparing `--show-toplevel` against `root`.
    return (await git(root, ['rev-parse', '--show-cdup'])).stdout.trim() === ''
  } catch {
    return false
  }
}

/**
 * Commit the files a finished turn changed onto the live checkout. `files` are
 * repo-relative (git's own staged list from `commitWorktree`, not a tool heuristic).
 * Returns `committed: false` — never throws — when there's nothing to commit, the
 * project isn't a git repo root, or git refuses.
 */
export async function commitLiveTurn(
  root: string,
  files: string[],
  message: { title: string; body?: string }
): Promise<LiveCommit> {
  const paths = committableFiles(files)
  if (!paths.length) return { committed: false, files: [] }
  if (!(await atRepoRoot(root))) return { committed: false, files: [] }
  const pathArgs = ['--', ...paths]
  try {
    // Stage first: a pathspec commit only matches paths git already knows, so a file
    // the turn CREATED needs the add. `add` also records deletions.
    await git(root, ['add', ...pathArgs])
    const staged = (await git(root, ['diff', '--cached', '--name-only', ...pathArgs])).stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    // The merge wrote content identical to HEAD (e.g. the user had already made the
    // same edit by hand) — nothing to record.
    if (!staged.length) return { committed: false, files: [] }
    await git(root, [
      // Forced identity so a repo with no user.name still commits, and `--no-verify`
      // so a target repo's pre-commit hook (husky/lint-staged on a half-finished
      // refactor) can't abort the turn's commit. Same reasoning as `commitWorktree`.
      '-c',
      'user.name=Praxis',
      '-c',
      'user.email=praxis@local',
      'commit',
      '--no-verify',
      '-m',
      commitTitle(message.title),
      ...(message.body ? ['-m', message.body] : []),
      // Pathspec ⇒ partial commit: commits these files' working-tree content and
      // leaves the rest of the index (the user's own staged work) alone.
      ...pathArgs
    ])
    const sha = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim()
    return { committed: true, sha, files: staged }
  } catch {
    // Best-effort: the change is already merged into the working tree, so a failed
    // commit is exactly the pre-existing behavior, not lost work.
    return { committed: false, files: [] }
  }
}
