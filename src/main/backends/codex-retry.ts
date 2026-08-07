/**
 * Pure half of the Codex backend's error handling, split out of `codex.ts` so it can
 * be unit-tested — that file reaches `electron` transitively (via `../providers`),
 * which the bun test tier can't load.
 */

/** `Reconnecting... 2/5 (unexpected status 403 Forbidden: …, url: …)` */
const RECONNECT_RE = /^Reconnecting\.\.\.\s*\d+\/\d+\s*\(([\s\S]*)\)\s*$/

/**
 * Collapse the CLI's retry storm into one line that actually says what happened.
 *
 * A failed request is retried up to five times and EVERY attempt arrives as its own
 * `error` ThreadEvent, so an unusable model paints five red lines into the chat
 * before the real failure. Worse, the six messages are ordered worst-last: the
 * attempts carry the cause ("403 Forbidden: Free tier users do not have access to
 * this model") while the terminal one — the last thing the user reads — says only
 * "exceeded retry limit, last status: 429".
 *
 * Verified live against AI Gateway on a free-tier key (2026-08-07), which is exactly
 * the state a user is in right after pasting their first key, so this is the first
 * failure they'd ever see. `note()` takes an attempt out of the error stream (it's
 * progress, not an outcome) while keeping its reason; `explain()` grafts that reason
 * onto the terminal error.
 *
 * Create one PER TURN — a cause from an earlier turn must not be grafted onto a
 * later, unrelated failure.
 */
export function createRetryCause(): {
  /** True when `message` was a retry attempt (caller should not emit it as an error). */
  note: (message: string) => boolean
  /** The terminal error with the remembered cause appended, when there is one. */
  explain: (message: string) => string
} {
  let cause: string | null = null
  return {
    note: (message) => {
      const m = RECONNECT_RE.exec(message.trim())
      if (!m) return false
      // Drop the trailing ", url: …" — the endpoint is ours, not news to the user.
      cause = (m[1] ?? '').replace(/,\s*url:\s*\S+$/, '').trim() || null
      return true
    },
    explain: (message) => (cause ? `${message} — ${cause}` : message)
  }
}
