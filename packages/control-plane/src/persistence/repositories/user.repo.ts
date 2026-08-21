/**
 * PgUserRepo — WebUI human identity (design §3.2, §5.6).
 *
 * The human-auth plane verifies an OIDC bearer JWT, then calls this to map the
 * external `sub` to a LOCAL user row just-in-time. First sight of a subject is
 * signup: the user row is created (or an invited, email-only row is claimed by
 * setting its `oidcSubject`) and a personal org is created with the user as its
 * owner. Afterwards it's a cheap idempotent fetch. No passwords, no secrets —
 * the issuer owns authentication; this owns only the local mapping.
 *
 * Email trust: only a VERIFIED email (`emailVerified` — a signed token claim,
 * see `http/plugins/auth.ts`) may claim invited rows, upgrade a synthetic
 * placeholder, or be stored as the user's address. Emails are normalized to
 * lowercase everywhere so invites and sign-ins can't miss on case.
 */
import { Prisma, withAmbientTx, type PrismaLike } from '../prisma.js'
import {
  type UserRepo,
  type ProvisionOidcUserInput,
  type MemberRemovalPreview,
  type OrgMemberRecord,
  type OrgMemberRole,
  type VisibilityResourceKind,
  type UserProfileRecord,
  SYNTHETIC_EMAIL_SUFFIX,
  isSyntheticEmail
} from '../ports.js'
import { provisionPresetAgents, type PresetPoolPlacement } from '../preset-agents.js'
import { OrgMembershipMissing, OrgOwnerRequired } from '../errors.js'

const RESOURCE_AUDIENCE_TABLES = ['agent', 'daemon', 'cron_def', 'mcp_provider', 'skill_source'] as const
const ORG_ROLE_RANK: Record<OrgMemberRole, number> = { viewer: 0, collaborator: 1, owner: 2 }

interface LockedOrgMembership {
  userId: string
  role: OrgMemberRole
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
    SELECT "userId", "role"::text AS "role"
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
  ['skillSource', 'skill_source']
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

/** `Dana Reyes <dana@acme.dev>` → base label `dana` for the personal-org name/slug. */
function personalOrgBase(displayName?: string | null, email?: string | null): string {
  const fromName = displayName?.trim().split(/\s+/)[0]
  const fromEmail = email && !isSyntheticEmail(email) ? email.split('@')[0] : undefined
  return (fromName || fromEmail || 'my').toLowerCase()
}

/** Lowercase letters/digits/hyphens, no leading/trailing hyphen — the org-slug shape. */
function slugify(base: string): string {
  const s = base
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return s || 'org'
}

const isP2002 = (err: unknown): boolean => (err as { code?: string }).code === 'P2002'

/**
 * Give `userId` a personal org they own (idempotent: no-op when they already own
 * one). Extracted as a free function so the waitlist redeem transaction can create
 * the personal org at ACTIVATION time (waitlist-and-login.md §6) sharing the exact
 * same slug-allocation logic as signup. `db` may be an interactive transaction
 * client. Slug collisions fall back to a numeric suffix, then a userId-derived slug.
 *
 * ATOMIC (preset-agents.md §3.2): the whole body runs in ONE transaction —
 * `withAmbientTx` opens it on a root client and composes under the waitlist
 * redeem's existing one. The org, its membership, the preset agent, and the
 * `preset_agent` marker must commit together: the marker is the idempotency
 * record, so a crash that committed the agent but not the marker would leave the
 * next boot's backfill seeing a reserved-slug collision and permanently recording
 * `skipped` — a marker that no longer describes the preset that exists, with no
 * repair path (creation has no later trigger). Rollback is the only safe answer.
 *
 * Each candidate is claimed with a conflict-TOLERANT insert (`createMany` +
 * `skipDuplicates` ⇒ `INSERT … ON CONFLICT DO NOTHING`), which reports a taken slug as
 * `count: 0` instead of raising. Never allocate by catching the unique violation of a
 * plain INSERT: this now ALWAYS runs inside an interactive transaction, and in
 * Postgres ANY failed statement aborts the WHOLE transaction — the caught P2002
 * would poison every following query with 25P02 and surface as a 500. A read-then-insert
 * has the same flaw, since two concurrent allocations can pick the same free candidate.
 *
 * PER-USER SERIALIZATION: the first statement locks the `app_user` row
 * (`SELECT … FOR UPDATE`), making THIS seam the single serialization point for
 * every personal-org caller — including callers in the external admin app,
 * which mirrors this seam over the shared database. Without it, two paths that
 * otherwise lock disjoint rows (e.g. waitlist redeem, which locks only the
 * `waitlist_entry` row when the user is ALREADY activated and so skips the
 * `user.update`, racing an admin-side activation repair) can both observe "no
 * owner membership" and each mint a personal org + preset. The loser of this
 * lock resumes after the winner commits; READ COMMITTED re-reads then see the
 * winner's membership and the call degrades to the idempotent no-op.
 */
export async function ensurePersonalOrg(
  db: PrismaLike,
  userId: string,
  displayName?: string | null,
  email?: string | null,
  opts?: { presetAgents?: boolean; presetPool?: PresetPoolPlacement | null }
): Promise<void> {
  await withAmbientTx(db, async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "app_user" WHERE "id" = ${userId} FOR UPDATE`)
    const already = await tx.membership.findFirst({ where: { userId, role: 'owner' } })
    if (already) return
    const base = personalOrgBase(displayName, email)
    const name = `${base.charAt(0).toUpperCase()}${base.slice(1)}'s organization`
    const baseSlug = slugify(base)
    const candidates = [baseSlug, `${baseSlug}-2`, `${baseSlug}-3`, `org-${userId.slice(-8).toLowerCase()}`]
    for (const slug of candidates) {
      // `count: 0` ⇒ the slug is taken (by a committed row, or by a concurrent inserter
      // this statement waited on) — move to the next candidate with the transaction
      // still healthy. `count: 1` ⇒ the row is OURS, and `slug` is unique, so reading it
      // back by slug cannot pick up someone else's org.
      const { count } = await tx.org.createMany({
        data: [{ name, slug, createdByUserId: userId }],
        skipDuplicates: true
      })
      if (count === 0) continue
      const org = await tx.org.findUniqueOrThrow({ where: { slug }, select: { id: true } })
      await tx.membership.create({ data: { orgId: org.id, userId, role: 'owner' } })
      // Org-creation seam (preset-agents.md §3.2): a new personal org is born with
      // the `agentconnect` general preset. A brand-new org cannot collide on the
      // reserved slug, so no expected-failure statement runs here — safe under an
      // ambient transaction. A throw rolls the org + membership back with it (no
      // compensating delete needed, and none would be legal on an aborted tx).
      if (opts?.presetAgents !== false) {
        await provisionPresetAgents(tx, { orgId: org.id, createdByUserId: userId, pool: opts?.presetPool ?? null })
      }
      return
    }
    throw new Error('could not allocate a unique slug for the personal org')
  })
}

export class PgUserRepo implements UserRepo {
  /**
   * @param provisionPersonalOrgOnSignup When false (WAITLIST_MODE on), JIT signup
   *  does NOT create a personal org — the org is created only when the user redeems
   *  their join link (waitlist-and-login.md §6/§8). Default true = the OSS behavior
   *  where every login lands in an owned workspace.
   */
  constructor(
    private readonly db: PrismaLike,
    private readonly provisionPersonalOrgOnSignup = true,
    /** Provision preset agents with each personal org (preset-agents.md §3.2).
     *  Deploy-time opt-out rides PRESET_AGENTS_ENABLED. */
    private readonly presetAgents = true,
    /** Exec config the preset is born with on a pool-backed install (§3.2); null ⇒ born
     *  unplaced. Rides PRESET_AGENT_POOL_RUNTIME/_MODEL. */
    private readonly presetPool: PresetPoolPlacement | null = null
  ) {}

  async provisionOidcUser(input: ProvisionOidcUserInput): Promise<{ userId: string }> {
    const { oidcSubject, displayName, picture } = input
    // Only a verified email may participate in identity matching (claiming an
    // invited row / becoming the stored address) — an unverified hint could
    // squat a victim's pending invite. Normalized so lookups can't miss on case.
    const email = input.emailVerified ? input.email?.trim().toLowerCase() : undefined

    // Fast path: known subject.
    const existing = await this.db.user.findUnique({ where: { oidcSubject } })
    if (existing) {
      if (email && isSyntheticEmail(existing.email)) await this.upgradeSyntheticEmail(existing.id, email)
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
      if (invited && !invited.oidcSubject) {
        // Guarded claim: only bind our subject if the row is STILL unclaimed —
        // count 0 means a concurrent racer (same or another subject) won.
        const res = await this.db.user.updateMany({
          where: { id: invited.id, oidcSubject: null },
          data: {
            oidcSubject,
            ...(displayName && !invited.displayName ? { displayName } : {}),
            ...(picture ? { picture } : {})
          }
        })
        if (res.count === 1) {
          await this.ensurePersonalOrg(invited.id, displayName, email)
          return { userId: invited.id }
        }
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
    await this.ensurePersonalOrg(user.id, displayName, storedEmail)
    return { userId: user.id }
  }

  /**
   * A verified email arrived for a user still holding a synthetic placeholder.
   * Plain case: rename. Collision case: the email is held by an UNCLAIMED
   * invited row — merge it (move its memberships here, drop the row) so the
   * invite reaches the person it was meant for; any other holder wins and the
   * placeholder stays.
   */
  private async upgradeSyntheticEmail(userId: string, email: string): Promise<void> {
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
      if (holder.id === userId || holder.oidcSubject) return

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
        const lockedUsers = await tx.$queryRaw<Array<{ id: string; email: string; oidcSubject: string | null }>>(
          Prisma.sql`
            SELECT "id", "email", "oidcSubject"
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
              role: membership.role
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
      if (outcome === 'merged') return
    }

    // A rejected provisioning promise is evicted by the auth plugin, so the
    // caller can retry from a fresh membership snapshot instead of being
    // silently memoized without its invite.
    throw new Error('identity membership changed during merge; retry sign-in')
  }

  /**
   * Signup half of JIT provisioning: give the user their own org (they're its
   * owner) so everyone lands in a workspace they can manage. No-op when the
   * user already OWNS some org — that keeps signup idempotent under
   * retries/races (combined with the auth plane's in-flight promise cache)
   * while still granting an invited collaborator/viewer their personal org
   * when they claim the invite. Under WAITLIST_MODE (`provisionPersonalOrgOnSignup
   * = false`) this is skipped entirely: the personal org is created only when the
   * user redeems their join link (waitlist-and-login.md §6/§8), so "login ⇒ has an
   * org ⇒ passes the gate" cannot bypass the admission check.
   */
  private async ensurePersonalOrg(userId: string, displayName?: string | null, email?: string | null): Promise<void> {
    if (!this.provisionPersonalOrgOnSignup) return
    await ensurePersonalOrg(this.db, userId, displayName, email, {
      presetAgents: this.presetAgents,
      presetPool: this.presetPool
    })
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

  async healPersonalOrg(userId: string): Promise<void> {
    // Also gated by the signup flag: under WAITLIST_MODE a bare `GET /orgs` must not
    // self-heal an org into existence (that would flip a Stranger to orgCount=1 =
    // "active", bypassing the gate — §8). The route additionally skips calling this,
    // but gating here too keeps the invariant if another caller appears.
    if (!this.provisionPersonalOrgOnSignup) return
    const user = await this.db.user.findUnique({ where: { id: userId } })
    if (!user) return
    await ensurePersonalOrg(this.db, user.id, user.displayName, user.email, {
      presetAgents: this.presetAgents,
      presetPool: this.presetPool
    })
  }

  async listMembers(orgId: string): Promise<OrgMemberRecord[]> {
    const rows = await this.db.membership.findMany({
      where: { orgId },
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
      await lockOrgOwnerTransition(tx, orgId)
      const memberships = await lockOrgMemberships(tx, orgId, [actingUserId, userId])
      const actor = memberships.find((membership) => membership.userId === actingUserId)
      const current = memberships.find((membership) => membership.userId === userId)
      if (actor?.role !== 'owner' || !current) throw new OrgMembershipMissing()
      if (
        current.role === 'owner' &&
        role !== 'owner' &&
        (await tx.membership.count({ where: { orgId, role: 'owner' } })) === 1
      ) {
        throw new OrgOwnerRequired()
      }

      const row = await tx.membership.update({
        where: { orgId_userId: { orgId, userId } },
        data: { role },
        include: { user: true }
      })
      return toMemberRecord(row)
    })
  }

  async addMemberByEmail(orgId: string, email: string, role: OrgMemberRole): Promise<OrgMemberRecord> {
    // Reuse the existing user for this email, else create an invited (email-only)
    // row the person claims on first SSO sign-in. `upsert` keyed on the unique
    // email keeps two racers from colliding; normalized like the claim path.
    const normalized = email.trim().toLowerCase()
    const user = await this.db.user.upsert({ where: { email: normalized }, create: { email: normalized }, update: {} })
    const row = await this.db.membership.create({
      data: { orgId, userId: user.id, role },
      include: { user: true }
    })
    return toMemberRecord(row)
  }

  async removeMember(orgId: string, userId: string, actingUserId: string): Promise<void> {
    // Prune the departing user from Selected audiences, repair only audiences
    // that would become empty, then remove membership in ONE transaction.
    // createdByUserId is immutable audit attribution and is deliberately untouched.
    await withAmbientTx(this.db, async (tx) => {
      await lockOrgOwnerTransition(tx, orgId)
      const membershipSnapshot = await tx.membership.findMany({
        where: { orgId },
        select: { userId: true, role: true },
        orderBy: [{ createdAt: 'asc' }, { userId: 'asc' }]
      })
      const actor = membershipSnapshot.find((membership) => membership.userId === actingUserId)
      const departing = membershipSnapshot.find((membership) => membership.userId === userId)
      const leaving = userId === actingUserId
      if (!departing || (!leaving && actor?.role !== 'owner')) throw new OrgMembershipMissing()

      const replacementUserId = chooseAudienceReplacement(membershipSnapshot, userId, actingUserId)
      if (!replacementUserId) throw new OrgOwnerRequired()

      // Fence audience-bearing resource writes on both ends, then recheck the
      // snapshot used above. The org transition lock keeps every competing
      // demotion/removal out until this transaction commits.
      const locked = await lockOrgMemberships(tx, orgId, [userId, replacementUserId])
      const byUserId = new Map(locked.map((membership) => [membership.userId, membership]))
      if (!byUserId.has(userId) || byUserId.get(replacementUserId)?.role !== 'owner') {
        throw new OrgMembershipMissing()
      }

      for (const table of RESOURCE_AUDIENCE_TABLES) {
        await tx.$executeRaw(removeMemberFromResourceAudiencesSql(table, orgId, userId, replacementUserId))
      }
      // GitLab OAuth authority ends with membership (§9.4) via the database
      // trigger on membership deletes — the same transition for EVERY removal
      // path, including account deletions that never reach this method.
      // The row is still locked here; deletion completes the same transaction.
      await tx.membership.delete({ where: { orgId_userId: { orgId, userId } } })
    })
  }

  async previewMemberRemoval(orgId: string, userId: string, actingUserId: string): Promise<MemberRemovalPreview> {
    // Unlocked and outside any transaction: this only feeds a confirmation
    // dialog. `removeMember` re-derives everything under the transition lock.
    const rows = await this.db.membership.findMany({
      where: { orgId },
      include: { user: true },
      orderBy: [{ createdAt: 'asc' }, { userId: 'asc' }]
    })
    if (!rows.some((row) => row.userId === userId)) throw new OrgMembershipMissing()

    const replacementId = chooseAudienceReplacement(
      rows.map((row) => ({ userId: row.userId, role: row.role as OrgMemberRole })),
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
      ) as MemberRemovalPreview['resources']
    }
  }

  async addMember(orgId: string, userId: string, role: OrgMemberRole): Promise<void> {
    await this.db.membership.create({ data: { orgId, userId, role } })
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
}
