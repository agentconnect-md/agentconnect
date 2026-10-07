import { describe, expect, it, vi } from 'vitest'
import {
  checkPlaceRead,
  placeReadRefusal,
  placeRefusalMessage,
  type SourcePlace
} from '../src/assistant/place-access.js'

// assistant-mode.md §5.5 (P0a): a DM, webchat or private channel only from itself, everything else open.
const ownDm: SourcePlace = { platform: 'slack', channel: 'D_P', kind: 'dm' }
const otherDm: SourcePlace = { platform: 'slack', channel: 'D_Q', kind: 'dm' }
const channel: SourcePlace = { platform: 'slack', channel: 'C_INT', kind: 'channel', private: false }
const external: SourcePlace = { platform: 'slack', channel: 'C_EXT', kind: 'channel', private: false }
const privateChannel: SourcePlace = { platform: 'slack', channel: 'C_PRIV', kind: 'channel', private: true }
const groupDm: SourcePlace = { platform: 'slack', channel: 'G_MPIM', kind: 'group_dm' }
const webchat: SourcePlace = { platform: 'webchat', channel: 'chat-1', kind: 'webchat' }
const otherWebchat: SourcePlace = { platform: 'webchat', channel: 'chat-2', kind: 'webchat' }
const telegramGroup: SourcePlace = { platform: 'telegram', channel: '-1001', kind: 'channel', private: false }

const sources = { ownDm, otherDm, channel, external, privateChannel, groupDm, webchat, otherWebchat, telegramGroup }

const expected: Record<string, Record<keyof typeof sources, string | undefined>> = {
  "P's DM": {
    ownDm: undefined,
    otherDm: 'direct',
    channel: undefined,
    external: undefined,
    privateChannel: 'private_channel',
    groupDm: undefined,
    webchat: 'direct',
    otherWebchat: 'direct',
    telegramGroup: undefined
  },
  'an internal channel': {
    ownDm: 'direct',
    otherDm: 'direct',
    channel: undefined,
    external: undefined,
    privateChannel: 'private_channel',
    groupDm: undefined,
    webchat: 'direct',
    otherWebchat: 'direct',
    telegramGroup: undefined
  },
  // An external place reads like an internal one; only what it posts differs.
  'an external channel': {
    ownDm: 'direct',
    otherDm: 'direct',
    channel: undefined,
    external: undefined,
    privateChannel: 'private_channel',
    groupDm: undefined,
    webchat: 'direct',
    otherWebchat: 'direct',
    telegramGroup: undefined
  },
  'the private channel': {
    ownDm: 'direct',
    otherDm: 'direct',
    channel: undefined,
    external: undefined,
    privateChannel: undefined,
    groupDm: undefined,
    webchat: 'direct',
    otherWebchat: 'direct',
    telegramGroup: undefined
  },
  'a group DM': {
    ownDm: 'direct',
    otherDm: 'direct',
    channel: undefined,
    external: undefined,
    privateChannel: 'private_channel',
    groupDm: undefined,
    webchat: 'direct',
    otherWebchat: 'direct',
    telegramGroup: undefined
  },
  // P0: webchat recalls itself and channels; DMs wait for identity links.
  webchat: {
    ownDm: 'direct',
    otherDm: 'direct',
    channel: undefined,
    external: undefined,
    privateChannel: 'private_channel',
    groupDm: undefined,
    webchat: undefined,
    otherWebchat: 'direct',
    telegramGroup: undefined
  }
}

const currents = {
  "P's DM": ownDm,
  'an internal channel': channel,
  'an external channel': external,
  'the private channel': privateChannel,
  'a group DM': groupDm,
  webchat
}

describe('placeReadRefusal — the assistant-mode read matrix', () => {
  for (const [label, current] of Object.entries(currents)) {
    it(`from ${label}`, () => {
      const got = Object.fromEntries(
        Object.entries(sources).map(([name, source]) => [name, placeReadRefusal(current, source)])
      )
      expect(got).toEqual(expected[label])
    })
  }

  it('refuses a place it could not describe, and a channel whose privacy is unknown', () => {
    expect(placeReadRefusal(channel, { platform: 'slack', channel: 'C_X' })).toBe('undetermined')
    expect(placeReadRefusal(channel, { platform: 'slack', channel: 'C_X', kind: 'channel' })).toBe('undetermined')
  })

  it('keeps the same conversation id on another platform a different place', () => {
    expect(placeReadRefusal(ownDm, { platform: 'telegram', channel: 'D_P', kind: 'dm' })).toBe('direct')
  })
})

describe('placeRefusalMessage', () => {
  it('tells the model what to answer instead of the content', () => {
    expect(placeRefusalMessage('direct')).toContain('Ask me in a DM.')
    expect(placeRefusalMessage('private_channel')).toContain('private channel and can be asked there')
    expect(placeRefusalMessage('undetermined')).toContain('could not be determined')
  })
})

describe('checkPlaceRead', () => {
  it('counts a refused read by tool and reason only, and nothing for an allowed one', () => {
    const recorder = { refused: vi.fn() }
    expect(checkPlaceRead('recall', channel, otherDm, recorder)).toBe('direct')
    expect(checkPlaceRead('getChannelHistory', channel, privateChannel, recorder)).toBe('private_channel')
    expect(checkPlaceRead('recall', ownDm, channel, recorder)).toBeUndefined()
    expect(recorder.refused.mock.calls).toEqual([
      ['recall', 'direct'],
      ['getChannelHistory', 'private_channel']
    ])
  })
})
