/**
 * PgWaitlistRepo — the CP side of closed-beta admission (waitlist-and-login.md §4-§6).
 *
 * The CP writes ONLY the redemption columns (`redeemedAt` / `redeemedByUserId`) plus
 * `User.activatedAt`; the external admin app owns approval/mint columns (§7). Redeem
 * serializes with the admin's revoke/rotate via `SELECT … FOR UPDATE` on the entry
 * row and re-checks every condition inside the transaction before committing —
 * field-level ownership alone does not remove the race (§4).
 *
 * `redeemOpen` applies the same rules to the second link flavor — the open,
 * email-agnostic, single-use `open_activation_link` (§6a) — which carries no email
 * binding and no waitlist entry.
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
import { ensurePersonalOrg } from './user.repo.js'

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

  async addSelf(email: string, note?: string): Promise<WaitlistEntryStatus> {
    const normalized = email.trim().toLowerCase()
    const existing = await this.db.waitlistEntry.findUnique({ where: { email: normalized }, select: { status: true } })
    if (existing) return existing.status // leave pending/approved/rejected untouched (§11)
    try {
      const created = await this.db.waitlistEntry.create({
        data: { email: normalized, status: 'pending', source: 'self', ...(note ? { note } : {}) },
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
      // Unknown / not-approved / revoked / expired → indistinguishable "invalid" to
      // avoid leaking which condition failed.
      if (!entry || entry.status !== 'approved' || entry.revokedAt) return { status: 'invalid' }
      if (entry.joinExpiresAt && entry.joinExpiresAt.getTime() < now.getTime()) return { status: 'invalid' }
      // Already redeemed by a DIFFERENT user — the link is one-email/one-user.
      if (entry.redeemedByUserId && entry.redeemedByUserId !== userId) return { status: 'invalid' }

      // Strong email binding: the signed-in user's verified email must match the
      // email the link was minted for (§6 step 3). Surfaced so the UI can tell the
      // user which account to sign in with.
      if (entry.email !== normalizedEmail) return { status: 'email_mismatch', expectedEmail: entry.email }

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { displayName: true, email: true, activatedAt: true }
      })
      if (!user) return { status: 'invalid' }

      // Activate (idempotent) + create the personal org (idempotent) + stamp the
      // redemption. All within this locked transaction.
      if (!user.activatedAt) await tx.user.update({ where: { id: userId }, data: { activatedAt: now } })
      const realEmail = isSyntheticEmail(user.email) ? normalizedEmail : user.email
      await ensurePersonalOrg(tx, userId, user.displayName, realEmail)
      if (!entry.redeemedByUserId) {
        await tx.waitlistEntry.update({
          where: { tokenHash },
          data: { redeemedByUserId: userId, redeemedAt: now }
        })
      }
      return { status: 'activated' }
    })
  }

  /** Open (email-agnostic) single-use link — §6a. Same locked-transaction shape as
   *  {@link redeem}: `FOR UPDATE` on the link row serializes two people racing to
   *  consume it, so exactly one wins and the loser sees the opaque `invalid`. */
  async redeemOpen(tokenHash: string, userId: string, verifiedEmail: string, now: Date): Promise<WaitlistRedeemResult> {
    const normalizedEmail = verifiedEmail.trim().toLowerCase()
    return this.inTransaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "open_activation_link" WHERE "tokenHash" = ${tokenHash} FOR UPDATE`
      )

      const link = await tx.openActivationLink.findUnique({ where: { tokenHash } })
      // Unknown / revoked / expired / already consumed by someone else → one
      // indistinguishable "invalid", so a probe learns nothing about the link.
      if (!link || link.revokedAt) return { status: 'invalid' }
      if (link.expiresAt.getTime() < now.getTime()) return { status: 'invalid' }
      if (link.redeemedByUserId && link.redeemedByUserId !== userId) return { status: 'invalid' }

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { displayName: true, email: true, activatedAt: true }
      })
      if (!user) return { status: 'invalid' }

      if (!user.activatedAt) await tx.user.update({ where: { id: userId }, data: { activatedAt: now } })
      const realEmail = isSyntheticEmail(user.email) ? normalizedEmail : user.email
      await ensurePersonalOrg(tx, userId, user.displayName, realEmail)
      // Consume it. Only on the first redemption, so a repeat by the same user keeps
      // the original audit stamp instead of sliding it forward.
      if (!link.redeemedByUserId) {
        await tx.openActivationLink.update({
          where: { tokenHash },
          data: { redeemedByUserId: userId, redeemedEmail: realEmail, redeemedAt: now }
        })
      }
      return { status: 'activated' }
    })
  }
}
