#!/usr/bin/env node
// Test ACP agent whose path contains "claude" (so AcpHost treats it as a Claude
// runtime) — echoes process.env.CLAUDE_CODE_EXECUTABLE back in its reply, to assert
// the daemon's auto-injection of that var from a `claude` on PATH.
import { createInterface } from 'node:readline'
const rl = createInterface({ input: process.stdin })
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
let n = 0
rl.on('line', (line) => {
  if (!line.trim()) return
  const { id, method, params } = JSON.parse(line)
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: 1, agentCapabilities: {} } })
  } else if (method === 'session/new') {
    send({ jsonrpc: '2.0', id, result: { sessionId: `s${++n}` } })
  } else if (method === 'session/prompt') {
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `claude_exec:${process.env.CLAUDE_CODE_EXECUTABLE ?? ''}` }
        }
      }
    })
    send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, result: null })
  }
})
