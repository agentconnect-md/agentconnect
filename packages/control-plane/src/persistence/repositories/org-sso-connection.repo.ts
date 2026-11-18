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
      const existed = (await tx.orgSsoConnection.findUnique({ where: { orgId }, select: { id: true } })) !== null
      const changed = {
        logtoConnectorId,
        protocol,
        name,
        configChangedAt: at,
        testNonceHash: null,
        testExpiresAt: null
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

  setActive(orgId: string, at: Date | null, actorUserId: string): Promise<OrgSsoConnectionRecord | null> {
    return this.inTransaction(async (tx) => {
      const current = await tx.orgSsoConnection.findUnique({ where: { orgId } })
      if (!current) return null
      if ((current.activatedAt !== null) === (at !== null)) return toRecord(current)
      const row = await tx.orgSsoConnection.update({ where: { orgId }, data: { activatedAt: at } })
      await this.audit(tx, orgId, actorUserId, `single sign-on connection ${at ? 'activated' : 'deactivated'}`, {
        action: at ? 'connection_activated' : 'connection_deactivated',
        connectionId: row.id
      })
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
