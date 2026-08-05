import { describe, it, expect } from 'vitest'
import {
  normalizeFeishuMessage,
  toAttachment,
  humanizeFeishuText,
  type FeishuMessageLike
} from '../src/feishu/normalize.js'

const base: FeishuMessageLike = {
  messageId: 'om_111',
  chatId: 'oc_777',
  chatType: 'group',
  messageType: 'text',
  content: JSON.stringify({ text: 'hello @_user_1' }),
  senderOpenId: 'ou_123',
  senderUnionId: 'on_123',
  senderIsBot: false,
  mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'AgentBot' }]
}

describe('normalizeFeishuMessage', () => {
  it('maps a group text message, mention humanized + open_id routed', () => {
    const m = normalizeFeishuMessage(base, { traceId: 't1' })
    expect(m).toMatchObject({
      msgId: 'feishu:oc_777:om_111',
      platform: 'feishu',
      source: 'user',
      channel: 'oc_777',
      text: 'hello @AgentBot', // @_user_1 placeholder humanized to the mention name
      mentionedBots: ['ou_bot'], // routed on the mentioned party's open_id
      sender: { id: 'on_123', isBot: false },
      isDm: false
    })
    // A top-level group @mention opens a topic thread → keyed on its own message id
    // (which the connection replies into as the thread root).
    expect(m.thread).toBe('om_111')
    expect(m.attachments).toBeUndefined()
  })

  it('falls back to open_id for rolling compatibility when union_id is absent', () => {
    const { senderUnionId: _omit, ...legacy } = base
    expect(normalizeFeishuMessage(legacy, { traceId: 't' }).sender.id).toBe('ou_123')
  })

  it('keys a group thread reply on root_id, so the whole topic thread is one session', () => {
    // Turn 1 (top-level) keyed on om_111; a reply inside its thread carries root_id=om_111
    // and a distinct message_id → same thread key, so it continues the same session.
    const reply = normalizeFeishuMessage(
      { ...base, messageId: 'om_222', rootId: 'om_111', content: JSON.stringify({ text: 'follow up' }), mentions: [] },
      { traceId: 't' }
    )
    expect(reply.thread).toBe('om_111')
    expect(reply.channel).toBe('oc_777')
  })

  it('flags a p2p chat as a DM and keys the whole DM (chat id) as one session', () => {
    const m = normalizeFeishuMessage({ ...base, chatType: 'p2p' }, { traceId: 't' })
    expect(m.isDm).toBe(true)
    expect(m.thread).toBe('oc_777') // no threads in a DM → chat-scoped session
  })

  it('parses the text-message content JSON into .text', () => {
    const m = normalizeFeishuMessage(
      { ...base, content: JSON.stringify({ text: 'plain body' }), mentions: [] },
      { traceId: 't' }
    )
    expect(m.text).toBe('plain body')
  })

  it('flattens a post rich-text body to plain text', () => {
    const post = JSON.stringify({
      title: 'Heads up',
      content: [
        [
          { tag: 'text', text: 'see ' },
          { tag: 'a', href: 'https://x', text: 'this link' }
        ],
        [{ tag: 'at', user_id: 'ou_9', user_name: 'Bob' }]
      ]
    })
    const m = normalizeFeishuMessage({ ...base, messageType: 'post', content: post, mentions: [] }, { traceId: 't' })
    expect(m.text).toBe('Heads up\nsee this link\n@Bob')
  })

  it('yields empty text (never throws) for a non-text/post type or malformed JSON', () => {
    expect(
      normalizeFeishuMessage({ ...base, messageType: 'image', content: '{}', mentions: [] }, { traceId: 't' }).text
    ).toBe('')
    expect(normalizeFeishuMessage({ ...base, content: 'not json', mentions: [] }, { traceId: 't' }).text).toBe('')
  })

  it('marks a bot sender and defaults senderIsBot to false when absent', () => {
    expect(normalizeFeishuMessage({ ...base, senderIsBot: true }, { traceId: 't' }).sender.isBot).toBe(true)
    const { senderIsBot: _omit, ...noBot } = base
    expect(normalizeFeishuMessage(noBot, { traceId: 't' }).sender.isBot).toBe(false)
  })

  it('maps image/file attachments, encoding <messageId>:<type>:<fileKey> into sourceUrl', () => {
    const m = normalizeFeishuMessage(
      {
        ...base,
        messageType: 'image',
        content: '{}',
        mentions: [],
        attachments: [
          { fileKey: 'img_v2_abc', type: 'image', name: 'pic.png', mimeType: 'image/png', size: 42 },
          { fileKey: 'file_v2_def', type: 'file', name: 'doc.pdf' }
        ]
      },
      { traceId: 't' }
    )
    expect(m.attachments).toEqual([
      { id: 'img_v2_abc', name: 'pic.png', mimeType: 'image/png', size: 42, sourceUrl: 'om_111:image:img_v2_abc' },
      { id: 'file_v2_def', name: 'doc.pdf', mimeType: 'application/octet-stream', sourceUrl: 'om_111:file:file_v2_def' }
    ])
  })
})

describe('humanizeFeishuText', () => {
  it('replaces every @_user_N placeholder with @name from the mentions map', () => {
    const text = humanizeFeishuText('hi @_user_1 and @_user_2', [
      { key: '@_user_1', id: { open_id: 'ou_a' }, name: 'Alice' },
      { key: '@_user_2', id: { open_id: 'ou_b' }, name: 'Bob' }
    ])
    expect(text).toBe('hi @Alice and @Bob')
  })

  it('falls back to @open_id when the display name is missing, and leaves unknown placeholders', () => {
    expect(humanizeFeishuText('hey @_user_1', [{ key: '@_user_1', id: { open_id: 'ou_x' } }])).toBe('hey @ou_x')
    expect(humanizeFeishuText('hey @_user_1', [{ key: '@_user_1' }])).toBe('hey @_user_1')
  })

  it('is a no-op with no mentions', () => {
    expect(humanizeFeishuText('plain text', [])).toBe('plain text')
    expect(humanizeFeishuText('plain text', undefined)).toBe('plain text')
  })
})

describe('toAttachment', () => {
  it('drops a malformed / keyless / unknown-type element', () => {
    expect(toAttachment(null, 'om_1')).toBeNull()
    expect(toAttachment({ fileKey: '', type: 'image' } as never, 'om_1')).toBeNull()
    expect(toAttachment({ fileKey: 'k', type: 'image' }, '')).toBeNull()
    expect(toAttachment({ fileKey: 'k', type: 'audio' } as never, 'om_1')).toBeNull()
  })

  it('defaults name + mimeType and encodes the compound download key', () => {
    expect(toAttachment({ fileKey: 'img_1', type: 'image' }, 'om_9')).toEqual({
      id: 'img_1',
      name: 'img_1',
      mimeType: 'application/octet-stream',
      sourceUrl: 'om_9:image:img_1'
    })
  })
})
