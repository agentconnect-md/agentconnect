#!/usr/bin/env node
// The PUPPET ACP adapter — how a real-subject run gets a SCRIPTED referee that
// still acts through the real tool surface.
//
// The daemon launches this like any other ACP runtime (config.json `runtimes`
// entry). It is a hand-rolled JSON-RPC 2.0 peer over newline-delimited JSON on
// stdio (like packages/daemon/test/fixtures/scriptable-acp-agent.mjs), but it
// holds NO policy at all: every `session/prompt` is forwarded over a local
// socket (`AC_PUPPET_ENDPOINT`) to the evaluation driver, which runs the
// deterministic brain (TypeScript, shared with the scripted CI variant) and
// performs the brain's `sendMessage` calls itself against the daemon's MCP
// control socket, using the per-session binding this adapter captured at
// `session/new` (AC_MCP_ENDPOINT / AC_MCP_TOKEN in the injected server env —
// the exact material the mcp-bridge subprocess would use).
//
// The result: eval composition == live composition — the referee is an
// ordinary agent whose calls run the production trusted-session-context path —
// while its brain stays deterministic and fully typed in the driver process.
import net from 'node:net'
import { createInterface } from 'node:readline'

const endpoint = process.env.AC_PUPPET_ENDPOINT
if (!endpoint) {
  process.stderr.write('puppet-acp-agent: AC_PUPPET_ENDPOINT must be set\n')
  process.exit(1)
}

// ── driver link (newline-delimited JSON over the unix socket) ──────────────
const driver = net.connect(endpoint)
driver.setEncoding('utf8')
let driverBuffer = ''
let requestId = 0
const pendingDriver = new Map()
driver.on('data', (chunk) => {
  driverBuffer += chunk
  let newline
  while ((newline = driverBuffer.indexOf('\n')) !== -1) {
    const line = driverBuffer.slice(0, newline)
    driverBuffer = driverBuffer.slice(newline + 1)
    if (!line.trim()) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    const resolve = pendingDriver.get(message.id)
    if (resolve) {
      pendingDriver.delete(message.id)
      resolve(message)
    }
  }
})
driver.on('error', (error) => {
  process.stderr.write(`puppet-acp-agent: driver socket error: ${error.message}\n`)
  process.exit(1)
})
function askDriver(payload) {
  const id = ++requestId
  return new Promise((resolve) => {
    pendingDriver.set(id, resolve)
    driver.write(`${JSON.stringify({ id, ...payload })}\n`)
  })
}

/** Extract the daemon control-socket binding from `session/new`'s mcpServers. */
function bindingOf(mcpServers) {
  if (!Array.isArray(mcpServers)) return undefined
  for (const server of mcpServers) {
    const env = server?.env
    if (!Array.isArray(env)) continue
    const endpointVar = env.find((entry) => entry?.name === 'AC_MCP_ENDPOINT')?.value
    const token = env.find((entry) => entry?.name === 'AC_MCP_TOKEN')?.value
    if (typeof endpointVar === 'string' && typeof token === 'string') return { endpoint: endpointVar, token }
  }
  return undefined
}

// ── the ACP stdio side ─────────────────────────────────────────────────────
const rl = createInterface({ input: process.stdin })
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
const update = (sessionId, u) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } })
let sessionCounter = 0

rl.on('line', async (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  const { id, method, params } = msg
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: 1, agentCapabilities: {} } })
  } else if (method === 'session/new') {
    const sessionId = `puppet-${++sessionCounter}`
    await askDriver({ op: 'new', sessionId, binding: bindingOf(params?.mcpServers) ?? null })
    send({ jsonrpc: '2.0', id, result: { sessionId } })
  } else if (method === 'session/prompt') {
    const text = (params?.prompt ?? []).map((block) => block?.text ?? '').join('\n')
    const answer = await askDriver({ op: 'prompt', sessionId: params?.sessionId, text })
    update(params?.sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: typeof answer.reply === 'string' ? answer.reply : 'AC_NO_RESPONSE' }
    })
    send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })
  } else if (method === 'session/cancel') {
    if (id !== undefined) send({ jsonrpc: '2.0', id, result: null })
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, result: null })
  }
})
