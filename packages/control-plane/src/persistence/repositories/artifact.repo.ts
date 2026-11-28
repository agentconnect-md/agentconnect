// PgArtifactRepo — artifacts and their revisions (artifacts.md §4); metadata only, the bytes live in the transfer bucket.
import { randomUUID } from 'node:crypto'
import { SOURCE_CACHE_GRACE_SECONDS } from '@agentconnect.md/object-store'
import type { Artifact, ArtifactDeletion, ArtifactRevision } from '../../generated/prisma/client.js'
import { Prisma } from '../../generated/prisma/client.js'
import type { ArtifactAudience, ArtifactReachSession, ArtifactViewer } from '../../authorization/artifact-policy.js'
import { withAmbientTx, type PrismaLike } from '../prisma.js'
import type {
  ArtifactAudienceKeys,
  ArtifactChange,
  ArtifactCompletion,
  ArtifactDeletionRecord,
  ArtifactListFilter,
  ArtifactManifest,
  ArtifactPageQuery,
  ArtifactPublishLimits,
  ArtifactPublishResult,
  ArtifactRecord,
  ArtifactRepo,
  ArtifactRevisionKey,
  ArtifactRevisionRecord,
  NewArtifact,
  NewArtifactRevision
} from '../ports.js'
import type { RevisionRetentionFacts } from '../../artifacts/retention.js'

/** An idempotency key the agent already used for a different publication. */
export class ArtifactIdempotencyConflictError extends Error {
  constructor() {
    super('artifact idempotency key already recorded for another publication')
    this.name = 'ArtifactIdempotencyConflictError'
  }
}

/** An update's base is no longer the newest ready revision, checked at begin under the artifact's row lock (artifacts.md §5.6). */
export class ArtifactStaleBaseError extends Error {
  constructor(readonly latestRevision: number) {
    super('the base revision is no longer the latest')
    this.name = 'ArtifactStaleBaseError'
  }
}

/** A new revision would take the organization past its artifact total (artifacts.md §10.2). */
export class ArtifactOrgLimitError extends Error {
  constructor(
    readonly limit: number,
    readonly used: number,
    readonly bytes: number
  ) {
    super('the organization artifact total would be exceeded')
    this.name = 'ArtifactOrgLimitError'
  }
}

/** Under the org's lock until commit, so concurrent publishes see each other's pending bytes; throws past the limit. */
async function holdOrgTotal(tx: PrismaLike, orgId: string, bytes: number, limits?: ArtifactPublishLimits) {
  const limit = limits?.orgBytesLimit ?? null
  if (limit === null) return
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['artifact-org-total', orgId])}, 0))`
  // Live revisions only: an expired or deleted one has left these rows and a closed one stops counting (§5.6, §10.1).
  const rows = await tx.$queryRaw<Array<{ used: bigint | null }>>`
    SELECT SUM(r."totalBytes") AS "used" FROM "artifact_revision" r
    JOIN "artifact" a ON a."id" = r."artifactId"
    WHERE a."orgId" = ${orgId} AND r."state" IN ('pending', 'ready')`
  const used = Number(rows[0]?.used ?? 0)
  if (used + bytes > limit) throw new ArtifactOrgLimitError(limit, used, bytes)
}

const manifestBytes = (manifest: ArtifactManifest): number => manifest.files.reduce((sum, file) => sum + file.bytes, 0)

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
    baseRevision: row.baseRevision,
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt
  }
}

function toDeletion(row: ArtifactDeletion): ArtifactDeletionRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    objectKeys: row.objectKeys,
    deletedAt: row.deletedAt,
    purgeAfter: row.purgeAfter,
    sweptAt: row.sweptAt
  }
}

/** The publishing daemon's `sessions.retention` now, snapshotted beside the revision for after the daemon is gone. */
async function daemonRetention(tx: PrismaLike, daemonId: string | undefined): Promise<string | null> {
  if (!daemonId) return null
  const daemon = await tx.daemon.findUnique({ where: { id: daemonId }, select: { sessionRetention: true } })
  return daemon?.sessionRetention ?? null
}

function revisionData(
  revision: NewArtifactRevision,
  artifactId: string,
  number: number,
  publishedRetention: string | null
) {
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
    publishedByDaemonId: revision.publishedByDaemonId ?? null,
    publishedRetention,
    totalBytes: manifestBytes(revision.manifest),
    fileCount: revision.manifest.files.length,
    baseRevision: revision.baseRevision,
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

/** A revision's object keys: each manifest path under its storage prefix. */
const objectKeysOf = (revision: Pick<ArtifactRevision, 'storagePrefix' | 'manifest'>): string[] =>
  (revision.manifest as unknown as ArtifactManifest).files.map((file) => `${revision.storagePrefix}/${file.path}`)

/** The day count in a `sessions.retention` value; `never` and anything malformed match nothing and keep the revision. */
const RETENTION_DAYS_SQL = '^([1-9][0-9]{0,3})d$'
/** One day, the shortest `sessions.retention`, which bounds the scan by the creation index. */
const SHORTEST_RETENTION_MS = 24 * 60 * 60_000

/** The longest upload URL lifetime the transfer config admits plus the grace, so a deletion's last sweep follows every PUT. */
export const ARTIFACT_PURGE_DELAY_MAX_MS = (3600 + SOURCE_CACHE_GRACE_SECONDS) * 1000

/** Record every artifact of a deleted organization for the reaper and delete their rows, in the caller's transaction. */
export async function recordOrgArtifactDeletions(
  tx: PrismaLike,
  orgId: string,
  at: { deletedAt: Date; purgeAfter: Date }
): Promise<number> {
  const recorded = await tx.$executeRaw`
    INSERT INTO "artifact_deletion" ("id", "orgId", "objectKeys", "deletedAt", "purgeAfter")
    SELECT a."id", a."orgId",
           COALESCE(array_agg(r."storagePrefix" || '/' || (f.file ->> 'path')) FILTER (WHERE f.file IS NOT NULL), '{}'),
           ${at.deletedAt}, ${at.purgeAfter}
    FROM "artifact" a
    LEFT JOIN "artifact_revision" r ON r."artifactId" = a."id"
    LEFT JOIN LATERAL jsonb_array_elements(r."manifest" -> 'files') AS f(file) ON true
    WHERE a."orgId" = ${orgId}
    GROUP BY a."id", a."orgId"
    ON CONFLICT ("id") DO NOTHING`
  // Revisions and shares cascade, so no link of the organization's artifacts opens from here on.
  await tx.artifact.deleteMany({ where: { orgId } })
  return recorded
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

  async create(
    artifact: NewArtifact,
    revision: NewArtifactRevision,
    limits?: ArtifactPublishLimits
  ): Promise<ArtifactPublishResult> {
    // A first publish's replay must be the revision 1 of an artifact, never a later append.
    const isFirst = (found: ArtifactPublishResult) => found.revision.number === 1
    const replayed = await this.replayFor(revision, isFirst)
    if (replayed) return replayed
    const id = randomUUID()
    try {
      return await withAmbientTx(this.db, async (tx) => {
        await holdOrgTotal(tx, artifact.orgId, manifestBytes(revision.manifest), limits)
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
        const retention = await daemonRetention(tx, revision.publishedByDaemonId)
        const first = await tx.artifactRevision.create({
          data: { ...revisionData(revision, id, 1, retention), baseRevision: null }
        })
        return { artifact: toArtifact(created), revision: toRevision(first), replayed: false }
      })
    } catch (err) {
      // A same-key begin that committed while this one waited is a replay, even when its bytes now fill the total.
      if (!isUniqueViolation(err) && !(err instanceof ArtifactOrgLimitError)) throw err
      const raced = await this.replayFor(revision, isFirst)
      if (raced) return raced
      throw err
    }
  }

  async appendRevision(
    orgId: string,
    artifactId: string,
    revision: NewArtifactRevision,
    limits?: ArtifactPublishLimits
  ): Promise<ArtifactPublishResult | null> {
    const sameArtifact = (found: ArtifactPublishResult) =>
      found.artifact.id === artifactId && found.artifact.orgId === orgId
    const replayed = await this.replayFor(revision, sameArtifact)
    if (replayed) return replayed
    try {
      return await withAmbientTx(this.db, async (tx) => {
        // The row lock serializes number allocation and the base check between concurrent publishes to one artifact.
        const locked = await tx.$queryRaw<Array<{ latestRevision: number }>>`
          SELECT "latestRevision" FROM "artifact" WHERE "id" = ${artifactId}::uuid AND "orgId" = ${orgId} FOR UPDATE`
        const latestRevision = locked[0]?.latestRevision
        if (latestRevision === undefined) return null
        if (revision.baseRevision !== null && revision.baseRevision !== latestRevision) {
          throw new ArtifactStaleBaseError(latestRevision)
        }
        // Taken after the artifact's row lock and never before it, so two appends cannot deadlock.
        await holdOrgTotal(tx, orgId, manifestBytes(revision.manifest), limits)
        const top = await tx.artifactRevision.aggregate({ where: { artifactId }, _max: { number: true } })
        const retention = await daemonRetention(tx, revision.publishedByDaemonId)
        const appended = await tx.artifactRevision.create({
          data: revisionData(revision, artifactId, (top._max.number ?? 0) + 1, retention)
        })
        const current = await tx.artifact.findUniqueOrThrow({ where: { id: artifactId } })
        return { artifact: toArtifact(current), revision: toRevision(appended), replayed: false }
      })
    } catch (err) {
      if (!isUniqueViolation(err) && !(err instanceof ArtifactOrgLimitError)) throw err
      const raced = await this.replayFor(revision, sameArtifact)
      if (raced) return raced
      throw err
    }
  }

  async markReady(orgId: string, artifactId: string, number: number): Promise<ArtifactCompletion | null> {
    return withAmbientTx(this.db, async (tx) => {
      // The same row lock as begin, so of two updates that both passed begin only the first to complete is ready.
      const locked = await tx.$queryRaw<Array<{ latestRevision: number }>>`
        SELECT "latestRevision" FROM "artifact" WHERE "id" = ${artifactId}::uuid AND "orgId" = ${orgId} FOR UPDATE`
      const latestRevision = locked[0]?.latestRevision
      if (latestRevision === undefined) return null
      const revision = await tx.artifactRevision.findUnique({
        where: { artifactId_number: { artifactId, number } },
        select: { id: true, state: true, baseRevision: true }
      })
      if (!revision) return null
      let state = revision.state
      if (state === 'pending') {
        // A base must still be the latest; a replacement must find no higher revision ready, so `latestRevision` only moves forward.
        const current =
          revision.baseRevision === null ? latestRevision < number : revision.baseRevision === latestRevision
        if (current) {
          await tx.artifactRevision.update({ where: { id: revision.id }, data: { state: 'ready' } })
          await tx.$executeRaw`
            UPDATE "artifact" SET "latestRevision" = ${number}, "updatedAt" = now()
            WHERE "id" = ${artifactId}::uuid AND "latestRevision" < ${number}`
          state = 'ready'
        } else {
          // Closed and its key released, so the same content can start a new revision; it never opens and counts no bytes.
          await tx.artifactRevision.update({
            where: { id: revision.id },
            data: { state: 'closed', idempotencyKey: null }
          })
          state = 'closed'
        }
      }
      const row = await tx.artifact.findUniqueOrThrow({ where: { id: artifactId } })
      return { artifact: toArtifact(row), state }
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

  async deleteRecording(
    orgId: string,
    id: string,
    at: { deletedAt: Date; purgeAfter: Date }
  ): Promise<ArtifactDeletionRecord | null> {
    return withAmbientTx(this.db, async (tx) => {
      // The row lock orders this after any append in flight, so a pending revision's keys are recorded too.
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "artifact" WHERE "id" = ${id}::uuid AND "orgId" = ${orgId} FOR UPDATE`
      if (locked.length === 0) return null
      const revisions = await tx.artifactRevision.findMany({
        where: { artifactId: id },
        select: { storagePrefix: true, manifest: true }
      })
      const objectKeys = revisions.flatMap(objectKeysOf)
      const recorded = await tx.artifactDeletion.create({ data: { id, orgId, objectKeys, ...at } })
      // Revisions and shares cascade, so every read, list and share link answers as absent from here on.
      await tx.artifact.delete({ where: { id } })
      return toDeletion(recorded)
    })
  }

  async expiredRevisions(now: Date, limit: number): Promise<ArtifactRevisionKey[]> {
    // The SQL projection of `revisionExpired`; the integration test holds the two to the same cases.
    return this.db.$queryRaw<ArtifactRevisionKey[]>`
      SELECT a."orgId", r."artifactId", r."number"
      FROM "artifact_revision" r
      JOIN "artifact" a ON a."id" = r."artifactId"
      LEFT JOIN "daemon" d ON d."id" = r."publishedByDaemonId"
      CROSS JOIN LATERAL (
        SELECT substring(COALESCE(d."sessionRetention", r."publishedRetention") FROM ${RETENTION_DAYS_SQL})::int AS days
      ) w
      WHERE r."state" = 'ready'
        AND r."createdAt" < ${new Date(now.getTime() - SHORTEST_RETENTION_MS)}
        AND r."number" < a."latestRevision"
        AND w.days IS NOT NULL
        AND r."createdAt" + make_interval(days => w.days) < ${now}
        AND NOT EXISTS (
          SELECT 1 FROM "artifact_share" s
          WHERE s."artifactId" = r."artifactId" AND s."revisionNumber" = r."number" AND s."revokedAt" IS NULL
        )
      ORDER BY r."createdAt", r."id"
      LIMIT ${limit}`
  }

  async expireRecording(
    key: ArtifactRevisionKey,
    at: { deletedAt: Date; purgeAfter: Date },
    expired: (facts: RevisionRetentionFacts) => boolean
  ): Promise<ArtifactDeletionRecord | null> {
    return withAmbientTx(this.db, async (tx) => {
      // The row lock orders this against a share being created on the revision, which takes the share lock.
      const locked = await tx.$queryRaw<Array<{ latestRevision: number }>>`
        SELECT "latestRevision" FROM "artifact"
        WHERE "id" = ${key.artifactId}::uuid AND "orgId" = ${key.orgId} FOR UPDATE`
      const latestRevision = locked[0]?.latestRevision
      if (latestRevision === undefined) return null
      const revision = await tx.artifactRevision.findUnique({
        where: { artifactId_number: { artifactId: key.artifactId, number: key.number } }
      })
      if (!revision) return null
      const [daemon, activeShares] = await Promise.all([
        revision.publishedByDaemonId
          ? tx.daemon.findUnique({ where: { id: revision.publishedByDaemonId }, select: { sessionRetention: true } })
          : null,
        tx.artifactShare.count({
          where: { artifactId: key.artifactId, revisionNumber: key.number, revokedAt: null }
        })
      ])
      const facts: RevisionRetentionFacts = {
        state: revision.state,
        number: revision.number,
        createdAt: revision.createdAt,
        latestRevision,
        retention: daemon?.sessionRetention ?? revision.publishedRetention,
        activelyShared: activeShares > 0
      }
      if (!expired(facts)) return null
      const recorded = await tx.artifactDeletion.create({
        data: { id: revision.id, orgId: key.orgId, objectKeys: objectKeysOf(revision), ...at }
      })
      // Revoked shares on it stay, so their links keep answering as revoked until the artifact is deleted.
      await tx.artifactRevision.delete({ where: { id: revision.id } })
      return toDeletion(recorded)
    })
  }

  async dueDeletions(now: Date, limit: number): Promise<ArtifactDeletionRecord[]> {
    const rows = await this.db.artifactDeletion.findMany({
      where: { OR: [{ sweptAt: null }, { purgeAfter: { lte: now } }] },
      orderBy: [{ deletedAt: 'asc' }, { id: 'asc' }],
      take: limit
    })
    return rows.map(toDeletion)
  }

  async markDeletionSwept(id: string, at: Date): Promise<void> {
    await this.db.artifactDeletion.updateMany({ where: { id }, data: { sweptAt: at } })
  }

  async dropDeletion(id: string): Promise<void> {
    await this.db.artifactDeletion.deleteMany({ where: { id } })
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
