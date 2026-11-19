// Shared-file snapshots (agent-authored-attachments.md §4.1): signed into the transfer bucket, read by session visibility, released with the session.
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { seedAgent, seedDaemon, seedSessionMeta } from '../fixtures/seed.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { PgSessionRepo } from '../../src/persistence/repositories/session.repo.js'
import { PgSessionFileSnapshotRepo } from '../../src/persistence/repositories/session-file-snapshot.repo.js'
import { createSessionFileService, SESSION_FILE_MISSING_GRACE_MS } from '../../src/file-transfer/session-file.js'
import type { FileTransfer } from '../../src/file-transfer/transfer.js'
import type { OrgMemberRole } from '../../src/persistence/ports.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const T0 = Date.parse('2026-10-21T10:00:00.000Z')
const BYTES = Buffer.from('<p>first draft</p>')
const SHA = createHash('sha256').update(BYTES).digest('base64')
const HEX = Buffer.from(SHA, 'base64').toString('hex')

const opened: HttpApp[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((a) => a.close()))
})

// An in-memory bucket: a signed PUT is "uploaded" by the test putting the key in `objects`.
function fakeBucket() {
  const objects = new Map<string, { bytes: number; sha256: string }>()
  const deleted: string[] = []
  const transfer = {
    enabled: () => true,
    maxBytes: 1024,
    holds: async ({ key, size, sha256 }: { key: string; size: number; sha256: string }) =>
      objects.get(key)?.bytes === size && objects.get(key)?.sha256 === sha256,
    signPut: async ({ key }: { key: string }) => ({
      url: `https://store.example.test/${key}?sig=put`,
      headers: { 'x-amz-tagging': 'ac-cache=live' },
      expiresAt: T0 + 900_000
    }),
    storedDownload: async ({ key, size, sha256 }: { key: string; size: number; sha256: string }) =>
      objects.get(key)?.bytes === size && objects.get(key)?.sha256 === sha256
        ? { url: `https://store.example.test/${key}?sig=get`, headers: {}, expiresAt: T0 + 1_800_000 }
        : undefined,
    deleteObject: async (key: string) => {
      deleted.push(key)
      objects.delete(key)
    }
  } as unknown as FileTransfer
  return { transfer, objects, deleted }
}

function harness(now = T0) {
  const bucket = fakeBucket()
  const service = createSessionFileService({
    transfer: bucket.transfer,
    snapshots: new PgSessionFileSnapshotRepo(prisma),
    sessions: new PgSessionRepo(prisma),
    now: () => now
  })
  return { ...bucket, service }
}

function appAs(userId: string, service: ReturnType<typeof harness>['service']): HttpApp {
  const app = buildHttpApp(prisma, { DEFAULT_OWNER_ID: userId }, undefined, undefined, { sessionFiles: service })
  opened.push(app)
  return app
}

async function makeUser(sub: string, role: OrgMemberRole): Promise<string> {
  const email = `${sub}@example.test`
  const { userId } = await new PgUserRepo(prisma).provisionOidcUser({ oidcSubject: sub, email, emailVerified: true })
  await new PgUserRepo(prisma).addMemberByEmail(DEFAULT_ORG_ID, email, role)
  return userId
}

async function session(visibility: 'org' | 'private' = 'org', ownerIdentity?: string) {
  const daemonId = await seedDaemon(prisma, randomUUID())
  const agentId = await seedAgent(prisma, randomUUID(), { daemonId })
  const sessionId = await seedSessionMeta(prisma, randomUUID(), agentId, {
    visibility,
    ...(ownerIdentity ? { ownerIdentity } : {})
  })
  return { agentId, sessionId }
}

// Sign and "upload" one snapshot the way a daemon does; returns its key.
async function share(h: ReturnType<typeof harness>, s: { agentId: string; sessionId: string }): Promise<string> {
  const signed = await h.service.signPut(DEFAULT_ORG_ID, {
    agentId: s.agentId,
    sessionId: s.sessionId,
    name: 'daily-report.html',
    bytes: BYTES.length,
    sha256: SHA,
    network: 'cluster'
  })
  const key = decodeURIComponent(new URL(signed.url!).pathname.slice(1))
  h.objects.set(key, { bytes: BYTES.length, sha256: SHA })
  return key
}

describe('shared-file snapshots', () => {
  it('downloads the shared revision by its marker’s digest prefix, and uploads a repeated share once', async () => {
    const h = harness()
    const s = await session()
    await share(h, s)
    const again = await h.service.signPut(DEFAULT_ORG_ID, {
      ...s,
      name: 'daily-report.html',
      bytes: BYTES.length,
      sha256: SHA,
      network: 'cluster'
    })
    expect(again).toEqual({ stored: true })

    const res = await appAs(DEFAULT_OWNER_ID, h.service).app.inject({
      method: 'GET',
      url: `${ORG}/sessions/${s.sessionId}/shared-files/${HEX.slice(0, 16)}`
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      name: 'daily-report.html',
      bytes: BYTES.length,
      url: expect.stringContaining('sig=get')
    })
    const missing = await appAs(DEFAULT_OWNER_ID, h.service).app.inject({
      method: 'GET',
      url: `${ORG}/sessions/${s.sessionId}/shared-files/${'0'.repeat(16)}`
    })
    expect(missing.statusCode).toBe(404)
  })

  it('hides a private session’s snapshots from a member who cannot see it', async () => {
    const h = harness()
    const dana = await makeUser(`share-dana-${randomUUID()}`, 'collaborator')
    const erin = await makeUser(`share-erin-${randomUUID()}`, 'collaborator')
    const s = await session('private', `user:${dana}`)
    await share(h, s)
    const url = `${ORG}/sessions/${s.sessionId}/shared-files/${HEX.slice(0, 16)}`
    expect((await appAs(dana, h.service).app.inject({ method: 'GET', url })).statusCode).toBe(200)
    expect((await appAs(erin, h.service).app.inject({ method: 'GET', url })).statusCode).toBe(404)
  })

  it('releases a purged session’s snapshot and one whose session is gone, but keeps a live one', async () => {
    const h = harness()
    const live = await session()
    const purged = await session()
    const gone = await session()
    const liveKey = await share(h, live)
    const purgedKey = await share(h, purged)
    const goneKey = await share(h, gone)
    await prisma.sessionMeta.update({ where: { id: purged.sessionId }, data: { contentPurgedAt: new Date(T0) } })
    await prisma.sessionMeta.delete({ where: { id: gone.sessionId } })

    // A purged session's snapshot is unreadable at once, before the reaper deletes its object.
    const purgedRead = await appAs(DEFAULT_OWNER_ID, h.service).app.inject({
      method: 'GET',
      url: `${ORG}/sessions/${purged.sessionId}/shared-files/${HEX.slice(0, 16)}`
    })
    expect(purgedRead.statusCode).toBe(404)
    expect(h.objects.has(purgedKey)).toBe(true)

    // A session row that is missing only briefly may still be on its way, so its snapshot waits out the grace.
    expect(await h.service.reap()).toBe(1)
    expect(h.deleted).toEqual([purgedKey])

    await prisma.sessionFileSnapshot.updateMany({
      where: { objectKey: goneKey },
      data: { createdAt: new Date(Date.now() - SESSION_FILE_MISSING_GRACE_MS - 60_000) }
    })
    const later = createSessionFileService({
      transfer: h.transfer,
      snapshots: new PgSessionFileSnapshotRepo(prisma),
      sessions: new PgSessionRepo(prisma)
    })
    expect(await later.reap()).toBe(1)
    expect(h.deleted).toEqual([purgedKey, goneKey])
    expect(h.objects.has(liveKey)).toBe(true)
    expect(await prisma.sessionFileSnapshot.count({ where: { sessionId: live.sessionId } })).toBe(1)
    expect(await prisma.sessionFileSnapshot.count({ where: { objectKey: { in: [purgedKey, goneKey] } } })).toBe(0)
  })
})
