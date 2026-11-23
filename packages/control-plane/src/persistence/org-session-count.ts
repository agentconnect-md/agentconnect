// The monthly session count's writes and enforcement reads, shared by the first milestone, the admission and session grants (org-session-policy.md).
import { Prisma } from '../generated/prisma/client.js'
import type { PrismaLike } from './prisma.js'
import type { MilestoneAdmissionRefusal } from './ports.js'

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

/** Record one session id's admission under the database clock's month; `counted` says whether it consumed the count. */
export function insertAdmission(
  tx: PrismaLike,
  sessionId: string,
  orgId: string,
  agentId: string,
  counted: boolean,
  maintenance: string | null
): Promise<number> {
  return tx.$executeRaw(Prisma.sql`
    INSERT INTO "org_session_admission" ("sessionId", "orgId", "agentId", "monthStart", "counted", "maintenance")
    VALUES (${sessionId}, ${orgId}, ${agentId}::uuid, ${MONTH_START_SQL}, ${counted}, ${maintenance})
  `)
}

/** Admit a milestone's id as `session/admit` would, minus maintenance, under the caller's lineage fence; undefined lets it record. */
export async function admitAtMilestone(
  tx: PrismaLike,
  orgId: string,
  agentId: string,
  sessionId: string,
  enforcement: boolean
): Promise<MilestoneAdmissionRefusal | undefined> {
  const limit = await enforcedLimit(tx, orgId, enforcement)
  if (limit === null) return undefined
  const rows = await tx.$queryRaw<Array<{ admittedBy: string | null; recordedBy: string | null }>>(Prisma.sql`
    SELECT
      (SELECT a."agentId"::text FROM "org_session_admission" a WHERE a."sessionId" = ${sessionId}) AS "admittedBy",
      (SELECT s."agentId"::text FROM "session_meta" s WHERE s."id" = ${sessionId}) AS "recordedBy"
  `)
  const { admittedBy, recordedBy } = rows[0]!
  if (admittedBy !== null) return admittedBy === agentId ? undefined : { reason: 'other_agent' }
  // A recorded id was counted then, or predates counting; another agent's row is refused by the upsert itself.
  if (recordedBy !== null) return undefined
  // A session that started fail-open is admitted here, against the same conditional count.
  if (!(await countSessionStartWithin(tx, orgId, limit))) {
    return { reason: 'session_limit_reached', limit, ...(await monthCount(tx, orgId)) }
  }
  await insertAdmission(tx, sessionId, orgId, agentId, true, null)
  return undefined
}

/** Whether a daemon admitted this session id, which settled its count at admission, counted or exempt. */
export async function sessionAdmitted(tx: PrismaLike, sessionId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ one: number }>>(Prisma.sql`
    SELECT 1 AS "one" FROM "org_session_admission" WHERE "sessionId" = ${sessionId}
  `)
  return rows.length > 0
}
