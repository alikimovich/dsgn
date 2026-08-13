/**
 * Inline text-edit engine test — through real IPC (no dev server/auth):
 *  - text.apply rewrites a plain-text element's content in source.
 *  - an expression child ({props.label}) falls back to the agent (needsAgent).
 *
 * Run with: bun run test:text
 */
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = join(root, 'test', 'fixtures', 'propedit-app')
const badge = join(fixture, 'src', 'Badge.tsx')
const original = readFileSync(badge, 'utf8')

let app
try {
  app = await electron.launch({
    executablePath: electronPath,
    args: [join(root, 'out', 'main', 'index.js')],
    cwd: root
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

  console.log('TEXT-EDIT OK — plain text rewritten to source, expression → agent')
} catch (err) {
  console.error('TEXT-EDIT FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  writeFileSync(badge, original) // leave the fixture pristine
  await app?.close()
}
