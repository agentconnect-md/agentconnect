import { describe, expect, it, vi } from 'vitest'
import {
  checkPlaceRead,
  NOT_SHARED_HERE,
  placeReadRefusal,
  placeRefusalMessage,
  type SourcePlace
} from '../src/assistant/place-access.js'

// assistant-mode.md §5.5 (P0a): a DM, webchat or private place only from itself, every other place open.
const ownDm: SourcePlace = { platform: 'slack', channel: 'D_P', kind: 'dm' }
const otherDm: SourcePlace = { platform: 'slack', channel: 'D_Q', kind: 'dm' }
const channel: SourcePlace = { platform: 'slack', channel: 'C_INT', kind: 'channel', private: false }
const external: SourcePlace = { platform: 'slack', channel: 'C_EXT', kind: 'channel', private: false }
const privateChannel: SourcePlace = { platform: 'slack', channel: 'C_PRIV', kind: 'channel', private: true }
const groupDm: SourcePlace = { platform: 'slack', channel: 'G_MPIM', kind: 'group_dm', private: true }
const openGroup: SourcePlace = { platform: 'feishu', channel: 'oc_group', kind: 'group_dm', private: false }
const webchat: SourcePlace = { platform: 'webchat', channel: 'chat-1', kind: 'webchat' }
const otherWebchat: SourcePlace = { platform: 'webchat', channel: 'chat-2', kind: 'webchat' }
const telegramGroup: SourcePlace = { platform: 'telegram', channel: '-1001', kind: 'channel', private: false }
const telegramClosed: SourcePlace = { platform: 'telegram', channel: '-1002', kind: 'channel', private: true }

const sources = {
  ownDm,
  otherDm,
  channel,
  external,
  privateChannel,
  groupDm,
  openGroup,
  webchat,
  otherWebchat,
  telegramGroup,
  telegramClosed
}
type Row = Record<keyof typeof sources, string | undefined>

// What every place but the source's own conversation reads: the open places, nothing direct or private.
const elsewhere = (own: Partial<Row>): Row => ({
  ownDm: 'direct',
  otherDm: 'direct',
  channel: undefined,
  external: undefined,
  privateChannel: 'private',
  groupDm: 'private',
  openGroup: undefined,
  webchat: 'direct',
  otherWebchat: 'direct',
  telegramGroup: undefined,
  telegramClosed: 'private',
  ...own
})

const cases: [string, SourcePlace, Row][] = [
  ["P's DM", ownDm, elsewhere({ ownDm: undefined })],
  ['an internal channel', channel, elsewhere({})],
  // An external place reads like an internal one; only what it posts differs.
  ['an external channel', external, elsewhere({})],
  ['the private channel', privateChannel, elsewhere({ privateChannel: undefined })],
  ['the private group DM', groupDm, elsewhere({ groupDm: undefined })],
  ['an open group DM', openGroup, elsewhere({})],
  // P0: webchat recalls itself and open places; DMs wait for identity links.
  ['webchat', webchat, elsewhere({ webchat: undefined })]
]

describe('placeReadRefusal — the assistant-mode read matrix', () => {
  it.each(cases)('from %s', (_label, current, expected) => {
    const got = Object.fromEntries(Object.entries(sources).map(([name, s]) => [name, placeReadRefusal(current, s)]))
    expect(got).toEqual(expected)
  })

  it('refuses a place it could not describe, and a channel or group DM whose privacy is unknown', () => {
    expect(placeReadRefusal(channel, { platform: 'slack', channel: 'C_X' })).toBe('undetermined')
    expect(placeReadRefusal(channel, { platform: 'slack', channel: 'C_X', kind: 'channel' })).toBe('undetermined')
    expect(placeReadRefusal(channel, { platform: 'slack', channel: 'G_X', kind: 'group_dm' })).toBe('undetermined')
  })

  it('keeps the same conversation id on another platform a different place', () => {
    expect(placeReadRefusal(ownDm, { platform: 'telegram', channel: 'D_P', kind: 'dm' })).toBe('direct')
  })
})

describe('placeRefusalMessage', () => {
  it('keeps "ask me in a DM" for a DM and says nothing about where anything else is', () => {
    expect(placeRefusalMessage('direct')).toContain('Ask me in a DM.')
    for (const reason of ['private', 'undetermined'] as const) {
      expect(placeRefusalMessage(reason)).toBe(NOT_SHARED_HERE)
      expect(placeRefusalMessage(reason)).not.toMatch(/private|channel/i)
    }
    expect(NOT_SHARED_HERE).toContain("I can't share that here.")
  })
})

describe('checkPlaceRead', () => {
  it('counts a refused read by tool and reason only, and nothing for an allowed one', async () => {
    const recorder = { refused: vi.fn() }
    expect(await checkPlaceRead('recall', channel, otherDm, undefined, recorder)).toBe('direct')
    expect(await checkPlaceRead('getChannelHistory', channel, privateChannel, undefined, recorder)).toBe('private')
    expect(await checkPlaceRead('recall', ownDm, channel, undefined, recorder)).toBeUndefined()
    expect(recorder.refused.mock.calls).toEqual([
      ['recall', 'direct'],
      ['getChannelHistory', 'private']
    ])
  })

  // Per-asker scoping (§5.5) widens a private place only, so the refused-read count follows the widened verdict.
  it('asks about membership only for a private place, and counts it refused only when that fails', async () => {
    const recorder = { refused: vi.fn() }
    const member = vi.fn(async () => true)
    expect(await checkPlaceRead('recall', ownDm, privateChannel, member, recorder)).toBeUndefined()
    expect(await checkPlaceRead('recall', ownDm, groupDm, member, recorder)).toBeUndefined()
    expect(await checkPlaceRead('recall', ownDm, otherDm, member, recorder)).toBe('direct')
    expect(await checkPlaceRead('recall', ownDm, { ...privateChannel, private: undefined }, member, recorder)).toBe(
      'undetermined'
    )
    expect(member).toHaveBeenCalledTimes(2)
    const failing = vi.fn(async (): Promise<boolean> => {
      throw new Error('lookup failed')
    })
    expect(await checkPlaceRead('getReactions', ownDm, privateChannel, failing, recorder)).toBe('private')
    expect(await checkPlaceRead('listBookmarks', ownDm, privateChannel, async () => false, recorder)).toBe('private')
    expect(recorder.refused.mock.calls).toEqual([
      ['recall', 'direct'],
      ['recall', 'undetermined'],
      ['getReactions', 'private'],
      ['listBookmarks', 'private']
    ])
  })
})
