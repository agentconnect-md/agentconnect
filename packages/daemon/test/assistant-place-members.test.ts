// Live membership behind per-asker scoping (assistant-mode.md §5.5): the cache, its failures, and who counts as the asker.
import { describe, expect, it, vi } from 'vitest'
import { PLACE_MEMBERS_TTL_MS, PlaceMembers } from '../src/assistant/place-members.js'
import type { MessageGateway, SessionContext } from '../src/mcp/ops.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'

type Gateway = Pick<MessageGateway, 'getChannelInfo' | 'listMemberIds'>

function setup(gateway: Partial<Gateway> = {}) {
  const clock = { now: 1_000 }
  const gw: Gateway = {
    getChannelInfo: vi.fn(async (id: string) => ({ id, isIm: id.startsWith('D'), user: 'U_P' })),
    listMemberIds: vi.fn(async () => ['U_P', 'U_ALICE']),
    ...gateway
  }
  const members = new PlaceMembers({ now: () => clock.now, gatewayFor: (id) => (id === 'int-slack' ? gw : undefined) })
  return { clock, gw, members }
}

const dm: SessionContext = {
  agentId: 'agent-a',
  platform: 'slack',
  integrationId: 'int-slack',
  transportScope: 'scope-slack',
  isDm: true,
  channel: 'D_P',
  thread: 'append:1',
  deliveryThread: '1.1',
  tools: []
}

const fromP = {
  msgId: 'm-1',
  traceId: 't-1',
  source: 'user',
  platform: 'slack',
  channel: 'D_P',
  sender: { id: 'U_P', isBot: false },
  text: 'hi',
  mentionedBots: [],
  isDm: true
} as NormalizedMessage

describe('PlaceMembers.isMember', () => {
  it('answers from one listing per conversation for a minute, then asks again', async () => {
    const { clock, gw, members } = setup()
    expect(await members.isMember('int-slack', 'C_PRIV', 'U_P')).toBe(true)
    expect(await members.isMember('int-slack', 'C_PRIV', 'U_Q')).toBe(false)
    vi.mocked(gw.listMemberIds!).mockResolvedValue(['U_ALICE'])
    clock.now += PLACE_MEMBERS_TTL_MS - 1
    expect(await members.isMember('int-slack', 'C_PRIV', 'U_P')).toBe(true)
    clock.now += 2
    expect(await members.isMember('int-slack', 'C_PRIV', 'U_P')).toBe(false)
    expect(gw.listMemberIds).toHaveBeenCalledTimes(2)
  })

  it('shares one lookup between concurrent reads', async () => {
    const { gw, members } = setup()
    await Promise.all([
      members.isMember('int-slack', 'C_PRIV', 'U_P'),
      members.isMember('int-slack', 'C_PRIV', 'U_ALICE')
    ])
    expect(gw.listMemberIds).toHaveBeenCalledTimes(1)
  })

  it('answers false when it cannot confirm, and never keeps a failure', async () => {
    const { gw, members } = setup({ listMemberIds: vi.fn().mockRejectedValueOnce(new Error('ratelimited')) })
    expect(await members.isMember('int-slack', 'C_PRIV', 'U_P')).toBe(false)
    vi.mocked(gw.listMemberIds!).mockResolvedValue(['U_P'])
    expect(await members.isMember('int-slack', 'C_PRIV', 'U_P')).toBe(true)
    // No connection for the bot, or a connection without the listing, confirms nothing.
    expect(await members.isMember('int-other', 'C_PRIV', 'U_P')).toBe(false)
    const portless = setup({ listMemberIds: undefined })
    expect(await portless.members.isMember('int-slack', 'C_PRIV', 'U_P')).toBe(false)
  })
})

describe('PlaceMembers.askerIn', () => {
  it("names the DM's counterpart when their own message started the turn", async () => {
    const { members } = setup()
    expect(await members.askerIn(dm, fromP)).toEqual({ integrationId: 'int-slack', userId: 'U_P' })
  })

  it('names nobody for any other turn or session', async () => {
    const { members } = setup()
    const cases: [string, SessionContext, NormalizedMessage | undefined][] = [
      ['no live turn', dm, undefined],
      ['a report round', dm, { ...fromP, source: 'agent', sender: { id: 'peer', isBot: true }, parentReport: true }],
      ['a scheduled run', dm, { ...fromP, source: 'cron' }],
      ['a console continuation', dm, { ...fromP, adoptedSession: true }],
      ['a headless turn', dm, { ...fromP, headless: true }],
      ['a bot', dm, { ...fromP, sender: { id: 'U_P', isBot: true } }],
      ['another sender', dm, { ...fromP, sender: { id: 'U_Q', isBot: false } }],
      ['a message from elsewhere', dm, { ...fromP, channel: 'D_Q' }],
      ['a group DM', { ...dm, isDm: false, channel: 'G_MPIM' }, { ...fromP, channel: 'G_MPIM', isDm: false }],
      ['a sub-session', { ...dm, thread: 'subsession:d-1' }, fromP],
      ['webchat', { ...dm, platform: 'webchat', integrationId: undefined }, { ...fromP, platform: 'webchat' }]
    ]
    for (const [label, ctx, msg] of cases) expect(await members.askerIn(ctx, msg), label).toBeUndefined()
  })

  it('names nobody when the platform does not confirm the counterpart', async () => {
    const notIm = setup({ getChannelInfo: vi.fn(async (id: string) => ({ id, isIm: false, user: 'U_P' })) })
    expect(await notIm.members.askerIn(dm, fromP)).toBeUndefined()
    const failing = setup({ getChannelInfo: vi.fn(async () => Promise.reject(new Error('ratelimited'))) })
    expect(await failing.members.askerIn(dm, fromP)).toBeUndefined()
    const other = setup({ getChannelInfo: vi.fn(async (id: string) => ({ id, isIm: true, user: 'U_Q' })) })
    expect(await other.members.askerIn(dm, fromP)).toBeUndefined()
  })
})
