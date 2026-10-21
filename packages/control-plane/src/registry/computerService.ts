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
  COMPUTER_STALE_AFTER_MS,
  agentsAffectedByAccess,
  presentComputerStatus,
  type ComputerAgentAccess,
  type ComputerPolicy,
  type ComputerStatus
} from '../domain/computer.js'
import type { ApiKeyCodec } from './apiKey.js'
import type { ComputerChannelControl } from '../ws/computer-registry.js'
import type { ComputerLeaseService } from './computerLeaseService.js'
import type { ComputerScreenshots } from './computerScreenshots.js'

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

export interface ComputerServiceOpts {
  /** Live Computer channels, so a revoke, delete or policy change reaches a connected desktop at once. */
  channels?: ComputerChannelControl
  /** Control leases: a revoke ends the lease, and a policy change re-checks it. */
  leases?: Pick<ComputerLeaseService, 'current' | 'preempt'>
  /** A live status older than this reads as offline: its channel died without a clean close. */
  staleAfterMs?: number
  /** Stored screenshots, so a lowered retention applies to the ones already kept. */
  screenshots?: Pick<ComputerScreenshots, 'applyRetention'>
  /** Re-ship the specs of agents whose derived Computer list changed; best-effort, the reconnect roster is the backstop. */
  onAgentAccessChanged?: (orgId: OrgId, agents: 'all' | string[]) => Promise<void>
}

export class ComputerService {
  constructor(
    private readonly codec: ApiKeyCodec,
    private readonly computers: ComputerRepo,
    private readonly apiKeys: ApiKeyRepo,
    private readonly audit: AuditRepo,
    private readonly clock: Clock,
    private readonly opts: ComputerServiceOpts = {}
  ) {}

  /** The status to show: a live one the channel stopped refreshing has gone offline. */
  presentedStatus(c: Pick<ComputerRecord, 'status' | 'lastSeenAt'> & { stoppedAt?: Date | null }): ComputerStatus {
    return presentComputerStatus(c, this.clock.now(), this.opts.staleAfterMs ?? COMPUTER_STALE_AFTER_MS)
  }

  /** A removed member's Computers were revoked in the removal transaction; end their live channels too. */
  memberRemoved(orgId: string, userId: string): void {
    this.opts.channels?.revokeOwner(orgId, userId)
  }

  async createRegistration(input: {
    orgId: OrgId
    createdByUserId: string
    name?: string
    ttlMinutes?: number
    /** A managed computer's own row (§15.1): the token keys it rather than creating a Computer. */
    computerId?: ComputerId
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
      ...(input.computerId ? { computerId: input.computerId } : {}),
      expiresAt: new Date(this.clock.now() + ttl * 60_000)
    })
    this.record(input.orgId, input.createdByUserId, 'registration_create', {
      registrationId: registration.id,
      displayTail: registration.displayTail,
      ...(input.computerId ? { computerId: input.computerId } : {})
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

  /** Null when the Computer was revoked (or removed) before the write landed. */
  async setPolicy(
    orgId: OrgId,
    id: ComputerId,
    policy: ComputerPolicy,
    actorUserId?: string
  ): Promise<ComputerRecord | null> {
    const computer = await this.computers.setPolicy(orgId, id, policy)
    if (!computer) return null
    this.opts.channels?.pushPolicy(id, computer.policy)
    // A failure here is caught up by the screenshot reaper's next sweep.
    await this.opts.screenshots?.applyRetention(id).catch(() => 0)
    // A grant taken away ends the lease it backed; a failure here leaves it to the next heartbeat.
    await this.opts.leases?.current(orgId, id).catch(() => null)
    this.record(orgId, actorUserId, 'policy_update', { computerId: id, agentMode: policy.agentMode })
    return computer
  }

  /** Change which agents may use the Computer (§4.1) from what it is now; null when it was revoked or removed. */
  async setAgentAccess(
    orgId: OrgId,
    id: ComputerId,
    next: (current: ComputerAgentAccess) => ComputerAgentAccess,
    actorUserId?: string
  ): Promise<ComputerRecord | null> {
    const changed = await this.computers.updateAgentAccess(orgId, id, next)
    if (!changed) return null
    const { before, computer } = changed
    const affected = agentsAffectedByAccess(before, computer.agentAccess)
    if (affected === 'all' || affected.length > 0) {
      // Access taken away ends the lease it backed; a failure here leaves it to the next heartbeat.
      await this.opts.leases?.current(orgId, id).catch(() => null)
      this.record(orgId, actorUserId, 'agent_access_update', {
        computerId: id,
        before,
        after: computer.agentAccess
      })
      await this.reship(orgId, affected)
    }
    return computer
  }

  /** The console Stop (§6): ends the lease and holds the desktop paused until `resume`; null when revoked or missing. */
  async stop(orgId: OrgId, id: ComputerId, actorUserId?: string): Promise<ComputerRecord | null> {
    const at = new Date(this.clock.now())
    const computer = await this.computers.setStop(orgId, id, { at, byUserId: actorUserId ?? null })
    if (!computer) return null
    // A failure here leaves the lease to the next read, which ends it on the stop too.
    await this.opts.leases?.preempt(orgId, id, 'paused').catch(() => false)
    this.opts.channels?.pushStop(id, { at: (computer.stoppedAt ?? at).toISOString() })
    this.record(orgId, actorUserId, 'stop', { computerId: id })
    return computer
  }

  /** Lift a console Stop; the desktop resumes only a pause the console caused. */
  async resume(orgId: OrgId, id: ComputerId, actorUserId?: string): Promise<ComputerRecord | null> {
    const computer = await this.computers.setStop(orgId, id, null)
    if (!computer) return null
    this.opts.channels?.pushStop(id, null)
    this.record(orgId, actorUserId, 'resume', { computerId: id })
    return computer
  }

  async revoke(orgId: OrgId, id: ComputerId, actorUserId?: string): Promise<ComputerRecord> {
    const { computer, revokedKeyIds } = await this.computers.revoke(
      orgId,
      id,
      'computer revoked',
      new Date(this.clock.now())
    )
    await this.opts.leases?.preempt(orgId, id, 'revoked').catch(() => false)
    this.opts.channels?.revoke(id, 'revoked')
    this.record(orgId, actorUserId, 'revoke', { computerId: id, revokedKeyIds })
    await this.accessGone(orgId, computer)
    return computer
  }

  async delete(orgId: OrgId, id: ComputerId, actorUserId?: string): Promise<void> {
    const existing = await this.computers.get(orgId, id)
    await this.computers.delete(orgId, id)
    this.opts.channels?.revoke(id, 'deleted')
    this.record(orgId, actorUserId, 'delete', { computerId: id })
    if (existing) await this.accessGone(orgId, existing)
  }

  /** A new Computer's agents get it in their specs at once (§4.1). */
  async accessGranted(orgId: OrgId, computer: Pick<ComputerRecord, 'agentAccess'>): Promise<void> {
    await this.reship(orgId, agentsAffectedByAccess({ mode: 'none', agents: [] }, computer.agentAccess))
  }

  // A revoked or deleted Computer leaves every derived list it was on.
  private async accessGone(orgId: OrgId, computer: Pick<ComputerRecord, 'agentAccess'>): Promise<void> {
    await this.reship(orgId, agentsAffectedByAccess(computer.agentAccess, { mode: 'none', agents: [] }))
  }

  // Best-effort: the write already landed, and the daemons' reconnect roster carries it otherwise.
  private async reship(orgId: OrgId, affected: 'all' | string[]): Promise<void> {
    if (affected !== 'all' && affected.length === 0) return
    await this.opts.onAgentAccessChanged?.(orgId, affected).catch(() => {})
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
