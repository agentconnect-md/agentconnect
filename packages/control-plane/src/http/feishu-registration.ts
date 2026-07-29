/**
 * Durable coordinator for Feishu/Lark's one-click app registration.
 *
 * Provider cursors and provisional credentials live behind a SecretCipher
 * persistence seam, so a browser poll can continue on any Control Plane
 * replica. A short DB claim leases each provider/finalize step to one replica.
 */
import { randomUUID } from 'node:crypto'
import type { FeishuRegion } from '@agentconnect.md/protocol'
import { AgentId, BotId, IntegrationId, type OrgId } from '../domain/ids.js'
import type { FeishuAppRegistrationRecord, FeishuAppRegistrationStore } from '../persistence/ports.js'
import { OfficialFeishuRegistrationProvider, type FeishuRegistrationProvider } from './feishu-registration-provider.js'

export type FeishuRegistrationFailure =
  'denied' | 'expired' | 'agent_unavailable' | 'invalid_credentials' | 'setup_failed'

export class FeishuRegistrationSetupError extends Error {
  constructor(readonly reason: Exclude<FeishuRegistrationFailure, 'denied' | 'expired'>) {
    super(reason)
    this.name = 'FeishuRegistrationSetupError'
  }
}

export class FeishuRegistrationConflictError extends Error {
  constructor() {
    super('another user is already setting up a Feishu/Lark app for this agent')
    this.name = 'FeishuRegistrationConflictError'
  }
}

/** Placement is moving; keep the authorized credentials and retry finalization. */
export class FeishuRegistrationRetryError extends Error {
  constructor() {
    super('agent placement is changing')
    this.name = 'FeishuRegistrationRetryError'
  }
}

export interface StartFeishuRegistration {
  orgId: OrgId
  agentId: AgentId
  fallbackRegion: FeishuRegion
  appName: string
  requestedName?: string
  createdByUserId: string
}

export interface FinalizeFeishuRegistration {
  orgId: OrgId
  agentId: AgentId
  requestedName: string | null
  createdByUserId: string
  botId: BotId
  integrationId: IntegrationId
  appId: string
  appSecret: string
  region: FeishuRegion
}

export interface FeishuRegistrationSnapshot {
  id: string
  orgId: OrgId
  agentId: AgentId
  authorizationUrl: string
  expiresAt: Date
  status: 'pending' | 'completed' | 'failed'
  failureReason: FeishuRegistrationFailure | null
  integrationId: IntegrationId | null
}

const CLAIM_MS = 2 * 60 * 1000

function targetKey(orgId: OrgId, agentId: AgentId): string {
  return `${orgId}:${agentId}`
}

function failureReason(error: unknown): FeishuRegistrationFailure {
  return error instanceof FeishuRegistrationSetupError ? error.reason : 'setup_failed'
}

function publicSnapshot(row: FeishuAppRegistrationRecord): FeishuRegistrationSnapshot {
  const status = row.status === 'authorized' ? 'pending' : row.status
  return {
    id: row.id,
    orgId: row.orgId,
    agentId: row.agentId,
    authorizationUrl: row.authorizationUrl,
    expiresAt: row.expiresAt,
    status,
    failureReason:
      status === 'failed' ? ((row.failureReason as FeishuRegistrationFailure | null) ?? 'setup_failed') : null,
    integrationId: status === 'completed' ? row.integrationId : null
  }
}

function isUniqueConstraint(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'P2002'
}

export class FeishuAppRegistrationService {
  constructor(
    private readonly store: FeishuAppRegistrationStore,
    private readonly provider: FeishuRegistrationProvider = new OfficialFeishuRegistrationProvider(),
    private readonly now: () => number = Date.now
  ) {}

  async start(input: StartFeishuRegistration): Promise<FeishuRegistrationSnapshot> {
    const key = targetKey(input.orgId, input.agentId)
    const now = new Date(this.now())
    await this.store.expireTarget(key, now)
    const existing = await this.store.getActiveTarget(key)
    if (existing) return this.reuseOrConflict(existing, input.createdByUserId)

    const begun = await this.provider.begin(input.appName)
    try {
      const row = await this.store.create({
        id: randomUUID(),
        targetKey: key,
        orgId: input.orgId,
        agentId: input.agentId,
        ...(input.requestedName ? { requestedName: input.requestedName } : {}),
        fallbackRegion: input.fallbackRegion,
        authorizationUrl: begun.authorizationUrl,
        providerDomain: begun.providerDomain,
        deviceCode: begun.deviceCode,
        intervalMs: begun.intervalMs,
        nextPollAt: now,
        expiresAt: new Date(now.getTime() + begun.expiresInMs),
        botId: BotId(randomUUID()),
        integrationId: IntegrationId(randomUUID()),
        createdByUserId: input.createdByUserId
      })
      return publicSnapshot(row)
    } catch (error) {
      if (!isUniqueConstraint(error)) throw error
      const winner = await this.store.getActiveTarget(key)
      if (!winner) throw error
      return this.reuseOrConflict(winner, input.createdByUserId)
    }
  }

  async get(
    id: string,
    orgId: OrgId,
    finalize: (input: FinalizeFeishuRegistration) => Promise<void>
  ): Promise<FeishuRegistrationSnapshot | null> {
    let row = await this.store.get(id)
    if (!row || row.orgId !== orgId) return null

    const now = new Date(this.now())
    if (row.status === 'pending' && row.expiresAt <= now) {
      await this.store.expire(id, now)
      row = (await this.store.get(id)) ?? row
    }
    if (row.status === 'completed' || row.status === 'failed') return publicSnapshot(row)

    const claimToken = randomUUID()
    const claimed = await this.store.claim(id, claimToken, now, new Date(now.getTime() + CLAIM_MS))
    if (!claimed) return publicSnapshot((await this.store.get(id)) ?? row)

    let current = claimed
    if (current.status === 'pending') {
      current = await this.poll(current, claimToken)
      if (current.status !== 'authorized') return publicSnapshot(current)
    }

    if (!current.appId || !current.appSecret || !current.resolvedRegion || !current.createdByUserId) {
      await this.store.settle(id, claimToken, { status: 'failed', failureReason: 'setup_failed' })
    } else {
      try {
        await finalize({
          orgId: current.orgId,
          agentId: current.agentId,
          requestedName: current.requestedName,
          createdByUserId: current.createdByUserId,
          botId: current.botId,
          integrationId: current.integrationId,
          appId: current.appId,
          appSecret: current.appSecret,
          region: current.resolvedRegion
        })
      } catch (error) {
        if (error instanceof FeishuRegistrationRetryError) {
          await this.store.releaseAuthorized(id, claimToken)
        } else {
          await this.store.settle(id, claimToken, {
            status: 'failed',
            failureReason: failureReason(error)
          })
        }
        return publicSnapshot((await this.store.get(id)) ?? current)
      }
      // Keep settlement outside the finalize catch. If this DB write itself is
      // transient, the authorized row and reserved IDs remain retryable instead
      // of reporting failure after the integration was already installed.
      await this.store.settle(id, claimToken, { status: 'completed' })
    }
    return publicSnapshot((await this.store.get(id)) ?? current)
  }

  private async poll(row: FeishuAppRegistrationRecord, claimToken: string): Promise<FeishuAppRegistrationRecord> {
    if (!row.deviceCode) {
      await this.store.settle(row.id, claimToken, { status: 'failed', failureReason: 'setup_failed' })
      return (await this.store.get(row.id)) ?? row
    }

    let result
    try {
      result = await this.provider.poll(row.providerDomain, row.deviceCode)
    } catch {
      await this.release(row, claimToken, row.intervalMs)
      return (await this.store.get(row.id)) ?? row
    }

    switch (result.outcome) {
      case 'pending':
        await this.release(row, claimToken, row.intervalMs)
        break
      case 'slow_down':
        await this.release(row, claimToken, row.intervalMs + 5000)
        break
      case 'switch_domain':
        await this.release(row, claimToken, row.intervalMs, result.providerDomain, 0)
        break
      case 'authorized': {
        const authorized = await this.store.authorize(row.id, claimToken, {
          appId: result.appId,
          appSecret: result.appSecret,
          region: result.region ?? row.fallbackRegion
        })
        if (authorized) return authorized
        break
      }
      case 'denied':
        await this.store.settle(row.id, claimToken, { status: 'failed', failureReason: 'denied' })
        break
      case 'expired':
        await this.store.settle(row.id, claimToken, { status: 'failed', failureReason: 'expired' })
        break
      case 'failed':
        await this.store.settle(row.id, claimToken, { status: 'failed', failureReason: 'setup_failed' })
        break
    }
    return (await this.store.get(row.id)) ?? row
  }

  private async release(
    row: FeishuAppRegistrationRecord,
    claimToken: string,
    intervalMs: number,
    providerDomain?: string,
    delayMs = intervalMs
  ): Promise<void> {
    await this.store.release(row.id, claimToken, {
      ...(providerDomain ? { providerDomain } : {}),
      intervalMs,
      nextPollAt: new Date(this.now() + delayMs)
    })
  }

  private reuseOrConflict(existing: FeishuAppRegistrationRecord, createdByUserId: string): FeishuRegistrationSnapshot {
    if (existing.createdByUserId !== createdByUserId) throw new FeishuRegistrationConflictError()
    return publicSnapshot(existing)
  }
}
