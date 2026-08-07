import type { AgentOptions } from '../../shared/api'
import type { ModelProvider } from './types'
import { claudeProvider } from './claude'
import { codexProvider } from './codex'
import { geminiProvider } from './gemini'

export type { ModelProvider, ProviderSession, PendingPrompt } from './types'

/**
 * Pick the backend for a session from `options.provider` (the renderer sets it;
 * default = Claude). A backend is reachable only when the renderer explicitly
 * selects it, so the default runtime is byte-identical to pre-v7.
 *
 * HARNESS AND ENDPOINT ARE ORTHOGONAL (v10). `provider` names the HARNESS — who runs
 * the agent loop — while `connectionId` names an ENDPOINT the user added (an
 * OpenAI-compatible host: Vercel AI Gateway, Groq, a custom deployment) that supplies
 * the base URL, the key and the model. Only the Codex harness can drive such an
 * endpoint today, so a set `connectionId` routes to Codex **regardless of what
 * `provider` says** — the model picker builds its entries from `ModelChoice`, and an
 * entry carrying a `connectionId` is by construction a Codex-harness entry, but a
 * stale renderer state or a resumed session could still pair one with `provider:
 * 'claude'`. Routing to Claude there would run the turn on the Claude subscription
 * and silently ignore the endpoint the user picked.
 *
 * Auth follows the same split: the two built-in seats log in with the user's own
 * subscription (Claude `setup-token`, Codex "sign in with ChatGPT"), while a
 * connection uses the user's own API key — encrypted at rest with safeStorage and
 * confined to main. No key is ever committed in-repo.
 *
 * Gemini is EXPERIMENTAL and UNWIRED: unlike Claude/Codex it has NO SDK in
 * package.json (it shells out to an external `gemini` CLI that most installs
 * lack), so selecting it by default is a runtime trap. It is therefore gated
 * behind an explicit opt-in — set PRAXIS_EXPERIMENTAL_GEMINI=1 (or `true`) to
 * enable `provider: 'gemini'`. Without the flag a 'gemini' request falls back to
 * Claude, exactly like an unknown provider. Claude and Codex are unaffected.
 */
function geminiEnabled(): boolean {
  const v = process.env.PRAXIS_EXPERIMENTAL_GEMINI
  return v === '1' || v === 'true'
}

export function pickProvider(options: AgentOptions): ModelProvider {
  // A connection is an endpoint, not a harness — and Codex is the harness that can
  // point at one. It wins the dispatch (see the note above); codex.ts fails the turn
  // soft if the id no longer resolves.
  if (options.connectionId) return codexProvider
  switch (options.provider) {
    case 'codex':
      return codexProvider
    case 'gemini':
      return geminiEnabled() ? geminiProvider : claudeProvider
    case 'claude':
    case undefined:
    default:
      return claudeProvider
  }
}
