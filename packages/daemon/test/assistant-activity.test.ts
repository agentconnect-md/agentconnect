// The console's Activity view of an agent (assistant-mode.md §1.7, §5.11), answered from the daemon's own store.
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ASSISTANT_ACTIVITY_RESULT_BYTES,
  AssistantActivityReadResult,
  AssistantActivityWriteResult,
  type AssistantActivityPermission,
  type AssistantActivityReadReq,
  type AssistantActivityReadResult as ReadResult
} from '@agentconnect.md/protocol'
import type { DraftDecision } from '../src/assistant/drafts.js'
import {
  AssistantActivityViolationError,
  createAssistantActivity,
  type AssistantActivity,
  type AssistantActivityDeps
} from '../src/cp/assistant-activity.js'
import { subsessionCoordinate } from '../src/session/subsession-coordinate.js'
import { ASSISTANT_DRAFT_TTL_MS } from '../src/store/assistant-drafts.js'
import { ASSISTANT_ITEM_LIMITS } from '../src/store/assistant-items.js'
import { LocalStore, sessionKey } from '../src/store/local-store.js'
import { openTestStore } from './store-support.js'

const SUPPORT = { platform: 'slack', channel: 'C0SUPPORT', transportScope: 'T0EXAMPLE' }
const NOW = 10_000
/** A background sub-session's request awaiting an answer, as the permission path lists it. */
const PERMISSION: AssistantActivityPermission = {
  requestId: '00000000-0000-4000-8000-0000000000aa',
  sessionId: 'sid-sub',
  parentSessionId: 'sid-parent',
  tool: 'Write src/app.ts',
  createdAt: '1970-01-01T00:00:05.000Z',
  expiresAt: '1970-01-01T12:00:05.000Z',
  options: [
    { optionId: 'o-allow', name: 'Allow', kind: 'allow_once' },
    { optionId: 'o-deny', name: 'Deny', kind: 'reject_once' }
  ]
}

let store: LocalStore | undefined
afterEach(async () => {
  await store?.close()
  store = undefined
})

/** A store, two assistant-mode agents, one agent with the mode off, and the seam over them. */
async function setup() {
  store = await openTestStore()
  const s = store
  const [a, b, off]: [string, string, string] = [randomUUID(), randomUUID(), randomUUID()]
  const agents = new Map<string, { assistantMode: { enabled: boolean } }>([
    [a, { assistantMode: { enabled: true } }],
    [b, { assistantMode: { enabled: true } }],
    [off, { assistantMode: { enabled: false } }]
  ])
  const decideDraft = vi.fn(
    async (_input: Parameters<AssistantActivityDeps['decideDraft']>[0]): Promise<DraftDecision> => ({
      result: 'decided',
      status: 'succeeded',
      failure: null
    })
  )
  const stopSession = vi.fn(async (_key: string, _actor: { userId: string; name?: string }) => true)
  const pendingPermissions = vi.fn((agentId: string) => (agentId === a || agentId === off ? [PERMISSION] : []))
  const activity = createAssistantActivity({
    store: () => s,
    agent: (id) => agents.get(id),
    now: () => NOW,
    decideDraft,
    stopSession,
    pendingPermissions
  })
  return { s, a, b, off, activity, decideDraft, stopSession, pendingPermissions }
}

async function read<O extends AssistantActivityReadReq['operation']>(
  activity: AssistantActivity,
  req: Extract<AssistantActivityReadReq, { operation: O }>
): Promise<Extract<ReadResult, { operation: O }>> {
  const result = await activity.read(req)
  // Every answer is what the wire accepts.
  expect(AssistantActivityReadResult.safeParse(result).success).toBe(true)
  return result as Extract<ReadResult, { operation: O }>
}

/** A follow-up taken in the support channel, with its index row under that channel's long session. */
async function createFollowUp(s: LocalStore, agentId: string, over: Record<string, unknown> = {}) {
  const key = sessionKey('slack', 'C0SUPPORT', `subsession:patrol-${randomUUID()}`, agentId, 'T0EXAMPLE')
  const item = await s.assistantItems.create({
    agentId,
    title: 'Ship the release notes',
    doneWhen: 'The notes are published',
    origin: SUPPORT,
    taskKey: key,
    asker: 'slack:T0EXAMPLE:U0ALICE',
    now: 1_000,
    ...over
  })
  await s.assistantSubsessions.openFollowUp({
    agentId,
    childSessionKey: key,
    parentSessionId: 'sid-parent',
    parentSessionKey: sessionKey('slack', 'C0SUPPORT', 'append:1', agentId, 'T0EXAMPLE'),
    now: Number(over.now ?? 1_000)
  })
  return item
}

/** Start one check of a follow-up at `at`. */
const begin = (s: LocalStore, agentId: string, item: { id: string; taskKey: string }, at: number) =>
  s.assistantPatrols.begin(agentId, item.id, {
    key: item.taskKey,
    nextCheck: null,
    observationVersion: 0,
    input: null,
    now: at,
    staleBefore: 0,
    exclusive: false
  })

describe('the Activity view: follow-ups in place of items', () => {
  it('answers no items, and deletes none, from a daemon that keeps follow-ups', async () => {
    const { s, a, activity } = await setup()
    const item = await createFollowUp(s, a)
    expect(await read(activity, { agentId: a, operation: 'items', section: 'open', limit: 50 })).toEqual({
      operation: 'items',
      items: [],
      truncated: false
    })
    expect((await read(activity, { agentId: a, operation: 'item', itemId: item.id })).item).toBeNull()
    expect(await activity.write({ agentId: a, operation: 'delete-item', itemId: item.id })).toEqual({
      operation: 'delete-item',
      found: false
    })
    expect(await s.assistantItems.get(a, item.id)).toBeDefined()
  })

  it('lists a follow-up as a task with its state, next check and newest finished checks', async () => {
    const { s, a, activity } = await setup()
    const item = await createFollowUp(s, a, { nextCheck: 86_400_000 })
    for (let i = 1; i <= 7; i++) {
      const begun = await begin(s, a, item, i * 1_000)
      await s.assistantPatrols.endCheck(a, item.id, begun!.checkNo, {
        observation: `check ${i}`,
        reported: i === 7,
        now: i * 1_000 + 1
      })
      await s.assistantPatrols.succeed(a, item.id, item.taskKey, i * 1_000 + 1)
    }
    // A running check has seen nothing yet, so it is not among them.
    await begin(s, a, item, 8_000)
    const page = await read(activity, { agentId: a, operation: 'subsessions', limit: 10 })
    expect(page.followUps).toBe(true)
    expect(page.subsessions).toEqual([
      {
        sessionId: null,
        parentSessionId: 'sid-parent',
        state: 'open',
        createdAt: '1970-01-01T00:00:01.000Z',
        kind: 'follow-up',
        followUp: {
          id: item.id,
          title: 'Ship the release notes',
          doneWhen: 'The notes are published',
          status: 'waiting',
          nextCheck: '1970-01-02T00:00:00.000Z',
          recentChecks: [7, 6, 5, 4, 3].map((i) => ({
            at: new Date(i * 1_000).toISOString(),
            observation: `check ${i}`,
            reported: i === 7
          }))
        }
      }
    ])
  })

  // assistant-mode.md §5.13: a first look is a follow-up row marked as one, with no time of its own to show.
  it('marks a first look, which shows no next check while it waits for the scheduled-check slot', async () => {
    const { s, a, activity } = await setup()
    await createFollowUp(s, a, {
      title: 'First look at support',
      doneWhen: undefined,
      nextCheck: 1_000,
      firstLook: 'joined'
    })
    const page = await read(activity, { agentId: a, operation: 'subsessions', limit: 10 })
    expect(page.subsessions).toEqual([
      expect.objectContaining({
        kind: 'follow-up',
        followUp: expect.objectContaining({
          title: 'First look at support',
          status: 'waiting',
          nextCheck: null,
          firstLook: true
        })
      })
    ])
  })

  it('keeps a page of follow-ups inside the wire budget, paging on from the last row it carries', async () => {
    const { s, a, activity } = await setup()
    const long = 'x'.repeat(ASSISTANT_ITEM_LIMITS.observation)
    for (let f = 0; f < 30; f++) {
      const item = await createFollowUp(s, a, { now: 1_000 + f })
      for (let i = 1; i <= 5; i++) {
        const at = (f * 10 + i) * 1_000
        const begun = await begin(s, a, item, at)
        await s.assistantPatrols.endCheck(a, item.id, begun!.checkNo, {
          observation: long,
          reported: false,
          now: at + 1
        })
        await s.assistantPatrols.succeed(a, item.id, item.taskKey, at + 1)
      }
    }
    const bytes = (result: unknown) => Buffer.byteLength(JSON.stringify(result), 'utf8')
    const all = await read(activity, { agentId: a, operation: 'subsessions', limit: 30 })
    expect(bytes(all)).toBeLessThanOrEqual(ASSISTANT_ACTIVITY_RESULT_BYTES)
    expect(all.subsessions.length).toBeLessThan(30)
    expect(all.truncated).toBe(true)
    // One conversation's pages carry every row once, each inside the budget.
    const seen: string[] = []
    let cursor: string | undefined
    do {
      const page = await read(activity, {
        agentId: a,
        operation: 'subsessions',
        limit: 30,
        parent: { sessionId: 'sid-parent', ...(cursor ? { cursor } : {}) }
      })
      expect(bytes(page)).toBeLessThanOrEqual(ASSISTANT_ACTIVITY_RESULT_BYTES)
      seen.push(...page.subsessions.map((row) => row.createdAt))
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    expect(new Set(seen).size).toBe(30)
  })

  it('names a running check, checks paused after failures, and how a follow-up ended', async () => {
    const { s, a, activity } = await setup()
    const status = async () =>
      (await read(activity, { agentId: a, operation: 'subsessions', limit: 10 })).subsessions.map((r) => [
        r.kind,
        r.state,
        r.followUp?.status,
        r.followUp?.nextCheck
      ])
    const item = await createFollowUp(s, a, { nextCheck: 5_000 })
    await s.assistantSubsessions.checking(a, item.taskKey)
    expect(await status()).toEqual([['follow-up', 'open', 'checking', '1970-01-01T00:00:05.000Z']])
    await s.assistantSubsessions.finish(a, item.taskKey, 'failed')
    // Five failed checks in a row pause it until it is messaged.
    for (let n = 0; n < 5; n++) {
      await begin(s, a, item, 6_000 + n)
      await s.assistantPatrols.fail(a, item.id, item.taskKey, 6_000 + n, 5_000)
    }
    expect(await status()).toEqual([['follow-up', 'open', 'paused', '1970-01-01T00:00:05.000Z']])
    await s.assistantItems.schedule(a, item.id, { status: 'done', nextCheck: null })
    expect(await status()).toEqual([['follow-up', 'done', 'done', null]])
    const other = await createFollowUp(s, a, { title: 'Watch the build', now: 2_000 })
    await s.assistantItems.schedule(a, other.id, { status: 'dropped', nextCheck: null })
    expect((await status())[0]).toEqual(['follow-up', 'done', 'stopped', null])
  })

  it('lists a place’s follow-ups under its current long session, and none outside assistant mode', async () => {
    const { s, a, off, activity } = await setup()
    const item = await createFollowUp(s, a)
    const coordinate = await s.resolveAppendCoordinate(a, 'C0SUPPORT', 'T0EXAMPLE', 1)
    const place = sessionKey('slack', 'C0SUPPORT', coordinate, a, 'T0EXAMPLE')
    await s.upsertSession({
      key: place,
      agentId: a,
      platform: 'slack',
      channel: 'C0SUPPORT',
      thread: coordinate,
      transportScope: 'T0EXAMPLE',
      acpSessionId: 'acp-current',
      sessionId: 'sid-current',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 2_000
    })
    const under = async (sessionId: string) =>
      (await read(activity, { agentId: a, operation: 'subsessions', limit: 10, parent: { sessionId } })).subsessions
    expect(await under('sid-current')).toEqual([
      expect.objectContaining({ kind: 'follow-up', parentSessionId: 'sid-current' })
    ])
    expect(await under('sid-parent')).toEqual([])
    expect((await s.assistantSubsessions.get(a, item.taskKey))?.parentSessionKey).toBe(place)
    await createFollowUp(s, off)
    expect((await read(activity, { agentId: off, operation: 'subsessions', limit: 10 })).subsessions).toEqual([])
  })

  it('ends a follow-up on the console’s Stop, not only its check', async () => {
    const { s, a, activity, stopSession } = await setup()
    const stopFollowUp = vi.fn(async (): Promise<'stopped' | 'ended'> => 'stopped')
    const withStop = createAssistantActivity({
      store: () => s,
      agent: () => ({ assistantMode: { enabled: true } }),
      now: () => NOW,
      decideDraft: async () => ({ result: 'not-found', status: null, failure: null }),
      stopSession,
      stopFollowUp
    })
    const item = await createFollowUp(s, a)
    await s.upsertSession({
      key: item.taskKey,
      agentId: a,
      platform: 'slack',
      channel: 'C0SUPPORT',
      thread: item.taskKey.split(':')[2]!,
      transportScope: 'T0EXAMPLE',
      acpSessionId: 'acp-follow-up',
      sessionId: 'sid-follow-up',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1_000
    })
    const actor = { userId: 'usr-1', name: 'Grace' }
    const stop = (on: AssistantActivity) =>
      on.write({ agentId: a, operation: 'stop-subsession', sessionId: 'sid-follow-up', actor })
    expect(await stop(withStop)).toEqual({ operation: 'stop-subsession', result: 'stopped' })
    expect(stopFollowUp).toHaveBeenCalledWith(a, expect.objectContaining({ id: item.id }), actor)
    stopFollowUp.mockResolvedValueOnce('ended')
    expect(await stop(withStop)).toEqual({ operation: 'stop-subsession', result: 'not-running' })
    expect(stopSession).not.toHaveBeenCalled()
    // A daemon that cannot end a follow-up from the console stops nothing.
    expect(await stop(activity)).toEqual({ operation: 'stop-subsession', result: 'not-found' })
  })

  it('ends a follow-up by its id before its first check, only under the conversation its row names', async () => {
    const { s, a, b, activity, stopSession } = await setup()
    const stopFollowUp = vi.fn(async (): Promise<'stopped' | 'ended'> => 'stopped')
    const withStop = createAssistantActivity({
      store: () => s,
      agent: () => ({ assistantMode: { enabled: true } }),
      now: () => NOW,
      decideDraft: async () => ({ result: 'not-found', status: null, failure: null }),
      stopSession,
      stopFollowUp
    })
    const item = await createFollowUp(s, a)
    // No check has run, so the row has no session to stop it by; its own id does.
    const [row] = (await read(withStop, { agentId: a, operation: 'subsessions', limit: 10 })).subsessions
    expect(row).toMatchObject({ sessionId: null, followUp: { id: item.id } })
    const actor = { userId: 'usr-1', name: null }
    const stop = (on: AssistantActivity, agentId: string, followUpId: string, parentSessionId = 'sid-parent') =>
      on.write({ agentId, operation: 'stop-follow-up', followUpId, parentSessionId, actor })
    const result = await stop(withStop, a, item.id)
    expect(AssistantActivityWriteResult.parse(result)).toEqual({ operation: 'stop-follow-up', result: 'stopped' })
    expect(stopFollowUp).toHaveBeenCalledWith(a, expect.objectContaining({ id: item.id }), { userId: 'usr-1' })
    stopFollowUp.mockResolvedValueOnce('ended')
    expect(await stop(withStop, a, item.id)).toEqual({ operation: 'stop-follow-up', result: 'not-running' })

    stopFollowUp.mockClear()
    const theirs = await createFollowUp(s, b)
    // Another conversation, another agent's follow-up, an unknown id, and a daemon that cannot end one end nothing.
    for (const [on, agentId, id, parent] of [
      [withStop, a, item.id, 'sid-elsewhere'],
      [withStop, a, theirs.id, 'sid-parent'],
      [withStop, a, randomUUID(), 'sid-parent'],
      [activity, a, item.id, 'sid-parent']
    ] as const) {
      expect(await stop(on, agentId, id, parent)).toEqual({ operation: 'stop-follow-up', result: 'not-found' })
    }
    expect(stopFollowUp).not.toHaveBeenCalled()
    expect(stopSession).not.toHaveBeenCalled()
  })

  it('reads one task by its own session, the same row the list carries', async () => {
    const { s, a, b, off, activity } = await setup()
    const item = await createFollowUp(s, a)
    const session = (agentId: string, key: string, sessionId: string, thread = key.split(':')[2]!) =>
      s.upsertSession({
        key,
        agentId,
        platform: 'slack',
        channel: 'C0SUPPORT',
        thread,
        transportScope: 'T0EXAMPLE',
        acpSessionId: `acp-${sessionId}`,
        sessionId,
        state: 'idle',
        lastDeliveredTs: null,
        updatedAt: 1_000
      })
    await session(a, item.taskKey, 'sid-follow-up')
    const one = async (agentId: string, sessionId: string) =>
      (await read(activity, { agentId, operation: 'task', sessionId })).task
    const [listed] = (await read(activity, { agentId: a, operation: 'subsessions', limit: 10 })).subsessions
    expect(await one(a, 'sid-follow-up')).toEqual(listed)
    expect(listed).toMatchObject({ sessionId: 'sid-follow-up', kind: 'follow-up', followUp: { id: item.id } })

    // Another agent's task, a session that is no task, and an unknown one read as none.
    expect(await one(b, 'sid-follow-up')).toBeNull()
    await session(a, sessionKey('slack', 'C0SUPPORT', 'append:1', a, 'T0EXAMPLE'), 'sid-parent', 'append:1')
    expect(await one(a, 'sid-parent')).toBeNull()
    expect(await one(a, 'sid-unknown')).toBeNull()
    // Outside assistant mode a follow-up is not shown, as the list leaves it out.
    const offItem = await createFollowUp(s, off)
    await session(off, offItem.taskKey, 'sid-off')
    expect(await one(off, 'sid-off')).toBeNull()
  })
})

describe('the Activity view: sub-sessions', () => {
  it('lists open sub-sessions first, by their outward ids once their sessions exist', async () => {
    const { s, a, b, activity } = await setup()
    const parentKey = sessionKey('slack', 'C0SUPPORT', 'append:1', a, 'T0EXAMPLE')
    const child = (id: string) => sessionKey('slack', 'C0SUPPORT', subsessionCoordinate(id), a, 'T0EXAMPLE')
    const open = { agentId: a, parentSessionId: 'sid-parent', parentSessionKey: parentKey }
    await s.assistantSubsessions.open({ ...open, childSessionKey: child('finished'), now: 1_000 })
    await s.assistantSubsessions.open({ ...open, childSessionKey: child('running'), now: 2_000 })
    await s.assistantSubsessions.open({ ...open, childSessionKey: child('starting'), now: 3_000 })
    await s.assistantSubsessions.finish(a, child('finished'), 'done')
    await s.assistantSubsessions.open({ ...open, agentId: b, childSessionKey: 'other-agent', now: 4_000 })
    await s.upsertSession({
      key: child('running'),
      agentId: a,
      platform: 'slack',
      channel: 'C0SUPPORT',
      thread: subsessionCoordinate('running'),
      transportScope: 'T0EXAMPLE',
      acpSessionId: 'acp-running',
      sessionId: 'sid-running',
      state: 'prompting',
      lastDeliveredTs: null,
      updatedAt: 2_000
    })

    const page = await read(activity, { agentId: a, operation: 'subsessions', limit: 10 })
    expect(page).toEqual({
      operation: 'subsessions',
      subsessions: [
        {
          sessionId: null,
          parentSessionId: 'sid-parent',
          state: 'open',
          createdAt: '1970-01-01T00:00:03.000Z',
          kind: 'delegated'
        },
        {
          sessionId: 'sid-running',
          parentSessionId: 'sid-parent',
          state: 'open',
          createdAt: '1970-01-01T00:00:02.000Z',
          kind: 'delegated'
        },
        {
          sessionId: null,
          parentSessionId: 'sid-parent',
          state: 'done',
          createdAt: '1970-01-01T00:00:01.000Z',
          kind: 'delegated'
        }
      ],
      truncated: false,
      followUps: true
    })
    expect((await read(activity, { agentId: a, operation: 'subsessions', limit: 2 })).truncated).toBe(true)
  })

  it('lists only the sub-sessions one conversation opened, newest first, a page at a time', async () => {
    const { s, a, b, activity } = await setup()
    const parentKey = sessionKey('slack', 'C0SUPPORT', 'append:1', a, 'T0EXAMPLE')
    const child = (id: string) => sessionKey('slack', 'C0SUPPORT', subsessionCoordinate(id), a, 'T0EXAMPLE')
    const open = { agentId: a, parentSessionId: 'sid-parent', parentSessionKey: parentKey }
    for (const [id, now] of [
      ['1', 1_000],
      ['2', 2_000],
      ['3', 3_000]
    ] as const)
      await s.assistantSubsessions.open({ ...open, childSessionKey: child(id), now })
    await s.assistantSubsessions.open({
      ...open,
      parentSessionId: 'sid-other',
      childSessionKey: child('x'),
      now: 4_000
    })
    await s.assistantSubsessions.open({ ...open, agentId: b, childSessionKey: 'other-agent', now: 5_000 })
    await s.assistantSubsessions.finish(a, child('3'), 'failed')

    const first = await read(activity, {
      agentId: a,
      operation: 'subsessions',
      limit: 2,
      parent: { sessionId: 'sid-parent' }
    })
    expect(first.subsessions.map((r) => [r.state, r.createdAt])).toEqual([
      ['failed', '1970-01-01T00:00:03.000Z'],
      ['open', '1970-01-01T00:00:02.000Z']
    ])
    expect(first.truncated).toBe(true)
    expect(first.nextCursor).toEqual(expect.any(String))
    const rest = await read(activity, {
      agentId: a,
      operation: 'subsessions',
      limit: 2,
      parent: { sessionId: 'sid-parent', cursor: first.nextCursor! }
    })
    expect(rest).toMatchObject({
      subsessions: [{ parentSessionId: 'sid-parent', state: 'open', createdAt: '1970-01-01T00:00:01.000Z' }],
      truncated: false,
      nextCursor: null
    })
    // Another agent's conversation of the same id holds nothing of this agent's.
    const theirs = await read(activity, {
      agentId: b,
      operation: 'subsessions',
      limit: 10,
      parent: { sessionId: 'sid-parent' }
    })
    expect(theirs.subsessions).toHaveLength(1)
    const forged = activity.read({
      agentId: a,
      operation: 'subsessions',
      limit: 2,
      parent: { sessionId: 'sid-parent', cursor: 'not-a-cursor' }
    })
    await expect(forged).rejects.toMatchObject({ reason: 'bad-cursor' })
  })
})

describe('the Activity view: stopping a sub-session', () => {
  async function withChild(s: LocalStore, agentId: string, id: string, sessionId: string) {
    const key = sessionKey('webchat', 'conv-1', subsessionCoordinate(id), agentId)
    await s.assistantSubsessions.open({
      agentId,
      childSessionKey: key,
      parentSessionId: 'sid-parent',
      parentSessionKey: sessionKey('webchat', 'conv-1', 'append:1', agentId),
      now: 1_000
    })
    await s.upsertSession({
      key,
      agentId,
      platform: 'webchat',
      channel: 'conv-1',
      thread: subsessionCoordinate(id),
      transportScope: null,
      acpSessionId: `acp-${id}`,
      sessionId,
      state: 'prompting',
      lastDeliveredTs: null,
      updatedAt: 1_000
    })
    return key
  }

  const stop = (activity: AssistantActivity, agentId: string, sessionId: string) =>
    activity.write({
      agentId,
      operation: 'stop-subsession',
      sessionId,
      actor: { userId: 'usr-1', name: 'Grace' }
    })

  it('interrupts an open sub-session’s turn through the cancel core, naming who stopped it', async () => {
    const { s, a, activity, stopSession } = await setup()
    const key = await withChild(s, a, '1', 'sid-child')
    const result = await stop(activity, a, 'sid-child')
    expect(AssistantActivityWriteResult.parse(result)).toEqual({ operation: 'stop-subsession', result: 'stopped' })
    expect(stopSession).toHaveBeenCalledWith(key, { userId: 'usr-1', name: 'Grace' })
    stopSession.mockResolvedValueOnce(false)
    expect(await stop(activity, a, 'sid-child')).toEqual({ operation: 'stop-subsession', result: 'not-running' })
  })

  it('shows a sub-session whose failure report is still on its way as ended, with nothing to stop', async () => {
    const { s, a, activity, stopSession } = await setup()
    const key = await withChild(s, a, '1', 'sid-child')
    expect(await s.assistantSubsessions.claimReport(a, key, '{"text":"ended"}')).toBe(true)
    const page = await read(activity, { agentId: a, operation: 'subsessions', limit: 10 })
    expect(page.subsessions).toEqual([
      {
        sessionId: 'sid-child',
        parentSessionId: 'sid-parent',
        state: 'failed',
        createdAt: '1970-01-01T00:00:01.000Z',
        kind: 'delegated'
      }
    ])
    expect(await stop(activity, a, 'sid-child')).toEqual({ operation: 'stop-subsession', result: 'not-running' })
    expect(stopSession).not.toHaveBeenCalled()
  })

  it('stops nothing that is settled, not indexed, or another agent’s', async () => {
    const { s, a, b, activity, stopSession } = await setup()
    const key = await withChild(s, a, '1', 'sid-child')
    await s.assistantSubsessions.finish(a, key, 'done')
    expect(await stop(activity, a, 'sid-child')).toEqual({ operation: 'stop-subsession', result: 'not-running' })
    // An ordinary session of the agent is not a sub-session.
    await s.upsertSession({
      key: sessionKey('webchat', 'conv-1', 'append:1', a),
      agentId: a,
      platform: 'webchat',
      channel: 'conv-1',
      thread: 'append:1',
      transportScope: null,
      acpSessionId: 'acp-parent',
      sessionId: 'sid-parent',
      state: 'prompting',
      lastDeliveredTs: null,
      updatedAt: 1_000
    })
    expect(await stop(activity, a, 'sid-parent')).toEqual({ operation: 'stop-subsession', result: 'not-found' })
    await withChild(s, b, '2', 'sid-theirs')
    expect(await stop(activity, a, 'sid-theirs')).toEqual({ operation: 'stop-subsession', result: 'not-found' })
    expect(await stop(activity, a, 'sid-unknown')).toEqual({ operation: 'stop-subsession', result: 'not-found' })
    expect(stopSession).not.toHaveBeenCalled()
  })
})

describe('the Activity view: drafts', () => {
  it('lists the drafts awaiting approval with the exact text, the target, the approver and the expiry', async () => {
    const { s, a, b, activity } = await setup()
    await s.setDisplayName('U0ALICE', 'Alice', 1_000)
    const text = 'The release is out.\n\nNotes: https://docs.example.test/r'
    const draft = await s.assistantDrafts.create({
      agentId: a,
      kind: 'elsewhere',
      target: { platform: 'slack', integrationId: 'int-a', channel: 'C0SUPPORT', thread: '1700000000.000100' },
      destination: { name: 'support' },
      text,
      approver: {
        kind: 'member',
        integrationId: 'int-a',
        channel: 'D0ALICE',
        userId: 'U0ALICE',
        teamId: 'T0EXAMPLE',
        consoleUserId: null
      },
      now: 1_000
    })
    const decided = await s.assistantDrafts.create({ ...draftInput(a), now: 1_000 })
    await s.assistantDrafts.deny(decided.id, { id: null, name: null }, 2_000)
    await s.assistantDrafts.create({ ...draftInput(a), now: NOW - ASSISTANT_DRAFT_TTL_MS })
    await s.assistantDrafts.create({ ...draftInput(b), now: 1_000 })

    const page = await read(activity, { agentId: a, operation: 'drafts', limit: 10 })
    expect(page).toEqual({
      operation: 'drafts',
      drafts: [
        {
          id: draft.id,
          kind: 'elsewhere',
          target: {
            platform: 'slack',
            integrationId: 'int-a',
            channel: 'C0SUPPORT',
            thread: '1700000000.000100',
            name: 'support',
            dm: false,
            external: false
          },
          text,
          approver: {
            kind: 'member',
            integrationId: 'int-a',
            channel: 'D0ALICE',
            userId: 'U0ALICE',
            consoleUserId: null,
            name: 'Alice'
          },
          createdAt: '1970-01-01T00:00:01.000Z',
          expiresAt: new Date(1_000 + ASSISTANT_DRAFT_TTL_MS).toISOString()
        }
      ],
      truncated: false
    })
  })

  it('lists sub-sessions’ permission requests waiting for an answer only for a Control Plane that asks', async () => {
    const { a, b, activity, pendingPermissions } = await setup()
    // An older Control Plane does not ask, so the answer is the shape it knows.
    expect(await read(activity, { agentId: a, operation: 'drafts', limit: 10 })).not.toHaveProperty('permissions')
    expect(pendingPermissions).not.toHaveBeenCalled()
    expect(await read(activity, { agentId: a, operation: 'drafts', limit: 10, permissions: true })).toMatchObject({
      permissions: [PERMISSION]
    })
    expect(await read(activity, { agentId: b, operation: 'drafts', limit: 10, permissions: true })).toMatchObject({
      permissions: []
    })
    expect(pendingPermissions.mock.calls).toEqual([[a], [b]])
  })
})

describe('the Activity view: one webchat conversation’s proposals', () => {
  /** A session of agent `agentId` with outward id `sessionId`. */
  const seedSession = (s: LocalStore, agentId: string, sessionId: string, platform: string, thread: string) =>
    s.upsertSession({
      key: sessionKey(platform, 'conv-1', thread, agentId),
      agentId,
      platform,
      channel: 'conv-1',
      thread,
      transportScope: null,
      acpSessionId: `acp-${sessionId}`,
      sessionId,
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1_000
    })
  const proposal = (s: LocalStore, agentId: string, platform: string, channel: string) =>
    s.assistantDrafts.createTask({
      agentId,
      target: { platform, integrationId: platform === 'webchat' ? '' : 'int-a', channel, thread: null },
      task: 'Rebase PR #12 onto main and push.',
      sentence: 'I want to rebase PR #12.',
      why: 'It conflicts with main.',
      itemId: 'item-1',
      itemVersion: 1,
      source: {
        platform,
        integrationId: null,
        channel,
        thread: 'subsession:patrol-1',
        transportScope: null,
        sessionKey: null,
        sessionId: null,
        place: false
      },
      approver: {
        kind: 'place',
        integrationId: platform === 'webchat' ? '' : 'int-a',
        channel,
        userId: null,
        teamId: null,
        consoleUserId: null
      },
      now: 1_000
    })

  it('lists only that conversation’s proposals, never its permission requests, and nothing for another session', async () => {
    const { s, a, b, activity, pendingPermissions } = await setup()
    await seedSession(s, a, 'sid-webchat', 'webchat', 'webchat:conv-1')
    await seedSession(s, a, 'sid-sub', 'webchat', subsessionCoordinate('1'))
    await seedSession(s, a, 'sid-slack', 'slack', 'append:1')
    await seedSession(s, b, 'sid-theirs', 'webchat', 'webchat:conv-1')
    const here = await proposal(s, a, 'webchat', 'conv-1')
    await proposal(s, a, 'webchat', 'conv-2')
    await proposal(s, a, 'slack', 'conv-1')
    await proposal(s, b, 'webchat', 'conv-1')
    await s.assistantDrafts.create({ ...draftInput(a), now: 1_000 })

    const page = await read(activity, {
      agentId: a,
      operation: 'drafts',
      limit: 10,
      permissions: true,
      conversation: { sessionId: 'sid-webchat' }
    })
    expect(page).not.toHaveProperty('permissions')
    expect(pendingPermissions).not.toHaveBeenCalled()
    expect(page.drafts).toEqual([
      expect.objectContaining({ id: here.id, kind: 'task', approver: null, inConversation: true })
    ])
    // A sub-session's page, a Slack conversation, another agent's session and an unknown one hold none of them.
    for (const sessionId of ['sid-sub', 'sid-slack', 'sid-theirs', 'sid-unknown']) {
      const none = await read(activity, { agentId: a, operation: 'drafts', limit: 10, conversation: { sessionId } })
      expect(none.drafts).toEqual([])
    }
  })

  it('binds a decision to the conversation, and never reaches the draft path for a session that is not one', async () => {
    const { s, a, activity, decideDraft } = await setup()
    await seedSession(s, a, 'sid-webchat', 'webchat', 'webchat:conv-1')
    await seedSession(s, a, 'sid-slack', 'slack', 'append:1')
    const req = {
      agentId: a,
      operation: 'decide-draft' as const,
      draftId: 'draft-1',
      choice: 'approve' as const,
      decider: { userId: 'usr-2', name: 'Grace' }
    }
    await activity.write({ ...req, conversation: { sessionId: 'sid-webchat' } })
    expect(decideDraft).toHaveBeenCalledWith({ ...req, conversation: { platform: 'webchat', channel: 'conv-1' } })
    for (const sessionId of ['sid-slack', 'sid-unknown']) {
      expect(await activity.write({ ...req, conversation: { sessionId } })).toEqual({
        operation: 'decide-draft',
        result: 'not-found',
        status: null,
        failure: null
      })
    }
    expect(decideDraft).toHaveBeenCalledTimes(1)
  })

  it('carries a follow-up form’s follow-up on the proposal, and the follow-up an approval took', async () => {
    const { s, a, activity, decideDraft } = await setup()
    await seedSession(s, a, 'sid-webchat', 'webchat', 'webchat:conv-1')
    const form = await s.assistantDrafts.createTask({
      agentId: a,
      target: { platform: 'webchat', integrationId: '', channel: 'conv-1', thread: null },
      task: '',
      followUp: { title: 'The release date', doneWhen: 'A date is posted.', nextCheck: 1_760_000_000_000 },
      sentence: 'I want to follow up the release date.',
      why: 'Ada is waiting on it.',
      itemId: 'item-1',
      itemVersion: 1,
      source: {
        platform: 'webchat',
        integrationId: null,
        channel: 'conv-1',
        thread: 'subsession:patrol-1',
        transportScope: null,
        sessionKey: null,
        sessionId: null,
        place: false
      },
      approver: {
        kind: 'place',
        integrationId: '',
        channel: 'conv-1',
        userId: null,
        teamId: null,
        consoleUserId: null
      },
      now: 1_000
    })
    const page = await read(activity, {
      agentId: a,
      operation: 'drafts',
      limit: 10,
      conversation: { sessionId: 'sid-webchat' }
    })
    expect(page.drafts).toEqual([
      expect.objectContaining({
        id: form.id,
        text: 'The release date',
        proposal: expect.objectContaining({
          followUp: {
            title: 'The release date',
            doneWhen: 'A date is posted.',
            nextCheck: new Date(1_760_000_000_000).toISOString()
          }
        })
      })
    ])
    decideDraft.mockResolvedValueOnce({
      result: 'decided',
      status: 'succeeded',
      failure: null,
      followUp: { id: 'item-taken', parentSessionId: 'sid-webchat' }
    })
    expect(
      await activity.write({
        agentId: a,
        operation: 'decide-draft',
        draftId: form.id,
        choice: 'approve',
        decider: { userId: 'usr-2', name: 'Grace' }
      })
    ).toEqual({
      operation: 'decide-draft',
      result: 'decided',
      status: 'succeeded',
      failure: null,
      followUp: { id: 'item-taken', parentSessionId: 'sid-webchat' }
    })
  })
})

describe('the Activity view: deciding a draft', () => {
  it('hands the decision to the draft path and bounds the failure', async () => {
    const { a, activity, decideDraft } = await setup()
    decideDraft.mockResolvedValueOnce({ result: 'decided', status: 'failed', failure: '😀'.repeat(3_000) })
    const req = {
      agentId: a,
      operation: 'decide-draft' as const,
      draftId: 'draft-1',
      choice: 'approve' as const,
      decider: { userId: 'usr-2', name: 'Grace' }
    }
    const answer = await activity.write(req)
    expect(decideDraft).toHaveBeenCalledWith(req)
    expect(answer).toMatchObject({ operation: 'decide-draft', result: 'decided', status: 'failed' })
    expect(AssistantActivityWriteResult.safeParse(answer).success).toBe(true)

    decideDraft.mockResolvedValueOnce({ result: 'expired', status: 'expired', failure: null })
    expect(await activity.write({ ...req, choice: 'discard', decider: { userId: 'usr-3', name: null } })).toEqual({
      operation: 'decide-draft',
      result: 'expired',
      status: 'expired',
      failure: null
    })
  })

  it('never reaches the draft path for an agent it does not hold', async () => {
    const { activity, decideDraft } = await setup()
    const write = activity.write({
      agentId: randomUUID(),
      operation: 'decide-draft',
      draftId: 'draft-1',
      choice: 'approve',
      decider: { userId: 'usr-2', name: 'Grace' }
    })
    await expect(write).rejects.toBeInstanceOf(AssistantActivityViolationError)
    expect(decideDraft).not.toHaveBeenCalled()
  })

  it('decides an agent’s draft outside assistant mode too, but refuses its proposals', async () => {
    const { s, off, activity, decideDraft } = await setup()
    await s.upsertSession({
      key: sessionKey('webchat', 'conv-1', 'webchat:conv-1', off),
      agentId: off,
      platform: 'webchat',
      channel: 'conv-1',
      thread: 'webchat:conv-1',
      transportScope: null,
      acpSessionId: 'acp-webchat',
      sessionId: 'sid-webchat',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1_000
    })
    const req = {
      agentId: off,
      operation: 'decide-draft' as const,
      draftId: 'draft-1',
      choice: 'approve' as const,
      decider: { userId: 'usr-2', name: 'Grace' }
    }
    const draft = await s.assistantDrafts.create({ ...draftInput(off), now: 1_000 })
    expect(await activity.write({ ...req, draftId: draft.id })).toMatchObject({
      operation: 'decide-draft',
      result: 'decided'
    })
    expect(decideDraft).toHaveBeenCalledWith({ ...req, draftId: draft.id })
    // An unknown draft is the draft path's to call not found.
    await activity.write(req)
    expect(decideDraft).toHaveBeenCalledTimes(2)
    // A proposal, by its conversation or by its id, is assistant mode's.
    const proposal = await s.assistantDrafts.createTask({
      agentId: off,
      target: { platform: 'webchat', integrationId: '', channel: 'conv-1', thread: null },
      task: 'Rebase PR #12 onto main and push.',
      sentence: 'I want to rebase PR #12.',
      why: 'It conflicts with main.',
      itemId: 'item-1',
      itemVersion: 1,
      source: {
        platform: 'webchat',
        integrationId: null,
        channel: 'conv-1',
        thread: 'subsession:patrol-1',
        transportScope: null,
        sessionKey: null,
        sessionId: null,
        place: false
      },
      approver: {
        kind: 'place',
        integrationId: '',
        channel: 'conv-1',
        userId: null,
        teamId: null,
        consoleUserId: null
      },
      now: 1_000
    })
    for (const write of [
      { ...req, draftId: proposal.id },
      { ...req, draftId: proposal.id, conversation: { sessionId: 'sid-webchat' } }
    ])
      await expect(activity.write(write)).rejects.toMatchObject({ reason: 'assistant-mode-off' })
    expect(decideDraft).toHaveBeenCalledTimes(2)
  })
})

describe('the Activity view: who it answers', () => {
  it('refuses an agent it does not hold before touching the store', async () => {
    const { s, a, activity } = await setup()
    const item = await createFollowUp(s, a)
    const refusal = async (run: () => Promise<unknown>) => {
      const err = await run().then(
        () => undefined,
        (e: unknown) => e
      )
      expect(err).toBeInstanceOf(AssistantActivityViolationError)
      return (err as AssistantActivityViolationError).reason
    }
    const unknown = randomUUID()
    expect(await refusal(() => activity.read({ agentId: unknown, operation: 'drafts', limit: 10 }))).toBe(
      'unknown-agent'
    )
    expect(await refusal(() => activity.write({ agentId: unknown, operation: 'delete-item', itemId: item.id }))).toBe(
      'unknown-agent'
    )
    const stopUnknown = activity.write({
      agentId: unknown,
      operation: 'stop-subsession',
      sessionId: 'sid-child',
      actor: { userId: 'usr-1', name: null }
    })
    expect(await refusal(() => stopUnknown)).toBe('unknown-agent')
    expect(await s.assistantItems.get(a, item.id)).toBeDefined()
  })

  it('answers an agent outside assistant mode with its permission requests, sub-sessions and drafts, and no items, patrols or proposals', async () => {
    const { s, off, activity, stopSession } = await setup()
    // What the agent kept from a time it was in assistant mode stays out of view.
    const item = await createFollowUp(s, off)
    const parentKey = sessionKey('webchat', 'conv-1', 'webchat:conv-1', off)
    await s.upsertSession({
      key: parentKey,
      agentId: off,
      platform: 'webchat',
      channel: 'conv-1',
      thread: 'webchat:conv-1',
      transportScope: null,
      acpSessionId: 'acp-parent',
      sessionId: 'sid-parent',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1_000
    })
    const child = (id: string) => sessionKey('webchat', 'conv-1', subsessionCoordinate(id), off)
    const open = { agentId: off, parentSessionId: 'sid-parent', parentSessionKey: parentKey }
    await s.assistantSubsessions.open({ ...open, childSessionKey: child('delegated'), now: 1_000 })
    await s.assistantSubsessions.openFollowUp({ ...open, childSessionKey: child('patrol-1'), now: 2_000 })
    await s.upsertSession({
      key: child('delegated'),
      agentId: off,
      platform: 'webchat',
      channel: 'conv-1',
      thread: subsessionCoordinate('delegated'),
      transportScope: null,
      acpSessionId: 'acp-delegated',
      sessionId: 'sid-delegated',
      state: 'prompting',
      lastDeliveredTs: null,
      updatedAt: 1_000
    })
    const post = await s.assistantDrafts.create({ ...draftInput(off), now: 1_000 })
    await s.assistantDrafts.createTask({
      agentId: off,
      target: { platform: 'webchat', integrationId: '', channel: 'conv-1', thread: null },
      task: 'Rebase PR #12 onto main and push.',
      sentence: 'I want to rebase PR #12.',
      why: 'It conflicts with main.',
      itemId: item.id,
      itemVersion: 1,
      source: {
        platform: 'webchat',
        integrationId: null,
        channel: 'conv-1',
        thread: 'subsession:patrol-1',
        transportScope: null,
        sessionKey: null,
        sessionId: null,
        place: false
      },
      approver: {
        kind: 'place',
        integrationId: '',
        channel: 'conv-1',
        userId: null,
        teamId: null,
        consoleUserId: null
      },
      now: 1_000
    })

    expect(await read(activity, { agentId: off, operation: 'items', section: 'open', limit: 10 })).toEqual({
      operation: 'items',
      items: [],
      truncated: false
    })
    expect(await read(activity, { agentId: off, operation: 'item', itemId: item.id })).toEqual({
      operation: 'item',
      item: null
    })
    expect(await read(activity, { agentId: off, operation: 'subsessions', limit: 10 })).toEqual({
      operation: 'subsessions',
      subsessions: [
        {
          sessionId: 'sid-delegated',
          parentSessionId: 'sid-parent',
          state: 'open',
          createdAt: '1970-01-01T00:00:01.000Z',
          kind: 'delegated'
        }
      ],
      truncated: false,
      followUps: true
    })
    expect(
      await read(activity, { agentId: off, operation: 'subsessions', limit: 10, parent: { sessionId: 'sid-parent' } })
    ).toMatchObject({ subsessions: [{ sessionId: 'sid-delegated' }], truncated: false, nextCursor: null })
    const drafts = await read(activity, {
      agentId: off,
      operation: 'drafts',
      limit: 10,
      proposals: true,
      permissions: true
    })
    expect(drafts.drafts.map((d) => d.id)).toEqual([post.id])
    expect(drafts.permissions).toEqual([PERMISSION])
    expect(
      await read(activity, { agentId: off, operation: 'drafts', limit: 10, conversation: { sessionId: 'sid-parent' } })
    ).toEqual({ operation: 'drafts', drafts: [], truncated: false })

    // No item is deleted; a sub-session stops as any agent's does.
    expect(await activity.write({ agentId: off, operation: 'delete-item', itemId: item.id })).toEqual({
      operation: 'delete-item',
      found: false
    })
    expect(await s.assistantItems.get(off, item.id)).toBeDefined()
    expect(
      await activity.write({
        agentId: off,
        operation: 'stop-subsession',
        sessionId: 'sid-delegated',
        actor: { userId: 'usr-1', name: null }
      })
    ).toEqual({ operation: 'stop-subsession', result: 'stopped' })
    expect(stopSession).toHaveBeenCalledWith(child('delegated'), { userId: 'usr-1' })
  })
})

function draftInput(agentId: string) {
  return {
    agentId,
    kind: 'elsewhere' as const,
    target: { platform: 'slack', integrationId: 'int-a', channel: 'C0SUPPORT', thread: null },
    text: 'Another draft.'
  }
}
