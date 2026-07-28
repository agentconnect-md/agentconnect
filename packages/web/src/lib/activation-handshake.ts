// The two-phase handshake that lets an activation link redeem ONLY under an
// identity established for that link (waitlist activation, app/activate/[token]).
//
// Why two phases: the page signs the browser's existing session out before
// redeeming, and needs to know, after the round trip, that it may now redeem. A
// single marker written before the sign-out is not proof of anything — the sign-out
// can fail, or another tab can pick the marker up — and consuming it would redeem
// under the residual identity, the exact bug this flow exists to prevent.
//
// So:
//   1. `beginActivation(token)` records an INTENT ("a sign-out for this token is
//      starting"). An intent authorizes nothing; a page that finds only an intent
//      starts the sign-out over.
//   2. `promoteActivationProof()` runs in the OIDC callback, i.e. only after a
//      sign-in actually completed, and turns the intent into PROOF.
//   3. `claimActivationProof(token)` consumes the proof (once) and is the only
//      thing that authorizes a redemption.
//
// `abandonActivation()` drops the intent when the sign-out never happened, so a
// later unrelated sign-in cannot be promoted into proof for this link.

import { clearFlowState, readFlowState, takeFlowState, writeFlowState } from '@/lib/flow-state'

/**
 * Record the intent to re-authenticate for `token`, immediately before starting
 * the sign-out. Returns false when the intent could not be stored at all — the
 * caller must then fail closed rather than redeem under the current session.
 */
export function beginActivation(token: string): boolean {
  // Any proof lying around belongs to an earlier attempt; it must not survive into
  // this one (it would authorize a redemption this sign-out has not earned yet).
  clearFlowState('activate.fresh')
  return writeFlowState('activate.pending', token)
}

/** Forget the intent — the sign-out did not happen, so nothing may be promoted. */
export function abandonActivation(): void {
  clearFlowState('activate.pending')
}

/**
 * Turn a pending intent into proof. Called from the OIDC callback page, so proof
 * exists only when a sign-in has actually completed. No intent ⇒ no-op (an
 * ordinary console sign-in must never mint activation proof).
 */
export function promoteActivationProof(): void {
  const pending = takeFlowState('activate.pending')
  if (pending) writeFlowState('activate.fresh', pending)
}

/**
 * Consume the proof for `token`. True only when a sign-in completed for THIS
 * link — the sole authorization to redeem. Always consumes the proof, so a stale
 * or mismatched one cannot be replayed by a later visit.
 */
export function claimActivationProof(token: string): boolean {
  return takeFlowState('activate.fresh') === token
}

/** Is an activation round trip in flight (intent recorded, not yet promoted)? */
export function activationPending(): boolean {
  return readFlowState('activate.pending') !== null
}
