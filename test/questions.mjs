/**
 * Store-driven visual test of the agent-question interface (the SDK's
 * AskUserQuestion tool → interactive multiple-choice cards). No agent/auth: we
 * push a `question-request` into the store the way main's `agent:event` does, then
 * exercise the card (single-select auto-submit, multi-select + Send, Skip).
 *
 * The full canUseTool round-trip (a live AskUserQuestion answered back to the
 * model) needs Claude credentials and is out of scope here — like the permission
 * card, clicking without an open session only exercises the renderer.
 *
 * Run with: node test/questions.mjs
 */
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync } from 'node:fs'

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
  await win.evaluate(() => window.__praxisWorkspace.getState().openOrActivate('/tmp/praxis-test-project'))
  await win.waitForSelector('.composer__input', { timeout: 15000 })

  // 1) A single single-select question renders as a card with header + options.
  await win.evaluate(() => {
    window.__praxisQuestions.getState().addRequest({
      id: 'q_single',
      sessionKey: window.__praxisStore.getState().activeKey,
      questions: [
        {
          header: 'Approach',
          question: 'Which layout should the hero use?',
          multiSelect: false,
          options: [
            { label: 'Centered', description: 'Title + CTA stacked and centered' },
            { label: 'Split', description: 'Copy left, image right' }
          ]
        }
      ]
    })
  })
  await win.waitForSelector('.question', { timeout: 5000 })
  const header = (await win.textContent('.question__header'))?.trim()
  if (header !== 'Approach') throw new Error(`unexpected question header: ${header}`)
  const qtext = (await win.textContent('.question__text'))?.trim() ?? ''
  if (!/which layout/i.test(qtext)) throw new Error(`unexpected question text: ${qtext}`)
  const optCount = await win.$$eval('.question__option', (els) => els.length)
  // 2 real options + the always-present "Other…" affordance.
  if (optCount !== 3) throw new Error(`expected 3 option buttons (2 + Other), got ${optCount}`)
  await win.screenshot({ path: join(artifacts, '10-question-card.png') })

  // Clicking a concrete option on a single single-select question answers it and
  // removes the card (auto-submit).
  await win.click('.question__option:has-text("Centered")')
  await win.waitForFunction(() => !document.querySelector('.question'), { timeout: 5000 })

  // 2) A multi-select question does NOT auto-submit: pick two, then Send. The
  // Send button is disabled until at least one option is chosen.
  await win.evaluate(() => {
    window.__praxisQuestions.getState().addRequest({
      id: 'q_multi',
      sessionKey: window.__praxisStore.getState().activeKey,
      questions: [
        {
          header: 'Features',
          question: 'Which sections should I add?',
          multiSelect: true,
          options: [
            { label: 'Pricing', description: 'A 3-tier pricing grid' },
            { label: 'FAQ', description: 'Accordion of common questions' },
            { label: 'Testimonials', description: 'Customer quotes' }
          ]
        }
      ]
    })
  })
  await win.waitForSelector('.question', { timeout: 5000 })
  const sendDisabled = await win.$eval('.question__send', (b) => b.disabled)
  if (!sendDisabled) throw new Error('Send should be disabled before any option is chosen')
  await win.click('.question__option:has-text("Pricing")')
  await win.click('.question__option:has-text("FAQ")')
  // Both stay selected (multi-select toggles, not radio).
  const selected = await win.$$eval('.question__option.is-selected', (els) =>
    els.map((e) => e.textContent?.trim() ?? '')
  )
  if (selected.length !== 2) throw new Error(`multi-select should keep 2 picks, got ${selected.length}`)
  await win.click('.question__send')
  await win.waitForFunction(() => !document.querySelector('.question'), { timeout: 5000 })

  // 3) "Skip" dismisses a question without answering.
  await win.evaluate(() => {
    window.__praxisQuestions.getState().addRequest({
      id: 'q_skip',
      sessionKey: window.__praxisStore.getState().activeKey,
      questions: [
        {
          header: 'Style',
          question: 'Rounded or square corners?',
          multiSelect: false,
          options: [
            { label: 'Rounded', description: 'Soft, friendly' },
            { label: 'Square', description: 'Sharp, technical' }
          ]
        }
      ]
    })
  })
  await win.waitForSelector('.question', { timeout: 5000 })
  await win.click('.question__skip')
  await win.waitForFunction(() => !document.querySelector('.question'), { timeout: 5000 })

  // 4) A `question-resolved` event from main clears a still-open card (e.g. the
  // agent answered elsewhere, or the turn was interrupted).
  await win.evaluate(() => {
    window.__praxisQuestions.getState().addRequest({
      id: 'q_resolved',
      sessionKey: window.__praxisStore.getState().activeKey,
      questions: [
        {
          header: 'Copy',
          question: 'Formal or casual tone?',
          multiSelect: false,
          options: [
            { label: 'Formal', description: 'Professional' },
            { label: 'Casual', description: 'Conversational' }
          ]
        }
      ]
    })
  })
  await win.waitForSelector('.question', { timeout: 5000 })
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('agent:event', {
      type: 'question-resolved',
      id: 'q_resolved'
    })
  })
  await win.waitForFunction(() => !document.querySelector('.question'), { timeout: 5000 })

  // 5) A MULTI-question request runs as a step-by-step wizard: one question at a
  // time with a progress chip; a single-select pick auto-advances; Back returns
  // (keeping the pick); the last step Sends.
  await win.evaluate(() => {
    window.__praxisQuestions.getState().addRequest({
      id: 'q_wizard',
      sessionKey: window.__praxisStore.getState().activeKey,
      questions: [
        {
          header: 'Layout',
          question: 'Grid or list?',
          multiSelect: false,
          options: [
            { label: 'Grid', description: 'Cards in a grid' },
            { label: 'List', description: 'Stacked rows' }
          ]
        },
        {
          header: 'Density',
          question: 'Compact or comfortable?',
          multiSelect: false,
          options: [
            { label: 'Compact', description: 'Tight spacing' },
            { label: 'Comfortable', description: 'Roomy spacing' }
          ]
        }
      ]
    })
  })
  await win.waitForSelector('.question', { timeout: 5000 })
  const items = await win.$$eval('.question__item', (els) => els.length)
  if (items !== 1) throw new Error(`wizard should show ONE question at a time, got ${items}`)
  const prog = (await win.textContent('.question__progress'))?.trim()
  if (prog !== '1/2') throw new Error(`progress chip reads "${prog}", expected 1/2`)
  await win.screenshot({ path: join(artifacts, '11-question-wizard.png') })
  // Picking on step 1 auto-advances to step 2.
  await win.click('.question__option:has-text("Grid")')
  const h2 = (await win.textContent('.question__header'))?.trim()
  if (h2 !== 'Density') throw new Error(`step 2 header is "${h2}"`)
  // Back returns to step 1 with the pick kept.
  await win.click('.question__back')
  const kept = await win.$$eval('.question__option.is-selected', (els) => els.length)
  if (kept !== 1) throw new Error('Back lost the step-1 pick')
  await win.click('.question__next')
  // Final step: answer + Send submits the whole request.
  await win.click('.question__option:has-text("Compact")')
  await win.click('.question__send')
  await win.waitForFunction(() => !document.querySelector('.question'), { timeout: 5000 })

  console.log('QUESTIONS OK — single-select auto-submit, multi-select + Send, Skip, resolved-event clear, wizard steps')
} catch (err) {
  console.error('QUESTIONS FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  await app?.close()
}
