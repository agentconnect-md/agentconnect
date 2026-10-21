// PgComputerScreenshotRepo — stored screenshot metadata and per-day usage (computer-use.md §9); never the bytes.
import { COMPUTER_SCREENSHOT_CONTENT_TYPES, type ComputerScreenshotContentType } from '@agentconnect.md/protocol'
import type { ComputerScreenshot } from '../../generated/prisma/client.js'
import { Prisma } from '../../generated/prisma/client.js'
import { withAmbientTx, type PrismaLike } from '../prisma.js'
import type { ComputerScreenshotRecord, ComputerScreenshotRepo, ComputerScreenshotUsageTotals } from '../ports.js'

const contentTypeOf = (value: string): ComputerScreenshotContentType =>
  (COMPUTER_SCREENSHOT_CONTENT_TYPES as readonly string[]).includes(value)
    ? (value as ComputerScreenshotContentType)
    : 'image/png'

function toRecord(row: ComputerScreenshot): ComputerScreenshotRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    computerId: row.computerId,
    sessionId: row.sessionId,
    agentId: row.agentId,
    sha256: row.sha256,
    bytes: row.bytes,
    contentType: contentTypeOf(row.contentType),
    objectKey: row.objectKey,
    takenAt: row.takenAt,
    createdAt: row.createdAt,
    storedAt: row.storedAt,
    expiresAt: row.expiresAt
  }
}

// The UTC day an upload is counted on.
const utcDay = (at: Date): Date => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()))

export class PgComputerScreenshotRepo implements ComputerScreenshotRepo {
  constructor(private readonly db: PrismaLike) {}

  async reserve(row: Omit<ComputerScreenshotRecord, 'storedAt'>): Promise<ComputerScreenshotRecord> {
    const where = {
      computerId_sessionId_sha256: { computerId: row.computerId, sessionId: row.sessionId, sha256: row.sha256 }
    }
    // An existing row keeps its key, so a retried upload lands where the first one may already have.
    const existing = await this.db.computerScreenshot.findUnique({ where })
    if (existing) return toRecord(existing)
    try {
      return toRecord(await this.db.computerScreenshot.create({ data: row }))
    } catch (err) {
      // A concurrent reserve of the same screenshot won the insert; use its row.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const raced = await this.db.computerScreenshot.findUnique({ where })
        if (raced) return toRecord(raced)
      }
      throw err
    }
  }

  async get(computerId: string, sessionId: string, sha256: string): Promise<ComputerScreenshotRecord | null> {
    const row = await this.db.computerScreenshot.findUnique({
      where: { computerId_sessionId_sha256: { computerId, sessionId, sha256 } }
    })
    return row ? toRecord(row) : null
  }

  // One transaction: a stored row is always metered, and the once-only guard keeps a retry from counting twice.
  async markStored(id: string, orgId: string, bytes: number, at: Date): Promise<boolean> {
    return withAmbientTx(this.db, async (tx) => {
      const { count } = await tx.computerScreenshot.updateMany({
        where: { id, orgId, storedAt: null },
        data: { storedAt: at }
      })
      if (count === 0) return false
      const day = utcDay(at)
      await tx.computerScreenshotUsage.upsert({
        where: { orgId_day: { orgId, day } },
        create: { orgId, day, count: 1, bytes: BigInt(bytes) },
        update: { count: { increment: 1 }, bytes: { increment: BigInt(bytes) } }
      })
      return true
    })
  }

  async findStored(orgId: string, sessionId: string, sha256: string, now: Date): Promise<ComputerScreenshotRecord[]> {
    const rows = await this.db.computerScreenshot.findMany({
      where: { orgId, sessionId, sha256, storedAt: { not: null }, expiresAt: { gt: now } },
      orderBy: [{ takenAt: 'desc' }, { id: 'desc' }],
      take: 20
    })
    return rows.map(toRecord)
  }

  async listStored(
    orgId: string,
    sessionId: string,
    now: Date,
    page: { limit: number; after?: { takenAt: Date; id: string } }
  ): Promise<ComputerScreenshotRecord[]> {
    const after = page.after
    const rows = await this.db.computerScreenshot.findMany({
      where: {
        orgId,
        sessionId,
        storedAt: { not: null },
        expiresAt: { gt: now },
        ...(after ? { OR: [{ takenAt: { gt: after.takenAt } }, { takenAt: after.takenAt, id: { gt: after.id } }] } : {})
      },
      orderBy: [{ takenAt: 'asc' }, { id: 'asc' }],
      take: page.limit
    })
    return rows.map(toRecord)
  }

  async reapable(now: Date, pendingBefore: Date, limit: number): Promise<ComputerScreenshotRecord[]> {
    const rows = await this.db.$queryRaw<ComputerScreenshot[]>`
      SELECT s.* FROM "computer_screenshot" s
      WHERE s."expiresAt" <= ${now}
         OR (s."storedAt" IS NULL AND s."createdAt" < ${pendingBefore})
         OR NOT EXISTS (SELECT 1 FROM "computer" c WHERE c."id" = s."computerId")
      ORDER BY s."expiresAt" ASC
      LIMIT ${limit}`
    return rows.map(toRecord)
  }

  async clampExpiry(retention: {
    defaultDays: number
    maxDays: number
    computerId?: string
    orgId?: string
    capDays?: number
  }): Promise<number> {
    const only = retention.computerId ? Prisma.sql`AND c."id" = ${retention.computerId}::uuid` : Prisma.empty
    const org = retention.orgId ? Prisma.sql`AND c."orgId" = ${retention.orgId} AND c."kind" = 'managed'` : Prisma.empty
    const cap = retention.capDays ?? retention.maxDays
    return this.db.$executeRaw`
      UPDATE "computer_screenshot" s
      SET "expiresAt" = s."createdAt" + make_interval(days => r.days)
      FROM (
        SELECT c."id",
               LEAST(COALESCE((c."policy"->>'screenshotRetentionDays')::int, ${retention.defaultDays}::int), ${retention.maxDays}::int, ${cap}::int) AS days
        FROM "computer" c
        WHERE TRUE ${only} ${org}
      ) r
      WHERE s."computerId" = r."id" AND s."expiresAt" > s."createdAt" + make_interval(days => r.days)`
  }

  async deleteRows(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0
    const { count } = await this.db.computerScreenshot.deleteMany({ where: { id: { in: ids } } })
    return count
  }

  async usage(orgId: string, window: { from: Date; to: Date }, now: Date): Promise<ComputerScreenshotUsageTotals> {
    const [written, stored] = await Promise.all([
      this.db.computerScreenshotUsage.aggregate({
        where: { orgId, day: { gte: utcDay(window.from), lt: window.to } },
        _sum: { count: true, bytes: true }
      }),
      this.db.computerScreenshot.aggregate({
        where: { orgId, storedAt: { not: null }, expiresAt: { gt: now } },
        _count: { _all: true },
        _sum: { bytes: true }
      })
    ])
    return {
      written: { count: written._sum.count ?? 0, bytes: Number(written._sum.bytes ?? 0n) },
      stored: { count: stored._count._all, bytes: stored._sum.bytes ?? 0 }
    }
  }

  async storedBytes(orgId: string, now: Date): Promise<number> {
    const [row] = await this.db.$queryRaw<Array<{ bytes: bigint | null }>>`
      SELECT SUM(s."bytes")::bigint AS bytes
      FROM "computer_screenshot" s JOIN "computer" c ON c."id" = s."computerId"
      WHERE s."orgId" = ${orgId} AND c."kind" = 'managed' AND s."storedAt" IS NOT NULL AND s."expiresAt" > ${now}`
    return Number(row?.bytes ?? 0n)
  }

  async managedOrgs(now: Date): Promise<string[]> {
    const rows = await this.db.$queryRaw<Array<{ orgId: string }>>`
      SELECT DISTINCT s."orgId"
      FROM "computer_screenshot" s JOIN "computer" c ON c."id" = s."computerId"
      WHERE c."kind" = 'managed' AND s."expiresAt" > ${now}`
    return rows.map((r) => r.orgId)
  }
}
