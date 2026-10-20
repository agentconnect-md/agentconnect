import { afterEach, describe, expect, it, vi } from 'vitest'
import { AhpClient, InMemoryTransport } from '@microsoft/agent-host-protocol/client'
import {
  ActionType,
  AhpErrorCodes,
  SessionStatus,
  MessageKind,
  TurnState,
  chatReducer,
  type ChatAction,
  type ChatState,
  type Turn
} from '@microsoft/agent-host-protocol'
import { AhpActionJournal } from '../../src/ahp/action-journal.js'
import { AhpHostConnection, AhpProtocolError, type AhpHostPort } from '../../src/ahp/connection.js'

const root = 'ahp-root://' as const
const chat = 'ahp-chat:/one/main'
const state: ChatState = {
  resource: chat,
  title: 'One',
  status: SessionStatus.Idle,
  modifiedAt: '2026-01-01T00:00:00Z',
  turns: []
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const cleanup: (() => void)[] = []
afterEach(() => {
  for (const close of cleanup.splice(0)) close()
})

// This verifies the protocol boundary with the real SDK; runtime acceptance uses a separate Daemon fixture.
async function fixture(overrides: Partial<AhpHostPort> = {}) {
  let high = 0
  const journal = await AhpActionJournal.create({ reserve: async (size) => ({ start: high + 1, end: (high += size) }) })
  const port: AhpHostPort = {
    provider: { provider: 'agent', displayName: 'Agent', description: '', models: [] },
    journal,
    isAuthorized: () => true,
    serialized: (fn) => fn(),
    prepare: async () => {},
    snapshot: () => structuredClone(state),
    listSessions: async () => ({ items: [] }),
    createSession: async () => {},
    dispatch: async (params, origin) => {
      await journal.append({ channel: params.channel, action: params.action, origin })
    },
    ...overrides
  }
  const [clientTransport, serverTransport] = InMemoryTransport.pair()
  const closed = vi.fn()
  const frames: string[] = []
  const connection = new AhpHostConnection({
    port,
    send: (text) => {
      frames.push(text)
      serverTransport.send(text)
    },
    close: (reason) => {
      closed(reason)
      serverTransport.close()
    }
  })
  const serving = (async () => {
    for (;;) {
      const frame = await serverTransport.recv()
      if (!frame) return
      if (frame.kind === 'text') await connection.receive(frame.text)
    }
  })()
  const client = new AhpClient(clientTransport, { requestTimeoutMs: 1000 })
  client.connect()
  cleanup.push(() => {
    client.shutdown()
    connection.dispose()
    serverTransport.close()
    void serving
  })
  return { client, connection, port, closed, frames }
}

describe('AHP official SDK handshake', () => {
  it('discovers the provider, creates and subscribes using standard requests', async () => {
    const create = vi.fn(async () => {})
    const { client } = await fixture({ createSession: create })
    const init = await client.initialize({ clientId: 'one', protocolVersions: ['1.0.0'], initialSubscriptions: [root] })
    expect(init.protocolVersion).toBe('1.0.0')
    expect(init.snapshots[0]!.state).toMatchObject({ agents: [{ provider: 'agent' }] })
    await client.request('createSession', { channel: 'ahp-session:/one', provider: 'agent' })
    expect(create).toHaveBeenCalledOnce()
    expect((await client.subscribe(chat)).result.snapshot?.state).toEqual(state)
    expect(await client.request('listSessions', { channel: root })).toEqual({ items: [] })
  })

  it('uses a private rejected echo understood by the SDK', async () => {
    const { client, port } = await fixture({
      dispatch: async () => {
        throw new AhpProtocolError(AhpErrorCodes.PermissionDenied, 'denied')
      }
    })
    await client.initialize({ clientId: 'one', protocolVersions: ['1.0.0'] })
    await client.subscribe(chat)
    const events = client.events()
    const handle = client.dispatch(chat, { type: ActionType.ChatTurnCancelled, turnId: 'turn', duration: 0 })
    const event = await events.next()
    expect(event.value?.event).toMatchObject({
      type: 'action',
      params: { rejectionReason: 'denied', origin: { clientId: 'one', clientSeq: handle.clientSeq } }
    })
    expect(port.journal.replay(1, new Set([chat]))).toEqual([])
  })

  it('acknowledges the origin once without requiring a subscription', async () => {
    const { client, frames } = await fixture()
    await client.initialize({ clientId: 'one', protocolVersions: ['1.0.0'] })
    const events = client.events()
    const handle = client.dispatch(chat, { type: ActionType.ChatTurnCancelled, turnId: 'turn', duration: 0 })
    expect((await events.next()).value?.event).toMatchObject({
      type: 'action',
      params: { origin: { clientId: 'one', clientSeq: handle.clientSeq } }
    })
    expect(frames.map((frame) => JSON.parse(frame)).filter((frame) => frame.method === 'action')).toHaveLength(1)
  })

  it('rejects unsupported versions and closes the transport', async () => {
    const { client, closed } = await fixture()
    await expect(client.initialize({ clientId: 'one', protocolVersions: ['0.9.0'] })).rejects.toMatchObject({
      code: AhpErrorCodes.UnsupportedProtocolVersion
    })
    expect(closed).toHaveBeenCalledWith('invalid_message')
  })
})

describe('AHP recovery and authorization boundary', () => {
  it('filters reconnect replay by freshly authorized subscriptions, independent of clientId', async () => {
    const first = await fixture()
    const hidden = 'ahp-chat:/hidden/main'
    await first.port.journal.append({
      channel: hidden,
      action: { type: ActionType.ChatTurnCancelled, turnId: 'private', duration: 0 }
    })
    const accepted = await first.port.journal.append({
      channel: chat,
      action: { type: ActionType.ChatTurnCancelled, turnId: 'visible', duration: 0 }
    })
    await first.port.journal.append({
      channel: chat,
      action: { type: ActionType.ChatTurnCancelled, turnId: 'denied-secret', duration: 0 },
      rejectionReason: 'private denial'
    })
    const next = await fixture({
      ...first.port,
      prepare: async (channel) => {
        if (channel === hidden) throw new AhpProtocolError(AhpErrorCodes.PermissionDenied, 'denied')
      }
    })
    const result = await next.client.reconnect({
      clientId: 'same-id-is-not-authority',
      lastSeenServerSeq: 1,
      subscriptions: [chat, hidden]
    })
    expect(result).toEqual({ type: 'replay', actions: [accepted], missing: [hidden] })
    expect(JSON.stringify(result)).not.toContain('private')
  })

  it('falls back to snapshots for a new incarnation and for oversized replay responses', async () => {
    const next = await fixture()
    expect(await next.client.reconnect({ clientId: 'one', lastSeenServerSeq: 0, subscriptions: [chat] })).toMatchObject(
      { type: 'snapshot', snapshots: [{ resource: chat, fromSeq: 1 }] }
    )
    const large = await fixture()
    for (let index = 0; index < 3; index++)
      await large.port.journal.append({
        channel: chat,
        action: { type: ActionType.ChatDelta, turnId: 'turn', partId: 'part', content: 'x'.repeat(24 * 1024) }
      })
    const reconnect = await fixture(large.port)
    expect(
      await reconnect.client.reconnect({ clientId: 'one', lastSeenServerSeq: 1, subscriptions: [chat] })
    ).toMatchObject({ type: 'snapshot' })
    expect(reconnect.frames.every((frame) => Buffer.byteLength(frame) <= 64 * 1024)).toBe(true)
  })

  it('restores all initial channels before taking one consistent snapshot cursor', async () => {
    let title = 'before'
    const first = await fixture()
    first.port.prepare = async (channel) => {
      if (channel.endsWith('second')) {
        title = 'after'
        await first.port.journal.append({
          channel: chat,
          action: { type: ActionType.ChatTurnCancelled, turnId: 'restored', duration: 0 }
        })
      }
    }
    first.port.snapshot = () => ({ ...state, title })
    const result = await first.client.initialize({
      clientId: 'one',
      protocolVersions: ['1.0.0'],
      initialSubscriptions: [chat, 'ahp-chat:/second']
    })
    expect(result.snapshots.map((snapshot) => [snapshot.fromSeq, (snapshot.state as ChatState).title])).toEqual([
      [2, 'after'],
      [2, 'after']
    ])
  })

  it('rechecks authority after asynchronous preparation and sends no stale snapshot', async () => {
    let authorized = true
    const entered = deferred()
    const prepared = deferred()
    const current = await fixture({
      isAuthorized: () => authorized,
      prepare: async () => {
        entered.resolve()
        await prepared.promise
      }
    })
    await current.client.initialize({ clientId: 'one', protocolVersions: ['1.0.0'] })
    const pending = current.client.subscribe(chat)
    const rejection = expect(pending).rejects.toThrow()
    await entered.promise
    authorized = false
    prepared.resolve()
    await rejection
    expect(current.closed).toHaveBeenCalledWith('unauthorized')
    expect(current.frames.map((frame) => JSON.parse(frame)).filter((frame) => frame.result?.snapshot)).toEqual([])
  })

  it('broadcasts accepted actions once to each client but rejected actions only to their origin', async () => {
    const first = await fixture()
    const second = await fixture(first.port)
    await first.client.initialize({ clientId: 'first', protocolVersions: ['1.0.0'], initialSubscriptions: [chat] })
    await second.client.initialize({ clientId: 'second', protocolVersions: ['1.0.0'], initialSubscriptions: [chat] })
    const firstEvents = first.client.events()
    const secondEvents = second.client.events()
    first.client.dispatch(chat, { type: ActionType.ChatTurnCancelled, turnId: 'turn', duration: 0 })
    const accepted = (await firstEvents.next()).value
    expect((await secondEvents.next()).value).toEqual(accepted)
    first.port.dispatch = async () => {
      throw new AhpProtocolError(AhpErrorCodes.PermissionDenied, 'private')
    }
    first.client.dispatch(chat, { type: ActionType.ChatTurnCancelled, turnId: 'denied', duration: 0 })
    expect((await firstEvents.next()).value?.event).toMatchObject({ params: { rejectionReason: 'private' } })
    expect(second.frames.map((frame) => JSON.parse(frame)).filter((frame) => frame.method === 'action')).toHaveLength(1)
  })

  it('never fabricates a rejected action after an unknown post-commit failure', async () => {
    const current = await fixture({
      dispatch: async () => {
        throw new Error('commit outcome unknown')
      }
    })
    await current.client.initialize({ clientId: 'one', protocolVersions: ['1.0.0'] })
    await current.connection.receive(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'dispatchAction',
        params: {
          channel: chat,
          clientSeq: 1,
          action: { type: ActionType.ChatTurnCancelled, turnId: 'turn', duration: 0 }
        }
      })
    )
    expect(current.closed).toHaveBeenCalledWith('unavailable')
    expect(current.frames.some((frame) => frame.includes('rejectionReason'))).toBe(false)
  })

  it('explicitly closes oversized output and bounds pending input', async () => {
    const huge = await fixture({ snapshot: () => ({ ...state, title: 'x'.repeat(64 * 1024) }) })
    await huge.client.initialize({ clientId: 'one', protocolVersions: ['1.0.0'] })
    await expect(huge.client.subscribe(chat)).rejects.toThrow()
    expect(huge.closed).toHaveBeenCalledWith('overloaded')
    const blocked = deferred()
    const queued = await fixture({
      serialized: async (fn) => {
        await blocked.promise
        return fn()
      }
    })
    const receives = Array.from({ length: 17 }, (_, id) =>
      queued.connection.receive(JSON.stringify({ jsonrpc: '2.0', id, method: 'ping', params: { channel: root } }))
    )
    expect(queued.closed).toHaveBeenCalledWith('overloaded')
    blocked.resolve()
    await Promise.all(receives)
  })

  it('loads more than one wire frame of history through standard fetchTurns', async () => {
    const current = await fixture({ snapshot: () => ({ ...state, turnsNextCursor: 'first' }) })
    let page = 0
    current.port.fetchTurns = async () => {
      const turns: Turn[] = Array.from({ length: 6 }, (_, index) => ({
        id: `page-${page}-${index}`,
        message: { text: 'x'.repeat(4096), origin: { kind: MessageKind.User } },
        responseParts: [],
        usage: undefined,
        state: TurnState.Complete
      }))
      return { type: ActionType.ChatTurnsLoaded, turns, ...(page++ < 2 ? { turnsNextCursor: `page-${page}` } : {}) }
    }
    await current.client.initialize({ clientId: 'one', protocolVersions: ['1.0.0'] })
    let reduced = (await current.client.subscribe(chat)).result.snapshot!.state as ChatState
    const events = current.client.events()
    for (let index = 0; index < 3; index++) {
      expect(
        await current.client.request('fetchTurns', { channel: chat, ...(index ? { cursor: `page-${index}` } : {}) })
      ).toEqual({})
      const event = (await events.next()).value!.event
      if (event.type !== 'action') throw new Error('Expected standard action')
      reduced = chatReducer(reduced, event.params.action as ChatAction)
    }
    expect(reduced.turns).toHaveLength(18)
    expect(Buffer.byteLength(JSON.stringify(reduced))).toBeGreaterThan(64 * 1024)
    expect(current.frames.every((frame) => Buffer.byteLength(frame) <= 64 * 1024)).toBe(true)
  })

  it('keeps independently materialized history contiguous for clients joining between pages', async () => {
    const turn = (id: string): Turn => ({
      id,
      message: { text: id, origin: { kind: MessageKind.User } },
      responseParts: [],
      usage: undefined,
      state: TurnState.Complete
    })
    const tail = { ...state, turns: [turn('recent')], turnsNextCursor: 'middle' }
    const fetch = vi.fn(async (params: { cursor?: string }) => ({
      type: ActionType.ChatTurnsLoaded as const,
      turns: [turn(params.cursor!)],
      ...(params.cursor === 'middle' ? { turnsNextCursor: 'oldest' } : {})
    }))
    const first = await fixture({ snapshot: () => structuredClone(tail), fetchTurns: fetch })
    await first.client.initialize({ clientId: 'first', protocolVersions: ['1.0.0'] })
    let firstView = (await first.client.subscribe(chat)).result.snapshot!.state as ChatState
    const firstEvents = first.client.events()
    await first.client.request('fetchTurns', { channel: chat })
    const pageOne = (await firstEvents.next()).value!.event
    if (pageOne.type !== 'action') throw new Error('Expected history action')
    firstView = chatReducer(firstView, pageOne.params.action as ChatAction)
    const second = await fixture(first.port)
    await second.client.initialize({ clientId: 'second', protocolVersions: ['1.0.0'] })
    let secondView = (await second.client.subscribe(chat)).result.snapshot!.state as ChatState
    const secondEvents = second.client.events()
    const beforeSecondPage = first.port.journal.currentSequence
    await first.client.request('fetchTurns', { channel: chat })
    const pageTwo = (await firstEvents.next()).value!.event
    if (pageTwo.type !== 'action') throw new Error('Expected history action')
    firstView = chatReducer(firstView, pageTwo.params.action as ChatAction)
    expect(firstView.turns.map((turn) => turn.id)).toEqual(['oldest', 'middle', 'recent'])
    expect(second.frames.map((frame) => JSON.parse(frame)).filter((frame) => frame.method === 'action')).toEqual([])
    await second.client.request('fetchTurns', { channel: chat })
    const secondPage = (await secondEvents.next()).value!.event
    if (secondPage.type !== 'action') throw new Error('Expected history action')
    secondView = chatReducer(secondView, secondPage.params.action as ChatAction)
    expect(secondView.turns.map((turn) => turn.id)).toEqual(['middle', 'recent'])
    expect(secondView.turnsNextCursor).toBe('oldest')
    expect(fetch.mock.calls.map(([params]) => params.cursor)).toEqual(['middle', 'oldest', 'middle'])
    await first.client.request('fetchTurns', { channel: chat })
    expect(fetch).toHaveBeenCalledTimes(3)
    const recovery = await fixture(first.port)
    const recovered = await recovery.client.reconnect({
      clientId: 'first',
      lastSeenServerSeq: beforeSecondPage,
      subscriptions: [chat]
    })
    expect(recovered).toMatchObject({ type: 'snapshot', snapshots: [{ state: JSON.parse(JSON.stringify(tail)) }] })
    expect(first.port.snapshot(chat)).toEqual(tail)
  })

  it('accepts opaque 2048-byte cursors and only exposes explicitly supported extension methods', async () => {
    const list = vi.fn(async () => ({ items: [] }))
    const custom = vi.fn(async () => ({ ok: true }))
    const current = await fixture({ listSessions: list, customRequest: custom })
    await expect(current.client.request('listSessions', { channel: root })).rejects.toMatchObject({ code: -32600 })
    await current.client.initialize({ clientId: 'one', protocolVersions: ['1.0.0'] })
    await current.client.request('listSessions', { channel: root, cursor: 'x'.repeat(2048) })
    expect(list).toHaveBeenCalledWith({ channel: root, cursor: 'x'.repeat(2048) })
    await current.connection.receive(
      JSON.stringify({ jsonrpc: '2.0', id: 90, method: 'agentconnect/appRpc', params: { channel: chat, appId: 'app' } })
    )
    expect(custom).toHaveBeenCalledWith('agentconnect/appRpc', { channel: chat, appId: 'app' })
    await current.connection.receive(
      JSON.stringify({ jsonrpc: '2.0', id: 91, method: 'agentconnect/arbitrary', params: { channel: chat } })
    )
    expect(custom).toHaveBeenCalledOnce()
    expect(JSON.parse(current.frames.at(-1)!)).toMatchObject({ id: 91, error: { code: -32601 } })
  })
})
