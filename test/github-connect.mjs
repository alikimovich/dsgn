/**
 * Unit test for the "Connect to GitHub" pure helpers (the first-publish bridge):
 * repo-name sanitization and the Option-B branch push plan. Pure bun — no gh,
 * no network, no Electron. Run via: bun run test:github-connect
 */
import assert from 'node:assert'
import { sanitizeRepoName, resolveConnectPlan } from '../src/shared/github.ts'

// --- sanitizeRepoName -------------------------------------------------------

assert.strictEqual(sanitizeRepoName('My Cool App'), 'my-cool-app')
assert.strictEqual(sanitizeRepoName('  spaced  '), 'spaced')
assert.strictEqual(sanitizeRepoName('weird__name!!'), 'weird__name') // _ kept; trailing !!→- trimmed
assert.strictEqual(sanitizeRepoName('---leading-and-trailing---'), 'leading-and-trailing')
assert.strictEqual(sanitizeRepoName('under_score.dot-dash'), 'under_score.dot-dash')
assert.strictEqual(sanitizeRepoName('café résumé'), 'caf-r-sum') // non-ascii → separators, trimmed
assert.strictEqual(sanitizeRepoName(''), 'my-app')
assert.strictEqual(sanitizeRepoName('!!!'), 'my-app')
assert.strictEqual(sanitizeRepoName('.hidden.'), 'hidden')
assert.strictEqual(sanitizeRepoName('a'.repeat(120)).length, 100) // capped

// --- resolveConnectPlan -----------------------------------------------------

// Scaffold case: on praxis/main, base 'main' is an ancestor → fast-forward main
// to the work branch and make it the default; push both (Option B: the repo's
// default branch shows the built work).
assert.deepStrictEqual(resolveConnectPlan('praxis/main', true), {
  defaultBranch: 'main',
  fastForwardBase: true,
  pushBranches: ['main', 'praxis/main']
})

// Diverged base (existing repo opened with no remote): can't fast-forward, so
// the work branch itself becomes the default.
assert.deepStrictEqual(resolveConnectPlan('praxis/feature', false), {
  defaultBranch: 'praxis/feature',
  fastForwardBase: false,
  pushBranches: ['praxis/feature']
})

// A praxis branch whose suffix maps to a differently-named base.
assert.deepStrictEqual(resolveConnectPlan('praxis/dev', true), {
  defaultBranch: 'dev',
  fastForwardBase: true,
  pushBranches: ['dev', 'praxis/dev']
})

// Non-work branch (user already on a plain branch) just publishes itself — no
// base to fast-forward, regardless of the ancestor flag.
assert.deepStrictEqual(resolveConnectPlan('main', true), {
  defaultBranch: 'main',
  fastForwardBase: false,
  pushBranches: ['main']
})
assert.deepStrictEqual(resolveConnectPlan('trunk', false), {
  defaultBranch: 'trunk',
  fastForwardBase: false,
  pushBranches: ['trunk']
})

// Degenerate 'praxis/' (empty suffix) falls back to 'main' as the base.
assert.deepStrictEqual(resolveConnectPlan('praxis/', true), {
  defaultBranch: 'main',
  fastForwardBase: true,
  pushBranches: ['main', 'praxis/']
})

console.log('GITHUB-CONNECT OK — repo-name sanitize, Option-B branch push plan')
