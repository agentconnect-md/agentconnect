import { describe, it, expect, vi } from 'vitest'
import { FakeClock, type Transport } from '@agentconnect.md/connection'
import {
  buildRelayDaemonFrame,
  RD_PLATFORM_REQUEST_V1,
  RD_WEBCHAT_IMAGES_V1,
  type RdMsg,
  type RelayDaemonFrame
} from '@agentconnect.md/protocol'
import { RelayManager } from '../../src/cp/relay-manager.js'
import { PlatformRelayUnsent } from '../../src/platforms/platform-relay.js'
import {
  MsTeamsApi,
  MsTeamsApiError,
  msTeamsRelayPort,
  relayMsTeamsConnector
} from '../../src/platforms/msteams/api.js'
import type { RelayClientDeps } from '../../src/cp/relay-client.js'
import type { Logger } from '../../src/log.js'

const silentLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as unknown as Logger

/** A transport that never opens (the dial hangs) — enough to observe start/stop without a handshake. */
function hangingConnect(): Promise<Transport> {
  return new Promise<Transport>(() => {})
}

/** A transport that captures every frame sent on it, for asserting a broadcast reached it. */
class FakeTransport implements Transport {
  readonly subprotocol = 'rd'
  sent: RelayDaemonFrame[] = []
  private msgCb?: (t: string) => void
  private closeCb?: (code: number, reason: string) => void
  onMessage(cb: (t: string) => void): void {
    this.msgCb = cb
  }
  onClose(cb: (code: number, reason: string) => void): void {
    this.closeCb = cb
  }
  close(): void {}
  disconnect(): void {
    this.closeCb?.(1006, 'disconnected')
  }
  send(text: string): void {
    this.sent.push(JSON.parse(text) as RelayDaemonFrame)
  }
  inject(frame: RelayDaemonFrame): void {
    this.msgCb?.(JSON.stringify(frame))
  }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function manager() {
  const connect = vi.fn(hangingConnect)
  const mgr = new RelayManager({
    apiKey: () => 'k',
    daemonId: () => 'daemon-1',
    clock: new FakeClock(),
    connect,
    log: silentLog,
    jitter: () => 0,
    onRelayMsg: (msg: RdMsg) => ({ msgId: msg.msgId, accepted: true })
  } as unknown as RelayClientDeps)
  return { mgr, connect }
}

const entry = (relayId: string, url: string) => ({ relayId, url })

describe('RelayManager.converge', () => {
  it('dials newly-listed relays', () => {
    const { mgr, connect } = manager()
    mgr.converge([entry('r1', 'wss://r1'), entry('r2', 'wss://r2')])
    expect(mgr.size()).toBe(2)
    expect(connect).toHaveBeenCalledTimes(2)
  })

  it('is idempotent — re-applying the same roster dials nothing new', () => {
    const { mgr, connect } = manager()
    const roster = [entry('r1', 'wss://r1')]
    mgr.converge(roster)
    mgr.converge(roster)
    expect(mgr.size()).toBe(1)
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('prunes relays dropped from the roster', () => {
    const { mgr } = manager()
    mgr.converge([entry('r1', 'wss://r1'), entry('r2', 'wss://r2')])
    mgr.converge([entry('r1', 'wss://r1')]) // r2 gone
    expect(mgr.size()).toBe(1)
  })

  it('re-dials a relay whose url changed (relay moved instances)', () => {
    const { mgr, connect } = manager()
    mgr.converge([entry('r1', 'wss://r1-a')])
    mgr.converge([entry('r1', 'wss://r1-b')]) // same id, new url
    expect(mgr.size()).toBe(1)
    expect(connect).toHaveBeenCalledTimes(2) // stopped the old, dialed the new
  })

  it('converge([]) tears every relay down', async () => {
    const { mgr } = manager()
    mgr.converge([entry('r1', 'wss://r1'), entry('r2', 'wss://r2')])
    mgr.converge([])
    expect(mgr.size()).toBe(0)
  })

  it('stop() clears all clients', async () => {
    const { mgr } = manager()
    mgr.converge([entry('r1', 'wss://r1')])
    await mgr.stop()
    expect(mgr.size()).toBe(0)
  })

  it('reports a platform request no relay could take as unsent', async () => {
    const { mgr } = manager()
    mgr.converge([entry('r1', 'wss://r1')])
    await expect(
      mgr.request({ platformId: 'msteams', botId: '11111111-1111-4111-8111-111111111111', payload: {} })
    ).rejects.toBeInstanceOf(PlatformRelayUnsent)
  })
})

/** A manager whose relays actually complete the rd/hello handshake, so `isReady()` is
 *  true and `sendWebchatPost` can broadcast onto their transports. */
function readyManager() {
  const transports = new Map<string, FakeTransport>()
  const connect = vi.fn(async (url: string) => {
    const t = new FakeTransport()
    transports.set(url, t)
    return t
  })
  const mgr = new RelayManager({
    apiKey: () => 'k',
    daemonId: () => 'daemon-1',
    clock: new FakeClock(),
    connect,
    log: silentLog,
    jitter: () => 0,
    onRelayMsg: (msg: RdMsg) => ({ msgId: msg.msgId, accepted: true })
  } as unknown as RelayClientDeps)
  return { mgr, transports }
}

async function toReady(t: FakeTransport, relayId: string, capabilities?: string[]): Promise<void> {
  await flush()
  const hello = [...t.sent].reverse().find((f) => f.type === 'rd/hello')!
  t.inject(buildRelayDaemonFrame('rd/hello/ok', { relayId, capabilities }, { corr: hello.id }))
  await flush()
}

const POST = {
  conversationId: '11111111-1111-4111-8111-111111111111',
  agentId: '22222222-2222-4222-8222-222222222222',
  post: {
    postId: '33333333-3333-4333-8333-333333333333',
    conversationId: '11111111-1111-4111-8111-111111111111',
    author: { kind: 'agent' as const, agentId: '22222222-2222-4222-8222-222222222222' },
    text: 'hi',
    at: 1
  },
  initiator: 'agent' as const
}

const RELAY_1 = '44444444-4444-4444-8444-444444444444'
const RELAY_2 = '55555555-5555-4555-8555-555555555555'

it('keeps advertised tools through relay disconnect and replacement, but accepts an explicit capability downgrade', async () => {
  const { mgr, transports } = readyManager()
  try {
    expect(mgr.advertisesWebchatImages()).toBe(false)
    mgr.converge([entry(RELAY_1, 'wss://relay.example.test')])
    await toReady(transports.get('wss://relay.example.test')!, RELAY_1, [RD_WEBCHAT_IMAGES_V1])
    expect(mgr.advertisesWebchatImages()).toBe(true)
    expect(mgr.supportsWebchatImages()).toBe(true)
    transports.get('wss://relay.example.test')!.disconnect()
    expect(mgr.supportsWebchatImages()).toBe(false)
    expect(mgr.advertisesWebchatImages()).toBe(true)
    mgr.converge([])
    expect(mgr.advertisesWebchatImages()).toBe(true)
    mgr.converge([entry(RELAY_2, 'wss://replacement.example.test')])
    expect(mgr.advertisesWebchatImages()).toBe(true)
    await toReady(transports.get('wss://replacement.example.test')!, RELAY_2, [])
    expect(mgr.advertisesWebchatImages()).toBe(false)
  } finally {
    await mgr.stop()
  }
})

describe('RelayManager.sendWebchatPost (#753)', () => {
  it('broadcasts to every READY relay — only the one holding this conversation acts on it', async () => {
    const { mgr, transports } = readyManager()
    mgr.converge([entry(RELAY_1, 'wss://r1'), entry(RELAY_2, 'wss://r2')])
    await toReady(transports.get('wss://r1')!, RELAY_1)
    await toReady(transports.get('wss://r2')!, RELAY_2)

    mgr.sendWebchatPost(POST)

    for (const url of ['wss://r1', 'wss://r2']) {
      const frame = transports.get(url)!.sent.find((f) => f.type === 'rd/webchat-post')
      expect(frame?.payload).toEqual(POST)
    }
  })

  it('skips a relay that has not completed its handshake yet', async () => {
    const { mgr, transports } = readyManager()
    mgr.converge([entry(RELAY_1, 'wss://r1'), entry(RELAY_2, 'wss://r2')])
    await toReady(transports.get('wss://r1')!, RELAY_1) // r2 left mid-handshake

    mgr.sendWebchatPost(POST)

    expect(transports.get('wss://r1')!.sent.some((f) => f.type === 'rd/webchat-post')).toBe(true)
    expect(transports.get('wss://r2')!.sent.some((f) => f.type === 'rd/webchat-post')).toBe(false)
  })

  it('routes rd/route via the ingress relay first, only over relays with the forward leg, else a retry', async () => {
    const { mgr } = manager()
    const calls: string[] = []
    const fake = (relayId: string, route: boolean, fail = false) => ({
      relayId,
      supportsRoute: () => route,
      sendRoute: vi.fn(async (p: { deliveryId: string }) => {
        calls.push(relayId)
        if (fail) throw new Error('closed')
        return { deliveryId: p.deliveryId, disposition: 'admitted' as const }
      }),
      sendRouteReport: vi.fn(async () => ({ accepted: true }))
    })
    const clients = (mgr as unknown as { clients: Map<string, unknown> }).clients
    clients.set('r-old', fake('r-old', false))
    clients.set('r-a', fake('r-a', true, true))
    clients.set('r-b', fake('r-b', true))
    expect(await mgr.sendRoute({ deliveryId: 'd' } as never, 'r-b')).toMatchObject({ disposition: 'admitted' })
    expect(calls).toEqual(['r-b'])
    calls.length = 0
    expect(await mgr.sendRoute({ deliveryId: 'd' } as never, 'r-a')).toMatchObject({ disposition: 'admitted' })
    expect(calls).toEqual(['r-a', 'r-b'])
    clients.clear()
    clients.set('r-old', fake('r-old', false))
    expect(await mgr.sendRoute({ deliveryId: 'd' } as never)).toEqual({
      deliveryId: 'd',
      disposition: 'retry',
      reason: 'offline'
    })
    expect(await mgr.sendRouteReport({} as never)).toEqual({ accepted: false, reason: 'offline' })
  })
})

describe('RelayManager.request (platform requests)', () => {
  const REQ = { platformId: 'msteams', botId: '11111111-1111-4111-8111-111111111111', payload: { op: 'graph-token' } }

  // Answer a relay's pending rd/platform/request with `reply`, once it arrives.
  async function answer(t: FakeTransport, reply: Record<string, unknown>): Promise<void> {
    await vi.waitFor(() => expect(t.sent.some((f) => f.type === 'rd/platform/request')).toBe(true))
    const req = t.sent.find((f) => f.type === 'rd/platform/request')!
    t.inject(buildRelayDaemonFrame('rd/platform/reply', reply as never, { corr: req.id }))
  }

  async function twoRelays() {
    const ready = readyManager()
    ready.mgr.converge([entry(RELAY_1, 'wss://r1'), entry(RELAY_2, 'wss://r2')])
    await toReady(ready.transports.get('wss://r1')!, RELAY_1, [RD_PLATFORM_REQUEST_V1])
    await toReady(ready.transports.get('wss://r2')!, RELAY_2, [RD_PLATFORM_REQUEST_V1])
    return { mgr: ready.mgr, r1: ready.transports.get('wss://r1')!, r2: ready.transports.get('wss://r2')! }
  }

  it('asks the next relay when one has not seen the daemon’s membership yet, since that relay never called the provider', async () => {
    const { mgr, r1, r2 } = await twoRelays()
    const pending = mgr.request(REQ)
    await answer(r1, { outcome: 'refused', reason: 'not_member', retryable: true })
    await answer(r2, { outcome: 'ok', payload: { status: 200 } })
    expect(await pending).toEqual({ outcome: 'ok', payload: { status: 200 } })
    await mgr.stop()
  })

  it('stops at a final refusal, and answers a retryable one when every relay refused', async () => {
    const final = await twoRelays()
    const refused = final.mgr.request(REQ)
    await answer(final.r1, { outcome: 'refused', reason: 'ticket' })
    expect(await refused).toEqual({ outcome: 'refused', reason: 'ticket' })
    expect(final.r2.sent.some((f) => f.type === 'rd/platform/request')).toBe(false)
    await final.mgr.stop()

    const lagging = await twoRelays()
    const both = lagging.mgr.request(REQ)
    await answer(lagging.r1, { outcome: 'refused', reason: 'unknown_bot', retryable: true })
    await answer(lagging.r2, { outcome: 'refused', reason: 'not_member', retryable: true })
    expect(await both).toMatchObject({ outcome: 'refused', retryable: true })
    await lagging.mgr.stop()
  })

  it('never re-sends a post a relay answered with an error, which may follow the provider call', async () => {
    const { mgr, r1, r2 } = await twoRelays()
    const api = new MsTeamsApi(relayMsTeamsConnector(msTeamsRelayPort(mgr), REQ.botId), {
      sleep: async () => {},
      random: () => 0
    })
    const target = { serviceUrl: 'https://smba.trafficmanager.net/teams/', conversationId: 'a:chat', ticket: 't1.x.y' }
    const posting = api.postActivity(target, { type: 'message', text: 'hi' }).catch((e: unknown) => e)
    await vi.waitFor(() => expect(r1.sent.some((f) => f.type === 'rd/platform/request')).toBe(true))
    const req = r1.sent.find((f) => f.type === 'rd/platform/request')!
    r1.inject(
      buildRelayDaemonFrame('error', { code: 'INTERNAL', message: 'failed', retryable: false }, { corr: req.id })
    )
    const err = (await posting) as MsTeamsApiError
    expect(err).toBeInstanceOf(MsTeamsApiError)
    expect(err.kind).toBe('ambiguous')
    const sent = [...r1.sent, ...r2.sent].filter((f) => f.type === 'rd/platform/request')
    expect(sent).toHaveLength(1)
    await mgr.stop()
  })
})
