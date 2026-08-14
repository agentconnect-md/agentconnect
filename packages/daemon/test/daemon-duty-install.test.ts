// A duty grant only opens the SERVING gate; installation is the member's own
// pull (`duty/fetch`). These pin that pull: what it installs, what it refuses to
// resurrect, what it never re-fetches, and — the load-bearing one — that the
// rendezvous claim does not answer `granted` until the agent is actually there.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DutyGrantEntry } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import type { DutyRegistry } from '../src/cp/duty-registry.js'

const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const GROUP = '11111111-1111-4111-8111-111111111111'
const INTEGRATION = '22222222-2222-4222-8222-222222222222'
const CRON = '33333333-3333-4333-8333-333333333333'
const ORG = 'org-1'

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-duty-install-'))
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

const grant = (agents: string[] = [AGENT]): DutyGrantEntry => ({
  groupId: GROUP,
  orgId: ORG,
  term: '1',
  members: agents.map((refId) => ({ kind: 'agent' as const, refId }))
})

/** A grant that states what the CP currently holds for the agent — the freshness signal. */
const grantAt = (configRevision: string): DutyGrantEntry => ({
  ...grant(),
  members: [{ kind: 'agent', refId: AGENT, configRevision }]
})

const bundle = (configRevision?: string) => ({
  agentId: AGENT,
  spec: {
    orgId: ORG,
    name: 'scout',
    runtime: 'claude',
    ...(configRevision !== undefined ? { configRevision } : {}),
    workspace: { mode: 'scratch' as const, isolation: 'shared' as const }
  },
  integrations: [
    {
      integrationId: INTEGRATION,
      agentId: AGENT,
      orgId: ORG,
      platform: 'slack',
      core: { mode: 'direct' as const, bindRules: [], mutedChannels: [], gated: false },
      config: { botToken: 'xoxb-test', appToken: 'xapp-test' }
    }
  ],
  crons: [
    {
      cronId: CRON,
      agentId: AGENT,
      orgId: ORG,
      schedule: '0 9 * * *',
      timezone: 'UTC',
      trigger: 'standup',
      enabled: true
    }
  ]
})

/** A daemon started with a stub CP client — only the duty surface is exercised. */
async function boot(client: Record<string, unknown>) {
  const daemon = new Daemon({ root: scaffold() })
  await daemon.start()
  ;(daemon as any).cpClient = {
    organizationScope: () => 'frame',
    stop: async () => {},
    releaseDuties: vi.fn(async () => {}),
    ...client
  }
  return daemon
}

const registries = (d: Daemon) => ({
  agents: (d as any).cpAgents,
  integrations: (d as any).cpIntegrations,
  crons: (d as any).cpCrons
})

const duties = (d: Daemon) => (d as any).duties as DutyRegistry

/** Shift only the daemon's `now()`, leaving its real timers alone — enough to
 *  step past the per-agent install retry window. */
function shiftClock(d: Daemon): (ms: number) => void {
  const real = (d as any).clock
  let offset = 0
  ;(d as any).clock = {
    now: () => real.now() + offset,
    setTimeout: (fn: () => void, ms: number) => real.setTimeout(fn, ms),
    clearTimeout: (h: unknown) => real.clearTimeout(h)
  }
  return (ms: number) => {
    offset += ms
  }
}

describe('installing an agent a duty grant covers', () => {
  it('pulls and installs spec + integrations + crons for an agent this daemon lacks', async () => {
    const fetchDutyAgent = vi.fn(async () => ({ bundle: bundle() }))
    const daemon = await boot({ fetchDutyAgent })
    const cp = registries(daemon)
    expect(cp.agents.has(AGENT)).toBe(false)

    await (daemon as any).installGrantedAgents([grant()])

    expect(fetchDutyAgent).toHaveBeenCalledWith(AGENT, ORG)
    expect(cp.agents.has(AGENT)).toBe(true)
    expect(cp.integrations.forAgent(AGENT).map((i: { id: string }) => i.id)).toEqual([INTEGRATION])
    expect(cp.crons.forAgent(AGENT).map((c: { id: string }) => c.id)).toEqual([CRON])
    await daemon.stop()
  })

  it('never re-fetches an agent it already has', async () => {
    const fetchDutyAgent = vi.fn(async () => ({ bundle: bundle() }))
    const daemon = await boot({ fetchDutyAgent })

    await (daemon as any).installGrantedAgents([grant()])
    await (daemon as any).installGrantedAgents([grant()])

    expect(fetchDutyAgent).toHaveBeenCalledTimes(1)
    await daemon.stop()
  })

  it('REFETCHES an agent it already has when the grant names a newer revision', async () => {
    // The stale-bundle case: this member installed the agent under a duty, lost
    // that duty (which is not a removal — #948 — so the replica survived), the CP
    // went on editing a spec this member was no longer a delivery target for, and
    // now the duty comes back. Presence alone would serve the frozen bundle forever.
    const fetchDutyAgent = vi.fn(async () => ({ bundle: bundle('7') }))
    const daemon = await boot({ fetchDutyAgent })
    const cp = registries(daemon)

    cp.agents.upsert(AGENT, { ...bundle('3').spec })
    expect(cp.agents.appliedRevision(AGENT)).toBe(3n)

    await (daemon as any).installGrantedAgents([grantAt('7')])

    expect(fetchDutyAgent).toHaveBeenCalledWith(AGENT, ORG)
    expect(cp.agents.appliedRevision(AGENT)).toBe(7n)
    await daemon.stop()
  })

  it('does NOT refetch when the grant names the revision it already applied', async () => {
    const fetchDutyAgent = vi.fn(async () => ({ bundle: bundle('7') }))
    const daemon = await boot({ fetchDutyAgent })
    const cp = registries(daemon)

    cp.agents.upsert(AGENT, { ...bundle('7').spec })

    await (daemon as any).installGrantedAgents([grantAt('7')])

    // The common path stays free: a regrant of a current replica costs no round trip.
    expect(fetchDutyAgent).not.toHaveBeenCalled()
    await daemon.stop()
  })

  it('a grant naming an OLDER revision than the applied one costs no round trip', async () => {
    // Directional, like the fence itself: only "the CP has moved on" is a reason to
    // pull. A lagging grant would be refused by the revision fence anyway, so
    // fetching it would only burn a round trip on a bundle we must not apply.
    const fetchDutyAgent = vi.fn(async () => ({ bundle: bundle('3') }))
    const daemon = await boot({ fetchDutyAgent })
    registries(daemon).agents.upsert(AGENT, { ...bundle('7').spec })

    await (daemon as any).installGrantedAgents([grantAt('3')])

    expect(fetchDutyAgent).not.toHaveBeenCalled()
    await daemon.stop()
  })

  it('a refetched bundle goes through the same withdrawal guard as any other admission', async () => {
    // Load-bearing: a refetch is an admission like any other, so a revoke landing
    // mid-flight must stop it — otherwise the refresh path is a hole in the guard.
    let releaseFetch!: () => void
    const fetched = new Promise<void>((resolve) => {
      releaseFetch = resolve
    })
    const fetchDutyAgent = vi.fn(async () => {
      await fetched
      return { bundle: bundle('7') }
    })
    const daemon = await boot({ fetchDutyAgent })
    registries(daemon).agents.upsert(AGENT, { ...bundle('3').spec })

    const admission = (daemon as any).admitDutyGrants([grantAt('7')])
    await vi.waitFor(() => expect(fetchDutyAgent).toHaveBeenCalled())
    ;(daemon as any).applyDutyRevoke([{ groupId: GROUP, reason: 'gone' }])
    releaseFetch()

    await expect(admission).resolves.toEqual(new Set([GROUP]))
    expect(duties(daemon).digest()).toEqual([])
    await daemon.stop()
  })

  it('skips an agent a move is staging — a grant must not resurrect it', async () => {
    const fetchDutyAgent = vi.fn(async () => ({ bundle: bundle() }))
    const daemon = await boot({ fetchDutyAgent })
    ;(daemon as any).moveStagedAgents.add(AGENT)

    await (daemon as any).installGrantedAgents([grant()])

    expect(fetchDutyAgent).not.toHaveBeenCalled()
    expect(registries(daemon).agents.has(AGENT)).toBe(false)
    await daemon.stop()
  })

  it('skips an agent that is pending removal', async () => {
    const fetchDutyAgent = vi.fn(async () => ({ bundle: bundle() }))
    const daemon = await boot({ fetchDutyAgent })
    vi.spyOn(daemon as any, 'agentRemovalPending').mockReturnValue(true)

    await (daemon as any).installGrantedAgents([grant()])

    expect(fetchDutyAgent).not.toHaveBeenCalled()
    await daemon.stop()
  })

  it('a failed fetch is reported as a refused group, never thrown into frame dispatch', async () => {
    const daemon = await boot({
      fetchDutyAgent: vi.fn(async () => {
        throw new Error('control plane unreachable')
      })
    })

    await expect((daemon as any).installGrantedAgents([grant()])).resolves.toEqual(new Set([GROUP]))
    expect(registries(daemon).agents.has(AGENT)).toBe(false)
    await daemon.stop()
  })
})

describe('a group is not held until it is servable', () => {
  it('the grant is invisible in the digest for the whole install round trip', async () => {
    let releaseFetch!: () => void
    const fetched = new Promise<void>((resolve) => {
      releaseFetch = resolve
    })
    const fetchDutyAgent = vi.fn(async () => {
      await fetched
      return { bundle: bundle() }
    })
    const daemon = await boot({ fetchDutyAgent })

    // The EVT entry point, exactly as ConfigApply calls it — returns immediately.
    ;(daemon as any).applyDutyGrant([grant()])
    await vi.waitFor(() => expect(fetchDutyAgent).toHaveBeenCalled())

    // Load-bearing: this is the routing window. A digest that already advertised
    // the group would make the CP and the relay resolve triggers to this member
    // while the agent is still absent — and they could not even re-route, because
    // the holder they resolve to IS this member.
    expect(duties(daemon).digest()).toEqual([])
    expect(duties(daemon).holdsAgent(AGENT)).toBe(false)

    releaseFetch()
    await vi.waitFor(() => expect(duties(daemon).digest()).toEqual([{ groupId: GROUP, term: '1' }]))
    expect(registries(daemon).agents.has(AGENT)).toBe(true)
    await daemon.stop()
  })

  it('a failed fetch never applies the grant at all', async () => {
    const daemon = await boot({
      fetchDutyAgent: vi.fn(async () => {
        throw new Error('control plane unreachable')
      })
    })

    await (daemon as any).admitDutyGrants([grant()])

    // Not held ⇒ absent from the digest ⇒ the CP sees a lease this member does
    // not report and reissues it through its missing-regrant path. Holding it
    // would wedge the agent absent forever, because the lease exchange has
    // nothing to say about a group whose term the member already reports.
    expect(duties(daemon).digest()).toEqual([])
    expect(duties(daemon).holdsAgent(AGENT)).toBe(false)
    expect(registries(daemon).agents.has(AGENT)).toBe(false)
    await daemon.stop()
  })

  it('an EMPTY reply refuses the group — the CP is saying we do not hold it', async () => {
    const daemon = await boot({ fetchDutyAgent: vi.fn(async () => ({})) })

    await expect((daemon as any).admitDutyGrants([grant()])).resolves.toEqual(new Set([GROUP]))

    expect(duties(daemon).digest()).toEqual([])
    expect(registries(daemon).agents.has(AGENT)).toBe(false)
    await daemon.stop()
  })

  it('an APPLY failure refuses the group too — not just a failed fetch', async () => {
    const daemon = await boot({ fetchDutyAgent: vi.fn(async () => ({ bundle: bundle() })) })
    vi.spyOn(registries(daemon).agents, 'upsert').mockImplementation(() => {
      throw new Error('agent root is not writable')
    })

    await (daemon as any).admitDutyGrants([grant()])

    expect(duties(daemon).digest()).toEqual([])
    expect(registries(daemon).agents.has(AGENT)).toBe(false)
    await daemon.stop()
  })

  it('a group covering several agents is refused whole when one of them fails', async () => {
    const other = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
    const daemon = await boot({
      fetchDutyAgent: vi.fn(async (agentId: string) =>
        agentId === AGENT ? { bundle: bundle() } : Promise.reject(new Error('gone'))
      )
    })

    await (daemon as any).admitDutyGrants([grant([AGENT, other])])

    expect(duties(daemon).digest()).toEqual([])
    await daemon.stop()
  })

  it('a regrant retries the install and takes the group, once the retry window has passed', async () => {
    let broken = true
    const fetchDutyAgent = vi.fn(async () => {
      if (broken) throw new Error('control plane unreachable')
      return { bundle: bundle() }
    })
    const daemon = await boot({ fetchDutyAgent })
    const advance = shiftClock(daemon)

    await (daemon as any).admitDutyGrants([grant()])
    expect(duties(daemon).digest()).toEqual([])

    // Inside the retry window a regrant is refused again WITHOUT another fetch —
    // a permanently failing agent cannot outpace the beat that regrants it.
    broken = false
    await (daemon as any).admitDutyGrants([grant()])
    expect(fetchDutyAgent).toHaveBeenCalledTimes(1)
    expect(duties(daemon).digest()).toEqual([])

    advance(20_000)
    await (daemon as any).admitDutyGrants([grant()])

    expect(fetchDutyAgent).toHaveBeenCalledTimes(2)
    expect(duties(daemon).digest()).toEqual([{ groupId: GROUP, term: '1' }])
    expect(registries(daemon).agents.has(AGENT)).toBe(true)
    await daemon.stop()
  })

  it('a re-grant for an agent already installed is applied with no fetch at all', async () => {
    const fetchDutyAgent = vi.fn(async () => ({ bundle: bundle() }))
    const daemon = await boot({ fetchDutyAgent })

    await (daemon as any).admitDutyGrants([grant()])
    await (daemon as any).admitDutyGrants([{ ...grant(), term: '2' }])

    // The common path is unchanged: only a genuinely new agent waits.
    expect(fetchDutyAgent).toHaveBeenCalledTimes(1)
    expect(duties(daemon).digest()).toEqual([{ groupId: GROUP, term: '2' }])
    await daemon.stop()
  })
})

describe('the rendezvous claim ordering', () => {
  it('resolves granted only AFTER the granted agent is installed', async () => {
    let releaseFetch!: () => void
    const fetched = new Promise<void>((resolve) => {
      releaseFetch = resolve
    })
    const fetchDutyAgent = vi.fn(async () => {
      await fetched
      return { bundle: bundle() }
    })
    const daemon = await boot({
      claimDuty: vi.fn(async () => ({ granted: true, grant: grant() })),
      fetchDutyAgent
    })
    const cp = registries(daemon)

    let settled = false
    const claim = (daemon as any).claimDutyForTrigger(AGENT).then((result: unknown) => {
      settled = true
      return result
    })
    await vi.waitFor(() => expect(fetchDutyAgent).toHaveBeenCalled())

    // The CP has leased the group, but this member neither serves nor advertises
    // it yet — answering `granted` here is exactly the bug this pull closes.
    expect(cp.agents.has(AGENT)).toBe(false)
    expect(duties(daemon).digest()).toEqual([])
    expect(settled).toBe(false)

    releaseFetch()
    await expect(claim).resolves.toEqual({ granted: true })
    expect(cp.agents.has(AGENT)).toBe(true)
    expect(duties(daemon).holdsAgent(AGENT)).toBe(true)
    await daemon.stop()
  })

  it('answers granted:false when the install failed, and holds nothing afterwards', async () => {
    const daemon = await boot({
      claimDuty: vi.fn(async () => ({ granted: true, grant: grant() })),
      fetchDutyAgent: vi.fn(async () => {
        throw new Error('control plane unreachable')
      })
    })

    await expect((daemon as any).claimDutyForTrigger(AGENT)).resolves.toEqual({ granted: false })

    // The grant was never applied, so the answer and the local state agree:
    // saying "not me" while still holding the lease is the split brain this
    // mechanism exists to avoid.
    expect(duties(daemon).digest()).toEqual([])
    expect(duties(daemon).holdsAgent(AGENT)).toBe(false)
    expect(registries(daemon).agents.has(AGENT)).toBe(false)
    await daemon.stop()
  })

  it('answers granted:false on an empty reply, without ever holding the group', async () => {
    const daemon = await boot({
      claimDuty: vi.fn(async () => ({ granted: true, grant: grant() })),
      fetchDutyAgent: vi.fn(async () => ({}))
    })

    await expect((daemon as any).claimDutyForTrigger(AGENT)).resolves.toEqual({ granted: false })

    expect(duties(daemon).digest()).toEqual([])
    expect(registries(daemon).agents.has(AGENT)).toBe(false)
    await daemon.stop()
  })
})
