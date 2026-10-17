// A follow-up's check state, its check log and its row of the sub-session index (assistant-mode.md §5.12): one contract suite, on SQLite and on PostgreSQL.
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import pg from 'pg'
import { afterEach, describe, expect, it } from 'vitest'
import { firstLookCoordinate, checkCoordinate, subsessionCoordinate } from '../src/session/subsession-coordinate.js'
import { ASSISTANT_CHECKS_KEPT, CHECK_MAX_FAILURES, checkBackoffMs } from '../src/store/assistant-checks.js'
import { LocalStore, SCHEMA_VERSION, sessionKey } from '../src/store/local-store.js'
import { PostgresAsyncDatabase } from '../src/store/postgres-async-database.js'
import { openTestStore, tempStorePath, usingPostgresStore } from './store-support.js'

let store: LocalStore | undefined
afterEach(async () => {
  await store?.close()
  store = undefined
})

async function open(): Promise<LocalStore> {
  store = await openTestStore()
  return store
}

/** A fresh agent id per case: the pool store is shared by every suite of a worker. */
const agent = (): string => `agent-${randomUUID()}`
const ORIGIN = { platform: 'slack', channel: 'C0GENERAL', transportScope: 'T0EXAMPLE' }
const MINUTE = 60_000
const HOUR = 60 * MINUTE

const key = (agentId: string, id: string, thread = checkCoordinate(id)): string =>
  sessionKey('slack', 'C0GENERAL', thread, agentId, 'T0EXAMPLE')

async function item(s: LocalStore, agentId: string, nextCheck: number | undefined, status?: 'waiting' | 'done') {
  return await s.assistantItems.create({
    agentId,
    title: 'Watch the release',
    doneWhen: 'It is out',
    ...(nextCheck !== undefined ? { nextCheck } : {}),
    ...(status ? { status } : {}),
    origin: ORIGIN,
    taskKey: key(agentId, randomUUID()),
    now: 1
  })
}

/** A check of the follow-up starts at `now`: scheduled for `nextCheck`, or messaged when that is null. */
const begin = (
  s: LocalStore,
  agentId: string,
  it1: { id: string; taskKey: string },
  now: number,
  over: { nextCheck?: number | null; observationVersion?: number; staleBefore?: number; exclusive?: boolean } = {}
) =>
  s.assistantChecks.begin(agentId, it1.id, {
    key: it1.taskKey,
    nextCheck: over.nextCheck ?? null,
    observationVersion: over.observationVersion ?? 0,
    input: null,
    now,
    staleBefore: over.staleBefore ?? 0,
    exclusive: over.exclusive ?? false
  })

const row = (agentId: string, id: string, now: number, thread?: string) => ({
  agentId,
  childSessionKey: key(agentId, id, thread),
  parentSessionId: 'sid-parent-1',
  parentSessionKey: sessionKey('slack', 'C0GENERAL', 'append:1', agentId, 'T0EXAMPLE'),
  now
})

describe('the check state', () => {
  it('finds open follow-ups whose next check is due, earliest first, and nothing else', async () => {
    const s = await open()
    const a = agent()
    const later = await item(s, a, 2_000)
    const first = await item(s, a, 500)
    await item(s, a, 9_000)
    await item(s, a, undefined)
    await item(s, a, 100, 'done')
    const waiting = await item(s, a, 700, 'waiting')
    const checking = await item(s, a, 600)
    await begin(s, a, checking, 1_000)
    await item(s, agent(), 100)
    expect(await s.assistantChecks.due(a, 5_000, 10)).toEqual([
      { itemId: first.id, nextCheck: 500 },
      { itemId: waiting.id, nextCheck: 700 },
      { itemId: later.id, nextCheck: 2_000 }
    ])
    expect(await s.assistantChecks.due(a, 5_000, 1)).toEqual([{ itemId: first.id, nextCheck: 500 }])
    // A check running since before the stale bound no longer holds its follow-up back.
    expect(await s.assistantChecks.due(a, 5_000, 10, 1_001)).toContainEqual({ itemId: checking.id, nextCheck: 600 })
  })

  it('checks one next check once, and the next value again, in the follow-up’s one session', async () => {
    const s = await open()
    const a = agent()
    const it1 = await item(s, a, 1_000)
    expect(await begin(s, a, it1, 2_000, { nextCheck: 1_000 })).toEqual({ checkNo: 1, messages: null, events: [] })
    expect(await s.assistantChecks.byRunningKey(a, it1.taskKey)).toMatchObject({
      itemId: it1.id,
      runningNextCheck: 1_000,
      runningCheck: 1,
      runningSince: 2_000
    })
    expect(await s.assistantChecks.succeed(a, it1.id, it1.taskKey, 3_000)).toBe(true)
    expect(await s.assistantChecks.byRunningKey(a, it1.taskKey)).toBeUndefined()
    expect(await s.assistantChecks.due(a, 10_000, 10)).toEqual([])
    // An overdue check is taken once however late it is.
    expect(await s.assistantChecks.due(a, 10_000_000, 10)).toEqual([])
    await s.assistantItems.schedule(a, it1.id, { status: 'active', nextCheck: 4_000 })
    expect(await s.assistantChecks.due(a, 10_000, 10)).toEqual([{ itemId: it1.id, nextCheck: 4_000 }])
    // A messaged check leaves the scheduled one due.
    expect(await begin(s, a, it1, 5_000)).toEqual({ checkNo: 2, messages: null, events: [] })
    await s.assistantChecks.succeed(a, it1.id, it1.taskKey, 5_500)
    expect(await s.assistantChecks.due(a, 10_000, 10)).toEqual([{ itemId: it1.id, nextCheck: 4_000 }])
  })

  it('backs off min(60, 2ⁿ) minutes after each failure and stops at the fifth until it is messaged', async () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => checkBackoffMs(n) / MINUTE)).toEqual([2, 4, 8, 16, 32, 60, 60])
    const s = await open()
    const a = agent()
    const it1 = await item(s, a, 1_000)
    let now = 2_000
    for (let n = 1; n <= CHECK_MAX_FAILURES; n++) {
      expect(await s.assistantChecks.due(a, now, 10)).toEqual([{ itemId: it1.id, nextCheck: 1_000 }])
      await begin(s, a, it1, now, { nextCheck: 1_000 })
      const failed = await s.assistantChecks.fail(a, it1.id, it1.taskKey, now, 1_000)
      expect(failed).toEqual({ failures: n, stopped: n === CHECK_MAX_FAILURES })
      expect(await s.assistantChecks.due(a, now + checkBackoffMs(n) - 1, 10)).toEqual([])
      now += checkBackoffMs(n)
    }
    expect(await s.assistantChecks.get(a, it1.id)).toMatchObject({ stopped: true })
    expect(await s.assistantChecks.due(a, now + 10 * 60 * MINUTE, 10)).toEqual([])
    // A new next check does not resume it; a message's check does, with a fresh streak.
    await s.assistantItems.schedule(a, it1.id, { status: 'active', nextCheck: 3_000 })
    expect(await s.assistantChecks.due(a, now, 10)).toEqual([])
    await begin(s, a, it1, now)
    expect(await s.assistantChecks.get(a, it1.id)).toMatchObject({ stopped: false, failures: 0 })
  })

  it('keeps the check’s observation baseline and report in the store until it ends', async () => {
    const s = await open()
    const a = agent()
    const it1 = await item(s, a, 1_000)
    await begin(s, a, it1, 2_000, { nextCheck: 1_000, observationVersion: 3 })
    expect(await s.assistantChecks.keepReport(a, it1.id, it1.taskKey, 'It shipped.', 2_500)).toBe(true)
    expect(await s.assistantChecks.keepReport(a, it1.id, key(a, 'other'), 'Not this check.', 2_500)).toBe(false)
    expect(await s.assistantChecks.byRunningKey(a, it1.taskKey)).toMatchObject({
      runningObservationVersion: 3,
      runningReport: 'It shipped.'
    })
    await s.assistantChecks.fail(a, it1.id, it1.taskKey, 3_000, 1_000)
    expect(await s.assistantChecks.get(a, it1.id)).toMatchObject({
      runningKey: null,
      runningObservationVersion: null,
      runningReport: null,
      runningCheck: null,
      runningSince: null
    })
    // The next check starts with no report of the last one.
    await begin(s, a, it1, 4_000, { nextCheck: 1_000, observationVersion: 4 })
    expect(await s.assistantChecks.byRunningKey(a, it1.taskKey)).toMatchObject({
      runningObservationVersion: 4,
      runningReport: null,
      runningCheck: 2
    })
  })

  it('runs one check of a follow-up at a time, a scheduled one only while none of the agent’s runs', async () => {
    const s = await open()
    const [a, b] = [agent(), agent()]
    const it1 = await item(s, a, 1_000)
    const it2 = await item(s, a, 1_000)
    const theirs = await item(s, b, 1_000)
    expect(await begin(s, a, it1, 2_000, { nextCheck: 1_000, exclusive: true })).toBeDefined()
    expect(await begin(s, a, it1, 2_100)).toBeUndefined()
    // The agent's one scheduled check is taken; a messaged check of another follow-up still starts.
    expect(await begin(s, a, it2, 2_200, { nextCheck: 1_000, exclusive: true })).toBeUndefined()
    expect(await begin(s, b, theirs, 2_200, { nextCheck: 1_000, exclusive: true })).toBeDefined()
    expect(await begin(s, a, it2, 2_300)).toBeDefined()
    await s.assistantChecks.release(a, it2.id, it2.taskKey, 2_400)
    // A check older than the stale bound no longer holds anything, and ends in the log as it was.
    expect(await begin(s, a, it2, 3_000, { nextCheck: 1_000, exclusive: true, staleBefore: 2_001 })).toBeDefined()
    expect(await begin(s, a, it1, 3_100, { staleBefore: 2_001 })).toEqual({ checkNo: 2, messages: null, events: [] })
    expect((await s.assistantChecks.checks(a, it1.id, 10)).map((c) => [c.checkNo, c.endedAt])).toEqual([
      [2, null],
      [1, 3_100]
    ])
  })

  it('logs each check, keeps the newest, and counts the agent’s for its budget', async () => {
    const s = await open()
    const [a, b] = [agent(), agent()]
    const it1 = await item(s, a, 1_000)
    // An hour apart, so the oldest checks fall out of the budget window and can be pruned.
    for (let n = 1; n <= ASSISTANT_CHECKS_KEPT + 2; n++) {
      const begun = await begin(s, a, it1, n * HOUR)
      await s.assistantChecks.endCheck(a, it1.id, begun!.checkNo, {
        observation: `seen ${n}`,
        reported: n % 2 === 0,
        now: n * HOUR + 1
      })
      await s.assistantChecks.succeed(a, it1.id, it1.taskKey, n * HOUR + 1)
    }
    const checks = await s.assistantChecks.checks(a, it1.id, 100)
    expect(checks).toHaveLength(ASSISTANT_CHECKS_KEPT)
    expect(checks[0]).toEqual({
      itemId: it1.id,
      checkNo: ASSISTANT_CHECKS_KEPT + 2,
      startedAt: (ASSISTANT_CHECKS_KEPT + 2) * HOUR,
      endedAt: (ASSISTANT_CHECKS_KEPT + 2) * HOUR + 1,
      observation: `seen ${ASSISTANT_CHECKS_KEPT + 2}`,
      reported: true,
      startedBy: 'message',
      events: []
    })
    expect(checks.at(-1)?.checkNo).toBe(3)
    await begin(s, b, await item(s, b, 1_000), 50 * HOUR)
    expect(await s.assistantChecks.checksSince(a, 50 * HOUR)).toEqual({ count: 3, oldest: 50 * HOUR })
    expect(await s.assistantChecks.checksSince(a, 999 * HOUR)).toEqual({ count: 0, oldest: null })
    // A released check says nothing, and leaves the log and the budget.
    const begun = await begin(s, a, it1, 60 * HOUR)
    await s.assistantChecks.release(a, it1.id, it1.taskKey, 60 * HOUR + 1)
    expect((await s.assistantChecks.checks(a, it1.id, 1))[0]?.checkNo).not.toBe(begun!.checkNo)
    expect((await s.assistantChecks.checksSince(a, 50 * HOUR)).count).toBe(3)
  })

  it('keeps every check the budget window counts, past the newest kept', async () => {
    const s = await open()
    const a = agent()
    const it1 = await item(s, a, 1_000)
    // A minute apart: all inside one window, so a budget above the kept count still sees them all.
    for (let n = 1; n <= ASSISTANT_CHECKS_KEPT + 10; n++) {
      const begun = await begin(s, a, it1, n * MINUTE)
      await s.assistantChecks.endCheck(a, it1.id, begun!.checkNo, {
        observation: `seen ${n}`,
        reported: false,
        now: n * MINUTE + 1
      })
      await s.assistantChecks.succeed(a, it1.id, it1.taskKey, n * MINUTE + 1)
    }
    expect((await s.assistantChecks.checksSince(a, 0)).count).toBe(ASSISTANT_CHECKS_KEPT + 10)
  })

  it('keeps messages for the next check, which takes them all', async () => {
    const s = await open()
    const a = agent()
    const it1 = await item(s, a, undefined, 'waiting')
    const closed = await item(s, a, undefined, 'done')
    await s.assistantChecks.setPendingMessages(a, it1.id, '["one"]', 1_000)
    await s.assistantChecks.setPendingMessages(a, closed.id, '["gone"]', 1_000)
    expect(await s.assistantChecks.withPendingMessages(a, 2_000, 10)).toEqual([it1.id])
    await begin(s, a, it1, 2_000)
    expect(await s.assistantChecks.withPendingMessages(a, 2_000, 10)).toEqual([])
    await s.assistantChecks.setPendingMessages(a, it1.id, '["two"]', 2_100)
    // Waiting while a check runs, and while it backs off after a failure.
    expect(await s.assistantChecks.withPendingMessages(a, 2_200, 10)).toEqual([])
    await s.assistantChecks.fail(a, it1.id, it1.taskKey, 3_000, null)
    expect(await s.assistantChecks.withPendingMessages(a, 3_000, 10)).toEqual([])
    expect(await s.assistantChecks.withPendingMessages(a, 3_000 + checkBackoffMs(1), 10)).toEqual([it1.id])
    expect(await begin(s, a, it1, 9_000_000)).toEqual({ checkNo: 2, messages: '["two"]', events: [] })
    expect((await s.assistantChecks.get(a, it1.id))?.pendingMessages).toBeNull()
  })

  it('lets only the check in flight settle the follow-up, and a release leaves the check due', async () => {
    const s = await open()
    const a = agent()
    const it1 = await item(s, a, 1_000)
    await begin(s, a, it1, 2_000, { nextCheck: 1_000 })
    expect(await s.assistantChecks.succeed(a, it1.id, key(a, 'old'), 4_000)).toBe(false)
    expect(await s.assistantChecks.fail(a, it1.id, key(a, 'old'), 4_000, 1_000)).toBeUndefined()
    await s.assistantChecks.release(a, it1.id, it1.taskKey, 4_000)
    expect(await s.assistantChecks.get(a, it1.id)).toMatchObject({ runningKey: null, failures: 0 })
    expect(await s.assistantChecks.due(a, 5_000, 10)).toEqual([{ itemId: it1.id, nextCheck: 1_000 }])
    await s.assistantChecks.skip(a, it1.id, 1_000, 5_000)
    expect(await s.assistantChecks.due(a, 5_000, 10)).toEqual([])
  })
})

describe('a follow-up’s row of the sub-session index', () => {
  it('is idle until a check runs, and never counts toward the delegation cap', async () => {
    const s = await open()
    const a = agent()
    expect(await s.assistantSubsessions.openFollowUp(row(a, '1', 1_000))).toBe(true)
    expect(await s.assistantSubsessions.openFollowUp(row(a, '1', 2_000))).toBe(false)
    expect(await s.assistantSubsessions.get(a, key(a, '1'))).toMatchObject({ state: 'done', kind: 'follow-up' })
    await s.assistantSubsessions.checking(a, key(a, '1'))
    expect(await s.assistantSubsessions.get(a, key(a, '1'))).toMatchObject({ state: 'open', createdAt: 1_000 })
    // A running check takes none of the delegations' places.
    const cap = { limit: 1, startedSince: 0 }
    const delegation = row(a, 'd1', 1_000, subsessionCoordinate('d1'))
    expect(await s.assistantSubsessions.openWithinLimit(delegation, cap)).toBe(true)
    expect(await s.assistantSubsessions.get(a, delegation.childSessionKey)).not.toHaveProperty('kind')
    expect(await s.assistantSubsessions.openWithinLimit(row(a, 'd2', 1_000, subsessionCoordinate('d2')), cap)).toBe(
      false
    )
    // A delegation's row is never turned into a check.
    await s.assistantSubsessions.finish(a, delegation.childSessionKey, 'done')
    await s.assistantSubsessions.checking(a, delegation.childSessionKey)
    expect(await s.assistantSubsessions.get(a, delegation.childSessionKey)).toMatchObject({ state: 'done' })
  })

  it('names its place’s current long session once that session takes it over', async () => {
    const s = await open()
    const a = agent()
    const mine = await item(s, a, undefined)
    const elsewhere = await s.assistantItems.create({
      agentId: a,
      title: 'Elsewhere',
      origin: { ...ORIGIN, channel: 'C0OTHER' },
      taskKey: sessionKey('slack', 'C0OTHER', checkCoordinate('x'), a, 'T0EXAMPLE')
    })
    for (const followUp of [mine, elsewhere])
      await s.assistantSubsessions.openFollowUp({ ...row(a, 'x', 1_000), childSessionKey: followUp.taskKey })
    const owner = { sessionId: 'sid-current', key: sessionKey('slack', 'C0GENERAL', 'append:2', a, 'T0EXAMPLE') }
    await s.assistantSubsessions.adoptFollowUps(a, ORIGIN, owner)
    expect(await s.assistantSubsessions.get(a, mine.taskKey)).toMatchObject({
      parentSessionId: 'sid-current',
      parentSessionKey: owner.key
    })
    expect(await s.assistantSubsessions.get(a, elsewhere.taskKey)).toMatchObject({ parentSessionId: 'sid-parent-1' })
  })
})

describe('the place a follow-up belongs to', () => {
  it('is the append session in force, else the place’s only session', async () => {
    const s = await open()
    const a = agent()
    const session = (channel: string, thread: string) => ({
      key: sessionKey('slack', channel, thread, a, 'T0EXAMPLE'),
      agentId: a,
      platform: 'slack',
      channel,
      thread,
      transportScope: 'T0EXAMPLE',
      acpSessionId: null,
      state: 'idle' as const,
      lastDeliveredTs: null,
      updatedAt: 1
    })
    const coordinate = await s.resolveAppendCoordinate(a, 'C1', 'T0EXAMPLE', 1)
    expect(await s.placeSession(a, 'slack', 'C1', 'T0EXAMPLE')).toBeUndefined()
    await s.upsertSession(session('C1', coordinate))
    await s.upsertSession(session('C1', '100.1'))
    expect((await s.placeSession(a, 'slack', 'C1', 'T0EXAMPLE'))?.thread).toBe(coordinate)
    // No append session: one session is the place's, several threads are not one conversation.
    await s.upsertSession(session('D1', 'webchat:D1'))
    await s.upsertSession(session('D1', checkCoordinate('1')))
    expect((await s.placeSession(a, 'slack', 'D1', 'T0EXAMPLE'))?.thread).toBe('webchat:D1')
    await s.upsertSession(session('C2', '100.1'))
    await s.upsertSession(session('C2', '100.2'))
    expect(await s.placeSession(a, 'slack', 'C2', 'T0EXAMPLE')).toBeUndefined()
    expect(await s.placeSession(a, 'slack', 'C3', 'T0EXAMPLE')).toBeUndefined()
  })
})

/** A first look of the place (assistant-mode.md §5.13), due at `nextCheck`. */
async function firstLook(s: LocalStore, agentId: string, nextCheck: number, now = 1) {
  return await s.assistantItems.create({
    agentId,
    title: 'First look at general',
    nextCheck,
    origin: ORIGIN,
    taskKey: key(agentId, randomUUID(), firstLookCoordinate(randomUUID())),
    firstLook: 'joined',
    now
  })
}

describe('a first look in the follow-up tables', () => {
  it('is marked, left out of a follow-ups-only list, and found as its place’s newest', async () => {
    const s = await open()
    const a = agent()
    const followUp = await item(s, a, 500)
    expect(followUp.firstLook).toBeNull()
    const older = await firstLook(s, a, 500, 1)
    const newer = await firstLook(s, a, 500, 2)
    expect(newer.firstLook).toBe('joined')
    expect((await s.assistantItems.list(a, { followUpsOnly: true })).map((i) => i.id)).toEqual([followUp.id])
    expect((await s.assistantItems.latestFirstLook(a, ORIGIN))?.id).toBe(newer.id)
    expect(older.id).not.toBe(newer.id)
    expect(await s.assistantItems.latestFirstLook(a, { ...ORIGIN, channel: 'C0OTHER' })).toBeUndefined()
    await expect(
      s.assistantItems.create({ agentId: a, title: 't', origin: ORIGIN, taskKey: 'k', firstLook: 'later' as never })
    ).rejects.toThrow('firstLook')
  })

  it('is checked only once no follow-up’s check is due', async () => {
    const s = await open()
    const a = agent()
    const look = await firstLook(s, a, 100)
    const followUp = await item(s, a, 500)
    expect((await s.assistantChecks.due(a, 1_000, 10)).map((d) => d.itemId)).toEqual([followUp.id, look.id])
    expect((await s.assistantChecks.due(a, 300, 10)).map((d) => d.itemId)).toEqual([look.id])
  })

  it('grants a running check its history up to the cap, and none to a check that is not running', async () => {
    const s = await open()
    const a = agent()
    const look = await firstLook(s, a, 100)
    const started = await begin(s, a, look, 1_000, { nextCheck: 100 })
    expect(await s.assistantChecks.takeHistory(a, look.id, started!.checkNo, 300, 500)).toBe(300)
    expect(await s.assistantChecks.takeHistory(a, look.id, started!.checkNo, 300, 500)).toBe(200)
    expect(await s.assistantChecks.takeHistory(a, look.id, started!.checkNo, 10, 500)).toBe(0)
    expect(await s.assistantChecks.takeHistory(a, look.id, started!.checkNo + 1, 10, 500)).toBe(0)
  })

  it('is never a dream’s source', async () => {
    const s = await open()
    const a = agent()
    const row = (thread: string, acp: string) => ({
      key: key(a, acp, thread),
      agentId: a,
      platform: 'slack',
      channel: 'C0GENERAL',
      thread,
      transportScope: 'T0EXAMPLE',
      acpSessionId: acp,
      state: 'idle' as const,
      lastDeliveredTs: null,
      updatedAt: 1
    })
    await s.upsertSession(row('append:1', `acp-${randomUUID()}`))
    await s.upsertSession(row(firstLookCoordinate('1'), `acp-${randomUUID()}`))
    expect((await s.dreamSessionSources(a, 10)).map((source) => source.thread)).toEqual(['append:1'])
  })
})

describe.skipIf(usingPostgresStore())('the v38 → v39 patrol schema on SQLite', () => {
  it('marks the existing sub-sessions as delegations and adds the patrol state', async () => {
    const path = tempStorePath('ac-assistant-v38-')
    await (await LocalStore.open(path)).close()
    const a = agent()
    const old = new DatabaseSync(path)
    old.exec(
      'ALTER TABLE assistant_subsession DROP COLUMN kind; DROP TABLE assistant_check_state; PRAGMA user_version = 38'
    )
    old
      .prepare(
        `INSERT INTO assistant_subsession (agentId, childSessionKey, parentSessionId, parentSessionKey, state, createdAt)
         VALUES (?, ?, 'sid-parent-1', 'parent', 'open', 1000)`
      )
      .run(a, key(a, 'd', subsessionCoordinate('d')))
    old.close()

    const upgraded = await LocalStore.open(path)
    try {
      const delegation = await upgraded.assistantSubsessions.get(a, key(a, 'd', subsessionCoordinate('d')))
      expect(delegation).toMatchObject({ state: 'open' })
      expect(delegation).not.toHaveProperty('kind')
      // The old row still counts toward the cap, and no patrol is in its way.
      expect(
        await upgraded.assistantSubsessions.openWithinLimit(row(a, 'd2', 1_000, subsessionCoordinate('d2')), {
          limit: 1,
          startedSince: 0
        })
      ).toBe(false)
      expect(await upgraded.assistantSubsessions.openFollowUp(row(a, 'p', 1_000))).toBe(true)
      const it1 = await item(upgraded, a, 500)
      expect(await upgraded.assistantChecks.due(a, 1_000, 10)).toEqual([{ itemId: it1.id, nextCheck: 500 }])
      await begin(upgraded, a, it1, 1_000, { nextCheck: 500 })
      expect(await upgraded.assistantChecks.keepReport(a, it1.id, it1.taskKey, 'It shipped.', 1_000)).toBe(true)
      expect(await upgraded.assistantChecks.byRunningKey(a, it1.taskKey)).toMatchObject({
        runningObservationVersion: 0,
        runningReport: 'It shipped.'
      })
    } finally {
      await upgraded.close()
    }
    const db = new DatabaseSync(path)
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION)
    db.close()
  })

  it('adds the column to a store that skipped v38 straight to the current schema', async () => {
    const path = tempStorePath('ac-assistant-v37p-')
    await (await LocalStore.open(path)).close()
    const old = new DatabaseSync(path)
    old.exec('DROP TABLE assistant_subsession; DROP TABLE assistant_check_state; PRAGMA user_version = 37')
    old.close()
    const upgraded = await LocalStore.open(path)
    const a = agent()
    try {
      expect(await upgraded.assistantSubsessions.openFollowUp(row(a, 'p', 1_000))).toBe(true)
      expect(await upgraded.assistantSubsessions.get(a, key(a, 'p'))).toMatchObject({ kind: 'follow-up' })
    } finally {
      await upgraded.close()
    }
  })
})

describe.skipIf(!usingPostgresStore())('the v38 → v39 patrol schema on PostgreSQL', () => {
  it('marks the existing sub-sessions as delegations and adds the patrol state', async () => {
    const databaseUrl = process.env.DATA_PLANE_TEST_DATABASE_URL!
    const schema = `mig_${randomUUID().replace(/-/g, '')}`
    const config = { version: 1 as const, databaseUrl, maxConnections: 2 }
    const orgForAgent = (): string => 'org-a'
    const admin = new pg.Client({ connectionString: databaseUrl })
    await admin.connect()
    const a = agent()
    try {
      const fresh = await PostgresAsyncDatabase.open(config, () => undefined, schema)
      await fresh.finishSchemaInitialization()
      const first = await LocalStore.open({ database: fresh, shared: true, ownerId: 'm1', orgForAgent })
      await first.close()

      await admin.query(`SET search_path TO ${schema}`)
      await admin.query('ALTER TABLE assistant_subsession DROP COLUMN kind')
      await admin.query('DROP TABLE assistant_check_state')
      await admin.query(
        `INSERT INTO assistant_subsession (agentId, childSessionKey, parentSessionId, parentSessionKey, state, createdAt)
         VALUES ($1, $2, 'sid-parent-1', 'parent', 'open', 1000)`,
        [a, key(a, 'd', subsessionCoordinate('d'))]
      )
      await admin.query('UPDATE _local_store_schema_version SET version = 38 WHERE singleton = true')

      const database = await PostgresAsyncDatabase.open(config, () => undefined, schema)
      await database.finishSchemaInitialization()
      const upgraded = await LocalStore.open({ database, shared: true, ownerId: 'm2', orgForAgent })
      try {
        expect(await upgraded.assistantSubsessions.get(a, key(a, 'd', subsessionCoordinate('d')))).not.toHaveProperty(
          'kind'
        )
        expect(
          await upgraded.assistantSubsessions.openWithinLimit(row(a, 'd2', 1_000, subsessionCoordinate('d2')), {
            limit: 1,
            startedSince: 0
          })
        ).toBe(false)
        expect(await upgraded.assistantSubsessions.openFollowUp(row(a, 'p', 1_000))).toBe(true)
        const it1 = await item(upgraded, a, 500)
        await begin(upgraded, a, it1, 1_000, { nextCheck: 500 })
        expect(await upgraded.assistantChecks.keepReport(a, it1.id, it1.taskKey, 'It shipped.', 1_000)).toBe(true)
        expect(await upgraded.assistantChecks.byRunningKey(a, it1.taskKey)).toMatchObject({
          itemId: it1.id,
          runningNextCheck: 500,
          runningObservationVersion: 0,
          runningReport: 'It shipped.'
        })
      } finally {
        await upgraded.close()
      }
      const version = await admin.query('SELECT version FROM _local_store_schema_version')
      expect(Number(version.rows[0].version)).toBe(SCHEMA_VERSION)
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined)
      await admin.end()
    }
  })
})

/** A follow-up and a first look as a v57 store holds them: items, a running check, the index row, sessions and outward ids. */
async function seedChecks(s: LocalStore, a: string) {
  const followUp = await s.assistantItems.create({
    agentId: a,
    title: 'Watch the release',
    origin: ORIGIN,
    taskKey: key(a, 'p1'),
    now: 1
  })
  const look = await s.assistantItems.create({
    agentId: a,
    title: 'First look',
    origin: ORIGIN,
    taskKey: key(a, 'l1', firstLookCoordinate('l1')),
    firstLook: 'joined',
    now: 1
  })
  await begin(s, a, followUp, 1_000)
  await s.assistantSubsessions.openFollowUp(row(a, 'p1', 1_000))
  for (const [taskKey, thread] of [
    [followUp.taskKey, checkCoordinate('p1')],
    [look.taskKey, firstLookCoordinate('l1')]
  ] as const) {
    await s.upsertSession({
      key: taskKey,
      agentId: a,
      platform: 'slack',
      channel: 'C0GENERAL',
      thread,
      transportScope: 'T0EXAMPLE',
      acpSessionId: `acp-${randomUUID()}`,
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1
    })
    await s.ensureOutwardSessionId(taskKey, a, 1)
  }
  return { followUp, look }
}

/** What v57 must leave: the new table, column, kind and coordinates on every row seeded above. */
async function expectChecks(s: LocalStore, a: string, seeded: Awaited<ReturnType<typeof seedChecks>>) {
  expect(await s.assistantItems.get(a, seeded.followUp.id)).toMatchObject({ taskKey: key(a, 'p1') })
  expect(await s.assistantChecks.byRunningKey(a, key(a, 'p1'))).toMatchObject({
    itemId: seeded.followUp.id,
    checkedNextCheck: null,
    runningCheck: 1
  })
  expect(await s.assistantSubsessions.get(a, key(a, 'p1'))).toMatchObject({ kind: 'follow-up' })
  expect(await s.getSession(key(a, 'p1'))).toMatchObject({ thread: checkCoordinate('p1') })
  expect(await s.getSession(key(a, 'l1', firstLookCoordinate('l1')))).toMatchObject({
    thread: firstLookCoordinate('l1')
  })
}

describe.skipIf(usingPostgresStore())('the v56 → v57 check names on SQLite', () => {
  /** Each text column in a store, skipping SQLite's own and virtual tables. */
  const textColumns = (db: DatabaseSync): [string, string][] =>
    (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL%'"
        )
        .all() as { name: string }[]
    ).flatMap(({ name }) =>
      (db.prepare(`PRAGMA table_info(${name})`).all() as { name: string; type: string }[])
        .filter((c) => c.type.toUpperCase() === 'TEXT')
        .map((c): [string, string] => [name, c.name])
    )

  it('renames the check state and rewrites every stored check coordinate', async () => {
    const path = tempStorePath('ac-assistant-v56-')
    const a = agent()
    const fresh = await LocalStore.open(path)
    const seeded = await seedChecks(fresh, a)
    await fresh.close()
    // Back to what a v56 daemon wrote, with a queued check message and a transcript row of its session.
    const old = new DatabaseSync(path)
    old.exec(
      'ALTER TABLE assistant_check_state RENAME TO assistant_patrol; ' +
        'ALTER TABLE assistant_patrol RENAME COLUMN checkedNextCheck TO patrolledNextCheck; ' +
        "UPDATE assistant_subsession SET kind = 'patrol' WHERE kind = 'follow-up'"
    )
    for (const [table, column] of textColumns(old))
      old.exec(`UPDATE ${table} SET ${column} = replace(${column}, 'subsession:check-', 'subsession:patrol-')`)
    const oldKey = key(a, 'p1', 'subsession:patrol-p1')
    old
      .prepare('INSERT INTO inbox (id, sessionKey, agentId, msg, enqueuedAt) VALUES (?, ?, ?, ?, ?)')
      .run(
        'inbox-1',
        oldKey,
        a,
        JSON.stringify({ msgId: 'patrol:C0GENERAL:1:check-2', thread: 'subsession:patrol-p1' }),
        '1'
      )
    old
      .prepare(
        "INSERT INTO transcript (channel, thread, sender, kind, text, sessionScope) VALUES (?, ?, ?, 'tool', '', ?)"
      )
      .run('C0GENERAL', 'subsession:patrol-p1', a, oldKey)
    old.exec('PRAGMA user_version = 56')
    old.close()

    const upgraded = await LocalStore.open(path)
    try {
      await expectChecks(upgraded, a, seeded)
    } finally {
      await upgraded.close()
    }
    const db = new DatabaseSync(path)
    try {
      const left = textColumns(db).filter(
        ([table, column]) =>
          db.prepare(`SELECT 1 FROM ${table} WHERE ${column} LIKE '%subsession:patrol-%'`).all().length > 0
      )
      expect(left).toEqual([])
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'assistant_patrol'").all()).toEqual([])
      const inbox = db.prepare("SELECT sessionKey, msg FROM inbox WHERE id = 'inbox-1'").get() as {
        sessionKey: string
        msg: string
      }
      expect(inbox.sessionKey).toBe(key(a, 'p1'))
      expect(JSON.parse(inbox.msg)).toMatchObject({ thread: checkCoordinate('p1') })
    } finally {
      db.close()
    }
  })
})

describe.skipIf(!usingPostgresStore())('the v56 → v57 check names on PostgreSQL', () => {
  it('renames the check state and rewrites every stored check coordinate', async () => {
    const databaseUrl = process.env.DATA_PLANE_TEST_DATABASE_URL!
    const schema = `mig_${randomUUID().replace(/-/g, '')}`
    const config = { version: 1 as const, databaseUrl, maxConnections: 2 }
    const orgForAgent = (): string => 'org-a'
    const admin = new pg.Client({ connectionString: databaseUrl })
    await admin.connect()
    const a = agent()
    const textColumns = async (): Promise<[string, string][]> =>
      (
        await admin.query(
          `SELECT table_name, column_name FROM information_schema.columns
            WHERE table_schema = $1 AND data_type IN ('text', 'character varying')`,
          [schema]
        )
      ).rows.map((r: { table_name: string; column_name: string }): [string, string] => [r.table_name, r.column_name])
    try {
      const fresh = await PostgresAsyncDatabase.open(config, () => undefined, schema)
      await fresh.finishSchemaInitialization()
      const first = await LocalStore.open({ database: fresh, shared: true, ownerId: 'm1', orgForAgent })
      const seeded = await seedChecks(first, a)
      await first.close()

      await admin.query(`SET search_path TO ${schema}`)
      await admin.query('ALTER TABLE assistant_check_state RENAME TO assistant_patrol')
      await admin.query('ALTER TABLE assistant_patrol RENAME COLUMN checkednextcheck TO patrollednextcheck')
      await admin.query("UPDATE assistant_subsession SET kind = 'patrol' WHERE kind = 'follow-up'")
      for (const [table, column] of await textColumns())
        await admin.query(
          `UPDATE ${table} SET ${column} = replace(${column}, 'subsession:check-', 'subsession:patrol-')`
        )
      await admin.query('UPDATE _local_store_schema_version SET version = 56 WHERE singleton = true')

      const database = await PostgresAsyncDatabase.open(config, () => undefined, schema)
      await database.finishSchemaInitialization()
      const upgraded = await LocalStore.open({ database, shared: true, ownerId: 'm2', orgForAgent })
      try {
        await expectChecks(upgraded, a, seeded)
      } finally {
        await upgraded.close()
      }
      const left: string[] = []
      for (const [table, column] of await textColumns())
        if ((await admin.query(`SELECT 1 FROM ${table} WHERE ${column} LIKE '%subsession:patrol-%'`)).rows.length > 0)
          left.push(`${table}.${column}`)
      expect(left).toEqual([])
      const version = await admin.query('SELECT version FROM _local_store_schema_version')
      expect(Number(version.rows[0].version)).toBe(SCHEMA_VERSION)
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined)
      await admin.end()
    }
  })
})

describe.skipIf(usingPostgresStore())('the v54 → v55 first-look schema on SQLite', () => {
  it('adds the first-look marker and the history count to a v54 store', async () => {
    const path = tempStorePath('ac-assistant-v54-')
    await (await LocalStore.open(path)).close()
    const old = new DatabaseSync(path)
    old.exec(
      'ALTER TABLE assistant_item DROP COLUMN firstLook; ALTER TABLE assistant_check DROP COLUMN historyRead; ' +
        'PRAGMA user_version = 54'
    )
    old.close()
    const upgraded = await LocalStore.open(path)
    const a = agent()
    try {
      const look = await firstLook(upgraded, a, 100)
      expect((await upgraded.assistantItems.get(a, look.id))?.firstLook).toBe('joined')
      const started = await begin(upgraded, a, look, 1_000, { nextCheck: 100 })
      expect(await upgraded.assistantChecks.takeHistory(a, look.id, started!.checkNo, 10, 500)).toBe(10)
    } finally {
      await upgraded.close()
    }
    const db = new DatabaseSync(path)
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION)
    db.close()
  })
})

describe.skipIf(!usingPostgresStore())('the v54 → v55 first-look schema on PostgreSQL', () => {
  it('adds the first-look marker and the history count to a v54 store', async () => {
    const databaseUrl = process.env.DATA_PLANE_TEST_DATABASE_URL!
    const schema = `mig_${randomUUID().replace(/-/g, '')}`
    const config = { version: 1 as const, databaseUrl, maxConnections: 2 }
    const orgForAgent = (): string => 'org-a'
    const admin = new pg.Client({ connectionString: databaseUrl })
    await admin.connect()
    const a = agent()
    try {
      const fresh = await PostgresAsyncDatabase.open(config, () => undefined, schema)
      await fresh.finishSchemaInitialization()
      await (await LocalStore.open({ database: fresh, shared: true, ownerId: 'm1', orgForAgent })).close()
      await admin.query(`SET search_path TO ${schema}`)
      await admin.query('ALTER TABLE assistant_item DROP COLUMN firstlook')
      await admin.query('ALTER TABLE assistant_check DROP COLUMN historyread')
      await admin.query('UPDATE _local_store_schema_version SET version = 54 WHERE singleton = true')
      const database = await PostgresAsyncDatabase.open(config, () => undefined, schema)
      await database.finishSchemaInitialization()
      const upgraded = await LocalStore.open({ database, shared: true, ownerId: 'm2', orgForAgent })
      try {
        const look = await firstLook(upgraded, a, 100)
        expect((await upgraded.assistantItems.get(a, look.id))?.firstLook).toBe('joined')
        const started = await begin(upgraded, a, look, 1_000, { nextCheck: 100 })
        expect(await upgraded.assistantChecks.takeHistory(a, look.id, started!.checkNo, 10, 500)).toBe(10)
      } finally {
        await upgraded.close()
      }
      const version = await admin.query('SELECT version FROM _local_store_schema_version')
      expect(Number(version.rows[0].version)).toBe(SCHEMA_VERSION)
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined)
      await admin.end()
    }
  })
})

describe('event wake in the check state (assistant-mode.md §5.14)', () => {
  const wake = (wakeId: number, kinds: Array<'merged' | 'checks' | 'comment'>, latestAt: number, now = latestAt) => ({
    wakeId,
    kinds,
    latestAt,
    now,
    staleBefore: 0
  })
  const start = (
    s: LocalStore,
    agentId: string,
    it1: { id: string; taskKey: string },
    now: number,
    startedBy: 'time' | 'message' | 'wake'
  ) =>
    s.assistantChecks.begin(agentId, it1.id, {
      key: it1.taskKey,
      nextCheck: null,
      observationVersion: 0,
      input: null,
      now,
      staleBefore: 0,
      exclusive: false,
      startedBy
    })

  it('records a wake once per wakeId and folds a later one into the waiting wake', async () => {
    const s = await open()
    const a = agent()
    const it1 = await item(s, a, undefined, 'waiting')
    expect(await s.assistantChecks.recordWake(a, it1.id, wake(1, ['merged'], 1_000))).toBe('recorded')
    expect(await s.assistantChecks.recordWake(a, it1.id, wake(1, ['merged'], 1_000))).toBe('duplicate')
    expect(await s.assistantChecks.recordWake(a, it1.id, wake(2, ['checks', 'merged'], 2_000))).toBe('recorded')
    expect(await s.assistantChecks.get(a, it1.id)).toMatchObject({
      wakeId: 2,
      wakeAt: 1_000,
      wakeKinds: ['merged', 'checks'],
      wakeLatestAt: 2_000
    })
    expect(await s.assistantChecks.wokenDue(a, 3_000, 10, 0, 3_000)).toEqual([it1.id])
  })

  it('counts a new subscription’s wakes afresh, so watching again loses none of its events', async () => {
    const s = await open()
    const a = agent()
    const it1 = await item(s, a, undefined, 'waiting')
    const on = (subscription: number, wakeId: number, at: number) => ({ ...wake(wakeId, ['merged'], at), subscription })
    expect(await s.assistantChecks.recordWake(a, it1.id, on(7, 5, 1_000))).toBe('recorded')
    // Stopped and watched again: the Control Plane's new subscription counts from 1.
    expect(await s.assistantChecks.recordWake(a, it1.id, on(9, 1, 2_000))).toBe('recorded')
    expect(await s.assistantChecks.recordWake(a, it1.id, on(9, 1, 2_000))).toBe('duplicate')
    expect(await s.assistantChecks.get(a, it1.id)).toMatchObject({ wakeId: 1, wakeSubscription: 9 })
  })

  it('drops a wake the check running since before its events answers, and keeps one with a later event', async () => {
    const s = await open()
    const a = agent()
    const it1 = await item(s, a, undefined, 'waiting')
    await start(s, a, it1, 5_000, 'message')
    expect(await s.assistantChecks.recordWake(a, it1.id, wake(1, ['comment'], 4_000, 6_000))).toBe('answered')
    expect((await s.assistantChecks.get(a, it1.id))?.wakeAt).toBeNull()
    expect(await s.assistantChecks.recordWake(a, it1.id, wake(2, ['merged'], 7_000))).toBe('recorded')
    // It waits for the running check to end.
    expect(await s.assistantChecks.wokenDue(a, 8_000, 10, 0, 8_000)).toEqual([])
    await s.assistantChecks.succeed(a, it1.id, it1.taskKey, 9_000)
    expect(await s.assistantChecks.wokenDue(a, 9_000, 10, 0, 9_000)).toEqual([it1.id])
  })

  it('lets any check take the wake along, logs what started it, and spaces woken checks apart', async () => {
    const s = await open()
    const a = agent()
    const it1 = await item(s, a, undefined, 'waiting')
    // A wake starts nothing while none waits.
    expect(await start(s, a, it1, 1_000, 'wake')).toBeUndefined()
    await s.assistantChecks.recordWake(a, it1.id, wake(1, ['merged'], 2_000))
    expect(await start(s, a, it1, 3_000, 'wake')).toEqual({ checkNo: 1, messages: null, events: ['merged'] })
    expect(await s.assistantChecks.get(a, it1.id)).toMatchObject({
      wakeAt: null,
      wakeKinds: [],
      lastWokenAt: 3_000,
      runningWake: ['merged']
    })
    await s.assistantChecks.succeed(a, it1.id, it1.taskKey, 4_000)
    expect((await s.assistantChecks.checks(a, it1.id, 1))[0]).toMatchObject({ startedBy: 'wake', events: ['merged'] })

    await s.assistantChecks.recordWake(a, it1.id, wake(2, ['checks'], 5_000))
    expect(await s.assistantChecks.wokenDue(a, 6_000, 10, 0, 6_000 - 15 * MINUTE)).toEqual([])
    expect(await s.assistantChecks.wokenDue(a, 3_000 + 15 * MINUTE, 10, 0, 3_000)).toEqual([it1.id])
    // A message's check takes the waiting wake with it and counts once.
    await s.assistantChecks.setPendingMessages(a, it1.id, '["look again"]', 7_000)
    expect(await start(s, a, it1, 8_000, 'message')).toEqual({
      checkNo: 2,
      messages: '["look again"]',
      events: ['checks']
    })
    expect(await s.assistantChecks.wokenDue(a, 3_000 + 15 * MINUTE, 10, 9_000, 3_000)).toEqual([])
  })

  it('puts back the wake of a check that did not finish, due at once', async () => {
    const s = await open()
    const a = agent()
    const it1 = await item(s, a, undefined, 'waiting')
    await s.assistantChecks.recordWake(a, it1.id, wake(1, ['merged'], 1_000))
    await start(s, a, it1, 2_000, 'wake')
    const running = (await s.assistantChecks.get(a, it1.id))!
    await s.assistantChecks.release(a, it1.id, it1.taskKey, 3_000)
    await s.assistantChecks.recordWake(a, it1.id, wake(2, ['comment'], 3_500))
    await s.assistantChecks.restoreWake(a, it1.id, running.runningWake, 4_000)
    expect(await s.assistantChecks.get(a, it1.id)).toMatchObject({
      wakeAt: 3_500,
      wakeKinds: ['merged', 'comment'],
      runningWake: []
    })
  })

  it('keeps what a follow-up watches, and lists the open ones whose watch is taken or waits', async () => {
    const s = await open()
    const a = agent()
    const watched = await item(s, a, undefined, 'waiting')
    const refused = await item(s, a, undefined, 'waiting')
    const ended = await item(s, a, undefined, 'done')
    const url = 'https://github.com/example-org/example-repo/pull/12'
    expect(
      await s.assistantItems.setWatch(a, watched.id, {
        url,
        target: 'example-org/example-repo#12',
        state: 'watching',
        reason: null,
        repoId: '456'
      })
    ).toBe(true)
    await s.assistantItems.setWatch(a, refused.id, { url, target: null, state: 'refused', reason: 'no_access' })
    expect(await s.assistantItems.setWatch(a, ended.id, { url, target: null, state: 'pending', reason: null })).toBe(
      false
    )
    expect((await s.assistantItems.get(a, watched.id))?.watch).toEqual({
      url,
      target: 'example-org/example-repo#12',
      state: 'watching',
      reason: null,
      repoId: '456'
    })
    expect(await s.assistantItems.watching(a)).toEqual([{ id: watched.id, url }])
    await s.assistantItems.setWatch(a, watched.id, null)
    expect((await s.assistantItems.get(a, watched.id))?.watch).toBeNull()
  })
})

describe.skipIf(usingPostgresStore())('the v60 → v61 event wake schema on SQLite', () => {
  it('adds the watch, the waiting wake, what started each check and a proposal’s watch to a v60 store', async () => {
    const path = tempStorePath('ac-assistant-v60-')
    await (await LocalStore.open(path)).close()
    const old = new DatabaseSync(path)
    old.exec(
      [
        'ALTER TABLE assistant_item DROP COLUMN watchUrl',
        'ALTER TABLE assistant_item DROP COLUMN watchTarget',
        'ALTER TABLE assistant_item DROP COLUMN watchState',
        'ALTER TABLE assistant_item DROP COLUMN watchReason',
        'ALTER TABLE assistant_check_state DROP COLUMN wakeId',
        'ALTER TABLE assistant_check_state DROP COLUMN wakeAt',
        'ALTER TABLE assistant_check_state DROP COLUMN wakeKinds',
        'ALTER TABLE assistant_check_state DROP COLUMN wakeLatestAt',
        'ALTER TABLE assistant_check_state DROP COLUMN lastWokenAt',
        'ALTER TABLE assistant_check_state DROP COLUMN runningWake',
        'ALTER TABLE assistant_check DROP COLUMN startedBy',
        'ALTER TABLE assistant_check DROP COLUMN events',
        'ALTER TABLE assistant_draft DROP COLUMN followUpWatch',
        'PRAGMA user_version = 60'
      ].join('; ')
    )
    old.close()
    const upgraded = await LocalStore.open(path)
    const a = agent()
    try {
      const it1 = await item(upgraded, a, undefined, 'waiting')
      await upgraded.assistantItems.setWatch(a, it1.id, {
        url: 'https://github.com/example-org/example-repo/issues/7',
        target: null,
        state: 'pending',
        reason: null
      })
      expect(
        await upgraded.assistantChecks.recordWake(a, it1.id, {
          wakeId: 1,
          kinds: ['closed'],
          latestAt: 1_000,
          now: 1_000,
          staleBefore: 0
        })
      ).toBe('recorded')
      expect((await upgraded.assistantItems.get(a, it1.id))?.watch?.state).toBe('pending')
    } finally {
      await upgraded.close()
    }
    const db = new DatabaseSync(path)
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION)
    db.close()
  })
})

describe.skipIf(usingPostgresStore())('the v61 → v62 watched repository id on SQLite', () => {
  it('adds the id a check’s code-host reads aim at to a v61 store', async () => {
    const path = tempStorePath('ac-assistant-v61-')
    await (await LocalStore.open(path)).close()
    const old = new DatabaseSync(path)
    old.exec('ALTER TABLE assistant_item DROP COLUMN watchRepoId; PRAGMA user_version = 61')
    old.close()
    const upgraded = await LocalStore.open(path)
    const a = agent()
    try {
      const it1 = await item(upgraded, a, undefined, 'waiting')
      const url = 'https://gitlab.example.test/example-group/example-project/-/merge_requests/3'
      await upgraded.assistantItems.setWatch(a, it1.id, {
        url,
        target: 'x',
        state: 'watching',
        reason: null,
        repoId: '4455667'
      })
      expect((await upgraded.assistantItems.get(a, it1.id))?.watch?.repoId).toBe('4455667')
    } finally {
      await upgraded.close()
    }
    const db = new DatabaseSync(path)
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION)
    db.close()
  })
})
