#!/usr/bin/env node
// Test runner for Praxis. Replaces the old &&-mega-chains in package.json.
//
// Usage: node test/run.mjs <tiers...>   where tier ∈ unit | electron | live | all
//
//   unit     — pure-bun logic tests (no build, no display). Run with `bun`.
//   electron — Playwright/Electron UI tests. `electron-vite build` runs ONCE
//              before the tier, then each test runs with `node`.
//   live     — agent/codex/sim e2e. Need creds/display; they self-SKIP (exit 0)
//              without them, which the runner counts as a pass. Run with `node`.
//   all      — unit + electron + live.
//
// Behavior: spawn each test as a subprocess, KEEP GOING on failure, treat
// exit code 0 as PASS (the e2e self-SKIP convention is exit 0 → pass), print a
// summary table at the end, and exit non-zero if any test FAILED.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(TEST_DIR);

// --- Tier membership (derived from package.json `test` and `verify` scripts) ---

// unit = the `bun test/NAME.mjs` group before `electron-vite build` in `test`.
const UNIT = [
  'pr-body',
  'feedback-body',
  'publish-message',
  'slash-token',
  'skills-discovery',
  'github-connect',
  'html-source',
  'project-key',
  'project-create',
  'devserver-net',
  'xcode',
  'git',
  'sidecar-migrate',
  'diag-cache',
  'diag-rules',
  'sessions-store',
  'chat-title',
  'chat-settings',
  'run-stats',
  'edit-history',
  'worktrees',
  'chat-worktrees',
  'live-commit',
  'file-tree',
  'file-ops',
  'rules',
  'tw-classes',
  'tw-styles',
  'token-match',
  'layers-move',
  'inline-style',
  'css-values',
  'elide-url',
  'control-panels',
  'svelte-instance',
  'docs-links',
  'update',
  'spring',
  'apca',
  'fluid',
  'oklch',
  'shadows',
  'type-metrics',
  'skills-install',
  'praxis-cli',
];

// electron = the `node test/NAME.mjs` group AFTER `electron-vite build` in `test`.
const ELECTRON = [
  'smoke',
  'menu-recents',
  'open-preview',
  'mobile-frame',
  'viewport-per-project',
  'rail',
  'rail-collapse',
  'chat-hide',
  'editor-search',
  'rail-chat-overflow',
  'devserver-multi',
  'static-serve',
  'agent-multi',
  'agent-cap',
  'provider-seam',
  'agent-history',
  'history-ui',
  'chat-render',
  'revert-action',
  'chat-route',
  'restore-reload',
  'preview-location',
  'feedback-dialog',
  'connect-dialog',
  'html-text-edit',
  'questions',
  'diagnose-card',
  'select-element',
  'comment-mode',
  'spawn-comment',
  'chat-isolation',
  'prop-edit',
  'style-edit',
  'layers-panel',
  'custom-controls',
  'prop-edit-svelte',
  'prop-svelte-self',
  'code-peek',
  'code-drawer',
  'annotations',
  'tokens',
  'tokens-scaffold',
  'ready-gating',
  'text-edit',
  'text-edit-svelte',
  'setup-detect',
  'setup-restart',
  'sim-detect',
  'sim-preflight',
  'sim-frame',
  'sim-control',
];

// live = the tests present in `verify` but not in `test`.
const LIVE = [
  'agent-e2e',
  'codex-e2e',
  'controls-agent',
  'tool-invocation',
  'sim-e2e',
  'style-provenance',
];

const TIERS = {
  unit: { runner: 'bun', build: false, tests: UNIT },
  electron: { runner: 'node', build: true, tests: ELECTRON },
  live: { runner: 'node', build: false, tests: LIVE },
};

const TIER_ORDER = ['unit', 'electron', 'live'];

// --- Arg parsing ---

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('usage: node test/run.mjs <tiers...>  (unit | electron | live | all)');
  process.exit(2);
}

const selected = new Set();
for (const arg of args) {
  if (arg === 'all') {
    for (const t of TIER_ORDER) selected.add(t);
  } else if (TIERS[arg]) {
    selected.add(arg);
  } else {
    console.error(`unknown tier: ${arg}  (expected unit | electron | live | all)`);
    process.exit(2);
  }
}

// --- Run ---

function fmtDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function runOne(runner, name) {
  const file = join(TEST_DIR, `${name}.mjs`);
  const started = Date.now();
  // Each Electron test gets its own throwaway userData (main honors
  // PRAXIS_USER_DATA): persisted state (workspace/recents localStorage) can't leak
  // between tests — boot restore would otherwise auto-reopen a prior test's
  // project — and each launch holds its own single-instance lock.
  const userData = mkdtempSync(join(tmpdir(), `praxis-test-${name}-`));
  let res;
  try {
    res = spawnSync(runner, [file], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, PRAXIS_USER_DATA: userData },
    });
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
  const duration = Date.now() - started;
  // spawnSync sets .error on spawn failure (e.g. runner not found) and .signal
  // when killed by a signal; both are failures. Exit 0 (incl. e2e SKIP) = pass.
  const ok = !res.error && res.signal == null && res.status === 0;
  return { name, ok, duration, status: res.status, signal: res.signal, error: res.error };
}

function build() {
  console.log('\n=== electron-vite build ===');
  const res = spawnSync('electron-vite', ['build'], { cwd: ROOT, stdio: 'inherit' });
  if (res.error || res.signal != null || res.status !== 0) {
    console.error('electron-vite build FAILED — cannot run electron tier.');
    return false;
  }
  return true;
}

const results = [];
let buildFailed = false;

for (const tier of TIER_ORDER) {
  if (!selected.has(tier)) continue;
  const { runner, build: needsBuild, tests } = TIERS[tier];

  console.log(`\n########## tier: ${tier} (${tests.length} tests) ##########`);

  if (needsBuild) {
    if (!build()) {
      // Mark every test in this tier as failed and skip running them.
      buildFailed = true;
      for (const name of tests) {
        results.push({ tier, name, ok: false, duration: 0, note: 'build failed' });
      }
      continue;
    }
  }

  for (const name of tests) {
    console.log(`\n--- [${tier}] ${name} ---`);
    const r = runOne(runner, name);
    results.push({ tier, ...r });
  }
}

// --- Summary ---

const nameWidth = Math.max(...results.map((r) => r.name.length), 4);
console.log('\n' + '='.repeat(nameWidth + 24));
console.log('  SUMMARY');
console.log('='.repeat(nameWidth + 24));

let failed = 0;
for (const r of results) {
  const status = r.ok ? 'PASS' : 'FAIL';
  if (!r.ok) failed++;
  const dur = r.duration ? fmtDuration(r.duration) : '';
  const note = r.note ? `  (${r.note})` : '';
  console.log(`  ${status}  ${r.name.padEnd(nameWidth)}  ${dur.padStart(7)}${note}`);
}

console.log('='.repeat(nameWidth + 24));
const total = results.length;
console.log(`  ${total - failed}/${total} passed, ${failed} failed`);
console.log('='.repeat(nameWidth + 24) + '\n');

process.exit(failed > 0 || buildFailed ? 1 : 0);
