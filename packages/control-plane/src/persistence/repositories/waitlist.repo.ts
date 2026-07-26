/**
 * PgWaitlistRepo — the CP side of closed-beta admission (waitlist-and-login.md §4-§6).
 *
 * The CP writes ONLY the link's binding (`email` / `boundAt`, on the null→value
 * transition) and redemption (`redeemedAt` / `redeemedByUserId`) columns, plus
 * `User.activatedAt`; the external admin app owns the approval + mint/revoke columns
 * (§7). Redeem serializes with the admin's revoke — and with a second person racing to
 * claim the same unbound link — via `SELECT … FOR UPDATE` on the link row, re-checking
 * every condition inside the transaction before committing: field-level ownership
 * alone does not remove the race (§4).
 *
 * There is a SINGLE redeem path for the whole `activation_link` list. A link bound to
 * an email admits only that email; an unbound one admits anybody and binds itself to
 * its first redeemer, which collapses "single-use" into the same email check rather
 * than a second flavor of code.
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
      // Serialize against the admin app's revoke and against another person racing to
      // claim the SAME unbound link: if a revoke wins, this read resumes and observes
      // it; if we win, the other transaction waits and then sees our binding.
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "activation_link" WHERE "tokenHash" = ${tokenHash} FOR UPDATE`)

      const link = await tx.activationLink.findUnique({ where: { tokenHash } })
      // Unknown / revoked / expired → indistinguishable "invalid" to avoid leaking
      // which condition failed.
      if (!link || link.revokedAt) return { status: 'invalid' }
      if (link.expiresAt.getTime() < now.getTime()) return { status: 'invalid' }
      // Already redeemed by a DIFFERENT user — one link, one account. Checked BEFORE
      // the email comparison so a consumed link never discloses whom it belongs to.
      if (link.redeemedByUserId && link.redeemedByUserId !== userId) return { status: 'invalid' }

      // The one rule. A BOUND link (minted for an approved applicant, or bound by
      // whoever redeemed it first) admits only that email — surfaced as a mismatch so
      // the UI can name the account to sign in with. An UNBOUND link admits anyone and
      // becomes bound below, which is exactly what makes it single-use.
      if (link.email !== null && link.email !== normalizedEmail) {
        return { status: 'email_mismatch', expectedEmail: link.email }
      }

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { displayName: true, email: true, activatedAt: true }
      })
      if (!user) return { status: 'invalid' }

      const realEmail = isSyntheticEmail(user.email) ? normalizedEmail : user.email
      // A link never overrides an explicit rejection. The waitlist entry is only an
      // application record now, so this is the one place the two tables still meet:
      // without it, a link minted before a rejection (or an unbound link handed to a
      // rejected applicant) would quietly let them in. No entry at all is fine — that
      // is the whole point of an unbound link.
      const entry = await tx.waitlistEntry.findUnique({ where: { email: realEmail }, select: { status: true } })
      if (entry?.status === 'rejected') return { status: 'invalid' }

      // Activate (idempotent) + create the personal org (idempotent) + bind & stamp
      // the redemption. All within this locked transaction.
      if (!user.activatedAt) await tx.user.update({ where: { id: userId }, data: { activatedAt: now } })
      await ensurePersonalOrg(tx, userId, user.displayName, realEmail)
      const boundNow = link.email === null
      if (!link.redeemedByUserId) {
        await tx.activationLink.update({
          where: { tokenHash },
          data: {
            // Record the binding on the null→value transition only; a bound link's
            // email is immutable, and a repeat by the same user keeps the original
            // stamps instead of sliding them forward.
            ...(boundNow ? { email: realEmail, boundAt: now } : {}),
            redeemedByUserId: userId,
            redeemedAt: now
          }
        })
      }
      return { status: 'activated', boundNow }
    })
  }
}
