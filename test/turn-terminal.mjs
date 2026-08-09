/** Provider terminal normalization: exactly one success/failed decision per turn. */
import { TurnTerminalTracker } from '../src/main/turn-terminal.ts'

let failed = 0
const ok = (condition, message) => {
  if (!condition) {
    console.error(`FAIL: ${message}`)
    failed++
  }
}

const turns = new TurnTerminalTracker()
turns.begin('codex')
ok(turns.claim('codex', 'error') === 'failed', 'the first Codex error claims failure')
ok(turns.claim('codex', 'done') === null, 'Codex error→done finalizes only once')

turns.begin('codex')
ok(turns.claim('codex', 'done') === 'success', 'the next clean turn can claim success')
ok(turns.claim('codex', 'done') === null, 'duplicate done is ignored')

turns.begin('claude')
ok(turns.claim('claude', 'error') === 'failed', 'Claude error-only turns still finalize')

if (failed) process.exit(1)
console.log('turn-terminal: OK')
