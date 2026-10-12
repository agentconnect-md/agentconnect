// The read rule's lookups and askers (assistant-mode.md §5.5): the cache, its failures, and who counts as asking.
import { describe, expect, it, vi } from 'vitest'
import {
  askerOfFollower,
  PLACE_MEMBERS_TTL_MS,
  PlaceMembers,
  turnAskers,
  type TurnMessage
} from '../src/assistant/place-members.js'
import { NOBODY, type ConsoleVerdict, type ReadAsker } from '../src/assistant/place-access.js'
import type { MessageGateway } from '../src/mcp/ops.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'

type Gateway = Pick<MessageGateway, 'getChannelInfo' | 'listMemberIds' | 'isFullMember'>

function setup(gateway: Partial<Gateway> = {}, verdict?: () => Promise<ConsoleVerdict>) {
  const clock = { now: 1_000 }
  const gw: Gateway = {
    getChannelInfo: vi.fn(async (id: string) => ({ id })),
    listMemberIds: vi.fn(async () => ['U_P', 'U_ALICE']),
    isFullMember: vi.fn(async (user: string) => user === 'U_P'),
    ...gateway
  }
  const readAccess = vi.fn(
    async (_agent: string, _asker: ReadAsker, _sessions: readonly string[]): Promise<ConsoleVerdict> =>
      verdict ? verdict() : { asker: 'unidentifiable' }
  )
  const members = new PlaceMembers({
    now: () => clock.now,
    gatewayFor: (id) => (id === 'int-slack' ? gw : undefined),
    readAccess
  })
  return { clock, gw, members, readAccess }
}

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

describe('PlaceMembers.isFullMember and consoleVerdict', () => {
  it('caches a workspace standing for a minute and confirms nothing without the port', async () => {
    const { clock, gw, members } = setup()
    expect(await members.isFullMember('int-slack', 'U_P')).toBe(true)
    expect(await members.isFullMember('int-slack', 'U_P')).toBe(true)
    expect(await members.isFullMember('int-slack', 'U_GUEST')).toBe(false)
    expect(gw.isFullMember).toHaveBeenCalledTimes(2)
    clock.now += PLACE_MEMBERS_TTL_MS
    await members.isFullMember('int-slack', 'U_P')
    expect(gw.isFullMember).toHaveBeenCalledTimes(3)
    expect(await setup({ isFullMember: undefined }).members.isFullMember('int-slack', 'U_P')).toBe(false)
  })

  it("caches the console's verdict per agent, asker and session set, and drops a failed one", async () => {
    const linked: ConsoleVerdict = { asker: 'linked', visible: new Set(['ses-1']) }
    const answers = [Promise.reject(new Error('offline')), Promise.resolve(linked)]
    answers[0]!.catch(() => {})
    const { members, readAccess } = setup({}, () => answers.shift()!)
    const asker: ReadAsker = { kind: 'member', platform: 'slack', integrationId: 'int-slack', userId: 'U_P' }
    await expect(members.consoleVerdict('agent-a', asker, ['ses-1'])).rejects.toThrow('offline')
    expect(await members.consoleVerdict('agent-a', asker, ['ses-1'])).toBe(linked)
    expect(await members.lookupsFor('agent-a').console(asker, ['ses-1'])).toBe(linked)
    expect(readAccess).toHaveBeenCalledTimes(2)
    expect(readAccess).toHaveBeenLastCalledWith('agent-a', asker, ['ses-1'])
  })

  it('confirms nothing on a daemon that cannot ask the console', async () => {
    const members = new PlaceMembers({ now: () => 0, gatewayFor: () => undefined })
    await expect(members.consoleVerdict('agent-a', { kind: 'console', userId: 'user-p' }, [])).rejects.toThrow()
  })
})

const fromP = {
  source: 'user',
  platform: 'slack',
  sender: { id: 'U_P', isBot: false }
} as NormalizedMessage
const msg = (over: Partial<NormalizedMessage>): TurnMessage => ({
  msg: { ...fromP, ...over },
  integrationId: 'int-slack'
})

describe('turnAskers', () => {
  it("names the turn's sender on the bot it arrived on, or the console user behind a webchat turn", () => {
    expect(turnAskers([{ msg: fromP }], 'int-slack')).toEqual({
      people: [{ kind: 'member', platform: 'slack', integrationId: 'int-slack', userId: 'U_P' }],
      nobody: false
    })
    expect(
      turnAskers([{ msg: { ...fromP, sender: { id: 'user-p', isBot: false } }, console: true }], undefined)
    ).toEqual({ people: [{ kind: 'console', userId: 'user-p' }], nobody: false })
  })

  it('names every sender a turn folds in, once each', () => {
    const askers = turnAskers([msg({}), msg({ sender: { id: 'U_Q', isBot: false } }), msg({})], 'int-slack')
    expect(askers.people.map((p) => (p.kind === 'member' ? p.userId : p.userId))).toEqual(['U_P', 'U_Q'])
    expect(askers.nobody).toBe(false)
  })

  it('names nobody for a turn no person sent, and marks a turn that folds one in', () => {
    for (const over of [
      { source: 'cron' as const },
      { source: 'hook' as const },
      { source: 'agent' as const, sender: { id: 'peer', isBot: true }, parentReport: true },
      { headless: true },
      { sender: { id: 'B_OTHER', isBot: true } }
    ]) {
      expect(turnAskers([msg(over)], 'int-slack'), JSON.stringify(over)).toEqual(NOBODY)
    }
    expect(turnAskers([], 'int-slack')).toEqual(NOBODY)
    expect(turnAskers([msg({}), msg({ source: 'cron' })], 'int-slack').nobody).toBe(true)
    expect(turnAskers([{ msg: fromP }], undefined)).toEqual(NOBODY)
  })

  it('reads a sub-session as the people whose turn opened it, and one nobody opened as nobody', () => {
    const opener = turnAskers([msg({})], 'int-slack')
    const delegation = msg({ source: 'agent', sender: { id: 'agent-a', isBot: true } })
    expect(turnAskers([delegation], 'int-slack', opener)).toEqual(opener)
    expect(turnAskers([delegation], 'int-slack', NOBODY)).toEqual(NOBODY)
  })

  it("reads a schedule's run as the console user its row records", () => {
    const run: TurnMessage = { ...msg({ source: 'cron' }), person: { kind: 'console', userId: 'user-editor' } }
    expect(turnAskers([run], 'int-slack')).toEqual({
      people: [{ kind: 'console', userId: 'user-editor' }],
      nobody: false
    })
  })
})

describe('askerOfFollower', () => {
  it("names an item's asker as a console user or a chat member on the bot the item came through", () => {
    expect(askerOfFollower('user:user-p', 'webchat', undefined)).toEqual({ kind: 'console', userId: 'user-p' })
    expect(askerOfFollower('slack:T0AAA:U_P', 'slack', 'int-slack')).toEqual({
      kind: 'member',
      platform: 'slack',
      integrationId: 'int-slack',
      userId: 'U_P'
    })
    expect(askerOfFollower('slack:T0AAA:U_P', 'slack', undefined)).toBeUndefined()
    expect(askerOfFollower('slack:T0AAA:U_P', 'feishu', 'int-feishu')).toBeUndefined()
    expect(askerOfFollower('user:', 'webchat', undefined)).toBeUndefined()
  })
})
