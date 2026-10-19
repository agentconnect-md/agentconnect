import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentSchema } from '../src/agents/agent-schema.js'
import { ChatSessionApplication } from '../src/session/chat-application.js'
import { ChatSessionContinuation } from '../src/session/chat-continuation.js'
import { sessionKey, transcriptChannelKey, type LocalStore } from '../src/store/local-store.js'
import { WebchatTransport, type WebchatHost, type WebchatReplyConnection } from '../src/webchat/transport.js'
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
  const connections = new Map<string, WebchatReplyConnection>()
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
    integrationIdForSessionTransport: () => (connections.has('origin') ? 'origin' : undefined),
    connForIntegration: (id) => connections.get(id),
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
  return { store, host, application, transport, sink, send, agents, admission, connections }
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

async function continuationFixture(platform = 'slack') {
  const f = await fixture()
  const key = sessionKey(platform, 'channel', 'thread', agentId, 'account')
  await f.store.upsertSession({
    key,
    agentId,
    platform,
    channel: 'channel',
    thread: 'thread',
    transportScope: 'account',
    sessionId: 'outward',
    acpSessionId: 'runtime-private',
    state: 'idle',
    lastDeliveredTs: null,
    updatedAt: 1
  })
  const postAsAuthor = vi.fn<() => Promise<{ ts: string; text: string } | undefined>>(async () => ({
    ts: '200',
    text: 'continued'
  }))
  const finalizeResponse = vi.fn(async () => true)
  f.connections.set('origin', { postAsAuthor, finalizeResponse } as unknown as WebchatReplyConnection)
  const send = () =>
    f.transport.dispatchWebchatContinuationTurn(
      agentId,
      conversationId,
      'outward',
      'continued',
      author,
      f.sink,
      'continuation-turn'
    )
  return { ...f, key, postAsAuthor, finalizeResponse, send }
}

describe('shared continuation behind the legacy adapter', () => {
  it('reserves admission before the origin mirror and releases execution only after proven delivery', async () => {
    const { host, send, postAsAuthor, finalizeResponse, key } = await continuationFixture()
    const order: string[] = []
    vi.mocked(host.dispatch).mockImplementation(async (_agent, message, integration, context, _meta, options) => {
      expect(sessionKey(message.platform, message.channel, message.thread!, agentId, message.transportScope)).toBe(key)
      expect(message.adoptedSession).toBe(true)
      expect(integration).toBe('origin')
      expect(context?.continuation).toBe(true)
      order.push('admit')
      options?.onAdmission?.({ accepted: true })
      if (await options?.admissionWait) order.push('execute')
      return null
    })
    postAsAuthor.mockImplementation(async () => {
      order.push('mirror')
      return { ts: '200', text: 'continued' }
    })
    await expect(send()).resolves.toEqual({ accepted: true, turnId: 'continuation-turn' })
    expect(order).toEqual(['admit', 'mirror', 'execute'])
    expect(finalizeResponse).toHaveBeenCalledOnce()
    expect(host.dispatch).toHaveBeenCalledOnce()
  })

  it('refuses execution and drops only its stream when the provider cannot prove mirror delivery', async () => {
    const { host, send, postAsAuthor, transport } = await continuationFixture()
    let executed = false
    vi.mocked(host.dispatch).mockImplementation(async (_agent, _message, _integration, _context, _meta, options) => {
      options?.onAdmission?.({ accepted: true })
      executed = await options!.admissionWait!
      return null
    })
    postAsAuthor.mockResolvedValue(undefined)
    await expect(send()).resolves.toEqual({
      accepted: false,
      turnId: 'continuation-turn',
      reason: 'integration_delivery_failed'
    })
    expect(executed).toBe(false)
    expect(transport.probeWebchatStream(agentId, conversationId)).toEqual({
      accepted: false,
      reason: 'stream_not_found'
    })
  })

  it('never mirrors a turn refused by the shared execution gate', async () => {
    const { host, send, postAsAuthor } = await continuationFixture()
    vi.mocked(host.dispatch).mockImplementation(async (_agent, _message, _integration, _context, _meta, options) => {
      options?.onAdmission?.({ accepted: false, reason: 'draining' })
      expect(await options?.admissionWait).toBe(false)
      return null
    })
    await expect(send()).resolves.toMatchObject({ accepted: false, reason: 'draining' })
    expect(postAsAuthor).not.toHaveBeenCalled()
  })

  it('continues a hook transcript once without requiring or invoking a platform integration', async () => {
    const { host, send, connections, postAsAuthor } = await continuationFixture('hook')
    connections.clear()
    await expect(send()).resolves.toMatchObject({ accepted: true })
    expect(host.dispatch).toHaveBeenCalledOnce()
    const call = vi.mocked(host.dispatch).mock.calls[0]!
    expect(call[1]).toMatchObject({
      platform: 'hook',
      channel: 'channel',
      thread: 'thread',
      transportScope: 'account'
    })
    expect(call[2]).toBeUndefined()
    expect(call[3]?.continuation).toBeUndefined()
    expect(postAsAuthor).not.toHaveBeenCalled()
  })
})

describe('durable continuation admission', () => {
  async function prepare() {
    const f = await continuationFixture()
    const continuation = new ChatSessionContinuation(
      {
        ...f.host,
        dispatch: (agent, message, integration, context, options) =>
          f.host.dispatch(agent, message, integration, context, undefined, options)
      },
      f.application
    )
    const prepared = await continuation.prepare({
      agentId,
      conversationId,
      targetSessionId: 'outward',
      turnId: 'durable',
      text: 'continued',
      author
    })
    if (!prepared.accepted) throw new Error('fixture failed')
    return { ...f, continuation, prepared, context: { conversationId, turnId: 'durable', sink: f.sink } }
  }

  it('awaits the durable admission effect after the mirror and before execution', async () => {
    const f = await prepare()
    const order: string[] = []
    f.postAsAuthor.mockImplementation(async () => {
      order.push('mirror')
      return { ts: '200', text: 'continued' }
    })
    vi.mocked(f.host.dispatch).mockImplementation(async (_a, _m, _i, _c, _meta, options) => {
      expect(options).toMatchObject({ requireDurable: true, receiptId: 'stable-receipt' })
      await options?.onAdmission?.({ accepted: true })
      if (await options?.admissionWait) order.push('execute')
      return null
    })
    await f.continuation.dispatch(f.prepared.turn, f.context, vi.fn(), {
      requireDurable: true,
      receiptId: 'stable-receipt',
      onAdmission: async () => {
        await Promise.resolve()
        order.push('echo')
      }
    })
    expect(order).toEqual(['mirror', 'echo', 'execute'])
  })

  it('reconciles a durable duplicate without mirroring again', async () => {
    const f = await prepare()
    const onAdmission = vi.fn(async () => {})
    vi.mocked(f.host.dispatch).mockImplementation(async (_a, _m, _i, _c, _meta, options) => {
      await options?.onAdmission?.({ accepted: true, duplicate: true })
      return null
    })
    await expect(
      f.continuation.dispatch(f.prepared.turn, f.context, vi.fn(), {
        requireDurable: true,
        receiptId: 'stable',
        onAdmission
      })
    ).resolves.toEqual({ accepted: true })
    expect(f.postAsAuthor).not.toHaveBeenCalled()
    expect(onAdmission).toHaveBeenCalledWith({ accepted: true, duplicate: true })
  })

  it('does not acknowledge admission when the platform mirror fails', async () => {
    const f = await prepare()
    f.postAsAuthor.mockResolvedValue(undefined)
    const onAdmission = vi.fn(async () => {})
    vi.mocked(f.host.dispatch).mockImplementation(async (_a, _m, _i, _c, _meta, options) => {
      await options?.onAdmission?.({ accepted: true })
      expect(await options?.admissionWait).toBe(false)
      return null
    })
    await expect(
      f.continuation.dispatch(f.prepared.turn, f.context, vi.fn(), { requireDurable: true, onAdmission })
    ).resolves.toMatchObject({ accepted: false, reason: 'integration_delivery_failed' })
    expect(onAdmission).not.toHaveBeenCalled()
  })
})
