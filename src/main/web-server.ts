import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createReadStream, realpathSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse
} from 'node:http'
import type { Socket } from 'node:net'
import { connect as connectTcp } from 'node:net'
import { extname, join, normalize, resolve } from 'node:path'
import type { BrowserWindow } from 'electron'
import { WebSocket, WebSocketServer } from 'ws'
import { registerAgentIpc } from './agent'
import { registerDevServerIpc } from './devserver'
import { checkoutBranch, ensureBranch, listBranches, switchBranch } from './git'
import { connectToGitHub, githubStatus } from './github'
import { readProjectIcon } from './project-icon'
import type { RendererEventTarget, RpcHandler, RpcHandlerRegistry } from './rpc-router'
import { WEB_PREVIEW_BRIDGE } from './web-preview-bridge'

const MAX_RPC_BODY = 4 * 1024 * 1024
const SESSION_COOKIE = 'praxis_web_session'

const MIME: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
}

const ROOT_ARGUMENTS: Record<string, number | 'options'> = {
  'project:detect': 0,
  'project:icon': 0,
  'devserver:start': 'options',
  'devserver:stop': 0,
  'devserver:running': 0,
  'devserver:info': 0,
  'git:ensure': 0,
  'git:set': 0,
  'git:list': 0,
  'git:checkout': 0,
  'github:status': 0,
  'github:connect': 0,
  'agent:open-project': 0,
  'agent:close-project': 0,
  'agent:set-active': 0,
  'agent:is-open': 0,
  'agent:new-chat': 0,
  'agent:restart-chat': 0,
  'agent:clear-main-context': 0,
  'agent:resume-session': 0,
  'agent:close-chat': 0,
  'agent:tag-session': 0,
  'agent:spawn-comment': 0,
  'agent:spawn-apply': 0,
  'agent:spawn-discard': 0,
  'agent:spawn-pr': 0,
  'sessions:list': 0,
  'project-memory:get': 0,
  'project-memory:set': 0
}

export class WebCommandRouter implements RpcHandlerRegistry {
  private readonly handlers = new Map<string, RpcHandler>()

  constructor(private readonly root: string) {}

  handle(channel: string, listener: RpcHandler): void {
    if (this.handlers.has(channel)) throw new Error(`Duplicate browser command: ${channel}`)
    this.handlers.set(channel, listener)
  }

  async invoke(channel: string, args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel)
    if (!handler) throw new Error(`Unsupported browser command: ${channel}`)
    this.assertRootScope(channel, args)
    return handler({}, ...args)
  }

  private assertRootScope(channel: string, args: unknown[]): void {
    const location = ROOT_ARGUMENTS[channel]
    if (location === undefined) return
    const supplied =
      location === 'options' ? (args[0] as { root?: unknown } | undefined)?.root : args[location]
    if (typeof supplied !== 'string' || resolve(supplied) !== this.root) {
      throw new Error('That command is outside the repository opened by this Praxis server.')
    }
  }
}

type PreviewGateway = {
  origin: string
  setTarget: (url: string | null) => void
  close: () => Promise<void>
}

export type BrowserServer = {
  url: string
  launchUrl: string
  close: () => Promise<void>
}

export type BrowserServerOptions = {
  root: string
  port?: number
  rendererDir: string
}

function sameSecret(left: string, right: string): boolean {
  const a = createHash('sha256').update(left).digest()
  const b = createHash('sha256').update(right).digest()
  return timingSafeEqual(a, b)
}

function cookieValue(req: IncomingMessage, name: string): string | null {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return null
}

async function bodyJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_RPC_BODY) throw new Error('Request body is too large.')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  })
  res.end(body)
}

function browserHtml(source: string): string {
  return source
    .replace(
      "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: praxis-media:; media-src 'self' praxis-media:; object-src 'none'; base-uri 'self';",
      "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: http: https:; media-src 'self' http: https:; connect-src 'self' ws: wss:; frame-src http: https:; object-src 'none'; base-uri 'self';"
    )
    .replace(
      '<script type="module"',
      '<script src="/__praxis/config.js"></script>\n    <script type="module"'
    )
}

function allowedPreviewTarget(raw: string): URL {
  const url = new URL(raw)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error('The browser preview may load only a loopback development server.')
  }
  return url
}

function stripFrameAncestors(value: string): string {
  return value
    .split(';')
    .filter((directive) => !/^\s*frame-ancestors\b/i.test(directive))
    .join(';')
}

async function createPreviewGateway(
  previewToken: string,
  controlOrigin: () => string
): Promise<PreviewGateway> {
  let target: URL | null = null
  const server = createServer((req, res) => {
    const incoming = new URL(req.url ?? '/', 'http://preview.invalid')
    if (incoming.pathname === '/__praxis/bridge.js') {
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store'
      })
      res.end(WEB_PREVIEW_BRIDGE)
      return
    }
    if (!target) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('No project preview is running.')
      return
    }
    const upstream = new URL(req.url ?? '/', target.origin)
    const headers = { ...req.headers, host: target.host, 'accept-encoding': 'identity' }
    const proxy = httpRequest(upstream, { method: req.method, headers }, (upstreamResponse) => {
      const responseHeaders = { ...upstreamResponse.headers }
      delete responseHeaders['x-frame-options']
      if (typeof responseHeaders['content-security-policy'] === 'string') {
        responseHeaders['content-security-policy'] = stripFrameAncestors(
          responseHeaders['content-security-policy']
        )
      }
      const contentType = String(upstreamResponse.headers['content-type'] ?? '')
      if (!contentType.includes('text/html')) {
        res.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders)
        upstreamResponse.pipe(res)
        return
      }
      const chunks: Buffer[] = []
      upstreamResponse.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      upstreamResponse.on('end', () => {
        const bridge = `/__praxis/bridge.js?token=${encodeURIComponent(previewToken)}&parent=${encodeURIComponent(controlOrigin())}`
        let html = Buffer.concat(chunks).toString('utf8')
        const tag = `<script src="${bridge}"></script>`
        html = html.includes('</head>') ? html.replace('</head>', `${tag}</head>`) : `${tag}${html}`
        delete responseHeaders['content-length']
        delete responseHeaders['content-encoding']
        responseHeaders['cache-control'] = 'no-store'
        res.writeHead(upstreamResponse.statusCode ?? 200, responseHeaders)
        res.end(html)
      })
    })
    proxy.on('error', (error) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`Preview gateway error: ${error.message}`)
    })
    req.pipe(proxy)
  })

  server.on('upgrade', (req, socket: Socket, head) => {
    if (!target) return socket.destroy()
    const port = Number(target.port || 80)
    const upstream = connectTcp(port, target.hostname, () => {
      const headers = Object.entries({ ...req.headers, host: target?.host })
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
        .join('\r\n')
      upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headers}\r\n\r\n`)
      if (head.length) upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    })
    upstream.on('error', () => socket.destroy())
  })

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolveListen())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Preview gateway did not bind.')

  return {
    origin: `http://127.0.0.1:${address.port}`,
    setTarget: (url) => {
      target = url ? allowedPreviewTarget(url) : null
    },
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose()))
  }
}

function serveAsset(rendererDir: string, pathname: string, res: ServerResponse): void {
  const relative = pathname === '/' ? 'index.html' : normalize(pathname).replace(/^[/\\]+/, '')
  const file = resolve(rendererDir, relative)
  if (!file.startsWith(`${resolve(rendererDir)}/`)) {
    res.writeHead(404)
    res.end()
    return
  }
  try {
    if (!statSync(file).isFile()) throw new Error('not a file')
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Not found')
    return
  }
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'cache-control': relative === 'index.html' ? 'no-store' : 'public, max-age=31536000, immutable'
  })
  createReadStream(file).pipe(res)
}

export async function startBrowserServer(options: BrowserServerOptions): Promise<BrowserServer> {
  const root = realpathSync(options.root)
  const rendererDir = realpathSync(options.rendererDir)
  const launchToken = randomBytes(24).toString('base64url')
  const sessionToken = randomBytes(24).toString('base64url')
  const previewToken = randomBytes(24).toString('base64url')
  const router = new WebCommandRouter(root)
  const sockets = new Set<WebSocket>()
  let origin = ''
  let launchAvailable = true

  const emit = (channel: string, payload: unknown): void => {
    const message = JSON.stringify({ channel, payload })
    for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.send(message)
  }
  const eventTarget: RendererEventTarget = {
    webContents: { isDestroyed: () => false, send: emit }
  }
  const getWindow = (): BrowserWindow | null => eventTarget as unknown as BrowserWindow

  registerDevServerIpc(getWindow, router)
  registerAgentIpc(getWindow, router)
  router.handle('project:pick', () => root)
  router.handle('project:icon', () => readProjectIcon(root))
  router.handle('menu:set-recents', () => undefined)
  router.handle('git:ensure', () => ensureBranch(root))
  router.handle('git:set', (_event, _requestedRoot, name: string) => switchBranch(root, name))
  router.handle('git:list', () => listBranches(root))
  router.handle('git:checkout', (_event, _requestedRoot, branch: string) =>
    checkoutBranch(root, branch)
  )
  router.handle('github:status', () => githubStatus(root))
  router.handle('github:connect', (_event, _requestedRoot, connectOptions) =>
    connectToGitHub(root, connectOptions as Parameters<typeof connectToGitHub>[1])
  )
  router.handle('simulator:preflight', () => ({
    ok: false,
    reason: 'The iOS Simulator is not exposed in browser mode yet.',
    isMac: process.platform === 'darwin',
    hasXcode: false,
    hasIdb: false,
    runtimes: [],
    devices: []
  }))

  const preview = await createPreviewGateway(previewToken, () => origin)
  const webConfig = {
    root,
    rpcPath: '/__praxis/rpc',
    eventsPath: '/__praxis/events',
    previewToken
  }
  router.handle('preview:load', (_event, rawUrl: string) => {
    const target = allowedPreviewTarget(rawUrl)
    preview.setTarget(target.href)
    emit('preview:url-changed', target.href)
    return { gatewayUrl: `${preview.origin}${target.pathname}${target.search}${target.hash}` }
  })
  router.handle('preview:reset', () => {
    preview.setTarget(null)
  })

  const webSocketServer = new WebSocketServer({ noServer: true })
  webSocketServer.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://praxis.invalid')
    if (req.headers.host !== new URL(origin).host) {
      res.writeHead(421, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store'
      })
      res.end('Invalid Praxis host.')
      return
    }
    const cookie = cookieValue(req, SESSION_COOKIE)
    const authenticated = !!cookie && sameSecret(cookie, sessionToken)

    if (!authenticated) {
      if (
        launchAvailable &&
        url.pathname === '/' &&
        sameSecret(url.searchParams.get('token') ?? '', launchToken)
      ) {
        launchAvailable = false
        res.writeHead(302, {
          location: '/',
          'set-cookie': `${SESSION_COOKIE}=${encodeURIComponent(sessionToken)}; HttpOnly; SameSite=Strict; Path=/`,
          'cache-control': 'no-store'
        })
        res.end()
      } else {
        res.writeHead(401, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store'
        })
        res.end('Open the one-time URL printed by `praxis serve`.')
      }
      return
    }

    if (url.pathname === '/__praxis/rpc' && req.method === 'POST') {
      if (req.headers.origin !== origin) {
        json(res, 403, { ok: false, error: 'Invalid request origin.' })
        return
      }
      try {
        const body = (await bodyJson(req)) as { channel?: unknown; args?: unknown }
        if (typeof body.channel !== 'string' || !Array.isArray(body.args)) {
          throw new Error('Malformed command request.')
        }
        const result = await router.invoke(body.channel, body.args)
        json(res, 200, { ok: true, result: result ?? null })
      } catch (error) {
        json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    if (url.pathname === '/__praxis/config.js') {
      const source = `window.__PRAXIS_WEB_CONFIG__=${JSON.stringify(webConfig).replace(/</g, '\\u003c')};`
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'content-length': Buffer.byteLength(source),
        'cache-control': 'no-store'
      })
      res.end(source)
      return
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const source = await readFile(join(rendererDir, 'index.html'), 'utf8')
      const html = browserHtml(source)
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(html),
        'cache-control': 'no-store'
      })
      res.end(html)
      return
    }

    serveAsset(rendererDir, url.pathname, res)
  })

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://praxis.invalid')
    const cookie = cookieValue(req, SESSION_COOKIE)
    if (
      req.headers.host !== new URL(origin).host ||
      url.pathname !== '/__praxis/events' ||
      !cookie ||
      !sameSecret(cookie, sessionToken) ||
      req.headers.origin !== origin
    ) {
      socket.destroy()
      return
    }
    webSocketServer.handleUpgrade(req, socket, head, (ws) =>
      webSocketServer.emit('connection', ws, req)
    )
  })

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 4173, '127.0.0.1', () => resolveListen())
  })
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Praxis browser server did not bind.')
  origin = `http://127.0.0.1:${address.port}`

  return {
    url: origin,
    launchUrl: `${origin}/?token=${encodeURIComponent(launchToken)}`,
    close: async () => {
      for (const socket of sockets) socket.close()
      await preview.close()
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    }
  }
}
