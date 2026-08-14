// The daemon half of `T_reassign > T_fence`: a member must stop serving its duties before
// the CP can hand them to a successor. These pin what the fence tears down, what it must
// leave alone, and that it does nothing at all while enforcement is off.
import { describe, it, expect, vi } from 'vitest'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
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

function scaffold(dutyEnforcement: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-duty-fence-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      features: { dutyEnforcement },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  return root
}

const grant = (): DutyGrantEntry => ({
  groupId: GROUP,
  orgId: ORG,
  term: '1',
  members: [{ kind: 'agent', refId: AGENT }]
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

/** A daemon holding one granted duty, with a stub CP client — only the duty surface runs. */
async function boot(dutyEnforcement = true) {
  const root = scaffold(dutyEnforcement)
  const daemon = new Daemon({ root })
  await daemon.start()
  const fetchDutyAgent = vi.fn(async () => ({ bundle: bundle() }))
  ;(daemon as any).cpClient = {
    organizationScope: () => 'frame',
    stop: async () => {},
    releaseDuties: vi.fn(async () => {}),
    fetchDutyAgent
  }
  await (daemon as any).admitDutyGrants([grant()])
  return { daemon, root, fetchDutyAgent }
}

const duties = (d: Daemon) => (d as any).duties as DutyRegistry
const served = (d: Daemon): string[] => (d as any).transportAgents().map((a: { id: string }) => a.id)
const fence = (d: Daemon) => (d as any).fenceDuties()

describe('the duty self-fence', () => {
  it('releases every held group and stops serving its agents', async () => {
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

  it('is a revoke, not a removal — workspace, agent registry, and sessions survive', async () => {
    const { daemon, root } = await boot()
    const store = (daemon as any).store
    store.upsertSession({
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
    expect(store.listSessions(AGENT)).toHaveLength(1)
    expect(store.getSession(`slack:C1:T1:${AGENT}`)).toBeDefined()
    await daemon.stop()
  })

  it('does nothing while enforcement is off — duties gate no service, so there is nothing to fence', async () => {
    const { daemon } = await boot(false)
    expect(served(daemon)).toContain(AGENT)

    fence(daemon)

    // Still held, still served: tearing anything down here would drop live traffic.
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
    await (daemon as any).admitDutyGrants([grant()])

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
