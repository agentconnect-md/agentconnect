// PgSessionFileSnapshotRepo — where a shared file's snapshot sits in the transfer bucket (agent-authored-attachments.md §4.1); never the bytes.
import type { SessionFileSnapshot } from '../../generated/prisma/client.js'
import { Prisma } from '../../generated/prisma/client.js'
import type { PrismaLike } from '../prisma.js'
import type { SessionFileSnapshotRecord, SessionFileSnapshotRepo } from '../ports.js'

function toRecord(row: SessionFileSnapshot): SessionFileSnapshotRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    agentId: row.agentId,
    sessionId: row.sessionId,
    sha256: row.sha256,
    bytes: row.bytes,
    name: row.name,
    objectKey: row.objectKey,
    createdAt: row.createdAt
  }
}

export class PgSessionFileSnapshotRepo implements SessionFileSnapshotRepo {
  constructor(private readonly db: PrismaLike) {}

  async reserve(row: Omit<SessionFileSnapshotRecord, 'createdAt'>): Promise<SessionFileSnapshotRecord> {
    const where = { objectKey: row.objectKey }
    const existing = await this.db.sessionFileSnapshot.findUnique({ where })
    if (existing) return toRecord(existing)
    try {
      return toRecord(await this.db.sessionFileSnapshot.create({ data: row }))
    } catch (err) {
      // A concurrent share of the same bytes won the insert; use its row.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const raced = await this.db.sessionFileSnapshot.findUnique({ where })
        if (raced) return toRecord(raced)
      }
      throw err
    }
  }

  async findByDigest(orgId: string, sessionId: string, sha256Prefix: string): Promise<SessionFileSnapshotRecord[]> {
    const rows = await this.db.sessionFileSnapshot.findMany({
      where: { orgId, sessionId, sha256: { startsWith: sha256Prefix.toLowerCase() } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 5
    })
    return rows.map(toRecord)
  }

  async reapable(missingBefore: Date, limit: number): Promise<SessionFileSnapshotRecord[]> {
    const rows = await this.db.$queryRaw<SessionFileSnapshot[]>`
      SELECT f.* FROM "session_file_snapshot" f
      LEFT JOIN "session_meta" s ON s."id" = f."sessionId"
      WHERE s."contentPurgedAt" IS NOT NULL
         OR (s."id" IS NULL AND f."createdAt" < ${missingBefore})
      ORDER BY f."createdAt" ASC
      LIMIT ${limit}`
    return rows.map(toRecord)
  }

  async delete(id: string): Promise<void> {
    await this.db.sessionFileSnapshot.deleteMany({ where: { id } })
  }
}
