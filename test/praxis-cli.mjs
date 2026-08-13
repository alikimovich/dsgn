/**
 * praxis CLI (bin/praxis.mjs) — pure unit test of the lockfile-drift helper
 * that keeps `praxis --update` from aborting on a dirty, install-generated
 * lockfile. Runs under bun (no electron), like update.mjs. Importing the module
 * must NOT run the CLI — `main()` is guarded by invokedAsScript().
 *
 * Run with: bun test/praxis-cli.mjs
 */
import { lockfilesToRestore } from '../bin/praxis.mjs'

let failed = 0
const assert = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    failed++
  }
}
const eq = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)})`)

// --- the real-world case: bun install left bun.lock modified (unstaged) ---
eq(lockfilesToRestore(' M bun.lock\n'), ['bun.lock'], 'unstaged bun.lock is restored')
eq(lockfilesToRestore('M  bun.lock\n'), ['bun.lock'], 'staged bun.lock is restored')
eq(lockfilesToRestore('MM bun.lock\n'), ['bun.lock'], 'staged+unstaged bun.lock is restored')

// --- other package managers' lockfiles ---
eq(
  lockfilesToRestore(' M package-lock.json\n M yarn.lock\n M pnpm-lock.yaml\n M bun.lockb\n'),
  ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb'],
  'all supported lockfiles are restored',
)

// --- untracked lockfiles have no HEAD version to restore ---
eq(lockfilesToRestore('?? bun.lock\n'), [], 'untracked bun.lock is left alone')

// --- non-lockfile edits are never touched (only lockfiles get discarded) ---
eq(lockfilesToRestore(' M src/main/agent.ts\n'), [], 'source edits are not restored')
eq(
  lockfilesToRestore(' M src/main/agent.ts\n M bun.lock\n'),
  ['bun.lock'],
  'only the lockfile is picked out from a mixed dirty tree',
)

// --- a path merely containing a lockfile name (not exact) is not matched ---
eq(lockfilesToRestore(' M vendor/bun.lock.bak\n'), [], 'non-exact lockfile path is ignored')

// --- clean tree / empty & junk input ---
eq(lockfilesToRestore(''), [], 'empty porcelain → nothing to restore')
eq(lockfilesToRestore('\n\n'), [], 'blank lines → nothing to restore')

if (failed) {
  console.error(`PRAXIS-CLI FAILED — ${failed} assertion(s)`)
  process.exit(1)
}
console.log('PRAXIS-CLI OK — lockfilesToRestore picks dirty tracked lockfiles, ignores the rest')
