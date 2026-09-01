import { describe, expect, it } from 'vitest'
import { poolObservations, readPoolObservations, type PoolMetricsDeps } from './pool-metrics.js'
import type { PoolTelemetryRow } from '../persistence/ports.js'

const NOW = new Date('2026-01-01T00:00:00Z')

const row = (over: Partial<PoolTelemetryRow> = {}): PoolTelemetryRow => ({
  setId: '00000000-0000-4000-8000-000000000001',
  setName: 'pool',
  installWide: true,
  liveMembers: 3,
  unboundedMembers: 0,
  capacityAgents: 24,
  dutyAgents: 20,
  vacantGroups: 0,
  oversizedVacantGroups: 0,
  capabilityBlockedVacantGroups: 0,
  oldestVacancySec: 0,
  ...over
})

const deps = (over: Partial<PoolMetricsDeps> = {}): PoolMetricsDeps => ({
  repo: { poolTelemetry: async () => [row()] },
  clock: { now: () => NOW.getTime() } as PoolMetricsDeps['clock'],
  liveMs: 120_000,
  maxMembers: 1000,
  ...over
})

const valueOf = (obs: ReturnType<typeof poolObservations>, metric: string) =>
  obs.find((o) => o.metric === metric)?.value

describe('poolObservations', () => {
  it('headroom is the unspent budget, and goes negative when the ledger is over it', () => {
    expect(valueOf(poolObservations([row()]), 'headroom')).toBe(4)
    // Members leaving while their leases are still live is exactly the shape a capacity alert
    // must catch, so the gauge reports the overdraft rather than clamping it to zero.
    expect(valueOf(poolObservations([row({ capacityAgents: 8, dutyAgents: 20 })]), 'headroom')).toBe(-12)
  })

  it('labels the org-less set as the install-wide pool and every other set as an org one', () => {
    const [install] = poolObservations([row()])
    expect(install!.attrs).toEqual({ set: 'pool', scope: 'install' })
    const [org] = poolObservations([row({ installWide: false, setName: 'acme' })])
    expect(org!.attrs).toEqual({ set: 'acme', scope: 'org' })
  })

  // `maxAgents <= 0` is the daemon's sentinel for "no ceiling" (Daemon.dutyHeadroomForPendingClaim
  // returns +Infinity for it), so a set holding one has no finite budget at all. Reporting the
  // summed sentinel would say the opposite of what the member does — a pool that accepts
  // everything would advertise zero capacity and fire the "full" alarm forever.
  it('reports no capacity or headroom for a set with an unbounded member, rather than zero', () => {
    const obs = poolObservations([row({ unboundedMembers: 1, capacityAgents: 16, dutyAgents: 20 })])
    expect(obs.map((o) => o.metric)).not.toContain('capacity')
    expect(obs.map((o) => o.metric)).not.toContain('headroom')
    // Everything that is still well defined keeps flowing, and the omission is explainable.
    expect(valueOf(obs, 'unbounded')).toBe(1)
    expect(valueOf(obs, 'used')).toBe(20)
    expect(valueOf(obs, 'members')).toBe(3)
  })

  it('a fully bounded set still reports both, and unbounded reads zero', () => {
    const obs = poolObservations([row()])
    expect(valueOf(obs, 'capacity')).toBe(24)
    expect(valueOf(obs, 'headroom')).toBe(4)
    expect(valueOf(obs, 'unbounded')).toBe(0)
  })

  it('reports every set, so one full pool cannot be averaged away by an idle one', () => {
    const obs = poolObservations([row(), row({ setName: 'other', installWide: false, dutyAgents: 24 })])
    expect(obs.filter((o) => o.metric === 'headroom').map((o) => [o.attrs.set, o.value])).toEqual([
      ['pool', 4],
      ['other', 0]
    ])
  })
})

describe('readPoolObservations', () => {
  it('reads the ledger at the clock, with the lease horizon and deliverability cap it was given', async () => {
    const seen: unknown[] = []
    const obs = await readPoolObservations(
      deps({
        repo: {
          poolTelemetry: async (now, liveMs, maxMembers) => {
            seen.push([now, liveMs, maxMembers])
            return [row()]
          }
        }
      })
    )
    expect(seen).toEqual([[NOW, 120_000, 1000]])
    expect(valueOf(obs!, 'members')).toBe(3)
  })

  // The defect this exists to prevent: observing zeros on a database blip is indistinguishable
  // from a full pool with no headroom, which fires the capacity alert on an unrelated outage.
  it('skips the collection entirely when the ledger cannot be read', async () => {
    const warned: unknown[] = []
    const result = await readPoolObservations(
      deps({
        repo: {
          poolTelemetry: async () => {
            throw new Error('connection terminated')
          }
        },
        log: { warn: (o) => warned.push(o) }
      })
    )
    expect(result).toBeNull()
    expect(warned).toHaveLength(1)
  })
})
