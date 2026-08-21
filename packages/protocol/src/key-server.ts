import { z } from 'zod'

/**
 * `agentconnect.key-server/v1` — the contract for dynamically fetching an
 * AI-provider credential instead of configuring a static key on the daemon.
 *
 * Plain HTTPS request/response — deliberately NOT the daemon↔CP WebSocket, a
 * frame group, or any streaming transport: issuance is a low-frequency,
 * stateless exchange, and a bare REST surface is what lets any deployment
 * implement it without speaking AgentConnect's wire protocol. The daemon is
 * the only caller; implementations range from a plain key vault that rotates
 * real provider keys to a managed LLM egress layer that issues short-lived
 * session-scoped credentials and meters usage on its own data path. The
 * daemon treats the returned key as opaque — it never knows which kind it
 * received. Where the key is sent is deployment topology, configured on the
 * daemon; the issuer supplies the credential alone.
 */

export const KEY_SERVER_PROFILE = 'agentconnect.key-server/v1' as const

// RPC-style POST routes, mirroring the operation names. JSON bodies both ways.
export const KEY_SERVER_ISSUE_KEY_PATH = '/v1/issue-key' as const
export const KEY_SERVER_REVOKE_KEY_PATH = '/v1/revoke-key' as const

// `Authorization: Bearer <token>`, sent only when a token source is configured; with none,
// the request carries no auth header at all. The token is opaque to the daemon.
export const KEY_SERVER_AUTH_HEADER = 'authorization' as const

/** Provider API dialect the credential must speak. */
export const KeyProvider = z.enum(['anthropic', 'openai', 'deepseek'])
export type KeyProvider = z.infer<typeof KeyProvider>

// No `daemonId` field: caller identity belongs to the transport, and a server able to
// verify the bearer derives it there — a body-asserted one would be untrusted input.
export const IssueKeyRequest = z
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
export type IssueKeyRequest = z.infer<typeof IssueKeyRequest>

// Responses parse tolerantly (unknown fields stripped, not rejected), unlike the `.strict()`
// requests: the daemon reads issuers it does not ship with, so a field one adds later must not
// fail every issuance. A base URL is not among the fields it may usefully add — that is
// deployment topology and comes only from the daemon's own configuration.
export const IssueKeyResponse = z
  .object({
    // Opaque handle for RevokeKey and audit; the key value never travels again. It names
    // THIS issuance, not the underlying secret — a server may answer two issuances with one
    // credential, and only it knows whether revoking a keyId may touch other holders.
    keyId: z.string().min(1),
    key: z.string().min(1),
    // Validity as a DURATION from the server's issuance instant, for the same reason the
    // request states one: an absolute instant would be the server's clock, and every reader
    // of it would be a different one. The daemon cannot observe that instant, so it anchors
    // the countdown at its own request-send time — necessarily at or before issuance, hence
    // a deadline no later than the real one. Anchoring at receipt would instead overshoot by
    // the response's flight time. Absent ⇒ long-lived: no refresh loop, ended by RevokeKey
    // or superseded by the re-fetch every new session performs.
    expiresInSeconds: z.number().int().positive().optional(),
    // Renew-from hint on the same scale; meaningless without an expiry, so it needs one.
    refreshInSeconds: z.number().int().positive().optional()
  })
  .refine((r) => r.refreshInSeconds === undefined || r.expiresInSeconds !== undefined, {
    message: 'refreshInSeconds requires expiresInSeconds'
  })
  .refine(
    (r) =>
      r.refreshInSeconds === undefined || r.expiresInSeconds === undefined || r.refreshInSeconds < r.expiresInSeconds,
    { message: 'refreshInSeconds must precede expiresInSeconds' }
  )
export type IssueKeyResponse = z.infer<typeof IssueKeyResponse>

// Idempotent: unknown and already-revoked ids both succeed — the caller wants
// "ensure it is dead", not an existence probe.
export const RevokeKeyRequest = z.object({ keyId: z.string().min(1) }).strict()
export type RevokeKeyRequest = z.infer<typeof RevokeKeyRequest>

// Tolerant like IssueKeyResponse: the daemon wants "it is dead", not a shape check.
export const RevokeKeyResponse = z.object({})
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
 * Returns a violation description, or null for a conforming grant. Both sides
 * are durations, so the check reads no clock and cannot be skewed by one.
 */
export function keyGrantViolation(request: IssueKeyRequest, response: IssueKeyResponse): string | null {
  if (request.ttlSeconds === undefined) return null
  if (response.expiresInSeconds === undefined) return 'bounded request answered with an unbounded key'
  if (response.expiresInSeconds > request.ttlSeconds) return 'granted validity exceeds requested ttlSeconds'
  return null
}
