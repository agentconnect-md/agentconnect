/**
 * Pure state machines for the formal-review publication lease
 * (gitlab-com-integration.md §15.1, §15.2).
 *
 * These predicates are the whole of the correctness argument, so they live away
 * from I/O: the repository applies them inside one transaction and the broker
 * applies them again when it maps a verdict onto the wire. Nothing here reads a
 * clock, a database, or a provider.
 */
import {
  codeHostReviewPublicEffect,
  type CodeHostReviewLeasePhase,
  type CodeHostReviewOpKind,
  type CodeHostReviewOpOutcome,
  type CodeHostReviewOpState,
  type CodeHostReviewState
} from '@agentconnect.md/protocol'

/** Counts of one attempt's operation records — the only ledger input a transfer needs. */
export interface CodeHostReviewLedger {
  total: number
  issued: number
  requestStarted: number
  settled: number
  ambiguous: number
  unused: number
  /** Any record that was ever classified ambiguous, even if later identified. */
  everAmbiguous: boolean
}

export const EMPTY_LEDGER: CodeHostReviewLedger = {
  total: 0,
  issued: 0,
  requestStarted: 0,
  settled: 0,
  ambiguous: 0,
  unused: 0,
  everAmbiguous: false
}

/** The four — and only four — conditions §15.1 permits ownership transfer under. */
export type CodeHostReviewTransferCondition =
  'no_mutation_issued' | 'all_returned_unused' | 'deterministic_and_reconciled' | 'ambiguous_identified_and_reconciled'

/** Why a transfer was refused; the row then locks and keeps its old attempt. */
export type CodeHostReviewLockReason = 'records_outstanding' | 'ambiguous_unresolved' | 'effect_unreconciled'

export type CodeHostReviewTransferVerdict =
  { transfer: true; condition: CodeHostReviewTransferCondition } | { transfer: false; lock: CodeHostReviewLockReason }

/**
 * May publication authority move off the current attempt?
 *
 * Elapsed time, a disconnected daemon, and an expired lease are deliberately not
 * inputs: once any record was issued the outbound request is no longer revocable,
 * so only the ledger and a durable reconciliation can answer this. Anything else
 * locks the row indefinitely — there is no timeout and no force unlock.
 */
export function classifyTransfer(ledger: CodeHostReviewLedger, reconciled: boolean): CodeHostReviewTransferVerdict {
  if (ledger.total === 0) return { transfer: true, condition: 'no_mutation_issued' }
  if (ledger.unused === ledger.total) return { transfer: true, condition: 'all_returned_unused' }
  if (ledger.issued > 0 || ledger.requestStarted > 0) return { transfer: false, lock: 'records_outstanding' }
  if (ledger.ambiguous > 0) return { transfer: false, lock: 'ambiguous_unresolved' }
  if (!reconciled) return { transfer: false, lock: 'effect_unreconciled' }
  return {
    transfer: true,
    condition: ledger.everAmbiguous ? 'ambiguous_identified_and_reconciled' : 'deterministic_and_reconciled'
  }
}

/** An attempt is reconciled once its durable outcome positively classified the effect. */
export function outcomeReconciles(state: CodeHostReviewState | null): boolean {
  return state !== null && codeHostReviewPublicEffect(state) !== 'unknown'
}

export type CodeHostReviewAcquisition =
  | { kind: 'fresh' }
  | { kind: 'idempotent' }
  | { kind: 'held' }
  | { kind: 'transfer'; condition: CodeHostReviewTransferCondition }
  | { kind: 'lock'; lock: CodeHostReviewLockReason }
  | { kind: 'already_locked' }

export interface CodeHostReviewLeaseState {
  phase: CodeHostReviewLeasePhase
  attemptId: string | null
  leaseUntil: Date | null
}

/**
 * What one acquisition request may do to the current row. A live lease held by
 * another attempt is ordinary contention (`held`, retryable) and never locks;
 * only an EXPIRED lease reaches the transfer decision.
 */
export function classifyAcquisition(input: {
  current: CodeHostReviewLeaseState | null
  attemptId: string
  nowMs: number
  ledger: CodeHostReviewLedger
  reconciled: boolean
}): CodeHostReviewAcquisition {
  const { current } = input
  if (!current) return { kind: 'fresh' }
  if (current.phase === 'ambiguous_locked') return { kind: 'already_locked' }
  if (current.attemptId === input.attemptId) return { kind: 'idempotent' }
  if (current.phase === 'settled' || current.attemptId === null) return { kind: 'fresh' }
  if (current.leaseUntil !== null && current.leaseUntil.getTime() > input.nowMs) return { kind: 'held' }
  const verdict = classifyTransfer(input.ledger, input.reconciled)
  return verdict.transfer ? { kind: 'transfer', condition: verdict.condition } : { kind: 'lock', lock: verdict.lock }
}

/** The lease phase is CP-derived: an adapter never asserts it. */
export function phaseAfterIssue(
  current: CodeHostReviewLeasePhase,
  kind: CodeHostReviewOpKind
): CodeHostReviewLeasePhase {
  return kind === 'bulk_publish' && current === 'open' ? 'publishing' : current
}

export function phaseAfterSettle(
  current: CodeHostReviewLeasePhase,
  kind: CodeHostReviewOpKind
): CodeHostReviewLeasePhase {
  return kind === 'bulk_publish' && current === 'publishing' ? 'classifying' : current
}

export type CodeHostReviewRelease =
  { kind: 'release' } | { kind: 'lock' } | { kind: 'retain'; reason: CodeHostReviewLockReason }

/**
 * May a reported terminal outcome actually clear ownership?
 *
 * Reporting an outcome is a claim about the effect, not about the ledger: a
 * record still `issued`, `request_started`, or `ambiguous` may yet reach the
 * provider, and a late `bulk_publish` consumes EVERY pending draft the service
 * account owns — exactly the cross-attempt publication the lease exists to
 * prevent. So release runs the SAME transfer classification an acquisition
 * would, and a ledger that could not be transferred to a new attempt cannot be
 * released to one either.
 *
 * `retain` keeps the attempt fail-closed with the outcome already recorded;
 * settling or returning the last outstanding record re-runs this and releases.
 * An attempt with no reported outcome is simply still running — callers do not
 * ask this until one exists.
 */
export function classifyRelease(input: {
  ledger: CodeHostReviewLedger
  state: CodeHostReviewState
}): CodeHostReviewRelease {
  // §15.2: an outcome that proves nothing locks the merge request whatever the ledger says.
  if (!outcomeReconciles(input.state)) return { kind: 'lock' }
  const verdict = classifyTransfer(input.ledger, true)
  return verdict.transfer ? { kind: 'release' } : { kind: 'retain', reason: verdict.lock }
}

/** The phase a lease that is no longer owned must be in — the released/locked split alone. */
export function phaseOfSettledOutcome(state: CodeHostReviewState): CodeHostReviewLeasePhase {
  return outcomeReconciles(state) ? 'settled' : 'ambiguous_locked'
}

export type CodeHostReviewOpRefusal = 'not_issued' | 'already_started' | 'not_started' | 'terminal' | 'outcome_conflict'

export type CodeHostReviewOpTransition =
  { ok: true; next: CodeHostReviewOpState; idempotent: boolean } | { ok: false; reason: CodeHostReviewOpRefusal }

/** The durable facts one operation record carries into a transition. */
export interface CodeHostReviewOpFacts {
  state: CodeHostReviewOpState
  startToken: string | null
  responseStatus: number | null
  responseExternalId: string | null
}

/**
 * `issued` → `request_started`, and nothing else. `startToken` names the ONE
 * intended outbound request, so a retransmitted reply is idempotent while a
 * second, different start is refused — the invariant is one outbound request per
 * record, not one frame per record.
 */
export function startTransition(record: CodeHostReviewOpFacts, startToken: string): CodeHostReviewOpTransition {
  if (record.state === 'issued') return { ok: true, next: 'request_started', idempotent: false }
  if (record.state === 'request_started') {
    return record.startToken === startToken
      ? { ok: true, next: 'request_started', idempotent: true }
      : { ok: false, reason: 'already_started' }
  }
  return { ok: false, reason: 'terminal' }
}

/**
 * Record the deterministic response or `response_ambiguous`. An ambiguous record
 * is not terminal: a later deterministic settle that names the provider object is
 * exactly §15.1's "positively identified by its signed provider marker".
 */
export function settleTransition(
  record: CodeHostReviewOpFacts,
  outcome: CodeHostReviewOpOutcome
): CodeHostReviewOpTransition {
  if (record.state === 'issued') return { ok: false, reason: 'not_started' }
  if (record.state === 'unused') return { ok: false, reason: 'terminal' }
  if (record.state === 'request_started') {
    return { ok: true, next: outcome.kind === 'deterministic' ? 'settled' : 'ambiguous', idempotent: false }
  }
  if (record.state === 'ambiguous') {
    if (outcome.kind === 'ambiguous') return { ok: true, next: 'ambiguous', idempotent: true }
    // Without a named provider object nothing was identified, so nothing is proven.
    if (!outcome.externalId) return { ok: false, reason: 'outcome_conflict' }
    return { ok: true, next: 'settled', idempotent: false }
  }
  if (outcome.kind !== 'deterministic') return { ok: false, reason: 'outcome_conflict' }
  const same = record.responseStatus === outcome.status && record.responseExternalId === (outcome.externalId ?? null)
  return same ? { ok: true, next: 'settled', idempotent: true } : { ok: false, reason: 'outcome_conflict' }
}

/** Durably return a permit no request ever started — §15.1's second transfer condition. */
export function returnUnusedTransition(record: CodeHostReviewOpFacts): CodeHostReviewOpTransition {
  if (record.state === 'issued') return { ok: true, next: 'unused', idempotent: false }
  if (record.state === 'unused') return { ok: true, next: 'unused', idempotent: true }
  return { ok: false, reason: record.state === 'request_started' ? 'already_started' : 'terminal' }
}

const EXTERNAL_REF = /^(note|draft_note|discussion|approval):(?:0|[1-9]\d*)$/

/** Encode one published object for the outcome store: `"<kind>:<numeric id>"`. */
export function encodeExternalRef(kind: string, externalId: string): string {
  const encoded = `${kind}:${externalId}`
  if (!EXTERNAL_REF.test(encoded)) throw new Error('external reference is not a kind and a numeric id')
  return encoded
}

/** Reject anything that is not a kind and a numeric id, so the column cannot hold prose. */
export function isEncodedExternalRef(value: string): boolean {
  return EXTERNAL_REF.test(value)
}
