import { createReadStream, watch, type FSWatcher } from 'fs'
import { readdir, stat } from 'fs/promises'
import { createServer, type Server } from 'http'
import { extname, join, normalize, relative, resolve, sep } from 'path'
import type { RunningDevServer } from '../shared/api'
import { stampHtml } from './html-source'

/**
 * praxis's built-in static file server — the preview backend for plain
 * HTML/CSS/JS projects that have no package.json and no dev command to spawn.
 *
 * It's an in-process Node http.Server (not a spawned child) so it needs no
 * external tool (`serve`, `python -m http.server`, …) on the user's PATH and we
 * control the exact port. It injects a tiny live-reload snippet into served HTML
 * and watches the folder, so agent edits reflect in the preview the same way a
 * real dev server's HMR would — vanilla sites otherwise have none.
 */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.pdf': 'application/pdf'
}

const RELOAD_PATH = '/__praxis_reload'

// Injected before </body>: opens an SSE stream and hard-reloads on any change.
const LIVE_RELOAD_SNIPPET = `<script>(function(){try{var es=new EventSource("${RELOAD_PATH}");es.onmessage=function(){location.reload()}}catch(e){}})();</script>`

/** Find the entry HTML to serve for the directory root: index.html, else the first *.html. */
export async function findStaticEntry(root: string): Promise<string | null> {
  try {
    const names = await readdir(root)
    if (names.includes('index.html')) return 'index.html'
    if (names.includes('index.htm')) return 'index.htm'
    const html = names.filter((n) => /\.html?$/i.test(n)).sort()
    return html[0] ?? null
  } catch {
    return null
  }
}

/** Resolve a request path to an absolute file inside root, or null if it escapes. */
function resolveWithinRoot(root: string, urlPath: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0])
  } catch {
    return null
  }
  const clean = normalize(decoded).replace(/^(\.\.[/\\])+/, '')
  const abs = resolve(root, '.' + (clean.startsWith('/') ? clean : '/' + clean))
  // Guard against traversal: the resolved path must stay under root.
  if (abs !== root && !abs.startsWith(root + sep)) return null
  return abs
}

/**
 * Start the static server for `root` on `port`/`host`. Resolves once it's
 * listening (returned url is what the preview loads). The returned `server` is
 * stored by the caller so it can be closed on stop/quit.
 */
export function startStaticServer(
  opts: { root: string; port: number; host: string },
  onLog: (line: string) => void
): Promise<{ server: Server; running: RunningDevServer }> {
  const { root, port, host } = opts
  const clients = new Set<import('http').ServerResponse>()

  const server = createServer((req, res) => {
    const url = req.url ?? '/'

    // Live-reload event stream — held open, one message per file change.
    if (url.split('?')[0] === RELOAD_PATH) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      })
      res.write('retry: 1000\n\n')
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end('Method Not Allowed')
      return
    }

    void serveFile(req.method === 'HEAD').catch(() => {
      if (!res.headersSent) res.writeHead(500)
      res.end('Internal error')
    })

    async function serveFile(headOnly: boolean): Promise<void> {
      const abs = resolveWithinRoot(root, url)
      if (!abs) {
        res.writeHead(403).end('Forbidden')
        return
      }
      let target = abs
      let info = await stat(target).catch(() => null)
      // Directory → its index.html (root dir falls back to the first *.html).
      if (info?.isDirectory()) {
        const entry = (await findStaticEntry(target)) ?? 'index.html'
        target = join(target, entry)
        info = await stat(target).catch(() => null)
      }
      if (!info?.isFile()) {
        res
          .writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
          .end(
            `<!doctype html><meta charset=utf-8><title>404</title><body style="font:14px system-ui;padding:2rem">Not found: ${url.replace(/</g, '&lt;')}</body>`
          )
        return
      }
      const type = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream'
      const isHtml = type.startsWith('text/html')

      if (isHtml) {
        // Inject the live-reload snippet — read fully so we can rewrite the body.
        const chunks: Buffer[] = []
        await new Promise<void>((res2, rej2) => {
          const rs = createReadStream(target)
          rs.on('data', (c) => chunks.push(c as Buffer))
          rs.on('end', res2)
          rs.on('error', rej2)
        })
        let html = Buffer.concat(chunks).toString('utf8')
        // Inject data-praxis-source stamps so the preview can map an element back
        // to its line in this file (vanilla projects have no build step to do it).
        // Best-effort: stampHtml returns the input unchanged on any parse failure.
        const rel = relative(root, target).split(sep).join('/')
        html = await stampHtml(html, rel)
        html = html.includes('</body>')
          ? html.replace('</body>', `${LIVE_RELOAD_SNIPPET}</body>`)
          : html + LIVE_RELOAD_SNIPPET
        const body = Buffer.from(html, 'utf8')
        res.writeHead(200, {
          'Content-Type': type,
          'Content-Length': body.length,
          'Cache-Control': 'no-cache'
        })
        res.end(headOnly ? undefined : body)
        return
      }

      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': info.size,
        'Cache-Control': 'no-cache'
      })
      if (headOnly) {
        res.end()
        return
      }
      createReadStream(target).pipe(res)
    }
  })

  // Best-effort live reload: watch the tree and ping open SSE clients (debounced).
  let watcher: FSWatcher | null = null
  let reloadTimer: NodeJS.Timeout | null = null
  const notifyReload = (): void => {
    if (reloadTimer) return
    reloadTimer = setTimeout(() => {
      reloadTimer = null
      for (const c of clients) c.write('data: change\n\n')
    }, 80)
  }
  try {
    watcher = watch(root, { recursive: true }, (_e, name) => {
      // Ignore VCS/dependency noise so a `.git` write doesn't reload the preview.
      if (name && /(^|[/\\])(\.git|node_modules)([/\\]|$)/.test(name)) return
      notifyReload()
    })
    watcher.on('error', () => {})
  } catch {
    /* recursive watch unsupported here — serve without live reload */
  }

  server.on('close', () => {
    if (reloadTimer) clearTimeout(reloadTimer)
    watcher?.close()
    for (const c of clients) c.end()
    clients.clear()
  })

  return new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      const url = `http://${host}:${port}`
      onLog(`Static server serving ${root} at ${url}.`)
      resolvePromise({ server, running: { url, pid: process.pid, attached: false } })
    })
  })
}
