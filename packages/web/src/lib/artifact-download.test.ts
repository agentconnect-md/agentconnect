import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { unzipSync, strFromU8 } from 'fflate'
import type { ArtifactManifestFile } from './artifact'

const api = vi.hoisted(() => ({ fileUrl: vi.fn(), revision: vi.fn() }))
const saved = vi.hoisted(() => ({ save: vi.fn() }))

vi.mock('@/lib/api', () => ({ getArtifactFileUrl: api.fileUrl, getArtifactRevision: api.revision }))
vi.mock('@/lib/shared-file', () => ({ saveBlob: saved.save }))

import { ArtifactFetchError, downloadArtifactRevision, fetchArtifactFile } from './artifact-download'

const ID = '0b6d1d55-5f43-4c8e-9a51-2f0a8f5b1c3d'
const BODIES: Record<string, string> = {
  'report.pdf': '%PDF-1.7 fake',
  'source/report.docx': 'PK fake docx',
  'notes.md': '# Notes'
}
const file = (path: string, mediaType: string): ArtifactManifestFile => ({
  path,
  sha256: '0'.repeat(64),
  bytes: BODIES[path]!.length,
  mediaType
})

beforeEach(() => {
  api.fileUrl.mockImplementation(async (_id: string, _revision: number, path: string) => ({
    path,
    url: `https://store.example.test/${encodeURIComponent(path)}`
  }))
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = decodeURIComponent(new URL(url).pathname.slice(1))
      const body = BODIES[path]
      return body === undefined ? new Response('gone', { status: 403 }) : new Response(body, { status: 200 })
    })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  api.fileUrl.mockReset()
  api.revision.mockReset()
  saved.save.mockReset()
})

describe('fetchArtifactFile', () => {
  it('types the bytes by the manifest, not by the store’s attachment headers, and reads without credentials', async () => {
    const blob = await fetchArtifactFile(ID, 2, { path: 'report.pdf', mediaType: 'application/pdf' })
    expect(blob.type).toBe('application/pdf')
    expect(await blob.text()).toBe(BODIES['report.pdf'])
    expect(api.fileUrl).toHaveBeenCalledWith(ID, 2, 'report.pdf')
    expect(vi.mocked(fetch).mock.calls[0]![1]).toMatchObject({ credentials: 'omit' })
  })

  it('reports a refused signed read', async () => {
    await expect(fetchArtifactFile(ID, 2, { path: 'missing.txt', mediaType: 'text/plain' })).rejects.toBeInstanceOf(
      ArtifactFetchError
    )
  })
})

describe('downloadArtifactRevision', () => {
  it('saves a single file as itself under its manifest name', async () => {
    await downloadArtifactRevision(ID, 1, 'Notes', [file('notes.md', 'text/markdown')])
    expect(saved.save).toHaveBeenCalledTimes(1)
    const [blob, name] = saved.save.mock.calls[0]! as [Blob, string]
    expect(name).toBe('notes.md')
    expect(await blob.text()).toBe('# Notes')
  })

  it('zips every file of a multi-file revision under its manifest path, named after the title', async () => {
    api.revision.mockResolvedValue({
      manifest: {
        entry: 'report.pdf',
        files: [file('report.pdf', 'application/pdf'), file('source/report.docx', 'application/vnd.openxmlformats')]
      }
    })
    await downloadArtifactRevision(ID, 4, 'Q3 report: final')
    expect(api.revision).toHaveBeenCalledWith(ID, 4)
    const [blob, name] = saved.save.mock.calls[0]! as [Blob, string]
    expect(name).toBe('Q3 report- final.zip')
    expect(blob.type).toBe('application/zip')
    const entries = unzipSync(new Uint8Array(await blob.arrayBuffer()))
    expect(Object.keys(entries).sort()).toEqual(['report.pdf', 'source/report.docx'])
    expect(strFromU8(entries['source/report.docx']!)).toBe(BODIES['source/report.docx'])
  })

  it('saves nothing when one of the files cannot be read', async () => {
    await expect(
      downloadArtifactRevision(ID, 4, 'Broken', [
        file('report.pdf', 'application/pdf'),
        { ...file('notes.md', 'text/markdown'), path: 'gone.md' }
      ])
    ).rejects.toBeInstanceOf(ArtifactFetchError)
    expect(saved.save).not.toHaveBeenCalled()
  })
})
