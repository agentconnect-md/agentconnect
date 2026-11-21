// PgOrgSessionPolicyRepo — per-organization session policies by revision and their monthly session counts (org-session-policy.md).
import type { PrismaLike } from '../prisma.js'
import type { OrgSessionMonthUsage, OrgSessionPolicyInput, OrgSessionPolicyRepo } from '../ports.js'

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

  async monthUsage(orgId: string): Promise<OrgSessionMonthUsage | null> {
    // One statement, so the count, the policy, and the month all describe the same instant.
    const rows = await this.db.$queryRaw<OrgSessionMonthUsage[]>`
      WITH t AS (
        SELECT now() AS "asOf", date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS "monthStart"
      )
      SELECT
        COALESCE(m."used", 0) AS "used",
        p."monthlySessionLimit" AS "limit",
        p."revision" AS "policyRevision",
        t."monthStart",
        (t."monthStart" AT TIME ZONE 'UTC' + interval '1 month') AT TIME ZONE 'UTC' AS "resetsAt",
        t."asOf"
      FROM "org" o
      CROSS JOIN t
      LEFT JOIN "org_session_month" m ON m."orgId" = o."id" AND m."monthStart" = t."monthStart"
      LEFT JOIN "org_session_policy" p ON p."orgId" = o."id"
      WHERE o."id" = ${orgId}`
    return rows[0] ?? null
  }
}
