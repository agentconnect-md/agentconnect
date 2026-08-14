import { z } from 'zod'

/**
 * `agentconnect.key-server/v1` — the contract for dynamically fetching an
 * AI-provider credential instead of configuring a static key on the daemon.
 *
 * This is deliberately NOT a daemon↔CP frame group. The daemon is the only
 * caller; any deployment-provided service can implement it: a plain key
 * vault that rotates real provider keys, or a managed LLM egress layer that
 * issues short-lived session-scoped credentials and meters usage on its own
 * data path. The daemon treats the returned pair as opaque — it never knows
 * which kind it received.
 */

export const KEY_SERVER_PROFILE = 'agentconnect.key-server/v1' as const

// RPC-style routes, mirroring the operation names.
export const KEY_SERVER_GET_KEY_PATH = '/v1/get-key' as const
export const KEY_SERVER_REVOKE_KEY_PATH = '/v1/revoke-key' as const

/** Provider API dialect the credential must speak; selects the (key, baseUrl) pair. */
export const KeyProvider = z.enum(['anthropic', 'openai'])
export type KeyProvider = z.infer<typeof KeyProvider>

// Caller identity (which daemon) comes from transport auth, never from the body:
// the daemon authenticates with the same credential it presents to its CP (org
// API key, or the projected ServiceAccount token for in-cluster daemons), and
// the server cross-checks `orgId` against that identity.
export const GetKeyRequest = z
  .object({
    orgId: z.string().min(1),
    agentId: z.string().min(1),
    sessionId: z.string().min(1),
    provider: KeyProvider,
    // Desired validity, relative to avoid clock skew. Absent ⇒ the caller asks
    // for a long-lived key it will manage via RevokeKey.
    ttlSeconds: z.number().int().positive().optional()
  })
  .strict()
export type GetKeyRequest = z.infer<typeof GetKeyRequest>

export const GetKeyResponse = z
  .object({
    // Opaque handle for RevokeKey and audit; the key value never travels again.
    keyId: z.string().min(1),
    key: z.string().min(1),
    // Atomic with `key` — inject both or neither. Absent ⇒ the daemon falls
    // through to its next base-URL layer (static config, then runtime default).
    baseUrl: z.string().url().optional(),
    // Absent ⇒ long-lived: no refresh loop, revoked explicitly or superseded
    // by the re-fetch every new session performs.
    expiresAt: z.string().datetime().optional(),
    // Renew-from hint; meaningless without an expiry, so it requires one.
    refreshAfter: z.string().datetime().optional()
  })
  .strict()
  .refine((r) => r.refreshAfter === undefined || r.expiresAt !== undefined, {
    message: 'refreshAfter requires expiresAt'
  })
  .refine((r) => r.refreshAfter === undefined || r.expiresAt === undefined || r.refreshAfter < r.expiresAt, {
    message: 'refreshAfter must precede expiresAt'
  })
export type GetKeyResponse = z.infer<typeof GetKeyResponse>

// Idempotent: unknown and already-revoked ids both succeed — the caller wants
// "ensure it is dead", not an existence probe.
export const RevokeKeyRequest = z.object({ keyId: z.string().min(1) }).strict()
export type RevokeKeyRequest = z.infer<typeof RevokeKeyRequest>

export const RevokeKeyResponse = z.object({}).strict()
export type RevokeKeyResponse = z.infer<typeof RevokeKeyResponse>

/** Machine-readable denial reasons the daemon surfaces as attributable errors, never as internal faults. */
export const KeyServerErrorCode = z.enum(['org_suspended', 'quota_denied', 'unauthorized', 'unavailable'])
export type KeyServerErrorCode = z.infer<typeof KeyServerErrorCode>

export const KeyServerErrorBody = z
  .object({
    error: z.object({ code: KeyServerErrorCode, message: z.string().optional() }).strict()
  })
  .strict()
export type KeyServerErrorBody = z.infer<typeof KeyServerErrorBody>

/**
 * The narrowing rule, executable: a server may shorten a requested validity but
 * never extend it, and may go unbounded only when the caller asked for that.
 * Returns a violation description, or null for a conforming grant. `issuedAt`
 * is the caller's clock at request time — expiry math stays caller-relative.
 */
export function keyGrantViolation(request: GetKeyRequest, response: GetKeyResponse, issuedAt: Date): string | null {
  if (request.ttlSeconds === undefined) return null
  if (response.expiresAt === undefined) return 'bounded request answered with an unbounded key'
  const grantedMs = Date.parse(response.expiresAt) - issuedAt.getTime()
  if (grantedMs > request.ttlSeconds * 1000) return 'granted validity exceeds requested ttlSeconds'
  return null
}
