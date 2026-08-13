/**
 * run-stats unit test (pure — no Electron, no DOM). Covers the two things the
 * chat status line's numbers can get wrong: double-counting tokens (providers
 * re-report a request's usage cumulatively, and the two providers disagree on
 * whether cached tokens are part of `input_tokens` or alongside it), and a
 * readout that reflows as it ticks.
 *
 * Run with: bun run test:run-stats
 */
import {
  addUsage,
  describeRunStats,
  emptyUsage,
  formatDuration,
  formatTokens,
  isEmptyUsage,
  readUsage,
  usageDelta
} from '../src/shared/run-stats.ts'

let failed = 0
const same = (a, b, msg) => {
  const A = JSON.stringify(a)
  const B = JSON.stringify(b)
  if (A !== B) {
    console.error(`FAIL: ${msg} — got ${A}, want ${B}`)
    failed++
  }
}

// --- readUsage: provider shapes ---

same(readUsage(null), null, 'no payload → null')
same(readUsage('12'), null, 'non-object payload → null')
same(readUsage({}), { input: 0, output: 0, cached: 0 }, 'object with no counts → zeroes')

// Anthropic: cache reads/writes are reported ALONGSIDE input_tokens, so they add.
same(
  readUsage({
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 900,
    cache_creation_input_tokens: 50
  }),
  { input: 1050, output: 20, cached: 950 },
  'anthropic: cache tokens add to the input total'
)
// Codex: cached_input_tokens is a SUBSET of input_tokens, so it must not add.
same(
  readUsage({ input_tokens: 1000, cached_input_tokens: 900, output_tokens: 20 }),
  { input: 1000, output: 20, cached: 900 },
  'codex: cached tokens are part of the input total'
)
same(
  readUsage({ inputTokens: 30, outputTokens: 4, cachedInputTokens: 10 }),
  { input: 30, output: 4, cached: 10 },
  'camelCase spelling'
)
// Junk (negatives, strings, NaN) reads as zero rather than poisoning a total.
same(
  readUsage({ input_tokens: -5, output_tokens: '9', cache_read_input_tokens: NaN }),
  { input: 0, output: 0, cached: 0 },
  'non-positive / non-numeric counts read as zero'
)

// --- usageDelta: a request's usage is reported cumulatively, several times ---

// message_start → message_delta → the final assistant message, all for ONE request.
let sent = emptyUsage()
const report = (raw) => {
  const total = readUsage(raw)
  const delta = usageDelta(sent, total)
  sent = addUsage(sent, delta)
  return delta
}
same(
  report({ input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 1 }),
  { input: 1000, output: 1, cached: 900 },
  'message_start: the whole input side is new'
)
same(
  report({ output_tokens: 40 }),
  { input: 0, output: 39, cached: 0 },
  'message_delta: only the new output, and the omitted input is not clawed back'
)
same(
  report({ input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 40 }),
  { input: 0, output: 0, cached: 0 },
  'the final message repeats the request total → nothing new'
)
same(sent, { input: 1000, output: 40, cached: 900 }, 'one request counted exactly once')

same(isEmptyUsage(emptyUsage()), true, 'zeroes are empty')
same(isEmptyUsage({ input: 0, output: 0, cached: 3 }), false, 'cached-only is not empty')

// --- formatting: fixed-width-ish, never reflowing mid-turn ---

same(formatTokens(0), '0', 'zero')
same(formatTokens(842), '842', 'under a thousand is exact')
same(formatTokens(1234), '1.2k', 'thousands get one decimal')
same(formatTokens(9949), '9.9k', 'just under the decimal cutoff')
same(formatTokens(9950), '10k', 'rounds up past the cutoff instead of "10.0k"')
same(formatTokens(18_400), '18k', 'double-digit thousands drop the decimal')
same(formatTokens(999_400), '999k', 'just under a million')
same(formatTokens(1_240_000), '1.2M', 'millions')
same(formatTokens(12_400_000), '12M', 'double-digit millions')

same(formatDuration(0), '0:00', 'zero')
same(formatDuration(9_000), '0:09', 'seconds are zero-padded')
same(formatDuration(83_000), '1:23', 'minutes:seconds')
same(formatDuration(3_600_000), '1:00:00', 'an hour grows the field')
same(formatDuration(3_723_000), '1:02:03', 'hours:minutes:seconds')
same(formatDuration(-5), '0:00', 'a negative elapsed clamps to zero')

same(
  describeRunStats({ input: 1000, output: 40, cached: 900 }, 83_000),
  '1,000 input tokens (900 cached) · 40 output tokens · 1:23 working',
  'tooltip sentence'
)
same(
  describeRunStats({ input: 1000, output: 40, cached: 0 }, 0),
  '1,000 input tokens · 40 output tokens · 0:00 working',
  'no cache hit → no cached clause'
)

if (failed) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('run-stats: all checks passed')
