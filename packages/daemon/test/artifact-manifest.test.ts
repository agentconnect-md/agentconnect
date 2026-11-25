// The publish side's manifest building (artifacts.md §5.3–§5.4, §10.2): walk, path rules, limits, entry, hashing.
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ARTIFACT_MAX_FILES } from '@agentconnect.md/protocol'
import {
  artifactDirName,
  artifactIdempotencyKey,
  artifactMediaType,
  ArtifactToolError,
  buildArtifactManifest
} from '../src/artifacts/manifest.js'
import { fakeTree, type FakeNode as Node } from './artifact-tree-support.js'

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')
const build = (root: Node, opts: { label?: string; entry?: string; maxFileBytes?: number } = {}) =>
  buildArtifactManifest(fakeTree(root), {
    label: opts.label ?? 'files:outputs/site',
    ...(opts.entry !== undefined ? { entry: opts.entry } : {}),
    maxFileBytes: opts.maxFileBytes ?? 50 * 1024 * 1024
  })

describe('buildArtifactManifest', () => {
  it('makes a single file a one-file manifest named by its base name', async () => {
    const built = await build('<h1>hi</h1>', { label: 'files:outputs/report.html' })
    expect(built.manifest).toEqual({
      entry: 'report.html',
      files: [{ path: 'report.html', sha256: sha('<h1>hi</h1>'), bytes: 11, mediaType: 'text/html' }]
    })
    expect(built.files[0]!.rel).toBe('')
  })

  it('walks a directory in sorted order, leaves out .git, and checks the entry', async () => {
    const built = await build(
      { 'index.html': 'x', assets: { 'app.js': 'y', 'logo.svg': 'z' }, '.git': { HEAD: 'ref' } },
      { entry: './index.html' }
    )
    expect(built.manifest.entry).toBe('index.html')
    expect(built.manifest.files.map((f) => [f.path, f.mediaType])).toEqual([
      ['assets/app.js', 'text/javascript'],
      ['assets/logo.svg', 'image/svg+xml'],
      ['index.html', 'text/html']
    ])
    expect(built.skipped).toEqual(['.git'])
  })

  it('requires an entry for a directory of several files, suggesting index.html', async () => {
    await expect(build({ 'index.html': 'x', 'a.css': 'y' })).rejects.toThrow(
      /name the one that opens first as `entry` \(for example "index.html"\)/
    )
    await expect(build({ 'index.html': 'x', 'a.css': 'y' }, { entry: 'main.html' })).rejects.toThrow(
      /the entry "main.html" is not one of the files/
    )
    // One file needs no entry.
    expect((await build({ 'only.md': '# hi' })).manifest.entry).toBe('only.md')
  })

  it('refuses links and special files, and an empty file, by name before any upload', async () => {
    await expect(build({ 'index.html': 'x', secret: { link: true } }, { entry: 'index.html' })).rejects.toThrow(
      /"files:outputs\/site\/secret" is a symbolic link or special file/
    )
    await expect(build({ link: true })).rejects.toThrow(/is a symbolic link or special file/)
    await expect(build({ 'index.html': 'x', 'empty.txt': '' }, { entry: 'index.html' })).rejects.toThrow(
      /"empty.txt" is empty/
    )
    await expect(build({})).rejects.toThrow(/holds no files/)
  })

  it('refuses paths that collide after case folding or Unicode normalization', async () => {
    await expect(build({ 'A.html': 'x', 'a.html': 'y' }, { entry: 'a.html' })).rejects.toThrow(
      /differ only in letter case or Unicode form/
    )
    await expect(build({ 'café.md': 'x', 'café.md': 'y' }, { entry: 'café.md' })).rejects.toThrow(
      /differ only in letter case/
    )
  })

  it('refuses a path the protocol rules reject', async () => {
    await expect(build({ 'a\\b.txt': 'x' })).rejects.toThrow(/contains a backslash/)
  })

  it('stops at the file-count limit while walking', async () => {
    const many = Object.fromEntries(Array.from({ length: ARTIFACT_MAX_FILES + 1 }, (_, i) => [`f${i}.txt`, 'x']))
    const tree = fakeTree(many)
    await expect(buildArtifactManifest(tree, { label: 'out', entry: 'f0.txt', maxFileBytes: 1000 })).rejects.toThrow(
      /more than 200 files/
    )
    expect(tree.reads).toEqual([])
  })

  it('refuses a file over the per-file limit, and files that add up past the revision limit', async () => {
    await expect(
      build({ 'a.bin': 'x'.repeat(20), 'b.bin': 'y' }, { entry: 'a.bin', maxFileBytes: 10 })
    ).rejects.toThrow(/"a.bin" is 20 bytes, over this deployment's 10-byte limit per file/)
    const tree = fakeTree({ 'a.bin': 'x', 'b.bin': 'y' })
    // The second read gets what remains of the 50 MB budget; a file past it reads as too large.
    tree.read = async (rel) =>
      rel === 'a.bin' ? { bytes: Buffer.alloc(30 * 1024 * 1024, 1) } : { tooLarge: 30 * 1024 * 1024 }
    await expect(
      buildArtifactManifest(tree, { label: 'out', entry: 'a.bin', maxFileBytes: 50 * 1024 * 1024 })
    ).rejects.toThrow(/add up to more than 52428800 bytes/)
  })

  it('reports refusals as ArtifactToolError', async () => {
    await expect(build({ 'a.txt': '' })).rejects.toBeInstanceOf(ArtifactToolError)
  })
})

describe('artifact helpers', () => {
  it('types files by extension through an allowlist', () => {
    expect(artifactMediaType('index.HTML')).toBe('text/html')
    expect(artifactMediaType('notes.md')).toBe('text/markdown')
    expect(artifactMediaType('report.pdf')).toBe('application/pdf')
    expect(artifactMediaType('main.ts')).toBe('text/plain')
    expect(artifactMediaType('blob.xyz')).toBe('application/octet-stream')
    expect(artifactMediaType('Makefile')).toBe('application/octet-stream')
  })

  it('keys a publication by turn and content, so a retry in the same turn reuses it', () => {
    const manifest = {
      entry: 'a.md',
      files: [{ path: 'a.md', sha256: sha('x'), bytes: 1, mediaType: 'text/markdown' }]
    }
    const base = { agentId: 'agent-1', sessionId: 'session-1', turn: 'msg-1', title: 'A', manifest }
    const key = artifactIdempotencyKey(base)
    expect(key).toMatch(/^pub-[0-9a-f]{48}$/)
    expect(artifactIdempotencyKey({ ...base })).toBe(key)
    expect(artifactIdempotencyKey({ ...base, turn: 'msg-2' })).not.toBe(key)
    expect(
      artifactIdempotencyKey({
        ...base,
        manifest: { ...manifest, files: [{ ...manifest.files[0]!, sha256: sha('y') }] }
      })
    ).not.toBe(key)
  })

  it('names a fetch directory from the title and the id, safely', () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e'
    expect(artifactDirName('Q3 revenue report', id)).toBe('Q3-revenue-report-0f8fad5b')
    expect(artifactDirName('../../etc/passwd', id)).toBe('etc-passwd-0f8fad5b')
    expect(artifactDirName('...', id)).toBe('artifact-0f8fad5b')
    expect(artifactDirName('季度报告', id)).toBe('季度报告-0f8fad5b')
    expect(artifactDirName('x'.repeat(300), id)).toHaveLength(60 + 9)
  })
})
