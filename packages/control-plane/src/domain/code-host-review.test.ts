import { describe, expect, it } from 'vitest'
import {
  EMPTY_LEDGER,
  classifyAcquisition,
  classifyTransfer,
  encodeExternalRef,
  isEncodedExternalRef,
  outcomeReconciles,
  phaseAfterIssue,
  classifyRelease,
  phaseAfterSettle,
  phaseOfSettledOutcome,
  returnUnusedTransition,
  settleTransition,
  startTransition,
  type CodeHostReviewLedger,
  type CodeHostReviewOpFacts
} from './code-host-review.js'

const ATTEMPT = 'attempt-a'
const OTHER = 'attempt-b'
const TOKEN = 'start-token-1'

function ledger(over: Partial<CodeHostReviewLedger>): CodeHostReviewLedger {
  return { ...EMPTY_LEDGER, ...over }
}

function record(over: Partial<CodeHostReviewOpFacts>): CodeHostReviewOpFacts {
  return { state: 'issued', startToken: null, responseStatus: null, responseExternalId: null, ...over }
}

describe('publication-lease transfer rules (gitlab-com-integration.md §15.1)', () => {
  it('accepts exactly the four listed conditions', () => {
    expect(classifyTransfer(ledger({}), false)).toEqual({ transfer: true, condition: 'no_mutation_issued' })
    expect(classifyTransfer(ledger({ total: 3, unused: 3 }), false)).toEqual({
      transfer: true,
      condition: 'all_returned_unused'
    })
    expect(classifyTransfer(ledger({ total: 2, settled: 2 }), true)).toEqual({
      transfer: true,
      condition: 'deterministic_and_reconciled'
    })
    expect(classifyTransfer(ledger({ total: 2, settled: 2, everAmbiguous: true }), true)).toEqual({
      transfer: true,
      condition: 'ambiguous_identified_and_reconciled'
    })
  })

  it('refuses every other ledger and locks the row instead', () => {
    // A permit that was handed out but never accounted for: the request may be in flight.
    expect(classifyTransfer(ledger({ total: 1, issued: 1 }), true)).toEqual({
      transfer: false,
      lock: 'records_outstanding'
    })
    expect(classifyTransfer(ledger({ total: 1, requestStarted: 1 }), true)).toEqual({
      transfer: false,
      lock: 'records_outstanding'
    })
    // A partially returned set is not "every issued record returned unused".
    expect(classifyTransfer(ledger({ total: 2, unused: 1, issued: 1 }), true)).toEqual({
      transfer: false,
      lock: 'records_outstanding'
    })
    expect(classifyTransfer(ledger({ total: 1, ambiguous: 1 }), true)).toEqual({
      transfer: false,
      lock: 'ambiguous_unresolved'
    })
    // Deterministic responses alone are not enough: the effect must be reconciled.
    expect(classifyTransfer(ledger({ total: 1, settled: 1 }), false)).toEqual({
      transfer: false,
      lock: 'effect_unreconciled'
    })
  })

  it('treats an unclassified or unknown outcome as no reconciliation', () => {
    expect(outcomeReconciles(null)).toBe(false)
    expect(outcomeReconciles('ambiguous_locked')).toBe(false)
    expect(outcomeReconciles('review_reconciliation_required')).toBe(false)
    expect(outcomeReconciles('submitted')).toBe(true)
    expect(outcomeReconciles('not_submitted')).toBe(true)
    expect(outcomeReconciles('requested_changes_state_ambiguous')).toBe(true)
  })
})

describe('lease acquisition', () => {
  const base = { attemptId: ATTEMPT, nowMs: 1_000, ledger: EMPTY_LEDGER, reconciled: false }

  it('acquires a subject nothing owns', () => {
    expect(classifyAcquisition({ ...base, current: null })).toEqual({ kind: 'fresh' })
    expect(classifyAcquisition({ ...base, current: { phase: 'settled', attemptId: null, leaseUntil: null } })).toEqual({
      kind: 'fresh'
    })
  })

  it('re-answers the same attempt instead of minting a second fence', () => {
    expect(
      classifyAcquisition({
        ...base,
        current: { phase: 'publishing', attemptId: ATTEMPT, leaseUntil: new Date(500) }
      })
    ).toEqual({ kind: 'idempotent' })
  })

  it('makes a live lease ordinary contention, never a lock', () => {
    expect(
      classifyAcquisition({
        ...base,
        ledger: ledger({ total: 1, requestStarted: 1 }),
        current: { phase: 'publishing', attemptId: OTHER, leaseUntil: new Date(60_000) }
      })
    ).toEqual({ kind: 'held' })
  })

  it('an expired lease transfers only under a listed condition, and otherwise locks', () => {
    const expired = { phase: 'open' as const, attemptId: OTHER, leaseUntil: new Date(10) }
    expect(classifyAcquisition({ ...base, current: expired })).toEqual({
      kind: 'transfer',
      condition: 'no_mutation_issued'
    })
    expect(classifyAcquisition({ ...base, current: expired, ledger: ledger({ total: 1, requestStarted: 1 }) })).toEqual(
      { kind: 'lock', lock: 'records_outstanding' }
    )
  })

  it('never escapes ambiguous_locked, however long it has been locked', () => {
    for (const nowMs of [1_000, 10 ** 12, Number.MAX_SAFE_INTEGER]) {
      expect(
        classifyAcquisition({
          ...base,
          nowMs,
          current: { phase: 'ambiguous_locked', attemptId: OTHER, leaseUntil: null }
        })
      ).toEqual({ kind: 'already_locked' })
    }
  })
})

describe('operation-record state machine', () => {
  it('permits exactly one outbound request per record', () => {
    expect(startTransition(record({}), TOKEN)).toEqual({ ok: true, next: 'request_started', idempotent: false })
    // The SAME intended request retransmitted after a lost reply is idempotent…
    expect(startTransition(record({ state: 'request_started', startToken: TOKEN }), TOKEN)).toEqual({
      ok: true,
      next: 'request_started',
      idempotent: true
    })
    // …while a second, different one is refused outright.
    expect(startTransition(record({ state: 'request_started', startToken: TOKEN }), 'start-token-2')).toEqual({
      ok: false,
      reason: 'already_started'
    })
    for (const state of ['settled', 'ambiguous', 'unused'] as const) {
      expect(startTransition(record({ state }), TOKEN)).toEqual({ ok: false, reason: 'terminal' })
    }
  })

  it('settles a started record and lets a later marker identify an ambiguous one', () => {
    const started = record({ state: 'request_started', startToken: TOKEN })
    expect(settleTransition(started, { kind: 'deterministic', status: 201, externalId: '99' })).toEqual({
      ok: true,
      next: 'settled',
      idempotent: false
    })
    expect(settleTransition(started, { kind: 'ambiguous', code: 'response_ambiguous' })).toEqual({
      ok: true,
      next: 'ambiguous',
      idempotent: false
    })
    const ambiguous = record({ state: 'ambiguous' })
    expect(settleTransition(ambiguous, { kind: 'deterministic', status: 200, externalId: '99' })).toEqual({
      ok: true,
      next: 'settled',
      idempotent: false
    })
    // No named provider object identifies nothing, so nothing is proven.
    expect(settleTransition(ambiguous, { kind: 'deterministic', status: 200 })).toEqual({
      ok: false,
      reason: 'outcome_conflict'
    })
    expect(settleTransition(ambiguous, { kind: 'ambiguous', code: 'response_ambiguous' })).toEqual({
      ok: true,
      next: 'ambiguous',
      idempotent: true
    })
  })

  it('refuses a settle that was never started and a second, different result', () => {
    expect(settleTransition(record({}), { kind: 'deterministic', status: 201 })).toEqual({
      ok: false,
      reason: 'not_started'
    })
    expect(settleTransition(record({ state: 'unused' }), { kind: 'deterministic', status: 201 })).toEqual({
      ok: false,
      reason: 'terminal'
    })
    const settled = record({ state: 'settled', responseStatus: 201, responseExternalId: '99' })
    expect(settleTransition(settled, { kind: 'deterministic', status: 201, externalId: '99' })).toEqual({
      ok: true,
      next: 'settled',
      idempotent: true
    })
    expect(settleTransition(settled, { kind: 'deterministic', status: 201, externalId: '100' })).toEqual({
      ok: false,
      reason: 'outcome_conflict'
    })
  })

  it('returns only a permit no request ever started', () => {
    expect(returnUnusedTransition(record({}))).toEqual({ ok: true, next: 'unused', idempotent: false })
    expect(returnUnusedTransition(record({ state: 'unused' }))).toEqual({
      ok: true,
      next: 'unused',
      idempotent: true
    })
    expect(returnUnusedTransition(record({ state: 'request_started' }))).toEqual({
      ok: false,
      reason: 'already_started'
    })
    expect(returnUnusedTransition(record({ state: 'ambiguous' }))).toEqual({ ok: false, reason: 'terminal' })
  })
})

describe('lease phase', () => {
  it('advances only on the publication operation', () => {
    expect(phaseAfterIssue('open', 'draft_create')).toBe('open')
    expect(phaseAfterIssue('open', 'bulk_publish')).toBe('publishing')
    expect(phaseAfterSettle('publishing', 'draft_create')).toBe('publishing')
    expect(phaseAfterSettle('publishing', 'bulk_publish')).toBe('classifying')
    expect(phaseAfterSettle('classifying', 'approval')).toBe('classifying')
  })

  it('names the phase of a lease nobody owns any more', () => {
    expect(phaseOfSettledOutcome('submitted')).toBe('settled')
    expect(phaseOfSettledOutcome('not_submitted')).toBe('settled')
    expect(phaseOfSettledOutcome('ambiguous_locked')).toBe('ambiguous_locked')
    expect(phaseOfSettledOutcome('review_reconciliation_required')).toBe('ambiguous_locked')
  })
})

describe('release classification (§15.1: reporting an outcome is not releasing the lease)', () => {
  it('releases a classified outcome only when the ledger has nothing outstanding', () => {
    expect(classifyRelease({ ledger: ledger({}), state: 'submitted' })).toEqual({ kind: 'release' })
    expect(classifyRelease({ ledger: ledger({ total: 2, unused: 2 }), state: 'not_submitted' })).toEqual({
      kind: 'release'
    })
    expect(classifyRelease({ ledger: ledger({ total: 2, settled: 2 }), state: 'submitted' })).toEqual({
      kind: 'release'
    })
    expect(
      classifyRelease({ ledger: ledger({ total: 1, settled: 1, everAmbiguous: true }), state: 'submitted' })
    ).toEqual({ kind: 'release' })
  })

  it('retains ownership while any record could still reach the provider', () => {
    // The blocker: a late bulk_publish consumes every pending draft of the service account.
    expect(classifyRelease({ ledger: ledger({ total: 1, requestStarted: 1 }), state: 'submitted' })).toEqual({
      kind: 'retain',
      reason: 'records_outstanding'
    })
    expect(classifyRelease({ ledger: ledger({ total: 1, issued: 1 }), state: 'submitted' })).toEqual({
      kind: 'retain',
      reason: 'records_outstanding'
    })
    expect(
      classifyRelease({ ledger: ledger({ total: 2, settled: 1, issued: 1 }), state: 'approval_not_recorded' })
    ).toEqual({ kind: 'retain', reason: 'records_outstanding' })
    expect(classifyRelease({ ledger: ledger({ total: 1, ambiguous: 1 }), state: 'submitted' })).toEqual({
      kind: 'retain',
      reason: 'ambiguous_unresolved'
    })
  })

  it('locks on an outcome that proves nothing, whatever the ledger says', () => {
    for (const state of ['ambiguous_locked', 'review_reconciliation_required'] as const) {
      expect(classifyRelease({ ledger: ledger({}), state })).toEqual({ kind: 'lock' })
      expect(classifyRelease({ ledger: ledger({ total: 2, settled: 2 }), state })).toEqual({ kind: 'lock' })
    }
  })

  it('answers exactly what a transfer would, so release and takeover cannot drift', () => {
    const ledgers = [
      ledger({}),
      ledger({ total: 2, unused: 2 }),
      ledger({ total: 2, settled: 2 }),
      ledger({ total: 1, issued: 1 }),
      ledger({ total: 1, requestStarted: 1 }),
      ledger({ total: 1, ambiguous: 1 }),
      ledger({ total: 3, settled: 2, unused: 1, everAmbiguous: true })
    ]
    for (const l of ledgers) {
      const transfer = classifyTransfer(l, true)
      const release = classifyRelease({ ledger: l, state: 'submitted' })
      expect(release.kind === 'release').toBe(transfer.transfer)
    }
  })
})

describe('external reference encoding', () => {
  it('accepts a kind and a numeric id only', () => {
    expect(encodeExternalRef('note', '778899')).toBe('note:778899')
    expect(isEncodedExternalRef('draft_note:0')).toBe(true)
    expect(isEncodedExternalRef('approval:12')).toBe(true)
  })

  it('refuses anything that could carry prose', () => {
    expect(() => encodeExternalRef('note', 'looks good to me')).toThrow()
    expect(isEncodedExternalRef('note:looks good')).toBe(false)
    expect(isEncodedExternalRef('body:1')).toBe(false)
    expect(isEncodedExternalRef('note:01')).toBe(false)
  })
})
