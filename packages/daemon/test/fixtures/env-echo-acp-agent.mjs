#!/usr/bin/env node
// Test ACP agent that echoes one selected environment variable back in its reply,
// or — when AC_ECHO_NAME is "ARGV" — its own spawn argv (to assert appended flags).
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
          content: {
            type: 'text',
            text:
              (process.env.AC_ECHO_NAME ?? 'AC_ECHO_VAR') === 'ARGV'
                ? `argv:${JSON.stringify(process.argv.slice(2))}`
                : `env:${process.env[process.env.AC_ECHO_NAME ?? 'AC_ECHO_VAR'] ?? ''}`
          }
        }
      }
    })
    send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, result: null })
  }
})
