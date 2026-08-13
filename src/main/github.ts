/**
 * "Connect to GitHub" — the first-publish bridge (see docs/PROGRESS.md). A
 * freshly scaffolded project is a local-only repo with no `origin`; Publish
 * (annotations.ts) assumes a remote already exists and dead-ends with a git-
 * jargon error. This module gives the renderer a distinct, explicit step that
 * creates the GitHub repo, wires `origin`, and pushes the built work — so the
 * repo's default branch reflects what the user made (Option B), not the bare
 * scaffold. Publish stays exactly as-is; it just works once a remote is present.
 *
 * We lean on the `gh` CLI (praxis's audience clones + `bun install`, and the
 * codebase already shells out to gh for Publish). Everything here is best-effort
 * and defensive: any failure returns `{ ok: false, error }` rather than throwing.
 */
import { execFile } from 'child_process'
import { ipcMain } from 'electron'
import { basename } from 'path'
import { promisify } from 'util'
import type { GithubConnectOptions, GithubConnectResult, GithubStatus } from '../shared/api'
import { resolveConnectPlan, sanitizeRepoName } from '../shared/github'

const execFileP = promisify(execFile)
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const git = (root: string, args: string[], timeout = 10000): Promise<{ stdout: string }> =>
  execFileP('git', args, { cwd: root, timeout, maxBuffer: 4 * 1024 * 1024 }) as Promise<{
    stdout: string
  }>

const gh = (root: string, args: string[], timeout = 30000): Promise<{ stdout: string }> =>
  execFileP('gh', args, { cwd: root, timeout, maxBuffer: 10 * 1024 * 1024 }) as Promise<{
    stdout: string
  }>

/** trimmed stdout, or '' on any failure. */
const tryOut = async (p: Promise<{ stdout: string }>): Promise<string> => {
  try {
    return (await p).stdout.trim()
  } catch {
    return ''
  }
}

/**
 * Report the project's GitHub link + gh readiness, and prefill the connect
 * sheet. Never throws — a non-repo / missing gh degrades to a describable state.
 */
export async function githubStatus(root: string): Promise<GithubStatus> {
  const suggestedName = sanitizeRepoName(basename(root) || 'my-app')

  const remoteUrl = await tryOut(git(root, ['remote', 'get-url', 'origin']))
  if (remoteUrl) {
    return { connected: true, remoteUrl, gh: 'ok', suggestedName }
  }

  // No remote yet — probe gh so the sheet can guide install/login before the user
  // fills anything in.
  try {
    await execFileP('gh', ['--version'], { timeout: 8000 })
  } catch {
    return { connected: false, gh: 'missing', suggestedName }
  }
  try {
    await execFileP('gh', ['auth', 'status'], { timeout: 8000 })
  } catch {
    return { connected: false, gh: 'unauthed', suggestedName }
  }

  const login = await tryOut(gh(root, ['api', 'user', '-q', '.login'], 8000))
  const orgsRaw = await tryOut(gh(root, ['api', 'user/orgs', '-q', '.[].login'], 8000))
  const orgs = orgsRaw ? orgsRaw.split('\n').filter(Boolean) : []
  return {
    connected: false,
    gh: 'ok',
    suggestedName,
    ...(login ? { login } : {}),
    ...(orgs.length ? { orgs } : {})
  }
}

/**
 * Create the GitHub repo, wire `origin`, and push the built work as the default
 * branch (Option B). Preconditions are re-checked here — the sheet's status can
 * go stale between open and submit.
 */
export async function connectToGitHub(
  root: string,
  opts: GithubConnectOptions
): Promise<GithubConnectResult> {
  let current: string
  try {
    await git(root, ['rev-parse', '--is-inside-work-tree'])
    current = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
  } catch {
    return { ok: false, error: 'Not a git repository.' }
  }
  if (current === 'HEAD') {
    return { ok: false, error: 'Detached HEAD — check out a branch first.' }
  }
  if (await tryOut(git(root, ['remote', 'get-url', 'origin']))) {
    return { ok: false, error: 'Already connected — this project has an "origin" remote.' }
  }
  try {
    await execFileP('gh', ['--version'], { timeout: 8000 })
  } catch {
    return { ok: false, error: 'GitHub CLI (gh) not found — install it to connect.' }
  }
  try {
    await execFileP('gh', ['auth', 'status'], { timeout: 8000 })
  } catch {
    return { ok: false, error: 'Not signed in to GitHub — run `gh auth login`, then retry.' }
  }

  const name = sanitizeRepoName(opts.name)
  const owner = opts.owner?.trim()
  if (!owner) return { ok: false, error: 'Pick an owner for the repo.' }
  const slug = `${owner}/${name}`

  // Plan the branches: fast-forward the clean base up to the work branch so the
  // repo's default branch shows what the user built, not the bare scaffold.
  // `merge-base --is-ancestor` exits 0 when base is an ancestor of current.
  const base = current.startsWith('praxis/') ? current.slice('praxis/'.length) || 'main' : current
  let baseIsAncestor = false
  if (base !== current) {
    baseIsAncestor = await git(root, ['merge-base', '--is-ancestor', base, current])
      .then(() => true)
      .catch(() => false)
  }
  const plan = resolveConnectPlan(current, baseIsAncestor)

  try {
    if (plan.fastForwardBase && plan.defaultBranch !== current) {
      // Move the base ref forward without switching the checkout (the live tree
      // stays on the work branch the preview is serving).
      await git(root, ['branch', '-f', plan.defaultBranch, current])
    }
    // Create the repo + wire the remote, but don't let gh pick what to push —
    // we push the default branch first, explicitly, so it lands as HEAD.
    await gh(root, [
      'repo',
      'create',
      slug,
      opts.private ? '--private' : '--public',
      '--source',
      '.',
      '--remote',
      'origin'
    ])
    for (const b of plan.pushBranches) {
      await git(root, ['push', '-u', 'origin', b], 60000)
    }
    // Make sure GitHub's default branch + local origin/HEAD are the branch we want.
    await gh(root, ['repo', 'edit', slug, '--default-branch', plan.defaultBranch]).catch(() => {})
    await git(root, ['remote', 'set-head', 'origin', '-a']).catch(() => {})

    const url = await tryOut(gh(root, ['repo', 'view', slug, '--json', 'url', '-q', '.url']))
    return { ok: true, ...(url ? { url } : { url: `https://github.com/${slug}` }) }
  } catch (err) {
    return { ok: false, error: errMsg(err).split('\n').slice(0, 4).join('\n') }
  }
}

export function registerGithubIpc(): void {
  ipcMain.handle('github:status', (_e, root: string) => githubStatus(root))
  ipcMain.handle('github:connect', (_e, root: string, opts: GithubConnectOptions) =>
    connectToGitHub(root, opts)
  )
}
