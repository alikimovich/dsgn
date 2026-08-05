/**
 * The chat status line's numbers: token accounting for a chat session, plus the
 * formatting the line renders.
 *
 * Pure, and shared because both sides of the IPC need a piece of it — `main`
 * reads each provider's loosely-typed usage payload off the stream (`readUsage`
 * + `usageDelta`, so the same tokens are never counted twice), the renderer sums
 * the deltas into a session total and formats them (`formatTokens` /
 * `formatDuration`).
 */

/**
 * Tokens a provider reported for one API request. `input` is ALL input-side
 * tokens; `cached` is the part of that which was served from the prompt cache
 * (a breakdown of `input`, not a third number to add) — see `readUsage`, which
 * normalizes the providers' differing conventions into this one.
 */
export interface TokenUsage {
  input: number
  output: number
  cached: number
}

export const emptyUsage = (): TokenUsage => ({ input: 0, output: 0, cached: 0 })

export const isEmptyUsage = (u: TokenUsage): boolean => !u.input && !u.output && !u.cached

export const addUsage = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cached: a.cached + b.cached
})

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

/** Sum of whichever of these keys the payload actually carries a number under. */
const pick = (u: Record<string, unknown>, keys: string[]): number =>
  keys.reduce((acc, k) => acc + num(u[k]), 0)

/**
 * Pull token counts out of a provider's usage payload, tolerating both the
 * Anthropic spelling (`input_tokens`, `cache_read_input_tokens`,
 * `cache_creation_input_tokens`) and the camelCase one Codex uses
 * (`inputTokens`, `cachedInputTokens`). Returns null when the payload isn't an
 * object at all, so callers can ignore the many stream messages that carry no
 * usage — a payload that IS an object but has no numbers reads as all-zero.
 *
 * The two conventions differ in one way that matters: Anthropic reports cache
 * reads/writes ALONGSIDE `input_tokens` (so they add), while Codex reports
 * `cached_input_tokens` as a subset OF its `input_tokens` (so it doesn't). Both
 * normalize here to "all input tokens, of which this many were cached".
 */
export function readUsage(raw: unknown): TokenUsage | null {
  if (!raw || typeof raw !== 'object') return null
  const u = raw as Record<string, unknown>
  const alongside = pick(u, ['cache_read_input_tokens', 'cache_creation_input_tokens'])
  const subset = pick(u, ['cached_input_tokens', 'cachedInputTokens'])
  return {
    input: pick(u, ['input_tokens', 'inputTokens']) + alongside,
    output: pick(u, ['output_tokens', 'outputTokens']),
    cached: alongside + subset
  }
}

/**
 * The not-yet-reported part of a cumulative reading. Providers re-report a
 * request's usage as it grows (`message_start` → `message_delta` → the final
 * message), so a caller keeps the running maximum it has already emitted and
 * sends only this difference. Never negative: a payload that omits a field reads
 * as 0 and must not claw back tokens already counted.
 */
export function usageDelta(sent: TokenUsage, total: TokenUsage): TokenUsage {
  return {
    input: Math.max(0, total.input - sent.input),
    output: Math.max(0, total.output - sent.output),
    cached: Math.max(0, total.cached - sent.cached)
  }
}

/**
 * Compact token count for a status line that must not reflow as it ticks:
 * `842`, `1.2k`, `18k`, `1.4M`. One decimal only below 10 of a unit, so the
 * string stays ~4 characters wide at any magnitude.
 */
export function formatTokens(n: number): string {
  const v = Math.max(0, Math.round(n))
  if (v < 1000) return String(v)
  const scale = (div: number, suffix: string): string => {
    const x = v / div
    return `${x < 9.95 ? x.toFixed(1) : Math.round(x)}${suffix}`
  }
  return v < 1_000_000 ? scale(1000, 'k') : scale(1_000_000, 'M')
}

/** Elapsed time as `m:ss`, or `h:mm:ss` once it passes an hour. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/**
 * The full sentence behind the status line's compact numbers (its `title`
 * tooltip / screen-reader label) — exact counts, and what share of the input was
 * served from the prompt cache.
 */
export function describeRunStats(usage: TokenUsage, ms: number): string {
  const n = (v: number): string => v.toLocaleString('en-US')
  const cached = usage.cached ? ` (${n(usage.cached)} cached)` : ''
  return `${n(usage.input)} input tokens${cached} · ${n(usage.output)} output tokens · ${formatDuration(ms)} working`
}
