/**
 * Inline comment/annotation modes — end to end, through the real IPC and the
 * preview WebContentsView (no human):
 *
 *   open fixture → arm Comment mode → trusted click on a stamped element →
 *   the inline composer appears in the overlay's shadow root → type + send →
 *   the comment reaches the agent (a user turn referencing the element).
 *
 *   then arm Annotate mode → click + type + send → an annotation pin is stored
 *   (no agent turn).
 *
 * The preview is a separate CDP target, so we reach it via the main process
 * (`webContents.executeJavaScript` / `sendInputEvent`) like select-element.mjs.
 *
 * Run with: bun run test:comment
 */
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = join(root, 'test', 'fixtures', 'selectable-app')
const artifacts = join(root, 'test', 'artifacts')
mkdirSync(artifacts, { recursive: true })

const EXPECTED_SOURCE = 'src/components/Hero.tsx:7'

let app
try {
  app = await electron.launch({
    executablePath: electronPath,
    args: [join(root, 'out', 'main', 'index.js')],
    cwd: root
  })
  const win = await app.firstWindow()
  await win.waitForSelector('.empty__open', { timeout: 15000 })

  await app.evaluate(async ({ dialog }, f) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] })
  }, fixture)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:action', 'open-project'))
  await win.waitForFunction(
    () =>
      /http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+/.test(
        document.querySelector('.previewbar__url')?.textContent ?? ''
      ),
    { timeout: 60000 }
  )

  // Run code inside the preview page (the dev-server WebContentsView).
  const previewEval = (code) =>
    app.evaluate(({ webContents }, c) => {
      const wc = webContents
        .getAllWebContents()
        .find((w) => /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+/.test(w.getURL()))
      return wc ? wc.executeJavaScript(c, true) : null
    }, code)

  // Deliver a trusted click at a viewport point in the preview.
  const previewClick = (pt) =>
    app.evaluate(({ webContents }, p) => {
      const wc = webContents
        .getAllWebContents()
        .find((w) => /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+/.test(w.getURL()))
      if (!wc) return false
      wc.focus()
      wc.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y })
      wc.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 })
      wc.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 })
      return true
    }, pt)

  const HERO_CENTER = `(() => {
    const el = document.querySelector('#hero-title')
    if (!el) return null
    const b = el.getBoundingClientRect()
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }
  })()`

  const COMPOSER_DISPLAY = `(() => {
    const sr = document.querySelector('[data-praxis-overlay]')?.shadowRoot
    const c = sr?.querySelector('[data-praxis-composer]')
    return c ? getComputedStyle(c).display : 'none'
  })()`

  // Fill the composer's textarea and return the send button's centre point.
  const fillAndGetSend = (text) => `(() => {
    const sr = document.querySelector('[data-praxis-overlay]')?.shadowRoot
    const ta = sr?.querySelector('[data-praxis-composer] textarea')
    // The pill's first button is now the comment toggle — target Submit by label.
    const btn = sr?.querySelector('[data-praxis-composer] button[aria-label="Submit"]')
    if (!ta || !btn) return null
    ta.focus(); ta.value = ${JSON.stringify(text)}
    const b = btn.getBoundingClientRect()
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }
  })()`

  // Arm a mode, click the hero, wait for the composer — retrying to absorb the
  // set-comment-mode IPC round-trip and input-delivery lag under load. We re-issue
  // the arm via the API each iteration so a dropped arm self-heals.
  async function armAndOpen(_label, mode) {
    // The preview-bar mode buttons are gone (comment/annotate are element-scoped
    // actions on the selection pill now); arm via the store — the same path the
    // C/Y keyboard shortcuts use.
    await win.evaluate((m) => {
      window.__praxisSelection.getState().setCommentMode(m)
      void window.api.preview.setCommentMode(m)
    }, mode)
    for (let i = 0; i < 60; i++) {
      // Re-ensure the preload is armed (idempotent) — guards against a missed IPC
      // or a preview reload disarming mid-test.
      await win.evaluate((m) => window.api.preview.setCommentMode(m), mode)
      const c = await previewEval(HERO_CENTER)
      if (c) {
        await previewClick(c)
        const shown = await previewEval(COMPOSER_DISPLAY)
        if (shown === 'flex') return true
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    return false
  }

  // ---- Comment mode → agent ----
  if (!(await armAndOpen('Comment', 'comment'))) throw new Error('comment composer never opened')
  await win.screenshot({ path: join(artifacts, '09-comment-composer.png') })
  const send1 = await previewEval(fillAndGetSend('needs more contrast'))
  if (!send1) throw new Error('could not fill the comment composer')
  await previewClick(send1)
  // The comment reaches the agent: a user message referencing the element + source.
  await win.waitForFunction(
    (src) => {
      const msgs = window.__praxisStore?.getState().messages ?? []
      return msgs.some(
        (m) => m.role === 'user' && m.text.includes('needs more contrast') && m.text.includes(src)
      )
    },
    EXPECTED_SOURCE,
    { timeout: 8000 }
  )
  // Mode disarmed after submit (one comment per arming).
  const modeAfter = await win.evaluate(() => window.__praxisSelection?.getState().commentMode)
  if (modeAfter) throw new Error(`comment mode should disarm after submit, got ${modeAfter}`)

  // ---- Annotate mode → pin (no agent) ----
  const before = await win.evaluate(() => window.__praxisAnnotations?.getState().list.length ?? 0)
  if (!(await armAndOpen('Annotate', 'annotate'))) throw new Error('annotate composer never opened')
  const send2 = await previewEval(fillAndGetSend('social media links, lead out'))
  if (!send2) throw new Error('could not fill the annotate composer')
  await previewClick(send2)
  await win.waitForFunction(
    (n) => (window.__praxisAnnotations?.getState().list.length ?? 0) > n,
    before,
    { timeout: 8000 }
  )
  const note = await win.evaluate(
    () => window.__praxisAnnotations?.getState().list.at(-1)?.text
  )
  if (note !== 'social media links, lead out') {
    throw new Error(`annotation text wrong: ${note}`)
  }
  // Annotate must NOT have sent an agent turn — the last message isn't the note.
  const lastUser = await win.evaluate(() => {
    const msgs = window.__praxisStore?.getState().messages ?? []
    return msgs.filter((m) => m.role === 'user').at(-1)?.text ?? ''
  })
  if (lastUser.includes('social media links')) {
    throw new Error('annotation should not have started an agent turn')
  }

  console.log('COMMENT-MODE OK — comment → agent turn, annotation → pin (no agent)')
} catch (err) {
  console.error('COMMENT-MODE FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  await app?.close()
  // The annotate step writes into the fixture's .praxis sidecar — leave it pristine.
  rmSync(join(fixture, '.praxis'), { recursive: true, force: true })
}
