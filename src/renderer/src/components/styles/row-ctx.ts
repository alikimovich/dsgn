import type { Token, TokenSet } from '../../../../shared/api'
import type { TokenCandidate, TokenResolution } from '../../../../shared/token-match'

/**
 * What every Styles-panel row needs from the panel. StylePanel builds one of
 * these per render and threads it to each row, so rows stay presentational —
 * they never touch `window.api` themselves.
 */
export interface RowCtx {
  values: Record<string, string>
  disabled: boolean
  preview: (prop: string, css: string) => void
  /** `group` batches a multi-prop gesture (linked sides) into one undo step. */
  commit: (prop: string, css: string, group?: string) => Promise<void>
  /** Drop the prop's live override + queued frame (editor cancelled, apply failed). */
  cancel: (prop: string) => void

  // --- design tokens -------------------------------------------------------

  /** The project's tokens, or null when none were detected. */
  tokens: TokenSet | null
  /** Tokens offerable for a property, best-ranked first (empty → no token UI). */
  tokensFor: (prop: string) => TokenCandidate[]
  /** Which token the property's current value IS, if any. */
  tokenFor: (prop: string) => TokenResolution | null
  /**
   * A token's value AS RESOLVED ON THIS ELEMENT — the live custom property when
   * we have it, else the value recorded in the token file. This is what gets
   * previewed and what the swatches paint, so a dark-mode override shows the
   * color the user will actually get.
   */
  tokenValue: (token: Token) => string
  /**
   * Commit a token pick: previews the resolved value, writes a *reference*.
   * `group` batches a multi-prop gesture, exactly as `commit` does.
   */
  commitToken: (prop: string, candidate: TokenCandidate, group?: string) => Promise<void>
}
