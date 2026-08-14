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

  it('a failed fetch is logged and dropped, never thrown into frame dispatch', async () => {
    const daemon = await boot({
      fetchDutyAgent: vi.fn(async () => {
        throw new Error('control plane unreachable')
      })
    })

    await expect((daemon as any).installGrantedAgents([grant()])).resolves.toBeUndefined()
    expect(registries(daemon).agents.has(AGENT)).toBe(false)
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
})
