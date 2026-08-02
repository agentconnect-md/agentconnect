import { Prisma } from '../../generated/prisma/client.js'
import type { SessionFilterQuery } from '../ports.js'

/** SQL mirror of authorization/policy.ts#canViewSession. The caller's query
 * must expose SessionMeta under `alias` (default `s`). Undefined is reserved
 * for internal unfiltered reads; every human role uses the same predicate. */
export function sessionViewerSql(
  viewer: SessionFilterQuery['viewer'],
  alias: Prisma.Sql = Prisma.raw('s')
): Prisma.Sql | null {
  if (!viewer) return null
  const s = alias
  const direct = Prisma.sql`(
    ${s}."externalProvider" IS NULL
    AND (
      ${s}."visibility" = 'org'::"SessionVisibility"
      OR (
        ${s}."visibility" = 'private'::"SessionVisibility"
        AND ${s}."ownerIdentity" IS NOT NULL
        AND ${s}."ownerIdentity" = ANY(${viewer.identitySet}::text[])
      )
    )
  )`
  const snapshot = viewer.externalAccess
  if (!snapshot) return direct
  const externalArms: Prisma.Sql[] = []
  for (const policy of snapshot.policies) {
    externalArms.push(Prisma.sql`(
      ${s}."externalProvider" = ${policy.provider}
      AND ${s}."visibility" = 'org'::"SessionVisibility"
      AND EXISTS (
        SELECT 1 FROM "session_external_access_policy" policy
        WHERE policy."orgId" = ${s}."orgId"
          AND policy."provider" = ${s}."externalProvider"
          AND (
            policy."readFenceRev" IS NULL
            OR (
              ${s}."classifiedPolicyRev" IS NOT NULL
              AND ${s}."classifiedPolicyRev" >= policy."readFenceRev"
            )
          )
      )
    )`)
  }
  for (const allowed of snapshot.allowedScopes) {
    externalArms.push(Prisma.sql`(
      ${s}."visibility" = 'external'::"SessionVisibility"
      AND ${s}."externalResolution" = 'settled'::"ExternalResolution"
      AND ${s}."externalScopeId" = ${allowed.id}::uuid
      AND EXISTS (
        SELECT 1 FROM "session_external_access_policy" policy
        WHERE policy."orgId" = ${s}."orgId"
          AND policy."provider" = ${s}."externalProvider"
      )
      AND EXISTS (
        SELECT 1 FROM "external_scope" scope
        WHERE scope."id" = ${s}."externalScopeId"
          AND scope."orgId" = ${s}."orgId"
          AND scope."provider" = ${s}."externalProvider"
          AND scope."aclRevision" = ${allowed.aclRevision}
          AND scope."revokedAt" IS NULL
      )
    )`)
  }
  return externalArms.length > 0 ? Prisma.sql`(${direct} OR ${Prisma.join(externalArms, ' OR ')})` : direct
}
