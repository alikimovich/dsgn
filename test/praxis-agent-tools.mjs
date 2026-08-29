/**
 * Codex ↔ Praxis MCP control bridge (pure Node/Bun, no provider credentials).
 * Proves the loopback bridge is session-scoped and that the actual stdio MCP
 * subprocess advertises/calls both workspace tools instead of merely testing a
 * config-shaped object.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'
import {
  registerPraxisAgentTools,
  shutdownPraxisAgentTools
} from '../src/main/praxis-agent-tools.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const calls = []
const registration = await registerPraxisAgentTools(async (action) => {
  calls.push(action)
  if (action === 'workspace_state') {
    return { state: 'parked', files: ['src/App.tsx'] }
  }
  return { ok: true, state: 'resolving', files: ['src/App.tsx'] }
})

const bridgeCall = (token, action) =>
  new Promise((resolve, reject) => {
    const payload = JSON.stringify({ action })
    const req = httpRequest(
      {
        socketPath: registration.socketPath,
        path: '/invoke',
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload)
        }
      },
      (response) => {
        response.resume()
        response.on('end', () => resolve(response.statusCode))
      }
    )
    req.on('error', reject)
    req.end(payload)
  })

assert.equal(
  await bridgeCall('wrong', 'workspace_state'),
  401,
  'another session token cannot operate this chat'
)

const child = spawn(electronPath, [join(root, 'bin', 'praxis-agent-mcp.mjs')], {
  cwd: root,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    PRAXIS_AGENT_TOOL_SOCKET: registration.socketPath,
    PRAXIS_AGENT_TOOL_TOKEN: registration.token
  },
  stdio: ['pipe', 'pipe', 'pipe']
})

let buffer = ''
let nextId = 1
const pending = new Map()
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  while (buffer.includes('\n')) {
    const index = buffer.indexOf('\n')
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
    }
  }
})

const request = (method, params = {}) => {
  const id = nextId++
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`MCP ${method} timed out`))
    }, 10_000)
    pending.set(id, (message) => {
      clearTimeout(timer)
      resolve(message)
    })
  })
}

try {
  const initialized = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'praxis-test', version: '1.0.0' }
  })
  assert.equal(initialized.result.serverInfo.name, 'praxis')
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`
  )

  const listed = await request('tools/list')
  assert.deepEqual(listed.result.tools.map((tool) => tool.name).sort(), [
    'prepare_conflict_resolution',
    'workspace_state'
  ])

  const status = await request('tools/call', {
    name: 'workspace_state',
    arguments: {}
  })
  assert.equal(status.result.structuredContent.state, 'parked')

  const prepared = await request('tools/call', {
    name: 'prepare_conflict_resolution',
    arguments: {}
  })
  assert.equal(prepared.result.structuredContent.state, 'resolving')
  assert.deepEqual(calls, ['workspace_state', 'prepare_conflict_resolution'])
} finally {
  registration.dispose()
  child.kill()
}

assert.equal(
  await bridgeCall(registration.token, 'workspace_state'),
  401,
  'disposed sessions are no longer callable'
)
await shutdownPraxisAgentTools()

console.log('PRAXIS-AGENT-TOOLS OK — scoped loopback bridge + real stdio MCP tools')
