// Unfinished revision cleanup (artifacts.md §10.1): pending and closed revisions go once their PUTs expired plus the grace.
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { ArtifactManifest, ArtifactPublishBeginOk } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { agentAndSession, harness, hex, manifestOf, publish, T0 } from '../fixtures/artifacts.js'
import { ArtifactRefusal } from '../../src/artifacts/service.js'
import { unfinishedRevisionExpired } from '../../src/artifacts/retention.js'
import { PgArtifactRepo } from '../../src/persistence/index.js'
import { PgOrgSessionPolicyRepo } from '../../src/persistence/repositories/org-session-policy.repo.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

type Harness = ReturnType<typeof harness>

// The harness signs 900 s PUTs; the reaper waits that plus the 300 s grace.
const DELAY = (900 + 300) * 1000

const refusal = async (p: Promise<unknown>) => {
  const err = await p.catch((e: unknown) => e)
  expect(err).toBeInstanceOf(ArtifactRefusal)
  return err as ArtifactRefusal
}

const pending = (ok: ArtifactPublishBeginOk) => {
  if (ok.state !== 'pending') throw new Error('expected a pending revision')
  return ok
}

const keysOf = (h: Harness, artifactId: string, revision: number) =>
  [...h.objects.keys()].filter((k) => k.includes(`/${artifactId}/${revision}/`))

const numbers = async (artifactId: string) =>
  (await prisma.artifactRevision.findMany({ where: { artifactId }, orderBy: { number: 'asc' } })).map((r) => r.number)

async function setup(h: Harness = harness()) {
  const { agent, sessionId } = await agentAndSession()
  const begin = (
    extra: { artifactId?: string; baseRevision?: number; idempotencyKey?: string; manifest?: ArtifactManifest } = {}
  ) =>
    h.service.begin(DEFAULT_ORG_ID, agent, {
      agentId: agent.id,
      sessionId,
      ...(extra.artifactId ? { artifactId: extra.artifactId } : { title: 'Weekly report' }),
      ...(extra.baseRevision !== undefined ? { baseRevision: extra.baseRevision } : {}),
      manifest: extra.manifest ?? manifestOf(['index.html', '<p>draft</p>'], ['app.js', 'go()', 'text/javascript']),
      idempotencyKey: extra.idempotencyKey ?? `key-${randomUUID()}`,
      network: 'cluster'
    })
  const complete = (artifactId: string, revision: number) =>
    h.service.complete(DEFAULT_ORG_ID, { agentId: agent.id, artifactId, revision })
  return { h, agent, sessionId, begin, complete }
}

/** A ready revision 1 and a revision 2 refused at completion, both uploaded; the clock is still at T0. */
async function withClosed() {
  const s = await setup()
  const { artifactId } = await publish(s.h, s.agent, s.sessionId)
  const mine = pending(await s.begin({ artifactId, baseRevision: 1 }))
  const theirs = pending(await s.begin({ artifactId, baseRevision: 1, manifest: manifestOf(['index.html', 'v3']) }))
  s.h.upload(mine)
  s.h.upload(theirs)
  await s.complete(artifactId, theirs.revision)
  expect((await refusal(s.complete(artifactId, mine.revision))).reason).toBe('stale-base')
  return { ...s, artifactId }
}

describe('unfinished revision cleanup', () => {
  it('removes a closed revision once its PUTs expired plus the grace, objects first, and keeps the ready ones', async () => {
    const { h, artifactId } = await withClosed()
    const gone = keysOf(h, artifactId, 2)
    expect(gone).toHaveLength(2)

    h.clock.now = T0 + DELAY
    expect(await h.service.removeUnfinished()).toBe(0)
    expect(await numbers(artifactId)).toEqual([1, 2, 3])

    h.clock.now = T0 + DELAY + 1
    expect(await h.service.removeUnfinished()).toBe(1)
    expect(await numbers(artifactId)).toEqual([1, 3])
    expect(h.deletes.sort()).toEqual(gone.sort())
    expect(keysOf(h, artifactId, 1)).toHaveLength(1)
    expect(keysOf(h, artifactId, 3)).toHaveLength(1)
    // URLs signed for it have expired, so the first sweep is the last and its record is dropped.
    expect(await prisma.artifactDeletion.count()).toBe(0)
    expect(await prisma.artifact.findUniqueOrThrow({ where: { id: artifactId } })).toMatchObject({ latestRevision: 3 })
    expect(await h.service.removeUnfinished()).toBe(0)
  })

  it('removes an abandoned first revision with its never-ready artifact, and its completion is refused', async () => {
    const { h, begin, complete } = await setup()
    const begun = pending(await begin())
    h.upload(begun)
    // Only one of its two files landed; the sweep deletes every manifest key regardless.
    const signed = keysOf(h, begun.artifactId, 1)
    h.objects.delete(signed[0]!)

    h.clock.now = T0 + DELAY + 1
    expect(await h.service.removeUnfinished()).toBe(1)
    expect(await prisma.artifactRevision.count({ where: { artifactId: begun.artifactId } })).toBe(0)
    expect(await prisma.artifact.count({ where: { id: begun.artifactId } })).toBe(0)
    expect(h.deletes.sort()).toEqual(signed.sort())
    expect(keysOf(h, begun.artifactId, 1)).toEqual([])

    const err = await refusal(complete(begun.artifactId, 1))
    expect(err.reason).toBe('not-found')
  })

  it('removes an abandoned update and keeps its artifact, which still has a ready revision', async () => {
    const { h, agent, sessionId, begin, complete } = await setup()
    const { artifactId } = await publish(h, agent, sessionId)
    const begun = pending(await begin({ artifactId, baseRevision: 1 }))
    h.upload(begun)

    h.clock.now = T0 + DELAY + 1
    expect(await h.service.removeUnfinished()).toBe(1)
    expect(await numbers(artifactId)).toEqual([1])
    expect(keysOf(h, artifactId, 2)).toEqual([])
    expect(await prisma.artifact.findUniqueOrThrow({ where: { id: artifactId } })).toMatchObject({ latestRevision: 1 })
    expect((await refusal(complete(artifactId, 2))).reason).toBe('not-found')
  })

  it('counts from the last signing, so a pending revision a replay re-signed is not removed early', async () => {
    const { h, begin, complete } = await setup()
    const first = pending(await begin({ idempotencyKey: 'replayed-key-0001' }))

    const replayAt = T0 + 1_000_000
    h.clock.now = replayAt
    const replay = pending(await begin({ idempotencyKey: 'replayed-key-0001' }))
    expect([replay.artifactId, replay.revision]).toEqual([first.artifactId, 1])

    h.clock.now = T0 + DELAY + 1
    expect(await h.service.removeUnfinished()).toBe(0)
    h.clock.now = replayAt + DELAY
    expect(await h.service.removeUnfinished()).toBe(0)

    h.upload(replay)
    expect((await complete(replay.artifactId, 1)).revision).toBe(1)
    h.clock.now = replayAt + DELAY * 10
    expect(await h.service.removeUnfinished()).toBe(0)
    expect(await numbers(replay.artifactId)).toEqual([1])
  })

  it('never removes a ready revision however long ago its PUTs were signed', async () => {
    const { h, agent, sessionId } = await setup()
    const { artifactId } = await publish(h, agent, sessionId)
    await prisma.artifactRevision.updateMany({ where: { artifactId }, data: { uploadsSignedAt: new Date(0) } })
    expect(await new PgArtifactRepo(prisma).unfinishedRevisions(new Date(T0), 10)).toEqual([])
    h.clock.now = T0 + 365 * 24 * 3_600_000
    expect(await h.service.removeUnfinished()).toBe(0)
    expect(await numbers(artifactId)).toEqual([1])
  })

  it('re-decides under the lock, so a revision a replay re-signed after the scan is kept', async () => {
    const { begin } = await setup()
    const begun = pending(await begin())
    const repo = new PgArtifactRepo(prisma)
    const now = T0 + DELAY + 1
    const [key] = await repo.unfinishedRevisions(new Date(now - DELAY), 10)
    expect(key).toEqual({ orgId: DEFAULT_ORG_ID, artifactId: begun.artifactId, number: 1 })

    expect(await repo.touchUploads(DEFAULT_ORG_ID, begun.artifactId, 1, new Date(now))).toBe(true)
    const at = { deletedAt: new Date(now), purgeAfter: new Date(now) }
    expect(await repo.removeUnfinished(key!, at, (facts) => unfinishedRevisionExpired(facts, now, DELAY))).toBeNull()
    expect(await numbers(begun.artifactId)).toEqual([1])
    expect(await prisma.artifactDeletion.count()).toBe(0)
  })

  it('refuses a replay of a revision the reaper removed and signs no PUT for it', async () => {
    const { h, begin } = await setup()
    const begun = pending(await begin())
    const repo = new PgArtifactRepo(prisma)
    expect(await repo.touchUploads(DEFAULT_ORG_ID, begun.artifactId, 1, new Date(T0))).toBe(true)
    h.clock.now = T0 + DELAY + 1
    expect(await h.service.removeUnfinished()).toBe(1)
    expect(await repo.touchUploads(DEFAULT_ORG_ID, begun.artifactId, 1, new Date(h.clock.now))).toBe(false)
  })

  it('keeps the row gone and retries the objects when the bucket refuses them', async () => {
    const { h, artifactId } = await withClosed()
    const gone = keysOf(h, artifactId, 2)
    h.bucket.failDeletes = true
    h.clock.now = T0 + DELAY + 1
    expect(await h.service.removeUnfinished()).toBe(1)
    expect(await numbers(artifactId)).toEqual([1, 3])
    expect(keysOf(h, artifactId, 2)).toEqual(gone)
    const [record] = await prisma.artifactDeletion.findMany()
    expect(record).toMatchObject({ orgId: DEFAULT_ORG_ID, sweptAt: null })
    expect([...record!.objectKeys].sort()).toEqual(gone.sort())

    await expect(h.service.reap()).rejects.toThrow('bucket unavailable')
    expect(await prisma.artifactDeletion.count()).toBe(1)
    h.bucket.failDeletes = false
    expect(await h.service.reap()).toBe(1)
    expect(keysOf(h, artifactId, 2)).toEqual([])
    expect(await prisma.artifactDeletion.count()).toBe(0)
  })

  it('stops counting an abandoned revision toward the organization total once it is removed', async () => {
    const policies = new PgOrgSessionPolicyRepo(prisma)
    await policies.apply(DEFAULT_ORG_ID, {
      revision: 1,
      monthlySessionLimit: null,
      historyRetentionDays: null,
      enforce: false,
      artifactBytesLimit: 1000
    })
    const h = harness([], undefined, { orgBytesLimit: (orgId) => policies.artifactBytesLimit(orgId) })
    const { begin } = await setup(h)
    const sized = (bytes: number): ArtifactManifest => ({
      entry: 'f.bin',
      files: [{ path: 'f.bin', sha256: hex('f'), bytes, mediaType: 'application/octet-stream' }]
    })
    pending(await begin({ manifest: sized(800) }))
    expect((await refusal(begin({ manifest: sized(800) }))).reason).toBe('org-limit')

    h.clock.now = T0 + DELAY + 1
    expect(await h.service.removeUnfinished()).toBe(1)
    expect(pending(await begin({ manifest: sized(800) })).revision).toBe(1)
  })

  it('works through a backlog one bounded batch at a time, oldest signing first', async () => {
    const { h, begin } = await setup()
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      h.clock.now = T0 + i * 1000
      ids.push(pending(await begin()).artifactId)
    }
    const repo = new PgArtifactRepo(prisma)
    const cutoff = new Date(T0 + 10_000)
    expect((await repo.unfinishedRevisions(cutoff, 2)).map((k) => k.artifactId)).toEqual(ids.slice(0, 2))
    expect(await repo.unfinishedRevisions(cutoff, 10)).toHaveLength(3)
    expect(await repo.unfinishedRevisions(new Date(T0 + 1000), 10)).toHaveLength(1)
  })
})
