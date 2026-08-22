import { describe, it, expect, vi } from 'vitest'
import { FakeClock, type Transport } from '@agentconnect.md/connection'
import { buildRelayDaemonFrame, type RdMsg, type RelayDaemonFrame } from '@agentconnect.md/protocol'
import { RelayManager } from '../../src/cp/relay-manager.js'
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
  onMessage(cb: (t: string) => void): void {
    this.msgCb = cb
  }
  onClose(): void {}
  close(): void {}
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

async function toReady(t: FakeTransport, relayId: string): Promise<void> {
  await flush()
  const hello = [...t.sent].reverse().find((f) => f.type === 'rd/hello')!
  t.inject(buildRelayDaemonFrame('rd/hello/ok', { relayId }, { corr: hello.id }))
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
})
