import { describe, it, expect, vi } from 'vitest'
import { RelayRoster, type RosterBroadcaster } from './relayRoster.js'
import type { RelayRepo, RelayRecord } from '../persistence/ports.js'
import type { Clock } from '../domain/clock.js'

const NOW = 1_700_000_000_000
const clock = { now: () => NOW } as unknown as Clock
const STALE_MS = 45_000

function row(over: Partial<RelayRecord> = {}): RelayRecord {
  return {
    id: 'relay-1',
    name: 'pod-0',
    daemonUrl: 'wss://relay-0.example.test',
    features: [],
    stunUrl: null,
    lastSeenAt: new Date(NOW),
    createdAt: new Date(NOW),
    ...over
  }
}

function make(alive: RelayRecord[]) {
  const listAlive = vi.fn(async () => alive)
  const relays = { listAlive } as unknown as RelayRepo
  const broadcaster: RosterBroadcaster = { broadcastRelayRoster: vi.fn() }
  const roster = new RelayRoster(relays, broadcaster, clock, STALE_MS)
  return { roster, listAlive, broadcaster }
}

describe('RelayRoster', () => {
  it('maps alive relays to { relayId, url } entries, keyed within the failover window', async () => {
    const { roster, listAlive } = make([
      row({ id: 'r1', daemonUrl: 'wss://r1' }),
      row({ id: 'r2', daemonUrl: 'wss://r2' })
    ])
    const entries = await roster.entries()
    expect(entries).toEqual([
      { relayId: 'r1', url: 'wss://r1' },
      { relayId: 'r2', url: 'wss://r2' }
    ])
    // listAlive is queried with now − staleMs.
    expect(listAlive).toHaveBeenCalledWith(new Date(NOW - STALE_MS))
  })

  it('broadcast() fans the computed roster to the broadcaster', async () => {
    const { roster, broadcaster } = make([row({ id: 'r1', daemonUrl: 'wss://r1' })])
    await roster.broadcast()
    expect(broadcaster.broadcastRelayRoster).toHaveBeenCalledWith([{ relayId: 'r1', url: 'wss://r1' }])
  })

  it('stunUrls() lists the distinct STUN addresses alive relays advertise, skipping relays without one', async () => {
    const { roster } = make([
      row({ id: 'r1', stunUrl: 'stun:stun-0.example.test:3478' }),
      row({ id: 'r2', stunUrl: null }),
      row({ id: 'r3', stunUrl: 'stun:stun-1.example.test:3478' }),
      row({ id: 'r4', stunUrl: 'stun:stun-0.example.test:3478' })
    ])
    expect(await roster.stunUrls()).toEqual(['stun:stun-0.example.test:3478', 'stun:stun-1.example.test:3478'])
  })

  it('an empty pool broadcasts an empty roster (no relays to dial)', async () => {
    const { roster, broadcaster } = make([])
    await roster.broadcast()
    expect(broadcaster.broadcastRelayRoster).toHaveBeenCalledWith([])
  })
})
