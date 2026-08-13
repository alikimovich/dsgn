/**
 * Visual + behavioral check for the collapsible projects rail (LKM-16):
 *  - the rail stays MOUNTED when collapsed (so it can animate), gaining
 *    `.rail--collapsed` and animating its width toward 0;
 *  - the floating `.sidebar-toggle` toggles `collapsed` state;
 *  - the toggle renders LAST inside `.panes` (after `.pane--preview`) so its
 *    no-drag region wins over the chat pane's drag strip when collapsed.
 * Screenshots land in test/artifacts/ for eyeballing the slide.
 */
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync } from 'node:fs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = join(root, 'test', 'fixtures', 'static-app')
const artifacts = join(root, 'test', 'artifacts')
mkdirSync(artifacts, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let app
try {
  app = await electron.launch({
    executablePath: electronPath,
    args: [join(root, 'out', 'main', 'index.js')],
    cwd: root
  })
  const win = await app.firstWindow()
  await win.waitForSelector('.empty__open', { timeout: 15000 })

  await app.evaluate(async ({ dialog }, fixturePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixturePath] })
  }, fixture)
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.send('menu:action', 'open-project')
  )

  await win.waitForSelector('.rail', { timeout: 60000 })
  await win.waitForSelector('.sidebar-toggle', { timeout: 5000 })

  // The toggle must be the LAST element child of .panes (after .pane--preview).
  const toggleIsLast = await win.evaluate(() => {
    const panes = document.querySelector('.panes')
    return panes?.lastElementChild?.classList.contains('sidebar-toggle') ?? false
  })
  if (!toggleIsLast) throw new Error('.sidebar-toggle is not the last child of .panes')

  await win.screenshot({ path: join(artifacts, '10-rail-expanded.png') })

  // Collapse.
  await win.click('.sidebar-toggle')
  await sleep(120) // mid-animation
  await win.screenshot({ path: join(artifacts, '11-rail-collapsing.png') })
  await sleep(300) // settled

  const collapsed = await win.evaluate(() => {
    const rail = document.querySelector('.rail')
    return {
      mounted: !!rail,
      hasClass: rail?.classList.contains('rail--collapsed') ?? false,
      width: rail ? Math.round(rail.getBoundingClientRect().width) : -1
    }
  })
  if (!collapsed.mounted) throw new Error('rail unmounted on collapse — cannot animate out')
  if (!collapsed.hasClass) throw new Error('rail missing .rail--collapsed class')
  if (collapsed.width > 4) throw new Error(`collapsed rail width ${collapsed.width}px should be ~0`)
  await win.screenshot({ path: join(artifacts, '12-rail-collapsed.png') })

  // Expand again.
  await win.click('.sidebar-toggle')
  await sleep(300)
  const expanded = await win.evaluate(() => {
    const rail = document.querySelector('.rail')
    return {
      hasClass: rail?.classList.contains('rail--collapsed') ?? false,
      width: rail ? Math.round(rail.getBoundingClientRect().width) : -1
    }
  })
  if (expanded.hasClass) throw new Error('rail still collapsed after re-toggle')
  if (expanded.width < 200) throw new Error(`expanded rail width ${expanded.width}px should be ~208`)
  await win.screenshot({ path: join(artifacts, '13-rail-reexpanded.png') })

  console.log('RAIL-COLLAPSE OK — collapsed width', collapsed.width, '→ expanded', expanded.width)
} catch (err) {
  console.error('RAIL-COLLAPSE FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  await app?.close()
}
