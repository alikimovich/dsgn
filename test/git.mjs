/**
 * Unit test for branch management against a real temp git repo (no electron).
 * Run via bun so the .ts import transpiles: bun run test:git
 */
import assert from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ensureBranch,
  getCurrentBranch,
  isGitRepo,
  normalizeBranchName,
  switchBranch
} from '../src/main/git.ts'

// --- pure name coercion: always a git-ref-safe praxis/<…> ---
assert.equal(normalizeBranchName('feature x'), 'praxis/feature-x')
assert.equal(normalizeBranchName('praxis/foo'), 'praxis/foo')
assert.equal(normalizeBranchName('  weird~^:?*name  '), 'praxis/weird-name')
assert.equal(normalizeBranchName('praxis/'), 'praxis/work')
assert.equal(normalizeBranchName('/a/b/'), 'praxis/a/b')

// --- not a git repo: a clean no-op ---
const nonRepo = mkdtempSync(join(tmpdir(), 'praxis-nonrepo-'))
assert.equal(await isGitRepo(nonRepo), false)
assert.deepEqual(await ensureBranch(nonRepo), { isRepo: false, branch: null, created: false })
rmSync(nonRepo, { recursive: true, force: true })

// --- a real repo on `main` ---
const dir = mkdtempSync(join(tmpdir(), 'praxis-repo-'))
const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' })
g('init', '-b', 'main')
g('config', 'user.email', 't@example.com')
g('config', 'user.name', 'Test')
writeFileSync(join(dir, 'f.txt'), 'hi')
g('add', '.')
g('commit', '-m', 'init')
assert.equal(await getCurrentBranch(dir), 'main')

// ensureBranch from main → creates praxis/main and checks it out
assert.deepEqual(await ensureBranch(dir), { isRepo: true, branch: 'praxis/main', created: true })
assert.equal(await getCurrentBranch(dir), 'praxis/main')

// ensureBranch when already on a praxis/* branch → keep it, don't recreate
assert.deepEqual(await ensureBranch(dir), { isRepo: true, branch: 'praxis/main', created: false })

// ensureBranch on a legacy pre-rename dsgn/* branch → keep it too (never nest
// a praxis/dsgn/… branch on top of old work)
g('checkout', '-b', 'dsgn/old-work')
assert.deepEqual(await ensureBranch(dir), { isRepo: true, branch: 'dsgn/old-work', created: false })
g('checkout', 'praxis/main')

// switch to a new named branch (coerced + created)
assert.deepEqual(await switchBranch(dir, 'feature-y'), {
  isRepo: true,
  branch: 'praxis/feature-y',
  created: true
})
assert.equal(await getCurrentBranch(dir), 'praxis/feature-y')

// switch back to an existing branch → not created
assert.deepEqual(await switchBranch(dir, 'praxis/main'), {
  isRepo: true,
  branch: 'praxis/main',
  created: false
})

rmSync(dir, { recursive: true, force: true })
console.log('GIT OK — normalize, non-repo, ensure (create/keep), switch (create/existing)')
