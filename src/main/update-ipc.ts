import { spawn } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'
import { app, ipcMain, type BrowserWindow } from 'electron'
import type { UpdateStatus } from '../shared/api'
import { checkForUpdate } from './update'

/**
 * Electron-side wiring for Praxis self-update. Detection lives in update.ts
 * (electron-free / unit-tested); this registers the IPC, runs the background
 * checks, and drives the in-app "Update & Restart" which shells out to
 * `bin/praxis.mjs --update` and relaunches. Mirrors the registerAgentIpc pattern.
 */

let getWindow_: () => BrowserWindow | null = () => null
const push = (status: UpdateStatus): void => {
  // The update runs against a child process whose socket `onData` keeps firing;
  // guard a destroyed webContents (renderer killed on display sleep) so a late
  // status line can't throw an uncaught "Object has been destroyed".
  const wc = getWindow_()?.webContents
  if (wc && !wc.isDestroyed()) wc.send('update:status', status)
}

// A GUI-launched Electron process inherits a minimal PATH, so `bun`/`git` may
// not resolve. The primary launch path is the `praxis` terminal command (which
// inherits the shell PATH), but prepend the common toolchain locations anyway.
const spawnPath = (): string =>
  [join(homedir(), '.bun/bin'), '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH ?? '']
    .filter(Boolean)
    .join(':')

/**
 * Run `bin/praxis.mjs --update` as a child (Electron-as-node, so no separate
 * node install is required), streaming its output to the renderer as progress.
 * On success the app relaunches to pick up the rebuild; on failure it reports.
 */
async function applyUpdate(repoRoot: string): Promise<void> {
  push({ status: 'updating', behind: 0, progress: 'Starting update…' })
  const bin = join(repoRoot, 'bin', 'praxis.mjs')
  await new Promise<void>((resolve) => {
    const child = spawn(process.execPath, [bin, '--update', '--no-launch'], {
      cwd: repoRoot,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PATH: spawnPath() }
    })
    const onData = (buf: Buffer): void => {
      const line = buf.toString().trim().split('\n').pop()?.trim()
      if (line) push({ status: 'updating', behind: 0, progress: line })
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', (e) => {
      push({ status: 'error', behind: 0, error: e.message })
      resolve()
    })
    child.on('close', (code) => {
      if (code === 0) {
        app.relaunch()
        app.quit()
      } else {
        push({ status: 'error', behind: 0, error: `Update failed (exit code ${code ?? 'unknown'})` })
      }
      resolve()
    })
  })
}

const SIX_HOURS = 6 * 60 * 60 * 1000

/**
 * Register the update IPC + background checks. `repoRoot` is the app's own
 * checkout (app.getAppPath() in an unpackaged Electron app). Checks run 4s after
 * ready (so window creation wins the startup race) and every 6h thereafter.
 */
export function registerUpdateIpc(getWindow: () => BrowserWindow | null): void {
  getWindow_ = getWindow
  const repoRoot = app.getAppPath()

  ipcMain.handle('update:check', async () => {
    const status = await checkForUpdate(repoRoot)
    push(status)
    return status
  })
  ipcMain.handle('update:apply', async () => {
    await applyUpdate(repoRoot)
  })

  const check = (): void => {
    checkForUpdate(repoRoot)
      .then(push)
      .catch(() => {})
  }
  setTimeout(check, 4000)
  setInterval(check, SIX_HOURS)
}
