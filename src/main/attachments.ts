import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ImageAttachment } from '../shared/api'

/**
 * On-disk home for images the user pastes into the composer.
 *
 * An image DROPPED from Finder already has a path (`webUtils.getPathForFile`),
 * so the renderer can hand that one to the agent as-is. An image PASTED from the
 * clipboard is an in-memory blob with no path at all — it reaches the model as a
 * vision block and nothing more, so the agent can see the screenshot but has no
 * file to copy into the repo and ends up asking the user "where is this saved?".
 * Writing those bytes into the app's own attachments dir gives every shared
 * image a path, which is the whole point of this module.
 *
 * Pure (fs + path only, no electron) so it's unit-testable; the caller injects
 * the directory (main uses `<userData>/praxis/attachments`) and the timestamp.
 *
 * Everything here is renderer-supplied and therefore untrusted: the media type
 * picks the extension from a fixed table, the suggested name is reduced to a
 * safe basename, and nothing is ever written outside `dir`.
 */

/** Extension per image media type. Anything unknown falls back to `.png`. */
const EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff'
}

/** Refuse absurd payloads outright rather than filling the disk (25 MB of bytes). */
const MAX_BYTES = 25 * 1024 * 1024

/** Files older than this are swept on the next save — these are scratch copies. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Reduce a browser-supplied filename to a safe, extension-less basename, or ''
 * when nothing usable survives. Directory separators, NUL, and anything outside
 * `[A-Za-z0-9._-]` are dropped, so the result can only ever name a file inside
 * the attachments dir.
 */
function safeStem(name: string | undefined): string {
  if (typeof name !== 'string') return ''
  const base = name.split(/[/\\]/).pop() ?? ''
  // Only the LAST extension goes, and only when something precedes it — so a
  // dotfile-looking name (".hidden") keeps its text instead of vanishing.
  const stem = base.replace(/^(.+)\.[^.]*$/, '$1')
  return stem
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 40)
    .replace(/[.-]+$/, '')
}

/**
 * Name for a saved attachment: `<stamp>-<stem>.<ext>`. `stamp` makes repeated
 * pastes of the same screenshot distinct instead of clobbering each other.
 */
export function attachmentFileName(
  mediaType: string,
  name: string | undefined,
  stamp: string
): string {
  const ext = EXT_BY_TYPE[String(mediaType ?? '').toLowerCase()] ?? 'png'
  const stem = safeStem(name) || 'pasted-image'
  return `${stamp}-${stem}.${ext}`
}

/**
 * Write a pasted image into `dir` and return its absolute path, or '' if it
 * couldn't be written. Never throws: a failed save just means the turn goes out
 * with the vision block alone, exactly as it did before.
 */
export async function saveImageAttachment(
  dir: string,
  image: ImageAttachment,
  name: string | undefined,
  stamp: string
): Promise<string> {
  try {
    if (!image || typeof image.data !== 'string' || !image.data) return ''
    if (!String(image.mediaType ?? '').startsWith('image/')) return ''
    const bytes = Buffer.from(image.data, 'base64')
    if (!bytes.length || bytes.length > MAX_BYTES) return ''
    await mkdir(dir, { recursive: true })
    const abs = join(dir, attachmentFileName(image.mediaType, name, stamp))
    await writeFile(abs, bytes)
    return abs
  } catch {
    return ''
  }
}

/**
 * Drop saved attachments older than `maxAgeMs`. These are scratch copies of
 * clipboard bytes, so the dir would otherwise grow forever. Never throws.
 */
export async function pruneAttachments(
  dir: string,
  now: number,
  maxAgeMs: number = MAX_AGE_MS
): Promise<number> {
  let removed = 0
  try {
    for (const entry of await readdir(dir)) {
      const abs = join(dir, entry)
      try {
        const info = await stat(abs)
        if (!info.isFile() || now - info.mtimeMs <= maxAgeMs) continue
        await rm(abs, { force: true })
        removed++
      } catch {
        // A file that vanished (or that we can't stat) is not our problem.
      }
    }
  } catch {
    // No dir yet — nothing to prune.
  }
  return removed
}
