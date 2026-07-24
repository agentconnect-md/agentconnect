/**
 * `MemorySecretsProvider` (design §2.1 `secrets/providers/memory.ts`, §5.4) — the
 * in-memory `SecretsProvider` for dev and tests.
 *
 * Returns deterministic Vault/KMS-style **refs**, NEVER plaintext (a test asserts
 * no secret material ever appears in any persisted row or emitted frame). The ref
 * is a stable `memory://lease/<leaseId>` handle; `provision`/`renew` only ever
 * hand back that ref + a configurable ttl.
 *
 * This is the `SECRETS_PROVIDER=memory` default the composition root selects via
 * {@link makeSecretsProvider} when no real Vault/KMS is configured.
 */
import type { SecretsRequest } from '@agentconnect.md/protocol'
import type { DaemonId } from '../../domain/ids.js'
import type { ProvisionedLease, ScopeAttestationInput, SecretsProvider } from './provider.js'

export interface MemoryProviderOpts {
  /** Default lease lifetime (seconds). */
  ttlSec?: number
  /** Default renew-before window (seconds). */
  renewBeforeSec?: number
}

export class MemorySecretsProvider implements SecretsProvider {
  private readonly ttlSec: number
  private readonly renewBeforeSec: number
  /** Leases this provider has handed out (ref by leaseId) — for renew/revoke. */
  private readonly leases = new Map<string, ProvisionedLease>()

  constructor(opts: MemoryProviderOpts = {}) {
    this.ttlSec = opts.ttlSec ?? 900
    this.renewBeforeSec = opts.renewBeforeSec ?? 60
  }

  provision(_daemonId: DaemonId, leaseId: string, _scope: SecretsRequest['scope']): Promise<ProvisionedLease> {
    const lease: ProvisionedLease = {
      ref: `memory://lease/${leaseId}`, // a ref, NEVER the secret
      ttlSec: this.ttlSec,
      renewBeforeSec: this.renewBeforeSec
    }
    this.leases.set(leaseId, lease)
    return Promise.resolve(lease)
  }

  renew(leaseId: string): Promise<ProvisionedLease> {
    // The ref is stable across renew; only the persisted expiry advances.
    const lease = this.leases.get(leaseId) ?? {
      ref: `memory://lease/${leaseId}`,
      ttlSec: this.ttlSec,
      renewBeforeSec: this.renewBeforeSec
    }
    this.leases.set(leaseId, lease)
    return Promise.resolve(lease)
  }

  revoke(leaseId: string, _reason: string): Promise<void> {
    this.leases.delete(leaseId)
    return Promise.resolve()
  }

  signScopeAttestation(_input: ScopeAttestationInput): Promise<{ jws: string; exp: string }> {
    // 🅼 Machine-identity attestation is scaffolded but not implemented (§5.6a).
    return Promise.reject(new Error('NOT_IMPLEMENTED'))
  }
}

/** Select the provider for a config (`memory` now; `vault` is additive later). */
export function makeSecretsProvider(
  config: { SECRETS_PROVIDER: 'memory' | 'vault' },
  opts: MemoryProviderOpts = {}
): SecretsProvider {
  // Only the in-memory provider exists at MVP; `vault` falls back to it until a
  // real Vault/KMS client lands (adopting it is additive — same port).
  void config.SECRETS_PROVIDER
  return new MemorySecretsProvider(opts)
}
