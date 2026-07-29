/**
 * Durable Feishu/Lark device-registration state.
 *
 * Device codes and provisional App Secrets are sealed with the deployment's
 * SecretCipher. Claim tokens make provider polling and finalization
 * single-writer across Control Plane replicas.
 */
import type { FeishuAppRegistration } from '../../generated/prisma/client.js'
import type { PrismaLike } from '../prisma.js'
import type {
  CreateFeishuAppRegistrationInput,
  FeishuAppRegistrationRecord,
  FeishuAppRegistrationStore
} from '../ports.js'
import type { SecretCipher } from '../../secrets/cipher.js'
import { AgentId, BotId, IntegrationId, OrgId } from '../../domain/ids.js'
import type { FeishuRegion } from '@agentconnect.md/protocol'

function region(value: string | null): FeishuRegion | null {
  return value === 'feishu' || value === 'lark' ? value : null
}

export class PgFeishuAppRegistrationStore implements FeishuAppRegistrationStore {
  constructor(
    private readonly prisma: PrismaLike,
    private readonly cipher: SecretCipher
  ) {}

  private async toRecord(row: FeishuAppRegistration): Promise<FeishuAppRegistrationRecord> {
    return {
      id: row.id,
      targetKey: row.targetKey,
      orgId: OrgId(row.orgId),
      agentId: AgentId(row.agentId),
      requestedName: row.requestedName,
      fallbackRegion: region(row.fallbackRegion) ?? 'lark',
      authorizationUrl: row.authorizationUrl,
      providerDomain: row.providerDomain,
      deviceCode: row.deviceCode === null ? null : await this.cipher.open(row.deviceCode),
      intervalMs: row.intervalMs,
      nextPollAt: row.nextPollAt,
      expiresAt: row.expiresAt,
      status: row.status,
      failureReason: row.failureReason,
      appId: row.appId,
      appSecret: row.appSecret === null ? null : await this.cipher.open(row.appSecret),
      resolvedRegion: region(row.resolvedRegion),
      botId: BotId(row.botId),
      integrationId: IntegrationId(row.integrationId),
      createdByUserId: row.createdByUserId,
      claimToken: row.claimToken,
      claimedUntil: row.claimedUntil,
      createdAt: row.createdAt,
      settledAt: row.settledAt
    }
  }

  async create(input: CreateFeishuAppRegistrationInput): Promise<FeishuAppRegistrationRecord> {
    const row = await this.prisma.feishuAppRegistration.create({
      data: {
        id: input.id,
        targetKey: input.targetKey,
        orgId: input.orgId,
        agentId: input.agentId,
        ...(input.requestedName !== undefined ? { requestedName: input.requestedName } : {}),
        fallbackRegion: input.fallbackRegion,
        authorizationUrl: input.authorizationUrl,
        providerDomain: input.providerDomain,
        deviceCode: await this.cipher.seal(input.deviceCode),
        intervalMs: input.intervalMs,
        nextPollAt: input.nextPollAt,
        expiresAt: input.expiresAt,
        botId: input.botId,
        integrationId: input.integrationId,
        createdByUserId: input.createdByUserId
      }
    })
    return this.toRecord(row)
  }

  async get(id: string): Promise<FeishuAppRegistrationRecord | null> {
    const row = await this.prisma.feishuAppRegistration.findUnique({ where: { id } })
    return row ? this.toRecord(row) : null
  }

  async getActiveTarget(targetKey: string): Promise<FeishuAppRegistrationRecord | null> {
    const row = await this.prisma.feishuAppRegistration.findUnique({ where: { targetKey } })
    return row ? this.toRecord(row) : null
  }

  async expire(id: string, now: Date): Promise<void> {
    await this.prisma.feishuAppRegistration.updateMany({
      where: { id, status: 'pending', expiresAt: { lte: now } },
      data: {
        status: 'failed',
        failureReason: 'expired',
        targetKey: null,
        deviceCode: null,
        appSecret: null,
        claimToken: null,
        claimedUntil: null,
        settledAt: now
      }
    })
  }

  async expireTarget(targetKey: string, now: Date): Promise<void> {
    await this.prisma.feishuAppRegistration.updateMany({
      where: { targetKey, status: 'pending', expiresAt: { lte: now } },
      data: {
        status: 'failed',
        failureReason: 'expired',
        targetKey: null,
        deviceCode: null,
        appSecret: null,
        claimToken: null,
        claimedUntil: null,
        settledAt: now
      }
    })
  }

  async claim(
    id: string,
    claimToken: string,
    now: Date,
    claimedUntil: Date
  ): Promise<FeishuAppRegistrationRecord | null> {
    const claimed = await this.prisma.feishuAppRegistration.updateMany({
      where: {
        id,
        AND: [
          { OR: [{ claimedUntil: null }, { claimedUntil: { lte: now } }] },
          {
            OR: [{ status: 'authorized' }, { status: 'pending', expiresAt: { gt: now }, nextPollAt: { lte: now } }]
          }
        ]
      },
      data: { claimToken, claimedUntil }
    })
    return claimed.count === 1 ? this.get(id) : null
  }

  async release(
    id: string,
    claimToken: string,
    update: { providerDomain?: string; intervalMs: number; nextPollAt: Date }
  ): Promise<void> {
    await this.prisma.feishuAppRegistration.updateMany({
      where: { id, status: 'pending', claimToken },
      data: {
        ...(update.providerDomain ? { providerDomain: update.providerDomain } : {}),
        intervalMs: update.intervalMs,
        nextPollAt: update.nextPollAt,
        claimToken: null,
        claimedUntil: null
      }
    })
  }

  async authorize(
    id: string,
    claimToken: string,
    input: { appId: string; appSecret: string; region: FeishuRegion }
  ): Promise<FeishuAppRegistrationRecord | null> {
    const updated = await this.prisma.feishuAppRegistration.updateMany({
      where: { id, status: 'pending', claimToken },
      data: {
        status: 'authorized',
        appId: input.appId,
        appSecret: await this.cipher.seal(input.appSecret),
        resolvedRegion: input.region,
        deviceCode: null
      }
    })
    return updated.count === 1 ? this.get(id) : null
  }

  async settle(
    id: string,
    claimToken: string,
    outcome: { status: 'completed' } | { status: 'failed'; failureReason: string }
  ): Promise<void> {
    await this.prisma.feishuAppRegistration.updateMany({
      where: { id, status: { in: ['pending', 'authorized'] }, claimToken },
      data: {
        status: outcome.status,
        ...(outcome.status === 'failed' ? { failureReason: outcome.failureReason } : {}),
        targetKey: null,
        deviceCode: null,
        appSecret: null,
        claimToken: null,
        claimedUntil: null,
        settledAt: new Date()
      }
    })
  }

  async reapExpired(staleBefore: Date): Promise<number> {
    const deleted = await this.prisma.feishuAppRegistration.deleteMany({
      where: {
        OR: [{ settledAt: { lt: staleBefore } }, { expiresAt: { lt: staleBefore } }]
      }
    })
    return deleted.count
  }
}
