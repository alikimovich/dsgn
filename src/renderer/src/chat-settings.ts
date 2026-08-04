/**
 * The agent choices that belong to ONE chat (backend, model, effort, permission
 * posture) and the pure mappings between them and the `AgentOptions` main starts
 * a session with.
 *
 * Two copies of this state exist by necessity — the toolbar's (renderer) and the
 * live session's (main, `ProviderSession.options`) — so every session-creating
 * call must hand main the SAME settings the toolbar shows, and every restore must
 * read them back. `agentOptionsFor` / `chatAgentSettingsFromOptions` are the two
 * directions of that round trip; going through them is what keeps the pickers
 * honest (a hand-built options object silently dropped `permissionMode`, so a
 * chat could read "Auto" while main was actually asking for every edit).
 *
 * Pure + dependency-free (no zustand, no window.api) so it can be unit-tested —
 * `store.ts` re-exports the whole surface, so importers can keep using it.
 */
import type { AgentOptions, PermissionMode } from '../../shared/api'

// Sentinel values mean "use the account/model default" (omit from SDK options).
export const DEFAULT_MODEL = 'default'
export const DEFAULT_EFFORT = 'auto'
/** The default backend (the Claude Agent SDK). */
export const DEFAULT_PROVIDER = 'claude'

/** Agent choices belong to a chat. `useSession` mirrors the active chat so the
 * toolbar stays simple, while `ProjectEntry.chatSettings` retains every chat's
 * choice as the user moves through the rail. */
export interface ChatAgentSettings {
  model: string
  effort: string
  provider: string
  /** Tool-permission posture for THIS chat. Persisted per-chat like model/provider
   *  so switching chats restores it (main keeps mode per-session; see usePermissions). */
  permissionMode: PermissionMode
}

export const defaultChatAgentSettings = (): ChatAgentSettings => ({
  model: DEFAULT_MODEL,
  effort: 'high',
  provider: DEFAULT_PROVIDER,
  permissionMode: 'auto'
})

/** This chat's settings out of a project entry (structurally typed so this module
 *  stays free of the store's `ProjectEntry`). Missing entries are legacy workspace
 *  data and safely use the defaults. */
export const chatAgentSettingsFor = (
  entry: { chatSettings?: Record<string, ChatAgentSettings> },
  sessionKey: string
): ChatAgentSettings => ({ ...defaultChatAgentSettings(), ...entry.chatSettings?.[sessionKey] })

/** Convert the UI sentinels into AgentOptions the SDK understands. */
export const toAgentOptions = (s: { model: string; effort: string; provider?: string }): {
  model?: string
  effort?: string
  provider?: string
} => ({
  model: s.model === DEFAULT_MODEL ? undefined : s.model,
  effort: s.effort === DEFAULT_EFFORT ? undefined : s.effort,
  // Default Claude is implied — only send a non-default backend.
  ...(s.provider && s.provider !== DEFAULT_PROVIDER ? { provider: s.provider } : {})
})

/** The FULL options a session must be started with — the SDK sentinels plus the
 *  permission posture. Every open/new-chat/restart/resume call site uses this, so
 *  none of them can forget the mode and leave the picker lying about the session. */
export const agentOptionsFor = (s: ChatAgentSettings): AgentOptions => ({
  ...toAgentOptions(s),
  permissionMode: s.permissionMode
})

/**
 * The inverse: what a session started with these options is ACTUALLY running as.
 * The fallbacks are main's, not the UI's — an absent `permissionMode` means
 * `'default'` (ask), the SDK default backends/claude.ts applies, NOT the toolbar's
 * 'auto'. Used to reconcile the pickers with main after a renderer reload.
 */
export const chatAgentSettingsFromOptions = (options: AgentOptions = {}): ChatAgentSettings => ({
  model: options.model ?? DEFAULT_MODEL,
  effort: options.effort ?? DEFAULT_EFFORT,
  provider: options.provider ?? DEFAULT_PROVIDER,
  permissionMode: options.permissionMode ?? 'default'
})

/**
 * Settings for a chat resumed from a history record. Resume is Claude-only (the
 * record's `sdkSessionId` is both the resume id and the "this was Claude" marker),
 * so a resumed chat always runs on Claude — and a model alias picked for another
 * backend ("gpt-5") means nothing to it, hence the account default. Everything
 * else (effort, permission posture) carries over from the visible chat.
 */
export const resumeChatSettings = (current: ChatAgentSettings): ChatAgentSettings =>
  current.provider === DEFAULT_PROVIDER
    ? current
    : { ...current, provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL }
