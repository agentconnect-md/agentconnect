#!/usr/bin/env node
// Scripted ACP runtime for AHP acceptance: no AHP, application, or authorization implementation lives here.
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const logPath = process.argv[2]
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
const log = (entry) => {
  if (logPath) appendFileSync(logPath, `${JSON.stringify(entry)}\n`)
}
const requests = new Map()
const running = new Map()
let sequence = 0
let sessions = 0
function ask(method, params) {
  const id = `fixture-${++sequence}`
  return new Promise((resolve) => {
    requests.set(id, resolve)
    send({ id, method, params })
  })
}
function update(sessionId, update) {
  send({ method: 'session/update', params: { sessionId, update } })
}
function text(sessionId, text) {
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
}

async function prompt(id, params) {
  const input = params.prompt
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
  let release
  const stopped = new Promise((resolve) => {
    release = resolve
  })
  const run = { cancelled: false, release }
  running.set(params.sessionId, run)
  text(params.sessionId, 'fixture started\n')
  if (input.includes('[ahp:approve]')) {
    const result = await Promise.race([
      ask('session/request_permission', {
        sessionId: params.sessionId,
        toolCall: {
          toolCallId: 'fixture-read',
          title: 'Read fixture',
          kind: 'read',
          status: 'pending',
          rawInput: { path: 'fixture.txt' }
        },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'deny-once', name: 'Deny', kind: 'reject_once' }
        ]
      }),
      stopped
    ])
    if (!run.cancelled) text(params.sessionId, `permission: ${JSON.stringify(result)}\n`)
  }
  if (!run.cancelled && input.includes('[ahp:input]')) {
    const result = await Promise.race([
      ask('elicitation/create', {
        sessionId: params.sessionId,
        mode: 'form',
        message: 'Choose fixture input',
        requestedSchema: {
          type: 'object',
          properties: { value: { type: 'string', enum: ['one', 'two'] } },
          required: ['value']
        }
      }),
      stopped
    ])
    if (!run.cancelled) text(params.sessionId, `input: ${JSON.stringify(result)}\n`)
  }
  if (!run.cancelled && input.includes('[ahp:hold]')) await stopped
  if (!run.cancelled && input.includes('[ahp:edit]')) {
    update(params.sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: 'fixture-edit',
      title: 'Edit fixture',
      kind: 'edit',
      status: 'in_progress',
      content: [{ type: 'diff', path: '/work/fixture.txt', oldText: 'old line\n', newText: 'new line\n' }]
    })
    update(params.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'fixture-edit', status: 'completed' })
  }
  if (!run.cancelled) {
    update(params.sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: 'fixture-tool',
      title: 'Read fixture',
      kind: 'read',
      status: 'in_progress',
      rawInput: { path: 'fixture.txt' }
    })
    update(params.sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'fixture-tool',
      status: 'completed',
      rawOutput: 'fixture output'
    })
    text(params.sessionId, 'fixture complete')
  }
  running.delete(params.sessionId)
  send({ id, result: { stopReason: run.cancelled ? 'cancelled' : 'end_turn' } })
}

createInterface({ input: process.stdin }).on('line', (line) => {
  void (async () => {
    const message = JSON.parse(line)
    const { id, method, params } = message
    log({ method: method ?? 'response', params: method ? params : message.result })
    if (!method) {
      requests.get(id)?.(message.result)
      requests.delete(id)
      return
    }
    switch (method) {
      case 'initialize':
        send({
          id,
          result: {
            protocolVersion: 1,
            agentInfo: { name: 'ahp-acceptance-runtime', version: '1.0.0' },
            agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } }
          }
        })
        return
      case 'session/new':
        send({ id, result: { sessionId: `fixture-session-${++sessions}` } })
        return
      case 'session/load':
        send({ id, result: {} })
        return
      case 'session/prompt':
        await prompt(id, params)
        return
      case 'session/cancel': {
        const run = running.get(params.sessionId)
        if (run) {
          run.cancelled = true
          run.release()
        }
        return
      }
      default:
        if (id !== undefined) send({ id, error: { code: -32601, message: 'Unsupported fixture method' } })
    }
  })().catch((error) => {
    process.stderr.write(`${error.stack}\n`)
    process.exitCode = 1
  })
})
