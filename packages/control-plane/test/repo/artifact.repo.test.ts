// Artifacts and revisions in PostgreSQL (artifacts.md §4): idempotent publish, revision numbering, and list predicates.
import { describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import {
  ArtifactIdempotencyConflictError,
  PgArtifactRepo,
  decodeArtifactCursor,
  encodeArtifactCursor
} from '../../src/persistence/repositories/artifact.repo.js'
import {
  agentCanReachArtifact,
  canViewArtifact,
  type ArtifactAudience,
  type ArtifactReachSession,
  type ArtifactViewer
} from '../../src/authorization/artifact-policy.js'
import type { ArtifactRecord, NewArtifactRevision } from '../../src/persistence/ports.js'

const ORG = 'org_artifacts'
const OTHER_ORG = 'org_elsewhere'
const AGENT = 'a1a1a1a1-1111-4111-8111-111111111111'
const AGENT_2 = 'a2a2a2a2-2222-4222-8222-222222222222'
const S1 = '51515151-1111-4111-8111-111111111111'
const S2 = '52525252-2222-4222-8222-222222222222'

const revision = (key: string, patch: Partial<NewArtifactRevision> = {}): NewArtifactRevision => ({
  manifest: {
    entry: 'index.html',
    files: [
      { path: 'index.html', sha256: 'a'.repeat(64), bytes: 120, mediaType: 'text/html' },
      { path: 'app.js', sha256: 'b'.repeat(64), bytes: 30, mediaType: 'text/javascript' }
    ]
  },
  storageMode: 'signed',
  storagePrefix: ({ artifactId, number }) => `src/${ORG}/artifact/${artifactId}/${number}/`,
  producedByAgentId: AGENT,
  producedByAgentName: 'Reporter',
  producedInSessionId: 'session-1',
  initiatedBy: 'user:alice',
  idempotencyKey: key,
  ...patch
})

const audience = (patch: Partial<ArtifactAudience> = {}): ArtifactAudience => ({
  orgId: ORG,
  visibility: 'org',
  ownerIdentity: null,
  externalProvider: null,
  externalScopeId: null,
  editorsAgentId: null,
  ...patch
})

const fresh = (patch: Partial<ArtifactAudience> = {}) => ({
  ...audience(patch),
  title: 'Weekly report',
  originSessionId: 'session-1'
})

describe('PgArtifactRepo (real Postgres)', () => {
  it('records a pending first revision, lists it only once ready, and replays a retried publish', async () => {
    const repo = new PgArtifactRepo(prisma)
    const first = await repo.create(fresh(), revision('k1'))
    expect(first.replayed).toBe(false)
    expect(first.artifact.latestRevision).toBe(0)
    expect(first.revision).toMatchObject({
      number: 1,
      state: 'pending',
      totalBytes: 150,
      fileCount: 2,
      storagePrefix: `src/${ORG}/artifact/${first.artifact.id}/1/`
    })
    const viewer: ArtifactViewer = { orgId: ORG, principal: { userId: 'u', role: 'viewer' }, identitySet: new Set() }
    expect(await repo.listVisible(viewer, { limit: 10 })).toEqual([])

    const ready = await repo.markReady(ORG, first.artifact.id, 1)
    expect(ready?.latestRevision).toBe(1)
    expect(await repo.markReady(ORG, first.artifact.id, 1)).toMatchObject({ latestRevision: 1 })
    expect((await repo.listVisible(viewer, { limit: 10 })).map((a) => a.id)).toEqual([first.artifact.id])

    const retried = await repo.create({ ...fresh(), title: 'ignored' }, revision('k1'))
    expect(retried.replayed).toBe(true)
    expect(retried.artifact.id).toBe(first.artifact.id)
    expect(retried.revision.id).toBe(first.revision.id)
    expect(await prisma.artifact.count()).toBe(1)
  })

  it('numbers appended revisions in order under concurrency and replays an append', async () => {
    const repo = new PgArtifactRepo(prisma)
    const { artifact } = await repo.create(fresh(), revision('c1'))
    const appended = await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((key) => repo.appendRevision(ORG, artifact.id, revision(key)))
    )
    expect(appended.map((r) => r!.revision.number).sort()).toEqual([2, 3, 4, 5, 6])
    const again = await repo.appendRevision(ORG, artifact.id, revision('c'))
    expect(again?.replayed).toBe(true)
    expect(again?.revision.id).toBe(appended[2]!.revision.id)
  })

  it('collapses concurrent first publishes with one key into one artifact', async () => {
    const repo = new PgArtifactRepo(prisma)
    const results = await Promise.all([1, 2, 3].map(() => repo.create(fresh(), revision('race'))))
    expect(new Set(results.map((r) => r.artifact.id)).size).toBe(1)
    expect(await prisma.artifact.count()).toBe(1)
  })

  it('refuses a key reused for another publication and an append to a missing or foreign artifact', async () => {
    const repo = new PgArtifactRepo(prisma)
    const one = await repo.create(fresh(), revision('x1'))
    const two = await repo.create(fresh(), revision('x2'))
    await repo.appendRevision(ORG, one.artifact.id, revision('x3'))
    await expect(repo.appendRevision(ORG, two.artifact.id, revision('x3'))).rejects.toBeInstanceOf(
      ArtifactIdempotencyConflictError
    )
    await expect(repo.create(fresh(), revision('x3'))).rejects.toBeInstanceOf(ArtifactIdempotencyConflictError)
    // Another agent's key space is its own.
    expect((await repo.create(fresh(), revision('x1', { producedByAgentId: AGENT_2 }))).replayed).toBe(false)
    expect(await repo.appendRevision(OTHER_ORG, one.artifact.id, revision('x4'))).toBeNull()
    expect(await repo.appendRevision(ORG, '00000000-0000-4000-8000-000000000000', revision('x5'))).toBeNull()
  })

  it('never moves latestRevision back and lists only ready revisions, newest first', async () => {
    const repo = new PgArtifactRepo(prisma)
    const { artifact } = await repo.create(fresh(), revision('r1'))
    await repo.appendRevision(ORG, artifact.id, revision('r2'))
    await repo.appendRevision(ORG, artifact.id, revision('r3'))
    await repo.markReady(ORG, artifact.id, 3)
    expect((await repo.markReady(ORG, artifact.id, 2))?.latestRevision).toBe(3)
    expect(await repo.markReady(OTHER_ORG, artifact.id, 1)).toBeNull()
    expect(await repo.markReady(ORG, artifact.id, 9)).toBeNull()
    expect((await repo.listRevisions(ORG, artifact.id)).map((r) => r.number)).toEqual([3, 2])
    expect(await repo.listRevisions(OTHER_ORG, artifact.id)).toEqual([])
    expect((await repo.getRevision(ORG, artifact.id, 1))?.state).toBe('pending')
    expect((await repo.getRevision(ORG, artifact.id, 2))?.manifest.entry).toBe('index.html')
  })

  it('renames, moves only between private and org, and deletes with its revisions', async () => {
    const repo = new PgArtifactRepo(prisma)
    const { artifact } = await repo.create(fresh({ ownerIdentity: 'user:alice' }), revision('m1'))
    expect((await repo.rename(ORG, artifact.id, 'Renamed'))?.title).toBe('Renamed')
    expect(await repo.rename(OTHER_ORG, artifact.id, 'Nope')).toBeNull()
    expect((await repo.setVisibility(ORG, artifact.id, 'private'))?.visibility).toBe('private')
    const scoped = await repo.create(
      fresh({ visibility: 'external', externalProvider: 'slack', externalScopeId: S1 }),
      revision('m2')
    )
    expect(await repo.setVisibility(ORG, scoped.artifact.id, 'org')).toBeNull()
    expect(await repo.delete(OTHER_ORG, artifact.id)).toBe(false)
    expect(await repo.delete(ORG, artifact.id)).toBe(true)
    expect(await repo.get(ORG, artifact.id)).toBeNull()
    expect(await prisma.artifactRevision.count({ where: { artifactId: artifact.id } })).toBe(0)
  })

  it('refuses an audience whose copied scope does not match its tier', async () => {
    const repo = new PgArtifactRepo(prisma)
    await expect(repo.create(fresh({ visibility: 'external' }), revision('s1'))).rejects.toThrow()
    await expect(repo.create(fresh({ visibility: 'editors' }), revision('s2'))).rejects.toThrow()
    await expect(repo.create(fresh({ visibility: 'org', editorsAgentId: AGENT }), revision('s3'))).rejects.toThrow()
  })

  it('lists exactly what canViewArtifact and agentCanReachArtifact admit, page by page', async () => {
    const repo = new PgArtifactRepo(prisma)
    const audiences: ArtifactAudience[] = [
      audience({ visibility: 'private', ownerIdentity: 'user:alice' }),
      audience({ visibility: 'private', ownerIdentity: 'slack:T1:UA' }),
      audience({ visibility: 'private' }),
      audience({ visibility: 'org', ownerIdentity: 'user:alice' }),
      audience({ visibility: 'org' }),
      audience({ visibility: 'external', externalProvider: 'slack', externalScopeId: S1 }),
      audience({ visibility: 'external', externalProvider: 'slack', externalScopeId: S2 }),
      audience({ visibility: 'editors', editorsAgentId: AGENT }),
      audience({ visibility: 'editors', editorsAgentId: AGENT_2 }),
      audience({ orgId: OTHER_ORG, visibility: 'org' })
    ]
    const stored: ArtifactRecord[] = []
    for (const [index, entry] of audiences.entries()) {
      const { artifact } = await repo.create(
        { ...entry, title: `a${index}`, originSessionId: null },
        revision(`v${index}`)
      )
      stored.push((await repo.markReady(entry.orgId, artifact.id, 1))!)
    }
    const access = (allowed: string[]) => ({
      policies: [{ provider: 'slack', readFenceRev: null }],
      allowedScopes: allowed.map((id) => ({ id, aclRevision: 0n })),
      decisionAt: new Date()
    })
    const viewers: ArtifactViewer[] = [
      {
        orgId: ORG,
        principal: { userId: 'alice', role: 'collaborator' },
        identitySet: new Set(['user:alice', 'slack:T1:UA'])
      },
      {
        orgId: ORG,
        principal: { userId: 'bob', role: 'collaborator' },
        identitySet: new Set(['user:bob']),
        externalAccess: access([S1]),
        editableAgentIds: new Set([AGENT])
      },
      { orgId: ORG, principal: { userId: 'olga', role: 'owner' }, identitySet: new Set(['user:olga']) },
      { orgId: OTHER_ORG, principal: { userId: 'alice', role: 'owner' }, identitySet: new Set(['user:alice']) }
    ]
    const sorted = (rows: ArtifactRecord[]) => rows.map((a) => a.id).sort()
    for (const viewer of viewers) {
      const expected = stored.filter((a) => canViewArtifact(a, viewer))
      expect(sorted(await repo.listVisible(viewer, { limit: 50 })), viewer.principal.userId).toEqual(sorted(expected))
    }
    const session = (patch: Partial<ArtifactReachSession>): ArtifactReachSession => ({
      orgId: ORG,
      agentId: AGENT,
      visibility: 'org',
      externalProvider: null,
      externalScopeId: null,
      externalResolution: null,
      ...patch
    })
    const reaches: Array<[ArtifactReachSession, ArtifactViewer | undefined]> = [
      [session({ visibility: 'private' }), viewers[0]],
      [session({ visibility: 'private' }), undefined],
      [session({}), undefined],
      [session({ visibility: 'editors' }), undefined],
      [
        session({
          visibility: 'external',
          externalProvider: 'slack',
          externalScopeId: S1,
          externalResolution: 'settled'
        }),
        undefined
      ],
      [
        session({
          visibility: 'external',
          externalProvider: 'slack',
          externalScopeId: S1,
          externalResolution: 'pending'
        }),
        undefined
      ]
    ]
    for (const [reach, owner] of reaches) {
      const expected = stored.filter((a) => agentCanReachArtifact(a, reach, owner))
      expect(sorted(await repo.listReachable(reach, owner, { limit: 50 })), reach.visibility).toEqual(sorted(expected))
    }

    const olga = viewers[2]!
    const all = await repo.listVisible(olga, { limit: 50 })
    const paged: ArtifactRecord[] = []
    let cursor: { updatedAt: Date; id: string } | undefined
    for (;;) {
      const page = await repo.listVisible(olga, { limit: 2, ...(cursor ? { cursor } : {}) })
      if (page.length === 0) break
      paged.push(...page)
      const last = page[page.length - 1]!
      cursor = { updatedAt: last.updatedAt, id: last.id }
    }
    expect(paged.map((a) => a.id)).toEqual(all.map((a) => a.id))
  })

  it('lists the artifacts with a ready revision produced in one session, newest activity first, page by page', async () => {
    const repo = new PgArtifactRepo(prisma)
    const ready = async (key: string, sessionId: string, org = ORG) => {
      const { artifact } = await repo.create(
        { ...fresh({ orgId: org }), originSessionId: sessionId },
        revision(key, { producedInSessionId: sessionId })
      )
      return (await repo.markReady(org, artifact.id, 1))!
    }
    const first = await ready('p1', 'session-a')
    const second = await ready('p2', 'session-a')
    const revisedHere = await ready('p3', 'session-b')
    await repo.appendRevision(ORG, revisedHere.id, revision('p3b', { producedInSessionId: 'session-a' }))
    await repo.markReady(ORG, revisedHere.id, 2)
    const pendingHere = await ready('p4', 'session-b')
    await repo.appendRevision(ORG, pendingHere.id, revision('p4b', { producedInSessionId: 'session-a' }))
    // Another organization's session with the same id, and an artifact whose only revision is still pending.
    await ready('p5', 'session-a', OTHER_ORG)
    await repo.create(fresh(), revision('p6', { producedInSessionId: 'session-a' }))
    const times = new Map([
      [first.id, '2026-11-25T10:00:03.000Z'],
      [second.id, '2026-11-25T10:00:01.000Z'],
      [revisedHere.id, '2026-11-25T10:00:02.000Z']
    ])
    for (const [id, at] of times) await prisma.artifact.update({ where: { id }, data: { updatedAt: new Date(at) } })

    const all = await repo.listProducedInSession(ORG, 'session-a', { limit: 10 })
    expect(all.map((a) => a.id)).toEqual([first.id, revisedHere.id, second.id])
    const paged: string[] = []
    let cursor: { updatedAt: Date; id: string } | undefined
    for (;;) {
      const page = await repo.listProducedInSession(ORG, 'session-a', { limit: 2, ...(cursor ? { cursor } : {}) })
      if (page.length === 0) break
      paged.push(...page.map((a) => a.id))
      const last = page[page.length - 1]!
      cursor = decodeArtifactCursor(encodeArtifactCursor(last))!
    }
    expect(paged).toEqual(all.map((a) => a.id))
    expect(await repo.listProducedInSession(ORG, 'session-none', { limit: 10 })).toEqual([])
    expect(decodeArtifactCursor('not-a-cursor')).toBeNull()
    const foreignId = Buffer.from(JSON.stringify([new Date().toISOString(), 'not-a-uuid'])).toString('base64url')
    expect(decodeArtifactCursor(foreignId)).toBeNull()
  })

  it('narrows a visible list by filter, names the audiences it holds, and updates only an unchanged audience', async () => {
    const repo = new PgArtifactRepo(prisma)
    const ready = async (key: string, patch: Partial<ArtifactAudience>, rev: Partial<NewArtifactRevision> = {}) => {
      const { artifact } = await repo.create(fresh(patch), revision(key, rev))
      return (await repo.markReady(ORG, artifact.id, 1))!
    }
    const alices = await ready('f1', { ownerIdentity: 'user:alice' })
    const scoped = await ready('f2', { visibility: 'external', externalProvider: 'slack', externalScopeId: S1 })
    await ready('f3', { visibility: 'external', externalProvider: 'slack', externalScopeId: S1 })
    const byAgent2 = await ready(
      'f4',
      { visibility: 'editors', editorsAgentId: AGENT_2 },
      { producedByAgentId: AGENT_2 }
    )
    await ready('f5', { visibility: 'private', ownerIdentity: 'user:bob' })
    await prisma.artifactShare.create({
      data: {
        id: '5ea5ea5e-1111-4111-8111-111111111111',
        orgId: ORG,
        artifactId: scoped.id,
        revisionNumber: 1,
        tokenHash: 'h'.repeat(64),
        displayTail: '…abcdef',
        audience: 'public',
        createdByIdentity: 'user:alice'
      }
    })
    const keys = await repo.audienceKeys(ORG)
    expect(keys).toEqual({ externalScopeIds: [S1], editorsAgentIds: [AGENT_2] })
    expect(await repo.audienceKeys(OTHER_ORG)).toEqual({ externalScopeIds: [], editorsAgentIds: [] })

    const olga: ArtifactViewer = {
      orgId: ORG,
      principal: { userId: 'olga', role: 'owner' },
      identitySet: new Set(['user:olga', 'user:alice']),
      externalAccess: {
        policies: [{ provider: 'slack', readFenceRev: null }],
        allowedScopes: [{ id: S1, aclRevision: 0n }],
        decisionAt: new Date()
      }
    }
    const ids = async (filter: Parameters<PgArtifactRepo['listVisible']>[2]) =>
      (await repo.listVisible(olga, { limit: 50 }, filter)).map((a) => a.id).sort()
    expect(await ids({ ownerIdentities: ['user:alice'] })).toEqual([alices.id])
    expect(await ids({ ownerIdentities: [] })).toEqual([])
    expect(await ids({ producedByAgentId: AGENT_2 })).toEqual([byAgent2.id])
    expect(await ids({ publiclyShared: true })).toEqual([scoped.id])
    // A filter never widens the audience: Bob's private artifact stays out.
    expect(await ids({ ownerIdentities: ['user:bob'] })).toEqual([])

    const latest = await repo.latestRevisions(ORG, [alices, scoped])
    expect(latest.map((r) => [r.artifactId, r.number]).sort()).toEqual(
      [
        [alices.id, 1],
        [scoped.id, 1]
      ].sort()
    )
    expect(await repo.latestRevisions(OTHER_ORG, [alices])).toEqual([])
    expect(await repo.latestRevisions(ORG, [])).toEqual([])

    const expected = { visibility: 'org' as const, ownerIdentity: 'user:alice' }
    const moved = await repo.update(ORG, alices.id, expected, { title: 'Renamed', visibility: 'private' })
    expect(moved).toMatchObject({ title: 'Renamed', visibility: 'private', ownerIdentity: 'user:alice' })
    // Decided against `org`, but it is `private` now: nothing changes.
    expect(await repo.update(ORG, alices.id, expected, { title: 'Stale' })).toBeNull()
    expect(await repo.update(OTHER_ORG, alices.id, { ...expected, visibility: 'private' }, { title: 'x' })).toBeNull()
    expect((await repo.get(ORG, alices.id))?.title).toBe('Renamed')
  })
})
