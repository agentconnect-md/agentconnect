import type { ReviewCheckoutDegradedReason } from '@agentconnect.md/protocol'
import { GitCredUnavailableError } from '../cp/git-credential.js'
import { ShimRequestAbortedError, ShimRequestTimeoutError } from '../shim/channels.js'

/** Sort the error that cost a review its exact checkout into the fixed reason its metric is labelled by. */
export function classifyReviewCheckoutFailure(err: unknown): ReviewCheckoutDegradedReason {
  const seen = new Set<unknown>()
  let next: unknown = err
  while (next instanceof Error && !seen.has(next)) {
    const current: Error = next
    seen.add(current)
    next = current.cause
    const message = current.message
    if (/configuration changed while active/.test(message)) return 'sandbox_conflict'
    if (
      current instanceof ShimRequestAbortedError ||
      current instanceof ShimRequestTimeoutError ||
      current.name === 'AbortError' ||
      /operation was aborted/.test(message)
    )
      return 'fetch_timeout'
    if (current instanceof GitCredUnavailableError || /could not read Username/.test(message))
      return 'credential_unavailable'
    if (/authority is draining/.test(message)) return 'authority_draining'
    if (/ref did not resolve to the requested SHA/.test(message)) return 'revision_mismatch'
  }
  return 'other'
}
