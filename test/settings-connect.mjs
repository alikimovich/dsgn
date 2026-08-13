/**
 * The Settings → Models & Providers "Connect" probe must always REACH AN END.
 *
 * The bug this exists for: `ProviderForm` gates every outcome on a `live` ref that
 * was only ever set to `false` (on unmount) and never back to `true` on mount.
 * React.StrictMode (on, see `main.tsx`) double-invokes mount effects as
 * mount → cleanup → mount, and a ref survives that cycle — so `live.current` was
 * permanently false and `stale()` permanently true. The probe could then neither
 * render a catalog, nor show an error, nor fire its own 12s deadline: the button
 * sat on "Connecting…" forever against a perfectly healthy endpoint. Two rounds of
 * "hardening" missed it because both kept the broken ref, and no test drove the
 * real dialog.
 *
 * So this drives the actual UI and only asserts the thing that matters: press
 * Connect, and within the deadline the form is out of the probing state with
 * something to show. It points at a closed local port, so it needs no network and
 * no key — a connection refused is a perfectly good "reached an end".
 *
 * What this canNOT reach: the case where the IPC reply never arrives at all. The
 * preload bridge is frozen, so a test can't stub `providers.catalog` to hang, and
 * main always answers within its own 10s abort. That path is covered structurally
 * instead — a deadline driven by the rendered `inFlight` state rather than by a
 * closure, so there is nothing to disown (see ProviderForm).
 *
 * Run with: bun run test:settings-connect
 */
import assert from 'node:assert'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'
import { _electron as electron } from 'playwright'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = join(root, 'test', 'artifacts')
mkdirSync(artifacts, { recursive: true })

let app
try {
  app = await electron.launch({
    executablePath: electronPath,
    args: [join(root, 'out', 'main', 'index.js')],
    cwd: root
  })

  const win = await app.firstWindow()
  await win.waitForSelector('.empty__open', { timeout: 15000 })

  // Open Settings through the store, so this doesn't depend on where the entry
  // point lives in the chrome (picker row today, menu item tomorrow).
  await win.evaluate(() => window.__praxisProviders.getState().setSettingsOpen(true))
  await win.waitForSelector('text=Models & Providers', { timeout: 10000 })

  // Start a new connection if the dialog opened on the list rather than the form.
  const addBtn = win.locator('button', { hasText: /Add connection/i })
  if (await addBtn.count()) await addBtn.first().click()
  await win.waitForSelector('#provider-label', { timeout: 10000 })

  // A custom endpoint pointed at a closed local port: no network, fails fast.
  // The preset radios carry no `value`, so go through their labels.
  await win.locator('label', { hasText: 'Custom' }).locator('input[type="radio"]').click()
  await win.waitForSelector('#provider-base-url', { timeout: 5000 })
  await win.locator('#provider-base-url').fill('http://127.0.0.1:9/v1')
  await win.locator('#provider-label').fill('Dead endpoint')
  await win.locator('#provider-key').fill('sk-not-a-real-key')

  const connect = win.locator('button', { hasText: /^Connect/ }).first()
  await connect.click()

  // The whole point: it must stop probing. The renderer's own deadline is 12s, so
  // 20s is a generous ceiling — before the fix this never resolved at all.
  await win.waitForFunction(() => !/Connecting/.test(document.body.innerText), undefined, {
    timeout: 20000
  })

  const text = await win.evaluate(() => document.body.innerText)
  assert.ok(
    !/Connecting/.test(text),
    'the Connect button must leave the probing state, not sit on "Connecting…"'
  )
  // And it must SAY something — silently going idle would be its own dead end.
  assert.ok(
    /Could not reach|No answer from|refused|ECONNREFUSED|not valid/i.test(text),
    `expected a readable failure after probing a closed port; got: ${text.slice(0, 400)}`
  )

  await win.screenshot({ path: join(artifacts, 'settings-connect.png') })
  console.log('SETTINGS-CONNECT OK — the probe reaches an end and explains itself')
} catch (err) {
  console.error('SETTINGS-CONNECT FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  await app?.close().catch(() => {})
}
