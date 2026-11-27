// PgArtifactShareRepo — share links to one artifact revision (artifacts.md §4, §8.3); only the token's peppered hash is stored.
import { randomUUID } from 'node:crypto'
import type { ArtifactShare } from '../../generated/prisma/client.js'
import { withAmbientTx, type PrismaLike } from '../prisma.js'
import type {
  ArtifactRecord,
  ArtifactShareAudience,
  ArtifactSharePageQuery,
  ArtifactShareRecord,
  ArtifactShareRepo,
  NewArtifactShare
} from '../ports.js'
import { toArtifact } from './artifact.repo.js'

function toShare(row: ArtifactShare): ArtifactShareRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    artifactId: row.artifactId,
    revisionNumber: row.revisionNumber,
    displayTail: row.displayTail,
    audience: row.audience,
    createdByIdentity: row.createdByIdentity,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    revokedAt: row.revokedAt
  }
}

export class PgArtifactShareRepo implements ArtifactShareRepo {
  constructor(private readonly db: PrismaLike) {}

  async create(share: NewArtifactShare): Promise<ArtifactShareRecord | null> {
    return withAmbientTx(this.db, async (tx) => {
      // The share lock waits out a retention sweep holding the row, so the revision read below sees its outcome.
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "artifact" WHERE "id" = ${share.artifactId}::uuid AND "orgId" = ${share.orgId} FOR SHARE`
      if (locked.length === 0) return null
      const ready = await tx.artifactRevision.count({
        where: { artifactId: share.artifactId, number: share.revisionNumber, state: 'ready' }
      })
      if (ready === 0) return null
      return toShare(await tx.artifactShare.create({ data: { id: randomUUID(), ...share } }))
    })
  }

  async listActive(orgId: string, artifactId: string): Promise<ArtifactShareRecord[]> {
    const rows = await this.db.artifactShare.findMany({
      where: { orgId, artifactId, revokedAt: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
    })
    return rows.map(toShare)
  }

  async get(orgId: string, artifactId: string, id: string): Promise<ArtifactShareRecord | null> {
    const row = await this.db.artifactShare.findFirst({ where: { id, orgId, artifactId } })
    return row ? toShare(row) : null
  }

  async setAudience(
    orgId: string,
    artifactId: string,
    id: string,
    audience: ArtifactShareAudience
  ): Promise<ArtifactShareRecord | null> {
    const updated = await this.db.artifactShare.updateManyAndReturn({
      where: { id, orgId, artifactId, revokedAt: null },
      data: { audience, updatedAt: new Date() }
    })
    return updated[0] ? toShare(updated[0]) : null
  }

  async revoke(orgId: string, artifactId: string, id: string, at: Date): Promise<ArtifactShareRecord | null> {
    await this.db.artifactShare.updateMany({
      where: { id, orgId, artifactId, revokedAt: null },
      data: { revokedAt: at, updatedAt: at }
    })
    return this.get(orgId, artifactId, id)
  }

  async activeAudiences(
    orgId: string,
    artifactIds: readonly string[]
  ): Promise<Array<{ artifactId: string; audience: ArtifactShareAudience }>> {
    if (artifactIds.length === 0) return []
    return this.db.artifactShare.findMany({
      where: { orgId, artifactId: { in: [...artifactIds] }, revokedAt: null },
      select: { artifactId: true, audience: true },
      distinct: ['artifactId', 'audience']
    })
  }

  async listActiveInOrg(
    orgId: string,
    audience: ArtifactShareAudience,
    page: ArtifactSharePageQuery
  ): Promise<Array<{ share: ArtifactShareRecord; artifact: ArtifactRecord }>> {
    const cursor = page.cursor
    const rows = await this.db.artifactShare.findMany({
      where: {
        orgId,
        audience,
        revokedAt: null,
        ...(cursor
          ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] }
          : {})
      },
      include: { artifact: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: page.limit
    })
    return rows.map(({ artifact, ...share }) => ({ share: toShare(share), artifact: toArtifact(artifact) }))
  }

  async findByTokenHash(tokenHash: string): Promise<{ share: ArtifactShareRecord; artifact: ArtifactRecord } | null> {
    const row = await this.db.artifactShare.findUnique({ where: { tokenHash }, include: { artifact: true } })
    if (!row) return null
    const { artifact, ...share } = row
    return { share: toShare(share), artifact: toArtifact(artifact) }
  }
}
