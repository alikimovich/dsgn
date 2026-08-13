import { execFile } from 'child_process'
import type { Dirent } from 'fs'
import { readdir } from 'fs/promises'
import { join, relative, sep } from 'path'
import { promisify } from 'util'

/**
 * File listing for the pop-out editor's `@pierre/trees` file tree. Returns the
 * project's repo-relative file paths (POSIX-separated — the tree keys on path
 * strings). Pure (child_process + fs only, no electron) so it's unit-testable.
 *
 * A git repo is listed via `git ls-files` (tracked) plus `--others
 * --exclude-standard` (untracked-but-not-ignored): fast, and .gitignore already
 * drops node_modules/build output. A non-git folder falls back to a bounded
 * filesystem walk that skips the usual heavy/hidden dirs.
 */

const execFileP = promisify(execFile)

// Never worth walking into these for a file tree; the git path excludes them via
// .gitignore anyway, so this only bites the fs-walk fallback.
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  '.turbo',
  'dist',
  'out',
  'build',
  '.cache',
  '.vercel',
  'coverage'
])

// A file tree past this many entries is unusable and the render cost isn't worth
// it — cap and let the caller note truncation if it matters.
const MAX_ENTRIES = 20000

const toPosix = (p: string): string => (sep === '/' ? p : p.split(sep).join('/'))

async function gitFiles(root: string): Promise<string[] | null> {
  try {
    const run = (args: string[]): Promise<string> =>
      execFileP('git', args, { cwd: root, timeout: 8000, maxBuffer: 32 * 1024 * 1024 }).then(
        (r) => r.stdout
      )
    // Confirm this is actually a work tree before trusting ls-files output.
    if ((await run(['rev-parse', '--is-inside-work-tree'])).trim() !== 'true') return null
    const [tracked, untracked] = await Promise.all([
      run(['ls-files', '-z']),
      run(['ls-files', '-z', '--others', '--exclude-standard'])
    ])
    const seen = new Set<string>()
    for (const chunk of [tracked, untracked]) {
      for (const line of chunk.split('\0')) {
        if (line) seen.add(line)
        if (seen.size >= MAX_ENTRIES) break
      }
    }
    return [...seen]
  } catch {
    return null
  }
}

async function walk(root: string): Promise<string[]> {
  const out: string[] = []
  const stack: string[] = [root]
  while (stack.length) {
    if (out.length >= MAX_ENTRIES) break
    const dir = stack.pop()!
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        stack.push(full)
      } else if (e.isFile()) {
        out.push(toPosix(relative(root, full)))
        if (out.length >= MAX_ENTRIES) break
      }
    }
  }
  return out
}

/** Repo-relative, POSIX-separated file paths for `root`, sorted. */
export async function listProjectFiles(root: string): Promise<string[]> {
  const git = await gitFiles(root)
  const files = git ?? (await walk(root))
  return files.sort((a, b) => a.localeCompare(b))
}
