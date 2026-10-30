import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import {
  SessionStatus,
  ActionType,
  AhpErrorCodes,
  JsonRpcErrorCodes,
  MessageKind
} from '@microsoft/agent-host-protocol'
import type { AhpAttachmentAuthorization, AhpSessionBinding, RdAhpOpen } from '@agentconnect.md/protocol'
import { AhpService, chatChannel, type AhpServiceOptions } from '../../src/ahp/service.js'

const disposals: (() => void)[] = []
afterEach(() => {
  disposals.splice(0).forEach((dispose) => dispose())
  vi.useRealTimers()
})
function fixture(overrides: Partial<AhpServiceOptions> = {}) {
  const auth: AhpAttachmentAuthorization = {
    orgId: 'org',
    agentId: randomUUID(),
    userId: 'reader',
    user: 'Reader',
    callerRole: 'editor',
    callerApproves: true,
    grant: { token: 'signed', expiresAtMs: Date.now() + 60_000 }
  }
  const binding: AhpSessionBinding & { sessionId: string } = {
    reservationId: randomUUID(),
    conversationId: randomUUID(),
    sessionUri: 'ahp-session:/one',
    sessionId: 'outward',
    callerRole: 'participant'
  }
  let high = 0
  const history = vi.fn(async () => ({
    resource: chatChannel(binding.sessionUri),
    title: 'One',
    status: SessionStatus.Idle,
    modifiedAt: new Date(0).toISOString(),
    turns: []
  }))
  const options: AhpServiceOptions = {
    enabled: () => true,
    available: () => true,
    now: Date.now,
    provider: () => ({ provider: auth.agentId, displayName: 'Agent', description: '', models: [] }),
    reserveSequence: async (_org, _agent, size) => ({ start: high + 1, end: (high += size) }),
    duty: () => undefined,
    registry: {
      list: vi.fn(async () => ({ ok: true as const, sessions: [binding] })),
      resolve: vi.fn(async () => ({ ok: true as const, ...binding })),
      reserve: vi.fn(async () => ({ ok: true as const, ...binding })),
      finalize: vi.fn(async () => ({ ok: true as const, ...binding }))
    },
    history,
    ensureSession: vi.fn(async () => binding.sessionId),
    dispatch: vi.fn(async (params, origin, context) => {
      await context.state.apply(params.channel, params.action, origin)
    }),
    ...overrides
  }
  const service = new AhpService(options)
  disposals.push(() => service.dispose())
  const connect = async (
    authorization = auth,
    connection = 'transport',
    attachmentId = randomUUID(),
    handshake?: RdAhpOpen['handshake']
  ) => {
    const input: RdAhpOpen = { attachmentId, authorization, ...(handshake ? { handshake } : {}) }
    const messages: any[] = []
    const close = vi.fn()
    const accepted = await service.open(
      input,
      { send: (message) => messages.push(JSON.parse(message)), close },
      connection
    )
    let id = 0
    const request = async (method: string, params: unknown) => {
      const requestId = ++id
      await service.receive(
        { attachmentId, message: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) },
        connection
      )
      return messages.find((message) => message.id === requestId)
    }
    const initialize = () =>
      request('initialize', { channel: 'ahp-root://', clientId: 'client', protocolVersions: ['1.0.0'] })
    return { input, accepted, request, initialize, messages, close, connection }
  }
  return { service, auth, binding, options, history, connect }
}

it('off refuses attachment without allocating sequence, registry, or execution', async () => {
  const reserveSequence = vi.fn()
  const { connect, options } = fixture({ enabled: () => false, reserveSequence })
  expect((await connect()).accepted).toBe(false)
  expect(reserveSequence).not.toHaveBeenCalled()
  expect(options.registry.list).not.toHaveBeenCalled()
  expect(options.dispatch).not.toHaveBeenCalled()
})

it('adopts a client the relay initialized, replaces its placeholder agent and runs its turn', async () => {
  const { connect, service, auth, binding, options } = fixture()
  const peer = await connect(auth, 'transport', randomUUID(), { clientId: 'third-party', root: true })
  expect(peer.accepted).toBe(true)
  expect(peer.messages).toEqual([
    {
      jsonrpc: '2.0',
      method: 'action',
      params: {
        channel: 'ahp-root://',
        serverSeq: expect.any(Number),
        action: { type: ActionType.RootAgentsChanged, agents: [expect.objectContaining({ displayName: 'Agent' })] }
      }
    }
  ])
  expect((await peer.initialize()).error.code).toBe(JsonRpcErrorCodes.InvalidRequest)
  const chat = chatChannel(binding.sessionUri)
  await peer.request('subscribe', { channel: chat })
  const turn = {
    type: ActionType.ChatTurnStarted,
    turnId: 'turn',
    startedAt: new Date(0).toISOString(),
    message: { text: 'Hello', origin: { kind: MessageKind.User } }
  }
  await service.receive(
    {
      attachmentId: peer.input.attachmentId,
      message: JSON.stringify({
        jsonrpc: '2.0',
        method: 'dispatchAction',
        params: { channel: chat, clientSeq: 1, action: turn }
      })
    },
    peer.connection
  )
  expect(options.dispatch).toHaveBeenCalledWith(
    expect.objectContaining({ channel: chat }),
    { clientId: 'third-party', clientSeq: 1 },
    expect.anything()
  )
  expect(peer.messages).toContainEqual(
    expect.objectContaining({ method: 'action', params: expect.objectContaining({ channel: chat, action: turn }) })
  )
  expect(peer.messages).toContainEqual(expect.objectContaining({ method: 'root/sessionSummaryChanged' }))
  const quiet = await connect(auth, 'transport', randomUUID(), { clientId: 'quiet', root: false })
  expect(quiet.accepted).toBe(true)
  expect(quiet.messages).toEqual([])
})

it('binds a browser attachment to CP canonical URI and refuses public create', async () => {
  const { auth, binding, connect, options } = fixture()
  const peer = await connect({ ...auth, conversationId: binding.conversationId })
  expect(peer.accepted).toBe(true)
  expect(options.registry.reserve).toHaveBeenCalledOnce()
  await peer.initialize()
  expect(
    (await peer.request('subscribe', { channel: chatChannel(binding.sessionUri) })).result.snapshot.state.resource
  ).toBe(chatChannel(binding.sessionUri))
  expect(
    (await peer.request('createSession', { channel: 'ahp-session:/another', provider: auth.agentId })).error.code
  ).toBe(AhpErrorCodes.PermissionDenied)
})

it('discovers catalogs without installing history or retaining every session', async () => {
  const { connect, history, options } = fixture()
  const peer = await connect()
  await peer.initialize()
  expect((await peer.request('listSessions', { channel: 'ahp-root://', limit: 100 })).result.items).toHaveLength(1)
  expect(options.registry.list).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 10 }))
  expect(history).not.toHaveBeenCalled()
})

it('closes passive subscriptions when renewal no longer authorizes the prepared session', async () => {
  const { connect, service, options, binding, auth } = fixture()
  const peer = await connect()
  await peer.initialize()
  await peer.request('subscribe', { channel: chatChannel(binding.sessionUri) })
  options.registry.resolve = vi.fn(async () => ({ ok: false as const, reason: 'forbidden' as const }))
  expect(
    await service.authorize(
      { ...peer.input, authorization: { ...auth, grant: { token: 'renewed', expiresAtMs: Date.now() + 60_000 } } },
      peer.connection
    )
  ).toBe(false)
  expect(peer.close).toHaveBeenCalledWith('unauthorized')
  const before = peer.messages.length
  service.observe(auth.orgId, auth.agentId, {
    sessionId: binding.sessionId,
    turnId: 'future',
    generation: 0,
    at: Date.now(),
    kind: 'started',
    text: 'private',
    origin: 'user'
  })
  await Promise.resolve()
  expect(peer.messages).toHaveLength(before)
  expect(options.dispatch).not.toHaveBeenCalled()
})

it('fresh command resolution replaces attachment role and revokes an old prepared channel on denial', async () => {
  const { connect, service, options, binding } = fixture()
  const peer = await connect()
  await peer.initialize()
  await peer.request('subscribe', { channel: chatChannel(binding.sessionUri) })
  await service.receive(
    {
      attachmentId: peer.input.attachmentId,
      message: JSON.stringify({
        jsonrpc: '2.0',
        method: 'dispatchAction',
        params: {
          channel: chatChannel(binding.sessionUri),
          clientSeq: 1,
          action: {
            type: ActionType.ChatTurnStarted,
            turnId: 'turn',
            startedAt: new Date().toISOString(),
            message: { text: 'hi', origin: { kind: 'user' } }
          }
        }
      })
    },
    peer.connection
  )
  expect(options.dispatch).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.objectContaining({
      authorization: expect.objectContaining({ callerRole: 'participant', callerApproves: false })
    })
  )
  options.registry.resolve = vi.fn(async () => ({ ok: false as const, reason: 'forbidden' as const }))
  await peer.request('subscribe', { channel: chatChannel(binding.sessionUri) })
  expect(peer.close).toHaveBeenCalledWith('unauthorized')
})

it('expires grants and detaches without invoking execution cancellation', async () => {
  vi.useFakeTimers()
  const { connect, options } = fixture()
  const peer = await connect()
  await peer.initialize()
  await vi.advanceTimersByTimeAsync(60_001)
  expect(peer.close).toHaveBeenCalledWith('unauthorized')
  expect(options.dispatch).not.toHaveBeenCalled()
})

it('isolates identical attachment IDs across relay transport generations', async () => {
  const { connect, service, auth, binding } = fixture()
  const attachmentId = randomUUID()
  const old = await connect(auth, 'old', attachmentId)
  const current = await connect(auth, 'current', attachmentId)
  service.relayLost('old')
  await current.initialize()
  expect(
    (await current.request('subscribe', { channel: chatChannel(binding.sessionUri) })).result.snapshot
  ).toBeDefined()
  expect(current.close).not.toHaveBeenCalled()
  expect(await old.initialize()).toBeUndefined()
})

it('releases a projection installed after its attachment disconnected during history I/O', async () => {
  let finish!: () => void
  const wait = new Promise<void>((resolve) => {
    finish = resolve
  })
  const history = vi.fn(async () => {
    await wait
    return []
  })
  const { connect, service, binding } = fixture({ history })
  const old = await connect()
  await old.initialize()
  const subscribing = old.request('subscribe', { channel: chatChannel(binding.sessionUri) })
  await vi.waitFor(() => expect(history).toHaveBeenCalledOnce())
  service.relayLost(old.connection)
  finish()
  await subscribing
  const current = await connect(undefined, 'replacement')
  await current.initialize()
  await current.request('subscribe', { channel: chatChannel(binding.sessionUri) })
  expect(history).toHaveBeenCalledTimes(2)
})

it('bounds queued observations and waits for a fresh attachment before recovering a failed host', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let high = 0
  const reserveSequence = vi.fn(async (_org: string, _agent: string, size: number) => {
    await gate
    return { start: high + 1, end: (high += size) }
  })
  const { service, auth, connect } = fixture({ reserveSequence })
  const event = {
    sessionId: 'outward',
    turnId: 'turn',
    generation: 0,
    at: Date.now(),
    kind: 'started' as const,
    text: 'hello',
    origin: 'user' as const
  }
  for (let index = 0; index < 1000; index++) service.observe(auth.orgId, auth.agentId, event)
  expect(reserveSequence).toHaveBeenCalledOnce()
  release()
  const peer = await connect()
  expect(peer.accepted).toBe(true)
  await peer.initialize()
  expect(peer.close).not.toHaveBeenCalled()
  expect(reserveSequence).toHaveBeenCalledTimes(2)
})

it('streams a turn while the CP is slow to resolve catalog notifications', async () => {
  const { connect, service, options, binding, auth } = fixture()
  const browser = await connect({ ...auth, conversationId: binding.conversationId })
  await browser.initialize()
  await browser.request('subscribe', { channel: chatChannel(binding.sessionUri) })
  const catalog = await connect()
  await catalog.initialize()
  await catalog.request('subscribe', { channel: 'ahp-root://' })
  let settle!: () => void
  const resolve = vi.fn(() => new Promise<any>((done) => (settle = () => done({ ok: true, ...binding }))))
  options.registry.resolve = resolve
  const event = { sessionId: binding.sessionId, turnId: 'turn', generation: 0, at: Date.now() }
  service.observe(auth.orgId, auth.agentId, { ...event, kind: 'started', text: 'Hello', origin: 'user' })
  for (let index = 0; index < 40; index++)
    service.observe(auth.orgId, auth.agentId, { ...event, kind: 'text', text: `${index}` })
  await vi.waitFor(() => expect(browser.messages.filter((m) => m.method === 'action').length).toBeGreaterThan(40))
  expect(browser.close).not.toHaveBeenCalled()
  expect(catalog.close).not.toHaveBeenCalled()
  expect(resolve).toHaveBeenCalledOnce()
  const summaries = () => catalog.messages.filter((m) => m.method === 'root/sessionSummaryChanged')
  expect(summaries()).toHaveLength(0)
  settle()
  await vi.waitFor(() => expect(summaries().length).toBeGreaterThan(16))
  const times = summaries().map((m) => m.params.changes.modifiedAt)
  expect(times).toEqual([...times].sort())
  expect(resolve).toHaveBeenCalledOnce()
})
