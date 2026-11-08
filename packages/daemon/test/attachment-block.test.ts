import { PNG } from 'pngjs'
import { describe, it, expect, vi } from 'vitest'
import { TRANSCRIPT_IMAGE_MAX_COUNT, WEBCHAT_IMAGE_MAX_BYTES } from '@agentconnect.md/protocol'
import {
  attachmentToBlock,
  buildAttachmentBlocks,
  attachmentMention,
  fitTranscriptImage,
  hydrateTranscriptImages,
  sniffImageMimeType,
  transcriptImageAttachments
} from '../src/session/attachment-block.js'
import { resetPreviewPool } from '../src/images/index.js'
import { feishuEventToMessageLike, normalizeFeishuMessage } from '../src/feishu/normalize.js'
import type { Attachment } from '../src/messages/normalized.js'

const att = (over: Partial<Attachment> = {}): Attachment => ({
  id: 'F1',
  name: 'a.png',
  mimeType: 'image/png',
  sourceUrl: 'https://files/F1',
  ...over
})

const supportsAll = () => true
const supportsNone = () => false

describe('attachmentToBlock', () => {
  it('builds a self-contained inline image block when the agent supports images', () => {
    const bytes = Buffer.from('IMG')
    expect(attachmentToBlock(att(), bytes, supportsAll)).toEqual({
      type: 'image',
      data: bytes.toString('base64'),
      mimeType: 'image/png'
    })
  })

  it('builds a text resource for text/* when embeddedContext is supported', () => {
    const bytes = Buffer.from('hello world')
    expect(
      attachmentToBlock(att({ mimeType: 'text/plain', name: 't.txt' }), bytes, (k) => k === 'embeddedContext')
    ).toEqual({
      type: 'resource',
      resource: { text: 'hello world', uri: 'https://files/F1', mimeType: 'text/plain' }
    })
  })

  it('builds a blob resource for binary when embeddedContext is supported', () => {
    const bytes = Buffer.from([1, 2, 3])
    expect(
      attachmentToBlock(att({ mimeType: 'application/pdf', name: 'd.pdf' }), bytes, (k) => k === 'embeddedContext')
    ).toEqual({
      type: 'resource',
      resource: { blob: bytes.toString('base64'), uri: 'https://files/F1', mimeType: 'application/pdf' }
    })
  })

  it('degrades to a resource_link (with a readSlackFile hint) when the agent lacks the capability', () => {
    const block = attachmentToBlock(att({ size: 42 }), Buffer.from('IMG'), supportsNone) as Record<string, unknown>
    expect(block).toMatchObject({
      type: 'resource_link',
      name: 'a.png',
      uri: 'https://files/F1',
      mimeType: 'image/png',
      size: 42
    })
    expect(String(block.description)).toContain('readSlackFile')
  })

  it('degrades to a resource_link when bytes are null (download failed)', () => {
    expect(attachmentToBlock(att(), null, supportsAll)).toMatchObject({
      type: 'resource_link',
      uri: 'https://files/F1'
    })
  })

  it('points provider-backed files at the platform attachment reader', () => {
    const block = attachmentToBlock(
      att({ name: 'invoice.pdf', mimeType: 'application/pdf', readerToolName: 'readQQFile' }),
      null,
      supportsAll
    ) as Record<string, unknown>
    expect(block).toMatchObject({ type: 'resource_link', name: 'invoice.pdf' })
    expect(String(block.description)).toContain('readQQFile')
  })
})

describe('buildAttachmentBlocks', () => {
  it('never downloads a file whose known size exceeds the cap (→ resource_link)', async () => {
    const download = vi.fn(async () => Buffer.from('SHOULD NOT HAPPEN'))
    const blocks = await buildAttachmentBlocks([att({ size: 50_000_000 })], {
      download,
      supports: supportsAll,
      maxBytes: 8 * 1024 * 1024
    })
    expect(download).not.toHaveBeenCalled()
    expect(blocks[0]).toMatchObject({ type: 'resource_link' })
  })

  it('downloads and inlines a file under the cap', async () => {
    const bytes = Buffer.from('IMG')
    const download = vi.fn(async () => bytes)
    const blocks = await buildAttachmentBlocks([att({ size: 3 })], { download, supports: supportsAll, maxBytes: 1024 })
    expect(download).toHaveBeenCalledOnce()
    expect(blocks[0]).toMatchObject({ type: 'image', data: bytes.toString('base64') })
  })

  it('leaves a tool-readable binary as a resource link for workspace materialization', async () => {
    const download = vi.fn(async () => Buffer.from('SHOULD NOT HAPPEN'))
    const blocks = await buildAttachmentBlocks(
      [att({ name: 'invoice.pdf', mimeType: 'application/pdf', readerToolName: 'readQQFile' })],
      { download, supports: supportsAll }
    )
    expect(download).not.toHaveBeenCalled()
    expect(blocks[0]).toMatchObject({ type: 'resource_link', name: 'invoice.pdf' })
  })

  it('uses inline webchat bytes without calling a platform downloader', async () => {
    const bytes = Buffer.from('IMG')
    const download = vi.fn(async () => null)
    const blocks = await buildAttachmentBlocks([att({ sourceUrl: undefined, inlineData: bytes, size: bytes.length })], {
      download,
      supports: supportsAll,
      maxBytes: 1024
    })
    expect(download).not.toHaveBeenCalled()
    expect(blocks[0]).toEqual({ type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' })
  })

  it('degrades to resource_link (not dropped) when a download throws', async () => {
    const blocks = await buildAttachmentBlocks([att()], {
      download: async () => {
        throw new Error('network')
      },
      supports: supportsAll
    })
    expect(blocks[0]).toMatchObject({ type: 'resource_link' })
  })
})

describe('uploaded-file attachments', () => {
  const upload: Attachment = {
    id: 'webchat:t:file:u',
    name: "it's.pdf",
    mimeType: 'application/pdf',
    size: 12,
    transfer: { uploadId: 'u', sha256: 's' }
  }

  it('hands the agent a download command for the presigned link and never downloads the bytes itself', async () => {
    const download = vi.fn(async () => Buffer.from('x'))
    const [block] = await buildAttachmentBlocks([upload], {
      download,
      supports: () => true,
      transferUrl: async () => ({
        url: 'https://store.example.test/k?X-Amz-Signature=s',
        expiresAt: Date.UTC(2026, 9, 9)
      })
    })
    expect(download).not.toHaveBeenCalled()
    expect(block).toMatchObject({ type: 'text' })
    const text = (block as { text: string }).text
    expect(text).toContain("[uploaded file: it's.pdf (application/pdf, 12 bytes); uploadId=u]")
    expect(text).toContain(`curl -fsSL -o 'uploads/it'\\''s.pdf' 'https://store.example.test/k?X-Amz-Signature=s'`)
    expect(text).toContain('2026-10-09T00:00:00.000Z')
  })

  it('says the upload is gone when no link can be issued', async () => {
    const [block] = await buildAttachmentBlocks([upload], {
      download: async () => null,
      supports: () => true,
      transferUrl: async () => {
        throw new Error('store down')
      }
    })
    expect((block as { text: string }).text).toContain('the upload is no longer available')
  })
})

describe('hydrateTranscriptImages', () => {
  it('fetches a platform image once and memoizes it for the prompt blocks', async () => {
    const bytes = Buffer.from('IMG')
    const download = vi.fn(async () => bytes)
    const attachments = [att({ size: bytes.length })]
    await hydrateTranscriptImages(attachments, { download })
    expect(transcriptImageAttachments(attachments)).toEqual([
      { name: 'a.png', mimeType: 'image/png', data: bytes.toString('base64') }
    ])
    // The prompt build reuses the memoized bytes rather than downloading again.
    await buildAttachmentBlocks(attachments, { download, supports: supportsAll })
    expect(download).toHaveBeenCalledOnce()
  })

  it('carries a raw Feishu image event (no provider MIME) through to the transcript', async () => {
    // Feishu's im.message.receive_v1 image event has only an image_key, so
    // normalization types it application/octet-stream — the bytes are what settle it.
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('pixels')])
    const msg = normalizeFeishuMessage(
      feishuEventToMessageLike({
        sender: { sender_id: { open_id: 'ou_1', union_id: 'on_1' }, sender_type: 'user' },
        message: {
          message_id: 'om_1',
          chat_id: 'oc_1',
          chat_type: 'p2p',
          message_type: 'image',
          content: JSON.stringify({ image_key: 'img_v3_abc' })
        }
      }),
      { traceId: 't1' }
    )
    const attachments = msg.attachments as Attachment[]
    expect(attachments[0]).toMatchObject({ mimeType: 'application/octet-stream', sourceUrl: 'om_1:image:img_v3_abc' })

    const download = vi.fn(async () => png)
    await hydrateTranscriptImages(attachments, { download })
    expect(transcriptImageAttachments(attachments)).toEqual([
      { name: 'img_v3_abc', mimeType: 'image/png', data: png.toString('base64') }
    ])
    // The corrected type also unlocks the inline ACP image block (it was a
    // resource_link while the attachment claimed application/octet-stream).
    const blocks = await buildAttachmentBlocks(attachments, { download, supports: supportsAll })
    expect(blocks[0]).toEqual({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' })
    expect(download).toHaveBeenCalledOnce()
  })

  it('skips a declared non-image and a file over the caller’s cap', async () => {
    const download = vi.fn(async () => Buffer.from('IMG'))
    const big = [att({ size: 9_000 })]
    await hydrateTranscriptImages(big, { download, maxBytes: 8_000 })
    expect(download).not.toHaveBeenCalled() // known size over the cap ⇒ never fetched
    const doc = [att({ name: 'd.pdf', mimeType: 'application/pdf' })]
    await hydrateTranscriptImages(doc, { download })
    expect(download).not.toHaveBeenCalled()
  })

  it('memoizes an image too big for the transcript, so the prompt still fetches once', async () => {
    // No reported size (Feishu never reports one), bytes over the transcript ceiling:
    // the schema drops it from the transcript, but the download must not repeat.
    const download = vi.fn(async () => Buffer.alloc(WEBCHAT_IMAGE_MAX_BYTES + 1))
    const attachments = [att()]
    await hydrateTranscriptImages(attachments, { download })
    expect(transcriptImageAttachments(attachments)).toEqual([])
    await buildAttachmentBlocks(attachments, { download, supports: supportsAll })
    expect(download).toHaveBeenCalledOnce()
  })

  it('fetches a separate thumbnail for the transcript when the full image is too big, without touching the prompt bytes', async () => {
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(WEBCHAT_IMAGE_MAX_BYTES)])
    const jpegThumb = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('thumb')])
    const download = vi.fn(async (a: Attachment) => (a.sourceUrl === 'https://files/thumb' ? jpegThumb : png))
    const attachments = [att({ thumbnailUrl: 'https://files/thumb' })]
    await hydrateTranscriptImages(attachments, { download })
    expect(download).toHaveBeenCalledTimes(2)
    expect(transcriptImageAttachments(attachments)).toEqual([
      { name: 'a.png', mimeType: 'image/jpeg', data: jpegThumb.toString('base64') }
    ])
    // The prompt block still gets the full-resolution bytes, never the thumbnail.
    const blocks = await buildAttachmentBlocks(attachments, { download, supports: supportsAll })
    expect(blocks[0]).toMatchObject({ type: 'image', data: png.toString('base64') })
  })

  it('fetches a transcript thumbnail after a Decision has already loaded full image bytes', async () => {
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(WEBCHAT_IMAGE_MAX_BYTES)])
    const jpegThumb = Buffer.from([0xff, 0xd8, 0xff, 0x00])
    const download = vi.fn(async () => jpegThumb)
    const attachments = [att({ inlineData: png, thumbnailUrl: 'https://files/thumb' })]
    await hydrateTranscriptImages(attachments, { download })
    expect(download).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sourceUrl: 'https://files/thumb' }))
    expect(attachments[0]!.inlineData).toBe(png)
    expect(transcriptImageAttachments(attachments)).toEqual([
      { name: 'a.png', mimeType: 'image/jpeg', data: jpegThumb.toString('base64') }
    ])
  })

  it('skips the thumbnail fetch when the full image already fits the transcript budget', async () => {
    const download = vi.fn(async () => Buffer.from('IMG'))
    const attachments = [att({ thumbnailUrl: 'https://files/thumb' })]
    await hydrateTranscriptImages(attachments, { download })
    expect(download).toHaveBeenCalledOnce()
  })

  it('keeps several images on one row, each fetched once', async () => {
    const download = vi.fn(async (a: Attachment) => Buffer.from(a.id))
    const attachments = [att({ id: 'F1' }), att({ id: 'F2', name: 'b.png' })]
    await hydrateTranscriptImages(attachments, { download })
    expect(transcriptImageAttachments(attachments)).toEqual([
      { name: 'a.png', mimeType: 'image/png', data: Buffer.from('F1').toString('base64') },
      { name: 'b.png', mimeType: 'image/png', data: Buffer.from('F2').toString('base64') }
    ])
    await buildAttachmentBlocks(attachments, { download, supports: supportsAll })
    expect(download).toHaveBeenCalledTimes(2)
  })

  it('swaps in a thumbnail for an image over its equal share of the row budget', async () => {
    const share = WEBCHAT_IMAGE_MAX_BYTES / 2
    const big = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(share)])
    const small = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(share - 64)])
    const thumb = Buffer.from([0xff, 0xd8, 0xff, 0x00])
    const download = vi.fn(async (a: Attachment) =>
      a.sourceUrl === 'https://files/thumb' ? thumb : a.id === 'F1' ? big : small
    )
    const attachments = [
      att({ id: 'F1', thumbnailUrl: 'https://files/thumb' }),
      att({ id: 'F2', name: 'b.png', thumbnailUrl: 'https://files/thumb-b' })
    ]
    await hydrateTranscriptImages(attachments, { download })
    // Only the image over its share pays for a thumbnail fetch.
    expect(download).toHaveBeenCalledTimes(3)
    expect(attachments[0]!.inlineData).toBe(big)
    expect(transcriptImageAttachments(attachments)).toEqual([
      { name: 'a.png', mimeType: 'image/jpeg', data: thumb.toString('base64') },
      { name: 'b.png', mimeType: 'image/png', data: small.toString('base64') }
    ])
  })

  it('rolls an unused share forward and never exceeds one image’s budget in total', () => {
    const png = (bytes: number) => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(bytes - 8)])
    const tiny = att({ id: 'F1', inlineData: png(1_024) })
    const large = att({ id: 'F2', name: 'b.png', inlineData: png(140 * 1024) })
    const kept = transcriptImageAttachments([tiny, large])
    // An even split would cap the large image at 80 KiB; the tiny one leaves it the rest.
    expect(kept.map((image) => image.name)).toEqual(['a.png', 'b.png'])
    const total = kept.reduce((sum, image) => sum + Buffer.from(image.data, 'base64').byteLength, 0)
    expect(total).toBeLessThanOrEqual(WEBCHAT_IMAGE_MAX_BYTES)
  })

  it('re-encodes an image whose thumbnail is still over its share, so every image of a Slack post fits', async () => {
    // Slack keeps a PNG screenshot's thumb_360 as PNG, often ~150 KB: over the 80 KiB share of a two-image row.
    const header = Buffer.from('89504e470d0a1a0a', 'hex')
    const full = Buffer.concat([header, Buffer.alloc(400 * 1024)])
    const thumb = Buffer.concat([header, Buffer.alloc(146 * 1024)])
    const fitted = (id: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(id)])
    const download = vi.fn(async (a: Attachment) => (a.sourceUrl?.startsWith('https://files/thumb') ? thumb : full))
    const fit = vi.fn(async (bytes: Buffer, name: string, maxBytes: number) => {
      expect(bytes).toBe(full) // the full-resolution source, not the thumbnail
      expect(maxBytes).toBe(Math.floor(WEBCHAT_IMAGE_MAX_BYTES / 2))
      return { data: fitted(name), mimeType: 'image/jpeg' as const }
    })
    const attachments = [
      att({ id: 'F1', name: 'image.png', thumbnailUrl: 'https://files/thumb-1' }),
      att({ id: 'F2', name: 'image.png', thumbnailUrl: 'https://files/thumb-2' })
    ]
    await hydrateTranscriptImages(attachments, { download, fit })
    expect(fit).toHaveBeenCalledTimes(2)
    expect(transcriptImageAttachments(attachments)).toEqual([
      { name: 'image.png', mimeType: 'image/jpeg', data: fitted('image.png').toString('base64') },
      { name: 'image.png', mimeType: 'image/jpeg', data: fitted('image.png').toString('base64') }
    ])
    // The prompt still gets the original bytes.
    const blocks = await buildAttachmentBlocks(attachments, { download, supports: supportsAll })
    expect(blocks[0]).toMatchObject({ type: 'image', data: full.toString('base64') })
  })

  it('leaves an image that already fits its share alone, and keeps the label when re-encoding fails', async () => {
    const header = Buffer.from('89504e470d0a1a0a', 'hex')
    const small = Buffer.concat([header, Buffer.from('small')])
    const big = Buffer.concat([header, Buffer.alloc(WEBCHAT_IMAGE_MAX_BYTES)])
    const fit = vi.fn(async () => null)
    const attachments = [att({ id: 'F1', inlineData: small }), att({ id: 'F2', name: 'b.png', inlineData: big })]
    await hydrateTranscriptImages(attachments, { download: vi.fn(), fit })
    expect(fit).toHaveBeenCalledExactlyOnceWith(big, 'b.png', Math.floor(WEBCHAT_IMAGE_MAX_BYTES / 2))
    expect(transcriptImageAttachments(attachments).map((image) => image.name)).toEqual(['a.png'])
  })

  it('fitTranscriptImage shrinks a real screenshot-sized PNG under the share', async () => {
    const width = 900
    const height = 700
    const img = new PNG({ width, height })
    let seed = 7
    for (let i = 0; i < width * height * 4; i++) {
      seed = (seed * 1103515245 + 12345) >>> 0
      img.data[i] = i % 4 === 3 ? 255 : seed & 0xff
    }
    const bytes = PNG.sync.write(img)
    const share = Math.floor(WEBCHAT_IMAGE_MAX_BYTES / 2)
    expect(bytes.byteLength).toBeGreaterThan(share)
    const fitted = await fitTranscriptImage(bytes, 'image.png', share)
    expect(fitted).not.toBeNull()
    expect(fitted!.data.byteLength).toBeLessThanOrEqual(share)
    expect(sniffImageMimeType(fitted!.data)).toBe(fitted!.mimeType)
    await resetPreviewPool()
  })

  it('keeps at most TRANSCRIPT_IMAGE_MAX_COUNT images', async () => {
    const download = vi.fn(async (a: Attachment) => Buffer.from(a.id))
    const attachments = Array.from({ length: TRANSCRIPT_IMAGE_MAX_COUNT + 2 }, (_, i) =>
      att({ id: `F${i}`, name: `${i}.png` })
    )
    await hydrateTranscriptImages(attachments, { download })
    expect(download).toHaveBeenCalledTimes(TRANSCRIPT_IMAGE_MAX_COUNT)
    expect(transcriptImageAttachments(attachments)).toHaveLength(TRANSCRIPT_IMAGE_MAX_COUNT)
  })

  it('survives a failed download', async () => {
    const attachments = [att()]
    await hydrateTranscriptImages(attachments, {
      download: async () => {
        throw new Error('network')
      }
    })
    expect(transcriptImageAttachments(attachments)).toEqual([])
  })
})

describe('attachmentMention', () => {
  it('summarizes attachments and is empty when there are none', () => {
    expect(attachmentMention(undefined)).toBe('')
    expect(attachmentMention([])).toBe('')
    expect(attachmentMention([att(), att({ name: 'b.pdf', mimeType: 'application/pdf' })])).toBe(
      '[attached: a.png (image/png), b.pdf (application/pdf)]'
    )
  })
})
