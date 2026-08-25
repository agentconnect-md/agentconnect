import { describe, expect, it } from 'vitest'
import { orgObservations, readOrgObservations, type OrgMetricsDeps } from './org-metrics.js'
import type { OrgTelemetryRow } from '../persistence/ports.js'

const NOW = new Date('2026-01-01T00:00:00Z')

const row = (over: Partial<OrgTelemetryRow> = {}): OrgTelemetryRow => ({
  orgId: 'org_acme',
  daemons: 2,
  agents: 7,
  sessionsTotal: 900,
  sessions30d: 120,
  sessions24h: 5,
  ...over
})

const deps = (over: Partial<OrgMetricsDeps> = {}): OrgMetricsDeps => ({
  repo: { orgTelemetry: async () => [row()] },
  clock: { now: () => NOW.getTime() } as OrgMetricsDeps['clock'],
  ...over
})

const valueOf = (obs: ReturnType<typeof orgObservations>, metric: string, window?: string) =>
  obs.find((o) => o.metric === metric && o.attrs.window === window)?.value

describe('orgObservations', () => {
  it('labels every series with the org id and splits sessions by window', () => {
    const obs = orgObservations([row()])
    expect(valueOf(obs, 'daemons')).toBe(2)
    expect(valueOf(obs, 'agents')).toBe(7)
    expect(valueOf(obs, 'sessions', 'total')).toBe(900)
    expect(valueOf(obs, 'sessions', '30d')).toBe(120)
    expect(valueOf(obs, 'sessions', '24h')).toBe(5)
    // The ID, never the slug: a slug is mutable and is user-chosen text.
    expect(obs.every((o) => o.attrs.org === 'org_acme')).toBe(true)
  })

  // The counts are not a hierarchy: only `total` is cumulative, so an org that has stopped using
  // the product keeps a large total beside zero windows and must still report all three.
  it('reports an idle org’s zero windows rather than dropping them', () => {
    const obs = orgObservations([row({ sessions30d: 0, sessions24h: 0 })])
    expect(valueOf(obs, 'sessions', 'total')).toBe(900)
    expect(valueOf(obs, 'sessions', '30d')).toBe(0)
    expect(valueOf(obs, 'sessions', '24h')).toBe(0)
  })

  // A series that vanishes on the way to zero is invisible on a dashboard — an org that removed
  // its last daemon would look like an org that was never there.
  it('emits all five series for an org holding nothing, as zeros', () => {
    const empty = row({ orgId: 'org_empty', daemons: 0, agents: 0, sessionsTotal: 0, sessions30d: 0, sessions24h: 0 })
    const obs = orgObservations([empty])
    expect(obs).toHaveLength(5)
    expect(obs.map((o) => o.value)).toEqual([0, 0, 0, 0, 0])
  })

  it('reports every org, so a busy one cannot be averaged away by an idle one', () => {
    const obs = orgObservations([row(), row({ orgId: 'org_other', agents: 1 })])
    expect(obs.filter((o) => o.metric === 'agents').map((o) => [o.attrs.org, o.value])).toEqual([
      ['org_acme', 7],
      ['org_other', 1]
    ])
  })
})

describe('readOrgObservations', () => {
  it('reads at the clock it was given, so the windows are the caller’s notion of now', async () => {
    const seen: unknown[] = []
    const obs = await readOrgObservations(
      deps({
        repo: {
          orgTelemetry: async (now) => {
            seen.push(now)
            return [row()]
          }
        }
      })
    )
    expect(seen).toEqual([NOW])
    expect(valueOf(obs!, 'daemons')).toBe(2)
  })

  // The defect this exists to prevent: observing zeros on a database blip is indistinguishable
  // from every org losing its daemons at once, which reads as a fleet-wide outage.
  it('skips the collection entirely when the read fails', async () => {
    const warned: unknown[] = []
    const result = await readOrgObservations(
      deps({
        repo: {
          orgTelemetry: async () => {
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
