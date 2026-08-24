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
import type { SlackAppFactory } from '../src/slack/connection.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const GROUP = '11111111-1111-4111-8111-111111111111'
const INTEGRATION = '22222222-2222-4222-8222-222222222222'
const CRON = '33333333-3333-4333-8333-333333333333'
const CONNECTION = '44444444-4444-4444-8444-444444444444'
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

/** One proxy def, as the CP projects it: the grant's issuance instant is the
 *  ordering marker, and the key it orders comes from the same grant. */
const proxyDef = (key = 'oct_docs', issuedAt = 2_000) => ({
  orgId: ORG,
  name: 'docs',
  issuedAt,
  transport: 'http' as const,
  url: 'https://relay.example.test/mcp/p1',
  args: [],
  env: [],
  headers: [{ name: 'Authorization', value: `Bearer ${key}` }]
})

/** The bearer the daemon would hand a session for `docs`, or undefined. */
const bearerOf = (d: Daemon): string | undefined =>
  ((d as any).cpMcpDefs.effective(ORG).docs?.headers as Array<{ name: string; value: string }> | undefined)?.[0]?.value

/** The same bundle plus the two definition kinds the spec only NAMES. */
const bundleWithDefinitions = (grantKey?: string, issuedAt?: number) => ({
  ...bundle(),
  spec: { ...bundle().spec, mcpServers: ['docs'], memory: { provider: 'external' as const, connectionId: CONNECTION } },
  mcpServers: [proxyDef(grantKey, issuedAt)],
  memoryConnections: [
    {
      connectionId: CONNECTION,
      orgId: ORG,
      revision: 1,
      transport: 'stdio' as const,
      commandRef: 'operator-mem0',
      config: {},
      secretKeys: [],
      secretLease: { values: {} },
      pin: { pluginId: 'ai.example.memory', profileMajor: 1 as const, secretHeaders: [] }
    }
  ]
})

/** A daemon started with a stub CP client — only the duty surface is exercised. */
async function boot(client: Record<string, unknown>, slackAppFactory: SlackAppFactory = fakeSlackAppFactory()) {
  const daemon = new Daemon({ slackAppFactory, root: scaffold() })
  await daemon.start()
  ;(daemon as any).cpClient = {
    organizationScope: () => 'frame',
    memberSet: () => ({ setId: '9f11e5e7-0000-4000-8000-000000000001', name: 'Cloud' }),
    stop: async () => {},
    releaseDuties: vi.fn(async () => {}),
    // An admission reports its new digest immediately: the CP holds every projection that
    // ADDRESSES this member until it sees the group held, so waiting for the next tick would
    // leave an agent this member is already serving unroutable.
    reportDutiesNow: vi.fn(() => {}),
    // The memory registry reports body-free probe facts as soon as a definition lands.
    emitMemoryConnectionFacts: vi.fn(() => {}),
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

    await (daemon as any).dutyCoordinator.installGrantedAgents([grant()])

    expect(fetchDutyAgent).toHaveBeenCalledWith(AGENT, ORG)
    expect(cp.agents.has(AGENT)).toBe(true)
    expect(cp.integrations.forAgent(AGENT).map((i: { id: string }) => i.id)).toEqual([INTEGRATION])
    expect(cp.crons.forAgent(AGENT).map((c: { id: string }) => c.id)).toEqual([CRON])
    await daemon.stop()
  })

  /**
   * An AgentSpec only NAMES its MCP servers and its memory connection; both
   * definitions arrive separately on placement-keyed paths (#979). A holder that
   * is not the placement installed neither, so the agent came up with tools it
   * could not resolve and a memory backend it had no entry for — silently.
   */
  it('installs the MCP defs the spec names and the memory connection it binds', async () => {
    const fetchDutyAgent = vi.fn(async () => ({ bundle: bundleWithDefinitions() }))
    const daemon = await boot({ fetchDutyAgent })

    await (daemon as any).dutyCoordinator.installGrantedAgents([grant()])

    // The proxy def is keyed (org, name) and must carry the bearer grant key —
    // presence of the NAME alone is exactly the broken state this fixes.
    const effective = (daemon as any).cpMcpDefs.effective(ORG)
    expect(effective.docs).toMatchObject({
      transport: 'http',
      url: 'https://relay.example.test/mcp/p1',
      headers: [{ name: 'Authorization', value: 'Bearer oct_docs' }]
    })
    expect((daemon as any).memoryConnections.connectionIds()).toEqual([CONNECTION])
    await daemon.stop()
  })

  /**
   * MCP grant rotation keeps the retiring and the fresh grant BOTH active until
   * the fresh one is distributed, so a bundle projected inside that window carries
   * a key the relay is about to revoke. The bundle apply is fenced by the grant's
   * issuance instant exactly as the live push is, so the holder ends up on the
   * fresh key under EITHER interleaving.
   */
  it('a bundle projected before a rotation cannot undo the fresh key it raced', async () => {
    let releaseFetch!: () => void
    const projected = new Promise<void>((resolve) => (releaseFetch = resolve))
    const fetchDutyAgent = vi.fn(async () => {
      await projected
      return { bundle: bundleWithDefinitions('oct_retiring', 1_000) }
    })
    const daemon = await boot({ fetchDutyAgent })
    const install = (daemon as any).dutyCoordinator.installGrantedAgents([grant()])

    // The rotation's live push lands first, through the real frame handler.
    ;(daemon as any).cpConfigApply().applyMcpServerUpsert(proxyDef('oct_fresh', 2_000))
    expect(bearerOf(daemon)).toBe('Bearer oct_fresh')

    releaseFetch()
    await install

    expect(bearerOf(daemon)).toBe('Bearer oct_fresh')
    await daemon.stop()
  })

  it('the other interleaving converges too — the fresh push overtakes an applied bundle', async () => {
    const fetchDutyAgent = vi.fn(async () => ({ bundle: bundleWithDefinitions('oct_retiring', 1_000) }))
    const daemon = await boot({ fetchDutyAgent })

    await (daemon as any).dutyCoordinator.installGrantedAgents([grant()])
    expect(bearerOf(daemon)).toBe('Bearer oct_retiring')
    ;(daemon as any).cpConfigApply().applyMcpServerUpsert(proxyDef('oct_fresh', 2_000))

    expect(bearerOf(daemon)).toBe('Bearer oct_fresh')
    await daemon.stop()
  })

  it('the ordering marker never reaches the runtime definition', async () => {
    const fetchDutyAgent = vi.fn(async () => ({ bundle: bundleWithDefinitions() }))
    const daemon = await boot({ fetchDutyAgent })

    await (daemon as any).dutyCoordinator.installGrantedAgents([grant()])

    expect(JSON.stringify((daemon as any).cpMcpDefs.effective(ORG))).not.toContain('issuedAt')
    await daemon.stop()
  })

  it('a bundle from an older CP carrying neither definition array still installs', async () => {
    const fetchDutyAgent = vi.fn(async () => ({ bundle: bundle() }))
    const daemon = await boot({ fetchDutyAgent })

    await (daemon as any).dutyCoordinator.installGrantedAgents([grant()])

    expect(registries(daemon).agents.has(AGENT)).toBe(true)
    expect((daemon as any).memoryConnections.connectionIds()).toEqual([])
    await daemon.stop()
  })

  it('the definitions land BEFORE the spec that references them', async () => {
    const fetchDutyAgent = vi.fn(async () => ({ bundle: bundleWithDefinitions() }))
    const daemon = await boot({ fetchDutyAgent })
    const order: string[] = []
    const registry = (daemon as any).memoryConnections
    const realUpsert = registry.upsert.bind(registry)
    registry.upsert = (spec: unknown) => {
      order.push('memory')
      return realUpsert(spec)
    }
    const agents = registries(daemon).agents
    const realAgentUpsert = agents.upsert.bind(agents)
    agents.upsert = (id: string, spec: unknown) => {
      order.push('agent')
      return realAgentUpsert(id, spec)
    }

    await (daemon as any).dutyCoordinator.installGrantedAgents([grant()])

    // Registry-before-agent: static memory admission must never see the agent
    // before at least a probing (fail-closed) connection entry exists.
    expect(order).toEqual(['memory', 'agent'])
    await daemon.stop()
  })

  it('never re-fetches an agent it already has', async () => {
    const fetchDutyAgent = vi.fn(async () => ({ bundle: bundle() }))
    const daemon = await boot({ fetchDutyAgent })

    await (daemon as any).dutyCoordinator.installGrantedAgents([grant()])
    await (daemon as any).dutyCoordinator.installGrantedAgents([grant()])

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

    await (daemon as any).dutyCoordinator.installGrantedAgents([grantAt('7')])

    expect(fetchDutyAgent).toHaveBeenCalledWith(AGENT, ORG)
    expect(cp.agents.appliedRevision(AGENT)).toBe(7n)
    await daemon.stop()
  })

  it('does NOT refetch when the grant names the revision it already applied', async () => {
    const fetchDutyAgent = vi.fn(async () => ({ bundle: bundle('7') }))
    const daemon = await boot({ fetchDutyAgent })
    const cp = registries(daemon)

    cp.agents.upsert(AGENT, { ...bundle('7').spec })

    await (daemon as any).dutyCoordinator.installGrantedAgents([grantAt('7')])

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

    await (daemon as any).dutyCoordinator.installGrantedAgents([grantAt('3')])

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

    const admission = (daemon as any).dutyCoordinator.admitDutyGrants([grantAt('7')])
    await vi.waitFor(() => expect(fetchDutyAgent).toHaveBeenCalled())
    ;(daemon as any).dutyCoordinator.applyDutyRevoke([{ groupId: GROUP, reason: 'gone' }])
    releaseFetch()

    await expect(admission).resolves.toEqual(new Set([GROUP]))
    expect(duties(daemon).digest()).toEqual([])
    await daemon.stop()
  })

  it('skips an agent a move is staging — a grant must not resurrect it', async () => {
    const fetchDutyAgent = vi.fn(async () => ({ bundle: bundle() }))
    const daemon = await boot({ fetchDutyAgent })
    ;(daemon as any).moveStagedAgents.add(AGENT)

    await (daemon as any).dutyCoordinator.installGrantedAgents([grant()])

    expect(fetchDutyAgent).not.toHaveBeenCalled()
    expect(registries(daemon).agents.has(AGENT)).toBe(false)
    await daemon.stop()
  })

  it('skips an agent that is pending removal', async () => {
    const fetchDutyAgent = vi.fn(async () => ({ bundle: bundle() }))
    const daemon = await boot({ fetchDutyAgent })
    vi.spyOn(daemon as any, 'agentRemovalPending').mockReturnValue(true)

    await (daemon as any).dutyCoordinator.installGrantedAgents([grant()])

    expect(fetchDutyAgent).not.toHaveBeenCalled()
    await daemon.stop()
  })

  it('a failed fetch is reported as a refused group, never thrown into frame dispatch', async () => {
    const daemon = await boot({
      fetchDutyAgent: vi.fn(async () => {
        throw new Error('control plane unreachable')
      })
    })

    await expect((daemon as any).dutyCoordinator.installGrantedAgents([grant()])).resolves.toEqual(new Set([GROUP]))
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
    ;(daemon as any).dutyCoordinator.applyDutyGrant([grant()])
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

    await (daemon as any).dutyCoordinator.admitDutyGrants([grant()])

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

    await expect((daemon as any).dutyCoordinator.admitDutyGrants([grant()])).resolves.toEqual(new Set([GROUP]))

    expect(duties(daemon).digest()).toEqual([])
    expect(registries(daemon).agents.has(AGENT)).toBe(false)
    await daemon.stop()
  })

  it('an APPLY failure refuses the group too — not just a failed fetch', async () => {
    const daemon = await boot({ fetchDutyAgent: vi.fn(async () => ({ bundle: bundle() })) })
    vi.spyOn(registries(daemon).agents, 'upsert').mockImplementation(() => {
      throw new Error('agent root is not writable')
    })

    await (daemon as any).dutyCoordinator.admitDutyGrants([grant()])

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

    await (daemon as any).dutyCoordinator.admitDutyGrants([grant([AGENT, other])])

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

    await (daemon as any).dutyCoordinator.admitDutyGrants([grant()])
    expect(duties(daemon).digest()).toEqual([])

    // Inside the retry window a regrant is refused again WITHOUT another fetch —
    // a permanently failing agent cannot outpace the beat that regrants it.
    broken = false
    await (daemon as any).dutyCoordinator.admitDutyGrants([grant()])
    expect(fetchDutyAgent).toHaveBeenCalledTimes(1)
    expect(duties(daemon).digest()).toEqual([])

    advance(20_000)
    await (daemon as any).dutyCoordinator.admitDutyGrants([grant()])

    expect(fetchDutyAgent).toHaveBeenCalledTimes(2)
    expect(duties(daemon).digest()).toEqual([{ groupId: GROUP, term: '1' }])
    expect(registries(daemon).agents.has(AGENT)).toBe(true)
    await daemon.stop()
  })

  it('a re-grant for an agent already installed is applied with no fetch at all', async () => {
    const fetchDutyAgent = vi.fn(async () => ({ bundle: bundle() }))
    const daemon = await boot({ fetchDutyAgent })

    await (daemon as any).dutyCoordinator.admitDutyGrants([grant()])
    await (daemon as any).dutyCoordinator.admitDutyGrants([{ ...grant(), term: '2' }])

    // The common path is unchanged: only a genuinely new agent waits.
    expect(fetchDutyAgent).toHaveBeenCalledTimes(1)
    expect(duties(daemon).digest()).toEqual([{ groupId: GROUP, term: '2' }])
    await daemon.stop()
  })
})

describe('the rendezvous claim ordering', () => {
  it('resolves granted only AFTER the granted agent is installed and connected', async () => {
    let releaseFetch!: () => void
    const fetched = new Promise<void>((resolve) => {
      releaseFetch = resolve
    })
    let releaseSlack!: () => void
    const slackReady = new Promise<void>((resolve) => {
      releaseSlack = resolve
    })
    const baseSlackAppFactory = fakeSlackAppFactory()
    const startSlack = vi.fn(async () => slackReady)
    const slackAppFactory: SlackAppFactory = (opts) => ({ ...baseSlackAppFactory(opts), start: startSlack })
    const fetchDutyAgent = vi.fn(async () => {
      await fetched
      return { bundle: bundle() }
    })
    const daemon = await boot(
      {
        claimDuty: vi.fn(async () => ({ granted: true, grant: grant() })),
        fetchDutyAgent
      },
      slackAppFactory
    )
    const cp = registries(daemon)

    let settled = false
    const claim = (daemon as any).dutyCoordinator.claimDutyForTrigger(AGENT).then((result: unknown) => {
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
    await vi.waitFor(() => expect(startSlack).toHaveBeenCalled())
    expect(cp.agents.has(AGENT)).toBe(true)
    expect(duties(daemon).holdsAgent(AGENT)).toBe(true)
    expect(settled).toBe(false)

    releaseSlack()
    await expect(claim).resolves.toEqual({ granted: true })
    await daemon.stop()
  })

  it('answers granted:false when the install failed, and holds nothing afterwards', async () => {
    const daemon = await boot({
      claimDuty: vi.fn(async () => ({ granted: true, grant: grant() })),
      fetchDutyAgent: vi.fn(async () => {
        throw new Error('control plane unreachable')
      })
    })

    await expect((daemon as any).dutyCoordinator.claimDutyForTrigger(AGENT)).resolves.toEqual({ granted: false })

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

    await expect((daemon as any).dutyCoordinator.claimDutyForTrigger(AGENT)).resolves.toEqual({ granted: false })

    expect(duties(daemon).digest()).toEqual([])
    expect(registries(daemon).agents.has(AGENT)).toBe(false)
    await daemon.stop()
  })

  it("reclaims a former owner's interrupted work for the agents the grant GAINED (#1033)", async () => {
    // Boot cannot be the trigger on a pool: peers keep serving through a rollout. The duty
    // grant is what makes a stranded grant ledger row or dream this member's to recover.
    const daemon = await boot({ fetchDutyAgent: vi.fn(async () => ({ bundle: bundle() })) })
    const grants = vi.spyOn((daemon as any).store, 'reclaimWebchatMcpGrants')
    const dreams = vi.spyOn((daemon as any).dreamRunner(), 'reclaimDreams')

    await (daemon as any).dutyCoordinator.admitDutyGrants([grant()])

    expect(duties(daemon).holdsAgent(AGENT)).toBe(true)
    expect(grants).toHaveBeenCalledWith([AGENT], 'session_closed', expect.any(Number))
    expect(dreams).toHaveBeenCalledWith([AGENT])

    // A re-grant of a group already held gains no agent, so it reclaims nothing.
    grants.mockClear()
    dreams.mockClear()
    await (daemon as any).dutyCoordinator.admitDutyGrants([grant()])
    expect(grants).not.toHaveBeenCalled()
    expect(dreams).not.toHaveBeenCalled()
    await daemon.stop()
  })
})
