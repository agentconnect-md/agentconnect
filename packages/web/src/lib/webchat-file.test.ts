import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TransferFileName, TransferMimeType } from '@agentconnect.md/protocol'

const reserve = vi.hoisted(() => vi.fn())
const signParts = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', () => ({ reserveFileUpload: reserve, signFileUploadParts: signParts }))

import {
  compositeSha256,
  fileSha256,
  filesMarker,
  splitFilesMarker,
  transferFileName,
  transferMimeType,
  uploadPartBytes,
  uploadWebchatFile
} from './webchat-file'

afterEach(() => {
  reserve.mockReset()
  signParts.mockReset()
})

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

  it('splits the marker back into the caption and its files', () => {
    const files = [
      { name: 'run me, (v2).sh', mimeType: 'text/x-sh' },
      { name: 'b.zip', mimeType: 'application/zip' }
    ]
    expect(splitFilesMarker(`hello\nworld\n${filesMarker(files)}`)).toEqual({ text: 'hello\nworld', files })
    expect(splitFilesMarker(filesMarker(files))).toEqual({ text: '', files })
  })

  it('leaves text without a well-formed trailing marker alone', () => {
    for (const text of ['plain', '[attached: a.pdf (application/pdf)] then more', 'x\n[attached: nope]']) {
      expect(splitFilesMarker(text)).toEqual({ text, files: [] })
    }
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
    const attachment = await uploadWebchatFile('agent-1', file, { put: put as unknown as typeof fetch })

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
      uploadWebchatFile('agent-1', new File([bytes], 'a.bin'), { put: put as unknown as typeof fetch })
    ).rejects.toThrow('HTTP 403')
  })
})

describe('uploadWebchatFile in parts', () => {
  const MIB = 1024 * 1024
  const UPLOAD_ID = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b'
  const bytes = new TextEncoder().encode('0123456789ab')
  const digest = (part: Uint8Array) => createHash('sha256').update(part).digest('base64')
  const digests = [bytes.slice(0, 5), bytes.slice(5, 10), bytes.slice(10)].map(digest)
  const later = new Date(Date.now() + 15 * 60_000).toISOString()
  const part = (partNumber: number) => ({
    partNumber,
    url: `https://store.example.test/k?partNumber=${partNumber}&uploadId=mp-1&sig=${partNumber}`,
    headers: { 'content-length': '5', 'x-amz-checksum-sha256': digests[partNumber - 1]! }
  })
  const complete = { url: 'https://store.example.test/k?uploadId=mp-1', headers: {} }

  function store(opts: { refuseOnce?: number; assembled?: string } = {}) {
    const refused = new Set<number>()
    return vi.fn(async (url: string, init: RequestInit) => {
      if (init.method === 'POST')
        return new Response(opts.assembled ?? '<CompleteMultipartUploadResult/>', { status: 200 })
      const n = Number(new URL(url).searchParams.get('partNumber'))
      if (n === opts.refuseOnce && !refused.has(n)) {
        refused.add(n)
        return new Response('expired', { status: 403 })
      }
      return new Response(null, { status: 200, headers: { etag: `"e${n}"` } })
    })
  }

  it('cuts a file into parts only above the browser’s part size, and never into more than 10,000', () => {
    expect(uploadPartBytes(100 * MIB, undefined)).toBeUndefined()
    expect(uploadPartBytes(64 * MIB, 512 * MIB)).toBeUndefined()
    expect(uploadPartBytes(65 * MIB, 512 * MIB)).toBe(64 * MIB)
    expect(uploadPartBytes(65 * MIB, 8 * MIB)).toBe(8 * MIB)
    expect(uploadPartBytes(1024 * 1024 * MIB, 512 * MIB)).toBe(Math.ceil((1024 * 1024 * MIB) / 10_000))
  })

  it('reserves with each part’s digest and their composite, PUTs every part, then assembles them', async () => {
    reserve.mockResolvedValue({
      uploadId: UPLOAD_ID,
      expiresAt: later,
      multipart: { multipartId: 'mp-1', parts: [part(1), part(2)], complete }
    })
    signParts.mockResolvedValue({ parts: [part(3)], complete, expiresAt: later })
    const put = store()
    const file = new File([bytes], 'big.bin', { type: 'application/octet-stream' })
    const attachment = await uploadWebchatFile('agent-1', file, { put: put as unknown as typeof fetch, partBytes: 5 })

    const sha256 = createHash('sha256')
      .update(Buffer.concat(digests.map((d) => Buffer.from(d, 'base64'))))
      .digest('base64')
    expect(await compositeSha256(digests)).toBe(sha256)
    expect(reserve).toHaveBeenCalledWith('agent-1', {
      name: 'big.bin',
      mimeType: 'application/octet-stream',
      size: 12,
      sha256,
      parts: { partBytes: 5, sha256: digests }
    })
    expect(signParts).toHaveBeenCalledWith('agent-1', UPLOAD_ID, {
      multipartId: 'mp-1',
      size: 12,
      partBytes: 5,
      parts: [{ partNumber: 3, sha256: digests[2] }]
    })
    const puts = put.mock.calls.filter(([, init]) => init.method === 'PUT')
    expect(puts.map(([, init]) => (init.body as Blob).size)).toEqual([5, 5, 2])
    expect(puts[0]![1].headers).toEqual({ 'x-amz-checksum-sha256': digests[0] })
    const [, assemble] = put.mock.calls.find(([, init]) => init.method === 'POST')!
    expect(assemble.headers).toEqual({ 'content-type': 'application/xml' })
    expect(assemble.body).toBe(
      `<CompleteMultipartUpload>${digests.map((d, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>"e${i + 1}"</ETag><ChecksumSHA256>${d}</ChecksumSHA256></Part>`).join('')}</CompleteMultipartUpload>`
    )
    expect(attachment).toEqual({
      uploadId: UPLOAD_ID,
      name: 'big.bin',
      mimeType: 'application/octet-stream',
      size: 12,
      sha256
    })
  })

  it('signs a refused part again and retries it', async () => {
    reserve.mockResolvedValue({
      uploadId: UPLOAD_ID,
      expiresAt: later,
      multipart: { multipartId: 'mp-1', parts: [part(1), part(2), part(3)], complete }
    })
    signParts.mockImplementation(async (_agent, _upload, body: { parts: Array<{ partNumber: number }> }) => ({
      parts: body.parts.map((p) => part(p.partNumber)),
      complete,
      expiresAt: later
    }))
    const put = store({ refuseOnce: 2 })
    const file = new File([bytes], 'big.bin')
    await uploadWebchatFile('agent-1', file, { put: put as unknown as typeof fetch, partBytes: 5 })
    expect(signParts.mock.calls.map(([, , body]) => body.parts[0].partNumber)).toEqual([2])
    expect(put.mock.calls.filter(([url]) => url.includes('partNumber=2'))).toHaveLength(2)
  })

  it('fails when the store answers the assembly with an error', async () => {
    reserve.mockResolvedValue({
      uploadId: UPLOAD_ID,
      expiresAt: later,
      multipart: { multipartId: 'mp-1', parts: [part(1), part(2), part(3)], complete }
    })
    const put = store({ assembled: '<Error><Code>InvalidPart</Code></Error>' })
    await expect(
      uploadWebchatFile('agent-1', new File([bytes], 'big.bin'), { put: put as unknown as typeof fetch, partBytes: 5 })
    ).rejects.toThrow('refused to assemble')
  })
})
