import { Prisma } from '../../generated/prisma/client.js'
import type { SessionFilterQuery } from '../ports.js'

/**
 * SQL mirror of authorization/policy.ts#canViewSession. The caller's query
 * must expose SessionMeta under `alias` (default `s`). Undefined is reserved
 * for internal unfiltered reads; every human role uses the same predicate.
 *
 * Shape matters here, not just meaning. This predicate is evaluated per
 * candidate row, and the conversation page re-applies it to the inner probe
 * row of its emit-at-max subquery — so anything written per-scope is paid
 * twice over, once per row and again per probed row. Written as one arm per
 * policy and one arm per allowed scope it reached nineteen OR arms carrying
 * ~28 correlated subqueries for an ordinary org, and the same page query
 * measured in seconds instead of single-digit milliseconds.
 *
 * So the arms are collapsed to a fixed three. The per-provider and per-scope
 * arms were identical apart from the value they matched, and their `EXISTS`
 * clauses referenced only the row (`orgId`, `externalProvider`,
 * `classifiedPolicyRev`) — never the arm — so a set membership plus one
 * shared `EXISTS` says exactly what the union of the arms said.
 *
 * The `EXISTS` checks deliberately read the live policy and scope tables
 * rather than trusting the caller's snapshot: that is the fence which stops a
 * concurrent enable (or an ACL bump) from being authorized against a stale
 * decision. Collapsing the arms keeps that read — it just performs it once
 * instead of once per scope.
 */
export function sessionViewerSql(
  viewer: SessionFilterQuery['viewer'],
  alias: Prisma.Sql = Prisma.raw('s')
): Prisma.Sql | null {
  if (!viewer) return null
  const s = alias
  const direct = Prisma.sql`(
    (
      ${s}."externalProvider" IS NULL
      AND ${s}."visibility" = 'org'::"SessionVisibility"
    )
    OR (
      ${s}."visibility" = 'private'::"SessionVisibility"
      AND ${s}."ownerIdentity" IS NOT NULL
      AND ${s}."ownerIdentity" = ANY(${viewer.identitySet}::text[])
    )
  )`
  const snapshot = viewer.externalAccess
  if (!snapshot) return direct

  const externalArms: Prisma.Sql[] = []

  // Provider-wide arm. Every per-policy arm asked the same question of the
  // same row and differed only in which provider it matched, so the union is
  // "the row's provider is one we hold a policy for", plus the read fence.
  if (snapshot.policies.length > 0) {
    const providers = snapshot.policies.map((policy) => policy.provider)
    externalArms.push(Prisma.sql`(
      ${s}."externalProvider" = ANY(${providers}::text[])
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

  // Scope arm. `externalScopeId = ANY(...)` is the cheap sargable half; the
  // revision fence rides inside the scope lookup as a (scope, revision) pair,
  // which is what kept each arm honest when they were written out one by one.
  // `external_scope.id` is the primary key, so at most one row can match the
  // session's scope id and the pair check binds that row's revision to the
  // one this viewer was actually granted.
  if (snapshot.allowedScopes.length > 0) {
    const scopeIds = snapshot.allowedScopes.map((allowed) => allowed.id)
    const grantedPairs = snapshot.allowedScopes.map(
      (allowed) => Prisma.sql`(${allowed.id}::uuid, ${allowed.aclRevision}::bigint)`
    )
    externalArms.push(Prisma.sql`(
      ${s}."visibility" = 'external'::"SessionVisibility"
      AND ${s}."externalResolution" = 'settled'::"ExternalResolution"
      AND ${s}."externalScopeId" = ANY(${scopeIds}::uuid[])
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
          AND scope."revokedAt" IS NULL
          AND (scope."id", scope."aclRevision") IN (${Prisma.join(grantedPairs)})
      )
    )`)
  }

  return externalArms.length > 0 ? Prisma.sql`(${direct} OR ${Prisma.join(externalArms, ' OR ')})` : direct
}
