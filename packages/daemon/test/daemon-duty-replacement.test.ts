// A duty grant REPLACES its group, so it carries removals as well as additions. These pin the half
// that is not optional when the install refuses the entry: the members the replacement dropped stop
// being served here anyway, because an addition is what failed and a removal never can.
import { describe, it, expect, vi } from 'vitest'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DutyGrantEntry } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import type { DutyRegistry } from '../src/cp/duty-registry.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

const AGENT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const AGENT_B = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
const AGENT_C = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'
const GROUP = '11111111-1111-4111-8111-111111111111'
const GROUP_B = '11111111-1111-4111-8111-111111111112'
const ORG = 'org-1'

const NAMES: Record<string, string> = { [AGENT_A]: 'scout', [AGENT_B]: 'ranger', [AGENT_C]: 'pilot' }
const INTEGRATION: Record<string, string> = {
  [AGENT_A]: '22222222-2222-4222-8222-222222222221',
  [AGENT_B]: '22222222-2222-4222-8222-222222222222',
  [AGENT_C]: '22222222-2222-4222-8222-222222222223'
}
const CRON: Record<string, string> = {
  [AGENT_A]: '33333333-3333-4333-8333-333333333331',
  [AGENT_B]: '33333333-3333-4333-8333-333333333332',
  [AGENT_C]: '33333333-3333-4333-8333-333333333333'
}

// No `features` block: the frame-scope stub connection below is the whole enforcement condition.
function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-duty-replacement-'))
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

const grant = (groupId: string, term: string, agents: string[]): DutyGrantEntry => ({
  groupId,
  orgId: ORG,
  term,
  members: agents.map((refId) => ({ kind: 'agent' as const, refId }))
})

const bundle = (agentId: string) => ({
  agentId,
  spec: {
    orgId: ORG,
    name: NAMES[agentId],
    runtime: 'claude',
    workspace: { mode: 'scratch' as const, isolation: 'shared' as const }
  },
  integrations: [
    {
      integrationId: INTEGRATION[agentId],
      agentId,
      orgId: ORG,
      platform: 'slack',
      core: { mode: 'direct' as const, bindRules: [], mutedChannels: [], gated: false },
      config: { botToken: `xoxb-${NAMES[agentId]}`, appToken: `xapp-${NAMES[agentId]}` }
    }
  ],
  crons: [
    {
      cronId: CRON[agentId],
      agentId,
      orgId: ORG,
      schedule: '0 9 * * *',
      timezone: 'UTC',
      trigger: 'standup',
      enabled: true
    }
  ]
})

/** A daemon holding GROUP at term 1 over agents A and C. `broken` is the set whose `duty/fetch`
 *  fails — the uninstallable addition a replacement carries. */
async function boot(broken = new Set<string>()) {
  const root = scaffold()
  const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root })
  await daemon.start()
  const fetchDutyAgent = vi.fn(async (agentId: string) => {
    if (broken.has(agentId)) throw new Error('control plane unreachable')
    return { bundle: bundle(agentId) }
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
  await (daemon as any).dutyCoordinator.admitDutyGrants([grant(GROUP, '1', [AGENT_A, AGENT_C])])
  return { daemon, root, broken, fetchDutyAgent }
}

const duties = (d: Daemon) => (d as any).duties as DutyRegistry
const served = (d: Daemon): string[] => (d as any).transportAgents().map((a: { id: string }) => a.id)
const schedules = (d: Daemon, agentId: string): number => (d as any).scheduler.count(agentId)
const admit = (d: Daemon, entries: DutyGrantEntry[]) =>
  (d as any).dutyCoordinator.admitDutyGrants(entries) as Promise<Set<string>>

/** Put a live Slack socket in the pool under this agent's own credentials, as a successful
 *  `reconcileSlackConnections` would — what consolidation must stop asking for once it is dropped. */
function liveSlackSocket(d: Daemon, agentId: string) {
  const integrationId = INTEGRATION[agentId]!
  const conn = {
    botToken: `xoxb-${NAMES[agentId]}`,
    appToken: `xapp-${NAMES[agentId]}`,
    botUserId: `U-${NAMES[agentId]}`,
    stop: vi.fn(async () => {})
  }
  ;(d as any).connections.slackPool.add(conn)
  ;(d as any).connByIntegration.set(integrationId, conn)
  ;(d as any).botUserIds[integrationId] = conn.botUserId
  return conn
}

const pooled = (d: Daemon): unknown[] => (d as any).connections.slackPool.all()

describe('a refused replacement still applies its removals', () => {
  it('drops the departed agent, keeps the group serving the rest, and stays at the old term', async () => {
    // The split this closes: A has been reassigned elsewhere, and B — the agent the replacement
    // ADDS — cannot be installed. Refusing the entry whole would leave A serviceable here while its
    // new holder serves it too.
    const { daemon } = await boot(new Set([AGENT_B]))
    expect(served(daemon).sort()).toEqual([AGENT_A, AGENT_C].sort())
    const socketA = liveSlackSocket(daemon, AGENT_A)
    const socketC = liveSlackSocket(daemon, AGENT_C)
    const stopA = vi.fn(async () => {})
    ;(daemon as any).hosts.set(AGENT_A, { stop: stopA })

    await expect(admit(daemon, [grant(GROUP, '2', [AGENT_C, AGENT_B])])).resolves.toEqual(new Set([GROUP]))

    // A is gone from the group and from service, physically as well as in the ledger.
    expect(duties(daemon).holdsAgent(AGENT_A)).toBe(false)
    expect(served(daemon)).not.toContain(AGENT_A)
    expect(schedules(daemon, AGENT_A)).toBe(0)
    await vi.waitFor(() => expect(stopA).toHaveBeenCalled())
    await vi.waitFor(() => expect(socketA.stop).toHaveBeenCalled())
    expect(pooled(daemon)).not.toContain(socketA)
    // C keeps serving: the removals are applied, the refusal is not escalated into a surrender.
    expect(duties(daemon).holdsAgent(AGENT_C)).toBe(true)
    expect(served(daemon)).toContain(AGENT_C)
    expect(schedules(daemon, AGENT_C)).toBe(1)
    expect(socketC.stop).not.toHaveBeenCalled()
    // B never made it in, so it is not served either.
    expect(duties(daemon).holdsAgent(AGENT_B)).toBe(false)
    // The OLD term is what the digest reports, so the CP sees a stale term and its stale-term
    // branch reissues the whole replacement on the next beat — the retry, at no headroom cost.
    expect(duties(daemon).digest()).toEqual([{ groupId: GROUP, term: '1' }])
    await daemon.stop()
  })

  it('is a revoke, not a removal — the dropped agent keeps workspace, registry entry, and sessions', async () => {
    const { daemon, root } = await boot(new Set([AGENT_B]))
    const store = (daemon as any).store
    await store.upsertSession({
      key: `slack:C1:T1:${AGENT_A}`,
      agentId: AGENT_A,
      platform: 'slack',
      channel: 'C1',
      thread: 'T1',
      acpSessionId: 'acp-1',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })

    await admit(daemon, [grant(GROUP, '2', [AGENT_C, AGENT_B])])

    expect((daemon as any).cpAgents.has(AGENT_A)).toBe(true)
    expect((daemon as any).agentRemovalPending(AGENT_A)).toBe(false)
    expect(existsSync(join(root, 'agents', NAMES[AGENT_A]!))).toBe(true)
    expect(await store.listSessions(AGENT_A)).toHaveLength(1)
    await daemon.stop()
  })

  it('leaves an agent another held group also covers in service', async () => {
    // The removal is per group; service is per agent. A second lease over the same agent is a
    // separate authority, and the refusal here says nothing about it.
    const { daemon } = await boot(new Set([AGENT_B]))
    await admit(daemon, [grant(GROUP_B, '1', [AGENT_A])])
    const stopA = vi.fn(async () => {})
    ;(daemon as any).hosts.set(AGENT_A, { stop: stopA })

    await admit(daemon, [grant(GROUP, '2', [AGENT_C, AGENT_B])])

    expect(duties(daemon).get(GROUP)?.agentIds).toEqual([AGENT_C])
    expect(duties(daemon).holdsAgent(AGENT_A)).toBe(true)
    expect(served(daemon)).toContain(AGENT_A)
    expect(schedules(daemon, AGENT_A)).toBe(1)
    // The teardown follows "in no held group any more", not group membership — a running host for
    // an agent the other lease still covers must not be torn down under it.
    expect(stopA).not.toHaveBeenCalled()
    await daemon.stop()
  })

  it('never resurrects a group this member does not hold', async () => {
    // Nothing to shrink: the group was never held, and a refusal must not make it appear.
    const { daemon } = await boot(new Set([AGENT_B]))

    await admit(daemon, [grant(GROUP_B, '1', [AGENT_B])])

    expect(duties(daemon).digest()).toEqual([{ groupId: GROUP, term: '1' }])
    expect(duties(daemon).get(GROUP_B)).toBeUndefined()
    await daemon.stop()
  })

  it('a withdrawal that lands mid-admission still wins — the group is not shrunk back into the ledger', async () => {
    // The #976 guard: a revoke inside the admission window means "do not serve this group at all",
    // which outranks the shrink. Applying a composition for it here would re-hold what was revoked.
    const { daemon } = await boot()
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    ;(daemon as any).cpClient.fetchDutyAgent = vi.fn(async () => {
      await blocked
      throw new Error('control plane unreachable')
    })
    const admitted = admit(daemon, [grant(GROUP, '2', [AGENT_C, AGENT_B])])
    await vi.waitFor(() => expect((daemon as any).dutyCoordinator.pendingDutyAdmissions()).toEqual([GROUP]))
    ;(daemon as any).dutyCoordinator.applyDutyRevoke([{ groupId: GROUP, reason: 'superseded' }])
    release()

    expect([...(await admitted)]).toEqual([GROUP])
    expect(duties(daemon).digest()).toEqual([])
    expect(served(daemon)).not.toContain(AGENT_A)
    expect(served(daemon)).not.toContain(AGENT_C)
    await daemon.stop()
  })

  it('a newer admission owns the group, so an older refusal never writes its stale removals', async () => {
    // The other half of the same guard, and the one a revoke cannot show: the group IS still held,
    // but by a later grant. Shrinking to the older entry's composition would drop a member the
    // newer authority just re-affirmed — an old grant overwriting a new one.
    const { daemon } = await boot()
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    ;(daemon as any).cpClient.fetchDutyAgent = vi.fn(async () => {
      await blocked
      throw new Error('control plane unreachable')
    })
    const stale = admit(daemon, [grant(GROUP, '2', [AGENT_C, AGENT_B])])
    await vi.waitFor(() => expect((daemon as any).dutyCoordinator.pendingDutyAdmissions()).toEqual([GROUP]))

    // The newer grant lands and completes first — both its agents are already installed.
    await admit(daemon, [grant(GROUP, '3', [AGENT_A, AGENT_C])])
    release()

    expect([...(await stale)]).toEqual([GROUP])
    expect(duties(daemon).digest()).toEqual([{ groupId: GROUP, term: '3' }])
    expect(duties(daemon).get(GROUP)?.agentIds.sort()).toEqual([AGENT_A, AGENT_C].sort())
    expect(served(daemon)).toContain(AGENT_A)
    await daemon.stop()
  })
})

describe('a replacement that installs cleanly is unaffected', () => {
  it('takes the new term and the new composition, and stops serving what it dropped', async () => {
    const { daemon } = await boot()
    const stopA = vi.fn(async () => {})
    ;(daemon as any).hosts.set(AGENT_A, { stop: stopA })

    await expect(admit(daemon, [grant(GROUP, '2', [AGENT_C, AGENT_B])])).resolves.toEqual(new Set())

    expect(duties(daemon).digest()).toEqual([{ groupId: GROUP, term: '2' }])
    expect(served(daemon).sort()).toEqual([AGENT_B, AGENT_C].sort())
    expect(served(daemon)).not.toContain(AGENT_A)
    expect(schedules(daemon, AGENT_A)).toBe(0)
    await vi.waitFor(() => expect(stopA).toHaveBeenCalled())
    await daemon.stop()
  })

  it('a re-grant at a new term with the same composition changes nothing it serves', async () => {
    const { daemon, fetchDutyAgent } = await boot()

    await admit(daemon, [grant(GROUP, '2', [AGENT_A, AGENT_C])])

    expect(duties(daemon).digest()).toEqual([{ groupId: GROUP, term: '2' }])
    expect(served(daemon).sort()).toEqual([AGENT_A, AGENT_C].sort())
    expect(fetchDutyAgent).toHaveBeenCalledTimes(2) // the initial pair, and nothing re-fetched
    await daemon.stop()
  })
})
