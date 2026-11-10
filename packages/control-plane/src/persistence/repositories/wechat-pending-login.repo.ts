// Durable personal-WeChat QR logins (wechat-integration.md §2.2); the iLink handle and bot token are sealed with SecretCipher.
import type { WechatPendingLogin } from '../../generated/prisma/client.js'
import type { PrismaLike } from '../prisma.js'
import type {
  CreateWechatPendingLoginInput,
  WechatLoginState,
  WechatPendingLoginRecord,
  WechatPendingLoginStore
} from '../ports.js'
import type { SecretCipher } from '../../secrets/cipher.js'
import { orgScope } from '../../secrets/scope.js'
import { AgentId, BotId, IntegrationId, OrgId } from '../../domain/ids.js'

const OPEN: WechatLoginState[] = ['waiting', 'scanned', 'verify_code', 'authorized']
const STATES = new Set<string>([...OPEN, 'completed', 'failed'])

export class PgWechatPendingLoginStore implements WechatPendingLoginStore {
  constructor(
    private readonly prisma: PrismaLike,
    private readonly cipher: SecretCipher
  ) {}

  private async toRecord(row: WechatPendingLogin): Promise<WechatPendingLoginRecord> {
    const scope = orgScope(OrgId(row.orgId))
    return {
      id: row.id,
      targetKey: row.targetKey,
      orgId: OrgId(row.orgId),
      agentId: AgentId(row.agentId),
      botId: row.botId ? BotId(row.botId) : null,
      requestedName: row.requestedName,
      createdByUserId: row.createdByUserId,
      qrcode: row.qrcode === null ? null : await this.cipher.open(row.qrcode, scope),
      qrUrl: row.qrUrl,
      pollHost: row.pollHost,
      status: STATES.has(row.status) ? (row.status as WechatLoginState) : 'failed',
      failureReason: row.failureReason,
      botToken: row.botToken === null ? null : await this.cipher.open(row.botToken, scope),
      ilinkBotId: row.ilinkBotId,
      ilinkUserId: row.ilinkUserId,
      baseUrl: row.baseUrl,
      integrationId: row.integrationId ? IntegrationId(row.integrationId) : null,
      resultBotId: row.resultBotId ? BotId(row.resultBotId) : null,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
      settledAt: row.settledAt
    }
  }

  async create(input: CreateWechatPendingLoginInput): Promise<WechatPendingLoginRecord> {
    const row = await this.prisma.wechatPendingLogin.create({
      data: {
        id: input.id,
        targetKey: input.targetKey,
        orgId: input.orgId,
        agentId: input.agentId,
        ...(input.botId ? { botId: input.botId } : {}),
        ...(input.requestedName ? { requestedName: input.requestedName } : {}),
        createdByUserId: input.createdByUserId,
        qrcode: await this.cipher.seal(input.qrcode, orgScope(input.orgId)),
        qrUrl: input.qrUrl,
        pollHost: input.pollHost,
        status: 'waiting',
        expiresAt: input.expiresAt
      }
    })
    return this.toRecord(row)
  }

  async get(orgId: OrgId, id: string): Promise<WechatPendingLoginRecord | null> {
    const row = await this.prisma.wechatPendingLogin.findUnique({ where: { id, orgId } })
    return row ? this.toRecord(row) : null
  }

  async getActiveTarget(orgId: OrgId, targetKey: string): Promise<WechatPendingLoginRecord | null> {
    const row = await this.prisma.wechatPendingLogin.findUnique({ where: { targetKey } })
    return row && row.orgId === orgId ? this.toRecord(row) : null
  }

  async advance(
    orgId: OrgId,
    id: string,
    patch: { status: 'waiting' | 'scanned' | 'verify_code'; qrcode?: string; qrUrl?: string; pollHost?: string }
  ): Promise<void> {
    await this.prisma.wechatPendingLogin.updateMany({
      where: { id, orgId, status: { in: ['waiting', 'scanned', 'verify_code'] } },
      data: {
        status: patch.status,
        ...(patch.qrcode !== undefined ? { qrcode: await this.cipher.seal(patch.qrcode, orgScope(orgId)) } : {}),
        ...(patch.qrUrl !== undefined ? { qrUrl: patch.qrUrl } : {}),
        ...(patch.pollHost !== undefined ? { pollHost: patch.pollHost } : {})
      }
    })
  }

  async authorize(
    orgId: OrgId,
    id: string,
    result: { botToken: string; ilinkBotId: string; ilinkUserId: string; baseUrl: string | null }
  ): Promise<void> {
    await this.prisma.wechatPendingLogin.updateMany({
      where: { id, orgId, status: { in: ['waiting', 'scanned', 'verify_code'] } },
      data: {
        status: 'authorized',
        qrcode: null,
        botToken: await this.cipher.seal(result.botToken, orgScope(orgId)),
        ilinkBotId: result.ilinkBotId,
        ilinkUserId: result.ilinkUserId,
        baseUrl: result.baseUrl
      }
    })
  }

  async claim(orgId: OrgId, id: string, token: string, now: Date, until: Date): Promise<boolean> {
    const { count } = await this.prisma.wechatPendingLogin.updateMany({
      where: {
        id,
        orgId,
        status: 'authorized',
        OR: [{ claimedUntil: null }, { claimedUntil: { lte: now } }]
      },
      data: { claimToken: token, claimedUntil: until }
    })
    return count === 1
  }

  async release(orgId: OrgId, id: string, token: string): Promise<void> {
    await this.prisma.wechatPendingLogin.updateMany({
      where: { id, orgId, claimToken: token },
      data: { claimToken: null, claimedUntil: null }
    })
  }

  async settle(
    orgId: OrgId,
    id: string,
    outcome:
      { status: 'completed'; integrationId: IntegrationId; botId: BotId } | { status: 'failed'; failureReason: string },
    at: Date
  ): Promise<void> {
    await this.prisma.wechatPendingLogin.updateMany({
      where: { id, orgId, status: { in: OPEN } },
      data: {
        status: outcome.status,
        targetKey: null,
        qrcode: null,
        botToken: null,
        claimToken: null,
        claimedUntil: null,
        settledAt: at,
        ...(outcome.status === 'completed'
          ? { integrationId: outcome.integrationId, resultBotId: outcome.botId }
          : { failureReason: outcome.failureReason })
      }
    })
  }

  async reapExpired(staleBefore: Date): Promise<number> {
    const { count } = await this.prisma.wechatPendingLogin.deleteMany({ where: { createdAt: { lt: staleBefore } } })
    return count
  }
}
