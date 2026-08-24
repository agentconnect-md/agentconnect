import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../src/daemon.js'
import { scheduleFingerprint } from '../src/scheduler/scheduler.js'

/**
 * #1031 — a cron or dream whose moment lands inside a duty handover (old holder released, new
 * holder not yet armed) used to run nowhere: a fresh `Cron` knows nothing of a moment already
 * passed. Gaining an agent's duty now replays the one occurrence that was swallowed, claimed
 * through the shared store so a pair of members racing the same handoff fires it once. A stamp is
 * only evidence about the definition it was written under, so an edited schedule replays nothing.
 */

/** Hourly: the previous occurrence is always inside the schedule's own grace window, and a real
 *  tick is an hour away, so nothing but the catch-up can fire inside a test. */
const HOURLY = '0 * * * *'
const AGENT = 'bot-a'
const GROUP = '11111111-1111-4111-8111-111111111111'
const HOUR_MS = 60 * 60_000
const CRON = { id: 'report', schedule: HOURLY, trigger: 'run the report' }
const DREAMING = { enabled: true, schedule: HOURLY }

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
      crons: [CRON],
      memory: { provider: 'managed', dreaming: DREAMING }
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
    memberSet: () => ({ setId: '9f11e5e7-0000-4000-8000-000000000001', name: 'Cloud' }),
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
  return { a, b, root, stop: () => Promise.all([a.daemon.stop(), b.daemon.stop()]) }
}

const grant = () => ({
  groupId: GROUP,
  orgId: 'org-1',
  term: '1',
  members: [{ kind: 'agent' as const, refId: AGENT }]
})
const hold = (inner: any) => inner.dutyCoordinator.settleDutyChange(inner.duties.applyGrant([grant()]))
const drop = (inner: any) => inner.dutyCoordinator.applyDutyRevoke([{ groupId: GROUP, reason: 'reassigned' }])

const agentOf = (inner: any) => inner.agents.get(AGENT)

/** Backdate both stamps, fingerprinted under the definitions currently in force. */
async function stampsBefore(inner: any, msAgo: number): Promise<void> {
  const at = inner.clock.now() - msAgo
  const agent = agentOf(inner)
  await inner.store.setCronLastRun(`${AGENT}:report`, at, scheduleFingerprint(inner.cronDefinition(agent.crons[0])))
  await inner.store.setDreamLastRun(AGENT, at, scheduleFingerprint(inner.dreamDefinition(agent)))
}

/** Rewrite agent.json, then reconcile every listed member — the path a real definition change
 *  takes, and where a moved definition retires its stamp. */
async function editAgent(root: string, members: { inner: any }[], mutate: (agent: any) => void): Promise<void> {
  const path = join(root, 'agents', AGENT, 'agent.json')
  const agent = JSON.parse(readFileSync(path, 'utf8'))
  mutate(agent)
  writeFileSync(path, JSON.stringify(agent))
  for (const member of members) await member.inner.reconcile()
}

/** Move both schedules the same way, as a console edit of the agent would. */
const editSchedules = (root: string, members: { inner: any }[], over: { schedule?: string; enabled?: boolean }) =>
  editAgent(root, members, (agent) => {
    for (const target of [agent.crons[0], agent.memory.dreaming]) Object.assign(target, over)
  })

/** A cron fire leaves the settle path, so a returned `hold` proves only that the decision was made;
 *  join the fires themselves, never a wall clock. The dream half is awaited inside the catch-up. */
const settle = (...members: { inner: any }[]) => Promise.all(members.map((member) => member.inner.joinCatchUpFires()))

describe('missed-fire compensation across a duty handover', () => {
  it('replays a cron and a dream that fell inside the handover, on the member that gained the duty', async () => {
    const { a, b, stop } = await bootPool()
    await hold(a.inner)
    // The window: the old holder releases before the moment, the successor arms after it.
    await stampsBefore(a.inner, 2 * HOUR_MS)
    await drop(a.inner)
    a.crons.length = 0
    a.dreams.length = 0
    await hold(b.inner)
    await settle(a, b)
    expect(b.crons).toEqual([AGENT])
    expect(b.dreams).toEqual([AGENT])
    // The released member neither fires nor holds anything to fire.
    expect(a.crons).toEqual([])
    expect(a.dreams).toEqual([])
    await stop()
  })

  it('fires nothing when the schedules already ran — the stamp is newer than the missed moment', async () => {
    const { a, b, stop } = await bootPool()
    await hold(a.inner)
    await stampsBefore(a.inner, 0)
    await drop(a.inner)
    await hold(b.inner)
    await settle(b)
    expect(b.crons).toEqual([])
    expect(b.dreams).toEqual([])
    await stop()
  })

  it('fires nothing when a schedule has no stamp at all — nothing durable says a fire was due', async () => {
    const { a, b, stop } = await bootPool()
    await hold(a.inner)
    await drop(a.inner)
    await hold(b.inner)
    await settle(b)
    expect(b.crons).toEqual([])
    expect(b.dreams).toEqual([])
    await stop()
  })

  it('two members racing the same handoff compensate the occurrence exactly once', async () => {
    const { a, b, stop } = await bootPool()
    await stampsBefore(a.inner, 2 * HOUR_MS)
    // Both claim the group — the overlap a handover leaves behind.
    await hold(a.inner)
    await hold(b.inner)
    await settle(a, b)
    expect(a.crons.length + b.crons.length).toBe(1)
    expect(a.dreams.length + b.dreams.length).toBe(1)
    await stop()
  })

  it('a second grant of an agent already held replays nothing — a catch-up is per handover', async () => {
    const { a, stop } = await bootPool()
    await stampsBefore(a.inner, 2 * HOUR_MS)
    await hold(a.inner)
    await settle(a)
    expect(a.crons).toEqual([AGENT])
    a.crons.length = 0
    a.dreams.length = 0
    await hold(a.inner)
    await settle(a)
    expect(a.crons).toEqual([])
    expect(a.dreams).toEqual([])
    await stop()
  })

  it('a real fire stamps the dream schedule, so the next handover sees the moment as served', async () => {
    const { a, stop } = await bootPool()
    expect(await a.inner.store.dreamRun(AGENT)).toBeUndefined()
    // The fire stamps before its gates, so awaiting it is already proof the row is durable.
    await a.inner.onDreamScheduleFire(AGENT)
    const run = await a.inner.store.dreamRun(AGENT)
    expect(run.lastRunAt).toBeGreaterThan(0)
    expect(run.definition).toBe(scheduleFingerprint(a.inner.dreamDefinition(agentOf(a.inner))))
    await stop()
  })

  it('replays nothing when the definition was edited since the stamp', async () => {
    const { a, b, root, stop } = await bootPool()
    await hold(a.inner)
    await stampsBefore(a.inner, 2 * HOUR_MS)
    await drop(a.inner)
    // Same cadence, different moments: :30 past the hour is due on its own, but the stamp is
    // evidence about the :00 schedule that no longer exists.
    await editSchedules(root, [a, b], { schedule: '30 * * * *' })
    await hold(b.inner)
    await settle(b)
    expect(b.crons).toEqual([])
    expect(b.dreams).toEqual([])
    await stop()
  })

  it('a member that does not serve the agent never rewrites the shared stamps', async () => {
    const { a, b, root, stop } = await bootPool()
    await hold(a.inner)
    await stampsBefore(a.inner, 2 * HOUR_MS)
    const cron = await a.inner.store.cronRun(`${AGENT}:report`)
    const dream = await a.inner.store.dreamRun(AGENT)
    // b holds nothing. Its reconcile disarms its own jobs; the shared evidence is the holder's,
    // and a stale non-holder rewriting it would erase the very gap the holder must compensate.
    await editSchedules(root, [b], { schedule: '30 * * * *' })
    expect(await b.inner.store.cronRun(`${AGENT}:report`)).toEqual(cron)
    expect(await b.inner.store.dreamRun(AGENT)).toEqual(dream)
    await stop()
  })

  it('a cron id deleted and recreated starts from no evidence', async () => {
    const { a, b, root, stop } = await bootPool()
    await hold(a.inner)
    await stampsBefore(a.inner, 2 * HOUR_MS)
    // Deleting drops the row outright — ids are re-mintable, so leaving one would let a later
    // schedule of the same name inherit a run it never had.
    await editAgent(root, [a], (agent) => {
      agent.crons = []
      delete agent.memory.dreaming
    })
    expect(await a.inner.store.cronRun(`${AGENT}:report`)).toBeUndefined()
    await editAgent(root, [a, b], (agent) => {
      agent.crons = [CRON]
      agent.memory.dreaming = DREAMING
    })
    await drop(a.inner)
    await hold(b.inner)
    await settle(b)
    expect(b.crons).toEqual([])
    expect(b.dreams).toEqual([])
    await stop()
  })

  it('replays nothing across a disable and re-enable', async () => {
    const { a, b, root, stop } = await bootPool()
    await hold(a.inner)
    await stampsBefore(a.inner, 2 * HOUR_MS)
    await editSchedules(root, [a, b], { enabled: false })
    await editSchedules(root, [a, b], { enabled: true })
    await drop(a.inner)
    await hold(b.inner)
    await settle(b)
    expect(b.crons).toEqual([])
    expect(b.dreams).toEqual([])
    await stop()
  })
})
