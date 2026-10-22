// DingTalk media: inbound downloads by download code, outbound uploads sent as image or file messages (dingtalk-integration.md §4.5).
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DingTalkRobotMessage } from '@agentconnect.md/message'
import { DingTalkConnection } from '../src/platforms/dingtalk/connection.js'
import { dingTalkFileUploader, dingTalkMediaMessage } from '../src/platforms/dingtalk/media.js'
import { attachmentReadToolsFor, isAttachmentReadTool } from '../src/platforms/read-ports.js'

const log = { trace: () => {}, debug: () => {}, info: () => {}, warn: vi.fn(), error: () => {} }
const ORIGIN = 'https://api.example.test'
const OAPI = 'https://oapi.dingtalk.com'
const FILE_HOST = 'http://files.example.test'
const CLIENT_ID = 'client-id-example'
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(32, 1)])

interface Call {
  url: string
  init?: RequestInit
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function fakeFetch(
  opts: {
    file?: () => Response
    download?: () => Response
    upload?: () => Response
    send?: () => Response
  } = {}
) {
  const calls: Call[] = []
  let sends = 0
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, ...(init ? { init } : {}) })
    if (url === `${ORIGIN}/v1.0/oauth2/accessToken`) return json(200, { accessToken: 'token-1', expireIn: 7200 })
    if (url === `${ORIGIN}/v1.0/robot/messageFiles/download`)
      return opts.download?.() ?? json(200, { downloadUrl: `${FILE_HOST}/object?sig=1` })
    if (url.startsWith(FILE_HOST)) return opts.file?.() ?? new Response(new Uint8Array(PNG))
    if (url.startsWith(`${OAPI}/media/upload`))
      return opts.upload?.() ?? json(200, { errcode: 0, errmsg: 'ok', media_id: '@media-example' })
    sends++
    return opts.send?.() ?? json(200, { processQueryKey: `pqk-${sends}` })
  })
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch }
}

const connections: DingTalkConnection[] = []
afterEach(async () => {
  for (const conn of connections.splice(0)) await conn.stop()
})

function connect(fetchImpl: typeof fetch) {
  const conn = new DingTalkConnection(
    { clientId: CLIENT_ID, clientSecret: 'client-secret-example', integrations: [] },
    { log, onMessage: () => {}, fetchImpl, origin: ORIGIN }
  )
  connections.push(conn)
  return conn
}

const quotedFile: DingTalkRobotMessage = {
  msgId: 'msg-0001',
  conversationId: 'cid-example-group',
  conversationType: '2',
  senderStaffId: 'user-0001',
  robotCode: CLIENT_ID,
  isInAtList: true,
  msgtype: 'text',
  text: {
    content: ' read this',
    isReplyMsg: true,
    repliedMsg: { msgType: 'file', msgId: 'msg-file', content: { downloadCode: 'code-file', fileName: 'notes.pdf' } }
  }
}

const picture: DingTalkRobotMessage = {
  msgId: 'msg-0002',
  conversationId: 'cid-example-dm',
  conversationType: '1',
  senderStaffId: 'user-0001',
  robotCode: CLIENT_ID,
  msgtype: 'picture',
  content: { downloadCode: 'code-picture' }
}

describe('DingTalk inbound attachments', () => {
  it('points every attachment at the DingTalk read tool, which the platform declares', () => {
    const conn = connect(fakeFetch().fetchImpl)
    const msg = conn.normalize(quotedFile)!
    expect(msg.attachments).toEqual([
      expect.objectContaining({ name: 'notes.pdf', sourceUrl: 'code-file', readerToolName: 'readDingTalkFile' })
    ])
    expect(attachmentReadToolsFor(['dingtalk']).map((tool) => tool.name)).toEqual(['readDingTalkFile'])
    expect(isAttachmentReadTool('readDingTalkFile')).toBe(true)
  })

  it('exchanges the download code with the robot code, then fetches the short-lived URL', async () => {
    const { calls, fetchImpl } = fakeFetch()
    const conn = connect(fetchImpl)
    expect(await conn.downloadFile('code-file', 1024)).toEqual(PNG)
    const exchange = calls.find((call) => call.url.endsWith('/v1.0/robot/messageFiles/download'))!
    expect((exchange.init!.headers as Record<string, string>)['x-acs-dingtalk-access-token']).toBe('token-1')
    expect(JSON.parse(String(exchange.init!.body))).toEqual({ downloadCode: 'code-file', robotCode: CLIENT_ID })
    expect(calls.at(-1)!.url).toBe(`${FILE_HOST}/object?sig=1`)
  })

  it('holds the size limit, declared or streamed', async () => {
    const declared = connect(
      fakeFetch({ file: () => new Response('x'.repeat(10), { headers: { 'content-length': '5000' } }) }).fetchImpl
    )
    expect(await declared.downloadFile('code-file', 1024)).toBeNull()
    const streamed = connect(fakeFetch({ file: () => new Response('x'.repeat(2048)) }).fetchImpl)
    expect(await streamed.downloadFile('code-file', 1024)).toBeNull()
  })

  it('never throws: an API refusal, a missing URL, a network failure and a non-image picture all read as null', async () => {
    const refused = connect(fakeFetch({ download: () => json(400, { code: 'invalidParameter' }) }).fetchImpl)
    await expect(refused.downloadFile('code-file')).resolves.toBeNull()
    const empty = connect(fakeFetch({ download: () => json(200, {}) }).fetchImpl)
    await expect(empty.downloadFile('code-file')).resolves.toBeNull()
    const local = connect(fakeFetch({ download: () => json(200, { downloadUrl: 'file:///etc/hosts' }) }).fetchImpl)
    await expect(local.downloadFile('code-file')).resolves.toBeNull()
    const offline = connect(
      fakeFetch({
        file: () => {
          throw new TypeError('fetch failed')
        }
      }).fetchImpl
    )
    await expect(offline.downloadFile('code-file')).resolves.toBeNull()
    const html = connect(fakeFetch({ file: () => new Response('<html></html>') }).fetchImpl)
    html.normalize(picture)
    await expect(html.downloadFile('code-picture')).resolves.toBeNull()
    await expect(html.downloadFile('')).resolves.toBeNull()
  })
})

describe('DingTalk outbound media', () => {
  it('uploads an image and sends it by media id, returning the send’s process query key', async () => {
    const { calls, fetchImpl } = fakeFetch()
    const conn = connect(fetchImpl)
    const outcome = await conn.sendMedia('cid-example-group', { bytes: PNG, name: 'chart.png', mimeType: 'image/png' })
    expect(outcome).toEqual({ ok: true, messageId: 'pqk-1' })
    const upload = calls.find((call) => call.url.startsWith(`${OAPI}/media/upload`))!
    const query = new URL(upload.url).searchParams
    expect(query.get('type')).toBe('image')
    expect(query.get('access_token')).toBe('token-1')
    const media = (upload.init!.body as FormData).get('media') as File
    expect(media.name).toBe('chart.png')
    expect(Buffer.from(await media.arrayBuffer())).toEqual(PNG)
    const send = calls.at(-1)!
    expect(send.url).toBe(`${ORIGIN}/v1.0/robot/groupMessages/send`)
    expect(JSON.parse(String(send.init!.body))).toEqual({
      robotCode: CLIENT_ID,
      openConversationId: 'cid-example-group',
      msgKey: 'sampleImageMsg',
      msgParam: JSON.stringify({ photoURL: '@media-example' })
    })
  })

  it('sends any other file as a file message with its type, and a caption as a message after it', async () => {
    const { calls, fetchImpl } = fakeFetch()
    const conn = connect(fetchImpl)
    const outcome = await conn.sendMedia(
      'dm:user-0001',
      { bytes: Buffer.from('%PDF-1.7'), name: 'Report.PDF', mimeType: 'application/pdf' },
      'The weekly report'
    )
    expect(outcome).toEqual({ ok: true, messageId: 'pqk-1' })
    expect(new URL(calls.find((call) => call.url.startsWith(OAPI))!.url).searchParams.get('type')).toBe('file')
    const sends = calls.filter((call) => call.url.endsWith('/v1.0/robot/oToMessages/batchSend'))
    expect(sends.map((call) => JSON.parse(String(call.init!.body)))).toEqual([
      {
        robotCode: CLIENT_ID,
        userIds: ['user-0001'],
        msgKey: 'sampleFile',
        msgParam: JSON.stringify({ mediaId: '@media-example', fileName: 'Report.PDF', fileType: 'pdf' })
      },
      {
        robotCode: CLIENT_ID,
        userIds: ['user-0001'],
        msgKey: 'sampleText',
        msgParam: JSON.stringify({ content: 'The weekly report' })
      }
    ])
  })

  it('refuses a file over the upload cap before any call, and reports upload and send failures', async () => {
    const { calls, fetchImpl } = fakeFetch()
    const conn = connect(fetchImpl)
    const big = { bytes: Buffer.alloc(20 * 1024 * 1024 + 1), name: 'big.png', mimeType: 'image/png' }
    expect(await conn.sendMedia('cid-example-group', big)).toEqual({ ok: false, reason: 'too_large' })
    expect(calls).toEqual([])

    const file = { bytes: PNG, name: 'chart.png', mimeType: 'image/png' }
    const rejected = connect(
      fakeFetch({ upload: () => json(200, { errcode: 40004, errmsg: 'invalid type' }) }).fetchImpl
    )
    expect(await rejected.sendMedia('cid-example-group', file)).toEqual({
      ok: false,
      reason: 'platform_error',
      detail: '40004'
    })
    const refused = connect(fakeFetch({ send: () => json(403, { code: 'Forbidden.AccessDenied' }) }).fetchImpl)
    expect(await refused.sendMedia('cid-example-group', file)).toEqual({
      ok: false,
      reason: 'platform_error',
      detail: 'Forbidden.AccessDenied'
    })
    // A send whose response was lost may still have delivered the image.
    const lost = connect(
      fakeFetch({
        send: () => {
          throw new TypeError('fetch failed')
        }
      }).fetchImpl
    )
    expect(await lost.sendMedia('cid-example-group', file)).toEqual({ ok: false, reason: 'indeterminate' })
  })

  it('binds the turn’s image uploader to its leased connection, and offers none to a headless turn', async () => {
    const sendMedia = vi.fn(async () => ({ ok: true as const, messageId: 'pqk-9' }))
    const uploader = dingTalkFileUploader({ conn: { sendMedia } as never, channel: 'cid-example-group' })!
    const file = { bytes: PNG, name: 'chart.png', mimeType: 'image/png' }
    expect(await uploader(file, 'Caption')).toEqual({ ok: true, messageId: 'pqk-9' })
    expect(sendMedia).toHaveBeenCalledWith('cid-example-group', file, 'Caption')
    expect(dingTalkFileUploader({ channel: 'cid-example-group' })).toBeUndefined()
  })

  it('names a file without an extension by a generic type', () => {
    expect(dingTalkMediaMessage('@m', { name: 'README', mimeType: 'text/plain' })).toEqual({
      msgKey: 'sampleFile',
      msgParam: JSON.stringify({ mediaId: '@m', fileName: 'README', fileType: 'file' })
    })
  })
})
