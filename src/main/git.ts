import { execFile } from 'child_process'
import { realpath } from 'fs/promises'
import { promisify } from 'util'
import type { BranchResult } from '../shared/api'

/**
 * Branch management for the opened project: praxis does its work on a `praxis/<…>`
 * branch so the user's main branch stays clean. Pure (child_process + git only,
 * no electron) so it's unit-testable against a temp repo.
 */

const execFileP = promisify(execFile)
const PRAXIS_PREFIX = 'praxis/'
// Work branches created before the dsgn→praxis rename (2026-07). Recognized as
// ours (keep working on them, allow publish) but never created anymore.
const LEGACY_PREFIX = 'dsgn/'

/** Is this branch a Praxis work branch (current or legacy prefix)? */
export function isWorkBranch(branch: string): boolean {
  return branch.startsWith(PRAXIS_PREFIX) || branch.startsWith(LEGACY_PREFIX)
}
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const git = (root: string, args: string[], timeout = 8000): Promise<{ stdout: string }> =>
  execFileP('git', args, { cwd: root, timeout, maxBuffer: 4 * 1024 * 1024 }) as Promise<{
    stdout: string
  }>

export async function isGitRepo(root: string): Promise<boolean> {
  try {
    const { stdout } = await git(root, ['rev-parse', '--is-inside-work-tree'])
    return stdout.trim() === 'true'
  } catch {
    return false
  }
}

/**
 * Only manage the branch when the opened folder is the repo's TOP LEVEL — not a
 * subdirectory of a larger repo (e.g. a fixture inside this repo, or a package
 * in a monorepo), where switching the whole repo's branch would be surprising.
 */
export async function isRepoRoot(root: string): Promise<boolean> {
  // '' means "this folder IS the top level"; a path or null both mean it isn't.
  return (await enclosingRepoRoot(root)) === ''
}

/**
 * Which repository this folder actually belongs to, for explaining a refusal.
 *
 * Returns `''` when the folder IS the top level, the enclosing repo's path when
 * it's a subdirectory of one, and `null` when git can't see a repo at all. The
 * three cases need three different pieces of advice, and telling them apart is
 * the difference between "open the repo's top-level folder" (useless when the
 * user has never heard of that repo) and naming the path they should open — or
 * telling them there's no repo here and `git init` is the answer.
 */
export async function enclosingRepoRoot(root: string): Promise<string | null> {
  try {
    const { stdout } = await git(root, ['rev-parse', '--show-toplevel'])
    const top = stdout.trim()
    if (!top) return null
    return (await realpath(top)) === (await realpath(root)) ? '' : top
  } catch {
    return null
  }
}

/** Check out an EXISTING branch by its exact name (no praxis/ coercion) — for the
 *  titlebar branch switcher. Carries uncommitted changes across like git does. */
export async function checkoutBranch(root: string, branch: string): Promise<BranchResult> {
  try {
    // `--` end-of-options so a branch name that happens to start with `-` can't
    // be parsed as a git flag (defense-in-depth; the value comes from the IPC).
    await git(root, ['checkout', '--end-of-options', branch])
    return { isRepo: true, branch, created: false }
  } catch (e) {
    return {
      isRepo: true,
      branch: (await getCurrentBranch(root)) ?? branch,
      created: false,
      error: msg(e)
    }
  }
}

/** Local branches (current first, then praxis/* newest-active, then the rest). */
export async function listBranches(
  root: string
): Promise<{ branches: string[]; current: string | null }> {
  try {
    const { stdout } = await git(root, [
      'for-each-ref',
      '--sort=-committerdate',
      '--format=%(refname:short)',
      'refs/heads'
    ])
    const all = stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    const current = await getCurrentBranch(root)
    // Current first, then praxis/* (recent), then everything else.
    const rank = (b: string): number => (b === current ? 0 : isWorkBranch(b) ? 1 : 2)
    const branches = [...all].sort((a, b) => rank(a) - rank(b))
    return { branches, current }
  } catch {
    return { branches: [], current: null }
  }
}

export async function getCurrentBranch(root: string): Promise<string | null> {
  try {
    const { stdout } = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
    const b = stdout.trim()
    return b && b !== 'HEAD' ? b : null // null = detached HEAD
  } catch {
    return null
  }
}

/** Make a git-ref-safe `praxis/<…>` branch name from a requested name or bare suffix. */
export function normalizeBranchName(requested: string): string {
  const raw = requested.trim()
  const withPrefix = raw.startsWith(PRAXIS_PREFIX) ? raw : PRAXIS_PREFIX + raw
  const suffix = withPrefix
    .slice(PRAXIS_PREFIX.length)
    .replace(/[\s~^:?*[\]\\@{}]+/g, '-') // git-forbidden chars + whitespace → -
    .replace(/\.{2,}/g, '-') // no ".."
    .replace(/\/{2,}/g, '/') // collapse //
    .replace(/^[/.-]+|[/.-]+$/g, '') // trim leading/trailing / . -
  return PRAXIS_PREFIX + (suffix || 'work')
}

async function branchExists(root: string, name: string): Promise<boolean> {
  try {
    await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])
    return true
  } catch {
    return false
  }
}

/** Switch to (creating if needed) a specific praxis/* branch. */
export async function switchBranch(root: string, requested: string): Promise<BranchResult> {
  if (!(await isRepoRoot(root))) return { isRepo: false, branch: null, created: false }
  const name = normalizeBranchName(requested)
  const cur = await getCurrentBranch(root)
  if (cur === name) return { isRepo: true, branch: name, created: false }
  const existed = await branchExists(root, name)
  try {
    // checkout -b carries uncommitted changes onto the new branch (nothing lost);
    // checking out an existing branch can fail if changes conflict — report that.
    await git(root, existed ? ['checkout', name] : ['checkout', '-b', name])
    return { isRepo: true, branch: name, created: !existed }
  } catch (e) {
    return { isRepo: true, branch: cur, created: false, error: msg(e) }
  }
}

/**
 * Ensure work happens on a `praxis/*` branch. If already on one, keep it; else
 * create `praxis/<current-branch>` (or `praxis/work` when detached) off HEAD.
 */
export async function ensureBranch(root: string): Promise<BranchResult> {
  if (!(await isRepoRoot(root))) return { isRepo: false, branch: null, created: false }
  const cur = await getCurrentBranch(root)
  if (cur && isWorkBranch(cur)) return { isRepo: true, branch: cur, created: false }
  return switchBranch(root, PRAXIS_PREFIX + (cur ?? 'work'))
}
