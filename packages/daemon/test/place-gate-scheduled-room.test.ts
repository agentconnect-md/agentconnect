import { describe, expect, it } from 'vitest'
import { CLOSED_LOOKUPS, NOBODY, type TurnAskers } from '../src/assistant/place-access.js'
import type { SessionContext } from '../src/mcp/ops/context.js'
import {
  judgePlaceWrite,
  type PlaceAccessDeps,
  type PlaceSnapshotRow,
  type WriteTarget
} from '../src/mcp/ops/place-gate.js'
import { buildSyntheticMessage, scheduleAnchorOf, scheduleRoomMessage } from '../src/scheduler/scheduler.js'

const ctx = {
  agentId: 'a1',
  platform: 'slack',
  integrationId: 'i1',
  channel: 'C1',
  thread: '1.005',
  deliveryThread: '1.005',
  isDm: false,
  tools: []
} as SessionContext

const room = (over: Partial<Extract<WriteTarget, { kind: 'new' }>> = {}): WriteTarget => ({
  kind: 'new',
  platform: 'slack',
  integrationId: 'i1',
  users: ['U1'],
  anchoredIn: 'C1',
  ...over
})

const PUBLIC: PlaceSnapshotRow = { kind: 'channel', isPrivate: false, externalReason: null }
const PRIVATE = { placeSnapshot: (): PlaceSnapshotRow => ({ ...PUBLIC, isPrivate: true }) }
// U1 and U2 are full members of the workspace; only U1 is in the anchor conversation.
const lookups = {
  ...CLOSED_LOOKUPS,
  fullMember: async (_bot: string, user: string) => user === 'U1' || user === 'U2',
  member: async (_bot: string, _channel: string, user: string) => user === 'U1',
  linked: async () => 'U1'
}

const deps = (askers: TurnAskers = NOBODY, over: Partial<PlaceAccessDeps> = {}): PlaceAccessDeps =>
  ({
    gatewayFor: () => undefined,
    readAskers: async () => askers,
    scheduleAnchor: () => ({ channel: 'C1', ts: '1.005' }),
    placeSnapshot: () => PUBLIC,
    targetExternal: async () => false,
    readLookups: () => lookups,
    ...over
  }) as PlaceAccessDeps

const judge = (target: WriteTarget, d: PlaceAccessDeps) => judgePlaceWrite(ctx, 'createSlackCodeChannel', target, d)
const NOBODY_REFUSAL = 'no person started this run'
const ANCHOR_REFUSAL = 'only from its own post in its own conversation'
const EMPTY_REFUSAL = 'at least one person invited'
const AUDIENCE_REFUSAL = 'takes only members of that conversation'
const PERSON: TurnAskers = { people: [{ kind: 'console', userId: 'u1' }], nobody: false }

describe('the write rule on a code channel a schedule makes from its own post', () => {
  it('lets a run no person is behind make one with the people it invites', async () => {
    await expect(judge(room(), deps())).resolves.toBe('post')
    await expect(judge(room({ users: ['<@U1>', 'U2'] }), deps())).resolves.toBe('post')
  })

  it('refuses a channel nobody is invited to, so none is left without an owner', async () => {
    await expect(judge(room({ users: [] }), deps())).rejects.toThrow(EMPTY_REFUSAL)
    await expect(judge(room({ users: [] }), deps(PERSON))).rejects.toThrow(EMPTY_REFUSAL)
  })

  it('invites only members of the organization', async () => {
    await expect(judge(room({ users: ['U1', 'U_GUEST'] }), deps())).rejects.toThrow('members of your organization')
  })

  it('keeps a private anchor’s channel to that conversation’s members', async () => {
    await expect(judge(room(), deps(NOBODY, PRIVATE))).resolves.toBe('post')
    await expect(judge(room({ users: ['U1', 'U2'] }), deps(NOBODY, PRIVATE))).rejects.toThrow(AUDIENCE_REFUSAL)
  })

  it('treats an anchor whose privacy is unknown as private', async () => {
    const unknown = { placeSnapshot: (): PlaceSnapshotRow => ({ kind: 'channel', externalReason: null }) }
    await expect(judge(room(), deps(NOBODY, unknown))).resolves.toBe('post')
    await expect(judge(room({ users: ['U2'] }), deps(NOBODY, unknown))).rejects.toThrow(AUDIENCE_REFUSAL)
  })

  it('still refuses anything new that names no anchor', async () => {
    const { anchoredIn: _anchoredIn, ...plain } = room() as Extract<WriteTarget, { kind: 'new' }>
    await expect(judge(plain, deps())).rejects.toThrow(NOBODY_REFUSAL)
  })

  it('takes the anchor from the live turn, never from the caller’s claim', async () => {
    // A hook or a report round has no schedule anchor, whatever its tool says.
    await expect(judge(room(), deps(NOBODY, { scheduleAnchor: () => undefined }))).rejects.toThrow(ANCHOR_REFUSAL)
    await expect(judge(room(), deps(NOBODY, { scheduleAnchor: undefined }))).rejects.toThrow(ANCHOR_REFUSAL)
    await expect(
      judge(room(), deps(NOBODY, { scheduleAnchor: () => ({ channel: 'C9', ts: '1.005' }) }))
    ).rejects.toThrow(ANCHOR_REFUSAL)
  })

  it('refuses an anchor in any other conversation, and a bot that is not the agent’s own', async () => {
    const elsewhere = deps(NOBODY, { scheduleAnchor: () => ({ channel: 'C9', ts: '1.005' }) })
    await expect(judge(room({ anchoredIn: 'C9' }), elsewhere)).rejects.toThrow(ANCHOR_REFUSAL)
    await expect(judge(room({ integrationId: 'other' }), deps())).rejects.toThrow()
  })

  it('refuses an anchor that is not a channel', async () => {
    const dm = { placeSnapshot: (): PlaceSnapshotRow => ({ kind: 'im' }) }
    await expect(judge(room(), deps(NOBODY, dm))).rejects.toThrow(ANCHOR_REFUSAL)
    await expect(judge(room(), deps(NOBODY, { placeSnapshot: () => undefined }))).rejects.toThrow(ANCHOR_REFUSAL)
  })

  it('refuses a conversation shared with another organization, and fails closed when that is unknown', async () => {
    const listed = { placeSnapshot: () => ({ ...PUBLIC, externalReason: 'shared' }) }
    await expect(judge(room(), deps(NOBODY, listed))).rejects.toThrow(ANCHOR_REFUSAL)
    await expect(judge(room(), deps(NOBODY, { targetExternal: async () => true }))).rejects.toThrow(ANCHOR_REFUSAL)
    await expect(
      judge(room(), deps(NOBODY, { targetExternal: async () => Promise.reject(new Error('down')) }))
    ).rejects.toThrow(ANCHOR_REFUSAL)
    await expect(judge(room(), deps(NOBODY, { targetExternal: undefined }))).rejects.toThrow(ANCHOR_REFUSAL)
  })

  it('judges a schedule that records a person as that person, so the anchor widens nothing', async () => {
    const guest = { readLookups: () => ({ ...lookups, linked: async () => 'U_GUEST' }) }
    await expect(judge(room(), deps(PERSON, guest))).rejects.toThrow('full members of this workspace')
    await expect(judge(room(), deps(PERSON))).resolves.toBe('post')
  })

  it('never exempts a turn with a person in it, even one also marked nobody', async () => {
    const mixed: TurnAskers = {
      people: [{ kind: 'member', platform: 'slack', integrationId: 'i1', userId: 'U_GUEST' }],
      nobody: true
    }
    await expect(judge(room(), deps(mixed))).rejects.toThrow(NOBODY_REFUSAL)
  })
})

describe('scheduleAnchorOf', () => {
  const fire = { source: 'cron', channel: 'C1', transcriptTs: '1.005' } as const

  it('names the post of an anchored fire', () => {
    expect(scheduleAnchorOf(fire, 0)).toEqual({ channel: 'C1', ts: '1.005' })
  })

  it.each([
    ['a person’s message', { ...fire, source: 'user' as const }, 0],
    ['an agent’s call', { ...fire, source: 'agent' as const }, 0],
    ['a headless fire', { ...fire, headless: true }, 0],
    ['a fire whose anchor failed to post', { source: 'cron' as const, channel: 'C1' }, 0],
    ['a fire with a message folded in', fire, 1]
  ])('has none for %s', (_name, msg, folded) => {
    expect(scheduleAnchorOf(msg, folded)).toBeUndefined()
  })
})

describe('scheduleRoomMessage', () => {
  it('carries the schedule into the room as its own turn: its person, the task as its text, and no run to report', () => {
    const cron = {
      id: 'tickets',
      schedule: '0 9 * * 1',
      trigger: 'pick up the next ticket',
      target: { platform: 'slack', channel: 'C1', integrationId: 'i1' },
      enabled: true
    }
    const fire = { ...buildSyntheticMessage('a1', cron, 't1').msg, cronRun: { cronId: 'tickets', firedAt: 'now' } }
    const room = scheduleRoomMessage({ ...fire, transcriptTs: '1.005' }, 'C2', 'Fix ticket 42', 't2')
    expect(room).toMatchObject({ source: 'cron', channel: 'C2', text: 'Fix ticket 42', sender: fire.sender })
    // The schedule's recorded person is found by its id, which the room turn keeps without the run.
    expect(room.roomOfCron).toBe('tickets')
    expect(room.msgId).not.toBe(fire.msgId)
    expect(room).not.toHaveProperty('cronRun')
    expect(room).not.toHaveProperty('transcriptTs')
    expect(room).not.toHaveProperty('headless')
  })
})
