// The console's Activity view of an agent (assistant-mode.md §1.7, §5.11), answered from the daemon's own store.
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ASSISTANT_ACTIVITY_OBSERVATIONS_MAX,
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
import { LocalStore, sessionKey } from '../src/store/local-store.js'
import { openTestStore } from './store-support.js'

const DM = { platform: 'slack', channel: 'D0ALICE', transportScope: 'T0EXAMPLE' }
const SUPPORT = { platform: 'slack', channel: 'C0SUPPORT', transportScope: 'T0EXAMPLE' }
const WEBCHAT = { platform: 'webchat', channel: 'conv-1', transportScope: null }
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

const createItem = (s: LocalStore, agentId: string, over: Record<string, unknown> = {}) =>
  s.assistantItems.create({
    agentId,
    title: 'Ship the release notes',
    doneWhen: 'The notes are published',
    origin: DM,
    followers: [
      { identity: 'slack:T0EXAMPLE:U0ALICE', place: DM },
      { identity: 'slack:T0EXAMPLE:U0BOB', place: SUPPORT },
      { identity: 'slack:T0EXAMPLE:U0CAROL', place: SUPPORT }
    ],
    now: 1_000,
    ...over
  })

describe('the Activity view: items', () => {
  it('lists open and closed items apart, with places and never a follower’s identity', async () => {
    const { s, a, b, activity } = await setup()
    const open = await createItem(s, a, { nextCheck: 86_400_000, now: 1_000 })
    const waiting = await createItem(s, a, { title: 'Wait for the review', status: 'waiting', now: 2_000 })
    const done = await createItem(s, a, { title: 'Rotate the key', status: 'done', now: 3_000 })
    await createItem(s, b, { title: 'Another agent’s item' })

    const page = await read(activity, { agentId: a, operation: 'items', section: 'open', limit: 50 })
    expect(page.truncated).toBe(false)
    expect(page.items.map((i) => i.id)).toEqual([waiting.id, open.id])
    expect(page.items[1]).toEqual({
      id: open.id,
      title: 'Ship the release notes',
      status: 'active',
      doneWhen: 'The notes are published',
      nextCheck: '1970-01-02T00:00:00.000Z',
      origin: { platform: 'slack', channel: 'D0ALICE' },
      places: [
        { platform: 'slack', channel: 'D0ALICE' },
        { platform: 'slack', channel: 'C0SUPPORT' }
      ],
      createdAt: '1970-01-01T00:00:01.000Z',
      updatedAt: '1970-01-01T00:00:01.000Z'
    })
    expect(JSON.stringify(page)).not.toContain('U0ALICE')

    const closed = await read(activity, { agentId: a, operation: 'items', section: 'closed', limit: 50 })
    expect(closed.items.map((i) => i.id)).toEqual([done.id])
    const first = await read(activity, { agentId: a, operation: 'items', section: 'open', limit: 1 })
    expect(first).toMatchObject({ items: [{ id: waiting.id }], truncated: true })
  })

  it('stops a list short of the wire budget and says so', async () => {
    const { s, a, activity } = await setup()
    // Each item is ~6 KB of UTF-8, so a hundred of them could never ride one frame.
    for (let i = 0; i < 40; i++) await createItem(s, a, { doneWhen: '完'.repeat(2_000), now: i })
    const page = await read(activity, { agentId: a, operation: 'items', section: 'open', limit: 100 })
    expect(page.truncated).toBe(true)
    expect(page.items.length).toBeGreaterThan(0)
    expect(page.items.length).toBeLessThan(40)
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(ASSISTANT_ACTIVITY_RESULT_BYTES)
  })

  it('reads one item’s summary and its newest observations, newest first; another agent’s reads as absent', async () => {
    const { s, a, b, activity } = await setup()
    const item = await createItem(s, a, { summary: 'Draft is in review.' })
    for (let i = 1; i <= ASSISTANT_ACTIVITY_OBSERVATIONS_MAX + 2; i++) {
      await s.assistantItems.appendObservation(a, item.id, { text: `check ${i}`, author: 'user:usr-1', now: i * 1_000 })
    }
    const { item: detail } = await read(activity, { agentId: a, operation: 'item', itemId: item.id })
    expect(detail?.summary).toBe('Draft is in review.')
    expect(detail?.observations).toHaveLength(ASSISTANT_ACTIVITY_OBSERVATIONS_MAX)
    expect(detail?.observations[0]).toEqual({ text: 'check 12', at: '1970-01-01T00:00:12.000Z' })
    expect(detail?.observations.at(-1)?.text).toBe('check 3')
    expect(JSON.stringify(detail)).not.toContain('usr-1')
    expect((await read(activity, { agentId: b, operation: 'item', itemId: item.id })).item).toBeNull()
  })

  it('deletes an item of the agent named, and only that agent’s', async () => {
    const { s, a, b, activity } = await setup()
    const item = await createItem(s, a)
    expect(await activity.write({ agentId: b, operation: 'delete-item', itemId: item.id })).toEqual({
      operation: 'delete-item',
      found: false
    })
    expect(await s.assistantItems.get(a, item.id)).toBeDefined()
    expect(await activity.write({ agentId: a, operation: 'delete-item', itemId: item.id })).toEqual({
      operation: 'delete-item',
      found: true
    })
    expect(await s.assistantItems.get(a, item.id)).toBeUndefined()
    expect(await activity.write({ agentId: a, operation: 'delete-item', itemId: item.id })).toMatchObject({
      found: false
    })
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
        { sessionId: null, parentSessionId: 'sid-parent', state: 'open', createdAt: '1970-01-01T00:00:03.000Z' },
        {
          sessionId: 'sid-running',
          parentSessionId: 'sid-parent',
          state: 'open',
          createdAt: '1970-01-01T00:00:02.000Z'
        },
        { sessionId: null, parentSessionId: 'sid-parent', state: 'done', createdAt: '1970-01-01T00:00:01.000Z' }
      ],
      truncated: false
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
      { sessionId: 'sid-child', parentSessionId: 'sid-parent', state: 'failed', createdAt: '1970-01-01T00:00:01.000Z' }
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
    const item = await createItem(s, a)
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
    const item = await createItem(s, off)
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
    await s.assistantSubsessions.openPatrol(
      { ...open, childSessionKey: child('patrol-1'), now: 2_000 },
      { startedSince: 0, staleBefore: 0 }
    )
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
          createdAt: '1970-01-01T00:00:01.000Z'
        }
      ],
      truncated: false
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

    // Deleting an item is refused; a sub-session stops as any agent's does.
    await expect(activity.write({ agentId: off, operation: 'delete-item', itemId: item.id })).rejects.toMatchObject({
      reason: 'assistant-mode-off'
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
