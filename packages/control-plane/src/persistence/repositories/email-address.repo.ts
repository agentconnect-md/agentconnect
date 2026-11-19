/** PgEmailAddressRepo — every address an Email integration has taken (email-integration.md §3); nothing here deletes a row. */
import type { PrismaLike } from '../prisma.js'
import type { EmailAddressRepo } from '../ports.js'

export class PgEmailAddressRepo implements EmailAddressRepo {
  constructor(private readonly db: PrismaLike) {}

  async taken(address: string): Promise<boolean> {
    return (await this.db.emailAddress.findUnique({ where: { address }, select: { address: true } })) !== null
  }

  async claim(address: string): Promise<boolean> {
    // The primary key decides a race: only one insert of an address counts.
    const { count } = await this.db.emailAddress.createMany({ data: [{ address }], skipDuplicates: true })
    return count === 1
  }
}
