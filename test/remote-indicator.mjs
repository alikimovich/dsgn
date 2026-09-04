/**
 * Browser-mode remote status should be present but visually quiet: one small
 * connection dot, no pill chrome or visible microcopy. The full status remains
 * available through its accessible name and tooltip.
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

  // Browser mode injects this before the renderer script. Mirror that timing on
  // reload; main.tsx retains Electron's native preload bridge when it is present.
  await win.addInitScript(() => {
    window.__PRAXIS_WEB_CONFIG__ = {
      root: '/tmp/praxis-remote-indicator',
      rpcPath: '/__praxis/rpc',
      eventsPath: '/__praxis/events',
      previewToken: 'test',
      remote: true
    }
  })
  await win.reload()
  await win.waitForSelector('.empty__open', { timeout: 15000 })
  await win.evaluate(() =>
    window.__praxisWorkspace.getState().openOrActivate('/tmp/praxis-remote-indicator')
  )
  await win.waitForSelector('.previewbar', { timeout: 5000 })
  await win.waitForSelector('.previewbar__remote', { timeout: 5000 })

  const status = await win.evaluate(() => {
    const indicator = document.querySelector('.previewbar__remote')
    const dot = indicator?.firstElementChild
    if (!indicator || !dot) return null
    const box = indicator.getBoundingClientRect()
    const dotBox = dot.getBoundingClientRect()
    const style = getComputedStyle(indicator)
    const dotStyle = getComputedStyle(dot)
    return {
      ariaLabel: indicator.getAttribute('aria-label'),
      title: indicator.getAttribute('title'),
      text: indicator.textContent?.trim() ?? '',
      width: box.width,
      height: box.height,
      borderWidth: style.borderWidth,
      background: style.backgroundColor,
      dotWidth: dotBox.width,
      dotHeight: dotBox.height,
      dotBackground: dotStyle.backgroundColor
    }
  })

  if (!status) throw new Error('remote status did not render')
  if (status.ariaLabel !== 'Remote access active' || !status.title?.includes('Tailscale')) {
    throw new Error(`remote status lost its accessible explanation: ${JSON.stringify(status)}`)
  }
  if (status.text || status.width !== 20 || status.height !== 20) {
    throw new Error(`remote status should be a quiet 20px dot slot: ${JSON.stringify(status)}`)
  }
  if (status.borderWidth !== '0px' || status.background !== 'rgba(0, 0, 0, 0)') {
    throw new Error(`remote status should have no pill chrome: ${JSON.stringify(status)}`)
  }
  if (status.dotWidth !== 6 || status.dotHeight !== 6 || status.dotBackground === 'rgba(0, 0, 0, 0)') {
    throw new Error(`remote connection dot is missing: ${JSON.stringify(status)}`)
  }

  await win.locator('.previewbar').screenshot({
    path: join(artifacts, '03d-remote-indicator.png')
  })
  console.log('REMOTE-INDICATOR OK — quiet dot, no pill chrome, accessible status retained')
} catch (error) {
  console.error('REMOTE-INDICATOR FAILED:', error?.message ?? error)
  process.exitCode = 1
} finally {
  await app?.close()
}
