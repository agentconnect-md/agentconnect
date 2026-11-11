// Members' pending requests for an agent's own Teams bot (teams-integration.md §8.6.6); the refresh token is sealed with SecretCipher.
import type { MsTeamsAgentBotRequest } from '../../generated/prisma/client.js'
import type { PrismaLike } from '../prisma.js'
import type {
  CreateMsTeamsAgentBotRequestInput,
  MsTeamsAgentBotRequestRecord,
  MsTeamsAgentBotRequestStatus,
  MsTeamsAgentBotRequestStore
} from '../ports.js'
import type { SecretCipher } from '../../secrets/cipher.js'
import { orgScope } from '../../secrets/scope.js'
import { AgentId, OrgId } from '../../domain/ids.js'

const STATUSES = new Set<string>(['pending', 'needs_sign_in', 'rejected'])

export class PgMsTeamsAgentBotRequestStore implements MsTeamsAgentBotRequestStore {
  constructor(
    private readonly prisma: PrismaLike,
    private readonly cipher: SecretCipher
  ) {}

  private async toRecord(row: MsTeamsAgentBotRequest): Promise<MsTeamsAgentBotRequestRecord> {
    const scope = orgScope(OrgId(row.orgId))
    return {
      id: row.id,
      orgId: OrgId(row.orgId),
      agentId: AgentId(row.agentId),
      tenantId: row.tenantId,
      createdByUserId: row.createdByUserId,
      sponsorId: row.sponsorId,
      identity: row.identity,
      catalogAppId: row.catalogAppId,
      teamIds: row.teamIds,
      appPackage: row.appPackage,
      botName: row.botName,
      refreshToken: row.refreshToken === null ? null : await this.cipher.open(row.refreshToken, scope),
      status: STATUSES.has(row.status) ? (row.status as MsTeamsAgentBotRequestStatus) : 'rejected',
      reason: row.reason,
      checks: row.checks,
      nextCheckAt: row.nextCheckAt,
      createdAt: row.createdAt
    }
  }

  async create(input: CreateMsTeamsAgentBotRequestInput): Promise<MsTeamsAgentBotRequestRecord> {
    const key = { orgId: input.orgId, agentId: input.agentId, tenantId: input.tenantId }
    // The agent's earlier request for the tenant gives way, whatever state it stopped in.
    await this.prisma.msTeamsAgentBotRequest.deleteMany({ where: key })
    const row = await this.prisma.msTeamsAgentBotRequest.create({
      data: {
        ...key,
        id: input.id,
        createdByUserId: input.createdByUserId,
        sponsorId: input.sponsorId,
        identity: input.identity,
        catalogAppId: input.catalogAppId,
        teamIds: input.teamIds,
        appPackage: input.appPackage,
        botName: input.botName,
        refreshToken: await this.cipher.seal(input.refreshToken, orgScope(input.orgId)),
        status: 'pending',
        nextCheckAt: input.nextCheckAt
      }
    })
    return this.toRecord(row)
  }

  async get(orgId: OrgId, id: string): Promise<MsTeamsAgentBotRequestRecord | null> {
    const row = await this.prisma.msTeamsAgentBotRequest.findUnique({ where: { id, orgId } })
    return row ? this.toRecord(row) : null
  }

  async listForAgent(orgId: OrgId, agentId: AgentId): Promise<MsTeamsAgentBotRequestRecord[]> {
    const rows = await this.prisma.msTeamsAgentBotRequest.findMany({
      where: { orgId, agentId },
      orderBy: { createdAt: 'asc' }
    })
    return Promise.all(rows.map((row) => this.toRecord(row)))
  }

  async due(now: Date, limit: number): Promise<{ orgId: OrgId; id: string }[]> {
    const rows = await this.prisma.msTeamsAgentBotRequest.findMany({
      where: { status: 'pending', nextCheckAt: { lte: now } },
      orderBy: { nextCheckAt: 'asc' },
      take: limit,
      select: { id: true, orgId: true }
    })
    return rows.map((row) => ({ id: row.id, orgId: OrgId(row.orgId) }))
  }

  async openedBefore(before: Date, limit: number): Promise<{ orgId: OrgId; id: string }[]> {
    const rows = await this.prisma.msTeamsAgentBotRequest.findMany({
      where: { createdAt: { lt: before } },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true, orgId: true }
    })
    return rows.map((row) => ({ id: row.id, orgId: OrgId(row.orgId) }))
  }

  async claim(orgId: OrgId, id: string, token: string, now: Date, until: Date): Promise<boolean> {
    const { count } = await this.prisma.msTeamsAgentBotRequest.updateMany({
      where: { id, orgId, OR: [{ claimedUntil: null }, { claimedUntil: { lte: now } }] },
      data: { claimToken: token, claimedUntil: until }
    })
    return count === 1
  }

  async holds(orgId: OrgId, id: string, token: string): Promise<boolean> {
    return (await this.prisma.msTeamsAgentBotRequest.count({ where: { id, orgId, claimToken: token } })) === 1
  }

  async release(
    orgId: OrgId,
    id: string,
    token: string,
    patch: {
      nextCheckAt: Date
      refreshToken?: string | null
      status?: MsTeamsAgentBotRequestStatus
      reason?: string | null
    }
  ): Promise<void> {
    const refreshToken =
      patch.refreshToken === undefined || patch.refreshToken === null
        ? patch.refreshToken
        : await this.cipher.seal(patch.refreshToken, orgScope(orgId))
    await this.prisma.msTeamsAgentBotRequest.updateMany({
      where: { id, orgId, claimToken: token },
      data: {
        claimToken: null,
        claimedUntil: null,
        checks: { increment: 1 },
        nextCheckAt: patch.nextCheckAt,
        ...(refreshToken !== undefined ? { refreshToken } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.reason !== undefined ? { reason: patch.reason } : {})
      }
    })
  }

  async resume(orgId: OrgId, id: string, refreshToken: string, now: Date): Promise<void> {
    await this.prisma.msTeamsAgentBotRequest.updateMany({
      where: { id, orgId },
      data: {
        refreshToken: await this.cipher.seal(refreshToken, orgScope(orgId)),
        status: 'pending',
        reason: null,
        checks: 0,
        nextCheckAt: now
      }
    })
  }

  async delete(orgId: OrgId, id: string): Promise<void> {
    await this.prisma.msTeamsAgentBotRequest.deleteMany({ where: { id, orgId } })
  }
}
