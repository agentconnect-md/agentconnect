// The daemon half of a pool rollout (k8s-daemon-pool.md §12): on SIGTERM a member stops claiming,
// declares `draining` on its digest, lets in-flight turns finish, and hands each held group back
// with an acknowledged `duty/release` — idle groups at once, busy ones as they settle — before the
// CP socket closes. These pin that sequence and its deadline path.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DutyGrantEntry } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import type { DutyRegistry } from '../src/cp/duty-registry.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { VirtualClock, runVirtual, settle as flush } from './fakes/virtual-clock.js'

const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const AGENT_B = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
const GROUP = '11111111-1111-4111-8111-111111111111'
const GROUP_B = '11111111-1111-4111-8111-111111111112'
const ORG = 'org-1'

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-duty-drain-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  return root
}

const grant = (groupId: string, agentId: string, placement?: 'daemon' | 'set'): DutyGrantEntry => ({
  groupId,
  orgId: ORG,
  term: '1',
  members: [{ kind: 'agent', refId: agentId, ...(placement ? { placement } : {}) }]
})

const bundle = (agentId: string, name: string) => ({
  agentId,
  spec: { orgId: ORG, name, runtime: 'claude', workspace: { mode: 'scratch' as const, isolation: 'shared' as const } },
  integrations: [],
  crons: []
})

/** A frame-scope member holding two single-agent groups, with an instrumented stub CP client.
 *  Every deadline the drain measures — the budget, the release backoff, the "still busy" sleep —
 *  runs on the injected clock, so a test skips them in virtual time instead of sleeping them. */
async function boot(opts: { releaseDuties?: (groupIds: string[]) => Promise<void> } = {}) {
  const clock = new VirtualClock()
  const daemon = new Daemon({ root: scaffold(), slackAppFactory: fakeSlackAppFactory(), clock })
  await daemon.start()
  const calls: { order: string[]; releases: string[][] } = { order: [], releases: [] }
  const releaseDuties = vi.fn(async (groupIds: string[]) => {
    calls.releases.push(groupIds)
    calls.order.push(`release:${groupIds.join(',')}`)
    await opts.releaseDuties?.(groupIds)
  })
  const stop = vi.fn(async () => {
    calls.order.push('socket-close')
  })
  const reportDutiesNow = vi.fn(() => {
    calls.order.push('report')
  })
  ;(daemon as any).cpClient = {
    organizationScope: () => 'frame',
    memberSet: () => ({ setId: '9f11e5e7-0000-4000-8000-000000000001', name: 'Cloud' }),
    terminallyClosed: () => false,
    stop,
    releaseDuties,
    reportDutiesNow,
    fetchDutyAgent: vi.fn(async ({ agentId }: { agentId: string }) => ({
      bundle: bundle(agentId, agentId === AGENT ? 'scout' : 'ranger')
    }))
  }
  await (daemon as any).dutyCoordinator.admitDutyGrants([grant(GROUP, AGENT), grant(GROUP_B, AGENT_B)])
  expect(duties(daemon).groupIds().sort()).toEqual([GROUP, GROUP_B])
  return { daemon, clock, calls, releaseDuties, stop, reportDutiesNow }
}

const duties = (d: Daemon) => (d as any).duties as DutyRegistry
const digest = (d: Daemon) =>
  (d as any).dutyCoordinator.dutyDigest() as { held: unknown[]; headroom: number; draining?: boolean }

describe('shutdown drain of a duty-holding member', () => {
  it('declares draining and releases each idle group with an awaited ack before the socket closes', async () => {
    const { daemon, calls, releaseDuties, reportDutiesNow } = await boot()
    expect(digest(daemon).draining).toBeUndefined()
    // The admission above reported its digest too; only what the shutdown does counts here.
    reportDutiesNow.mockClear()
    calls.order.length = 0

    const stopping = daemon.stop()
    // The very first thing: the digest says draining with zero headroom, reported at once.
    expect(digest(daemon)).toMatchObject({ headroom: 0, draining: true })
    expect(reportDutiesNow).toHaveBeenCalledTimes(1)
    await stopping

    // One release per group, each acknowledged, all before the CP transport was closed.
    expect(releaseDuties).toHaveBeenCalledTimes(2)
    expect(calls.releases.map((ids) => ids.length)).toEqual([1, 1])
    expect(calls.order).toEqual(['report', `release:${GROUP}`, `release:${GROUP_B}`, 'socket-close'])
    expect(duties(daemon).size()).toBe(0)
  })

  it('turns readiness false at the latch, so the endpoints controller stops routing before the drain runs', async () => {
    const { daemon } = await boot()
    ;(daemon as any).cpClient.state = 'READY'
    expect(daemon.readinessState()).toEqual({ ready: true, reason: 'ready' })

    const stopping = daemon.stop()
    // Synchronous with the latch, not a sync tick later: the drain that follows can take minutes,
    // and every second of it routing new traffic here is traffic the member is retiring from.
    expect(daemon.readinessState()).toEqual({ ready: false, reason: 'draining' })
    await stopping
    expect(daemon.readinessState()).toEqual({ ready: false, reason: 'draining' })
  })

  it('a late grant with everything clean is never installed and is acknowledged only after the loop is done', async () => {
    const LATE = '11111111-1111-4111-8111-111111111113'
    const { daemon, calls } = await boot()
    const fetchDutyAgent = (daemon as any).cpClient.fetchDutyAgent as ReturnType<typeof vi.fn>
    const info = vi.spyOn((daemon as any).log, 'info')

    const stopping = daemon.stop()
    // An exchange that began before the SIGTERM commits its vacancy grant and delivers it now.
    ;(daemon as any).dutyCoordinator.applyDutyGrant([grant(LATE, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3')])
    await stopping

    expect(fetchDutyAgent).not.toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3' })
    )
    expect(duties(daemon).get(LATE)).toBeUndefined()
    // Acknowledged after every held group, before the socket closed, and counted in the summary.
    expect(calls.releases).toEqual([[GROUP], [GROUP_B], [LATE]])
    expect(calls.order.at(-1)).toBe('socket-close')
    const summary = info.mock.calls.map(([m]) => String(m)).find((m) => m.startsWith('duty: shutdown drain released'))
    expect(summary).toMatch(/released 2 group\(s\) covering 2 agent\(s\) plus 1 late grant\(s\)/)
    expect(summary).toMatch(/3 acknowledged, 0 left to lapse/)
  })

  it('a late grant is not acknowledged while the loop is still waiting on a busy group', async () => {
    const LATE = '11111111-1111-4111-8111-111111111113'
    const { daemon, clock, calls } = await boot()
    const settle = (daemon as any).beginActiveDispatch(AGENT, 'slack:C1:T2') as () => void
    const cancel = vi.fn(async () => {})
    ;(daemon as any).hosts.set(AGENT, { stop: vi.fn(async () => {}), cancel })

    const stopping = daemon.stop()
    // A late grant for another agent, and a replacement of the busy group at a bumped term.
    ;(daemon as any).dutyCoordinator.applyDutyGrant([
      grant(LATE, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'),
      { ...grant(GROUP, AGENT), term: '2' }
    ])
    await vi.waitFor(() => expect(calls.releases).toEqual([[GROUP_B]]))
    // The loop is now parked on its "still busy" deadline, which is virtual and unfired, so
    // draining the macrotask queue is proof that nothing further CAN happen — not a guess.
    await flush()
    // Nothing late is acknowledged, the busy group is still held at its old term, its turn untouched.
    expect(calls.releases).toEqual([[GROUP_B]])
    expect(duties(daemon).get(GROUP)?.term).toBe('1')
    expect(cancel).not.toHaveBeenCalled()

    settle()
    await runVirtual(clock, stopping)
    // The loop releases GROUP after its turn; only then the late grants (GROUP again is idempotent).
    expect(calls.releases.slice(0, 2)).toEqual([[GROUP_B], [GROUP]])
    expect(
      calls.releases
        .slice(2)
        .map((ids) => ids[0])
        .sort()
    ).toEqual([LATE, GROUP].sort())
    expect(calls.order.at(-1)).toBe('socket-close')
  })

  it('a late grant covering an agent of a group left to lapse lapses too', async () => {
    const LATE = '11111111-1111-4111-8111-111111111113'
    const { daemon, calls } = await boot()
    ;(daemon as any).hosts.set(AGENT, {
      stop: vi.fn(async () => {
        throw new Error('child ignored SIGKILL')
      }),
      cancel: vi.fn(async () => {})
    })
    const info = vi.spyOn((daemon as any).log, 'info')
    const warn = vi.spyOn((daemon as any).log, 'warn')

    const stopping = daemon.stop()
    // A split: agent A re-homed under a NEW group id, delivered after the latch.
    ;(daemon as any).dutyCoordinator.applyDutyGrant([grant(LATE, AGENT)])
    await stopping

    // GROUP lapses (its host would not stop), and so does the late grant that covers the same agent.
    expect(calls.releases).toEqual([[GROUP_B]])
    expect(
      warn.mock.calls.some(([m]) => /late grant .* covers agent .* not released, its lease lapses/.test(String(m)))
    ).toBe(true)
    const summary = info.mock.calls.map(([m]) => String(m)).find((m) => m.startsWith('duty: shutdown drain released'))
    expect(summary).toMatch(/plus 1 late grant\(s\)/)
    expect(summary).toMatch(/1 acknowledged, 2 left to lapse/)
  })

  it('a late grant for a group whose fire-and-forget host stop failed before SIGTERM lapses', async () => {
    const { daemon, calls } = await boot()
    ;(daemon as any).hosts.set(AGENT, {
      stop: vi.fn(async () => {
        throw new Error('child ignored SIGKILL')
      }),
      cancel: vi.fn(async () => {})
    })
    await (daemon as any).dutyCoordinator.applyDutyRevoke([{ groupId: GROUP, reason: 'superseded' }])
    await flush()
    const warn = vi.spyOn((daemon as any).log, 'warn')

    const stopping = daemon.stop()
    ;(daemon as any).dutyCoordinator.applyDutyGrant([{ ...grant(GROUP, AGENT), term: '2' }])
    await stopping

    expect(calls.releases).toEqual([[GROUP_B]])
    expect(warn.mock.calls.some(([m]) => /late grant .* not released, its lease lapses/.test(String(m)))).toBe(true)
  })

  it("a late regrant of the last group revoked just before SIGTERM waits for that revoke's connection convergence, and lapses if it never confirms", async () => {
    // Confirmed late: the revoke's reconcile is held open, then released.
    {
      const { daemon, calls } = await boot()
      // Only GROUP is held, so the loop has nothing to do once it is revoked.
      await (daemon as any).dutyCoordinator.applyDutyRevoke([{ groupId: GROUP_B, reason: 'gone' }])
      await flush()
      let finishReconcile!: () => void
      const gate = new Promise<void>((resolve) => {
        finishReconcile = resolve
      })
      const runReconcile = (daemon as any).runReconcile.bind(daemon) as () => Promise<void>
      ;(daemon as any).runReconcile = async () => {
        await gate
        await runReconcile()
      }
      await (daemon as any).dutyCoordinator.applyDutyRevoke([{ groupId: GROUP, reason: 'superseded' }])
      expect(duties(daemon).size()).toBe(0)

      const stopping = daemon.stop()
      ;(daemon as any).dutyCoordinator.applyDutyGrant([{ ...grant(GROUP, AGENT), term: '2' }])
      await flush()
      // Loop done at once (nothing held), host long gone — still no ack while the socket teardown pends.
      expect(calls.releases).toEqual([])

      finishReconcile()
      await stopping
      expect(calls.releases).toEqual([[GROUP]])
    }
    // Never confirmed: lapses.
    {
      const { daemon, clock, calls } = await boot()
      ;(daemon as any).cfg.limits.shutdownDrainMs = 1_500
      await (daemon as any).dutyCoordinator.applyDutyRevoke([{ groupId: GROUP_B, reason: 'gone' }])
      await flush()
      ;(daemon as any).runReconcile = () => new Promise<void>(() => {})
      await (daemon as any).dutyCoordinator.applyDutyRevoke([{ groupId: GROUP, reason: 'superseded' }])
      const warn = vi.spyOn((daemon as any).log, 'warn')

      const stopping = daemon.stop()
      ;(daemon as any).dutyCoordinator.applyDutyGrant([{ ...grant(GROUP, AGENT), term: '2' }])
      // The 1.5s budget plus the 30s release reserve is elapsed in virtual time, not slept.
      await runVirtual(clock, stopping, 40_000)

      expect(calls.releases).toEqual([])
      expect(warn.mock.calls.some(([m]) => /late grant .* connection teardown unconfirmed/.test(String(m)))).toBe(true)
    }
  })

  it('a CP-commanded rebalance drain still ignores grants that land while it is suspended', async () => {
    const { daemon, releaseDuties } = await boot()
    const admit = vi.spyOn((daemon as any).dutyCoordinator, 'admitDutyGrants')
    ;(daemon as any).dutyClaimsSuspended = true
    ;(daemon as any).dutyCoordinator.applyDutyGrant([
      grant('11111111-1111-4111-8111-111111111114', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4')
    ])
    await flush()
    expect(admit).not.toHaveBeenCalled()
    expect(releaseDuties).not.toHaveBeenCalled()
    ;(daemon as any).dutyClaimsSuspended = false
    await daemon.stop()
  })

  it('a host that fails to stop leaves its group unreleased — the lease lapses instead of a false ack', async () => {
    const { daemon, calls } = await boot()
    ;(daemon as any).hosts.set(AGENT, {
      stop: vi.fn(async () => {
        throw new Error('child ignored SIGKILL')
      }),
      cancel: vi.fn(async () => {})
    })
    const info = vi.spyOn((daemon as any).log, 'info')
    const warn = vi.spyOn((daemon as any).log, 'warn')

    await daemon.stop()

    expect(calls.releases).toEqual([[GROUP_B]])
    expect(warn.mock.calls.some(([m]) => /not released, its lease lapses \(host stop failed/.test(String(m)))).toBe(
      true
    )
    const summary = info.mock.calls.map(([m]) => String(m)).find((m) => m.startsWith('duty: shutdown drain released'))
    expect(summary).toMatch(/1 acknowledged, 1 left to lapse/)
  })

  it("a release waits for the group's platform connections to converge — the socket is closed before the ack is sought", async () => {
    const { daemon, calls } = await boot()
    // A live direct socket for agent A's group, as reconcile would have opened it while held.
    const conn = { botToken: 'xoxb-test', appToken: 'xapp-test', botUserId: 'U1', stop: vi.fn(async () => {}) }
    ;(daemon as any).connections.slackPool.add(conn)
    ;(daemon as any).connByIntegration.set('22222222-2222-4222-8222-222222222222', conn)
    let socketOpenAtRelease: boolean | undefined
    ;(daemon as any).cpClient.releaseDuties = vi.fn(async (groupIds: string[]) => {
      if (groupIds[0] === GROUP) socketOpenAtRelease = (daemon as any).connections.slackPool.all().includes(conn)
      calls.releases.push(groupIds)
    })

    await daemon.stop()

    expect(calls.releases).toContainEqual([GROUP])
    expect(conn.stop).toHaveBeenCalled()
    expect(socketOpenAtRelease).toBe(false)
  })

  it('a group whose teardown cannot be confirmed by the deadline is not released — its lease is left to lapse', async () => {
    const { daemon, clock, releaseDuties } = await boot()
    ;(daemon as any).cfg.limits.shutdownDrainMs = 1_500
    // The reconcile that carries the connection convergence never finishes.
    ;(daemon as any).runReconcile = () => new Promise<void>(() => {})
    const info = vi.spyOn((daemon as any).log, 'info')
    const warn = vi.spyOn((daemon as any).log, 'warn')

    // The budget it never confirms within (plus the release reserve) is elapsed in virtual time.
    await runVirtual(clock, daemon.stop(), 40_000)

    expect(releaseDuties).not.toHaveBeenCalled()
    expect(warn.mock.calls.some(([m]) => /not released, its lease lapses/.test(String(m)))).toBe(true)
    const summary = info.mock.calls.map(([m]) => String(m)).find((m) => m.startsWith('duty: shutdown drain released'))
    expect(summary).toMatch(/0 acknowledged, 2 left to lapse/)
    // Withdrawn locally regardless: nothing here still claims to serve them.
    expect(duties(daemon).size()).toBe(0)
  })

  it('a busy group waits for its turn to finish while idle groups are released at once — no turn is cancelled', async () => {
    const { daemon, clock, calls } = await boot()
    // Agent A owns admitted work: an active dispatch lease, exactly what a running turn holds.
    const settle = (daemon as any).beginActiveDispatch(AGENT, 'slack:C1:T1') as () => void
    const cancel = vi.fn(async () => {})
    ;(daemon as any).hosts.set(AGENT, { stop: vi.fn(async () => {}), cancel })

    const stopping = daemon.stop()
    // Group B (idle) goes immediately; group A is still held while its turn runs.
    await vi.waitFor(() => expect(calls.releases).toEqual([[GROUP_B]]))
    // Parked on the loop's virtual "still busy" deadline: draining the queue settles everything
    // that could still happen, so the negative assertions below are exhaustive rather than timed.
    await flush()
    expect(duties(daemon).groupIds()).toEqual([GROUP])
    expect(cancel).not.toHaveBeenCalled()

    settle()
    await runVirtual(clock, stopping)
    expect(calls.releases).toEqual([[GROUP_B], [GROUP]])
    expect(cancel).not.toHaveBeenCalled()
    expect(calls.order.at(-1)).toBe('socket-close')
  })

  it("a member's daemon-placed work keeps the local turn-wait window, never the pool budget", async () => {
    const { daemon, clock, calls } = await boot()
    // Both agents pinned to this daemon: nothing here can move to a successor.
    await (daemon as any).dutyCoordinator.admitDutyGrants([
      grant(GROUP, AGENT, 'daemon'),
      grant(GROUP_B, AGENT_B, 'daemon')
    ])
    ;(daemon as any).cfg.limits.shutdownDrainMs = 1_000
    ;(daemon as any).cfg.limits.poolShutdownDrainMs = 600_000
    const warn = vi.spyOn((daemon as any).log, 'warn')
    // A turn that outlives the local window: it settles at 5s, long before a pool-budget wait would cut it.
    const settle = (daemon as any).beginActiveDispatch(AGENT, 'slack:C1:T1') as () => void
    ;(daemon as any).hosts.set(AGENT, { stop: vi.fn(async () => {}), cancel: vi.fn(async () => {}) })
    clock.setTimeout(() => settle(), 5_000)

    const startedAt = clock.now()
    await runVirtual(clock, daemon.stop(), 40_000)
    const elapsed = clock.now() - startedAt

    // The wait was cut at the 1s local window — under the pool's 570s wait this warning never fires —
    // and the straggler's group still released inside the reserve once its turn settled.
    expect(warn.mock.calls.some(([m]) => /deadline hit with .* still in flight/.test(String(m)))).toBe(true)
    expect(elapsed).toBeLessThan(31_000)
    expect(calls.releases.flat().sort()).toEqual([GROUP, GROUP_B].sort())
    expect(calls.order.at(-1)).toBe('socket-close')
  })

  it("a member's set-placed work rides the pool drain budget — org sets included", async () => {
    const { daemon, clock, calls } = await boot()
    // AGENT is explicitly set-placed; GROUP_B keeps boot()'s unstamped grant, the conservative default.
    await (daemon as any).dutyCoordinator.admitDutyGrants([grant(GROUP, AGENT, 'set')])
    expect(duties(daemon).setPlacedAgents()).toEqual(new Set([AGENT, AGENT_B]))
    ;(daemon as any).cfg.limits.shutdownDrainMs = 1_000
    ;(daemon as any).cfg.limits.poolShutdownDrainMs = 60_000
    const warn = vi.spyOn((daemon as any).log, 'warn')
    // A set-placed turn settling well past the local window but inside the pool wait.
    const settle = (daemon as any).beginActiveDispatch(AGENT, 'slack:C1:T1') as () => void
    ;(daemon as any).hosts.set(AGENT, { stop: vi.fn(async () => {}), cancel: vi.fn(async () => {}) })
    clock.setTimeout(() => settle(), 10_000)

    const startedAt = clock.now()
    await runVirtual(clock, daemon.stop(), 70_000)
    const elapsed = clock.now() - startedAt

    // Never cancelled: the pool budget carried the turn to its own end at 10s.
    expect(warn.mock.calls.some(([m]) => /deadline hit|local window hit/.test(String(m)))).toBe(false)
    expect(elapsed).toBeGreaterThanOrEqual(10_000)
    expect(elapsed).toBeLessThan(31_000)
    expect(calls.releases.flat().sort()).toEqual([GROUP, GROUP_B].sort())
    expect(calls.order.at(-1)).toBe('socket-close')
  })

  it('a set-placed dream with no active dispatch holds the pool budget, then is cut at the turn-wait cutoff', async () => {
    const { daemon, clock, calls } = await boot()
    await (daemon as any).dutyCoordinator.admitDutyGrants([grant(GROUP, AGENT, 'set')])
    ;(daemon as any).cfg.limits.shutdownDrainMs = 1_000
    ;(daemon as any).cfg.limits.poolShutdownDrainMs = 60_000
    // Busy through the dream path only — no dispatch lease, the release loop's other in-flight kind.
    let dreaming = true
    const cancelDream = vi.fn(async () => {
      dreaming = false
    })
    ;(daemon as any).dreamRunnerInstance = {
      dutyBusy: (id: string) => id === AGENT && dreaming,
      inFlightAgents: () => (dreaming ? [AGENT] : []),
      cancelInFlight: cancelDream
    }
    ;(daemon as any).hosts.set(AGENT, { stop: vi.fn(async () => {}), cancel: vi.fn(async () => {}) })
    const info = vi.spyOn((daemon as any).log, 'info')

    const startedAt = clock.now()
    await runVirtual(clock, daemon.stop(), 70_000)
    const elapsed = clock.now() - startedAt

    // The dream rode past the 1s local window on the pool budget, was cancelled at the 30s
    // turn-wait cutoff (60s minus the release reserve), and its group still released with an
    // ack inside the reserve — never forced at the overall deadline.
    expect(cancelDream).toHaveBeenCalledWith(AGENT)
    expect(elapsed).toBeGreaterThanOrEqual(30_000)
    expect(elapsed).toBeLessThan(45_000)
    expect(calls.releases.flat().sort()).toEqual([GROUP, GROUP_B].sort())
    const summary = info.mock.calls.map(([m]) => String(m)).find((m) => m.startsWith('duty: shutdown drain released'))
    expect(summary).toMatch(/2 acknowledged, 0 left to lapse/)
  })

  it("a daemon-placed dream is cut at the local window, not the pool one's", async () => {
    const { daemon, clock, calls } = await boot()
    await (daemon as any).dutyCoordinator.admitDutyGrants([
      grant(GROUP, AGENT, 'daemon'),
      grant(GROUP_B, AGENT_B, 'daemon')
    ])
    ;(daemon as any).cfg.limits.shutdownDrainMs = 1_000
    ;(daemon as any).cfg.limits.poolShutdownDrainMs = 600_000
    let dreaming = true
    const cancelDream = vi.fn(async () => {
      dreaming = false
    })
    ;(daemon as any).dreamRunnerInstance = {
      dutyBusy: (id: string) => id === AGENT && dreaming,
      inFlightAgents: () => (dreaming ? [AGENT] : []),
      cancelInFlight: cancelDream
    }
    ;(daemon as any).hosts.set(AGENT, { stop: vi.fn(async () => {}), cancel: vi.fn(async () => {}) })

    const startedAt = clock.now()
    await runVirtual(clock, daemon.stop(), 40_000)
    const elapsed = clock.now() - startedAt

    // Cut at the 1s local window; releases still ack inside the reserve that follows.
    expect(cancelDream).toHaveBeenCalledWith(AGENT)
    expect(elapsed).toBeLessThan(31_000)
    expect(calls.releases.flat().sort()).toEqual([GROUP, GROUP_B].sort())
    expect(calls.order.at(-1)).toBe('socket-close')
  })

  it('a parked adoption that cancellation can never wake still releases its group acked inside the reserve', async () => {
    const { daemon, clock, calls } = await boot()
    await (daemon as any).dutyCoordinator.admitDutyGrants([grant(GROUP, AGENT, 'set')])
    ;(daemon as any).cfg.limits.shutdownDrainMs = 1_000
    ;(daemon as any).cfg.limits.poolShutdownDrainMs = 60_000
    // The hung-request shape: the abandon flag lands but the job NEVER drains — only its
    // group hold drops (dutyBusy), exactly the runner's abandoned-job contract.
    let abandoned = false
    const cancelDream = vi.fn(async () => {
      abandoned = true
    })
    ;(daemon as any).dreamRunnerInstance = {
      dutyBusy: (id: string) => id === AGENT && !abandoned,
      inFlightAgents: () => [AGENT],
      cancelInFlight: cancelDream
    }
    ;(daemon as any).hosts.set(AGENT, { stop: vi.fn(async () => {}), cancel: vi.fn(async () => {}) })
    const info = vi.spyOn((daemon as any).log, 'info')

    const startedAt = clock.now()
    await runVirtual(clock, daemon.stop(), 70_000)
    const elapsed = clock.now() - startedAt

    // Cancelled at the 30s turn-wait cutoff; the group stops being busy at once and BOTH
    // releases are acknowledged inside the reserve — the hung request never consumes it.
    expect(cancelDream).toHaveBeenCalledWith(AGENT)
    expect(elapsed).toBeGreaterThanOrEqual(30_000)
    expect(elapsed).toBeLessThan(45_000)
    expect(calls.releases.flat().sort()).toEqual([GROUP, GROUP_B].sort())
    const summary = info.mock.calls.map(([m]) => String(m)).find((m) => m.startsWith('duty: shutdown drain released'))
    expect(summary).toMatch(/2 acknowledged, 0 left to lapse/)
    expect(calls.order.at(-1)).toBe('socket-close')
  })

  it('a release the CP never acknowledges is retried until the drain deadline, then counted and left to lapse', async () => {
    const { daemon, clock, releaseDuties } = await boot({
      releaseDuties: async () => {
        throw new Error('control plane unreachable (client DEGRADED)')
      }
    })
    ;(daemon as any).cfg.limits.shutdownDrainMs = 2_500
    const info = vi.spyOn((daemon as any).log, 'info')
    const warn = vi.spyOn((daemon as any).log, 'warn')

    const startedAt = clock.now()
    // Budget and backoff both run on the injected clock, so the ladder below is exercised in
    // virtual time — and the bound is asserted against that clock, never against the wall one.
    await runVirtual(clock, daemon.stop(), 40_000)
    const elapsed = clock.now() - startedAt

    // Retried on the backoff ladder and bounded by the budget plus the release reserve,
    // not by the retries.
    expect(releaseDuties.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(elapsed).toBeLessThan(35_000)
    expect(warn.mock.calls.some(([m]) => /not acknowledged before the drain deadline/.test(String(m)))).toBe(true)
    const summary = info.mock.calls.map(([m]) => String(m)).find((m) => m.startsWith('duty: shutdown drain released'))
    expect(summary).toMatch(/released 2 group\(s\) covering 2 agent\(s\)/)
    expect(summary).toMatch(/0 acknowledged, 2 left to lapse/)
    // Locally withdrawn regardless: nothing here still serves what the CP will hand on.
    expect(duties(daemon).size()).toBe(0)
  })

  it('a permanently closed CP client is not retried against — every lease lapses at once, not at the deadline', async () => {
    // The bootstrap-upgrade shape: the client is retired (stopped, socket closed, no redial)
    // BEFORE Daemon.stop() runs, so no retry can ever deliver a release.
    const { daemon, clock, releaseDuties } = await boot({
      releaseDuties: async () => {
        throw new Error('control plane unreachable (client CLOSED)')
      }
    })
    ;(daemon as any).cpClient.terminallyClosed = () => true
    const info = vi.spyOn((daemon as any).log, 'info')
    const warn = vi.spyOn((daemon as any).log, 'warn')

    const startedAt = clock.now()
    await runVirtual(clock, daemon.stop())

    // One attempt per group, no backoff ladder, and nowhere near the 300s pool drain budget.
    expect(releaseDuties).toHaveBeenCalledTimes(2)
    expect(clock.now() - startedAt).toBeLessThan(5_000)
    expect(warn.mock.calls.some(([m]) => /permanently closed, its lease lapses/.test(String(m)))).toBe(true)
    const summary = info.mock.calls.map(([m]) => String(m)).find((m) => m.startsWith('duty: shutdown drain released'))
    expect(summary).toMatch(/0 acknowledged, 2 left to lapse/)
    expect(duties(daemon).size()).toBe(0)
  })

  it('an org-scoped daemon is not duty-governed and stops as before — no digest bit, no release', async () => {
    const daemon = new Daemon({ root: scaffold(), slackAppFactory: fakeSlackAppFactory() })
    await daemon.start()
    const releaseDuties = vi.fn(async () => {})
    const reportDutiesNow = vi.fn()
    ;(daemon as any).cpClient = {
      organizationScope: () => 'connection',
      stop: vi.fn(async () => {}),
      releaseDuties,
      reportDutiesNow
    }
    await daemon.stop()
    expect(reportDutiesNow).not.toHaveBeenCalled()
    expect(releaseDuties).not.toHaveBeenCalled()
  })
})
