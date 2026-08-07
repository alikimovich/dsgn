/**
 * The codex CLI retries a failed request five times and emits EVERY attempt as its
 * own `error` ThreadEvent, so an unusable model would paint five red lines into the
 * chat before the real failure — and the terminal message is the least informative
 * of the six, because the cause only appears inside the attempts.
 *
 * `createRetryCause` collapses that: attempts leave the error stream (they're
 * progress) but their reason is remembered and grafted onto the terminal error.
 *
 * The fixtures below are REAL messages captured live from AI Gateway on a free-tier
 * key (2026-08-07) — the exact state a user is in right after pasting a first key,
 * which makes this the first failure they would ever see.
 *
 * Run with: bun run test:codex-retry
 */
import { createRetryCause } from '../src/main/backends/codex-retry.ts'

let failed = 0
const ok = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    failed++
  }
}

const attempt = (n) =>
  `Reconnecting... ${n}/5 (unexpected status 403 Forbidden: Free tier users do not have ` +
  `access to this model. Upgrade to paid credits at https://vercel.com/d?to=%2F for ` +
  `unrestricted access., url: https://ai-gateway.vercel.sh/v1/responses)`
const TERMINAL = 'exceeded retry limit, last status: 429 Too Many Requests'

try {
  // --- the real free-tier storm --------------------------------------------
  const rc = createRetryCause()
  const swallowed = [1, 2, 3, 4, 5].filter((n) => rc.note(attempt(n)))
  ok(swallowed.length === 5, 'every retry attempt is taken out of the error stream')

  const explained = rc.explain(TERMINAL)
  ok(explained.includes(TERMINAL), 'the terminal message is kept')
  ok(
    explained.includes('Free tier users do not have access to this model'),
    'the CAUSE is grafted onto the terminal error — the whole point'
  )
  ok(explained.includes('Upgrade to paid credits'), 'the actionable part of the cause survives')
  ok(!explained.includes('url: https://'), 'the endpoint URL is trimmed (not news to the user)')

  // --- a normal error is untouched ------------------------------------------
  const clean = createRetryCause()
  const plain = 'something else went wrong'
  ok(clean.note(plain) === false, 'a non-retry message is NOT swallowed')
  ok(clean.explain(plain) === plain, 'with no remembered cause, explain is identity')

  // --- shapes that must not be mistaken for a retry attempt -----------------
  const edge = createRetryCause()
  ok(edge.note('Reconnecting to the socket') === false, 'prose mentioning reconnecting is not one')
  ok(edge.note('') === false, 'an empty message is not a retry attempt')
  ok(
    edge.note('Reconnecting... 1/5 ()') === true,
    'a retry attempt with an empty reason is still swallowed'
  )
  ok(edge.explain(TERMINAL) === TERMINAL, 'an empty reason adds nothing rather than a bare dash')

  // --- a multi-line reason (stderr can wrap) --------------------------------
  const multi = createRetryCause()
  ok(multi.note('Reconnecting... 2/5 (line one\nline two)') === true, 'a multi-line reason parses')
  ok(multi.explain('boom').includes('line two'), 'the whole multi-line reason is carried')

  if (failed === 0) {
    console.log('CODEX-RETRY-CAUSE OK — storm collapsed, cause preserved, non-retry errors intact')
  } else {
    process.exitCode = 1
  }
} catch (err) {
  console.error('CODEX-RETRY-CAUSE FAILED:', err?.stack ?? err?.message ?? err)
  process.exitCode = 1
}
