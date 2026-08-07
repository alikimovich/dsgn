import type { BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AgentEvent, AgentOptions } from '../../shared/api'
import { projectKey } from '../../shared/projectKey'
import {
  addUsage,
  emptyUsage,
  isEmptyUsage,
  readUsage,
  usageDelta,
  type TokenUsage
} from '../../shared/run-stats'
import { watchRolloutUsage, type RolloutUsageWatch } from '../codex-usage'
import type { ModelProvider, PendingPrompt, ProviderSession, SpawnContext } from './types'
import { describeTool, sendToRenderer } from './tools'
import { createRecordCapture } from './record'
import { praxisRules } from '../rules'
import type {
  ModelReasoningEffort,
  Thread,
  ThreadItem,
  ThreadOptions
} from '@openai/codex-sdk'

/**
 * OpenAI Codex backend (v7) via `@openai/codex-sdk`. Auth is the user's **ChatGPT
 * subscription** ("sign in with ChatGPT": `codex login`) — NO API key. The SDK shells
 * out to the `codex` CLI, which edits the repo with its OWN sandboxed tools, so praxis
 * doesn't define a toolset here — it maps Codex's streamed `ThreadEvent`s onto praxis's
 * `AgentEvent` stream.
 *
 * Reachable only when `AgentOptions.provider === 'codex'`. ESM-only, so loaded via a
 * dynamic `import()` (like the Claude SDK) in this CJS main bundle. If the `codex` CLI
 * is missing or the user isn't logged in, the turn fails soft (`error` + `done`) and the
 * renderer maps it to the "sign in with ChatGPT" banner.
 *
 * Tool approvals run headless (`approvalPolicy: 'never'`, `sandboxMode: 'workspace-write'`)
 * — mapping Codex approvals → praxis permission cards is a follow-up (the SDK event stream
 * has no approval-request event to bridge).
 */

type CodexModule = typeof import('@openai/codex-sdk')
let codexPromise: Promise<CodexModule> | null = null
const loadCodex = (): Promise<CodexModule> => (codexPromise ??= import('@openai/codex-sdk'))

const execFileP = promisify(execFile)
// Overridable so tests can force the CLI-absent path even where `codex` resolves
// (e.g. `bun run` puts node_modules/.bin — which has the SDK's codex shim — on PATH).
const CODEX_BIN = process.env.PRAXIS_CODEX_BIN || 'codex'
/** The SDK shells out to the `codex` CLI; probe it up front so a missing/unauthed CLI
 *  fails soft FAST + clearly, instead of surfacing a slow spawn ENOENT mid-turn. */
async function codexCliPresent(): Promise<boolean> {
  try {
    await execFileP(CODEX_BIN, ['--version'], { timeout: 4000 })
    return true
  } catch {
    return false
  }
}

const REASONING_EFFORTS = new Set<ModelReasoningEffort>([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh'
])
const isEffort = (e: string | undefined): e is ModelReasoningEffort =>
  !!e && REASONING_EFFORTS.has(e as ModelReasoningEffort)
const oneLine = (s: string, n = 120): string => s.replace(/\s+/g, ' ').trim().slice(0, n)

async function startSession(
  root: string,
  options: AgentOptions,
  getWindow: () => BrowserWindow | null,
  // v9 resume/multi-chat: Codex has no confirmed resume primitive — accept the
  // context (for the shared ModelProvider signature) and no-op it. `emitKey`
  // (used for an additional live chat) is honored so its events still route to
  // the right renderer chat slice; `resumeSessionId` is ignored.
  ctx?: SpawnContext
): Promise<ProviderSession> {
  const key = projectKey(root)
  // `emitKey` tags live events (so an additional/resumed chat's `${key}#…` sessionKey
  // routes into its own renderer chat slice) — but the PERSISTED record must keep the
  // canonical `key`, since `sessions-store.ts#list`/`agent:sessions-list` always query
  // by the plain projectKey(root); tagging the record with `emitKey` would orphan an
  // additional/resumed chat's history entry (no lookup could ever find it again).
  const emitKey = ctx?.emitKey ?? key
  const cap = createRecordCapture(root, key)
  const pending = new Map<string, PendingPrompt>()
  let disposed = false
  let aborted = false // session teardown (permanent)
  let turnAbort: AbortController | null = null // cancels the in-flight turn only
  // praxis rules (v8 R): no system-prompt arg here, so prepend them to the first turn.
  let firstTurn = true

  const emit = (event: AgentEvent): void => {
    if (disposed) return
    const tagged = { ...event, projectKey: emitKey }
    // agent.ts's in-process hook — v9 workspace-snapshot isRunning tracking
    // (set for every interactive session: default, new-chat, resumed).
    ctx?.onEvent?.(tagged)
    sendToRenderer(getWindow, 'agent:event', tagged)
  }
  // Always attribute errors to the Codex backend (so the user knows which provider
  // failed, and the renderer's login-banner heuristic can key on it).
  const emitError = (m: string): void =>
    emit({ type: 'error', message: /codex/i.test(m) ? m : `Codex: ${m}` })

  // Build the thread up front (the SDK spawns the `codex` CLI; auth = `codex login`).
  let thread: Thread | null = null
  let initErr: Error | null = null
  try {
    if (!(await codexCliPresent())) {
      throw new Error(
        'the `codex` CLI was not found. Install it (`npm i -g @openai/codex` or Homebrew) and run `codex login` (sign in with ChatGPT).'
      )
    }
    const { Codex } = await loadCodex()
    const threadOptions: ThreadOptions = {
      workingDirectory: root,
      skipGitRepoCheck: true,
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      ...(options.model ? { model: options.model } : {}),
      ...(isEffort(options.effort) ? { modelReasoningEffort: options.effort } : {})
    }
    thread = new Codex().startThread(threadOptions)
  } catch (err) {
    initErr = err instanceof Error ? err : new Error(String(err))
  }

  // Codex reports token usage as a CUMULATIVE tally for the whole thread — turn 2's
  // `turn.completed` repeats turn 1's tokens on top of its own — so every reading is
  // diffed against what we've already emitted (the `usage` event carries a delta, and
  // summing the raw readings would have over-counted every turn after the first).
  // Same accumulator serves the live rollout tail below, so whichever readings it
  // missed are simply topped up at `turn.completed`.
  let sentUsage = emptyUsage()
  const noteUsage = (total: TokenUsage | null): void => {
    if (!total) return
    const delta = usageDelta(sentUsage, total)
    if (isEmptyUsage(delta)) return
    sentUsage = addUsage(sentUsage, delta) // = max(sent, total), never claws back
    emit({ type: 'usage', ...delta })
  }

  // The SDK's event stream has no incremental usage member, so the counters would
  // otherwise sit at zero for the whole turn; the CLI's own session rollout does
  // record them as it goes. Runs only while a turn is in flight. See codex-usage.ts.
  let usageWatch: RolloutUsageWatch | null = null
  const startUsageWatch = (threadId: string): void => {
    if (usageWatch || disposed) return
    usageWatch = watchRolloutUsage(threadId, noteUsage)
  }
  const stopUsageWatch = (): void => {
    usageWatch?.stop()
    usageWatch = null
  }

  // Codex streams whole `ThreadItem`s (often started→updated→completed), not raw deltas.
  // Track per-item: how much agent_message text we've emitted (so updates stream as a
  // suffix), and which tool items we've already surfaced (so we emit each step once).
  const emittedLen = new Map<string, number>()
  const statused = new Set<string>()

  const handleItem = (item: ThreadItem, terminal: boolean): void => {
    switch (item.type) {
      case 'agent_message': {
        const prev = emittedLen.get(item.id) ?? 0
        const full = item.text ?? ''
        if (full.length > prev) {
          const delta = full.slice(prev)
          emittedLen.set(item.id, full.length)
          cap.appendAssistant(delta)
          emit({ type: 'delta', text: delta })
        }
        break
      }
      case 'reasoning': {
        if (terminal && item.text?.trim() && !statused.has(item.id)) {
          statused.add(item.id)
          emit({ type: 'status', text: `Thinking · ${oneLine(item.text)}` })
        }
        break
      }
      case 'command_execution': {
        if (!statused.has(item.id)) {
          statused.add(item.id)
          emit({ type: 'status', text: `$ ${oneLine(item.command, 100)}` })
          cap.noteTool('Bash', { command: item.command })
        }
        break
      }
      case 'file_change': {
        // "Emitted once the patch succeeds or fails" → handle on the terminal event.
        if (terminal && !statused.has(item.id)) {
          statused.add(item.id)
          for (const ch of item.changes ?? []) {
            emit({ type: 'status', text: describeTool('Edit', { file_path: ch.path }) })
            cap.noteTool('Edit', { file_path: ch.path }) // → filesTouched in the record
          }
        }
        break
      }
      case 'web_search': {
        if (!statused.has(item.id)) {
          statused.add(item.id)
          emit({ type: 'status', text: `Search · ${oneLine(item.query, 80)}` })
        }
        break
      }
      case 'mcp_tool_call': {
        if (!statused.has(item.id)) {
          statused.add(item.id)
          emit({ type: 'status', text: `${item.server} · ${item.tool}` })
          cap.noteTool(item.tool, item.arguments)
        }
        break
      }
      case 'error': {
        // A non-fatal item-level error — surface it as a status, not a turn failure.
        emit({ type: 'status', text: `⚠ ${oneLine(item.message)}` })
        break
      }
    }
  }

  // Serialize turns: each send() runs to completion before the next starts.
  let chain: Promise<void> = Promise.resolve()
  const runTurn = async (text: string): Promise<void> => {
    if (aborted || disposed) return
    if (!thread) {
      // Missing CLI / not logged in → an auth-shaped error (isAuthError matches the
      // "codex login" / "sign in" phrasing → the renderer shows the login banner).
      emitError(initErr?.message ?? 'Codex backend unavailable. Run `codex login`.')
      emit({ type: 'done' })
      return
    }
    turnAbort = new AbortController()
    // On turn 2+ the thread id is already known, so the tail starts with the turn;
    // on turn 1 it starts at `thread.started`, a moment later.
    if (thread.id) startUsageWatch(thread.id)
    try {
      const { events } = await thread.runStreamed(text, { signal: turnAbort.signal })
      for await (const ev of events) {
        if (disposed || aborted || turnAbort.signal.aborted) break
        switch (ev.type) {
          case 'thread.started':
            startUsageWatch(ev.thread_id)
            break
          case 'item.started':
          case 'item.updated':
            handleItem(ev.item, false)
            break
          case 'item.completed':
            handleItem(ev.item, true)
            break
          case 'turn.completed':
            // A running thread total, not this turn's own tokens — `noteUsage`
            // emits only the part the rollout tail hasn't already reported.
            noteUsage(readUsage((ev as { usage?: unknown }).usage))
            break
          case 'turn.failed':
            emitError(ev.error.message)
            break
          case 'error':
            emitError(ev.message)
            break
          // turn.started needs no extra handling.
        }
      }
    } catch (err) {
      if (!aborted && !turnAbort.signal.aborted) {
        const m = err instanceof Error ? err.message : String(err)
        // A missing/unauthenticated `codex` CLI surfaces here (e.g. spawn ENOENT).
        emitError(
          /codex/i.test(m)
            ? m
            : `turn failed: ${m}. Is the \`codex\` CLI installed and \`codex login\` done?`
        )
      }
    }
    // One last read before the tail stops: an INTERRUPTED turn never reaches
    // `turn.completed`, so the rollout is the only record of what it spent.
    await usageWatch?.poll().catch(() => {})
    stopUsageWatch()
    cap.finalize()
    emit({ type: 'done' })
  }

  return {
    key,
    root,
    options,
    // Codex CLI is text-only here; images (paste/drop) are ignored for now.
    send: (text, _images) => {
      const prompt = firstTurn ? `${praxisRules()}\n\n---\n\n${text}` : text
      firstTurn = false
      chain = chain.then(() => runTurn(prompt))
    },
    pending,
    emit,
    record: cap.record,
    finalize: cap.finalize,
    dispose: () => {
      disposed = true
      stopUsageWatch()
    },
    shutdown: () => {
      aborted = true
      stopUsageWatch()
      turnAbort?.abort()
    },
    interrupt: async () => {
      turnAbort?.abort() // cancel the current turn; the session can still take more
    }
    // setModel/setPermissionMode: Codex sets these per-thread at startThread, so a live
    // change would mean re-threading — a follow-up. Model/effort are honored on open.
  }
}

export const codexProvider: ModelProvider = { id: 'codex', startSession }
