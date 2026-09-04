/**
 * Local browser-mode integration test. Launches the built Electron main process
 * without a desktop window, authenticates through the one-time URL, drives the
 * HTTP RPC boundary, starts the fixture dev server, and checks that its HTML is
 * proxied with the browser preview bridge injected.
 *
 * Run with: bun run test:browser
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'
import WebSocket from 'ws'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = join(root, 'test', 'fixtures', 'selectable-app')
const ownsUserData = !process.env.PRAXIS_USER_DATA
const userData = process.env.PRAXIS_USER_DATA ?? mkdtempSync(join(tmpdir(), 'praxis-browser-mode-'))

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
      const match = output.match(/Open once: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/)
      if (!match) return
      clearTimeout(timer)
      child.stdout.off('data', onData)
      resolve(match[1])
    }
    child.stdout.on('data', onData)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      reject(new Error(`browser server exited early (${signal ?? code}):\n${output}`))
    })
  })
}

function openSocket(url, headers) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers })
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
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
let origin
let cookie

try {
  child = spawn(electronPath, [join(root, 'out', 'main', 'index.js')], {
    cwd: root,
    env: {
      ...process.env,
      PRAXIS_USER_DATA: userData,
      PRAXIS_WEB_MODE: '1',
      PRAXIS_WEB_ROOT: fixture,
      PRAXIS_WEB_PORT: '0',
      PRAXIS_WEB_OPEN: '0',
      PRAXIS_CODEX_BIN: join(root, 'test', 'fixtures', 'no-such-codex-bin')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })

  const launchUrl = await waitForLaunch(child)
  origin = new URL(launchUrl).origin

  const unauthorized = await fetch(origin)
  if (unauthorized.status !== 401)
    fail(`unauthenticated UI should return 401, got ${unauthorized.status}`)

  const launch = await fetch(launchUrl, { redirect: 'manual' })
  if (launch.status !== 302 || launch.headers.get('location') !== '/') {
    fail(`one-time launch should redirect to /, got ${launch.status}`)
  }
  cookie = launch.headers.get('set-cookie')?.split(';', 1)[0]
  if (!cookie?.startsWith('praxis_web_session='))
    fail('launch did not set the browser session cookie')

  const reused = await fetch(launchUrl, { redirect: 'manual' })
  if (reused.status !== 401) fail(`launch token should be single-use, got ${reused.status}`)

  const headers = { Cookie: cookie }
  const home = await fetch(origin, { headers })
  const html = await home.text()
  if (home.status !== 200 || !html.includes('/__praxis/config.js')) {
    fail(`authenticated UI did not contain the web config script (${home.status})`)
  }
  const assetPath = html.match(/src="\.\/(assets\/[^"]+\.js)"/)?.[1]
  if (!assetPath) fail('renderer JavaScript asset was not present in browser HTML')
  const asset = await fetch(`${origin}/${assetPath}`, { headers })
  if (asset.status !== 200) fail(`authenticated renderer asset returned ${asset.status}`)

  const rpc = async (channel, args, requestOrigin = origin) => {
    const response = await fetch(`${origin}/__praxis/rpc`, {
      method: 'POST',
      headers: { ...headers, Origin: requestOrigin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, args })
    })
    return { status: response.status, body: await response.json() }
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

  socket = await openSocket(`${origin.replace('http:', 'ws:')}/__praxis/events`, {
    Cookie: cookie,
    Origin: origin
  })
  const events = []
  socket.on('message', (message) => events.push(JSON.parse(message.toString())))

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
  const previewResponse = await fetch(loaded.body.result.gatewayUrl)
  const previewHtml = await previewResponse.text()
  if (
    previewResponse.status !== 200 ||
    !previewHtml.includes('id="hero-title"') ||
    !previewHtml.includes('/__praxis/bridge.js?token=')
  ) {
    fail(`preview gateway did not inject the selection bridge (${previewResponse.status})`)
  }

  await new Promise((resolve) => setTimeout(resolve, 100))
  if (!events.some((event) => event.channel === 'preview:url-changed')) {
    fail('browser event socket did not receive preview:url-changed')
  }

  const stopped = await rpc('devserver:stop', [fixture])
  if (!stopped.body.ok) fail(`fixture dev server failed to stop: ${JSON.stringify(stopped.body)}`)
  await rpc('agent:close-project', [fixture])

  console.log('BROWSER MODE OK — auth, scoped RPC, agent events, dev server, and preview gateway')
} catch (error) {
  console.error('BROWSER MODE FAILED:', error?.message ?? error)
  process.exitCode = 1
} finally {
  socket?.close()
  if (child && child.exitCode == null) {
    child.kill('SIGTERM')
    await new Promise((resolve) => child.once('exit', resolve))
  }
  if (ownsUserData) rmSync(userData, { recursive: true, force: true })
}
