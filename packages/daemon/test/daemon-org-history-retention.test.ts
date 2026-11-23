// The retention sweep's org history dry run counts and logs, while deletion stays exactly the daemon-wide rule (org-session-policy.md, History retention).
import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../src/daemon.js'
import { FakeClock } from './cp/fake-clock.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

const DAY = 86_400_000
const ORG = 'org-retention-a'

function scaffold(retention: string): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-org-retention-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: ['unused'] } },
      sessions: { retention }
    })
  )
  const adir = join(root, 'agents', 'bot-a')
  mkdirSync(adir, { recursive: true })
  writeFileSync(
    join(adir, 'agent.json'),
    JSON.stringify({
      id: 'bot-a',
      name: 'bot-a',
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
      integrations: [],
      output: { mode: 'medium' }
    })
  )
  return root
}

function quietHost() {
  return {
    start: vi.fn(async () => {}),
    newSession: vi.fn(async () => 'acp-1'),
    prompt: vi.fn(async () => 'end_turn'),
    cancel: vi.fn(async () => {}),
    stop: vi.fn(async () => {})
  }
}

async function startDaemon(retention: string) {
  const clock = new FakeClock()
  const daemon = new Daemon({
    slackAppFactory: fakeSlackAppFactory(),
    root: scaffold(retention),
    hostFactory: () => quietHost() as any,
    clock
  })
  await daemon.start()
  const d = daemon as any
  // `start()` runs its own pass; let it finish so the test's pass is the one judged.
  while (d.sessionRetentionSweepInFlight) await new Promise((resolve) => setTimeout(resolve, 5))
  vi.spyOn(d, 'orgForAgent').mockReturnValue(ORG)
  const lines: string[] = []
  const debug: string[] = []
  vi.spyOn(d.log, 'info').mockImplementation((msg: unknown) => void lines.push(String(msg)))
  vi.spyOn(d.log, 'debug').mockImplementation((msg: unknown) => void debug.push(String(msg)))
  return { daemon, d, clock, lines, debug }
}

async function seed(d: any, key: string, updatedAt: number, state: 'idle' | 'closed' = 'closed') {
  await d.store.upsertSession({
    key,
    agentId: 'bot-a',
    platform: 'slack',
    channel: 'C1',
    thread: key,
    acpSessionId: `acp-${key}`,
    state,
    lastDeliveredTs: null,
    updatedAt
  })
}

// A call landing while another pass runs is dropped: wait it out first.
async function sweep(d: any) {
  while (d.sessionRetentionSweepInFlight) await new Promise((resolve) => setTimeout(resolve, 5))
  await d.sweepSessionRetention()
}

const dryRunLine = (lines: string[]) => lines.filter((line) => line.startsWith('retention dry run:')).at(-1)
const field = (line: string | undefined, name: string) => Number(new RegExp(`\\b${name}=(\\d+)`).exec(line ?? '')?.[1])

describe('retention sweep — org history dry run', () => {
  it('counts a shorter org window as deleting more, and deletes nothing the daemon-wide window keeps', async () => {
    const { daemon, d, clock, lines, debug } = await startDaemon('90d')
    d.orgHistoryRetention.applySnapshot({
      orgIds: [ORG],
      entries: [{ orgId: ORG, revision: 3, historyRetentionDays: 7 }]
    })
    const now = clock.now()
    await seed(d, 'young', now - 10 * DAY)
    await seed(d, 'mid', now - 30 * DAY)
    await seed(d, 'old', now - 100 * DAY)
    await seed(d, 'fresh', now - 1 * DAY)

    await sweep(d)

    // The real pass still deletes only what 90 days reaches.
    expect(await d.store.getSession('young')).toBeDefined()
    expect(await d.store.getSession('mid')).toBeDefined()
    expect(await d.store.getSession('fresh')).toBeDefined()
    expect(await d.store.getSession('old')).toBeUndefined()

    const line = dryRunLine(lines)
    expect(field(line, 'candidates')).toBe(3)
    expect(field(line, 'currentDeletes')).toBe(1)
    expect(field(line, 'wouldDelete')).toBe(3)
    expect(field(line, 'wouldKeep')).toBe(0)
    expect(field(line, 'differs')).toBe(2)
    expect(field(line, 'orgDeletesMore')).toBe(2)
    expect(field(line, 'paused')).toBe(0)
    expect(debug).toContain(`retention dry run: session young org=${ORG} current=keep org=delete basis=policy`)
    await daemon.stop()
  })

  it('counts a longer or unlimited org window as keeping, while today’s 7-day rule still deletes', async () => {
    const { daemon, d, clock, lines } = await startDaemon('7d')
    d.orgHistoryRetention.applySnapshot({
      orgIds: [ORG],
      entries: [{ orgId: ORG, revision: 1, historyRetentionDays: null }]
    })
    const now = clock.now()
    await seed(d, 'ten', now - 10 * DAY)
    await seed(d, 'hundred', now - 100 * DAY)

    await sweep(d)

    expect(await d.store.getSession('ten')).toBeUndefined()
    expect(await d.store.getSession('hundred')).toBeUndefined()
    const line = dryRunLine(lines)
    expect(field(line, 'candidates')).toBe(2)
    expect(field(line, 'currentDeletes')).toBe(2)
    expect(field(line, 'wouldKeep')).toBe(2)
    expect(field(line, 'orgKeepsMore')).toBe(2)
    await daemon.stop()
  })

  it('follows today’s rule for an org without a policy and pauses a stale or unsynced one', async () => {
    const { daemon, d, clock, lines } = await startDaemon('7d')
    d.orgHistoryRetention.applySnapshot({ orgIds: [ORG], entries: [] })
    await seed(d, 'a', clock.now() - 10 * DAY)
    await sweep(d)
    let line = dryRunLine(lines)
    expect(field(line, 'policyMissing')).toBe(1)
    expect(field(line, 'wouldDelete')).toBe(1)
    expect(field(line, 'differs')).toBe(0)

    // A push at revision 5, then a lagging snapshot at revision 4: the org pauses.
    d.orgHistoryRetention.applyUpdate({ orgId: ORG, revision: 5, historyRetentionDays: 30 })
    d.orgHistoryRetention.applySnapshot({
      orgIds: [ORG],
      entries: [{ orgId: ORG, revision: 4, historyRetentionDays: 1 }]
    })
    await seed(d, 'b', clock.now() - 10 * DAY)
    lines.length = 0
    await sweep(d)
    line = dryRunLine(lines)
    expect(field(line, 'paused')).toBe(1)
    expect(field(line, 'pausedStale')).toBe(1)
    expect(field(line, 'wouldDelete')).toBe(0)
    // The real pass is not paused: it is still today's rule.
    expect(await d.store.getSession('b')).toBeUndefined()

    d.orgHistoryRetention.linkLost()
    await seed(d, 'c', clock.now() - 10 * DAY)
    lines.length = 0
    await sweep(d)
    line = dryRunLine(lines)
    expect(field(line, 'pausedUnsynced')).toBe(1)
    await daemon.stop()
  })

  it('counts a live turn as protected under both rules', async () => {
    const { daemon, d, clock, lines } = await startDaemon('90d')
    d.orgHistoryRetention.applySnapshot({
      orgIds: [ORG],
      entries: [{ orgId: ORG, revision: 1, historyRetentionDays: 7 }]
    })
    await seed(d, 'busy', clock.now() - 10 * DAY)
    d.inflight.add('busy')
    await sweep(d)
    const line = dryRunLine(lines)
    expect(field(line, 'protected')).toBe(1)
    expect(field(line, 'wouldDelete')).toBe(0)
    expect(await d.store.getSession('busy')).toBeDefined()
    await daemon.stop()
  })

  it('does not run before a Control Plane has answered a register', async () => {
    const { daemon, d, clock, lines } = await startDaemon('7d')
    await seed(d, 'x', clock.now() - 10 * DAY)
    await sweep(d)
    expect(dryRunLine(lines)).toBeUndefined()
    expect(await d.store.getSession('x')).toBeUndefined()
    await daemon.stop()
  })
})
