import { app, ipcMain } from 'electron'
import type { Diagnosis, DiagStep } from '../shared/api'
import { recall, remember, setStatus, signatureFor } from './diag-cache'
import { matchKnownError } from './diag-rules'

/**
 * AI-assisted diagnosis of an open/launch failure. Recall a per-machine cached
 * fix first (instant, no model call); otherwise run a single tool-less Agent SDK
 * turn that returns a structured fix plan. We only DIAGNOSE here — applying is
 * the user's explicit choice (propose-first).
 */

type SdkModule = typeof import('@anthropic-ai/claude-agent-sdk')
let sdkPromise: Promise<SdkModule> | null = null
const loadSdk = (): Promise<SdkModule> =>
  (sdkPromise ??= import('@anthropic-ai/claude-agent-sdk'))

function parseDiagnosis(text: string, error: string): Diagnosis | null {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const o = JSON.parse(m[0]) as { summary?: unknown; detail?: unknown; steps?: unknown }
    const steps: DiagStep[] = Array.isArray(o.steps)
      ? o.steps
          .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
          .filter((s) => typeof s.text === 'string')
          .map((s) => ({
            text: String(s.text),
            command:
              typeof s.command === 'string' && s.command.trim() ? String(s.command).trim() : undefined,
            scope: s.scope === 'host' ? 'host' : 'repo'
          }))
      : []
    if (typeof o.summary !== 'string' || steps.length === 0) return null
    return {
      signature: signatureFor(error),
      summary: o.summary,
      detail: typeof o.detail === 'string' ? o.detail : undefined,
      steps,
      seenBefore: false,
      status: 'proposed'
    }
  } catch {
    return null
  }
}

async function aiDiagnose(
  root: string,
  error: string,
  context: string
): Promise<Diagnosis | null> {
  let query: SdkModule['query']
  try {
    ;({ query } = await loadSdk())
  } catch {
    return null
  }
  const prompt =
    `You are diagnosing a failure that happened while opening or running a project in Praxis ` +
    `(a local dev tool that runs the project's dev server / iOS simulator). Diagnose the ROOT ` +
    `CAUSE and give concrete fix steps. Do NOT modify anything — only diagnose.\n\n` +
    `Project root: ${root}\nContext: ${context || '(none)'}\n\nError / output:\n"""\n${error.slice(0, 4000)}\n"""\n\n` +
    `For each step set "scope" to "repo" if it is a change INSIDE this project a tool could apply ` +
    `(install a dependency, edit a config) or "host" if it is a machine-level action the user must ` +
    `run themselves (sudo, xcode-select, downloading an SDK/platform). Include the exact shell ` +
    `"command" when there is one. Respond with ONLY a JSON object, no prose:\n` +
    `{"summary":"one-line root cause","detail":"a sentence or two","steps":[{"text":"...","command":"...","scope":"repo|host"}]}`

  try {
    const q = query({
      prompt,
      options: {
        cwd: root,
        settingSources: [],
        includePartialMessages: false,
        permissionMode: 'default',
        maxTurns: 1,
        allowedTools: []
      }
    })
    let text = ''
    for await (const msg of q) {
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'text') text += block.text
        }
      } else if (msg.type === 'result') {
        break
      }
    }
    return parseDiagnosis(text, error)
  } catch {
    return null
  }
}

export function registerDiagnoseIpc(): void {
  ipcMain.handle(
    'diagnose:run',
    async (_e, root: string, error: string, context = ''): Promise<Diagnosis | null> => {
      const dir = app.getPath('userData')
      const cached = await recall(dir, root, error)
      if (cached) return cached
      // Layer 2: a known error signature → known fix, instant + offline, before
      // spending a model call. Falls through to the AI when nothing matches.
      const ruled = matchKnownError(error)
      if (ruled) {
        const diag: Diagnosis = {
          signature: signatureFor(error),
          summary: ruled.summary,
          detail: ruled.detail,
          steps: ruled.steps,
          seenBefore: false,
          status: 'proposed'
        }
        await remember(dir, root, diag)
        return diag
      }
      const diag = await aiDiagnose(root, error, context)
      if (diag) await remember(dir, root, diag)
      return diag
    }
  )
  ipcMain.handle(
    'diagnose:record',
    async (_e, root: string, signature: string, status: 'applied' | 'dismissed') => {
      await setStatus(app.getPath('userData'), root, signature, status)
    }
  )
}
