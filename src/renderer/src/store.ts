import { create } from 'zustand'
import type {
  Annotation,
  CommentMode,
  Diagnosis,
  Framework,
  PermissionMode,
  PermissionRequest,
  PreviewKind,
  QuestionRequest,
  PropInspection,
  SelectedElement,
  SessionRecord,
  SessionTranscriptEntry,
  SlashCommandItem,
  GithubStatus,
  TokenSet,
  UpdateStatus
} from '../../shared/api'
import { projectKey } from '../../shared/projectKey'
import { useComposerDrafts } from './composer-drafts'
import { emptyUsage, addUsage as sumUsage, type TokenUsage } from '../../shared/run-stats'
import {
  type ChatAgentSettings,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  type ModelSelection
} from './chat-settings'
import { preferredChatAgentSettings } from './preferred-model'

const bootChatSettings = preferredChatAgentSettings()

// The per-chat agent choices + their AgentOptions mappings live in their own
// (pure, unit-testable) module; re-exported here so importers keep one entry point.
export {
  type ChatAgentSettings,
  type ModelSelection,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  agentModelId,
  agentOptionsFor,
  chatAgentSettingsFor,
  chatModelLabel,
  chatAgentSettingsFromOptions,
  defaultChatAgentSettings,
  resumeChatSettings,
  toAgentOptions
} from './chat-settings'

/**
 * One ordered chunk of an assistant turn — additive alongside the flat
 * `text`/`statuses` fields (kept for back-compat: `CopyAction`, the status
 * line, and App.tsx's export still read those). `segments` preserves the
 * actual interleaving of prose and tool-call runs (`text → tools → text → …`)
 * instead of collapsing a whole turn into one blob + one flat status list.
 */
export type MsgSegment = { kind: 'text'; text: string } | { kind: 'tools'; statuses: string[] }

/** A vision image attached to a user turn, kept for in-bubble display (data URL). */
export interface MsgAttachment {
  id: string
  mediaType: string
  url: string
}

/** A compact, display-only snapshot of the element selection a user turn carried,
 *  so the sent bubble can show the same pill the composer did. */
export interface MsgSelection {
  tag: string
  ident: string
  source: string | null
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  /** Tool-use status lines surfaced during the turn (assistant messages). */
  statuses: string[]
  /** Ordered text/tool-run chunks — see `MsgSegment`. */
  segments: MsgSegment[]
  /** Images the user attached to this turn (user messages). */
  attachments?: MsgAttachment[]
  /** The element the user had selected when they sent this turn (user messages). */
  selection?: MsgSelection
  /** Edit-history group id (`chat:<wtId>:<turnNo>`) whose file changes this assistant
   *  turn made — set from the 'merged' isolation event; drives the per-turn Revert
   *  button. Absent for turns that made no edits or whose work was already pushed. */
  revertGroup?: string
}

/** One project's chat. `streamingId` is the assistant message currently being
 * streamed (so a backgrounded project's turn keeps appending to the right one). */
interface ChatSlice {
  messages: ChatMessage[]
  isRunning: boolean
  streamingId: string | null
  /** Auto-generated name summarising what this chat is about (main's `title`
   *  event). The rail prefers it over the first-message heuristic; undefined
   *  until generated. */
  title?: string
  /** Per-chat git-worktree isolation status (v9). `'live'` for a non-repo
   *  project (no worktree — the old behavior); `'isolated'` while its worktree
   *  auto-merges cleanly after each turn; `'parked'` when a turn's merge
   *  conflicted and the work awaits review in the sidebar. Driven by the
   *  `'isolation'` `AgentEvent` and rehydrated from `LiveChatSnapshot.isolation`. */
  isolation: 'live' | 'isolated' | 'parked'
  /** Files carrying the unmerged changes while `'parked'` — named in the in-chat
   *  conflict card. Empty/undefined otherwise (and after a reload, where the snapshot
   *  doesn't carry them — the card then omits the file list). */
  isolationFiles?: string[]
  /** Tokens this chat has spent since it opened (summed from the backends' `usage`
   *  event deltas) — the status line's ↑/↓ counters. */
  usage: TokenUsage
  /** Time this chat has spent WORKING, in ms: the sum of its finished turns'
   *  durations. Idle time between turns is deliberately excluded — a wall-clock
   *  "session age" would mostly measure how long the user was at lunch. */
  workedMs: number
  /** When the turn in flight started (`Date.now()`), or null when idle. The status
   *  line adds the live remainder to `workedMs`; `finish` folds it in. */
  turnStartedAt: number | null
  /** A turn finished while the user was looking at some OTHER chat — the rail
   *  marks it green ("done, go check it"). Cleared the moment they open it. A
   *  turn that finishes on the chat that's already on screen never sets this:
   *  they watched it land. */
  needsReview: boolean
}
const emptySlice = (): ChatSlice => ({
  messages: [],
  isRunning: false,
  streamingId: null,
  isolation: 'live',
  usage: emptyUsage(),
  workedMs: 0,
  turnStartedAt: null,
  needsReview: false
})

interface ChatState {
  /** Per-project chat, keyed by projectKey ('' is the default / no-project slice). */
  byKey: Record<string, ChatSlice>
  activeKey: string
  // Mirrors of the active slice — what ChatPanel and the tests read.
  messages: ChatMessage[]
  isRunning: boolean
  isolation: 'live' | 'isolated' | 'parked'
  isolationFiles?: string[]
  /** Show a project's chat (preserves each project's history across switches). */
  setActiveChat: (key: string) => void
  /**
   * Populate a chat slice from a session transcript (v9 resume, boot reattach) so
   * the conversation shows its past turns, not an empty thread. No-op if the slice
   * already has messages (never clobbers a live chat / a repeat restore). When
   * `isRunning` (a reattached turn still in flight in main), opens a fresh empty
   * streaming assistant message so the turn's continuing `agent:event` deltas keep
   * rendering into it (the pre-reload buffered text isn't in the transcript yet —
   * see restore.ts).
   */
  hydrate: (key: string, messages: ChatMessage[], isRunning?: boolean) => void
  /** Store this chat's auto-generated name (main's `title` event / a resumed
   *  chat's persisted title). Preserves the slice's messages. */
  setTitle: (key: string, title: string) => void
  /** Update a chat's worktree-isolation status (the `'isolation'` `AgentEvent`,
   *  or a `LiveChatSnapshot` rehydrate on reload). `files` accompany a `'parked'`
   *  status (the unmerged files) and are cleared on any other status. */
  setIsolation: (
    key: string,
    isolation: 'live' | 'isolated' | 'parked',
    files?: string[]
  ) => void
  /** Tag this chat's latest assistant turn with the edit-history group that reverts
   *  its file changes (the 'merged' isolation event). No-op if there's no assistant
   *  message yet. Call it BEFORE any post-merge note so the real turn gets tagged. */
  tagRevert: (key: string, group: string) => void
  /** Drop a project's chat buffer (on close) — including its unsent composer draft. */
  clearChat: (key: string) => void
  /** Clear a chat's "done — go check it" flag (it's been read). */
  markReviewed: (key: string) => void
  // Actions default to the active project; pass a key to target a backgrounded one.
  appendUser: (
    text: string,
    key?: string,
    extras?: { attachments?: MsgAttachment[]; selection?: MsgSelection }
  ) => void
  /** Add a standalone assistant note (e.g. a finished comment-spawn notification). */
  appendNote: (text: string, key?: string) => void
  startAssistant: (key?: string) => void
  appendDelta: (text: string, key?: string) => void
  appendStatus: (text: string, key?: string) => void
  /** Add one backend `usage` event's token delta to this chat's running totals. */
  addUsage: (delta: TokenUsage, key?: string) => void
  finish: (key?: string) => void
  /** Is the given project's turn in flight (for the rail's working dot)? */
  isRunningFor: (key: string) => boolean
}

let counter = 0
const nextId = (): string => `m${++counter}`

/**
 * Per-project chat store. The active project's slice is mirrored into the
 * top-level `messages`/`isRunning` so ChatPanel and the Playwright store harness
 * read it unchanged; backgrounded projects' turns keep streaming into their own
 * slice (the rail shows a "working" dot, and the output is there on switch-back).
 * The `agent:event` stream (tagged with `projectKey` by main) routes here.
 */
export const useChat = create<ChatState>((set, get) => {
  // Transform one project's slice, re-syncing the active mirror when it's active.
  const patch = (key: string | undefined, fn: (s: ChatSlice) => ChatSlice): void =>
    set((state) => {
      // `undefined` → the active project; an explicit '' is its own (no-project)
      // slice (don't collapse it into the active project with `||`).
      const k = key ?? state.activeKey
      const slice = fn(state.byKey[k] ?? emptySlice())
      const byKey = { ...state.byKey, [k]: slice }
      return k === state.activeKey
        ? {
            byKey,
            messages: slice.messages,
            isRunning: slice.isRunning,
            isolation: slice.isolation,
            isolationFiles: slice.isolationFiles
          }
        : { byKey }
    })
  return {
    byKey: {},
    activeKey: '',
    messages: [],
    isRunning: false,
    isolation: 'live',
    setActiveChat: (key) =>
      set((s) => {
        const prev = s.byKey[key] ?? emptySlice()
        // Opening a chat IS reading it — drop any "done, go check it" mark.
        const slice = prev.needsReview ? { ...prev, needsReview: false } : prev
        return {
          activeKey: key,
          byKey: { ...s.byKey, [key]: slice },
          messages: slice.messages,
          isRunning: slice.isRunning,
          isolation: slice.isolation,
          isolationFiles: slice.isolationFiles
        }
      }),
    hydrate: (key, messages, isRunning = false) =>
      set((s) => {
        const prev = s.byKey[key] ?? emptySlice()
        // Only seed an empty slice — never overwrite a chat that's already live.
        if (prev.messages.length) return {}
        let msgs = messages
        let streamingId: string | null = null
        if (isRunning) {
          const id = nextId()
          msgs = [...messages, { id, role: 'assistant', text: '', statuses: [], segments: [] }]
          streamingId = id
        }
        const slice: ChatSlice = {
          messages: msgs,
          isRunning,
          streamingId,
          title: prev.title,
          isolation: prev.isolation,
          isolationFiles: prev.isolationFiles,
          // A restored chat's past turns carry no usage/timing (neither the
          // transcript nor the live snapshot records them), so its counters start
          // from zero and describe this app run's work on the chat. A reattached
          // in-flight turn times from now — its real start is already gone.
          usage: prev.usage,
          workedMs: prev.workedMs,
          turnStartedAt: isRunning ? Date.now() : prev.turnStartedAt,
          needsReview: prev.needsReview
        }
        return key === s.activeKey
          ? {
              byKey: { ...s.byKey, [key]: slice },
              messages: slice.messages,
              isRunning,
              isolation: slice.isolation,
              isolationFiles: slice.isolationFiles
            }
          : { byKey: { ...s.byKey, [key]: slice } }
      }),
    setTitle: (key, title) => patch(key, (sl) => ({ ...sl, title })),
    setIsolation: (key, isolation, files) =>
      // Only a park carries files; clear them on any other status so a stale list can't
      // linger after a merge.
      patch(key, (sl) => ({ ...sl, isolation, isolationFiles: isolation === 'parked' ? files : undefined })),
    tagRevert: (key, group) =>
      patch(key, (sl) => {
        const idx = sl.messages.map((m) => m.role).lastIndexOf('assistant')
        if (idx < 0) return sl
        const messages = sl.messages.slice()
        messages[idx] = { ...messages[idx], revertGroup: group }
        return { ...sl, messages }
      }),
    clearChat: (key) => {
      // A closed chat's half-written message goes with it — otherwise a new chat
      // that reuses the key (a project's default `key` after closing all of them)
      // would open showing the dead chat's text.
      useComposerDrafts.getState().clear(key)
      set((s) => {
        const byKey = { ...s.byKey }
        delete byKey[key]
        return key === s.activeKey
          ? {
              byKey,
              messages: [],
              isRunning: false,
              isolation: 'live' as const,
              isolationFiles: undefined
            }
          : { byKey }
      })
    },
    markReviewed: (key) =>
      set((s) => {
        const slice = s.byKey[key]
        if (!slice?.needsReview) return {}
        return { byKey: { ...s.byKey, [key]: { ...slice, needsReview: false } } }
      }),
    appendUser: (text, key, extras) =>
      patch(key, (sl) => ({
        ...sl,
        messages: [
          ...sl.messages,
          {
            id: nextId(),
            role: 'user',
            text,
            statuses: [],
            segments: text ? [{ kind: 'text', text }] : [],
            ...(extras?.attachments?.length ? { attachments: extras.attachments } : {}),
            ...(extras?.selection ? { selection: extras.selection } : {})
          }
        ]
      })),
    appendNote: (text, key) =>
      patch(key, (sl) => ({
        ...sl,
        messages: [
          ...sl.messages,
          {
            id: nextId(),
            role: 'assistant',
            text,
            statuses: [],
            segments: text ? [{ kind: 'text', text }] : []
          }
        ]
      })),
    startAssistant: (key) =>
      patch(key, (sl) => {
        const id = nextId()
        return {
          ...sl,
          messages: [
            ...sl.messages,
            { id, role: 'assistant', text: '', statuses: [], segments: [] }
          ],
          isRunning: true,
          streamingId: id,
          // Start the working-time clock unless a turn is somehow already timing
          // (two starts without a finish would otherwise lose the first's elapsed).
          turnStartedAt: sl.turnStartedAt ?? Date.now()
        }
      }),
    appendDelta: (text, key) =>
      patch(key, (sl) => ({
        ...sl,
        messages: sl.messages.map((m) => {
          if (m.id !== sl.streamingId) return m
          const last = m.segments[m.segments.length - 1]
          const segments =
            last?.kind === 'text'
              ? [
                  ...m.segments.slice(0, -1),
                  { kind: 'text' as const, text: last.text + text }
                ]
              : [...m.segments, { kind: 'text' as const, text }]
          return { ...m, text: m.text + text, segments }
        })
      })),
    appendStatus: (text, key) =>
      patch(key, (sl) => ({
        ...sl,
        messages: sl.messages.map((m) => {
          if (m.id !== sl.streamingId) return m
          const last = m.segments[m.segments.length - 1]
          const segments =
            last?.kind === 'tools'
              ? [
                  ...m.segments.slice(0, -1),
                  { kind: 'tools' as const, statuses: [...last.statuses, text] }
                ]
              : [...m.segments, { kind: 'tools' as const, statuses: [text] }]
          return { ...m, statuses: [...m.statuses, text], segments }
        })
      })),
    addUsage: (delta, key) => patch(key, (sl) => ({ ...sl, usage: sumUsage(sl.usage, delta) })),
    finish: (key) => {
      // A turn that lands on a chat the user isn't looking at is the one worth
      // flagging green in the rail; one that lands on screen was already seen.
      const unseen = key !== undefined && key !== get().activeKey
      patch(key, (sl) => ({
        ...sl,
        isRunning: false,
        streamingId: null,
        // Fold the finished turn's elapsed time into the chat's total and stop the
        // clock — the gap until the next turn is idle time, which doesn't count.
        workedMs: sl.workedMs + (sl.turnStartedAt ? Date.now() - sl.turnStartedAt : 0),
        turnStartedAt: null,
        // Only a turn that was actually running counts as a completion — the bare
        // `finish()` calls that clear a reopened session's stale running flag must
        // not light the badge.
        needsReview: sl.needsReview || (unseen && sl.isRunning)
      }))
    },
    isRunningFor: (key) => !!get().byKey[key]?.isRunning
  }
})

/** What the chat's status line shows: the active chat's token totals + how long
 *  it has been working (`turnStartedAt` non-null ⟺ that clock is still running). */
export interface RunStats {
  usage: TokenUsage
  workedMs: number
  turnStartedAt: number | null
}

/**
 * The active chat's run stats. Selects the slice itself (a stable reference that
 * only changes when that chat changes) rather than a derived object, so this
 * doesn't re-render on every unrelated store write.
 */
export const useRunStats = (): RunStats => {
  const slice = useChat((s) => s.byKey[s.activeKey])
  return {
    usage: slice?.usage ?? EMPTY_USAGE,
    workedMs: slice?.workedMs ?? 0,
    turnStartedAt: slice?.turnStartedAt ?? null
  }
}
// Module-level so an absent slice yields the same object every render.
const EMPTY_USAGE = emptyUsage()

/**
 * Rebuild chat messages from a persisted session transcript (v9 resume). The
 * on-disk transcript is a flat, chronological list of `user` / `assistant` /
 * `status` (tool-use) lines; this regroups each turn's assistant text + tool
 * statuses into a single assistant `ChatMessage` with interleaved `segments`,
 * mirroring what the live stream builds (`startAssistant` → `appendDelta` /
 * `appendStatus`). A `user` line ends the current turn and starts a fresh one.
 */
export const messagesFromTranscript = (
  transcript: SessionTranscriptEntry[]
): ChatMessage[] => {
  const messages: ChatMessage[] = []
  // The assistant message the current turn's text/tool lines accrue into.
  let current: ChatMessage | null = null
  for (const entry of transcript) {
    if (entry.role === 'user') {
      current = null
      messages.push({
        id: nextId(),
        role: 'user',
        text: entry.text,
        statuses: [],
        segments: entry.text ? [{ kind: 'text', text: entry.text }] : []
      })
      continue
    }
    if (!current) {
      current = { id: nextId(), role: 'assistant', text: '', statuses: [], segments: [] }
      messages.push(current)
    }
    const last = current.segments[current.segments.length - 1]
    if (entry.role === 'assistant') {
      if (last?.kind === 'text') last.text += entry.text
      else current.segments.push({ kind: 'text', text: entry.text })
      current.text = current.text ? `${current.text}\n\n${entry.text}` : entry.text
    } else {
      // A 'status' line is a tool-use run.
      if (last?.kind === 'tools') last.statuses.push(entry.text)
      else current.segments.push({ kind: 'tools', statuses: [entry.text] })
      current.statuses.push(entry.text)
    }
  }
  return messages
}

interface SessionState {
  model: string
  /** See `ChatAgentSettings.modelId`. */
  modelId?: string
  effort: string
  /** Which backend runs the agent ('claude' | 'codex' | …) — v7. */
  provider: string
  /** v10: the user-added endpoint this chat runs against, if any. */
  connectionId?: string
  /** "/" menu entries — project skills first, described; built by main (LKM-54). */
  slashCommands: SlashCommandItem[]
  /** Set when the agent reports an auth failure — drives the onboarding banner. */
  authNeeded: boolean
  /**
   * Set when a *Codex* turn reports an auth/"not connected" failure — drives the
   * inline `codex login` hint. Kept separate from `authNeeded` (which owns the
   * Claude-specific onboarding banner) so the hint only nags after a real
   * failure, not on every switch to the Codex backend.
   */
  codexAuthNeeded: boolean
  /** Absolute path of the open project (needed to resolve prop-edit sources). */
  projectRoot: string | null
  /** The `praxis/*` branch praxis is working on (null if not a git repo). */
  branch: string | null
  setModel: (model: string) => void
  /** Apply a whole picker choice at once — model, its backend id, harness and
   *  endpoint move together, so no subscriber ever sees a half-applied pair. */
  setModelSelection: (selection: ModelSelection) => void
  setEffort: (effort: string) => void
  setProvider: (provider: string) => void
  setChatAgentSettings: (settings: ChatAgentSettings) => void
  setSlashCommands: (commands: SlashCommandItem[]) => void
  setAuthNeeded: (authNeeded: boolean) => void
  setCodexAuthNeeded: (codexAuthNeeded: boolean) => void
  setProjectRoot: (projectRoot: string | null) => void
  setBranch: (branch: string | null) => void
}

export const useSession = create<SessionState>((set) => ({
  model: bootChatSettings.model,
  modelId: bootChatSettings.modelId,
  effort: bootChatSettings.effort,
  provider: bootChatSettings.provider,
  connectionId: bootChatSettings.connectionId,
  slashCommands: [],
  authNeeded: false,
  codexAuthNeeded: false,
  projectRoot: null,
  branch: null,
  // Since v10 the model choice is a TUPLE — `model` (the picker's identity),
  // `modelId` (what the backend is actually told to run) and `connectionId` (which
  // endpoint runs it). `agentModelId` prefers `modelId`, and `connectionId` pins the
  // harness whatever `provider` says, so a setter that moves one member and leaves
  // the rest is worse than no setter at all: `setModel('haiku')` over a chat holding
  // `{ model: 'claude:opus', modelId: 'opus' }` would still run opus. These two only
  // survive for tests/imperative callers, so they set the whole tuple to a consistent
  // state: a bare model id names itself and belongs to no connection, and switching
  // harness drops a model value that was namespaced to the previous one.
  setModel: (model) => set({ model, modelId: undefined, connectionId: undefined }),
  setModelSelection: ({ model, modelId, provider, connectionId }) =>
    set({ model, modelId, provider, connectionId }),
  setEffort: (effort) => set({ effort }),
  setProvider: (provider) =>
    set({ provider, model: DEFAULT_MODEL, modelId: undefined, connectionId: undefined }),
  setChatAgentSettings: ({ model, modelId, effort, provider, connectionId, permissionMode }) => {
    // `modelId`/`connectionId` are set even when undefined — a chat with no
    // connection must CLEAR the outgoing chat's, not inherit it.
    set({ model, modelId, effort, provider, connectionId })
    // Mode is a per-chat choice too, but it lives in usePermissions (which also owns
    // the pending-prompt queue). Restore it here so activating a chat re-points the
    // toolbar dropdown to THAT chat's real mode instead of a stale global value —
    // this is the single place every switch/boot path funnels through.
    usePermissions.getState().setMode(permissionMode)
  },
  setSlashCommands: (slashCommands) => set({ slashCommands }),
  setAuthNeeded: (authNeeded) => set({ authNeeded }),
  setCodexAuthNeeded: (codexAuthNeeded) => set({ codexAuthNeeded }),
  setProjectRoot: (projectRoot) => set({ projectRoot }),
  setBranch: (branch) => set({ branch })
}))

/**
 * v5 workspace — the set of open projects and which one is active. This is the
 * future source of truth for multi-project: per-project state (preview, dev
 * server, agent session, annotations, tokens…) will hang off `activeKey`. It's
 * additive and dormant for now — App still drives a single project via
 * `useSession.projectRoot`; this store mirrors it and grows as the rail/backends
 * land (see docs/TASKS.md "v5"). Projects are identified by `projectKey(root)`.
 */
/** How to relaunch a project's preview (used to restart it after a config edit). */
export interface LaunchSpec {
  root: string
  command: string
  framework?: Framework
  previewKind: PreviewKind
}

export interface ProjectEntry {
  /** Absolute repo root as opened. */
  root: string
  /** Canonical key (`projectKey(root)`) — the dedupe + map identity. */
  key: string
  /** Display name (folder basename, overridable). */
  name: string
  // Per-project display snapshot, restored on switch (chat lives in useChat byKey;
  // tokens/annotations are re-detected on switch).
  url: string | null
  previewKind: PreviewKind
  branch: string | null
  launchSpec: LaunchSpec | null
  /** Preview viewport for THIS project — each remembers its own; restored on
   *  switch (a global viewport leaked one project's Mobile into the next). */
  viewport?: Viewport
  /** Rail: hide this project's chat list. The rail is an ACCORDION — at most one
   *  project's chats are unfolded at a time, and it's the project you last
   *  switched to: `activate`/`openOrActivate` unfold it and fold every other one,
   *  and the chevron unfolds the same exclusive way (see `foldOthers`). Folding
   *  still doesn't deactivate a project — its dev server/preview stay live either
   *  way, only the list is hidden. Persisted with the entry, so a relaunch
   *  restores the same single open project.
   *  Defaults to expanded (undefined = false). */
  chatsCollapsed?: boolean
  /** Monotonic recency stamp (bumped on activate) — drives LRU warm-server eviction. */
  touchedAt: number
  /**
   * v9 resume/multi-chat — this project's live `sessionKey`s (mirrors `agent.ts`'s
   * map): `key` itself for the default chat, plus `` `${key}#…` `` for any
   * additional (`agent:new-chat`) or resumed (`agent:resume-session`) ones.
   * Defaults to just `[key]` — untouched by projects that never open a second chat.
   */
  sessionKeys: string[]
  /** Which of `sessionKeys` is the one currently shown (mirrors `agent.ts`'s
   *  per-project `activeSessionKeyByProject`, kept in sync by whoever switches/
   *  creates/resumes a chat while this project is active). Defaults to `key`. */
  activeSessionKey: string
  /** Model/backend choices for each live chat. Missing entries are legacy
   * workspace data and safely use the defaults. */
  chatSettings?: Record<string, ChatAgentSettings>
}

export const chatAgentSettingsFromSession = (
  session: Pick<SessionState, 'model' | 'modelId' | 'effort' | 'provider' | 'connectionId'>
): ChatAgentSettings => ({
  model: session.model,
  modelId: session.modelId,
  effort: session.effort,
  provider: session.provider,
  connectionId: session.connectionId,
  permissionMode: usePermissions.getState().mode
})

interface WorkspaceState {
  projects: ProjectEntry[]
  activeKey: string | null
  /** Collapse the left projects rail to a thin strip (persisted across launches). */
  collapsed: boolean
  /** Hide the chat pane so the preview fills the window (persisted across launches). */
  chatHidden: boolean
  /** Open a project (or re-activate it if already open). Returns its key. */
  openOrActivate: (root: string, meta?: { name?: string }) => string
  activate: (key: string) => void
  /** Update one project's snapshot fields. */
  patchEntry: (key: string, partial: Partial<ProjectEntry>) => void
  close: (key: string) => void
  toggleCollapsed: () => void
  toggleChatHidden: () => void
  /** Fold/unfold a project's chat list. Unfolding folds every other project
   *  away (accordion) — see `chatsCollapsed`. */
  toggleChatsCollapsed: (key: string) => void
  reset: () => void
  /** Replace the whole set (boot restore) — see restore.ts. Also advances the
   *  LRU recency counter past the restored `touchedAt`s so entries opened after a
   *  restore still sort as newer. */
  hydrate: (projects: ProjectEntry[], activeKey: string | null) => void
}

/**
 * Light/dark theme — the tool ALWAYS matches the OS color scheme (no in-app
 * toggle). A `.dark` class on <html> flips every CSS token (shadcn + app-shell);
 * it's set before first paint and updated live when the OS switches.
 */
type Theme = 'light' | 'dark'
const systemTheme = (): Theme => {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}
const applyTheme = (t: Theme): void => {
  try {
    document.documentElement.classList.toggle('dark', t === 'dark')
  } catch {
    /* no DOM (tests) */
  }
}
applyTheme(systemTheme()) // set the class before first paint — praxis always matches the OS

/** Preview viewport: 'desktop' = fill the pane, 'mobile' = a centered phone width. */
export type Viewport = 'desktop' | 'mobile'
export const MOBILE_VIEWPORT_WIDTH = 390
interface ViewportState {
  viewport: Viewport
  setViewport: (v: Viewport) => void
}
export const useViewport = create<ViewportState>((set) => ({
  viewport: 'desktop',
  setViewport: (viewport) => {
    set({ viewport })
    // The viewport is a per-project choice: record it on the active project's
    // entry so a switch can restore it (App restores via applyProject/attempt).
    const ws = useWorkspace.getState()
    if (ws.activeKey) ws.patchEntry(ws.activeKey, { viewport })
  }
}))

/**
 * Freeze the preview under overlay UI: while `frozen`, PreviewPane swaps the
 * native view (which always paints above the DOM) for a pixel-identical
 * snapshot <img>, so dropdowns can stack on top of a still-visible preview.
 * Set by whoever opens the overlay (e.g. the branch switcher).
 */
interface PreviewFreezeState {
  frozen: boolean
  /** True once the snapshot has painted AND the live view is hidden — overlay
   *  UI (dropdowns) waits for this before opening, so it never renders behind
   *  the native view and then "pops" when the view finally hides. */
  ready: boolean
  setFrozen: (frozen: boolean) => void
  setReady: (ready: boolean) => void
}
export const usePreviewFreeze = create<PreviewFreezeState>((set) => ({
  frozen: false,
  ready: false,
  setFrozen: (frozen) => set(frozen ? { frozen } : { frozen, ready: false }),
  setReady: (ready) => set({ ready })
}))

/**
 * Open an overlay that must paint above the native preview (dropdowns, the
 * session-review modal, the feedback dialog): freeze-frame first (PreviewPane
 * swaps in a snapshot <img> and hides the native view), then call `show` once
 * the freeze is ready — showing in the same tick would render the overlay
 * behind the native view for the capture's ~80ms and then "pop" (flicker). A
 * wedged capture never blocks the overlay (350ms failsafe). Callers restore
 * with `usePreviewFreeze.getState().setFrozen(false)` on close.
 */
export const openWithPreviewFreeze = (show: () => void): void => {
  usePreviewFreeze.getState().setFrozen(true)
  if (usePreviewFreeze.getState().ready) {
    show()
    return
  }
  const done = (): void => {
    unsub()
    clearTimeout(failsafe)
    show()
  }
  const unsub = usePreviewFreeze.subscribe((s) => {
    if (s.ready) done()
  })
  const failsafe = setTimeout(done, 350)
}

/**
 * Right-edge strip (px) reserved by the floating prop panel. PreviewPane lays
 * the native view out around it — desktop shrinks the view's width, mobile
 * re-centers the whole bezel in the remaining space (naively shrinking the
 * ~390px cutout used to collapse the phone screen to a sliver).
 */
interface PanelInsetState {
  /** Right-edge strip reserved for the floating PropPanel. */
  inset: number
  /** Bottom strip reserved for the v9 code drawer (shrinks the native view's height). */
  bottom: number
  setInset: (inset: number) => void
  setBottom: (bottom: number) => void
}
export const usePanelInset = create<PanelInsetState>((set) => ({
  inset: 0,
  bottom: 0,
  setInset: (inset) => set({ inset: Math.max(0, inset) }),
  setBottom: (bottom) => set({ bottom: Math.max(0, bottom) })
}))

/**
 * The v9 editable code drawer — which stamped element's file is open in it (null =
 * closed). Opened from the Inspector's "Code" button; the drawer mounts under the
 * preview (right side) and reserves a bottom inset (usePanelInset).
 */
interface CodeDrawerState {
  /** The `data-praxis-source` string of the file open in the drawer, or null. */
  source: string | null
  /** Navigation history (Cmd+click jumps push here); index points at `source`. */
  stack: string[]
  index: number
  open: (source: string) => void
  back: () => void
  forward: () => void
  close: () => void
}
export const useCodeDrawer = create<CodeDrawerState>((set) => ({
  source: null,
  stack: [],
  index: -1,
  open: (source) =>
    set((s) => {
      if (s.source === source) return {}
      // A new open truncates any forward history (browser semantics).
      const stack = [...s.stack.slice(0, s.index + 1), source]
      return { source, stack, index: stack.length - 1 }
    }),
  back: () => set((s) => (s.index > 0 ? { index: s.index - 1, source: s.stack[s.index - 1] } : {})),
  forward: () =>
    set((s) =>
      s.index < s.stack.length - 1 ? { index: s.index + 1, source: s.stack[s.index + 1] } : {}
    ),
  close: () => set({ source: null, stack: [], index: -1 })
}))

/**
 * Recently opened projects — shown on the empty state for one-click reopening.
 * Persisted across launches; most recent first, deduped by projectKey.
 */
export interface RecentProject {
  root: string
  name: string
  at: number
}
const RECENTS_KEY = 'praxis:recent-projects'
const readRecents = (): RecentProject[] => {
  try {
    const v = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? '[]') as RecentProject[]
    return Array.isArray(v)
      ? v.filter((r) => r && typeof r.root === 'string' && typeof r.name === 'string')
      : []
  } catch {
    return []
  }
}
const writeRecents = (recents: RecentProject[]): void => {
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(recents))
  } catch {
    /* private mode / no storage — keep in memory only */
  }
}
interface RecentsState {
  recents: RecentProject[]
  addRecent: (root: string, name: string) => void
  removeRecent: (root: string) => void
  clearRecents: () => void
}
export const useRecents = create<RecentsState>((set) => ({
  recents: readRecents(),
  addRecent: (root, name) =>
    set((s) => {
      const key = projectKey(root)
      const recents = [
        { root, name, at: Date.now() },
        ...s.recents.filter((r) => projectKey(r.root) !== key)
      ].slice(0, 8)
      writeRecents(recents)
      return { recents }
    }),
  removeRecent: (root) =>
    set((s) => {
      const recents = s.recents.filter((r) => r.root !== root)
      writeRecents(recents)
      return { recents }
    }),
  clearRecents: () => {
    writeRecents([])
    set({ recents: [] })
  }
}))

/**
 * How Publish ends: 'merge' = create the PR and squash-merge it to the default
 * branch (the button reads "Publish"); 'pr' = stop after creating/updating the
 * PR and stay on the work branch (the button reads "Create PR"). Chosen from
 * the split button's settings menu; persisted across launches.
 */
export type PublishMode = 'merge' | 'pr'
const PUBLISH_MODE_KEY = 'praxis:publish-mode'
const readPublishMode = (): PublishMode => {
  try {
    return localStorage.getItem(PUBLISH_MODE_KEY) === 'pr' ? 'pr' : 'merge'
  } catch {
    return 'merge'
  }
}
interface PublishModeState {
  mode: PublishMode
  setMode: (mode: PublishMode) => void
}
export const usePublishMode = create<PublishModeState>((set) => ({
  mode: readPublishMode(),
  setMode: (mode) => {
    try {
      localStorage.setItem(PUBLISH_MODE_KEY, mode)
    } catch {
      /* private mode / no storage — keep it in memory only */
    }
    set({ mode })
  }
}))

/**
 * Praxis self-update status, pushed from main over `update.onStatus`. A banner
 * offers "Update & Restart" once available; dismissing it remembers the
 * `subject` it was dismissed for (persisted) so the SAME update doesn't
 * re-nag, but a newer one (different subject) still surfaces.
 */
const UPDATE_DISMISSED_KEY = 'praxis:update-dismissed-subject'
const readDismissed = (): string | null => {
  try {
    return localStorage.getItem(UPDATE_DISMISSED_KEY)
  } catch {
    return null
  }
}
interface UpdateState {
  status: UpdateStatus['status']
  behind: number
  subject?: string
  progress?: string
  error?: string
  dismissedSubject: string | null
  setStatus: (s: UpdateStatus) => void
  dismiss: () => void
}
export const useUpdate = create<UpdateState>((set, get) => ({
  status: 'idle',
  behind: 0,
  dismissedSubject: readDismissed(),
  setStatus: (s) =>
    set({
      status: s.status,
      behind: s.behind,
      subject: s.subject,
      progress: s.progress,
      error: s.error
    }),
  dismiss: () => {
    const subject = get().subject ?? ''
    try {
      localStorage.setItem(UPDATE_DISMISSED_KEY, subject)
    } catch {
      /* private mode / no storage — keep it in memory only */
    }
    set({ dismissedSubject: subject })
  }
}))

// Follow the OS live — no manual toggle; the tool's theme is always the Mac's.
try {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    applyTheme(e.matches ? 'dark' : 'light')
  })
} catch {
  /* no matchMedia (tests) */
}

// Remember the rail collapse preference across launches (renderer-only UI state).
const RAIL_KEY = 'praxis:rail-collapsed'
const CHAT_KEY = 'praxis:chat-hidden'
const readFlag = (key: string): boolean => {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}
const readCollapsed = (): boolean => readFlag(RAIL_KEY)

const basename = (p: string): string => p.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || p
// Monotonic recency counter for LRU warm-server eviction (process-lifetime; fine
// to reset to 0 on a fresh launch since the workspace starts empty).
let touchSeq = 0
const bumpTouched = (projects: ProjectEntry[], key: string): ProjectEntry[] =>
  projects.map((p) => (p.key === key ? { ...p, touchedAt: ++touchSeq } : p))

/**
 * The rail's accordion: unfold `key`'s chat list and fold every other project's
 * away, so exactly one project is ever open. Applied wherever a project becomes
 * the one on screen (`openOrActivate`/`activate`) and when the chevron unfolds
 * one, which is what makes switching read as a hand-off — the project you left
 * closes as the one you picked opens — instead of stacking every project you've
 * visited down the rail. Only the list folds; every project stays live.
 * Entries whose fold is already right come back as the SAME object, so this
 * never re-renders a row it didn't change.
 */
const foldOthers = (projects: ProjectEntry[], key: string): ProjectEntry[] =>
  projects.map((p) => {
    const collapsed = p.key !== key
    return Boolean(p.chatsCollapsed) === collapsed ? p : { ...p, chatsCollapsed: collapsed }
  })

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  projects: [],
  activeKey: null,
  collapsed: readCollapsed(),
  toggleCollapsed: () =>
    set((s) => {
      const collapsed = !s.collapsed
      try {
        localStorage.setItem(RAIL_KEY, collapsed ? '1' : '0')
      } catch {
        /* private mode / no storage — keep it in memory only */
      }
      return { collapsed }
    }),
  chatHidden: readFlag(CHAT_KEY),
  toggleChatHidden: () =>
    set((s) => {
      const chatHidden = !s.chatHidden
      try {
        localStorage.setItem(CHAT_KEY, chatHidden ? '1' : '0')
      } catch {
        /* private mode / no storage — keep it in memory only */
      }
      return { chatHidden }
    }),
  openOrActivate: (root, meta) => {
    const key = projectKey(root)
    const exists = get().projects.some((p) => p.key === key)
    set((s) => {
      const projects = bumpTouched(
        exists
          ? s.projects
          : [
              ...s.projects,
              {
                root,
                key,
                name: meta?.name ?? basename(root),
                url: null,
                previewKind: 'web',
                branch: null,
                launchSpec: null,
                touchedAt: 0,
                sessionKeys: [key],
                activeSessionKey: key,
                chatSettings: { [key]: chatAgentSettingsFromSession(useSession.getState()) }
              }
            ],
        key
      )
      // Accordion: the project being opened is the one that shows its chats.
      return { projects: foldOthers(projects, key), activeKey: key }
    })
    return key
  },
  // Switching hands the accordion over: the outgoing project's chat list folds
  // away as the incoming one's unfolds (`foldOthers`).
  activate: (key) =>
    set((s) =>
      s.projects.some((p) => p.key === key)
        ? { activeKey: key, projects: foldOthers(bumpTouched(s.projects, key), key) }
        : s
    ),
  patchEntry: (key, partial) =>
    set((s) => ({
      projects: s.projects.map((p) => (p.key === key ? { ...p, ...partial } : p))
    })),
  // Unfolding is exclusive (the accordion again — opening one project's chats
  // closes whichever was open); folding just closes this one.
  toggleChatsCollapsed: (key) =>
    set((s) => ({
      projects: s.projects.find((p) => p.key === key)?.chatsCollapsed
        ? foldOthers(s.projects, key)
        : s.projects.map((p) => (p.key === key ? { ...p, chatsCollapsed: true } : p))
    })),
  close: (key) =>
    set((s) => {
      const projects = s.projects.filter((p) => p.key !== key)
      const activeKey =
        s.activeKey === key ? (projects.at(-1)?.key ?? null) : s.activeKey
      return { projects, activeKey }
    }),
  reset: () => set({ projects: [], activeKey: null }),
  hydrate: (projects, activeKey) =>
    set(() => {
      // Persisted `touchedAt`s outrank a fresh launch's counter (reset to 0), which
      // would make restored entries look newer than anything opened afterwards.
      // Advance past them so LRU eviction ordering stays monotonic.
      touchSeq = projects.reduce((m, p) => Math.max(m, p.touchedAt || 0), touchSeq)
      return { projects, activeKey }
    })
}))

/**
 * Persist the workspace shape (open projects + which is active) so a renderer
 * reload / app relaunch can restore it (see restore.ts). In-memory today, mirrored
 * to localStorage here; every ProjectEntry field is plain JSON data (launchSpec /
 * viewport included), so it round-trips. Only the MAIN renderer persists — the
 * floating prop-panel view (`?praxisPanel=1`) shares this origin's localStorage but
 * has its own (empty) workspace, so it must never write over the real one.
 */
const WORKSPACE_KEY = 'praxis:workspace'
const isPanelWindow = (): boolean => {
  try {
    return new URLSearchParams(window.location.search).has('praxisPanel')
  } catch {
    return false
  }
}

export interface PersistedWorkspace {
  projects: ProjectEntry[]
  activeKey: string | null
}

export const readPersistedWorkspace = (): PersistedWorkspace | null => {
  try {
    const raw = localStorage.getItem(WORKSPACE_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as PersistedWorkspace
    if (!v || !Array.isArray(v.projects)) return null
    const projects = v.projects.filter(
      (p) => p && typeof p.root === 'string' && typeof p.key === 'string'
    )
    return { projects, activeKey: typeof v.activeKey === 'string' ? v.activeKey : null }
  } catch {
    return null
  }
}

const writePersistedWorkspace = (ws: WorkspaceState): void => {
  try {
    localStorage.setItem(
      WORKSPACE_KEY,
      JSON.stringify({ projects: ws.projects, activeKey: ws.activeKey })
    )
  } catch {
    /* private mode / no storage — keep it in memory only */
  }
}

// Write on every workspace change (open/close/switch/patch). The panel window
// never subscribes, so it can't clobber the main renderer's saved shape.
if (!isPanelWindow()) {
  useWorkspace.subscribe(writePersistedWorkspace)
}

/**
 * v5-D "previous agents" — persisted agent sessions per project, surfaced under
 * each project in the rail. Loaded lazily (on project activate / rail expand) from
 * the on-disk store in main (`window.api.sessions`); the live session isn't here
 * (it's persisted only on teardown), so this is strictly the *past* runs.
 */
interface HistoryState {
  /** Past sessions keyed by `projectKey(root)`, newest first. */
  byKey: Record<string, SessionRecord[]>
  loading: Record<string, boolean>
  /** Fetch (refresh) a project's history. */
  load: (root: string) => Promise<void>
  /** Delete one record and drop it from the list. */
  remove: (root: string, id: string) => Promise<void>
  /** Rename one record (rail inline rename); no-op if main rejects the name. */
  rename: (root: string, id: string, title: string) => Promise<void>
}

export const useHistory = create<HistoryState>((set) => ({
  byKey: {},
  loading: {},
  load: async (root) => {
    const key = projectKey(root)
    set((s) => ({ loading: { ...s.loading, [key]: true } }))
    try {
      const recs = await window.api.sessions.list(root)
      set((s) => ({ byKey: { ...s.byKey, [key]: recs }, loading: { ...s.loading, [key]: false } }))
    } catch {
      set((s) => ({ loading: { ...s.loading, [key]: false } }))
    }
  },
  remove: async (root, id) => {
    const key = projectKey(root)
    try {
      await window.api.sessions.remove(id)
    } catch {
      // best-effort; still drop it from the visible list
    }
    set((s) => ({
      byKey: { ...s.byKey, [key]: (s.byKey[key] ?? []).filter((r) => r.id !== id) }
    }))
  },
  rename: async (root, id, title) => {
    const key = projectKey(root)
    // Main normalises + validates the name, and is the only writer of the record —
    // adopt what it echoes back rather than the raw input.
    const res = await window.api.sessions.rename(id, title).catch(() => null)
    if (!res?.ok || !res.title) return
    const named = res.title
    set((s) => ({
      byKey: {
        ...s.byKey,
        [key]: (s.byKey[key] ?? []).map((r) => (r.id === id ? { ...r, title: named } : r))
      }
    }))
  }
}))

/**
 * v8 F1: detached comment spawns currently running, keyed by their parent
 * `sessionKey`, so the rail can nest each agent beneath the chat that created it. A row
 * appears the moment a comment is dispatched and is removed on `spawn-finished` (the
 * finished run reappears in `useHistory` as a "previous agent" carrying its branch).
 * These never enter `useChat` — the main chat stream stays byte-clean.
 */
export interface SpawnRow {
  id: string
  branch: string | null
  label: string
  /** Actual inherited harness/model, captured when the spawn was dispatched. */
  modelLabel: string
  /** 'queued' until a per-repo slot frees (Phase 3), then 'running'. */
  status: 'running' | 'queued'
}
interface SpawnsState {
  byKey: Record<string, SpawnRow[]>
  add: (key: string, row: SpawnRow) => void
  /** Flip a queued row to running + attach its branch (on `spawn-started`). */
  start: (key: string, id: string, branch: string) => void
  remove: (key: string, id: string) => void
}
export const useSpawns = create<SpawnsState>((set) => ({
  byKey: {},
  add: (key, row) =>
    set((s) => ({ byKey: { ...s.byKey, [key]: [row, ...(s.byKey[key] ?? [])] } })),
  start: (key, id, branch) =>
    set((s) => ({
      byKey: {
        ...s.byKey,
        [key]: (s.byKey[key] ?? []).map((r) =>
          r.id === id ? { ...r, status: 'running', branch } : r
        )
      }
    })),
  remove: (key, id) =>
    set((s) => ({ byKey: { ...s.byKey, [key]: (s.byKey[key] ?? []).filter((r) => r.id !== id) } }))
}))

/** Compact "time ago" for history timestamps (e.g. "3m ago", "2h ago", "5d ago"). */
export const relativeTime = (ms: number, now = Date.now()): string => {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  return `${d}d ago`
}

/**
 * Tighter "time ago" for the rail's chat list — Cursor-style trailing labels
 * with no "ago" suffix and month/year buckets ("3m", "2h", "5d", "4mo", "1y").
 */
export const shortAgo = (ms: number, now = Date.now()): string => {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return 'now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.round(h / 24)
  if (d < 30) return `${d}d`
  const mo = Math.round(d / 30)
  if (mo < 12) return `${mo}mo`
  return `${Math.round(d / 365)}y`
}

/**
 * Auto-name a chat from its opening user message — Praxis never asks the user to
 * title a chat, so the first prompt stands in (whitespace-collapsed and capped).
 * Falls back to `fallback` when the chat has no user turn yet.
 */
export const chatTitle = (firstUserText: string | undefined | null, fallback = 'New chat'): string => {
  const t = (firstUserText ?? '').replace(/\s+/g, ' ').trim()
  if (!t) return fallback
  const MAX = 34
  return t.length > MAX ? `${t.slice(0, MAX).trimEnd()}…` : t
}

/**
 * Heuristic: does this agent error look like a missing/invalid login?
 * Per-user auth means a fresh teammate hits this before they've run
 * `claude setup-token` (Claude) or `codex login` (Codex) — we want to guide
 * them, not show a raw 401. The `sign in` / `codex login` phrasings cover the
 * Codex backend's "not connected" errors (see backends/codex.ts).
 */
export const isAuthError = (message: string): boolean =>
  /\b401\b|invalid authentication|unauthorized|setup-token|not logged in|no credentials|authentication_error|sign in|codex login/i.test(
    message
  )

/**
 * v2 element selection. `selectMode` mirrors the overlay armed in the preview;
 * `selected` is the most recently picked element. The composer reads `selected`
 * to seed a change request that points the agent at the right source location.
 */
interface SelectionState {
  selectMode: boolean
  /** The armed inline-overlay comment mode (Figma-style C/Y), mirrored from the preview. */
  commentMode: CommentMode
  selected: SelectedElement | null
  /** Prop inspection for the selected element (null while loading / no source). */
  inspection: PropInspection | null
  inspecting: boolean
  setSelectMode: (selectMode: boolean) => void
  setCommentMode: (commentMode: CommentMode) => void
  /** Selecting a new element clears the previous inspection. */
  setSelected: (selected: SelectedElement | null) => void
  setInspection: (inspection: PropInspection | null) => void
  setInspecting: (inspecting: boolean) => void
}

export const useSelection = create<SelectionState>((set) => ({
  selectMode: false,
  commentMode: null,
  selected: null,
  inspection: null,
  inspecting: false,
  // Select and comment/annotate are mutually exclusive overlay modes.
  setSelectMode: (selectMode) => set({ selectMode, ...(selectMode ? { commentMode: null } : {}) }),
  setCommentMode: (commentMode) => set({ commentMode, ...(commentMode ? { selectMode: false } : {}) }),
  setSelected: (selected) => set({ selected, inspection: null, inspecting: false }),
  setInspection: (inspection) => set({ inspection }),
  setInspecting: (inspecting) => set({ inspecting })
}))

/**
 * Tool-permission posture + the queue of pending approve/deny prompts. `mode`
 * is the SDK's PermissionMode: 'auto' is Auto (the SDK's classifier approves the
 * routine calls; only what it flags reaches a card), 'default' asks for every
 * gated tool, 'acceptEdits' auto-accepts edits. This mirrors the ACTIVE chat's
 * mode — main holds one per session, so every path that creates or switches a
 * chat has to move both together (see chat-settings.ts).
 */
interface PermissionState {
  mode: PermissionMode
  pending: PermissionRequest[]
  setMode: (mode: PermissionMode) => void
  addRequest: (request: PermissionRequest) => void
  removeRequest: (id: string) => void
  clearPending: () => void
}

export const usePermissions = create<PermissionState>((set) => ({
  // Mirrors the boot chat's posture (last-used or the Settings default). Auto is
  // still the fallback inside preferredChatAgentSettings when nothing is stored.
  mode: bootChatSettings.permissionMode,
  pending: [],
  setMode: (mode) => set({ mode }),
  addRequest: (request) =>
    set((s) =>
      s.pending.some((p) => p.id === request.id)
        ? s
        : { pending: [...s.pending, request] }
    ),
  removeRequest: (id) => set((s) => ({ pending: s.pending.filter((p) => p.id !== id) })),
  clearPending: () => set({ pending: [] })
}))

/**
 * Pending agent questions (the AskUserQuestion tool) awaiting the user's picks.
 * Distinct from permission cards: these are the agent *asking the user* (which
 * approach, which option), not requesting a tool. The answer flows back to the
 * agent as the tool result. Deduped by id; cleared on project switch.
 */
interface QuestionState {
  pending: QuestionRequest[]
  addRequest: (request: QuestionRequest) => void
  removeRequest: (id: string) => void
  clearPending: () => void
}

export const useQuestions = create<QuestionState>((set) => ({
  pending: [],
  addRequest: (request) =>
    set((s) =>
      s.pending.some((p) => p.id === request.id) ? s : { pending: [...s.pending, request] }
    ),
  removeRequest: (id) => set((s) => ({ pending: s.pending.filter((p) => p.id !== id) })),
  clearPending: () => set({ pending: [] })
}))

// A picked element's fields come from the (only semi-trusted) previewed page.
// Collapse to a single line (no control chars / newlines, so an injected value
// can't masquerade as a new instruction paragraph) and cap by code point
// (surrogate-safe). The source is additionally validated to a `path:line` shape.
export const oneLine = (s: string, max: number): string =>
  Array.from(s.replace(new RegExp("[\\u0000-\\u001F\\u007F]+", "g"), " "))
    .slice(0, max)
    .join('')
    .trim()

const SOURCE_RE = /^[\w./@-]+:\d+(:\d+)?$/

/**
 * One-shot composer signals from App-level surfaces:
 * - `seed` prefills the chat input (user still presses Enter).
 * - `submit` sends straight to the agent (inline comment mode), or prefills if a
 *   turn is already running so the comment is never dropped.
 */
interface ComposerState {
  seed: string | null
  submit: string | null
  setSeed: (seed: string | null) => void
  setSubmit: (submit: string | null) => void
}

export const useComposer = create<ComposerState>((set) => ({
  seed: null,
  submit: null,
  setSeed: (seed) => set({ seed }),
  setSubmit: (submit) => set({ submit })
}))

/**
 * App-owned UI actions other components can invoke without prop-drilling.
 * App registers the real handlers (they close over preview routing state like
 * previewKind); callers use `useUiActions.getState().toggleSelect()`.
 */
interface UiActionsState {
  toggleSelect: () => void
  register: (actions: { toggleSelect: () => void }) => void
}

export const useUiActions = create<UiActionsState>((set) => ({
  toggleSelect: () => {},
  register: (actions) => set(actions)
}))

/**
 * In-app feedback dialog (LKM-27) — a single global open flag so any surface (the
 * previewbar button, the empty-state button) can raise the one dialog App renders.
 */
interface FeedbackState {
  open: boolean
  setOpen: (open: boolean) => void
}
export const useFeedback = create<FeedbackState>((set) => ({
  open: false,
  setOpen: (open) => set({ open })
}))

/**
 * "Connect to GitHub" (the first-publish bridge). `status` is the opened
 * project's GitHub link — `null` when it isn't a git repo (the header then keeps
 * the normal Publish control). When `status.connected` is false the header shows
 * "Connect to GitHub" instead, and `connectOpen` raises the one connect sheet
 * App renders (same single-flag pattern as the feedback dialog).
 */
interface GithubState {
  status: GithubStatus | null
  connectOpen: boolean
  setStatus: (status: GithubStatus | null) => void
  setConnectOpen: (open: boolean) => void
}
export const useGithub = create<GithubState>((set) => ({
  status: null,
  connectOpen: false,
  setStatus: (status) => set({ status }),
  setConnectOpen: (connectOpen) => set({ connectOpen })
}))

/** Render a chat slice as a plain-text transcript for a feedback attachment. */
export const formatConversation = (messages: ChatMessage[]): string =>
  messages
    .map((m) => {
      const who = m.role === 'user' ? 'You' : 'Praxis'
      const text = m.text.trim()
      return text ? `${who}: ${text}` : ''
    })
    .filter(Boolean)
    .join('\n\n')

/**
 * Props island visibility. Opening is EXPLICIT (the selection toolbar's props
 * action) — auto-popping a card on every pick was noisy. Cleared when the
 * selection is dropped.
 */
interface PropsIslandState {
  open: boolean
  setOpen: (open: boolean) => void
}

export const usePropsIsland = create<PropsIslandState>((set) => ({
  open: false,
  setOpen: (open) => set({ open })
}))

// Layers panel visibility + resizable height, persisted across launches like
// the rail's collapse preference.
const LAYERS_OPEN_KEY = 'praxis:layers-open'
const LAYERS_HEIGHT_KEY = 'praxis:layers-height'
const LAYERS_HEIGHT_MIN = 120
const LAYERS_HEIGHT_MAX = 420
const LAYERS_HEIGHT_DEFAULT = 220

const readLayersOpen = (): boolean => {
  try {
    return localStorage.getItem(LAYERS_OPEN_KEY) === '1'
  } catch {
    return false
  }
}
const readLayersHeight = (): number => {
  try {
    const n = Number(localStorage.getItem(LAYERS_HEIGHT_KEY))
    return Number.isFinite(n) && n >= LAYERS_HEIGHT_MIN && n <= LAYERS_HEIGHT_MAX
      ? n
      : LAYERS_HEIGHT_DEFAULT
  } catch {
    return LAYERS_HEIGHT_DEFAULT
  }
}

interface LayersPanelState {
  open: boolean
  height: number
  setOpen: (open: boolean) => void
  setHeight: (height: number) => void
}

export const useLayersPanel = create<LayersPanelState>((set) => ({
  open: readLayersOpen(),
  height: readLayersHeight(),
  setOpen: (open) => {
    try {
      localStorage.setItem(LAYERS_OPEN_KEY, open ? '1' : '0')
    } catch {
      /* private mode / no storage — keep it in memory only */
    }
    set({ open })
  },
  setHeight: (height) => {
    const clamped = Math.min(LAYERS_HEIGHT_MAX, Math.max(LAYERS_HEIGHT_MIN, height))
    try {
      localStorage.setItem(LAYERS_HEIGHT_KEY, String(clamped))
    } catch {
      /* private mode / no storage — keep it in memory only */
    }
    set({ height: clamped })
  }
}))

/** The on-open "set this project up for editing" offer. */
interface SetupState {
  /** The previewed app isn't source-stamped — offer to set it up. */
  needed: boolean
  dismissed: boolean
  /**
   * Can praxis instrument this project (a supported UI framework was detected)?
   * Gates the offer — never dead-end a static/vanilla project on "Set it up" —
   * and tailors the Styles tab's read-only guidance. Null until the probe runs.
   */
  canInstrument: boolean | null
  busy: boolean
  /** A setup was applied; the next readiness report verifies stamps actually fired. */
  verifying: boolean
  /**
   * One-shot signal: the setup turn finished, so App should restart the dev
   * server + reload the preview (a config edit only applies on a full restart).
   * App consumes it and clears it.
   */
  restartRequested: boolean
  status: string | null
  setNeeded: (needed: boolean) => void
  setDismissed: (dismissed: boolean) => void
  setCanInstrument: (canInstrument: boolean | null) => void
  setBusy: (busy: boolean) => void
  setVerifying: (verifying: boolean) => void
  setRestartRequested: (restartRequested: boolean) => void
  setStatus: (status: string | null) => void
  reset: () => void
}

export const useSetup = create<SetupState>((set) => ({
  needed: false,
  dismissed: false,
  canInstrument: null,
  busy: false,
  verifying: false,
  restartRequested: false,
  status: null,
  setNeeded: (needed) => set({ needed }),
  setDismissed: (dismissed) => set({ dismissed }),
  setCanInstrument: (canInstrument) => set({ canInstrument }),
  setBusy: (busy) => set({ busy }),
  setVerifying: (verifying) => set({ verifying }),
  setRestartRequested: (restartRequested) => set({ restartRequested }),
  setStatus: (status) => set({ status }),
  reset: () =>
    set({
      needed: false,
      dismissed: false,
      canInstrument: null,
      busy: false,
      verifying: false,
      restartRequested: false,
      status: null
    })
}))

/** Design tokens detected for the open project (one source wins). */
interface TokenState {
  set: TokenSet | null
  /** First-run offer to scaffold `.praxis/tokens.json` when no tokens were found. */
  offerNeeded: boolean
  offerDismissed: boolean
  scaffolding: boolean
  setSet: (set: TokenSet | null) => void
  setOfferNeeded: (offerNeeded: boolean) => void
  setOfferDismissed: (offerDismissed: boolean) => void
  setScaffolding: (scaffolding: boolean) => void
  /** Clear everything on project switch. */
  reset: () => void
}

export const useTokens = create<TokenState>((set) => ({
  set: null,
  offerNeeded: false,
  offerDismissed: false,
  scaffolding: false,
  setSet: (tokenSet) => set({ set: tokenSet }),
  setOfferNeeded: (offerNeeded) => set({ offerNeeded }),
  setOfferDismissed: (offerDismissed) => set({ offerDismissed }),
  setScaffolding: (scaffolding) => set({ scaffolding }),
  reset: () => set({ set: null, offerNeeded: false, offerDismissed: false, scaffolding: false })
}))

/** v3 handoff: reviewer notes pinned to elements + which one is focused. */
interface AnnotationState {
  list: Annotation[]
  focusedId: string | null
  setList: (list: Annotation[]) => void
  setFocused: (focusedId: string | null) => void
}

export const useAnnotations = create<AnnotationState>((set) => ({
  list: [],
  focusedId: null,
  setList: (list) => set({ list }),
  setFocused: (focusedId) => set({ focusedId })
}))

/**
 * Activity log for the open-project flow — detect, attach/spawn decision,
 * dev-server output, readiness, preview, agent. Surfaced in a collapsible
 * console so "it didn't work" has a visible trail.
 */
export type LogKind = 'info' | 'server' | 'success' | 'error'
export interface LogLine {
  id: number
  time: string
  text: string
  kind: LogKind
}

interface LogState {
  lines: LogLine[]
  open: boolean
  append: (text: string, kind?: LogKind) => void
  clear: () => void
  setOpen: (open: boolean) => void
}

let logSeq = 0

export const useLog = create<LogState>((set) => ({
  lines: [],
  open: false,
  append: (text, kind = 'info') =>
    set((s) => {
      const d = new Date()
      const time = d.toTimeString().slice(0, 8)
      // Cap history so a chatty dev server can't grow it without bound.
      const lines = [...s.lines, { id: ++logSeq, time, text, kind }].slice(-500)
      // An error auto-opens the console so the failure is visible.
      return kind === 'error' ? { lines, open: true } : { lines }
    }),
  clear: () => set({ lines: [] }),
  setOpen: (open) => set({ open })
}))

/** AI fix proposal for the current open/launch failure (propose-first). */
interface DiagnosisState {
  current: Diagnosis | null
  busy: boolean
  setCurrent: (current: Diagnosis | null) => void
  setBusy: (busy: boolean) => void
}

export const useDiagnosis = create<DiagnosisState>((set) => ({
  current: null,
  busy: false,
  setCurrent: (current) => set({ current }),
  setBusy: (busy) => set({ busy })
}))

/** Build the chat prompt prefix that anchors the agent to a picked element. */
export const describeSelectionForPrompt = (el: SelectedElement): string => {
  const id = el.id ? oneLine(el.id, 64) : ''
  const cls = el.classes[0] ? oneLine(el.classes[0], 64) : ''
  const ident = id ? `#${id}` : cls ? `.${cls}` : ''
  const source = el.source && SOURCE_RE.test(el.source) ? el.source : null
  const where = source ? ` in ${source}` : ` (selector: ${oneLine(el.selector, 200)})`
  const text = el.text ? ` with text “${oneLine(el.text, 40)}”` : ''
  return `In the preview I selected the <${oneLine(el.tag, 32)}${ident}> element${where}${text}. `
}

/**
 * A display-only snapshot of a selection for the sent message bubble — the same
 * tag + `#id`/`.class` identifier the composer's Inspector pill shows, plus the
 * source ref. Kept alongside the message so the bubble can render the pill after
 * the selection is cleared from the composer.
 */
export const selectionForBubble = (el: SelectedElement): MsgSelection => ({
  tag: el.tag,
  ident: el.id ? `#${el.id}` : el.classes[0] ? `.${el.classes[0]}` : '',
  source: el.source ?? null
})

/**
 * The preview's real current location (link clicks, SPA route changes, initial
 * load) — mirrors main's `did-navigate`/`did-navigate-in-page` reports. A single
 * global value: only one native preview `WebContentsView` is ever live, so it
 * always reflects whichever project is currently active. Kept in sync by a
 * single top-level listener (see App.tsx). The chat composer no longer reads
 * this to prepend hidden context — the agent has a `preview_location` tool
 * (main-process) it can call itself when it needs to know the current page.
 * This store may still back renderer UI (e.g. a preview URL bar) later.
 */
interface PreviewLocationState {
  url: string | null
  setUrl: (url: string | null) => void
}

export const usePreviewLocation = create<PreviewLocationState>((set) => ({
  url: null,
  setUrl: (url) => set({ url })
}))

// Exposed for the Playwright test harness (and handy for live debugging).
;(
  window as unknown as {
    __praxisStore?: typeof useChat
    __praxisSession?: typeof useSession
    __praxisSelection?: typeof useSelection
    __praxisPermissions?: typeof usePermissions
    __praxisQuestions?: typeof useQuestions
    __praxisAnnotations?: typeof useAnnotations
    __praxisTokens?: typeof useTokens
    __praxisSetup?: typeof useSetup
  }
).__praxisStore = useChat
;(window as unknown as { __praxisSession?: typeof useSession }).__praxisSession = useSession
;(
  window as unknown as { __praxisMessagesFromTranscript?: typeof messagesFromTranscript }
).__praxisMessagesFromTranscript = messagesFromTranscript
;(window as unknown as { __praxisSelection?: typeof useSelection }).__praxisSelection = useSelection
;(window as unknown as { __praxisPermissions?: typeof usePermissions }).__praxisPermissions =
  usePermissions
;(window as unknown as { __praxisQuestions?: typeof useQuestions }).__praxisQuestions = useQuestions
;(window as unknown as { __praxisAnnotations?: typeof useAnnotations }).__praxisAnnotations =
  useAnnotations
;(window as unknown as { __praxisTokens?: typeof useTokens }).__praxisTokens = useTokens
;(window as unknown as { __praxisSetup?: typeof useSetup }).__praxisSetup = useSetup
;(window as unknown as { __praxisLog?: typeof useLog }).__praxisLog = useLog
;(window as unknown as { __praxisGithub?: typeof useGithub }).__praxisGithub = useGithub
;(window as unknown as { __praxisDiagnosis?: typeof useDiagnosis }).__praxisDiagnosis = useDiagnosis
;(window as unknown as { __praxisWorkspace?: typeof useWorkspace }).__praxisWorkspace = useWorkspace
;(window as unknown as { __praxisHistory?: typeof useHistory }).__praxisHistory = useHistory
;(window as unknown as { __praxisSpawns?: typeof useSpawns }).__praxisSpawns = useSpawns
;(window as unknown as { __praxisViewport?: typeof useViewport }).__praxisViewport = useViewport
;(window as unknown as { __praxisPanelInset?: typeof usePanelInset }).__praxisPanelInset = usePanelInset
;(window as unknown as { __praxisCodeDrawer?: typeof useCodeDrawer }).__praxisCodeDrawer = useCodeDrawer
;(window as unknown as { __praxisPropsIsland?: typeof usePropsIsland }).__praxisPropsIsland = usePropsIsland
;(
  window as unknown as { __praxisPreviewLocation?: typeof usePreviewLocation }
).__praxisPreviewLocation = usePreviewLocation
;(window as unknown as { __praxisLayersPanel?: typeof useLayersPanel }).__praxisLayersPanel =
  useLayersPanel
;(window as unknown as { __praxisComposer?: typeof useComposer }).__praxisComposer = useComposer
