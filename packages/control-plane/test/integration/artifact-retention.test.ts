// Revision retention and organization deletion (artifacts.md §10.1, P3): old revisions go, objects first; latest and shared stay.
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { agentAndSession, harness, manifestOf, publish, T0 } from '../fixtures/artifacts.js'
import { revisionExpired } from '../../src/artifacts/retention.js'
import { artifactRevisionPrefix } from '../../src/file-transfer/transfer.js'
import { PgArtifactRepo, PgArtifactShareRepo, PgOrgRepo } from '../../src/persistence/index.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const READ = '/api/v1/artifact-shares/read'
const DAY = 24 * 60 * 60_000

type Harness = ReturnType<typeof harness>

const opened: HttpApp[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((a) => a.close()))
})

function appAs(h: Harness) {
  const built = buildHttpApp(prisma, { DEFAULT_OWNER_ID }, undefined, undefined, { artifacts: h.service })
  opened.push(built)
  return built.app
}

const keysOf = (h: Harness, artifactId: string, revision: number) =>
  [...h.objects.keys()].filter((k) => k.includes(`/${artifactId}/${revision}/`))

const age = async (artifactId: string, number: number, days: number) =>
  await prisma.artifactRevision.update({
    where: { artifactId_number: { artifactId, number } },
    data: { createdAt: new Date(T0 - days * DAY) }
  })

const numbers = async (artifactId: string) =>
  (await prisma.artifactRevision.findMany({ where: { artifactId }, orderBy: { number: 'asc' } })).map((r) => r.number)

/** An artifact with three ready revisions published from one daemon, aged 120, 60 and 1 days. */
async function threeRevisions(h: Harness = harness(), retention = '90d') {
  const org = await agentAndSession()
  await prisma.daemon.update({ where: { id: org.daemonId }, data: { sessionRetention: retention } })
  const opts = { daemonId: org.daemonId }
  const first = await publish(h, org.agent, org.sessionId, {
    ...opts,
    manifest: manifestOf(['index.html', '<p>v1</p>'], ['app.js', 'v1()', 'text/javascript'])
  })
  const id = first.artifactId
  await publish(h, org.agent, org.sessionId, { ...opts, artifactId: id, manifest: manifestOf(['index.html', 'v2']) })
  await publish(h, org.agent, org.sessionId, { ...opts, artifactId: id, manifest: manifestOf(['index.html', 'v3']) })
  await age(id, 1, 120)
  await age(id, 2, 60)
  await age(id, 3, 1)
  return { h, org, id }
}

describe('the retention sweep', () => {
  it('records the publishing daemon and its retention beside each revision', async () => {
    const { org, id } = await threeRevisions(undefined, '30d')
    const rows = await prisma.artifactRevision.findMany({ where: { artifactId: id } })
    expect(rows.map((r) => [r.publishedByDaemonId, r.publishedRetention])).toEqual([
      [org.daemonId, '30d'],
      [org.daemonId, '30d'],
      [org.daemonId, '30d']
    ])
  })

  it('removes a revision older than the window, objects first, and keeps the newer and the latest', async () => {
    const { h, id } = await threeRevisions()
    const gone = keysOf(h, id, 1)
    expect(gone).toHaveLength(2)

    expect(await h.service.prune()).toBe(1)
    expect(await numbers(id)).toEqual([2, 3])
    expect(h.deletes.sort()).toEqual(gone.sort())
    expect(keysOf(h, id, 2)).toHaveLength(1)
    expect(keysOf(h, id, 3)).toHaveLength(1)
    // The first sweep succeeded, so the record is already dropped.
    expect(await prisma.artifactDeletion.count()).toBe(0)
    // A second pass has nothing left to do.
    expect(await h.service.prune()).toBe(0)

    // The artifact stays, and a pinned link to the pruned revision reads as absent; the viewer falls back to the latest.
    const app = appAs(h)
    const read = await app.inject({ method: 'GET', url: `${ORG}/artifacts/${id}` })
    expect(read.statusCode).toBe(200)
    expect(read.json()).toMatchObject({ latestRevision: 3 })
    expect((await app.inject({ method: 'GET', url: `${ORG}/artifacts/${id}/revisions/1` })).statusCode).toBe(404)
  })

  it('keeps the latest revision however old it is', async () => {
    const { h, id } = await threeRevisions()
    await age(id, 2, 200)
    await age(id, 3, 300)
    expect(await h.service.prune()).toBe(2)
    expect(await numbers(id)).toEqual([3])
  })

  it('follows the daemon’s current retention, and never keeps everything', async () => {
    const { h, org, id } = await threeRevisions()
    await prisma.daemon.update({ where: { id: org.daemonId }, data: { sessionRetention: 'never' } })
    expect(await h.service.prune()).toBe(0)
    expect(await numbers(id)).toEqual([1, 2, 3])

    await prisma.daemon.update({ where: { id: org.daemonId }, data: { sessionRetention: '30d' } })
    expect(await h.service.prune()).toBe(2)
    expect(await numbers(id)).toEqual([3])
  })

  it('uses the retention recorded at publish once the daemon is gone, and keeps a revision with neither', async () => {
    const { h, id } = await threeRevisions()
    await prisma.artifactRevision.updateMany({ where: { artifactId: id }, data: { publishedByDaemonId: randomUUID() } })
    await prisma.artifactRevision.update({
      where: { artifactId_number: { artifactId: id, number: 2 } },
      data: { publishedRetention: '30d' }
    })
    await prisma.artifactRevision.update({
      where: { artifactId_number: { artifactId: id, number: 1 } },
      data: { publishedByDaemonId: null, publishedRetention: null }
    })
    expect(await h.service.prune()).toBe(1)
    expect(await numbers(id)).toEqual([1, 3])
  })

  it('keeps a revision an active share pins, until the share is revoked; the revoked link still answers 410', async () => {
    const { h, id } = await threeRevisions()
    await age(id, 2, 120)
    const app = appAs(h)
    const created = await app.inject({
      method: 'POST',
      url: `${ORG}/artifacts/${id}/shares`,
      payload: { revision: 1, audience: 'public' }
    })
    expect(created.statusCode).toBe(201)
    const { id: shareId, token } = created.json()

    expect(await h.service.prune()).toBe(1)
    expect(await numbers(id)).toEqual([1, 3])
    expect((await app.inject({ method: 'POST', url: READ, payload: { token } })).statusCode).toBe(200)

    const revoke = await app.inject({ method: 'DELETE', url: `${ORG}/artifacts/${id}/shares/${shareId}` })
    expect(revoke.statusCode).toBeLessThan(300)
    expect(await h.service.prune()).toBe(1)
    expect(await numbers(id)).toEqual([3])
    expect(await prisma.artifactShare.count({ where: { id: shareId } })).toBe(1)
    expect((await app.inject({ method: 'POST', url: READ, payload: { token } })).statusCode).toBe(410)
  })

  it('keeps the creating agent the producer once revision 1 is gone, and still refuses another agent', async () => {
    const { h, org, id } = await threeRevisions()
    expect(await h.service.prune()).toBe(1)
    expect(await numbers(id)).toEqual([2, 3])
    const owner = { kind: 'console' as const, userId: DEFAULT_OWNER_ID }
    const base = { agentId: org.agentId, sessionId: org.sessionId, artifactId: id, initiator: owner }

    const other = await agentAndSession()
    const refused = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (err: { reason?: string }) => err.reason
      )
    expect(
      await refused(
        h.service.begin(DEFAULT_ORG_ID, other.agent, {
          agentId: other.agentId,
          sessionId: other.sessionId,
          artifactId: id,
          manifest: manifestOf(['index.html', 'x']),
          idempotencyKey: `key-${randomUUID()}`,
          network: 'cluster'
        })
      )
    ).toBe('not-producer')
    const othersBase = { ...base, agentId: other.agentId, sessionId: other.sessionId }
    expect(await refused(h.service.share(DEFAULT_ORG_ID, { ...othersBase, audience: 'org' }))).toBe('not-producer')
    expect(await refused(h.service.delete(DEFAULT_ORG_ID, othersBase))).toBe('not-producer')

    expect((await publish(h, org.agent, org.sessionId, { artifactId: id })).revision).toBe(4)
    const listed = await h.service.list(DEFAULT_ORG_ID, { agentId: org.agentId, sessionId: org.sessionId })
    expect(listed.artifacts.find((a) => a.artifactId === id)?.producedByAgent).toBe(true)
    const shared = await h.service.share(DEFAULT_ORG_ID, { ...base, audience: 'org' })
    expect(shared.revision).toBe(4)
    await h.service.unshare(DEFAULT_ORG_ID, { ...base, shareId: shared.shareId })
    await h.service.delete(DEFAULT_ORG_ID, base)
    expect(await prisma.artifact.count({ where: { id } })).toBe(0)
  })

  it('refuses a share on a revision the sweep removed', async () => {
    const { h, id } = await threeRevisions()
    expect(await h.service.prune()).toBe(1)
    const shares = new PgArtifactShareRepo(prisma)
    const share = {
      orgId: DEFAULT_ORG_ID,
      artifactId: id,
      revisionNumber: 1,
      audience: 'org' as const,
      tokenHash: randomUUID(),
      displayTail: 'abcd',
      createdByIdentity: `user:${DEFAULT_OWNER_ID}`
    }
    expect(await shares.create(share)).toBeNull()
    expect(await shares.create({ ...share, revisionNumber: 3 })).not.toBeNull()
    expect(await shares.create({ ...share, artifactId: randomUUID() })).toBeNull()
    const refused = await appAs(h).inject({
      method: 'POST',
      url: `${ORG}/artifacts/${id}/shares`,
      payload: { revision: 1, audience: 'org' }
    })
    expect(refused.statusCode).toBe(404)
  })

  it('re-decides under the lock, so a revision shared after the scan is kept', async () => {
    const { h, id } = await threeRevisions()
    const repo = new PgArtifactRepo(prisma)
    const [key] = await repo.expiredRevisions(new Date(T0), 10)
    expect(key).toEqual({ orgId: DEFAULT_ORG_ID, artifactId: id, number: 1 })
    await new PgArtifactShareRepo(prisma).create({
      orgId: DEFAULT_ORG_ID,
      artifactId: id,
      revisionNumber: 1,
      audience: 'org',
      tokenHash: randomUUID(),
      displayTail: 'abcd',
      createdByIdentity: `user:${DEFAULT_OWNER_ID}`
    })
    const at = { deletedAt: new Date(T0), purgeAfter: new Date(T0) }
    expect(await repo.expireRecording(key!, at, (facts) => revisionExpired(facts, T0))).toBeNull()
    expect(await numbers(id)).toEqual([1, 2, 3])
  })

  it('leaves a revision that never became ready to the publish path', async () => {
    const { h, org, id } = await threeRevisions()
    await h.service.begin(
      DEFAULT_ORG_ID,
      org.agent,
      {
        agentId: org.agent.id,
        sessionId: org.sessionId,
        artifactId: id,
        manifest: manifestOf(['index.html', 'v4']),
        idempotencyKey: `key-${randomUUID()}`,
        network: 'cluster'
      },
      org.daemonId
    )
    await age(id, 4, 300)
    expect(await h.service.prune()).toBe(1)
    expect(await numbers(id)).toEqual([2, 3, 4])
  })

  it('keeps the rows gone and retries the objects when the bucket refuses them', async () => {
    const { h, id } = await threeRevisions()
    const gone = keysOf(h, id, 1)
    h.bucket.failDeletes = true
    expect(await h.service.prune()).toBe(1)
    expect(await numbers(id)).toEqual([2, 3])
    expect(keysOf(h, id, 1)).toEqual(gone)
    const [record] = await prisma.artifactDeletion.findMany()
    expect(record).toMatchObject({ orgId: DEFAULT_ORG_ID, sweptAt: null })
    expect([...record!.objectKeys].sort()).toEqual(gone.sort())

    await expect(h.service.reap()).rejects.toThrow('bucket unavailable')
    expect(await prisma.artifactDeletion.count()).toBe(1)
    h.bucket.failDeletes = false
    expect(await h.service.reap()).toBe(1)
    expect(keysOf(h, id, 1)).toEqual([])
    expect(await prisma.artifactDeletion.count()).toBe(0)
  })

  it('works through a backlog one bounded batch at a time', async () => {
    const h = harness()
    const ids: string[] = []
    for (let i = 0; i < 3; i++) ids.push((await threeRevisions(h)).id)
    const repo = new PgArtifactRepo(prisma)
    const batch = await repo.expiredRevisions(new Date(T0), 2)
    expect(batch).toHaveLength(2)
    expect(await repo.expiredRevisions(new Date(T0), 10)).toHaveLength(3)
  })
})

describe('deleting an organization', () => {
  it('removes its artifacts through the deletion reaper, objects first, and leaves other organizations alone', async () => {
    const h = harness()
    const kept = await threeRevisions(h)
    const orgId = `org-${randomUUID()}`
    await prisma.org.create({ data: { id: orgId, slug: orgId } })
    // Artifact rows carry no foreign key to their organization, so they can be written for it directly.
    const artifactId = randomUUID()
    await prisma.artifact.create({
      data: { id: artifactId, orgId, title: 'Gone', visibility: 'org', latestRevision: 2 }
    })
    const keys: string[] = []
    for (const number of [1, 2]) {
      const storagePrefix = artifactRevisionPrefix(orgId, artifactId, number)
      await prisma.artifactRevision.create({
        data: {
          id: randomUUID(),
          artifactId,
          number,
          manifest: manifestOf(['index.html', `v${number}`]) as never,
          storageMode: 'signed',
          storagePrefix,
          producedByAgentId: randomUUID(),
          producedByAgentName: 'agent',
          producedInSessionId: 'webchat:gone',
          totalBytes: 2,
          fileCount: 1,
          state: 'ready',
          idempotencyKey: `gone-${number}`
        }
      })
      keys.push(`${storagePrefix}/index.html`)
      h.objects.set(`${storagePrefix}/index.html`, { exists: true, contentLength: 2, checksumSha256: 'x' })
    }
    const emptyId = randomUUID()
    await prisma.artifact.create({ data: { id: emptyId, orgId, title: 'Empty', visibility: 'org' } })

    expect((await new PgOrgRepo(prisma).delete(orgId)).status).toBe('deleted')
    expect(await prisma.artifact.count({ where: { orgId } })).toBe(0)
    expect(await prisma.artifactRevision.count({ where: { artifactId } })).toBe(0)
    const records = await prisma.artifactDeletion.findMany({ where: { orgId }, orderBy: { id: 'asc' } })
    expect(records.map((r) => r.id).sort()).toEqual([artifactId, emptyId].sort())
    expect([...records.find((r) => r.id === artifactId)!.objectKeys].sort()).toEqual(keys.sort())

    // The first sweep deletes the objects; the record stays for one more after the upload URL lifetime.
    h.clock.now = Date.now()
    await h.service.reap()
    for (const key of keys) expect(h.objects.has(key)).toBe(false)
    expect(await prisma.artifactDeletion.count({ where: { orgId, sweptAt: { not: null } } })).toBe(2)
    h.clock.now = Date.now() + 2 * 60 * 60_000
    expect(await h.service.reap()).toBe(2)
    expect(await prisma.artifactDeletion.count({ where: { orgId } })).toBe(0)

    expect(await numbers(kept.id)).toEqual([1, 2, 3])
  })
})
