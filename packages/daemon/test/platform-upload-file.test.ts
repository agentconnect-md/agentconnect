import { describe, expect, it, vi } from 'vitest'
import { TelegramConnection, type TelegramBotHandle } from '../src/telegram/connection.js'
import { DiscordConnection } from '../src/discord/connection.js'
import { FeishuConnection, type FeishuClientHandle } from '../src/feishu/connection.js'

const png = { bytes: Buffer.from('PNGBYTES'), name: 'shot.png', mimeType: 'image/png' }
const zip = { bytes: Buffer.from('PK'), name: 'logs.zip', mimeType: 'application/zip' }

/** The outbound file surface, per platform. Slack is covered separately because its share is
 *  three calls and answers with no message id; these three answer with the message they made,
 *  which is what makes a forward there anchor like an ordinary post. */
describe('outbound file sends', () => {
  describe('telegram', () => {
    function connection() {
      const api = {
        sendMessage: vi.fn(async () => ({ message_id: 10 })),
        sendPhoto: vi.fn(async () => ({ message_id: 11 })),
        sendDocument: vi.fn(async () => ({ message_id: 12 }))
      }
      const handle = { api, init: async () => {}, botInfo: { id: 1 } } as unknown as TelegramBotHandle
      const conn = new TelegramConnection(
        { group: { botToken: 'tok', integrations: [] }, onMessage: () => {}, newTraceId: () => 't', sendIntervalMs: 0 },
        () => handle
      )
      return { conn, api }
    }

    it('sends an image as a photo so it previews inline, captioned, topic-threaded, and by reply', async () => {
      // `replyTo` is what PLACES the post in a non-forum group — without it the file lands at
      // the chat ROOT, the outcome the design's §2 exists to rule out.
      const { conn, api } = connection()
      await expect(conn.uploadFile('-100123', png, 'from slack', { thread: '77', replyTo: 41 })).resolves.toEqual({
        ok: true,
        messageId: '11'
      })
      expect(api.sendPhoto).toHaveBeenCalledWith('-100123', expect.anything(), {
        message_thread_id: 77,
        reply_parameters: { message_id: 41, allow_sending_without_reply: true },
        caption: 'from slack'
      })
      expect(api.sendDocument).not.toHaveBeenCalled()
      expect(api.sendMessage).not.toHaveBeenCalled()
    })

    it('ignores a non-numeric thread (the tg:/dm session keys address nothing)', async () => {
      const { conn, api } = connection()
      await conn.uploadFile('-100123', png, undefined, { thread: 'tg:99', replyTo: 99 })
      expect(api.sendPhoto).toHaveBeenCalledWith('-100123', expect.anything(), {
        reply_parameters: { message_id: 99, allow_sending_without_reply: true }
      })
    })

    it('sends anything else as a document, the only form that preserves the bytes', async () => {
      const { conn, api } = connection()
      await expect(conn.uploadFile('-100123', zip, 'logs')).resolves.toEqual({ ok: true, messageId: '12' })
      expect(api.sendDocument).toHaveBeenCalledOnce()
      expect(api.sendPhoto).not.toHaveBeenCalled()
    })

    it('posts an over-cap caption as its own message, after the file and with the same placement', async () => {
      const { conn, api } = connection()
      const long = 'x'.repeat(1025)
      await conn.uploadFile('-100123', png, long, { replyTo: 41 })
      expect(api.sendMessage).toHaveBeenCalledWith('-100123', long, {
        reply_parameters: { message_id: 41, allow_sending_without_reply: true }
      })
      // File first: a photo Telegram rejects must not leave a caption standing alone.
      expect(api.sendPhoto.mock.invocationCallOrder[0]!).toBeLessThan(api.sendMessage.mock.invocationCallOrder[0]!)
    })

    it('reports a lost over-cap caption as a warning, not as a failed send', async () => {
      const { conn, api } = connection()
      api.sendMessage.mockRejectedValueOnce(new Error('rate limited'))
      await expect(conn.uploadFile('-100123', png, 'x'.repeat(1025))).resolves.toEqual({
        ok: true,
        messageId: '11',
        warning: expect.stringContaining('caption')
      })
    })

    it('classifies a refused send instead of throwing into the caller', async () => {
      const { conn, api } = connection()
      api.sendPhoto.mockRejectedValueOnce(Object.assign(new Error('Bad Request'), { description: 'chat not found' }))
      await expect(conn.uploadFile('-100123', png, 'hi')).resolves.toEqual({ ok: false, reason: 'not_found' })
    })
  })

  describe('discord', () => {
    function connection() {
      const conn = new DiscordConnection({
        group: { botToken: 'token', integrations: [] },
        onMessage: () => {},
        newTraceId: () => 'trace',
        sendIntervalMs: 0
      })
      let n = 0
      const channel = { send: vi.fn(async (_payload: unknown) => ({ id: `m${++n}` })) }
      ;(conn as unknown as { client: unknown }).client = { channels: { fetch: async () => channel } }
      return { conn, channel }
    }

    it('carries the bytes on the message itself, with every ping suppressed', async () => {
      // allowedMentions parse:[] is the platform-native half of caption-mention escaping —
      // a model-authored caption must not be able to ping.
      const { conn, channel } = connection()
      await expect(conn.uploadFile('C1', png, 'look at this')).resolves.toEqual({ ok: true, messageId: 'm1' })
      expect(channel.send).toHaveBeenCalledWith({
        content: 'look at this',
        files: [{ attachment: png.bytes, name: 'shot.png' }],
        allowedMentions: { parse: [] }
      })
    })

    it('attaches the file to the first chunk only when the caption is split', async () => {
      const { conn, channel } = connection()
      await conn.uploadFile('C1', png, 'y'.repeat(2500))
      expect(channel.send).toHaveBeenCalledTimes(2)
      expect(channel.send.mock.calls[0]![0]).toHaveProperty('files')
      expect(channel.send.mock.calls[1]![0]).not.toHaveProperty('files')
    })

    it('reports a dropped later chunk as a warning, since the file itself landed', async () => {
      const { conn, channel } = connection()
      channel.send.mockImplementationOnce(async () => ({ id: 'm1' })).mockRejectedValueOnce(new Error('boom'))
      await expect(conn.uploadFile('C1', png, 'y'.repeat(2500))).resolves.toEqual({
        ok: true,
        messageId: 'm1',
        warning: expect.stringContaining('caption')
      })
    })

    it('classifies an unreachable channel rather than claiming delivery', async () => {
      const { conn } = connection()
      ;(conn as unknown as { client: unknown }).client = { channels: { fetch: async () => null } }
      await expect(conn.uploadFile('C1', png, 'hi')).resolves.toEqual({ ok: false, reason: 'not_found' })
    })

    it('classifies an over-limit attachment from Discord’s own error code', async () => {
      const { conn, channel } = connection()
      channel.send.mockRejectedValueOnce(Object.assign(new Error('Request entity too large'), { code: 40005 }))
      await expect(conn.uploadFile('C1', png, 'hi')).resolves.toEqual({ ok: false, reason: 'too_large' })
    })
  })

  describe('feishu', () => {
    function connection() {
      const api = {
        createText: vi.fn(async () => ({ messageId: 'om_text' })),
        replyText: vi.fn(async () => ({ messageId: 'om_reply' })),
        uploadImage: vi.fn(async () => ({ imageKey: 'img_1' })),
        createImage: vi.fn(async () => ({ messageId: 'om_img' })),
        replyImage: vi.fn(async () => ({ messageId: 'om_img_reply' }))
      }
      const handle = { api, startWs: async () => {}, close: () => {} } as unknown as FeishuClientHandle
      const conn = new FeishuConnection(
        {
          group: {
            appId: 'cli_1',
            appSecret: 's',
            mode: 'direct',
            region: 'feishu',
            botOpenId: 'ou_bot',
            integrations: []
          },
          onMessage: () => {},
          newTraceId: () => 't',
          sendIntervalMs: 0
        },
        () => handle
      )
      return { conn, api }
    }

    it('hosts the bytes first, then sends a message referencing the returned key', async () => {
      const { conn, api } = connection()
      await conn.uploadFile('oc_1', png, 'from slack')
      expect(api.uploadImage).toHaveBeenCalledWith(png.bytes)
      expect(api.createImage).toHaveBeenCalledWith('oc_1', 'img_1')
    })

    it('sends the image before the caption, and anchors on it', async () => {
      const { conn, api } = connection()
      await expect(conn.uploadFile('oc_1', png, 'from slack')).resolves.toEqual({ ok: true, messageId: 'om_img' })
      expect(api.createText).toHaveBeenCalledWith('oc_1', 'from slack')
      expect(api.createImage.mock.invocationCallOrder[0]!).toBeLessThan(api.createText.mock.invocationCallOrder[0]!)
    })

    it('reports nothing-sent when the image fails, without having posted the caption', async () => {
      const { conn, api } = connection()
      api.createImage.mockRejectedValueOnce(new Error('bad key'))
      await expect(conn.uploadFile('oc_1', png, 'from slack')).resolves.toEqual({
        ok: false,
        reason: 'platform_error'
      })
      expect(api.createText).not.toHaveBeenCalled()
    })

    it('reports a lost caption as a warning, not as a failed send', async () => {
      const { conn, api } = connection()
      api.createText.mockRejectedValueOnce(new Error('rate limited'))
      await expect(conn.uploadFile('oc_1', png, 'from slack')).resolves.toEqual({
        ok: true,
        messageId: 'om_img',
        warning: 'the image was sent, but its caption did not post'
      })
    })

    it('says PART of the caption when earlier chunks already landed', async () => {
      const { conn, api } = connection()
      api.createText
        .mockImplementationOnce(async () => ({ messageId: 'om_text' }))
        .mockRejectedValueOnce(new Error('rate limited'))
      const long = 'z'.repeat(6000)
      await expect(conn.uploadFile('oc_1', png, long)).resolves.toEqual({
        ok: true,
        messageId: 'om_img',
        warning: 'the image was sent, but part of its caption did not post'
      })
    })

    it('threads both messages off a topic anchor', async () => {
      const { conn, api } = connection()
      await conn.uploadFile('oc_1', png, 'hi', { thread: 'om_root' })
      expect(api.replyText).toHaveBeenCalledWith('om_root', 'hi')
      expect(api.replyImage).toHaveBeenCalledWith('om_root', 'img_1')
    })

    it('treats a DM anchor (the chat id) as the root post it is', async () => {
      const { conn, api } = connection()
      await expect(conn.uploadFile('oc_1', png, undefined, { thread: 'oc_1' })).resolves.toEqual({
        ok: true,
        messageId: 'om_img'
      })
      expect(api.createImage).toHaveBeenCalledWith('oc_1', 'img_1')
    })

    it('REFUSES an anchor it cannot honor instead of silently posting at the chat root', async () => {
      // sendImage prefix-sniffs; an unrecognized anchor (a hook turn's hookId:deliveryKey)
      // would otherwise become a brand-new topic reported as success.
      const { conn, api } = connection()
      await expect(conn.uploadFile('oc_1', png, 'hi', { thread: 'hook-1:d-2' })).resolves.toEqual({
        ok: false,
        reason: 'not_found'
      })
      expect(api.uploadImage).not.toHaveBeenCalled()
    })

    it('refuses a non-image, which its file endpoint cannot type honestly', async () => {
      const { conn, api } = connection()
      await expect(conn.uploadFile('oc_1', zip, 'logs')).resolves.toEqual({ ok: false, reason: 'platform_error' })
      expect(api.uploadImage).not.toHaveBeenCalled()
    })
  })
})
