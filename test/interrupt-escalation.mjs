/**
 * Stop must ALWAYS work. The bug this guards: the Claude Agent SDK's `interrupt()`
 * is a control request whose promise settles only when the CLI subprocess answers,
 * with no timeout in the SDK — so against a wedged subprocess it never settles, the
 * Stop IPC never resolves, and the button is dead while the spinner runs forever.
 *
 * `interruptWithEscalation` bounds that: ask nicely, and if no answer comes, use the
 * kill switch. The cases below are the ones that decide whether a session survives.
 *
 * Run with: bun run test:interrupt
 */
import { interruptWithEscalation } from '../src/main/backends/interrupt.ts'

let failed = 0
const ok = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    failed++
  }
}
const never = () => new Promise(() => {})

try {
  // --- graceful answers in time → the session is left alone -----------------
  {
    let killed = 0
    const r = await interruptWithEscalation({
      graceful: () => Promise.resolve(),
      graceMs: 50,
      escalate: () => killed++
    })
    ok(r === undefined, 'a clean stop reports nothing to escalate')
    ok(killed === 0, 'a clean stop does NOT kill the query')
  }

  // A REJECTION is still an answer — the turn is over, so killing on top of it
  // would destroy a session that stopped correctly.
  {
    let killed = 0
    const r = await interruptWithEscalation({
      graceful: () => Promise.reject(new Error('Operation aborted')),
      graceMs: 50,
      escalate: () => killed++
    })
    ok(r === undefined, 'a rejected cancel counts as answered')
    ok(killed === 0, 'a rejected cancel does not escalate')
  }

  // A backend with nothing to cancel, and one that throws synchronously.
  {
    let killed = 0
    ok(
      (await interruptWithEscalation({
        graceful: () => undefined,
        graceMs: 50,
        escalate: () => killed++
      })) === undefined,
      'no cancel to run reads as answered'
    )
    ok(
      (await interruptWithEscalation({
        graceful: () => {
          throw new Error('sync boom')
        },
        graceMs: 50,
        escalate: () => killed++
      })) === undefined,
      'a synchronous throw reads as answered'
    )
    ok(killed === 0, 'neither escalates')
  }

  // --- graceful never answers → escalate (the actual bug) ------------------
  {
    let killed = 0
    const r = await interruptWithEscalation({
      graceful: never,
      graceMs: 20,
      escalate: () => killed++
    })
    ok(!!r && r.hardStopped === true, 'a wedged backend reports hardStopped')
    ok(killed === 1, 'the kill switch runs exactly once')
  }

  // It must RESOLVE, not hang — that is the whole point. If this regressed, the
  // test would time out rather than fail, so assert we got here at all.
  {
    const started = Date.now()
    await interruptWithEscalation({ graceful: never, graceMs: 10, escalate: () => {} })
    ok(Date.now() - started < 2000, 'a wedged backend still resolves promptly')
  }

  // --- a graceful answer landing in the same tick as the deadline ----------
  // The timer fires but the cancel HAS settled; killing then would tear down a
  // session that stopped fine. The post-race re-check is what prevents it.
  {
    let killed = 0
    let fire = () => {}
    const p = interruptWithEscalation({
      graceful: () => Promise.resolve(),
      graceMs: 0,
      escalate: () => killed++,
      setTimer: (fn) => {
        fire = fn
      }
    })
    await Promise.resolve()
    fire() // deadline fires after the graceful path already settled
    const r = await p
    ok(killed === 0, 'a late timer cannot kill an already-settled cancel')
    ok(r === undefined, 'and it still reports a clean stop')
  }

  if (failed === 0) {
    console.log('INTERRUPT-ESCALATION OK — clean stops preserved, wedged backends killed once')
  } else {
    process.exitCode = 1
  }
} catch (err) {
  console.error('INTERRUPT-ESCALATION FAILED:', err?.stack ?? err?.message ?? err)
  process.exitCode = 1
}
