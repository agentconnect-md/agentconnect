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
import { orgScope } from '../../secrets/scope.js'
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

  // These rows are worked by a background poller that serves no tenant, so the
  // at-rest key scope comes from the row itself (ports.ts documents why: the
  // polling methods are lease-fenced system-tier, org-scoped-data-layer.md §3.4).
  // On `get` the query is org-fenced first, so the row's org IS the caller's.
  private async toRecord(row: FeishuAppRegistration): Promise<FeishuAppRegistrationRecord> {
    const scope = orgScope(OrgId(row.orgId))
    return {
      id: row.id,
      targetKey: row.targetKey,
      orgId: OrgId(row.orgId),
      agentId: AgentId(row.agentId),
      requestedName: row.requestedName,
      fallbackRegion: region(row.fallbackRegion) ?? 'lark',
      transport: row.transport,
      authorizationUrl: row.authorizationUrl,
      providerDomain: row.providerDomain,
      deviceCode: row.deviceCode === null ? null : await this.cipher.open(row.deviceCode, scope),
      intervalMs: row.intervalMs,
      nextPollAt: row.nextPollAt,
      expiresAt: row.expiresAt,
      status: row.status,
      failureReason: row.failureReason,
      appId: row.appId,
      appSecret: row.appSecret === null ? null : await this.cipher.open(row.appSecret, scope),
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
        transport: input.transport,
        authorizationUrl: input.authorizationUrl,
        providerDomain: input.providerDomain,
        deviceCode: await this.cipher.seal(input.deviceCode, orgScope(input.orgId)),
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

  async get(orgId: OrgId, id: string): Promise<FeishuAppRegistrationRecord | null> {
    const row = await this.prisma.feishuAppRegistration.findUnique({ where: { id, orgId } })
    return row ? this.toRecord(row) : null
  }

  /** System-tier read for the lease-fenced worker paths below (see ports.ts). */
  private async getSystem(id: string): Promise<FeishuAppRegistrationRecord | null> {
    const row = await this.prisma.feishuAppRegistration.findUnique({ where: { id } })
    return row ? this.toRecord(row) : null
  }

  async getActiveTarget(targetKey: string): Promise<FeishuAppRegistrationRecord | null> {
    const row = await this.prisma.feishuAppRegistration.findUnique({ where: { targetKey } })
    return row ? this.toRecord(row) : null
  }

  async expire(id: string, now: Date): Promise<void> {
    await this.prisma.feishuAppRegistration.updateMany({
      where: {
        id,
        status: 'pending',
        expiresAt: { lte: now },
        OR: [{ claimedUntil: null }, { claimedUntil: { lte: now } }]
      },
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
      where: {
        targetKey,
        status: 'pending',
        expiresAt: { lte: now },
        OR: [{ claimedUntil: null }, { claimedUntil: { lte: now } }]
      },
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
    return claimed.count === 1 ? this.getSystem(id) : null
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
    // The key scope has to be known BEFORE the sealing update, and this path is
    // fenced by the claim token rather than an org — read the owner off the row.
    const owner = await this.prisma.feishuAppRegistration.findUnique({ where: { id }, select: { orgId: true } })
    if (!owner) return null
    const updated = await this.prisma.feishuAppRegistration.updateMany({
      where: { id, status: 'pending', claimToken },
      data: {
        status: 'authorized',
        appId: input.appId,
        appSecret: await this.cipher.seal(input.appSecret, orgScope(OrgId(owner.orgId))),
        resolvedRegion: input.region,
        deviceCode: null
      }
    })
    return updated.count === 1 ? this.getSystem(id) : null
  }

  async releaseAuthorized(id: string, claimToken: string): Promise<void> {
    await this.prisma.feishuAppRegistration.updateMany({
      where: { id, status: 'authorized', claimToken },
      data: { claimToken: null, claimedUntil: null }
    })
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
