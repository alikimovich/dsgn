/**
 * Does the always-on rules text actually make the agent CALL the praxis design
 * tools? Every other test proves the tools work when invoked; this one proves
 * they get invoked at all — spontaneously, from a natural design request, with
 * no mention of the tool name in the prompt.
 *
 * That distinction is the whole point: the prompts below are ordinary things a
 * designer would type. If the agent picks the tool, the rules in src/main/rules.ts
 * are doing their job. If it hand-writes a hex or a line-height instead, the
 * push isn't landing and the tool is dead weight.
 *
 *   OK   — every probed tool fired (exit 0)
 *   SKIP — no Claude credentials / the SDK couldn't run (exit 0, prints why)
 *   FAIL — a turn completed but the tool was never called (exit 1)
 *
 * Run with: bun run test:tool-invocation   (needs `claude login` / setup-token)
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'
import { _electron as electron } from 'playwright'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = join(root, 'test', 'fixtures', 'editable-app')
const indexPath = join(fixture, 'index.html')

// Natural design asks. NONE of them names a tool — naming one would test the
// SDK's tool dispatch, which we already know works, instead of the rules.
const PROBES = [
  {
    tool: 'mcp__praxis__check_contrast',
    label: 'check_contrast (APCA)',
    prompt:
      'The h1 in index.html is plain black. Make it a warm amber that still reads ' +
      'clearly on the white background. Edit the file directly, do not ask for confirmation.'
  },
  {
    tool: 'mcp__praxis__line_height',
    label: 'line_height (type metrics)',
    prompt:
      'Add a paragraph of body copy under the h1 in index.html and give it a ' +
      'sensible line-height for reading. Edit the file directly, do not ask for confirmation.'
  }
]

// `node test/tool-invocation.mjs line_height` probes one tool in a fresh session —
// useful to confirm a failure isn't an artifact of running second, after an interrupt.
const only = process.argv[2]
const probes = only ? PROBES.filter((p) => p.tool.includes(only)) : PROBES
if (probes.length === 0) {
  console.error(`No probe matches "${only}". Known: ${PROBES.map((p) => p.tool).join(', ')}`)
  process.exit(1)
}

const indent = (s) =>
  (s || '(empty)')
    .split('\n')
    .map((l) => '    ' + l)
    .join('\n')
const original = readFileSync(indexPath, 'utf8')

let app
try {
  app = await electron.launch({
    executablePath: electronPath,
    args: [join(root, 'out', 'main', 'index.js')],
    cwd: root
  })

  const win = await app.firstWindow()
  // Boot state is NOT deterministic: the app restores its last session, so it
  // lands either on the empty/recents screen or straight into a restored project.
  // Wait for whichever shell rendered rather than assuming one.
  await win.waitForFunction(
    () => !!document.querySelector('.empty__open') || !!document.querySelector('.rail__action'),
    { timeout: 30000 }
  )

  await app.evaluate(async ({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] })
  }, fixture)
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.send('menu:action', 'open-project')
  )

  // Wait for THIS fixture to be the active project — a restored project from a
  // previous run would otherwise satisfy a bare "preview has a URL" check. The
  // store globals only exist once a project is active, hence the optional chain.
  await win.waitForFunction(
    () => (window.__praxisSession?.getState().projectRoot ?? '').includes('editable-app'),
    { timeout: 90000 }
  )
  await win.waitForFunction(
    () =>
      /http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+/.test(
        document.querySelector('.previewbar__url')?.textContent ?? ''
      ),
    { timeout: 60000 }
  )

  // Sonnet, not haiku: a weak model failing to follow the rules would confound
  // "the rules don't land" with "the model can't". Auto mode so the edit tool
  // isn't gated by an approve/deny card no one is here to click. Set AFTER the
  // project opens — opening activates a chat, which restores that chat's own
  // model/mode and would clobber these.
  await win.evaluate(() => {
    window.__praxisSession.getState().setModel('sonnet')
    window.__praxisPermissions.getState().setMode('bypassPermissions')
  })

  const results = []
  let skipReason = ''

  for (const probe of probes) {
    // Status lines are `describeTool()` output — "<name> · <detail>" — pushed onto
    // the assistant message. Snapshot the count first so we only read THIS turn's.
    const before = await win.evaluate(() => window.__praxisStore.getState().messages.length)

    await win.fill('.composer__input', probe.prompt)
    await win.click('.composer__send')

    // The assertion is "did the agent reach for this tool", not "did the turn
    // finish" — so stop at the first sighting instead of waiting out the whole
    // edit. Resolves as soon as EITHER the tool fires or the turn ends without it.
    let timedOut = false
    try {
      await win.waitForFunction(
        ({ tool, n }) => {
          const st = window.__praxisStore.getState()
          const seen = st.messages
            .slice(n)
            .flatMap((m) => m.statuses ?? [])
            .some((s) => s.startsWith(tool))
          return seen || st.isRunning === false
        },
        { tool: probe.tool, n: before },
        { timeout: 300000, polling: 500 }
      )
    } catch {
      timedOut = true
    }

    const turn = await win.evaluate((n) => {
      const ms = window.__praxisStore.getState().messages.slice(n)
      return {
        statuses: ms.flatMap((m) => m.statuses ?? []),
        text: ms
          .filter((m) => m.role === 'assistant')
          .map((m) => m.text)
          .join('\n')
      }
    }, before)

    const called = turn.statuses.some((s) => s.startsWith(probe.tool))
    // A turn that produced real tool calls or assistant prose is authenticated —
    // only an empty, failed turn means "no credentials". Don't let a slow turn
    // masquerade as a skip.
    const ranAtAll = turn.statuses.length > 0 || turn.text.trim().length > 0
    const looksLikeNoAuth =
      !ranAtAll ||
      /unauthor|invalid api key|please run .*login|not logged in|setup-token|ECONN/i.test(turn.text)

    // Leave the session idle so the next probe starts from a clean turn.
    await win.evaluate(() => window.api.agent.interrupt())
    await win
      .waitForFunction(() => window.__praxisStore.getState().isRunning === false, {
        timeout: 30000
      })
      .catch(() => {})

    if (called) {
      results.push({ ...probe, state: 'OK', turn })
    } else if (looksLikeNoAuth) {
      skipReason = 'the agent produced no output'
      results.push({ ...probe, state: 'SKIP', turn })
      break
    } else {
      // Either the turn ended without touching the tool, or it ran past the cap
      // while never reaching for it. Both are the same verdict; note which.
      results.push({ ...probe, state: 'FAIL', turn, timedOut })
    }
  }

  console.log('')
  // Always show what was actually called — a bare OK/FAIL hides whether the tool
  // fired for the right reason, and the tool list is the evidence for the claim.
  for (const r of results) {
    console.log(`  ${r.state.padEnd(4)}  ${r.label}`)
    const called = [...new Set(r.turn.statuses.map((s) => s.split(' · ')[0]))]
    console.log('        tools called this turn:')
    console.log(indent(called.join('\n') || '(none)').replace(/^/gm, '    '))
    const hit = r.turn.statuses.find((s) => s.startsWith(r.tool))
    if (hit) console.log(`        → ${hit}`)
    if (r.timedOut) console.log('        (turn hit the time cap without calling it)')
  }
  console.log('')

  if (results.some((r) => r.state === 'SKIP')) {
    console.log(`TOOL-INVOCATION SKIP — ${skipReason} (likely no Claude credentials).`)
    console.log(indent(results.at(-1).turn.text))
  } else if (results.every((r) => r.state === 'OK')) {
    console.log('TOOL-INVOCATION OK — the rules made the agent reach for every probed tool.')
  } else {
    const missed = results.filter((r) => r.state === 'FAIL').map((r) => r.label)
    console.error(`TOOL-INVOCATION FAIL — never called: ${missed.join(', ')}`)
    process.exitCode = 1
  }
} catch (err) {
  console.error('TOOL-INVOCATION ERROR:', err?.message ?? err)
  // Dump enough to tell a harness problem (never got a project open) apart from
  // a real one, without needing an interactive re-run.
  try {
    const win = await app?.firstWindow()
    console.error(
      '  app state:',
      JSON.stringify(
        await win?.evaluate(() => ({
          projectRoot: window.__praxisSession?.getState().projectRoot ?? null,
          urlbar: document.querySelector('.previewbar__url')?.textContent ?? null,
          emptyScreen: !!document.querySelector('.empty__open')
        }))
      )
    )
    await win?.screenshot({ path: join(root, 'test', 'artifacts', 'tool-invocation-error.png') })
  } catch {
    /* the window is already gone — the message above is all we get */
  }
  process.exitCode = 1
} finally {
  writeFileSync(indexPath, original) // always leave the fixture pristine
  await app?.close()
}
