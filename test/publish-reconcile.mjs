/**
 * Safe publish reconciliation against real local/bare repositories. Network and
 * GitHub are not involved; these are the exact fetch/merge/push graph shapes.
 */
import assert from 'node:assert'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  publishConflictFiles,
  pushReconciledBranch,
  withPublishLock
} from '../src/main/publish-reconcile.ts'

const roots = []
const q = (value) => `'${value.replaceAll("'", "'\\''")}'`
const run = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'praxis-publish-'))
  roots.push(root)
  const remote = join(root, 'remote.git')
  const local = join(root, 'local')
  const peer = join(root, 'peer')
  run(root, 'init', '--bare', remote)
  run(root, 'clone', remote, local)
  run(local, 'config', 'user.email', 'local@example.com')
  run(local, 'config', 'user.name', 'Local')
  run(local, 'checkout', '-b', 'main')
  writeFileSync(join(local, 'shared.txt'), 'base\n')
  run(local, 'add', '.')
  run(local, 'commit', '-m', 'base')
  run(local, 'push', '-u', 'origin', 'main')
  run(remote, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  run(root, 'clone', remote, peer)
  run(peer, 'config', 'user.email', 'peer@example.com')
  run(peer, 'config', 'user.name', 'Peer')
  run(local, 'checkout', '-b', 'praxis/main')
  return { root, remote, local, peer }
}

function seedRemoteBranch({ local, peer }) {
  run(local, 'push', '-u', 'origin', 'praxis/main')
  run(peer, 'fetch', 'origin')
  run(peer, 'checkout', '-b', 'praxis/main', 'origin/praxis/main')
}

function commitFile(repo, name, content, message) {
  writeFileSync(join(repo, name), content)
  run(repo, 'add', '--', name)
  run(repo, 'commit', '-m', message)
}

try {
  // No remote branch yet: preserve the local tip and create it normally.
  {
    const f = fixture()
    commitFile(f.local, 'created.txt', 'created\n', 'local work')
    const result = await pushReconciledBranch(f.local, 'praxis/main')
    assert.equal(result.ok, true)
    assert.equal(result.action, 'created')
    assert.equal(result.attempts, 1)
    assert.equal(result.recoveryRefs.length, 1)
    assert.equal(
      run(f.remote, 'rev-parse', 'refs/heads/praxis/main'),
      run(f.local, 'rev-parse', 'HEAD')
    )
  }

  // Remote is an ancestor: local stays intact and pushes normally.
  {
    const f = fixture()
    seedRemoteBranch(f)
    commitFile(f.local, 'ahead.txt', 'ahead\n', 'local ahead')
    const result = await pushReconciledBranch(f.local, 'praxis/main')
    assert.equal(result.ok, true)
    assert.equal(result.action, 'ahead')
    assert.equal(
      run(f.remote, 'rev-parse', 'refs/heads/praxis/main'),
      run(f.local, 'rev-parse', 'HEAD')
    )
  }

  // Local is an ancestor: fast-forward it without inventing a merge commit.
  {
    const f = fixture()
    seedRemoteBranch(f)
    commitFile(f.peer, 'behind.txt', 'remote\n', 'remote ahead')
    run(f.peer, 'push', 'origin', 'praxis/main')
    const remoteTip = run(f.peer, 'rev-parse', 'HEAD')
    const result = await pushReconciledBranch(f.local, 'praxis/main')
    assert.equal(result.ok, true)
    assert.equal(result.action, 'fast-forwarded')
    assert.equal(run(f.local, 'rev-parse', 'HEAD'), remoteTip)
  }

  // Diverged non-overlapping work: make an explicit two-parent merge and push it.
  {
    const f = fixture()
    seedRemoteBranch(f)
    commitFile(f.local, 'local.txt', 'local\n', 'local side')
    commitFile(f.peer, 'remote.txt', 'remote\n', 'remote side')
    run(f.peer, 'push', 'origin', 'praxis/main')
    const result = await pushReconciledBranch(f.local, 'praxis/main')
    assert.equal(result.ok, true)
    assert.equal(result.action, 'merged')
    assert.equal(run(f.local, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3)
    assert.equal(
      run(f.remote, 'rev-parse', 'refs/heads/praxis/main'),
      run(f.local, 'rev-parse', 'HEAD')
    )
  }

  // Overlap: preserve both exact tips, report the file, and leave Git's merge
  // state in place for a deliberate per-file resolution.
  {
    const f = fixture()
    seedRemoteBranch(f)
    writeFileSync(join(f.local, 'shared.txt'), 'local\n')
    run(f.local, 'commit', '-am', 'local side')
    writeFileSync(join(f.peer, 'shared.txt'), 'remote\n')
    run(f.peer, 'commit', '-am', 'remote side')
    run(f.peer, 'push', 'origin', 'praxis/main')
    const localTip = run(f.local, 'rev-parse', 'HEAD')
    const remoteTip = run(f.peer, 'rev-parse', 'HEAD')
    const result = await pushReconciledBranch(f.local, 'praxis/main')
    assert.equal(result.ok, false)
    assert.deepEqual(result.files, ['shared.txt'])
    assert.deepEqual(await publishConflictFiles(f.local), ['shared.txt'])
    assert.equal(run(f.remote, 'rev-parse', 'refs/heads/praxis/main'), remoteTip)
    assert.deepEqual(
      new Set(result.recoveryRefs.map((ref) => run(f.local, 'rev-parse', ref))),
      new Set([localTip, remoteTip])
    )
  }

  // A remote move during push: the pre-push hook advances the bare remote after
  // our fetch. The first push is rejected; the bounded retry fetches, merges,
  // and succeeds without force.
  {
    const f = fixture()
    seedRemoteBranch(f)
    commitFile(f.local, 'local.txt', 'local\n', 'local side')
    commitFile(f.peer, 'racing.txt', 'remote race\n', 'remote side')
    const sentinel = join(f.root, 'advanced')
    const hook = join(f.local, '.git', 'hooks', 'pre-push')
    writeFileSync(
      hook,
      `#!/bin/sh\nif [ ! -f ${q(sentinel)} ]; then\n  touch ${q(sentinel)}\n  git -C ${q(f.peer)} push origin praxis/main\nfi\n`
    )
    chmodSync(hook, 0o755)
    const result = await pushReconciledBranch(f.local, 'praxis/main')
    assert.equal(result.ok, true)
    assert.equal(result.action, 'merged')
    assert.equal(result.attempts, 2)
    assert.equal(
      run(f.remote, 'rev-parse', 'refs/heads/praxis/main'),
      run(f.local, 'rev-parse', 'HEAD')
    )
  }

  // The lock is keyed by canonical repository path and always releases.
  {
    const f = fixture()
    let release
    const first = withPublishLock(f.local, () => new Promise((resolve) => (release = resolve)))
    await new Promise((resolve) => setTimeout(resolve, 0))
    await assert.rejects(
      withPublishLock(f.local, async () => undefined),
      /already in progress/
    )
    release()
    await first
    await withPublishLock(f.local, async () => undefined)
  }
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
}

console.log('PUBLISH RECONCILE OK — create, ahead, behind, diverged, conflict, race, lock')
