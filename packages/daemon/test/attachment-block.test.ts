import { describe, it, expect, vi } from 'vitest'
import { WEBCHAT_IMAGE_MAX_BYTES } from '@agentconnect.md/protocol'
import {
  attachmentToBlock,
  buildAttachmentBlocks,
  attachmentMention,
  hydrateTranscriptImage,
  transcriptImageAttachments
} from '../src/session/attachment-block.js'
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

describe('hydrateTranscriptImage', () => {
  it('fetches a platform image once and memoizes it for the prompt blocks', async () => {
    const bytes = Buffer.from('IMG')
    const download = vi.fn(async () => bytes)
    const attachments = [att({ size: bytes.length })]
    await hydrateTranscriptImage(attachments, { download })
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
        sender: { sender_id: { open_id: 'ou_1' }, sender_type: 'user' },
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
    await hydrateTranscriptImage(attachments, { download })
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
    await hydrateTranscriptImage(big, { download, maxBytes: 8_000 })
    expect(download).not.toHaveBeenCalled() // known size over the cap ⇒ never fetched
    const doc = [att({ name: 'd.pdf', mimeType: 'application/pdf' })]
    await hydrateTranscriptImage(doc, { download })
    expect(download).not.toHaveBeenCalled()
  })

  it('memoizes an image too big for the transcript, so the prompt still fetches once', async () => {
    // No reported size (Feishu never reports one), bytes over the transcript ceiling:
    // the schema drops it from the transcript, but the download must not repeat.
    const download = vi.fn(async () => Buffer.alloc(WEBCHAT_IMAGE_MAX_BYTES + 1))
    const attachments = [att()]
    await hydrateTranscriptImage(attachments, { download })
    expect(transcriptImageAttachments(attachments)).toEqual([])
    await buildAttachmentBlocks(attachments, { download, supports: supportsAll })
    expect(download).toHaveBeenCalledOnce()
  })

  it('survives a failed download', async () => {
    const attachments = [att()]
    await hydrateTranscriptImage(attachments, {
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
