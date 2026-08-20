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

    it('sends an image as a photo so it previews inline, captioned and threaded', async () => {
      const { conn, api } = connection()
      await expect(conn.uploadFile('-100123', png, 'from slack', '77')).resolves.toEqual({ messageId: '11' })
      expect(api.sendPhoto).toHaveBeenCalledWith('-100123', expect.anything(), {
        message_thread_id: 77,
        caption: 'from slack'
      })
      expect(api.sendDocument).not.toHaveBeenCalled()
      expect(api.sendMessage).not.toHaveBeenCalled()
    })

    it('sends anything else as a document, the only form that preserves the bytes', async () => {
      const { conn, api } = connection()
      await expect(conn.uploadFile('-100123', zip, 'logs')).resolves.toEqual({ messageId: '12' })
      expect(api.sendDocument).toHaveBeenCalledOnce()
      expect(api.sendPhoto).not.toHaveBeenCalled()
    })

    it('posts an over-cap caption as its own message rather than letting Telegram truncate it', async () => {
      const { conn, api } = connection()
      const long = 'x'.repeat(1025)
      await conn.uploadFile('-100123', png, long)
      expect(api.sendMessage).toHaveBeenCalledWith('-100123', long, {})
      expect(api.sendPhoto.mock.calls[0]![2]).toEqual({})
    })

    it('reports a refused send instead of throwing into the caller', async () => {
      const { conn, api } = connection()
      api.sendPhoto.mockRejectedValueOnce(new Error('chat not found'))
      await expect(conn.uploadFile('-100123', png, 'hi')).resolves.toBeUndefined()
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
      const channel = { send: vi.fn(async () => ({ id: `m${++n}` })) }
      ;(conn as unknown as { client: unknown }).client = { channels: { fetch: async () => channel } }
      return { conn, channel }
    }

    it('carries the bytes on the message itself, so the caption and file are one post', async () => {
      const { conn, channel } = connection()
      await expect(conn.uploadFile('C1', png, 'look at this')).resolves.toEqual({ messageId: 'm1' })
      expect(channel.send).toHaveBeenCalledWith({
        content: 'look at this',
        files: [{ attachment: png.bytes, name: 'shot.png' }]
      })
    })

    it('attaches the file to the first chunk only when the caption is split', async () => {
      const { conn, channel } = connection()
      await conn.uploadFile('C1', png, 'y'.repeat(2500))
      expect(channel.send).toHaveBeenCalledTimes(2)
      expect(channel.send.mock.calls[0]![0]).toHaveProperty('files')
      expect(channel.send.mock.calls[1]![0]).not.toHaveProperty('files')
    })

    it('reports an unreachable channel rather than claiming delivery', async () => {
      const { conn } = connection()
      ;(conn as unknown as { client: unknown }).client = { channels: { fetch: async () => null } }
      await expect(conn.uploadFile('C1', png, 'hi')).resolves.toBeUndefined()
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

    it('anchors on the caption, because an image message carries none', async () => {
      const { conn, api } = connection()
      await expect(conn.uploadFile('oc_1', png, 'from slack')).resolves.toEqual({ messageId: 'om_text' })
      expect(api.createText).toHaveBeenCalledWith('oc_1', 'from slack')
    })

    it('anchors on the image when there is no caption at all', async () => {
      const { conn, api } = connection()
      await expect(conn.uploadFile('oc_1', png)).resolves.toEqual({ messageId: 'om_img' })
      expect(api.createText).not.toHaveBeenCalled()
    })

    it('threads both messages off a topic anchor', async () => {
      const { conn, api } = connection()
      await conn.uploadFile('oc_1', png, 'hi', 'om_root')
      expect(api.replyText).toHaveBeenCalledWith('om_root', 'hi')
      expect(api.replyImage).toHaveBeenCalledWith('om_root', 'img_1')
    })

    it('refuses a non-image, which its file endpoint cannot type honestly', async () => {
      const { conn, api } = connection()
      await expect(conn.uploadFile('oc_1', zip, 'logs')).resolves.toBeUndefined()
      expect(api.uploadImage).not.toHaveBeenCalled()
    })
  })
})
