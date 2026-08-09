import { describe, expect, it, vi } from 'vitest'
import { FakeClock } from '../../test/fakes/fake-clock.js'
import { OrgId } from '../domain/ids.js'
import type { ExternalScopeRecord, SessionExternalAccessPolicyRecord } from '../persistence/ports.js'
import type { SessionAccessWarmOutcome } from './session-access-plugin.js'
import { SessionAccessWarmer } from './session-access-warmer.js'

/** `Clock` reports wall-clock epoch milliseconds, and lru-cache reads a falsy
 *  entry start as "no TTL recorded" — a clock left at 0 would hide expiry. */
const EPOCH = 1_777_000_000_000
const ORG = OrgId('org-1')
const SCOPE_ID = '11111111-1111-4111-8111-111111111111'
/** Half the default public TTL — the §4.3 re-warm cadence. */
const INTERVAL = 1_800_000

function scopeRecord(overrides: Partial<ExternalScopeRecord> = {}): ExternalScopeRecord {
  return {
    id: SCOPE_ID,
    orgId: ORG,
    provider: 'slack',
    realmKey: 'T_INSTALL',
    resourceKind: 'conversation',
    resourceKey: 'C_CHANNEL',
    credentialKind: 'bot',
    credentialId: 'b0b0b0b0-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    aclRevision: 1n,
    revokedAt: null,
    ...overrides
  }
}

function policyRecord(state: SessionExternalAccessPolicyRecord['state']): SessionExternalAccessPolicyRecord {
  return { orgId: ORG, provider: 'slack', state, currentRev: 1n, readFenceRev: 1n }
}

function harness(opts: { random?: () => number; idleDropMs?: number } = {}) {
  const clock = new FakeClock(EPOCH)
  const scopes = new Map<string, ExternalScopeRecord>([[SCOPE_ID, scopeRecord()]])
  const policies = new Map<string, SessionExternalAccessPolicyRecord>([[`${ORG}:slack`, policyRecord('enabled')]])
  const target = vi.fn(async (_scope: ExternalScopeRecord): Promise<SessionAccessWarmOutcome> => {
    return { outcome: 'warmed', verdict: 'public' }
  })
  const getExternalScopes = vi.fn(async (ids: string[]) =>
    ids.flatMap((id) => (scopes.has(id) ? [scopes.get(id)!] : []))
  )
  const getExternalAccessPolicy = vi.fn(async (orgId: OrgId, provider: string) => {
    return policies.get(`${orgId}:${provider}`) ?? null
  })
  const warmer = new SessionAccessWarmer({
    sessions: { getExternalScopes, getExternalAccessPolicy },
    targets: new Map([['slack', target]]),
    clock,
    random: opts.random ?? (() => 0),
    ...(opts.idleDropMs !== undefined ? { idleDropMs: opts.idleDropMs } : {})
  })
  return { clock, warmer, target, scopes, policies, getExternalScopes, getExternalAccessPolicy }
}

describe('SessionAccessWarmer', () => {
  it('warms a poked scope and re-warms it on the half-lease cadence', async () => {
    const h = harness()
    h.warmer.start()

    h.warmer.poke(ORG, SCOPE_ID)
    h.clock.advance(0)
    await h.warmer.settle()
    expect(h.target).toHaveBeenCalledTimes(1)
    expect(h.target).toHaveBeenCalledWith(expect.objectContaining({ id: SCOPE_ID, provider: 'slack' }))

    // Repeated pokes inside the cadence add no provider work — the loop carries
    // the scope; the poke only refreshes its working-set retention.
    h.warmer.poke(ORG, SCOPE_ID)
    h.clock.advance(0)
    await h.warmer.settle()
    expect(h.target).toHaveBeenCalledTimes(1)

    h.clock.advance(INTERVAL)
    await h.warmer.settle()
    expect(h.target).toHaveBeenCalledTimes(2)

    h.clock.advance(INTERVAL)
    await h.warmer.settle()
    expect(h.target).toHaveBeenCalledTimes(3)
    expect(h.warmer.stats).toMatchObject({ warms: 3, warmed: 3, skipped: 0, failed: 0 })
  })

  it('drops a scope with no poke past the retention window, until it is poked again', async () => {
    const h = harness({ idleDropMs: 2 * INTERVAL })
    h.warmer.start()
    h.warmer.poke(ORG, SCOPE_ID)
    h.clock.advance(0)
    await h.warmer.settle()

    // Two cadence sweeps still carry it (idle age 1× and exactly 2× the window)…
    h.clock.advance(INTERVAL)
    await h.warmer.settle()
    h.clock.advance(INTERVAL)
    await h.warmer.settle()
    expect(h.target).toHaveBeenCalledTimes(3)

    // …the next sweep finds it idle beyond the window and drops it for good.
    h.clock.advance(INTERVAL)
    await h.warmer.settle()
    h.clock.advance(INTERVAL)
    await h.warmer.settle()
    expect(h.target).toHaveBeenCalledTimes(3)

    // Fresh activity re-enters the working set immediately.
    h.warmer.poke(ORG, SCOPE_ID)
    h.clock.advance(0)
    await h.warmer.settle()
    expect(h.target).toHaveBeenCalledTimes(4)
  })

  it('skips a warm for a disabled or missing policy with zero provider calls', async () => {
    const h = harness()
    h.policies.set(`${ORG}:slack`, policyRecord('disabled'))
    h.warmer.start()

    h.warmer.poke(ORG, SCOPE_ID)
    h.clock.advance(0)
    await h.warmer.settle()
    expect(h.target).not.toHaveBeenCalled()

    h.policies.delete(`${ORG}:slack`)
    h.clock.advance(INTERVAL)
    await h.warmer.settle()
    expect(h.target).not.toHaveBeenCalled()
    expect(h.warmer.stats).toMatchObject({ warms: 2, skipped: 2, warmed: 0 })
  })

  it('skips at execution when the scope no longer resolves under the poked org', async () => {
    const h = harness()
    h.warmer.start()

    h.warmer.poke(OrgId('org-2'), SCOPE_ID)
    h.clock.advance(0)
    await h.warmer.settle()
    expect(h.target).not.toHaveBeenCalled()
    // The policy gate was never consulted either — the scope fence comes first.
    expect(h.getExternalAccessPolicy).not.toHaveBeenCalled()
    expect(h.warmer.stats.skipped).toBe(1)
  })

  it('skips a provider with no warm target', async () => {
    const h = harness()
    h.scopes.set(SCOPE_ID, scopeRecord({ provider: 'feishu' }))
    h.warmer.start()

    h.warmer.poke(ORG, SCOPE_ID)
    h.clock.advance(0)
    await h.warmer.settle()
    expect(h.target).not.toHaveBeenCalled()
    expect(h.warmer.stats.skipped).toBe(1)
  })

  it('holds the concurrency cap under a burst of pokes', async () => {
    const h = harness()
    let active = 0
    let maxActive = 0
    const releases: Array<() => void> = []
    h.target.mockImplementation(() => {
      active += 1
      maxActive = Math.max(maxActive, active)
      return new Promise<SessionAccessWarmOutcome>((resolve) => {
        releases.push(() => {
          active -= 1
          resolve({ outcome: 'warmed', verdict: 'public' })
        })
      })
    })
    for (let index = 1; index <= 8; index++) {
      h.scopes.set(`scope-${index}`, scopeRecord({ id: `scope-${index}` }))
    }
    h.warmer.start()
    for (let index = 1; index <= 8; index++) h.warmer.poke(ORG, `scope-${index}`)
    h.clock.advance(0)

    await vi.waitFor(() => expect(h.target.mock.calls.length).toBe(3))
    expect(maxActive).toBe(3)

    // Draining a slot admits exactly the next queued warm, never a burst.
    await vi.waitFor(() => {
      while (releases.length > 0) releases.shift()!()
      expect(h.target.mock.calls.length).toBe(8)
    })
    while (releases.length > 0) releases.shift()!()
    await h.warmer.settle()
    expect(maxActive).toBe(3)
    expect(h.warmer.stats.warmed).toBe(8)
  })

  it('spreads first warms after a restart across the young-process window', async () => {
    const h = harness({ random: () => 0.5 })
    h.warmer.start()

    h.warmer.poke(ORG, SCOPE_ID)
    h.clock.advance(INTERVAL / 2 - 1)
    await h.warmer.settle()
    expect(h.target).not.toHaveBeenCalled()

    h.clock.advance(1)
    await h.warmer.settle()
    expect(h.target).toHaveBeenCalledTimes(1)
  })

  it('jitters within the small band once the process is no longer young', async () => {
    const h = harness({ random: () => 0.5 })
    h.warmer.start()
    h.clock.advance(INTERVAL)
    await h.warmer.settle()

    h.warmer.poke(ORG, SCOPE_ID)
    h.clock.advance(15_000)
    await h.warmer.settle()
    expect(h.target).toHaveBeenCalledTimes(1)
  })

  it('records pokes before startBackground but never arms a timer', async () => {
    const h = harness()
    h.warmer.poke(ORG, SCOPE_ID)
    expect(h.clock.pendingTimers()).toBe(0)
    h.clock.advance(10 * INTERVAL)
    await h.warmer.settle()
    expect(h.target).not.toHaveBeenCalled()

    // Arming later picks the recorded scope up on the first sweep.
    h.warmer.start()
    h.clock.advance(INTERVAL)
    await h.warmer.settle()
    expect(h.target).toHaveBeenCalledTimes(1)
  })

  it('stop() cancels the loop and every scheduled warm', async () => {
    const h = harness({ random: () => 0.5 })
    h.warmer.start()
    expect(h.clock.pendingTimers()).toBe(1)
    h.warmer.poke(ORG, SCOPE_ID)
    expect(h.clock.pendingTimers()).toBe(2)

    h.warmer.stop()
    expect(h.clock.pendingTimers()).toBe(0)
    await h.warmer.settle()

    h.clock.advance(10 * INTERVAL)
    await h.warmer.settle()
    expect(h.target).not.toHaveBeenCalled()
  })

  it('settle() drains a warm still in flight when stop() lands', async () => {
    const h = harness()
    let release!: () => void
    h.target.mockImplementation(() => {
      return new Promise<SessionAccessWarmOutcome>((resolve) => {
        release = () => resolve({ outcome: 'warmed', verdict: 'public' })
      })
    })
    h.warmer.start()
    h.warmer.poke(ORG, SCOPE_ID)
    h.clock.advance(0)
    await vi.waitFor(() => expect(h.target).toHaveBeenCalledTimes(1))

    h.warmer.stop()
    const settled = vi.fn()
    const settling = h.warmer.settle().then(settled)
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()

    release()
    await settling
    expect(settled).toHaveBeenCalledTimes(1)
    expect(h.warmer.stats.warmed).toBe(1)
  })

  it('counts a target failure without caching responsibilities of its own', async () => {
    const h = harness()
    h.target.mockResolvedValue({ outcome: 'failed', reason: 'ratelimited' })
    h.warmer.start()

    h.warmer.poke(ORG, SCOPE_ID)
    h.clock.advance(0)
    await h.warmer.settle()
    expect(h.warmer.stats).toMatchObject({ warms: 1, failed: 1, warmed: 0 })

    // The scope stays in the working set; the next sweep retries.
    h.target.mockResolvedValue({ outcome: 'warmed', verdict: 'public' })
    h.clock.advance(INTERVAL)
    await h.warmer.settle()
    expect(h.warmer.stats).toMatchObject({ warms: 2, failed: 1, warmed: 1 })
  })
})
