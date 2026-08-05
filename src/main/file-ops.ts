import { mkdir, rename, rm, stat, writeFile } from 'fs/promises'
import { dirname, normalize, relative, resolve, sep } from 'path'
import type { FileOpResult } from '../shared/api'

/**
 * Create / rename / delete for the pop-out editor's file-tree sidebar — the
 * file-manager half of `file-tree.ts` (which only lists). Pure (fs + path only,
 * no electron) so it's unit-testable; the one electron-flavored bit, moving a
 * deleted file to the OS trash instead of unlinking it, is injected by the
 * caller (`shell.trashItem` from main) rather than imported here.
 *
 * Every path that crosses IPC is untrusted, so each op re-validates it from
 * scratch: repo-relative, POSIX-separated, no traversal, and never inside a
 * protected directory. The tree lists FILES, so these ops are file-only —
 * intermediate directories are created implicitly by a nested path
 * ("src/new/Thing.tsx"), and directories are never renamed or deleted.
 */

/**
 * Directories the file manager refuses to touch at any depth: git's own store,
 * the praxis sidecar (`.dsgn` is its pre-rename name — old repos still carry
 * it, and the agent's write-deny covers both), and installed dependencies.
 */
const PROTECTED_SEGMENTS = new Set(['.git', '.praxis', '.dsgn', 'node_modules'])

/**
 * Normalize an untrusted path to a repo-relative POSIX path, or null when it
 * isn't one we're willing to write: absolute, traversing (`..`), empty, hidden
 * behind a protected directory, or carrying a NUL byte.
 */
export function normalizeRelPath(input: string): string | null {
  if (typeof input !== 'string') return null
  const posix = input.trim().replace(/\\/g, '/')
  if (!posix || posix.includes('\0')) return null
  if (posix.startsWith('/') || /^[A-Za-z]:/.test(posix)) return null
  const segments = posix.split('/').filter((s) => s !== '')
  if (!segments.length) return null
  for (const s of segments) {
    if (s === '.' || s === '..') return null
    if (PROTECTED_SEGMENTS.has(s)) return null
  }
  return segments.join('/')
}

/** Absolute path for a validated repo-relative path, or null if it escapes `root`. */
function toAbs(root: string, rel: string): string | null {
  const abs = resolve(root, rel)
  const inside = relative(normalize(root), abs)
  if (!inside || inside.startsWith('..') || inside.startsWith(`..${sep}`)) return null
  return abs
}

/** Resolve + validate in one step: the caller only ever sees a safe pair. */
function target(root: string, input: string): { rel: string; abs: string } | null {
  const rel = normalizeRelPath(input)
  if (!rel) return null
  const abs = toAbs(root, rel)
  return abs ? { rel, abs } : null
}

const BAD_PATH = 'That path is not allowed.'

async function exists(abs: string): Promise<boolean> {
  try {
    await stat(abs)
    return true
  } catch {
    return false
  }
}

/**
 * Create an empty file at `path` (repo-relative). Missing parent directories are
 * created; an existing file is never clobbered.
 */
export async function createProjectFile(root: string, path: string): Promise<FileOpResult> {
  const t = target(root, path)
  if (!t) return { ok: false, error: BAD_PATH }
  if (await exists(t.abs)) return { ok: false, error: 'Something already exists at that path.' }
  try {
    await mkdir(dirname(t.abs), { recursive: true })
    // 'wx' — fail rather than truncate if the path appeared since the check.
    await writeFile(t.abs, '', { encoding: 'utf8', flag: 'wx' })
  } catch {
    return { ok: false, error: 'Could not create that file.' }
  }
  return { ok: true, path: t.rel }
}

/**
 * Rename (or move — the new path may sit in another directory) a file. Refuses
 * to overwrite an existing path, except when the only difference is letter case:
 * on a case-insensitive filesystem `Foo.tsx` → `foo.tsx` "already exists", and
 * refusing it would make case fixes impossible.
 */
export async function renameProjectFile(
  root: string,
  from: string,
  to: string
): Promise<FileOpResult> {
  const src = target(root, from)
  const dst = target(root, to)
  if (!src || !dst) return { ok: false, error: BAD_PATH }
  if (src.rel === dst.rel) return { ok: true, path: dst.rel }
  try {
    if (!(await stat(src.abs)).isFile()) return { ok: false, error: 'Only files can be renamed.' }
  } catch {
    return { ok: false, error: 'That file no longer exists.' }
  }
  const caseOnly = src.rel.toLowerCase() === dst.rel.toLowerCase()
  if (!caseOnly && (await exists(dst.abs))) {
    return { ok: false, error: 'Something already exists at that path.' }
  }
  try {
    await mkdir(dirname(dst.abs), { recursive: true })
    await rename(src.abs, dst.abs)
  } catch {
    return { ok: false, error: 'Could not rename that file.' }
  }
  return { ok: true, path: dst.rel }
}

/**
 * Delete a file. `trash` (main passes `shell.trashItem`) makes it recoverable —
 * these edits are outside the content-diff undo history, so the OS trash is the
 * only undo there is. If trashing fails (no desktop session, unsupported fs) the
 * file is removed outright: the user asked for it gone.
 */
export async function deleteProjectFile(
  root: string,
  path: string,
  trash?: (abs: string) => Promise<void>
): Promise<FileOpResult> {
  const t = target(root, path)
  if (!t) return { ok: false, error: BAD_PATH }
  try {
    if (!(await stat(t.abs)).isFile()) return { ok: false, error: 'Only files can be deleted.' }
  } catch {
    return { ok: false, error: 'That file no longer exists.' }
  }
  if (trash) {
    try {
      await trash(t.abs)
      return { ok: true, path: t.rel }
    } catch {
      /* fall through to a plain delete */
    }
  }
  try {
    await rm(t.abs)
  } catch {
    return { ok: false, error: 'Could not delete that file.' }
  }
  return { ok: true, path: t.rel }
}
