import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '@tencent-connect/qqbot-nodejs/protocol'
import { downloadQQAttachment, downloadQQImage } from '../src/platforms/qq/images.js'
import { QQSender, type QQRestPort, type QQStreamCursor } from '../src/platforms/qq/sender.js'
import { attachmentToBlock } from '../src/session/attachment-block.js'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64'
)
const file = { bytes: png, name: 'picture.png', mimeType: 'image/png' }
const target = { kind: 'c2c' as const, id: 'user' }

function imageSender(blockSize: number | string = 40) {
  const abort = new AbortController()
  const request = vi.fn(async (_token: string, _method: string, path: string, _body?: unknown): Promise<unknown> => {
    if (path.endsWith('/upload_prepare'))
      return {
        upload_id: 'upload',
        block_size: blockSize,
        parts: [
          { index: 1, presigned_url: 'https://upload.example/1' },
          { index: 2, presigned_url: 'https://upload.example/2' }
        ]
      }
    if (path.endsWith('/files')) return { file_info: 'scoped-image', ttl: 300 }
    return { id: path.endsWith('/stream_messages') ? 'stream' : 'image' }
  })
  const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }))
  const sender = new QQSender(
    { request } as QQRestPort,
    async () => 'token',
    abort.signal,
    undefined,
    undefined,
    fetchImpl
  )
  return { sender, request, fetchImpl, abort }
}

describe('QQ image input', () => {
  it('reports unavailable QQ images instead of passing an unusable resource link', () => {
    const att = {
      id: 'image',
      name: 'image.png',
      mimeType: 'image/png',
      sourceUrl: 'https://gchat.qpic.cn/image',
      unavailableText: 'QQ image unavailable'
    }
    expect(attachmentToBlock(att, null, () => true)).toEqual({ type: 'text', text: 'QQ image unavailable' })
    expect(attachmentToBlock(att, png, () => false)).toEqual({ type: 'text', text: 'QQ image unavailable' })
    expect(attachmentToBlock(att, png, () => true)).toMatchObject({ type: 'image' })
  })
  it('downloads bounded provider bytes without forwarding bot credentials', async () => {
    const fetchImpl = vi.fn(async () => new Response(png, { headers: { 'content-length': String(png.length) } }))
    expect(await downloadQQImage('http://gchat.qpic.cn/image', 1000, new AbortController().signal, fetchImpl)).toEqual(
      png
    )
    expect(fetchImpl).toHaveBeenCalledWith('https://gchat.qpic.cn/image', {
      redirect: 'manual',
      signal: expect.any(AbortSignal)
    })
  })
  it('downloads bounded non-image attachments without applying image validation', async () => {
    const pdf = Buffer.from('%PDF-1.7')
    const fetchImpl = vi.fn(async () => new Response(pdf))
    expect(
      await downloadQQAttachment('https://gchat.qpic.cn/invoice', 1000, new AbortController().signal, fetchImpl)
    ).toEqual(pdf)
  })
  it('distinguishes oversized, non-image and expired content without logging URLs or response bodies', async () => {
    for (const [response, reason] of [
      [new Response(png, { headers: { 'content-length': '9999' } }), 'size_limit'],
      [new Response(Buffer.alloc(1001)), 'size_limit'],
      [new Response('not an image'), 'unsupported_format'],
      [new Response('sensitive provider response', { status: 403 }), 'http_403']
    ] as const) {
      const reportFailure = vi.fn()
      expect(
        await downloadQQImage(
          'https://gchat.qpic.cn/image?secret=hidden',
          1000,
          new AbortController().signal,
          async () => response,
          reportFailure
        )
      ).toBeNull()
      expect(reportFailure).toHaveBeenCalledExactlyOnceWith(reason)
    }
  })
  it('rejects redirects outside the provider before fetching their target', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } })
    )
    expect(
      await downloadQQImage('https://gchat.qpic.cn/image', 1000, new AbortController().signal, fetchImpl)
    ).toBeNull()
    expect(fetchImpl).toHaveBeenCalledOnce()
  })
})

describe('QQ image output', () => {
  it('quotes the acknowledged message once and shares its budget with progress, image and final', async () => {
    const { sender, request } = imageSender()
    const group = { kind: 'group' as const, id: 'group' }
    await sender.sendAcknowledgement(group, 'incoming', '收到，正在处理。')
    await sender.sendAcknowledgement(group, 'incoming', '收到，正在排队。')
    expect(request.mock.calls[0]?.[3]).toEqual({
      content: '收到，正在处理。',
      msg_type: 0,
      msg_id: 'incoming',
      msg_seq: 1,
      message_reference: { message_id: 'incoming' }
    })
    expect(await sender.sendProgress(group, 'incoming', 'Working.')).toBe(true)
    expect(await sender.sendProgress(group, 'incoming', 'More progress.')).toBe(false)
    expect(await sender.sendImage(group, 'incoming', file)).toMatchObject({ ok: true })
    const beforeRefusal = request.mock.calls.length
    expect(await sender.sendImage(group, 'incoming', file)).toMatchObject({ ok: false })
    expect(request).toHaveBeenCalledTimes(beforeRefusal)
    await sender.sendText(group, 'incoming', 'Done.')
    const posts = request.mock.calls.filter((call) => call[2].endsWith('/messages'))
    expect(posts).toHaveLength(4)
    for (const post of posts) expect(post[3]).toMatchObject({ message_reference: { message_id: 'incoming' } })
    expect(request.mock.lastCall?.[3]).toMatchObject({ markdown: { content: 'Done.' }, msg_seq: 4 })
    expect(await sender.sendProgress(group, 'another-message', 'New task.')).toBe(true)
    expect(await sender.sendProgress({ ...group, id: 'another-group' }, 'incoming', 'Other group.')).toBe(true)
  })

  it('does not retry uncertain acknowledgement or send a cancelled, late or DM acknowledgement', async () => {
    const { sender, request } = imageSender()
    const group = { kind: 'group' as const, id: 'group' }
    request.mockRejectedValueOnce(new Error('timeout'))
    await sender.sendAcknowledgement(group, 'incoming', '收到，正在处理。')
    await sender.sendAcknowledgement(group, 'incoming', '收到，正在处理。')
    expect(request).toHaveBeenCalledOnce()
    await sender.sendText(group, 'incoming', 'Done.')
    expect(request.mock.lastCall?.[3]).toMatchObject({ msg_seq: 2 })
    const abort = new AbortController()
    abort.abort()
    await sender.sendAcknowledgement(group, 'cancelled', 'Received.', abort.signal)
    await sender.sendAcknowledgement(target, 'dm', 'Received.')
    await sender.sendText(group, 'finished', 'Done.')
    await sender.sendAcknowledgement(group, 'finished', 'Received.')
    expect(request).toHaveBeenCalledTimes(3)
  })

  it('fits an overlong final into the remaining group allowance with a visible omission notice', async () => {
    const { sender, request } = imageSender()
    const group = { kind: 'group' as const, id: 'group' }
    for (let i = 0; i < 3; i++) expect(await sender.sendImage(group, 'incoming', file)).toMatchObject({ ok: true })
    await sender.sendText(group, 'incoming', '长回答😀'.repeat(2000))
    const posts = request.mock.calls.filter((call) => call[2].endsWith('/messages'))
    expect(posts).toHaveLength(4)
    const body = posts[3]![3] as { markdown: { content: string } }
    expect(
      posts.every(
        (call) =>
          (call[3] as { message_reference?: { message_id: string } }).message_reference?.message_id === 'incoming'
      )
    ).toBe(true)
    expect(body.markdown.content).toContain('remaining text was not sent')
    expect(Buffer.byteLength(body.markdown.content)).toBeLessThanOrEqual(4000)
    expect(body.markdown.content).not.toContain('\ufffd')
  })

  it('keeps uncertain progress charged, avoids resending it and still delivers a distinct final', async () => {
    const { sender, request } = imageSender()
    const group = { kind: 'group' as const, id: 'group' }
    request.mockRejectedValueOnce(new Error('timeout'))
    expect(await sender.sendProgress(group, 'incoming', 'Working.')).toBe(false)
    await expect(sender.sendText(group, 'incoming', 'Working.')).rejects.toThrow('no automatic resend')
    expect(request).toHaveBeenCalledOnce()
    expect(await sender.sendImage(group, 'incoming', file)).toMatchObject({ ok: true })
    expect(await sender.sendImage(group, 'incoming', file)).toMatchObject({ ok: true })
    expect(await sender.sendImage(group, 'incoming', file)).toMatchObject({ ok: false })
    await sender.sendText(group, 'incoming', 'Done.')
    expect(request.mock.calls.filter((call) => call[2].endsWith('/messages'))).toHaveLength(4)
  })

  it('releases definite Markdown refusals and does not send progress after turn cancellation', async () => {
    const { sender, request } = imageSender()
    const group = { kind: 'group' as const, id: 'group' }
    const original = request.getMockImplementation()!
    request.mockImplementation(async (...args) => {
      if ((args[3] as { msg_type?: number } | undefined)?.msg_type === 2)
        throw new ApiError('denied', 403, args[2], 123)
      return original(...args)
    })
    expect(await sender.sendProgress(group, 'incoming', 'Working.')).toBe(true)
    for (let i = 0; i < 2; i++) expect(await sender.sendImage(group, 'incoming', file)).toMatchObject({ ok: true })
    await sender.sendText(group, 'incoming', 'Done.')
    expect(request.mock.lastCall?.[3]).toMatchObject({
      content: 'Done.',
      msg_type: 0,
      message_reference: { message_id: 'incoming' }
    })
    const beforeCancel = request.mock.calls.length
    const abort = new AbortController()
    abort.abort()
    expect(await sender.sendProgress(group, 'another-message', 'Cancelled.', abort.signal)).toBe(false)
    expect(request).toHaveBeenCalledTimes(beforeCancel)
  })

  it.each([40, '40'])('uploads all parts with block size %j and shares text/stream sequences', async (blockSize) => {
    const { sender, request, fetchImpl } = imageSender(blockSize)
    const cursor: QQStreamCursor = { index: 0 }
    await sender.sendStream(target, 'incoming', cursor, 'Working', false)
    expect(await sender.sendImage(target, 'incoming', file, 'Caption')).toEqual({ ok: true, messageId: 'image' })
    await sender.sendStream(target, 'incoming', cursor, 'Done', true)
    await sender.sendText(target, 'incoming', 'After')
    const requests = request.mock.calls
    expect(requests.map((call) => call[2].split('/').at(-1))).toEqual([
      'stream_messages',
      'upload_prepare',
      'upload_part_finish',
      'upload_part_finish',
      'files',
      'messages',
      'stream_messages',
      'messages'
    ])
    expect(requests[1]?.[3]).toMatchObject({ file_type: 1, file_name: 'picture.png', file_size: png.length })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(requests[2]?.[3]).toMatchObject({ upload_id: 'upload', part_index: 1, block_size: 40 })
    expect(requests[3]?.[3]).toMatchObject({ part_index: 2, block_size: png.length - 40 })
    expect(requests[5]?.[3]).toEqual({
      msg_type: 7,
      media: { file_info: 'scoped-image' },
      content: 'Caption',
      msg_id: 'incoming',
      msg_seq: 2
    })
    expect(requests[6]?.[3]).toMatchObject({ msg_seq: 1, stream_msg_id: 'stream' })
    expect(requests[7]?.[3]).toMatchObject({ msg_seq: 3 })
  })
  it('publishes nothing when upload fails or is cancelled between parts', async () => {
    for (const cancel of [false, true]) {
      const { sender, request, fetchImpl, abort } = imageSender()
      fetchImpl.mockImplementation(async () => {
        if (cancel) abort.abort()
        return new Response(null, { status: cancel ? 200 : 503 })
      })
      expect(await sender.sendImage(target, 'incoming', file)).toMatchObject({ ok: false, reason: 'platform_error' })
      expect(request.mock.calls.some((call) => call[2].endsWith('/messages'))).toBe(false)
    }
  })
  it.each(['timeout', 'missing-id', 'forbidden'])('does not resend a media post after %s', async (failure) => {
    const { sender, request } = imageSender()
    const original = request.getMockImplementation()!
    request.mockImplementation(async (...args) => {
      if (!args[2].endsWith('/messages')) return original(...args)
      if (failure === 'timeout') throw new Error('timeout')
      if (failure === 'forbidden') throw new ApiError('denied', 403, args[2], 123)
      return {}
    })
    expect(await sender.sendImage(target, 'incoming', file)).toMatchObject({
      ok: false,
      reason: failure === 'forbidden' ? 'forbidden' : 'indeterminate'
    })
    expect(request.mock.calls.filter((call) => call[2].endsWith('/messages'))).toHaveLength(1)
  })
  it('refuses non-images and a missing passive reply before uploading', async () => {
    const { sender, request } = imageSender()
    expect(await sender.sendImage(target, 'incoming', { ...file, bytes: Buffer.from('%PDF document') })).toMatchObject({
      ok: false
    })
    expect(await sender.sendImage(target, '', file)).toMatchObject({ ok: false })
    expect(request).not.toHaveBeenCalled()
  })
})
