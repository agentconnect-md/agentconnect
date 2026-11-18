/** PgOrgDomainRepo — domains an organization claims for single sign-on (organization-sso.md §3). */
import type { PrismaClient } from '../../generated/prisma/client.js'
import type { PrismaLike } from '../prisma.js'
import type { OrgDomainRecord, OrgDomainRepo } from '../ports.js'

const isP2002 = (err: unknown): boolean => (err as { code?: string }).code === 'P2002'

const live = (now: Date) => ({ OR: [{ verifiedAt: { not: null } }, { challengeExpiresAt: { gt: now } }] })

export class PgOrgDomainRepo implements OrgDomainRepo {
  constructor(private readonly db: PrismaLike) {}

  private inTransaction<T>(run: (tx: PrismaLike) => Promise<T>): Promise<T> {
    return '$transaction' in this.db ? (this.db as PrismaClient).$transaction((tx) => run(tx)) : run(this.db)
  }

  listForOrg(orgId: string, now: Date): Promise<OrgDomainRecord[]> {
    return this.db.orgDomain.findMany({
      where: { orgId, ...live(now) },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
    })
  }

  get(orgId: string, id: string, now: Date): Promise<OrgDomainRecord | null> {
    return this.db.orgDomain.findFirst({ where: { id, orgId, ...live(now) } })
  }

  async claim(
    input: { orgId: string; domain: string; challenge: string; challengeExpiresAt: Date; maxPerOrg: number },
    now: Date,
    actorUserId: string
  ): Promise<{ record: OrgDomainRecord; created: boolean } | 'taken' | 'limit'> {
    const { orgId, domain, challenge, challengeExpiresAt, maxPerOrg } = input
    const run = () =>
      this.inTransaction(async (tx) => {
        const existing = await tx.orgDomain.findUnique({ where: { orgId_domain: { orgId, domain } } })
        if (existing && (existing.verifiedAt || existing.challengeExpiresAt.getTime() > now.getTime())) {
          return { record: existing, created: false }
        }
        const held = await tx.orgDomain.findFirst({
          where: { domain, verifiedAt: { not: null }, orgId: { not: orgId } },
          select: { id: true }
        })
        if (held) return 'taken' as const
        if ((await tx.orgDomain.count({ where: { orgId, ...live(now) } })) >= maxPerOrg) return 'limit' as const
        // An expired claim for the same domain is replaced, so its old challenge stops working.
        if (existing) await tx.orgDomain.delete({ where: { id: existing.id } })
        const record = await tx.orgDomain.create({ data: { orgId, domain, challenge, challengeExpiresAt } })
        await tx.auditEvent.create({
          data: {
            kind: 'org_sso_change',
            orgId,
            actorUserId,
            message: `single sign-on domain ${domain} added`,
            details: { action: 'domain_added', domainId: record.id, domain }
          }
        })
        return { record, created: true }
      })
    try {
      return await run()
    } catch (err) {
      // Two owners added the same domain at once: the second reads the winner's row.
      if (isP2002(err)) return run()
      throw err
    }
  }

  async markVerified(
    orgId: string,
    id: string,
    at: Date,
    actorUserId: string
  ): Promise<OrgDomainRecord | 'taken' | null> {
    try {
      return await this.inTransaction(async (tx) => {
        const current = await tx.orgDomain.findFirst({ where: { id, orgId, ...live(at) } })
        if (!current) return null
        if (current.verifiedAt) return current
        const held = await tx.orgDomain.findFirst({
          where: { domain: current.domain, verifiedAt: { not: null } },
          select: { id: true }
        })
        if (held) return 'taken' as const
        const record = await tx.orgDomain.update({
          where: { id },
          data: { verifiedAt: at, lastCheckedAt: at, lastCheckOk: true }
        })
        await tx.orgDomain.deleteMany({ where: { domain: current.domain, verifiedAt: null, orgId: { not: orgId } } })
        await tx.auditEvent.create({
          data: {
            kind: 'org_sso_change',
            orgId,
            actorUserId,
            message: `single sign-on domain ${current.domain} verified`,
            details: { action: 'domain_verified', domainId: id, domain: current.domain }
          }
        })
        return record
      })
    } catch (err) {
      // Two organizations verified the same domain at once: the partial unique index lets one win.
      if (isP2002(err)) return 'taken'
      throw err
    }
  }

  async recordCheck(id: string, at: Date, ok: boolean | null): Promise<void> {
    await this.db.orgDomain.updateMany({
      where: { id },
      data: { lastCheckedAt: at, ...(ok === null ? {} : { lastCheckOk: ok }) }
    })
  }

  release(orgId: string, id: string, actorUserId: string): Promise<boolean> {
    return this.inTransaction(async (tx) => {
      const current = await tx.orgDomain.findFirst({ where: { id, orgId } })
      if (!current) return false
      await tx.orgDomain.delete({ where: { id } })
      await tx.auditEvent.create({
        data: {
          kind: 'org_sso_change',
          orgId,
          actorUserId,
          message: `single sign-on domain ${current.domain} released`,
          details: {
            action: 'domain_released',
            domainId: id,
            domain: current.domain,
            verified: current.verifiedAt !== null
          }
        }
      })
      return true
    })
  }

  listDueForRecheck(before: Date, limit: number): Promise<OrgDomainRecord[]> {
    return this.db.orgDomain.findMany({
      where: { verifiedAt: { not: null }, OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: before } }] },
      orderBy: [{ lastCheckedAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
      take: limit
    })
  }

  getAny(id: string): Promise<OrgDomainRecord | null> {
    return this.db.orgDomain.findUnique({ where: { id } })
  }

  async deleteExpiredPending(now: Date): Promise<number> {
    const { count } = await this.db.orgDomain.deleteMany({
      where: { verifiedAt: null, challengeExpiresAt: { lte: now } }
    })
    return count
  }
}
