import { describe, expect, it, vi } from 'vitest'
import { dispatchEvent } from '@tencent-connect/qqbot-nodejs/protocol'
import { QQConnection } from '../src/platforms/qq/connection.js'
import { QQReferences } from '../src/platforms/qq/references.js'
import type { Logger } from '../src/log.js'

function connection() {
  return new QQConnection(
    { appId: '100', appSecret: 'secret', integrations: [] },
    {
      api: { request: async <T>() => ({ id: 'sent-message', ext_info: { ref_idx: 'native-index' } }) as T },
      token: async () => 'token',
      onMessage: vi.fn(),
      log: { info: vi.fn(), warn: vi.fn() } as unknown as Logger
    }
  )
}

const event = {
  rawEventType: 'GROUP_AT_MESSAGE_CREATE',
  kind: 'group',
  groupOpenid: 'g1',
  senderId: 'Alice',
  messageId: 'inbound',
  content: '<@!100> source',
  msgIdx: 'native-index'
}

describe('QQ native quote association', () => {
  it('resolves known human messages without sharing quote indices across conversations or bots', () => {
    const conn = connection()
    conn.normalizeMessage(event)
    const quoted = conn.normalizeMessage({
      ...event,
      senderId: 'Bob',
      messageId: 'answer',
      content: '<@!100> this one',
      msgIdx: 'second-index',
      refMsgIdx: 'native-index'
    })!
    expect(quoted).toMatchObject({
      channel: 'group:g1',
      thread: 'group',
      replyTo: 'inbound',
      quoted: { messageId: 'inbound', sender: 'Alice', text: 'source' },
      adapterExt: { qq: { replyId: 'answer' } }
    })
    expect(conn.normalizeMessage({ ...event, groupOpenid: 'g2', refMsgIdx: 'native-index' })!.quoted).toBeUndefined()
    expect(connection().normalizeMessage({ ...event, refMsgIdx: 'native-index' })!.quoted).toBeUndefined()
  })
  it('associates an outgoing message with the actual SDK-parsed native reply', async () => {
    const conn = connection()
    await conn.sendText('group:g1', 'trigger', 'An earlier reply')
    const dispatched = dispatchEvent(
      'GROUP_AT_MESSAGE_CREATE',
      {
        id: 'reply-from-Bob',
        content: '<@!100> explain this',
        author: { member_openid: 'Bob' },
        group_openid: 'g1',
        message_type: 103,
        message_scene: { ext: ['msg_idx=own-index'] },
        msg_elements: [{ msg_idx: 'native-index', content: 'An earlier reply' }]
      },
      '100'
    )
    expect(dispatched.action).toBe('message')
    if (dispatched.action !== 'message') throw new Error('expected message')
    expect(conn.normalizeMessage(dispatched.msg)).toMatchObject({
      sender: { id: 'qq:user:100:Bob' },
      text: 'explain this',
      replyTo: 'sent-message',
      quoted: { messageId: 'sent-message', sender: 'QQ bot', text: 'An earlier reply' }
    })
  })
  it('uses the pushed source on cache misses and keeps ambient messages out of the cache', () => {
    const conn = connection()
    expect(conn.normalizeMessage({ ...event, rawEventType: 'GROUP_MESSAGE_CREATE' })).toBeNull()
    const quoted = conn.normalizeMessage({
      ...event,
      messageId: 'reply',
      msgIdx: undefined,
      refMsgIdx: 'native-index',
      msgElements: [{ msg_idx: 'native-index', content: 'pushed source' }]
    })!
    expect(quoted.quoted).toMatchObject({ text: 'pushed source' })
    expect(quoted.quoted?.sender).toBeUndefined()
  })
  it('bounds both cached text and the reference index', () => {
    const cache = new QQReferences()
    cache.remember('group:g', ['first'], { content: 'x'.repeat(5000) })
    expect(cache.get('group:g', 'first')).toMatchObject({ content: 'x'.repeat(1000), excerpt: true })
    for (let i = 0; i < 2001; i++) cache.remember('group:g', [String(i)], { content: 'text' })
    expect(cache.get('group:g', 'first')).toBeUndefined()
  })
})
