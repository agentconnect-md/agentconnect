// PgArtifactRepo — artifacts and their revisions (artifacts.md §4); metadata only, the bytes live in the transfer bucket.
import { randomUUID } from 'node:crypto'
import type { Artifact, ArtifactRevision } from '../../generated/prisma/client.js'
import { Prisma } from '../../generated/prisma/client.js'
import type { ArtifactAudience, ArtifactReachSession, ArtifactViewer } from '../../authorization/artifact-policy.js'
import { withAmbientTx, type PrismaLike } from '../prisma.js'
import type {
  ArtifactAudienceKeys,
  ArtifactChange,
  ArtifactListFilter,
  ArtifactManifest,
  ArtifactPageQuery,
  ArtifactPublishResult,
  ArtifactRecord,
  ArtifactRepo,
  ArtifactRevisionRecord,
  NewArtifact,
  NewArtifactRevision
} from '../ports.js'

/** An idempotency key the agent already used for a different publication. */
export class ArtifactIdempotencyConflictError extends Error {
  constructor() {
    super('artifact idempotency key already recorded for another publication')
    this.name = 'ArtifactIdempotencyConflictError'
  }
}

export function toArtifact(row: Artifact): ArtifactRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    title: row.title,
    ownerIdentity: row.ownerIdentity,
    visibility: row.visibility,
    externalProvider: row.externalProvider,
    externalScopeId: row.externalScopeId,
    editorsAgentId: row.editorsAgentId,
    originSessionId: row.originSessionId,
    latestRevision: row.latestRevision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

function toRevision(row: ArtifactRevision): ArtifactRevisionRecord {
  return {
    id: row.id,
    artifactId: row.artifactId,
    number: row.number,
    manifest: row.manifest as unknown as ArtifactManifest,
    storageMode: row.storageMode,
    storagePrefix: row.storagePrefix,
    producedByAgentId: row.producedByAgentId,
    producedByAgentName: row.producedByAgentName,
    producedInSessionId: row.producedInSessionId,
    initiatedBy: row.initiatedBy,
    totalBytes: row.totalBytes,
    fileCount: row.fileCount,
    state: row.state,
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt
  }
}

function revisionData(revision: NewArtifactRevision, artifactId: string, number: number) {
  return {
    id: randomUUID(),
    artifactId,
    number,
    manifest: revision.manifest as unknown as Prisma.InputJsonValue,
    storageMode: revision.storageMode,
    storagePrefix: revision.storagePrefix({ artifactId, number }),
    producedByAgentId: revision.producedByAgentId,
    producedByAgentName: revision.producedByAgentName,
    producedInSessionId: revision.producedInSessionId,
    initiatedBy: revision.initiatedBy,
    totalBytes: revision.manifest.files.reduce((sum, file) => sum + file.bytes, 0),
    fileCount: revision.manifest.files.length,
    idempotencyKey: revision.idempotencyKey
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The opaque list cursor: the last row's `updatedAt` and id, in the order every artifact list pages by. */
export function encodeArtifactCursor(row: Pick<ArtifactRecord, 'updatedAt' | 'id'>): string {
  return Buffer.from(JSON.stringify([row.updatedAt.toISOString(), row.id]), 'utf8').toString('base64url')
}

/** The position an `encodeArtifactCursor` cursor names; null for anything this control plane did not issue. */
export function decodeArtifactCursor(cursor: string): NonNullable<ArtifactPageQuery['cursor']> | null {
  try {
    const [at, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as [unknown, unknown]
    const updatedAt = new Date(String(at))
    // The id is compared against a uuid column, so anything else would fail in SQL rather than read as a bad cursor.
    return typeof id === 'string' && UUID.test(id) && !Number.isNaN(updatedAt.getTime()) ? { updatedAt, id } : null
  } catch {
    return null
  }
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
}

/** The SQL projection of `canViewArtifact`; the integration test holds the two to the same truth table. */
export function artifactViewWhere(viewer: ArtifactViewer): Prisma.ArtifactWhereInput {
  const arms: Prisma.ArtifactWhereInput[] = [{ visibility: 'org' }]
  const identities = [...viewer.identitySet]
  if (identities.length > 0) arms.push({ visibility: 'private', ownerIdentity: { in: identities } })
  if (viewer.principal.role === 'owner') {
    arms.push({ visibility: 'private', ownerIdentity: null }, { visibility: 'editors' })
  } else if (viewer.editableAgentIds && viewer.editableAgentIds.size > 0) {
    arms.push({ visibility: 'editors', editorsAgentId: { in: [...viewer.editableAgentIds] } })
  }
  const providers = viewer.externalAccess?.policies.map((policy) => policy.provider) ?? []
  const scopes = viewer.externalAccess?.allowedScopes.map((scope) => scope.id) ?? []
  if (providers.length > 0 && scopes.length > 0) {
    arms.push({ visibility: 'external', externalProvider: { in: providers }, externalScopeId: { in: scopes } })
  }
  return { orgId: viewer.orgId, OR: arms }
}

/** `ArtifactListFilter` as SQL, ANDed onto the audience predicate. */
export function artifactFilterWhere(filter: ArtifactListFilter): Prisma.ArtifactWhereInput[] {
  const where: Prisma.ArtifactWhereInput[] = []
  if (filter.ownerIdentities) where.push({ ownerIdentity: { in: [...filter.ownerIdentities] } })
  if (filter.producedByAgentId) {
    where.push({ revisions: { some: { producedByAgentId: filter.producedByAgentId, state: 'ready' } } })
  }
  if (filter.publiclyShared) where.push({ shares: { some: { audience: 'public', revokedAt: null } } })
  return where
}

/** The SQL projection of `agentCanReachArtifact`; null when the session reaches nothing. */
export function artifactReachWhere(
  session: ArtifactReachSession,
  sessionOwner: ArtifactViewer | undefined
): Prisma.ArtifactWhereInput | null {
  switch (session.visibility) {
    case 'private':
      return sessionOwner && sessionOwner.orgId === session.orgId ? artifactViewWhere(sessionOwner) : null
    case 'org':
      return { orgId: session.orgId, visibility: 'org' }
    case 'editors':
      return {
        orgId: session.orgId,
        OR: [{ visibility: 'org' }, { visibility: 'editors', editorsAgentId: session.agentId }]
      }
    case 'external':
      if (session.externalResolution !== 'settled' || !session.externalProvider || !session.externalScopeId) return null
      return {
        orgId: session.orgId,
        visibility: 'external',
        externalProvider: session.externalProvider,
        externalScopeId: session.externalScopeId
      }
  }
}

/** A `user:` owner who is no longer a member owns nothing new (§6.3); the key-share lock orders this against a removal. */
async function memberOwnerIdentity(tx: PrismaLike, orgId: string, ownerIdentity: string | null) {
  if (!ownerIdentity?.startsWith('user:')) return ownerIdentity
  const member = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "membership" WHERE "orgId" = ${orgId} AND "userId" = ${ownerIdentity.slice('user:'.length)}
    FOR KEY SHARE`
  return member.length > 0 ? ownerIdentity : null
}

export class PgArtifactRepo implements ArtifactRepo {
  constructor(private readonly db: PrismaLike) {}

  /** What an agent already recorded under a key, with its artifact. */
  private async replay(revision: NewArtifactRevision): Promise<ArtifactPublishResult | null> {
    const row = await this.db.artifactRevision.findUnique({
      where: {
        producedByAgentId_idempotencyKey: {
          producedByAgentId: revision.producedByAgentId,
          idempotencyKey: revision.idempotencyKey
        }
      },
      include: { artifact: true }
    })
    if (!row) return null
    const { artifact, ...rest } = row
    return { artifact: toArtifact(artifact), revision: toRevision(rest), replayed: true }
  }

  private async replayFor(
    revision: NewArtifactRevision,
    matches: (found: ArtifactPublishResult) => boolean
  ): Promise<ArtifactPublishResult | null> {
    const found = await this.replay(revision)
    if (found && !matches(found)) throw new ArtifactIdempotencyConflictError()
    return found
  }

  async create(artifact: NewArtifact, revision: NewArtifactRevision): Promise<ArtifactPublishResult> {
    // A first publish's replay must be the revision 1 of an artifact, never a later append.
    const isFirst = (found: ArtifactPublishResult) => found.revision.number === 1
    const replayed = await this.replayFor(revision, isFirst)
    if (replayed) return replayed
    const id = randomUUID()
    try {
      return await withAmbientTx(this.db, async (tx) => {
        const created = await tx.artifact.create({
          data: {
            id,
            orgId: artifact.orgId,
            title: artifact.title,
            ownerIdentity: await memberOwnerIdentity(tx, artifact.orgId, artifact.ownerIdentity),
            visibility: artifact.visibility,
            externalProvider: artifact.externalProvider,
            externalScopeId: artifact.externalScopeId,
            editorsAgentId: artifact.editorsAgentId,
            originSessionId: artifact.originSessionId
          }
        })
        const first = await tx.artifactRevision.create({ data: revisionData(revision, id, 1) })
        return { artifact: toArtifact(created), revision: toRevision(first), replayed: false }
      })
    } catch (err) {
      if (!isUniqueViolation(err)) throw err
      const raced = await this.replayFor(revision, isFirst)
      if (raced) return raced
      throw err
    }
  }

  async appendRevision(
    orgId: string,
    artifactId: string,
    revision: NewArtifactRevision
  ): Promise<ArtifactPublishResult | null> {
    const sameArtifact = (found: ArtifactPublishResult) =>
      found.artifact.id === artifactId && found.artifact.orgId === orgId
    const replayed = await this.replayFor(revision, sameArtifact)
    if (replayed) return replayed
    try {
      return await withAmbientTx(this.db, async (tx) => {
        // The row lock serializes number allocation between concurrent publishes to one artifact.
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "artifact" WHERE "id" = ${artifactId}::uuid AND "orgId" = ${orgId} FOR UPDATE`
        if (locked.length === 0) return null
        const top = await tx.artifactRevision.aggregate({ where: { artifactId }, _max: { number: true } })
        const appended = await tx.artifactRevision.create({
          data: revisionData(revision, artifactId, (top._max.number ?? 0) + 1)
        })
        const current = await tx.artifact.findUniqueOrThrow({ where: { id: artifactId } })
        return { artifact: toArtifact(current), revision: toRevision(appended), replayed: false }
      })
    } catch (err) {
      if (!isUniqueViolation(err)) throw err
      const raced = await this.replayFor(revision, sameArtifact)
      if (raced) return raced
      throw err
    }
  }

  async markReady(orgId: string, artifactId: string, number: number): Promise<ArtifactRecord | null> {
    return withAmbientTx(this.db, async (tx) => {
      const marked = await tx.artifactRevision.updateMany({
        where: { artifactId, number, artifact: { orgId } },
        data: { state: 'ready' }
      })
      if (marked.count === 0) return null
      // A late older revision never moves `latestRevision` back.
      await tx.$executeRaw`
        UPDATE "artifact" SET "latestRevision" = ${number}, "updatedAt" = now()
        WHERE "id" = ${artifactId}::uuid AND "latestRevision" < ${number}`
      const row = await tx.artifact.findUnique({ where: { id: artifactId } })
      return row ? toArtifact(row) : null
    })
  }

  async get(orgId: string, id: string): Promise<ArtifactRecord | null> {
    const row = await this.db.artifact.findFirst({ where: { id, orgId } })
    return row ? toArtifact(row) : null
  }

  async getRevision(orgId: string, artifactId: string, number: number): Promise<ArtifactRevisionRecord | null> {
    const row = await this.db.artifactRevision.findFirst({ where: { artifactId, number, artifact: { orgId } } })
    return row ? toRevision(row) : null
  }

  async listRevisions(orgId: string, artifactId: string): Promise<ArtifactRevisionRecord[]> {
    const rows = await this.db.artifactRevision.findMany({
      where: { artifactId, state: 'ready', artifact: { orgId } },
      orderBy: { number: 'desc' }
    })
    return rows.map(toRevision)
  }

  async rename(orgId: string, id: string, title: string): Promise<ArtifactRecord | null> {
    return this.updateWhere({ id, orgId }, { title })
  }

  async setVisibility(orgId: string, id: string, visibility: 'private' | 'org'): Promise<ArtifactRecord | null> {
    return this.updateWhere({ id, orgId, visibility: { in: ['private', 'org'] } }, { visibility })
  }

  async update(
    orgId: string,
    id: string,
    expected: Pick<ArtifactAudience, 'visibility' | 'ownerIdentity'>,
    change: ArtifactChange
  ): Promise<ArtifactRecord | null> {
    return this.updateWhere(
      { id, orgId, visibility: expected.visibility, ownerIdentity: expected.ownerIdentity },
      {
        ...(change.title !== undefined ? { title: change.title } : {}),
        ...(change.visibility !== undefined ? { visibility: change.visibility } : {})
      }
    )
  }

  async delete(orgId: string, id: string): Promise<boolean> {
    const deleted = await this.db.artifact.deleteMany({ where: { id, orgId } })
    return deleted.count > 0
  }

  async listVisible(
    viewer: ArtifactViewer,
    page: ArtifactPageQuery,
    filter: ArtifactListFilter = {}
  ): Promise<ArtifactRecord[]> {
    return this.page({ AND: [artifactViewWhere(viewer), ...artifactFilterWhere(filter)] }, page)
  }

  async audienceKeys(orgId: string): Promise<ArtifactAudienceKeys> {
    const [external, editors] = await Promise.all([
      this.db.artifact.findMany({
        where: { orgId, visibility: 'external', externalScopeId: { not: null } },
        select: { externalScopeId: true },
        distinct: ['externalScopeId']
      }),
      this.db.artifact.findMany({
        where: { orgId, visibility: 'editors', editorsAgentId: { not: null } },
        select: { editorsAgentId: true },
        distinct: ['editorsAgentId']
      })
    ])
    return {
      externalScopeIds: external.flatMap((row) => (row.externalScopeId ? [row.externalScopeId] : [])),
      editorsAgentIds: editors.flatMap((row) => (row.editorsAgentId ? [row.editorsAgentId] : []))
    }
  }

  async latestRevisions(
    orgId: string,
    artifacts: ReadonlyArray<Pick<ArtifactRecord, 'id' | 'latestRevision'>>
  ): Promise<ArtifactRevisionRecord[]> {
    if (artifacts.length === 0) return []
    const rows = await this.db.artifactRevision.findMany({
      where: {
        artifact: { orgId },
        OR: artifacts.map((artifact) => ({ artifactId: artifact.id, number: artifact.latestRevision }))
      }
    })
    return rows.map(toRevision)
  }

  async listReachable(
    session: ArtifactReachSession,
    sessionOwner: ArtifactViewer | undefined,
    page: ArtifactPageQuery
  ): Promise<ArtifactRecord[]> {
    const where = artifactReachWhere(session, sessionOwner)
    return where ? this.page(where, page) : []
  }

  async listProducedInSession(orgId: string, sessionId: string, page: ArtifactPageQuery): Promise<ArtifactRecord[]> {
    return this.page({ orgId, revisions: { some: { producedInSessionId: sessionId, state: 'ready' } } }, page)
  }

  private async updateWhere(
    where: Prisma.ArtifactWhereInput,
    data: Prisma.ArtifactUpdateManyMutationInput
  ): Promise<ArtifactRecord | null> {
    const updated = await this.db.artifact.updateManyAndReturn({ where, data: { ...data, updatedAt: new Date() } })
    return updated[0] ? toArtifact(updated[0]) : null
  }

  private async page(where: Prisma.ArtifactWhereInput, page: ArtifactPageQuery): Promise<ArtifactRecord[]> {
    const cursor = page.cursor
    const rows = await this.db.artifact.findMany({
      where: {
        AND: [
          where,
          // An artifact whose first revision is still uploading is not listed.
          { latestRevision: { gt: 0 } },
          ...(cursor
            ? [
                {
                  OR: [{ updatedAt: { lt: cursor.updatedAt } }, { updatedAt: cursor.updatedAt, id: { lt: cursor.id } }]
                }
              ]
            : [])
        ]
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: page.limit
    })
    return rows.map(toArtifact)
  }
}
