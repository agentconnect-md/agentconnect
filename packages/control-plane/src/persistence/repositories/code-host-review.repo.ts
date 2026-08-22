/**
 * PgCodeHostReviewLeaseRepo — durable publication serialization for formal
 * code-host reviews (gitlab-com-integration.md §15.1, §15.2).
 *
 * Every method here is a compare-and-swap inside one transaction that first
 * takes the subject's advisory lock, because the decisions are not row-local:
 * acquisition reads the whole operation ledger before it may transfer, and the
 * no-row case needs a lock a row cannot provide. The rules themselves are pure
 * and live in `domain/code-host-review.ts`; this file only makes them durable.
 *
 * Nothing here stores a review body, an inline comment, or provider prose: the
 * ledger holds a method and a bounded path, and the outcome store holds encoded
 * `"<kind>:<numeric id>"` references it re-validates on write.
 */
import type {
  CodeHostReviewLeasePhase,
  CodeHostReviewOpKind,
  CodeHostReviewOpMethod,
  CodeHostReviewOpOutcome,
  CodeHostReviewOpState,
  CodeHostReviewState
} from '@agentconnect.md/protocol'
import type { CodeHostReviewLease, CodeHostReviewOperation, PrismaClient } from '../../generated/prisma/client.js'
import { Prisma } from '../../generated/prisma/client.js'
import { AgentId, DaemonId, HookId } from '../../domain/ids.js'
import {
  EMPTY_LEDGER,
  classifyAcquisition,
  isEncodedExternalRef,
  outcomeReconciles,
  phaseAfterIssue,
  phaseAfterResult,
  phaseAfterSettle,
  returnUnusedTransition,
  settleTransition,
  startTransition,
  type CodeHostReviewLedger,
  type CodeHostReviewLockReason,
  type CodeHostReviewOpFacts
} from '../../domain/code-host-review.js'
import { lockCodeHostReviewSubject } from '../code-host-review-lock.js'
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
} from '../ports.js'

const PHASES: readonly CodeHostReviewLeasePhase[] = ['open', 'publishing', 'classifying', 'settled', 'ambiguous_locked']
const OP_STATES: readonly CodeHostReviewOpState[] = ['issued', 'request_started', 'settled', 'ambiguous', 'unused']

/** Fail closed on an unrecognized persisted phase: an unknown value admits nothing. */
function toPhase(value: string): CodeHostReviewLeasePhase {
  return (PHASES as readonly string[]).includes(value) ? (value as CodeHostReviewLeasePhase) : 'ambiguous_locked'
}

/** Fail closed the same way: an unknown record state is treated as outstanding. */
function toOpState(value: string): CodeHostReviewOpState {
  return (OP_STATES as readonly string[]).includes(value) ? (value as CodeHostReviewOpState) : 'request_started'
}

function toLease(r: CodeHostReviewLease): CodeHostReviewLeaseRecord {
  return {
    id: r.id,
    orgId: r.orgId,
    provider: r.provider,
    projectExternalId: r.projectExternalId,
    mergeRequestIid: r.mergeRequestIid,
    serviceAccountExternalId: r.serviceAccountExternalId,
    fence: r.fence,
    attemptId: r.attemptId,
    ownerDaemonId: r.ownerDaemonId === null ? null : DaemonId(r.ownerDaemonId),
    agentId: r.agentId === null ? null : AgentId(r.agentId),
    hookId: r.hookId === null ? null : HookId(r.hookId),
    deliveryKey: r.deliveryKey,
    event: r.event,
    verdict: r.verdict,
    headSha: r.headSha,
    phase: toPhase(r.phase),
    leaseUntil: r.leaseUntil,
    lockedReason: (r.lockedReason as CodeHostReviewLockReason | null) ?? null
  }
}

function toOperation(r: CodeHostReviewOperation): CodeHostReviewOperationRecord {
  return {
    id: r.id,
    leaseId: r.leaseId,
    orgId: r.orgId,
    attemptId: r.attemptId,
    fence: r.fence,
    ordinal: r.ordinal,
    kind: r.kind as CodeHostReviewOpKind,
    method: r.method as CodeHostReviewOpMethod,
    target: r.target,
    state: toOpState(r.state),
    startToken: r.startToken,
    responseStatus: r.responseStatus,
    responseExternalId: r.responseExternalId,
    resultCode: r.resultCode
  }
}

/** The durable facts the pure transitions read, with the persisted strings narrowed. */
function facts(r: CodeHostReviewOperation): CodeHostReviewOpFacts {
  return {
    state: toOpState(r.state),
    startToken: r.startToken,
    responseStatus: r.responseStatus,
    responseExternalId: r.responseExternalId
  }
}

function summarize(rows: CodeHostReviewOperation[]): CodeHostReviewLedger {
  const ledger: CodeHostReviewLedger = { ...EMPTY_LEDGER }
  for (const row of rows) {
    ledger.total += 1
    if (row.ambiguousAt !== null) ledger.everAmbiguous = true
    switch (toOpState(row.state)) {
      case 'issued':
        ledger.issued += 1
        break
      case 'request_started':
        ledger.requestStarted += 1
        break
      case 'settled':
        ledger.settled += 1
        break
      case 'ambiguous':
        ledger.ambiguous += 1
        break
      case 'unused':
        ledger.unused += 1
        break
    }
  }
  return ledger
}

export class PgCodeHostReviewLeaseRepo implements CodeHostReviewLeaseRepo {
  constructor(private readonly prisma: PrismaClient) {}

  async acquire(input: CodeHostReviewAcquireInput): Promise<CodeHostReviewAcquireResult> {
    return this.prisma.$transaction(async (tx) => {
      await lockCodeHostReviewSubject(tx, input.subject)
      const current = await this.findSubject(tx, input.subject)
      const ledger = current?.attemptId ? summarize(await this.ledgerRows(tx, current.attemptId)) : EMPTY_LEDGER
      const reconciled = current?.attemptId ? await this.isReconciled(tx, current.attemptId) : false
      const decision = classifyAcquisition({
        current: current
          ? { phase: toPhase(current.phase), attemptId: current.attemptId, leaseUntil: current.leaseUntil }
          : null,
        attemptId: input.attemptId,
        nowMs: input.now.getTime(),
        ledger,
        reconciled
      })

      if (decision.kind === 'already_locked') {
        return { outcome: 'locked', lease: toLease(current!), lock: toLease(current!).lockedReason }
      }
      if (decision.kind === 'held') return { outcome: 'held', lease: toLease(current!) }
      if (decision.kind === 'idempotent') {
        // The same attempt asking again is its own renewal, never a second fence.
        const renewed = await tx.codeHostReviewLease.update({
          where: { id: current!.id },
          data: { leaseUntil: input.leaseUntil, ownerDaemonId: input.daemonId }
        })
        return { outcome: 'idempotent', lease: toLease(renewed) }
      }
      if (decision.kind === 'lock') {
        const locked = await tx.codeHostReviewLease.update({
          where: { id: current!.id },
          data: { phase: 'ambiguous_locked', lockedReason: decision.lock, lockedAt: input.now }
        })
        return { outcome: 'locked', lease: toLease(locked), lock: decision.lock }
      }

      const owner = {
        orgId: input.orgId,
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
        lockedReason: null,
        lockedAt: null
      }
      const lease = current
        ? await tx.codeHostReviewLease.update({
            where: { id: current.id },
            data: { ...owner, fence: { increment: 1n } }
          })
        : await tx.codeHostReviewLease.create({
            data: { ...input.subject, ...owner, fence: 1n }
          })
      return {
        outcome: 'acquired',
        lease: toLease(lease),
        condition: decision.kind === 'transfer' ? decision.condition : 'fresh'
      }
    })
  }

  async renew(input: {
    attemptId: string
    orgId: string
    fence: bigint
    daemonId: DaemonId
    leaseUntil: Date
  }): Promise<CodeHostReviewLeaseRecord | null> {
    const renewed = await this.prisma.codeHostReviewLease.updateMany({
      where: {
        attemptId: input.attemptId,
        orgId: input.orgId,
        fence: input.fence,
        ownerDaemonId: input.daemonId,
        phase: { in: ['open', 'publishing', 'classifying'] }
      },
      data: { leaseUntil: input.leaseUntil }
    })
    if (renewed.count !== 1) return null
    const row = await this.prisma.codeHostReviewLease.findUnique({ where: { attemptId: input.attemptId } })
    return row ? toLease(row) : null
  }

  async byAttempt(attemptId: string): Promise<CodeHostReviewLeaseRecord | null> {
    const row = await this.prisma.codeHostReviewLease.findUnique({ where: { attemptId } })
    return row ? toLease(row) : null
  }

  async bySubject(subject: CodeHostReviewSubject): Promise<CodeHostReviewLeaseRecord | null> {
    const row = await this.findSubject(this.prisma, subject)
    return row ? toLease(row) : null
  }

  async issueOperation(input: CodeHostReviewIssueInput): Promise<CodeHostReviewOpResult> {
    return this.withOwnedLease(input, async (tx, lease) => {
      const existing = await tx.codeHostReviewOperation.findUnique({
        where: {
          attemptId_fence_kind_ordinal: {
            attemptId: input.attemptId,
            fence: input.fence,
            kind: input.kind,
            ordinal: input.ordinal
          }
        }
      })
      if (existing) {
        // A retransmitted issue returns the same permit; a used one is never re-handed out,
        // and a different method/target under the same coordinates is a different operation.
        if (existing.method !== input.method || existing.target !== input.target) {
          return { failure: 'permit_conflict' }
        }
        if (toOpState(existing.state) !== 'issued') return { failure: 'permit_conflict' }
        return { outcome: 'ok', record: toOperation(existing), phase: toPhase(lease.phase) }
      }
      const record = await tx.codeHostReviewOperation.create({
        data: {
          leaseId: lease.id,
          orgId: lease.orgId,
          attemptId: input.attemptId,
          fence: input.fence,
          ordinal: input.ordinal,
          kind: input.kind,
          method: input.method,
          target: input.target,
          state: 'issued',
          issuedAt: input.now
        }
      })
      const phase = phaseAfterIssue(toPhase(lease.phase), input.kind)
      if (phase !== toPhase(lease.phase)) {
        await tx.codeHostReviewLease.update({ where: { id: lease.id }, data: { phase } })
      }
      return { outcome: 'ok', record: toOperation(record), phase }
    })
  }

  async startOperation(input: CodeHostReviewAdvanceInput & { startToken: string }): Promise<CodeHostReviewOpResult> {
    return this.withOwnedLease(input, async (tx, lease) => {
      const record = await this.ownedRecord(tx, input)
      if (!record) return { failure: 'no_record' }
      const transition = startTransition(facts(record), input.startToken)
      if (!transition.ok) return { failure: 'transition', reason: transition.reason }
      if (transition.idempotent) {
        return { outcome: 'ok', record: toOperation(record), phase: toPhase(lease.phase) }
      }
      // The CAS is the invariant: exactly one caller can move `issued` forward, so
      // exactly one outbound provider request is ever permitted per record.
      const started = await tx.codeHostReviewOperation.updateMany({
        where: { id: record.id, state: 'issued' },
        data: { state: 'request_started', startToken: input.startToken, startedAt: input.now }
      })
      if (started.count !== 1) return { failure: 'transition', reason: 'already_started' }
      const after = await tx.codeHostReviewOperation.findUniqueOrThrow({ where: { id: record.id } })
      return { outcome: 'ok', record: toOperation(after), phase: toPhase(lease.phase) }
    })
  }

  async settleOperation(
    input: CodeHostReviewAdvanceInput & { outcome: CodeHostReviewOpOutcome }
  ): Promise<CodeHostReviewOpResult> {
    return this.withOwnedLease(input, async (tx, lease) => {
      const record = await this.ownedRecord(tx, input)
      if (!record) return { failure: 'no_record' }
      const transition = settleTransition(facts(record), input.outcome)
      if (!transition.ok) return { failure: 'transition', reason: transition.reason }
      if (!transition.idempotent) {
        const outcome = input.outcome
        await tx.codeHostReviewOperation.update({
          where: { id: record.id },
          data: {
            state: transition.next,
            ...(outcome.kind === 'deterministic'
              ? {
                  settledAt: input.now,
                  responseStatus: outcome.status,
                  responseExternalId: outcome.externalId ?? null,
                  resultCode: outcome.code ?? null
                }
              : { ambiguousAt: record.ambiguousAt ?? input.now, resultCode: outcome.code })
          }
        })
      }
      const phase = phaseAfterSettle(toPhase(lease.phase), toOperation(record).kind)
      if (phase !== toPhase(lease.phase)) {
        await tx.codeHostReviewLease.update({ where: { id: lease.id }, data: { phase } })
      }
      const after = await tx.codeHostReviewOperation.findUniqueOrThrow({ where: { id: record.id } })
      return { outcome: 'ok', record: toOperation(after), phase }
    })
  }

  async returnOperationUnused(input: CodeHostReviewAdvanceInput): Promise<CodeHostReviewOpResult> {
    return this.withOwnedLease(input, async (tx, lease) => {
      const record = await this.ownedRecord(tx, input)
      if (!record) return { failure: 'no_record' }
      const transition = returnUnusedTransition(facts(record))
      if (!transition.ok) return { failure: 'transition', reason: transition.reason }
      if (!transition.idempotent) {
        const returned = await tx.codeHostReviewOperation.updateMany({
          where: { id: record.id, state: 'issued' },
          data: { state: 'unused', settledAt: input.now }
        })
        if (returned.count !== 1) return { failure: 'transition', reason: 'already_started' }
      }
      const after = await tx.codeHostReviewOperation.findUniqueOrThrow({ where: { id: record.id } })
      return { outcome: 'ok', record: toOperation(after), phase: toPhase(lease.phase) }
    })
  }

  async recordOutcome(input: CodeHostReviewOutcomeInput): Promise<CodeHostReviewOutcomeResult> {
    // The encoding is the guard: anything that is not a kind and a numeric id is
    // refused outright rather than silently dropped, so prose cannot reach the store.
    if (!input.externalIds.every(isEncodedExternalRef)) return { outcome: 'conflict' }
    const owner = await this.prisma.codeHostReviewLease.findUnique({ where: { attemptId: input.attemptId } })
    if (!owner) return this.settleRetransmit(input)
    return this.prisma.$transaction(async (tx) => {
      await lockCodeHostReviewSubject(tx, {
        provider: owner.provider,
        projectExternalId: owner.projectExternalId,
        mergeRequestIid: owner.mergeRequestIid,
        serviceAccountExternalId: owner.serviceAccountExternalId
      })
      const lease = await tx.codeHostReviewLease.findUnique({ where: { id: owner.id } })
      if (
        !lease ||
        lease.attemptId !== input.attemptId ||
        lease.ownerDaemonId !== input.daemonId ||
        lease.orgId !== input.orgId
      ) {
        return this.settleRetransmit(input, tx)
      }
      if (
        lease.event !== input.event ||
        lease.verdict !== input.verdict ||
        lease.headSha !== input.headSha ||
        lease.hookId !== input.hookId ||
        lease.deliveryKey !== input.deliveryKey ||
        lease.provider !== input.provider ||
        lease.projectExternalId !== input.projectExternalId ||
        lease.mergeRequestIid !== input.mergeRequestIid
      ) {
        return { outcome: 'conflict' }
      }
      const existing = await tx.codeHostReviewAttemptOutcome.findUnique({ where: { attemptId: input.attemptId } })
      if (existing && existing.state !== input.state) return { outcome: 'conflict' }
      const outcomeFacts = {
        orgId: lease.orgId,
        hookId: input.hookId,
        deliveryKey: input.deliveryKey,
        provider: lease.provider,
        projectExternalId: lease.projectExternalId,
        mergeRequestIid: lease.mergeRequestIid,
        event: input.event,
        verdict: input.verdict,
        headSha: input.headSha,
        state: input.state,
        externalIds: input.externalIds
      }
      await tx.codeHostReviewAttemptOutcome.upsert({
        where: { attemptId: input.attemptId },
        create: { attemptId: input.attemptId, ...outcomeFacts, recordedAt: input.now },
        update: outcomeFacts
      })
      const phase = phaseAfterResult(input.state)
      await tx.codeHostReviewLease.update({
        where: { id: lease.id },
        data:
          phase === 'ambiguous_locked'
            ? { phase, lockedReason: 'ambiguous_unresolved', lockedAt: input.now }
            : { phase, attemptId: null, ownerDaemonId: null, leaseUntil: null }
      })
      return { outcome: existing ? 'idempotent' : 'recorded', phase }
    })
  }

  /** A retransmit that arrives after the lease was released settles the same way it did. */
  private async settleRetransmit(
    input: CodeHostReviewOutcomeInput,
    tx?: Prisma.TransactionClient
  ): Promise<CodeHostReviewOutcomeResult> {
    const client = tx ?? this.prisma
    const existing = await client.codeHostReviewAttemptOutcome.findUnique({ where: { attemptId: input.attemptId } })
    if (existing && existing.state === input.state) {
      return { outcome: 'idempotent', phase: phaseAfterResult(input.state) }
    }
    return { outcome: 'not_owner' }
  }

  private findSubject(
    tx: Pick<PrismaClient, 'codeHostReviewLease'>,
    subject: CodeHostReviewSubject
  ): Promise<CodeHostReviewLease | null> {
    return tx.codeHostReviewLease.findUnique({
      where: {
        provider_projectExternalId_mergeRequestIid_serviceAccountExternalId: {
          provider: subject.provider,
          projectExternalId: subject.projectExternalId,
          mergeRequestIid: subject.mergeRequestIid,
          serviceAccountExternalId: subject.serviceAccountExternalId
        }
      }
    })
  }

  private ledgerRows(tx: Prisma.TransactionClient, attemptId: string): Promise<CodeHostReviewOperation[]> {
    return tx.codeHostReviewOperation.findMany({ where: { attemptId } })
  }

  private async isReconciled(tx: Prisma.TransactionClient, attemptId: string): Promise<boolean> {
    const row = await tx.codeHostReviewAttemptOutcome.findUnique({ where: { attemptId } })
    return outcomeReconciles((row?.state as CodeHostReviewState | undefined) ?? null)
  }

  private ownedRecord(
    tx: Prisma.TransactionClient,
    input: CodeHostReviewAdvanceInput
  ): Promise<CodeHostReviewOperation | null> {
    return tx.codeHostReviewOperation.findFirst({
      where: { id: input.recordId, attemptId: input.attemptId, fence: input.fence }
    })
  }

  /** Every ledger op runs under the subject lock with the owner and fence re-checked. */
  private async withOwnedLease(
    input: { attemptId: string; orgId: string; fence: bigint; daemonId: DaemonId },
    run: (tx: Prisma.TransactionClient, lease: CodeHostReviewLease) => Promise<CodeHostReviewOpResult>
  ): Promise<CodeHostReviewOpResult> {
    const owner = await this.prisma.codeHostReviewLease.findUnique({ where: { attemptId: input.attemptId } })
    if (!owner) return { failure: 'no_lease' }
    return this.prisma.$transaction(async (tx) => {
      await lockCodeHostReviewSubject(tx, {
        provider: owner.provider,
        projectExternalId: owner.projectExternalId,
        mergeRequestIid: owner.mergeRequestIid,
        serviceAccountExternalId: owner.serviceAccountExternalId
      })
      const lease = await tx.codeHostReviewLease.findUnique({ where: { id: owner.id } })
      if (!lease || lease.attemptId !== input.attemptId) return { failure: 'no_lease' }
      if (lease.ownerDaemonId !== input.daemonId || lease.orgId !== input.orgId) return { failure: 'not_owner' }
      if (lease.fence !== input.fence) return { failure: 'stale_fence' }
      if (toPhase(lease.phase) === 'settled' || toPhase(lease.phase) === 'ambiguous_locked') {
        return { failure: 'lease_closed' }
      }
      return run(tx, lease)
    })
  }
}
