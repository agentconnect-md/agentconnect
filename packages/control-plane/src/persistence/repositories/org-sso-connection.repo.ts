/** PgOrgSsoConnectionRepo — an organization's SSO connection (organization-sso.md §3). */
import type { PrismaClient } from '../../generated/prisma/client.js'
import type { PrismaLike } from '../prisma.js'
import type { OrgSsoConnectionRecord, OrgSsoConnectionRepo, OrgSsoProtocol } from '../ports.js'

type Row = Omit<OrgSsoConnectionRecord, 'protocol'> & { protocol: string }

const toRecord = (row: Row): OrgSsoConnectionRecord => ({ ...row, protocol: row.protocol as OrgSsoProtocol })

export class PgOrgSsoConnectionRepo implements OrgSsoConnectionRepo {
  constructor(private readonly db: PrismaLike) {}

  private inTransaction<T>(run: (tx: PrismaLike) => Promise<T>): Promise<T> {
    return '$transaction' in this.db ? (this.db as PrismaClient).$transaction((tx) => run(tx)) : run(this.db)
  }

  private audit(tx: PrismaLike, orgId: string, actorUserId: string | null, message: string, details: object) {
    return tx.auditEvent.create({ data: { kind: 'org_sso_change', orgId, actorUserId, message, details } })
  }

  async getForOrg(orgId: string): Promise<OrgSsoConnectionRecord | null> {
    const row = await this.db.orgSsoConnection.findUnique({ where: { orgId } })
    return row ? toRecord(row) : null
  }

  save(
    input: { orgId: string; logtoConnectorId: string; protocol: OrgSsoProtocol; name: string },
    at: Date,
    actorUserId: string
  ): Promise<OrgSsoConnectionRecord> {
    const { orgId, logtoConnectorId, protocol, name } = input
    return this.inTransaction(async (tx) => {
      const current = await tx.orgSsoConnection.findUnique({ where: { orgId }, select: { testExpiresAt: true } })
      const existed = current !== null
      // An open test window ends here but stays on the row until what it bound has been unbound.
      const changed = {
        logtoConnectorId,
        protocol,
        name,
        configChangedAt: at,
        testNonceHash: null,
        testExpiresAt: current?.testExpiresAt ? at : null
      }
      const row = await tx.orgSsoConnection.upsert({
        where: { orgId },
        create: { orgId, ...changed },
        update: changed
      })
      await this.audit(tx, orgId, actorUserId, `single sign-on connection ${existed ? 'changed' : 'created'}`, {
        action: existed ? 'connection_changed' : 'connection_created',
        connectionId: row.id,
        protocol
      })
      return toRecord(row)
    })
  }

  async startTest(orgId: string, nonceHash: string, expiresAt: Date): Promise<OrgSsoConnectionRecord | null> {
    const { count } = await this.db.orgSsoConnection.updateMany({
      where: { orgId },
      data: { testNonceHash: nonceHash, testExpiresAt: expiresAt }
    })
    return count === 0 ? null : this.getForOrg(orgId)
  }

  async findLiveTest(nonceHash: string, now: Date): Promise<OrgSsoConnectionRecord | null> {
    const row = await this.db.orgSsoConnection.findFirst({
      where: { testNonceHash: nonceHash, testExpiresAt: { gt: now } }
    })
    return row ? toRecord(row) : null
  }

  completeTest(id: string, nonceHash: string, at: Date, actorUserId: string): Promise<OrgSsoConnectionRecord | null> {
    return this.inTransaction(async (tx) => {
      // The nonce is cleared by a configuration change, so a test that began before one cannot vouch for it.
      const { count } = await tx.orgSsoConnection.updateMany({
        where: { id, testNonceHash: nonceHash, testExpiresAt: { gt: at } },
        data: { testedAt: at, testNonceHash: null, testExpiresAt: at }
      })
      if (count === 0) return null
      const row = await tx.orgSsoConnection.findUniqueOrThrow({ where: { id } })
      await this.audit(tx, row.orgId, actorUserId, 'single sign-on connection tested', {
        action: 'connection_tested',
        connectionId: id
      })
      return toRecord(row)
    })
  }

  async listEndedTests(now: Date): Promise<OrgSsoConnectionRecord[]> {
    const rows = await this.db.orgSsoConnection.findMany({ where: { testExpiresAt: { lte: now } } })
    return rows.map(toRecord)
  }

  async closeTest(id: string, now: Date): Promise<void> {
    await this.db.orgSsoConnection.updateMany({
      where: { id, testExpiresAt: { lte: now } },
      data: { testNonceHash: null, testExpiresAt: null }
    })
  }

  activate(orgId: string, at: Date, actorUserId: string): Promise<OrgSsoConnectionRecord | null> {
    return this.inTransaction(async (tx) => {
      const current = await tx.orgSsoConnection.findUnique({ where: { orgId } })
      if (!current) return null
      if (current.activatedAt !== null) return toRecord(current)
      const row = await tx.orgSsoConnection.update({ where: { orgId }, data: { activatedAt: at } })
      await this.audit(tx, orgId, actorUserId, 'single sign-on connection activated', {
        action: 'connection_activated',
        connectionId: row.id
      })
      return toRecord(row)
    })
  }

  enforce(orgId: string, at: Date, actorUserId: string): Promise<OrgSsoConnectionRecord | null> {
    return this.inTransaction(async (tx) => {
      const current = await tx.orgSsoConnection.findUnique({ where: { orgId } })
      if (!current || current.activatedAt === null) return null
      if (current.enforcedAt !== null) return toRecord(current)
      const row = await tx.orgSsoConnection.update({ where: { orgId }, data: { enforcedAt: at } })
      await this.audit(tx, orgId, actorUserId, 'single sign-on enforced', {
        action: 'connection_enforced',
        connectionId: row.id
      })
      return toRecord(row)
    })
  }

  stopEnforcing(orgId: string, actorUserId: string): Promise<OrgSsoConnectionRecord | null> {
    return this.inTransaction(async (tx) => {
      const current = await tx.orgSsoConnection.findUnique({ where: { orgId } })
      if (!current) return null
      if (current.enforcedAt === null) return toRecord(current)
      const row = await tx.orgSsoConnection.update({ where: { orgId }, data: { enforcedAt: null } })
      await this.audit(tx, orgId, actorUserId, 'single sign-on no longer enforced', {
        action: 'connection_enforcement_stopped',
        connectionId: row.id
      })
      return toRecord(row)
    })
  }

  deactivate(orgId: string, at: Date, actorUserId: string): Promise<OrgSsoConnectionRecord | null> {
    return this.inTransaction(async (tx) => {
      const current = await tx.orgSsoConnection.findUnique({ where: { orgId } })
      if (!current) return null
      if (current.activatedAt === null && current.testExpiresAt === null) return toRecord(current)
      // A test window binds the same domains, so it ends too; it stays on the row until they are unbound.
      const row = await tx.orgSsoConnection.update({
        where: { orgId },
        data: {
          activatedAt: null,
          enforcedAt: null,
          testNonceHash: null,
          testExpiresAt: current.testExpiresAt ? at : null
        }
      })
      const wasActive = current.activatedAt !== null
      await this.audit(
        tx,
        orgId,
        actorUserId,
        `single sign-on ${wasActive ? 'connection deactivated' : 'test cancelled'}`,
        {
          action: wasActive ? 'connection_deactivated' : 'connection_test_cancelled',
          connectionId: row.id
        }
      )
      return toRecord(row)
    })
  }

  remove(orgId: string, actorUserId: string): Promise<OrgSsoConnectionRecord | null> {
    return this.inTransaction(async (tx) => {
      const current = await tx.orgSsoConnection.findUnique({ where: { orgId } })
      if (!current) return null
      await tx.orgSsoConnection.delete({ where: { orgId } })
      await this.audit(tx, orgId, actorUserId, 'single sign-on connection removed', {
        action: 'connection_removed',
        connectionId: current.id
      })
      return toRecord(current)
    })
  }

  async findByConnectorIds(connectorIds: readonly string[]): Promise<OrgSsoConnectionRecord[]> {
    if (connectorIds.length === 0) return []
    const rows = await this.db.orgSsoConnection.findMany({ where: { logtoConnectorId: { in: [...connectorIds] } } })
    return rows.map(toRecord)
  }

  async listActiveDomains(): Promise<
    { domain: string; orgId: string; connectorId: string; name: string; enforced: boolean }[]
  > {
    const rows = await this.db.orgSsoConnection.findMany({
      where: { activatedAt: { not: null } },
      select: {
        orgId: true,
        enforcedAt: true,
        logtoConnectorId: true,
        name: true,
        org: { select: { domains: { where: { verifiedAt: { not: null } }, select: { domain: true } } } }
      }
    })
    return rows.flatMap((row) =>
      row.org.domains.map(({ domain }) => ({
        domain,
        orgId: row.orgId,
        connectorId: row.logtoConnectorId,
        name: row.name,
        enforced: row.enforcedAt !== null
      }))
    )
  }

  async joinOnce(
    orgId: string,
    userId: string,
    connectionId: string,
    at: Date
  ): Promise<'joined' | 'already_member' | 'recorded'> {
    const run = () =>
      this.inTransaction(async (tx) => {
        const key = { orgId_userId: { orgId, userId } }
        if (await tx.orgSsoJoin.findUnique({ where: key })) return 'recorded' as const
        await tx.orgSsoJoin.create({ data: { orgId, userId, joinedAt: at } })
        // Someone invited earlier keeps their role; the record still stands, so a later removal is not overruled.
        if (await tx.membership.findUnique({ where: key })) return 'already_member' as const
        await tx.membership.create({ data: { orgId, userId, role: 'collaborator' } })
        await this.audit(tx, orgId, userId, 'member joined through single sign-on', {
          action: 'member_joined',
          connectionId,
          role: 'collaborator'
        })
        return 'joined' as const
      })
    try {
      return await run()
    } catch (err) {
      // Two sign-ins of the same person at once: the second reads the first's record.
      if ((err as { code?: string }).code === 'P2002') return run()
      throw err
    }
  }

  async subjectIsProvisioned(oidcSubject: string): Promise<boolean> {
    return (await this.db.user.findUnique({ where: { oidcSubject }, select: { id: true } })) !== null
  }

  async recordRefusal(
    orgId: string,
    details: { connectionId: string; subject: string; removed: boolean }
  ): Promise<void> {
    await this.audit(this.db, orgId, null, 'single sign-on refused an account outside the verified domains', {
      action: 'account_refused',
      ...details
    })
  }
}
