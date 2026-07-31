import { z } from 'zod'

/**
 * Error model — protocol §9.
 *
 * Every REQ can be answered by an `error` REP (`corr` = request `id`). Errors
 * are typed and actionable, not free text.
 */

export const ErrorCode = z.enum([
  // protocol / framing
  'UNKNOWN_FRAME',
  'FRAME_TOO_LARGE',
  'PROTOCOL_STATE',
  'BAD_PAYLOAD',
  // auth / identity
  'AUTH_FAILED',
  'ATTESTATION_INVALID',
  // fencing / ordering
  'STALE_EPOCH',
  'STALE_LAUNCH',
  // delivery
  'NO_SESSION',
  'SCOPE_DENIED',
  // delegated MCP authority / invocation binding
  'DELEGATION_DENIED',
  'INVOCATION_CONFLICT',
  // secrets
  'LEASE_EXPIRED',
  'LEASE_DENIED',
  // generic
  'RATE_LIMITED',
  'CONFLICT',
  'INTERNAL'
])
export type ErrorCode = z.infer<typeof ErrorCode>

export const ErrorFrame = z.object({
  code: ErrorCode,
  message: z.string(), // human-readable, redacted of secrets
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional()
})
export type ErrorFrame = z.infer<typeof ErrorFrame>

/**
 * WebSocket close codes — protocol §9.
 *
 * `4401` requires a fresh credential before reconnecting; everything else uses
 * exponential backoff with jitter.
 */
export const CloseCode = {
  BAD_SUBPROTOCOL: 4400, // bad subprotocol/handshake
  AUTH_FAILED: 4401, // auth failed (don't auto-retry)
  EPOCH_CONFLICT: 4409, // epoch conflict on handshake (do full reconcile)
  UNSUPPORTED_ENCODING: 4415, // binary/unsupported encoding
  RATE_LIMITED: 4429, // rate-limited (backoff)
  SERVER_INTERNAL: 1011, // server internal
  SERVER_RESTARTING: 1012, // server restarting (reconnect with backoff)
  /** soft 256 KiB cap exceeded → ws library close (protocol §1). */
  MESSAGE_TOO_BIG: 1009
} as const
export type CloseCode = (typeof CloseCode)[keyof typeof CloseCode]
