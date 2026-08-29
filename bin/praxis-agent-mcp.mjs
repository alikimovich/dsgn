#!/usr/bin/env node
import { request } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const socketPath = process.env.PRAXIS_AGENT_TOOL_SOCKET
const token = process.env.PRAXIS_AGENT_TOOL_TOKEN

if (!socketPath || !token) {
  process.stderr.write('Praxis agent tool bridge is not configured.\n')
  process.exit(1)
}

const invoke = async (action) => {
  const payload = JSON.stringify({ action })
  const body = await new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: '/invoke',
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload)
        },
        timeout: 30_000
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        response.on('end', () => {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (response.statusCode !== 200 || !parsed?.ok) {
            reject(
              new Error(parsed?.error || `Praxis tool bridge returned HTTP ${response.statusCode}.`)
            )
            return
          }
          resolve(parsed)
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('Praxis tool bridge timed out.')))
    req.on('error', reject)
    req.end(payload)
  })
  return body.result
}

const result = (value) => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  structuredContent: value
})

const server = new McpServer({ name: 'praxis', version: '1.0.0' })

server.registerTool(
  'workspace_state',
  {
    title: 'Praxis workspace state',
    description:
      'Inspect Praxis authoritative landing/worktree state for this chat. Call this whenever a merge, conflict, worktree, landing, or stale-preview issue is suspected; do not infer state from `git status` in the private worktree.'
  },
  async () => result(await invoke('workspace_state'))
)

server.registerTool(
  'prepare_conflict_resolution',
  {
    title: 'Prepare Praxis conflict resolution',
    description:
      'Ask Praxis to safely combine the current live checkout with this chat’s parked changes inside this chat worktree. Call when workspace_state says `parked`. If files are returned, resolve every marker in them; the normal turn completion will ask Praxis to land the resolved result.'
  },
  async () => result(await invoke('prepare_conflict_resolution'))
)

await server.connect(new StdioServerTransport())
