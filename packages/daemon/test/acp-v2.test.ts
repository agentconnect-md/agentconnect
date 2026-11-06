import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as V2 from '@agentclientprotocol/sdk/experimental/v2/unstable'
import { createV2Client } from '../src/acp/acp-v2-client.js'
import { V2SessionUpdates, permissionFromV2 } from '../src/acp/acp-v2-updates.js'
import { RuntimeSessionFailure, SESSION_FAILURE_CAPABILITIES } from '../src/acp/session-failure.js'

const cleanup: Array<() => void> = []
afterEach(() => cleanup.splice(0).forEach((close) => close()))
const usage = { totalTokens: 9, inputTokens: 6, outputTokens: 3 }
const model: V2.SessionConfigOption = {
  type: 'select',
  configId: 'model',
  name: 'Model',
  category: 'model',
  currentValue: 'test',
  options: [{ groupId: 'models', name: 'Models', options: [{ name: 'Test', value: 'test' }] }]
}
const fast: V2.SessionConfigOption = {
  type: 'boolean',
  configId: 'fast',
  name: 'Fast',
  category: 'model_config',
  currentValue: false
}

async function fixture(onRequest?: (request: V2.AnyRequest, reply: (result: unknown) => void) => boolean) {
  let inbound!: ReadableStreamDefaultController<V2.AnyMessage>
  const requests: V2.AnyRequest[] = []
  const sent: V2.AnyMessage[] = []
  const handlers = {
    update: vi.fn(),
    permission: vi.fn(async () => ({ outcome: { outcome: 'selected' as const, optionId: 'allow' } })),
    elicit: vi.fn(async () => ({ action: 'accept' as const, content: { answer: 'yes' } })),
    elicitationComplete: vi.fn(),
    sdkLifecycle: vi.fn()
  }
  const input = new ReadableStream<V2.AnyMessage>({
    start(controller) {
      inbound = controller
    }
  })
  const client = createV2Client(
    {
      readable: input,
      writable: new WritableStream({
        write(message: V2.AnyMessage) {
          sent.push(message)
          if (!('method' in message) || !('id' in message)) return
          const request = message as V2.AnyRequest
          requests.push(request)
          const reply = (result: unknown) => inbound.enqueue({ jsonrpc: '2.0', id: request.id, result })
          if (onRequest?.(request, reply)) return
          switch (request.method) {
            case 'initialize':
              reply({
                protocolVersion: 2,
                info: { name: 'fixture', version: '1' },
                capabilities: {
                  session: { systemPrompt: {}, delete: {}, additionalDirectories: {}, mcp: { stdio: {}, http: {} } }
                },
                authMethods: [{ type: 'agent', methodId: 'login', name: 'Login' }],
                _meta: { steering: { supported: true } }
              })
              break
            case 'session/new':
              reply({ sessionId: 's1', configOptions: [model, fast] })
              break
            case 'session/resume':
              reply({ configOptions: [model, fast] })
              break
            case 'session/set_config_option':
              reply({ configOptions: [model, { ...fast, currentValue: true }] })
              break
            case 'session/prompt':
              reply({ messageId: 'user' })
              break
            default:
              reply({})
          }
        }
      })
    },
    handlers
  )
  let closed = false
  const close = () => {
    if (!closed) {
      closed = true
      inbound.close()
    }
  }
  cleanup.push(close)
  const send = (message: V2.AnyMessage) => inbound.enqueue(message)
  const update = (update: V2.SessionUpdate, sessionId = 's1') =>
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } })
  const init = await client.initialize({
    protocolVersion: 1,
    clientCapabilities: {
      _meta: SESSION_FAILURE_CAPABILITIES,
      elicitation: { form: {}, url: {} },
      auth: { terminal: true }
    }
  })
  return { client, init, requests, sent, handlers, send, update, close }
}

describe('ACP v2 client', () => {
  it('negotiates AIR, native creation instructions, replay, auth, MCP and boolean configuration', async () => {
    const f = await fixture()
    expect(f.init).toMatchObject({
      protocolVersion: 2,
      authMethods: [{ id: 'login' }],
      agentCapabilities: { loadSession: true }
    })
    expect(f.requests[0]!.params).toMatchObject({
      protocolVersion: 2,
      capabilities: { _meta: SESSION_FAILURE_CAPABILITIES, auth: { terminal: {} } }
    })
    const res = await f.client.newSession({
      cwd: '/workspace',
      mcpServers: [{ name: 'local', command: 'tool', args: [], env: [] }],
      instructions: 'Follow the review policy.'
    })
    expect(f.requests.at(-1)!.params).toMatchObject({
      systemPrompt: { mode: 'append', content: [{ type: 'text', text: 'Follow the review policy.' }] },
      mcpServers: [{ type: 'stdio' }]
    })
    expect(res.configOptions).toMatchObject([
      { id: 'model', options: [{ group: 'models', options: [{ value: 'test' }] }] },
      { id: 'fast', type: 'select', currentValue: 'off' }
    ])
    await f.client.setConfig({ sessionId: 's1', configId: 'fast', value: 'on' })
    expect(f.requests.at(-1)!.params).toMatchObject({ type: 'boolean', value: true })
    await f.client.setConfig({ sessionId: 's1', configId: 'model', value: 'test' })
    expect(f.requests.at(-1)!.params).toMatchObject({ type: 'id', value: 'test' })
    await f.client.loadSession({ sessionId: 's1', cwd: '/workspace', mcpServers: [], instructions: 'Updated policy.' })
    expect(f.requests.at(-1)).toMatchObject({
      method: 'session/resume',
      params: { replayFrom: { type: 'start' } }
    })
    expect(f.requests.at(-1)!.params).not.toHaveProperty('systemPrompt')
    await f.client.authenticate('login')
    expect(f.requests.at(-1)).toMatchObject({ method: 'auth/login', params: { methodId: 'login' } })
  })

  it('waits past acknowledgement and interactive work, completes once, and ignores stale idle snapshots', async () => {
    const f = await fixture()
    const done = vi.fn()
    const prompt = f.client.prompt({ sessionId: 's1', prompt: [{ type: 'text', text: 'Do the work' }] }).then(done)
    await vi.waitFor(() => expect(f.requests.at(-1)?.method).toBe('session/prompt'))
    expect(done).not.toHaveBeenCalled()
    f.update({ sessionUpdate: 'state_update', state: 'requires_action' })
    await f.client.cancel('s1')
    expect(done).not.toHaveBeenCalled()
    f.update({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'cancelled', usage })
    await prompt
    expect(done).toHaveBeenCalledWith({ stopReason: 'cancelled', usage, _meta: undefined })
    const secondDone = vi.fn()
    const next = f.client.prompt({ sessionId: 's1', prompt: [] }).then(secondDone)
    f.update({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'cancelled', usage })
    f.update({ sessionUpdate: 'agent_message_chunk', messageId: 'reply', content: { type: 'text', text: 'working' } })
    await vi.waitFor(() => expect(f.handlers.update).toHaveBeenCalled())
    expect(secondDone).not.toHaveBeenCalled()
    f.update({ sessionUpdate: 'state_update', state: 'running' })
    f.update({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn', usage })
    await next
    expect(done).toHaveBeenCalledTimes(1)
    expect(secondDone).toHaveBeenCalledTimes(1)
  })

  it('accepts completion before acknowledgement but still propagates request errors', async () => {
    let respond!: (result: unknown) => void
    const f = await fixture((request, reply) => {
      if (request.method !== 'session/prompt') return false
      respond = reply
      return true
    })
    const done = vi.fn()
    const prompt = f.client.prompt({ sessionId: 's1', prompt: [] }).then(done)
    await vi.waitFor(() => expect(respond).toBeTypeOf('function'))
    f.update({ sessionUpdate: 'state_update', state: 'running' })
    f.update({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn', usage })
    expect(done).not.toHaveBeenCalled()
    respond({ messageId: 'user' })
    await prompt
    const rejected = f.client.prompt({ sessionId: 's1', prompt: [] })
    const check = expect(rejected).rejects.toMatchObject({ code: -32002 })
    await vi.waitFor(() => expect(f.requests.filter((r) => r.method === 'session/prompt')).toHaveLength(2))
    f.update({ sessionUpdate: 'state_update', state: 'running' })
    f.update({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' })
    f.send({ jsonrpc: '2.0', id: f.requests.at(-1)!.id, error: { code: -32002, message: 'Session not found' } })
    await check
  })

  it.each(['disconnect', 'release', 'failure', 'air'] as const)(
    'rejects an acknowledged prompt on %s',
    async (mode) => {
      const f = await fixture()
      const prompt = f.client.prompt({ sessionId: 's1', prompt: [] })
      const check =
        mode === 'air'
          ? expect(prompt).rejects.toBeInstanceOf(RuntimeSessionFailure)
          : expect(prompt).rejects.toBeInstanceOf(Error)
      await vi.waitFor(() => expect(f.requests.at(-1)?.method).toBe('session/prompt'))
      if (mode === 'disconnect') f.close()
      else if (mode === 'release') f.client.forgetSession('s1')
      else {
        f.update({ sessionUpdate: 'state_update', state: 'running' })
        f.update({
          sessionUpdate: 'state_update',
          state: 'idle',
          stopReason: 'error',
          error: { code: -32603, message: 'Failed' },
          ...(mode === 'air'
            ? {
                _meta: {
                  jetbrains: {
                    air: {
                      version: 1,
                      sessionFailure: { severity: 'error', category: 'limit', title: 'Quota exhausted', actions: [] }
                    }
                  }
                }
              }
            : {})
        })
      }
      await check
    }
  )

  it('keeps concurrent sessions independent and refuses overlapping prompts within one session', async () => {
    const f = await fixture()
    const a = f.client.prompt({ sessionId: 'a', prompt: [] })
    const b = f.client.prompt({ sessionId: 'b', prompt: [] })
    await expect(f.client.prompt({ sessionId: 'a', prompt: [] })).rejects.toThrow('already running')
    f.update({ sessionUpdate: 'state_update', state: 'running' }, 'b')
    f.update({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'cancelled' }, 'b')
    await expect(b).resolves.toMatchObject({ stopReason: 'cancelled' })
    f.update({ sessionUpdate: 'state_update', state: 'running' }, 'a')
    f.update({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' }, 'a')
    await expect(a).resolves.toMatchObject({ stopReason: 'end_turn' })
  })

  it('routes permissions and typed elicitations through the existing handlers', async () => {
    const f = await fixture()
    f.send({
      jsonrpc: '2.0',
      id: 'permission',
      method: 'session/request_permission',
      params: {
        sessionId: 's1',
        title: 'Run tests',
        subject: { type: 'command', command: 'node --test', cwd: '/workspace', toolCallId: 'tool' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
      }
    })
    f.send({
      jsonrpc: '2.0',
      id: 'form',
      method: 'elicitation/create',
      params: {
        sessionId: 's1',
        mode: 'form',
        message: 'Continue?',
        requestedSchema: { type: 'object', properties: { answer: { type: 'string' } } }
      }
    })
    await vi.waitFor(() =>
      expect(f.sent).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'permission',
            result: { outcome: { outcome: 'selected', optionId: 'allow' } }
          }),
          expect.objectContaining({ id: 'form', result: { action: 'accept', content: { answer: 'yes' } } })
        ])
      )
    )
    expect(f.handlers.permission.mock.calls[0]).toMatchObject([
      { toolCall: { toolCallId: 'tool', kind: 'execute', rawInput: { command: 'node --test' } } }
    ])
  })
})

describe('ACP v2 updates', () => {
  it('delivers the final markdown plan once even when a snapshot replaces earlier text', () => {
    const state = new V2SessionUpdates()
    state.update({ sessionUpdate: 'plan_update', plan: { type: 'markdown', planId: 'p', content: 'Draft' } })
    state.update({ sessionUpdate: 'plan_update', plan: { type: 'markdown', planId: 'p', content: 'Final plan' } })
    expect(state.finish()).toEqual([
      { sessionUpdate: 'agent_message_chunk', messageId: 'p', content: { type: 'text', text: 'Final plan' } }
    ])
    expect(state.finish()).toEqual([])
  })

  it('creates tools once, merges metadata patches, folds UTF-8 terminals and replaces snapshots', () => {
    const state = new V2SessionUpdates()
    const first = state.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't',
      title: 'Run',
      status: 'in_progress',
      content: [{ type: 'terminal', terminalId: 'term' }],
      _meta: { keep: true, remove: true }
    })
    expect(first[0]).toMatchObject({ sessionUpdate: 'tool_call', title: 'Run' })
    const bytes = Buffer.from('结果')
    state.update({
      sessionUpdate: 'terminal_output_chunk',
      terminalId: 'term',
      data: bytes.subarray(0, 2).toString('base64')
    })
    expect(
      state.update({
        sessionUpdate: 'terminal_output_chunk',
        terminalId: 'term',
        data: bytes.subarray(2).toString('base64')
      })[0]
    ).toMatchObject({ rawOutput: { formatted_output: '结果' } })
    state.update({
      sessionUpdate: 'terminal_update',
      terminalId: 'term',
      output: { data: Buffer.from('complete').toString('base64') }
    })
    expect(
      state.update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 't',
        status: 'completed',
        _meta: { remove: null },
        rawOutput: { formatted_output: '', exit_code: 0 }
      })[0]
    ).toMatchObject({
      sessionUpdate: 'tool_call_update',
      status: 'completed',
      rawOutput: { formatted_output: 'complete', exit_code: 0 },
      _meta: { keep: true }
    })
    expect(state.update({ sessionUpdate: 'tool_call_update', toolCallId: 't', _meta: null })[0]?._meta).toBeNull()
  })

  it('converts real patch hunks, plans and content chunks without losing prior tool content', () => {
    const state = new V2SessionUpdates()
    const result = state.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'edit',
      title: 'Edit',
      content: [
        {
          type: 'diff',
          changes: [{ operation: 'modify', path: '/workspace/file.txt' }],
          patch: {
            format: 'git_patch',
            text: '--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file\n'
          }
        }
      ]
    })
    expect(result[0]).toMatchObject({
      content: [{ type: 'diff', oldText: 'old\n', newText: 'new', path: '/workspace/file.txt' }]
    })
    const chunk = state.update({
      sessionUpdate: 'tool_call_content_chunk',
      toolCallId: 'edit',
      content: { type: 'content', content: { type: 'text', text: 'done' } }
    })
    expect(chunk[0]).toMatchObject({
      content: [
        { type: 'diff', newText: 'new' },
        { type: 'content', content: { text: 'done' } }
      ]
    })
    expect(
      state.update({
        sessionUpdate: 'plan_update',
        plan: { type: 'items', planId: 'p', entries: [{ content: 'Test', status: 'completed', priority: 'medium' }] }
      })[0]
    ).toMatchObject({ sessionUpdate: 'plan', entries: [{ content: 'Test', status: 'completed' }] })
    expect(
      permissionFromV2({
        sessionId: 's',
        title: 'Edit',
        subject: { type: 'tool_call', toolCall: { toolCallId: 'edit', title: 'Apply patch', kind: 'edit' } },
        options: []
      }).toolCall
    ).toMatchObject({ toolCallId: 'edit', title: 'Apply patch', kind: 'edit' })
  })
})
