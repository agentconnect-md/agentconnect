import { describe, expect, it } from 'vitest'
import { CLOSED_LOOKUPS, NOBODY, type TurnAskers } from '../src/assistant/place-access.js'
import type { SessionContext } from '../src/mcp/ops/context.js'
import {
  judgePlaceWrite,
  type PlaceAccessDeps,
  type PlaceSnapshotRow,
  type WriteTarget
} from '../src/mcp/ops/place-gate.js'
import { scheduleAnchorOf } from '../src/scheduler/scheduler.js'

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
  users: [],
  anchoredIn: 'C1',
  ...over
})

const PUBLIC: PlaceSnapshotRow = { kind: 'channel', isPrivate: false, externalReason: null }

const deps = (askers: TurnAskers = NOBODY, over: Partial<PlaceAccessDeps> = {}): PlaceAccessDeps =>
  ({
    gatewayFor: () => undefined,
    readAskers: async () => askers,
    scheduleAnchor: () => ({ channel: 'C1', ts: '1.005' }),
    placeSnapshot: () => PUBLIC,
    targetExternal: async () => false,
    readLookups: () => CLOSED_LOOKUPS,
    ...over
  }) as PlaceAccessDeps

const judge = (target: WriteTarget, d: PlaceAccessDeps) => judgePlaceWrite(ctx, 'createSlackCodeChannel', target, d)
const NOBODY_REFUSAL = 'no person started this run'
const ANCHOR_REFUSAL = 'only from its own post in a public channel'
const PERSON: TurnAskers = { people: [{ kind: 'console', userId: 'u1' }], nobody: false }

describe('the write rule on a code channel made from a schedule’s own post', () => {
  it('lets a run no person is behind make one from its own public conversation', async () => {
    await expect(judge(room(), deps())).resolves.toBe('post')
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

  it('refuses an anchor in any other conversation', async () => {
    const elsewhere = deps(NOBODY, { scheduleAnchor: () => ({ channel: 'C9', ts: '1.005' }) })
    await expect(judge(room({ anchoredIn: 'C9' }), elsewhere)).rejects.toThrow(ANCHOR_REFUSAL)
  })

  it('refuses a bot that is not the agent’s own', async () => {
    await expect(judge(room({ integrationId: 'other' }), deps())).rejects.toThrow(ANCHOR_REFUSAL)
  })

  it('refuses a private anchor, for a schedule that records a person too', async () => {
    const privately = { placeSnapshot: () => ({ ...PUBLIC, isPrivate: true }) }
    await expect(judge(room(), deps(NOBODY, privately))).rejects.toThrow(ANCHOR_REFUSAL)
    await expect(judge(room(), deps(PERSON, privately))).rejects.toThrow(ANCHOR_REFUSAL)
  })

  it('refuses when nothing confirms the anchor is a public channel', async () => {
    await expect(judge(room(), deps(NOBODY, { placeSnapshot: () => undefined }))).rejects.toThrow(ANCHOR_REFUSAL)
    const dm = { placeSnapshot: (): PlaceSnapshotRow => ({ kind: 'im' }) }
    await expect(judge(room(), deps(NOBODY, dm))).rejects.toThrow(ANCHOR_REFUSAL)
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
    await expect(judge(room(), deps(PERSON))).rejects.toThrow('full members of this workspace')
    const member = {
      readLookups: () => ({ ...CLOSED_LOOKUPS, linked: async () => 'U1', fullMember: async () => true })
    }
    await expect(judge(room(), deps(PERSON, member))).resolves.toBe('post')
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
    ['a hook', { ...fire, source: 'hook' as const }, 0],
    ['a headless fire', { ...fire, headless: true }, 0],
    ['a fire whose anchor failed to post', { source: 'cron' as const, channel: 'C1' }, 0],
    ['a fire with a message folded in', fire, 1]
  ])('has none for %s', (_name, msg, folded) => {
    expect(scheduleAnchorOf(msg, folded)).toBeUndefined()
  })
})
