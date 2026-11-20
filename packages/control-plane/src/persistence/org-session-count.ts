// The monthly session count's writes, shared by the first milestone and the admission (org-session-policy.md).
import { Prisma } from '../generated/prisma/client.js'
import type { PrismaLike } from './prisma.js'

/** The current UTC month's first instant by the database clock, the key every count writes under. */
export const MONTH_START_SQL = Prisma.sql`date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`

/** Count one new session against its org's current UTC month by the database clock; never refuses. */
export async function countSessionStart(tx: PrismaLike, orgId: string): Promise<void> {
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "org_session_month" AS m ("orgId", "monthStart", "used")
    VALUES (${orgId}, ${MONTH_START_SQL}, 1)
    ON CONFLICT ("orgId", "monthStart") DO UPDATE SET "used" = m."used" + 1
  `)
}

/** Whether a daemon admitted this session id, which then counted it at admission. */
export async function sessionAdmitted(tx: PrismaLike, sessionId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ one: number }>>(Prisma.sql`
    SELECT 1 AS "one" FROM "org_session_admission" WHERE "sessionId" = ${sessionId}
  `)
  return rows.length > 0
}
