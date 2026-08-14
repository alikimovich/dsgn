import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { BrowserWindow } from 'electron'
import { z } from 'zod'
import type {
  AgentEvent,
  AgentOptions,
  ImageAttachment,
  PermissionRequest,
  QuestionAnswers,
  QuestionRequest,
  QuestionSpec,
  SessionTranscriptEntry,
  SlashCommandItem
} from '../../shared/api'
import { projectKey } from '../../shared/projectKey'
import { addUsage, emptyUsage, isEmptyUsage, readUsage, usageDelta } from '../../shared/run-stats'
import { checkContrast, suggestAccessible } from '../apca'
import { lexLiteral, locateAnchor, validateManifest } from '../control-manifest'
import { saveManifest } from '../control-panels'
import { fluidClamp, fluidScale } from '../fluid'
import { recordClaudeModels } from '../model-catalog'
import { oklchScale } from '../oklch'
import { capturePreview, getPreviewUrl } from '../preview-state'
import { praxisRules } from '../rules'
import { elevationScale, layeredShadow } from '../shadows'
import { findPack, SKILL_PACKS } from '../skill-packs'
import { discoverProjectSkills, mergeSlashCommands } from '../skills'
import { installSkillPack } from '../skills-install'
import {
  analyze,
  fromBounceDuration,
  fromRatioFreq,
  PRESETS,
  type SpringConfig,
  springToCss,
  toCssVars,
  toKeyframes,
  toTransition
} from '../spring'
import { letterSpacing, lineHeight } from '../type-metrics'
import { interruptWithEscalation } from './interrupt'
import { createRecordCapture } from './record'
import { sanitizeTitle, transcriptDigest } from './title'
import { AUTO_ALLOW_TOOLS, describeTool, sendToRenderer, toolDetail, touchesSidecar } from './tools'
import type {
  ModelProvider,
  PendingPrompt,
  PendingQuestion,
  ProviderSession,
  SpawnContext
} from './types'

// The bundled Praxis agent plugin (skills teaching the preview workflow). Lives
// at the repo root; resolved relative to the compiled main (out/main →
// ../../agent-plugin), the same walk as index.ts's appIcon. Only wired in when
// present so a stripped build degrades gracefully instead of erroring.
const PLUGIN_PATH = join(__dirname, '../../agent-plugin')

/**
 * How long Stop waits for the SDK's graceful `interrupt()` before killing the
 * query outright. Generous enough that a merely BUSY subprocess (mid tool call,
 * flushing a long response) still gets to stop cleanly and keep its session, but
 * short enough that a wedged one doesn't leave the user staring at a dead button.
 */
const INTERRUPT_GRACE_MS = 3_000

// The two in-process `praxis` MCP tools, fully-qualified (mcp__<server>__<tool>).
// Read-only observers of the user's preview — auto-allowed so they never prompt.
const PREVIEW_TOOL_NAMES = new Set([
  'mcp__praxis__preview_location',
  'mcp__praxis__preview_screenshot'
])
// All in-process `praxis` tools — the observers above plus `define_controls`
// (v10 Custom Controls). define_controls DOES persist state, but only through
// main's own validated `saveManifest` path (main stays the sole `.praxis/`
// writer), so it's equally safe to auto-allow: allowedTools + the canUseTool
// short-circuit both use this set.
const PRAXIS_TOOL_NAMES = new Set([
  ...PREVIEW_TOOL_NAMES,
  'mcp__praxis__define_controls',
  // Pure, deterministic spring→CSS calculator. No state, no side effects, so
  // it's auto-allowed like the observers — it never touches disk or the repo.
  'mcp__praxis__spring_to_css',
  // APCA accessible-contrast checker + color suggester. Also pure (reads no repo
  // state, writes nothing) — auto-allowed for the same reason.
  'mcp__praxis__check_contrast',
  // Design-system calculators (fluid clamp() sizing, OKLCH color ramps, layered
  // shadows, size-aware line-height). All pure math — no state, no disk — so
  // auto-allowed like the rest.
  'mcp__praxis__fluid_clamp',
  'mcp__praxis__color_scale',
  'mcp__praxis__layered_shadow',
  'mcp__praxis__line_height',
  // Lists the curated skill-pack catalog — pure/read-only (no install, no
  // network), so auto-allowed. Its sibling `install_skills` is deliberately NOT
  // here: it writes files + hits the network, so it must surface a permission card.
  'mcp__praxis__list_recommended_skills'
])

// `define_controls` input — ControlPanelManifest minus `id`/`createdAt` (main
// assigns those). The SDK converts this zod shape to JSON Schema over MCP, so
// the model sees the exact manifest schema without any prompt bloat. Structural
// security limits live in validateManifest (control-manifest.ts) — the shape
// here stays permissive-but-typed and every input re-runs the real validator.
const defineControlsShape = {
  manifest: z.object({
    file: z.string().describe('Repo-relative path of the source file the params live in'),
    component: z.string().describe('The component the panel targets (its exported name)'),
    title: z.string().describe('Panel heading shown to the user (≤80 chars)'),
    params: z
      .array(
        z.object({
          id: z.string().describe('Stable id, unique in the panel: ^[a-z0-9][a-z0-9-]{0,40}$'),
          label: z.string().describe('Human label rendered next to the control (≤80 chars)'),
          kind: z.enum(['number', 'color', 'select', 'toggle', 'text', 'bezier']),
          unit: z.string().optional().describe("Display unit for kind 'number', e.g. 'px' | 'ms'"),
          min: z.number().optional().describe("Clamp minimum (kind 'number' only)"),
          max: z.number().optional().describe("Clamp maximum (kind 'number' only)"),
          step: z.number().optional().describe("Scrub increment (kind 'number' only)"),
          options: z
            .array(z.string())
            .optional()
            .describe("Allowed values (kind 'select' only, 1-20 entries)"),
          apply: z
            .discriminatedUnion('strategy', [
              z.object({
                strategy: z.literal('prop'),
                propName: z.string().describe('Component prop to edit (per-instance values)')
              }),
              z.object({
                strategy: z.literal('style'),
                styleProp: z
                  .string()
                  .describe("CSS longhand routed through the Styles engine, e.g. 'border-radius'")
              }),
              z.object({
                strategy: z.literal('literal'),
                anchor: z
                  .string()
                  .describe(
                    'Unique substring of the file (4-200 chars) ending immediately before the ' +
                      "literal to edit — ideal shape: 'const STAGGER_MS = '. Must occur exactly once."
                  )
              })
            ])
            .describe('How the param writes back to source')
        })
      )
      .min(1)
      .max(12)
  })
}

// `spring_to_css` input — three interchangeable ways to describe the spring
// (physical, ζ/frequency, or Framer-style bounce/duration) plus a preset shortcut
// and output-shape knobs. Pure calculation: the SDK turns this zod shape into
// JSON Schema so the model sees every field without prompt bloat.
const springToCssShape = {
  stiffness: z
    .number()
    .positive()
    .optional()
    .describe('Physical spring: spring constant k (>0). Pair with damping.'),
  damping: z
    .number()
    .min(0)
    .optional()
    .describe('Physical spring: damping coefficient c (>=0). Pair with stiffness.'),
  mass: z
    .number()
    .positive()
    .optional()
    .describe('Mass m (>0). Default 1. Applies to all input modes.'),
  dampingRatio: z
    .number()
    .positive()
    .optional()
    .describe('ζ: <1 bounces, 1 critical, >1 overdamped. Pair with frequencyHz.'),
  frequencyHz: z
    .number()
    .positive()
    .optional()
    .describe('Natural frequency in Hz. Pair with dampingRatio.'),
  bounce: z
    .number()
    .optional()
    .describe('Framer-style bounciness (~0–1; higher = bouncier). Pair with durationMs.'),
  durationMs: z
    .number()
    .positive()
    .optional()
    .describe('Framer-style target settle duration (ms). Pair with bounce.'),
  preset: z
    .string()
    .optional()
    .describe(`Named preset instead of raw params. One of: ${Object.keys(PRESETS).join(', ')}.`),
  property: z.string().optional().describe("CSS property the motion drives. Default 'transform'."),
  format: z
    .enum(['transition', 'linear', 'css-vars', 'keyframes', 'json'])
    .optional()
    .describe("Output shape. Default 'transition' (property + duration + linear())."),
  simplify: z
    .number()
    .optional()
    .describe(
      'RDP tolerance (e.g. 0.001) to trim control points on long curves. Omit for full resolution.'
    )
}

/** Resolve the spring config from whichever of the three input modes was given. */
function resolveSpringConfig(a: {
  stiffness?: number
  damping?: number
  mass?: number
  dampingRatio?: number
  frequencyHz?: number
  bounce?: number
  durationMs?: number
  preset?: string
}): SpringConfig | { error: string } {
  const mass = a.mass ?? 1
  if (a.preset !== undefined) {
    const cfg = PRESETS[a.preset]
    if (!cfg)
      return {
        error: `unknown preset "${a.preset}". Choose one of: ${Object.keys(PRESETS).join(', ')}.`
      }
    return cfg
  }
  if (a.stiffness !== undefined || a.damping !== undefined) {
    if (a.stiffness === undefined || a.damping === undefined) {
      return { error: 'stiffness and damping must be given together.' }
    }
    return { stiffness: a.stiffness, damping: a.damping, mass }
  }
  if (a.dampingRatio !== undefined || a.frequencyHz !== undefined) {
    if (a.dampingRatio === undefined || a.frequencyHz === undefined) {
      return { error: 'dampingRatio and frequencyHz must be given together.' }
    }
    return fromRatioFreq(a.dampingRatio, a.frequencyHz, mass)
  }
  if (a.bounce !== undefined || a.durationMs !== undefined) {
    if (a.bounce === undefined || a.durationMs === undefined) {
      return { error: 'bounce and durationMs must be given together.' }
    }
    return fromBounceDuration(a.bounce, a.durationMs, mass)
  }
  return {
    error:
      'no spring given. Provide one of: stiffness+damping, dampingRatio+frequencyHz, bounce+durationMs, or preset.'
  }
}

// `check_contrast` input — a color pair plus text context, and how to suggest an
// accessible alternative when it fails. Pure calculation over the APCA reference
// tables (apca.ts); the SDK turns this zod shape into JSON Schema for the model.
const checkContrastShape = {
  foreground: z.string().describe('Text/foreground color: hex, rgb(), hsl(), or CSS color name.'),
  background: z.string().describe('Background color (same formats).'),
  fontSizePx: z.number().positive().optional().describe('Text size in px. Default 16.'),
  fontWeight: z
    .number()
    .optional()
    .describe('Font weight 100–900 (snapped to nearest 100). Default 400.'),
  wcag2: z
    .boolean()
    .optional()
    .describe('Also report the legacy WCAG 2 ratio (AA/AAA). Default false.'),
  suggest: z
    .enum(['auto', 'foreground', 'background', 'none'])
    .optional()
    .describe(
      "When/what to suggest an accessible alternative for, preserving hue: 'auto' (default) suggests a " +
        "new foreground only if the pair fails; 'foreground'/'background' force a suggestion for that color; " +
        "'none' skips it."
    )
}

// `fluid_clamp` input — a single fluid value (minPx+maxPx) or a whole modular
// scale. Viewport/root knobs are shared. Pure Utopia math (fluid.ts).
const fluidClampShape = {
  minPx: z
    .number()
    .positive()
    .optional()
    .describe('Size in px at the min viewport (single-value mode). Pair with maxPx.'),
  maxPx: z
    .number()
    .positive()
    .optional()
    .describe('Size in px at the max viewport (single-value mode). Pair with minPx.'),
  scale: z
    .object({
      baseMinPx: z.number().positive().describe('Base step size (px) at the min viewport.'),
      baseMaxPx: z.number().positive().describe('Base step size (px) at the max viewport.'),
      ratioMin: z
        .number()
        .positive()
        .optional()
        .describe('Modular ratio at the min viewport (default 1.2 — tighter on mobile).'),
      ratioMax: z
        .number()
        .positive()
        .optional()
        .describe('Modular ratio at the max viewport (default 1.25).'),
      stepsUp: z.number().int().optional().describe('Steps above base (default 5).'),
      stepsDown: z.number().int().optional().describe('Steps below base (default 2).')
    })
    .optional()
    .describe('Generate a whole fluid type/space scale instead of a single value.'),
  minViewportPx: z
    .number()
    .positive()
    .optional()
    .describe('Viewport where the min size applies (default 320).'),
  maxViewportPx: z
    .number()
    .positive()
    .optional()
    .describe('Viewport where the max size applies (default 1280).'),
  rootPx: z
    .number()
    .positive()
    .optional()
    .describe('Root font size for rem conversion (default 16).'),
  format: z
    .enum(['value', 'css-vars'])
    .optional()
    .describe(
      "Output shape. 'value' (default) = raw clamp() strings; 'css-vars' = a --step-* custom-property block."
    )
}

// `color_scale` input — an OKLCH perceptual tonal ramp from a seed color (oklch.ts).
const colorScaleShape = {
  seed: z.string().describe('Seed color (hex) to build the ramp around.'),
  steps: z
    .number()
    .int()
    .optional()
    .describe('Number of steps (default 12; step 1 = lightest, N = darkest).'),
  hueShift: z.number().optional().describe('Degrees to rotate the hue from the seed (default 0).'),
  lightnessRange: z
    .tuple([z.number(), z.number()])
    .optional()
    .describe('[darkestL, lightestL] in OKLCH lightness 0..1 (default [0.18, 0.98]).'),
  format: z
    .enum(['hex-list', 'css-vars', 'tailwind'])
    .optional()
    .describe("Output shape (default 'hex-list')."),
  name: z
    .string()
    .optional()
    .describe("Token name prefix for css-vars/tailwind output (default 'color').")
}

// `layered_shadow` input — one elevation shadow or a whole elevation scale (shadows.ts).
const layeredShadowShape = {
  elevation: z
    .number()
    .optional()
    .describe('Logical lift (0 = flush, larger = more raised, ~0..24). Single-shadow mode.'),
  scale: z
    .boolean()
    .optional()
    .describe('Generate a whole elevation scale instead of a single shadow.'),
  levels: z
    .number()
    .int()
    .optional()
    .describe('Number of elevation tokens when scale=true (default 5).'),
  layers: z.number().int().optional().describe('Stacked box-shadow layers per shadow (default 5).'),
  lightAngleDeg: z
    .number()
    .optional()
    .describe('Direction light comes from (default 180 = top → shadow cast downward).'),
  colorRgb: z
    .tuple([z.number(), z.number(), z.number()])
    .optional()
    .describe('Shadow color as RGB 0-255 (default [0,0,0]).'),
  baseAlpha: z
    .number()
    .positive()
    .optional()
    .describe('Opacity of the closest (tightest) layer (default 0.12).'),
  format: z
    .enum(['value', 'css-vars'])
    .optional()
    .describe("Output shape. 'value' (default) or a --shadow-* custom-property block.")
}

// `line_height` input — a font size plus optional measure/role and output knobs.
// Pure type-metrics math (type-metrics.ts): size-aware, WCAG-floored leading and
// (optional) Material-3 tracking. The SDK turns this zod shape into JSON Schema.
const lineHeightShape = {
  fontSizePx: z.number().positive().describe('Font size in px to compute leading for.'),
  measureCh: z
    .number()
    .positive()
    .optional()
    .describe(
      'Line length in characters (measure). Longer lines get a touch more leading (~66ch ideal).'
    ),
  role: z
    .enum(['auto', 'body', 'heading', 'display'])
    .optional()
    .describe(
      "Type role (default 'auto' = inferred from size). Sets the WCAG floor: 'body' is floored at 1.5; 'heading'/'display' may sit tighter."
    ),
  includeTracking: z
    .boolean()
    .optional()
    .describe('Also return a recommended letter-spacing (tracking) for this size.'),
  format: z
    .enum(['value', 'css'])
    .optional()
    .describe(
      "Output shape. 'value' (default) = the unitless line-height number; 'css' = a `line-height: <n>;` declaration (plus `letter-spacing` when includeTracking)."
    )
}

/** Panel id assigned by main: component slug + a short hash of file+component,
 *  matching validateManifest's `^[a-z0-9][a-z0-9-]{0,40}$` by construction. */
function panelId(file: string, component: string): string {
  const slug =
    component
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'panel'
  const hash = createHash('sha1').update(`${file}:${component}`).digest('hex').slice(0, 6)
  return `${slug}-${hash}`
}

// The Agent SDK is ESM-only; this CJS main bundle must reach it via a dynamic
// import() (preserved by Rollup for external deps) rather than a static require.
type SdkModule = typeof import('@anthropic-ai/claude-agent-sdk')
let sdkPromise: Promise<SdkModule> | null = null
const loadSdk = (): Promise<SdkModule> => (sdkPromise ??= import('@anthropic-ai/claude-agent-sdk'))

/** A push-driven async queue of user messages for the SDK's streaming input. */
class InputStream implements AsyncIterable<SDKUserMessage> {
  private buffer: SDKUserMessage[] = []
  private waiting: ((r: IteratorResult<SDKUserMessage>) => void)[] = []
  private closed = false

  push(text: string, images?: ImageAttachment[]): void {
    // Plain string when there are no images; otherwise a content-block array so the
    // Claude Agent SDK sees the text + each pasted/dropped image as a vision block.
    const content =
      images && images.length
        ? [
            ...(text ? [{ type: 'text', text }] : []),
            ...images.map((im) => ({
              type: 'image',
              source: { type: 'base64', media_type: im.mediaType, data: im.data }
            }))
          ]
        : text
    const msg = {
      type: 'user',
      message: { role: 'user', content }
    } as unknown as SDKUserMessage
    const next = this.waiting.shift()
    if (next) next({ value: msg, done: false })
    else this.buffer.push(msg)
  }

  close(): void {
    this.closed = true
    let r: ((res: IteratorResult<SDKUserMessage>) => void) | undefined
    while ((r = this.waiting.shift())) r({ value: undefined as never, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        const buffered = this.buffer.shift()
        if (buffered) return Promise.resolve({ value: buffered, done: false })
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((resolve) => this.waiting.push(resolve))
      }
    }
  }
}

/** Pull a text delta out of a streaming partial-message event, shape-tolerant. */
function textDelta(msg: unknown): string | null {
  const event = (msg as { event?: { type?: string; delta?: { type?: string; text?: string } } })
    .event
  if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
    return event.delta.text ?? null
  }
  return null
}

/**
 * Coerce the AskUserQuestion tool input into our `QuestionSpec[]`, tolerating the
 * SDK's loosely-typed payload. Returns [] when nothing usable is present (the
 * caller then lets the tool fall through rather than showing an empty card).
 */
function parseQuestions(input: unknown): QuestionSpec[] {
  const raw = (input as { questions?: unknown })?.questions
  if (!Array.isArray(raw)) return []
  const out: QuestionSpec[] = []
  for (const q of raw) {
    const question =
      typeof (q as { question?: unknown })?.question === 'string'
        ? (q as { question: string }).question
        : ''
    const options = Array.isArray((q as { options?: unknown })?.options)
      ? (q as { options: unknown[] }).options
          .map((o) => ({
            label:
              typeof (o as { label?: unknown })?.label === 'string'
                ? (o as { label: string }).label
                : '',
            ...(typeof (o as { description?: unknown })?.description === 'string'
              ? { description: (o as { description: string }).description }
              : {})
          }))
          .filter((o) => o.label)
      : []
    if (!question || options.length === 0) continue
    out.push({
      question,
      header:
        typeof (q as { header?: unknown })?.header === 'string' && (q as { header: string }).header
          ? (q as { header: string }).header
          : 'Question',
      options,
      multiSelect: (q as { multiSelect?: unknown })?.multiSelect === true
    })
  }
  return out
}

/**
 * Feed the user's picks back to the model as the AskUserQuestion tool result. We
 * DENY the tool with the answer as its message: in headless SDK mode there is no
 * built-in interactive prompt to run, so intercepting `canUseTool` and returning
 * the answer here keeps the whole exchange under praxis's control. The message is
 * phrased as an answer so the model continues with the user's choice in hand.
 */
function formatAnswers(questions: QuestionSpec[], answers: QuestionAnswers): string {
  const lines = questions.map((q) => {
    const a = (answers[q.question] ?? '').trim()
    return `- ${q.question}\n  → ${a || '(no answer)'}`
  })
  return `The user answered your question(s):\n${lines.join('\n')}`
}

/**
 * The incumbent backend: a persistent multi-turn Claude Agent SDK `query()` with
 * `cwd` = the opened repo, so the repo's CLAUDE.md + .claude/skills are discovered
 * (`settingSources`). Auth = the user's Claude subscription (`claude login` /
 * `setup-token`). This is the verbatim pre-v7 `startSession`, now behind the
 * `ModelProvider` seam.
 */
async function startSession(
  root: string,
  options: AgentOptions,
  getWindow: () => BrowserWindow | null,
  ctx?: SpawnContext
): Promise<ProviderSession> {
  const key = projectKey(root)
  // A detached comment spawn (v8 F1) files its events + history under the PARENT
  // project's key (so the rail/history surface it), and stamps `sessionId` so the
  // renderer keeps it out of the main chat stream.
  const emitKey = ctx?.emitKey ?? key
  // The persisted record's `projectKey` must stay the canonical project key (not
  // `emitKey`) — `sessions-store.ts#list` and `agent:sessions-list` always query by
  // the plain `projectKey(root)`, so an additional/resumed chat (whose `emitKey` is
  // `${key}#…`) would otherwise get a history record no rail lookup can ever find.
  const cap = createRecordCapture(root, key)
  const { query, createSdkMcpServer, tool } = await loadSdk()
  const input = new InputStream()
  const abort = new AbortController()
  const pending = new Map<string, PendingPrompt>()
  const pendingQuestions = new Map<string, PendingQuestion>()
  // Per-session: disposed when replaced/closed; namespaces fallback permission ids.
  let disposed = false
  // Set when `interrupt` had to force-stop a wedged query. The abort makes the
  // reader loop throw rather than reach a `result`, but a graceful interrupt that
  // lands just AFTER the grace window could still deliver one — and the seam
  // promises exactly one `done` per turn, which the escalation has already sent.
  let hardStopped = false
  let permCounter = 0

  const emit = (event: AgentEvent): void => {
    if (disposed) return
    const tagged = {
      ...event,
      projectKey: emitKey,
      ...(ctx?.sessionId ? { sessionId: ctx.sessionId } : {})
    }
    // agent.ts watches this in-process hook for a spawn's terminal done/error, and
    // (v9) an interactive session's for workspace-snapshot isRunning tracking.
    ctx?.onEvent?.(tagged)
    sendToRenderer(getWindow, 'agent:event', tagged)
  }

  // In-process SDK MCP server bundling Praxis's own agent tools: read-only views
  // of the user's live preview (the native WebContentsView that index.ts owns,
  // reached via the preview-state registry) which OBSERVE what the user sees
  // (agent-browser is the agent's own headless copy for interaction),
  // define_controls (v10 Custom Controls), a family of pure design-system
  // calculators — spring_to_css, check_contrast, fluid_clamp, color_scale,
  // layered_shadow, line_height — and the skill-pack tools (list_recommended_skills
  // pure; install_skills side-effecting). The observers, calculators and
  // list_recommended_skills are auto-allowed (see allowedTools + canUseTool) so they
  // never prompt — all are side-effect-free, and define_controls persists only
  // through main's validated saveManifest path. install_skills is NOT auto-allowed:
  // it writes files + hits the network, so it surfaces a normal permission card.
  const previewServer = createSdkMcpServer({
    name: 'praxis',
    version: '1.0.0',
    tools: [
      tool(
        'preview_location',
        "The page/route currently shown in the user's live preview pane.",
        {},
        async () => {
          const url = getPreviewUrl()
          if (!url) return { content: [{ type: 'text', text: 'No project preview is open.' }] }
          let text = `The preview is currently showing ${url}.`
          try {
            const u = new URL(url)
            text += ` (path: ${u.pathname}${u.search}${u.hash})`
          } catch {
            /* non-parseable URL — the full string above is enough */
          }
          return { content: [{ type: 'text', text }] }
        }
      ),
      tool(
        'preview_screenshot',
        'A screenshot of exactly what the user sees in their preview pane right now (their route, viewport, simulator included).',
        {},
        async () => {
          const img = await capturePreview()
          if (!img || img.isEmpty()) {
            return { content: [{ type: 'text', text: 'No project preview is open.' }] }
          }
          // Downscale like feedback.ts's captureWindow so the base64 payload
          // stays reasonable; 1200px keeps UI legible for verification.
          const { width } = img.getSize()
          const scaled = width > 1200 ? img.resize({ width: 1200 }) : img
          const jpeg = scaled.toJPEG(70)
          return {
            content: [{ type: 'image', data: jpeg.toString('base64'), mimeType: 'image/jpeg' }]
          }
        }
      ),
      // v10 Custom Controls: register an AI-surfaced control panel. The manifest
      // is UNTRUSTED — main re-validates structure, checks every literal anchor
      // against the file the agent just wrote (this session's cwd, which may be
      // a per-chat worktree), and persists to the LIVE root (ctx.liveRoot) so
      // the panel isn't stranded when the worktree merges/drops. Failures come
      // back as tool-result text (never a throw) so the model can fix + retry.
      tool(
        'define_controls',
        'Register a control panel of tweakable parameters (sliders, color pickers, toggles) ' +
          'for a component, after instrumenting its source so each parameter is a clean ' +
          'target: a named top-level constant in the component file (literal strategy), a ' +
          'typed prop with a literal default (prop strategy), or a CSS property (style ' +
          'strategy). The user tweaks these live in the Praxis island.',
        defineControlsShape,
        async (args) => {
          const fail = (text: string) => ({
            content: [{ type: 'text' as const, text: `define_controls failed: ${text}` }],
            isError: true
          })
          const input = args.manifest
          // Main assigns identity; the model never picks ids or timestamps.
          const manifest = validateManifest({
            ...input,
            id: panelId(input.file, input.component),
            createdAt: new Date().toISOString()
          })
          if ('error' in manifest) return fail(manifest.error)
          // Anchor check against THIS session's tree (the worktree, where the
          // agent just wrote) — the live tree may not have the constant yet.
          let code: string
          try {
            code = await readFile(join(root, manifest.file), 'utf8')
          } catch {
            return fail(`could not read ${manifest.file} — does the file exist?`)
          }
          for (const param of manifest.params) {
            if (param.apply.strategy !== 'literal') continue
            const loc = locateAnchor(code, param.apply.anchor)
            if ('error' in loc) {
              const why =
                loc.error === 'missing'
                  ? 'does not occur in the file'
                  : 'occurs more than once (must be unique)'
              return fail(`param '${param.id}': anchor ${why}. Adjust the anchor or the code.`)
            }
            if (!lexLiteral(code, loc.at, param.kind)) {
              return fail(
                `param '${param.id}': no ${param.kind} literal immediately after the anchor. ` +
                  'The anchor must end right before the literal value.'
              )
            }
          }
          const saved = await saveManifest(ctx?.liveRoot ?? root, manifest)
          if ('error' in saved) return fail(saved.error)
          sendToRenderer(getWindow, 'controls:updated', { root: ctx?.liveRoot ?? root })
          const n = manifest.params.length
          return {
            content: [
              {
                type: 'text',
                text:
                  `Registered control panel "${manifest.title}" for ${manifest.component} ` +
                  `(${manifest.file}) with ${n} param${n === 1 ? '' : 's'}: ` +
                  `${manifest.params.map((p) => p.id).join(', ')}. ` +
                  'The user can now tweak them live from the Custom tab of the selection island.'
              }
            ]
          }
        }
      ),
      // Pure spring→CSS calculator. LLMs can't reliably integrate a spring in
      // their head, so this computes the EXACT `linear()` easing + duration the
      // agent should paste into the target repo's CSS. No state, no disk, no
      // side effects — deterministic function, auto-allowed like the observers.
      tool(
        'spring_to_css',
        'Compute a CSS `linear()` easing + duration from a physical spring, so a bouncy/springy ' +
          'motion runs on the compositor as a normal `transition`/`@keyframes` instead of a JS loop. ' +
          'Use this ANY time the user asks for a spring, bouncy, springy, or physics-based animation, ' +
          'or gives spring params (stiffness/damping/mass, ζ+frequency, or bounce+duration) — do NOT ' +
          'hand-write spring `linear()` values or guess a cubic-bezier. Returns exact values to paste ' +
          'into source. Note: only `transform` and `opacity` are compositor-cheap.',
        springToCssShape,
        async (args) => {
          const cfg = resolveSpringConfig(args)
          if ('error' in cfg) {
            return {
              content: [{ type: 'text' as const, text: `spring_to_css failed: ${cfg.error}` }],
              isError: true
            }
          }

          const opts = { simplify: args.simplify ?? 0, property: args.property }
          const m = analyze(cfg, opts)
          const p2 = (n: number): number => Number(n.toFixed(2))

          let out: string
          switch (args.format ?? 'transition') {
            case 'linear':
              out = springToCss(cfg, opts).easing
              break
            case 'css-vars':
              out = toCssVars(cfg, opts)
              break
            case 'keyframes':
              out = toKeyframes(cfg, {
                ...opts,
                prop: args.property ? `--${args.property}` : undefined
              })
              break
            case 'json':
              out = JSON.stringify(springToCss(cfg, opts), null, 2)
              break
            default:
              out = toTransition(cfg, opts)
          }

          const property = args.property ?? 'transform'
          const compositorSafe = property === 'transform' || property === 'opacity'
          const notes = [
            `ζ=${p2(m.dampingRatio)} (${m.regime}), ${p2(m.frequencyHz)}Hz, overshoot ${p2(m.overshoot * 100)}%`,
            `settle ${m.settleDuration}ms · visual ~${m.visualDuration}ms · ${m.pointCount} points`,
            compositorSafe
              ? `'${property}' is compositor-friendly.`
              : `Warning: '${property}' is NOT compositor-cheap (only transform/opacity are) — this runs on the main thread and can jank.`,
            'Wrap in @media (prefers-reduced-motion: reduce) to disable. Needs Chrome/Edge 113+, Firefox 112+, Safari 17.2+ (falls back to ease).'
          ]

          return {
            content: [{ type: 'text' as const, text: `${out}\n\n/* ${notes.join('\n   ')} */` }]
          }
        }
      ),
      // APCA (Lc) accessible-contrast checker + color suggester. APCA is the
      // perceptual model WCAG 3 is built around — don't eyeball readability or
      // use the old 4.5:1 ratio. When a pair fails, it hands back the nearest
      // accessible color (hue preserved) so the palette still matches. Pure
      // calc over the reference tables — no state, no disk, auto-allowed.
      tool(
        'check_contrast',
        'Check whether a foreground/background color pair is readable using APCA (Lc) — the perceptual ' +
          'contrast model WCAG 3 is built around, more accurate than WCAG 2. Use it whenever you pick, ' +
          'change, or review text/UI colors, or the user asks if a color pair is accessible/readable/legible. ' +
          'When the pair fails it also SUGGESTS the nearest accessible color (adjusting lightness, keeping ' +
          'hue) so the palette still matches — use that hex instead of guessing. Pass fontSizePx/fontWeight ' +
          'for accurate thresholds (APCA readability depends on text size + weight).',
        checkContrastShape,
        async (args) => {
          try {
            const res = await checkContrast({
              foreground: args.foreground,
              background: args.background,
              fontSizePx: args.fontSizePx,
              fontWeight: args.fontWeight,
              wcag2: args.wcag2
            })

            const badge =
              res.verdict === 'pass'
                ? '✓ PASS'
                : res.verdict === 'fail'
                  ? '✗ FAIL'
                  : `⚠ ${res.verdict.toUpperCase()}`
            const lines = [
              `${badge} — APCA Lc ${res.lc.toFixed(1)} for ${res.foreground} on ${res.background} at ${res.fontSizePx}px/${res.fontWeight}`,
              res.message
            ]
            if (res.wcag2) {
              lines.push(
                `WCAG 2: ${res.wcag2.ratioRounded}:1 — AA ${res.wcag2.AA}, AAA ${res.wcag2.AAA}, UI 3:1 ${res.wcag2.uiComponents}.`
              )
            }

            // Decide whether to suggest an accessible alternative.
            const mode = args.suggest ?? 'auto'
            const role: 'foreground' | 'background' | null =
              mode === 'foreground' || mode === 'background'
                ? mode
                : mode === 'auto' && res.verdict !== 'pass'
                  ? 'foreground'
                  : null
            if (role) {
              const adjust = role === 'foreground' ? args.foreground : args.background
              const fixed = role === 'foreground' ? args.background : args.foreground
              const s = await suggestAccessible(adjust, fixed, role, res.fontSizePx, res.fontWeight)
              lines.push(
                s.bestEffort
                  ? `Suggested ${role}: ${s.hex} (Lc ${s.lc.toFixed(1)}, ${s.verdict}) — closest to ${adjust} preserving hue, but no hue-preserving lightness fully passes at this size; increase font size/weight or shift the other color too.`
                  : `Suggested accessible ${role}: ${s.hex} (Lc ${s.lc.toFixed(1)}, passes) — nearest to ${adjust} preserving hue.`
              )
            }

            return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            return {
              content: [{ type: 'text' as const, text: `check_contrast failed: ${msg}` }],
              isError: true
            }
          }
        }
      ),
      // Fluid clamp() sizing. The middle `calc()` term of a fluid clamp() is a
      // two-point solve in mixed rem/vw units that LLMs get subtly wrong (the
      // size ends up off at real viewports). This computes it exactly and is
      // verified to hit both endpoints. Pure math — no state, auto-allowed.
      tool(
        'fluid_clamp',
        'Compute a CSS `clamp()` for fluid (responsive) type or spacing that scales smoothly between a ' +
          'min size at a small viewport and a max size at a large one. Use whenever you set a responsive ' +
          'font-size or spacing that should grow with the screen — do NOT hand-write the clamp() calc() ' +
          'term, it is easy to get wrong. Give minPx+maxPx for one value, or `scale` for a whole modular ' +
          'type/space scale. Output is rem-based so it respects user zoom.',
        fluidClampShape,
        async (args) => {
          try {
            const vp = {
              minViewportPx: args.minViewportPx,
              maxViewportPx: args.maxViewportPx,
              rootPx: args.rootPx
            }
            if (args.scale) {
              const steps = fluidScale({ ...args.scale, ...vp })
              const body =
                args.format === 'css-vars'
                  ? steps.map((s) => `  --step-${s.step}: ${s.css};`).join('\n')
                  : steps.map((s) => `step ${s.step}: ${s.css}`).join('\n')
              const out = args.format === 'css-vars' ? `:root {\n${body}\n}` : body
              return { content: [{ type: 'text' as const, text: out }] }
            }
            if (args.minPx === undefined || args.maxPx === undefined) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: 'fluid_clamp failed: provide minPx and maxPx (single value), or a `scale` object.'
                  }
                ],
                isError: true
              }
            }
            const r = fluidClamp({ minPx: args.minPx, maxPx: args.maxPx, ...vp })
            const css = args.format === 'css-vars' ? `--fluid: ${r.css};` : r.css
            const note = r.isStatic
              ? 'min and max are equal — emitted a static rem value.'
              : `verified: ${r.checkAtMinPx}px at ${args.minViewportPx ?? 320}px viewport, ${r.checkAtMaxPx}px at ${args.maxViewportPx ?? 1280}px.${r.warning ? ` Note: ${r.warning}` : ''}`
            return { content: [{ type: 'text' as const, text: `${css}\n\n/* ${note} */` }] }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            return {
              content: [{ type: 'text' as const, text: `fluid_clamp failed: ${msg}` }],
              isError: true
            }
          }
        }
      ),
      // OKLCH perceptual tonal ramp. Hand-picked hex ramps drift in hue and have
      // uneven perceptual lightness steps; OKLCH↔sRGB is a nonlinear transform
      // with an iterative gamut-map an LLM can't do in its head. Pure, auto-allowed.
      tool(
        'color_scale',
        'Generate a perceptually-even OKLCH tonal color ramp (Radix/Material-style 1..N scale) from a ' +
          'single seed color, each step gamut-mapped to valid sRGB. Use when building a color system, ' +
          'shades/tints of a brand color, or a token palette — do NOT hand-pick hex shades (they drift ' +
          'in hue and step unevenly). Pair the resulting steps with check_contrast to pick accessible ' +
          'text/background pairs.',
        colorScaleShape,
        async (args) => {
          try {
            const steps = oklchScale({
              seed: args.seed,
              steps: args.steps,
              hueShift: args.hueShift,
              lightnessRange: args.lightnessRange
            })
            const name = args.name ?? 'color'
            let out: string
            switch (args.format) {
              case 'css-vars':
                out = `:root {\n${steps.map((s) => `  --${name}-${s.index}: ${s.hex};`).join('\n')}\n}`
                break
              case 'tailwind':
                out = `${name}: {\n${steps.map((s) => `  ${s.index * 50}: '${s.hex}',`).join('\n')}\n}`
                break
              default:
                out = steps
                  .map(
                    (s) =>
                      `${s.index}: ${s.hex}  (oklch ${s.oklch.l.toFixed(3)} ${s.oklch.c.toFixed(3)} ${s.oklch.h.toFixed(1)})`
                  )
                  .join('\n')
            }
            return { content: [{ type: 'text' as const, text: out }] }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            return {
              content: [{ type: 'text' as const, text: `color_scale failed: ${msg}` }],
              isError: true
            }
          }
        }
      ),
      // Layered box-shadow. A realistic cast shadow is 5-6 correlated layers with
      // a shared light angle; LLMs emit one flat `0 4px 6px rgba(...)`. This
      // derives the whole stack from one elevation number. Pure, auto-allowed.
      tool(
        'layered_shadow',
        'Generate a realistic multi-layer CSS `box-shadow` (or a whole elevation scale) from one elevation ' +
          'value — several stacked layers with a shared light angle, the way real depth looks. Use whenever ' +
          'you add a shadow/elevation to a card, popover, button, etc. — do NOT hand-write a single flat ' +
          'box-shadow; it looks cheap. Set `scale: true` for a coherent sm..2xl token set.',
        layeredShadowShape,
        async (args) => {
          try {
            const common = {
              layers: args.layers,
              lightAngleDeg: args.lightAngleDeg,
              colorRgb: args.colorRgb,
              baseAlpha: args.baseAlpha
            }
            if (args.scale) {
              const set = elevationScale({ levels: args.levels, ...common })
              const out =
                args.format === 'css-vars'
                  ? `:root {\n${set.map((e) => `  --shadow-${e.label}: ${e.css};`).join('\n')}\n}`
                  : set.map((e) => `${e.label} (level ${e.level}): ${e.css}`).join('\n\n')
              return { content: [{ type: 'text' as const, text: out }] }
            }
            if (args.elevation === undefined) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: 'layered_shadow failed: provide `elevation`, or set `scale: true`.'
                  }
                ],
                isError: true
              }
            }
            const r = layeredShadow({ elevation: args.elevation, ...common })
            const out = args.format === 'css-vars' ? `--shadow: ${r.css};` : r.css
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `${out}\n\n/* ${r.layers.length} layers, shared light angle */`
                }
              ]
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            return {
              content: [{ type: 'text' as const, text: `layered_shadow failed: ${msg}` }],
              isError: true
            }
          }
        }
      ),
      // Size-aware, WCAG-floored line-height (and optional letter-spacing). LLMs
      // default to a hardcoded 1.5 everywhere; real leading is inverse to size and
      // measure-aware, with body text floored at 1.5. Pure math (type-metrics.ts) —
      // no state, no disk, auto-allowed like the other calculators.
      tool(
        'line_height',
        'Compute an accessible, size-appropriate CSS line-height (and optional letter-spacing) for a ' +
          'font size. Call this WHENEVER you set a font-size or line-height instead of defaulting to 1.5 ' +
          'everywhere — leading should tighten as type grows, stay measure-aware, and body text is floored ' +
          'at 1.5 per WCAG 2.1 SC 1.4.12. Pass includeTracking for a matching letter-spacing.',
        lineHeightShape,
        async (args) => {
          const lh = lineHeight({
            fontSizePx: args.fontSizePx,
            measureCh: args.measureCh,
            role: args.role
          })
          const ls = args.includeTracking ? letterSpacing(args.fontSizePx) : null
          const lines: string[] = []
          if ((args.format ?? 'value') === 'css') {
            lines.push(`line-height: ${lh.lineHeight};`)
            if (ls) lines.push(`letter-spacing: ${ls.css};`)
          } else {
            lines.push(
              `line-height: ${lh.lineHeight} (${lh.lineHeightPx}px at ${args.fontSizePx}px)`
            )
            if (ls) lines.push(`letter-spacing: ${ls.css}`)
          }
          const notes = [lh.rationale]
          if (ls) notes.push(ls.rationale)
          if (lh.floored) {
            notes.push('WCAG 2.1 SC 1.4.12: body text must stay usable at line-height ≥ 1.5.')
          }
          return {
            content: [
              { type: 'text' as const, text: `${lines.join('\n')}\n\n/* ${notes.join('\n   ')} */` }
            ]
          }
        }
      ),
      // Curated catalog of external "taste" skill packs Praxis can OFFER to install.
      // Pure/read-only — just formats SKILL_PACKS for the model; no network, no disk,
      // so it's auto-allowed. Its sibling install_skills is NOT (it writes + fetches).
      tool(
        'list_recommended_skills',
        'List the curated catalog of external design/craft skill packs Praxis can offer to install into ' +
          "the user's project or user scope. Call this when a design task would benefit from established " +
          'craft you lack (animation/interaction taste, color systems, frontend polish), then OFFER the ' +
          'user a relevant pack — never install silently. Use the returned id with install_skills.',
        {},
        async () => {
          const text = SKILL_PACKS.map(
            (p) =>
              `• ${p.id} — ${p.title}\n  ${p.description}\n  ${p.url} (recommended scope: ${p.recommendedScope})`
          ).join('\n\n')
          return {
            content: [
              {
                type: 'text' as const,
                text: `Curated skill packs (install with install_skills using the id):\n\n${text}`
              }
            ]
          }
        }
      ),
      // Install a curated skill pack (`npx skills add … --copy`) into the project or
      // user scope. SIDE-EFFECTING: writes files + hits the network, so it is NOT in
      // PRAXIS_TOOL_NAMES — it surfaces a normal permission card. packId is validated
      // against the curated allowlist (skill-packs.ts) BEFORE anything spawns, so an
      // arbitrary repo string can never reach `npx skills add`. Persists to the LIVE
      // root (ctx.liveRoot), not the per-chat worktree, so installs aren't stranded.
      tool(
        'install_skills',
        "Install a curated skill pack into the user's project (<repo>/.claude/skills/) or user scope " +
          '(~/.claude/skills/), after the user agrees. Only packs from list_recommended_skills are allowed. ' +
          'OFFER first and let the user pick the scope — never install silently. Newly installed skills are ' +
          'discovered on the next message/session, so they take effect then.',
        {
          packId: z
            .string()
            .describe('Pack id from list_recommended_skills (curated allowlist only).'),
          scope: z
            .enum(['project', 'user'])
            .optional()
            .describe(
              "Install target: 'project' = <repo>/.claude/skills, 'user' = ~/.claude/skills. Defaults to the pack's recommendedScope."
            )
        },
        async (args) => {
          const pack = findPack(args.packId)
          if (!pack) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text:
                    `install_skills failed: '${args.packId}' is not in the curated skill-pack allowlist. ` +
                    'Call list_recommended_skills and use one of its ids.'
                }
              ],
              isError: true
            }
          }
          const scope = args.scope ?? pack.recommendedScope
          const result = await installSkillPack({
            packId: args.packId,
            scope,
            liveRoot: ctx?.liveRoot ?? root
          })
          const restart =
            'Newly installed skills are discovered when the agent starts its next turn — they take ' +
            'effect on your next message (or a fresh session), not mid-turn.'
          return {
            content: [{ type: 'text' as const, text: `${result.message}\n\n${restart}` }],
            ...(result.ok ? {} : { isError: true })
          }
        }
      )
    ]
  })

  const q: Query = query({
    prompt: input,
    options: {
      cwd: root,
      settingSources: ['user', 'project', 'local'],
      // The repo's CLAUDE.md + skills load via settingSources; Praxis's own
      // operating rules (v8 R) are appended to the Claude Code preset, with the
      // preview-tools section (Claude alone can call the in-process praxis tools).
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: praxisRules({ previewTools: true, projectMemory: ctx?.projectMemory })
      },
      // The praxis MCP server (preview_location / preview_screenshot / define_controls /
      // spring_to_css / check_contrast / fluid_clamp / color_scale / layered_shadow /
      // line_height / list_recommended_skills / install_skills). All but install_skills
      // are auto-allowed here so they never surface a permission card (canUseTool also
      // short-circuits them, belt-and-suspenders) — main validates everything
      // define_controls persists, and install_skills prompts (writes files + network).
      mcpServers: { praxis: previewServer },
      allowedTools: [...PRAXIS_TOOL_NAMES],
      // The bundled Praxis skill plugin (only when present in this build).
      ...(existsSync(PLUGIN_PATH)
        ? { plugins: [{ type: 'local' as const, path: PLUGIN_PATH }] }
        : {}),
      includePartialMessages: true,
      permissionMode: options.permissionMode ?? 'default',
      allowDangerouslySkipPermissions: true,
      abortController: abort,
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { effort: options.effort as 'low' | 'medium' | 'high' } : {}),
      // v9 resume: reload a past conversation's context (the record's captured
      // sdkSessionId) instead of starting fresh. Absent for the default open/new-chat path.
      ...(ctx?.resumeSessionId ? { resume: ctx.resumeSessionId } : {}),
      canUseTool: async (toolName, toolInput, opts) => {
        // The agent asking the user a question isn't a permission decision — surface
        // it as an interactive multiple-choice card and feed the answer back as the
        // tool result. (Handled before the permission machinery so it never shows an
        // approve/deny card.)
        if (toolName === 'AskUserQuestion') {
          const questions = parseQuestions(toolInput)
          if (questions.length === 0) {
            return { behavior: 'deny', message: 'The question had no answerable options.' }
          }
          if (disposed || abort.signal.aborted || opts.signal.aborted) {
            return { behavior: 'deny', message: 'Session no longer active.' }
          }
          const id = opts.toolUseID || `${key}:q${++permCounter}`
          const request: QuestionRequest = { id, questions, sessionKey: emitKey }
          return await new Promise((resolve) => {
            const cleanup = (): void => {
              pendingQuestions.delete(id)
              opts.signal.removeEventListener('abort', onAbort)
            }
            const onAbort = (): void => {
              cleanup()
              emit({ type: 'question-resolved', id })
              resolve({ behavior: 'deny', message: 'Interrupted.' })
            }
            pendingQuestions.set(id, {
              settle: (answers) => {
                cleanup()
                resolve({
                  behavior: 'deny',
                  message: answers
                    ? formatAnswers(questions, answers)
                    : 'The user dismissed the question without answering.'
                })
              }
            })
            opts.signal.addEventListener('abort', onAbort, { once: true })
            emit({ type: 'question-request', request })
          })
        }
        // The in-process praxis tools are auto-allowed: the preview pair are
        // read-only observers of the user's own view, and define_controls only
        // persists through main's validated saveManifest path. They're also in
        // allowedTools, but guard here too so a canUseTool call for them can
        // never reach a prompt.
        if (PRAXIS_TOOL_NAMES.has(toolName)) {
          emit({ type: 'status', text: describeTool(toolName, toolInput) })
          return { behavior: 'allow', updatedInput: toolInput }
        }
        if (touchesSidecar(toolName, toolInput)) {
          return {
            behavior: 'deny',
            message: 'The .praxis/ sidecar is managed by praxis, not the agent.'
          }
        }
        if (AUTO_ALLOW_TOOLS.has(toolName)) {
          emit({ type: 'status', text: describeTool(toolName, toolInput) })
          return { behavior: 'allow', updatedInput: toolInput }
        }
        if (disposed || abort.signal.aborted || opts.signal.aborted) {
          return { behavior: 'deny', message: 'Session no longer active.' }
        }
        // In `auto` mode the SDK's classifier auto-approves routine tools without
        // calling this hook; a call reaching here is one the classifier flagged as
        // risky (the 'ask' path). Surface an approve/deny card so the user decides —
        // this is the only prompt in auto mode, for genuinely dangerous ops.
        emit({ type: 'status', text: describeTool(toolName, toolInput) })
        const id = opts.toolUseID || `${key}:perm${++permCounter}`
        const request: PermissionRequest = {
          id,
          toolName,
          title: opts.title || `Allow ${toolName}?`,
          ...(opts.displayName ? { displayName: opts.displayName } : {}),
          ...(toolDetail(toolName, toolInput) ? { detail: toolDetail(toolName, toolInput)! } : {}),
          sessionKey: emitKey
        }
        return await new Promise((resolve) => {
          const cleanup = (): void => {
            pending.delete(id)
            opts.signal.removeEventListener('abort', onAbort)
          }
          const onAbort = (): void => {
            cleanup()
            emit({ type: 'permission-resolved', id })
            resolve({ behavior: 'deny', message: 'Interrupted.' })
          }
          pending.set(id, {
            toolName,
            settle: (behavior) => {
              cleanup()
              resolve(
                behavior === 'allow'
                  ? { behavior: 'allow', updatedInput: toolInput }
                  : { behavior: 'deny', message: 'Denied by the user in Praxis.' }
              )
            }
          })
          opts.signal.addEventListener('abort', onAbort, { once: true })
          emit({ type: 'permission-request', request })
        })
      }
    }
  })

  // The "/" menu (LKM-54): project skills — the opened repo's
  // `.claude/skills/**/SKILL.md`, discovered + described here in main so the
  // renderer never touches the filesystem — rank ahead of the SDK's advertised
  // commands, shadowing same-named ones. Either side may resolve first, so both
  // land in this closure and re-emit the merged list.
  let projectSkills: SlashCommandItem[] = []
  let sdkCommandNames: string[] = []
  const emitCommands = (): void => {
    const merged = mergeSlashCommands(projectSkills, sdkCommandNames)
    if (merged.length) emit({ type: 'commands', commands: merged })
  }
  void discoverProjectSkills(root).then((skills) => {
    if (disposed || !skills.length) return
    projectSkills = skills
    emitCommands()
  })

  // Populate the "/" menu immediately: with a streaming input, the SDK's `init`
  // system message (which carries slash_commands) only arrives after the FIRST
  // user message — so a freshly-opened project's "/" menu would be empty until you
  // chat once. supportedCommands() (captured at initialize) fetches them eagerly.
  void q
    .supportedCommands()
    .then((cmds) => {
      if (disposed || !cmds.length) return
      sdkCommandNames = cmds.map((c) => c.name)
      emitCommands()
    })
    .catch(() => {
      /* older SDK / not ready — the init message will still populate on first turn */
    })

  // Feed the model picker (see main/model-catalog.ts). A LIVE query is the only
  // thing that can say which models this account actually has — `choices()` runs
  // on a picker render with no session to ask — so every session opportunistically
  // hands its answer to the catalog, which persists it for the next launch. Purely
  // fire-and-forget: never awaited, never emitted, never able to fail a turn. The
  // try/catch is for an SDK old enough to lack the method outright, which would
  // throw SYNCHRONOUSLY here and take session startup with it.
  try {
    void q
      .supportedModels()
      .then((models) => recordClaudeModels(models))
      .catch(() => {
        /* not ready / no auth — the picker keeps its cached or last-resort list */
      })
  } catch {
    /* no supportedModels() on this SDK — same outcome, one turn earlier */
  }

  // Drive the output stream for the life of the session.
  void (async () => {
    let streamedText = false
    // Token accounting for the API request in flight. The SDK reports the SAME
    // request's usage repeatedly and cumulatively — `message_start` (the input
    // side), then each `message_delta` (the running output total), then the
    // complete `assistant` message — so remember the running maximum already
    // emitted and send only what's new. Reset per request, at `message_start`.
    let sentUsage = emptyUsage()
    const reportUsage = (raw: unknown): void => {
      const total = readUsage(raw)
      if (!total) return
      const delta = usageDelta(sentUsage, total)
      if (isEmptyUsage(delta)) return
      sentUsage = addUsage(sentUsage, delta)
      emit({ type: 'usage', ...delta })
    }
    try {
      for await (const msg of q) {
        switch (msg.type) {
          case 'system': {
            const sys = msg as { subtype?: string; slash_commands?: string[]; session_id?: string }
            if (sys.subtype === 'init') {
              // v9 resume: capture the SDK's own resumable session id off the init
              // message — this is what a later `agent:resume-session` forwards back
              // as `options.resume`. Distinct from `ctx.sessionId` (v8 F1 spawn bookkeeping).
              if (typeof sys.session_id === 'string' && sys.session_id) {
                cap.setSdkSessionId(sys.session_id)
              }
              if (Array.isArray(sys.slash_commands)) {
                sdkCommandNames = sys.slash_commands
                emitCommands()
              }
            }
            break
          }
          case 'stream_event': {
            const ev = (msg as { event?: { type?: string; message?: unknown; usage?: unknown } })
              .event
            if (ev?.type === 'message_start') {
              // A new request — its counters start from zero again.
              sentUsage = emptyUsage()
              reportUsage((ev.message as { usage?: unknown } | undefined)?.usage)
            } else if (ev?.type === 'message_delta') {
              reportUsage(ev.usage)
            }
            const text = textDelta(msg)
            if (text) {
              streamedText = true
              cap.appendAssistant(text)
              emit({ type: 'delta', text })
            }
            break
          }
          case 'assistant': {
            // The final, authoritative usage for this request — a no-op delta
            // when the stream events above already reported all of it.
            reportUsage((msg.message as { usage?: unknown }).usage)
            for (const block of msg.message.content) {
              if (block.type === 'text' && !streamedText) {
                cap.appendAssistant(block.text)
                emit({ type: 'delta', text: block.text })
              } else if (block.type === 'tool_use') {
                // Capture in the assistant stream (not canUseTool) so tools are
                // recorded even under bypassPermissions, where canUseTool is skipped.
                cap.noteTool(block.name, block.input)
                emit({ type: 'status', text: describeTool(block.name, block.input) })
              }
            }
            break
          }
          case 'result': {
            if (hardStopped) break // the force-stop already finalized and sent `done`
            cap.finalize()
            emit({ type: 'done' })
            streamedText = false
            break
          }
        }
      }
    } catch (err) {
      if (!abort.signal.aborted) {
        emit({ type: 'error', message: err instanceof Error ? err.message : String(err) })
      }
    }
  })()

  return {
    key,
    root,
    options,
    send: (text, images) => input.push(text, images),
    pending,
    pendingQuestions,
    emit,
    record: cap.record,
    finalize: cap.finalize,
    dispose: () => {
      disposed = true
    },
    shutdown: () => {
      abort.abort()
      input.close()
    },
    setModel: async (model) => {
      await q.setModel?.(model)
    },
    setPermissionMode: async (mode) => {
      await q.setPermissionMode?.(mode)
    },
    interrupt: async () => {
      // `q.interrupt()` is a CONTROL REQUEST to the CLI subprocess, and the SDK's
      // control-request promise settles only when a matching `control_response`
      // comes back — there is no timeout in the SDK. So when that subprocess is
      // wedged (the request went out and nothing ever came back: 0 tokens in, 0
      // out, the turn running for minutes) the graceful path never returns, this
      // promise never settles, and Stop does nothing at all — precisely the state
      // Stop exists to escape. Race it, then escalate to the abort signal the
      // query was constructed with, which is the kill switch shutdown() already
      // relies on and which nothing else was reaching for here.
      return await interruptWithEscalation({
        graceful: () => q.interrupt?.(),
        graceMs: INTERRUPT_GRACE_MS,
        escalate: () => {
          hardStopped = true // stop the reader loop double-emitting on a late result
          abort.abort()
          input.close()
          emit({
            type: 'error',
            message:
              'That turn stopped responding, so Praxis force-stopped it. The chat has been ' +
              'restarted — earlier messages are still shown, but the assistant no longer has ' +
              'them in context.'
          })
          cap.finalize()
          emit({ type: 'done' })
        }
      })
    }
  }
}

/**
 * One-shot, tool-less completion that names a chat by its subject (see the
 * `ModelProvider.generateTitle` contract). Runs a fresh headless `query()` with
 * no setting sources (skip the repo's CLAUDE.md/skills — a title needs none) and
 * every tool denied, so it can't touch the repo or drift into work. Aborts after
 * a short deadline; any failure resolves to null (the rail keeps its heuristic
 * name). Reuses the session's model so it honours the user's provider auth.
 */
async function generateTitle(
  transcript: SessionTranscriptEntry[],
  options: AgentOptions
): Promise<string | null> {
  const convo = transcriptDigest(transcript)
  if (!convo) return null

  const { query } = await loadSdk()
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 20_000)
  try {
    const prompt =
      'Below is the start of a conversation between a user and a coding assistant working on a UI/design project.\n\n' +
      `${convo}\n\n` +
      'Write a short, specific title (3–6 words, Title Case, no quotes, no trailing punctuation) naming what this ' +
      'conversation is actually about — the task or subject, not a greeting and not the literal opening words. ' +
      'Reply with ONLY the title.'
    let out = ''
    const q = query({
      prompt,
      options: {
        settingSources: [],
        allowedTools: [],
        includePartialMessages: false,
        permissionMode: 'default',
        abortController: abort,
        // A title needs no tools; deny everything so it can never edit the repo.
        canUseTool: async () => ({ behavior: 'deny', message: 'Titling uses no tools.' }),
        ...(options.model ? { model: options.model } : {})
      }
    })
    for await (const msg of q) {
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'text') out += block.text
        }
      } else if (msg.type === 'result') {
        break
      }
    }
    return sanitizeTitle(out)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export const claudeProvider: ModelProvider = {
  id: 'claude',
  supportsSpawn: true,
  startSession,
  generateTitle
}
