// The account-ownership proof behind a social link, kept for the tab.
//
// Its own module on purpose: `auth.ts` has to drop the proof when a session
// ends, and it already sits BELOW `logto-account.ts` in the import graph — so
// the storage lives here, where both can reach it without a cycle. Nothing is
// imported here, and only the record id is stored; never the code itself.

const OWNERSHIP_PROOF_KEY = 'ac.social-link.proof'

// A verification record may authorize more than one change while it lives, so
// linking a second provider need not ask for a second code. But a reused proof
// must still be valid when the CALLBACK saves the identity, and the provider's
// consent screen sits in between — spending the tail of the window is how
// someone who pauses there gets a 403 instead of a link.
const OWNERSHIP_PROOF_MIN_REMAINING_MS = 5 * 60 * 1000

/**
 * Keep the proof so a second link in the same sitting does not ask again.
 *
 * `expiresAt` is Logto's own, because the record's clock starts when the code
 * is REQUESTED, not when it is redeemed: timing the redemption would credit a
 * slow reader with minutes the record does not have.
 */
export function rememberOwnershipProof(recordId: string, expiresAt: string): void {
  try {
    sessionStorage.setItem(OWNERSHIP_PROOF_KEY, JSON.stringify({ recordId, expiresAt }))
  } catch {
    // Storage is optional here: without it the next link just asks for a code.
  }
}

/** The stored proof, but only while enough of its window is left to survive the
 *  provider round trip. Undefined ⇒ the caller must collect a fresh code. */
export function reusableOwnershipProof(): string | undefined {
  try {
    const value = sessionStorage.getItem(OWNERSHIP_PROOF_KEY)
    if (!value) return undefined
    const proof: unknown = JSON.parse(value)
    if (!proof || typeof proof !== 'object') return undefined
    const { recordId, expiresAt } = proof as { recordId?: unknown; expiresAt?: unknown }
    if (typeof recordId !== 'string' || typeof expiresAt !== 'string') return undefined
    const deadline = Date.parse(expiresAt)
    // An unparseable expiry is not a fresh one: fail closed and ask for a code.
    if (Number.isNaN(deadline)) return undefined
    if (deadline - Date.now() < OWNERSHIP_PROOF_MIN_REMAINING_MS) return undefined
    return recordId
  } catch {
    return undefined
  }
}

/** Drop the proof — it expired, Logto refused it, or the session ended. A proof
 *  outliving its session would send the next user through provider consent with
 *  a record that cannot succeed. */
export function forgetOwnershipProof(): void {
  try {
    sessionStorage.removeItem(OWNERSHIP_PROOF_KEY)
  } catch {
    // Nothing to do; a refused proof is re-collected on the next attempt anyway.
  }
}
