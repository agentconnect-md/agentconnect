import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../src/daemon.js'

/**
 * #1031 — a cron or dream whose moment lands inside a duty handover (old holder released, new
 * holder not yet armed) used to run nowhere: a fresh `Cron` knows nothing of a moment already
 * passed. Gaining an agent's duty now replays the one occurrence that was swallowed, claimed
 * through the shared store so a pair of members racing the same handoff fires it once.
 */

/** Hourly: the previous occurrence is always inside the schedule's own grace window, and a real
 *  tick is an hour away, so nothing but the catch-up can fire inside a test. */
const HOURLY = '0 * * * *'
const AGENT = 'bot-a'
const GROUP = '11111111-1111-4111-8111-111111111111'
const HOUR_MS = 60 * 60_000

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-catchup-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  const adir = join(root, 'agents', AGENT)
  mkdirSync(adir, { recursive: true })
  writeFileSync(
    join(adir, 'agent.json'),
    JSON.stringify({
      id: AGENT,
      name: AGENT,
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
      integrations: [],
      output: { mode: 'low' },
      // Target-less ⇒ a headless fire, so the catch-up needs no live platform connection.
      crons: [{ id: 'report', schedule: HOURLY, trigger: 'run the report' }],
      memory: { provider: 'managed', dreaming: { enabled: true, schedule: HOURLY } }
    })
  )
  return root
}

/** One member: dispatch and the dream runner stubbed, so a fire is observable without a real turn. */
async function boot(root: string) {
  const daemon = new Daemon({
    root,
    hostFactory: () => ({}) as any,
    dreamOperationPolicy: 'test-only',
    probeRuntimes: async () => []
  })
  await daemon.start()
  const inner = daemon as any
  const crons: string[] = []
  const dreams: string[] = []
  inner.dispatch = vi.fn(async (agentId: string) => {
    crons.push(agentId)
    return 'acp-1'
  })
  inner.dreamRunner = () => ({
    start: async (agentId: string) => {
      dreams.push(agentId)
      return { dreamId: 'drm-test' }
    },
    hasNewSessionsSinceLastDream: () => true,
    reclaimDreams: () => {}
  })
  // Duty leases gate service, exactly like an install-wide pool member.
  inner.cpClient = {
    organizationScope: () => 'frame',
    stop: async () => {},
    releaseDuties: vi.fn(async () => {}),
    reportDutiesNow: vi.fn(() => {}),
    fetchDutyAgent: vi.fn()
  }
  return { daemon, inner, crons, dreams }
}

/** Two members over ONE store: the same root, so both LocalStores open the same database. */
async function bootPool() {
  const root = scaffold()
  const a = await boot(root)
  const b = await boot(root)
  return { a, b, stop: () => Promise.all([a.daemon.stop(), b.daemon.stop()]) }
}

const grant = () => ({
  groupId: GROUP,
  orgId: 'org-1',
  term: '1',
  members: [{ kind: 'agent' as const, refId: AGENT }]
})
const hold = (inner: any) => inner.settleDutyChange(inner.duties.applyGrant([grant()]))
const drop = (inner: any) => inner.applyDutyRevoke([{ groupId: GROUP, reason: 'reassigned' }])

/** Backdate both stamps so the schedules' previous occurrence reads as swallowed. */
function stampsBefore(inner: any, msAgo: number): void {
  const at = inner.clock.now() - msAgo
  inner.store.setCronLastRun(`${AGENT}:report`, at)
  inner.store.setDreamLastRun(AGENT, at)
}

/** croner fires are async under the hood; let the stubbed dispatch settle. */
const settle = () => new Promise((r) => setTimeout(r, 30))

describe('missed-fire compensation across a duty handover', () => {
  it('replays a cron and a dream that fell inside the handover, on the member that gained the duty', async () => {
    const { a, b, stop } = await bootPool()
    hold(a.inner)
    // The window: the old holder releases before the moment, the successor arms after it.
    stampsBefore(a.inner, 2 * HOUR_MS)
    drop(a.inner)
    a.crons.length = 0
    a.dreams.length = 0
    hold(b.inner)
    await settle()
    expect(b.crons).toEqual([AGENT])
    expect(b.dreams).toEqual([AGENT])
    // The released member neither fires nor holds anything to fire.
    expect(a.crons).toEqual([])
    expect(a.dreams).toEqual([])
    await stop()
  })

  it('fires nothing when the schedules already ran — the stamp is newer than the missed moment', async () => {
    const { a, b, stop } = await bootPool()
    hold(a.inner)
    stampsBefore(a.inner, 0)
    drop(a.inner)
    hold(b.inner)
    await settle()
    expect(b.crons).toEqual([])
    expect(b.dreams).toEqual([])
    await stop()
  })

  it('fires nothing when a schedule has no stamp at all — nothing durable says a fire was due', async () => {
    const { a, b, stop } = await bootPool()
    hold(a.inner)
    drop(a.inner)
    hold(b.inner)
    await settle()
    expect(b.crons).toEqual([])
    expect(b.dreams).toEqual([])
    await stop()
  })

  it('two members racing the same handoff compensate the occurrence exactly once', async () => {
    const { a, b, stop } = await bootPool()
    stampsBefore(a.inner, 2 * HOUR_MS)
    // Both claim the group — the overlap a handover leaves behind.
    hold(a.inner)
    hold(b.inner)
    await settle()
    expect(a.crons.length + b.crons.length).toBe(1)
    expect(a.dreams.length + b.dreams.length).toBe(1)
    await stop()
  })

  it('a second grant of an agent already held replays nothing — a catch-up is per handover', async () => {
    const { a, stop } = await bootPool()
    stampsBefore(a.inner, 2 * HOUR_MS)
    hold(a.inner)
    await settle()
    expect(a.crons).toEqual([AGENT])
    a.crons.length = 0
    a.dreams.length = 0
    hold(a.inner)
    await settle()
    expect(a.crons).toEqual([])
    expect(a.dreams).toEqual([])
    await stop()
  })

  it('a real fire stamps the dream schedule, so the next handover sees the moment as served', async () => {
    const { a, stop } = await bootPool()
    expect(a.inner.store.getDreamLastRun(AGENT)).toBeUndefined()
    a.inner.onDreamScheduleFire(AGENT)
    await settle()
    expect(a.inner.store.getDreamLastRun(AGENT)).toBeGreaterThan(0)
    await stop()
  })
})
