#!/usr/bin/env node
// Test ACP agent that echoes one selected environment variable back in its reply,
// or — when AC_ECHO_NAME is "ARGV" — its own spawn argv (to assert appended flags).
import { createInterface } from 'node:readline'
const rl = createInterface({ input: process.stdin })
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
let n = 0
let version = 1
rl.on('line', (line) => {
  if (!line.trim()) return
  const { id, method, params } = JSON.parse(line)
  if (method === 'initialize') {
    version = params.protocolVersion
    send({
      jsonrpc: '2.0',
      id,
      result:
        version === 2
          ? {
              protocolVersion: 2,
              info: { name: 'fixture', version: '1' },
              capabilities: { session: { systemPrompt: {} } }
            }
          : { protocolVersion: 1, agentCapabilities: {} }
    })
  } else if (method === 'session/new') {
    send({ jsonrpc: '2.0', id, result: { sessionId: `s${++n}` } })
  } else if (method === 'session/prompt') {
    if (version === 2)
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'state_update', state: 'running' }
        }
      })
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: `message-${n}`,
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
    send({ jsonrpc: '2.0', id, result: version === 2 ? { messageId: `user-${n}` } : { stopReason: 'end_turn' } })
    if (version === 2)
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' }
        }
      })
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, result: null })
  }
})
