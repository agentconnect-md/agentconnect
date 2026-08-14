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

const bundle = () => ({
  agentId: AGENT,
  spec: {
    orgId: ORG,
    name: 'scout',
    runtime: 'claude',
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

  it('an empty reply installs nothing — "you do not hold it, or it is gone"', async () => {
    const daemon = await boot({ fetchDutyAgent: vi.fn(async () => ({})) })

    await (daemon as any).installGrantedAgents([grant()])

    expect(registries(daemon).agents.has(AGENT)).toBe(false)
    await daemon.stop()
  })

  it('a failed fetch is logged, never thrown into frame dispatch', async () => {
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

describe('a duty this member cannot serve is not held', () => {
  it('a failed fetch drops the group, so the digest stops reporting it', async () => {
    const daemon = await boot({
      fetchDutyAgent: vi.fn(async () => {
        throw new Error('control plane unreachable')
      })
    })
    ;(daemon as any).applyDutyGrant([grant()], 'caller')
    expect(duties(daemon).digest()).toEqual([{ groupId: GROUP, term: '1' }])

    await (daemon as any).installGrantedAgents([grant()])

    // Load-bearing: an unheld group is exactly what makes the CP's missing-
    // regrant path reissue it. Still holding it would wedge the agent absent
    // forever, because the lease exchange has nothing to say about a group whose
    // term the member already reports.
    expect(duties(daemon).digest()).toEqual([])
    expect(duties(daemon).holdsAgent(AGENT)).toBe(false)
    expect(registries(daemon).agents.has(AGENT)).toBe(false)
    await daemon.stop()
  })

  it('an APPLY failure drops the group too — not just a failed fetch', async () => {
    const daemon = await boot({ fetchDutyAgent: vi.fn(async () => ({ bundle: bundle() })) })
    ;(daemon as any).applyDutyGrant([grant()], 'caller')
    vi.spyOn(registries(daemon).agents, 'upsert').mockImplementation(() => {
      throw new Error('agent root is not writable')
    })

    await (daemon as any).installGrantedAgents([grant()])

    expect(duties(daemon).digest()).toEqual([])
    expect(registries(daemon).agents.has(AGENT)).toBe(false)
    await daemon.stop()
  })

  it('a group covering several agents is dropped whole when one of them fails', async () => {
    const other = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
    const daemon = await boot({
      fetchDutyAgent: vi.fn(async (agentId: string) =>
        agentId === AGENT ? { bundle: bundle() } : Promise.reject(new Error('gone'))
      )
    })
    ;(daemon as any).applyDutyGrant([grant([AGENT, other])], 'caller')

    await (daemon as any).installGrantedAgents([grant([AGENT, other])])

    expect(duties(daemon).digest()).toEqual([])
    await daemon.stop()
  })

  it('a regrant retries the install and succeeds, once the retry window has passed', async () => {
    let broken = true
    const fetchDutyAgent = vi.fn(async () => {
      if (broken) throw new Error('control plane unreachable')
      return { bundle: bundle() }
    })
    const daemon = await boot({ fetchDutyAgent })
    const advance = shiftClock(daemon)
    ;(daemon as any).applyDutyGrant([grant()], 'caller')
    await (daemon as any).installGrantedAgents([grant()])
    expect(duties(daemon).digest()).toEqual([])

    // Inside the retry window a regrant is dropped again WITHOUT another fetch —
    // a permanently failing agent cannot outpace the beat that regrants it.
    broken = false
    ;(daemon as any).applyDutyGrant([grant()], 'caller')
    await (daemon as any).installGrantedAgents([grant()])
    expect(fetchDutyAgent).toHaveBeenCalledTimes(1)
    expect(duties(daemon).digest()).toEqual([])

    advance(20_000)
    ;(daemon as any).applyDutyGrant([grant()], 'caller')
    await (daemon as any).installGrantedAgents([grant()])

    expect(fetchDutyAgent).toHaveBeenCalledTimes(2)
    expect(duties(daemon).digest()).toEqual([{ groupId: GROUP, term: '1' }])
    expect(registries(daemon).agents.has(AGENT)).toBe(true)
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

    // The duty is already held, but the agent is not installed yet — answering
    // `granted` here is exactly the bug this pull closes.
    expect(cp.agents.has(AGENT)).toBe(false)
    expect(settled).toBe(false)

    releaseFetch()
    await expect(claim).resolves.toEqual({ granted: true })
    expect(cp.agents.has(AGENT)).toBe(true)
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

    // The answer and the local state agree: saying "not me" while still holding
    // the lease is the split brain this mechanism exists to avoid.
    expect(duties(daemon).digest()).toEqual([])
    expect(duties(daemon).holdsAgent(AGENT)).toBe(false)
    expect(registries(daemon).agents.has(AGENT)).toBe(false)
    await daemon.stop()
  })
})
