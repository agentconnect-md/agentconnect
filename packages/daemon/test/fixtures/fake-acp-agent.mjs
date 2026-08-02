#!/usr/bin/env node
// Minimal ACP agent for tests: JSON-RPC 2.0 over newline-delimited JSON on stdio.
import { createInterface } from 'node:readline'

const rl = createInterface({ input: process.stdin })
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
let sessionCounter = 0

// `AC_IGNORE_SIGTERM` simulates a hung/buggy adapter for AcpHost.stop() escalation
// tests: SIGTERM is swallowed and a keep-alive interval survives the graceful stdin
// EOF, so only the SIGKILL fallback can reap it.
if (process.env.AC_IGNORE_SIGTERM) {
  process.on('SIGTERM', () => {})
  setInterval(() => {}, 1000)
}

// A model selector config option (advertised on session/new). `AC_MODELS` (comma
// list) turns it on for model-switch tests; unset ⇒ no selector (original behavior).
const modelList = (process.env.AC_MODELS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const sessionModels = new Map()
const reviewerEnabled = process.env.AC_APPROVALS_REVIEWER === '1'
const sessionReviewers = new Map()

// Optional MCP transport capabilities advertised at initialize. `AC_MCP_CAPS`
// (comma list) turns them on; unset ⇒ no mcpCapabilities key at all.
const mcpCaps = (process.env.AC_MCP_CAPS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const agentCapabilities = () => ({
  ...(mcpCaps.length
    ? {
        mcpCapabilities: {
          http: mcpCaps.includes('http'),
          sse: mcpCaps.includes('sse')
        }
      }
    : {}),
  ...(process.env.AC_LOAD_UPDATES ? { loadSession: true } : {})
})
const configOptions = (sessionId) => {
  const options = []
  if (modelList.length) {
    options.push({
      id: 'model',
      category: 'model',
      type: 'select',
      currentValue: sessionModels.get(sessionId) ?? modelList[0],
      options: modelList.map((value) => ({ value, name: value }))
    })
  }
  if (reviewerEnabled) {
    options.push({
      id: 'approvals_reviewer',
      category: '_approvals_reviewer',
      type: 'select',
      currentValue: sessionReviewers.get(sessionId) ?? 'user',
      options: [
        { value: 'user', name: 'User' },
        { value: 'auto_review', name: 'Auto-review' }
      ]
    })
  }
  return options.length ? options : undefined
}

rl.on('line', async (line) => {
  if (!line.trim()) return
  const msg = JSON.parse(line)
  const { id, method, params } = msg
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: 1, agentCapabilities: agentCapabilities() } })
  } else if (method === 'session/new') {
    const sessionId = `s${++sessionCounter}`
    sessionModels.set(sessionId, modelList[0])
    sessionReviewers.set(sessionId, 'user')
    send({ jsonrpc: '2.0', id, result: { sessionId, configOptions: configOptions(sessionId) } })
  } else if (method === 'session/set_config_option') {
    if (params.configId === 'model' && modelList.includes(params.value))
      sessionModels.set(params.sessionId, params.value)
    if (params.configId === 'approvals_reviewer' && ['user', 'auto_review'].includes(params.value))
      sessionReviewers.set(params.sessionId, params.value)
    send({ jsonrpc: '2.0', id, result: { configOptions: configOptions(params.sessionId) } })
  } else if (method === 'session/load') {
    if (process.env.AC_LOAD_UPDATES) {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'historical output' } }
        }
      })
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'session_info_update', title: 'Restored title' }
        }
      })
    }
    send({ jsonrpc: '2.0', id, result: { configOptions: configOptions(params.sessionId) } })
  } else if (method === 'session/prompt') {
    const text = (params.prompt ?? []).map((b) => b.text ?? '').join('')
    // send a session/update notification to the client
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `echo:${text}` } }
      }
    })
    send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })
  } else if (method === 'session/cancel') {
    // session/cancel is a notification (no id), no response needed
    if (id !== undefined) {
      send({ jsonrpc: '2.0', id, result: null })
    }
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, result: null })
  }
})
