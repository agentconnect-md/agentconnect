// The console's Activity view of an assistant-mode agent (assistant-mode.md §1.7, §5.11), answered from the daemon's own store.
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ASSISTANT_ACTIVITY_OBSERVATIONS_MAX,
  ASSISTANT_ACTIVITY_RESULT_BYTES,
  AssistantActivityReadResult,
  AssistantActivityWriteResult,
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
import { ASSISTANT_DRAFT_TTL_MS, assistantGrantId } from '../src/store/assistant-drafts.js'
import { LocalStore, sessionKey } from '../src/store/local-store.js'
import { openTestStore } from './store-support.js'

const DM = { platform: 'slack', channel: 'D0ALICE', transportScope: 'T0EXAMPLE' }
const SUPPORT = { platform: 'slack', channel: 'C0SUPPORT', transportScope: 'T0EXAMPLE' }
const WEBCHAT = { platform: 'webchat', channel: 'conv-1', transportScope: null }
const NOW = 10_000

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
  const agents = new Map<string, { assistantMode: { enabled: boolean; responsibleUserId?: string } }>([
    [a, { assistantMode: { enabled: true, responsibleUserId: 'usr-1' } }],
    [b, { assistantMode: { enabled: true, responsibleUserId: 'usr-1' } }],
    [off, { assistantMode: { enabled: false } }]
  ])
  const decideDraft = vi.fn(
    async (_input: Parameters<AssistantActivityDeps['decideDraft']>[0]): Promise<DraftDecision> => ({
      result: 'decided',
      status: 'succeeded',
      granted: false,
      failure: null
    })
  )
  const activity = createAssistantActivity({
    store: () => s,
    agent: (id) => agents.get(id),
    now: () => NOW,
    decideDraft
  })
  return { s, a, b, off, activity, decideDraft }
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
})

describe('the Activity view: drafts and grants', () => {
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
          offerAlways: false,
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

  it('lists the agent’s grants with who granted them, and revokes one by its id', async () => {
    const { s, a, b, activity } = await setup()
    await s.setDisplayName('U0ALICE', 'Alice', 1_000)
    const here = { platform: 'slack', integrationId: 'int-a', channel: 'D0ALICE' }
    const there = { platform: 'slack', integrationId: 'int-a', channel: 'C0SUPPORT' }
    const webchat = { platform: 'webchat', integrationId: null, channel: 'conv-1' }
    await s.assistantDrafts.grant(a, here, there, 'T0EXAMPLE:U0ALICE', 0, 1_000)
    await s.assistantDrafts.grant(a, webchat, there, null, 0, 2_000)
    await s.assistantDrafts.grant(b, here, there, null, 0, 1_000)

    const page = await read(activity, { agentId: a, operation: 'grants' })
    expect(page).toEqual({
      operation: 'grants',
      grants: [
        {
          id: assistantGrantId(webchat, there),
          source: webchat,
          target: there,
          grantedByName: null,
          grantedAt: '1970-01-01T00:00:02.000Z'
        },
        {
          id: assistantGrantId(here, there),
          source: here,
          target: there,
          grantedByName: 'Alice',
          grantedAt: '1970-01-01T00:00:01.000Z'
        }
      ],
      truncated: false
    })

    const id = assistantGrantId(here, there)
    expect(
      await activity.write({ agentId: b, operation: 'revoke-grant', grantId: assistantGrantId(webchat, there) })
    ).toEqual({ operation: 'revoke-grant', found: false })
    expect(await activity.write({ agentId: a, operation: 'revoke-grant', grantId: id })).toEqual({
      operation: 'revoke-grant',
      found: true
    })
    expect(await s.assistantDrafts.granted(a, here, there)).toBe(false)
    expect(await s.assistantDrafts.granted(b, here, there)).toBe(true)
    expect((await read(activity, { agentId: a, operation: 'grants' })).grants.map((g) => g.id)).toEqual([
      assistantGrantId(webchat, there)
    ])
  })
})

describe('the Activity view: deciding a draft', () => {
  it('hands the decision to the draft path, names the console decider for grant listings, and bounds the failure', async () => {
    const { s, a, activity, decideDraft } = await setup()
    decideDraft.mockResolvedValueOnce({
      result: 'decided',
      status: 'failed',
      granted: false,
      failure: '😀'.repeat(3_000)
    })
    const req = {
      agentId: a,
      operation: 'decide-draft' as const,
      draftId: 'draft-1',
      choice: 'always' as const,
      decider: { userId: 'usr-2', name: 'Grace' }
    }
    const answer = await activity.write(req)
    expect(decideDraft).toHaveBeenCalledWith(req)
    expect(answer).toMatchObject({ operation: 'decide-draft', result: 'decided', status: 'failed', granted: false })
    expect(AssistantActivityWriteResult.safeParse(answer).success).toBe(true)
    expect((await s.getDisplayNames(['usr-2'])).get('usr-2')).toBe('Grace')

    decideDraft.mockResolvedValueOnce({ result: 'expired', status: 'expired', granted: false, failure: null })
    expect(await activity.write({ ...req, choice: 'discard', decider: { userId: 'usr-3', name: null } })).toEqual({
      operation: 'decide-draft',
      result: 'expired',
      status: 'expired',
      granted: false,
      failure: null
    })
    expect((await s.getDisplayNames(['usr-3'])).size).toBe(0)
  })

  it('never reaches the draft path for an agent it does not hold or one outside assistant mode', async () => {
    const { off, activity, decideDraft } = await setup()
    for (const agentId of [randomUUID(), off]) {
      const write = activity.write({
        agentId,
        operation: 'decide-draft',
        draftId: 'draft-1',
        choice: 'approve',
        decider: { userId: 'usr-2', name: 'Grace' }
      })
      await expect(write).rejects.toBeInstanceOf(AssistantActivityViolationError)
    }
    expect(decideDraft).not.toHaveBeenCalled()
  })
})

describe('the Activity view: who it answers', () => {
  it('refuses an agent it does not hold, and one not in assistant mode, before touching the store', async () => {
    const { s, a, off, activity } = await setup()
    const item = await createItem(s, off)
    await createItem(s, a, { origin: WEBCHAT, followers: [] })
    const refusal = async (run: () => Promise<unknown>) => {
      const err = await run().then(
        () => undefined,
        (e: unknown) => e
      )
      expect(err).toBeInstanceOf(AssistantActivityViolationError)
      return (err as AssistantActivityViolationError).reason
    }
    const unknown = randomUUID()
    expect(await refusal(() => activity.read({ agentId: unknown, operation: 'grants' }))).toBe('unknown-agent')
    expect(await refusal(() => activity.write({ agentId: unknown, operation: 'delete-item', itemId: item.id }))).toBe(
      'unknown-agent'
    )
    for (const operation of ['grants', 'drafts', 'subsessions'] as const) {
      const req = (operation === 'grants'
        ? { agentId: off, operation }
        : { agentId: off, operation, limit: 10 }) as unknown as AssistantActivityReadReq
      expect(await refusal(() => activity.read(req))).toBe('assistant-mode-off')
    }
    expect(await refusal(() => activity.read({ agentId: off, operation: 'items', section: 'open', limit: 10 }))).toBe(
      'assistant-mode-off'
    )
    expect(await refusal(() => activity.write({ agentId: off, operation: 'delete-item', itemId: item.id }))).toBe(
      'assistant-mode-off'
    )
    expect(await s.assistantItems.get(off, item.id)).toBeDefined()
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
