/**
 * PgWaitlistRepo — the CP side of closed-beta admission (waitlist-and-login.md §4-§6).
 *
 * The CP writes ONLY the redemption columns (`redeemedAt` / `redeemedByUserId`) plus
 * `User.activatedAt`; the external admin app owns approval/mint columns (§7). Activation
 * grants ADMISSION, not an organization — the activated user then creates or joins one
 * from org onboarding, like any other new account. Redeem
 * serializes with the admin's revoke/rotate via `SELECT … FOR UPDATE` on the entry
 * row and re-checks every condition inside the transaction before committing —
 * field-level ownership alone does not remove the race (§4).
 */
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js'
import type { PrismaLike } from '../prisma.js'
import {
  isSyntheticEmail,
  type WaitlistAccessState,
  type WaitlistEntryStatus,
  type WaitlistRedeemResult,
  type WaitlistRepo
} from '../ports.js'

const isP2002 = (err: unknown): boolean => (err as { code?: string }).code === 'P2002'

export class PgWaitlistRepo implements WaitlistRepo {
  constructor(private readonly db: PrismaLike) {}

  private inTransaction<T>(run: (tx: PrismaLike) => Promise<T>): Promise<T> {
    return '$transaction' in this.db ? (this.db as PrismaClient).$transaction((tx) => run(tx)) : run(this.db)
  }

  async accessState(userId: string): Promise<WaitlistAccessState> {
    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: { email: true, activatedAt: true }
    })
    if (!user) return { activated: false, orgCount: 0, email: null, entryStatus: null }
    const orgCount = await this.db.membership.count({ where: { userId } })
    // Only a real verified email is a valid waitlist key — a synthetic placeholder
    // reads as "no email" (§5), so we neither look it up nor echo it.
    const email = isSyntheticEmail(user.email) ? null : user.email
    let entryStatus: WaitlistEntryStatus | null = null
    if (email) {
      const entry = await this.db.waitlistEntry.findUnique({ where: { email }, select: { status: true } })
      entryStatus = entry?.status ?? null
    }
    return { activated: user.activatedAt != null, orgCount, email, entryStatus }
  }

  async addSelf(email: string, note?: string, name?: string): Promise<WaitlistEntryStatus> {
    const normalized = email.trim().toLowerCase()
    const existing = await this.db.waitlistEntry.findUnique({ where: { email: normalized }, select: { status: true } })
    if (existing) return existing.status // leave pending/approved/rejected untouched (§11)
    try {
      const created = await this.db.waitlistEntry.create({
        data: {
          email: normalized,
          status: 'pending',
          source: 'self',
          ...(note ? { note } : {}),
          ...(name ? { name } : {})
        },
        select: { status: true }
      })
      return created.status
    } catch (err) {
      // Lost the unique-email race — the winner's row is authoritative.
      if (isP2002(err)) {
        const row = await this.db.waitlistEntry.findUnique({ where: { email: normalized }, select: { status: true } })
        if (row) return row.status
      }
      throw err
    }
  }

  async redeem(tokenHash: string, userId: string, verifiedEmail: string, now: Date): Promise<WaitlistRedeemResult> {
    const normalizedEmail = verifiedEmail.trim().toLowerCase()
    return this.inTransaction(async (tx) => {
      // Serialize against the admin app's approve/revoke/rotate on this row: if a
      // revoke/rotate wins, this read resumes and observes the new state; if redeem
      // wins, the admin's UPDATE waits until we commit.
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "waitlist_entry" WHERE "tokenHash" = ${tokenHash} FOR UPDATE`)

      const entry = await tx.waitlistEntry.findUnique({ where: { tokenHash } })
      if (!entry) return { status: 'invalid' }
      // Idempotency FIRST (§6): once THIS user has redeemed the link, a repeat always
      // succeeds — even if the link was later revoked or expired. Their account is
      // already activated, so a retry must not be punished. This must precede the
      // approval/revoke/expiry gates below (a DIFFERENT user still fails there).
      if (entry.redeemedByUserId === userId) return { status: 'activated' }

      // From here the link is unredeemed or was taken by someone else. Unknown /
      // not-approved / revoked / expired / already-taken all collapse to an
      // indistinguishable "invalid" so we don't leak which condition failed.
      if (entry.status !== 'approved' || entry.revokedAt) return { status: 'invalid' }
      if (entry.joinExpiresAt && entry.joinExpiresAt.getTime() < now.getTime()) return { status: 'invalid' }
      if (entry.redeemedByUserId) return { status: 'invalid' } // redeemed by a DIFFERENT user

      // Conditional email binding (§6). A row WITH an email is bound: the signed-in
      // user's verified email must match the one the link was minted for (surfaced so
      // the UI can say which account to use). A BEARER row (email null) skips the
      // check — any verified identity may redeem it once (the one-use guard above
      // still applies); the redeemer's email is recorded below in `redeemedEmail`.
      if (entry.email !== null && entry.email !== normalizedEmail) {
        return { status: 'email_mismatch', expectedEmail: entry.email }
      }

      const user = await tx.user.findUnique({ where: { id: userId }, select: { activatedAt: true } })
      if (!user) return { status: 'invalid' }

      // An ALREADY-ACTIVATED account gains nothing from a BEARER link, so don't burn
      // one: report success (they may enter the app) and leave the one-time link for
      // someone who still needs it. A BOUND link is minted for this exact person, so
      // it still records its redemption below (audit).
      if (entry.email === null && user.activatedAt) return { status: 'activated' }

      // Activate (idempotent) + stamp the redemption, within this locked transaction.
      // `redeemedByUserId` is null here (the same-user short-circuit and different-user
      // reject are both above).
      if (!user.activatedAt) await tx.user.update({ where: { id: userId }, data: { activatedAt: now } })
      await tx.waitlistEntry.update({
        where: { tokenHash },
        data: { redeemedByUserId: userId, redeemedAt: now, redeemedEmail: normalizedEmail }
      })
      return { status: 'activated' }
    })
  }
}
