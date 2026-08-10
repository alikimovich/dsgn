import { createHash } from 'crypto'
import { protocol } from 'electron'
import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { Readable } from 'stream'
import { mediaTypeFor, parseRange } from './media-types'

/**
 * The editor's media backend: a custom `praxis-media://` scheme that streams a
 * project's image / video / audio files into the renderer so the code editor can
 * SHOW them instead of decoding their bytes as utf8 (which is how a .PNG used to
 * open — screenfuls of mojibake with line numbers down the side).
 *
 * Why a protocol and not a `data:` URL like the composer's attachments:
 *  - a video has to be RANGE-servable or Chromium can't seek it, and it must not
 *    be base64'd through IPC and held whole in the renderer's heap;
 *  - `file://` can't be loaded from the renderer's document (and would hand it a
 *    read primitive for the whole disk).
 *
 * The renderer never names a path. Main hands out an opaque token per file it
 * has already resolved inside a project root, and the handler serves only paths
 * in that registry — so a compromised renderer can't widen the scheme into an
 * arbitrary-file read.
 */

export const MEDIA_SCHEME = 'praxis-media'

/**
 * token → absolute path. Bounded (LRU-ish by insertion order): the editor opens
 * one file at a time, so this only ever holds the recent history.
 */
const files = new Map<string, string>()
const MAX_TOKENS = 500

/**
 * Register `absPath` as servable and return the URL for it. The token is a hash
 * of the path, so re-opening a file reuses its URL (and the responses carry
 * `no-store`, so a file edited on disk still reloads fresh).
 */
export function mediaUrl(absPath: string): string {
  const token = createHash('sha1').update(absPath).digest('hex').slice(0, 24)
  files.delete(token)
  files.set(token, absPath)
  while (files.size > MAX_TOKENS) {
    const oldest = files.keys().next().value
    if (oldest === undefined) break
    files.delete(oldest)
  }
  return `${MEDIA_SCHEME}://f/${token}`
}

/**
 * Must run BEFORE app ready (privileged schemes are fixed at that point).
 * `stream` is what lets a <video> pull the body progressively; `supportFetchAPI`
 * lets the handler answer with a streaming Response.
 */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
    }
  ])
}

const notFound = (): Response => new Response('Not found', { status: 404 })

async function serve(request: Request): Promise<Response> {
  let token: string
  try {
    token = new URL(request.url).pathname.replace(/^\/+/, '')
  } catch {
    return notFound()
  }
  const file = files.get(token)
  if (!file) return notFound()
  // Re-derive the type from the path we registered — never from the request.
  const info = mediaTypeFor(file)
  if (!info) return notFound()

  let size: number
  try {
    const st = await stat(file)
    if (!st.isFile()) return notFound()
    size = st.size
  } catch {
    return notFound()
  }

  const headers: Record<string, string> = {
    'content-type': info.mediaType,
    'accept-ranges': 'bytes',
    // The file is live on disk and the token is stable, so never let a cached
    // copy outlive an edit.
    'cache-control': 'no-store'
  }
  if (size === 0) return new Response(null, { status: 200, headers })

  const range = parseRange(request.headers.get('range'), size)
  if (range === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { ...headers, 'content-range': `bytes */${size}` }
    })
  }
  const start = range ? range.start : 0
  const end = range ? range.end : size - 1
  if (range) headers['content-range'] = `bytes ${start}-${end}/${size}`
  headers['content-length'] = String(end - start + 1)

  const body = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream<Uint8Array>
  return new Response(body, { status: range ? 206 : 200, headers })
}

/** Install the handler. Call once, after app ready. */
export function registerMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, (request) => serve(request))
}
