// The monthly session count's writes and enforcement reads, shared by the first milestone, the admission and session grants (org-session-policy.md).
import { Prisma } from '../generated/prisma/client.js'
import type { PrismaLike } from './prisma.js'

/** Install-level session policy options; `enforcement: false` makes every organization count only. */
export interface SessionPolicyEnforcementOptions {
  enforcement?: boolean
}

/** The current UTC month's first instant by the database clock, the key every count writes under. */
export const MONTH_START_SQL = Prisma.sql`date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`

/** The next UTC month's first instant by the database clock, when the current month's count resets. */
export const NEXT_MONTH_START_SQL = Prisma.sql`(${MONTH_START_SQL} AT TIME ZONE 'UTC' + interval '1 month') AT TIME ZONE 'UTC'`

/** Count one new session against its org's current UTC month by the database clock; never refuses. */
export async function countSessionStart(tx: PrismaLike, orgId: string): Promise<void> {
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "org_session_month" AS m ("orgId", "monthStart", "used")
    VALUES (${orgId}, ${MONTH_START_SQL}, 1)
    ON CONFLICT ("orgId", "monthStart") DO UPDATE SET "used" = m."used" + 1
  `)
}

/** Count one new session only while the month is below `limit`; false when the limit is reached and nothing was counted. */
export async function countSessionStartWithin(tx: PrismaLike, orgId: string, limit: number): Promise<boolean> {
  // The conflicting row is locked and re-read before the WHERE, so concurrent admits cannot overrun the limit.
  const rows = await tx.$queryRaw<Array<{ used: number }>>(Prisma.sql`
    INSERT INTO "org_session_month" AS m ("orgId", "monthStart", "used")
    SELECT ${orgId}, ${MONTH_START_SQL}, 1 WHERE ${limit}::int > 0
    ON CONFLICT ("orgId", "monthStart") DO UPDATE SET "used" = m."used" + 1 WHERE m."used" < ${limit}::int
    RETURNING m."used"
  `)
  return rows.length === 1
}

/** The org's current month count and its reset instant, both by the database clock. */
export async function monthCount(tx: PrismaLike, orgId: string): Promise<{ used: number; resetsAt: Date }> {
  const rows = await tx.$queryRaw<Array<{ used: number; resetsAt: Date }>>(Prisma.sql`
    SELECT COALESCE(
      (SELECT m."used" FROM "org_session_month" m WHERE m."orgId" = ${orgId} AND m."monthStart" = ${MONTH_START_SQL}),
      0
    ) AS "used", ${NEXT_MONTH_START_SQL} AS "resetsAt"
  `)
  return rows[0]!
}

/** The limit an org enforces now, or null when it only counts: no policy, enforce off, no limit, or the install switch off. */
export async function enforcedLimit(tx: PrismaLike, orgId: string, enforcement: boolean): Promise<number | null> {
  if (!enforcement) return null
  const rows = await tx.$queryRaw<Array<{ limit: number | null }>>(Prisma.sql`
    SELECT "monthlySessionLimit" AS "limit" FROM "org_session_policy" WHERE "orgId" = ${orgId} AND "enforce"
  `)
  return rows[0]?.limit ?? null
}

/** Whether the org lets this agent's session id be recorded or granted: it does not enforce, or the id is admitted or recorded for the agent. */
export async function sessionStandsForAgent(
  tx: PrismaLike,
  orgId: string,
  agentId: string,
  sessionId: string,
  enforcement: boolean
): Promise<boolean> {
  if ((await enforcedLimit(tx, orgId, enforcement)) === null) return true
  const rows = await tx.$queryRaw<Array<{ one: number }>>(Prisma.sql`
    SELECT 1 AS "one" FROM "org_session_admission" WHERE "sessionId" = ${sessionId} AND "agentId" = ${agentId}::uuid
    UNION ALL
    SELECT 1 FROM "session_meta" WHERE "id" = ${sessionId} AND "agentId" = ${agentId}::uuid
    LIMIT 1
  `)
  return rows.length > 0
}

/** Whether a daemon admitted this session id, which settled its count at admission, counted or exempt. */
export async function sessionAdmitted(tx: PrismaLike, sessionId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ one: number }>>(Prisma.sql`
    SELECT 1 AS "one" FROM "org_session_admission" WHERE "sessionId" = ${sessionId}
  `)
  return rows.length > 0
}
