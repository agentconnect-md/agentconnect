import { describe, it, expect } from 'vitest'
import { normalizeTelegramMessage, telegramThread, type TelegramMessage } from '../src/telegram/normalize.js'

const ctx = { traceId: 'trace-1' }

function msg(over: Partial<TelegramMessage> = {}): TelegramMessage {
  return {
    message_id: 10,
    chat: { id: -100123, type: 'supergroup', title: 'devs' },
    from: { id: 42, is_bot: false, first_name: 'Ada', username: 'ada' },
    text: 'hello',
    ...over
  }
}

describe('normalizeTelegramMessage', () => {
  it('maps a plain group message: channel = chat id, thread undefined (channel-root), sender', () => {
    const n = normalizeTelegramMessage(msg(), ctx)
    expect(n).toMatchObject({
      msgId: 'telegram:-100123:10',
      traceId: 'trace-1',
      source: 'user',
      platform: 'telegram',
      channel: '-100123',
      sender: { id: '42', isBot: false },
      text: 'hello',
      mentionedBots: [],
      isDm: false
    })
    expect(n.thread).toBeUndefined()
    expect(n.attachments).toBeUndefined()
  })

  it('flags a private chat as a DM', () => {
    const n = normalizeTelegramMessage(msg({ chat: { id: 42, type: 'private' } }), ctx)
    expect(n.isDm).toBe(true)
    expect(n.channel).toBe('42')
  })

  it('marks a bot sender as isBot', () => {
    const n = normalizeTelegramMessage(msg({ from: { id: 7, is_bot: true, username: 'somebot' } }), ctx)
    expect(n.sender).toEqual({ id: '7', isBot: true })
  })

  it('carries a forum-topic message_thread_id in telegramTopicId (thread left to the daemon)', () => {
    const n = normalizeTelegramMessage(
      msg({ message_thread_id: 555, is_topic_message: true, reply_to_message: { message_id: 999 } }),
      ctx
    )
    // normalize no longer owns Telegram threading — it surfaces the topic id + reply
    // target and leaves `thread` for the daemon's canonicalizeTelegramThread.
    expect(n.thread).toBeUndefined()
    expect(n.telegramTopicId).toBe('555')
    expect(n.telegramThreadRoot).toBeUndefined()
    expect(n.replyTo).toBe('999')
  })

  it('carries a plain-supergroup message_thread_id as telegramThreadRoot (NOT a topic)', () => {
    // A reply in a non-forum supergroup: message_thread_id is the reply-thread ROOT, not
    // a forum topic — so it must not post back as message_thread_id.
    const n = normalizeTelegramMessage(msg({ message_thread_id: 6, reply_to_message: { message_id: 7 } }), ctx)
    expect(n.thread).toBeUndefined()
    expect(n.telegramTopicId).toBeUndefined()
    expect(n.telegramThreadRoot).toBe('6')
    expect(n.replyTo).toBe('7')
  })

  it('carries reply_to_message id in replyTo (no thread root) for a basic-group reply', () => {
    const n = normalizeTelegramMessage(msg({ reply_to_message: { message_id: 999 } }), ctx)
    expect(n.thread).toBeUndefined()
    expect(n.telegramTopicId).toBeUndefined()
    expect(n.telegramThreadRoot).toBeUndefined()
    expect(n.replyTo).toBe('999')
  })

  it('extracts @username mentions (without @) and text_mention numeric ids', () => {
    const text = 'ping @mybot and @ghost here'
    const n = normalizeTelegramMessage(
      msg({
        text,
        entities: [
          { type: 'mention', offset: text.indexOf('@mybot'), length: '@mybot'.length },
          { type: 'mention', offset: text.indexOf('@ghost'), length: '@ghost'.length },
          { type: 'text_mention', offset: 0, length: 4, user: { id: 314 } }
        ]
      }),
      ctx
    )
    expect(n.mentionedBots).toEqual(['mybot', 'ghost', '314'])
  })

  it('reads text + entities from caption/caption_entities when there is no text', () => {
    const caption = 'see @mybot'
    const n = normalizeTelegramMessage(
      msg({
        text: undefined,
        caption,
        caption_entities: [{ type: 'mention', offset: caption.indexOf('@mybot'), length: '@mybot'.length }],
        photo: [{ file_id: 'small' }, { file_id: 'big', file_size: 2048, file_unique_id: 'uq' }]
      }),
      ctx
    )
    expect(n.text).toBe('see @mybot')
    expect(n.mentionedBots).toEqual(['mybot'])
  })

  it('picks the largest photo rendition as an image attachment', () => {
    const n = normalizeTelegramMessage(
      msg({
        photo: [
          { file_id: 'sm', file_size: 100 },
          { file_id: 'lg', file_size: 9000, file_unique_id: 'uq9' }
        ]
      }),
      ctx
    )
    expect(n.attachments).toEqual([{ id: 'lg', name: 'uq9.jpg', mimeType: 'image/jpeg', size: 9000, sourceUrl: 'lg' }])
  })

  it('maps a document attachment, carrying file_id in sourceUrl', () => {
    const n = normalizeTelegramMessage(
      msg({ document: { file_id: 'DOC1', file_name: 'report.pdf', mime_type: 'application/pdf', file_size: 512 } }),
      ctx
    )
    expect(n.attachments).toEqual([
      { id: 'DOC1', name: 'report.pdf', mimeType: 'application/pdf', size: 512, sourceUrl: 'DOC1' }
    ])
  })

  it('handles a missing sender (e.g. channel post) as unknown/non-bot', () => {
    const n = normalizeTelegramMessage(msg({ from: undefined }), ctx)
    expect(n.sender).toEqual({ id: 'unknown', isBot: false })
  })
})

describe('quoted (reply_to_message content)', () => {
  it('carries the replied-to message text and author label alongside replyTo', () => {
    const n = normalizeTelegramMessage(
      msg({
        text: '@mybot what do you make of this?',
        reply_to_message: {
          message_id: 999,
          from: { id: 7, is_bot: false, first_name: 'Bob', username: 'bob' },
          text: 'the deploy failed with ECONNRESET'
        }
      }),
      ctx
    )
    expect(n.replyTo).toBe('999')
    expect(n.quoted).toEqual({
      messageId: '999',
      sender: '@bob',
      text: 'the deploy failed with ECONNRESET'
    })
  })

  it('prefers the user-selected `quote` over the full source and marks it an excerpt', () => {
    const n = normalizeTelegramMessage(
      msg({
        quote: { text: 'ECONNRESET', is_manual: true },
        reply_to_message: { message_id: 999, from: { id: 7 }, text: 'the deploy failed with ECONNRESET' }
      }),
      ctx
    )
    expect(n.quoted).toEqual({ messageId: '999', sender: '7', text: 'ECONNRESET', selection: true, excerpt: true })
  })

  it('marks a truncated full source partial but NOT a selection (nothing was chosen by hand)', () => {
    // `selection` gates suppression downstream, so mere partialness must never set it.
    const n = normalizeTelegramMessage(msg({ reply_to_message: { message_id: 5, text: 'y'.repeat(1200) } }), ctx)
    expect(n.quoted?.excerpt).toBe(true)
    expect(n.quoted?.selection).toBeUndefined()
  })

  it('falls back to the numeric id when the quoted author has no username', () => {
    const n = normalizeTelegramMessage(msg({ reply_to_message: { message_id: 1, from: { id: 7 }, text: 'hi' } }), ctx)
    expect(n.quoted?.sender).toBe('7')
  })

  it('omits sender when the quoted message has no author (channel post / hidden)', () => {
    const n = normalizeTelegramMessage(msg({ reply_to_message: { message_id: 1, text: 'hi' } }), ctx)
    expect(n.quoted).toEqual({ messageId: '1', text: 'hi' })
  })

  it('uses the quoted caption and folds in an attachment mention for a media source', () => {
    const n = normalizeTelegramMessage(
      msg({
        reply_to_message: {
          message_id: 5,
          from: { id: 7, username: 'bob' },
          caption: 'see the trace',
          document: { file_id: 'f1', file_name: 'trace.log', mime_type: 'text/plain' }
        }
      }),
      ctx
    )
    expect(n.quoted?.text).toBe('see the trace [attached: trace.log (text/plain)]')
  })

  it('still describes a media-only quoted message', () => {
    const n = normalizeTelegramMessage(
      msg({
        reply_to_message: {
          message_id: 5,
          from: { id: 7, username: 'bob' },
          photo: [{ file_id: 'p1', file_unique_id: 'u1' }]
        }
      }),
      ctx
    )
    expect(n.quoted?.text).toBe('[attached: u1.jpg (image/jpeg)]')
  })

  it('truncates a long quoted message and marks it an excerpt', () => {
    const long = 'x'.repeat(1500)
    const n = normalizeTelegramMessage(msg({ reply_to_message: { message_id: 5, text: long } }), ctx)
    expect(n.quoted?.text).toBe(`${'x'.repeat(1000)}…`)
    expect(n.quoted?.excerpt).toBe(true)
  })

  it('is absent for a non-reply, and for a reply whose source carries nothing usable', () => {
    expect(normalizeTelegramMessage(msg(), ctx).quoted).toBeUndefined()
    // A service-record source (e.g. a pinned/forward stub) has no text, caption or media.
    expect(normalizeTelegramMessage(msg({ reply_to_message: { message_id: 5 } }), ctx).quoted).toBeUndefined()
  })
})

describe('telegramThread (forum topic only)', () => {
  it('returns the forum-topic id, ignoring any reply', () => {
    expect(telegramThread(msg({ message_thread_id: 1, reply_to_message: { message_id: 2 } }))).toBe('1')
    // A reply outside a topic is no longer a thread — the daemon resolves it.
    expect(telegramThread(msg({ reply_to_message: { message_id: 2 } }))).toBeUndefined()
    expect(telegramThread(msg())).toBeUndefined()
  })
})
