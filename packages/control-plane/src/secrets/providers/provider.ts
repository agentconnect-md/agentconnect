/**
 * `SecretsProvider` port (design §2.1 `secrets/providers/provider.ts`, §5.6) —
 * the Vault/KMS abstraction the C5 lease broker sits on top of.
 *
 * The provider is the ONLY thing that ever sees secret material, and even then it
 * returns a *reference* (a Vault/KMS path/handle), NEVER the plaintext: the broker
 * stores the ref + TTL in C6, the daemon resolves it directly against the store
 * out-of-band. This keeps the body-locality / no-plaintext invariant (§3.10)
 * structural — nothing above this port can leak a secret because nothing above it
 * is ever handed one.
 *
 * Machine-identity attestation (`signScopeAttestation`, 🅼) is scaffolded but
 * stubbed: it throws `NOT_IMPLEMENTED` until that decision lands (§5.6a); adopting
 * it is additive.
 */
import type { SecretsRequest } from '@agentconnect.md/protocol'
import type { DaemonId } from '../../domain/ids.js'

/** The lease material a provider mints for a scope: an opaque ref + a TTL. */
export interface ProvisionedLease {
  /** Opaque Vault/KMS path or handle — NOT the secret itself. */
  ref: string
  /** Lease lifetime in seconds. */
  ttlSec: number
  /** How many seconds before expiry the daemon should renew (advisory). */
  renewBeforeSec: number
}

/** An attested capability the object store can verify offline (🅼, §3.2). */
export interface ScopeAttestationInput {
  daemonId: DaemonId
  machineId: string
  scope: 'attachment.put' | 'attachment.get' | 'facts.put'
  resourceRef: string
}

export interface SecretsProvider {
  /**
   * Provision a lease for a daemon's scope. Returns a REFERENCE (+ ttl), never
   * plaintext. `leaseId` is supplied by the broker so the ref can be tied to the
   * persisted lease row.
   */
  provision(daemonId: DaemonId, leaseId: string, scope: SecretsRequest['scope']): Promise<ProvisionedLease>
  /** Renew an existing lease, returning the (possibly unchanged) ref + a fresh ttl. */
  renew(leaseId: string): Promise<ProvisionedLease>
  /** Revoke the underlying lease at the store. Best-effort; idempotent. */
  revoke(leaseId: string, reason: string): Promise<void>
  /**
   * 🅼 Sign a scope attestation the object store verifies offline. STUBBED until
   * the machine-identity decision lands — throws `NOT_IMPLEMENTED` (§5.6a).
   */
  signScopeAttestation(input: ScopeAttestationInput): Promise<{ jws: string; exp: string }>
}
