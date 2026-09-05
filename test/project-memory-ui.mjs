import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'
import { _electron as electron } from 'playwright'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = join(root, 'test', 'fixtures', 'static-app')
const artifacts = join(root, 'test', 'artifacts')
const userData = mkdtempSync(join(tmpdir(), 'praxis-memory-ui-'))
mkdirSync(artifacts, { recursive: true })

let app
try {
  app = await electron.launch({
    executablePath: electronPath,
    args: [join(root, 'out', 'main', 'index.js')],
    cwd: root,
    env: { ...process.env, PRAXIS_USER_DATA: userData }
  })
  const win = await app.firstWindow()
  await win.waitForSelector('.empty__open', { timeout: 15_000 })
  await app.evaluate(async ({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, fixture)
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.send('menu:action', 'open-project')
  )
  await win.waitForSelector('.rail__project-menu', { timeout: 60_000 })
  await win.locator('.rail__row').hover()
  await win.click('.rail__project-menu')
  await win.getByRole('menuitem', { name: 'Memory', exact: true }).click()
  await win.waitForSelector('[aria-label$="project memory"]', { timeout: 10_000 })

  const decision =
    '# Decisions\n\n- Chats land on praxis/master.\n- Every chat uses a detached worktree.'
  await win.fill('[aria-label$="project memory"]', decision)
  await win.click('button:has-text("Save memory")')
  await win.waitForFunction(() => document.body.textContent.includes('Project memory saved.'))

  const saved = await win.evaluate(
    (projectRoot) => window.api.projectMemory.get(projectRoot),
    fixture
  )
  if (saved.content !== decision)
    throw new Error(`memory did not round-trip: ${JSON.stringify(saved)}`)
  await win.screenshot({ path: join(artifacts, '21-project-memory.png') })

  await win.click('button:has-text("Close")')
  await win.waitForSelector('[aria-label$="project memory"]', { state: 'detached' })
  await win.locator('.rail__row').hover()
  await win.click('.rail__project-menu')
  await win.getByRole('menuitem', { name: 'Memory', exact: true }).click()
  await win.waitForSelector('[aria-label$="project memory"]', { timeout: 10_000 })
  const restored = await win.inputValue('[aria-label$="project memory"]')
  if (restored !== decision)
    throw new Error('memory did not survive closing and reopening the editor')

  if (await win.locator('button:has-text("Clear context")').count()) {
    throw new Error('project memory must not expose a privileged chat-context reset')
  }

  console.log('PROJECT-MEMORY-UI OK — edit, save, and reopen peer-shared memory')
} catch (error) {
  console.error('PROJECT-MEMORY-UI FAILED:', error?.message ?? error)
  process.exitCode = 1
} finally {
  await app?.close()
  rmSync(userData, { recursive: true, force: true })
}
