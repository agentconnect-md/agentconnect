import { describe, expect, it } from 'vitest'
import { NormalizedPlatformMessageSchema, manifestFor, type NormalizedPlatformMessage } from '@agentconnect.md/protocol'
import { commandText } from '../src/command-text.js'
import {
  normalizeWeComMessage,
  type WeComInboundMessage,
  type WeComNormalizeContext,
  type WeComNormalized
} from '../src/wecom-message.js'
import {
  BOT,
  BOT_NAME,
  FILE,
  GROUP,
  IMAGE,
  MIXED_IMAGE,
  QUOTED_IMAGE,
  RESPONSE_URL,
  USER,
  VIDEO,
  assistantInvocation,
  dmFile,
  dmImage,
  dmQuoteOfImage,
  dmText,
  dmVideo,
  dmVoice,
  groupMention,
  groupMixed,
  groupQuoteOfText,
  streamRefresh
} from './fixtures/wecom-messages.js'

const normalize = (payload: WeComInboundMessage, context: Partial<WeComNormalizeContext> = {}) =>
  normalizeWeComMessage(payload, { botId: BOT, traceId: 'trace-1', ...context })

function resultOf(payload: WeComInboundMessage, context?: Partial<WeComNormalizeContext>): WeComNormalized {
  const result = normalize(payload, context)
  if (!result) throw new Error('expected a message')
  // Every normalized message is a valid wire payload that carries neither a media key nor the response URL.
  expect(NormalizedPlatformMessageSchema.parse(result.message)).toEqual(result.message)
  const wire = JSON.stringify(result.message)
  expect(wire).not.toContain('aes-key')
  expect(wire).not.toContain('media.example.test')
  expect(wire).not.toContain(RESPONSE_URL)
  return result
}

const messageOf = (payload: WeComInboundMessage, context?: Partial<WeComNormalizeContext>): NormalizedPlatformMessage =>
  resultOf(payload, context).message

describe('WeCom normalization', () => {
  it('keys a direct chat by its member and reads the send time in seconds', () => {
    const message = messageOf(dmText)
    expect(message).toEqual({
      msgId: `wecom:${BOT}:msg-dm-0001`,
      traceId: 'trace-1',
      source: 'user',
      platform: 'wecom',
      channel: `dm:${USER}`,
      sender: { id: USER, isBot: false },
      text: 'hello there',
      mentionedBots: [],
      isDm: true,
      platformTimeMs: 1767225600000
    })
    expect(manifestFor('wecom').dmChannelPattern?.test(message.channel)).toBe(true)
  })

  it('keys a group by its chat id and keeps the mention as the person wrote it', () => {
    const message = messageOf(groupMention)
    expect(message).toMatchObject({
      msgId: `wecom:${BOT}:msg-group-0001`,
      channel: GROUP,
      text: `@${BOT_NAME} please summarize the thread`,
      mentionedBots: [BOT],
      isDm: false
    })
    expect(message.leadingMentions).toBeUndefined()
    expect(manifestFor('wecom').dmChannelPattern?.test(message.channel)).toBe(false)
  })

  it("marks the bot's leading mention for command parsing when its name is known", () => {
    const message = messageOf({ ...groupMention, text: { content: `@${BOT_NAME} /stop` } }, { botName: BOT_NAME })
    expect(message.leadingMentions).toEqual([{ id: BOT, text: `@${BOT_NAME}` }])
    expect(commandText(message, [BOT]).trim()).toBe('/stop')
    expect(messageOf(dmText, { botName: BOT_NAME }).leadingMentions).toBeUndefined()
  })

  it("admits voice by WeCom's own transcription", () => {
    const result = resultOf(dmVoice)
    expect(result.message.text).toBe('what is the weather today')
    expect(result.message.attachments).toBeUndefined()
    expect(result.media).toEqual([])
  })

  it('turns an image into an opaque reference and hands its URL and key to the connection alone', () => {
    const result = resultOf(dmImage)
    expect(result.message.text).toBe('')
    expect(result.message.attachments).toEqual([
      { id: 'msg-dm-0003:0', name: 'image-1.jpg', mimeType: 'image/jpeg', sourceUrl: 'wecom-media:msg-dm-0003:0' }
    ])
    expect(result.media).toEqual([
      { ref: 'wecom-media:msg-dm-0003:0', url: IMAGE.url, aesKey: IMAGE.aeskey, kind: 'image' }
    ])
  })

  it('carries a file and a video, which WeCom sends without a name', () => {
    const file = resultOf(dmFile)
    expect(file.message.attachments).toEqual([
      {
        id: 'msg-dm-0004:0',
        name: 'attachment-1',
        mimeType: 'application/octet-stream',
        sourceUrl: 'wecom-media:msg-dm-0004:0'
      }
    ])
    expect(file.media).toEqual([{ ref: 'wecom-media:msg-dm-0004:0', url: FILE.url, aesKey: FILE.aeskey, kind: 'file' }])
    const video = resultOf(dmVideo)
    expect(video.message.attachments).toEqual([
      { id: 'msg-dm-0005:0', name: 'video-1.mp4', mimeType: 'video/mp4', sourceUrl: 'wecom-media:msg-dm-0005:0' }
    ])
    expect(video.media[0]).toMatchObject({ url: VIDEO.url, aesKey: VIDEO.aeskey, kind: 'video' })
  })

  it('joins mixed text runs and carries their images', () => {
    const result = resultOf(groupMixed)
    expect(result.message).toMatchObject({
      text: `@${BOT_NAME} see the screenshot\nthanks`,
      attachments: [{ id: 'msg-group-0002:0', mimeType: 'image/jpeg', sourceUrl: 'wecom-media:msg-group-0002:0' }]
    })
    expect(result.media).toEqual([
      { ref: 'wecom-media:msg-group-0002:0', url: MIXED_IMAGE.url, aesKey: MIXED_IMAGE.aeskey, kind: 'image' }
    ])
  })

  it('quotes text without a message id, since WeCom names none', () => {
    const message = messageOf(groupQuoteOfText)
    expect(message.quoted).toEqual({ text: 'The build is red again.' })
    expect(message.replyTo).toBeUndefined()
  })

  it('bounds a long quote and marks it as an excerpt', () => {
    const long = structuredClone(groupQuoteOfText)
    long.quote = { msgtype: 'text', text: { content: 'x'.repeat(1200) } }
    expect(messageOf(long).quoted).toEqual({ text: `${'x'.repeat(1000)}…`, excerpt: true })
  })

  it('carries a quoted image as an attachment the quote names', () => {
    const result = resultOf(dmQuoteOfImage)
    expect(result.message.text).toBe('what is in this picture?')
    expect(result.message.attachments).toEqual([
      {
        id: 'msg-dm-0006:quote:0',
        name: 'image-1.jpg',
        mimeType: 'image/jpeg',
        sourceUrl: 'wecom-media:msg-dm-0006:0'
      }
    ])
    expect(result.message.quoted).toEqual({ text: '[attached: image-1.jpg (image/jpeg)]' })
    expect(result.media).toEqual([
      { ref: 'wecom-media:msg-dm-0006:0', url: QUOTED_IMAGE.url, aesKey: QUOTED_IMAGE.aeskey, kind: 'image' }
    ])
  })

  it('says so in the text when media arrives without a usable URL or key', () => {
    for (const image of [
      { url: IMAGE.url },
      { aeskey: IMAGE.aeskey },
      { ...IMAGE, url: 'http://media.example.test/x' }
    ]) {
      const result = resultOf({ ...dmImage, image })
      expect(result.message.text).toMatch(/^\[WeCom attachment unavailable/)
      expect(result.message.attachments).toBeUndefined()
      expect(result.media).toEqual([])
    }
  })

  it('omits a send time that is absent or not in seconds', () => {
    expect(messageOf({ ...dmText, create_time: undefined }).platformTimeMs).toBeUndefined()
    expect(messageOf({ ...dmText, create_time: 1767225600000 }).platformTimeMs).toBeUndefined()
  })

  it('serves no message type it does not know', () => {
    expect(normalize(streamRefresh)).toBeNull()
    expect(normalize({ ...dmText, msgtype: 'event' })).toBeNull()
  })

  it('refuses another bot, an assistant invocation, and anything it cannot address', () => {
    expect(normalize(dmText, { botId: 'aibot-other' })).toBeNull()
    expect(normalize(assistantInvocation)).toBeNull()
    for (const overrides of [
      { chattype: 'channel' },
      { msgid: '' },
      { from: {} },
      { from: undefined },
      { text: { content: '' } }
    ] satisfies Partial<WeComInboundMessage>[])
      expect(normalize({ ...dmText, ...overrides }), JSON.stringify(overrides)).toBeNull()
    expect(normalize({ ...groupMention, chatid: undefined })).toBeNull()
    expect(normalize({ ...groupMention, chatid: 'dm:user-bob' })).toBeNull()
  })

  it('ignores a chat id on a direct chat', () => {
    expect(messageOf({ ...dmText, chatid: GROUP }).channel).toBe(`dm:${USER}`)
  })
})
