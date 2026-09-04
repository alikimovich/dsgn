import { execFile } from 'child_process'
import { ipcMain } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { join } from 'path'
import { promisify } from 'util'
import type { Annotation, AnnotationInput, PublishResult } from '../shared/api'
import { buildPrBody } from '../shared/pr-body'
import { buildPublishMessage, publishCommitSummaries } from '../shared/publish-message'
import { enclosingRepoRoot, ensureBranch } from './git'
import { publishConflictFiles, pushReconciledBranch, withPublishLock } from './publish-reconcile'
import { aheadOfBase, changedSince, defaultBase } from './publish-scope'

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

function conflictResult(files: string[], recoveryRefs: string[] = []): PublishResult {
  return {
    ok: false,
    error:
      `Publish paused because local and remote changes overlap in ${files.length} ` +
      `${files.length === 1 ? 'file' : 'files'}. Resolve each file, commit the merge, then Publish again.`,
    conflictFiles: files,
    recoveryRefs
  }
}

async function lockedPublish(
  root: string,
  task: () => Promise<PublishResult>
): Promise<PublishResult> {
  try {
    return await withPublishLock(root, task)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
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
 * Full "Publish": commit every change on the current praxis/* branch → reconcile
 * its remote counterpart without rewriting either history → push →
 * create (or reuse) a PR → squash-merge it into the default branch (deleting the
 * remote branch) → check out the default branch and pull → delete the merged
 * local branch → start a fresh same-named praxis/* branch off the updated base to
 * keep working on. One-click ship-and-continue.
 */
async function shipToMain(
  root: string,
  _legacyChatSummary: string[] = [],
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
  const existingConflicts = await publishConflictFiles(root)
  if (existingConflicts.length) return conflictResult(existingConflicts)
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
      // The old message just said "open the repo's top-level folder", which is a
      // dead end: it never said WHICH repo, and for a freshly created project the
      // answer usually isn't "open something else" at all — it's that this folder
      // never became a repo (a scaffold whose `git init` failed used to be
      // swallowed silently), so git resolved to whatever repo happens to sit
      // above it. Name the actual situation and the actual next step.
      const enclosing = await enclosingRepoRoot(root)
      return {
        ok: false,
        error:
          enclosing === null
            ? `This folder isn't a git repository, so there's nothing to publish from. Run \`git init\` in ${root} (and make a first commit), then try again.`
            : `Can't publish: this folder is inside the repository at ${enclosing}, but isn't its top level, so Praxis won't switch that whole repo onto a work branch. Either open ${enclosing} as the project and publish from there, or make this folder its own repository with \`git init\` in ${root}.`
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
    // Title + body come from the commits and files that actually differ from the
    // base. Chat is intentionally excluded: it contains questions, corrections,
    // logs, and commands that do not belong in release notes.
    await git(root, ['add', '-A'])
    const diffstat = await git(root, ['diff', '--stat', base]).catch(() => '')
    const changedFiles = (await git(root, ['diff', '--name-only', base]).catch(() => ''))
      .split('\n')
      .map((file) => file.trim())
      .filter(Boolean)
    const commitLog = await git(root, [
      'log',
      '--no-merges',
      '--format=%s%x1f%b%x1e',
      `${base}..${branch}`
    ]).catch(() => '')
    const msg = buildPublishMessage(
      branch,
      publishCommitSummaries(commitLog),
      diffstat,
      changedFiles
    )
    const staged = await git(root, ['diff', '--cached', '--name-only'])
    if (staged) await git(root, ['commit', '-m', msg.title, '-m', msg.body])
    const ahead = await git(root, ['rev-list', '--count', `${base}..${branch}`]).catch(() => '0')
    if (!staged && ahead === '0') {
      return { ok: false, error: `Nothing to publish — no changes since ${base}.` }
    }
    // 2. Fetch, preserve both tips, reconcile the remote branch, then push.
    // If another publisher advances it between fetch and push, retry the same
    // reconciliation a bounded number of times. A content conflict stays in the
    // worktree so the user can resolve each file — never choose ours/theirs
    // globally and never rewrite a shared branch.
    const pushed = await pushReconciledBranch(root, branch)
    if (!pushed.ok) return conflictResult(pushed.files, pushed.recoveryRefs)
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
    lockedPublish(root, () => publishToPr(root, opts))
  )
  ipcMain.handle('publish:ship', (_e, root: string, summary?: string[], mode?: 'merge' | 'pr') =>
    lockedPublish(root, () => shipToMain(root, summary ?? [], mode ?? 'merge'))
  )
}
