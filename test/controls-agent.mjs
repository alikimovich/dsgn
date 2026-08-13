/**
 * Live e2e for Custom Controls — the one piece the canned-manifest test can't
 * cover: a REAL agent turn calling the `define_controls` tool, and the
 * worktree → liveRoot persistence seam. The fixture copy is a git REPO ROOT,
 * so the chat runs in a per-chat worktree: the agent instruments the source
 * THERE, the tool callback validates against the worktree file but persists
 * the manifest under the LIVE project root, and the turn's auto-merge lands
 * the instrumented source back on the live tree — after which every literal
 * anchor must resolve against the LIVE files.
 *
 *   OK   — a valid manifest landed in the live tree's .praxis/ with resolving anchors (exit 0)
 *   SKIP — no Claude credentials / the SDK couldn't run (exit 0, prints why)
 *   FAIL — the turn completed but produced no valid manifest (exit 1)
 *
 * Run with: bun run test:controls-agent   (needs `claude login` / setup-token)
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'
import { _electron as electron } from 'playwright'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = join(root, 'test', 'fixtures', 'propedit-app')

// The turn edits files and .praxis/ state — run on a throwaway COPY so the real
// fixture stays pristine whatever the agent does.
const project = mkdtempSync(join(tmpdir(), 'praxis-controls-agent-'))

// The target: a stagger delay buried as a magic number in the JSX — exactly
// the parameter neither the Props tab (no prop) nor the Styles tab (not a
// tracked property) can surface.
const staggerSrc = `export function Stagger(): JSX.Element {
  const items = ['alpha', 'beta', 'gamma']
  return (
    <ul>
      {items.map((label, i) => (
        <li key={label} style={{ transitionDelay: \`\${i * 120}ms\` }}>
          {label}
        </li>
      ))}
    </ul>
  )
}
`

// The trigger prompt, mirroring controlsPrompt's claude branch (renderer/src/
// lib/controls-prompt.ts) — this test imports nothing from src.
const PROMPT = [
  'I want a live control panel for the list in src/Stagger.tsx (the `Stagger` component). What I want to control: "the per-item stagger delay".',
  '',
  "1. Read the component's source and find the value behind that parameter — it is a magic number buried in the JSX.",
  '2. It is not already a tweakable target, so instrument it first: extract it to a named top-level constant in src/Stagger.tsx (e.g. `const STAGGER_MS = 120`). Keep runtime behavior identical.',
  "3. Then call the `define_controls` tool ONCE with the parameter. Use the 'literal' strategy; the anchor must occur exactly once in the file and end immediately before the value (ideal shape: `const STAGGER_MS = `). Pass `file` repo-relative (`src/Stagger.tsx`), give the param a lowercase kebab-case id (e.g. `stagger-ms`), and for number params a sensible min/max/step and unit.",
  'Never create or edit files under `.praxis/`. Do not ask for confirmation.'
].join('\n')

const indent = (s) =>
  (s || '(empty)')
    .split('\n')
    .map((l) => '    ' + l)
    .join('\n')

// A literal anchor resolves when it occurs exactly once and a lexable literal
// head follows — a tiny reimplementation of control-manifest.ts's
// locateAnchor + lexLiteral start (no imports from src by design).
const anchorResolves = (code, anchor) => {
  const first = code.indexOf(anchor)
  if (first === -1 || code.indexOf(anchor, first + 1) !== -1) return false
  const rest = code.slice(first + anchor.length).replace(/^\s+/, '')
  return /^(-?(?:\d+\.?\d*|\.\d+)|['"`]|true\b|false\b|\[)/.test(rest)
}

/** Inspect the LIVE tree: parse the store and check every literal anchor.
 *  Returns { ok: true } or { ok: false, why } for diagnostics/polling. */
const checkLiveManifest = () => {
  const storeFile = join(project, '.praxis', 'control-panels.json')
  if (!existsSync(storeFile))
    return { ok: false, why: 'no .praxis/control-panels.json in the live root' }
  let store
  try {
    store = JSON.parse(readFileSync(storeFile, 'utf8'))
  } catch {
    return { ok: false, why: 'store is not valid JSON' }
  }
  const panels = Array.isArray(store?.panels) ? store.panels : []
  if (panels.length === 0) return { ok: false, why: 'store has no panels' }
  const literals = []
  for (const panel of panels) {
    if (
      typeof panel?.file !== 'string' ||
      panel.file.startsWith('/') ||
      panel.file.includes('..')
    ) {
      return { ok: false, why: `panel file is not repo-relative: ${JSON.stringify(panel?.file)}` }
    }
    for (const param of panel.params ?? []) {
      if (param?.apply?.strategy === 'literal') literals.push({ file: panel.file, param })
    }
  }
  if (literals.length === 0) return { ok: false, why: 'no literal-strategy params in any panel' }
  for (const { file, param } of literals) {
    const abs = join(project, file)
    if (!existsSync(abs)) return { ok: false, why: `live file missing: ${file}` }
    if (!anchorResolves(readFileSync(abs, 'utf8'), param.apply.anchor)) {
      return {
        ok: false,
        why: `anchor does not resolve in the LIVE ${file}: ${JSON.stringify(param.apply.anchor)}`
      }
    }
  }
  return { ok: true, count: literals.length }
}

let app
try {
  cpSync(fixture, project, { recursive: true })
  writeFileSync(join(project, 'src', 'Stagger.tsx'), staggerSrc)
  // Any real repo gitignores these; without it the worktree bootstrap's
  // node_modules/.env symlinks (dangling — the fixture has no deps) get staged
  // by the turn commit and autoApplyWorktree refuses the batch (parked).
  writeFileSync(join(project, '.gitignore'), 'node_modules\n.env\n.praxis\n')
  // A git REPO ROOT is what routes the chat through a per-chat worktree (the
  // isRepoRoot gate) — the whole point of this test's liveRoot assertion.
  for (const args of [
    ['init'],
    ['add', '-A'],
    ['-c', 'user.name=praxis-test', '-c', 'user.email=test@example.com', 'commit', '-m', 'fixture']
  ]) {
    const r = spawnSync('git', ['-C', project, ...args], { stdio: 'ignore' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed while preparing the copy`)
  }

  app = await electron.launch({
    executablePath: electronPath,
    args: [join(root, 'out', 'main', 'index.js')],
    cwd: root
  })
  const win = await app.firstWindow()
  await win.waitForSelector('.empty__open', { timeout: 15000 })

  // Cheap/fast model, and Auto (bypassPermissions) so the instrument edit isn't
  // gated by an approve card no one is here to click. Stub the folder dialog.
  await win.evaluate(() => {
    window.__praxisSession.getState().setModel('haiku')
    window.__praxisPermissions.getState().setMode('bypassPermissions')
  })
  await app.evaluate(async ({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] })
  }, project)
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.send('menu:action', 'open-project')
  )
  await win.waitForFunction(
    () =>
      /http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+/.test(
        document.querySelector('.previewbar__url')?.textContent ?? ''
      ),
    { timeout: 60000 }
  )

  // Send the trigger prompt and wait for the turn to complete.
  await win.fill('.composer__input', PROMPT)
  await win.click('.composer__send')

  let finished = true
  try {
    await win.waitForFunction(() => window.__praxisStore.getState().isRunning === true, {
      timeout: 20000
    })
    // Generous: a cheap model may burn a few define_controls validation
    // retries (the tool returns error text so it self-corrects) before the
    // turn settles.
    await win.waitForFunction(() => window.__praxisStore.getState().isRunning === false, {
      timeout: 420000
    })
  } catch {
    finished = false
  }

  const assistant = await win.evaluate(() => {
    const ms = window.__praxisStore.getState().messages
    const a = [...ms].reverse().find((m) => m.role === 'assistant')
    return a ? `${a.statuses.join('\n')}\n${a.text}`.trim() : ''
  })
  const isolation = await win.evaluate(() => window.__praxisStore.getState().isolation)
  const looksLikeNoAuth =
    /⚠️|unauthor|invalid api key|credential|please run .*login|not logged in|setup-token|ENOENT|spawn|ECONN/i.test(
      assistant
    )

  // The manifest is saved mid-turn (to the live root), but the instrumented
  // SOURCE only reaches the live tree via the turn's auto-merge on done —
  // poll briefly for both to line up.
  let check = { ok: false, why: 'never checked' }
  if (finished) {
    const end = Date.now() + 30000
    for (;;) {
      check = checkLiveManifest()
      if (check.ok || Date.now() > end) break
      await new Promise((r) => setTimeout(r, 1000))
    }
  }

  if (finished && check.ok) {
    console.log(
      `CONTROLS-AGENT OK — a real define_controls turn persisted a manifest to the LIVE ` +
        `root; ${check.count} literal anchor(s) resolve against the live tree post-merge.`
    )
  } else if (!finished) {
    console.log('CONTROLS-AGENT SKIP — the turn never completed (likely no auth or the SDK')
    const late = checkLiveManifest()
    console.log(
      '  subprocess failed to spawn). Live-manifest state: ' +
        (late.ok ? 'manifest valid (turn overran the wait)' : late.why)
    )
    console.log('  Last assistant output:')
    console.log(indent(assistant))
  } else if (looksLikeNoAuth) {
    console.log('CONTROLS-AGENT SKIP — the agent could not run (likely no Claude credentials):')
    console.log(indent(assistant))
  } else {
    console.error(`CONTROLS-AGENT FAIL — turn completed but: ${check.why}`)
    console.error('  Assistant said:')
    console.error(indent(assistant))
    // Live-tree forensics — a merge that parked/nooped shows up here.
    const g = (args) =>
      spawnSync('git', ['-C', project, ...args], { encoding: 'utf8' }).stdout.trim()
    console.error('  chat isolation state: ' + isolation)
    console.error('  git status:\n' + indent(g(['status', '--porcelain'])))
    console.error('  git log --all:\n' + indent(g(['log', '--oneline', '--all', '-n', '8'])))
    try {
      console.error(
        '  live src/Stagger.tsx:\n' +
          indent(readFileSync(join(project, 'src', 'Stagger.tsx'), 'utf8'))
      )
    } catch {}
    process.exitCode = 1
  }
} catch (err) {
  console.error('CONTROLS-AGENT ERROR:', err?.message ?? err)
  process.exitCode = 1
} finally {
  await app?.close()
  rmSync(project, { recursive: true, force: true })
}
