import { execFile } from 'child_process'
import { ipcMain } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { join } from 'path'
import { promisify } from 'util'
import type { Annotation, AnnotationInput, PublishResult } from '../shared/api'
import { buildPrBody } from '../shared/pr-body'
import { buildPublishMessage } from '../shared/publish-message'
import { ensureBranch } from './git'

/**
 * Annotation sidecar + engineer handoff (v3). Reviewer notes are pinned to
 * elements and stored in `<repo>/.praxis/annotations.json` — a sidecar the agent
 * is told not to touch (writes under `.praxis/` are denied in agent.ts). "Publish"
 * turns the praxis-related working changes + the notes into a branch and a PR.
 */

const execFileP = promisify(execFile)
const dir = (root: string): string => join(root, '.praxis')
const file = (root: string): string => join(dir(root), 'annotations.json')

let counter = 0
const newId = (): string => `a${Date.now().toString(36)}${(counter++).toString(36)}`

async function readAnnotations(root: string): Promise<Annotation[]> {
  try {
    const raw = await readFile(file(root), 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as Annotation[]) : []
  } catch {
    return []
  }
}

/** Atomic write (tmp + rename) so a crash can't leave a half-written file that
 *  readAnnotations would silently treat as "no notes". */
async function writeAnnotations(root: string, list: Annotation[]): Promise<void> {
  await mkdir(dir(root), { recursive: true })
  const tmp = file(root) + '.tmp'
  await writeFile(tmp, JSON.stringify(list, null, 2) + '\n', 'utf8')
  await rename(tmp, file(root))
}

// Main is the only writer, but two IPC calls can interleave at their awaits.
// Serialize all mutations through a promise chain so read-modify-write is atomic.
let writeChain: Promise<unknown> = Promise.resolve()
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = writeChain.then(task, task)
  writeChain = run.catch(() => undefined)
  return run
}

function addAnnotation(root: string, input: AnnotationInput): Promise<Annotation[]> {
  return serialize(async () => {
    const text = input.text.trim()
    if (!text) return readAnnotations(root)
    const list = await readAnnotations(root)
    const annotation: Annotation = {
      id: newId(),
      source: input.source,
      selector: input.selector,
      tag: input.tag,
      text: text.slice(0, 2000),
      createdAt: new Date().toISOString()
    }
    const next = [...list, annotation]
    await writeAnnotations(root, next)
    return next
  })
}

function removeAnnotation(root: string, id: string): Promise<Annotation[]> {
  return serialize(async () => {
    const next = (await readAnnotations(root)).filter((a) => a.id !== id)
    await writeAnnotations(root, next)
    return next
  })
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP('git', args, { cwd: root, maxBuffer: 10 * 1024 * 1024 })
  return stdout.trim()
}

/** The repo's default branch (main/master) from origin/HEAD; `main` when it isn't set. */
async function defaultBase(root: string): Promise<string> {
  try {
    return (
      (await git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).replace(
        /^origin\//,
        ''
      ) || 'main'
    )
  } catch {
    return 'main' // origin/HEAD not set — assume main
  }
}

/** How many commits HEAD is ahead of the default branch (local ref, then the remote
 *  one). 0 when neither ref resolves — e.g. a repo that has never been pushed. */
async function aheadOfBase(root: string, base: string): Promise<number> {
  for (const ref of [base, `origin/${base}`]) {
    try {
      const n = Number(await git(root, ['rev-list', '--count', `${ref}..HEAD`]))
      if (Number.isFinite(n)) return n
    } catch {
      /* ref doesn't exist here — try the next one */
    }
  }
  return 0
}

/**
 * Tracked files this branch changed — COMMITTED work included. Praxis commits every
 * turn on the live checkout (`live-commit.ts`), so a diff vs HEAD alone would report
 * "nothing changed" for a session whose turns all landed. Diff against the merge base
 * with the default branch — two-dot, i.e. vs the WORKING TREE, so uncommitted edits
 * still count — and fall back to HEAD when there's no base to compare against (no
 * origin, unborn branch, or the checkout IS the base branch). Clean paths (no
 * porcelain quoting / rename arrows).
 */
async function changedSince(root: string): Promise<string[]> {
  const flags = ['-c', 'core.quotePath=false', 'diff', '--name-only']
  let out: string
  try {
    const mergeBase = await git(root, ['merge-base', 'HEAD', await defaultBase(root)])
    out = await git(root, [...flags, mergeBase])
  } catch {
    out = await git(root, [...flags, 'HEAD'])
  }
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

async function publishToPr(root: string, opts: { title: string }): Promise<PublishResult> {
  const title = opts.title || 'praxis: design handoff'
  // --- Pre-flight: fail before any mutation. ---
  let original: string
  try {
    await git(root, ['rev-parse', '--is-inside-work-tree'])
    original = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
  } catch {
    return { ok: false, error: 'Not a git repository.' }
  }
  if (original === 'HEAD') {
    return { ok: false, error: 'You’re on a detached HEAD — check out a branch first.' }
  }
  try {
    await git(root, ['remote', 'get-url', 'origin'])
  } catch {
    return { ok: false, error: 'No “origin” remote — add one, then publish.' }
  }
  try {
    await execFileP('gh', ['--version'])
  } catch {
    return { ok: false, error: 'GitHub CLI (gh) not found — install it to publish a PR.' }
  }

  const annotations = await readAnnotations(root)
  const changedFiles = await changedSince(root)
  if (!changedFiles.length && !annotations.length) {
    return { ok: false, error: 'Nothing to publish — no changes or notes yet.' }
  }

  const branch = `praxis/handoff-${Date.now().toString(36)}`
  let committed = false
  try {
    await git(root, ['checkout', '-b', branch])
    // Stage tracked changes + the sidecar only — never sweep in untracked files
    // (local .env, build artifacts, unrelated WIP).
    await git(root, ['add', '-u'])
    await git(root, ['add', '--', '.praxis'])
    const staged = await git(root, ['diff', '--cached', '--name-only'])
    // Per-turn live commits mean the work is usually already IN the branch's history,
    // so "nothing staged" no longer means "nothing to publish" — only nothing staged
    // AND nothing ahead of the base does. When nothing is staged the handoff branch
    // simply points at the same commits, which is a perfectly publishable PR.
    if (!staged && (await aheadOfBase(root, await defaultBase(root))) === 0) {
      await git(root, ['checkout', original])
      await git(root, ['branch', '-D', branch])
      return { ok: false, error: 'Nothing to publish — no changes or notes yet.' }
    }
    if (staged) {
      await git(root, ['commit', '-m', title])
      committed = true
    }
    await git(root, ['push', '-u', 'origin', branch])

    const body = buildPrBody(annotations, changedFiles)
    const { stdout } = await execFileP('gh', ['pr', 'create', '--title', title, '--body', body], {
      cwd: root,
      maxBuffer: 10 * 1024 * 1024
    })
    const url = stdout
      .trim()
      .split('\n')
      .find((l) => /^https?:\/\//.test(l))
    return { ok: true, ...(url ? { url } : {}) }
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err))
      .split('\n')
      .slice(0, 3)
      .join('\n')
    // Roll back to the user's branch. If we already committed, the work lives on
    // the handoff branch — say so rather than silently leaving them stranded.
    try {
      await git(root, ['checkout', original])
      if (!committed) await git(root, ['branch', '-D', branch])
    } catch {
      /* best-effort */
    }
    return committed
      ? { ok: false, error: `Committed to ${branch}, but couldn’t finish: ${msg}` }
      : { ok: false, error: msg }
  }
}

/**
 * Full "Publish": commit every change on the current praxis/* branch → push →
 * create (or reuse) a PR → squash-merge it into the default branch (deleting the
 * remote branch) → check out the default branch and pull → delete the merged
 * local branch → start a fresh same-named praxis/* branch off the updated base to
 * keep working on. One-click ship-and-continue.
 */
async function shipToMain(
  root: string,
  summary: string[] = [],
  mode: 'merge' | 'pr' = 'merge'
): Promise<PublishResult> {
  let branch: string
  try {
    await git(root, ['rev-parse', '--is-inside-work-tree'])
    branch = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
  } catch {
    return { ok: false, error: 'Not a git repository.' }
  }
  if (branch === 'HEAD') return { ok: false, error: 'Detached HEAD — check out a branch first.' }
  // Default branch (main/master), from origin/HEAD; fall back to main.
  const base = await defaultBase(root)
  if (branch === base) {
    // The open-time `git:ensure` should have moved the checkout onto a praxis/*
    // work branch, but a project can still land here on its base branch (ensure
    // failed at open, the user switched back via the titlebar, or a previous
    // publish's recovery stranded them). Self-heal instead of refusing: move
    // onto `praxis/<base>` now — `checkout -b` carries the uncommitted work
    // along, and the rest of the flow keeps the base branch clean exactly as if
    // open-time ensure had succeeded. `ensureBranch` still refuses non-root
    // checkouts (a subdir of a larger repo), which stays a hard error.
    const healed = await ensureBranch(root)
    if (!healed.isRepo) {
      return {
        ok: false,
        error: `You're on ${base}, and this folder isn't the repository root — open the repo's top-level folder to publish.`
      }
    }
    if (!healed.branch || healed.branch === base || healed.error) {
      return {
        ok: false,
        error: `You're on ${base} and Praxis couldn't create a work branch${healed.error ? `: ${healed.error}` : '.'}`
      }
    }
    branch = healed.branch
  }
  try {
    await git(root, ['remote', 'get-url', 'origin'])
  } catch {
    return { ok: false, error: 'No "origin" remote — add one, then publish.' }
  }
  try {
    await execFileP('gh', ['--version'])
  } catch {
    return { ok: false, error: 'GitHub CLI (gh) not found — install it to publish.' }
  }

  const gh = (args: string[]): Promise<{ stdout: string }> =>
    execFileP('gh', args, { cwd: root, maxBuffer: 10 * 1024 * 1024 })

  try {
    // 1. Commit all changes (gitignore-respected). Skip the commit if clean.
    // Title + body come from the session's user requests (and the diffstat vs
    // base), so the branch commit, the PR, and the squash-merge commit all read
    // as the actual work — not "praxis: publish <branch>".
    await git(root, ['add', '-A'])
    const diffstat = await git(root, ['diff', '--stat', base]).catch(() => '')
    const msg = buildPublishMessage(branch, summary, diffstat)
    const staged = await git(root, ['diff', '--cached', '--name-only'])
    if (staged) await git(root, ['commit', '-m', msg.title, '-m', msg.body])
    const ahead = await git(root, ['rev-list', '--count', `${base}..${branch}`]).catch(() => '0')
    if (!staged && ahead === '0') {
      return { ok: false, error: `Nothing to publish — no changes since ${base}.` }
    }
    // 2. Push the branch.
    await git(root, ['push', '-u', 'origin', branch])
    // 3. Create the PR, or reuse an existing one for this branch.
    let url = ''
    try {
      const { stdout } = await gh([
        'pr',
        'create',
        '--base',
        base,
        '--head',
        branch,
        '--title',
        msg.title,
        '--body',
        msg.body
      ])
      url =
        stdout
          .trim()
          .split('\n')
          .find((l) => /^https?:\/\//.test(l)) ?? ''
    } catch (e) {
      const existing = await gh(['pr', 'view', branch, '--json', 'url', '-q', '.url']).catch(
        () => ({ stdout: '' })
      )
      url = existing.stdout.trim()
      if (!url) throw e
      // Reused an open PR (PR-only mode publishes again onto the same branch):
      // refresh its title/body to the cumulative summary. Best-effort.
      await gh(['pr', 'edit', branch, '--title', msg.title, '--body', msg.body]).catch(() => {})
    }
    // PR-only mode stops here — stay on the work branch with the PR open for
    // review; publishing again updates the same PR.
    if (mode === 'pr') return { ok: true, branch, ...(url ? { url } : {}) }
    // 4. Squash-merge into base + delete the remote branch. Explicit subject
    // and body so the merge commit's message never falls back to the repo's
    // "default commit message" setting; keep GitHub's "(#N)" convention.
    const prNumber = url.match(/\/pull\/(\d+)/)?.[1]
    await gh([
      'pr',
      'merge',
      branch,
      '--squash',
      '--delete-branch',
      '--subject',
      prNumber ? `${msg.title} (#${prNumber})` : msg.title,
      '--body',
      msg.body
    ])
    // 5. Update the local base branch.
    await git(root, ['checkout', base])
    await git(root, ['pull', '--ff-only', 'origin', base])
    // 6. Delete the merged local branch, then 7. start a fresh one off the new base.
    await git(root, ['branch', '-D', branch]).catch(() => {})
    await git(root, ['checkout', '-b', branch])
    return { ok: true, branch, ...(url ? { url } : {}) }
  } catch (err) {
    // Recovery: steps 5–7 check out `base` before restoring `branch`, so a
    // failure partway through (e.g. `pull --ff-only`) strands the user on the
    // default branch even though the titlebar still shows their work branch.
    // Put them back on it — check it out if it still exists, else recreate it
    // off HEAD (the squash-merge already landed the work on base). Best-effort.
    try {
      const now = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
      if (now !== branch) {
        await git(root, ['checkout', branch]).catch(() => git(root, ['checkout', '-b', branch]))
      }
    } catch {
      /* couldn't restore — surface the original error below */
    }
    const msg = (err instanceof Error ? err.message : String(err))
      .split('\n')
      .slice(0, 4)
      .join('\n')
    return { ok: false, error: msg }
  }
}

export function registerAnnotationsIpc(): void {
  ipcMain.handle('annotations:list', (_e, root: string) => readAnnotations(root))
  ipcMain.handle('annotations:add', (_e, root: string, input: AnnotationInput) =>
    addAnnotation(root, input)
  )
  ipcMain.handle('annotations:remove', (_e, root: string, id: string) => removeAnnotation(root, id))
  ipcMain.handle('publish:to-pr', (_e, root: string, opts: { title: string }) =>
    publishToPr(root, opts)
  )
  ipcMain.handle('publish:ship', (_e, root: string, summary?: string[], mode?: 'merge' | 'pr') =>
    shipToMain(root, summary ?? [], mode ?? 'merge')
  )
}
