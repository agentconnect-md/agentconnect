import { describe, it, expect, vi } from 'vitest'
import { attachmentToBlock, buildAttachmentBlocks, attachmentMention } from '../src/session/attachment-block.js'
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

describe('attachmentMention', () => {
  it('summarizes attachments and is empty when there are none', () => {
    expect(attachmentMention(undefined)).toBe('')
    expect(attachmentMention([])).toBe('')
    expect(attachmentMention([att(), att({ name: 'b.pdf', mimeType: 'application/pdf' })])).toBe(
      '[attached: a.png (image/png), b.pdf (application/pdf)]'
    )
  })
})
