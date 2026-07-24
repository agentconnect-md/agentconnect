/**
 * PgOrgInviteLinkRepo — one hash-only shareable join link per organization.
 *
 * Redemption owns the membership write because the link check, prior-use check,
 * redemption row, and collaborator membership must commit as one transaction.
 */
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js'
import type { PrismaLike } from '../prisma.js'
import type { OrgInviteAcceptResult, OrgInviteLinkRecord, OrgInviteLinkRepo } from '../ports.js'

const isP2002 = (err: unknown): boolean => (err as { code?: string }).code === 'P2002'

function toRecord(row: {
  id: string
  orgId: string
  tokenHash: string
  displayTail: string
  expiresAt: Date
  revokedAt: Date | null
  createdByUserId: string | null
  createdAt: Date
}): OrgInviteLinkRecord {
  return row
}

export class PgOrgInviteLinkRepo implements OrgInviteLinkRepo {
  constructor(private readonly db: PrismaLike) {}

  private inTransaction<T>(run: (tx: PrismaLike) => Promise<T>): Promise<T> {
    return '$transaction' in this.db ? (this.db as PrismaClient).$transaction((tx) => run(tx)) : run(this.db)
  }

  async getForOrg(orgId: string): Promise<OrgInviteLinkRecord | null> {
    const row = await this.db.orgInviteLink.findUnique({ where: { orgId } })
    return row ? toRecord(row) : null
  }

  async createReplacingInactive(
    input: {
      orgId: string
      tokenHash: string
      displayTail: string
      expiresAt: Date
      createdByUserId: string
    },
    now: Date
  ): Promise<OrgInviteLinkRecord | null> {
    try {
      return await this.inTransaction(async (tx) => {
        const existing = await tx.orgInviteLink.findUnique({ where: { orgId: input.orgId } })
        if (existing && !existing.revokedAt && existing.expiresAt.getTime() > now.getTime()) return null
        if (existing) await tx.orgInviteLink.delete({ where: { id: existing.id } })
        const created = await tx.orgInviteLink.create({ data: input })
        await tx.auditEvent.create({
          data: {
            kind: 'org_invite_change',
            orgId: input.orgId,
            actorUserId: input.createdByUserId,
            message: `organization invite link ${created.id} created`,
            details: {
              action: 'created',
              inviteLinkId: created.id,
              displayTail: created.displayTail,
              expiresAt: created.expiresAt.toISOString()
            }
          }
        })
        return toRecord(created)
      })
    } catch (err) {
      // Two owners generated concurrently: the unique org slot lets one win.
      if (isP2002(err)) return null
      throw err
    }
  }

  async revoke(orgId: string, inviteLinkId: string, at: Date, actorUserId: string): Promise<boolean> {
    return this.inTransaction(async (tx) => {
      const current = await tx.orgInviteLink.findFirst({ where: { id: inviteLinkId, orgId } })
      if (!current) return false
      if (current.revokedAt) return true
      const updated = await tx.orgInviteLink.updateMany({
        where: { id: inviteLinkId, orgId, revokedAt: null },
        data: { revokedAt: at }
      })
      if (updated.count === 0) return true
      await tx.auditEvent.create({
        data: {
          kind: 'org_invite_change',
          orgId,
          actorUserId,
          message: `organization invite link ${inviteLinkId} revoked`,
          details: { action: 'revoked', inviteLinkId }
        }
      })
      return true
    })
  }

  async accept(tokenHash: string, userId: string, now: Date): Promise<OrgInviteAcceptResult> {
    const run = () =>
      this.inTransaction(async (tx) => {
        // Serialize acceptance with revoke/replacement before validating state.
        // If revoke wins, this read resumes and observes revokedAt; if accept
        // wins, revoke cannot return until the membership transaction commits.
        await tx.$queryRaw(Prisma.sql`
          SELECT "id"
          FROM "org_invite_link"
          WHERE "tokenHash" = ${tokenHash}
          FOR UPDATE
        `)
        const link = await tx.orgInviteLink.findUnique({
          where: { tokenHash },
          include: { org: { select: { id: true, slug: true, name: true } } }
        })
        if (!link || link.revokedAt || link.expiresAt.getTime() <= now.getTime()) {
          return { status: 'unavailable' } as const
        }

        const used = await tx.orgInviteRedemption.findUnique({
          where: { inviteLinkId_userId: { inviteLinkId: link.id, userId } }
        })
        if (used) return { status: 'unavailable' } as const

        const membership = await tx.membership.findUnique({
          where: { orgId_userId: { orgId: link.orgId, userId } }
        })
        if (membership) return { status: 'already_member', org: link.org } as const

        await tx.orgInviteRedemption.create({ data: { inviteLinkId: link.id, userId, redeemedAt: now } })
        await tx.membership.create({ data: { orgId: link.orgId, userId, role: 'collaborator' } })
        await tx.auditEvent.create({
          data: {
            kind: 'org_invite_change',
            orgId: link.orgId,
            actorUserId: userId,
            message: `organization invite link ${link.id} redeemed`,
            details: { action: 'redeemed', inviteLinkId: link.id, role: 'collaborator' }
          }
        })
        return { status: 'accepted', org: link.org } as const
      })

    try {
      return await run()
    } catch (err) {
      // A same-user or same-membership race resolves to the now-current state.
      if (isP2002(err)) return run()
      throw err
    }
  }
}
