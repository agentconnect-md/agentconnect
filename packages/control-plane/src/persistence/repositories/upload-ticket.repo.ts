// Console file-transfer upload tickets in PostgreSQL, so the replica a daemon asks `transfer/sign` need not be the one that minted it.
import { TransferUploadOutcome } from '@agentconnect.md/protocol'
import type { PrismaLike } from '../prisma.js'
import type { UploadTicket, UploadTicketRepo, UploadTicketState } from '../ports.js'

export class PgUploadTicketRepo implements UploadTicketRepo {
  constructor(private readonly db: PrismaLike) {}

  async open(id: string, ticket: UploadTicket, ttlMs: number): Promise<void> {
    await this.db.$executeRaw`DELETE FROM "transfer_upload_ticket" WHERE "expiresAt" <= now()`
    await this.db.$executeRaw`
      INSERT INTO "transfer_upload_ticket" ("id", "daemonId", "objectKey", "size", "agentId", "path", "expiresAt")
      VALUES (${id}::uuid, ${ticket.daemonId}::uuid, ${ticket.objectKey}, ${BigInt(ticket.size)},
              ${ticket.agentId ?? null}, ${ticket.path ?? null},
              now() + ${ttlMs}::double precision * interval '1 millisecond')`
  }

  async find(id: string, daemonId: string): Promise<Omit<UploadTicket, 'daemonId'> | undefined> {
    const rows = await this.db.$queryRaw<Array<{ objectKey: string; size: bigint }>>`
      SELECT "objectKey", "size" FROM "transfer_upload_ticket"
      WHERE "id" = ${id}::uuid AND "daemonId" = ${daemonId}::uuid AND "expiresAt" > now() AND "settledAt" IS NULL`
    const row = rows[0]
    return row ? { objectKey: row.objectKey, size: Number(row.size) } : undefined
  }

  async pending(objectKey: string, daemonId: string): Promise<string | undefined> {
    const rows = await this.db.$queryRaw<Array<{ id: string }>>`
      SELECT "id"::text AS "id" FROM "transfer_upload_ticket"
      WHERE "objectKey" = ${objectKey} AND "daemonId" = ${daemonId}::uuid AND "agentId" IS NOT NULL
        AND "expiresAt" > now() AND "settledAt" IS NULL
      ORDER BY "expiresAt" DESC LIMIT 1`
    return rows[0]?.id
  }

  async settle(id: string, daemonId: string, outcome: TransferUploadOutcome, retainMs: number): Promise<boolean> {
    // Settles once: a resent `transfer/settle` finds the row settled and changes nothing.
    const updated = await this.db.$executeRaw`
      UPDATE "transfer_upload_ticket"
      SET "outcome" = ${JSON.stringify(outcome)}::jsonb, "settledAt" = now(),
          "expiresAt" = now() + ${retainMs}::double precision * interval '1 millisecond'
      WHERE "id" = ${id}::uuid AND "daemonId" = ${daemonId}::uuid AND "expiresAt" > now() AND "settledAt" IS NULL`
    return updated > 0
  }

  async get(id: string): Promise<UploadTicketState | undefined> {
    const rows = await this.db.$queryRaw<
      Array<{
        daemonId: string
        objectKey: string
        size: bigint
        agentId: string | null
        path: string | null
        outcome: unknown
      }>
    >`
      SELECT "daemonId"::text AS "daemonId", "objectKey", "size", "agentId", "path", "outcome"
      FROM "transfer_upload_ticket" WHERE "id" = ${id}::uuid AND "expiresAt" > now()`
    const row = rows[0]
    if (!row) return undefined
    const outcome = row.outcome === null ? undefined : TransferUploadOutcome.safeParse(row.outcome)
    return {
      daemonId: row.daemonId,
      objectKey: row.objectKey,
      size: Number(row.size),
      ...(row.agentId !== null ? { agentId: row.agentId } : {}),
      ...(row.path !== null ? { path: row.path } : {}),
      // A row this version cannot read reads as a failed transfer rather than one still running.
      ...(outcome
        ? {
            outcome: outcome.success
              ? outcome.data
              : { ok: false as const, code: 'INTERNAL' as const, message: 'unreadable transfer outcome' }
          }
        : {})
    }
  }

  async close(id: string): Promise<void> {
    await this.db.transferUploadTicket.deleteMany({ where: { id } })
  }
}
