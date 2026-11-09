import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { WebchatFileAttachment } from '@agentconnect.md/protocol'
import { ChatUploadReference, decodeChatAttachments, resolveChatUploadUrl } from '../src/session/chat-attachments.js'
import {
  buildAttachmentBlocks,
  transcriptImageAttachments,
  transcriptUploads
} from '../src/session/attachment-block.js'

const file = {
  uploadId: '3f1c2a4e-9b7d-4e21-8c3a-0d5e6f7a8b9c',
  name: 'report.txt',
  mimeType: 'text/plain',
  size: 5,
  sha256: 'A'.repeat(43) + '='
}

describe('shared chat attachments', () => {
  it('keeps mixed upload identifiers and images through model input and transcript replay without a workspace copy', async () => {
    const preview = { name: 'preview.webp', mimeType: 'image/webp' as const, data: 'aGVsbG8=' }
    const image = {
      ...file,
      uploadId: '41bc0e5c-f5b1-4c4c-882c-10905089a779',
      name: 'screenshot.png',
      mimeType: 'image/png',
      preview
    }
    const attachments = decodeChatAttachments('turn', { files: [file, image] })
    const download = vi.fn()
    const blocks = await buildAttachmentBlocks(attachments, {
      download,
      supports: () => true,
      transferUrl: async () => ({ url: 'https://store.example.test/file', expiresAt: 1000 })
    })
    expect(blocks).toContainEqual({ type: 'image', data: preview.data, mimeType: preview.mimeType })
    expect(JSON.stringify(blocks)).toContain(image.uploadId)
    expect(transcriptUploads(attachments)).toEqual([file, { ...image, preview: undefined }])
    expect(transcriptImageAttachments(attachments)).toEqual([{ ...preview, name: image.name }])
    expect(download).not.toHaveBeenCalled()
  })

  it('bounds mixed selections and their combined preview bytes', () => {
    const image = { name: 'image.webp', mimeType: 'image/webp', data: Buffer.alloc(160 * 1024).toString('base64') }
    expect(() =>
      decodeChatAttachments('turn', { images: [image], files: Array.from({ length: 10 }, () => file) })
    ).toThrow()
    expect(() =>
      decodeChatAttachments('turn', { images: [image], files: [{ ...file, preview: { ...image, data: 'aGVsbG8=' } }] })
    ).toThrow()
    const preview = { ...image, data: Buffer.alloc(80 * 1024).toString('base64') }
    expect(
      decodeChatAttachments('turn', {
        files: [
          { ...file, preview },
          { ...file, preview }
        ]
      })
    ).toHaveLength(2)
    expect(() =>
      decodeChatAttachments('turn', { files: Array.from({ length: 3 }, () => ({ ...file, preview })) })
    ).toThrow()
  })
  it('keeps the existing upload shape and normalizes metadata without signing or fetching bytes', () => {
    expectTypeOf<ChatUploadReference>().toEqualTypeOf<WebchatFileAttachment>()
    expect(decodeChatAttachments('turn', { files: [file] })).toEqual([
      {
        id: `webchat:turn:file:${file.uploadId}`,
        name: 'report.txt',
        mimeType: 'text/plain',
        size: 5,
        transfer: { uploadId: file.uploadId, sha256: file.sha256 }
      }
    ])
    const images = decodeChatAttachments('turn', {
      images: [{ name: 'image.png', mimeType: 'image/png', data: 'aGVsbG8=' }]
    })
    expect(images[0]?.inlineData?.toString()).toBe('hello')
    expect(images[0]?.size).toBe(5)
  })

  it.each([
    { ...file, name: '../private' },
    { ...file, sha256: 'unverified' },
    { ...file, size: -1 },
    { ...file, uploadId: 'unknown' },
    { ...file, url: 'http://127.0.0.1/admin' },
    { ...file, agentId: 'another-agent' }
  ])('refuses unsafe or caller-asserted attachment fields: %j', (input) => {
    expect(() => decodeChatAttachments('turn', { files: [input] })).toThrow()
  })

  it('bounds both image and uploaded-file counts before dispatch', () => {
    const files = Array.from({ length: 10 }, () => file)
    expect(decodeChatAttachments('turn', { files })).toHaveLength(10)
    expect(() => decodeChatAttachments('turn', { files: [...files, file] })).toThrow()
    const image = { name: 'a.png', mimeType: 'image/png', data: 'aGVsbG8=' }
    expect(() => decodeChatAttachments('turn', { images: [image, image] })).toThrow()
  })

  it('uses the trusted agent and network for CP verification and leaves durable metadata unchanged', async () => {
    const attachment = decodeChatAttachments('turn', { files: [file] })[0]!
    const before = JSON.stringify(attachment)
    const transferGet = vi.fn(async () => ({ url: 'https://bucket.example/signed', expiresAt: 1000 }))
    expect(
      await resolveChatUploadUrl(attachment, { agentId: 'authorized-agent', network: 'cluster', transferGet })
    ).toEqual({ url: 'https://bucket.example/signed', expiresAt: 1000 })
    expect(transferGet).toHaveBeenCalledWith({
      agentId: 'authorized-agent',
      network: 'cluster',
      uploadId: file.uploadId,
      size: 5,
      sha256: file.sha256
    })
    expect(JSON.stringify(attachment)).toBe(before)
  })

  it('cannot override the agent through an internal attachment or turn a denied upload into a URL fetch', async () => {
    const attachment = decodeChatAttachments('turn', { files: [file] })[0]!
    Object.assign(attachment.transfer!, { agentId: 'foreign-agent', network: 'public', url: 'http://127.0.0.1/admin' })
    const transferGet = vi.fn(async () => ({}))
    const download = vi.fn(async () => Buffer.from('should not fetch'))
    const blocks = await buildAttachmentBlocks([attachment], {
      download,
      supports: () => false,
      transferUrl: (item) =>
        resolveChatUploadUrl(item, { agentId: 'authorized-agent', network: 'cluster', transferGet })
    })
    expect(transferGet).toHaveBeenCalledWith({
      agentId: 'authorized-agent',
      network: 'cluster',
      uploadId: file.uploadId,
      size: 5,
      sha256: file.sha256
    })
    expect(download).not.toHaveBeenCalled()
    expect(blocks).toEqual([
      { type: 'text', text: '[uploaded file: report.txt (text/plain, 5 bytes) — the upload is no longer available]' }
    ])
  })

  it('cannot resolve an upload while its authority is unavailable', async () => {
    const attachment = decodeChatAttachments('turn', { files: [file] })[0]!
    expect(await resolveChatUploadUrl(attachment, { agentId: 'agent', network: 'public' })).toBeUndefined()
    await expect(
      resolveChatUploadUrl(attachment, {
        agentId: 'agent',
        network: 'public',
        transferGet: async () => {
          throw new Error('authority unavailable')
        }
      })
    ).rejects.toThrow('authority unavailable')
  })
})
