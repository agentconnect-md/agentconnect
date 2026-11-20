// PgOrgSessionPolicyRepo — per-organization session policies delivered by revision (org-session-policy.md).
import type { PrismaLike } from '../prisma.js'
import type { OrgSessionPolicyInput, OrgSessionPolicyRepo } from '../ports.js'

export class PgOrgSessionPolicyRepo implements OrgSessionPolicyRepo {
  constructor(private readonly db: PrismaLike) {}

  async apply(orgId: string, policy: OrgSessionPolicyInput): Promise<number | null> {
    // One statement under the row lock: a higher revision replaces every field, any other keeps the row; no org row ⇒ no insert.
    const rows = await this.db.$queryRaw<Array<{ revision: number }>>`
      INSERT INTO "org_session_policy" AS p
        ("orgId", "revision", "monthlySessionLimit", "historyRetentionDays", "enforce", "updatedAt")
      SELECT o."id", ${policy.revision}::int, ${policy.monthlySessionLimit}::int, ${policy.historyRetentionDays}::int, ${policy.enforce}::boolean, CURRENT_TIMESTAMP
      FROM "org" o WHERE o."id" = ${orgId}
      ON CONFLICT ("orgId") DO UPDATE SET
        "monthlySessionLimit" = CASE WHEN p."revision" < EXCLUDED."revision" THEN EXCLUDED."monthlySessionLimit" ELSE p."monthlySessionLimit" END,
        "historyRetentionDays" = CASE WHEN p."revision" < EXCLUDED."revision" THEN EXCLUDED."historyRetentionDays" ELSE p."historyRetentionDays" END,
        "enforce" = CASE WHEN p."revision" < EXCLUDED."revision" THEN EXCLUDED."enforce" ELSE p."enforce" END,
        "updatedAt" = CASE WHEN p."revision" < EXCLUDED."revision" THEN EXCLUDED."updatedAt" ELSE p."updatedAt" END,
        "revision" = GREATEST(p."revision", EXCLUDED."revision")
      RETURNING p."revision"`
    return rows[0]?.revision ?? null
  }
}
