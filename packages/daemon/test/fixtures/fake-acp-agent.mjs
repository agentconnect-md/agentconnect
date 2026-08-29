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
const permissionModeList = (process.env.AC_PERMISSION_MODES ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const sessionPermissionModes = new Map()
const additionalDirectoriesEnabled = process.env.AC_ADDITIONAL_DIRECTORIES === '1'
const deleteSessionEnabled = process.env.AC_DELETE_SESSION === '1'
const expectedAdditionalDirectories = process.env.AC_EXPECT_ADDITIONAL_DIRECTORIES
  ? JSON.parse(process.env.AC_EXPECT_ADDITIONAL_DIRECTORIES)
  : undefined
const acceptsAdditionalDirectories = (id, params) => {
  if (expectedAdditionalDirectories === undefined) return true
  if (JSON.stringify(params.additionalDirectories ?? []) === JSON.stringify(expectedAdditionalDirectories)) return true
  send({
    jsonrpc: '2.0',
    id,
    error: {
      code: -32602,
      message: `unexpected additionalDirectories: ${JSON.stringify(params.additionalDirectories)}`
    }
  })
  return false
}

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
  ...(process.env.AC_LOAD_UPDATES ? { loadSession: true } : {}),
  ...(additionalDirectoriesEnabled || deleteSessionEnabled
    ? {
        sessionCapabilities: {
          ...(additionalDirectoriesEnabled ? { additionalDirectories: {} } : {}),
          ...(deleteSessionEnabled ? { delete: {} } : {})
        }
      }
    : {})
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
  if (permissionModeList.length) {
    options.push({
      id: 'mode',
      category: 'mode',
      type: 'select',
      currentValue: sessionPermissionModes.get(sessionId) ?? permissionModeList[0],
      options: permissionModeList.map((value) => ({ value, name: value }))
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
    if (!acceptsAdditionalDirectories(id, params)) return
    const sessionId = `s${++sessionCounter}`
    sessionModels.set(sessionId, modelList[0])
    sessionPermissionModes.set(sessionId, permissionModeList[0])
    send({ jsonrpc: '2.0', id, result: { sessionId, configOptions: configOptions(sessionId) } })
  } else if (method === 'session/set_config_option') {
    if (params.configId === 'model' && modelList.includes(params.value))
      sessionModels.set(params.sessionId, params.value)
    if (params.configId === 'mode' && permissionModeList.includes(params.value))
      sessionPermissionModes.set(params.sessionId, params.value)
    send({ jsonrpc: '2.0', id, result: { configOptions: configOptions(params.sessionId) } })
  } else if (method === 'session/load') {
    if (!acceptsAdditionalDirectories(id, params)) return
    if (process.env.AC_LOAD_PERMISSION_MODE)
      sessionPermissionModes.set(params.sessionId, process.env.AC_LOAD_PERMISSION_MODE)
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
  } else if (method === 'session/delete') {
    sessionModels.delete(params.sessionId)
    sessionPermissionModes.delete(params.sessionId)
    send({ jsonrpc: '2.0', id, result: {} })
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
