import { describe, expect, it } from 'vitest'
import {
  ARTIFACT_MAX_BYTES,
  ARTIFACT_MAX_FILES,
  artifactRevisionLimitProblem,
  formatArtifactBytes,
  ArtifactManifest,
  ArtifactPublishBeginOk,
  ArtifactListEntry,
  ArtifactPublishBeginReq,
  ArtifactRefusalReason,
  ArtifactShareOk,
  ArtifactShareReq,
  ArtifactTitle,
  ArtifactUnshareReq,
  ArtifactDeleteOk,
  ArtifactDeleteReq,
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
  it.each([
    'index.html',
    'assets/app.js',
    'a b/ü.md',
    '.well-known/x',
    'dir.git/x',
    '..hidden',
    'sub/__ac/x',
    '__ac',
    '__acx/y'
  ])('accepts %s', (p) => {
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
    ['__ac/shim', /reserved/],
    ['__AC/sw.js', /reserved/],
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

  it('leaves the file count and the total size to the named limit check', () => {
    const many = Array.from({ length: ARTIFACT_MAX_FILES + 1 }, (_, i) => file(`f${i}.txt`))
    expect(ArtifactManifest.safeParse({ entry: 'f0.txt', files: many }).success).toBe(true)
    expect(artifactRevisionLimitProblem({ files: many })).toMatchObject({
      rule: 'files',
      limit: ARTIFACT_MAX_FILES,
      actual: ARTIFACT_MAX_FILES + 1,
      message: `a revision holds at most 200 files, and this one has 201`
    })
    const atLimit = Array.from({ length: ARTIFACT_MAX_FILES }, (_, i) => file(`f${i}.txt`))
    expect(artifactRevisionLimitProblem({ files: atLimit })).toBeUndefined()
  })

  it('holds a revision to 200 MB in total', () => {
    expect(ARTIFACT_MAX_BYTES).toBe(200 * 1024 * 1024)
    const half = Math.ceil(ARTIFACT_MAX_BYTES / 2) + 1
    const over = [file('a', half), file('b', half)]
    expect(ArtifactManifest.safeParse({ entry: 'a', files: over }).success).toBe(true)
    expect(artifactRevisionLimitProblem({ files: over })).toMatchObject({
      rule: 'bytes',
      limit: ARTIFACT_MAX_BYTES,
      actual: 2 * half,
      message: `a revision holds at most 200 MB, and this one has ${2 * half} bytes`
    })
    expect(artifactRevisionLimitProblem({ files: [file('a', ARTIFACT_MAX_BYTES)] })).toBeUndefined()
  })

  it('formats whole megabytes and leaves other sizes in bytes', () => {
    expect(formatArtifactBytes(ARTIFACT_MAX_BYTES)).toBe('200 MB')
    expect(formatArtifactBytes(1024 * 1024 + 1)).toBe('1048577 bytes')
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

  it('registers the seven request/reply pairs', () => {
    for (const type of [
      'artifact/publish/begin',
      'artifact/publish/complete',
      'artifact/fetch',
      'artifact/list',
      'artifact/share',
      'artifact/unshare',
      'artifact/delete'
    ]) {
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

describe('artifact share frames', () => {
  const SHARE = '33333333-3333-4333-8333-333333333333'
  const share = {
    agentId: AGENT,
    sessionId: 'webchat:s-1',
    artifactId: ARTIFACT,
    audience: 'public',
    initiator: { kind: 'chat', integrationId: '44444444-4444-4444-8444-444444444444', memberId: 'U1' }
  }

  it('round-trips a share with or without a revision, and only for a public or org audience', () => {
    const decoded = decodeEnvelope(encode(buildEnvelope('artifact/share', share)))
    expect(decoded.ok && decoded.frame.payload).toEqual(share)
    expect(ArtifactShareReq.safeParse({ ...share, revision: 2 }).success).toBe(true)
    expect(ArtifactShareReq.safeParse({ ...share, revision: 0 }).success).toBe(false)
    expect(ArtifactShareReq.safeParse({ ...share, audience: 'private' }).success).toBe(false)
  })

  it('answers a share with its link and unshares by share id', () => {
    const ok = {
      shareId: SHARE,
      artifactId: ARTIFACT,
      revision: 1,
      audience: 'org',
      displayTail: '…abcdef',
      createdAt: '2026-11-27T10:00:00.000Z',
      linkPath: '/share/token',
      link: 'https://console.example.test/share/token'
    }
    expect(ArtifactShareOk.safeParse(ok).success).toBe(true)
    const unshare = { agentId: AGENT, sessionId: 'webchat:s-1', artifactId: ARTIFACT, shareId: SHARE }
    expect(ArtifactUnshareReq.safeParse(unshare).success).toBe(true)
    expect(ArtifactUnshareReq.safeParse({ ...unshare, shareId: 'https://console.example.test/share/x' }).success).toBe(
      false
    )
  })

  it('parses a list entry with or without shares, and names the share refusals', () => {
    const entry = {
      artifactId: ARTIFACT,
      title: 'Q3 report',
      audience: { visibility: 'org', owned: true },
      producedByAgent: true,
      updatedAt: '2026-11-27T10:00:00.000Z',
      latest: {
        revision: 1,
        entry: 'index.html',
        entryMediaType: 'text/html',
        fileCount: 1,
        totalBytes: 10,
        producedByAgentName: 'Analyst',
        createdAt: '2026-11-27T10:00:00.000Z'
      }
    }
    expect(ArtifactListEntry.safeParse(entry).success).toBe(true)
    const shares = [
      { shareId: SHARE, revision: 1, audience: 'public', displayTail: '…abcdef', createdAt: entry.updatedAt }
    ]
    expect(ArtifactListEntry.safeParse({ ...entry, shares }).success).toBe(true)
    for (const reason of [
      'no-member-authority',
      'share-forbidden',
      'revision-not-ready',
      'share-not-found',
      'revision-limit',
      'org-limit'
    ]) {
      expect(ArtifactRefusalReason.safeParse(reason).success).toBe(true)
    }
  })
})

describe('artifact delete frames', () => {
  const del = { agentId: AGENT, sessionId: 'webchat:s-1', artifactId: ARTIFACT }

  it('round-trips a delete by artifact id, with or without an initiator, and names its refusal', () => {
    const withInitiator = { ...del, initiator: { kind: 'console', userId: 'u-1' } }
    const decoded = decodeEnvelope(encode(buildEnvelope('artifact/delete', withInitiator)))
    expect(decoded.ok && decoded.frame.payload).toEqual(withInitiator)
    expect(ArtifactDeleteReq.safeParse(del).success).toBe(true)
    expect(ArtifactDeleteReq.safeParse({ ...del, artifactId: 'not-a-uuid' }).success).toBe(false)
    const ok = { artifactId: ARTIFACT, title: 'Q3 report', deletedAt: '2026-11-27T10:00:00.000Z' }
    expect(ArtifactDeleteOk.safeParse(ok).success).toBe(true)
    expect(ArtifactDeleteOk.safeParse({ ...ok, deletedAt: 'yesterday' }).success).toBe(false)
    expect(ArtifactRefusalReason.safeParse('delete-forbidden').success).toBe(true)
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
