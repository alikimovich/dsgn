/**
 * Local browser-mode integration test. Launches the built Electron main process
 * without a desktop window, authenticates through the one-time URL, drives the
 * HTTP RPC boundary, starts the fixture dev server, and checks that its HTML is
 * proxied with the browser preview bridge injected.
 *
 * Run with: bun run test:browser
 */
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'
import WebSocket from 'ws'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixtureSource = join(root, 'test', 'fixtures', 'selectable-app')
const fixtureTemp = mkdtempSync(join(tmpdir(), 'praxis-browser-project-'))
const fixturePath = join(fixtureTemp, 'selectable-app')
cpSync(fixtureSource, fixturePath, { recursive: true })
const fixture = realpathSync(fixturePath)
const ownsUserData = !process.env.PRAXIS_USER_DATA
const userData = process.env.PRAXIS_USER_DATA ?? mkdtempSync(join(tmpdir(), 'praxis-browser-mode-'))

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createTcpServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('missing TCP port'))
      server.close(() => resolve(address.port))
    })
  })
}

const controlPort = await freePort()
let previewPort = await freePort()
while (previewPort === controlPort) previewPort = await freePort()

const fail = (message) => {
  throw new Error(message)
}

function waitForLaunch(child, timeout = 15_000) {
  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(
      () => reject(new Error(`browser server did not start:\n${output}`)),
      timeout
    )
    const onData = (chunk) => {
      output += chunk.toString()
      const launch = output.match(/Open once: (https:\/\/[^\s]+\/\?token=[^\s]+)/)?.[1]
      const localControl = output.match(/Praxis local control: (http:\/\/127\.0\.0\.1:\d+)/)?.[1]
      const localPreview = output.match(/Praxis local preview: (http:\/\/127\.0\.0\.1:\d+)/)?.[1]
      if (!launch || !localControl || !localPreview) return
      clearTimeout(timer)
      child.stdout.off('data', onData)
      resolve({ launch, localControl, localPreview })
    }
    child.stdout.on('data', onData)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      reject(new Error(`browser server exited early (${signal ?? code}):\n${output}`))
    })
  })
}

function openSocket(url, headers, events) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers })
    socket.on('message', (message) => events.push(JSON.parse(message.toString())))
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

function closeSocket(socket) {
  return new Promise((resolve) => {
    socket.once('close', resolve)
    socket.close()
  })
}

function localRequest(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method, headers }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      response.on('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          text: Buffer.concat(chunks).toString('utf8')
        })
      })
    })
    request.once('error', reject)
    if (body) request.write(body)
    request.end()
  })
}

async function waitFor(check, message, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  fail(message)
}

let child
let socket
let cookie

const publicOrigin = 'https://studio.example.ts.net:8443'
const previewPublicOrigin = 'https://studio.example.ts.net:8444'
const publicHost = new URL(publicOrigin).host

try {
  child = spawn(electronPath, [join(root, 'out', 'main', 'index.js')], {
    cwd: root,
    env: {
      ...process.env,
      PRAXIS_USER_DATA: userData,
      PRAXIS_WEB_MODE: '1',
      PRAXIS_WEB_ROOT: fixture,
      PRAXIS_WEB_PORT: String(controlPort),
      PRAXIS_WEB_PREVIEW_PORT: String(previewPort),
      PRAXIS_WEB_REMOTE: '1',
      PRAXIS_WEB_PUBLIC_ORIGIN: publicOrigin,
      PRAXIS_WEB_PREVIEW_ORIGIN: previewPublicOrigin,
      PRAXIS_WEB_OPEN: '0',
      PRAXIS_CODEX_BIN: join(root, 'test', 'fixtures', 'no-such-codex-bin')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })

  const launch = await waitForLaunch(child)
  const localLaunchUrl = `${launch.localControl}${new URL(launch.launch).search}`
  const proxyHeaders = { Host: publicHost }

  const unauthorized = await localRequest(launch.localControl, { headers: proxyHeaders })
  if (unauthorized.status !== 401)
    fail(`unauthenticated UI should return 401, got ${unauthorized.status}`)

  const paired = await localRequest(localLaunchUrl, { headers: proxyHeaders })
  if (paired.status !== 302 || paired.headers.location !== '/') {
    fail(`one-time launch should redirect to /, got ${paired.status}`)
  }
  const setCookie = paired.headers['set-cookie']?.[0] ?? ''
  cookie = setCookie.split(';', 1)[0]
  if (!cookie?.startsWith('praxis_web_session='))
    fail('launch did not set the browser session cookie')
  if (!setCookie.includes('; Secure')) fail('remote launch did not set a Secure session cookie')

  const reused = await localRequest(localLaunchUrl, { headers: proxyHeaders })
  if (reused.status !== 401) fail(`launch token should be single-use, got ${reused.status}`)

  const headers = { ...proxyHeaders, Cookie: cookie }
  const home = await localRequest(launch.localControl, { headers })
  const html = home.text
  if (home.status !== 200 || !html.includes('/__praxis/config.js')) {
    fail(`authenticated UI did not contain the web config script (${home.status})`)
  }
  const assetPath = html.match(/src="\.\/(assets\/[^"]+\.js)"/)?.[1]
  if (!assetPath) fail('renderer JavaScript asset was not present in browser HTML')
  const asset = await localRequest(`${launch.localControl}/${assetPath}`, { headers })
  if (asset.status !== 200) fail(`authenticated renderer asset returned ${asset.status}`)

  const rpc = async (channel, args, requestOrigin = publicOrigin) => {
    const response = await localRequest(`${launch.localControl}/__praxis/rpc`, {
      method: 'POST',
      headers: { ...headers, Origin: requestOrigin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, args })
    })
    return { status: response.status, body: JSON.parse(response.text) }
  }

  const crossOrigin = await rpc('project:detect', [fixture], 'http://attacker.invalid')
  if (crossOrigin.status !== 403)
    fail(`cross-origin RPC should return 403, got ${crossOrigin.status}`)

  const outOfScope = await rpc('project:detect', [root])
  if (outOfScope.status !== 400 || outOfScope.body.ok !== false) {
    fail('RPC accepted a repository outside the server root')
  }

  const detected = await rpc('project:detect', [fixture])
  if (
    !detected.body.ok ||
    detected.body.result?.previewKind !== 'web' ||
    detected.body.result?.devCommand !== 'npm run dev'
  ) {
    fail(`fixture detection failed: ${JSON.stringify(detected.body)}`)
  }

  const detectedTokens = await rpc('tokens:detect', [fixture])
  if (!detectedTokens.body.ok || detectedTokens.body.result?.source !== 'none') {
    fail(`browser token detection failed: ${JSON.stringify(detectedTokens.body)}`)
  }
  const outOfScopeTokens = await rpc('tokens:scaffold', [root])
  if (outOfScopeTokens.status !== 400 || outOfScopeTokens.body.ok !== false) {
    fail('browser token scaffold accepted a repository outside the server root')
  }
  const scaffoldedTokens = await rpc('tokens:scaffold', [fixture])
  if (
    !scaffoldedTokens.body.ok ||
    !scaffoldedTokens.body.result?.ok ||
    !scaffoldedTokens.body.result?.written ||
    scaffoldedTokens.body.result?.set?.source !== 'manifest'
  ) {
    fail(`browser token scaffold failed: ${JSON.stringify(scaffoldedTokens.body)}`)
  }
  if (!existsSync(join(fixture, '.praxis', 'tokens.json'))) {
    fail('browser token scaffold did not write .praxis/tokens.json')
  }
  const repeatedScaffold = await rpc('tokens:scaffold', [fixture])
  if (!repeatedScaffold.body.result?.ok || repeatedScaffold.body.result?.written) {
    fail(`browser token scaffold was not idempotent: ${JSON.stringify(repeatedScaffold.body)}`)
  }

  const events = []
  const socketHeaders = { Host: publicHost, Cookie: cookie, Origin: publicOrigin }
  socket = await openSocket(
    `${launch.localControl.replace('http:', 'ws:')}/__praxis/events`,
    socketHeaders,
    events
  )

  const openedAgent = await rpc('agent:open-project', [fixture, { provider: 'codex' }])
  if (!openedAgent.body.ok)
    fail(`browser agent session failed to open: ${JSON.stringify(openedAgent.body)}`)
  const sent = await rpc('agent:send', ['hello from browser transport'])
  if (!sent.body.ok) fail(`browser agent command failed: ${JSON.stringify(sent.body)}`)
  await waitFor(
    () => events.some((event) => event.channel === 'agent:event' && event.payload?.type === 'done'),
    `browser event socket did not receive agent completion: ${JSON.stringify(events)}`
  )
  if (!events.some((event) => event.channel === 'agent:event' && event.payload?.type === 'error')) {
    fail('missing Codex binary should emit a fail-soft browser agent error')
  }

  const started = await rpc('devserver:start', [
    {
      root: fixture,
      command: detected.body.result.devCommand,
      framework: detected.body.result.framework
    }
  ])
  if (!started.body.ok || !started.body.result?.url) {
    fail(`fixture dev server failed to start: ${JSON.stringify(started.body)}\n${stderr}`)
  }

  const loaded = await rpc('preview:load', [started.body.result.url])
  if (!loaded.body.ok || !loaded.body.result?.gatewayUrl) {
    fail(`preview gateway failed to load: ${JSON.stringify(loaded.body)}`)
  }
  if (!loaded.body.result.gatewayUrl.startsWith(`${previewPublicOrigin}/`)) {
    fail(`preview did not use its configured external origin: ${loaded.body.result.gatewayUrl}`)
  }
  const previewPath = new URL(loaded.body.result.gatewayUrl)
  const previewResponse = await fetch(`${launch.localPreview}${previewPath.pathname}`)
  const previewHtml = await previewResponse.text()
  if (
    previewResponse.status !== 200 ||
    !previewHtml.includes('id="hero-title"') ||
    !previewHtml.includes('/__praxis/bridge.js?token=') ||
    !previewHtml.includes(encodeURIComponent(publicOrigin))
  ) {
    fail(`preview gateway did not inject the selection bridge (${previewResponse.status})`)
  }

  await new Promise((resolve) => setTimeout(resolve, 100))
  if (!events.some((event) => event.channel === 'preview:url-changed')) {
    fail('browser event socket did not receive preview:url-changed')
  }

  const lastEventSeq = Math.max(...events.map((event) => event.seq ?? 0))
  await closeSocket(socket)
  socket = undefined
  await rpc('preview:load', [started.body.result.url])
  const replayedEvents = []
  socket = await openSocket(
    `${launch.localControl.replace('http:', 'ws:')}/__praxis/events?after=${lastEventSeq}`,
    socketHeaders,
    replayedEvents
  )
  await waitFor(
    () => replayedEvents.some((event) => event.channel === 'preview:url-changed'),
    `browser event socket did not replay missed events: ${JSON.stringify(replayedEvents)}`
  )
  if (replayedEvents.some((event) => event.seq <= lastEventSeq)) {
    fail(`event replay included stale sequence numbers: ${JSON.stringify(replayedEvents)}`)
  }

  const stopped = await rpc('devserver:stop', [fixture])
  if (!stopped.body.ok) fail(`fixture dev server failed to stop: ${JSON.stringify(stopped.body)}`)
  await rpc('agent:close-project', [fixture])

  console.log(
    'BROWSER MODE OK — auth, scoped RPC, token scaffold, reconnect replay, dev server, and preview gateway'
  )
} catch (error) {
  console.error('BROWSER MODE FAILED:', error?.message ?? error)
  process.exitCode = 1
} finally {
  socket?.close()
  if (child && child.exitCode == null) {
    child.kill('SIGTERM')
    await new Promise((resolve) => child.once('exit', resolve))
  }
  rmSync(fixtureTemp, { recursive: true, force: true })
  if (ownsUserData) rmSync(userData, { recursive: true, force: true })
}
