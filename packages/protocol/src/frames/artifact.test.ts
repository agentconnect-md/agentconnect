import { describe, expect, it } from 'vitest'
import {
  ARTIFACT_MAX_BYTES,
  ARTIFACT_MAX_FILES,
  ArtifactManifest,
  ArtifactPublishBeginOk,
  ArtifactPublishBeginReq,
  ArtifactTitle,
  artifactPathProblem,
  buildEnvelope,
  decodeEnvelope,
  encode,
  formatArtifactMarker,
  isFrameType,
  parseArtifactMarker
} from '../index.js'

const AGENT = '11111111-1111-4111-8111-111111111111'
const ARTIFACT = '22222222-2222-4222-8222-222222222222'
const SHA = 'a'.repeat(64)
const file = (path: string, bytes = 10) => ({ path, sha256: SHA, bytes, mediaType: 'text/html' })

describe('artifact path rules (artifacts.md §5.4)', () => {
  it.each(['index.html', 'assets/app.js', 'a b/ü.md', '.well-known/x', 'dir.git/x', '..hidden'])('accepts %s', (p) => {
    expect(artifactPathProblem(p)).toBeUndefined()
  })

  it.each([
    ['', /empty/],
    ['/etc/passwd', /absolute/],
    ['a\\b', /backslash/],
    ['a\u0000b', /control/],
    ['a\nb', /control/],
    ['a//b', /empty segment/],
    ['a/', /empty segment/],
    ['./a', /`\.`/],
    ['a/../b', /`\.`/],
    ['.git/config', /\.git/],
    ['sub/.GIT/HEAD', /\.git/],
    [`${'x'.repeat(256)}`, /segment/],
    [`${'a/'.repeat(400)}b`, /longer than/]
  ])('refuses %j', (p, why) => {
    expect(artifactPathProblem(p)).toMatch(why)
  })
})

describe('ArtifactManifest', () => {
  it('accepts a multi-file revision whose entry is one of its files', () => {
    expect(
      ArtifactManifest.safeParse({ entry: 'report.pdf', files: [file('report.pdf'), file('report.docx')] }).success
    ).toBe(true)
  })

  it('refuses an entry that is not a file', () => {
    expect(ArtifactManifest.safeParse({ entry: 'index.html', files: [file('app.js')] }).success).toBe(false)
  })

  it('refuses paths that collide after case folding or Unicode normalization', () => {
    expect(ArtifactManifest.safeParse({ entry: 'A.md', files: [file('A.md'), file('a.md')] }).success).toBe(false)
    const composed = 'café.md'
    const decomposed = 'café.md'
    expect(ArtifactManifest.safeParse({ entry: composed, files: [file(composed), file(decomposed)] }).success).toBe(
      false
    )
    expect(ArtifactManifest.safeParse({ entry: 'straße', files: [file('straße'), file('STRASSE')] }).success).toBe(
      false
    )
  })

  it('refuses a file inside another file', () => {
    expect(ArtifactManifest.safeParse({ entry: 'a', files: [file('a'), file('A/b')] }).success).toBe(false)
  })

  it('bounds the file count and the total size', () => {
    const many = Array.from({ length: ARTIFACT_MAX_FILES + 1 }, (_, i) => file(`f${i}.txt`))
    expect(ArtifactManifest.safeParse({ entry: 'f0.txt', files: many }).success).toBe(false)
    const atLimit = Array.from({ length: ARTIFACT_MAX_FILES }, (_, i) => file(`f${i}.txt`))
    expect(ArtifactManifest.safeParse({ entry: 'f0.txt', files: atLimit }).success).toBe(true)
    const half = Math.ceil(ARTIFACT_MAX_BYTES / 2) + 1
    expect(ArtifactManifest.safeParse({ entry: 'a', files: [file('a', half), file('b', half)] }).success).toBe(false)
    expect(ArtifactManifest.safeParse({ entry: 'a', files: [file('a', ARTIFACT_MAX_BYTES)] }).success).toBe(true)
  })

  it('refuses an empty file, an upper-case digest and a media type with parameters', () => {
    expect(ArtifactManifest.safeParse({ entry: 'a', files: [file('a', 0)] }).success).toBe(false)
    expect(ArtifactManifest.safeParse({ entry: 'a', files: [{ ...file('a'), sha256: 'A'.repeat(64) }] }).success).toBe(
      false
    )
    const typed = { ...file('a'), mediaType: 'text/html; charset=utf-8' }
    expect(ArtifactManifest.safeParse({ entry: 'a', files: [typed] }).success).toBe(false)
  })
})

describe('artifact frames', () => {
  const begin = {
    agentId: AGENT,
    sessionId: 'webchat:s-1',
    title: 'Q3 report',
    manifest: { entry: 'index.html', files: [file('index.html')] },
    idempotencyKey: 'publish-0001',
    network: 'cluster',
    initiator: { kind: 'console', userId: 'u-1' }
  }

  it('registers the four request/reply pairs', () => {
    for (const type of ['artifact/publish/begin', 'artifact/publish/complete', 'artifact/fetch', 'artifact/list']) {
      expect(isFrameType(type)).toBe(true)
      expect(isFrameType(`${type}/ok`)).toBe(true)
    }
  })

  it('round-trips a publish begin through the envelope codec', () => {
    const decoded = decodeEnvelope(encode(buildEnvelope('artifact/publish/begin', begin)))
    expect(decoded.ok && decoded.frame.payload).toEqual(begin)
  })

  it('refuses a begin with a bad path, a blank title or a short idempotency key', () => {
    expect(ArtifactPublishBeginReq.safeParse(begin).success).toBe(true)
    const badPath = { ...begin, manifest: { entry: '../x', files: [file('../x')] } }
    expect(ArtifactPublishBeginReq.safeParse(badPath).success).toBe(false)
    expect(ArtifactPublishBeginReq.safeParse({ ...begin, title: '   ' }).success).toBe(false)
    expect(ArtifactTitle.safeParse('line one\nline two').success).toBe(false)
    expect(ArtifactPublishBeginReq.safeParse({ ...begin, idempotencyKey: 'short' }).success).toBe(false)
  })

  it('answers either PUTs for a pending revision or a replayed ready result', () => {
    const pending = { state: 'pending', artifactId: ARTIFACT, revision: 1, uploads: [], expiresAt: 1 }
    expect(ArtifactPublishBeginOk.safeParse(pending).success).toBe(true)
    const ready = {
      state: 'ready',
      artifactId: ARTIFACT,
      revision: 2,
      title: 'Q3 report',
      linkPath: `/acme/artifacts/${ARTIFACT}?revision=2`,
      audience: { visibility: 'org', owned: true }
    }
    expect(ArtifactPublishBeginOk.safeParse(ready).success).toBe(true)
  })
})

describe('artifact transcript marker', () => {
  it('round-trips titles with quotes, brackets, backslashes and newlines on one line', () => {
    for (const title of ['Q3 report', 'say "hi" ] [artifact: x]', 'back\\slash', 'two\nlines', '日本語']) {
      const marker = formatArtifactMarker({ artifactId: ARTIFACT, revision: 3, title })
      expect(marker.includes('\n')).toBe(false)
      expect(parseArtifactMarker(`Here it is.\n${marker}`)).toEqual({
        caption: 'Here it is.',
        artifact: { artifactId: ARTIFACT, revision: 3, title }
      })
    }
  })

  it('parses a marker alone and ignores one that is not on the last line', () => {
    const marker = formatArtifactMarker({ artifactId: ARTIFACT, revision: 1, title: 'x' })
    expect(parseArtifactMarker(marker)?.caption).toBe('')
    expect(parseArtifactMarker(`${marker}\nmore`)).toBeNull()
  })

  it('refuses malformed markers', () => {
    expect(parseArtifactMarker(`[artifact: ${ARTIFACT} r0 "x"]`)).toBeNull()
    expect(parseArtifactMarker(`[artifact: not-a-uuid-not-a-uuid-not-a-uuid-xxxx r1 "x"]`)).toBeNull()
    expect(parseArtifactMarker(`[artifact: ${ARTIFACT} r1 "unterminated]`)).toBeNull()
    expect(parseArtifactMarker(`[artifact: ${ARTIFACT} r1 "bad \\q escape"]`)).toBeNull()
    expect(() => formatArtifactMarker({ artifactId: 'X', revision: 1, title: 'x' })).toThrow()
  })
})
