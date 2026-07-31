/**
 * `ProtocolError` ↔ `ErrorFrame` mapping (design §2.1 `domain/errors.ts`,
 * protocol §9).
 *
 * A `ProtocolError` is the transport-free representation of a typed wire error.
 * Services and the connection FSM throw/raise it; the WS edge serializes it into
 * an `ErrorFrame` REP (`corr` = the offending request `id`). This keeps the
 * brain (C3/C4) from importing the wire schema while still speaking the same
 * `ErrorCode` vocabulary.
 *
 * `domain/` imports only the protocol contract (types + the `ErrorCode` enum),
 * never a transport library or Prisma.
 */
import { ErrorCode, type ErrorFrame } from '@agentconnect.md/protocol'

/** Whether a given error code is retryable by default (protocol §9). */
const RETRYABLE_DEFAULT: Record<ErrorCodeValue, boolean> = {
  UNKNOWN_FRAME: false,
  FRAME_TOO_LARGE: false,
  PROTOCOL_STATE: false,
  BAD_PAYLOAD: false,
  AUTH_FAILED: false,
  ATTESTATION_INVALID: false,
  STALE_EPOCH: true,
  STALE_LAUNCH: true,
  NO_SESSION: false,
  SCOPE_DENIED: false,
  DELEGATION_DENIED: false,
  INVOCATION_CONFLICT: false,
  LEASE_EXPIRED: true,
  LEASE_DENIED: false,
  RATE_LIMITED: true,
  CONFLICT: false,
  INTERNAL: true
}

export type ErrorCodeValue = (typeof ErrorCode)['options'][number]

/**
 * A typed, actionable error that maps 1:1 onto an `ErrorFrame`. Thrown by
 * services / the FSM and translated to a REP at the edge via {@link toFrame}.
 */
export class ProtocolError extends Error {
  readonly code: ErrorCodeValue
  readonly retryable: boolean
  readonly details?: Record<string, unknown>

  constructor(
    code: ErrorCodeValue,
    message: string,
    opts: { retryable?: boolean; details?: Record<string, unknown> } = {}
  ) {
    super(message)
    this.name = 'ProtocolError'
    this.code = code
    this.retryable = opts.retryable ?? RETRYABLE_DEFAULT[code]
    if (opts.details) this.details = opts.details
  }

  /** Serialize to the `error` frame payload (protocol §9). */
  toFrame(): ErrorFrame {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {})
    }
  }

  /** Build a `ProtocolError` from a decoded `error` frame payload. */
  static fromFrame(f: ErrorFrame): ProtocolError {
    return new ProtocolError(f.code, f.message, {
      retryable: f.retryable,
      ...(f.details ? { details: f.details } : {})
    })
  }
}

/** Convenience constructor for the PROTOCOL_STATE gate (protocol §2.1). */
export function protocolStateError(frameType: string, state: string): ProtocolError {
  return new ProtocolError('PROTOCOL_STATE', `${frameType} illegal in ${state}`, { retryable: false })
}
