import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { SessionFileSnapshotRecord, SessionFileSnapshotRepo, SessionMetaRecord } from '../persistence/ports.js'
import { createSessionFileService, SESSION_FILE_MISSING_GRACE_MS } from './session-file.js'
import { FileTransferError, sessionFileKey, type FileTransfer } from './transfer.js'

const ORG = 'org_1'
const AGENT = '11111111-1111-4111-8111-111111111111'
const OTHER_AGENT = '44444444-4444-4444-8444-444444444444'
const SESSION = '55555555-5555-4555-8555-555555555555'
const NOW = Date.UTC(2026, 10, 19, 12, 0, 0)
const BYTES = Buffer.from('<p>report</p>')
const SHA = createHash('sha256').update(BYTES).digest('base64')
const HEX = Buffer.from(SHA, 'base64').toString('hex')
const KEY = sessionFileKey(ORG, AGENT, SESSION, HEX)

function bucket(opts: { held?: boolean; enabled?: boolean; seen?: unknown[]; failDelete?: string } = {}): FileTransfer {
  const seen = opts.seen ?? []
  return {
    enabled: () => opts.enabled ?? true,
    maxBytes: 100,
    uploadLimits: () => ({ maxBytes: 100 }),
    grantUpload: async () => {
      throw new Error('unused')
    },
    grantMultipartUpload: async () => {
      throw new Error('unused')
    },
    signParts: async () => {
      throw new Error('unused')
    },
    uploadedFileUrl: async () => undefined,
    cachedDownload: async () => undefined,
    holds: async (input) => {
      seen.push({ holds: input })
      return opts.held ?? false
    },
    deleteObject: async (key) => {
      if (key === opts.failDelete) throw new Error('denied')
      seen.push({ delete: key })
    },
    signPut: async (input) => {
      seen.push({ signPut: input })
      if (input.bytes > 100) throw new FileTransferError('too-large', 'too large')
      return { url: 'https://store.example.test/p', headers: { 'x-amz-tagging': 'ac-cache=live' }, expiresAt: 1 }
    },
    signDownload: async () => ({ url: 'https://store.example.test/g', headers: {}, expiresAt: 2 }),
    signGet: async () => ({ url: 'https://store.example.test/g', headers: {}, expiresAt: 2 }),
    storedDownload: async (input) => {
      seen.push({ storedDownload: input })
      return opts.held === false ? undefined : { url: 'https://store.example.test/g', headers: {}, expiresAt: 2 }
    }
  }
}

function repo(rows: SessionFileSnapshotRecord[] = [], reapable: SessionFileSnapshotRecord[] = []) {
  const asked: Date[] = []
  const store: SessionFileSnapshotRepo & { asked: Date[] } = {
    asked,
    reserve: async (row) => {
      const existing = rows.find((r) => r.objectKey === row.objectKey)
      if (existing) return existing
      const created = { ...row, createdAt: new Date(NOW) }
      rows.push(created)
      return created
    },
    findByDigest: async (orgId, sessionId, prefix) =>
      rows.filter((r) => r.orgId === orgId && r.sessionId === sessionId && r.sha256.startsWith(prefix)),
    reapable: async (missingBefore) => {
      asked.push(missingBefore)
      return [...reapable]
    },
    delete: async (id) => {
      const i = rows.findIndex((r) => r.id === id)
      if (i >= 0) rows.splice(i, 1)
      const j = reapable.findIndex((r) => r.id === id)
      if (j >= 0) reapable.splice(j, 1)
    }
  }
  return store
}

const session = (over: Partial<SessionMetaRecord> = {}) =>
  ({ id: SESSION, agentId: AGENT, contentPurgedAt: null, ...over }) as unknown as SessionMetaRecord

const sessions = (found: SessionMetaRecord | null) => ({ get: async () => found })

const put = { agentId: AGENT, sessionId: SESSION, name: '报告.html', bytes: BYTES.length, sha256: SHA }

describe('shared-file snapshots', () => {
  it('records the snapshot and signs a retained PUT under its session’s key', async () => {
    const seen: unknown[] = []
    const rows: SessionFileSnapshotRecord[] = []
    const service = createSessionFileService({
      transfer: bucket({ seen }),
      snapshots: repo(rows),
      sessions: sessions(session()),
      now: () => NOW
    })
    expect(await service.signPut(ORG, { ...put, network: 'cluster' })).toEqual({
      url: 'https://store.example.test/p',
      headers: { 'x-amz-tagging': 'ac-cache=live' }
    })
    expect(rows).toMatchObject([
      {
        orgId: ORG,
        agentId: AGENT,
        sessionId: SESSION,
        sha256: HEX,
        bytes: BYTES.length,
        name: put.name,
        objectKey: KEY
      }
    ])
    expect(seen).toContainEqual({
      signPut: { key: KEY, bytes: BYTES.length, sha256: SHA, network: 'cluster', retain: true }
    })
  })

  it('answers stored when the session already holds the same bytes', async () => {
    const seen: unknown[] = []
    const service = createSessionFileService({
      transfer: bucket({ seen, held: true }),
      snapshots: repo(),
      sessions: sessions(session())
    })
    expect(await service.signPut(ORG, { ...put, network: 'public' })).toEqual({ stored: true })
    expect(seen.some((s) => 'signPut' in (s as object))).toBe(false)
  })

  it('refuses a session it does not know yet (retryable), another agent’s, or one whose content is gone', async () => {
    const make = (found: SessionMetaRecord | null) =>
      createSessionFileService({ transfer: bucket(), snapshots: repo(), sessions: sessions(found) })
    await expect(make(null).signPut(ORG, { ...put, network: 'public' })).rejects.toMatchObject({
      code: 'SCOPE_DENIED',
      retryable: true
    })
    await expect(
      make(session({ agentId: OTHER_AGENT as SessionMetaRecord['agentId'] })).signPut(ORG, {
        ...put,
        network: 'public'
      })
    ).rejects.toMatchObject({ code: 'SCOPE_DENIED', retryable: false })
    await expect(
      make(session({ contentPurgedAt: new Date(NOW) })).signPut(ORG, { ...put, network: 'public' })
    ).rejects.toMatchObject({ code: 'SCOPE_DENIED', retryable: false })
  })

  it('refuses without a bucket, over the limit, or while the bucket is gated', async () => {
    const base = { snapshots: repo(), sessions: sessions(session()) }
    await expect(createSessionFileService(base).signPut(ORG, { ...put, network: 'public' })).rejects.toMatchObject({
      code: 'SCOPE_DENIED'
    })
    await expect(
      createSessionFileService({ ...base, transfer: bucket() }).signPut(ORG, { ...put, bytes: 101, network: 'public' })
    ).rejects.toMatchObject({ code: 'TOO_LARGE' })
    await expect(
      createSessionFileService({ ...base, transfer: bucket({ enabled: false }) }).signPut(ORG, {
        ...put,
        network: 'public'
      })
    ).rejects.toMatchObject({ code: 'UNAVAILABLE', retryable: true })
  })

  it('downloads a snapshot by the digest prefix a share marker records, under its own name', async () => {
    const seen: unknown[] = []
    const rows: SessionFileSnapshotRecord[] = []
    const service = createSessionFileService({
      transfer: bucket({ seen }),
      snapshots: repo(rows),
      sessions: sessions(session()),
      now: () => NOW
    })
    await service.signPut(ORG, { ...put, network: 'public' })
    expect(await service.download({ orgId: ORG, sessionId: SESSION, sha256Prefix: HEX.slice(0, 16) })).toEqual({
      url: 'https://store.example.test/g',
      expiresAt: 2,
      name: put.name,
      bytes: BYTES.length
    })
    expect(seen).toContainEqual({ storedDownload: { key: KEY, size: BYTES.length, sha256: SHA, name: put.name } })
    expect(await service.download({ orgId: ORG, sessionId: 'other', sha256Prefix: HEX.slice(0, 16) })).toBeUndefined()
  })

  it('names an image original from the request, and finds nothing the bucket no longer holds', async () => {
    const rows: SessionFileSnapshotRecord[] = []
    const store = repo(rows)
    await createSessionFileService({ transfer: bucket(), snapshots: store, sessions: sessions(session()) }).retainImage(
      {
        orgId: ORG,
        agentId: AGENT,
        sessionId: SESSION,
        key: KEY,
        bytes: 5,
        sha256Hex: HEX
      }
    )
    const held = createSessionFileService({ transfer: bucket(), snapshots: store, sessions: sessions(session()) })
    expect(
      (await held.download({ orgId: ORG, sessionId: SESSION, sha256Prefix: HEX.slice(0, 16), name: 'chart.png' }))?.name
    ).toBe('chart.png')
    const gone = createSessionFileService({
      transfer: bucket({ held: false }),
      snapshots: store,
      sessions: sessions(session())
    })
    expect(await gone.download({ orgId: ORG, sessionId: SESSION, sha256Prefix: HEX.slice(0, 16) })).toBeUndefined()
  })

  it('releases purged or orphaned snapshots object first, and keeps a row whose delete failed', async () => {
    const row = (id: string, key: string): SessionFileSnapshotRecord => ({
      id,
      orgId: ORG,
      agentId: AGENT,
      sessionId: SESSION,
      sha256: HEX,
      bytes: 5,
      name: null,
      objectKey: key,
      createdAt: new Date(NOW)
    })
    const other = sessionFileKey(ORG, AGENT, 'session-2', HEX)
    const reapable = [row('b', other), row('a', KEY)]
    const store = repo([], reapable)
    const seen: unknown[] = []
    const service = createSessionFileService({
      transfer: bucket({ seen, failDelete: other }),
      snapshots: store,
      sessions: sessions(session()),
      now: () => NOW
    })
    await expect(service.reap()).rejects.toThrow('denied')
    expect(seen).toEqual([{ delete: KEY }])
    expect(reapable.map((r) => r.id)).toEqual(['b'])
    expect(store.asked).toEqual([new Date(NOW - SESSION_FILE_MISSING_GRACE_MS)])
  })
})
