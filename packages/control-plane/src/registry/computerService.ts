// ComputerService — registration tokens, the token-for-key exchange, and the `computer` key principal (computer-use.md §3.6).
import { randomUUID } from 'node:crypto'
import type {
  ApiKeyRepo,
  AuditRepo,
  ComputerProfile,
  ComputerRecord,
  ComputerRegistrationRecord,
  ComputerRepo
} from '../persistence/ports.js'
import type { Clock } from '../domain/clock.js'
import { ComputerId, type OrgId } from '../domain/ids.js'
import {
  COMPUTER_REGISTRATION_DEFAULT_TTL_MINUTES,
  COMPUTER_REGISTRATION_MAX_TTL_MINUTES,
  type ComputerPolicy
} from '../domain/computer.js'
import type { ApiKeyCodec } from './apiKey.js'

/** Skip the best-effort `lastUsedAt` write unless the key has not been touched for this long. */
const LAST_USED_THROTTLE_MS = 60_000

/** Who a verified `computer` key acts as: one Computer in one organization, nothing else. */
export interface ComputerPrincipal {
  computerId: ComputerId
  orgId: OrgId
  apiKeyId: string
}

export interface IssuedComputerRegistration {
  registration: ComputerRegistrationRecord
  /** The one-time plaintext token, returned exactly once. */
  token: string
}

export interface RegisteredComputer {
  computer: ComputerRecord
  apiKeyId: string
  /** The Computer key's plaintext, returned exactly once. */
  apiKey: string
  displayTail: string
}

export class ComputerService {
  constructor(
    private readonly codec: ApiKeyCodec,
    private readonly computers: ComputerRepo,
    private readonly apiKeys: ApiKeyRepo,
    private readonly audit: AuditRepo,
    private readonly clock: Clock
  ) {}

  async createRegistration(input: {
    orgId: OrgId
    createdByUserId: string
    name?: string
    ttlMinutes?: number
  }): Promise<IssuedComputerRegistration> {
    const ttl = Math.min(
      Math.max(1, Math.floor(input.ttlMinutes ?? COMPUTER_REGISTRATION_DEFAULT_TTL_MINUTES)),
      COMPUTER_REGISTRATION_MAX_TTL_MINUTES
    )
    const minted = this.codec.mint()
    const registration = await this.computers.createRegistration({
      orgId: input.orgId,
      createdByUserId: input.createdByUserId,
      hash: minted.hash,
      displayTail: minted.displayTail,
      ...(input.name ? { name: input.name } : {}),
      expiresAt: new Date(this.clock.now() + ttl * 60_000)
    })
    this.record(input.orgId, input.createdByUserId, 'registration_create', {
      registrationId: registration.id,
      displayTail: registration.displayTail
    })
    return { registration, token: minted.token }
  }

  /** Spend a registration token: one Computer and its first key, or null for any unusable token. */
  async register(token: string, profile: ComputerProfile): Promise<RegisteredComputer | null> {
    const parsed = this.codec.parse(token)
    if (!parsed) return null
    const key = this.codec.mint()
    const result = await this.computers.register({
      registrationHash: this.codec.hash(parsed.secret),
      now: new Date(this.clock.now()),
      computerId: ComputerId(randomUUID()),
      profile,
      key: { hash: key.hash, displayTail: key.displayTail }
    })
    if (!result) return null
    this.record(result.computer.orgId, result.computer.ownerUserId, 'register', {
      computerId: result.computer.id,
      apiKeyId: result.apiKeyId,
      displayTail: key.displayTail
    })
    return { computer: result.computer, apiKeyId: result.apiKeyId, apiKey: key.token, displayTail: key.displayTail }
  }

  /** Verify a Computer-channel credential; any other principal, a revoked key or a revoked Computer is refused. */
  async authenticate(token: string): Promise<ComputerPrincipal | null> {
    const parsed = this.codec.parse(token)
    if (!parsed) return null
    // A store error propagates so a transient blip is not mistaken for a bad key.
    const row = await this.apiKeys.findByHash(this.codec.hash(parsed.secret))
    if (!row || row.principalType !== 'computer') return null
    if (!row.computerId || !row.orgId || row.revokedAt) return null
    const nowMs = this.clock.now()
    if (row.expiresAt && row.expiresAt.getTime() <= nowMs) return null
    const computer = await this.computers.getUnscoped(row.computerId)
    if (!computer || computer.orgId !== row.orgId || computer.status === 'revoked') return null
    if (!row.lastUsedAt || nowMs - row.lastUsedAt.getTime() >= LAST_USED_THROTTLE_MS) {
      void this.apiKeys.touchLastUsed(row.id, new Date(nowMs)).catch(() => {})
    }
    return { computerId: row.computerId, orgId: row.orgId, apiKeyId: row.id }
  }

  async setPolicy(orgId: OrgId, id: ComputerId, policy: ComputerPolicy, actorUserId?: string): Promise<ComputerRecord> {
    const computer = await this.computers.setPolicy(orgId, id, policy)
    this.record(orgId, actorUserId, 'policy_update', {
      computerId: id,
      allowedAgents: policy.allowedAgents,
      agentMode: policy.agentMode
    })
    return computer
  }

  async revoke(orgId: OrgId, id: ComputerId, actorUserId?: string): Promise<ComputerRecord> {
    const { computer, revokedKeyIds } = await this.computers.revoke(
      orgId,
      id,
      'computer revoked',
      new Date(this.clock.now())
    )
    this.record(orgId, actorUserId, 'revoke', { computerId: id, revokedKeyIds })
    return computer
  }

  async delete(orgId: OrgId, id: ComputerId, actorUserId?: string): Promise<void> {
    await this.computers.delete(orgId, id)
    this.record(orgId, actorUserId, 'delete', { computerId: id })
  }

  // Best-effort audit: never blocks or fails the operation, and never carries a secret.
  private record(orgId: OrgId, actorUserId: string | undefined, action: string, details: Record<string, unknown>) {
    void this.audit
      .append({
        kind: 'computer_change',
        orgId,
        ...(actorUserId ? { actorUserId } : {}),
        details: { action, ...details }
      })
      .catch(() => {})
  }
}
