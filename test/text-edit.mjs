/**
 * Inline text-edit engine test — through real IPC (no dev server/auth):
 *  - text.apply rewrites a plain-text element's content in source.
 *  - an expression child ({props.label}) falls back to the agent (needsAgent).
 *  - the App dispatches that fallback as a detached background text-edit agent,
 *    leaving both the composer and visible chat untouched.
 *
 * Run with: bun run test:text
 */
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = join(root, 'test', 'fixtures', 'propedit-app')
const badge = join(fixture, 'src', 'Badge.tsx')
const original = readFileSync(badge, 'utf8')
const userData = mkdtempSync(join(tmpdir(), 'praxis-text-edit-ud-'))

let app
try {
  app = await electron.launch({
    executablePath: electronPath,
    args: [join(root, 'out', 'main', 'index.js')],
    cwd: root,
    env: { ...process.env, PRAXIS_USER_DATA: userData }
  })
  const win = await app.firstWindow()
  await win.waitForSelector('.empty__open', { timeout: 15000 })
  await win.evaluate(() => window.__praxisWorkspace.getState().openOrActivate('/tmp/praxis-test-project'))
  await win.waitForSelector('.composer__input', { timeout: 15000 })

  // Plain-text <h1>Welcome</h1> at Badge.tsx:25 → text rewritten in source.
  const res = await win.evaluate(
    (args) => window.api.text.apply(args.fixture, { source: 'src/Badge.tsx:25', text: 'Hello there' }),
    { fixture }
  )
  if (!res.applied) throw new Error(`text apply not applied: ${JSON.stringify(res)}`)
  const after = readFileSync(badge, 'utf8')
  if (!after.includes('>Hello there<')) throw new Error('source text was not rewritten')
  if (after.includes('>Welcome<')) throw new Error('old text still present')

  // Expression child {props.label} → can't splice, hands off to the agent.
  const expr = await win.evaluate(
    (args) => window.api.text.apply(args.fixture, { source: 'src/Badge.tsx:13', text: 'nope' }),
    { fixture }
  )
  if (expr.applied || !expr.needsAgent) {
    throw new Error(`expression text should need the agent: ${JSON.stringify(expr)}`)
  }

  // Replace only the spawn IPC handler with a deterministic capture. The real
  // text:apply engine above still decides this expression needs an agent; App must
  // automatically dispatch it with the text-edit origin instead of seeding chat.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('agent:spawn-comment')
    ipcMain.handle(
      'agent:spawn-comment',
      (_e, root, text, parentSessionKey, options, origin) => {
        globalThis.__praxisTextSpawn = { root, text, parentSessionKey, options, origin }
        return {
          ok: true,
          spawnId: 'text-edit-bg',
          branch: 'praxis/comment-text-edit-bg'
        }
      }
    )
  })
  const KEY = 'text-edit-parent'
  await win.evaluate(
    ({ fixture, key }) => {
      window.__praxisSession.getState().setProjectRoot(fixture)
      window.__praxisStore.getState().setActiveChat(key)
      window.__praxisStore.getState().clearChat(key)
      window.__praxisComposer.getState().setSeed(null)
    },
    { fixture, key: KEY }
  )
  await app.evaluate(({ BrowserWindow }, edit) => {
    BrowserWindow.getAllWindows()[0].webContents.send('preview:text-edit', edit)
  }, { source: 'src/Badge.tsx:13', text: 'Background rename' })
  await win.waitForFunction(
    (key) =>
      window.__praxisSpawns.getState().byKey[key]?.some((r) => r.id === 'text-edit-bg'),
    KEY,
    { timeout: 4000 }
  )

  const dispatched = await app.evaluate(() => globalThis.__praxisTextSpawn)
  if (dispatched?.origin !== 'text-edit') {
    throw new Error(`text fallback should be marked text-edit: ${JSON.stringify(dispatched)}`)
  }
  if (!/change only the selected element's rendered text/i.test(dispatched?.text ?? '')) {
    throw new Error(`background prompt should constrain the edit: ${dispatched?.text}`)
  }
  const composer = await win.inputValue('.composer__input')
  if (composer !== '') throw new Error(`background edit must not seed the composer: ${composer}`)
  const beforeMessages = await win.evaluate(
    (key) => window.__praxisStore.getState().byKey[key]?.messages.length ?? 0,
    KEY
  )

  // Completion removes the running row and writes only to the activity log—not chat.
  await app.evaluate(({ BrowserWindow }, ev) => {
    BrowserWindow.getAllWindows()[0].webContents.send('agent:event', ev)
  }, {
    type: 'spawn-finished',
    projectKey: KEY,
    sessionId: 'text-edit-bg',
    branch: null,
    origin: 'text-edit',
    files: ['Badge.tsx'],
    summary: 'Changed the shared label.'
  })
  await win.waitForFunction(
    (key) => !(window.__praxisSpawns.getState().byKey[key] ?? []).some((r) => r.id === 'text-edit-bg'),
    KEY,
    { timeout: 4000 }
  )
  const afterMessages = await win.evaluate(
    (key) => window.__praxisStore.getState().byKey[key]?.messages.length ?? 0,
    KEY
  )
  if (afterMessages !== beforeMessages) {
    throw new Error(`background text completion must not post in chat: ${beforeMessages} → ${afterMessages}`)
  }
  const activity = await win.evaluate(() =>
    window.__praxisLog.getState().lines.map((line) => line.text).join('\n')
  )
  if (!/Background text edit applied · Badge\.tsx/.test(activity)) {
    throw new Error(`background text completion should reach activity log: ${activity}`)
  }

  console.log(
    'TEXT-EDIT OK — plain text rewritten; expression → detached agent with composer/chat untouched'
  )
} catch (err) {
  console.error('TEXT-EDIT FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  writeFileSync(badge, original) // leave the fixture pristine
  await app?.close()
  rmSync(userData, { recursive: true, force: true })
}
