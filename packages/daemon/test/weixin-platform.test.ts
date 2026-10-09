import { describe, it, expect } from 'vitest'
import { consolidateWeixin, WeixinConnKey } from '../src/platforms/weixin/connection.js'
import { normalizeWeixinEvent, parseWeixinUserId, WeixinUserId } from '../src/platforms/weixin/message.js'
import type { NormalizedChatEvent } from '../src/platforms/weixin/vendor/sdk/protocol/chat-event.js'
import type { LoadedAgent } from '../src/agents/load-agents.js'

function event(overrides: Partial<NormalizedChatEvent> = {}): NormalizedChatEvent {
  return {
    id: 'm1',
    seq: 1,
    type: 'text',
    chat: { id: 'peer1', type: 'private' },
    from: { id: 'peer1' },
    date: 1_700_000_000,
    text: '你好',
    raw: {},
    ...overrides
  }
}

describe('normalizeWeixinEvent', () => {
  it('maps a text DM to a weixin normalized message', () => {
    const msg = normalizeWeixinEvent('bot-1', event())
    expect(msg?.platform).toBe('weixin')
    expect(msg?.channel).toBe('dm:peer1')
    expect(msg?.isDm).toBe(true)
    expect(msg?.sender.id).toBe('weixin:user:bot-1:peer1')
    expect(msg?.text).toBe('你好')
    expect(msg?.mentionedBots).toEqual([])
  })

  it('drops an event with no peer id', () => {
    expect(normalizeWeixinEvent('bot-1', event({ from: { id: '' } }))).toBeNull()
  })

  it('drops an empty event', () => {
    expect(normalizeWeixinEvent('bot-1', event({ text: '', media: undefined }))).toBeNull()
  })

  it('projects media to an ilink-media ref attachment', () => {
    const msg = normalizeWeixinEvent('bot-1', event({ text: '', media: { kind: 'photo', item: {} } as never }))
    expect(msg?.attachments?.[0]?.sourceUrl).toBe('ilink-media:m1:0')
    expect(msg?.attachments?.[0]?.mimeType).toBe('image/jpeg')
  })
})

describe('weixin user id round-trip', () => {
  it('parses back what it writes', () => {
    const id = WeixinUserId('acct', 'peer')
    expect(parseWeixinUserId(id)).toEqual({ accountId: 'acct', peerId: 'peer' })
    expect(parseWeixinUserId('not-weixin')).toBeUndefined()
  })
})

describe('consolidateWeixin', () => {
  const agent = (integrations: object[]): LoadedAgent => ({ id: 'agent-1', integrations }) as unknown as LoadedAgent

  it('groups integrations by bot identity and keeps integration ids for binding', () => {
    const groups = consolidateWeixin([
      agent([
        { id: 'i1', platform: 'weixin', config: { accountId: 'a', botToken: 't1' } },
        { id: 'i2', platform: 'weixin', config: { accountId: 'a', botToken: 't1' } },
        { id: 'i3', platform: 'qq', config: { appId: 'x', appSecret: 'y' } }
      ])
    ])
    expect(groups.size).toBe(1)
    const group = groups.values().next().value!
    expect(group.accountId).toBe('a')
    expect(group.integrations).toEqual([
      { agentId: 'agent-1', integrationId: 'i1' },
      { agentId: 'agent-1', integrationId: 'i2' }
    ])
  })

  it('does not reuse a connection key across token rotations', () => {
    expect(WeixinConnKey({ accountId: 'a', botToken: 'old' })).not.toBe(
      WeixinConnKey({ accountId: 'a', botToken: 'new' })
    )
  })
})
