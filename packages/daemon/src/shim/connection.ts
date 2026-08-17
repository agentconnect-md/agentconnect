import { isAbsolute, normalize } from 'node:path'
import type { Binding } from './binding.js'
import type { ShimFrame } from './protocol.js'

/** Verifies a presented token and reports which pod it was issued to. Satisfied by
 *  the Kubernetes client's TokenReview; injected so tests need no API server. */
export interface PodIdentityVerifier {
  reviewToken(
    token: string,
    audiences: string[]
  ): Promise<{
    authenticated: boolean
    podName?: string
    podUid?: string
    error?: string
  }>
}

/** A bound shim connection the daemon can send requests on. */
export interface ShimConnection {
  binding: Binding
  /** The credential issued to THIS channel, so teardown can revoke exactly it rather than
   *  whatever the pod currently holds — a renewal may already have replaced that. */
  issuedCredential: string
  /** The pod's workspace mount as the shim reported it; absent on legacy shims. Pod-reported
   *  and only ever used to build paths sent back INTO that pod, never on this filesystem. */
  workspaceRoot?: string
  send(frame: ShimFrame): void
  /** Observe inbound frames — how a ShimChannel receives the replies to its requests. */
  onFrame(listener: (text: string) => void): void
  close(reason: string): void
}

export const DEFAULT_CREDENTIAL_TTL_MS = 10 * 60_000

// A verifier's error is an unbounded string from an external system, and it reaches a log. Keep
// the diagnostic but never the credential inside it: a token in a log outlives the request by
// however long the logs are kept, and by then it is somewhere nobody is auditing.
export function withoutToken(message: string, token: string): string {
  return token.length > 0 ? message.split(token).join('[redacted]') : message
}

/** A usable pod workspace root: absolute, normalized, never `/`. Anything else ⇒ unreported. */
export function sanitizeWorkspaceRoot(reported: string | undefined): string | undefined {
  if (!reported || !isAbsolute(reported)) return undefined
  const normalized = normalize(reported).replace(/\/+$/, '')
  return normalized.length > 0 ? normalized : undefined
}
