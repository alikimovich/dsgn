/**
 * Types shared across the main / preload / renderer boundary. This module is
 * neutral (no electron or node imports) so every tsconfig can include it
 * without dragging in process-specific code.
 */
import type { GithubConnectOptions, GithubConnectResult, GithubStatus } from './github'

export type { GithubConnectOptions, GithubConnectResult, GithubStatus } from './github'

export type PackageManager = 'bun' | 'pnpm' | 'yarn' | 'npm'
export type Framework =
  | 'vite'
  | 'next'
  | 'cra'
  | 'sveltekit'
  | 'expo'
  | 'react-native'
  // A plain static site (vanilla HTML/CSS/JS, no package.json or build step) —
  // served by praxis's own built-in static file server, not a spawned dev command.
  | 'static'
  | 'unknown'

/**
 * What the right pane previews: a web dev server in the native WebContentsView
 * ('web'), or a booted iOS Simulator streamed through the local sim bridge
 * ('simulator'). Threads through detection so the renderer drives the right
 * lifecycle (devServer.* vs simulator.*) while everything downstream of the URL
 * — bounds, load, retry — stays identical.
 */
export type PreviewKind = 'web' | 'simulator'

/**
 * AI-assisted diagnosis of an open/launch failure. praxis *proposes* a fix (never
 * auto-runs): repo-scoped steps it can apply, host-scoped steps (sudo / global /
 * downloads) the user runs. Cached per-machine by `signature` so a repeat error
 * recalls the plan instead of re-diagnosing.
 */
export interface DiagStep {
  text: string
  /** Optional exact shell command (shown with a copy button). */
  command?: string
  /** 'repo' = praxis can apply it; 'host' = machine-level, the user must run it. */
  scope: 'repo' | 'host'
}
export interface Diagnosis {
  /** Stable cache key derived from the error. */
  signature: string
  summary: string
  detail?: string
  steps: DiagStep[]
  /** True when recalled from the per-machine cache rather than freshly diagnosed. */
  seenBefore: boolean
  /** Last recorded outcome for this signature on this machine. */
  status?: 'proposed' | 'applied' | 'dismissed'
}

/** Result of ensuring/switching the opened project's `praxis/*` working branch. */
export interface BranchResult {
  isRepo: boolean
  /** The branch now checked out (null if not a git repo or the switch failed). */
  branch: string | null
  /** True if this call created the branch. */
  created: boolean
  /** Set when a switch failed (e.g. conflicting uncommitted changes). */
  error?: string
}

export interface DetectedProject {
  root: string
  name: string
  framework: Framework
  packageManager: PackageManager
  scriptName: string
  /** Full command we'll run, e.g. "bun run dev". User may override this. */
  devCommand: string
  /** Web dev server vs iOS Simulator (React Native / Expo → 'simulator'). */
  previewKind: PreviewKind
}

export interface RunningDevServer {
  url: string
  pid: number
  /** True when we attached to a server the user was already running (we don't own it). */
  attached?: boolean
}

/** Result of `devserver:info` — lets a reattaching renderer recover an already-
 *  running project's URL instead of blindly respawning on a fresh port. */
export interface DevServerInfo {
  running: boolean
  server?: RunningDevServer
}

/**
 * A booted simulator served through the local sim bridge. `url` is that bridge's
 * HTTP URL (an MJPEG device page) so `preview.load(url)` is unchanged at the call
 * site — the simulator preview is "just another local URL".
 */
export interface RunningSimulator {
  url: string
  /** PID of the Metro/Expo dev-server process group (for teardown). */
  pid: number
  /** The booted device's UDID. */
  udid: string
  /** The launched app's bundle id (so subsequent runs relaunch without rebuilding). */
  bundleId: string
  previewKind: 'simulator'
}

/** One bootable iOS simulator device. */
export interface SimDevice {
  udid: string
  name: string
  runtime: string
}

/**
 * Result of probing the host for iOS-Simulator capability — all read-only. The
 * renderer surfaces `reason` (a human message) when `ok` is false, instead of
 * crashing on a non-macOS host or one without Xcode.
 */
export interface SimPreflight {
  ok: boolean
  reason?: string
  isMac: boolean
  hasXcode: boolean
  /** `idb` present (enables Phase-2 interaction); mirroring works without it. */
  hasIdb: boolean
  runtimes: string[]
  devices: SimDevice[]
}

/**
 * The agent's permission posture, mirroring the SDK's `PermissionMode`:
 * - `auto` — **praxis's default**: a model classifier approves/denies each tool
 *   call; only the ones it flags as risky fall through to praxis's canUseTool
 *   (approve/deny card). No prompts for routine work, but genuinely dangerous
 *   ops still surface.
 * - `default` — ask (cards) for every tool the SDK gates.
 * - `acceptEdits` — auto-accept file edits, still ask for the rest (e.g. Bash).
 * - `bypassPermissions` — skip all checks (and praxis's canUseTool guards); unused.
 */
export type PermissionMode = 'auto' | 'default' | 'acceptEdits' | 'bypassPermissions'

/** One selectable choice in an agent question (the SDK's AskUserQuestion tool). */
export interface QuestionOption {
  /** Short display text (1-5 words). */
  label: string
  /** Why this option / what it implies — shown under the label. */
  description?: string
}

/** One question the agent posed to the user via the AskUserQuestion tool. */
export interface QuestionSpec {
  /** Very short chip label (≤12 chars), e.g. "Approach". */
  header: string
  /** The full question sentence. */
  question: string
  options: QuestionOption[]
  /** Allow picking more than one option (else single-choice). */
  multiSelect: boolean
}

/**
 * A pending agent question surfaced to the user as an interactive multiple-choice
 * card (distinct from a tool approve/deny). The user's picks flow back to the
 * agent as the tool result. `id` correlates the answer to the awaiting SDK call.
 */
export interface QuestionRequest {
  id: string
  questions: QuestionSpec[]
}

/**
 * The user's answer to a QuestionRequest: question text → chosen answer string
 * (multi-select answers comma-joined; free text for "Other"). `null` (sent by the
 * renderer) means the user dismissed the question without answering.
 */
export type QuestionAnswers = Record<string, string>

/** A pending tool-permission prompt surfaced to the user as an approve/deny card. */
export interface PermissionRequest {
  /** Correlates the renderer's decision back to the awaiting SDK callback. */
  id: string
  toolName: string
  /** Full prompt sentence from the SDK when available (else built from tool + input). */
  title: string
  /** Short noun phrase, e.g. "Edit file" — good for compact labels. */
  displayName?: string
  /** A single-line summary of the most relevant input (path / command / pattern). */
  detail?: string
}

/**
 * One entry in the composer's "/" menu. `source: 'project'` marks a skill
 * discovered in the opened repo (`.claude/skills/<name>/SKILL.md`) — these rank
 * first and carry the SKILL.md frontmatter `description`; everything else the
 * backend advertises (built-ins, user-level skills) is `'other'`.
 */
export interface SlashCommandItem {
  name: string
  description?: string
  source: 'project' | 'other'
}

export type AgentEvent = (
  | { type: 'delta'; text: string }
  | { type: 'status'; text: string }
  | { type: 'commands'; commands: SlashCommandItem[] }
  | { type: 'permission-request'; request: PermissionRequest }
  /** A pending request was resolved without the user (abort/session change) — dismiss its card. */
  | { type: 'permission-resolved'; id: string }
  /** The agent asked the user a multiple-choice question (AskUserQuestion tool). */
  | { type: 'question-request'; request: QuestionRequest }
  /** A pending question was resolved (answered elsewhere / abort / session change) — dismiss its card. */
  | { type: 'question-resolved'; id: string }
  | { type: 'done' }
  | { type: 'error'; message: string }
  /** An auto-generated name for this chat, summarising what the conversation is
   *  about (not its opening words). Emitted once per chat after the first turn
   *  completes; the renderer stores it on the chat slice and the rail shows it. */
  | { type: 'title'; title: string }
  /** A queued comment spawn (v8 F1 Phase 3) started running — flip its rail row from
   *  queued → running and attach its branch. */
  | { type: 'spawn-started'; branch: string }
  /** A detached comment spawn (v8 F1) finished — drop its working rail row. `branch`
   *  is null when it auto-applied onto the working tree, else the durable review
   *  branch. `summary` (the agent's closing message) + `files` drive a notification
   *  in the parent project's chat so the user can follow up on it. */
  | { type: 'spawn-finished'; branch: string | null; summary?: string; files?: string[] }
  /** Per-chat worktree isolation status (v9). A chat's turn merged back onto the live
   *  checkout ('merged'), a private worktree was forked for the chat ('isolated'), or a
   *  turn parked on its branch after mid-turn drift ('parked'). Routed by `projectKey` =
   *  the chat's emitKey, like every other interactive-chat event. */
  | {
      type: 'isolation'
      state: 'isolated' | 'merged' | 'parked'
      branch?: string
      files?: string[]
      /** On 'merged': the edit-history group id (`chat:<wtId>:<turnNo>`) that reverts
       *  this turn's file changes — the renderer tags the merged assistant message with
       *  it to render a per-turn Revert button. */
      group?: string
      /** On 'merged': whether this turn is safely revertable (false once the chat's
       *  work has been pushed & merged via a PR) — the renderer hides Revert if false. */
      revertable?: boolean
    }
) & {
  /** Which project's session emitted this — set by main so the renderer routes it
   * to the right chat (active project shows live; others accumulate in the rail). */
  projectKey?: string
  /** Set for a detached comment-spawn's events (v8 F1) — the renderer keeps these
   *  out of the main chat stream and routes them to the spawn's own rail row. */
  sessionId?: string
}

/** Per-session options the user can set from the chat toolbar. */
/**
 * An image pasted or dropped into the composer, sent to the agent as a vision
 * content block. `data` is raw base64 (no `data:` prefix); `mediaType` is the
 * MIME type (e.g. "image/png").
 */
export interface ImageAttachment {
  mediaType: string
  data: string
}

export interface AgentOptions {
  /** Model alias ('opus' | 'sonnet' | 'haiku') or undefined for the account default. */
  model?: string
  /** Reasoning effort ('low' | 'medium' | 'high') or undefined for the model default. */
  effort?: string
  /** Permission posture; defaults to 'default' (ask). */
  permissionMode?: PermissionMode
  /**
   * Which subscription-login backend to run (v7): 'claude' (default) | 'codex' | …
   * Undefined → Claude. Each backend authenticates with the user's own subscription
   * (Claude setup-token / Codex sign-in-with-ChatGPT / …) — never an in-repo API key.
   */
  provider?: string
}

/** One line of a recorded agent session's transcript (v5-D history). */
export interface SessionTranscriptEntry {
  role: 'user' | 'assistant' | 'status'
  text: string
  at: number
}

/**
 * A persisted agent session ("previous agent") — captured in main as the agent
 * works and written to disk when the session ends (close / switch-away suspend /
 * quit), so it's reopenable for review or resume after restart. `endedAt` is null
 * while the session is still live.
 */
export interface SessionRecord {
  id: string
  projectKey: string
  projectRoot: string
  projectName: string
  startedAt: number
  endedAt: number | null
  /** The praxis/* branch it worked on, if the renderer tagged it. */
  branch?: string
  /** The PR it produced, if published. */
  prUrl?: string
  /** Repo-relative (or absolute) paths the agent edited this session. */
  filesTouched: string[]
  transcript: SessionTranscriptEntry[]
  /**
   * An auto-generated name summarising what this chat is about (LLM-derived from
   * the conversation once its first turn finishes), so the rail shows a meaningful
   * label instead of the opening words. Absent until generated (or on a backend
   * without title support) — the rail then falls back to the first user message.
   */
  title?: string
  /** A detached comment spawn (v8 F1), vs the interactive project chat. */
  kind?: 'comment'
  /**
   * The Claude Agent SDK's own resumable session id (v9 resume), captured off
   * the `system`/init message. Only the Claude backend sets this (Codex/Gemini
   * have no equivalent primitive wired up) — its presence is what the "Resume"
   * affordance gates on, since it doubles as a Claude-backend marker.
   */
  sdkSessionId?: string
}

/**
 * One live (still-open, in-memory) agent chat, as seen from main — used to
 * reattach the renderer after a reload without tearing down the session. The
 * full in-progress `SessionRecord` (transcript included) travels here so the
 * renderer can repaint the chat without a round trip to disk (a live session
 * is only persisted on teardown, so `sessions:list`/`sessions:get` can't see it).
 */
export interface LiveChatSnapshot {
  sessionKey: string
  record: SessionRecord
  /** A turn is currently in flight for this session (best-effort — see
   *  `agent:workspace-snapshot`'s implementation for how it's derived). */
  isRunning: boolean
  /** Per-chat worktree isolation status (v9), for the renderer to rehydrate the chat's
   *  isolation chip after a reload. Absent for a non-isolated chat (treated as 'live'). */
  isolation?: { state: 'live' | 'isolated' | 'parked'; branch?: string }
}

/** One live project (an open workspace-rail entry) and its live chat(s). */
export interface LiveProjectSnapshot {
  projectKey: string
  /** Absolute project root, recovered from the session record. */
  root: string
  chats: LiveChatSnapshot[]
  /** Which of `chats` was last active for this project, if any. */
  activeSessionKey: string | null
}

/** Everything still live in main when the renderer asks — the reattach source
 *  of truth after a hard reload (render-process-gone, hard refresh). */
export interface WorkspaceSnapshot {
  projects: LiveProjectSnapshot[]
  /** The project root of the globally active sessionKey, if any. */
  activeRoot: string | null
}

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
  /** Corner radius for the native view (card inset in desktop viewport, iPhone
   *  screen in mobile); 0/omitted = square. */
  radius?: number
}

/**
 * An element the user picked in the live preview (v2 select mode). `source` is
 * the repo's opt-in `data-praxis-source` stamp ("path/File.tsx:line") when present
 * — that's what lets the agent edit the exact component (see DESIGN.md).
 */
export interface SelectedElement {
  tag: string
  id: string | null
  classes: string[]
  selector: string
  source: string | null
  /**
   * The nearest COMPONENT-instance call site (v8 F3a) — `data-praxis-component-source`,
   * which the stamp plugin forwards so the authored `<Component …/>` (not the
   * innermost host) wins. Lets the inspector edit per-instance props. Null when the
   * element isn't inside a stamped component instance (or on a non-React backend).
   */
  componentSource: string | null
  text: string | null
  rect: Bounds
  styles: Record<string, string>
}

/** Figma-style inline overlay modes: comment-to-agent (C) or annotation (Y). */
export type CommentMode = 'comment' | 'annotate' | null

/** A comment/annotation submitted from the preview's inline composer. */
export interface PreviewComment {
  kind: 'comment' | 'annotate'
  el: SelectedElement
  text: string
}

/**
 * A stamped element's source file, read for the inspector's inline code peek —
 * the whole file (so surrounding context is visible) plus the stamp line and,
 * when the JSX parse resolves it, the element's full line span for highlighting.
 */
export interface SourceView {
  /** Repo-relative file path (from the stamp). */
  file: string
  /** The full file content. */
  code: string
  /** 1-based line the stamp points at. */
  line: number
  /** 1-based inclusive line span of the stamped element (open → close tag). */
  elementStart?: number
  elementEnd?: number
}

/** Result of a whole-file save from the v9 code drawer. */
export interface SourceWriteResult {
  ok: boolean
  /** The file drifted on disk since the drawer loaded it — refused to clobber. */
  conflict?: boolean
  /** Human-readable failure (unresolved path, write error). */
  error?: string
}

export type PropKind = 'string' | 'number' | 'boolean' | 'enum' | 'other'

/** One editable prop/attribute of a selected element. */
export interface PropField {
  name: string
  kind: PropKind
  /** Allowed values for `kind: 'enum'`. */
  options?: string[]
  /** Current literal value at the usage site, if set and literal. */
  value?: string | number | boolean
  /** Currently set with a non-literal expression — editing it routes to the agent. */
  expression?: boolean
  /** From react-docgen, when a schema was resolved. */
  description?: string
  required?: boolean
  /** This prop isn't currently on the element (offered from the schema to add). */
  fromSchema?: boolean
  /** The component's declared default (react-docgen), when one was resolved.
   *  Drives the "reset to default" affordance — resetting removes the attribute
   *  so the value falls back to this. (v8 F2) */
  default?: string | number | boolean
}

/** Result of inspecting a selected element's editable props. */
export interface PropInspection {
  component: string
  /** The `path:line` we edit at (from the element's data-praxis-source). */
  source: string
  fields: PropField[]
  /**
   * True when a real prop schema resolved (react-docgen). This is the gate: only
   * schema-backed components get the prop panel; otherwise it's prompt-only.
   */
  hasSchema: boolean
  /** Why the schema is limited (e.g. no react-docgen match), if applicable. */
  note?: string
}

/** What the floating prop-panel island renders from (main renderer → island). */
export interface PanelState {
  root: string
  element: SelectedElement
  inspection: PropInspection | null
  inspecting: boolean
  /**
   * Tallest the CARD may grow (px) — derived from the preview area by the main
   * renderer. The island must not size itself from its own viewport (the view's
   * height follows the card's reported height; 100vh would be circular).
   */
  maxHeight: number
  /** AI-surfaced control panels matching the selection (Custom Controls, v10) —
   *  fetched by the main renderer via `controls:get`; null while unfetched. */
  controls: ResolvedControlPanel[] | null
  /**
   * Can praxis instrument this project for visual editing (a supported UI
   * framework was detected)? Tailors the Styles tab's read-only guidance when
   * the picked element has no source stamp. Null while unprobed.
   */
  canInstrument: boolean | null
  /**
   * The project's detected design tokens, so the Styles tab can name the
   * current value ("--color-text", not "#6c6c6c") and offer a picker. Null
   * while undetected / between projects.
   */
  tokens: TokenSet | null
}

/** A user action inside the island, relayed back to the main renderer. */
export type PanelAction =
  | { kind: 'close' }
  | { kind: 'seed'; text: string }
  | { kind: 'setup' }
  | { kind: 'owner' }
  | { kind: 'inspection'; inspection: PropInspection }
  /** Ask the AI to surface a control panel for the selection (Custom Controls,
   *  v10) — App builds the trigger prompt and auto-sends it as a real turn. */
  | { kind: 'controls'; hint?: string; panelId?: string }

export interface PropEdit {
  source: string
  name: string
  kind: PropKind
  value: string | number | boolean
}

export interface PropEditResult {
  applied: boolean
  /** When not applied directly: the change needs the agent (complex / non-literal). */
  needsAgent?: boolean
  /** A ready-to-send prompt describing the change, when `needsAgent`. */
  agentPrompt?: string
  error?: string
}

/**
 * A style change from the island's Styles tab (v10). `prop` is a css longhand
 * from the fixed v1 allowlist (e.g. 'padding-top', 'border-radius',
 * 'transition-duration'); `value` is its css text (e.g. '13px', '150ms',
 * 'cubic-bezier(.17,.67,.83,.67)'). `classes` is the element's live class list,
 * which drives the Tailwind-first commit strategy (rewrite a utility class when
 * one matches, else splice an inline style, else route to the agent).
 */
export interface StyleEdit {
  /** The element's `data-praxis-source` stamp ("path/File.tsx:line"). */
  source: string
  /** The css property (longhand) being edited. */
  prop: string
  /** The new css value, as css text. */
  value: string
  /** The element's current class list (Tailwind class-rewrite candidates). */
  classes: string[]
  /**
   * Optional undo-batch id: a multi-prop gesture (the linked padding/margin
   * scrubber commits four longhands) sends one shared group so a single Cmd+Z
   * reverts the whole gesture — the per-prop coalesce keys differ, so
   * edit-history's group batching is the only thing that can join them.
   */
  group?: string
  /**
   * Set when the user picked a DESIGN TOKEN rather than a raw value: write a
   * reference (`var(--color-text)`, or a Tailwind token class) instead of
   * `value`. `value` still carries the token's resolved css text, so the live
   * preview, the post-commit reconcile and Replay all keep working against
   * something concrete — only the text written into source differs.
   *
   * Only the name + group cross the boundary: main re-detects the project's
   * tokens and re-validates the pick (name exists, value shape fits the
   * property), so the island's claim is never trusted. An unresolvable token is
   * dropped silently and the edit lands as a plain value edit — the value is
   * still right, only the reference is unavailable.
   */
  token?: { name: string; group: string }
}

/** Result of applying a StyleEdit (mirrors PropEditResult's shape). */
export interface StyleEditResult {
  applied: boolean
  /** How the edit landed: a Tailwind class rewrite or an inline-style splice. */
  strategy?: 'tailwind' | 'inline'
  /** True when a token REFERENCE was written (rather than the resolved value). */
  wroteToken?: boolean
  /** When not applied directly: the change needs the agent (dynamic class / expression style). */
  needsAgent?: boolean
  /** A ready-to-send prompt describing the change, when `needsAgent`. */
  agentPrompt?: string
  error?: string
}

/** Which control primitive the island renders for a custom-control param. */
export type ControlKind = 'number' | 'color' | 'select' | 'toggle' | 'text' | 'bezier'

/**
 * How a custom-control param writes back to the repo. The manifest is untrusted
 * agent output — main validates every strategy's target before any write.
 * - `prop`    — a component prop edit, applied at the live selection's
 *               `componentSource ?? source` through the props engine.
 * - `style`   — a css property, routed through the Styles engine (StyleEdit).
 * - `literal` — a source literal located by `anchor`: a unique substring that
 *               ends immediately before the literal in the manifest's `file`.
 *               Must occur exactly once (checked at save AND at every apply);
 *               main lexes + renders the replacement literal itself — supplied
 *               strings are never spliced raw.
 */
export type ControlApply =
  | { strategy: 'prop'; propName: string }
  | { strategy: 'style'; styleProp: string }
  | { strategy: 'literal'; anchor: string }

/** One parameter in an AI-surfaced control panel. Static metadata only — the
 *  current value is re-derived from the source of truth on every read (no
 *  values are stored, so manifests can't drift). */
export interface ControlParam {
  /** Stable id, unique within its panel (`^[a-z0-9][a-z0-9-]{0,40}$`). */
  id: string
  /** Human label rendered next to the control (≤80 chars, rendered as text). */
  label: string
  kind: ControlKind
  /** Display unit for 'number' params, e.g. 'px' | 'ms'. */
  unit?: string
  /** Clamp range for 'number' params (main clamps on apply, not just in UI). */
  min?: number
  max?: number
  /** Scrub increment for 'number' params. */
  step?: number
  /** Allowed values for `kind: 'select'`. */
  options?: string[]
  /** How the param writes back to source. */
  apply: ControlApply
}

/**
 * An AI-surfaced control panel for one component (Custom Controls, v10) —
 * generated by the agent's `define_controls` tool, validated by main, and
 * persisted in the repo's `.praxis/control-panels.json` sidecar. Upserted by
 * `file` + `component` (regenerating replaces, never duplicates).
 */
export interface ControlPanelManifest {
  id: string
  /** Repo-relative source file the panel's params live in. */
  file: string
  /** The component name the panel targets (matches PropInspection.component). */
  component: string
  /** Panel heading shown in the island's Custom tab. */
  title: string
  params: ControlParam[]
  createdAt: string
}

/**
 * A ControlParam with its value freshly resolved from the source of truth
 * (`literal` → lexed from the live file; `prop` → props:inspect; `style` →
 * the element's computed styles). `valid: false` (with `reason`) marks a param
 * whose target no longer resolves — rendered disabled with a Regenerate offer.
 */
export interface ResolvedControlParam extends ControlParam {
  /** The current value, or null when it couldn't be resolved. */
  value: string | number | boolean | null
  /** False when the anchor/prop/style target no longer resolves. */
  valid: boolean
  /** Why the param is invalid (e.g. "anchor not found"), when `valid` is false. */
  reason?: string
}

/** A manifest plus its params resolved against the live tree — what the island renders. */
export interface ResolvedControlPanel {
  manifest: ControlPanelManifest
  params: ResolvedControlParam[]
}

/** Result of an undo/redo over the praxis source-edit history (v8 F3b). */
export interface UndoResult {
  ok: boolean
  /** The file reverted/re-applied. */
  file?: string
  /** The history stack was empty. */
  empty?: boolean
  /** The file changed on disk since the edit — refused to clobber. */
  conflict?: boolean
}

/**
 * Apply a design token to the selected element directly (agent-free) when it maps
 * to an existing literal — a schema enum/string prop, or a single inline-style
 * property of the same family. Ambiguous cases (add-new, no stamp, className
 * expression, multiple candidates) fall back to the agent (`needsAgent`).
 */
export interface TokenEdit {
  /** The element's `data-praxis-source` stamp (null → agent). */
  source: string | null
  token: Token
  /** The token's group name (e.g. 'colors' | 'spacing' | 'radius' | 'fontSize'). */
  group: string
  /** How the token source renders a reference (css → var(--name); else the value). */
  tokenSource: TokenSource
  /** The element's current class list (for the future Tailwind-class-swap path). */
  classes: string[]
}

/** A reviewer note pinned to an element, stored in the repo's .praxis sidecar. */
export interface Annotation {
  id: string
  /** The element's data-praxis-source, if any. */
  source: string | null
  selector: string
  tag: string
  /** The reviewer's note. */
  text: string
  createdAt: string
}

/** What the renderer supplies to create an annotation (id/createdAt assigned in main). */
export interface AnnotationInput {
  source: string | null
  selector: string
  tag: string
  text: string
}

export interface PublishResult {
  ok: boolean
  /** The created PR URL on success. */
  url?: string
  /** The fresh praxis/* branch created to continue on (publish.ship). */
  branch?: string
  error?: string
}

/**
 * In-app feedback (LKM-27) posted as a GitHub issue on Praxis's OWN repo (the
 * app's git checkout, `app.getAppPath()`), not the opened target project. The
 * screenshot + conversation are opt-in attachments — the renderer only sends
 * them when the corresponding toggle is on, so a bare report carries neither.
 */
export interface FeedbackInput {
  /** The user's typed feedback. */
  body: string
  /** A `data:image/…;base64,…` app screenshot, present only when opted in. */
  screenshot?: string | null
  /** The rendered chat transcript, present only when opted in. */
  conversation?: string | null
}

export interface FeedbackResult {
  ok: boolean
  /** The created issue URL on success. */
  url?: string
  error?: string
}

/** Result of scaffolding source-stamping into an unprepared project. */
export type Frontend = 'react' | 'react-native' | 'svelte' | 'vue' | 'solid' | 'unknown'
/** How praxis instruments source mapping for the detected framework. */
export type SetupStrategy =
  | 'babel-plugin'
  | 'babel-plugin-rn'
  | 'svelte-preprocess'
  | 'inspector'
  | 'none'

/**
 * Read-only setup probe — can praxis instrument this project for visual editing?
 * Runs the deps-based framework detection WITHOUT writing anything, so the
 * renderer can decide up front whether to even offer setup (never dead-end a
 * static/vanilla project on "Set it up") and how to word the Styles tab's
 * read-only guidance.
 */
export interface SetupProbe {
  /** The detected UI framework (deps-based), or 'unknown' when unrecognized. */
  framework: Frontend
  /** True when praxis can add source-mapping for this framework (i.e. framework !== 'unknown'). */
  canInstrument: boolean
}

export interface SetupResult {
  ok: boolean
  /** The detected UI framework (NOT the build tool) — drives everything. */
  framework?: Frontend
  /** The instrumentation approach chosen for that framework. */
  strategy?: SetupStrategy
  /** Svelte major version (4 or 5), so the prop-typing idiom is right. */
  svelteMajor?: number
  /** Repo-relative files praxis wrote (under `.praxis/`). */
  files?: string[]
  /** False if the helper already existed (idempotent). */
  written?: boolean
  error?: string
}

export type TokenSource = 'manifest' | 'tailwind' | 'css' | 'none'

export interface Token {
  name: string
  value: string
}

export interface TokenGroup {
  name: string
  tokens: Token[]
}

/** Design tokens detected in the opened repo (one source wins per project). */
export interface TokenSet {
  source: TokenSource
  /** Human label for where they came from, e.g. ".praxis/tokens.json". */
  origin?: string
  groups: TokenGroup[]
}

/** Result of scaffolding a starter `.praxis/tokens.json` manifest. */
export interface TokenScaffoldResult {
  ok: boolean
  /** False if a manifest already existed (idempotent — nothing written). */
  written: boolean
  /** The token set after scaffolding (now sourced from the manifest). */
  set?: TokenSet
  error?: string
}

/** One entry in the File → Open Recent menu (pushed from the renderer's store). */
export interface RecentMenuEntry {
  root: string
  name: string
}

/**
 * Self-update status pushed from main (`update:status`). Praxis is distributed
 * as a git checkout; the updater compares HEAD to the tracked remote.
 * - `idle`      — up to date, or not a git checkout / offline / no upstream.
 * - `available` — `behind` commits behind the remote; `subject` is the newest.
 * - `updating`  — an in-app "Update & Restart" is running; `progress` is the
 *                 latest output line.
 * - `error`     — a check or apply failed; `error` is the message.
 */
export interface UpdateStatus {
  status: 'idle' | 'available' | 'updating' | 'error'
  behind: number
  subject?: string
  progress?: string
  error?: string
}

/** The surface exposed on `window.api` by the preload bridge. */
export interface PraxisApi {
  /** Subscribe to native-menu (Actions/File) commands: 'reload' | 'stop' | 'select' |
   *  'open-project' | 'new-project' | 'clear-recents' | 'viewport:desktop' |
   *  'viewport:mobile'. Returns an unsubscribe. */
  onMenuAction: (cb: (action: string) => void) => () => void
  /** Recover a dropped/selected file's absolute on-disk path (Electron's
   *  `webUtils.getPathForFile`, run in the preload). Returns '' for a file with
   *  no on-disk path (e.g. an in-memory clipboard blob). Synchronous. */
  pathForFile: (file: File) => string
  /** Native window-chrome state. Drives layout that depends on whether the macOS
   *  traffic lights are present (they vanish in fullscreen). */
  window: {
    /** Current native-fullscreen state (traffic lights hidden when true). */
    isFullscreen: () => Promise<boolean>
    /** Fires on enter/leave native fullscreen with the new state. */
    onFullscreenChange: (cb: (fullscreen: boolean) => void) => () => void
  }
  /** File menu ↔ renderer recents bridge. The renderer owns the recents list
   *  (localStorage); it pushes the current set so main can build the native
   *  File → Open Recent submenu, and is called back when one is chosen. */
  menu: {
    /** Push the current recents (most-recent-first) so main rebuilds Open Recent. */
    setRecents: (recents: RecentMenuEntry[]) => void
    /** Fires when a project is chosen from File → Open Recent. */
    onOpenRecent: (cb: (root: string) => void) => () => void
  }
  preview: {
    setBounds: (bounds: Bounds) => void
    load: (url: string) => Promise<void>
    reset: () => Promise<void>
    /** Hide the native view while the user drags the split (it would otherwise eat mouse events). */
    setDragging: (active: boolean) => void
    /** Toggle click-to-select mode in the previewed app (v2). */
    setSelectMode: (active: boolean) => Promise<void>
    /** Fires when the user clicks an element in select mode. */
    onElementPicked: (cb: (el: SelectedElement) => void) => () => void
    /** Fires when select mode is cancelled from inside the preview (Escape). */
    onSelectCancelled: (cb: () => void) => () => void
    /** Render annotation pins in the preview, located by CSS selector. */
    setAnnotations: (pins: { id: string; selector: string }[]) => void
    /** Toggle the in-page iPhone bezel overlay (mobile viewport); passes clicks through. */
    setFrame: (active: boolean) => void
    /** Drop the in-preview selection toolbar (pill removed / message sent). */
    clearSelected: () => void
    /** Launch progress shown inside the preview (bottom pill); null clears. */
    setStatus: (text: string | null) => void
    /** Fires when S is pressed inside the focused preview (toggle select). */
    onToggleSelect: (cb: () => void) => () => void
    /** Fires when the preview navigates (link clicks, SPA routes) — full URL. */
    onUrlChanged: (cb: (url: string) => void) => () => void
    /** Selection-toolbar actions that resolve in the renderer (code / delete). */
    onToolbarAction: (cb: (kind: 'code' | 'delete' | 'props') => void) => () => void
    /** Snapshot the live preview as a data URL (freeze-frame under overlay UI). */
    capture: () => Promise<string | null>
    /** Fires after the previewed app loads, reporting source-stamp coverage. */
    onReadiness: (cb: (info: { stamps: number }) => void) => () => void
    /** Fires when the user commits an inline text edit in the preview. */
    onTextEdit: (cb: (edit: { source: string; text: string }) => void) => () => void
    /** Arm/disarm the inline comment (C) or annotation (Y) overlay mode. */
    setCommentMode: (mode: CommentMode) => Promise<void>
    /** Fires when the preview's mode changes from a keyboard shortcut (C/Y/Esc). */
    onCommentMode: (cb: (mode: CommentMode) => void) => () => void
    /** Fires when the user submits an inline comment/annotation in the preview. */
    onComment: (cb: (c: PreviewComment) => void) => () => void
  }
  /**
   * Floating prop-panel plumbing. The floating island is a separate
   * WebContentsView stacked above the preview (DOM can't paint over a native
   * view); the main renderer drives its bounds/state, the panel instance
   * renders and reports actions/height back.
   */
  panel: {
    /** Main renderer → position + show the island (window coordinates). */
    show: (bounds: { x: number; y: number; width: number; height: number }) => void
    hide: () => void
    /** Main renderer → push the state the island renders from. */
    setState: (state: PanelState) => void
    /** Island → receive state pushes. */
    onState: (cb: (state: PanelState) => void) => () => void
    /** Island → relay a user action to the main renderer. */
    action: (action: PanelAction) => void
    /** Main renderer → handle island actions. */
    onAction: (cb: (action: PanelAction) => void) => () => void
    /** Island → report its rendered size (px). */
    reportSize: (size: { width: number; height: number }) => void
    /** Main renderer → resize the island view to the reported size. */
    onSize: (cb: (size: { width: number; height: number }) => void) => () => void
  }
  project: {
    pick: () => Promise<string | null>
    detect: (root: string) => Promise<DetectedProject>
    /** Save-dialog for a folder to create (New Project…). Null when cancelled. */
    pickNew: () => Promise<string | null>
    /** Scaffold a minimal Vite+React app there, git init, install deps. */
    create: (root: string) => Promise<{ ok: boolean; root?: string; error?: string }>
  }
  devServer: {
    start: (opts: {
      root: string
      command: string
      framework?: Framework
    }) => Promise<RunningDevServer>
    /** Stop the dev server for one project (others keep running). */
    stop: (root: string) => Promise<void>
    /** Is this project's dev server still running? (warm servers can die) */
    isRunning: (root: string) => Promise<boolean>
    /** Like `isRunning`, but also returns the running server's URL/pid — lets a
     *  reattaching renderer (e.g. after a reload) recover the live preview URL
     *  instead of respawning on a fresh port. */
    info: (root: string) => Promise<DevServerInfo>
    onLog: (cb: (line: string) => void) => () => void
  }
  git: {
    /** Ensure work happens on a `praxis/*` branch (creates one off HEAD if needed). */
    ensure: (root: string) => Promise<BranchResult>
    /** Switch to / create a specific branch (name is coerced to `praxis/<…>`). */
    set: (root: string, name: string) => Promise<BranchResult>
    /** List local branches (current first) so the titlebar pill can switch. */
    list: (root: string) => Promise<{ branches: string[]; current: string | null }>
    /** Check out an existing branch by exact name (no praxis/ coercion). */
    checkout: (root: string, branch: string) => Promise<BranchResult>
  }
  diagnose: {
    /** Recall a cached fix for this error, else ask the AI; caches the result. Null without auth. */
    run: (root: string, error: string, context?: string) => Promise<Diagnosis | null>
    /** Record the user's decision for a signature (per-machine memory). */
    record: (root: string, signature: string, status: 'applied' | 'dismissed') => Promise<void>
  }
  simulator: {
    /** Probe the host for macOS + Xcode + a bootable simulator (read-only, never throws). */
    preflight: () => Promise<SimPreflight>
    /** Boot a sim, start Metro/Expo, launch the app, stand up the frame bridge. */
    start: (opts: { root: string; command?: string; udid?: string }) => Promise<RunningSimulator>
    stop: () => Promise<void>
    /** Phase 3: arm/disarm element-select (a tap becomes a source pick). */
    setSelectMode: (active: boolean) => Promise<void>
    onLog: (cb: (line: string) => void) => () => void
    /** A tapped simulator element, resolved to its RN source when the testID
     * stamp is present (null source → project not set up for select). */
    onElementPicked: (cb: (pick: { source: string | null; tag: string }) => void) => () => void
  }
  props: {
    /**
     * Inspect the editable props of the element at `source` ("path:line").
     * `text` is the clicked element's rendered text — for Svelte it lets praxis
     * content-match the click to the concrete component INSTANCE (v8 F3a-svelte)
     * instead of falling back to a definition-default edit.
     */
    inspect: (root: string, source: string, text?: string | null) => Promise<PropInspection | null>
    /** Apply a prop edit; may report it needs the agent for a complex change. */
    apply: (root: string, edit: PropEdit) => Promise<PropEditResult>
    /** Apply a design token directly when it maps to a literal; agent-fallback otherwise. */
    applyToken: (root: string, edit: TokenEdit) => Promise<PropEditResult>
    /** Remove a prop attribute from the element's source (reset-to-default). Reversible
     *  via the F3b edit history. A no-op (already absent) reports applied. (v8 F2) */
    remove: (root: string, source: string, name: string) => Promise<PropEditResult>
  }
  text: {
    /** Rewrite the element's text content in source; agent-fallback for complex content. */
    apply: (root: string, edit: { source: string; text: string }) => Promise<PropEditResult>
  }
  /** The island's Styles tab (v10): live scrub injection into the previewed app
   *  plus the Tailwind-first commit engine (`main/styles.ts`). */
  styles: {
    /** Commit a style edit to source: Tailwind class rewrite → inline-style
     *  splice → agent fallback (`needsAgent`, like prop editing). */
    apply: (root: string, edit: StyleEdit) => Promise<StyleEditResult>
    /** Live scrub override — inject `prop: value` inline on the selected element
     *  (the preload stashes the original for exact revert). Fire-and-forget. */
    preview: (prop: string, value: string) => void
    /** Revert live override(s) exactly — one prop, or all when omitted. */
    clearPreview: (prop?: string) => void
    /** Fresh computed values for `props` from the current selection (pick-time
     *  snapshots go stale). Null when the selection is gone (navigation /
     *  element removed), there's no preview, or the read timed out. */
    read: (props: string[]) => Promise<Record<string, string> | null>
    /** Replay a transition on the selected element: jump to `from` with
     *  transitions disabled, force reflow, then set `to` so it animates. */
    replay: (prop: string, from: string, to: string) => void
  }
  /** AI-surfaced custom-control panels (v10) — manifests persisted by main in
   *  the repo's `.praxis/control-panels.json`, values resolved fresh per read. */
  controls: {
    /** Panels matching the selection's candidate files (two-stamp match), with
     *  every param's value freshly resolved against the live tree. */
    get: (root: string, q: { files: string[]; component?: string }) => Promise<ResolvedControlPanel[]>
    /** Every stored panel for the repo (unresolved manifests). */
    list: (root: string) => Promise<ControlPanelManifest[]>
    /** Delete a panel by id ("Remove panel"). */
    remove: (root: string, id: string) => Promise<void>
    /** Apply a value to a literal-strategy param — main re-anchors, lexes and
     *  renders the replacement itself (never splices a supplied string raw). */
    applyLiteral: (
      root: string,
      panelId: string,
      paramId: string,
      value: string | number | boolean
    ) => Promise<StyleEditResult>
    /** Fires when the agent's `define_controls` tool saved a manifest — App
     *  re-fetches and re-pushes panel state for that root. */
    onUpdated: (cb: (root: string) => void) => () => void
  }
  source: {
    /** Resolve a component tag name to its defining file via imports (Cmd+click). */
    resolveComponent: (root: string, fromFile: string, name: string) => Promise<string | null>
    /** Read the stamped element's source file for the inspector's code peek. */
    read: (root: string, source: string) => Promise<SourceView | null>
    /** Jump to the stamp in the user's editor (code/cursor/zed/subl CLI → OS default app). */
    openInEditor: (root: string, source: string) => Promise<{ ok: boolean; error?: string }>
    /** Save the whole file from the v9 code drawer. Refuses if disk drifted from
     *  `baseline` (the content the drawer loaded); routes through commitEdit so
     *  undo/redo + HMR just work. */
    write: (
      root: string,
      source: string,
      baseline: string,
      content: string
    ) => Promise<SourceWriteResult>
    /** Pop the code drawer out into its own resizable window showing `source`.
     *  Focuses the existing window if one is already open for this root. */
    popout: (root: string, source: string) => Promise<void>
    /** Close the standalone editor window (called from inside a popped-out editor). */
    closeWindow: () => Promise<void>
    /** Repo-relative file paths for the pop-out editor's file-tree sidebar. */
    tree: (root: string) => Promise<string[]>
    /** Standalone editor window: retarget event when a second pop-out reuses it. */
    onNavigate: (cb: (source: string) => void) => () => void
  }
  /** Undo/redo over ALL direct praxis source edits — props, text, token swaps (v8 F3b).
   *  Scoped per project root: the rail keeps several projects open at once. */
  edits: {
    undo: (root: string) => Promise<UndoResult>
    redo: (root: string) => Promise<UndoResult>
    can: (root: string) => Promise<{ undo: boolean; redo: boolean }>
    /** Per-turn chat revert: restore the pre-turn files of the recorded group
     *  `chat:<wtId>:<turnNo>` (addressable, not stack-order). `conflict` when a file
     *  drifted since (a later turn or hand edit touched it). */
    revert: (root: string, group: string) => Promise<UndoResult>
    /** Is that group still safely revertable right now (on the stack, no file drifted)?
     *  A cheap pre-check for greying out the Revert button. */
    canRevert: (root: string, group: string) => Promise<boolean>
  }
  tokens: {
    /** Detect design tokens in the repo (manifest → tailwind → CSS vars). */
    detect: (root: string) => Promise<TokenSet>
    /** Write a starter `.praxis/tokens.json` (idempotent — skips if one exists). */
    scaffold: (root: string) => Promise<TokenScaffoldResult>
  }
  annotations: {
    list: (root: string) => Promise<Annotation[]>
    add: (root: string, input: AnnotationInput) => Promise<Annotation[]>
    remove: (root: string, id: string) => Promise<Annotation[]>
    /** Fires when the user clicks an annotation pin in the preview. */
    onPinClick: (cb: (id: string) => void) => () => void
  }
  publish: {
    /** Create a branch + GitHub PR with the annotations; returns the PR URL. */
    toPr: (root: string, opts: { title: string }) => Promise<PublishResult>
    /** Full ship: commit all → push → PR → squash-merge to the default branch →
     *  pull it → delete the merged branch → start a fresh praxis/* branch. */
    ship: (root: string, summary?: string[], mode?: 'merge' | 'pr') => Promise<PublishResult>
  }
  github: {
    /** GitHub link + gh readiness for the header + connect sheet. */
    status: (root: string) => Promise<GithubStatus>
    /** First-publish bridge: create the repo, wire origin, push the built work. */
    connect: (root: string, opts: GithubConnectOptions) => Promise<GithubConnectResult>
  }
  setup: {
    /** Read-only: detect the UI framework + whether praxis can instrument it (no writes). */
    detect: (root: string) => Promise<SetupProbe>
    /** Write the dev-only source-stamping plugin into the repo (deterministic). */
    scaffold: (root: string) => Promise<SetupResult>
    /** Remove praxis's scaffold files from the repo (the .praxis helpers + legacy root plugin). */
    uninstall: (root: string) => Promise<SetupResult>
  }
  agent: {
    openProject: (root: string, options?: AgentOptions) => Promise<void>
    /** Close a project's agent session (single-active teardown / rail close). */
    closeProject: (root: string) => Promise<void>
    /**
     * Make an already-open project's session the active one (rail switch). Without
     * `sessionKey`, restores whichever of the project's own sessions (default, or
     * an additional/resumed chat) was last active. Pass `sessionKey` to select a
     * SPECIFIC one of that project's already-live sessions directly (v9 multi-chat
     * switcher) — it's a no-op unless that session is already live.
     */
    setActive: (root: string, sessionKey?: string) => Promise<void>
    /** Does this project still have a live session? (LRU may have suspended it) */
    isOpen: (root: string) => Promise<boolean>
    /**
     * Start an ADDITIONAL fresh session for a project that already has one open
     * (v9 resume/multi-chat) — unlike `openProject`, the existing session is left
     * running. Returns the new session's key (`${projectKey}#…`) and makes it the
     * project's active session.
     */
    newChat: (
      root: string,
      options?: AgentOptions
    ) => Promise<{ ok: boolean; sessionKey?: string; error?: string }>
    /** Restart one live chat with startup-only options (such as a Codex model)
     * without touching any of its sibling chats. */
    restartChat: (
      root: string,
      sessionKey: string,
      options?: AgentOptions
    ) => Promise<{ ok: boolean; error?: string }>
    /**
     * Resume a past ("previous agent") session by its history record id — requires
     * the record to carry a Claude `sdkSessionId` (else `ok:false`). Starts a live
     * session with the SDK's `resume` option, registers it under a new sessionKey,
     * and makes it the project's active session.
     */
    resumeSession: (
      root: string,
      recordId: string
    ) => Promise<{ ok: boolean; sessionKey?: string; error?: string }>
    /**
     * Close ONE of a project's live chats (v9 multi-chat) — tears down just that
     * `sessionKey`'s session (persisting it to history like any teardown), leaving
     * the project and its other chats untouched. Returns the project's remaining
     * live sessionKeys and whichever one is now active (`null` if none remain, so
     * the caller closes the project). A no-op-safe call if the key isn't live.
     */
    closeChat: (
      root: string,
      sessionKey: string
    ) => Promise<{ ok: boolean; remaining: string[]; activeSessionKey: string | null }>
    send: (text: string, images?: ImageAttachment[]) => Promise<void>
    setModel: (model: string) => Promise<void>
    /** Change the permission posture live (drives the SDK's setPermissionMode). */
    setPermissionMode: (mode: PermissionMode) => Promise<void>
    /** Answer a pending approve/deny card. */
    respondPermission: (id: string, behavior: 'allow' | 'deny') => Promise<void>
    /** Answer a pending agent question (AskUserQuestion). `answers` maps each
     *  question's text to the chosen option label(s); `null` dismisses it. */
    respondQuestion: (id: string, answers: QuestionAnswers | null) => Promise<void>
    interrupt: () => Promise<void>
    /** Tag the live session with branch / PR metadata for its history record. */
    tagSession: (root: string, tag: { branch?: string; prUrl?: string }) => Promise<void>
    /** Spawn a detached comment agent in its own git worktree (v8 F1) — runs in the
     *  background without touching the active chat. Returns `ok:false` (with a reason)
     *  when the project isn't a git repo root, so the caller can fall back to chat. */
    spawnComment: (
      root: string,
      text: string,
      options?: AgentOptions
    ) => Promise<{ ok: boolean; spawnId?: string; branch?: string; queued?: boolean; reason?: string }>
    /** F1 Phase 3 — cancel a running or queued comment spawn (the rail row's ×). */
    spawnInterrupt: (spawnId: string) => Promise<void>
    /** F1 Phase 2 — apply a finished spawn's branch diff onto the live working tree
     *  (the dev server HMRs it). `conflict` when the patch overlapped local edits. */
    spawnApply: (root: string, branch: string) => Promise<{ ok: boolean; conflict?: boolean; error?: string }>
    /** F1 Phase 2 — delete a finished spawn's branch (Discard). */
    spawnDiscard: (root: string, branch: string) => Promise<{ ok: boolean }>
    /** F1 Phase 2 — push a finished spawn's branch + open a PR from it. */
    spawnPr: (
      root: string,
      branch: string,
      title: string,
      recordId: string
    ) => Promise<{ ok: boolean; prUrl?: string; error?: string }>
    /** v9 conflict card — "Resolve it" on the ACTIVE parked chat. Stages the worktree
     *  with both sides 3-way merged; `conflicted` lists the files with real overlap and
     *  `prompt` is the resolution turn the renderer should `send`. An empty `conflicted`
     *  means the sides merged cleanly and were already applied (no turn to run). */
    resolveConflict: () => Promise<{ ok: boolean; conflicted: string[]; prompt?: string; error?: string }>
    /** v9 conflict card — "Discard changes" on the ACTIVE parked chat (drop its work). */
    discardConflict: () => Promise<{ ok: boolean }>
    onEvent: (cb: (event: AgentEvent) => void) => () => void
    /** Everything still live in main (open projects, their live chats + in-progress
     *  transcripts) — used to reattach the renderer after a reload without tearing
     *  down any session. Read-only: never suspends/starts/closes anything. */
    workspaceSnapshot: () => Promise<WorkspaceSnapshot>
  }
  /** Persisted agent-session history ("previous agents") — v5-D. */
  sessions: {
    /** Past sessions for a project, newest first (excludes the live one). */
    list: (root: string) => Promise<SessionRecord[]>
    get: (id: string) => Promise<SessionRecord | null>
    remove: (id: string) => Promise<void>
  }
  /** In-app feedback → a GitHub issue on Praxis's own repo (LKM-27). */
  feedback: {
    /** Snapshot the app window as a downscaled data URL, for the opt-in screenshot. */
    capture: () => Promise<string | null>
    /** Post the feedback (with any opted-in attachments) as a GitHub issue. */
    submit: (input: FeedbackInput) => Promise<FeedbackResult>
  }
  /** Praxis self-update: check the git remote and apply an update in place. */
  update: {
    /** Subscribe to update-status pushes (startup check, periodic, and apply progress). */
    onStatus: (cb: (status: UpdateStatus) => void) => () => void
    /** Force an immediate check against the remote. */
    check: () => Promise<UpdateStatus>
    /** Run `praxis --update` (pull + install + build) and relaunch on success. */
    apply: () => Promise<void>
  }
}
