import { createCipheriv, createHash } from 'node:crypto'
import type { LookupAddress } from 'node:dns'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WeComInboundMessage } from '@agentconnect.md/message'
import { WeComConnection } from '../src/platforms/wecom/connection.js'
import {
  correctWeComAttachment,
  decryptWeComMedia,
  downloadWeComMedia,
  WECOM_FILE_MAX_BYTES,
  WECOM_IMAGE_MAX_BYTES,
  WECOM_MEDIA_URL_TTL_MS,
  WECOM_UPLOAD_CHUNK_BYTES,
  WECOM_UPLOAD_MAX_CHUNKS,
  weComDispositionName,
  weComFileUploader,
  weComMediaKey,
  weComMediaLookup,
  weComMediaType,
  weComMediaUrl,
  uploadWeComMedia,
  weComUploadChunks,
  weComUploadName
} from '../src/platforms/wecom/media.js'
import type { Attachment, NormalizedMessage } from '../src/messages/normalized.js'
import { FakeWeComServer, quietLog } from './fakes/wecom-server.js'

const BOT = 'aibot-example'
const USER = 'user-alice'
const GROUP = 'chat-example-group'
const MEDIA_URL = 'https://media.example.test/download/item-1'

// Invented test vectors: a fixed key derived from a label, never a captured file.
const KEY = createHash('sha256').update('wecom-media-test-key').digest()
const AES_KEY = KEY.toString('base64')
const OTHER_KEY = createHash('sha256').update('wecom-media-other-key').digest()
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('example image body')])

/** Encrypt as WeCom documents it: AES-256-CBC, IV = the key's first 16 bytes, PKCS#7 padding to a multiple of `block`. */
function encrypt(plain: Buffer, key: Buffer = KEY, block = 32): Buffer {
  const pad = block - (plain.length % block)
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16))
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(Buffer.concat([plain, Buffer.alloc(pad, pad)])), cipher.final()])
}

function served(body: Buffer, headers: Record<string, string> = {}): typeof fetch {
  return vi.fn(async () => new Response(new Uint8Array(body), { status: 200, headers })) as unknown as typeof fetch
}

const signal = new AbortController().signal
const SENT = { ok: true, messageId: expect.stringMatching(/^aibot_send_msg_/) }

describe('WeCom media crypto', () => {
  it('decrypts AES-256-CBC with the key prefix as IV and padding to 32 or 16 bytes', () => {
    for (const length of [0, 1, 15, 16, 31, 32, 33, 1000]) {
      const plain = Buffer.alloc(length, 7)
      expect(decryptWeComMedia(encrypt(plain), KEY)).toEqual(plain)
      expect(decryptWeComMedia(encrypt(plain, KEY, 16), KEY)).toEqual(plain)
    }
  })

  it('refuses a wrong key, truncated ciphertext and a ragged length', () => {
    const cipher = encrypt(Buffer.from('a document body of some length'))
    expect(decryptWeComMedia(cipher, OTHER_KEY)).toBeUndefined()
    expect(decryptWeComMedia(cipher.subarray(0, cipher.length - 16), KEY)).toBeUndefined()
    expect(decryptWeComMedia(cipher.subarray(0, cipher.length - 1), KEY)).toBeUndefined()
    expect(decryptWeComMedia(Buffer.alloc(0), KEY)).toBeUndefined()
  })

  it('decodes only a Base64 key of 32 bytes', () => {
    expect(weComMediaKey(AES_KEY)).toEqual(KEY)
    expect(weComMediaKey(AES_KEY.replace(/=+$/, ''))).toEqual(KEY)
    expect(weComMediaKey(KEY.subarray(0, 16).toString('base64'))).toBeUndefined()
    expect(weComMediaKey('aes-key-placeholder')).toBeUndefined()
  })
})

describe('WeCom media download', () => {
  it('fetches, decrypts and names a download', async () => {
    const fetchImpl = served(encrypt(PNG), {
      'content-disposition': `attachment; filename*=UTF-8''%E6%8A%A5%E5%91%8A.pdf`
    })
    const result = await downloadWeComMedia({ signal, fetchImpl }, { url: MEDIA_URL, aesKey: AES_KEY }, 1024)
    expect(result).toEqual({ bytes: PNG, fileName: '报告.pdf' })
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(String(url)).toBe(MEDIA_URL)
    expect(init).toMatchObject({ redirect: 'error' })
  })

  it('reports a wrong key, an oversize body and an HTTP failure as unavailable', async () => {
    const reasons: string[] = []
    const report = (reason: string) => reasons.push(reason)
    const media = { url: MEDIA_URL, aesKey: AES_KEY }
    const big = Buffer.alloc(4096, 1)
    expect(await downloadWeComMedia({ signal, fetchImpl: served(encrypt(PNG, OTHER_KEY)) }, media, 1024, report)).toBe(
      null
    )
    expect(
      await downloadWeComMedia(
        { signal, fetchImpl: served(encrypt(big), { 'content-length': '4128' }) },
        media,
        1024,
        report
      )
    ).toBeNull()
    expect(await downloadWeComMedia({ signal, fetchImpl: served(encrypt(big)) }, media, 1024, report)).toBeNull()
    expect(await downloadWeComMedia({ signal, fetchImpl: served(encrypt(big)) }, media, 4095, report)).toBeNull()
    const gone = vi.fn(async () => new Response('', { status: 403 })) as unknown as typeof fetch
    expect(await downloadWeComMedia({ signal, fetchImpl: gone }, media, 1024, report)).toBeNull()
    expect(reasons).toEqual(['decrypt_failed', 'size_limit', 'size_limit', 'size_limit', 'http_403'])
  })

  it('refuses a plain-HTTP, credentialed or IP-literal URL before fetching', async () => {
    const fetchImpl = served(encrypt(PNG))
    const reasons: string[] = []
    for (const url of [
      'http://media.example.test/item',
      'https://user:pw@media.example.test/item',
      'https://127.0.0.1/item',
      'https://[::1]/item',
      'https://192.0.2.10/item',
      'not a url'
    ])
      expect(
        await downloadWeComMedia({ signal, fetchImpl }, { url, aesKey: AES_KEY }, 1024, (r) => reasons.push(r))
      ).toBeNull()
    expect(reasons.every((reason) => reason === 'refused_url')).toBe(true)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(weComMediaUrl(MEDIA_URL)?.hostname).toBe('media.example.test')
  })

  it('refuses a host that resolves to a loopback, private or link-local address', async () => {
    const resolveTo = (addresses: LookupAddress[]) =>
      ((_host: string, _options: unknown, callback: (e: null, a: LookupAddress[]) => void) =>
        callback(null, addresses)) as unknown as typeof import('node:dns').lookup
    const ask = (addresses: LookupAddress[], all = false) =>
      new Promise<unknown>((resolve) =>
        weComMediaLookup(resolveTo(addresses))('media.example.test', { all }, (error, address) =>
          resolve(error ? 'refused' : address)
        )
      )
    expect(await ask([{ address: '203.0.113.10', family: 4 }])).toBe('203.0.113.10')
    expect(await ask([{ address: '127.0.0.1', family: 4 }])).toBe('refused')
    expect(await ask([{ address: '10.1.2.3', family: 4 }])).toBe('refused')
    expect(await ask([{ address: '169.254.169.254', family: 4 }])).toBe('refused')
    expect(await ask([{ address: 'fd00::1', family: 6 }])).toBe('refused')
    expect(
      await ask([
        { address: '203.0.113.10', family: 4 },
        { address: '192.168.1.5', family: 4 }
      ])
    ).toBe('refused')
    expect(await ask([{ address: '203.0.113.10', family: 4 }], true)).toEqual([{ address: '203.0.113.10', family: 4 }])
  })

  it('reads a bare file name from Content-Disposition', () => {
    expect(weComDispositionName('attachment; filename="report.pdf"')).toBe('report.pdf')
    expect(weComDispositionName("attachment; filename*=UTF-8''notes%20v2.txt")).toBe('notes v2.txt')
    expect(weComDispositionName('attachment; filename="../../etc/passwd"')).toBe('passwd')
    expect(weComDispositionName('attachment; filename=".."')).toBeUndefined()
    expect(weComDispositionName(null)).toBeUndefined()
  })

  it('corrects the placeholder name and type from the bytes and the download name', () => {
    const att = (name: string, mimeType: string): Attachment => ({
      id: 'a',
      name,
      mimeType,
      sourceUrl: 'wecom-media:m:0'
    })
    const image = att('image-1.jpg', 'image/jpeg')
    expect(correctWeComAttachment(image, 'image', { bytes: PNG })).toBe(true)
    expect(image).toMatchObject({ name: 'image-1.png', mimeType: 'image/png', size: PNG.length })
    expect(correctWeComAttachment(att('image-2.jpg', 'image/jpeg'), 'image', { bytes: Buffer.from('text') })).toBe(
      false
    )
    const file = att('attachment-1', 'application/octet-stream')
    correctWeComAttachment(file, 'file', { bytes: Buffer.from('%PDF-1.7'), fileName: 'report.pdf' })
    expect(file).toMatchObject({ name: 'report.pdf', mimeType: 'application/pdf' })
    const unnamed = att('attachment-1', 'application/octet-stream')
    correctWeComAttachment(unnamed, 'file', { bytes: Buffer.from('plain') })
    expect(unnamed).toMatchObject({ name: 'attachment-1', mimeType: 'application/octet-stream' })
    const video = att('video-1.mp4', 'video/mp4')
    correctWeComAttachment(video, 'video', { bytes: Buffer.from('....ftyp'), fileName: 'clip.mov' })
    expect(video).toMatchObject({ name: 'clip.mov', mimeType: 'video/mp4' })
  })
})

describe('WeCom upload planning', () => {
  it('chunks at 512 KB and refuses past 100 chunks', () => {
    expect(weComUploadChunks(1)).toBe(1)
    expect(weComUploadChunks(WECOM_UPLOAD_CHUNK_BYTES)).toBe(1)
    expect(weComUploadChunks(WECOM_UPLOAD_CHUNK_BYTES + 1)).toBe(2)
    expect(weComUploadChunks(WECOM_UPLOAD_CHUNK_BYTES * WECOM_UPLOAD_MAX_CHUNKS)).toBe(100)
    expect(weComUploadChunks(WECOM_UPLOAD_CHUNK_BYTES * WECOM_UPLOAD_MAX_CHUNKS + 1)).toBeUndefined()
    expect(weComUploadChunks(0)).toBeUndefined()
  })

  it('sends PNG, JPEG and GIF as images within the image cap and anything else as a file within the file cap', () => {
    const sized = (size: number, mimeType: string) => ({ bytes: Buffer.alloc(size), mimeType })
    expect(weComMediaType(sized(100, 'image/png'))).toBe('image')
    expect(weComMediaType(sized(100, 'image/gif'))).toBe('image')
    expect(weComMediaType(sized(100, 'image/webp'))).toBe('file')
    expect(weComMediaType(sized(WECOM_IMAGE_MAX_BYTES + 1, 'image/jpeg'))).toBe('file')
    expect(weComMediaType(sized(WECOM_FILE_MAX_BYTES, 'application/pdf'))).toBe('file')
    expect(weComMediaType(sized(WECOM_FILE_MAX_BYTES + 1, 'application/pdf'))).toBeUndefined()
  })

  it('refuses an upload past 100 chunks before sending a frame', async () => {
    const command = vi.fn()
    const bytes = Buffer.alloc(WECOM_UPLOAD_CHUNK_BYTES * WECOM_UPLOAD_MAX_CHUNKS + 1)
    await expect(uploadWeComMedia({ command }, { bytes, name: 'big.bin' }, 'file')).rejects.toThrow(RangeError)
    expect(command).not.toHaveBeenCalled()
  })

  it('bounds an upload name to 256 bytes, keeping its extension', () => {
    expect(weComUploadName('report.pdf')).toBe('report.pdf')
    const long = weComUploadName(`${'报'.repeat(200)}.pdf`)
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(256)
    expect(long.endsWith('.pdf')).toBe(true)
  })
})

const connections: WeComConnection[] = []
afterEach(async () => {
  for (const conn of connections.splice(0)) await conn.stop()
})

function setup(
  opts: { now?: () => number; fetchImpl?: typeof fetch; maxAttachmentBytes?: number; log?: typeof quietLog } = {}
) {
  const server = new FakeWeComServer()
  const messages: NormalizedMessage[] = []
  const conn = new WeComConnection(
    { botId: BOT, secret: 'secret-placeholder', integrations: [{ agentId: 'agent', integrationId: 'int-wecom' }] },
    {
      onMessage: (msg) => messages.push(msg),
      log: opts.log ?? quietLog,
      createSocket: server.createSocket,
      timing: { requestTimeoutMs: 50 },
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.maxAttachmentBytes ? { maxAttachmentBytes: opts.maxAttachmentBytes } : {})
    }
  )
  connections.push(conn)
  return { server, conn, messages }
}

function dmMedia(msgid: string, msgtype: 'image' | 'file', url = MEDIA_URL): WeComInboundMessage {
  return {
    msgid,
    aibotid: BOT,
    chattype: 'single',
    from: { userid: USER },
    msgtype,
    [msgtype]: { url, aeskey: AES_KEY }
  }
}

const dmText: WeComInboundMessage = {
  msgid: 'msg-text-0001',
  aibotid: BOT,
  chattype: 'single',
  from: { userid: USER },
  msgtype: 'text',
  text: { content: 'and another thing' }
}

describe('WeCom inbound attachments', () => {
  it('fetches at receipt, corrects the name and type, and serves later reads from the held bytes', async () => {
    const lines: string[] = []
    const log = { ...quietLog, warn: (line: string) => lines.push(line), info: (line: string) => lines.push(line) }
    const fetchImpl = served(encrypt(PNG))
    const { server, conn, messages } = setup({ fetchImpl, log })
    await conn.start()
    server.last.message('req-1', dmMedia('msg-img-0001', 'image') as Record<string, unknown>)
    expect(messages).toHaveLength(0)
    await vi.waitFor(() => expect(messages).toHaveLength(1))
    const att = messages[0]!.attachments![0]!
    expect(att).toMatchObject({
      name: 'image-1.png',
      mimeType: 'image/png',
      size: PNG.length,
      readerToolName: 'readWeComFile'
    })
    expect(conn.hasMedia(att.sourceUrl!)).toBe(false)
    expect(await conn.downloadFile(att.sourceUrl!)).toEqual(PNG)
    expect(await conn.downloadFile(att.sourceUrl!, 4)).toBeNull()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(messages[0])).not.toContain(AES_KEY)
    expect(lines.join('\n')).not.toMatch(/media\.example\.test|wecom-media-test-key/)
    expect(lines.join('\n')).not.toContain(AES_KEY)
  })

  it('names a file from its download and keeps a later message in the same chat behind it', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const fetchImpl = vi.fn(async () => {
      await gate
      return new Response(new Uint8Array(encrypt(Buffer.from('%PDF-1.7 example'))), {
        headers: { 'content-disposition': 'attachment; filename="report.pdf"' }
      })
    }) as unknown as typeof fetch
    const { server, conn, messages } = setup({ fetchImpl })
    await conn.start()
    server.last.message('req-1', dmMedia('msg-file-0001', 'file') as Record<string, unknown>)
    server.last.message('req-2', dmText as Record<string, unknown>)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(messages).toHaveLength(0)
    release()
    await vi.waitFor(() => expect(messages).toHaveLength(2))
    expect(messages.map((m) => m.text)).toEqual(['', 'and another thing'])
    expect(messages[0]!.attachments![0]).toMatchObject({ name: 'report.pdf', mimeType: 'application/pdf' })
  })

  it('reads as unavailable once the link has expired, without fetching again', async () => {
    let now = 1_000_000
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls++
      return calls === 1 ? new Response('', { status: 500 }) : new Response(new Uint8Array(encrypt(PNG)))
    }) as unknown as typeof fetch
    const { server, conn, messages } = setup({ fetchImpl, now: () => now })
    await conn.start()
    server.last.message('req-1', dmMedia('msg-img-0002', 'image') as Record<string, unknown>)
    await vi.waitFor(() => expect(messages).toHaveLength(1))
    const att = messages[0]!.attachments![0]!
    expect(att.unavailableText).toMatch(/unavailable/)
    expect(conn.hasMedia(att.sourceUrl!)).toBe(true)
    now += WECOM_MEDIA_URL_TTL_MS
    expect(await conn.downloadFile(att.sourceUrl!)).toBeNull()
    expect(conn.hasMedia(att.sourceUrl!)).toBe(false)
    expect(calls).toBe(1)
  })

  it('retries a failed receipt fetch on read while the link is still valid', async () => {
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls++
      return calls === 1 ? new Response('', { status: 500 }) : new Response(new Uint8Array(encrypt(PNG)))
    }) as unknown as typeof fetch
    const { server, conn, messages } = setup({ fetchImpl })
    await conn.start()
    server.last.message('req-1', dmMedia('msg-img-0003', 'image') as Record<string, unknown>)
    await vi.waitFor(() => expect(messages).toHaveLength(1))
    expect(await conn.downloadFile(messages[0]!.attachments![0]!.sourceUrl!)).toEqual(PNG)
  })

  it('reads an oversize attachment or a refused host as unavailable', async () => {
    const fetchImpl = served(encrypt(Buffer.alloc(4096, 1)))
    const { server, conn, messages } = setup({ fetchImpl, maxAttachmentBytes: 1024 })
    await conn.start()
    server.last.message('req-1', dmMedia('msg-file-0002', 'file') as Record<string, unknown>)
    server.last.message('req-2', dmMedia('msg-file-0003', 'file', 'https://127.0.0.1/item') as Record<string, unknown>)
    await vi.waitFor(() => expect(messages).toHaveLength(2))
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    for (const msg of messages) {
      expect(msg.attachments![0]).toMatchObject({ name: 'attachment-1', mimeType: 'application/octet-stream' })
      expect(await conn.downloadFile(msg.attachments![0]!.sourceUrl!, 1024)).toBeNull()
    }
  })
})

describe('WeCom outbound media', () => {
  it('uploads in one chunk and sends an image to a direct chat, then its caption', async () => {
    const { server, conn } = setup()
    await conn.start()
    const outcome = await conn.sendMedia(`dm:${USER}`, { bytes: PNG, name: 'chart.png', mimeType: 'image/png' }, 'Q3')
    const socket = server.last
    // The image's own send frame names it.
    expect(outcome).toEqual({ ok: true, messageId: socket.frames('aibot_send_msg')[0]!.headers.req_id })
    expect(socket.frames('aibot_upload_media_init')[0]!.body).toEqual({
      type: 'image',
      filename: 'chart.png',
      total_size: PNG.length,
      total_chunks: 1,
      md5: createHash('md5').update(PNG).digest('hex')
    })
    expect(socket.frames('aibot_upload_media_chunk').map((f) => f.body)).toEqual([
      { upload_id: 'upload-example-1', chunk_index: 0, base64_data: PNG.toString('base64') }
    ])
    expect(socket.frames('aibot_upload_media_finish')[0]!.body).toEqual({ upload_id: 'upload-example-1' })
    expect(socket.frames('aibot_send_msg').map((f) => f.body)).toEqual([
      { chatid: USER, chat_type: 1, msgtype: 'image', image: { media_id: 'media-example-upload-example-1' } },
      { chatid: USER, chat_type: 1, msgtype: 'markdown', markdown: { content: 'Q3' } }
    ])
  })

  it('splits a file one byte past a chunk into two chunks and sends it to a group', async () => {
    const { server, conn } = setup()
    await conn.start()
    const bytes = Buffer.alloc(WECOM_UPLOAD_CHUNK_BYTES + 1, 3)
    const outcome = await conn.sendMedia(GROUP, { bytes, name: 'data.bin', mimeType: 'application/octet-stream' })
    expect(outcome).toEqual(SENT)
    const chunks = server.last.frames('aibot_upload_media_chunk').map((f) => f.body!)
    expect(chunks.map((c) => [c.chunk_index, Buffer.from(c.base64_data as string, 'base64').length])).toEqual([
      [0, WECOM_UPLOAD_CHUNK_BYTES],
      [1, 1]
    ])
    expect(server.last.frames('aibot_upload_media_init')[0]!.body).toMatchObject({ type: 'file', total_chunks: 2 })
    expect(server.last.frames('aibot_send_msg')[0]!.body).toEqual({
      chatid: GROUP,
      chat_type: 2,
      msgtype: 'file',
      file: { media_id: 'media-example-upload-example-1' }
    })
  })

  it('reports a refused upload and sends nothing', async () => {
    const { server, conn } = setup()
    await conn.start()
    server.answers.set('aibot_upload_media_chunk', 40001)
    expect(await conn.sendMedia(GROUP, { bytes: PNG, name: 'chart.png', mimeType: 'image/png' })).toEqual({
      ok: false,
      reason: 'platform_error',
      detail: 'errcode 40001'
    })
    expect(server.last.frames('aibot_upload_media_finish')).toHaveLength(0)
    expect(server.last.frames('aibot_send_msg')).toHaveLength(0)
  })

  it('refuses a file over the cap or under the minimum before uploading', async () => {
    const { server, conn } = setup()
    await conn.start()
    const big = { bytes: Buffer.alloc(WECOM_FILE_MAX_BYTES + 1), name: 'big.bin', mimeType: 'application/zip' }
    expect(await conn.sendMedia(GROUP, big)).toEqual({ ok: false, reason: 'too_large' })
    expect(
      await conn.sendMedia(GROUP, { bytes: Buffer.from('ab'), name: 'a.txt', mimeType: 'text/plain' })
    ).toMatchObject({ ok: false, reason: 'platform_error' })
    expect(server.last.frames('aibot_upload_media_init')).toHaveLength(0)
  })

  it('reports a send whose answer never came as possibly delivered', async () => {
    const { server, conn } = setup()
    await conn.start()
    server.answers.set('aibot_send_msg', 'silent')
    expect(await conn.sendMedia(GROUP, { bytes: PNG, name: 'chart.png', mimeType: 'image/png' })).toEqual({
      ok: false,
      reason: 'indeterminate'
    })
  })

  it('holds a bot to 30 uploads a minute', async () => {
    let now = 1_000_000
    const { server, conn } = setup({ now: () => now })
    await conn.start()
    const file = { bytes: PNG, name: 'chart.png', mimeType: 'image/png' }
    for (let i = 0; i < 30; i++) expect(await conn.sendMedia(`chat-example-${i}`, file)).toEqual(SENT)
    const refused = await conn.sendMedia('chat-example-30', file)
    expect(refused).toMatchObject({ ok: false, reason: 'platform_error' })
    expect(server.last.frames('aibot_upload_media_init')).toHaveLength(30)
    now += 60_000
    expect(await conn.sendMedia('chat-example-30', file)).toEqual(SENT)
  })

  it("binds the turn's uploader to its leased connection, and a headless turn gets none", async () => {
    const { server, conn } = setup()
    await conn.start()
    expect(weComFileUploader({ channel: GROUP, msgId: 'm' })).toBeUndefined()
    const upload = weComFileUploader({ channel: GROUP, msgId: 'm', conn })!
    expect(await upload({ bytes: PNG, name: 'chart.png', mimeType: 'image/png' })).toEqual(SENT)
    expect(server.last.frames('aibot_send_msg')[0]!.body).toMatchObject({ chatid: GROUP, msgtype: 'image' })
  })
})
