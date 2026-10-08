import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { WorkspaceReadContent } from '@agentconnect.md/protocol'
import { ProtocolError } from '../domain/errors.js'
import {
  assembleWorkspaceFile,
  attachmentDisposition,
  downloadContentType,
  sessionFileDownloadable,
  sha256Matches,
  WorkspaceDownloadRefusal
} from './workspace-download.js'

const MTIME = '2026-09-30T00:00:00.000Z'

/** A daemon answering byte reads of one file in `chunk`-byte slices. */
function daemonServing(file: Buffer | undefined, chunk = 4, mtimeAt: (offset: number) => string = () => MTIME) {
  const offsets: number[] = []
  const read = async (offset: number): Promise<WorkspaceReadContent> => {
    offsets.push(offset)
    if (!file) return { agentId: 'a', path: 'uploads/x', exists: false }
    const slice = file.subarray(offset, offset + chunk)
    const nextOffset = offset + slice.byteLength
    return {
      agentId: 'a',
      path: 'uploads/x',
      exists: true,
      type: 'file',
      size: file.byteLength,
      mtime: mtimeAt(offset),
      encoding: 'base64',
      content: slice.toString('base64'),
      offset,
      nextOffset,
      truncated: nextOffset < file.byteLength
    }
  }
  return { read, offsets }
}

describe('sessionFileDownloadable', () => {
  it('admits an upload, and any other file only with the digest its share recorded', () => {
    expect(sessionFileDownloadable('uploads/spec.pdf', undefined)).toBe(true)
    expect(sessionFileDownloadable('uploads/nested/log.txt', undefined)).toBe(true)
    expect(sessionFileDownloadable('out/chart.png', undefined)).toBe(false)
    expect(sessionFileDownloadable('out/chart.png', '1a2b3c4d5e6f7a8b')).toBe(true)
  })

  it('refuses any path whose shape could leave the directory it names', () => {
    for (const path of ['uploads', 'uploads/', '/uploads/x', 'uploads/../agent.json', 'uploads/./x', 'uploads\\x']) {
      expect(sessionFileDownloadable(path, undefined), path).toBe(false)
    }
    expect(sessionFileDownloadable('out/../../etc/passwd', '1a2b3c4d5e6f7a8b')).toBe(false)
  })
})

describe('assembleWorkspaceFile', () => {
  it('joins slices from the offsets the daemon names', async () => {
    const file = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    const daemon = daemonServing(file)
    await expect(assembleWorkspaceFile(daemon.read)).resolves.toEqual(file)
    expect(daemon.offsets).toEqual([0, 4, 8])
  })

  it('answers an empty file after one read', async () => {
    const daemon = daemonServing(Buffer.alloc(0))
    await expect(assembleWorkspaceFile(daemon.read)).resolves.toEqual(Buffer.alloc(0))
    expect(daemon.offsets).toEqual([0])
  })

  it('refuses a missing file, and an oversized one before reading past its first slice', async () => {
    await expect(assembleWorkspaceFile(daemonServing(undefined).read)).rejects.toMatchObject({
      status: 404,
      code: 'WORKSPACE_FILE_NOT_FOUND'
    })
    const daemon = daemonServing(Buffer.alloc(20))
    await expect(assembleWorkspaceFile(daemon.read, 16)).rejects.toMatchObject({
      status: 413,
      code: 'WORKSPACE_FILE_TOO_LARGE'
    })
    expect(daemon.offsets).toEqual([0])
  })

  it('refuses a file that changes or vanishes between slices', async () => {
    const changed = daemonServing(Buffer.alloc(10), 4, (offset) => (offset === 0 ? MTIME : '2026-09-30T00:00:01.000Z'))
    await expect(assembleWorkspaceFile(changed.read)).rejects.toMatchObject({
      status: 409,
      code: 'WORKSPACE_FILE_CHANGED'
    })

    const whole = daemonServing(Buffer.alloc(10))
    const vanishing = async (offset: number) =>
      offset === 0 ? whole.read(offset) : { agentId: 'a', path: 'uploads/x', exists: false }
    await expect(assembleWorkspaceFile(vanishing)).rejects.toBeInstanceOf(WorkspaceDownloadRefusal)
  })

  it('refuses a slice that is not the file’s bytes at the requested offset', async () => {
    const file = Buffer.alloc(10, 7)
    const good = daemonServing(file)
    const variants: Array<(slice: WorkspaceReadContent) => WorkspaceReadContent> = [
      (slice) => ({ ...slice, encoding: 'utf8' }), // an older reader answering text
      (slice) => ({ ...slice, offset: 1 }),
      (slice) => ({ ...slice, nextOffset: (slice.nextOffset ?? 0) + 1 }),
      (slice) => ({ ...slice, content: 'AAAA====' }), // not canonical base64
      (slice) => ({ ...slice, content: '', nextOffset: 0 }) // no progress
    ]
    for (const variant of variants) {
      await expect(assembleWorkspaceFile(async (offset) => variant(await good.read(offset)))).rejects.toBeInstanceOf(
        ProtocolError
      )
    }
  })
})

describe('download metadata', () => {
  it('checks a recorded digest prefix, whatever its case', () => {
    const bytes = Buffer.from('chart')
    const digest = createHash('sha256').update(bytes).digest('hex')
    expect(sha256Matches(bytes, digest.slice(0, 16).toUpperCase())).toBe(true)
    expect(sha256Matches(bytes, '0000000000000000')).toBe(false)
  })

  it('labels known types and keeps anything a browser could run opaque', () => {
    expect(downloadContentType('uploads/spec.pdf')).toBe('application/pdf')
    expect(downloadContentType('out/CHART.PNG')).toBe('image/png')
    expect(downloadContentType('uploads/page.html')).toBe('application/octet-stream')
    expect(downloadContentType('uploads/logo.svg')).toBe('application/octet-stream')
    expect(downloadContentType('uploads/README')).toBe('application/octet-stream')
  })

  it('names the attachment exactly, with an ASCII fallback', () => {
    expect(attachmentDisposition('uploads/spec.pdf')).toBe(`attachment; filename="spec.pdf"; filename*=UTF-8''spec.pdf`)
    expect(attachmentDisposition('uploads/résumé "v2" (final).pdf')).toBe(
      `attachment; filename="r_sum_ _v2_ (final).pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22v2%22%20%28final%29.pdf`
    )
  })
})
