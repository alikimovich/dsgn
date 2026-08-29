/**
 * praxis agent rules (v9 R) — pure unit test of the rules builder. Runs under bun
 * (no electron), like project-key/xcode/git.
 *
 * Run with: bun test/rules.mjs
 */
import { PRAXIS_RULES_VERSION, praxisRules } from '../src/main/rules.ts'

let failed = 0
const assert = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    failed++
  }
}

const r = praxisRules()
assert(typeof r === 'string' && r.length > 0, 'rules render to a non-empty string')
assert(typeof PRAXIS_RULES_VERSION === 'number', 'version is a number')
assert(PRAXIS_RULES_VERSION === 12, 'version bumped to 12')
assert(r.includes(`v${PRAXIS_RULES_VERSION}`), 'rules carry the version marker')
// v3 naming — the product is Praxis in the rule text now.
assert(/praxis/i.test(r), 'names the product Praxis')
assert(!/\bdsgn operating rules\b/i.test(r), 'no stale "dsgn operating rules" header')
// v3 context — designer pointing at UI, selections carry data-praxis-source, hot-reload.
assert(/data-praxis-source/.test(r), 'context mentions the data-praxis-source stamp')
assert(/hot-reload/i.test(r), 'context mentions instant hot-reload')
// R1 — scope of an element edit.
assert(/scope of an element edit/i.test(r), 'R1: scope-of-edit heading present')
assert(/\blocal\b/i.test(r) && /project-wide/i.test(r), 'R1: local vs project-wide distinction')
assert(/search first|grep/i.test(r), 'R1: search-first guidance')
assert(/report/i.test(r), 'R1: report-what-changed guidance')
// R-git (v10) — Praxis owns git state; the agent must not fight the worktree
// machinery (turn-end squash rewrites hashes; manual branch moves diverge).
assert(/git is praxis-managed/i.test(r), 'R-git: heading present')
assert(/praxis\/chat-/.test(r), 'R-git: names the chat worktree branch scheme')
assert(/squash/i.test(r), 'R-git: explains the turn-end squash')
assert(/reset --hard/.test(r), 'R-git: forbids hard-resetting the live checkout')
assert(/status, log, diff/i.test(r), 'R-git: read-only git allowed')
// R2: browser inspection → agent-browser, never Chrome DevTools unless asked.
assert(/agent-browser/i.test(r), 'R2: directs the agent to agent-browser')
assert(
  /devtools/i.test(r) && /unless the user explicitly asks/i.test(r),
  'R2: no DevTools unless asked'
)
// Deterministic (same output every call — safe to inject per turn).
assert(praxisRules() === r, 'praxisRules is deterministic')

const withMemory = praxisRules({ projectMemory: '- Use praxis/master as integration.' })
assert(/project memory/i.test(withMemory), 'memory: durable context section present')
assert(/Use praxis\/master as integration/.test(withMemory), 'memory: saved decision injected')
assert(!/<project-memory>/.test(r), 'memory: empty default adds no section')

// R3 — preview tools appear ONLY when previewTools is requested (Claude), never
// for the plain (Codex/Gemini) rendering.
const withTools = praxisRules({ previewTools: true })
assert(/preview_location/.test(withTools), 'previewTools: mentions preview_location')
assert(/preview_screenshot/.test(withTools), 'previewTools: mentions preview_screenshot')
assert(/seeing the user's preview/i.test(withTools), 'previewTools: has the preview section')
assert(!/preview_location/.test(r), 'default rendering omits preview_location')
assert(!/preview_screenshot/.test(r), 'default rendering omits preview_screenshot')
assert(praxisRules({ previewTools: true }) === withTools, 'previewTools rendering is deterministic')
// The agent-browser section survives in both renderings.
assert(/agent-browser/.test(withTools), 'previewTools: still keeps agent-browser guidance')
// R4 (v10) — custom-controls section rides with the Claude-only in-process tools:
// define_controls exists only on the praxis SDK server, so backends without
// previewTools must never be told to call it.
assert(/define_controls/.test(withTools), 'previewTools: teaches define_controls')
assert(/const STAGGER_MS = /.test(withTools), 'previewTools: shows the ideal anchor shape')
assert(/\.praxis\//.test(withTools), 'previewTools: forbids writing under .praxis/')
assert(!/define_controls/.test(r), 'default rendering omits define_controls')
// R5 (spring) — spring_to_css rides with the Claude-only in-process tools too.
assert(/spring_to_css/.test(withTools), 'previewTools: teaches spring_to_css')
assert(/prefers-reduced-motion/.test(withTools), 'previewTools: spring reduced-motion guidance')
assert(!/spring_to_css/.test(r), 'default rendering omits spring_to_css')
// R6 (accessible colors) — check_contrast rides with the Claude-only in-process tools.
assert(/check_contrast/.test(withTools), 'previewTools: teaches check_contrast')
assert(/APCA/.test(withTools), 'previewTools: mentions APCA')
assert(!/check_contrast/.test(r), 'default rendering omits check_contrast')
// R7 (design-system calculators) — fluid/color/shadow tools ride with previewTools too.
assert(/fluid_clamp/.test(withTools), 'previewTools: teaches fluid_clamp')
assert(/color_scale/.test(withTools), 'previewTools: teaches color_scale')
assert(/layered_shadow/.test(withTools), 'previewTools: teaches layered_shadow')
assert(!/fluid_clamp/.test(r), 'default rendering omits fluid_clamp')
// R8a (line-height) — size-aware line_height calculator rides with previewTools.
// v9: promoted to its own trigger-first section ("Whenever you write or change
// text styles…") — the buried calculator bullet never made the agent reach for it
// (caught by test/tool-invocation.mjs).
assert(/line_height/.test(withTools), 'previewTools: teaches line_height')
assert(
  /type metrics \(line_height\)/i.test(withTools),
  'previewTools: line_height has its own section'
)
assert(
  /whenever you write or change text styles/i.test(withTools),
  'previewTools: line_height trigger-first phrasing'
)
assert(!/line_height/.test(r), 'default rendering omits line_height')
// R8b (skills install) — offer-to-install skill packs rides with previewTools too.
assert(/list_recommended_skills/.test(withTools), 'previewTools: teaches list_recommended_skills')
assert(/install_skills/.test(withTools), 'previewTools: teaches install_skills')
assert(!/install_skills/.test(r), 'default rendering omits install_skills')

// R9 (Codex Praxis control) — workspace tools appear only for a backend that
// actually wires the local MCP server. The generic/Gemini prompt must not claim
// tools it cannot call.
const withWorkspaceTools = praxisRules({ workspaceTools: true })
assert(/workspace_state/.test(withWorkspaceTools), 'workspaceTools: teaches authoritative status')
assert(
  /prepare_conflict_resolution/.test(withWorkspaceTools),
  'workspaceTools: teaches safe conflict preparation'
)
assert(
  /do not tell the user to open a terminal/i.test(withWorkspaceTools),
  'workspaceTools: forbids terminal handoff'
)
assert(!/workspace_state/.test(r), 'default rendering omits workspace_state')

if (failed) {
  console.error(`RULES FAILED — ${failed} assertion(s)`)
  process.exit(1)
}
console.log(
  `RULES OK — v${PRAXIS_RULES_VERSION} builder, Praxis naming, R1 scope + preview-tools gating, deterministic`
)
