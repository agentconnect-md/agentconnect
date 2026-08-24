/**
 * PgCodeHostRunProjectionRepo — the durable desired-generation ledger for the
 * informational run projection (gitlab-com-integration.md §16).
 *
 * Every rule here is ported from the Control-Plane-owned GitHub Checks writer,
 * with one deliberate inversion: the OWNING DAEMON is the only provider writer,
 * so `leaseOwner` holds a daemon id rather than a worker id and an offline or
 * non-advertising daemon simply leaves the row pending. The ported rules are:
 *
 *  - generation — the natural key's write counter; every mutation is a CAS on
 *    `(id, generation)` returning false rather than throwing;
 *  - sealedThrough — a SEPARATE watermark ordering terminal AUTHORITY, so a
 *    late queued/running edge cannot regress a sealed generation;
 *  - lease — `leaseOwner`/`leaseUntil`, taken only when no mutation is in
 *    flight: daemon loss or lease expiry alone never authorizes another writer;
 *  - pending intent — a lifecycle edge that lands mid-write is parked as JSON
 *    and drained into a fresh generation afterwards;
 *  - write marker — the per-attempt mutex an ambiguous outcome keeps, so only
 *    reconciliation, never a replay, may follow;
 *  - tombstone — one-way cleanup intent a delayed edge can never revive;
 *  - out-of-order completion — generation ∧ lease owner ∧ marker on settlement.
 *
 * Metadata only: no note body, agent output, or provider exception text.
 */
import { randomUUID } from 'node:crypto'
import type { CodeHostNoteState } from '@agentconnect.md/protocol'
import { Prisma } from '../../generated/prisma/client.js'
import type { CodeHostRunProjection, PrismaClient } from '../../generated/prisma/client.js'
import type { AgentId, HookId, OrgId } from '../../domain/ids.js'
import type {
  CodeHostProjectionWriteResultInput,
  CodeHostRunProjectionRecord,
  CodeHostRunProjectionRepo,
  HookGateMode,
  HookReportingMode,
  HookReviewPolicy,
  UpsertCodeHostRunProjectionInput
} from '../ports.js'
import type { PrismaLike } from '../prisma.js'
import { lockHookReviewLifecycleScope, lockHookReviewOrgProducerScope } from '../review-projection-lock.js'

/** queued/running are lifecycle hints; everything else is an authority a late hint cannot undo. */
const NON_TERMINAL_STATES = new Set<CodeHostNoteState>(['queued', 'running'])

export function isTerminalNoteState(state: string): boolean {
  return !NON_TERMINAL_STATES.has(state as CodeHostNoteState)
}

/** The complete accepted fence a parked edge carries, so draining applies ITS authority, never the
 *  authority of the run whose write was in flight. Bigints ride as decimal strings, dates as ISO. */
interface PendingNoteFence {
  agentName?: string
  projectPath?: string
  sessionId?: string | null
  queuedAt?: string | null
  startedAt?: string | null
  completedAt?: string | null
  credentialEpoch?: string
  configRevision?: string
  dispatchRevision?: string
  dispatchDaemonId?: string
  reviewPolicySnapshot?: string
  reportingModeSnapshot?: string
  gateModeSnapshot?: string
}

interface PendingNoteIntent extends PendingNoteFence {
  desiredState: CodeHostNoteState
  reason?: string | null
  currentDeliveryKey?: string | null
  currentRunAt?: string
  nextAttemptAt?: string
  tombstoned?: boolean
}

/** Timestamps and session are per-RUN: a parked edge from a new delivery carries only its own, while
 *  one from the delivery already on the row merges the row's, so draining can set all of them. */
function encodePendingFence(
  input: UpsertCodeHostRunProjectionInput,
  current: CodeHostRunProjection,
  sameRun: boolean
): PendingNoteFence {
  const iso = (value: Date | null | undefined, carried: Date | null) =>
    (value ?? (sameRun ? carried : null))?.toISOString() ?? null
  return {
    agentName: input.agentName,
    projectPath: input.projectPath,
    sessionId: input.sessionId ?? (sameRun ? current.sessionId : null),
    queuedAt: iso(input.queuedAt, current.queuedAt),
    startedAt: iso(input.startedAt, current.startedAt),
    completedAt: iso(input.completedAt, current.completedAt),
    ...(input.credentialEpoch !== undefined ? { credentialEpoch: input.credentialEpoch.toString() } : {}),
    ...(input.configRevision !== undefined ? { configRevision: input.configRevision.toString() } : {}),
    ...(input.dispatchRevision !== undefined ? { dispatchRevision: input.dispatchRevision.toString() } : {}),
    ...(input.dispatchDaemonId ? { dispatchDaemonId: input.dispatchDaemonId } : {}),
    ...(input.reviewPolicySnapshot ? { reviewPolicySnapshot: input.reviewPolicySnapshot } : {}),
    ...(input.reportingModeSnapshot ? { reportingModeSnapshot: input.reportingModeSnapshot } : {}),
    ...(input.gateModeSnapshot ? { gateModeSnapshot: input.gateModeSnapshot } : {})
  }
}

/** Apply a parked edge's fence to the generation it drains into; a member it never carried is left. */
function pendingFenceUpdate(pending: PendingNoteIntent) {
  const at = (value?: string | null) => (value ? new Date(value) : null)
  return {
    ...(pending.agentName !== undefined ? { agentName: pending.agentName } : {}),
    ...(pending.projectPath !== undefined ? { projectPath: pending.projectPath } : {}),
    ...(pending.sessionId !== undefined ? { sessionId: pending.sessionId } : {}),
    ...(pending.queuedAt !== undefined ? { queuedAt: at(pending.queuedAt) } : {}),
    ...(pending.startedAt !== undefined ? { startedAt: at(pending.startedAt) } : {}),
    ...(pending.completedAt !== undefined ? { completedAt: at(pending.completedAt) } : {}),
    ...(pending.credentialEpoch !== undefined ? { credentialEpoch: BigInt(pending.credentialEpoch) } : {}),
    ...(pending.configRevision !== undefined ? { configRevision: BigInt(pending.configRevision) } : {}),
    ...(pending.dispatchRevision !== undefined ? { dispatchRevision: BigInt(pending.dispatchRevision) } : {}),
    ...(pending.dispatchDaemonId !== undefined ? { dispatchDaemonId: pending.dispatchDaemonId } : {}),
    ...(pending.reviewPolicySnapshot !== undefined ? { reviewPolicySnapshot: pending.reviewPolicySnapshot } : {}),
    ...(pending.reportingModeSnapshot !== undefined ? { reportingModeSnapshot: pending.reportingModeSnapshot } : {}),
    ...(pending.gateModeSnapshot !== undefined ? { gateModeSnapshot: pending.gateModeSnapshot } : {})
  }
}

function parsePendingIntent(value: unknown): PendingNoteIntent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const pending = value as Record<string, unknown>
  return typeof pending.desiredState === 'string' ? (pending as unknown as PendingNoteIntent) : null
}

function toRecord(r: CodeHostRunProjection): CodeHostRunProjectionRecord {
  return {
    id: r.id,
    provider: r.provider,
    hookId: r.hookId as HookId,
    orgId: r.orgId as OrgId,
    agentId: r.agentId as AgentId,
    agentName: r.agentName,
    projectId: r.projectId,
    projectPath: r.projectPath,
    mergeRequestIid: r.mergeRequestIid,
    headSha: r.headSha,
    projectionEpoch: r.projectionEpoch,
    generation: r.generation,
    currentDeliveryKey: r.currentDeliveryKey,
    currentRunAt: r.currentRunAt,
    externalId: r.externalId,
    noteId: r.noteId,
    desiredState: r.desiredState as CodeHostNoteState,
    observedState: r.observedState as CodeHostNoteState | null,
    reason: r.reason,
    sealedThrough: r.sealedThrough,
    queuedAt: r.queuedAt,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
    sessionId: r.sessionId,
    credentialEpoch: r.credentialEpoch,
    configRevision: r.configRevision,
    dispatchRevision: r.dispatchRevision,
    dispatchDaemonId: r.dispatchDaemonId,
    reviewPolicySnapshot: r.reviewPolicySnapshot as HookReviewPolicy | null,
    reportingModeSnapshot: r.reportingModeSnapshot as HookReportingMode | null,
    gateModeSnapshot: r.gateModeSnapshot as HookGateMode | null,
    leaseOwner: r.leaseOwner,
    leaseUntil: r.leaseUntil,
    nextAttemptAt: r.nextAttemptAt,
    attempts: r.attempts,
    lastErrorCode: r.lastErrorCode,
    pendingIntent: r.pendingIntent,
    writeMarker: r.writeMarker,
    writePhase: r.writePhase,
    writeStartedAt: r.writeStartedAt,
    tombstonedAt: r.tombstonedAt,
    updatedAt: r.updatedAt
  }
}

export class PgCodeHostRunProjectionRepo implements CodeHostRunProjectionRepo {
  constructor(private readonly db: PrismaLike) {}

  private transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    if ('$transaction' in this.db) return (this.db as PrismaClient).$transaction(fn)
    return fn(this.db as Prisma.TransactionClient)
  }

  private async lockById(tx: Prisma.TransactionClient, id: string): Promise<CodeHostRunProjection | null> {
    const rows = await tx.$queryRaw<CodeHostRunProjection[]>(Prisma.sql`
      SELECT * FROM "code_host_run_projection" WHERE "id" = ${id}::uuid FOR UPDATE
    `)
    return rows[0] ?? null
  }

  private async lockByNaturalKey(
    tx: Prisma.TransactionClient,
    hookId: HookId,
    projectId: bigint,
    mergeRequestIid: number,
    headSha: string,
    projectionEpoch: bigint
  ): Promise<CodeHostRunProjection | null> {
    const rows = await tx.$queryRaw<CodeHostRunProjection[]>(Prisma.sql`
      SELECT * FROM "code_host_run_projection"
      WHERE "hookId" = ${hookId}::uuid
        AND "projectId" = ${projectId}
        AND "mergeRequestIid" = ${mergeRequestIid}
        AND "headSha" = ${headSha}
        AND "projectionEpoch" = ${projectionEpoch}
      FOR UPDATE
    `)
    return rows[0] ?? null
  }

  async upsert(input: UpsertCodeHostRunProjectionInput): Promise<CodeHostRunProjectionRecord | null> {
    return this.transaction(async (tx) => {
      // Join the established owner-lifecycle lock order — org producer scope, then hook — BEFORE the
      // natural-key lock, exactly as the Checks writer does. Without it a converge that started
      // before a deletion could insert a fresh FK-free row after that deletion's cleanup snapshot
      // and leave it live once the HookDef was gone.
      await lockHookReviewOrgProducerScope(tx, input.orgId)
      await lockHookReviewLifecycleScope(tx, input.hookId)
      // The unique constraint prevents duplicate rows but does not make the read/compare/update
      // below atomic under READ COMMITTED. Serialize the natural key next, so two CP processes
      // cannot both advance one generation from stale state.
      const naturalKey = JSON.stringify([
        'code-host-run-projection',
        input.hookId,
        input.projectId.toString(),
        input.mergeRequestIid,
        input.headSha,
        input.projectionEpoch.toString()
      ])
      await tx.$queryRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtextextended(${naturalKey}, 0)) IS NULL AS "locked"
      `)
      const current = await this.lockByNaturalKey(
        tx,
        input.hookId,
        input.projectId,
        input.mergeRequestIid,
        input.headSha,
        input.projectionEpoch
      )
      // Tombstones are one-way cleanup intent: a delayed edge may observe a historical run after
      // disable/delete, but may never validate, increment, or otherwise revive the projection.
      if (current && current.tombstonedAt !== null) return toRecord(current)

      const lifecycle = {
        ...(input.queuedAt ? { queuedAt: input.queuedAt } : {}),
        ...(input.startedAt ? { startedAt: input.startedAt } : {}),
        ...(input.completedAt ? { completedAt: input.completedAt } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.credentialEpoch !== undefined ? { credentialEpoch: input.credentialEpoch } : {}),
        ...(input.configRevision !== undefined ? { configRevision: input.configRevision } : {}),
        ...(input.dispatchRevision !== undefined ? { dispatchRevision: input.dispatchRevision } : {}),
        ...(input.dispatchDaemonId ? { dispatchDaemonId: input.dispatchDaemonId } : {}),
        ...(input.reviewPolicySnapshot ? { reviewPolicySnapshot: input.reviewPolicySnapshot } : {}),
        ...(input.reportingModeSnapshot ? { reportingModeSnapshot: input.reportingModeSnapshot } : {}),
        ...(input.gateModeSnapshot ? { gateModeSnapshot: input.gateModeSnapshot } : {})
      }
      if (!current) {
        // Create only under a live owner. Every retire path — delete, disable, retarget, the agent
        // cascade — runs inside this same hook lock and either bumps the projection epoch or removes
        // the row, so a retired hook refuses a new projection instead of leaking one.
        const hook = await tx.hookDef.findUnique({
          where: { id: input.hookId },
          select: { orgId: true, enabled: true, projectionEpoch: true }
        })
        if (!hook || hook.orgId !== input.orgId || !hook.enabled || hook.projectionEpoch !== input.projectionEpoch) {
          return null
        }
        const id = randomUUID()
        return toRecord(
          await tx.codeHostRunProjection.create({
            data: {
              id,
              provider: input.provider,
              hookId: input.hookId,
              orgId: input.orgId,
              agentId: input.agentId,
              agentName: input.agentName,
              projectId: input.projectId,
              projectPath: input.projectPath,
              mergeRequestIid: input.mergeRequestIid,
              headSha: input.headSha,
              projectionEpoch: input.projectionEpoch,
              generation: 1n,
              externalId: id,
              desiredState: input.desiredState,
              reason: input.reason ?? null,
              ...(isTerminalNoteState(input.desiredState) ? { sealedThrough: 1n } : {}),
              currentDeliveryKey: input.currentDeliveryKey,
              currentRunAt: input.currentRunAt,
              nextAttemptAt: input.nextAttemptAt,
              ...lifecycle
            }
          })
        )
      }
      const sameRun = current.currentDeliveryKey === input.currentDeliveryKey
      // An older delivery may never take the row from a newer one — the same total order the Checks
      // writer applies to competing hook runs, here on relay ingest / report time.
      if (!sameRun && current.currentRunAt !== null && input.currentRunAt < current.currentRunAt) {
        return toRecord(current)
      }
      // A write in flight owns this generation: park the edge rather than move the generation, or
      // rewrite the state, under a mutation whose outcome nobody has settled yet.
      if (current.writePhase !== null) {
        const pending: Prisma.InputJsonValue = {
          desiredState: input.desiredState,
          reason: input.reason ?? null,
          currentDeliveryKey: input.currentDeliveryKey,
          currentRunAt: input.currentRunAt.toISOString(),
          nextAttemptAt: input.nextAttemptAt.toISOString(),
          ...encodePendingFence(input, current, sameRun)
        }
        return toRecord(
          await tx.codeHostRunProjection.update({ where: { id: current.id }, data: { pendingIntent: pending } })
        )
      }
      // Further edges of the SAME delivery move the state inside this generation (setDesired), so
      // here they only refresh the lifecycle facts a render reads.
      if (sameRun) {
        return toRecord(
          await tx.codeHostRunProjection.update({
            where: { id: current.id },
            data: { agentName: input.agentName, projectPath: input.projectPath, ...lifecycle }
          })
        )
      }
      const nextGeneration = current.generation + 1n
      return toRecord(
        await tx.codeHostRunProjection.update({
          where: { id: current.id },
          data: {
            generation: nextGeneration,
            currentDeliveryKey: input.currentDeliveryKey,
            currentRunAt: input.currentRunAt,
            agentName: input.agentName,
            projectPath: input.projectPath,
            desiredState: input.desiredState,
            reason: input.reason ?? null,
            ...(isTerminalNoteState(input.desiredState) ? { sealedThrough: nextGeneration } : {}),
            observedState: null,
            nextAttemptAt: input.nextAttemptAt,
            attempts: 0,
            lastErrorCode: null,
            pendingIntent: Prisma.DbNull,
            leaseOwner: null,
            leaseUntil: null,
            ...lifecycle,
            // A new delivery owns a fresh lifecycle: keeping the previous run's timestamps or session
            // would render another run's facts under this generation.
            queuedAt: input.queuedAt ?? null,
            startedAt: input.startedAt ?? null,
            completedAt: input.completedAt ?? null,
            sessionId: input.sessionId ?? null
          }
        })
      )
    })
  }

  async setDesired(
    projectionId: string,
    generation: bigint,
    desiredState: CodeHostNoteState,
    nextAttemptAt: Date,
    reason?: string
  ): Promise<boolean> {
    const terminal = isTerminalNoteState(desiredState)
    const changed = await this.db.codeHostRunProjection.updateMany({
      where: {
        id: projectionId,
        generation,
        tombstonedAt: null,
        // Once any terminal authority seals this generation a delayed queued/running edge can no
        // longer regress it, even if its caller held a stale row snapshot.
        ...(terminal ? {} : { sealedThrough: { lt: generation } })
      },
      data: {
        desiredState,
        reason: reason ?? null,
        nextAttemptAt,
        ...(terminal ? { sealedThrough: generation } : {})
      }
    })
    return changed.count === 1
  }

  async supersede(
    hookId: HookId,
    projectId: bigint,
    mergeRequestIid: number,
    currentHeadSha: string,
    at: Date
  ): Promise<number> {
    return this.transaction(async (tx) => {
      const candidates = await tx.codeHostRunProjection.findMany({
        where: {
          hookId,
          projectId,
          mergeRequestIid,
          headSha: { not: currentHeadSha },
          tombstonedAt: null,
          desiredState: { notIn: ['superseded'] }
        },
        select: { id: true }
      })
      let changed = 0
      // Deterministic id order: supersession overlaps ordinary lifecycle edges on the same subject.
      for (const { id } of [...candidates].sort((a, b) => a.id.localeCompare(b.id))) {
        const row = await this.lockById(tx, id)
        if (!row || row.tombstonedAt !== null || row.desiredState === 'superseded') continue
        // A mutation is in flight for the current generation: park supersession as pending intent
        // instead of moving a generation someone is mid-writing.
        if (row.writePhase !== null) {
          if (parsePendingIntent(row.pendingIntent)?.desiredState === 'superseded') continue
          await tx.codeHostRunProjection.update({
            where: { id: row.id },
            data: {
              pendingIntent: { desiredState: 'superseded', nextAttemptAt: at.toISOString() },
              nextAttemptAt: at
            }
          })
          changed += 1
          continue
        }
        const nextGeneration = row.generation + 1n
        await tx.codeHostRunProjection.update({
          where: { id: row.id },
          data: {
            generation: nextGeneration,
            desiredState: 'superseded',
            sealedThrough: nextGeneration,
            observedState: null,
            reason: null,
            completedAt: row.completedAt ?? at,
            nextAttemptAt: at,
            attempts: 0,
            lastErrorCode: null,
            pendingIntent: Prisma.DbNull,
            leaseOwner: null,
            leaseUntil: null
          }
        })
        changed += 1
      }
      return changed
    })
  }

  async beginWrite(
    projectionId: string,
    generation: bigint,
    leaseOwner: string,
    writeMarker: string,
    writePhase: string,
    startedAt: Date,
    leaseUntil: Date
  ): Promise<boolean> {
    return this.transaction(async (tx) => {
      const current = await this.lockById(tx, projectionId)
      // Ownership may move only when no provider mutation is in flight: an ambiguous mutation stays
      // fail-closed on the old writer, and daemon loss or lease expiry alone cannot reassign it.
      if (!current || current.generation !== generation || current.writePhase !== null || current.writeMarker !== null)
        return false
      const changed = await tx.codeHostRunProjection.updateMany({
        where: { id: projectionId, generation, writePhase: null, writeMarker: null },
        data: { leaseOwner, leaseUntil, writeMarker, writePhase, writeStartedAt: startedAt }
      })
      return changed.count === 1
    })
  }

  async completeWrite(input: CodeHostProjectionWriteResultInput): Promise<boolean> {
    return this.transaction(async (tx) => {
      const current = await this.lockById(tx, input.projectionId)
      // The out-of-order fence: an older generation's result settles nothing, and neither does a
      // result from a writer that no longer holds the lease or names a stale marker.
      if (
        !current ||
        current.generation !== input.generation ||
        current.leaseOwner !== input.leaseOwner ||
        current.writeMarker !== input.writeMarker
      )
        return false
      const needsFollowup =
        current.pendingIntent !== null ||
        (current.desiredState !== input.observedState && input.settledErrorCode === undefined)
      const changed = await tx.codeHostRunProjection.updateMany({
        where: {
          id: input.projectionId,
          generation: input.generation,
          leaseOwner: input.leaseOwner,
          writeMarker: input.writeMarker
        },
        data: {
          observedState: input.observedState,
          ...(input.noteId ? { noteId: input.noteId } : {}),
          writeMarker: null,
          writePhase: null,
          writeStartedAt: null,
          leaseOwner: null,
          leaseUntil: null,
          nextAttemptAt: needsFollowup ? (input.recheckAt ?? current.nextAttemptAt ?? new Date()) : null,
          attempts: 0,
          lastErrorCode: input.settledErrorCode ?? null
        }
      })
      return changed.count === 1
    })
  }

  async failWrite(
    projectionId: string,
    generation: bigint,
    leaseOwner: string,
    writeMarker: string,
    errorCode: string,
    nextAttemptAt: Date,
    keepWriteMutex = false
  ): Promise<boolean> {
    return this.transaction(async (tx) => {
      const current = await this.lockById(tx, projectionId)
      // Same out-of-order fence as completeWrite: a late duplicate of an EARLIER attempt's result
      // names that attempt's marker and must not touch the attempt now in flight.
      if (
        !current ||
        current.generation !== generation ||
        current.leaseOwner !== leaseOwner ||
        current.writeMarker !== writeMarker
      )
        return false
      const changed = await tx.codeHostRunProjection.updateMany({
        where: { id: projectionId, generation, leaseOwner, writeMarker },
        data: {
          attempts: { increment: 1 },
          lastErrorCode: errorCode,
          nextAttemptAt,
          // Only a PROVED non-effect releases the mutex AND the lease. An ambiguous mutation keeps
          // both, so the same daemon stays the one writer that may reconcile the marker (§16).
          ...(keepWriteMutex
            ? {}
            : { leaseOwner: null, leaseUntil: null, writeMarker: null, writePhase: null, writeStartedAt: null })
        }
      })
      return changed.count === 1
    })
  }

  async advancePending(
    projectionId: string,
    generation: bigint,
    fallbackNextAttemptAt: Date
  ): Promise<CodeHostRunProjectionRecord | null> {
    return this.transaction(async (tx) => {
      const current = await this.lockById(tx, projectionId)
      if (
        !current ||
        current.generation !== generation ||
        current.writePhase !== null ||
        current.writeMarker !== null ||
        current.pendingIntent === null
      )
        return null
      const pending = parsePendingIntent(current.pendingIntent)
      if (!pending) return null
      // Cleanup strictness is one-way: a tombstoned row drains only its own cleanup intent.
      if (current.tombstonedAt !== null && pending.tombstoned !== true) return null
      const encoded = pending.nextAttemptAt ? new Date(pending.nextAttemptAt) : fallbackNextAttemptAt
      const nextAttemptAt = Number.isNaN(encoded.getTime()) ? fallbackNextAttemptAt : encoded
      const nextGeneration = generation + 1n
      const changed = await tx.codeHostRunProjection.updateMany({
        where: { id: projectionId, generation, writePhase: null, writeMarker: null },
        data: {
          generation: nextGeneration,
          desiredState: pending.desiredState,
          reason: pending.reason ?? null,
          ...(isTerminalNoteState(pending.desiredState) ? { sealedThrough: nextGeneration } : {}),
          observedState: null,
          nextAttemptAt,
          attempts: 0,
          lastErrorCode: null,
          pendingIntent: Prisma.DbNull,
          ...(pending.currentDeliveryKey !== undefined ? { currentDeliveryKey: pending.currentDeliveryKey } : {}),
          ...(pending.currentRunAt ? { currentRunAt: new Date(pending.currentRunAt) } : {}),
          // The parked edge's OWN placement and credential fence: draining must never dispatch the
          // new generation to the daemon or credential epoch the in-flight write belonged to.
          ...pendingFenceUpdate(pending)
        }
      })
      if (changed.count !== 1) return null
      const fresh = await tx.codeHostRunProjection.findUnique({ where: { id: projectionId } })
      return fresh ? toRecord(fresh) : null
    })
  }

  async get(projectionId: string): Promise<CodeHostRunProjectionRecord | null> {
    const row = await this.db.codeHostRunProjection.findUnique({ where: { id: projectionId } })
    return row ? toRecord(row) : null
  }
}

/** Row lock shared with every projection mutation, so cleanup serializes against an in-flight write. */
async function lockProjectionById(tx: Prisma.TransactionClient, id: string): Promise<CodeHostRunProjection | null> {
  const rows = await tx.$queryRaw<CodeHostRunProjection[]>(Prisma.sql`
    SELECT * FROM "code_host_run_projection" WHERE "id" = ${id}::uuid FOR UPDATE
  `)
  return rows[0] ?? null
}

/**
 * One-way cleanup intent, callable INSIDE the transaction that retires the owner rows.
 *
 * The ledger has no foreign keys — cleanup must outlive hook, agent, and organization rows — so the
 * intent has to be committed by the same transaction that removes ownership, never by a best-effort
 * call afterwards. Hook deletion, the agent cascade, and the organization sweep all land here.
 */
export async function tombstoneCodeHostRunProjections(
  tx: Prisma.TransactionClient,
  scope: { hookIds: readonly string[] } | { orgId: string },
  at: Date
): Promise<number> {
  const where = 'orgId' in scope ? { orgId: scope.orgId } : { hookId: { in: [...new Set(scope.hookIds)] } }
  if ('hookIds' in scope && scope.hookIds.length === 0) return 0
  const rows = await tx.codeHostRunProjection.findMany({ where, select: { id: true } })
  let changed = 0
  // Deterministic id order: hook deletion, the agent cascade, and organization deletion overlap.
  for (const { id } of [...rows].sort((a, b) => a.id.localeCompare(b.id))) {
    const row = await lockProjectionById(tx, id)
    if (!row || row.tombstonedAt !== null) continue
    if (row.writePhase !== null) {
      // A cleanup tombstone must not stomp a mutex someone is mid-writing; it rides as pending.
      await tx.codeHostRunProjection.update({
        where: { id: row.id },
        data: {
          tombstonedAt: at,
          pendingIntent: { desiredState: 'skipped', tombstoned: true, nextAttemptAt: at.toISOString() },
          nextAttemptAt: at
        }
      })
      changed += 1
      continue
    }
    const nextGeneration = row.generation + 1n
    await tx.codeHostRunProjection.update({
      where: { id: row.id },
      data: {
        tombstonedAt: at,
        generation: nextGeneration,
        desiredState: 'skipped',
        sealedThrough: nextGeneration,
        observedState: null,
        nextAttemptAt: at,
        attempts: 0,
        lastErrorCode: null,
        pendingIntent: Prisma.DbNull,
        leaseOwner: null,
        leaseUntil: null
      }
    })
    changed += 1
  }
  return changed
}
