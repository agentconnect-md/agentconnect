// Console file-transfer upload tickets in PostgreSQL, so the replica a daemon asks `transfer/sign` need not be the one that minted it.
import type { PrismaLike } from '../prisma.js'
import type { UploadTicket, UploadTicketRepo } from '../ports.js'

export class PgUploadTicketRepo implements UploadTicketRepo {
  constructor(private readonly db: PrismaLike) {}

  async open(id: string, ticket: UploadTicket, ttlMs: number): Promise<void> {
    await this.db.$executeRaw`DELETE FROM "transfer_upload_ticket" WHERE "expiresAt" <= now()`
    await this.db.$executeRaw`
      INSERT INTO "transfer_upload_ticket" ("id", "daemonId", "objectKey", "size", "expiresAt")
      VALUES (${id}::uuid, ${ticket.daemonId}::uuid, ${ticket.objectKey}, ${BigInt(ticket.size)},
              now() + ${ttlMs}::double precision * interval '1 millisecond')`
  }

  async find(id: string, daemonId: string): Promise<Omit<UploadTicket, 'daemonId'> | undefined> {
    const rows = await this.db.$queryRaw<Array<{ objectKey: string; size: bigint }>>`
      SELECT "objectKey", "size" FROM "transfer_upload_ticket"
      WHERE "id" = ${id}::uuid AND "daemonId" = ${daemonId}::uuid AND "expiresAt" > now()`
    const row = rows[0]
    return row ? { objectKey: row.objectKey, size: Number(row.size) } : undefined
  }

  async close(id: string): Promise<void> {
    await this.db.transferUploadTicket.deleteMany({ where: { id } })
  }
}
