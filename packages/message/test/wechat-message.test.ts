import { describe, expect, it } from 'vitest'
import { NormalizedPlatformMessageSchema, manifestFor, type NormalizedPlatformMessage } from '@agentconnect.md/protocol'
import { normalizeWeChatMessage, type WeChatInboundMessage } from '../src/wechat-message.js'
import {
  BIG_ID,
  BOT,
  CONTEXT_TOKEN,
  USER,
  botAuthored,
  empty,
  fileWithCaption,
  foreignSender,
  image,
  quote,
  text,
  voice
} from './fixtures/wechat-messages.js'

const normalize = (payload: WeChatInboundMessage) =>
  normalizeWeChatMessage(payload, { botId: BOT, boundUserId: USER, traceId: 'trace-1' })

function messageOf(payload: WeChatInboundMessage): NormalizedPlatformMessage {
  const result = normalize(payload)
  if (!result) throw new Error('expected a message')
  // Every normalized message is a valid wire payload that carries neither the reply token nor a media key.
  expect(NormalizedPlatformMessageSchema.parse(result.message)).toEqual(result.message)
  const wire = JSON.stringify(result.message)
  expect(wire).not.toContain(CONTEXT_TOKEN)
  expect(wire).not.toMatch(/aes|-ref|cdn\.example/)
  return result.message
}

describe('WeChat normalization', () => {
  it('keys the one chat by its user and keeps a message id above 2^53 exact', () => {
    const message = messageOf(text)
    expect(message).toEqual({
      msgId: `wechat:${BOT}:${BIG_ID}`,
      traceId: 'trace-1',
      source: 'user',
      platform: 'wechat',
      channel: `dm:${USER}`,
      sender: { id: USER, isBot: false },
      text: 'hello there',
      mentionedBots: [],
      isDm: true,
      platformTimeMs: 1761292800000
    })
    expect(manifestFor('wechat').dmChannelPattern?.test(message.channel)).toBe(true)
  })

  it('refuses a message id that a JSON number has already rounded', () => {
    expect(normalize({ ...text, message_id: Number(BIG_ID) })).toBeNull()
    expect(normalize({ ...text, message_id: 42 })?.message.msgId).toBe(`wechat:${BOT}:42`)
  })

  it("admits voice by WeChat's own transcription", () => {
    const message = messageOf(voice)
    expect(message.text).toBe('今天天气怎么样')
    expect(message.attachments).toBeUndefined()
  })

  it('turns media into opaque references and hands the keys to the connection alone', () => {
    const result = normalize(image)!
    expect(result.message.attachments).toEqual([
      { id: `${BIG_ID}:0`, name: 'image-1.jpg', mimeType: 'image/jpeg', sourceUrl: `wechat-media:${BIG_ID}:0` }
    ])
    expect(result.media).toEqual([
      {
        ref: `wechat-media:${BIG_ID}:0`,
        image: true,
        encryptQueryParam: 'image-ref',
        aesKey: 'aW1hZ2Uta2V5',
        aesKeyHex: '00112233445566778899aabbccddeeff'
      }
    ])
  })

  it('keeps a caption beside a file and sanitizes its name', () => {
    const message = messageOf(fileWithCaption)
    expect(message.text).toBe('please read this')
    expect(message.attachments).toEqual([
      {
        id: `${BIG_ID}:0`,
        name: 'report _final_.pdf',
        mimeType: 'application/pdf',
        sourceUrl: `wechat-media:${BIG_ID}:0`
      }
    ])
    expect(normalize(fileWithCaption)!.media[0]).toMatchObject({ fullUrl: 'https://cdn.example.test/c2c/download?x=1' })
  })

  it('bounds a quoted message to 1,000 characters', () => {
    const message = messageOf(quote)
    expect(message.text).toBe('what does this mean?')
    expect(message.quoted).toEqual({ text: `${'x'.repeat(1000)}…`, excerpt: true })
  })

  it('drops bot-authored, empty and foreign-sender messages', () => {
    expect(normalize(botAuthored)).toBeNull()
    expect(normalize(empty)).toBeNull()
    expect(normalize(foreignSender)).toBeNull()
    expect(normalize({ ...text, message_id: undefined })).toBeNull()
    expect(normalize({ ...text, from_user_id: '' })).toBeNull()
  })
})
