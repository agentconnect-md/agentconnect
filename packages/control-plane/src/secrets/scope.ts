/**
 * `SecretScope` — which key a persisted secret value is sealed under
 * (docs/designs/per-org-secret-encryption.md §2, §4).
 *
 * The scope is passed EXPLICITLY to every `seal`/`open` call and is never
 * encoded in the stored value. That direction is the whole point: the stored
 * string comes out of Postgres, which is exactly the surface we assume may be
 * read across tenants, so it must not be the thing that selects a decryption
 * key. A caller states which tenant it believes a value belongs to, and a
 * mismatch fails at Vault instead of decrypting silently.
 *
 * Leaf module on purpose — both the cipher and `config/env.ts` need the key-name
 * rules, and neither should drag the other in.
 */
import type { OrgId } from '../domain/ids.js'

export type SecretScope = { kind: 'deployment' } | { kind: 'org'; orgId: OrgId }

/** Deployment-owned material (the deployment config document's secrets). */
export const DEPLOYMENT_SCOPE: SecretScope = { kind: 'deployment' }

/** Org-owned material — everything a tenant would expect deleted with its org. */
export const orgScope = (orgId: OrgId): SecretScope => ({ kind: 'org', orgId })

/**
 * Envelope marker for values sealed under a SCOPED key. It carries a format
 * version and nothing else — deliberately not the tenant id (see above). Its
 * one job is to let `open` tell a scoped value apart from a pre-scoping one, so
 * the rollout needs no backfill.
 */
export const SECRET_ENVELOPE_PREFIX = 'acv1:'

/**
 * Org key names default to `<deployment key>-org-`, so they inherit whatever
 * namespace the deployment key already occupies. Deployments commonly share one
 * transit mount and rely on key naming alone to stay separated; a fixed prefix
 * would collide their org keys, a derived one cannot.
 */
export function effectiveOrgKeyPrefix(transitKey: string, configured?: string | undefined): string {
  return configured ?? `${transitKey}-org-`
}

/**
 * The deployment key must sit OUTSIDE the org namespace: a name inside it would
 * be a shreddable name, and shredding it destroys the deployment's whole trust
 * root. Returns the reason it is unsafe, or null when the pair is fine.
 */
export function orgKeyPrefixConflict(transitKey: string, orgKeyPrefix: string): string | null {
  if (orgKeyPrefix.length === 0) return 'the org transit key prefix must not be empty'
  if (transitKey.startsWith(orgKeyPrefix)) {
    return 'VAULT_TRANSIT_KEY must not start with the org transit key prefix — a deployment key inside the org namespace is a shreddable name'
  }
  return null
}
