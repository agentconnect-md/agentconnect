// The bot's rejected mark, aggregated from its per-relay probe observations (preset-agents.md §5.3): any current `rejected` row marks it, none clears it.
import { Prisma } from '../../generated/prisma/client.js'
import type { PrismaLike } from '../prisma.js'

/** Recompute the mark of every bot `scope` selects (a predicate over alias `b`); rows whose mark already agrees are left untouched. */
export async function recomputeCredentialMarks(db: PrismaLike, scope: Prisma.Sql): Promise<number> {
  return db.$executeRaw(Prisma.sql`
    UPDATE bot SET
      "credentialRejectedAt" = CASE WHEN agg."firstAt" IS NULL THEN NULL
        ELSE COALESCE(bot."credentialRejectedAt", agg."firstAt") END,
      "credentialRejectedCode" = agg.code,
      "updatedAt" = CURRENT_TIMESTAMP
    FROM (
      SELECT b.id,
        (SELECT MIN(o."observedAt") FROM bot_credential_observation o
          WHERE o."botId" = b.id AND o."credentialRevision" = b."credentialRevision" AND o.result = 'rejected') AS "firstAt",
        (SELECT o.code FROM bot_credential_observation o
          WHERE o."botId" = b.id AND o."credentialRevision" = b."credentialRevision" AND o.result = 'rejected'
          ORDER BY o."observedAt" DESC, o."relayId" DESC LIMIT 1) AS code
      FROM bot b WHERE ${scope}
    ) agg
    WHERE bot.id = agg.id
      AND ((agg."firstAt" IS NULL) <> (bot."credentialRejectedAt" IS NULL)
        OR bot."credentialRejectedCode" IS DISTINCT FROM agg.code)`)
}
