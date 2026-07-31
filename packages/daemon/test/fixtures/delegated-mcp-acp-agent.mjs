#!/usr/bin/env node
import { createInterface } from 'node:readline'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

const ADMIN_SERVER_NAME = 'agentconnect-admin'
const ADMIN_UNAVAILABLE = 'AgentConnect admin tools are temporarily unavailable. Retry shortly.'
const ADMIN_UNEXPECTED = 'admin:unexpected-error'
const sessions = new Map()
let sessionCounter = 0

const rl = createInterface({ input: process.stdin })
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)

function textFromPrompt(prompt) {
  const textBlocks = (prompt ?? [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
  const text = textBlocks.at(-1) ?? ''
  // A human trigger arrives as `[<sender id>] <text>` (session-concept §2.1);
  // unwrap the sender envelope so command parsing sees the bare text.
  return text.replace(/^\[[^\]]+\] /, '')
}

function descriptorFor(params) {
  const descriptor = (params.mcpServers ?? []).find((server) => server?.name === ADMIN_SERVER_NAME)
  if (
    !descriptor ||
    typeof descriptor.command !== 'string' ||
    !Array.isArray(descriptor.args) ||
    !Array.isArray(descriptor.env)
  ) {
    return undefined
  }
  return descriptor
}

async function connectAdmin(params) {
  const descriptor = descriptorFor(params)
  if (!descriptor) return undefined
  const client = new Client({ name: 'agentconnect-delegated-mcp-fixture', version: '0.0.0' })
  const transport = new StdioClientTransport({
    command: descriptor.command,
    args: descriptor.args.filter((arg) => typeof arg === 'string'),
    env: Object.fromEntries(
      descriptor.env.flatMap((entry) =>
        entry && typeof entry.name === 'string' && typeof entry.value === 'string' ? [[entry.name, entry.value]] : []
      )
    )
  })
  try {
    await client.connect(transport)
    return client
  } catch (error) {
    await client.close().catch(() => {})
    throw error
  }
}

async function replaceSession(sessionId, params) {
  const previous = sessions.get(sessionId)
  if (previous) await previous.close().catch(() => {})
  const client = await connectAdmin(params)
  sessions.set(sessionId, client)
}

function emitText(sessionId, text) {
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text }
      }
    }
  })
}

async function answerPrompt(sessionId, prompt) {
  const text = textFromPrompt(prompt)
  if (text.startsWith('echo:')) return text

  const client = sessions.get(sessionId)
  if (!client) return `admin:error:${ADMIN_UNAVAILABLE}`

  try {
    if (text === 'admin:list') {
      const listed = await client.listTools()
      const names = listed.tools.map((tool) => tool.name).sort()
      return `admin:list:${names.join(',')}`
    }
    if (text.startsWith('admin:call ')) {
      const match = /^admin:call ([^ ]+)(?: (.*))?$/.exec(text)
      if (!match) return `admin:error:${ADMIN_UNAVAILABLE}`
      const args = match[2] ? JSON.parse(match[2]) : {}
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        return ADMIN_UNEXPECTED
      }
      const result = await client.callTool({ name: match[1], arguments: args })
      const message = (result.content ?? [])
        .filter((content) => content?.type === 'text' && typeof content.text === 'string')
        .map((content) => content.text)
        .join('\n')
      if (!result.isError) return `admin:call:${match[1]}:${message || 'ok'}`
      return message.includes(ADMIN_UNAVAILABLE) ? `admin:error:${ADMIN_UNAVAILABLE}` : ADMIN_UNEXPECTED
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    return message.includes(ADMIN_UNAVAILABLE) ? `admin:error:${ADMIN_UNAVAILABLE}` : ADMIN_UNEXPECTED
  }
  return `echo:${text}`
}

rl.on('line', (line) => {
  if (!line.trim()) return
  void (async () => {
    const message = JSON.parse(line)
    const { id, method, params = {} } = message
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true }
        }
      })
      return
    }
    if (method === 'session/new') {
      const sessionId = `delegated-fixture-${++sessionCounter}`
      await replaceSession(sessionId, params)
      send({ jsonrpc: '2.0', id, result: { sessionId } })
      return
    }
    if (method === 'session/load') {
      await replaceSession(params.sessionId, params)
      send({ jsonrpc: '2.0', id, result: {} })
      return
    }
    if (method === 'session/prompt') {
      emitText(params.sessionId, await answerPrompt(params.sessionId, params.prompt))
      send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })
      return
    }
    if (method === 'session/cancel') {
      if (id !== undefined) send({ jsonrpc: '2.0', id, result: null })
      return
    }
    if (id !== undefined) send({ jsonrpc: '2.0', id, result: null })
  })().catch(() => {
    if (line.trim()) {
      const message = JSON.parse(line)
      if (message.id !== undefined) {
        send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32603, message: 'fixture request failed' }
        })
      }
    }
  })
})

async function shutdown() {
  await Promise.all([...sessions.values()].flatMap((client) => (client ? [client.close().catch(() => {})] : [])))
  sessions.clear()
}

rl.on('close', () => {
  void shutdown()
})
process.on('SIGTERM', () => {
  void shutdown().finally(() => process.exit(0))
})
