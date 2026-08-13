/**
 * chat-settings unit test (pure — no Electron, no DOM, no zustand). These are the
 * mappings between a chat's visible agent choices and the `AgentOptions` main
 * starts its session with. The bug they exist to prevent: a session created
 * WITHOUT `permissionMode` runs under main's default ('default' = ask for every
 * edit) while the composer's picker keeps showing the UI default ("Auto") — so
 * the mode on screen isn't the mode the agent is running.
 *
 * Run with: bun test/chat-settings.mjs
 */

import {
  agentOptionsFor,
  chatAgentSettingsFor,
  chatAgentSettingsFromOptions,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  defaultChatAgentSettings,
  resumeChatSettings,
  toAgentOptions
} from '../src/renderer/src/chat-settings.ts'

let failed = 0
const ok = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    failed++
  }
}
const eq = (actual, expected, msg) =>
  ok(actual === expected, `${msg} (got ${JSON.stringify(actual)})`)

// ── The UI sentinels drop out of the options ────────────────────────────────
{
  const opts = toAgentOptions({ model: DEFAULT_MODEL, effort: 'auto', provider: DEFAULT_PROVIDER })
  eq(opts.model, undefined, 'the default model sentinel is omitted')
  eq(opts.effort, undefined, 'the default effort sentinel is omitted')
  ok(!('provider' in opts), 'the default backend is implied, not sent')

  const picked = toAgentOptions({ model: 'opus', effort: 'high', provider: 'codex' })
  eq(picked.model, 'opus', 'a real model is sent')
  eq(picked.effort, 'high', 'a real effort is sent')
  eq(picked.provider, 'codex', 'a non-default backend is sent')
}

// ── agentOptionsFor ALWAYS carries the posture ──────────────────────────────
// The whole point: a session-creating call can't forget the mode.
{
  for (const mode of ['auto', 'default', 'acceptEdits', 'bypassPermissions']) {
    const opts = agentOptionsFor({ ...defaultChatAgentSettings(), permissionMode: mode })
    eq(opts.permissionMode, mode, `agentOptionsFor carries '${mode}'`)
  }
  const opts = agentOptionsFor({
    model: 'opus',
    effort: 'auto',
    provider: DEFAULT_PROVIDER,
    permissionMode: 'auto'
  })
  eq(opts.model, 'opus', 'agentOptionsFor keeps the model')
  eq(opts.effort, undefined, 'agentOptionsFor still drops the sentinels')
}

// ── The inverse uses MAIN's fallbacks, not the UI's ─────────────────────────
{
  const fromNothing = chatAgentSettingsFromOptions({})
  eq(
    fromNothing.permissionMode,
    'default',
    'a session started with no mode is ASKING — never reported as Auto'
  )
  eq(fromNothing.model, DEFAULT_MODEL, 'no model → the default sentinel')
  eq(fromNothing.effort, 'auto', 'no effort → the default sentinel')
  eq(fromNothing.provider, DEFAULT_PROVIDER, 'no provider → Claude')
  eq(chatAgentSettingsFromOptions().permissionMode, 'default', 'absent options behave as {}')

  const live = chatAgentSettingsFromOptions({
    model: 'opus',
    effort: 'high',
    provider: 'codex',
    permissionMode: 'acceptEdits'
  })
  eq(live.permissionMode, 'acceptEdits', "main's live mode is reported as-is")
  eq(live.model, 'opus', "main's live model is reported as-is")
  eq(live.provider, 'codex', "main's live backend is reported as-is")

  // Round trip: what we send is what we read back.
  const settings = {
    model: 'sonnet',
    effort: 'high',
    provider: DEFAULT_PROVIDER,
    permissionMode: 'auto'
  }
  const round = chatAgentSettingsFromOptions(agentOptionsFor(settings))
  eq(JSON.stringify(round), JSON.stringify(settings), 'settings → options → settings round-trips')
}

// ── Per-chat lookup falls back to the defaults ──────────────────────────────
{
  eq(chatAgentSettingsFor({}, 'k').permissionMode, 'auto', 'a chat with no stored settings is Auto')
  const entry = { chatSettings: { k: { ...defaultChatAgentSettings(), permissionMode: 'default' } } }
  eq(chatAgentSettingsFor(entry, 'k').permissionMode, 'default', "a stored chat's mode wins")
  eq(chatAgentSettingsFor(entry, 'other').permissionMode, 'auto', 'another chat is unaffected')
}

// ── Resume is Claude-only ───────────────────────────────────────────────────
{
  const claude = { model: 'opus', effort: 'high', provider: 'claude', permissionMode: 'auto' }
  eq(resumeChatSettings(claude), claude, 'a Claude chat resumes exactly as it is')

  const codex = { model: 'gpt-5', effort: 'high', provider: 'codex', permissionMode: 'acceptEdits' }
  const resumed = resumeChatSettings(codex)
  eq(resumed.provider, DEFAULT_PROVIDER, 'resume pins the backend to Claude')
  eq(resumed.model, DEFAULT_MODEL, "another backend's model alias means nothing to Claude")
  eq(resumed.permissionMode, 'acceptEdits', 'the permission posture still carries over')
  eq(resumed.effort, 'high', 'the effort still carries over')
}

if (failed) {
  console.error(`\n${failed} chat-settings assertion(s) failed`)
  process.exit(1)
}
console.log('chat-settings: all assertions passed')
