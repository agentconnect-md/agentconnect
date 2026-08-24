import type { CodeHostReviewLeasePhase, CodeHostReviewOpOutcome } from '@agentconnect.md/protocol'
import {
  EMPTY_LEDGER,
  classifyAcquisition,
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
  type CodeHostReviewOpTransition
} from '../../src/domain/code-host-review.js'
import type {
  CodeHostReviewAcquireInput,
  CodeHostReviewAcquireResult,
  CodeHostReviewAdvanceInput,
  CodeHostReviewIssueInput,
  CodeHostReviewLeaseRecord,
  CodeHostReviewLeaseRepo,
  CodeHostReviewOpResult,
  CodeHostReviewOperationRecord,
  CodeHostReviewOutcomeInput,
  CodeHostReviewOutcomeResult,
  CodeHostReviewSubject
} from '../../src/persistence/ports.js'

interface StoredOperation extends CodeHostReviewOperationRecord {
  everAmbiguous: boolean
}

interface StoredOutcome {
  state: CodeHostReviewOutcomeInput['state']
  externalIds: string[]
}

function key(subject: CodeHostReviewSubject): string {
  return [
    subject.provider,
    subject.projectExternalId.toString(),
    subject.mergeRequestIid,
    subject.serviceAccountExternalId.toString()
  ].join('|')
}

/**
 * In-memory `CodeHostReviewLeaseRepo` for service unit tests.
 *
 * It is built on the same pure rules the Postgres repository applies, so it can
 * only diverge in durability, never in policy — the real CAS, fence, and
 * cross-daemon behavior are proven in `test/repo/code-host-review.repo.test.ts`.
 */
export class FakeCodeHostReviewLeaseRepo implements CodeHostReviewLeaseRepo {
  readonly leases = new Map<string, CodeHostReviewLeaseRecord>()
  readonly operations = new Map<string, StoredOperation>()
  readonly outcomes = new Map<string, StoredOutcome>()
  private nextId = 1

  private id(prefix: string): string {
    return `${prefix}-${this.nextId++}`
  }

  private ledgerOf(attemptId: string | null): CodeHostReviewLedger {
    if (!attemptId) return EMPTY_LEDGER
    const ledger: CodeHostReviewLedger = { ...EMPTY_LEDGER }
    for (const op of this.operations.values()) {
      if (op.attemptId !== attemptId) continue
      ledger.total += 1
      if (op.everAmbiguous) ledger.everAmbiguous = true
      if (op.state === 'issued') ledger.issued += 1
      if (op.state === 'request_started') ledger.requestStarted += 1
      if (op.state === 'settled') ledger.settled += 1
      if (op.state === 'ambiguous') ledger.ambiguous += 1
      if (op.state === 'unused') ledger.unused += 1
    }
    return ledger
  }

  async acquire(input: CodeHostReviewAcquireInput): Promise<CodeHostReviewAcquireResult> {
    const k = key(input.subject)
    const current = this.leases.get(k) ?? null
    const decision = classifyAcquisition({
      current,
      attemptId: input.attemptId,
      nowMs: input.now.getTime(),
      ledger: this.ledgerOf(current?.attemptId ?? null),
      reconciled: outcomeReconciles(this.outcomes.get(current?.attemptId ?? '')?.state ?? null)
    })
    if (decision.kind === 'already_locked') {
      return { outcome: 'locked', lease: current!, lock: current!.lockedReason }
    }
    if (decision.kind === 'held') return { outcome: 'held', lease: current! }
    if (decision.kind === 'idempotent') {
      current!.leaseUntil = input.leaseUntil
      return { outcome: 'idempotent', lease: current! }
    }
    if (decision.kind === 'lock') {
      current!.phase = 'ambiguous_locked'
      current!.lockedReason = decision.lock
      return { outcome: 'locked', lease: current!, lock: decision.lock }
    }
    const lease: CodeHostReviewLeaseRecord = {
      id: current?.id ?? this.id('lease'),
      orgId: input.orgId,
      ...input.subject,
      fence: (current?.fence ?? 0n) + 1n,
      attemptId: input.attemptId,
      ownerDaemonId: input.daemonId,
      agentId: input.agentId,
      hookId: input.hookId,
      deliveryKey: input.deliveryKey,
      event: input.event,
      verdict: input.verdict,
      headSha: input.headSha,
      phase: 'open',
      leaseUntil: input.leaseUntil,
      lockedReason: null
    }
    this.leases.set(k, lease)
    return {
      outcome: 'acquired',
      lease,
      condition: decision.kind === 'transfer' ? decision.condition : 'fresh'
    }
  }

  async renew(input: {
    attemptId: string
    orgId: string
    fence: bigint
    daemonId: CodeHostReviewAcquireInput['daemonId']
    leaseUntil: Date
  }): Promise<CodeHostReviewLeaseRecord | null> {
    const lease = this.byAttemptSync(input.attemptId)
    if (!lease || lease.orgId !== input.orgId || lease.fence !== input.fence) return null
    if (lease.ownerDaemonId !== input.daemonId) return null
    if (lease.phase === 'settled' || lease.phase === 'ambiguous_locked') return null
    lease.leaseUntil = input.leaseUntil
    return lease
  }

  async byAttempt(attemptId: string): Promise<CodeHostReviewLeaseRecord | null> {
    return this.byAttemptSync(attemptId)
  }

  async bySubject(subject: CodeHostReviewSubject): Promise<CodeHostReviewLeaseRecord | null> {
    return this.leases.get(key(subject)) ?? null
  }

  async issueOperation(input: CodeHostReviewIssueInput): Promise<CodeHostReviewOpResult> {
    const lease = this.ownedLease(input)
    if ('failure' in lease) return lease
    const existing = [...this.operations.values()].find(
      (op) =>
        op.attemptId === input.attemptId &&
        op.fence === input.fence &&
        op.kind === input.kind &&
        op.ordinal === input.ordinal
    )
    if (existing) {
      if (existing.method !== input.method || existing.target !== input.target || existing.state !== 'issued') {
        return { failure: 'permit_conflict' }
      }
      return { outcome: 'ok', record: existing, phase: lease.phase }
    }
    const record: StoredOperation = {
      id: this.id('op'),
      leaseId: lease.id,
      orgId: lease.orgId,
      attemptId: input.attemptId,
      fence: input.fence,
      ordinal: input.ordinal,
      kind: input.kind,
      method: input.method,
      target: input.target,
      state: 'issued',
      startToken: null,
      responseStatus: null,
      responseExternalId: null,
      resultCode: null,
      everAmbiguous: false
    }
    this.operations.set(record.id, record)
    lease.phase = phaseAfterIssue(lease.phase, input.kind)
    return { outcome: 'ok', record, phase: lease.phase }
  }

  async startOperation(input: CodeHostReviewAdvanceInput & { startToken: string }): Promise<CodeHostReviewOpResult> {
    return this.advance(input, (record, lease) => {
      const transition = startTransition(record, input.startToken)
      if (!transition.ok) return { failure: 'transition', reason: transition.reason }
      record.state = transition.next
      record.startToken = input.startToken
      return { outcome: 'ok', record, phase: lease.phase }
    })
  }

  async settleOperation(
    input: CodeHostReviewAdvanceInput & { outcome: CodeHostReviewOpOutcome }
  ): Promise<CodeHostReviewOpResult> {
    const replay = this.replayTerminalRecord(input, (record) => settleTransition(record, input.outcome))
    if (replay) return replay
    return this.advance(input, (record, lease) => {
      const transition = settleTransition(record, input.outcome)
      if (!transition.ok) return { failure: 'transition', reason: transition.reason }
      record.state = transition.next
      if (input.outcome.kind === 'deterministic') {
        record.responseStatus = input.outcome.status
        record.responseExternalId = input.outcome.externalId ?? null
      } else {
        record.everAmbiguous = true
      }
      lease.phase = phaseAfterSettle(lease.phase, record.kind)
      return { outcome: 'ok', record, phase: this.releaseIfNowSafe(lease) }
    })
  }

  async returnOperationUnused(input: CodeHostReviewAdvanceInput): Promise<CodeHostReviewOpResult> {
    const replay = this.replayTerminalRecord(input, (record) => returnUnusedTransition(record))
    if (replay) return replay
    return this.advance(input, (record, lease) => {
      const transition = returnUnusedTransition(record)
      if (!transition.ok) return { failure: 'transition', reason: transition.reason }
      record.state = transition.next
      return { outcome: 'ok', record, phase: this.releaseIfNowSafe(lease) }
    })
  }

  async recordOutcome(input: CodeHostReviewOutcomeInput): Promise<CodeHostReviewOutcomeResult> {
    if (!input.externalIds.every(isEncodedExternalRef)) return { outcome: 'conflict' }
    const lease = this.byAttemptSync(input.attemptId)
    const existing = this.outcomes.get(input.attemptId)
    if (!lease || lease.ownerDaemonId !== input.daemonId || lease.orgId !== input.orgId) {
      if (existing && existing.state === input.state) {
        return { outcome: 'idempotent', phase: phaseOfSettledOutcome(input.state) }
      }
      return { outcome: 'not_owner' }
    }
    if (lease.event !== input.event || lease.verdict !== input.verdict || lease.headSha !== input.headSha) {
      return { outcome: 'conflict' }
    }
    if (existing && existing.state !== input.state) return { outcome: 'conflict' }
    this.outcomes.set(input.attemptId, { state: input.state, externalIds: input.externalIds })
    // Recording the outcome never clears ownership by itself — the ledger decides.
    return { outcome: existing ? 'idempotent' : 'recorded', phase: this.releaseIfNowSafe(lease) }
  }

  /** The same release classification the Postgres repository runs under the subject lock. */
  private releaseIfNowSafe(lease: CodeHostReviewLeaseRecord): CodeHostReviewLeasePhase {
    if (lease.attemptId === null) return lease.phase
    const recorded = this.outcomes.get(lease.attemptId)
    if (!recorded) return lease.phase
    const decision = classifyRelease({ ledger: this.ledgerOf(lease.attemptId), state: recorded.state })
    if (decision.kind === 'retain') {
      lease.phase = 'classifying'
    } else if (decision.kind === 'lock') {
      lease.phase = 'ambiguous_locked'
      lease.lockedReason = 'ambiguous_unresolved'
    } else {
      lease.phase = 'settled'
      lease.attemptId = null
      lease.ownerDaemonId = null
      lease.leaseUntil = null
    }
    return lease.phase
  }

  private byAttemptSync(attemptId: string): CodeHostReviewLeaseRecord | null {
    for (const lease of this.leases.values()) if (lease.attemptId === attemptId) return lease
    return null
  }

  private ownedLease(input: {
    attemptId: string
    orgId: string
    fence: bigint
    daemonId: CodeHostReviewAcquireInput['daemonId']
  }): CodeHostReviewLeaseRecord | Extract<CodeHostReviewOpResult, { failure: string }> {
    const lease = this.byAttemptSync(input.attemptId)
    if (!lease) return { failure: 'no_lease' }
    if (lease.ownerDaemonId !== input.daemonId || lease.orgId !== input.orgId) return { failure: 'not_owner' }
    if (lease.fence !== input.fence) return { failure: 'stale_fence' }
    if (lease.phase === 'settled' || lease.phase === 'ambiguous_locked') return { failure: 'lease_closed' }
    return lease
  }

  /** The same record-first replay the Postgres repository does, so a released lease still answers. */
  private replayTerminalRecord(
    input: CodeHostReviewAdvanceInput,
    decide: (record: StoredOperation) => CodeHostReviewOpTransition
  ): CodeHostReviewOpResult | null {
    const record = this.operations.get(input.recordId)
    if (!record || record.attemptId !== input.attemptId || record.fence !== input.fence) return null
    if (record.orgId !== input.orgId) return null
    if (record.state === 'issued' || record.state === 'request_started') return null
    const transition = decide(record)
    if (transition.ok && !transition.idempotent) return null
    if (!transition.ok) return { failure: 'transition', reason: transition.reason }
    const lease = [...this.leases.values()].find((l) => l.id === record.leaseId)
    if (!lease) return null
    // The subject row is reusable, so its live phase may already belong to a newer fence.
    if (lease.fence === record.fence) return { outcome: 'ok', record, phase: lease.phase }
    const recorded = this.outcomes.get(record.attemptId)
    // Past that fence the record's attempt is over, so its own terminal outcome is the phase.
    return {
      outcome: 'ok',
      record,
      phase: recorded ? phaseOfSettledOutcome(recorded.state) : 'settled'
    }
  }

  private advance(
    input: CodeHostReviewAdvanceInput,
    run: (record: StoredOperation, lease: CodeHostReviewLeaseRecord) => CodeHostReviewOpResult
  ): CodeHostReviewOpResult {
    const lease = this.ownedLease(input)
    if ('failure' in lease) return lease
    const record = this.operations.get(input.recordId)
    if (!record || record.attemptId !== input.attemptId || record.fence !== input.fence) {
      return { failure: 'no_record' }
    }
    return run(record, lease)
  }
}
