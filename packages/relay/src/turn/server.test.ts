import { randomBytes } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { errorCode, lifetimeOf, restCredential, TestTurnClient, type TurnLink } from '../../test/turn-client.js'
import { ATTR, attr, buildStun, CLASS, METHOD, readXorAddress } from './codec.js'
import type { TurnMetrics } from './metrics.js'
import { TurnServer, turnSubject, type TurnClient, type TurnLimits } from './server.js'
import { defaultRelayedAddress } from './index.js'

const SECRET = 's'.repeat(40)
const RELAYED = '198.18.0.7'
const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

let now = 1_800_000_000_000
let events: string[] = []
let server: TurnServer
let secret: string | undefined = SECRET

const metrics: TurnMetrics = {
  allocation: (outcome) => events.push(`allocation:${outcome}`),
  ended: (reason, transport) => events.push(`ended:${reason}:${transport}`),
  relayed: (bytes, from, to) =>
    events.push(`relayed:${bytes}:${from.kind}>${to.kind}:${from.computerId ?? to.computerId ?? ''}`),
  dropped: (bytes, reason) => events.push(`dropped:${bytes}:${reason}`),
  observeActive: () => {}
}

function make(limits: Partial<TurnLimits> = {}): TurnServer {
  return new TurnServer({
    realm: 'agentconnect',
    relayedAddress: RELAYED,
    secret: () => secret,
    limits: {
      maxAllocations: 10,
      maxAllocationsPerUser: 4,
      maxBitsPerSecond: 8_000_000,
      idleTimeoutMs: 60_000,
      ...limits
    },
    log: quiet,
    metrics,
    now: () => now
  })
}

let port = 40000
function link(transport: TurnClient['transport'] = 'udp'): TurnLink & { ended: boolean } {
  const handlers: Array<(frame: Buffer) => void> = []
  const key = `${transport}:203.0.113.5:${++port}`
  const out = {
    ended: false,
    stream: transport !== 'udp',
    send: (frame: Buffer) => server.handle(client, frame),
    onFrame: (handler: (frame: Buffer) => void) => void handlers.push(handler),
    close: () => server.clientClosed(key)
  }
  const client: TurnClient = {
    key,
    transport,
    address: '203.0.113.5',
    port,
    send: (frame) => handlers.forEach((handler) => handler(frame)),
    end: () => void (out.ended = true)
  }
  return out
}

const credential = (who: string, ttlSec = 3600) => restCredential(SECRET, who, Math.floor(now / 1000) + ttlSec)

// A desktop and a viewer, both allocated and permitted to each other.
async function pair(): Promise<[TestTurnClient, TestTurnClient]> {
  const desktop = new TestTurnClient(link(), credential('computer-c1'))
  const viewer = new TestTurnClient(link('tls'), credential('viewer-u1'))
  expect((await desktop.allocate()).cls).toBe(CLASS.success)
  expect((await viewer.allocate()).cls).toBe(CLASS.success)
  expect((await desktop.permit(viewer.relayed!)).cls).toBe(CLASS.success)
  expect((await viewer.permit(desktop.relayed!)).cls).toBe(CLASS.success)
  return [desktop, viewer]
}

beforeEach(() => {
  now = 1_800_000_000_000
  events = []
  secret = SECRET
  server = make()
})

describe('TurnServer authentication', () => {
  it('challenges an unauthenticated Allocate with a realm and nonce, then allocates a relayed address', async () => {
    const client = new TestTurnClient(link(), credential('viewer-u1'))
    const challenge = await client.send(METHOD.allocate, [[ATTR.requestedTransport, Buffer.from([17, 0, 0, 0])]], {
      raw: true
    })
    expect(errorCode(challenge)).toBe(401)
    expect(attr(challenge, ATTR.realm)?.toString()).toBe('agentconnect')
    expect(attr(challenge, ATTR.nonce)?.length).toBeGreaterThan(10)
    const ok = await client.allocate()
    expect(ok.cls).toBe(CLASS.success)
    expect(client.relayed).toMatchObject({ address: RELAYED })
    expect(readXorAddress(attr(ok, ATTR.xorMappedAddress)!)).toMatchObject({ address: '203.0.113.5', port })
    expect(lifetimeOf(ok)).toBe(600)
    expect(attr(ok, ATTR.messageIntegrity)).toBeDefined()
    expect(server.allocations).toBe(1)
  })

  it('refuses a wrong password, a foreign realm, or a server still waiting for the CP secret', async () => {
    const wrong = new TestTurnClient(link(), { username: credential('viewer-u1').username, password: 'nope' })
    expect(errorCode(await wrong.allocate())).toBe(401)
    const realm = new TestTurnClient(link(), credential('viewer-u1'))
    await realm.allocate()
    realm.realm = 'elsewhere'
    expect(errorCode(await realm.send(METHOD.refresh, []))).toBe(401)
    secret = undefined
    expect(errorCode(await new TestTurnClient(link(), credential('viewer-u1')).allocate())).toBe(401)
    expect(server.allocations).toBe(1)
  })

  it('refuses an expired credential, so it can neither open nor refresh an allocation', async () => {
    const expired = new TestTurnClient(link(), credential('viewer-u1', -1))
    expect(errorCode(await expired.allocate())).toBe(401)
    expect(server.allocations).toBe(0)

    const client = new TestTurnClient(link(), credential('viewer-u1', 900))
    expect(lifetimeOf(await client.allocate())).toBe(600)
    now += 600_000
    // Refreshing near the end is capped at the credential's expiry rather than the asked lifetime.
    expect(lifetimeOf(await client.refresh(3600))).toBe(300)
    now += 300_000
    expect(errorCode(await client.refresh(600))).toBe(401)
    expect(errorCode(await client.permit({ address: RELAYED, port: 50000 }))).toBe(401)
    server.sweep()
    expect(server.allocations).toBe(0)
    expect(events).toContain('ended:credential_expired:udp')
  })

  it('caps the first lifetime at the credential expiry too', async () => {
    const client = new TestTurnClient(link(), credential('viewer-u1', 120))
    expect(lifetimeOf(await client.allocate([[ATTR.lifetime, Buffer.from([0, 0, 0x0e, 0x10])]]))).toBe(120)
  })

  it('answers a stale nonce with 438 and a fresh one', async () => {
    const client = new TestTurnClient(link(), credential('viewer-u1', 7200))
    await client.allocate()
    const old = client.nonce
    now += 11 * 60_000
    const stale = await client.send(METHOD.refresh, [])
    expect(errorCode(stale)).toBe(438)
    expect(attr(stale, ATTR.nonce)?.toString()).not.toBe(old)
    expect((await client.refresh()).cls).toBe(CLASS.success)
  })

  it('refuses a request on an allocation opened with another credential', async () => {
    const client = new TestTurnClient(link(), credential('viewer-u1'))
    await client.allocate()
    client.useCredential(credential('viewer-u2'))
    expect(errorCode(await client.refresh())).toBe(441)
  })
})

describe('TurnServer allocations', () => {
  it('answers a retransmitted Allocate the same way and another one with 437', async () => {
    const client = new TestTurnClient(link(), credential('viewer-u1'))
    const attrs = [[ATTR.requestedTransport, Buffer.from([17, 0, 0, 0])] as const]
    await client.request(METHOD.refresh)
    const transactionId = randomBytes(12)
    const first = await client.send(METHOD.allocate, attrs, { transactionId })
    expect(first.cls).toBe(CLASS.success)
    expect((await client.send(METHOD.allocate, attrs, { transactionId })).raw.equals(first.raw)).toBe(true)
    expect(errorCode(await client.send(METHOD.allocate, attrs))).toBe(437)
    expect(server.allocations).toBe(1)
  })

  it('relays UDP only, IPv4 only, and refuses unknown comprehension-required attributes', async () => {
    const client = new TestTurnClient(link(), credential('viewer-u1'))
    await client.allocate([])
    const tcp = new TestTurnClient(link(), credential('viewer-u1'))
    expect(errorCode(await tcp.request(METHOD.allocate, [[ATTR.requestedTransport, Buffer.from([6, 0, 0, 0])]]))).toBe(
      442
    )
    const v6 = new TestTurnClient(link(), credential('viewer-u1'))
    expect(errorCode(await v6.allocate([[ATTR.requestedAddressFamily, Buffer.from([2, 0, 0, 0])]]))).toBe(440)
    const odd = new TestTurnClient(link(), credential('viewer-u1'))
    const unknown = await odd.send(METHOD.allocate, [[0x0042, Buffer.alloc(4)]], { raw: true })
    expect(errorCode(unknown)).toBe(420)
    expect(attr(unknown, ATTR.unknownAttributes)?.readUInt16BE(0)).toBe(0x0042)
  })

  it('caps allocations per credential and per instance', async () => {
    server = make({ maxAllocations: 5, maxAllocationsPerUser: 2 })
    const cred = credential('viewer-u1')
    for (let i = 0; i < 2; i++) expect((await new TestTurnClient(link(), cred).allocate()).cls).toBe(CLASS.success)
    expect(errorCode(await new TestTurnClient(link(), cred).allocate())).toBe(486)
    for (let i = 0; i < 3; i++) await new TestTurnClient(link(), credential(`viewer-x${i}`)).allocate()
    expect(errorCode(await new TestTurnClient(link(), credential('viewer-y')).allocate())).toBe(508)
    expect(events.filter((e) => e === 'allocation:quota')).toHaveLength(1)
    expect(events.filter((e) => e === 'allocation:capacity')).toHaveLength(1)
  })

  it('counts the quota per subject, so fresh grants for the same viewer share it', async () => {
    server = make({ maxAllocationsPerUser: 2 })
    const first = new TestTurnClient(link(), credential('viewer-u1', 600))
    expect((await first.allocate()).cls).toBe(CLASS.success)
    expect((await new TestTurnClient(link(), credential('viewer-u1', 900)).allocate()).cls).toBe(CLASS.success)
    expect(errorCode(await new TestTurnClient(link(), credential('viewer-u1', 1200)).allocate())).toBe(486)
    expect((await new TestTurnClient(link(), credential('viewer-u2', 600)).allocate()).cls).toBe(CLASS.success)
    // Releasing one frees the shared quota for the next grant.
    expect(lifetimeOf(await first.refresh(0))).toBe(0)
    expect((await new TestTurnClient(link(), credential('viewer-u1', 1500)).allocate()).cls).toBe(CLASS.success)
  })

  it('deletes an allocation on a zero-lifetime Refresh, and a stream allocation when its connection closes', async () => {
    const client = new TestTurnClient(link(), credential('viewer-u1'))
    await client.allocate()
    expect(lifetimeOf(await client.refresh(0))).toBe(0)
    expect(server.allocations).toBe(0)
    expect(errorCode(await client.refresh())).toBe(437)
    const stream = new TestTurnClient(link('tcp'), credential('viewer-u1'))
    await stream.allocate()
    stream.link.close()
    expect(server.allocations).toBe(0)
    expect(events).toContain('ended:client_closed:tcp')
  })

  it('deletes an idle allocation and ends its stream', async () => {
    const tcp = link('tcp')
    const client = new TestTurnClient(tcp, credential('viewer-u1'))
    await client.allocate()
    now += 59_000
    server.sweep()
    expect(server.allocations).toBe(1)
    now += 1000
    server.sweep()
    expect(server.allocations).toBe(0)
    expect(tcp.ended).toBe(true)
    expect(events).toContain('ended:idle:tcp')
  })
})

describe('TurnServer relaying', () => {
  it('permits only its own relayed address, so it never sends to an arbitrary host', async () => {
    const client = new TestTurnClient(link(), credential('viewer-u1'))
    await client.allocate()
    expect(errorCode(await client.permit({ address: '10.0.0.1', port: 80 }))).toBe(403)
    expect(errorCode(await client.bind(0x4000, { address: '169.254.169.254', port: 80 }))).toBe(403)
  })

  it('hands a Send indication to the peer allocation as a Data indication from the sender relayed address', async () => {
    const [desktop, viewer] = await pair()
    desktop.sendTo(viewer.relayed!, Buffer.from('frame'))
    expect(viewer.received).toEqual([{ peer: desktop.relayed, data: Buffer.from('frame') }])
    expect(events).toContain('relayed:5:computer>viewer:c1')
  })

  it('drops data the receiving allocation has not permitted, or for no allocation', async () => {
    const desktop = new TestTurnClient(link(), credential('computer-c1'))
    const viewer = new TestTurnClient(link(), credential('viewer-u1'))
    await desktop.allocate()
    await viewer.allocate()
    await desktop.permit(viewer.relayed!)
    desktop.sendTo(viewer.relayed!, Buffer.from('x'))
    const nobody = { address: RELAYED, port: viewer.relayed!.port ^ 1 }
    desktop.sendTo(nobody, Buffer.from('y'))
    await desktop.permit(nobody)
    desktop.sendTo(nobody, Buffer.from('z'))
    expect(viewer.received).toEqual([])
    expect(events.filter((e) => e === 'dropped:1:no_permission')).toHaveLength(2)
    expect(events).toContain('dropped:1:no_peer')
  })

  it('isolates allocations: a third credential holder cannot reach a viewing it was not permitted into', async () => {
    const [desktop, viewer] = await pair()
    const intruder = new TestTurnClient(link(), credential('viewer-mallory'))
    await intruder.allocate()
    expect((await intruder.permit(viewer.relayed!)).cls).toBe(CLASS.success)
    expect((await intruder.bind(0x4000, desktop.relayed!)).cls).toBe(CLASS.success)
    intruder.sendTo(viewer.relayed!, Buffer.from('spam'))
    intruder.sendOnChannel(0x4000, Buffer.from('spam'))
    expect(viewer.received).toEqual([])
    expect(desktop.received).toEqual([])
    expect(events.filter((e) => e.startsWith('relayed:'))).toEqual([])
    expect(events.filter((e) => e === 'dropped:4:no_permission')).toHaveLength(2)
    // Neither peer of the viewing can send to the intruder either, since neither permitted it.
    desktop.sendTo(intruder.relayed!, Buffer.from('leak'))
    expect(intruder.received).toEqual([])
  })

  it('uses ChannelData once a channel is bound, padded on a stream transport', async () => {
    const [desktop, viewer] = await pair()
    expect((await desktop.bind(0x4001, viewer.relayed!)).cls).toBe(CLASS.success)
    expect((await viewer.bind(0x4002, desktop.relayed!)).cls).toBe(CLASS.success)
    desktop.sendOnChannel(0x4001, Buffer.from('abc'))
    viewer.sendOnChannel(0x4002, Buffer.from('defgh'))
    expect(viewer.received).toEqual([{ peer: 0x4002, data: Buffer.from('abc') }])
    expect(desktop.received).toEqual([{ peer: 0x4001, data: Buffer.from('defgh') }])
    // Rebinding the channel to another peer is refused.
    expect(errorCode(await desktop.bind(0x4001, { address: RELAYED, port: 1 }))).toBe(400)
  })

  it('caps what one allocation sends per second and drops the excess', async () => {
    server = make({ maxBitsPerSecond: 80_000 })
    const [desktop, viewer] = await pair()
    const chunk = Buffer.alloc(1000)
    for (let i = 0; i < 15; i++) desktop.sendTo(viewer.relayed!, chunk)
    expect(viewer.received).toHaveLength(10)
    expect(events.filter((e) => e === 'dropped:1000:bandwidth')).toHaveLength(5)
    now += 500
    for (let i = 0; i < 10; i++) desktop.sendTo(viewer.relayed!, chunk)
    expect(viewer.received).toHaveLength(15)
    // The cap is per allocation: the viewer's own sends are unaffected.
    viewer.sendTo(desktop.relayed!, chunk)
    expect(desktop.received).toHaveLength(1)
  })

  it('keeps an allocation that relays alive past the idle timeout', async () => {
    const [desktop, viewer] = await pair()
    for (let i = 0; i < 3; i++) {
      now += 40_000
      desktop.sendTo(viewer.relayed!, Buffer.from('ping'))
      server.sweep()
    }
    expect(server.allocations).toBe(2)
  })

  it('answers STUN Binding on the TURN port without authentication', async () => {
    const client = new TestTurnClient(link(), credential('viewer-u1'))
    const reply = await client.send(METHOD.binding, [], { raw: true })
    expect(reply.cls).toBe(CLASS.success)
    expect(readXorAddress(attr(reply, ATTR.xorMappedAddress)!)).toMatchObject({ address: '203.0.113.5' })
  })

  it('ignores responses and indications other than Send', () => {
    const l = link()
    const seen: Buffer[] = []
    l.onFrame((f) => seen.push(f))
    l.send(buildStun(METHOD.allocate, CLASS.success, randomBytes(12), []))
    l.send(buildStun(METHOD.data, CLASS.indication, randomBytes(12), []))
    expect(seen).toEqual([])
  })
})

describe('turn helpers', () => {
  it('reads the subject from the REST username', () => {
    expect(turnSubject('1700000000:computer-abc')).toEqual({ kind: 'computer', computerId: 'abc' })
    expect(turnSubject('1700000000:viewer-u1')).toEqual({ kind: 'viewer' })
    expect(turnSubject('1700000000:someone')).toEqual({ kind: 'other' })
  })

  it('derives a stable relayed address per relay name in 198.18.0.0/15', () => {
    const a = defaultRelayedAddress('agentconnect-relay-0')
    expect(a).toBe(defaultRelayedAddress('agentconnect-relay-0'))
    expect(a).not.toBe(defaultRelayedAddress('agentconnect-relay-1'))
    expect(a).toMatch(/^198\.(18|19)\.\d+\.\d+$/)
    expect(Number(a.split('.')[3])).toBeGreaterThan(0)
  })
})
