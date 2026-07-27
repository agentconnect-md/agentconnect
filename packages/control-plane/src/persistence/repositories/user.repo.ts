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
import type { PrismaLike } from '../prisma.js'
import {
  type UserRepo,
  type ProvisionOidcUserInput,
  type OrgMemberRecord,
  type OrgMemberRole,
  type UserProfileRecord,
  SYNTHETIC_EMAIL_SUFFIX,
  isSyntheticEmail
} from '../ports.js'

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
 * The free slug is chosen with a READ, never by catching the unique violation of a
 * failed INSERT: this may run inside an interactive transaction (the waitlist redeem),
 * and in Postgres ANY failed statement aborts the WHOLE transaction — a caught P2002
 * would poison every following query with 25P02 and surface as a 500. The last
 * candidate is derived from the (unique) user id, so it is free unless this user
 * already owns an org — which the early return above already handled.
 */
export async function ensurePersonalOrg(
  db: PrismaLike,
  userId: string,
  displayName?: string | null,
  email?: string | null
): Promise<void> {
  const already = await db.membership.findFirst({ where: { userId, role: 'owner' } })
  if (already) return
  const base = personalOrgBase(displayName, email)
  const name = `${base.charAt(0).toUpperCase()}${base.slice(1)}'s organization`
  const baseSlug = slugify(base)
  const candidates = [baseSlug, `${baseSlug}-2`, `${baseSlug}-3`, `org-${userId.slice(-8).toLowerCase()}`]
  const taken = new Set(
    (await db.org.findMany({ where: { slug: { in: candidates } }, select: { slug: true } })).map((o) => o.slug)
  )
  const slug = candidates.find((c) => !taken.has(c))
  if (!slug) throw new Error('could not allocate a unique slug for the personal org')
  const org = await db.org.create({ data: { name, slug } })
  try {
    await db.membership.create({ data: { orgId: org.id, userId, role: 'owner' } })
  } catch (err) {
    // Outside a transaction this keeps an empty org from leaking; inside one the
    // rollback does it (and this delete is itself a no-op on the aborted tx).
    await db.org.delete({ where: { id: org.id } }).catch(() => {})
    throw err
  }
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
    private readonly provisionPersonalOrgOnSignup = true
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
    const holder = await this.db.user.findUnique({ where: { email }, include: { memberships: true } })
    if (!holder) {
      await this.db.user.update({ where: { id: userId }, data: { email } }).catch(() => {})
      return
    }
    if (holder.id === userId || holder.oidcSubject) return
    for (const m of holder.memberships) {
      await this.db.membership
        .create({ data: { orgId: m.orgId, userId, role: m.role } })
        .catch((err) => (isP2002(err) ? undefined : Promise.reject(err))) // already a member — keep their role
    }
    await this.db.user.delete({ where: { id: holder.id } }) // frees the unique email
    await this.db.user.update({ where: { id: userId }, data: { email } }).catch(() => {})
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
    await ensurePersonalOrg(this.db, userId, displayName, email)
  }

  async healPersonalOrg(userId: string): Promise<void> {
    // Also gated by the signup flag: under WAITLIST_MODE a bare `GET /orgs` must not
    // self-heal an org into existence (that would flip a Stranger to orgCount=1 =
    // "active", bypassing the gate — §8). The route additionally skips calling this,
    // but gating here too keeps the invariant if another caller appears.
    if (!this.provisionPersonalOrgOnSignup) return
    const user = await this.db.user.findUnique({ where: { id: userId } })
    if (!user) return
    await ensurePersonalOrg(this.db, user.id, user.displayName, user.email)
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

  async removeMember(orgId: string, userId: string): Promise<void> {
    // Remove the membership AND prune the departing user's id from every resource's
    // `sharedWith` in ONE transaction (docs/designs/resource-visibility.md §8.1).
    // app_user.id is stable across removal→re-invite (JIT from the OIDC `sub`), so a
    // non-transactional / best-effort prune could silently re-grant a re-invited
    // user access to restricted resources they were previously shared on.
    const run = async (tx: PrismaLike): Promise<void> => {
      // Throws Prisma P2025 when the membership is absent → 404 at the route.
      await tx.membership.delete({ where: { orgId_userId: { orgId, userId } } })
      await tx.$executeRaw`UPDATE "agent"    SET "sharedWith" = array_remove("sharedWith", ${userId}) WHERE "orgId" = ${orgId} AND ${userId} = ANY("sharedWith")`
      await tx.$executeRaw`UPDATE "daemon"   SET "sharedWith" = array_remove("sharedWith", ${userId}) WHERE "orgId" = ${orgId} AND ${userId} = ANY("sharedWith")`
      await tx.$executeRaw`UPDATE "cron_def" SET "sharedWith" = array_remove("sharedWith", ${userId}) WHERE "orgId" = ${orgId} AND ${userId} = ANY("sharedWith")`
      await tx.$executeRaw`UPDATE "mcp_provider" SET "sharedWith" = array_remove("sharedWith", ${userId}) WHERE "orgId" = ${orgId} AND ${userId} = ANY("sharedWith")`
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
