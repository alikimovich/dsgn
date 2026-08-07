/**
 * Pure half of "Stop must always work", split out of the backends so it can be
 * unit-tested (claude.ts reaches `electron` transitively, which the bun tier can't
 * load).
 *
 * The problem it exists for: a backend's graceful cancel can be a round trip to a
 * subprocess. The Claude Agent SDK's `interrupt()` is a control request whose
 * promise settles only when a matching `control_response` comes back, and the SDK
 * puts NO timeout on it — so against a wedged subprocess it never settles, the
 * Stop IPC never resolves, and the button is simply dead. That is the one state
 * Stop is for.
 */

/**
 * Ask nicely, then escalate.
 *
 * Runs `graceful()` against a deadline. If it settles either way in time, the turn
 * is over and nothing else happens. If the deadline passes first, `escalate()` runs
 * — the caller's kill switch — and the result reports `hardStopped`.
 *
 * A REJECTION counts as settled: an error back from the backend is still an answer,
 * and escalating on top of it would kill a session that stopped correctly.
 *
 * `escalate` runs at most once, and never after a graceful settle, so a slow-but-
 * alive backend can't be killed by a late timer.
 */
export async function interruptWithEscalation(opts: {
  /** The backend's own cancel. May return undefined (nothing to cancel). */
  graceful: () => Promise<unknown> | undefined
  /** How long to wait before killing. */
  graceMs: number
  /** The kill switch — abort the query, kill the process. Runs at most once. */
  escalate: () => void
  /** Injectable timer so tests don't sleep. Defaults to setTimeout. */
  setTimer?: (fn: () => void, ms: number) => void
}): Promise<{ hardStopped: boolean } | undefined> {
  const { graceful, graceMs, escalate, setTimer = setTimeout } = opts

  let settled = false
  const answered = new Promise<boolean>((resolve) => {
    let g: Promise<unknown> | undefined
    try {
      g = graceful()
    } catch {
      // A cancel that throws SYNCHRONOUSLY has still answered — same as a rejection.
      settled = true
      resolve(true)
      return
    }
    if (g === undefined) {
      settled = true
      resolve(true)
      return
    }
    g.then(
      () => {
        settled = true
        resolve(true)
      },
      () => {
        settled = true
        resolve(true)
      }
    )
    setTimer(() => resolve(false), graceMs)
  })

  if (await answered) return
  // Re-check: the graceful path may have landed in the same tick the timer fired.
  if (settled) return
  escalate()
  return { hardStopped: true }
}
