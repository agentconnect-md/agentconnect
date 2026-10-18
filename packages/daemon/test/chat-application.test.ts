import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentSchema } from '../src/agents/agent-schema.js'
import { ChatSessionApplication } from '../src/session/chat-application.js'
import { transcriptChannelKey, type LocalStore } from '../src/store/local-store.js'
import { WebchatTransport, type WebchatHost } from '../src/webchat/transport.js'
import { memoryStoreDatabase, openTestStore } from './store-support.js'

const agentId = 'bot-a'
const conversationId = '88888888-8888-4888-8888-888888888888'
const author = { id: 'principal', name: 'Person' }
const opened: LocalStore[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((store) => store.close()))
})

async function fixture() {
  const store = await openTestStore({ database: memoryStoreDatabase() })
  opened.push(store)
  const agents = new Map([
    [
      agentId,
      {
        ...AgentSchema.parse({
          id: agentId,
          name: agentId,
          runtime: 'claude',
          workspace: { mode: 'from-scratch', path: '/tmp/chat-application' }
        }),
        dir: '/tmp/chat-application'
      }
    ]
  ])
  const host: WebchatHost = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    now: () => 100,
    store: () => store,
    agents: () => agents,
    mergedRules: () => [],
    paused: () => false,
    startFailure: () => undefined,
    safetyDraining: () => false,
    draining: () => false,
    agentDraining: () => false,
    turnFinalContextRefresh: () => true,
    holdContextForOwnTurn: vi.fn(),
    inflight: () => new Set(),
    serialQueue: () => new Map(),
    pending: () => new Map(),
    activeGateEntries: () => new Map(),
    interruptTurn: vi.fn(async () => {}),
    dispatch: vi.fn(async () => null),
    integrationIdForSessionTransport: () => undefined,
    connForIntegration: () => undefined,
    botUserIds: () => ({}),
    resolveCpAgent: () => null,
    sendWebchatPost: vi.fn(),
    collabAdmits: () => true
  }
  const admission = { full: false }
  const application = new ChatSessionApplication({ ...host, queueFull: () => admission.full })
  const transport = new WebchatTransport(host, application)
  const sink = { output: vi.fn(), done: vi.fn() }
  const send = (turnId: string, postId = turnId) =>
    transport.dispatchWebchatTurn(
      agentId,
      conversationId,
      'hello',
      author,
      sink,
      turnId,
      undefined,
      { model: 'requested' },
      undefined,
      [agentId],
      { postId, at: 100 }
    )
  return { store, host, application, transport, sink, send, agents, admission }
}

describe('shared chat application with the legacy adapter', () => {
  it('dispatches into the canonical session once while the adapter keeps its duplicate-stream gate', async () => {
    const { host, store, send } = await fixture()
    await expect(send('turn-a')).resolves.toEqual({ accepted: true, turnId: 'turn-a' })
    await expect(send('turn-a')).resolves.toEqual({ accepted: false, turnId: 'turn-a', reason: 'busy' })
    expect(host.dispatch).toHaveBeenCalledTimes(1)
    expect(host.dispatch).toHaveBeenCalledWith(
      agentId,
      expect.objectContaining({
        msgId: `webchat:${conversationId}`,
        channel: conversationId,
        traceId: 'turn-a',
        trigger: 'mention',
        sender: { id: 'principal', name: 'Person', isBot: false },
        transcriptPostId: 'turn-a'
      }),
      undefined,
      expect.objectContaining({ conversationId, turnId: 'turn-a' })
    )
    expect(
      await store.transcriptTextAt(transcriptChannelKey(conversationId), '100', {
        sender: author.id,
        recipient: agentId
      })
    ).toMatchObject({ postId: 'turn-a' })
  })

  it('carries collision-bumped admission coordinates into dispatch and retains the runtime policy', async () => {
    const { host, send, agents } = await fixture()
    await send('turn-a')
    await send('turn-b')
    const calls = vi.mocked(host.dispatch).mock.calls
    expect(calls[0]?.[1].transcriptTs).toBe('100')
    expect(calls[1]?.[1].transcriptTs).toBe('101')
    expect(calls[1]?.[3]?.runtime).toBeUndefined()
    agents.get(agentId)!.chatActions = 'settings'
    await send('turn-c')
    expect(vi.mocked(host.dispatch).mock.calls[2]?.[3]?.runtime).toEqual({ model: 'requested' })
  })

  it('keeps refused steering out of the durable transcript', async () => {
    const { host, transport, sink, store } = await fixture()
    vi.mocked(host.dispatch).mockImplementation(async (_agent, _message, _integration, _context, _meta, options) => {
      options?.onAdmission?.({ accepted: false, reason: 'busy' })
      return null
    })
    await expect(
      transport.dispatchWebchatTurn(
        agentId,
        conversationId,
        'hello',
        author,
        sink,
        'steer-a',
        undefined,
        undefined,
        undefined,
        undefined,
        { postId: 'steer-a', at: 100 },
        undefined,
        true
      )
    ).resolves.toMatchObject({ accepted: false, reason: 'busy' })
    expect(
      await store.transcriptTextAt(transcriptChannelKey(conversationId), '100', {
        sender: author.id,
        recipient: agentId
      })
    ).toBeUndefined()
    expect(transport.probeWebchatStream(agentId, conversationId)).toEqual({
      accepted: false,
      reason: 'stream_not_found'
    })
  })

  it('rechecks the shared queue synchronously at admission and starts no dispatch when full', async () => {
    const { host, send, admission } = await fixture()
    admission.full = true
    await expect(send('turn-a')).resolves.toEqual({ accepted: false, turnId: 'turn-a', reason: 'busy' })
    expect(host.dispatch).not.toHaveBeenCalled()
  })
})
