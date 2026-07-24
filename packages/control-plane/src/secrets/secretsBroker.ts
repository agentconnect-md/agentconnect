/**
 * `SecretsBrokerService` — implements the C5 `SecretsBroker` port (design §2.3,
 * §2.4; protocol §6).
 *
 * A lease broker ONLY. On `secrets/request` it asks the {@link SecretsProvider}
 * to provision a lease (which returns a Vault/KMS **ref** + ttl — NEVER plaintext),
 * persists the lease metadata via {@link SecretLeaseRepo} (ref + ttl + expiry, no
 * secret material), and returns the {@link SecretsGrant} the WS edge replies with.
 * Renew advances the persisted expiry; revoke flips the row to `revoked` and tells
 * the provider to drop the underlying lease.
 *
 * Transport-free and Prisma-free: depends only on the provider port, the lease
 * repository port, and a `Clock`. The plaintext-never invariant is structural —
 * this service is never handed a secret, only a ref.
 */
import { randomUUID } from 'node:crypto'
import type { SecretsRequest, SecretsGrant } from '@agentconnect.md/protocol'
import type { SecretsBroker } from '../ports.js'
import type { SecretLeaseRepo } from '../persistence/ports.js'
import type { SecretsProvider } from './providers/provider.js'
import type { Clock } from '../domain/clock.js'
import { LeaseId, type DaemonId } from '../domain/ids.js'

export class SecretsBrokerService implements SecretsBroker {
  constructor(
    private readonly provider: SecretsProvider,
    private readonly leases: SecretLeaseRepo,
    private readonly clock: Clock
  ) {}

  async request(daemonId: DaemonId, req: SecretsRequest): Promise<SecretsGrant> {
    const leaseId = LeaseId(randomUUID())
    const provisioned = await this.provider.provision(daemonId, leaseId, req.scope)
    const now = new Date(this.clock.now())
    const expiresAt = new Date(now.getTime() + provisioned.ttlSec * 1000)

    const lease = await this.leases.create({
      leaseId,
      daemonId,
      scope: req.scope,
      ref: provisioned.ref, // a ref — NEVER the secret
      ttlSec: provisioned.ttlSec,
      renewBeforeSec: provisioned.renewBeforeSec,
      issuedAt: now,
      expiresAt
    })

    return this.toGrant(
      lease.id,
      req.scope.platform,
      lease.scopeWorkspaceId,
      provisioned.ref,
      provisioned.ttlSec,
      provisioned.renewBeforeSec
    )
  }

  async renew(_daemonId: DaemonId, leaseId: LeaseId): Promise<SecretsGrant> {
    const provisioned = await this.provider.renew(leaseId)
    const now = new Date(this.clock.now())
    const expiresAt = new Date(now.getTime() + provisioned.ttlSec * 1000)
    const lease = await this.leases.renew(leaseId, expiresAt, now)

    return this.toGrant(
      lease.id,
      lease.scopePlatform,
      lease.scopeWorkspaceId,
      provisioned.ref,
      provisioned.ttlSec,
      provisioned.renewBeforeSec
    )
  }

  async revoke(leaseId: LeaseId, reason: string): Promise<void> {
    await this.provider.revoke(leaseId, reason)
    await this.leases.revoke(leaseId, reason)
  }

  private toGrant(
    leaseId: string,
    platform: string,
    workspaceId: string,
    ref: string,
    ttl: number,
    renewBeforeSec: number
  ): SecretsGrant {
    return {
      leaseId,
      scope: { platform, workspaceId },
      ref,
      ttl,
      renewBeforeSec
    }
  }
}
