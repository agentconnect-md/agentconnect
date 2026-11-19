/**
 * PgUserRepo — WebUI human identity (design §3.2, §5.6).
 *
 * The human-auth plane verifies an OIDC bearer JWT, then calls this to map the
 * external `sub` to a LOCAL user row just-in-time. First sight of a subject is
 * signup: the user row is created (or an invited, email-only row is claimed by
 * setting its `oidcSubject`). Signup creates NO organization — a user who belongs
 * to none lands on org onboarding and creates or joins one explicitly.
 * Afterwards it's a cheap idempotent fetch. No passwords, no secrets —
 * the issuer owns authentication; this owns only the local mapping.
 *
 * Email trust: only a VERIFIED email (`emailVerified` — a signed token claim,
 * see `http/plugins/auth.ts`) may claim invited rows, upgrade a synthetic
 * placeholder, or be stored as the user's address. Emails are normalized to
 * lowercase everywhere so invites and sign-ins can't miss on case.
 */
import { randomInt } from 'node:crypto'
import { Prisma, withAmbientTx, type PrismaLike } from '../prisma.js'
import {
  type UserRepo,
  type ProvisionOidcUserInput,
  type IntegrationChannelKey,
  type MemberChatRelease,
  type MemberRemovalPreview,
  type MemberRemovalResult,
  type OrgMemberRecord,
  type OrgMemberRole,
  type VisibilityResourceKind,
  type UserProfileRecord,
  type ServiceAccountRecord,
  type ServiceAccountRole,
  NO_MEMBER_CHAT_RELEASE,
  SERVICE_ACCOUNT_EMAIL_DOMAIN,
  SYNTHETIC_EMAIL_SUFFIX,
  isSyntheticEmail
} from '../ports.js'
import { OrgMembershipMissing, OrgOwnerRequired, ServiceAccountNotAddable } from '../errors.js'
import { bumpAgentsLosingComputersTx } from './computer.repo.js'
import { IntegrationId } from '../../domain/ids.js'
import { ACTIVE_MEMBERSHIP } from '../active-membership.js'

const RESOURCE_AUDIENCE_TABLES = [
  'agent',
  'daemon',
  'cron_def',
  'mcp_provider',
  'skill_source',
  'decision',
  'computer'
] as const
const ORG_ROLE_RANK: Record<OrgMemberRole, number> = { viewer: 0, collaborator: 1, owner: 2 }

interface LockedOrgMembership {
  userId: string
  role: OrgMemberRole
  suspendedAt: Date | null
}

/**
 * One transaction-scoped mutex for every owner demotion/removal in an
 * organization. NO KEY UPDATE conflicts with another transition and org
 * deletion, but remains compatible with the KEY SHARE lock held by ordinary
 * resource writes.
 *
 * The parent row is always locked before child memberships.
 */
async function lockOrgOwnerTransition(tx: Prisma.TransactionClient, orgId: string): Promise<void> {
  const org = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "org"
    WHERE "id" = ${orgId}
    FOR NO KEY UPDATE
  `)
  if (org.length === 0) throw new OrgMembershipMissing()
}

async function lockOrgMemberships(
  tx: Prisma.TransactionClient,
  orgId: string,
  userIds: readonly string[]
): Promise<LockedOrgMembership[]> {
  const ids = [...new Set(userIds)].sort()
  return tx.$queryRaw<LockedOrgMembership[]>(Prisma.sql`
    SELECT "userId", "role"::text AS "role", "suspendedAt"
    FROM "membership"
    WHERE "orgId" = ${orgId}
      AND "userId" IN (${Prisma.join(ids)})
    ORDER BY "userId"
    FOR UPDATE
  `)
}

/**
 * Replace one local user identity with another in a resource's Selected
 * audience. Creator/modifier attribution is deliberately not touched.
 */
function mergeResourceAudienceSql(table: (typeof RESOURCE_AUDIENCE_TABLES)[number], from: string, to: string) {
  return Prisma.sql`
    UPDATE ${Prisma.raw(`"public"."${table}"`)} AS resource
    SET "sharedWith" = (
      SELECT COALESCE(array_agg(deduplicated.user_id ORDER BY deduplicated.first_ordinal), ARRAY[]::TEXT[])
      FROM (
        SELECT mapped.user_id, MIN(mapped.ordinality) AS first_ordinal
        FROM (
          SELECT
            CASE WHEN shared.user_id = ${from} THEN ${to} ELSE shared.user_id END AS user_id,
            shared.ordinality
          FROM unnest(COALESCE(resource."sharedWith", ARRAY[]::TEXT[]))
            WITH ORDINALITY AS shared(user_id, ordinality)
        ) AS mapped
        GROUP BY mapped.user_id
      ) AS deduplicated
    )
    WHERE ${from} = ANY(COALESCE(resource."sharedWith", ARRAY[]::TEXT[]))
  `
}

/** Kind label (the API's vocabulary) → the visibility-carrier table. */
const VISIBILITY_RESOURCE_KINDS = [
  ['agent', 'agent'],
  ['daemon', 'daemon'],
  ['cron', 'cron_def'],
  ['mcpProvider', 'mcp_provider'],
  ['skillSource', 'skill_source'],
  ['decision', 'decision'],
  ['computer', 'computer']
] as const satisfies ReadonlyArray<readonly [VisibilityResourceKind, (typeof RESOURCE_AUDIENCE_TABLES)[number]]>

interface SelectedResourceCountRow {
  kind: VisibilityResourceKind
  selected: number
  reassigned: number
}

/**
 * One kind's removal preview: Selected resources that include this member, and
 * the subset with no other current member that therefore needs a replacement.
 */
function selectedResourceCountsSql(
  table: (typeof RESOURCE_AUDIENCE_TABLES)[number],
  kind: VisibilityResourceKind,
  orgId: string,
  departingUserId: string
) {
  return Prisma.sql`
    SELECT
      ${kind} AS "kind",
      count(*)::int AS "selected",
      (count(*) FILTER (
        WHERE NOT EXISTS (
          SELECT 1
          FROM unnest(COALESCE(resource."sharedWith", ARRAY[]::TEXT[])) AS shared(user_id)
          JOIN "membership" AS other
            ON other."userId" = shared.user_id
           AND other."orgId" = resource."orgId"
          WHERE shared.user_id <> ${departingUserId}
        )
      ))::int AS "reassigned"
    FROM ${Prisma.raw(`"public"."${table}"`)} AS resource
    WHERE resource."orgId" = ${orgId}
      AND resource."visibility" = 'restricted'
      AND ${departingUserId} = ANY(COALESCE(resource."sharedWith", ARRAY[]::TEXT[]))
  `
}

/** Remove one member from every audience and add `replacementUserId` only when
 * a Selected resource would otherwise have no current member left. */
function removeMemberFromResourceAudiencesSql(
  table: (typeof RESOURCE_AUDIENCE_TABLES)[number],
  orgId: string,
  departingUserId: string,
  replacementUserId: string
) {
  return Prisma.sql`
    UPDATE ${Prisma.raw(`"public"."${table}"`)} AS resource
    SET "sharedWith" = CASE
      WHEN resource."visibility" = 'restricted'
       AND NOT EXISTS (
         SELECT 1
         FROM unnest(array_remove(COALESCE(resource."sharedWith", ARRAY[]::TEXT[]), ${departingUserId}))
           AS shared(user_id)
         JOIN "membership" AS remaining
           ON remaining."orgId" = resource."orgId"
          AND remaining."userId" = shared.user_id
       )
      THEN ARRAY[${replacementUserId}]::TEXT[]
      ELSE (
        SELECT COALESCE(array_agg(candidate.user_id ORDER BY candidate.first_ordinal), ARRAY[]::TEXT[])
        FROM (
          SELECT shared.user_id, MIN(shared.ordinality) AS first_ordinal
          FROM unnest(COALESCE(resource."sharedWith", ARRAY[]::TEXT[]))
            WITH ORDINALITY AS shared(user_id, ordinality)
          JOIN "membership" AS remaining
            ON remaining."orgId" = resource."orgId"
           AND remaining."userId" = shared.user_id
          WHERE shared.user_id <> ${departingUserId}
          GROUP BY shared.user_id
        ) AS candidate
      )
    END
    WHERE resource."orgId" = ${orgId}
      AND ${departingUserId} = ANY(COALESCE(resource."sharedWith", ARRAY[]::TEXT[]))
  `
}

// app_user row → the caller's own profile. Synthetic placeholder emails read as
// "no email" (never displayed), same as the member record below.
function toProfileRecord(u: {
  id: string
  email: string
  displayName: string | null
  picture: string | null
  profilePictureUpdatedAt: Date | null
}): UserProfileRecord {
  return {
    userId: u.id,
    email: isSyntheticEmail(u.email) ? null : u.email,
    displayName: u.displayName,
    picture: u.picture,
    profilePictureUpdatedAt: u.profilePictureUpdatedAt
  }
}

// membership + joined app_user → the console member record. Synthetic placeholder
// emails read as "no email" (never displayed).
function toMemberRecord(m: {
  userId: string
  role: string
  createdAt: Date
  user: {
    email: string
    displayName: string | null
    picture: string | null
    profilePictureUpdatedAt: Date | null
  }
}): OrgMemberRecord {
  return {
    userId: m.userId,
    email: isSyntheticEmail(m.user.email) ? null : m.user.email,
    displayName: m.user.displayName,
    picture: m.user.picture,
    profilePictureUpdatedAt: m.user.profilePictureUpdatedAt,
    role: m.role as OrgMemberRole,
    joinedAt: m.createdAt
  }
}

/**
 * Who repairs a Selected audience that would otherwise become empty
 * (resource-visibility.md §8.2).
 *
 * Removing someone else uses the acting organization owner; a member leaving
 * on their own uses the longest-standing remaining owner. `snapshot` must
 * already be ordered by membership age (ties by user id). Null means the
 * departing member is the final owner and removal must be refused.
 */
function chooseAudienceReplacement(
  snapshot: readonly { userId: string; role: OrgMemberRole }[],
  departingUserId: string,
  actingUserId: string
): string | null {
  if (departingUserId !== actingUserId) return actingUserId
  return snapshot.find((m) => m.role === 'owner' && m.userId !== departingUserId)?.userId ?? null
}

type MemberChange = 'member_added' | 'role_changed' | 'member_removed' | 'member_left'
const MEMBER_CHANGE_MESSAGE: Record<MemberChange, string> = {
  member_added: 'member added',
  role_changed: 'member role changed',
  member_removed: 'member removed',
  member_left: 'member left'
}

/** Recorded in the transaction that makes the change, by member id and never by address. */
function auditMemberChange(
  tx: Prisma.TransactionClient,
  orgId: string,
  actorUserId: string | null,
  action: MemberChange,
  details: { userId: string; role?: string; previousRole?: string }
) {
  return tx.auditEvent.create({
    data: {
      kind: 'member_change',
      orgId,
      actorUserId,
      message: MEMBER_CHANGE_MESSAGE[action],
      details: { action, ...details }
    }
  })
}

/** Member routes treat a service account as absent, and service-account routes treat a person as absent. */
async function assertUserKind(
  db: Pick<Prisma.TransactionClient, 'user'>,
  userId: string,
  kind: 'human' | 'service_account'
): Promise<void> {
  const row = await db.user.findUnique({ where: { id: userId }, select: { kind: true } })
  if (row && row.kind !== kind) throw new OrgMembershipMissing()
}

// Prune Selected audiences, repair only ones that would empty, close the member's chat access, then delete the membership; createdByUserId stays.
async function removeMembershipTx(
  tx: Prisma.TransactionClient,
  orgId: string,
  userId: string,
  actingUserId: string,
  chat: MemberChatRelease = NO_MEMBER_CHAT_RELEASE
): Promise<MemberRemovalResult> {
  await lockOrgOwnerTransition(tx, orgId)
  const membershipSnapshot = await tx.membership.findMany({
    where: { orgId },
    select: { userId: true, role: true, suspendedAt: true },
    orderBy: [{ createdAt: 'asc' }, { userId: 'asc' }]
  })
  const activeSnapshot = membershipSnapshot.filter((membership) => membership.suspendedAt === null)
  const actor = activeSnapshot.find((membership) => membership.userId === actingUserId)
  const departing = membershipSnapshot.find((membership) => membership.userId === userId)
  const leaving = userId === actingUserId
  if (!departing || !actor || (!leaving && actor.role !== 'owner')) throw new OrgMembershipMissing()

  const replacementUserId = chooseAudienceReplacement(activeSnapshot, userId, actingUserId)
  if (!replacementUserId) throw new OrgOwnerRequired()

  // Fence audience writes on both ends and recheck the snapshot; the transition lock holds out competing removals.
  const locked = await lockOrgMemberships(tx, orgId, [userId, replacementUserId])
  const byUserId = new Map(locked.map((membership) => [membership.userId, membership]))
  const replacement = byUserId.get(replacementUserId)
  if (!byUserId.has(userId) || replacement?.role !== 'owner' || replacement.suspendedAt !== null) {
    throw new OrgMembershipMissing()
  }

  for (const table of RESOURCE_AUDIENCE_TABLES) {
    await tx.$executeRaw(removeMemberFromResourceAudiencesSql(table, orgId, userId, replacementUserId))
  }
  // A departing member's own desktops leave with them: revoke the Computers and their keys (computer-use.md §3.6).
  const computerAgents = await revokeOwnedComputersTx(tx, orgId, userId)
  const removedIntegrationIds = await deleteBoundBotsTx(tx, orgId, chat.botIds)
  const closedDirectMessages = await closeDirectMessagesTx(tx, orgId, chat.directMessages)
  // The member's own keys and grants end here and do not come back with a later membership; keys they minted for the organization stay.
  const endedAt = new Date()
  await tx.apiKey.updateMany({
    where: { orgId, userId, principalType: { in: ['user', 'oauth'] }, revokedAt: null },
    data: { revokedAt: endedAt, revokedReason: 'member removed' }
  })
  await tx.oAuthGrant.updateMany({ where: { orgId, userId, revokedAt: null }, data: { revokedAt: endedAt } })
  // A membership-delete trigger ends GitLab OAuth authority (§9.4) on every removal path.
  await tx.membership.delete({ where: { orgId_userId: { orgId, userId } } })
  return { computerAgents, removedIntegrationIds, closedDirectMessages }
}

// A bot bound to the departing member goes with every install; its secret cascades (resource-visibility.md §8.3).
async function deleteBoundBotsTx(
  tx: Prisma.TransactionClient,
  orgId: string,
  botIds: readonly string[]
): Promise<IntegrationId[]> {
  if (botIds.length === 0) return []
  const where = { orgId, botId: { in: [...botIds] } }
  const installs = await tx.integration.findMany({ where, select: { id: true, status: true } })
  await tx.integration.deleteMany({ where })
  await tx.bot.deleteMany({ where: { orgId, id: { in: [...botIds] } } })
  return installs.filter((i) => i.status === 'active').map((i) => IntegrationId(i.id))
}

// DM rows opened for the departing member go back to Off, unchosen, so a later re-share can open them again (§14.8).
async function closeDirectMessagesTx(
  tx: Prisma.TransactionClient,
  orgId: string,
  rows: readonly IntegrationChannelKey[]
): Promise<IntegrationChannelKey[]> {
  const closed: IntegrationChannelKey[] = []
  for (const { integrationId, channelId } of rows) {
    const res = await tx.integrationChannel.updateMany({
      where: { integrationId, channelId, kind: 'im', trigger: { not: 'off' }, integration: { orgId } },
      data: {
        trigger: 'off',
        triggerChosen: false,
        decisionBinding: Prisma.DbNull,
        decisionId: null,
        decisionNeedsReview: false
      }
    })
    if (res.count > 0) closed.push({ integrationId, channelId })
  }
  return closed
}

// What removal would still change of `chat`: bound bots that exist, and distinct DM conversations still open.
async function chatReleaseCounts(
  db: PrismaLike,
  orgId: string,
  chat: MemberChatRelease
): Promise<MemberRemovalPreview['chat']> {
  const bots = chat.botIds.length ? await db.bot.count({ where: { orgId, id: { in: [...chat.botIds] } } }) : 0
  if (chat.directMessages.length === 0) return { bots, directMessages: 0 }
  const open = await db.integrationChannel.findMany({
    where: {
      OR: chat.directMessages.map(({ integrationId, channelId }) => ({ integrationId, channelId })),
      kind: 'im',
      trigger: { not: 'off' },
      integration: { orgId }
    },
    select: { channelId: true, integration: { select: { botId: true } } }
  })
  return { bots, directMessages: new Set(open.map((row) => `${row.integration.botId}\x00${row.channelId}`)).size }
}

async function revokeOwnedComputersTx(
  tx: Prisma.TransactionClient,
  orgId: string,
  ownerUserId: string
): Promise<'all' | string[]> {
  // Unspent tokens leave too, so a re-added member cannot redeem one minted before the removal.
  await tx.computerRegistration.deleteMany({ where: { orgId, createdByUserId: ownerUserId, consumedAt: null } })
  const owned = await tx.computer.findMany({
    where: { orgId, ownerUserId },
    select: { id: true, status: true, allocation: true, agentAccess: true, accessAgentIds: true }
  })
  if (owned.length === 0) return []
  // Agents whose derived lists lose these Computers take a new revision, or a reconnect's changed spec is refused.
  const affected = await bumpAgentsLosingComputersTx(tx, orgId, owned)
  const at = new Date()
  const ids = owned.map((c) => c.id)
  await tx.apiKey.updateMany({
    where: { computerId: { in: ids }, revokedAt: null },
    data: { revokedAt: at, revokedReason: 'owner left the organization' }
  })
  await tx.computer.updateMany({
    where: { id: { in: ids }, status: { not: 'revoked' } },
    data: { status: 'revoked', revokedAt: at }
  })
  return affected
}

const isP2002 = (err: unknown): boolean => (err as { code?: string }).code === 'P2002'

// Six random base-36 characters keep the local part within Google's 30-character account id alongside a 23-character name.
const SUFFIX_LENGTH = 6
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
const serviceAccountEmail = (name: string) => {
  const suffix = Array.from({ length: SUFFIX_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')
  return `${name}-${suffix}@${SERVICE_ACCOUNT_EMAIL_DOMAIN}`
}

// The name is the address's local part minus the `-<suffix>`, so it needs no column of its own.
function toServiceAccountRecord(m: {
  userId: string
  role: string
  createdAt: Date
  user: { email: string; displayName: string | null }
}): ServiceAccountRecord {
  const local = m.user.email.slice(0, m.user.email.indexOf('@'))
  const name = local.slice(0, local.length - SUFFIX_LENGTH - 1)
  return {
    userId: m.userId,
    name,
    email: m.user.email,
    displayName: m.user.displayName ?? name,
    role: m.role as ServiceAccountRole,
    createdAt: m.createdAt
  }
}

/** An invite is claimed by its verified address alone; a row an organization's directory manages only by a sign-in through that organization's own active SSO connection, for every such organization. */
async function signInMayClaim(
  tx: Prisma.TransactionClient,
  userId: string,
  ssoConnectorId: string | null
): Promise<boolean> {
  const managed = await tx.membership.findMany({ where: { userId, managedBy: 'directory' }, select: { orgId: true } })
  if (managed.length === 0) return true
  if (ssoConnectorId === null) return false
  const orgIds = [...new Set(managed.map((membership) => membership.orgId))]
  const vouched = await tx.orgSsoConnection.count({
    where: { orgId: { in: orgIds }, logtoConnectorId: ssoConnectorId, activatedAt: { not: null } }
  })
  return vouched === orgIds.length
}

export class PgUserRepo implements UserRepo {
  constructor(private readonly db: PrismaLike) {}

  async provisionOidcUser(input: ProvisionOidcUserInput): Promise<{ userId: string }> {
    const { oidcSubject, displayName, picture } = input
    // Only a verified email may participate in identity matching (claiming an
    // invited row / becoming the stored address) — an unverified hint could
    // squat a victim's pending invite. Normalized so lookups can't miss on case.
    const email = input.emailVerified ? input.email?.trim().toLowerCase() : undefined

    // Fast path: known subject.
    const existing = await this.db.user.findUnique({ where: { oidcSubject } })
    if (existing) {
      if (email && isSyntheticEmail(existing.email)) {
        await this.upgradeSyntheticEmail(existing.id, email, input.ssoConnectorId ?? null)
      }
      // Avatars change (a new photo, a switched provider) — keep the stored URL
      // fresh. Cheap: the auth plane memoizes this per subject, so it runs at
      // most once per CP process per user, and only writes on an actual change.
      if (picture && existing.picture !== picture) {
        await this.db.user.update({ where: { id: existing.id }, data: { picture } }).catch(() => {})
      }
      return { userId: existing.id }
    }

    // Unknown subject = first login. An owner may have pre-added this email as an
    // invited member (a user row with no `oidcSubject`) — claim that row instead
    // of creating a duplicate.
    let storedEmail = email
    if (email) {
      const invited = await this.db.user.findUnique({ where: { email } })
      // A service account has no subject either, but it is never an invite to claim.
      if (invited && !invited.oidcSubject && invited.kind === 'human') {
        // Guarded claim: only bind our subject if the row is STILL unclaimed —
        // count 0 means a concurrent racer (same or another subject) won.
        const claimed = await withAmbientTx(this.db, async (tx) => {
          // The row lock holds off a membership being added to it until the claim has settled.
          await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "app_user" WHERE "id" = ${invited.id} FOR UPDATE`)
          if (!(await signInMayClaim(tx, invited.id, input.ssoConnectorId ?? null))) return false
          const res = await tx.user.updateMany({
            where: { id: invited.id, oidcSubject: null, kind: 'human' },
            data: {
              oidcSubject,
              ...(displayName && !invited.displayName ? { displayName } : {}),
              ...(picture ? { picture } : {})
            }
          })
          return res.count === 1
        })
        if (claimed) return { userId: invited.id }
        const winner = await this.db.user.findUnique({ where: { oidcSubject } })
        if (winner) return { userId: winner.id }
        // The row was claimed by a DIFFERENT subject — fall through and create
        // ourselves with a synthetic email (the unique email stays with them).
      }
      // Same email under a DIFFERENT subject already exists (unusual — e.g. two
      // IdPs). Store a synthetic email for the new subject so login still works;
      // the unique email stays with its first owner.
      if (invited) storedEmail = undefined
    }

    let user
    try {
      user = await this.db.user.create({
        data: {
          oidcSubject,
          email: storedEmail ?? `${oidcSubject}${SYNTHETIC_EMAIL_SUFFIX}`,
          ...(displayName ? { displayName } : {}),
          ...(picture ? { picture } : {})
        }
      })
    } catch (err) {
      // Lost a same-subject race (unique oidcSubject) — the winner's row is ours.
      if (isP2002(err)) {
        const winner = await this.db.user.findUnique({ where: { oidcSubject } })
        if (winner) return { userId: winner.id }
      }
      throw err
    }
    return { userId: user.id }
  }

  /**
   * A verified email arrived for a user still holding a synthetic placeholder.
   * Plain case: rename. Collision case: the email is held by an UNCLAIMED
   * invited row — merge it (move its memberships here, drop the row) so the
   * invite reaches the person it was meant for; any other holder wins and the
   * placeholder stays.
   */
  private async upgradeSyntheticEmail(userId: string, email: string, ssoConnectorId: string | null): Promise<void> {
    // A new membership can appear between the discovery read and our locks
    // (another owner may invite this email to a second org). Retry from a fresh
    // snapshot instead of locking a newly discovered child after its parent/user:
    // that would invert the resource-write lock order.
    for (let attempt = 0; attempt < 3; attempt++) {
      const holder = await this.db.user.findUnique({ where: { email }, include: { memberships: true } })
      if (!holder) {
        try {
          await this.db.user.update({ where: { id: userId }, data: { email } })
          return
        } catch (err) {
          // An invite may have created the email holder after the lookup. Retry
          // from a fresh snapshot so its memberships and resource authority are
          // merged instead of caching a false-success provisioning result.
          if (isP2002(err)) continue
          throw err
        }
      }
      if (holder.id === userId || holder.oidcSubject || holder.kind !== 'human') return

      const expectedOrgIds = [...new Set(holder.memberships.map((membership) => membership.orgId))].sort()
      const userIds = [holder.id, userId].sort()
      const outcome = await withAmbientTx(this.db, async (tx) => {
        // Parent before child, matching every membership transition. NO KEY
        // UPDATE serializes owner-role merges with demotion/removal while
        // remaining compatible with ordinary resource writers' KEY SHARE.
        // Lock multiple parents one statement at a time in sorted order; ORDER
        // BY on one multi-row SELECT does not guarantee row-lock acquisition
        // order.
        for (const orgId of expectedOrgIds) {
          const lockedOrg = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
            SELECT "id"
            FROM "org"
            WHERE "id" = ${orgId}
            FOR NO KEY UPDATE
          `)
          if (lockedOrg.length === 0) return 'retry' as const
        }

        // Fence both the invited identity and the canonical recipient across all
        // currently observed orgs. Stable (orgId, userId) order matches the
        // member-removal/resource-write protocol.
        const lockedMemberships =
          expectedOrgIds.length === 0
            ? []
            : await tx.$queryRaw<Array<{ id: string; orgId: string; userId: string }>>(Prisma.sql`
                SELECT "id", "orgId", "userId"
                FROM "membership"
                WHERE "orgId" IN (${Prisma.join(expectedOrgIds)})
                  AND "userId" IN (${Prisma.join(userIds)})
                ORDER BY "orgId", "userId"
                FOR UPDATE
              `)

        // Membership/resource writers take their membership locks before an FK
        // can lock app_user. Keep that order here too.
        const lockedUsers = await tx.$queryRaw<
          Array<{ id: string; email: string; oidcSubject: string | null; kind: string }>
        >(
          Prisma.sql`
            SELECT "id", "email", "oidcSubject", "kind"::text AS "kind"
            FROM "app_user"
            WHERE "id" IN (${Prisma.join(userIds)})
            ORDER BY "id"
            FOR UPDATE
          `
        )
        const byId = new Map(lockedUsers.map((user) => [user.id, user]))
        const lockedHolder = byId.get(holder.id)
        const canonical = byId.get(userId)
        if (
          !lockedHolder ||
          !canonical ||
          lockedHolder.email !== email ||
          lockedHolder.oidcSubject !== null ||
          lockedHolder.kind !== 'human' ||
          !isSyntheticEmail(canonical.email)
        ) {
          return 'retry' as const
        }

        // The app_user locks now block any later membership FK insert. Re-read
        // and ensure every currently committed row was among the rows locked
        // above; otherwise end this no-write attempt and acquire the wider sorted
        // lock set on the next pass.
        const currentMemberships = await tx.membership.findMany({
          where: {
            OR: [
              { userId: holder.id },
              ...(expectedOrgIds.length > 0 ? [{ userId, orgId: { in: expectedOrgIds } }] : [])
            ]
          }
        })
        const lockedMembershipIds = new Set(lockedMemberships.map((membership) => membership.id))
        if (currentMemberships.some((membership) => !lockedMembershipIds.has(membership.id))) {
          return 'retry' as const
        }

        const holderMemberships = currentMemberships.filter((membership) => membership.userId === holder.id)
        // Checked under the locks: the invited row's memberships can no longer change.
        if (!(await signInMayClaim(tx, holder.id, ssoConnectorId))) return 'refused' as const
        const canonicalByOrg = new Map(
          currentMemberships
            .filter((membership) => membership.userId === userId)
            .map((membership) => [membership.orgId, membership])
        )
        const missingMemberships = holderMemberships.filter((membership) => !canonicalByOrg.has(membership.orgId))
        if (missingMemberships.length > 0) {
          await tx.membership.createMany({
            data: missingMemberships.map((membership) => ({
              orgId: membership.orgId,
              userId,
              role: membership.role,
              suspendedAt: membership.suspendedAt,
              suspendedBy: membership.suspendedBy,
              managedBy: membership.managedBy
            })),
            skipDuplicates: true
          })
        }
        // A duplicate membership keeps the stronger role. Otherwise merging an
        // invited owner into a canonical collaborator could delete the org's
        // final owner along with the invited placeholder.
        for (const membership of holderMemberships) {
          const canonicalMembership = canonicalByOrg.get(membership.orgId)
          if (
            canonicalMembership &&
            ORG_ROLE_RANK[membership.role as OrgMemberRole] > ORG_ROLE_RANK[canonicalMembership.role as OrgMemberRole]
          ) {
            await tx.membership.update({
              where: { id: canonicalMembership.id },
              data: { role: membership.role }
            })
          }
        }

        // sharedWith has no FK, so deleting the invited row alone would strand
        // a stale audience id. Preserve first-seen order while de-duplicating.
        for (const table of RESOURCE_AUDIENCE_TABLES) {
          await tx.$executeRaw(mergeResourceAudienceSql(table, holder.id, userId))
        }

        await tx.user.delete({ where: { id: holder.id } }) // frees the unique email
        await tx.user.update({ where: { id: userId }, data: { email } })
        return 'merged' as const
      })
      if (outcome === 'merged' || outcome === 'refused') return
    }

    // A rejected provisioning promise is evicted by the auth plugin, so the
    // caller can retry from a fresh membership snapshot instead of being
    // silently memoized without its invite.
    throw new Error('identity membership changed during merge; retry sign-in')
  }

  async exists(userId: string): Promise<boolean> {
    // Primary-key probe, selecting nothing but the key — this runs on every
    // authenticated request, so it must stay a single index lookup.
    return (await this.db.user.findUnique({ where: { id: userId }, select: { id: true } })) != null
  }

  async recordDeletedIdentity(oidcSubject: string, cutoffAt: Date, expiresAt: Date): Promise<void> {
    const { count } = await this.db.deletedIdentityCutoff.createMany({
      data: [{ oidcSubject, cutoffAt, expiresAt }],
      skipDuplicates: true
    })
    if (count === 0) {
      // A cutoff only ever moves FORWARD — guarded in the WHERE so a slower
      // observation of an OLDER deletion cannot reopen a window a newer one closed.
      await this.db.deletedIdentityCutoff.updateMany({
        where: { oidcSubject, cutoffAt: { lt: cutoffAt } },
        data: { cutoffAt, expiresAt }
      })
    }
    // Opportunistic prune — no scheduler needed for a table that holds at most one
    // short-lived row per deleted identity. Housekeeping: never fail the write it
    // rode along with.
    await this.db.deletedIdentityCutoff.deleteMany({ where: { expiresAt: { lte: cutoffAt } } }).catch(() => {})
  }

  async deletedIdentityCutoff(oidcSubject: string, now: Date): Promise<Date | null> {
    const row = await this.db.deletedIdentityCutoff.findUnique({
      where: { oidcSubject },
      select: { cutoffAt: true, expiresAt: true }
    })
    if (!row || row.expiresAt <= now) return null
    return row.cutoffAt
  }

  async listMembers(orgId: string): Promise<OrgMemberRecord[]> {
    const rows = await this.db.membership.findMany({
      where: { orgId, user: { kind: 'human' }, ...ACTIVE_MEMBERSHIP },
      include: { user: true },
      orderBy: [{ createdAt: 'asc' }, { userId: 'asc' }]
    })
    return rows.map(toMemberRecord)
  }

  async setMemberRole(
    orgId: string,
    userId: string,
    role: OrgMemberRole,
    actingUserId: string
  ): Promise<OrgMemberRecord> {
    return withAmbientTx(this.db, async (tx) => {
      await assertUserKind(tx, userId, 'human')
      await lockOrgOwnerTransition(tx, orgId)
      const memberships = await lockOrgMemberships(tx, orgId, [actingUserId, userId])
      const actor = memberships.find((membership) => membership.userId === actingUserId)
      const current = memberships.find((membership) => membership.userId === userId)
      if (actor?.role !== 'owner' || actor.suspendedAt !== null || !current) throw new OrgMembershipMissing()
      if (
        current.role === 'owner' &&
        current.suspendedAt === null &&
        role !== 'owner' &&
        (await tx.membership.count({ where: { orgId, role: 'owner', ...ACTIVE_MEMBERSHIP } })) === 1
      ) {
        throw new OrgOwnerRequired()
      }

      const row = await tx.membership.update({
        where: { orgId_userId: { orgId, userId } },
        data: { role },
        include: { user: true }
      })
      if (current.role !== role) {
        await auditMemberChange(tx, orgId, actingUserId, 'role_changed', { userId, role, previousRole: current.role })
      }
      return toMemberRecord(row)
    })
  }

  async addMemberByEmail(
    orgId: string,
    email: string,
    role: OrgMemberRole,
    actingUserId?: string
  ): Promise<OrgMemberRecord> {
    // Reuse the existing user for this email, else create an invited (email-only)
    // row the person claims on first SSO sign-in. `upsert` keyed on the unique
    // email keeps two racers from colliding; normalized like the claim path.
    const normalized = email.trim().toLowerCase()
    const user = await this.db.user.upsert({ where: { email: normalized }, create: { email: normalized }, update: {} })
    if (user.kind !== 'human') throw new ServiceAccountNotAddable()
    return withAmbientTx(this.db, async (tx) => {
      const row = await tx.membership.create({
        data: { orgId, userId: user.id, role },
        include: { user: true }
      })
      await auditMemberChange(tx, orgId, actingUserId ?? null, 'member_added', { userId: user.id, role })
      return toMemberRecord(row)
    })
  }

  async removeMember(
    orgId: string,
    userId: string,
    actingUserId: string,
    chat?: MemberChatRelease
  ): Promise<MemberRemovalResult> {
    return withAmbientTx(this.db, async (tx) => {
      await assertUserKind(tx, userId, 'human')
      const removed = await removeMembershipTx(tx, orgId, userId, actingUserId, chat)
      const action = userId === actingUserId ? 'member_left' : 'member_removed'
      await auditMemberChange(tx, orgId, actingUserId, action, { userId })
      return removed
    })
  }

  async previewMemberRemoval(
    orgId: string,
    userId: string,
    actingUserId: string,
    chat: MemberChatRelease = NO_MEMBER_CHAT_RELEASE
  ): Promise<MemberRemovalPreview> {
    // Unlocked and outside any transaction: this only feeds a confirmation
    // dialog. `removeMember` re-derives everything under the transition lock.
    await assertUserKind(this.db, userId, 'human')
    const rows = await this.db.membership.findMany({
      where: { orgId },
      include: { user: true },
      orderBy: [{ createdAt: 'asc' }, { userId: 'asc' }]
    })
    if (!rows.some((row) => row.userId === userId)) throw new OrgMembershipMissing()

    const replacementId = chooseAudienceReplacement(
      rows
        .filter((row) => row.suspendedAt === null)
        .map((row) => ({ userId: row.userId, role: row.role as OrgMemberRole })),
      userId,
      actingUserId
    )
    const replacement = rows.find((row) => row.userId === replacementId)

    const counts = await this.db.$queryRaw<SelectedResourceCountRow[]>(
      Prisma.join(
        VISIBILITY_RESOURCE_KINDS.map(([kind, table]) => selectedResourceCountsSql(table, kind, orgId, userId)),
        ' UNION ALL '
      )
    )
    // UNION ALL has no defined order; re-impose the declared one so the dialog
    // always lists kinds the same way.
    const byKind = new Map(counts.map((row) => [row.kind, row]))

    return {
      replacement: replacement ? toMemberRecord(replacement) : null,
      resources: VISIBILITY_RESOURCE_KINDS.map(([kind]) => byKind.get(kind)).filter(
        (row) => row !== undefined && row.selected > 0
      ) as MemberRemovalPreview['resources'],
      chat: await chatReleaseCounts(this.db, orgId, chat)
    }
  }

  async addMember(orgId: string, userId: string, role: OrgMemberRole): Promise<void> {
    await this.db.membership.create({ data: { orgId, userId, role } })
  }

  async listServiceAccounts(orgId: string): Promise<ServiceAccountRecord[]> {
    const rows = await this.db.membership.findMany({
      where: { orgId, user: { kind: 'service_account' } },
      include: { user: true },
      orderBy: [{ createdAt: 'asc' }, { userId: 'asc' }]
    })
    return rows.map(toServiceAccountRecord)
  }

  async getServiceAccount(orgId: string, userId: string): Promise<ServiceAccountRecord | null> {
    const row = await this.db.membership.findFirst({
      where: { orgId, userId, user: { kind: 'service_account' } },
      include: { user: true }
    })
    return row ? toServiceAccountRecord(row) : null
  }

  async createServiceAccount(
    orgId: string,
    input: { name: string; role: ServiceAccountRole }
  ): Promise<ServiceAccountRecord> {
    // A suffix collision fails the unique email; draw a new one rather than surface it.
    for (let attempt = 0; ; attempt++) {
      try {
        const row = await this.db.membership.create({
          data: {
            role: input.role,
            org: { connect: { id: orgId } },
            user: {
              create: { kind: 'service_account', email: serviceAccountEmail(input.name), displayName: input.name }
            }
          },
          include: { user: true }
        })
        return toServiceAccountRecord(row)
      } catch (err) {
        if (!isP2002(err) || attempt >= 2) throw err
      }
    }
  }

  async updateServiceAccount(
    orgId: string,
    userId: string,
    patch: { displayName?: string; role?: ServiceAccountRole }
  ): Promise<ServiceAccountRecord> {
    return withAmbientTx(this.db, async (tx) => {
      const current = await tx.membership.findFirst({
        where: { orgId, userId, user: { kind: 'service_account' } },
        select: { id: true }
      })
      if (!current) throw new OrgMembershipMissing()
      if (patch.displayName !== undefined) {
        await tx.user.update({ where: { id: userId }, data: { displayName: patch.displayName } })
      }
      const row = await tx.membership.update({
        where: { id: current.id },
        data: patch.role !== undefined ? { role: patch.role } : {},
        include: { user: true }
      })
      return toServiceAccountRecord(row)
    })
  }

  async deleteServiceAccount(orgId: string, userId: string, actingUserId: string): Promise<void> {
    await withAmbientTx(this.db, async (tx) => {
      await assertUserKind(tx, userId, 'service_account')
      await removeMembershipTx(tx, orgId, userId, actingUserId)
      // Keys and webchat conversations cascade with the row.
      await tx.user.delete({ where: { id: userId } })
    })
  }

  async isServiceAccount(userId: string): Promise<boolean> {
    const row = await this.db.user.findUnique({ where: { id: userId }, select: { kind: true } })
    return row?.kind === 'service_account'
  }

  async getProfile(userId: string): Promise<UserProfileRecord | null> {
    const user = await this.db.user.findUnique({ where: { id: userId } })
    return user ? toProfileRecord(user) : null
  }

  async updateProfile(userId: string, patch: { displayName: string }): Promise<UserProfileRecord> {
    // Only the display name — email is immutable through this path (the OIDC
    // provider owns it; see the port contract).
    const user = await this.db.user.update({
      where: { id: userId },
      data: { displayName: patch.displayName }
    })
    return toProfileRecord(user)
  }

  async setProfilePicture(userId: string, updatedAt: Date): Promise<UserProfileRecord> {
    const user = await this.db.user.update({ where: { id: userId }, data: { profilePictureUpdatedAt: updatedAt } })
    return toProfileRecord(user)
  }

  async clearProfilePicture(userId: string): Promise<UserProfileRecord> {
    const user = await this.db.user.update({ where: { id: userId }, data: { profilePictureUpdatedAt: null } })
    return toProfileRecord(user)
  }

  async getOidcSubject(userId: string): Promise<string | null> {
    const row = await this.db.user.findUnique({ where: { id: userId }, select: { oidcSubject: true } })
    return row?.oidcSubject ?? null
  }

  async getGoogleAccountId(userId: string): Promise<string | null> {
    const row = await this.db.user.findUnique({ where: { id: userId }, select: { googleAccountId: true } })
    return row?.googleAccountId ?? null
  }

  async setGoogleAccountId(userId: string, googleAccountId: string | null): Promise<void> {
    await withAmbientTx(this.db, async (tx) => {
      // The identity provider moved the Google account to this user, so a stale holder lets go of it first.
      if (googleAccountId !== null) {
        await tx.user.updateMany({ where: { googleAccountId, NOT: { id: userId } }, data: { googleAccountId: null } })
      }
      await tx.user.updateMany({ where: { id: userId }, data: { googleAccountId } })
    })
  }
}
