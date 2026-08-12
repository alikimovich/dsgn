export type TurnTerminalOutcome = 'success' | 'failed'

/**
 * Provider streams do not all agree on terminal events: Codex can emit `error` and
 * then `done`, while Claude may emit only `error`. Claim exactly one terminal outcome
 * per turn so worktree finalization can neither be skipped nor run twice.
 */
export class TurnTerminalTracker {
  private finalized = new Set<string>()

  begin(sessionKey: string): void {
    this.finalized.delete(sessionKey)
  }

  claim(sessionKey: string, event: 'done' | 'error'): TurnTerminalOutcome | null {
    if (this.finalized.has(sessionKey)) return null
    this.finalized.add(sessionKey)
    return event === 'done' ? 'success' : 'failed'
  }
}
