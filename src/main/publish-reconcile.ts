import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)
const activeRepositories = new Set<string>()
let recoveryCounter = 0

type ReconcileAction = 'created' | 'up-to-date' | 'ahead' | 'fast-forwarded' | 'merged'

export interface ReconciledPush {
  ok: true
  action: ReconcileAction
  attempts: number
  recoveryRefs: string[]
}

export interface PublishConflict {
  ok: false
  kind: 'conflict'
  files: string[]
  attempts: number
  recoveryRefs: string[]
}

export type ReconciledPushResult = ReconciledPush | PublishConflict

export class PublishBusyError extends Error {
  constructor() {
    super('A publish is already in progress for this repository.')
    this.name = 'PublishBusyError'
  }
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP('git', args, {
    cwd: root,
    maxBuffer: 10 * 1024 * 1024
  })
  return stdout.trim()
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const detail = error as Error & { stdout?: string; stderr?: string }
  return [detail.message, detail.stderr, detail.stdout].filter(Boolean).join('\n')
}

function remoteMoved(error: unknown): boolean {
  return /non-fast-forward|fetch first|failed to push some refs|\[rejected\]/i.test(
    errorText(error)
  )
}

async function refExists(root: string, ref: string): Promise<boolean> {
  try {
    await git(root, ['show-ref', '--verify', '--quiet', ref])
    return true
  } catch {
    return false
  }
}

async function isAncestor(root: string, older: string, newer: string): Promise<boolean> {
  try {
    await git(root, ['merge-base', '--is-ancestor', older, newer])
    return true
  } catch {
    return false
  }
}

function safeRefPart(branch: string): string {
  return branch
    .split('/')
    .map((part) => part.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^\.+|\.+$/g, '') || 'branch')
    .join('/')
}

async function createRecoveryRefs(
  root: string,
  branch: string,
  remoteRef: string | null
): Promise<string[]> {
  const token = `${Date.now()}-${recoveryCounter++}`
  const prefix = `refs/praxis/recovery/${safeRefPart(branch)}/${token}`
  const refs: string[] = []
  const localRef = `${prefix}-local`
  await git(root, ['update-ref', localRef, 'HEAD'])
  refs.push(localRef)
  if (remoteRef) {
    const remoteRecoveryRef = `${prefix}-remote`
    await git(root, ['update-ref', remoteRecoveryRef, remoteRef])
    refs.push(remoteRecoveryRef)
  }
  return refs
}

export async function publishConflictFiles(root: string): Promise<string[]> {
  const files = await git(root, ['diff', '--name-only', '--diff-filter=U', '--'])
  return files ? files.split('\n').filter(Boolean) : []
}

async function reconcileOnce(
  root: string,
  branch: string,
  attempt: number,
  accumulatedRecoveryRefs: string[]
): Promise<Omit<ReconciledPush, 'attempts' | 'recoveryRefs'> | PublishConflict> {
  await git(root, ['fetch', '--prune', 'origin'])
  const remoteRef = `refs/remotes/origin/${branch}`
  const hasRemote = await refExists(root, remoteRef)
  const refs = await createRecoveryRefs(root, branch, hasRemote ? remoteRef : null)
  accumulatedRecoveryRefs.push(...refs)

  if (!hasRemote) return { ok: true, action: 'created' }

  const localOid = await git(root, ['rev-parse', 'HEAD'])
  const remoteOid = await git(root, ['rev-parse', remoteRef])
  if (localOid === remoteOid) return { ok: true, action: 'up-to-date' }
  if (await isAncestor(root, remoteRef, 'HEAD')) return { ok: true, action: 'ahead' }

  if (await isAncestor(root, 'HEAD', remoteRef)) {
    await git(root, ['merge', '--ff-only', remoteRef])
    return { ok: true, action: 'fast-forwarded' }
  }

  try {
    await git(root, [
      'merge',
      '--no-ff',
      '-m',
      'Reconcile local and remote Praxis publish histories',
      remoteRef
    ])
    return { ok: true, action: 'merged' }
  } catch (error) {
    const files = await publishConflictFiles(root)
    if (files.length) {
      return {
        ok: false,
        kind: 'conflict',
        files,
        attempts: attempt,
        recoveryRefs: [...accumulatedRecoveryRefs]
      }
    }
    throw error
  }
}

/**
 * Fetch, preserve both tips, reconcile without rewriting history, then push.
 * A non-fast-forward race gets a bounded fetch/reconcile retry. Conflicts are
 * intentionally left in the worktree for per-file resolution.
 */
export async function pushReconciledBranch(
  root: string,
  branch: string,
  maxAttempts = 3
): Promise<ReconciledPushResult> {
  const recoveryRefs: string[] = []
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const reconciled = await reconcileOnce(root, branch, attempt, recoveryRefs)
    if (!reconciled.ok) return reconciled
    try {
      await git(root, ['push', '-u', 'origin', branch])
      return {
        ...reconciled,
        attempts: attempt,
        recoveryRefs: [...recoveryRefs]
      }
    } catch (error) {
      if (attempt === maxAttempts || !remoteMoved(error)) throw error
    }
  }
  throw new Error(`Publish retry limit reached for ${branch}.`)
}

/** Hold one publish across commit, reconciliation, GitHub PR, and cleanup. */
export async function withPublishLock<T>(root: string, task: () => Promise<T>): Promise<T> {
  const key = await realpath(root).catch(() => resolve(root))
  if (activeRepositories.has(key)) throw new PublishBusyError()
  activeRepositories.add(key)
  try {
    return await task()
  } finally {
    activeRepositories.delete(key)
  }
}
