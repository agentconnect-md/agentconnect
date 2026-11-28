// Concurrent updates (artifacts.md §5.6): a base checked at begin and completion, replacements, retries and closed revisions.
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { ArtifactManifest, ArtifactPublishBeginOk } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { agentAndSession, harness, manifestOf } from '../fixtures/artifacts.js'
import { ArtifactRefusal } from '../../src/artifacts/service.js'
import { PgOrgSessionPolicyRepo } from '../../src/persistence/repositories/org-session-policy.repo.js'
import type { AgentRecord } from '../../src/persistence/ports.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

type Harness = ReturnType<typeof harness>
type Update = { baseRevision?: number; replace?: true; idempotencyKey?: string; manifest?: ArtifactManifest }

const V1 = manifestOf(['index.html', '<p>v1</p>'], ['style.css', 'body{}', 'text/css'])

const refusal = async (p: Promise<unknown>) => {
  const err = await p.catch((e: unknown) => e)
  expect(err).toBeInstanceOf(ArtifactRefusal)
  return err as ArtifactRefusal
}

const pending = (ok: ArtifactPublishBeginOk) => {
  if (ok.state !== 'pending') throw new Error('expected a pending revision')
  return ok
}

async function setup(h: Harness = harness()) {
  const { agent, sessionId } = await agentAndSession()
  const created = pending(
    await h.service.begin(DEFAULT_ORG_ID, agent, {
      agentId: agent.id,
      sessionId,
      title: 'Weekly report',
      manifest: V1,
      idempotencyKey: `key-${randomUUID()}`,
      network: 'cluster'
    })
  )
  h.upload(created)
  await complete(h, agent, created.artifactId, 1)
  const begin = (update: Update) =>
    h.service.begin(DEFAULT_ORG_ID, agent, {
      agentId: agent.id,
      sessionId,
      artifactId: created.artifactId,
      manifest: update.manifest ?? V1,
      idempotencyKey: update.idempotencyKey ?? `key-${randomUUID()}`,
      network: 'cluster',
      ...(update.baseRevision !== undefined ? { baseRevision: update.baseRevision } : {}),
      ...(update.replace ? { replace: true as const } : {})
    })
  const finish = (revision: number) => complete(h, agent, created.artifactId, revision)
  const publish = async (update: Update) => {
    const begun = pending(await begin(update))
    h.upload(begun)
    return await finish(begun.revision)
  }
  return { h, agent, artifactId: created.artifactId, begin, finish, publish }
}

const complete = (h: Harness, agent: AgentRecord, artifactId: string, revision: number) =>
  h.service.complete(DEFAULT_ORG_ID, { agentId: agent.id, artifactId, revision })

const revisionRow = (artifactId: string, number: number) =>
  prisma.artifactRevision.findUniqueOrThrow({ where: { artifactId_number: { artifactId, number } } })

describe('concurrent updates', () => {
  it('lets the first of two updates from one base win and refuses the second at completion with what changed', async () => {
    const { h, agent, artifactId, begin, finish } = await setup()
    const mine = pending(await begin({ baseRevision: 1, manifest: manifestOf(['index.html', '<p>mine</p>']) }))
    const theirs = pending(
      await begin({
        baseRevision: 1,
        manifest: manifestOf(['index.html', '<p>v1</p>'], ['style.css', 'body{color:red}', 'text/css'], ['b.js', 'x'])
      })
    )
    expect([mine.revision, theirs.revision]).toEqual([2, 3])
    h.upload(mine)
    h.upload(theirs)
    expect((await finish(theirs.revision)).revision).toBe(3)

    const err = await refusal(finish(mine.revision))
    expect(err.reason).toBe('stale-base')
    expect(err.code).toBe('CONFLICT')
    expect(err.retryable).toBe(false)
    expect(err.message).toContain('revision 3')
    expect(err.details).toEqual({
      baseRevision: 1,
      latest: {
        revision: 3,
        producedByAgentId: agent.id,
        producedByAgentName: agent.displayName ?? agent.name,
        createdAt: expect.any(String)
      },
      changes: { added: ['b.js'], changed: ['style.css'], removed: [], omitted: 0 }
    })
    expect(await revisionRow(artifactId, 2)).toMatchObject({ state: 'closed', idempotencyKey: null, baseRevision: 1 })
    expect((await prisma.artifact.findUniqueOrThrow({ where: { id: artifactId } })).latestRevision).toBe(3)
    // A repeated completion of the closed revision is refused the same way.
    expect((await refusal(finish(mine.revision))).details).toEqual(err.details)
  })

  it('lets exactly one of two updates from one base that complete at once become ready', async () => {
    const { h, artifactId, begin, finish } = await setup()
    const both = [pending(await begin({ baseRevision: 1 })), pending(await begin({ baseRevision: 1 }))]
    both.forEach(h.upload)
    const settled = await Promise.allSettled(both.map((b) => finish(b.revision)))
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1)
    const [lost] = settled.flatMap((s) => (s.status === 'rejected' ? [s.reason as unknown] : []))
    expect(lost).toMatchObject({ reason: 'stale-base' })
    const states = await prisma.artifactRevision.findMany({ where: { artifactId, number: { gt: 1 } } })
    expect(states.map((r) => r.state).sort()).toEqual(['closed', 'ready'])
  })

  it('refuses a stale base at begin before recording a revision or signing a PUT', async () => {
    const { artifactId, begin, publish } = await setup()
    await publish({ baseRevision: 1 })
    const err = await refusal(begin({ baseRevision: 1, manifest: manifestOf(['index.html', '<p>late</p>']) }))
    expect(err.reason).toBe('stale-base')
    expect(err.details).toMatchObject({ baseRevision: 1, latest: { revision: 2 } })
    // Revision 2 kept revision 1's manifest, so nothing changed between them.
    expect(err.details.changes).toEqual({ added: [], changed: [], removed: [], omitted: 0 })
    expect(await prisma.artifactRevision.count({ where: { artifactId } })).toBe(2)
    expect((await publish({ baseRevision: 2 })).revision).toBe(3)
  })

  it('accepts a replacement with no base, and treats a begin with neither mark as one', async () => {
    const { artifactId, publish } = await setup()
    await publish({ baseRevision: 1 })
    expect((await publish({ replace: true })).revision).toBe(3)
    // What a daemon older than §5.6 sends: no base and no mark.
    expect((await publish({})).revision).toBe(4)
    expect((await revisionRow(artifactId, 3)).baseRevision).toBeNull()
    expect((await revisionRow(artifactId, 4)).baseRevision).toBeNull()
  })

  it('refuses a replacement at completion once a higher revision is ready, describing only the latest', async () => {
    const { h, artifactId, begin, finish } = await setup()
    const replacement = pending(await begin({ replace: true }))
    const update = pending(await begin({ baseRevision: 1 }))
    h.upload(replacement)
    h.upload(update)
    await finish(update.revision)
    const err = await refusal(finish(replacement.revision))
    expect(err.reason).toBe('stale-base')
    expect(err.details).toEqual({ latest: expect.objectContaining({ revision: 3 }) })
    expect((await revisionRow(artifactId, 2)).state).toBe('closed')
  })

  it('makes a later replacement ready after an earlier one, so latestRevision keeps moving forward', async () => {
    const { h, artifactId, begin, finish } = await setup()
    const replacement = pending(await begin({ replace: true }))
    const old = pending(await begin({}))
    h.upload(replacement)
    h.upload(old)
    expect((await finish(replacement.revision)).revision).toBe(2)
    // A lower number never becomes ready after a higher one, so `latestRevision` only moves forward.
    expect((await finish(old.revision)).revision).toBe(3)
    expect((await prisma.artifact.findUniqueOrThrow({ where: { id: artifactId } })).latestRevision).toBe(3)
  })

  it('refuses a stale revision at completion as stale even before its files were uploaded', async () => {
    const { begin, finish, publish } = await setup()
    const late = pending(await begin({ baseRevision: 1 }))
    await publish({ baseRevision: 1 })
    expect((await refusal(finish(late.revision))).reason).toBe('stale-base')
  })

  it('answers a retried begin from its revision before any comparison', async () => {
    const { h, begin, finish, publish } = await setup()
    const done = pending(await begin({ baseRevision: 1, idempotencyKey: 'retry-done-0001' }))
    const waiting = pending(await begin({ baseRevision: 1, idempotencyKey: 'retry-wait-0001' }))
    h.upload(done)
    await finish(done.revision)
    await publish({ baseRevision: 2 })
    // Both bases are stale now, yet a retry still gets what its key recorded.
    expect(await begin({ baseRevision: 1, idempotencyKey: 'retry-done-0001' })).toMatchObject({
      state: 'ready',
      revision: done.revision
    })
    expect(await begin({ baseRevision: 1, idempotencyKey: 'retry-wait-0001' })).toMatchObject({
      state: 'pending',
      revision: waiting.revision
    })
    // The key names one publication, base included.
    const other = await refusal(begin({ baseRevision: 3, idempotencyKey: 'retry-done-0001' }))
    expect(other.reason).toBe('idempotency-conflict')
  })

  it('releases a refused revision’s key, so the same content starts a new revision', async () => {
    const { h, artifactId, begin, finish, publish } = await setup()
    const mine = pending(await begin({ baseRevision: 1, idempotencyKey: 'refused-key-0001' }))
    h.upload(mine)
    await publish({ baseRevision: 1 })
    expect((await refusal(finish(mine.revision))).reason).toBe('stale-base')
    // The same key on the same stale base is a new attempt, refused at begin instead of replaying the closed one.
    expect((await refusal(begin({ baseRevision: 1, idempotencyKey: 'refused-key-0001' }))).reason).toBe('stale-base')
    const retried = pending(await begin({ baseRevision: 3, idempotencyKey: 'refused-key-0001' }))
    expect(retried.revision).toBe(4)
    h.upload(retried)
    expect((await finish(retried.revision)).revision).toBe(4)
    expect(await prisma.artifactRevision.count({ where: { artifactId, state: 'closed' } })).toBe(1)
  })

  it('describes only the latest when the base is no longer kept', async () => {
    const { artifactId, begin, publish } = await setup()
    await publish({ baseRevision: 1 })
    await publish({ baseRevision: 2 })
    await prisma.artifactRevision.deleteMany({ where: { artifactId, number: { in: [1, 2] } } })
    const err = await refusal(begin({ baseRevision: 2 }))
    expect(err.reason).toBe('stale-base')
    expect(err.details).toEqual({ baseRevision: 2, latest: expect.objectContaining({ revision: 3 }) })
  })

  it('refuses a base on an artifact with no ready revision as not found', async () => {
    const h = harness()
    const { agent, sessionId } = await agentAndSession()
    const first = pending(
      await h.service.begin(DEFAULT_ORG_ID, agent, {
        agentId: agent.id,
        sessionId,
        title: 'Draft',
        manifest: V1,
        idempotencyKey: `key-${randomUUID()}`,
        network: 'cluster'
      })
    )
    const err = await refusal(
      h.service.begin(DEFAULT_ORG_ID, agent, {
        agentId: agent.id,
        sessionId,
        artifactId: first.artifactId,
        baseRevision: 1,
        manifest: V1,
        idempotencyKey: `key-${randomUUID()}`,
        network: 'cluster'
      })
    )
    expect(err.reason).toBe('not-found')
  })

  it('stops counting a closed revision toward the organization total', async () => {
    const policies = new PgOrgSessionPolicyRepo(prisma)
    const h = harness([], undefined, { orgBytesLimit: (orgId) => policies.artifactBytesLimit(orgId) })
    const { begin, finish } = await setup(h)
    const v1Bytes = V1.files.reduce((sum, f) => sum + f.bytes, 0)
    const sized = (bytes: number) => ({
      entry: 'f.bin',
      files: [{ path: 'f.bin', sha256: 'c'.repeat(64), bytes, mediaType: 'application/octet-stream' }]
    })
    await policies.apply(DEFAULT_ORG_ID, {
      revision: 1,
      monthlySessionLimit: null,
      historyRetentionDays: null,
      enforce: false,
      artifactBytesLimit: v1Bytes + 1000
    })
    const winner = pending(await begin({ baseRevision: 1, manifest: manifestOf(['index.html', 'w']) }))
    const loser = pending(await begin({ baseRevision: 1, manifest: sized(900) }))
    expect((await refusal(begin({ replace: true, manifest: sized(100) }))).reason).toBe('org-limit')
    h.upload(winner)
    await finish(winner.revision)
    expect((await refusal(finish(loser.revision))).reason).toBe('stale-base')
    expect((await begin({ replace: true, manifest: sized(900) })).state).toBe('pending')
  })
})
