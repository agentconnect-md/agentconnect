// PgOrgSessionPolicyRepo — per-organization session policies by revision, their monthly session counts, and session admissions (org-session-policy.md).
import { withAmbientTx, type PrismaLike } from '../prisma.js'
import { lockSessionLineage } from '../session-lineage-lock.js'
import { countSessionStart, MONTH_START_SQL } from '../org-session-count.js'
import type {
  OrgSessionAdmission,
  OrgSessionMaintenance,
  OrgSessionMonthUsage,
  OrgSessionPolicyInput,
  OrgSessionPolicyRepo
} from '../ports.js'

const OTHER_AGENT: OrgSessionAdmission = { admitted: false, conflict: 'other_agent' }

/** Exempt maintenance admissions one agent may make per UTC day; past it, maintenance counts like any session. */
export const MAINTENANCE_ADMISSIONS_PER_AGENT_PER_DAY = 24

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
        SELECT now() AS "asOf", ${MONTH_START_SQL} AS "monthStart"
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

  async admit(
    orgId: string,
    agentId: string,
    sessionId: string,
    maintenance?: OrgSessionMaintenance
  ): Promise<OrgSessionAdmission> {
    return withAmbientTx(this.db, async (tx) => {
      // The fence a first milestone takes on this id before it inserts, so the two serialize and count once between them.
      await lockSessionLineage(tx, [sessionId])
      const admitted = await tx.$queryRaw<Array<{ sameAgent: boolean; counted: boolean }>>`
        SELECT ("agentId" = ${agentId}::uuid) AS "sameAgent", "counted"
        FROM "org_session_admission" WHERE "sessionId" = ${sessionId}`
      if (admitted[0]) return admitted[0].sameAgent ? { admitted: true, counted: admitted[0].counted } : OTHER_AGENT
      const known = await tx.$queryRaw<Array<{ sameAgent: boolean }>>`
        SELECT ("agentId" = ${agentId}::uuid) AS "sameAgent" FROM "session_meta" WHERE "id" = ${sessionId}`
      if (known[0] && !known[0].sameAgent) return OTHER_AGENT
      // A session the CP already recorded was counted then, or predates counting; either way not again.
      if (known[0]) {
        await insertAdmission(tx, sessionId, orgId, agentId, false, null)
        return { admitted: true, counted: false }
      }
      if (maintenance && (await maintenanceExemptable(tx, agentId))) {
        await insertAdmission(tx, sessionId, orgId, agentId, false, maintenance)
        return { admitted: true, counted: false }
      }
      await insertAdmission(tx, sessionId, orgId, agentId, true, null)
      // Last statement, so the org's month row stays locked only until commit.
      await countSessionStart(tx, orgId)
      return { admitted: true, counted: true }
    })
  }
}

function insertAdmission(
  tx: PrismaLike,
  sessionId: string,
  orgId: string,
  agentId: string,
  counted: boolean,
  maintenance: OrgSessionMaintenance | null
): Promise<number> {
  return tx.$executeRaw`
    INSERT INTO "org_session_admission" ("sessionId", "orgId", "agentId", "monthStart", "counted", "maintenance")
    VALUES (${sessionId}, ${orgId}, ${agentId}::uuid, ${MONTH_START_SQL}, ${counted}, ${maintenance})`
}

/** Whether the agent has exempt admissions left today by the database clock, serialized per agent until commit. */
async function maintenanceExemptable(tx: PrismaLike, agentId: string): Promise<boolean> {
  // Taken after the lineage fence and never before it, so concurrent exempt admits of one agent cannot overrun the cap.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${maintenanceLockKey(agentId)}, 0))`
  const rows = await tx.$queryRaw<Array<{ exempt: number }>>`
    SELECT count(*)::int AS "exempt" FROM "org_session_admission"
    WHERE "agentId" = ${agentId}::uuid AND "maintenance" IS NOT NULL
      AND "createdAt" >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`
  return (rows[0]?.exempt ?? 0) < MAINTENANCE_ADMISSIONS_PER_AGENT_PER_DAY
}

function maintenanceLockKey(agentId: string): string {
  return JSON.stringify(['session-maintenance', agentId])
}
