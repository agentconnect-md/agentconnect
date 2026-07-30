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
import type { PrismaClient } from '../../generated/prisma/client.js'
import { Prisma, withAmbientTx, type PrismaLike } from '../prisma.js'
import {
  type UserRepo,
  type ProvisionOidcUserInput,
  type OrgMemberRecord,
  type OrgMemberRole,
  type UserProfileRecord,
  SYNTHETIC_EMAIL_SUFFIX,
  isSyntheticEmail
} from '../ports.js'
import { provisionPresetAgents } from '../preset-agents.js'
import { OrgMembershipMissing } from '../errors.js'

const RESOURCE_AUTHORITY_TABLES = ['agent', 'daemon', 'cron_def', 'mcp_provider', 'skill_source'] as const

/**
 * Replace one local user identity with another in a resource's effective
 * authority fields. Creator/modifier attribution is deliberately not touched:
 * those columns are audit history, while ownerUserId/sharedWith are live access.
 */
function mergeResourceAuthoritySql(table: (typeof RESOURCE_AUTHORITY_TABLES)[number], from: string, to: string) {
  return Prisma.sql`
    UPDATE ${Prisma.raw(`"public"."${table}"`)} AS resource
    SET
      "ownerUserId" = CASE
        WHEN resource."ownerUserId" = ${from} THEN ${to}
        ELSE resource."ownerUserId"
      END,
      "sharedWith" = (
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
    WHERE resource."ownerUserId" = ${from}
       OR ${from} = ANY(COALESCE(resource."sharedWith", ARRAY[]::TEXT[]))
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
  user: {
    email: string
    displayName: string | null
    picture: string | null
    profilePictureUpdatedAt: Date | null
    createdAt: Date
  }
}): OrgMemberRecord {
  return {
    userId: m.userId,
    email: isSyntheticEmail(m.user.email) ? null : m.user.email,
    displayName: m.user.displayName,
    picture: m.user.picture,
    profilePictureUpdatedAt: m.user.profilePictureUpdatedAt,
    role: m.role as OrgMemberRole,
    joinedAt: m.user.createdAt
  }
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
  opts?: { presetAgents?: boolean }
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
      const { count } = await tx.org.createMany({ data: [{ name, slug }], skipDuplicates: true })
      if (count === 0) continue
      const org = await tx.org.findUniqueOrThrow({ where: { slug }, select: { id: true } })
      await tx.membership.create({ data: { orgId: org.id, userId, role: 'owner' } })
      // Org-creation seam (preset-agents.md §3.2): a new personal org is born with
      // the `agentconnect` general preset. A brand-new org cannot collide on the
      // reserved slug, so no expected-failure statement runs here — safe under an
      // ambient transaction. A throw rolls the org + membership back with it (no
      // compensating delete needed, and none would be legal on an aborted tx).
      if (opts?.presetAgents !== false) {
        await provisionPresetAgents(tx, { orgId: org.id, createdByUserId: userId })
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
    private readonly presetAgents = true
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
        // Parent before child, matching lockResourceWriteMemberships. KEY SHARE
        // keeps an org deletion from cascading through memberships while this
        // identity merge is moving their authority.
        if (expectedOrgIds.length > 0) {
          await tx.$queryRaw(Prisma.sql`
            SELECT "id"
            FROM "org"
            WHERE "id" IN (${Prisma.join(expectedOrgIds)})
            ORDER BY "id"
            FOR KEY SHARE
          `)
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
        if (holderMemberships.length > 0) {
          await tx.membership.createMany({
            data: holderMemberships.map((membership) => ({
              orgId: membership.orgId,
              userId,
              role: membership.role
            })),
            skipDuplicates: true
          })
        }

        // Resource-table order matches removeMember. Translate grants as well as
        // ownership: sharedWith has no FK, so deleting the invited row alone
        // would otherwise strand a stale id. The SQL de-duplicates after
        // replacement while preserving first-seen order.
        for (const table of RESOURCE_AUTHORITY_TABLES) {
          await tx.$executeRaw(mergeResourceAuthoritySql(table, holder.id, userId))
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
    await ensurePersonalOrg(this.db, userId, displayName, email, { presetAgents: this.presetAgents })
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
    await ensurePersonalOrg(this.db, user.id, user.displayName, user.email, { presetAgents: this.presetAgents })
  }

  async listMembers(orgId: string): Promise<OrgMemberRecord[]> {
    const rows = await this.db.membership.findMany({
      where: { orgId },
      include: { user: true },
      orderBy: { user: { createdAt: 'asc' } }
    })
    return rows.map(toMemberRecord)
  }

  async setMemberRole(orgId: string, userId: string, role: OrgMemberRole): Promise<OrgMemberRecord> {
    const row = await this.db.membership.update({
      where: { orgId_userId: { orgId, userId } },
      data: { role },
      include: { user: true }
    })
    return toMemberRecord(row)
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

  async removeMember(orgId: string, userId: string, transferToUserId: string): Promise<void> {
    // Transfer ownership, prune the departing user's grants, then remove the
    // membership in ONE transaction (docs/designs/resource-visibility.md §8).
    // createdByUserId is immutable audit attribution and is deliberately untouched.
    const run = async (tx: PrismaLike): Promise<void> => {
      // Common serialization point with resource create/sharing writes. Lock both
      // ends in stable order: the departing membership fences its writes, while
      // the recipient lock prevents another removal from invalidating the transfer
      // target. Resource writes hold FOR SHARE on every membership whose authority
      // they persist, so these locks close the scan→delete window.
      const memberIds = [...new Set([userId, transferToUserId])].sort()
      const locked = await tx.$queryRaw<Array<{ userId: string; role: string }>>(Prisma.sql`
        SELECT "userId", "role"::text AS "role"
        FROM "membership"
        WHERE "orgId" = ${orgId}
          AND "userId" IN (${Prisma.join(memberIds)})
        ORDER BY "userId"
        FOR UPDATE
      `)
      const byUserId = new Map(locked.map((member) => [member.userId, member]))
      // The target must still exist and the distinct recipient must still own the
      // organization at this transaction's serialization point.
      if (userId === transferToUserId || !byUserId.has(userId) || byUserId.get(transferToUserId)?.role !== 'owner') {
        throw new OrgMembershipMissing()
      }
      await tx.$executeRaw`UPDATE "agent" SET "ownerUserId" = CASE WHEN "ownerUserId" = ${userId} THEN ${transferToUserId} ELSE "ownerUserId" END, "sharedWith" = array_remove("sharedWith", ${userId}) WHERE "orgId" = ${orgId} AND ("ownerUserId" = ${userId} OR ${userId} = ANY("sharedWith"))`
      await tx.$executeRaw`UPDATE "daemon" SET "ownerUserId" = CASE WHEN "ownerUserId" = ${userId} THEN ${transferToUserId} ELSE "ownerUserId" END, "sharedWith" = array_remove("sharedWith", ${userId}) WHERE "orgId" = ${orgId} AND ("ownerUserId" = ${userId} OR ${userId} = ANY("sharedWith"))`
      await tx.$executeRaw`UPDATE "cron_def" SET "ownerUserId" = CASE WHEN "ownerUserId" = ${userId} THEN ${transferToUserId} ELSE "ownerUserId" END, "sharedWith" = array_remove("sharedWith", ${userId}) WHERE "orgId" = ${orgId} AND ("ownerUserId" = ${userId} OR ${userId} = ANY("sharedWith"))`
      await tx.$executeRaw`UPDATE "mcp_provider" SET "ownerUserId" = CASE WHEN "ownerUserId" = ${userId} THEN ${transferToUserId} ELSE "ownerUserId" END, "sharedWith" = array_remove("sharedWith", ${userId}) WHERE "orgId" = ${orgId} AND ("ownerUserId" = ${userId} OR ${userId} = ANY("sharedWith"))`
      await tx.$executeRaw`UPDATE "skill_source" SET "ownerUserId" = CASE WHEN "ownerUserId" = ${userId} THEN ${transferToUserId} ELSE "ownerUserId" END, "sharedWith" = array_remove("sharedWith", ${userId}) WHERE "orgId" = ${orgId} AND ("ownerUserId" = ${userId} OR ${userId} = ANY("sharedWith"))`
      // The row is still locked here; deletion completes the same transaction.
      await tx.membership.delete({ where: { orgId_userId: { orgId, userId } } })
    }
    // Compose under an ambient transaction when given one (TransactionClient has no
    // $transaction); open our own interactive transaction otherwise.
    if ('$transaction' in this.db) await (this.db as PrismaClient).$transaction((tx) => run(tx))
    else await run(this.db)
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
