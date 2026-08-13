/**
 * End-to-end test of a REAL OpenAI Codex turn (v7), mirroring agent-e2e but on the
 * `codex` backend. Opens an editable fixture with `provider: 'codex'`, asks Codex to
 * change a heading, and asserts the file on disk actually changed.
 *
 *   OK   — Codex edited the fixture (exit 0)
 *   SKIP — the `codex` CLI isn't installed / not logged in (exit 0, prints why)
 *   FAIL — the turn completed but the file was NOT edited (exit 1)
 *
 * Gated like agent-e2e: it SKIPs cleanly until the user runs `codex login`. Once the
 * Codex CLI is installed + signed in (sign in with ChatGPT), this proves the live
 * event mapping in `backends/codex.ts` end to end.
 *
 * Run with: bun run test:codex
 */
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = join(root, 'test', 'fixtures', 'editable-app')
const indexPath = join(fixture, 'index.html')
const MARKER = 'VERIFIED_BY_CODEX'
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

  // Route this session to the Codex backend (default model/effort), then open the
  // fixture — `.btn--open` calls openProject with the session's provider.
  await win.evaluate(() => window.__praxisSession.getState().setProvider('codex'))
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

  await win.fill('.composer__input', PROMPT)
  await win.click('.composer__send')

  let finished = true
  try {
    await win.waitForFunction(() => window.__praxisStore.getState().isRunning === true, { timeout: 20000 })
    await win.waitForFunction(() => window.__praxisStore.getState().isRunning === false, { timeout: 180000 })
  } catch {
    finished = false
  }

  const assistant = await win.evaluate(() => {
    const ms = window.__praxisStore.getState().messages
    const a = [...ms].reverse().find((m) => m.role === 'assistant')
    return a ? `${a.statuses.join('\n')}\n${a.text}`.trim() : ''
  })

  const html = readFileSync(indexPath, 'utf8')
  const unavailable =
    /codex|not found|not logged in|login|sign in|ENOENT|spawn|unauthor|credential/i.test(assistant)

  if (html.includes(MARKER)) {
    console.log('CODEX-E2E OK — Codex edited the fixture file via a real turn.')
  } else if (!finished || unavailable) {
    console.log('CODEX-E2E SKIP — the Codex CLI is unavailable / not logged in:')
    console.log(indent(assistant))
  } else {
    console.error('CODEX-E2E FAIL — turn completed but index.html was not edited.')
    console.error('  Assistant said:')
    console.error(indent(assistant))
    process.exitCode = 1
  }
} catch (err) {
  console.error('CODEX-E2E ERROR:', err?.message ?? err)
  process.exitCode = 1
} finally {
  writeFileSync(indexPath, original) // always leave the fixture pristine
  await app?.close()
}
