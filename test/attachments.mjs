/**
 * attachments.ts unit test (pure — no Electron). Pasted-image persistence: the
 * bytes a clipboard image arrives as have no path anywhere on disk, so main
 * writes them out and hands the agent that path.
 *
 * The media type, the byte payload and the suggested filename all come from the
 * renderer, so the guards matter as much as the happy path: the name can only
 * ever produce a file INSIDE the attachments dir (no traversal, no separators),
 * a non-image or oversized payload is refused, and nothing throws — a failed
 * save must degrade to '' (image still rides as a vision block) rather than
 * killing the turn.
 *
 * Run with: bun run test:attachments
 */
import {
  attachmentFileName,
  pruneAttachments,
  saveImageAttachment
} from '../src/main/attachments.ts'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'attachments-'))
const dir = join(root, 'attachments')
let failed = 0
const ok = (cond, msg) => {
  if (!cond) (failed++, console.error('  ✗', msg))
}

// A 1×1 PNG, base64 — exactly the shape a pasted screenshot arrives in.
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

try {
  // --- attachmentFileName: extension from the media type, safe stem from the name ---
  ok(attachmentFileName('image/png', 'shot.png', '1') === '1-shot.png', 'png keeps its stem')
  ok(attachmentFileName('image/jpeg', 'photo.jpeg', '1') === '1-photo.jpg', 'jpeg → .jpg')
  ok(
    attachmentFileName('IMAGE/WEBP', 'a.webp', '1') === '1-a.webp',
    'media type matches case-insensitively'
  )
  ok(
    attachmentFileName('image/heic', 'x.heic', '1') === '1-x.png',
    'unknown image type falls back to .png'
  )
  ok(
    attachmentFileName('image/png', undefined, '7') === '7-pasted-image.png',
    'a nameless paste gets a default stem'
  )
  ok(
    attachmentFileName('image/png', '', '7') === '7-pasted-image.png',
    'an empty name gets the default stem too'
  )
  ok(
    attachmentFileName('image/png', '../../etc/passwd', '1') === '1-passwd.png',
    'traversal in the name is reduced to a bare stem'
  )
  ok(
    attachmentFileName('image/png', 'C:\\Windows\\evil.exe', '1') === '1-evil.png',
    'backslash separators are stripped too'
  )
  ok(
    !attachmentFileName('image/png', 'a/b\\c:d*e', '1').match(/[/\\:*]/),
    'no path/oddball characters survive'
  )
  ok(
    attachmentFileName('image/png', '.hidden', '1') === '1-hidden.png',
    'a leading dot never makes a dotfile'
  )
  ok(
    attachmentFileName('image/png', 'Screen Shot at 10.42.11', '1') ===
      '1-Screen-Shot-at-10.42.png',
    'spaces collapse to dashes and only the LAST extension is dropped'
  )
  ok(
    attachmentFileName('image/png', 'x'.repeat(200), '1').length < 60,
    'an absurdly long name is capped'
  )
  ok(
    attachmentFileName('image/png', 'a.png', '1') !== attachmentFileName('image/png', 'a.png', '2'),
    'the stamp keeps repeated pastes of the same name distinct'
  )

  // --- saveImageAttachment: the happy path ---
  const saved = await saveImageAttachment(dir, { mediaType: 'image/png', data: PNG }, 'shot.png', '100')
  ok(saved === join(dir, '100-shot.png'), 'returns the absolute path it wrote')
  ok(existsSync(saved), 'the file is actually on disk')
  ok(dirname(saved) === dir, 'the file lands inside the attachments dir')
  ok(readFileSync(saved).length === Buffer.from(PNG, 'base64').length, 'bytes round-trip')
  ok(
    readFileSync(saved).subarray(1, 4).toString() === 'PNG',
    'the decoded bytes are the real PNG, not the base64 text'
  )

  // A name that tries to escape still writes inside the dir.
  const escaped = await saveImageAttachment(
    dir,
    { mediaType: 'image/png', data: PNG },
    '../../escape.png',
    '101'
  )
  ok(dirname(escaped) === dir, 'a traversing name cannot write outside the dir')
  ok(basename(escaped) === '101-escape.png', 'it is sanitized to a plain basename')
  ok(!existsSync(join(root, '..', 'escape.png')), 'nothing was written above the dir')

  // --- saveImageAttachment: everything that must degrade to '' ---
  ok(
    (await saveImageAttachment(dir, { mediaType: 'text/plain', data: PNG }, 'a.txt', '1')) === '',
    'a non-image media type is refused'
  )
  ok(
    (await saveImageAttachment(dir, { mediaType: 'image/png', data: '' }, 'a.png', '1')) === '',
    'empty data is refused'
  )
  ok(
    (await saveImageAttachment(dir, { mediaType: 'image/png', data: '!!!!' }, 'a.png', '1')) === '',
    'data that decodes to nothing is refused'
  )
  ok(
    (await saveImageAttachment(
      dir,
      { mediaType: 'image/png', data: 'A'.repeat(40 * 1024 * 1024) },
      'big.png',
      '1'
    )) === '',
    'an oversized payload is refused'
  )
  ok((await saveImageAttachment(dir, null, 'a.png', '1')) === '', 'a missing image is refused')
  ok(
    (await saveImageAttachment(dir, { mediaType: 'image/png', data: 12 }, 'a.png', '1')) === '',
    'non-string data is refused'
  )
  // A dir path that can't be created (a FILE sits where the dir should go).
  const blocked = join(root, 'blocked')
  writeFileSync(blocked, 'not a dir')
  ok(
    (await saveImageAttachment(blocked, { mediaType: 'image/png', data: PNG }, 'a.png', '1')) === '',
    'an unwritable dir degrades to "" instead of throwing'
  )
  ok(readdirSync(dir).length === 2, 'only the two valid saves are on disk')

  // --- pruneAttachments: scratch copies do not accumulate forever ---
  const old = join(dir, '1-old.png')
  writeFileSync(old, 'x')
  const now = Date.now()
  const dayMs = 24 * 60 * 60 * 1000
  utimesSync(old, new Date(now - 30 * dayMs), new Date(now - 30 * dayMs))
  ok((await pruneAttachments(dir, now, 7 * dayMs)) === 1, 'an aged file is swept')
  ok(!existsSync(old), 'and it is gone')
  ok(existsSync(saved), 'a fresh file survives the sweep')
  ok((await pruneAttachments(dir, now, 7 * dayMs)) === 0, 'a second sweep finds nothing left')
  ok(
    (await pruneAttachments(join(root, 'nope'), now, 7 * dayMs)) === 0,
    'pruning a dir that does not exist is a no-op'
  )

  if (failed === 0)
    console.log('ATTACHMENTS OK — filename sanitizing, save guards, prune sweep')
  else console.error(`ATTACHMENTS: ${failed} assertion(s) failed`)
  process.exitCode = failed === 0 ? 0 : 1
} catch (err) {
  console.error('ATTACHMENTS FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  rmSync(root, { recursive: true, force: true })
}
