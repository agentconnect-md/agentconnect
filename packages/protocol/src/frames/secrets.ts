import { z } from 'zod'
import { Platform } from './route.js'

/**
 * Secrets (C5 ↔ D10) — protocol §6.
 *
 * Lease-based, no plaintext on the wire or in PG. Every frame carries a
 * REFERENCE to a Vault/KMS path, never the secret material itself.
 */

export const SecretsRequest = z.object({
  // D→C, REQ — daemon asks for a lease at session start
  scope: z.object({
    platform: Platform,
    workspaceId: z.string().uuid()
  })
})
export type SecretsRequest = z.infer<typeof SecretsRequest>

export const SecretsGrant = z.object({
  // C→D, REP (also in RegisterOk.leases[])
  leaseId: z.string().uuid(),
  scope: z.object({
    platform: z.string(),
    workspaceId: z.string().uuid()
  }),
  ref: z.string(), // Vault/KMS path or handle — NOT the secret
  ttl: z.number().int(), // seconds
  renewBeforeSec: z.number().int() // daemon should renew this many sec before expiry
})
export type SecretsGrant = z.infer<typeof SecretsGrant>

export const SecretsRenew = z.object({
  leaseId: z.string().uuid() // D→C REQ → new SecretsGrant
})
export type SecretsRenew = z.infer<typeof SecretsRenew>

export const SecretsRevoke = z.object({
  leaseId: z.string().uuid(),
  reason: z.string() // C→D EVT (hot revoke)
})
export type SecretsRevoke = z.infer<typeof SecretsRevoke>

/** 🅼 Direct-to-store upload/download grant — protocol §3.2 / frame #25. */
export const ScopeAttestation = z.object({
  machineId: z.string().uuid(),
  scope: z.enum(['attachment.put', 'attachment.get', 'facts.put']),
  resourceRef: z.string(), // opaque object key/prefix
  jws: z.string(), // signed capability the store verifies offline
  exp: z.string().datetime()
})
export type ScopeAttestation = z.infer<typeof ScopeAttestation>
