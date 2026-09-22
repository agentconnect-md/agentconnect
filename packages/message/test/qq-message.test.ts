import { describe, expect, it } from 'vitest'
import { normalizeQQMessage, parseQQUserId, QQAttachmentUrl, QQAvatarUrl, QQUserId } from '../src/qq-message.js'

const event = { kind: 'c2c', rawEventType: 'C2C_MESSAGE_CREATE', senderId: 'user', messageId: 'm1', content: 'hello' }
describe('QQ normalization', () => {
  it('keeps quoted source separate from the new text and passive reply anchor', () => {
    const msg = normalizeQQMessage(
      '100',
      {
        ...event,
        refMsgIdx: 'quote-index',
        msgIdx: 'own-index',
        msgElements: [{ msg_idx: 'quote-index', content: 'Original message' }]
      },
      'trace'
    )!
    expect(msg).toMatchObject({
      text: 'hello',
      replyTo: 'ref:quote-index',
      quoted: { text: 'Original message', messageId: 'ref:quote-index' },
      adapterExt: { qq: { replyId: 'm1' } }
    })
    expect(msg.quoted?.sender).toBeUndefined()
  })
  it('uses native quoted text over the cache and accepts quoted images through the usual image checks', () => {
    const msg = normalizeQQMessage(
      '100',
      {
        ...event,
        refMsgIdx: 'idx',
        msgElements: [
          {
            msg_idx: 'idx',
            content: 'x'.repeat(1200),
            attachments: [
              { content_type: 'image/png', url: 'https://gchat.qpic.cn/image', filename: 'quoted.png' },
              { content_type: 'image/png', url: 'http://127.0.0.1/private' }
            ]
          }
        ]
      },
      'trace',
      { messageId: 'original', sender: 'Alice', content: 'cache' }
    )!
    expect(msg.quoted).toMatchObject({ messageId: 'original', sender: 'Alice', text: 'x'.repeat(1000), excerpt: true })
    expect(msg.attachments).toEqual([expect.objectContaining({ id: 'idx:quote:0', name: 'quoted.png' })])
    expect(msg.text).toContain('attachment unavailable')
  })
  it('keeps user conversations stable and app-scoped message identities distinct', () => {
    const first = normalizeQQMessage('100', event, 'trace')!
    const next = normalizeQQMessage('100', { ...event, messageId: 'm2' }, 'trace')!
    expect(first.channel).toBe(next.channel)
    expect(first.thread).toBe('dm')
    expect(first.sender).toEqual({
      id: 'qq:user:100:user',
      isBot: false,
      avatarUrl: 'https://q.qlogo.cn/qqapp/100/user/640'
    })
    expect(first.msgId).not.toBe(normalizeQQMessage('200', event, 'trace')!.msgId)
    expect(first.sender.id).not.toBe(normalizeQQMessage('200', event, 'trace')!.sender.id)
    expect(first.channel).not.toBe(normalizeQQMessage('100', { ...event, senderId: 'other' }, 'trace')!.channel)
    expect(first.adapterExt).toEqual({ qq: { replyId: 'm1' } })
  })
  it('rejects mismatched event kinds, guild DM, empty and bot messages', () => {
    for (const overrides of [
      { kind: 'group' },
      { rawEventType: 'DIRECT_MESSAGE_CREATE' },
      { content: ' ' },
      { senderIsBot: true }
    ]) {
      expect(normalizeQQMessage('100', { ...event, ...overrides }, 'trace')).toBeNull()
    }
  })
  it('shares a group conversation across members while preserving authors and the passive reply id', () => {
    const group = {
      ...event,
      kind: 'group',
      rawEventType: 'GROUP_AT_MESSAGE_CREATE',
      groupOpenid: 'g1',
      senderName: 'Alice',
      content: '<@!100> hello <@200>'
    }
    const first = normalizeQQMessage('100', group, 'trace')!
    const next = normalizeQQMessage('100', { ...group, senderId: 'other', messageId: 'm2' }, 'trace')!
    expect(first).toMatchObject({
      channel: 'group:g1',
      thread: 'group',
      sender: {
        id: 'qq:user:100:user',
        name: 'Alice',
        avatarUrl: 'https://q.qlogo.cn/qqapp/100/user/640'
      },
      mentionedBots: ['100'],
      isDm: false,
      text: 'hello <@200>',
      adapterExt: { qq: { replyId: 'm1' } }
    })
    expect(next.channel).toBe(first.channel)
    expect(next.thread).toBe(first.thread)
    expect(next.sender.id).toBe('qq:user:100:other')
    expect(next.msgId).not.toBe(first.msgId)
    expect(normalizeQQMessage('100', { ...group, groupOpenid: 'g2' }, 'trace')!.channel).not.toBe(first.channel)
    expect(normalizeQQMessage('100', { ...event, senderId: 'g1' }, 'trace')!.channel).not.toBe(first.channel)
    expect(normalizeQQMessage('200', group, 'trace')!.msgId).not.toBe(first.msgId)
  })
  it('uses one app-scoped identity for the same sender in groups and C2C', () => {
    const dm = normalizeQQMessage('100', event, 'trace')!
    const group = normalizeQQMessage(
      '100',
      {
        ...event,
        kind: 'group',
        rawEventType: 'GROUP_AT_MESSAGE_CREATE',
        groupOpenid: 'group',
        content: '<@100> hello'
      },
      'trace'
    )!
    expect(group.sender.id).toBe(dm.sender.id)
  })
  it('round-trips QQ user identities and avatar coordinates without assuming an OpenID alphabet', () => {
    const id = QQUserId('100', 'opaque:value/with+symbols')
    expect(parseQQUserId(id)).toEqual({ appId: '100', openId: 'opaque:value/with+symbols' })
    expect(parseQQUserId('user')).toBeUndefined()
    expect(QQAvatarUrl('100', 'opaque/value')).toBe('https://q.qlogo.cn/qqapp/100/opaque%2Fvalue/640')
  })
  it('ignores ambient group text and commands even when their text contains a bot mention', () => {
    for (const content of ['hello', '!cancel', '<@!100> run this']) {
      expect(
        normalizeQQMessage(
          '100',
          { ...event, kind: 'group', rawEventType: 'GROUP_MESSAGE_CREATE', groupOpenid: 'g', content },
          'trace'
        )
      ).toBeNull()
    }
    const group = { ...event, kind: 'group', rawEventType: 'GROUP_AT_MESSAGE_CREATE', groupOpenid: 'g' }
    for (const overrides of [{ groupOpenid: '' }, { senderIsBot: true }, { content: '<@!100> ' }])
      expect(normalizeQQMessage('100', { ...group, ...overrides }, 'trace')).toBeNull()
    expect(normalizeQQMessage('100', { ...group, content: '<@100> !status' }, 'trace')!.text).toBe('!status')
    expect(
      normalizeQQMessage(
        '100',
        {
          ...group,
          content: '<@!100>',
          attachments: [{ content_type: 'image/png', url: 'https://gchat.qpic.cn/image' }]
        },
        'trace'
      )
    ).toMatchObject({ text: '', attachments: [{ mimeType: 'image/png' }] })
  })
  it('admits image-only messages and preserves image metadata beside text', () => {
    const attachments = [
      { content_type: 'image/jpeg', url: 'http://gchat.qpic.cn/picture', filename: '../photo.jpg', size: 123 }
    ]
    const image = normalizeQQMessage('100', { ...event, content: '', attachments }, 'trace')!
    expect(image.text).toBe('')
    expect(image.attachments).toEqual([
      {
        id: 'm1:0',
        name: '.._photo.jpg',
        mimeType: 'image/jpeg',
        sourceUrl: 'https://gchat.qpic.cn/picture',
        size: 123
      }
    ])
    expect(normalizeQQMessage('100', { ...event, attachments }, 'trace')?.text).toBe('hello')
  })
  it('preserves ordinary files while refusing arbitrary download destinations', () => {
    const msg = normalizeQQMessage(
      '100',
      {
        ...event,
        content: '',
        attachments: [
          { content_type: 'file', filename: 'invoice.pdf', url: 'https://gchat.qpic.cn/file' },
          {
            content_type: 'voice',
            filename: 'voice.silk',
            url: 'https://gchat.qpic.cn/voice',
            voice_wav_url: 'https://multimedia.nt.qq.com.cn/voice.wav'
          },
          { content_type: 'image/png', url: 'http://127.0.0.1/private' }
        ]
      },
      'trace'
    )!
    expect(msg.attachments).toEqual([
      expect.objectContaining({
        id: 'm1:0',
        name: 'invoice.pdf',
        mimeType: 'application/pdf',
        sourceUrl: 'https://gchat.qpic.cn/file'
      }),
      expect.objectContaining({
        id: 'm1:1',
        name: 'voice.silk',
        mimeType: 'audio/wav',
        sourceUrl: 'https://multimedia.nt.qq.com.cn/voice.wav'
      })
    ])
    expect(msg.text).toContain('attachment unavailable')
    for (const url of [
      'https://qpic.cn.attacker.test/a',
      'https://user:pass@gchat.qpic.cn/a',
      'file:///a',
      'https://gchat.qpic.cn:8443/a'
    ])
      expect(QQAttachmentUrl(url)).toBeUndefined()
    expect(QQAttachmentUrl('//multimedia.nt.qq.com.cn/a')).toBe('https://multimedia.nt.qq.com.cn/a')
  })
})
