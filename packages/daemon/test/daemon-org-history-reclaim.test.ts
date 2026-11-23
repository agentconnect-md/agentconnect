// The retention sweep deletes under each org's history window only with the install switch on, and only for orgs the Control Plane re-confirms (org-session-policy.md, Reclaim).
import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../src/daemon.js'
import type { OrgHistoryRetentionAnswer } from '../src/daemon/org-history-retention.js'
import { FakeClock } from './cp/fake-clock.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

const DAY = 86_400_000
const ORG = 'org-reclaim-a'

type Entry = { orgId: string; revision: number; historyRetentionDays: number | null }

function scaffold(sessions: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-org-reclaim-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: ['unused'] } },
      sessions
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

interface Setup {
  retention: string
  workspaceRetention?: string
  pool: boolean
  // What the Control Plane answers at re-confirmation; undefined ⇒ it cannot be reached.
  answer?: (orgIds: string[]) => Map<string, OrgHistoryRetentionAnswer> | undefined
}

/** The CP's current table: the answer the re-confirmation reads, which a test can move ahead of the daemon's. */
function controlPlane(entries: Entry[]) {
  const table = new Map(entries.map((entry) => [entry.orgId, entry]))
  return {
    table,
    answer: (orgIds: string[]) =>
      new Map(
        orgIds.map((orgId): [string, OrgHistoryRetentionAnswer] => {
          const entry = table.get(orgId)
          return [
            orgId,
            entry
              ? { kind: 'policy', revision: entry.revision, historyRetentionDays: entry.historyRetentionDays }
              : { kind: 'none' }
          ]
        })
      )
  }
}

async function startDaemon(setup: Setup) {
  const clock = new FakeClock()
  const daemon = new Daemon({
    slackAppFactory: fakeSlackAppFactory(),
    root: scaffold({
      retention: setup.retention,
      ...(setup.workspaceRetention ? { workspaceRetention: setup.workspaceRetention } : {})
    }),
    hostFactory: () => quietHost() as any,
    clock
  })
  await daemon.start()
  const d = daemon as any
  while (d.sessionRetentionSweepInFlight) await new Promise((resolve) => setTimeout(resolve, 5))
  vi.spyOn(d, 'orgForAgent').mockReturnValue(ORG)
  vi.spyOn(d, 'historyRetentionPoolMember').mockReturnValue(setup.pool)
  const confirm = vi
    .spyOn(d, 'confirmOrgHistoryRetention')
    .mockImplementation(async (orgIds: unknown) => setup.answer?.(orgIds as string[]))
  return { daemon, d, clock, confirm }
}

/** Deliver a snapshot as a register/ok would, with the reclaim switch as given. */
function deliver(d: any, entries: Entry[], reclaim: boolean | undefined) {
  d.orgHistoryRetention.applySnapshot({
    orgIds: [ORG],
    entries,
    ...(reclaim === undefined ? {} : { reclaim })
  })
}

async function seed(d: any, key: string, updatedAt: number) {
  await d.store.upsertSession({
    key,
    agentId: 'bot-a',
    platform: 'slack',
    channel: 'C1',
    thread: key,
    acpSessionId: `acp-${key}`,
    state: 'closed',
    lastDeliveredTs: null,
    updatedAt
  })
}

async function sweep(d: any) {
  while (d.sessionRetentionSweepInFlight) await new Promise((resolve) => setTimeout(resolve, 5))
  await d.sweepSessionRetention()
}

async function surviving(d: any, keys: string[]): Promise<string[]> {
  const kept: string[] = []
  for (const key of keys) if (await d.store.getSession(key)) kept.push(key)
  return kept
}

describe('retention sweep — org history reclaim', () => {
  it('switch off: deletes exactly what the daemon-wide window reaches and never asks the Control Plane', async () => {
    for (const reclaim of [undefined, false]) {
      const cp = controlPlane([{ orgId: ORG, revision: 1, historyRetentionDays: 7 }])
      const { daemon, d, clock, confirm } = await startDaemon({ retention: '90d', pool: true, answer: cp.answer })
      deliver(d, [...cp.table.values()], reclaim)
      const now = clock.now()
      await seed(d, 'young', now - 10 * DAY)
      await seed(d, 'old', now - 100 * DAY)
      await sweep(d)
      expect(await surviving(d, ['young', 'old'])).toEqual(['young'])
      expect(confirm).not.toHaveBeenCalled()
      await daemon.stop()
    }
    // …and an unlimited org is still reclaimed by today's 7-day rule while the switch is off.
    const { daemon, d, clock, confirm } = await startDaemon({ retention: '7d', pool: true })
    deliver(d, [{ orgId: ORG, revision: 1, historyRetentionDays: null }], false)
    await seed(d, 'ten', clock.now() - 10 * DAY)
    await sweep(d)
    expect(await surviving(d, ['ten'])).toEqual([])
    expect(confirm).not.toHaveBeenCalled()
    await daemon.stop()
  })

  it('pool member: a 7-day org deletes what is older, after one re-confirmation of the org', async () => {
    const cp = controlPlane([{ orgId: ORG, revision: 3, historyRetentionDays: 7 }])
    const { daemon, d, clock, confirm } = await startDaemon({ retention: '90d', pool: true, answer: cp.answer })
    deliver(d, [...cp.table.values()], true)
    const now = clock.now()
    await seed(d, 'fresh', now - 1 * DAY)
    await seed(d, 'young', now - 10 * DAY)
    await seed(d, 'mid', now - 30 * DAY)
    await seed(d, 'old', now - 100 * DAY)
    await sweep(d)
    expect(await surviving(d, ['fresh', 'young', 'mid', 'old'])).toEqual(['fresh'])
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm).toHaveBeenCalledWith([ORG])
    // Deleted under the org window, through the same durable purge receipt as today.
    const receipts = await d.store.listSessionPurges(10, clock.now())
    expect(receipts.map((row: { reason: string }) => row.reason)).toEqual(['retention', 'retention', 'retention'])
    await daemon.stop()
  })

  it('pool member: an unlimited org is never deleted, even past the old daemon-wide window', async () => {
    const cp = controlPlane([{ orgId: ORG, revision: 1, historyRetentionDays: null }])
    const { daemon, d, clock, confirm } = await startDaemon({ retention: '90d', pool: true, answer: cp.answer })
    deliver(d, [...cp.table.values()], true)
    await seed(d, 'ancient', clock.now() - 400 * DAY)
    await sweep(d)
    expect(await surviving(d, ['ancient'])).toEqual(['ancient'])
    expect(confirm).not.toHaveBeenCalled()
    await daemon.stop()
  })

  it('an org without a policy keeps today’s rule, once the Control Plane confirms it still has none', async () => {
    const cp = controlPlane([])
    const { daemon, d, clock, confirm } = await startDaemon({ retention: '7d', pool: true, answer: cp.answer })
    deliver(d, [], true)
    await seed(d, 'fresh', clock.now() - 1 * DAY)
    await seed(d, 'ten', clock.now() - 10 * DAY)
    await sweep(d)
    expect(await surviving(d, ['fresh', 'ten'])).toEqual(['fresh'])
    expect(confirm).toHaveBeenCalledWith([ORG])

    // A policy delivered elsewhere (another replica) shows at re-confirmation: nothing goes, and the table learns it.
    cp.table.set(ORG, { orgId: ORG, revision: 1, historyRetentionDays: null })
    await seed(d, 'twenty', clock.now() - 20 * DAY)
    await sweep(d)
    expect(await surviving(d, ['twenty'])).toEqual(['twenty'])
    expect(d.orgHistoryRetention.verdict(ORG)).toEqual({ kind: 'policy', windowMs: null, revision: 1 })
    await sweep(d)
    expect(await surviving(d, ['twenty'])).toEqual(['twenty'])
    await daemon.stop()
  })

  it('self-hosted: the shorter of the org window and the local setting', async () => {
    const longer = controlPlane([{ orgId: ORG, revision: 1, historyRetentionDays: 120 }])
    const a = await startDaemon({ retention: '90d', pool: false, answer: longer.answer })
    deliver(a.d, [...longer.table.values()], true)
    await seed(a.d, 'thirty', a.clock.now() - 30 * DAY)
    await seed(a.d, 'hundred', a.clock.now() - 100 * DAY)
    await sweep(a.d)
    expect(await surviving(a.d, ['thirty', 'hundred'])).toEqual(['thirty'])
    await a.daemon.stop()

    const shorter = controlPlane([{ orgId: ORG, revision: 1, historyRetentionDays: 7 }])
    const b = await startDaemon({ retention: '90d', pool: false, answer: shorter.answer })
    deliver(b.d, [...shorter.table.values()], true)
    await seed(b.d, 'ten', b.clock.now() - 10 * DAY)
    await seed(b.d, 'fresh', b.clock.now() - 1 * DAY)
    await sweep(b.d)
    expect(await surviving(b.d, ['ten', 'fresh'])).toEqual(['fresh'])
    await b.daemon.stop()

    // Unlimited on a self-hosted daemon leaves its own setting in charge.
    const unlimited = controlPlane([{ orgId: ORG, revision: 1, historyRetentionDays: null }])
    const c = await startDaemon({ retention: '7d', pool: false, answer: unlimited.answer })
    deliver(c.d, [...unlimited.table.values()], true)
    await seed(c.d, 'ten', c.clock.now() - 10 * DAY)
    await sweep(c.d)
    expect(await surviving(c.d, ['ten'])).toEqual([])
    await c.daemon.stop()
  })

  it('deletes nothing for an org whose re-confirmation mismatches, then acts on the newer revision next pass', async () => {
    const cp = controlPlane([{ orgId: ORG, revision: 4, historyRetentionDays: 7 }])
    const { daemon, d, clock } = await startDaemon({ retention: '90d', pool: true, answer: cp.answer })
    deliver(d, [{ orgId: ORG, revision: 3, historyRetentionDays: 7 }], true)
    await seed(d, 'ten', clock.now() - 10 * DAY)
    await sweep(d)
    expect(await surviving(d, ['ten'])).toEqual(['ten'])
    expect(d.orgHistoryRetention.verdict(ORG)).toMatchObject({ kind: 'policy', revision: 4 })
    await sweep(d)
    expect(await surviving(d, ['ten'])).toEqual([])
    await daemon.stop()
  })

  it('a window lengthened before the re-confirmation keeps the session', async () => {
    const cp = controlPlane([{ orgId: ORG, revision: 2, historyRetentionDays: 30 }])
    const { daemon, d, clock } = await startDaemon({ retention: '90d', pool: true, answer: cp.answer })
    deliver(d, [{ orgId: ORG, revision: 1, historyRetentionDays: 7 }], true)
    await seed(d, 'ten', clock.now() - 10 * DAY)
    await sweep(d)
    await sweep(d)
    expect(await surviving(d, ['ten'])).toEqual(['ten'])
    await daemon.stop()
  })

  it('deletes nothing for an org when the Control Plane is unreachable, times out, or denies it', async () => {
    const denied = (orgIds: string[]) =>
      new Map(orgIds.map((orgId): [string, OrgHistoryRetentionAnswer] => [orgId, { kind: 'denied' }]))
    for (const answer of [() => undefined, () => new Map<string, OrgHistoryRetentionAnswer>(), denied]) {
      const { daemon, d, clock, confirm } = await startDaemon({ retention: '7d', pool: true, answer })
      deliver(d, [{ orgId: ORG, revision: 1, historyRetentionDays: 7 }], true)
      await seed(d, 'ten', clock.now() - 10 * DAY)
      await sweep(d)
      expect(confirm).toHaveBeenCalledTimes(1)
      expect(await surviving(d, ['ten'])).toEqual(['ten'])
      await daemon.stop()
    }
  })

  it('a paused org deletes nothing this pass, never falling back to the daemon-wide rule', async () => {
    const cp = controlPlane([{ orgId: ORG, revision: 5, historyRetentionDays: 7 }])
    const { daemon, d, clock, confirm } = await startDaemon({ retention: '7d', pool: true, answer: cp.answer })
    // Unsynced: the link dropped, so there is nobody to ask either.
    deliver(d, [{ orgId: ORG, revision: 5, historyRetentionDays: 7 }], true)
    d.orgHistoryRetention.linkLost()
    await seed(d, 'old', clock.now() - 100 * DAY)
    await sweep(d)
    expect(await surviving(d, ['old'])).toEqual(['old'])
    expect(confirm).not.toHaveBeenCalled()

    // Stale: a lagging snapshot below a revision already seen. Asked, kept, and readable again afterwards.
    deliver(d, [{ orgId: ORG, revision: 4, historyRetentionDays: 7 }], true)
    expect(d.orgHistoryRetention.verdict(ORG)).toEqual({ kind: 'paused', reason: 'stale' })
    await sweep(d)
    expect(await surviving(d, ['old'])).toEqual(['old'])
    expect(confirm).toHaveBeenCalledWith([ORG])
    expect(d.orgHistoryRetention.verdict(ORG)).toMatchObject({ kind: 'policy', revision: 5 })
    await sweep(d)
    expect(await surviving(d, ['old'])).toEqual([])
    await daemon.stop()
  })

  it('an org no delivery named, as one first served through a duty grant, is learned at re-confirmation and acted on next pass', async () => {
    const cp = controlPlane([{ orgId: ORG, revision: 2, historyRetentionDays: 7 }])
    const { daemon, d, clock } = await startDaemon({ retention: '90d', pool: true, answer: cp.answer })
    d.orgHistoryRetention.applySnapshot({ orgIds: ['org-other'], entries: [], reclaim: true })
    expect(d.orgHistoryRetention.verdict(ORG)).toEqual({ kind: 'paused', reason: 'unknown' })
    await seed(d, 'ten', clock.now() - 100 * DAY)
    await sweep(d)
    expect(await surviving(d, ['ten'])).toEqual(['ten'])
    expect(d.orgHistoryRetention.verdict(ORG)).toEqual({ kind: 'policy', windowMs: 7 * DAY, revision: 2 })
    await sweep(d)
    expect(await surviving(d, ['ten'])).toEqual([])
    await daemon.stop()
  })

  it('keeps every protection of the real pass: a live turn and a recheck back-off survive the org window', async () => {
    const cp = controlPlane([{ orgId: ORG, revision: 1, historyRetentionDays: 7 }])
    const { daemon, d, clock } = await startDaemon({ retention: '90d', pool: true, answer: cp.answer })
    deliver(d, [...cp.table.values()], true)
    const now = clock.now()
    await seed(d, 'busy', now - 10 * DAY)
    await seed(d, 'backoff', now - 10 * DAY)
    d.inflight.add('busy')
    await d.store.markSessionRetentionKept('backoff', now - 10 * DAY, now, now + 7 * DAY)
    await sweep(d)
    expect(await surviving(d, ['busy', 'backoff'])).toEqual(['busy', 'backoff'])
    await daemon.stop()
  })

  it('stops deleting a confirmed org whose reading changes mid-pass', async () => {
    const cp = controlPlane([{ orgId: ORG, revision: 1, historyRetentionDays: 7 }])
    const { daemon, d, clock } = await startDaemon({ retention: '90d', pool: true, answer: cp.answer })
    deliver(d, [...cp.table.values()], true)
    await seed(d, 'ten', clock.now() - 10 * DAY)
    // A longer window pushed right after the re-confirmation, before the deletion.
    const realConfirm = d.confirmOrgHistoryRetention
    d.confirmOrgHistoryRetention = async (orgIds: string[]) => {
      const answers = await realConfirm.call(d, orgIds)
      d.orgHistoryRetention.applyUpdate({ orgId: ORG, revision: 2, historyRetentionDays: null })
      return answers
    }
    await sweep(d)
    expect(await surviving(d, ['ten'])).toEqual(['ten'])
    await daemon.stop()
  })

  it('the workspace pass leaves to the purge exactly the rows past the org window', async () => {
    const { daemon, d, clock } = await startDaemon({
      retention: '90d',
      workspaceRetention: '3d',
      pool: true,
      // Unconfirmed, so the purge keeps every row and the workspace pass alone is judged.
      answer: () => undefined
    })
    deliver(d, [{ orgId: ORG, revision: 1, historyRetentionDays: 7 }], true)
    const now = clock.now()
    await seed(d, 'five', now - 5 * DAY)
    await seed(d, 'ten', now - 10 * DAY)
    await sweep(d)
    expect((await d.store.getSession('five'))?.workspaceReclaimedAt).toBe(clock.now())
    // Past the org's 7 days: the purge's to judge, though the daemon-wide 90 days would have reclaimed its workspace.
    expect((await d.store.getSession('ten'))?.workspaceReclaimedAt ?? null).toBeNull()
    await daemon.stop()
  })
})
