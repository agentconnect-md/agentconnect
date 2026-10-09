import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TransferFileName, TransferMimeType } from '@agentconnect.md/protocol'

const reserve = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', () => ({ reserveFileUpload: reserve }))

import { fileSha256, filesMarker, transferFileName, transferMimeType, uploadWebchatFile } from './webchat-file'

afterEach(() => reserve.mockReset())

describe('webchat file names and types', () => {
  it('sanitizes a name into one the protocol accepts', () => {
    for (const raw of ['report.pdf', '../etc/passwd', 'a\\b\u0007c', '   ', 'x'.repeat(400)]) {
      const name = transferFileName(raw)
      expect(TransferFileName.safeParse(name).success, raw).toBe(true)
    }
    expect(transferFileName('../etc/passwd')).toBe('.._etc_passwd')
    expect(transferFileName('   ')).toBe('file')
  })

  it('keeps a well-formed MIME type and falls back to octet-stream', () => {
    expect(transferMimeType('application/pdf')).toBe('application/pdf')
    expect(transferMimeType('')).toBe('application/octet-stream')
    expect(transferMimeType('text/plain; charset=utf-8')).toBe('application/octet-stream')
    expect(TransferMimeType.safeParse(transferMimeType('weird')).success).toBe(true)
  })

  it('renders the daemon’s attachment marker', () => {
    expect(
      filesMarker([
        { name: 'a.pdf', mimeType: 'application/pdf' },
        { name: 'b.zip', mimeType: 'application/zip' }
      ])
    ).toBe('[attached: a.pdf (application/pdf), b.zip (application/zip)]')
    expect(filesMarker([])).toBe('')
  })
})

describe('uploadWebchatFile', () => {
  const bytes = new TextEncoder().encode('hello, store')
  const sha256 = createHash('sha256').update(bytes).digest('base64')

  it('hashes like S3’s checksum header', async () => {
    expect(await fileSha256(new Blob([bytes]))).toBe(sha256)
  })

  it('reserves with the digest, then PUTs the file with every signed header but content-length', async () => {
    reserve.mockResolvedValue({
      uploadId: '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b',
      url: 'https://store.example.test/bucket/key?X-Amz-Signature=sig',
      headers: {
        'content-length': String(bytes.length),
        'x-amz-checksum-sha256': sha256,
        'x-amz-tagging': 'ac-cache=pending'
      },
      expiresAt: '2026-10-09T12:00:00.000Z'
    })
    const put = vi.fn(async () => new Response(null, { status: 200 }))
    const file = new File([bytes], 'notes.txt', { type: 'text/plain' })
    const attachment = await uploadWebchatFile('agent-1', file, put as unknown as typeof fetch)

    expect(reserve).toHaveBeenCalledWith('agent-1', {
      name: 'notes.txt',
      mimeType: 'text/plain',
      size: bytes.length,
      sha256
    })
    expect(put).toHaveBeenCalledWith('https://store.example.test/bucket/key?X-Amz-Signature=sig', {
      method: 'PUT',
      headers: { 'x-amz-checksum-sha256': sha256, 'x-amz-tagging': 'ac-cache=pending' },
      body: file
    })
    expect(attachment).toEqual({
      uploadId: '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b',
      name: 'notes.txt',
      mimeType: 'text/plain',
      size: bytes.length,
      sha256
    })
  })

  it('fails when the store refuses the PUT', async () => {
    reserve.mockResolvedValue({ uploadId: 'u', url: 'https://store.example.test/k', headers: {}, expiresAt: '' })
    const put = vi.fn(async () => new Response('denied', { status: 403 }))
    await expect(
      uploadWebchatFile('agent-1', new File([bytes], 'a.bin'), put as unknown as typeof fetch)
    ).rejects.toThrow('HTTP 403')
  })
})
