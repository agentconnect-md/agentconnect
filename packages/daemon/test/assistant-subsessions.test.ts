// The assistant-mode sub-session index (assistant-mode.md §5.6): one contract suite, run on SQLite by default and on PostgreSQL by store-postgres.
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import pg from 'pg'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import { subsessionCoordinate } from '../src/session/subsession-coordinate.js'
import { LocalStore, SCHEMA_VERSION, sessionKey } from '../src/store/local-store.js'
import { PostgresAsyncDatabase } from '../src/store/postgres-async-database.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
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

const childKey = (agentId: string, id: string): string =>
  sessionKey('slack', 'C0GENERAL', subsessionCoordinate(id), agentId, 'T0EXAMPLE')

const row = (agentId: string, id: string, parentSessionId = 'sid-parent-1') => ({
  agentId,
  childSessionKey: childKey(agentId, id),
  parentSessionId,
  parentSessionKey: sessionKey('slack', 'C0GENERAL', 'append:1', agentId, 'T0EXAMPLE'),
  now: 1_000
})

describe('the assistant sub-session index', () => {
  it('records a delegation once, partitioned by agent', async () => {
    const s = await open()
    const a = agent()
    expect(await s.assistantSubsessions.open(row(a, '1'))).toBe(true)
    expect(await s.assistantSubsessions.open({ ...row(a, '1', 'sid-other'), now: 2_000 })).toBe(false)
    expect(await s.assistantSubsessions.get(a, childKey(a, '1'))).toEqual({
      agentId: a,
      childSessionKey: childKey(a, '1'),
      parentSessionId: 'sid-parent-1',
      parentSessionKey: sessionKey('slack', 'C0GENERAL', 'append:1', a, 'T0EXAMPLE'),
      state: 'open',
      createdAt: 1_000
    })
    expect(await s.assistantSubsessions.get(agent(), childKey(a, '1'))).toBeUndefined()
  })

  it('drops only the removed agent’s rows', async () => {
    const s = await open()
    const [a, b] = [agent(), agent()]
    await s.assistantSubsessions.open(row(a, '1'))
    await s.assistantSubsessions.open(row(a, '2'))
    await s.assistantSubsessions.open(row(b, '1'))
    expect(await s.assistantSubsessions.deleteForAgent(a)).toBe(2)
    expect(await s.assistantSubsessions.get(a, childKey(a, '1'))).toBeUndefined()
    expect(await s.assistantSubsessions.get(b, childKey(b, '1'))).toBeDefined()
  })

  it('drops a child’s row when its session is purged, and keeps its siblings', async () => {
    const s = await open()
    const a = agent()
    await s.assistantSubsessions.open(row(a, '1'))
    await s.assistantSubsessions.open(row(a, '2'))
    for (const id of ['1', '2']) {
      await s.upsertSession({
        key: childKey(a, id),
        agentId: a,
        platform: 'slack',
        channel: 'C0GENERAL',
        thread: subsessionCoordinate(id),
        transportScope: 'T0EXAMPLE',
        acpSessionId: `acp-${id}`,
        state: 'idle',
        lastDeliveredTs: null,
        updatedAt: 1_000
      })
    }
    expect(await s.deleteSession(childKey(a, '1'))).toBe(true)
    expect(await s.assistantSubsessions.get(a, childKey(a, '1'))).toBeUndefined()
    expect(await s.assistantSubsessions.get(a, childKey(a, '2'))).toBeDefined()
  })

  it('settles an open row once, to done or failed', async () => {
    const s = await open()
    const a = agent()
    await s.assistantSubsessions.open(row(a, '1'))
    await s.assistantSubsessions.open(row(a, '2'))
    expect(await s.assistantSubsessions.finish(a, childKey(a, '1'), 'done')).toBe(true)
    expect(await s.assistantSubsessions.finish(a, childKey(a, '1'), 'failed')).toBe(false)
    expect(await s.assistantSubsessions.finish(a, childKey(a, '2'), 'failed')).toBe(true)
    expect(await s.assistantSubsessions.finish(a, childKey(a, '3'), 'done')).toBe(false)
    expect((await s.assistantSubsessions.get(a, childKey(a, '1')))?.state).toBe('done')
    expect((await s.assistantSubsessions.get(a, childKey(a, '2')))?.state).toBe('failed')
  })

  it('opens below the limit only, counting the agent’s own open rows', async () => {
    const s = await open()
    const [a, b] = [agent(), agent()]
    const cap = { limit: 2, startedSince: 0 }
    expect(await s.assistantSubsessions.openWithinLimit(row(a, '1'), cap)).toBe(true)
    expect(await s.assistantSubsessions.openWithinLimit(row(a, '2'), cap)).toBe(true)
    expect(await s.assistantSubsessions.openWithinLimit(row(a, '3'), cap)).toBe(false)
    expect(await s.assistantSubsessions.get(a, childKey(a, '3'))).toBeUndefined()
    // Another agent's sub-sessions are its own.
    expect(await s.assistantSubsessions.openWithinLimit(row(b, '1'), cap)).toBe(true)
    // A settled row frees its place.
    await s.assistantSubsessions.finish(a, childKey(a, '1'), 'failed')
    expect(await s.assistantSubsessions.openWithinLimit(row(a, '3'), cap)).toBe(true)
    expect(await s.assistantSubsessions.get(a, childKey(a, '3'))).toMatchObject({ state: 'open', createdAt: 1_000 })
  })

  it('stops counting an open row whose session never appeared, once it is past the start grace', async () => {
    const s = await open()
    const a = agent()
    await s.assistantSubsessions.open(row(a, 'lost'))
    await s.assistantSubsessions.open(row(a, 'running'))
    await s.upsertSession({
      key: childKey(a, 'running'),
      agentId: a,
      platform: 'slack',
      channel: 'C0GENERAL',
      thread: subsessionCoordinate('running'),
      transportScope: 'T0EXAMPLE',
      acpSessionId: 'acp-running',
      state: 'prompting',
      lastDeliveredTs: null,
      updatedAt: 1_000
    })
    // Both rows were opened at 1_000: within the grace both count, past it only the one with a session does.
    const next = { ...row(a, 'next'), now: 2_000 }
    expect(await s.assistantSubsessions.openWithinLimit(next, { limit: 2, startedSince: 1_000 })).toBe(false)
    expect(await s.assistantSubsessions.openWithinLimit(next, { limit: 2, startedSince: 1_001 })).toBe(true)
    // The new row, still within its grace, counts beside the running one.
    expect(await s.assistantSubsessions.openWithinLimit(row(a, 'after'), { limit: 2, startedSince: 1_001 })).toBe(false)
  })

  it('lists the agent’s open rows first, then the newest, within the limit', async () => {
    const s = await open()
    const [a, b] = [agent(), agent()]
    await s.assistantSubsessions.open({ ...row(a, 'old-open'), now: 1_000 })
    await s.assistantSubsessions.open({ ...row(a, 'done'), now: 3_000 })
    await s.assistantSubsessions.open({ ...row(a, 'new-open'), now: 2_000 })
    await s.assistantSubsessions.open({ ...row(a, 'failed'), now: 4_000 })
    await s.assistantSubsessions.open(row(b, 'other'))
    await s.assistantSubsessions.finish(a, childKey(a, 'done'), 'done')
    await s.assistantSubsessions.finish(a, childKey(a, 'failed'), 'failed')
    const listed = await s.assistantSubsessions.list(a, 10)
    expect(listed.map((r) => [r.childSessionKey, r.state])).toEqual([
      [childKey(a, 'new-open'), 'open'],
      [childKey(a, 'old-open'), 'open'],
      [childKey(a, 'failed'), 'failed'],
      [childKey(a, 'done'), 'done']
    ])
    expect((await s.assistantSubsessions.list(a, 2)).map((r) => r.state)).toEqual(['open', 'open'])
  })

  it('lists one conversation’s rows newest first and pages from a row, ties broken by key', async () => {
    const s = await open()
    const [a, b] = [agent(), agent()]
    await s.assistantSubsessions.open({ ...row(a, '1'), now: 1_000 })
    await s.assistantSubsessions.open({ ...row(a, '3'), now: 2_000 })
    await s.assistantSubsessions.open({ ...row(a, '2'), now: 2_000 })
    await s.assistantSubsessions.open({ ...row(a, '4'), now: 3_000 })
    await s.assistantSubsessions.open({ ...row(a, 'elsewhere', 'sid-parent-2'), now: 4_000 })
    await s.assistantSubsessions.open({ ...row(b, '9'), now: 5_000 })
    await s.assistantSubsessions.finish(a, childKey(a, '4'), 'done')
    const keys = (rows: { childSessionKey: string }[]) => rows.map((r) => r.childSessionKey)

    const all = await s.assistantSubsessions.listForParent(a, 'sid-parent-1', { limit: 10 })
    expect(keys(all)).toEqual([childKey(a, '4'), childKey(a, '2'), childKey(a, '3'), childKey(a, '1')])
    const first = await s.assistantSubsessions.listForParent(a, 'sid-parent-1', { limit: 2 })
    expect(keys(first)).toEqual([childKey(a, '4'), childKey(a, '2')])
    const last = first.at(-1)!
    const next = await s.assistantSubsessions.listForParent(a, 'sid-parent-1', {
      limit: 2,
      after: { createdAt: last.createdAt, childSessionKey: last.childSessionKey }
    })
    expect(keys(next)).toEqual([childKey(a, '3'), childKey(a, '1')])
    expect(await s.assistantSubsessions.listForParent(b, 'sid-parent-1', { limit: 10 })).toEqual([
      expect.objectContaining({ childSessionKey: childKey(b, '9') })
    ])
    expect(await s.assistantSubsessions.listForParent(a, 'sid-unknown', { limit: 10 })).toEqual([])
  })

  it('lists every row reporting to one owning session by id and key, running first, with the total', async () => {
    const s = await open()
    const [a, b] = [agent(), agent()]
    const index = s.assistantSubsessions
    const owner = { sessionId: 'sid-parent-1', key: row(a, 'x').parentSessionKey }
    await index.open({ ...row(a, 'done'), now: 1_000 })
    await index.open({ ...row(a, 'task-approved'), now: 2_000 })
    await index.openFollowUp({ ...row(a, 'check-1'), now: 3_000 })
    await index.open({ ...row(a, 'running'), now: 500 })
    await index.finish(a, childKey(a, 'done'), 'done')
    await index.finish(a, childKey(a, 'check-1'), 'failed')
    // Another owner by id, the same id on another key (a session recreated elsewhere), and another agent.
    await index.open({ ...row(a, 'elsewhere', 'sid-parent-2'), now: 4_000 })
    await index.open({ ...row(a, 'other-key'), parentSessionKey: 'slack:C0GENERAL:append:2:x', now: 4_000 })
    await index.open({ ...row(b, 'theirs'), now: 4_000 })
    const keys = (rows: { childSessionKey: string }[]) => rows.map((r) => r.childSessionKey)

    const all = await index.listForOwner(a, owner, 10)
    expect(all.total).toBe(4)
    expect(keys(all.rows)).toEqual([
      childKey(a, 'task-approved'),
      childKey(a, 'running'),
      childKey(a, 'check-1'),
      childKey(a, 'done')
    ])
    expect(all.rows.find((r) => r.childSessionKey === childKey(a, 'check-1'))).toMatchObject({ kind: 'follow-up' })
    // A session that does not own its place's follow-ups lists none of them.
    const without = await index.listForOwner(a, owner, 10, { followUps: false })
    expect([keys(without.rows), without.total]).toEqual([
      [childKey(a, 'task-approved'), childKey(a, 'running'), childKey(a, 'done')],
      3
    ])
    const capped = await index.listForOwner(a, owner, 1)
    expect([keys(capped.rows), capped.total]).toEqual([[childKey(a, 'task-approved')], 4])
    // Past the running ones, a task whose session changed last comes first, however long ago it opened.
    await s.upsertSession({
      key: childKey(a, 'done'),
      agentId: a,
      platform: 'slack',
      channel: 'C0GENERAL',
      thread: subsessionCoordinate('done'),
      transportScope: 'T0EXAMPLE',
      acpSessionId: 'acp-done',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 9_000
    })
    expect(keys((await index.listForOwner(a, owner, 10)).rows).slice(2)).toEqual([
      childKey(a, 'done'),
      childKey(a, 'check-1')
    ])
    expect(await index.listForOwner(a, { ...owner, sessionId: 'sid-unknown' }, 10)).toEqual({ rows: [], total: 0 })
    expect(await index.listForOwner(b, owner, 10)).toEqual({ rows: [], total: 0 })
  })

  it('leaves out what a delegation opened for a session that delegates no task (auto-session-mode.md §5.1)', async () => {
    const s = await open()
    const a = agent()
    const index = s.assistantSubsessions
    const owner = { sessionId: 'sid-parent-1', key: row(a, 'x').parentSessionKey }
    await index.open({ ...row(a, 'delegated'), now: 1_000 })
    await index.open({ ...row(a, 'research-1'), now: 2_000 })
    await index.open({ ...row(a, 'task-approved'), now: 3_000 })
    await index.openFollowUp({ ...row(a, 'check-1'), now: 4_000 })
    const keys = (rows: { childSessionKey: string }[]) => rows.map((r) => r.childSessionKey).sort()
    const own = await index.listForOwner(a, owner, 10, { delegatedTasks: false })
    expect([keys(own.rows), own.total]).toEqual([
      [childKey(a, 'check-1'), childKey(a, 'research-1'), childKey(a, 'task-approved')].sort(),
      3
    ])
    const delegations = await index.listForOwner(a, owner, 10, { followUps: false, delegatedTasks: false })
    expect([keys(delegations.rows), delegations.total]).toEqual([
      [childKey(a, 'research-1'), childKey(a, 'task-approved')].sort(),
      2
    ])
    expect((await index.listForOwner(a, owner, 10)).total).toBe(4)
  })
})

describe('the failure report a sub-session index row holds (assistant-mode.md §5.7)', () => {
  it('holds a claimed report in `reporting`, counts its refused attempts, and settles it once', async () => {
    const s = await open()
    const [a, b] = [agent(), agent()]
    const index = s.assistantSubsessions
    await index.open(row(a, '1'))
    await index.open(row(a, '2'))
    expect(await index.claimReport(a, childKey(a, '1'), '{"text":"ended"}')).toBe(true)
    expect(await index.claimReport(a, childKey(a, '1'), '{"text":"again"}')).toBe(false)
    // Out of `open`, nothing else settles it: neither its own report nor a second claim.
    expect(await index.finish(a, childKey(a, '1'), 'done')).toBe(false)
    expect(await index.get(a, childKey(a, '1'))).toMatchObject({ state: 'reporting', endReport: '{"text":"ended"}' })
    expect(await index.get(a, childKey(a, '1'))).not.toHaveProperty('reportAttempts')

    expect(await index.countReportAttempt(a, childKey(a, '1'))).toBe(1)
    expect(await index.countReportAttempt(a, childKey(a, '1'))).toBe(2)
    expect(await index.countReportAttempt(a, childKey(a, '2'))).toBeUndefined()
    expect((await index.listReporting(a)).map((r) => [r.childSessionKey, r.reportAttempts])).toEqual([
      [childKey(a, '1'), 2]
    ])
    expect(await index.listReporting(b)).toEqual([])
    // A row whose turn has ended is no longer running, so it frees its place under the cap.
    expect(await index.openWithinLimit(row(a, '3'), { limit: 2, startedSince: 0 })).toBe(true)

    expect(await index.settleReport(a, childKey(a, '1'))).toBe(true)
    expect(await index.settleReport(a, childKey(a, '1'))).toBe(false)
    expect(await index.settleReport(a, childKey(a, '2'))).toBe(false)
    expect(await index.get(a, childKey(a, '1'))).toMatchObject({ state: 'failed', reportAttempts: 2 })
    expect(await index.listReporting(a)).toEqual([])
    expect(await index.countReportAttempt(a, childKey(a, '1'))).toBeUndefined()
  })

  it('lists the open delegations with no delivery left in the inbox, oldest first', async () => {
    const s = await open()
    const [a, b] = [agent(), agent()]
    const index = s.assistantSubsessions
    await index.open({ ...row(a, '1'), now: 2_000 })
    for (const id of ['2', '3', '4']) await index.open(row(a, id))
    await index.openFollowUp(row(a, 'check-5'))
    await index.checking(a, childKey(a, 'check-5'))
    await index.open(row(b, '6'))
    await index.finish(a, childKey(a, '3'), 'done')
    const kept = `inbox-${a}`
    await s.appendInbox({ id: kept, sessionKey: childKey(a, '4'), agentId: a, msg: '{}', enqueuedAt: '1' })

    const listed = async () => (await index.listOpenWithoutInbox(a)).map((r) => r.childSessionKey)
    expect(await listed()).toEqual([childKey(a, '2'), childKey(a, '1')])
    await s.removeInbox(kept)
    expect(await listed()).toEqual([childKey(a, '2'), childKey(a, '4'), childKey(a, '1')])
  })
})

describe('work rounds and parent inputs (send-message-guide.md §8.4, §8.6)', () => {
  it('reopens a settled row as its next round only below the limit, and only from the round it names', async () => {
    const s = await open()
    const a = agent()
    const index = s.assistantSubsessions
    const cap = { limit: 1, startedSince: 0 }
    await index.open(row(a, '1'))
    await index.open(row(a, '2'))
    expect(await index.finish(a, childKey(a, '1'), 'done')).toBe(true)
    // Row 2 still runs, so round 2 of row 1 waits for a slot.
    expect(await index.reopenWithinLimit(a, childKey(a, '1'), 1, cap)).toBe('limit')
    expect(await index.get(a, childKey(a, '1'))).toMatchObject({ state: 'done' })
    expect(await index.reopenWithinLimit(a, childKey(a, '2'), 1, cap)).toBe('changed')
    await index.finish(a, childKey(a, '2'), 'failed')
    expect(await index.reopenWithinLimit(a, childKey(a, '1'), 2, cap)).toBe('changed')
    expect(await index.reopenWithinLimit(a, childKey(a, '1'), 1, cap)).toBe('opened')
    expect(await index.get(a, childKey(a, '1'))).toMatchObject({ state: 'open', round: 2 })
    expect(await index.reopenWithinLimit(a, childKey(a, '2'), 1, cap)).toBe('limit')
    // A guard on the round: an older round's settlement or report claim changes nothing.
    expect(await index.finish(a, childKey(a, '1'), 'failed', 1)).toBe(false)
    expect(await index.claimReport(a, childKey(a, '1'), '{"text":"old"}', 1)).toBe(false)
    expect(await index.claimReport(a, childKey(a, '1'), '{"text":"new","round":2}', 2)).toBe(true)
    expect(await index.settleReport(a, childKey(a, '1'), 'done')).toBe(true)
    expect(await index.get(a, childKey(a, '1'))).toMatchObject({ state: 'done', round: 2 })
  })

  it('claims one submission once and keeps its receipt, dropped with the agent', async () => {
    const s = await open()
    const a = agent()
    const index = s.assistantSubsessions
    expect(await index.claimInput(a, 'sub-1', childKey(a, '1'), 1_000)).toBe(true)
    expect(await index.claimInput(a, 'sub-1', childKey(a, '1'), 1_001)).toBe(false)
    expect(await index.getInput(a, 'sub-1')).toEqual({
      agentId: a,
      submissionId: 'sub-1',
      childSessionKey: childKey(a, '1'),
      round: 0
    })
    await index.settleInput(a, 'sub-1', 2, '{"delivered":true}')
    expect(await index.getInput(a, 'sub-1')).toMatchObject({ round: 2, receipt: '{"delivered":true}' })
    await index.deleteForAgent(a)
    expect(await index.getInput(a, 'sub-1')).toBeUndefined()
  })
})

describe('the thread a task’s round reports in (assistant-mode.md §5.7)', () => {
  it('keeps the asking turn’s thread from the open, replaces it per round, and clears it', async () => {
    const s = await open()
    const a = agent()
    const index = s.assistantSubsessions
    await index.openWithinLimit({ ...row(a, '1'), replyThread: '200.1' }, { limit: 3, startedSince: 0 })
    await index.open(row(a, '2'))
    expect(await index.get(a, childKey(a, '1'))).toMatchObject({ replyThread: '200.1' })
    expect(await index.get(a, childKey(a, '2'))).not.toHaveProperty('replyThread')
    await index.setReplyThread(a, childKey(a, '1'), '300.1')
    expect(await index.get(a, childKey(a, '1'))).toMatchObject({ replyThread: '300.1' })
    await index.setReplyThread(a, childKey(a, '1'), null)
    expect(await index.get(a, childKey(a, '1'))).not.toHaveProperty('replyThread')
  })
})

describe('the task model: title, summary and attached threads (auto-session-mode.md §6)', () => {
  const thread = (a: string, id: string, ts: string, sinceRound = 1) => ({
    agentId: a,
    childSessionKey: childKey(a, id),
    platform: 'slack',
    channel: 'C0GENERAL',
    transportScope: 'T0EXAMPLE',
    thread: ts,
    sinceRound,
    now: 2_000
  })

  it('keeps the title a task opened with, and its summary with the turns since', async () => {
    const s = await open()
    const a = agent()
    const index = s.assistantSubsessions
    await index.openWithinLimit({ ...row(a, '1'), title: 'Fix the flaky test' }, { limit: 3, startedSince: 0 })
    expect(await index.get(a, childKey(a, '1'))).toMatchObject({ title: 'Fix the flaky test' })
    expect(await index.get(a, childKey(a, '1'))).not.toHaveProperty('summary')
    expect(await index.countTurn(a, childKey(a, '1'))).toBe(1)
    expect(await index.countTurn(a, childKey(a, '1'))).toBe(2)
    expect(
      await index.setSummary(a, childKey(a, '1'), { summary: 'Scope: the e2e test. Status: in progress.', now: 3_000 })
    ).toBe(true)
    expect(await index.get(a, childKey(a, '1'))).toMatchObject({
      title: 'Fix the flaky test',
      summary: 'Scope: the e2e test. Status: in progress.',
      summaryUpdatedAt: 3_000
    })
    expect(await index.get(a, childKey(a, '1'))).not.toHaveProperty('turnsSinceSummary')
    // The title changes only together with the summary.
    await index.setSummary(a, childKey(a, '1'), { summary: 'Done.', title: 'Flaky test fixed', now: 4_000 })
    expect(await index.get(a, childKey(a, '1'))).toMatchObject({ title: 'Flaky test fixed', summary: 'Done.' })
    await expect(index.setSummary(a, childKey(a, '1'), { summary: 'x'.repeat(501), now: 5_000 })).rejects.toThrow(
      /at most 500/
    )
    // The summary replaces the opening message's start, which is kept beside it.
    expect(await index.get(a, childKey(a, '1'))).not.toHaveProperty('background')
    expect(await index.setSummary(a, childKey(a, 'missing'), { summary: 'x', now: 5_000 })).toBe(false)
    expect(await index.countTurn(a, childKey(a, 'missing'))).toBeUndefined()
  })

  it('keeps the start of the message a task opened with, cut to a summary’s length', async () => {
    const s = await open()
    const a = agent()
    const index = s.assistantSubsessions
    await index.open({ ...row(a, '1'), background: '  write the release notes\n' })
    await index.openWithinLimit({ ...row(a, '2'), background: 'é'.repeat(600) }, { limit: 3, startedSince: 0 })
    await index.open({ ...row(a, '3'), background: '   ' })
    expect(await index.get(a, childKey(a, '1'))).toMatchObject({ background: 'write the release notes' })
    const cut = (await index.get(a, childKey(a, '2')))!.background!
    expect([...cut]).toHaveLength(500)
    expect(cut.endsWith('é…')).toBe(true)
    expect(await index.get(a, childKey(a, '3'))).not.toHaveProperty('background')
  })

  it('attaches a thread to one task only, finds the task by its thread, and releases them', async () => {
    const s = await open()
    const a = agent()
    const index = s.assistantSubsessions
    await index.open(row(a, '1'))
    await index.open(row(a, '2'))
    expect(await index.attachThread(thread(a, '1', '100.1'))).toBe(true)
    expect(await index.attachThread({ ...thread(a, '1', '100.2'), now: 3_000 })).toBe(true)
    // A thread already attached stays with its task, and an unknown task takes none.
    expect(await index.attachThread(thread(a, '2', '100.1'))).toBe(false)
    expect(await index.attachThread(thread(a, 'missing', '100.3'))).toBe(false)
    expect((await index.threadsOf(a, childKey(a, '1'))).map((t) => t.thread)).toEqual(['100.1', '100.2'])
    expect(await index.threadsOf(a, childKey(a, '1'))).toContainEqual({
      agentId: a,
      childSessionKey: childKey(a, '1'),
      platform: 'slack',
      channel: 'C0GENERAL',
      transportScope: 'T0EXAMPLE',
      thread: '100.1',
      sinceRound: 1,
      attachedAt: 2_000
    })
    const at = { platform: 'slack', channel: 'C0GENERAL', transportScope: 'T0EXAMPLE', thread: '100.2' }
    expect(await index.taskOfThread(a, at)).toBe(childKey(a, '1'))
    expect(await index.taskOfThread(a, { ...at, transportScope: null })).toBeUndefined()
    expect(await index.taskOfThread(agent(), at)).toBeUndefined()
    expect(await index.detachThreads(a, childKey(a, '1'))).toBe(2)
    expect(await index.taskOfThread(a, at)).toBeUndefined()
    // A released thread can be attached again.
    expect(await index.attachThread(thread(a, '2', '100.1'))).toBe(true)
  })

  it('keeps a threaded task out of the cap and its reports, from the round its first thread names', async () => {
    const s = await open()
    const a = agent()
    const index = s.assistantSubsessions
    const cap = { limit: 1, startedSince: 0 }
    expect(await index.openWithinLimit(row(a, '1'), cap)).toBe(true)
    expect(await index.openWithinLimit(row(a, '2'), cap)).toBe(false)
    expect(await index.reportsRound(a, childKey(a, '1'), 1)).toBe(true)
    // The round running when the thread attaches still reports once; later rounds do not.
    expect(await index.attachThread(thread(a, '1', '100.1', 2))).toBe(true)
    expect(await index.reportsRound(a, childKey(a, '1'), 1)).toBe(true)
    expect(await index.reportsRound(a, childKey(a, '1'), 2)).toBe(false)
    expect(await index.openWithinLimit(row(a, '2'), cap)).toBe(true)
    // A threaded task's next round opens whatever runs; a background one's still waits for a slot.
    await index.finish(a, childKey(a, '1'), 'done')
    expect(await index.reopenWithinLimit(a, childKey(a, '1'), 1, cap)).toBe('opened')
    expect(await index.open(row(a, '3'))).toBe(true)
    await index.finish(a, childKey(a, '3'), 'done')
    expect(await index.reopenWithinLimit(a, childKey(a, '3'), 1, cap)).toBe('limit')
  })

  it('knows a session still has a background task of its own running or reporting', async () => {
    const s = await open()
    const a = agent()
    const index = s.assistantSubsessions
    const parentKey = childKey(a, 'parent')
    const nested = (id: string) => ({ ...row(a, id), parentSessionKey: parentKey })
    expect(await index.hasRunningChildren(a, parentKey)).toBe(false)
    await index.open(nested('1'))
    expect(await index.hasRunningChildren(a, parentKey)).toBe(true)
    expect(await index.hasRunningChildren(agent(), parentKey)).toBe(false)
    await index.claimReport(a, childKey(a, '1'), '{"text":"ended"}')
    expect(await index.hasRunningChildren(a, parentKey)).toBe(true)
    await index.settleReport(a, childKey(a, '1'), 'done')
    expect(await index.hasRunningChildren(a, parentKey)).toBe(false)
    // A threaded child reports to its threads, never to this session.
    await index.open(nested('2'))
    await index.attachThread(thread(a, '2', '100.1'))
    expect(await index.hasRunningChildren(a, parentKey)).toBe(false)
  })

  it('runs a threaded task again on its next turn, in its next round, and leaves a background one to its parent', async () => {
    const s = await open()
    const a = agent()
    const index = s.assistantSubsessions
    await index.open(row(a, '1'))
    await index.open(row(a, '2'))
    await index.attachThread(thread(a, '1', '100.1'))
    // Already running.
    expect(await index.resumeThreaded(a, childKey(a, '1'))).toBe(false)
    await index.finish(a, childKey(a, '1'), 'done')
    await index.finish(a, childKey(a, '2'), 'done')
    expect(await index.resumeThreaded(a, childKey(a, '1'))).toBe(true)
    expect(await index.get(a, childKey(a, '1'))).toMatchObject({ state: 'open', round: 2 })
    expect(await index.resumeThreaded(a, childKey(a, '2'))).toBe(false)
    expect(await index.get(a, childKey(a, '2'))).toMatchObject({ state: 'done' })
    expect(await index.resumeThreaded(a, childKey(a, 'missing'))).toBe(false)
  })

  it('hands one parent’s threaded tasks to another and leaves its background ones (auto-session-mode.md §8)', async () => {
    const s = await open()
    const a = agent()
    const index = s.assistantSubsessions
    for (const id of ['threaded', 'background']) await index.open(row(a, id))
    await index.attachThread(thread(a, 'threaded', '100.1'))
    const successor = { sessionId: 'sid-parent-2', key: sessionKey('slack', 'C0GENERAL', 'append:2', a, 'T0EXAMPLE') }
    expect(await index.adoptThreaded(a, row(a, 'threaded').parentSessionKey, successor)).toEqual([
      row(a, 'threaded').childSessionKey
    ])
    expect(await index.get(a, childKey(a, 'threaded'))).toMatchObject({
      parentSessionId: successor.sessionId,
      parentSessionKey: successor.key
    })
    expect(await index.get(a, childKey(a, 'background'))).toMatchObject({ parentSessionId: 'sid-parent-1' })
    expect(await index.adoptThreaded(agent(), successor.key, successor)).toEqual([])
  })

  it('closes the settled threaded tasks idle past a time, whose threads become unowned (auto-session-mode.md §6.5)', async () => {
    const s = await open()
    const a = agent()
    const index = s.assistantSubsessions
    const ids = ['idle', 'unstarted', 'active', 'running', 'background']
    for (const id of ids) await index.open({ ...row(a, id), now: 1_000 })
    for (const [n, id] of ['idle', 'unstarted', 'active', 'running'].entries())
      await index.attachThread(thread(a, id, `100.${n}`))
    for (const id of ['idle', 'unstarted', 'active', 'background']) await index.finish(a, childKey(a, id), 'done')
    for (const [id, updatedAt] of [
      ['idle', 2_000],
      ['active', 9_000]
    ] as const)
      await s.upsertSession({
        key: childKey(a, id),
        agentId: a,
        platform: 'slack',
        channel: 'C0GENERAL',
        thread: subsessionCoordinate(id),
        transportScope: 'T0EXAMPLE',
        acpSessionId: `acp-${id}`,
        state: 'idle',
        lastDeliveredTs: null,
        updatedAt
      })
    expect((await index.closeIdleThreaded(a, 5_000)).sort()).toEqual(
      [childKey(a, 'idle'), childKey(a, 'unstarted')].sort()
    )
    expect(await index.get(a, childKey(a, 'idle'))).toBeUndefined()
    const at = { platform: 'slack', channel: 'C0GENERAL', transportScope: 'T0EXAMPLE', thread: '100.0' }
    expect(await index.taskOfThread(a, at)).toBeUndefined()
    for (const id of ['active', 'running', 'background']) expect(await index.get(a, childKey(a, id))).toBeDefined()
    expect(await index.taskOfThread(a, { ...at, thread: '100.2' })).toBe(childKey(a, 'active'))
    expect(await index.closeIdleThreaded(a, 5_000)).toEqual([])
  })

  it('adopts a conversation’s recent unowned thread sessions and releases them again (auto-session-mode.md §3.5)', async () => {
    const s = await open()
    const a = agent()
    const index = s.assistantSubsessions
    const conversation = { platform: 'slack', channel: 'C0GENERAL', transportScope: 'T0EXAMPLE' }
    const onThread = (ts: string, channel = 'C0GENERAL') => sessionKey('slack', channel, ts, a, 'T0EXAMPLE')
    const seed = async (thread: string, over: Partial<Parameters<LocalStore['upsertSession']>[0]> = {}) =>
      await s.upsertSession({
        key: onThread(thread, over.channel),
        agentId: a,
        platform: 'slack',
        channel: 'C0GENERAL',
        thread,
        transportScope: 'T0EXAMPLE',
        acpSessionId: `acp-${thread}`,
        state: 'idle',
        lastDeliveredTs: null,
        updatedAt: 9_000,
        ...over
      })
    await seed('100.1')
    await s.setSessionTitle(onThread('100.1'), 'Fix the flaky test')
    await seed('100.2', { state: 'prompting' })
    await seed('100.3', { updatedAt: 1_000 })
    await seed('100.4', { originSessionId: 'sid-caller' })
    await seed(subsessionCoordinate('bg'))
    await seed('append:5')
    await seed('100.6', { channel: 'C0OTHER' })
    // A thread another task already holds is not adopted with its session.
    await seed('100.7')
    await index.open({ ...row(a, 'holder'), now: 1_000 })
    await index.attachThread(thread(a, 'holder', '100.7'))

    const found = await index.unownedThreadSessions(a, conversation, 5_000)
    expect(found).toEqual([
      { key: onThread('100.1'), thread: '100.1', title: 'Fix the flaky test', running: false },
      { key: onThread('100.2'), thread: '100.2', running: true }
    ])
    const parent = { parentSessionId: 'sid-coordinator', parentSessionKey: 'coordinator-key' }
    for (const session of found)
      expect(
        await index.adoptThreadSession({
          agentId: a,
          childSessionKey: session.key,
          ...parent,
          title: session.title ?? 'Conversation',
          ...conversation,
          thread: session.thread,
          running: session.running,
          now: 9_500
        })
      ).toBe(true)
    expect(await index.get(a, onThread('100.1'))).toMatchObject({ title: 'Fix the flaky test', state: 'done' })
    expect(await index.get(a, onThread('100.2'))).toMatchObject({ title: 'Conversation', state: 'open' })
    expect(await index.taskOfThread(a, { ...conversation, thread: '100.1' })).toBe(onThread('100.1'))
    expect(await index.unownedThreadSessions(a, conversation, 5_000)).toEqual([])
    // A thread held by another task refuses the adoption, which leaves no row behind.
    expect(
      await index.adoptThreadSession({
        agentId: a,
        childSessionKey: onThread('100.7'),
        ...parent,
        ...conversation,
        thread: '100.7',
        running: false,
        now: 9_500
      })
    ).toBe(false)
    expect(await index.get(a, onThread('100.7'))).toBeUndefined()

    expect(await index.threadedConversations(a)).toEqual([conversation])
    const tasks = await index.threadedTasksIn(a, conversation)
    expect(tasks.map((task) => task.childSessionKey).sort()).toEqual(
      [onThread('100.1'), onThread('100.2'), childKey(a, 'holder')].sort()
    )
    expect(tasks.find((task) => task.childSessionKey === onThread('100.1'))?.parentSessionKey).toBe('coordinator-key')
    for (const task of tasks) expect(await index.closeTask(a, task.childSessionKey)).toBe(true)
    expect(await index.closeTask(a, onThread('100.1'))).toBe(false)
    expect(await index.get(a, onThread('100.1'))).toBeUndefined()
    expect(await index.threadsOf(a, onThread('100.1'))).toEqual([])
    expect(await index.threadedConversations(a)).toEqual([])
  })

  it('lists and retires a conversation’s coordinator only while it is still the one in force', async () => {
    const s = await open()
    const a = agent()
    const coordinator = await s.resolveAppendCoordinate(a, 'C0GENERAL', 'T0EXAMPLE', 1_000, 'coordinator')
    await s.resolveAppendCoordinate(a, 'C0APPEND', 'T0EXAMPLE', 1_000)
    expect(await s.coordinatorReservations(a)).toEqual([
      { channel: 'C0GENERAL', transportScope: 'T0EXAMPLE', coordinate: coordinator }
    ])
    expect(await s.retireCoordinator(a, 'C0GENERAL', 'T0EXAMPLE', 'append:coordinator-1')).toBe(false)
    expect(await s.retireCoordinator(a, 'C0GENERAL', 'T0EXAMPLE', coordinator)).toBe(true)
    expect(await s.coordinatorReservations(a)).toEqual([])
    expect(await s.currentAppendCoordinate(a, 'C0GENERAL', 'T0EXAMPLE')).toBeUndefined()
    // A later switch back mints a coordinator of its own.
    expect(await s.resolveAppendCoordinate(a, 'C0GENERAL', 'T0EXAMPLE', 2_000, 'coordinator')).not.toBe(coordinator)
  })

  it('drops a task’s threads with its agent and with its purged session', async () => {
    const s = await open()
    const a = agent()
    const index = s.assistantSubsessions
    await index.open(row(a, '1'))
    await index.attachThread(thread(a, '1', '100.1'))
    await s.upsertSession({
      key: childKey(a, '1'),
      agentId: a,
      platform: 'slack',
      channel: 'C0GENERAL',
      thread: subsessionCoordinate('1'),
      transportScope: 'T0EXAMPLE',
      acpSessionId: 'acp-1',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1_000
    })
    expect(await s.deleteSession(childKey(a, '1'))).toBe(true)
    expect(await index.threadsOf(a, childKey(a, '1'))).toEqual([])
    // A threaded task on its own platform thread leaves the index with its purged session too (auto-session-mode.md §6.5).
    const onThread = sessionKey('slack', 'C0GENERAL', '100.5', a, 'T0EXAMPLE')
    await index.open({ ...row(a, 'x'), childSessionKey: onThread })
    await index.attachThread({ ...thread(a, 'x', '100.5'), childSessionKey: onThread })
    await s.upsertSession({
      key: onThread,
      agentId: a,
      platform: 'slack',
      channel: 'C0GENERAL',
      thread: '100.5',
      transportScope: 'T0EXAMPLE',
      acpSessionId: 'acp-5',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1_000
    })
    expect(await s.deleteSession(onThread)).toBe(true)
    expect(await index.get(a, onThread)).toBeUndefined()
    expect(
      await index.taskOfThread(a, {
        platform: 'slack',
        channel: 'C0GENERAL',
        transportScope: 'T0EXAMPLE',
        thread: '100.5'
      })
    ).toBeUndefined()
    await index.open(row(a, '2'))
    await index.attachThread(thread(a, '2', '100.2'))
    await index.deleteForAgent(a)
    expect(await index.threadsOf(a, childKey(a, '2'))).toEqual([])
  })
})

describe.skipIf(usingPostgresStore())('the v70 → v72 task model on SQLite', () => {
  it('adds the columns and the thread table, titling each task from its session', async () => {
    const path = tempStorePath('ac-assistant-v70-')
    await (await LocalStore.open(path)).close()
    const a = agent()
    const old = new DatabaseSync(path)
    old.exec(`DROP TABLE assistant_subsession_thread;
      ALTER TABLE assistant_subsession DROP COLUMN title;
      ALTER TABLE assistant_subsession DROP COLUMN summary;
      ALTER TABLE assistant_subsession DROP COLUMN summaryUpdatedAt;
      ALTER TABLE assistant_subsession DROP COLUMN turnsSinceSummary;
      ALTER TABLE assistant_subsession DROP COLUMN background;
      PRAGMA user_version = 70`)
    const insert = old.prepare(
      `INSERT INTO assistant_subsession (agentId, childSessionKey, parentSessionId, parentSessionKey, state, createdAt)
       VALUES (?, ?, 'sid-parent-1', 'parent', 'done', 1000)`
    )
    insert.run(a, childKey(a, 'titled'))
    insert.run(a, childKey(a, 'untitled'))
    old
      .prepare(
        "INSERT INTO sessions (key, agentId, platform, channel, thread, title) VALUES (?, ?, 'slack', 'C0GENERAL', ?, ?)"
      )
      .run(childKey(a, 'titled'), a, subsessionCoordinate('titled'), 'fix the flaky test and open a PR')
    old.close()

    const upgraded = await LocalStore.open(path)
    try {
      const index = upgraded.assistantSubsessions
      expect(await index.get(a, childKey(a, 'titled'))).toMatchObject({ title: 'fix the flaky test and open a PR' })
      expect(await index.get(a, childKey(a, 'untitled'))).not.toHaveProperty('title')
      expect(await index.attachThread({ ...threadAt(a, 'titled'), now: 2_000 })).toBe(true)
      expect(await index.setSummary(a, childKey(a, 'untitled'), { summary: 'Done.', now: 2_000 })).toBe(true)
      await index.open({ ...row(a, 'new'), background: 'sort the backlog' })
      expect(await index.get(a, childKey(a, 'new'))).toMatchObject({ background: 'sort the backlog' })
    } finally {
      await upgraded.close()
    }
    const db = new DatabaseSync(path)
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION)
    db.close()
  })

  const threadAt = (a: string, id: string) => ({
    agentId: a,
    childSessionKey: childKey(a, id),
    platform: 'slack',
    channel: 'C0GENERAL',
    thread: '100.1',
    sinceRound: 1
  })
})

describe.skipIf(!usingPostgresStore())('the v70 → v72 task model on PostgreSQL', () => {
  it('adds the columns and the thread table, titling each task from its session', async () => {
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
      await admin.query('DROP TABLE assistant_subsession_thread')
      await admin.query(
        'ALTER TABLE assistant_subsession DROP COLUMN title, DROP COLUMN summary, DROP COLUMN summaryUpdatedAt, DROP COLUMN turnsSinceSummary, DROP COLUMN background'
      )
      await admin.query(
        `INSERT INTO assistant_subsession (agentId, childSessionKey, parentSessionId, parentSessionKey, state, createdAt)
         VALUES ($1, $2, 'sid-parent-1', 'parent', 'done', 1000)`,
        [a, childKey(a, '1')]
      )
      await admin.query(
        "INSERT INTO sessions (key, agentId, platform, channel, thread, title) VALUES ($1, $2, 'slack', 'C0GENERAL', $3, $4)",
        [childKey(a, '1'), a, subsessionCoordinate('1'), 'fix the flaky test and open a PR']
      )
      await admin.query('UPDATE _local_store_schema_version SET version = 70 WHERE singleton = true')

      const database = await PostgresAsyncDatabase.open(config, () => undefined, schema)
      await database.finishSchemaInitialization()
      const upgraded = await LocalStore.open({ database, shared: true, ownerId: 'm2', orgForAgent })
      try {
        const index = upgraded.assistantSubsessions
        expect(await index.get(a, childKey(a, '1'))).toMatchObject({ title: 'fix the flaky test and open a PR' })
        expect(
          await index.attachThread({
            agentId: a,
            childSessionKey: childKey(a, '1'),
            platform: 'slack',
            channel: 'C0GENERAL',
            thread: '100.1',
            sinceRound: 2,
            now: 2_000
          })
        ).toBe(true)
        expect(await index.reportsRound(a, childKey(a, '1'), 2)).toBe(false)
        await index.open({
          agentId: a,
          childSessionKey: childKey(a, '2'),
          parentSessionId: 'sid-parent-1',
          parentSessionKey: 'parent',
          background: 'sort the backlog'
        })
        expect(await index.get(a, childKey(a, '2'))).toMatchObject({ background: 'sort the backlog' })
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

describe.skipIf(usingPostgresStore())('the v59 → v60 reply thread column on SQLite', () => {
  it('adds the column to a v59 index, its rows with no thread', async () => {
    const path = tempStorePath('ac-assistant-v59-')
    await (await LocalStore.open(path)).close()
    const a = agent()
    const old = new DatabaseSync(path)
    old.exec('ALTER TABLE assistant_subsession DROP COLUMN replyThread; PRAGMA user_version = 59')
    old
      .prepare(
        `INSERT INTO assistant_subsession (agentId, childSessionKey, parentSessionId, parentSessionKey, state, createdAt)
         VALUES (?, ?, 'sid-parent-1', 'parent', 'done', 1000)`
      )
      .run(a, childKey(a, '1'))
    old.close()

    const upgraded = await LocalStore.open(path)
    try {
      expect(await upgraded.assistantSubsessions.get(a, childKey(a, '1'))).not.toHaveProperty('replyThread')
      await upgraded.assistantSubsessions.setReplyThread(a, childKey(a, '1'), '200.1')
      expect(await upgraded.assistantSubsessions.get(a, childKey(a, '1'))).toMatchObject({ replyThread: '200.1' })
    } finally {
      await upgraded.close()
    }
    const db = new DatabaseSync(path)
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION)
    db.close()
  })
})

describe.skipIf(usingPostgresStore())('the v50 → v51 round column on SQLite', () => {
  it('adds the column to a v50 index, its rows in their first round', async () => {
    const path = tempStorePath('ac-assistant-v50-')
    await (await LocalStore.open(path)).close()
    const a = agent()
    const old = new DatabaseSync(path)
    old.exec('ALTER TABLE assistant_subsession DROP COLUMN round; PRAGMA user_version = 50')
    old
      .prepare(
        `INSERT INTO assistant_subsession (agentId, childSessionKey, parentSessionId, parentSessionKey, state, createdAt)
         VALUES (?, ?, 'sid-parent-1', 'parent', 'done', 1000)`
      )
      .run(a, childKey(a, '1'))
    old.close()

    const upgraded = await LocalStore.open(path)
    try {
      expect(await upgraded.assistantSubsessions.get(a, childKey(a, '1'))).not.toHaveProperty('round')
      expect(
        await upgraded.assistantSubsessions.reopenWithinLimit(a, childKey(a, '1'), 1, { limit: 3, startedSince: 0 })
      ).toBe('opened')
      expect(await upgraded.assistantSubsessions.get(a, childKey(a, '1'))).toMatchObject({ state: 'open', round: 2 })
    } finally {
      await upgraded.close()
    }
    const db = new DatabaseSync(path)
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION)
    db.close()
  })
})

describe.skipIf(usingPostgresStore())('the v43 → v44 failure report columns on SQLite', () => {
  it('adds the columns to a v43 index and keeps its rows', async () => {
    const path = tempStorePath('ac-assistant-v43-')
    await (await LocalStore.open(path)).close()
    const a = agent()
    const old = new DatabaseSync(path)
    old.exec(
      'ALTER TABLE assistant_subsession DROP COLUMN endReport; ALTER TABLE assistant_subsession DROP COLUMN reportAttempts; PRAGMA user_version = 43'
    )
    old
      .prepare(
        `INSERT INTO assistant_subsession (agentId, childSessionKey, parentSessionId, parentSessionKey, state, createdAt)
         VALUES (?, ?, 'sid-parent-1', 'parent', 'open', 1000)`
      )
      .run(a, childKey(a, '1'))
    old.close()

    const upgraded = await LocalStore.open(path)
    try {
      expect(await upgraded.assistantSubsessions.get(a, childKey(a, '1'))).toEqual({
        agentId: a,
        childSessionKey: childKey(a, '1'),
        parentSessionId: 'sid-parent-1',
        parentSessionKey: 'parent',
        state: 'open',
        createdAt: 1_000
      })
      expect(await upgraded.assistantSubsessions.claimReport(a, childKey(a, '1'), '{"text":"ended"}')).toBe(true)
      expect(await upgraded.assistantSubsessions.countReportAttempt(a, childKey(a, '1'))).toBe(1)
    } finally {
      await upgraded.close()
    }
    const db = new DatabaseSync(path)
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION)
    db.close()
  })
})

describe.skipIf(!usingPostgresStore())('the v43 → v44 failure report columns on PostgreSQL', () => {
  it('adds the columns to a v43 index and keeps its rows', async () => {
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
      await admin.query('ALTER TABLE assistant_subsession DROP COLUMN endReport, DROP COLUMN reportAttempts')
      await admin.query(
        `INSERT INTO assistant_subsession (agentId, childSessionKey, parentSessionId, parentSessionKey, state, createdAt)
         VALUES ($1, $2, 'sid-parent-1', 'parent', 'open', 1000)`,
        [a, childKey(a, '1')]
      )
      await admin.query('UPDATE _local_store_schema_version SET version = 43 WHERE singleton = true')

      const database = await PostgresAsyncDatabase.open(config, () => undefined, schema)
      await database.finishSchemaInitialization()
      const upgraded = await LocalStore.open({ database, shared: true, ownerId: 'm2', orgForAgent })
      try {
        expect(await upgraded.assistantSubsessions.get(a, childKey(a, '1'))).toEqual({
          agentId: a,
          childSessionKey: childKey(a, '1'),
          parentSessionId: 'sid-parent-1',
          parentSessionKey: 'parent',
          state: 'open',
          createdAt: 1_000
        })
        expect(await upgraded.assistantSubsessions.claimReport(a, childKey(a, '1'), '{"text":"ended"}')).toBe(true)
        expect(await upgraded.assistantSubsessions.countReportAttempt(a, childKey(a, '1'))).toBe(1)
        expect(await upgraded.assistantSubsessions.get(a, childKey(a, '1'))).toMatchObject({
          state: 'reporting',
          endReport: '{"text":"ended"}',
          reportAttempts: 1
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

describe.skipIf(usingPostgresStore())('the v37 → v38 sub-session index on SQLite', () => {
  it('adds the table to a v37 store and stamps the current version', async () => {
    const path = tempStorePath('ac-assistant-v37-')
    await (await LocalStore.open(path)).close()
    const old = new DatabaseSync(path)
    old.exec('DROP TABLE assistant_subsession; PRAGMA user_version = 37')
    old.close()

    const upgraded = await LocalStore.open(path)
    const a = agent()
    try {
      expect(await upgraded.assistantSubsessions.open(row(a, '1'))).toBe(true)
      expect((await upgraded.assistantSubsessions.get(a, childKey(a, '1')))?.state).toBe('open')
    } finally {
      await upgraded.close()
    }
    const db = new DatabaseSync(path)
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index') AND name LIKE 'assistant_subsession%'")
      .all() as { name: string }[]
    expect(tables.map((t) => t.name).sort()).toEqual([
      'assistant_subsession',
      'assistant_subsession_by_parent',
      'assistant_subsession_input',
      'assistant_subsession_input_by_child',
      'assistant_subsession_thread',
      'assistant_subsession_thread_by_child'
    ])
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION)
    db.close()
  })
})

describe.skipIf(!usingPostgresStore())('the v37 → v38 sub-session index on PostgreSQL', () => {
  it('adds the table to a v37 store and keeps the other assistant tables', async () => {
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
      const item = await first.assistantItems.create({
        agentId: a,
        title: 'Kept across the upgrade',
        origin: { platform: 'slack', channel: 'C0GENERAL', transportScope: null },
        taskKey: 'slack:C0GENERAL:subsession:check-1:kept'
      })
      await first.close()

      await admin.query(`SET search_path TO ${schema}`)
      await admin.query('DROP TABLE assistant_subsession')
      await admin.query('UPDATE _local_store_schema_version SET version = 37 WHERE singleton = true')

      const database = await PostgresAsyncDatabase.open(config, () => undefined, schema)
      await database.finishSchemaInitialization()
      const upgraded = await LocalStore.open({ database, shared: true, ownerId: 'm2', orgForAgent })
      try {
        expect((await upgraded.assistantItems.get(a, item.id))?.title).toBe('Kept across the upgrade')
        expect(await upgraded.assistantSubsessions.open(row(a, '1'))).toBe(true)
        expect(await upgraded.assistantSubsessions.get(a, childKey(a, '1'))).toMatchObject({
          parentSessionId: 'sid-parent-1',
          state: 'open',
          createdAt: 1_000
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

  it('shows one member’s delegation to another member of the pool', async () => {
    const databaseUrl = process.env.DATA_PLANE_TEST_DATABASE_URL!
    const members: LocalStore[] = []
    const a = agent()
    try {
      for (let i = 0; i < 2; i++) {
        const database = await PostgresAsyncDatabase.open({ version: 1, databaseUrl, maxConnections: 4 })
        members.push(
          await LocalStore.open({ database, shared: true, ownerId: randomUUID(), orgForAgent: () => 'org-a' })
        )
        await database.finishSchemaInitialization()
      }
      const [first, second] = members as [LocalStore, LocalStore]
      expect(await first.assistantSubsessions.open(row(a, '1'))).toBe(true)
      expect(await second.assistantSubsessions.open(row(a, '1'))).toBe(false)
      expect((await second.assistantSubsessions.get(a, childKey(a, '1')))?.parentSessionId).toBe('sid-parent-1')
    } finally {
      for (const member of members) await member.close()
    }
  })
})

describe.skipIf(usingPostgresStore())('assistant sub-sessions on agent removal', () => {
  const dirs: string[] = []
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })

  it('drops the agent’s index rows when the control plane removes the agent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-asub-'))
    dirs.push(root)
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({
        version: 1,
        controlPlane: { enabled: false },
        runtimes: { claude: { command: 'node', args: [] } }
      })
    )
    const agentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
    const agentDir = join(root, 'agents', agentId)
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(
      join(agentDir, 'agent.json'),
      JSON.stringify({
        id: agentId,
        name: 'bot-a',
        status: 'active',
        runtime: 'claude',
        workspace: { mode: 'from-scratch', path: join(agentDir, 'ws') },
        integrations: [],
        output: { mode: 'medium' },
        assistantMode: { enabled: true }
      })
    )
    const idleHost = (a: { id: string }) =>
      ({
        id: a.id,
        start: vi.fn().mockResolvedValue(undefined),
        newSession: vi.fn(),
        prompt: vi.fn(),
        cancel: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined)
      }) as never
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: idleHost })
    await daemon.start()
    try {
      const seam = daemon as unknown as {
        store: LocalStore
        cpConfigApply(): { applyAgentRemove(id: string): Promise<void> }
      }
      const other = agent()
      await seam.store.assistantSubsessions.open(row(agentId, '1'))
      await seam.store.assistantSubsessions.open(row(other, '1'))
      await seam.cpConfigApply().applyAgentRemove(agentId)
      expect(await seam.store.assistantSubsessions.get(agentId, childKey(agentId, '1'))).toBeUndefined()
      expect(await seam.store.assistantSubsessions.get(other, childKey(other, '1'))).toBeDefined()
    } finally {
      await daemon.stop()
    }
  })
})
