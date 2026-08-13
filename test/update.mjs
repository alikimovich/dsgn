/**
 * praxis self-update — pure unit test of the detection helpers. Runs under bun
 * (no electron), like rules.mjs/git.ts: update.ts is electron-free.
 *
 * Run with: bun test/update.mjs
 */
import { parseBehind, deriveStatus } from '../src/main/update.ts'

let failed = 0
const assert = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    failed++
  }
}

// --- parseBehind: parses `git rev-list --count` output, 0 on junk ---
assert(parseBehind('3\n') === 3, 'parseBehind trims trailing newline')
assert(parseBehind('0') === 0, 'parseBehind handles zero')
assert(parseBehind('') === 0, 'parseBehind handles empty string')
assert(parseBehind('garbage') === 0, 'parseBehind handles non-numeric junk')
assert(parseBehind('  5  ') === 5, 'parseBehind trims surrounding whitespace')
assert(parseBehind('-2') === 0, 'parseBehind clamps negatives to 0')
assert(parseBehind('12') === 12, 'parseBehind parses a plain count')

// --- deriveStatus: behind-count (+ subject) → renderer-facing status ---
const s0 = deriveStatus(0)
assert(s0.status === 'idle', 'deriveStatus(0): status is idle')
assert(s0.behind === 0, 'deriveStatus(0): behind is 0')
assert(s0.subject === undefined, 'deriveStatus(0): subject is undefined')

const s0sub = deriveStatus(0, 'x')
assert(s0sub.status === 'idle', 'deriveStatus(0, subject): still idle')
assert(s0sub.behind === 0, 'deriveStatus(0, subject): behind is 0')

const s2 = deriveStatus(2, 'Fix bug')
assert(s2.status === 'available', 'deriveStatus(2, subject): status is available')
assert(s2.behind === 2, 'deriveStatus(2, subject): behind is 2')
assert(s2.subject === 'Fix bug', 'deriveStatus(2, subject): subject passed through')

const sBlank = deriveStatus(1, '   ')
assert(sBlank.status === 'available', 'deriveStatus(1, blank subject): status is available')
assert(sBlank.behind === 1, 'deriveStatus(1, blank subject): behind is 1')
assert(
  sBlank.subject === undefined,
  'deriveStatus(1, blank subject): whitespace-only subject trims to empty and is omitted'
)

const sPad = deriveStatus(3, '  Padded  ')
assert(sPad.subject === 'Padded', 'deriveStatus(3, padded subject): subject is trimmed')

if (failed) {
  console.error(`UPDATE FAILED — ${failed} assertion(s)`)
  process.exit(1)
}
console.log(
  'UPDATE OK — parseBehind clamps/normalizes, deriveStatus idle/available + subject trim'
)
