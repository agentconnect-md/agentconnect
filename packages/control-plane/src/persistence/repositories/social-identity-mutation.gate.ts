import { Prisma, type PrismaClient } from '../../generated/prisma/client.js'
import type { SocialIdentityMutationGate } from '../ports.js'

const TRANSACTION_TIMEOUT_MS = 45_000

/**
 * Serializes one Logto user's read/check/delete cycle across Control Plane
 * instances. The external call stays inside the transaction because releasing
 * the advisory lock before Logto accepts the DELETE would reopen the race.
 */
export class PgSocialIdentityMutationGate implements SocialIdentityMutationGate {
  constructor(private readonly prisma: PrismaClient) {}

  runExclusive<T>(oidcSubject: string, mutation: () => Promise<T>): Promise<T> {
    const key = JSON.stringify(['logto-social-identity', oidcSubject])
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0)) IS NULL AS "locked"
        `)
        return mutation()
      },
      { timeout: TRANSACTION_TIMEOUT_MS }
    )
  }
}
