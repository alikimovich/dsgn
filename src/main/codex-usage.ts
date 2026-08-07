import { open, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readUsage, type TokenUsage } from '../shared/run-stats'

/**
 * Live token counts for a Codex turn, read off the CLI's own session rollout.
 *
 * The SDK's typed event stream reports usage exactly once, on `turn.completed`
 * (its `ThreadEvent` union has no incremental usage member — verified against
 * the CLI's `exec --experimental-json` schema). So the status line sat at
 * `↑ 0 ↓ 0` for the whole of a Codex turn, which on a multi-minute turn is the
 * entire time anyone is looking at it.
 *
 * The CLI does record the counts as it goes, though — every model response
 * appends a `token_count` record to the thread's rollout file under
 * `$CODEX_HOME/sessions/<YYYY>/<MM>/<DD>/rollout-<timestamp>-<threadId>.jsonl`.
 * Tailing that file is read-only, costs one stat + a tail read per second while
 * a turn runs, and degrades to exactly the old behavior if the file can't be
 * found (`turn.completed` still delivers the full amount).
 *
 * Both sources report `total_token_usage` — a CUMULATIVE tally for the whole
 * thread, not a per-turn one — so callers must diff them (`usageDelta`) rather
 * than sum them.
 */

/** `$CODEX_HOME`, else `~/.codex` — where the CLI keeps its session rollouts. */
export const codexHome = (): string => process.env.CODEX_HOME || join(homedir(), '.codex')

/**
 * A thread's rollout out of one directory's filenames. Rollouts are named
 * `rollout-<timestamp>-<threadId>.jsonl`; the thread id is the tail, since the
 * timestamp (of thread creation, not of this turn) isn't something we know.
 */
export const pickRollout = (names: string[], threadId: string): string | null =>
  names.find((n) => n.startsWith('rollout-') && n.endsWith(`-${threadId}.jsonl`)) ?? null

/**
 * The newest cumulative reading in a slice of rollout JSONL, or null if it holds
 * none. Non-`token_count` records (the bulk of the file — messages, tool calls,
 * world state) and unparseable lines are skipped, so a rollout schema change can
 * only cost us the live counts, never throw.
 */
export function latestTotalUsage(chunk: string): TokenUsage | null {
  let latest: TokenUsage | null = null
  for (const line of chunk.split('\n')) {
    if (!line.includes('"token_count"')) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const payload = (parsed as { payload?: { type?: string; info?: Record<string, unknown> } })
      .payload
    if (payload?.type !== 'token_count') continue
    const total = readUsage(payload.info?.total_token_usage)
    if (total) latest = total
  }
  return latest
}

const NUMERIC = /^\d+$/
const dated = async (dir: string): Promise<string[]> => {
  try {
    return (await readdir(dir))
      .filter((n) => NUMERIC.test(n))
      .sort()
      .reverse()
      .map((n) => join(dir, n))
  } catch {
    return []
  }
}

/**
 * Newest-first day directories under `<home>/sessions`. Capped, and only the two
 * newest years/months are descended into: a heavy Codex user's session tree is
 * large, and the rollout we're after was created seconds ago (or, for a resumed
 * thread, on the day that thread started).
 */
async function newestDayDirs(sessions: string, cap = 6): Promise<string[]> {
  const out: string[] = []
  for (const year of (await dated(sessions)).slice(0, 2)) {
    for (const month of (await dated(year)).slice(0, 2)) {
      for (const day of await dated(month)) {
        out.push(day)
        if (out.length >= cap) return out
      }
    }
  }
  return out
}

/** Locate a thread's rollout file, or null if it isn't there (yet). */
export async function findRollout(threadId: string, home = codexHome()): Promise<string | null> {
  const sessions = join(home, 'sessions')
  for (const day of await newestDayDirs(sessions)) {
    let names: string[] = []
    try {
      names = await readdir(day)
    } catch {
      continue
    }
    const hit = pickRollout(names, threadId)
    if (hit) return join(day, hit)
  }
  return null
}

export interface RolloutUsageWatch {
  /** Read whatever the CLI has appended since the last poll. Driven by the
   *  watcher's own timer; exposed so a test can step it deterministically. */
  poll: () => Promise<void>
  stop: () => void
}

/**
 * Tail a thread's rollout and hand each new cumulative reading to `onTotal`
 * (which must diff it against what it has already counted — these are totals).
 * Resolving the path is retried on every poll: at `thread.started` the CLI may
 * not have written the file yet.
 */
export function watchRolloutUsage(
  threadId: string,
  onTotal: (total: TokenUsage) => void,
  opts: { home?: string; intervalMs?: number } = {}
): RolloutUsageWatch {
  let stopped = false
  let path: string | null = null
  let offset = 0

  const readNew = async (): Promise<void> => {
    if (stopped) return
    path ??= await findRollout(threadId, opts.home ?? codexHome())
    if (stopped || !path) return
    const fh = await open(path, 'r').catch(() => null)
    if (!fh) return
    try {
      const { size } = await fh.stat()
      // Rollouts only grow; a shrunken one has been replaced, so re-read it whole
      // (the caller diffs totals, so re-reporting what it already has costs nothing).
      if (size < offset) offset = 0
      if (size <= offset) return
      const buf = Buffer.alloc(size - offset)
      await fh.read(buf, 0, buf.length, offset)
      const text = buf.toString('utf8')
      // The CLI is appending while we read, so the tail may be half a record.
      // Stop at the last complete line and resume from there next time.
      const end = text.lastIndexOf('\n')
      if (end < 0) return
      offset += Buffer.byteLength(text.slice(0, end + 1))
      const total = latestTotalUsage(text.slice(0, end))
      if (total && !stopped) onTotal(total)
    } finally {
      await fh.close()
    }
  }

  // Reads are serialized: the caller polls once more when the turn ends, and two
  // reads racing on the same `offset` would each advance it and skip a chunk.
  let queue: Promise<void> = Promise.resolve()
  const poll = (): Promise<void> => {
    queue = queue.catch(() => {}).then(readNew)
    return queue
  }

  let busy = false
  const timer = setInterval(() => {
    if (busy || stopped) return
    busy = true
    void poll()
      .catch(() => {})
      .finally(() => {
        busy = false
      })
  }, opts.intervalMs ?? 1000)
  timer.unref?.()

  return {
    poll,
    stop: () => {
      stopped = true
      clearInterval(timer)
    }
  }
}
