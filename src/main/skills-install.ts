/**
 * Side-effecting runner for installing a curated skill pack via the `skills` CLI
 * (`npx skills add …`). The pure catalog + argv builder live in skill-packs.ts;
 * this file owns the spawn, timeout, and best-effort post-install listing.
 *
 * Contract: only packs in the curated allowlist can be installed (validated here
 * via `findPack` — the same gate the calling tool must apply). Never throws for a
 * normal install failure (unknown pack, non-zero exit, timeout, spawn error) —
 * it always resolves to a structured `InstallResult` with `ok:false`.
 *
 * Scope → target dir:
 *   project → <liveRoot>/.claude/skills   (spawn cwd = liveRoot; NO -g)
 *   user    → ~/.claude/skills            (spawn cwd = home; -g via buildInstallArgs)
 *
 * `--copy` (in buildInstallArgs) is what makes installs real, portable files
 * rather than symlinks into a cache. liveRoot is the LIVE checkout, not a per-chat
 * worktree — the caller threads it from SpawnContext.liveRoot.
 */

import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { buildInstallArgs, findPack } from './skill-packs'

const INSTALL_TIMEOUT_MS = 120_000

export interface InstallInput {
  packId: string
  scope: 'project' | 'user'
  liveRoot: string
}

export interface InstallResult {
  ok: boolean
  packId: string
  scope: 'project' | 'user'
  /** Where skills land for this scope. */
  targetDir: string
  /** Skill folder names found in targetDir afterward (best-effort). */
  installed: string[]
  message: string
  stderr?: string
}

/** Resolve the on-disk skills dir for a scope. */
function targetDirFor(scope: 'project' | 'user', liveRoot: string): string {
  return scope === 'user'
    ? join(homedir(), '.claude', 'skills')
    : join(liveRoot, '.claude', 'skills')
}

/** Best-effort: list installed skill folders (directories) in the target dir. Never throws. */
function listInstalledSkills(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * Install a curated skill pack. Validates the pack against the allowlist, spawns
 * `npx <buildInstallArgs>` (argv array — never a shell string), captures output,
 * enforces a ~120s timeout, then lists what landed. Resolves `{ ok:false, … }` on
 * any failure instead of throwing.
 */
export async function installSkillPack(input: InstallInput): Promise<InstallResult> {
  const { packId, scope, liveRoot } = input
  const targetDir = targetDirFor(scope, liveRoot)
  const pack = findPack(packId)

  // SECURITY gate: reject anything not in the curated catalog before spawning.
  if (!pack) {
    return {
      ok: false,
      packId,
      scope,
      targetDir,
      installed: [],
      message: `Refusing to install '${packId}': not in the curated skill-pack allowlist.`
    }
  }

  const args = buildInstallArgs(pack, scope)
  // -g targets home; project scope runs in the live checkout so ./.claude/skills resolves there.
  const cwd = scope === 'user' ? homedir() : liveRoot

  return new Promise<InstallResult>((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('npx', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      resolve({
        ok: false,
        packId,
        scope,
        targetDir,
        installed: [],
        message: `Failed to launch installer for '${pack.title}': ${(err as Error).message}`,
        stderr: (err as Error).message
      })
      return
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, INSTALL_TIMEOUT_MS)

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
    })

    child.on('error', (err: Error) => {
      clearTimeout(timer)
      resolve({
        ok: false,
        packId,
        scope,
        targetDir,
        installed: listInstalledSkills(targetDir),
        message: `Installer error for '${pack.title}': ${err.message}`,
        stderr: stderr || err.message
      })
    })

    child.on('close', (code: number | null) => {
      clearTimeout(timer)
      const installed = listInstalledSkills(targetDir)

      if (timedOut) {
        resolve({
          ok: false,
          packId,
          scope,
          targetDir,
          installed,
          message: `Install of '${pack.title}' timed out after ${INSTALL_TIMEOUT_MS / 1000}s.`,
          stderr
        })
        return
      }

      if (code === 0) {
        resolve({
          ok: true,
          packId,
          scope,
          targetDir,
          installed,
          message: `Installed '${pack.title}' into ${targetDir}${
            installed.length ? ` (${installed.join(', ')})` : ''
          }.`,
          stderr: stderr || undefined
        })
        return
      }

      resolve({
        ok: false,
        packId,
        scope,
        targetDir,
        installed,
        message: `Install of '${pack.title}' failed (exit ${code ?? 'null'}).`,
        stderr: stderr || stdout
      })
    })
  })
}
