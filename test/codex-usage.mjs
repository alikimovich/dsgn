/**
 * codex-usage unit test (pure — no Electron, no `codex` CLI). Covers the live
 * token counts the Codex status line reads off the CLI's own session rollout:
 * finding the right rollout file, pulling the newest cumulative reading out of a
 * mixed JSONL stream, and tailing a file that's still being appended to.
 *
 * The fixture lines are verbatim shapes from a real `codex exec
 * --experimental-json` run (`token_count` records carry a `total_token_usage`
 * that is CUMULATIVE for the whole thread, plus a per-call `last_token_usage`
 * that must NOT be counted).
 *
 * Run with: bun run test:codex-usage
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  findRollout,
  latestTotalUsage,
  pickRollout,
  watchRolloutUsage
} from '../src/main/codex-usage.ts'
import { usageDelta } from '../src/shared/run-stats.ts'

let failed = 0
const same = (a, b, msg) => {
  const A = JSON.stringify(a)
  const B = JSON.stringify(b)
  if (A !== B) {
    console.error(`FAIL: ${msg} — got ${A}, want ${B}`)
    failed++
  }
}
const ok = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    failed++
  }
}

const THREAD = '019fdb05-2d2a-70f1-b7d8-e40492994dcc'
const ROLLOUT = `rollout-2026-08-06T23-59-37-${THREAD}.jsonl`

const tokenCount = (total, last) =>
  JSON.stringify({
    timestamp: '2026-08-07T06:59:41.524Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: total.input,
          cached_input_tokens: total.cached,
          cache_write_input_tokens: 0,
          output_tokens: total.output,
          reasoning_output_tokens: 0,
          total_tokens: total.input + total.output
        },
        last_token_usage: {
          input_tokens: last.input,
          cached_input_tokens: last.cached,
          cache_write_input_tokens: 0,
          output_tokens: last.output,
          reasoning_output_tokens: 0,
          total_tokens: last.input + last.output
        },
        model_context_window: 258400
      }
    }
  })
const noise = (text) =>
  JSON.stringify({
    timestamp: '2026-08-07T06:59:41.490Z',
    type: 'event_msg',
    payload: { type: 'agent_message', message: text, phase: 'final_answer' }
  })

// --- pickRollout: the thread id is the filename TAIL (the timestamp is unknown) ---

same(
  pickRollout(['session_index.jsonl', ROLLOUT, `rollout-2026-08-06T10-00-00-other.jsonl`], THREAD),
  ROLLOUT,
  'picks the rollout whose name ends with the thread id'
)
same(pickRollout([ROLLOUT], 'other-thread'), null, 'no match for a different thread')
// A thread id that merely appears mid-name isn't this thread's rollout.
same(
  pickRollout([`rollout-2026-08-06T23-59-37-${THREAD}-fork.jsonl`], THREAD),
  null,
  'the id must be the tail, not a substring'
)

// --- latestTotalUsage: newest cumulative reading out of a mixed stream ---

same(latestTotalUsage(''), null, 'no records → null')
same(latestTotalUsage([noise('hi'), noise('bye')].join('\n')), null, 'no token_count → null')
same(
  latestTotalUsage(
    [
      noise('hi'),
      tokenCount(
        { input: 17232, cached: 11008, output: 5 },
        { input: 17232, cached: 11008, output: 5 }
      ),
      noise('bye'),
      tokenCount(
        { input: 34572, cached: 27136, output: 10 },
        { input: 17340, cached: 16128, output: 5 }
      )
    ].join('\n')
  ),
  { input: 34572, output: 10, cached: 27136 },
  'takes the LAST total_token_usage, never last_token_usage'
)
// A truncated / future-schema line must cost the live counts, not throw.
same(
  latestTotalUsage(
    [
      tokenCount({ input: 100, cached: 0, output: 2 }, { input: 100, cached: 0, output: 2 }),
      '{"payload":{"type":"token_count",'
    ].join('\n')
  ),
  { input: 100, output: 2, cached: 0 },
  'an unparseable line is skipped, earlier readings survive'
)

// --- findRollout / watchRolloutUsage against a real (fake-CLI) session tree ---

const home = mkdtempSync(join(tmpdir(), 'codex-home-'))
try {
  const day = join(home, 'sessions', '2026', '08', '06')
  mkdirSync(day, { recursive: true })
  // An older day that does NOT hold the thread — the walk must keep looking.
  mkdirSync(join(home, 'sessions', '2026', '07', '30'), { recursive: true })
  const stale = join(home, 'sessions', '2026', '07', '30')
  writeFileSync(join(stale, 'rollout-2026-07-30T01-00-00-old.jsonl'), '')

  same(await findRollout('nope', home), null, 'absent thread → null')

  const file = join(day, ROLLOUT)
  writeFileSync(file, `${noise('starting')}\n`)
  same(await findRollout(THREAD, home), file, 'finds the rollout under sessions/YYYY/MM/DD')

  // Tail it the way the backend does: every reading is a running THREAD total, so
  // the emitted deltas — not the raw readings — are what sum to the truth.
  const totals = []
  const watch = watchRolloutUsage(THREAD, (t) => totals.push(t), { home, intervalMs: 1 << 30 })
  try {
    await watch.poll()
    same(totals, [], 'no token_count yet → nothing reported')

    const first = tokenCount(
      { input: 17232, cached: 11008, output: 5 },
      { input: 17232, cached: 11008, output: 5 }
    )
    appendFileSync(file, `${first}\n`)
    await watch.poll()
    same(totals.at(-1), { input: 17232, output: 5, cached: 11008 }, 'first reading reported')

    // A half-written record is left for the next poll, not parsed or skipped.
    const second = tokenCount(
      { input: 34572, cached: 27136, output: 10 },
      { input: 17340, cached: 16128, output: 5 }
    )
    appendFileSync(file, second.slice(0, 40))
    await watch.poll()
    same(totals.length, 1, 'a partial line reports nothing')
    appendFileSync(file, `${second.slice(40)}\n`)
    await watch.poll()
    same(totals.at(-1), { input: 34572, output: 10, cached: 27136 }, 'the completed line is read')

    await watch.poll()
    same(totals.length, 2, 'a poll with nothing new reports nothing')

    // Concurrent polls (the timer's own, plus the end-of-turn one) must not race
    // on the read offset and skip a record between them.
    const third = { input: 51000, cached: 40000, output: 15 }
    appendFileSync(file, `${tokenCount(third, { input: 16428, cached: 12864, output: 5 })}\n`)
    const inFlight = watch.poll()
    const fourth = { input: 68000, cached: 52000, output: 20 }
    appendFileSync(file, `${tokenCount(fourth, { input: 17000, cached: 12000, output: 5 })}\n`)
    await Promise.all([inFlight, watch.poll()])
    same(
      totals.at(-1),
      { input: 68000, output: 20, cached: 52000 },
      'racing polls still land on the newest reading'
    )

    // What the backend does with those readings: diff, don't sum. Summing these
    // cumulative readings would bill the thread ~154k input tokens, not 68k.
    let sent = { input: 0, output: 0, cached: 0 }
    for (const t of totals) {
      const d = usageDelta(sent, t)
      sent = {
        input: sent.input + d.input,
        output: sent.output + d.output,
        cached: sent.cached + d.cached
      }
    }
    same(sent, totals.at(-1), 'deltas sum to the thread total, never to more')
  } finally {
    watch.stop()
  }

  // A stopped watch is inert even if the file keeps growing.
  const settled = totals.length
  const later = { input: 99999, cached: 0, output: 9 }
  appendFileSync(file, `${tokenCount(later, later)}\n`)
  await watch.poll()
  same(totals.length, settled, 'stop() ends reporting')

  // No sessions tree at all (a machine that has never run `codex`) → no crash.
  const bare = mkdtempSync(join(tmpdir(), 'codex-home-'))
  try {
    same(await findRollout(THREAD, bare), null, 'missing sessions dir → null, no throw')
    const w = watchRolloutUsage(THREAD, () => ok(false, 'must not report'), {
      home: bare,
      intervalMs: 1 << 30
    })
    await w.poll()
    w.stop()
  } finally {
    rmSync(bare, { recursive: true, force: true })
  }
} finally {
  rmSync(home, { recursive: true, force: true })
}

if (failed) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('codex-usage: all checks passed')
