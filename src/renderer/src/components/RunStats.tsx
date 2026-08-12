import { useEffect, useState } from 'react'
import { describeRunStats, formatDuration, formatTokens } from '../../../shared/run-stats'
import { useRunStats } from '../store'

/**
 * The chat status line's numbers, next to the running cat: tokens in, tokens
 * out, and how long this chat has been working.
 *
 * It replaced the running tool caption ("Reading App.tsx…") that used to sit
 * here. That caption wasn't lost — every step is still listed in the turn's own
 * StepDisclosure, one line above — but it told the user nothing about what the
 * turn was costing, and a status line is the one place that's on screen for the
 * whole turn.
 *
 * Time is WORKING time (finished turns + the one in flight), not wall clock
 * since the chat opened — see the store's `workedMs`.
 */
export default function RunStats(): React.JSX.Element | null {
  const { usage, workedMs, turnStartedAt } = useRunStats()
  // Re-render once a second while a turn is in flight so the clock ticks; when
  // it isn't, `workedMs` alone is the answer and nothing needs to tick.
  const [, tick] = useState(0)
  useEffect(() => {
    if (turnStartedAt == null) return
    const id = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [turnStartedAt])

  const elapsed = workedMs + (turnStartedAt == null ? 0 : Date.now() - turnStartedAt)
  // Nothing to say before the chat's first turn.
  if (!elapsed && !usage.input && !usage.output) return null

  return (
    <span
      className="chat__stats flex min-w-0 shrink items-center gap-2 whitespace-nowrap text-[12px] tabular-nums text-muted-foreground"
      title={describeRunStats(usage, elapsed)}
    >
      <span aria-hidden="true">↑ {formatTokens(usage.input)}</span>
      <span aria-hidden="true">↓ {formatTokens(usage.output)}</span>
      <span aria-hidden="true">{formatDuration(elapsed)}</span>
      {/* The visible row is three bare numbers with arrow glyphs — meaningless
          read aloud, so it's hidden and the full sentence is exposed instead. */}
      <span className="sr-only">{describeRunStats(usage, elapsed)}</span>
    </span>
  )
}
