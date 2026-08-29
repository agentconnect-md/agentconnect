// The daemon half of `T_reassign > T_fence`: a member must stop serving its duties before
// the CP can hand them to a successor. These pin what the fence tears down, what it must
// leave alone, and that an org-scoped daemon — which is not duty-governed — is untouched.
import { describe, it, expect, vi } from 'vitest'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DutyGrantEntry } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import type { DutyRegistry } from '../src/cp/duty-registry.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { VirtualClock, runVirtual } from './fakes/virtual-clock.js'
import { waitBudget } from './wait-support.js'

const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const AGENT_B = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
const GROUP = '11111111-1111-4111-8111-111111111111'
const GROUP_B = '11111111-1111-4111-8111-111111111112'
const INTEGRATION = '22222222-2222-4222-8222-222222222222'
const INTEGRATION_B = '22222222-2222-4222-8222-222222222223'
const CRON = '33333333-3333-4333-8333-333333333333'
const ORG = 'org-1'

// No `features` block anywhere in here on purpose: duty enforcement follows the connection's
// tenancy, so an install-wide member enforces with no configuration at all.
function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-duty-fence-'))
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

const grant = (groupId = GROUP, agentId = AGENT): DutyGrantEntry => ({
  groupId,
  orgId: ORG,
  term: '1',
  members: [{ kind: 'agent', refId: agentId }]
})

const bundle = (
  agentId = AGENT,
  name = 'scout',
  integrationId = INTEGRATION,
  creds = { botToken: 'xoxb-test', appToken: 'xapp-test' }
) => ({
  agentId,
  spec: {
    orgId: ORG,
    name,
    runtime: 'claude',
    workspace: { mode: 'scratch' as const, isolation: 'shared' as const }
  },
  integrations: [
    {
      integrationId,
      agentId,
      orgId: ORG,
      platform: 'slack',
      core: { mode: 'direct' as const, bindRules: [], mutedChannels: [], gated: false },
      config: { ...creds }
    }
  ],
  crons: [
    {
      cronId: agentId === AGENT ? CRON : `${CRON.slice(0, -1)}4`,
      agentId,
      orgId: ORG,
      schedule: '0 9 * * *',
      timezone: 'UTC',
      trigger: 'standup',
      enabled: true
    }
  ]
})

/** A daemon holding one granted duty, with a stub CP client — only the duty surface runs.
 *  The convergence retry the fence falls back to is armed on the injected clock, so a test can
 *  elapse it in virtual time rather than sleeping out its real one-second ladder. */
async function boot(scope: 'frame' | 'connection' = 'frame') {
  const root = scaffold()
  const clock = new VirtualClock()
  const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, clock })
  await daemon.start()
  const fetchDutyAgent = vi.fn(async () => ({ bundle: bundle() }))
  ;(daemon as any).cpClient = {
    organizationScope: () => scope,
    // Membership, not tenancy, is what makes duties enforced (daemon-groups.md §3).
    memberSet: () => (scope === 'frame' ? { setId: '9f11e5e7-0000-4000-8000-000000000001', name: 'Cloud' } : null),
    stop: async () => {},
    releaseDuties: vi.fn(async () => {}),
    // An admission reports its new digest immediately: the CP holds every projection that
    // ADDRESSES this member until it sees the group held, so waiting for the next tick would
    // leave an agent this member is already serving unroutable.
    reportDutiesNow: vi.fn(() => {}),
    fetchDutyAgent
  }
  await (daemon as any).dutyCoordinator.admitDutyGrants([grant()])
  return { daemon, root, clock, fetchDutyAgent }
}

/** A daemon with an admission held open at the `duty/fetch` round trip, so a withdrawal can land
 *  inside the window between grant receipt and `applyGrant` — the gap this guard exists for. */
async function bootMidAdmission() {
  const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold() })
  await daemon.start()
  let release!: () => void
  const fetched = new Promise<void>((resolve) => {
    release = resolve
  })
  const fetchDutyAgent = vi.fn(async () => {
    await fetched
    return { bundle: bundle() }
  })
  ;(daemon as any).cpClient = {
    organizationScope: () => 'frame',
    memberSet: () => ({ setId: '9f11e5e7-0000-4000-8000-000000000001', name: 'Cloud' }),
    stop: async () => {},
    releaseDuties: vi.fn(async () => {}),
    // An admission reports its new digest immediately: the CP holds every projection that
    // ADDRESSES this member until it sees the group held, so waiting for the next tick would
    // leave an agent this member is already serving unroutable.
    reportDutiesNow: vi.fn(() => {}),
    fetchDutyAgent
  }
  const admitted = (daemon as any).dutyCoordinator.admitDutyGrants([grant()]) as Promise<Set<string>>
  await vi.waitFor(() => expect(fetchDutyAgent).toHaveBeenCalled())
  return { daemon, admitted, release }
}

const duties = (d: Daemon) => (d as any).duties as DutyRegistry
const pending = (d: Daemon): string[] => (d as any).dutyCoordinator.pendingDutyAdmissions()
const served = (d: Daemon): string[] => (d as any).transportAgents().map((a: { id: string }) => a.id)
/** Fence the given groups, as the client's per-group deadline does when one elapses. */
const fence = (d: Daemon, groupIds: string[] = [GROUP]) => (d as any).dutyCoordinator.fenceDuties(groupIds)

/** Put a live Slack socket in the pool under the granted agent's own credentials, exactly as a
 *  successful `reconcileSlackConnections` would. Its key is what consolidation asks for while the
 *  duty is held — and what it must stop asking for once the fence closes the serving gate. */
function liveSlackSocket(
  d: Daemon,
  integrationId = INTEGRATION,
  creds = { botToken: 'xoxb-test', appToken: 'xapp-test' }
) {
  const conn = { ...creds, botUserId: `U-${integrationId.slice(-1)}`, stop: vi.fn(async () => {}) }
  ;(d as any).connections.slackPool.add(conn)
  ;(d as any).connByIntegration.set(integrationId, conn)
  ;(d as any).botUserIds[integrationId] = conn.botUserId
  return conn
}

const pooled = (d: Daemon): unknown[] => (d as any).connections.slackPool.all()

describe('the duty self-fence', () => {
  it('releases every held group and stops serving its agents, with no configuration asking for it', async () => {
    // The scaffold writes no `features` block: an install-wide (frame-scope) connection is the
    // whole condition, so a fresh pool member enforces the moment it registers.
    const { daemon } = await boot()
    expect(duties(daemon).digest()).toEqual([{ groupId: GROUP, term: '1' }])
    expect(served(daemon)).toContain(AGENT)
    expect((daemon as any).scheduler.count(AGENT)).toBe(1)
    // A live runtime for the fenced agent must go too — the successor is about to start one.
    const stop = vi.fn(async () => {})
    ;(daemon as any).hosts.set(AGENT, { stop })

    fence(daemon)
    await vi.waitFor(() => expect(stop).toHaveBeenCalled())

    // Nothing held ⇒ the next digest reports nothing, which is what makes the CP's
    // missing-regrant path the recovery path.
    expect(duties(daemon).digest()).toEqual([])
    expect(duties(daemon).agents().size).toBe(0)
    // The serving gate every platform consolidator derives from is closed.
    expect(served(daemon)).not.toContain(AGENT)
    // And the agent's schedules are disarmed — a cron is an ingress edge, so it fires
    // only at the holder.
    expect((daemon as any).scheduler.count(AGENT)).toBe(0)
    await daemon.stop()
  })

  it('interrupts the fenced agent turns as a handover, so their outcomes cannot read as a user stop', async () => {
    // The reason is load-bearing downstream: a GitHub review turn killed here reports it to the CP,
    // which turns it into the maintainer-facing Check. `stop` there is a lie about what happened.
    const { daemon } = await boot()
    const interrupt = vi.spyOn(daemon as any, 'interruptAgentTurns')

    fence(daemon)

    expect(interrupt).toHaveBeenCalledWith(AGENT, 'handover', 'handoff')
    await daemon.stop()
  })

  it('is a revoke, not a removal — workspace, agent registry, and sessions survive', async () => {
    const { daemon, root } = await boot()
    const store = (daemon as any).store
    await store.upsertSession({
      key: `slack:C1:T1:${AGENT}`,
      agentId: AGENT,
      platform: 'slack',
      channel: 'C1',
      thread: 'T1',
      acpSessionId: 'acp-1',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })
    expect(existsSync(join(root, 'agents', 'scout'))).toBe(true)

    fence(daemon)

    expect((daemon as any).cpAgents.has(AGENT)).toBe(true)
    expect((daemon as any).agentRemovalPending(AGENT)).toBe(false)
    expect(existsSync(join(root, 'agents', 'scout'))).toBe(true)
    // No session purge rides a fence: the duty moved, the history did not.
    expect(await store.listSessions(AGENT)).toHaveLength(1)
    expect(await store.getSession(`slack:C1:T1:${AGENT}`)).toBeDefined()
    await daemon.stop()
  })

  it('closes the platform connection the fenced agents were served over', async () => {
    // The physical half. `transportAgents` is the only ingress gate for a daemon-owned socket —
    // direct platform traffic is never re-checked per message — so a fence that empties a set but
    // leaves the socket up keeps delivering work a successor is already serving.
    const { daemon } = await boot()
    const conn = liveSlackSocket(daemon)
    expect(pooled(daemon)).toContain(conn)

    fence(daemon)

    await vi.waitFor(() => expect(conn.stop).toHaveBeenCalled())
    expect(pooled(daemon)).not.toContain(conn)
    expect((daemon as any).connByIntegration.has(INTEGRATION)).toBe(false)
    await daemon.stop()
  })

  it('closes it on a retry when the reconcile pass carrying the fence throws', async () => {
    // A reconcile has a dozen ways to throw before it reaches the platform layer (workspace
    // authority, host teardown, a platform close). If the request were consumed by that pass, the
    // fenced agent would keep its socket — and its direct ingress — indefinitely.
    const { daemon, clock } = await boot()
    const conn = liveSlackSocket(daemon)
    const realLoad = (daemon as any).loadAgentList.bind(daemon)
    let failures = 0
    ;(daemon as any).loadAgentList = (...args: unknown[]) => {
      if (failures++ < 1) throw new Error('reconcile blew up before the platform layer')
      return realLoad(...args)
    }

    fence(daemon)

    // The pass that carried the fence threw; the retry converges it anyway. Its one-second
    // backoff is elapsed on the injected clock, so what is asserted is that a retry HAPPENS —
    // never that a loaded runner got through the real ladder inside the test budget.
    await runVirtual(
      clock,
      vi.waitFor(() => expect(conn.stop).toHaveBeenCalled(), waitBudget(20_000, 5))
    )
    expect(failures).toBeGreaterThan(1) // the first pass really did throw
    expect(pooled(daemon)).not.toContain(conn)
    await daemon.stop()
  })

  it('fences one group and leaves the other serving, then fences that one at its own deadline', async () => {
    // The CP expires each lease on its own schedule, so a member sheds exactly what it can no
    // longer prove it holds. Tearing down the rest would drop live traffic the ledger still ours.
    const { daemon } = await boot()
    ;(daemon as any).cpClient.fetchDutyAgent = vi.fn(async () => ({
      bundle: bundle(AGENT_B, 'ranger', INTEGRATION_B, { botToken: 'xoxb-b', appToken: 'xapp-b' })
    }))
    await (daemon as any).dutyCoordinator.admitDutyGrants([grant(GROUP_B, AGENT_B)])
    expect(served(daemon).sort()).toEqual([AGENT, AGENT_B].sort())
    const socketA = liveSlackSocket(daemon)
    const socketB = liveSlackSocket(daemon, INTEGRATION_B, { botToken: 'xoxb-b', appToken: 'xapp-b' })

    fence(daemon, [GROUP])

    // A is shed…
    expect(duties(daemon).get(GROUP)).toBeUndefined()
    expect(served(daemon)).not.toContain(AGENT)
    await vi.waitFor(() => expect(socketA.stop).toHaveBeenCalled())
    // …and B keeps serving, socket and schedules intact.
    expect(duties(daemon).digest()).toEqual([{ groupId: GROUP_B, term: '1' }])
    expect(served(daemon)).toContain(AGENT_B)
    expect((daemon as any).scheduler.count(AGENT_B)).toBe(1)
    expect(socketB.stop).not.toHaveBeenCalled()
    expect(pooled(daemon)).toContain(socketB)

    fence(daemon, [GROUP_B])

    expect(duties(daemon).digest()).toEqual([])
    expect(served(daemon)).not.toContain(AGENT_B)
    await vi.waitFor(() => expect(socketB.stop).toHaveBeenCalled())
    await daemon.stop()
  })

  it('revokes every projected write fence in one multi-group self-fence', async () => {
    const { daemon } = await boot()
    ;(daemon as any).cpClient.fetchDutyAgent = vi.fn(async () => ({
      bundle: bundle(AGENT_B, 'ranger', INTEGRATION_B, { botToken: 'xoxb-b', appToken: 'xapp-b' })
    }))
    await (daemon as any).dutyCoordinator.admitDutyGrants([grant(GROUP_B, AGENT_B)])
    const revoke = vi.spyOn((daemon as any).store, 'revokeDutyWriteFence')

    await fence(daemon, [GROUP, GROUP_B])

    expect(revoke.mock.calls.map(([input]) => (input as { groupId: string }).groupId)).toEqual([GROUP, GROUP_B])
    expect(revoke.mock.calls.map(([input]) => (input as { term: string }).term)).toEqual(['1', '1'])
    await daemon.stop()
  })

  it('fencing a group leaves an agent that another held group also covers in service', async () => {
    // `applyRevoke` reports an agent as lost only when it is in NO held group any more, and the
    // teardown follows that, not the group membership — so a shared agent keeps serving.
    const { daemon } = await boot()
    await (daemon as any).dutyCoordinator.admitDutyGrants([grant(GROUP_B, AGENT)])
    expect(duties(daemon).digest()).toHaveLength(2)

    fence(daemon, [GROUP])

    expect(duties(daemon).digest()).toEqual([{ groupId: GROUP_B, term: '1' }])
    expect(served(daemon)).toContain(AGENT) // still covered by the group that did not expire
    expect((daemon as any).scheduler.count(AGENT)).toBe(1)
    await daemon.stop()
  })

  it('a fence landing mid-admission stops that admission from ever starting service', async () => {
    // Deadline tracking is synchronous, admission deliberately is not. Between grant receipt and
    // `applyGrant` the group is not held, so there is nothing for the fence to shed — and without
    // the withdrawal guard it would start serving the moment the admission completed.
    const { daemon, admitted, release } = await bootMidAdmission()
    expect(pending(daemon)).toEqual([GROUP])
    expect(duties(daemon).digest()).toEqual([]) // not held yet: the gap

    fence(daemon, [GROUP])
    release()

    expect([...(await admitted)]).toEqual([GROUP]) // refused
    expect(duties(daemon).digest()).toEqual([])
    expect(served(daemon)).not.toContain(AGENT)
    expect(pending(daemon)).toEqual([]) // and nothing left marked either
    await daemon.stop()
  })

  it('a revoke landing mid-admission refuses it the same way', async () => {
    const { daemon, admitted, release } = await bootMidAdmission()

    ;(daemon as any).dutyCoordinator.applyDutyRevoke([{ groupId: GROUP, reason: 'superseded' }])
    release()

    expect([...(await admitted)]).toEqual([GROUP])
    expect(duties(daemon).digest()).toEqual([])
    expect(served(daemon)).not.toContain(AGENT)
    await daemon.stop()
  })

  it('a drain release mid-admission refuses it, so nothing installs itself back after drain/done', async () => {
    const { daemon, admitted, release } = await bootMidAdmission()

    await (daemon as any).dutyCoordinator.releaseAllDuties()
    release()

    expect([...(await admitted)]).toEqual([GROUP])
    expect(duties(daemon).digest()).toEqual([])
    expect(served(daemon)).not.toContain(AGENT)
    await daemon.stop()
  })

  it('an admission no withdrawal touched still applies — the guard refuses nothing on its own', async () => {
    const { daemon, admitted, release } = await bootMidAdmission()

    release()

    expect([...(await admitted)]).toEqual([])
    expect(duties(daemon).digest()).toEqual([{ groupId: GROUP, term: '1' }])
    expect(served(daemon)).toContain(AGENT)
    expect(pending(daemon)).toEqual([])
    await daemon.stop()
  })

  it('does nothing on an org-scoped connection — that daemon owns its agents outright', async () => {
    // Duty is a tenancy question: an org-scoped daemon is not in the ledger, so its agents are
    // served whatever the registry happens to hold, and a fence there would drop live traffic.
    const { daemon } = await boot('connection')
    expect(served(daemon)).toContain(AGENT)

    fence(daemon)

    expect(duties(daemon).digest()).toEqual([{ groupId: GROUP, term: '1' }])
    expect(served(daemon)).toContain(AGENT)
    await daemon.stop()
  })

  it('a re-grant after a fence restores service without re-fetching the surviving agent', async () => {
    const { daemon, fetchDutyAgent } = await boot()
    expect(fetchDutyAgent).toHaveBeenCalledTimes(1)

    fence(daemon)
    expect(served(daemon)).not.toContain(AGENT)

    // What a reconnect looks like: the CP still leases the group to this member, sees a
    // digest that omits it, and reissues the grant.
    await (daemon as any).dutyCoordinator.admitDutyGrants([grant()])

    expect(duties(daemon).digest()).toEqual([{ groupId: GROUP, term: '1' }])
    expect(served(daemon)).toContain(AGENT)
    // The registry survived the fence, so the regrant installs nothing a second time.
    expect(fetchDutyAgent).toHaveBeenCalledTimes(1)
    await daemon.stop()
  })

  it('holding nothing makes the fence a no-op', async () => {
    const { daemon } = await boot()
    fence(daemon)
    const warn = vi.spyOn((daemon as any).log, 'warn')

    fence(daemon)

    expect(warn).not.toHaveBeenCalled()
    await daemon.stop()
  })
})
