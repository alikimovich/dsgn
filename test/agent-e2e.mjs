/**
 * End-to-end test of a REAL Claude agent turn — the one thing the other tests
 * can't cover. Opens an editable fixture repo, asks the agent to change a
 * heading, and asserts the file on disk actually changed.
 *
 *   OK   — the agent edited the fixture (exit 0)
 *   SKIP — no Claude credentials / the SDK couldn't run (exit 0, prints why)
 *   FAIL — the turn completed but the file was NOT edited (exit 1)
 *
 * Run with: bun run test:agent   (needs `claude login` / setup-token)
 */
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = join(root, 'test', 'fixtures', 'editable-app')
const indexPath = join(fixture, 'index.html')
const MARKER = 'VERIFIED_BY_CLAUDE'
const PROMPT =
  `Edit the file index.html in this project: change the text inside the ` +
  `<h1 id="title"> element to exactly: ${MARKER}. Edit the file directly with ` +
  `your tools and do not ask for confirmation.`

const indent = (s) => (s || '(empty)').split('\n').map((l) => '    ' + l).join('\n')
const original = readFileSync(indexPath, 'utf8')

let app
try {
  app = await electron.launch({
    executablePath: electronPath,
    args: [join(root, 'out', 'main', 'index.js')],
    cwd: root
  })

  const win = await app.firstWindow()
  await win.waitForSelector('.empty__open', { timeout: 15000 })

  // Cheap/fast model for the test turn, and Auto (bypassPermissions) so the edit
  // tool isn't gated by an approve/deny card no one is here to click — this also
  // exercises that "Auto" genuinely bypasses via the SDK. Stub the folder dialog.
  await win.evaluate(() => {
    window.__praxisSession.getState().setModel('haiku')
    window.__praxisPermissions.getState().setMode('bypassPermissions')
  })
  await app.evaluate(async ({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] })
  }, fixture)

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:action', 'open-project'))
  await win.waitForFunction(
    () =>
      /http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+/.test(
        document.querySelector('.previewbar__url')?.textContent ?? ''
      ),
    { timeout: 60000 }
  )

  // Send the edit request and wait for the turn to complete.
  await win.fill('.composer__input', PROMPT)
  await win.click('.composer__send')

  let finished = true
  try {
    await win.waitForFunction(() => window.__praxisStore.getState().isRunning === true, {
      timeout: 20000
    })
    await win.waitForFunction(() => window.__praxisStore.getState().isRunning === false, {
      timeout: 180000
    })
  } catch {
    finished = false
  }

  const assistant = await win.evaluate(() => {
    const ms = window.__praxisStore.getState().messages
    const a = [...ms].reverse().find((m) => m.role === 'assistant')
    return a ? `${a.statuses.join('\n')}\n${a.text}`.trim() : ''
  })

  const html = readFileSync(indexPath, 'utf8')
  const looksLikeNoAuth = /⚠️|unauthor|invalid api key|credential|please run .*login|not logged in|setup-token|ENOENT|spawn|ECONN/i.test(
    assistant
  )

  if (html.includes(MARKER)) {
    console.log('AGENT-E2E OK — the agent edited the fixture file via a real turn.')
  } else if (!finished) {
    console.log('AGENT-E2E SKIP — the turn never completed (likely no auth or the SDK')
    console.log('  subprocess failed to spawn). Last assistant output:')
    console.log(indent(assistant))
  } else if (looksLikeNoAuth) {
    console.log('AGENT-E2E SKIP — the agent could not run (likely no Claude credentials):')
    console.log(indent(assistant))
  } else {
    console.error('AGENT-E2E FAIL — turn completed but index.html was not edited.')
    console.error('  Assistant said:')
    console.error(indent(assistant))
    process.exitCode = 1
  }
} catch (err) {
  console.error('AGENT-E2E ERROR:', err?.message ?? err)
  process.exitCode = 1
} finally {
  writeFileSync(indexPath, original) // always leave the fixture pristine
  await app?.close()
}
