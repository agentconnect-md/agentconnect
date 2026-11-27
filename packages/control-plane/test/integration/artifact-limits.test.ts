// Publish limits (artifacts.md §5.6, §10.2): per-revision caps and the organization total, pending revisions included.
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { ARTIFACT_MAX_BYTES, ARTIFACT_MAX_FILES, type ArtifactManifest } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { agentAndSession, harness, hex } from '../fixtures/artifacts.js'
import { ArtifactRefusal } from '../../src/artifacts/service.js'
import { ArtifactOrgLimitError, PgArtifactRepo } from '../../src/persistence/repositories/artifact.repo.js'
import { PgOrgSessionPolicyRepo } from '../../src/persistence/repositories/org-session-policy.repo.js'
import type { AgentRecord, NewArtifactRevision } from '../../src/persistence/ports.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const policies = () => new PgOrgSessionPolicyRepo(prisma)
const limited = () => harness([], undefined, { orgBytesLimit: (orgId) => policies().artifactBytesLimit(orgId) })

const setLimit = (artifactBytesLimit: number | null, revision = 1) =>
  policies().apply(DEFAULT_ORG_ID, {
    revision,
    monthlySessionLimit: null,
    historyRetentionDays: null,
    enforce: false,
    artifactBytesLimit
  })

/** A manifest declaring these sizes; the CP checks declared sizes at begin, before any byte moves. */
const sized = (...sizes: number[]): ArtifactManifest => ({
  entry: 'f0.bin',
  files: sizes.map((bytes, i) => ({
    path: `f${i}.bin`,
    sha256: hex(`f${i}`),
    bytes,
    mediaType: 'application/octet-stream'
  }))
})

const begin = (
  h: ReturnType<typeof harness>,
  agent: AgentRecord,
  sessionId: string,
  manifest: ArtifactManifest,
  extra: { artifactId?: string; idempotencyKey?: string } = {}
) =>
  h.service.begin(DEFAULT_ORG_ID, agent, {
    agentId: agent.id,
    sessionId,
    ...(extra.artifactId ? { artifactId: extra.artifactId } : { title: 'Build output' }),
    manifest,
    idempotencyKey: extra.idempotencyKey ?? `key-${randomUUID()}`,
    network: 'cluster'
  })

const refusal = async (p: Promise<unknown>) => {
  const err = await p.catch((e: unknown) => e)
  expect(err).toBeInstanceOf(ArtifactRefusal)
  return err as ArtifactRefusal
}

describe('per-revision limits', () => {
  it('refuses more than 200 files at begin, naming the rule, and records nothing', async () => {
    const h = harness()
    const { agent, sessionId } = await agentAndSession()
    const many = sized(...Array.from({ length: ARTIFACT_MAX_FILES + 1 }, () => 1))
    const err = await refusal(begin(h, agent, sessionId, many))
    expect(err.reason).toBe('revision-limit')
    expect(err.code).toBe('BAD_PAYLOAD')
    expect(err.message).toBe('a revision holds at most 200 files, and this one has 201')
    expect(err.details).toEqual({ rule: 'files', limit: 200, actual: 201 })
    expect(await prisma.artifact.count()).toBe(0)
    const atLimit = sized(...Array.from({ length: ARTIFACT_MAX_FILES }, () => 1))
    expect((await begin(h, agent, sessionId, atLimit)).state).toBe('pending')
  })

  it('refuses more than 200 MB at begin and signs a revision of exactly 200 MB', async () => {
    const h = harness()
    const { agent, sessionId } = await agentAndSession()
    const err = await refusal(begin(h, agent, sessionId, sized(ARTIFACT_MAX_BYTES - 10, 11)))
    expect(err.reason).toBe('revision-limit')
    expect(err.message).toBe(`a revision holds at most 200 MB, and this one has ${ARTIFACT_MAX_BYTES + 1} bytes`)
    expect(err.details).toEqual({ rule: 'bytes', limit: ARTIFACT_MAX_BYTES, actual: ARTIFACT_MAX_BYTES + 1 })
    expect(await prisma.artifactRevision.count()).toBe(0)
    // One 200 MB file fits the default single-PUT size, so the whole revision is signed.
    const ok = await begin(h, agent, sessionId, sized(ARTIFACT_MAX_BYTES))
    if (ok.state !== 'pending') throw new Error('expected pending')
    expect(ok.uploads[0]!.headers['content-length']).toBe(String(ARTIFACT_MAX_BYTES))
  })
})

describe('organization total', () => {
  it('sets no total without a policy or with a null one', async () => {
    const h = limited()
    const { agent, sessionId } = await agentAndSession()
    expect((await begin(h, agent, sessionId, sized(ARTIFACT_MAX_BYTES))).state).toBe('pending')
    await setLimit(null)
    expect((await begin(h, agent, sessionId, sized(ARTIFACT_MAX_BYTES))).state).toBe('pending')
  })

  it('counts pending revisions, refuses a publish past the total, and admits one that lands exactly on it', async () => {
    const h = limited()
    const { agent, sessionId } = await agentAndSession()
    await setLimit(1000)
    const first = await begin(h, agent, sessionId, sized(600))
    if (first.state !== 'pending') throw new Error('expected pending')

    const over = await refusal(begin(h, agent, sessionId, sized(401)))
    expect(over.reason).toBe('org-limit')
    expect(over.code).toBe('CONFLICT')
    expect(over.retryable).toBe(false)
    expect(over.message).toBe(
      'the organization’s artifacts may hold at most 1000 bytes; 600 bytes are in use and this revision adds 401 bytes'
    )
    expect(over.details).toEqual({ limit: 1000, used: 600, bytes: 401 })
    // An append to an existing artifact is held to the same total.
    const append = await refusal(begin(h, agent, sessionId, sized(401), { artifactId: first.artifactId }))
    expect(append.reason).toBe('org-limit')

    expect((await begin(h, agent, sessionId, sized(400), { artifactId: first.artifactId })).state).toBe('pending')
    expect(await prisma.artifactRevision.count()).toBe(2)
  })

  it('answers a replayed key from its revision even once the total is reached', async () => {
    const h = limited()
    const { agent, sessionId } = await agentAndSession()
    await setLimit(1000)
    const first = await begin(h, agent, sessionId, sized(1000), { idempotencyKey: 'publish-full-0001' })
    if (first.state !== 'pending') throw new Error('expected pending')
    const again = await begin(h, agent, sessionId, sized(1000), { idempotencyKey: 'publish-full-0001' })
    expect(again).toMatchObject({ state: 'pending', artifactId: first.artifactId, revision: first.revision })
  })

  it('stops counting a revision once it is removed, and evicts nothing to make room', async () => {
    const h = limited()
    const { agent, sessionId } = await agentAndSession()
    await setLimit(1000)
    const first = await begin(h, agent, sessionId, sized(800))
    if (first.state !== 'pending') throw new Error('expected pending')
    expect((await refusal(begin(h, agent, sessionId, sized(300)))).reason).toBe('org-limit')
    expect(await prisma.artifactRevision.count()).toBe(1)
    const now = new Date()
    await new PgArtifactRepo(prisma).deleteRecording(DEFAULT_ORG_ID, first.artifactId, {
      deletedAt: now,
      purgeAfter: now
    })
    expect((await begin(h, agent, sessionId, sized(300))).state).toBe('pending')
  })

  it('stops counting a revision the retention sweep expired', async () => {
    const h = limited()
    const { agent, sessionId } = await agentAndSession()
    await setLimit(1000)
    const first = await begin(h, agent, sessionId, sized(700))
    if (first.state !== 'pending') throw new Error('expected pending')
    expect((await refusal(begin(h, agent, sessionId, sized(400), { artifactId: first.artifactId }))).reason).toBe(
      'org-limit'
    )
    const now = new Date()
    const expired = await new PgArtifactRepo(prisma).expireRecording(
      { orgId: DEFAULT_ORG_ID, artifactId: first.artifactId, number: first.revision },
      { deletedAt: now, purgeAfter: now },
      () => true
    )
    expect(expired).not.toBeNull()
    expect((await begin(h, agent, sessionId, sized(400))).state).toBe('pending')
  })

  it('lets exactly as many concurrent begins through as the total holds', async () => {
    const h = limited()
    const { agent, sessionId } = await agentAndSession()
    await setLimit(1000)
    const settled = await Promise.allSettled(Array.from({ length: 5 }, () => begin(h, agent, sessionId, sized(300))))
    const passed = settled.filter((s) => s.status === 'fulfilled')
    const refused = settled.flatMap((s) => (s.status === 'rejected' ? [s.reason as unknown] : []))
    expect(passed).toHaveLength(3)
    expect(refused).toHaveLength(2)
    for (const err of refused) expect(err).toMatchObject({ reason: 'org-limit' })
    const total = await prisma.artifactRevision.aggregate({ _sum: { totalBytes: true } })
    expect(total._sum.totalBytes).toBe(900)
  })
})

describe('PgArtifactRepo organization total lock', () => {
  const revision = (bytes: number): NewArtifactRevision => ({
    manifest: sized(bytes),
    storageMode: 'signed',
    storagePrefix: ({ artifactId, number }) => `src/${DEFAULT_ORG_ID}/artifact/${artifactId}/${number}/`,
    producedByAgentId: randomUUID(),
    producedByAgentName: 'Builder',
    producedInSessionId: 'session-1',
    initiatedBy: null,
    idempotencyKey: `key-${randomUUID()}`
  })
  const artifact = {
    orgId: DEFAULT_ORG_ID,
    title: 'Build output',
    ownerIdentity: null,
    visibility: 'org' as const,
    externalProvider: null,
    externalScopeId: null,
    editorsAgentId: null,
    originSessionId: 'session-1'
  }
  const limits = { orgBytesLimit: 1000 }

  /** Hold `first` in an open transaction until `second` queues on its locks, then commit and settle `second`. */
  const overlap = async (
    first: (repo: PgArtifactRepo) => Promise<unknown>,
    second: (repo: PgArtifactRepo) => Promise<unknown>
  ): Promise<unknown> => {
    let racing: Promise<unknown> | undefined
    await prisma.$transaction(async (tx) => {
      await first(new PgArtifactRepo(tx))
      racing = second(new PgArtifactRepo(prisma)).catch((e: unknown) => e)
      await vi.waitFor(
        async () => {
          const rows = await prisma.$queryRaw<Array<{ waiting: number }>>`
            SELECT count(*)::int AS "waiting" FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'`
          expect(rows[0]?.waiting ?? 0).toBeGreaterThanOrEqual(1)
        },
        { timeout: 20_000, interval: 10 }
      )
    })
    return await racing
  }

  it('makes a second begin wait for the first to commit, then counts its pending bytes', async () => {
    const err = await overlap(
      (repo) => repo.create(artifact, revision(600), limits),
      (repo) => repo.create(artifact, revision(600), limits)
    )
    expect(err).toBeInstanceOf(ArtifactOrgLimitError)
    expect(err).toMatchObject({ limit: 1000, used: 600, bytes: 600 })
    expect(await prisma.artifactRevision.count()).toBe(1)
  })

  it('answers a same-key begin that waited on the lock with the revision the first reserved, on create and append', async () => {
    const same = revision(600)
    const first = (await overlap(
      (repo) => repo.create(artifact, same, limits),
      (repo) => repo.create(artifact, same, limits)
    )) as { replayed: boolean; artifact: { id: string }; revision: { number: number } }
    expect(first).toMatchObject({ replayed: true, revision: { number: 1 } })

    const next = { ...revision(400), producedByAgentId: same.producedByAgentId }
    const appended = await overlap(
      (repo) => repo.appendRevision(DEFAULT_ORG_ID, first.artifact.id, next, limits),
      (repo) => repo.appendRevision(DEFAULT_ORG_ID, first.artifact.id, next, limits)
    )
    expect(appended).toMatchObject({ replayed: true, revision: { number: 2 } })
    expect(await prisma.artifactRevision.count()).toBe(2)
  })
})
