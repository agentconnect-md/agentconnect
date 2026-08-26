/**
 * PgHookRepo — inbound-webhook trigger definitions + run metadata
 * (webhook-triggers-and-github-events.md). The CP owns the definitions and
 * compiles them into relay rules; event payloads never land in these tables.
 *
 * Run lifecycle is two-stage: the relay's `rc/run-report` opens the row
 * (`recordDelivery`) and the daemon's `hook/report` completion closes it
 * (`recordReport`, scoped like cron reports). (hookId, deliveryKey) is the
 * idempotency key absorbing GitHub redeliveries and reconcile re-posts.
 */
import {
  HOOK_DELIVERY_REASON_DISPATCH_TIMEOUT,
  HOOK_DELIVERY_REASON_REVIEW_REQUEST_REQUIRED,
  RETRYABLE_HOOK_DELIVERY_REASONS,
  isGithubPullRequestRevisionEvent,
  isRetryableHookDeliveryReason,
  normalizeGitUrl,
  type Platform
} from '@agentconnect.md/protocol'
import { randomUUID } from 'node:crypto'
import type {
  HookDef,
  HookReviewProjection,
  HookReviewSubject,
  HookRun,
  PrismaClient,
  User
} from '../../generated/prisma/client.js'
import { Prisma } from '../../generated/prisma/client.js'
import type { PrismaLike } from '../prisma.js'
import { tombstoneCodeHostRunProjections } from './code-host-projection.repo.js'
import type {
  HookRepo,
  HookRecord,
  HookRunRecord,
  HookDeliveryInput,
  HookDeliveryRecordResult,
  GithubRepoFullNameRefreshResult,
  GithubCommentFamily,
  HookReportInput,
  HookStartInput,
  HookReviewAttemptInput,
  HookReviewAttemptResult,
  HookReviewResultInput,
  HookReviewProjectionRecord,
  HookReviewSubjectRecord,
  UpsertHookReviewProjectionInput,
  ProjectionWriteResultInput,
  HookSecretStore,
  UpsertHookInput
} from '../ports.js'
import { toDbPlatform } from '../platform.js'
import type { SecretCipher } from '../../secrets/cipher.js'
import { orgScope } from '../../secrets/scope.js'
import { AgentId, HookId, IntegrationId, OrgId, type DaemonId } from '../../domain/ids.js'
import { PLACEMENT_ONLY, type PlacementResolver, type ResolvableAgent } from '../../orchestrator/placementResolver.js'
import { ORPHANED_RUN_REASON } from './cron.repo.js'
import {
  lockHookReviewAgentLifecycleScope,
  lockHookReviewAgentRepoScope,
  lockHookReviewLifecycleScope,
  lockHookReviewOrgLifecycleScope,
  lockHookReviewOrgProducerScope
} from '../review-projection-lock.js'
import { authoritativeHookProjectionState } from '../../github/projection-state.js'
import { AgentWorkspaceIntegrationConflict, HookMissing } from '../errors.js'
import { bumpAgentConfigRevisions } from './organization-environment-fence.js'
import { joinAxisFence } from './gitlab-axis.js'

type HookWithUsers = HookDef & {
  createdBy: User | null
  lastModifiedBy: User | null
  // A boolean-shaped presence probe — `select: { hookId: true }` only, so the
  // secret material itself can never ride a list/read query.
  secret: { hookId: string } | null
}
const withUsers = { createdBy: true, lastModifiedBy: true, secret: { select: { hookId: true } } } as const

function toRecord(h: HookWithUsers): HookRecord {
  return {
    id: HookId(h.id),
    orgId: OrgId(h.orgId),
    agentId: h.agentId ? AgentId(h.agentId) : null,
    kind: h.kind,
    name: h.name,
    enabled: h.enabled,
    sessionMode: h.sessionMode,
    urlToken: h.urlToken,
    hmacConfigured: h.secret !== null,
    repoId: h.repoId,
    repoFullName: h.repoFullName,
    githubSessionKey: h.githubSessionKey,
    family: h.family,
    events: h.events,
    commentFamilies: h.commentFamilies as GithubCommentFamily[],
    labelFilter: h.labelFilter,
    mentionOnly: h.mentionOnly,
    configRevision: h.configRevision,
    dispatchRevision: h.dispatchRevision,
    projectionEpoch: h.projectionEpoch,
    reviewPolicy: h.reviewPolicy,
    reportingMode: h.reportingMode,
    gateMode: h.gateMode,
    requiredAcknowledgedAt: h.requiredAcknowledgedAt,
    requiredAcknowledgedByUserId: h.requiredAcknowledgedByUserId,
    requiredAcknowledgedConfigRevision: h.requiredAcknowledgedConfigRevision,
    targetPlatform: h.targetPlatform as Platform,
    targetChannel: h.targetChannel,
    targetIntegrationId: h.targetIntegrationId ? IntegrationId(h.targetIntegrationId) : null,
    lastFiredAt: h.lastFiredAt,
    createdBy: h.createdBy
      ? { userId: h.createdBy.id, displayName: h.createdBy.displayName, email: h.createdBy.email }
      : null,
    createdByUserId: h.createdByUserId,
    createdAt: h.createdAt,
    lastModifiedAt: h.lastModifiedAt,
    lastModifiedBy: h.lastModifiedBy
      ? { userId: h.lastModifiedBy.id, displayName: h.lastModifiedBy.displayName, email: h.lastModifiedBy.email }
      : null
  }
}

function toRunRecord(r: HookRun): HookRunRecord {
  return {
    id: r.id,
    hookId: HookId(r.hookId),
    orgId: OrgId(r.orgId),
    deliveryKey: r.deliveryKey,
    event: r.event,
    agentId: r.agentId ? AgentId(r.agentId) : null,
    configRevision: r.configRevision,
    dispatchRevision: r.dispatchRevision,
    projectionEpoch: r.projectionEpoch,
    dispatchDaemonId: r.dispatchDaemonId ? (r.dispatchDaemonId as DaemonId) : null,
    reviewPolicySnapshot: r.reviewPolicySnapshot,
    reportingModeSnapshot: r.reportingModeSnapshot,
    gateModeSnapshot: r.gateModeSnapshot,
    projectionIntent: r.projectionIntent as HookRunRecord['projectionIntent'],
    repoId: r.repoId,
    repoFullName: r.repoFullName,
    sourceInstallationId: r.sourceInstallationId,
    subjectKind: r.subjectKind,
    pullNumber: r.pullNumber,
    headSha: r.headSha,
    baseSha: r.baseSha,
    reportSha: r.reportSha,
    isDraft: r.isDraft,
    baseChanged: r.baseChanged,
    startedAt: r.startedAt,
    turnStartedAt: r.turnStartedAt,
    completedAt: r.completedAt,
    orphanedAt: r.orphanedAt,
    projectionId: r.projectionId,
    projectionGeneration: r.projectionGeneration,
    reviewAttemptId: r.reviewAttemptId,
    reviewAttemptState: r.reviewAttemptState,
    reviewErrorCode: r.reviewErrorCode,
    reviewId: r.reviewId,
    reviewEvent: r.reviewEvent as HookRunRecord['reviewEvent'],
    verdict: r.verdict as HookRunRecord['verdict'],
    reviewCommitId: r.reviewCommitId,
    publishedCommentKind: r.publishedCommentKind as HookRunRecord['publishedCommentKind'],
    publishedCommentId: r.publishedCommentId,
    status: r.status,
    durationMs: r.durationMs,
    sessionId: r.sessionId,
    reason: r.reason,
    redeliveryAttempts: r.redeliveryAttempts,
    redeliveryLastRequestedAt: r.redeliveryLastRequestedAt,
    redeliveryNextAttemptAt: r.redeliveryNextAttemptAt
  }
}

function toProjectionRecord(r: HookReviewProjection): HookReviewProjectionRecord {
  return {
    id: r.id,
    hookId: HookId(r.hookId),
    orgId: OrgId(r.orgId),
    agentId: AgentId(r.agentId),
    agentName: r.agentName,
    lastResolvedInstallationId: r.lastResolvedInstallationId,
    repoId: r.repoId,
    repoFullName: r.repoFullName,
    headSha: r.headSha,
    reportSha: r.reportSha,
    projectionEpoch: r.projectionEpoch,
    generation: r.generation,
    currentHookRunId: r.currentHookRunId,
    externalId: r.externalId,
    checkRunId: r.checkRunId,
    mode: r.mode,
    gateMode: r.gateMode,
    desiredState: r.desiredState,
    observedState: r.observedState,
    sealedThrough: r.sealedThrough,
    subjectSyncGeneration: r.subjectSyncGeneration,
    subjectSyncErrorCode: r.subjectSyncErrorCode,
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

function toSubjectRecord(r: HookReviewSubject): HookReviewSubjectRecord {
  return {
    projectionId: r.projectionId,
    pullNumber: r.pullNumber,
    headSha: r.headSha,
    baseSha: r.baseSha,
    isOpen: r.isOpen,
    updatedAt: r.updatedAt
  }
}

function pendingCurrentHookRunId(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const id = (value as Record<string, unknown>).currentHookRunId
  return typeof id === 'string' ? id : null
}

function pendingDesiredState(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const state = (value as Record<string, unknown>).desiredState
  return typeof state === 'string' ? state : null
}

function isStrictlyNewerRun(
  incoming: { id: string; startedAt: Date },
  incumbent: { id: string; startedAt: Date }
): boolean {
  const byTime = incoming.startedAt.getTime() - incumbent.startedAt.getTime()
  return byTime > 0 || (byTime === 0 && incoming.id.localeCompare(incumbent.id) > 0)
}

function isTerminalProjectionState(state: string): boolean {
  return state !== 'queued' && state !== 'in_progress'
}

function isProjectionDesiredState(state: string): boolean {
  return (
    state === 'queued' ||
    state === 'in_progress' ||
    state === 'success' ||
    state === 'action_required' ||
    state === 'neutral' ||
    state === 'skipped' ||
    state === 'failure' ||
    state === 'timed_out'
  )
}

function submittedReviewProjectionState(
  run: Pick<HookRun, 'projectionIntent' | 'reviewAttemptState' | 'reviewEvent' | 'verdict'>
): string | null {
  if (run.reviewAttemptState !== 'submitted') return null
  if (run.reviewEvent === 'REQUEST_CHANGES' || run.verdict === 'fail') return 'action_required'
  if (run.verdict === 'pass') return 'success'
  if (run.projectionIntent === 'review_action_only') return null
  if (run.verdict === 'neutral') return 'neutral'
  return null
}

/** Shared proof that a failed delivery has not crossed daemon execution or any
 * GitHub review/check side-effect barrier. */
function isSideEffectFreeFailedDeliveryStage(run: HookRun): boolean {
  return (
    run.status === 'failed' &&
    isRetryableHookDeliveryReason(run.reason) &&
    run.turnStartedAt === null &&
    run.orphanedAt === null &&
    run.durationMs === null &&
    run.sessionId === null &&
    run.reviewAttemptId === null &&
    run.reviewAttemptState === null &&
    run.reviewErrorCode === null &&
    run.reviewId === null &&
    run.reviewEvent === null &&
    run.verdict === null &&
    run.reviewCommitId === null &&
    run.publishedCommentKind === null &&
    run.publishedCommentId === null
  )
}

/** Scheduling eligibility: the durable due gate remains active. */
function isRetryableFailedDeliveryStage(run: HookRun): boolean {
  return (
    isSideEffectFreeFailedDeliveryStage(run) &&
    run.projectionId === null &&
    run.projectionGeneration === null &&
    run.redeliveryNextAttemptAt !== null
  )
}

/** Convergence eligibility outlives the scheduling gate. A cap/expiry/fanout
 * settlement may clear nextAttemptAt while an already admitted daemon still
 * owns a durable start or completion receipt. */
function isClaimedFailedDeliveryStage(run: HookRun): boolean {
  return (
    isSideEffectFreeFailedDeliveryStage(run) && run.redeliveryAttempts > 0 && run.redeliveryLastRequestedAt !== null
  )
}

type HookRunMetadataInput = Pick<
  HookStartInput,
  | 'sessionId'
  | 'projectionIntent'
  | 'repoId'
  | 'repoFullName'
  | 'sourceInstallationId'
  | 'subjectKind'
  | 'pullNumber'
  | 'headSha'
  | 'baseSha'
  | 'reportSha'
  | 'isDraft'
  | 'baseChanged'
>

/** Incoming trusted metadata may fill a legacy/null slot, but it may never
 * reinterpret a value already attached to this delivery GUID. */
function hookRunMetadataIsConsistent(run: HookRun, incoming: HookRunMetadataInput): boolean {
  const consistent = <T>(stored: T | null, value: T | undefined): boolean =>
    value === undefined || stored === null || stored === value
  return (
    consistent(run.sessionId, incoming.sessionId) &&
    consistent(run.projectionIntent, incoming.projectionIntent) &&
    consistent(run.repoId, incoming.repoId) &&
    consistent(run.repoFullName, incoming.repoFullName) &&
    consistent(run.sourceInstallationId, incoming.sourceInstallationId) &&
    consistent(run.subjectKind, incoming.subjectKind) &&
    consistent(run.pullNumber, incoming.pullNumber) &&
    consistent(run.headSha, incoming.headSha) &&
    consistent(run.baseSha, incoming.baseSha) &&
    consistent(run.reportSha, incoming.reportSha) &&
    consistent(run.isDraft, incoming.isDraft) &&
    consistent(run.baseChanged, incoming.baseChanged)
  )
}

const DURABLE_GITHUB_REDELIVERY_EVENTS = new Set([
  'issues',
  'pull_request',
  'issue_comment',
  'pull_request_review_comment',
  'push'
])
/** Only ordinary GitHub webhook families can be reconstructed from the App's
 * delivery list. Generic webhooks and Check rererequests use the Relay's short
 * retry only; scheduling them here would create a gate no reconciler can own. */
function supportsDurableGithubRedelivery(event: string | null | undefined): boolean {
  const family = event?.split(':', 1)[0]
  return family !== undefined && DURABLE_GITHUB_REDELIVERY_EVENTS.has(family)
}

async function lockHookDeliveryRedeliveryScope(tx: Prisma.TransactionClient, deliveryKey: string): Promise<void> {
  const key = JSON.stringify(['hook-delivery-redelivery', deliveryKey])
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0)) IS NULL AS "locked"
  `)
}

async function lockGithubRepoIdentityScope(tx: Prisma.TransactionClient, orgId: OrgId, repoId: bigint): Promise<void> {
  const key = JSON.stringify(['github-repo-identity', orgId, repoId.toString()])
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0)) IS NULL AS "locked"
  `)
}

/** The placement columns a dispatch fence reads. A `set` agent leaves `daemonId` null, so the
 *  resolver — not a join — is the only thing that can name who serves it. */
const PLACEMENT_REF_SELECT = { placementKind: true, daemonId: true, setId: true } as const

/** Who may act for one hook's agent, resolved BEFORE the fenced transaction: asking the duty
 *  ledger while holding one would trade a pooled connection for a lock. `agentId` is what the hook
 *  named at resolve time, and every fence re-reads it in the transaction, so this cannot widen. */
interface HookDispatchAuthority {
  agentId: string | null
  /** The resolver's view of the agent, kept for the callers that also need a dispatch target. */
  ref: ResolvableAgent | null
  /** Placement ∪ live duty holders. */
  serving: readonly string[]
}

const NO_AUTHORITY: HookDispatchAuthority = { agentId: null, ref: null, serving: [] }

/** May `daemonId` act for this hook, given the agent the transaction actually reads? */
function servedBy(
  authority: HookDispatchAuthority,
  agentId: string | null,
  daemonId: string | null | undefined
): boolean {
  return agentId !== null && agentId === authority.agentId && !!daemonId && authority.serving.includes(daemonId)
}

/** May `reportingDaemonId` close a run of `agentId` that was dispatched to `dispatchDaemonId`?
 *  The accepted dispatch target is a provenance snapshot, not the fence: a pool member can be
 *  retired mid-run, and the member that serves the agent afterwards reclaims the completion. */
function mayReport(
  authority: HookDispatchAuthority,
  agentId: string | null,
  reportingDaemonId: string,
  dispatchDaemonId: string | null | undefined
): boolean {
  return dispatchDaemonId === reportingDaemonId || servedBy(authority, agentId, reportingDaemonId)
}

export class PgHookRepo implements HookRepo {
  constructor(
    private readonly db: PrismaLike,
    /** Absent (tests, or a deployment with no member set) ⇒ placement alone, the pre-duty behavior. */
    private readonly placement: Pick<PlacementResolver, 'servingDaemons' | 'routableDaemon'> = PLACEMENT_ONLY
  ) {}

  /** Resolve one hook's dispatch authority. Called outside the fenced transaction. */
  private async dispatchAuthority(hookId: HookId): Promise<HookDispatchAuthority> {
    const hook = await this.db.hookDef.findUnique({
      where: { id: hookId },
      select: { agentId: true, agent: { select: PLACEMENT_REF_SELECT } }
    })
    if (!hook?.agentId || !hook.agent) return NO_AUTHORITY
    const ref = { ...hook.agent, id: hook.agentId }
    return { agentId: hook.agentId, ref, serving: await this.placement.servingDaemons(ref) }
  }

  private transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>, options?: { timeout?: number }): Promise<T> {
    if ('$transaction' in this.db) return (this.db as PrismaClient).$transaction(fn, options)
    return fn(this.db as Prisma.TransactionClient)
  }

  private async lockAgentLifecycleScopes(
    tx: Prisma.TransactionClient,
    agentIds: readonly (AgentId | null | undefined)[]
  ): Promise<Set<string>> {
    const ids = [...new Set(agentIds.filter((id): id is AgentId => id !== null && id !== undefined))].sort()
    for (const agentId of ids) await lockHookReviewAgentLifecycleScope(tx, agentId)
    return new Set(ids)
  }

  /**
   * Projection mutations that decide marker/generation/tombstone ordering must
   * share this row lock. The natural-key advisory lock still serializes the
   * no-row create case; once a row exists, `FOR UPDATE` is the bridge used by
   * id-addressed worker mutations and scope-addressed cleanup.
   */
  private async lockReviewProjectionById(
    tx: Prisma.TransactionClient,
    projectionId: string
  ): Promise<HookReviewProjection | null> {
    const rows = await tx.$queryRaw<HookReviewProjection[]>(Prisma.sql`
      SELECT *
      FROM "hook_review_projection"
      WHERE "id" = ${projectionId}::uuid
      FOR UPDATE
    `)
    return rows[0] ?? null
  }

  private async lockReviewProjectionByNaturalKey(
    tx: Prisma.TransactionClient,
    hookId: HookId,
    repoId: bigint,
    reportSha: string,
    projectionEpoch: bigint
  ): Promise<HookReviewProjection | null> {
    const rows = await tx.$queryRaw<HookReviewProjection[]>(Prisma.sql`
      SELECT *
      FROM "hook_review_projection"
      WHERE "hookId" = ${hookId}::uuid
        AND "repoId" = ${repoId}
        AND "reportSha" = ${reportSha}
        AND "projectionEpoch" = ${projectionEpoch}
      FOR UPDATE
    `)
    return rows[0] ?? null
  }

  private async lockHookRunById(tx: Prisma.TransactionClient, runId: string): Promise<HookRun | null> {
    const rows = await tx.$queryRaw<HookRun[]>(Prisma.sql`
      SELECT *
      FROM "hook_run"
      WHERE "id" = ${runId}
      FOR UPDATE
    `)
    return rows[0] ?? null
  }

  async upsert(input: UpsertHookInput): Promise<HookRecord> {
    const data = {
      orgId: input.orgId,
      agentId: input.agentId,
      kind: input.kind,
      name: input.name,
      sessionMode: input.sessionMode,
      // github kind: the route re-sends the full block on every write (repo
      // re-target allowed); webhook kind never sends it, and these stay null/[].
      repoId: input.repoId ?? null,
      repoFullName: input.repoFullName ?? null,
      // Immutable: an update never carries it, so omission must preserve the row's own.
      ...(input.family !== undefined ? { family: input.family } : {}),
      events: input.events ?? [],
      commentFamilies: input.commentFamilies ?? [],
      labelFilter: input.labelFilter ?? [],
      mentionOnly: input.mentionOnly ?? false,
      targetPlatform: toDbPlatform(input.targetPlatform ?? 'slack'),
      targetChannel: input.targetChannel ?? null,
      targetIntegrationId: input.targetIntegrationId ?? null,
      enabled: input.enabled ?? true
    }
    // Read an owner hint before entering the critical section. If a concurrent
    // rebind makes it stale, the transaction exits without writing and retries
    // with the newly observed owner. This keeps the lock order agent(s) -> hook
    // while covering both sides of a hook rebind.
    let ownerHint =
      input.expectedAgentId ??
      (await this.db.hookDef.findUnique({ where: { id: input.hookId }, select: { agentId: true } }))?.agentId
    const expectedOwnerForMutation = input.expectedAgentId ?? (ownerHint ? AgentId(ownerHint) : undefined)
    for (;;) {
      const result = await this.transaction(async (tx) => {
        // New HookDefs participate in the outer org-deletion fence before the
        // existing agent -> hook order. This also avoids a parent-FK row-lock /
        // agent advisory-lock inversion with concurrent org deletion.
        await lockHookReviewOrgProducerScope(tx, input.orgId)
        // §24.1: `repoId` is a host-relative GitLab project id, and a hook that
        // will not be enabled takes no binding lease, so this is its only fence.
        if (input.kind === 'gitlab') {
          if (!input.axisBaseUrl) throw new Error('gitlab hook write is missing its axis base url')
          await joinAxisFence(tx, input.axisBaseUrl)
        }
        const lockedAgentIds = await this.lockAgentLifecycleScopes(tx, [
          ownerHint ? AgentId(ownerHint) : null,
          input.agentId
        ])
        await lockHookReviewLifecycleScope(tx, input.hookId)
        const existing = await tx.hookDef.findUnique({ where: { id: input.hookId } })
        // Tenancy fence (org-scoped-data-layer.md §3), under the same lock as
        // the write it guards: an id that already names a row in another
        // organization must not fall through to the update branch, which
        // rewrites `orgId` and `agentId` along with the definition.
        if (existing && existing.orgId !== input.orgId) throw new HookMissing(input.hookId)
        if (existing?.agentId && !lockedAgentIds.has(existing.agentId)) {
          return { kind: 'retry', owner: AgentId(existing.agentId) } as const
        }
        if (input.kind === 'github' && input.repoId !== undefined) {
          await lockHookReviewAgentRepoScope(tx, input.agentId, input.repoId)
          const nextEnabled = input.enabled ?? true
          const nextReviewPolicy = input.reviewPolicy ?? existing?.reviewPolicy ?? 'off'
          const nextReportingMode = input.reportingMode ?? existing?.reportingMode ?? 'off'
          if (nextEnabled && (nextReviewPolicy !== 'off' || nextReportingMode !== 'off')) {
            const owner = await tx.agent.findUnique({
              where: { id: input.agentId },
              select: { workspaceMode: true, workspaceRepoId: true, gitAccess: true }
            })
            if (
              owner?.workspaceMode === 'github' &&
              owner.workspaceRepoId === input.repoId &&
              owner.gitAccess === 'read'
            ) {
              throw new AgentWorkspaceIntegrationConflict(input.repoId)
            }
          }
        }
        const nextReportingMode = input.reportingMode ?? existing?.reportingMode ?? 'off'
        const nextGateMode = input.gateMode ?? existing?.gateMode ?? 'informational'
        // Sibling family rows of one (agent, repo) answer the same threads, so
        // they must share one session namespace — including a grandfathered
        // owner/repo prefix, which a freshly minted numeric key would diverge from.
        const siblingKeyRow =
          input.kind === 'github' && input.repoId !== undefined && existing?.repoId !== input.repoId
            ? await tx.hookDef.findFirst({
                where: { id: { not: input.hookId }, agentId: input.agentId, kind: 'github', repoId: input.repoId },
                select: { githubSessionKey: true, repoFullName: true },
                orderBy: { createdAt: 'asc' }
              })
            : null
        const githubSessionKey =
          input.kind === 'github' && input.repoId !== undefined
            ? existing?.kind === 'github' && existing.repoId === input.repoId
              ? (existing.githubSessionKey ?? existing.repoFullName ?? `github:${input.repoId}`)
              : (siblingKeyRow?.githubSessionKey ?? siblingKeyRow?.repoFullName ?? `github:${input.repoId}`)
            : null
        const lifecycleChanged =
          existing !== null &&
          (existing.agentId !== input.agentId ||
            existing.repoId !== (input.repoId ?? null) ||
            existing.enabled !== (input.enabled ?? true) ||
            existing.reportingMode !== nextReportingMode ||
            existing.gateMode !== nextGateMode)
        const now = new Date()

        // Cleanup is part of the same hook-level critical section as the binding
        // mutation. A concurrent projection create either commits first and is
        // observed here, or waits and receives the new projection epoch.
        if (lifecycleChanged) {
          const projections = await tx.hookReviewProjection.findMany({ where: { hookId: input.hookId } })
          await this.tombstoneProjectionRows(tx, projections, now, 'failure')
        }

        // urlToken is minted once on CREATE and immutable after — an edit must
        // never rotate the capability URL out from under configured senders.
        const create = {
          id: input.hookId,
          ...data,
          githubSessionKey,
          ...(input.urlToken ? { urlToken: input.urlToken } : {}),
          ...(input.createdByUserId ? { createdByUserId: input.createdByUserId } : {}),
          ...(input.lastModifiedByUserId ? { lastModifiedByUserId: input.lastModifiedByUserId } : {}),
          reviewPolicy: input.reviewPolicy ?? 'off',
          reportingMode: input.reportingMode ?? 'off',
          gateMode: input.gateMode ?? 'informational',
          ...(input.requiredAcknowledgedAt !== undefined
            ? { requiredAcknowledgedAt: input.requiredAcknowledgedAt }
            : {}),
          ...(input.requiredAcknowledgedByUserId !== undefined
            ? { requiredAcknowledgedByUserId: input.requiredAcknowledgedByUserId }
            : {}),
          ...(input.requiredAcknowledgedConfigRevision !== undefined
            ? { requiredAcknowledgedConfigRevision: input.requiredAcknowledgedConfigRevision }
            : {})
        }
        const update = {
          ...data,
          githubSessionKey,
          configRevision: { increment: 1 },
          dispatchRevision: { increment: 1 },
          ...(lifecycleChanged ? { projectionEpoch: { increment: 1 } } : {}),
          ...(input.reviewPolicy !== undefined ? { reviewPolicy: input.reviewPolicy } : {}),
          ...(input.reportingMode !== undefined ? { reportingMode: input.reportingMode } : {}),
          ...(input.gateMode !== undefined ? { gateMode: input.gateMode } : {}),
          ...(input.requiredAcknowledgedAt !== undefined
            ? { requiredAcknowledgedAt: input.requiredAcknowledgedAt }
            : {}),
          ...(input.requiredAcknowledgedByUserId !== undefined
            ? { requiredAcknowledgedByUserId: input.requiredAcknowledgedByUserId }
            : {}),
          ...(input.requiredAcknowledgedConfigRevision !== undefined
            ? { requiredAcknowledgedConfigRevision: input.requiredAcknowledgedConfigRevision }
            : {}),
          lastModifiedAt: now,
          ...(input.lastModifiedByUserId ? { lastModifiedByUserId: input.lastModifiedByUserId } : {})
        }
        // The HTTP update path supplies its previously observed owner. Use an
        // update-only CAS so Agent deletion winning this lock race cannot turn a
        // stale rebind into a fresh HookDef under another still-live agent.
        const h = expectedOwnerForMutation
          ? await tx.hookDef.update({
              where: { id: input.hookId, agentId: expectedOwnerForMutation },
              data: update,
              include: withUsers
            })
          : await tx.hookDef.upsert({ where: { id: input.hookId }, create, update, include: withUsers })
        return { kind: 'done', hook: toRecord(h) } as const
      })
      if (result.kind === 'done') return result.hook
      ownerHint = result.owner
    }
  }

  async remove(orgId: OrgId, hookId: HookId, expectedAgentId?: AgentId): Promise<void> {
    let ownerHint =
      expectedAgentId ??
      (await this.db.hookDef.findUnique({ where: { id: hookId }, select: { agentId: true } }))?.agentId
    const expectedOwnerForMutation = expectedAgentId ?? (ownerHint ? AgentId(ownerHint) : undefined)
    for (;;) {
      const result = await this.transaction(async (tx) => {
        const lockedAgentIds = await this.lockAgentLifecycleScopes(tx, [ownerHint ? AgentId(ownerHint) : null])
        await lockHookReviewLifecycleScope(tx, hookId)
        const hook = await tx.hookDef.findUnique({ where: { id: hookId }, select: { agentId: true, orgId: true } })
        // Org fence BEFORE the projection tombstones: reaching those with a
        // foreign id would tear down another organization's durable Check
        // projections and only then fail on the delete (§3).
        if (hook && hook.orgId !== orgId) throw new HookMissing(hookId)
        if (hook?.agentId && !lockedAgentIds.has(hook.agentId)) {
          return { kind: 'retry', owner: AgentId(hook.agentId) } as const
        }
        const projections = await tx.hookReviewProjection.findMany({ where: { hookId } })
        const deletedAt = new Date()
        await this.tombstoneProjectionRows(tx, projections, deletedAt, 'failure')
        // The §16 ledger has no FK to this row, so its cleanup intent must commit with the delete.
        await tombstoneCodeHostRunProjections(tx, { hookIds: [hookId] }, deletedAt)
        await tx.hookDef.delete({
          where: { id: hookId, orgId, ...(expectedOwnerForMutation ? { agentId: expectedOwnerForMutation } : {}) }
        })
        return { kind: 'done' } as const
      })
      if (result.kind === 'done') return
      ownerHint = result.owner
    }
  }

  async get(orgId: OrgId, hookId: HookId): Promise<HookRecord | null> {
    // The org filter rides the unique lookup (extended where): a cross-org id
    // is indistinguishable from a missing row (org-scoped-data-layer.md §3).
    const h = await this.db.hookDef.findUnique({ where: { id: hookId, orgId }, include: withUsers })
    return h ? toRecord(h) : null
  }

  async getUnscoped(hookId: HookId): Promise<HookRecord | null> {
    const h = await this.db.hookDef.findUnique({ where: { id: hookId }, include: withUsers })
    return h ? toRecord(h) : null
  }

  async getMany(orgId: OrgId, hookIds: HookId[]): Promise<HookRecord[]> {
    if (hookIds.length === 0) return []
    // Ids outside the org drop out of the result exactly like unknown ones.
    const rows = await this.db.hookDef.findMany({ where: { id: { in: hookIds }, orgId }, include: withUsers })
    return rows.map(toRecord)
  }

  async getManyUnscoped(hookIds: HookId[]): Promise<HookRecord[]> {
    if (hookIds.length === 0) return []
    const rows = await this.db.hookDef.findMany({ where: { id: { in: hookIds } }, include: withUsers })
    return rows.map(toRecord)
  }

  async listEnabled(): Promise<HookRecord[]> {
    // The relay-register full-replay source: every enabled hook across every org
    // (the relay pool is deployment-level infra). Legacy inert rows compile to null.
    const rows = await this.db.hookDef.findMany({
      where: { enabled: true },
      include: withUsers,
      orderBy: { createdAt: 'asc' }
    })
    return rows.map(toRecord)
  }

  async listForAgent(agentId: AgentId): Promise<HookRecord[]> {
    const rows = await this.db.hookDef.findMany({
      where: { agentId },
      include: withUsers,
      orderBy: { createdAt: 'asc' }
    })
    return rows.map(toRecord)
  }

  async kindsByAgent(orgId: OrgId): Promise<Map<string, HookRecord['kind'][]>> {
    const rows = await this.db.hookDef.groupBy({
      by: ['agentId', 'kind'],
      where: { orgId, enabled: true, agentId: { not: null } }
    })
    const map = new Map<string, HookRecord['kind'][]>()
    for (const row of rows) {
      if (!row.agentId) continue
      const kinds = map.get(row.agentId) ?? []
      kinds.push(row.kind)
      map.set(row.agentId, kinds)
    }
    return map
  }

  async listForOrgKind(orgId: OrgId, kind: HookRecord['kind']): Promise<HookRecord[]> {
    const rows = await this.db.hookDef.findMany({
      where: { orgId, kind },
      include: withUsers,
      orderBy: { createdAt: 'asc' }
    })
    return rows.map(toRecord)
  }

  async listIdsForOrgKind(orgId: OrgId, kind: HookRecord['kind']): Promise<HookId[]> {
    const rows = await this.db.hookDef.findMany({ where: { orgId, kind }, select: { id: true } })
    return rows.map((row) => HookId(row.id))
  }

  async recordDelivery(hookId: HookId, r: HookDeliveryInput): Promise<boolean> {
    return (await this.recordDeliveryResult(hookId, r)).accepted
  }

  async recordDeliveryResult(hookId: HookId, r: HookDeliveryInput): Promise<HookDeliveryRecordResult> {
    const authority = await this.dispatchAuthority(hookId)
    return this.transaction(async (tx) => {
      // Organization deletion takes this lock before its final HookRun sweep.
      // Serialize both legacy and fenced delivery creation with that sweep so
      // the FK-less history table cannot gain a post-delete orphan.
      await lockHookReviewLifecycleScope(tx, hookId)
      await lockHookDeliveryRedeliveryScope(tx, r.deliveryKey)
      const existing = await tx.hookRun.findUnique({
        where: { hookId_deliveryKey: { hookId, deliveryKey: r.deliveryKey } }
      })
      const hasFence =
        r.agentId !== undefined &&
        r.configRevision !== undefined &&
        r.dispatchRevision !== undefined &&
        r.dispatchDaemonId !== undefined

      // Ordinary duplicates remain first-report-wins forever. The only
      // exception is a failed, side-effect-free delivery-stage row carrying a
      // shared-protocol retryable reason.
      if (existing && !isRetryableFailedDeliveryStage(existing)) {
        return { accepted: true, newlyObserved: false }
      }

      if (existing && r.status === 'failed') {
        const receivedReason = r.reason ?? 'delivery failed'
        const current = hasFence
          ? await tx.hookDef.findUnique({
              where: { id: hookId },
              select: {
                agentId: true,
                configRevision: true,
                dispatchRevision: true,
                projectionEpoch: true
              }
            })
          : null
        const matchesCurrent =
          current !== null &&
          current.agentId === r.agentId &&
          current.configRevision === r.configRevision &&
          current.dispatchRevision === r.dispatchRevision &&
          servedBy(authority, current.agentId, r.dispatchDaemonId)
        const preservesTriggerAuthority = existing.agentId === r.agentId && existing.configRevision === r.configRevision
        const remainsRetryable =
          hasFence &&
          isRetryableHookDeliveryReason(receivedReason) &&
          matchesCurrent &&
          preservesTriggerAuthority &&
          supportsDurableGithubRedelivery(r.event ?? existing.event)
        await tx.hookDef.updateMany({
          where: { id: hookId, OR: [{ lastFiredAt: null }, { lastFiredAt: { lt: r.firedAt } }] },
          data: { lastFiredAt: r.firedAt }
        })
        await tx.hookRun.update({
          where: { id: existing.id },
          data: {
            event: r.event ?? existing.event,
            startedAt: r.firedAt,
            completedAt: r.firedAt,
            reason: receivedReason,
            ...(hasFence
              ? {
                  agentId: r.agentId,
                  configRevision: r.configRevision,
                  dispatchRevision: r.dispatchRevision,
                  projectionEpoch: matchesCurrent ? current!.projectionEpoch : null,
                  dispatchDaemonId: r.dispatchDaemonId,
                  reviewPolicySnapshot: r.reviewPolicySnapshot ?? null,
                  reportingModeSnapshot: r.reportingModeSnapshot ?? null,
                  gateModeSnapshot: r.gateModeSnapshot ?? null,
                  projectionIntent: r.projectionIntent ?? null,
                  repoId: r.repoId ?? null,
                  repoFullName: r.repoFullName ?? null,
                  sourceInstallationId: r.sourceInstallationId ?? null,
                  subjectKind: r.subjectKind ?? null,
                  pullNumber: r.pullNumber ?? null,
                  headSha: r.headSha ?? null,
                  baseSha: r.baseSha ?? null,
                  reportSha: r.reportSha ?? null,
                  isDraft: r.isDraft ?? null,
                  baseChanged: r.baseChanged ?? null
                }
              : {}),
            // A claimed retry already carries its durable due time. Preserve
            // that gate on another transient failure; a terminal/nonretryable
            // delivery verdict removes the row from the queue immediately.
            redeliveryNextAttemptAt: remainsRetryable ? (existing.redeliveryNextAttemptAt ?? r.firedAt) : null
          }
        })
        return { accepted: true, newlyObserved: false }
      }

      const hook = await tx.hookDef.findUnique({
        where: { id: hookId },
        select: {
          id: true,
          orgId: true,
          agentId: true,
          configRevision: true,
          dispatchRevision: true,
          projectionEpoch: true,
          reviewPolicy: true,
          reportingMode: true,
          gateMode: true
        }
      })
      if (!hook) return { accepted: false, newlyObserved: false }

      // A full R1/R2a accepted tuple is authoritative only when it exactly
      // matches current compiled config + placement. Rolling legacy reports are
      // still retained as history, but their null tuple cannot authorize effects.
      // Reopening an existing failed row is an authority transition, so unlike
      // a rolling-version first delivery it requires the complete current
      // dispatch tuple. This ensures a late completion from the old placement
      // loses the normal recordReport fences.
      if (existing && r.status === 'accepted' && !hasFence) {
        return { accepted: false, newlyObserved: false }
      }
      if (
        isRetryableHookDeliveryReason(existing?.reason) &&
        (existing.agentId !== r.agentId || existing.configRevision !== r.configRevision)
      )
        return { accepted: false, newlyObserved: false }
      if (
        r.status === 'accepted' &&
        hasFence &&
        (hook.agentId !== r.agentId ||
          hook.configRevision !== r.configRevision ||
          hook.dispatchRevision !== r.dispatchRevision ||
          !servedBy(authority, hook.agentId, r.dispatchDaemonId) ||
          (r.reviewPolicySnapshot !== undefined && hook.reviewPolicy !== r.reviewPolicySnapshot) ||
          (r.reportingModeSnapshot !== undefined && hook.reportingMode !== r.reportingModeSnapshot) ||
          (r.gateModeSnapshot !== undefined && hook.gateMode !== r.gateModeSnapshot))
      ) {
        return { accepted: false, newlyObserved: false }
      }

      await tx.hookDef.updateMany({
        where: { id: hookId, OR: [{ lastFiredAt: null }, { lastFiredAt: { lt: r.firedAt } }] },
        data: { lastFiredAt: r.firedAt }
      })

      if (existing) {
        await tx.hookRun.update({
          where: { id: existing.id },
          data: {
            event: r.event ?? null,
            startedAt: r.firedAt,
            agentId: r.agentId!,
            configRevision: r.configRevision!,
            dispatchRevision: r.dispatchRevision!,
            projectionEpoch: hook.projectionEpoch,
            dispatchDaemonId: r.dispatchDaemonId!,
            reviewPolicySnapshot: r.reviewPolicySnapshot ?? null,
            reportingModeSnapshot: r.reportingModeSnapshot ?? null,
            gateModeSnapshot: r.gateModeSnapshot ?? null,
            projectionIntent: r.projectionIntent ?? null,
            repoId: r.repoId ?? null,
            repoFullName: r.repoFullName ?? null,
            sourceInstallationId: r.sourceInstallationId ?? null,
            subjectKind: r.subjectKind ?? null,
            pullNumber: r.pullNumber ?? null,
            headSha: r.headSha ?? null,
            baseSha: r.baseSha ?? null,
            reportSha: r.reportSha ?? null,
            isDraft: r.isDraft ?? null,
            baseChanged: r.baseChanged ?? null,
            turnStartedAt: null,
            completedAt: null,
            orphanedAt: null,
            reviewAttemptId: null,
            reviewAttemptState: null,
            reviewErrorCode: null,
            reviewId: null,
            reviewEvent: null,
            verdict: null,
            reviewCommitId: null,
            publishedCommentKind: null,
            publishedCommentId: null,
            status: 'running',
            durationMs: null,
            sessionId: null,
            reason: null,
            redeliveryNextAttemptAt: null
          }
        })
      } else {
        await tx.hookRun.create({
          data: {
            hookId,
            orgId: hook.orgId,
            deliveryKey: r.deliveryKey,
            event: r.event ?? null,
            startedAt: r.firedAt,
            ...(r.agentId ? { agentId: r.agentId } : {}),
            ...(r.configRevision !== undefined ? { configRevision: r.configRevision } : {}),
            ...(r.dispatchRevision !== undefined ? { dispatchRevision: r.dispatchRevision } : {}),
            ...(hasFence ? { projectionEpoch: hook.projectionEpoch } : {}),
            ...(r.dispatchDaemonId ? { dispatchDaemonId: r.dispatchDaemonId } : {}),
            ...(r.reviewPolicySnapshot ? { reviewPolicySnapshot: r.reviewPolicySnapshot } : {}),
            ...(r.reportingModeSnapshot ? { reportingModeSnapshot: r.reportingModeSnapshot } : {}),
            ...(r.gateModeSnapshot ? { gateModeSnapshot: r.gateModeSnapshot } : {}),
            ...(r.projectionIntent ? { projectionIntent: r.projectionIntent } : {}),
            ...(r.repoId !== undefined ? { repoId: r.repoId } : {}),
            ...(r.repoFullName ? { repoFullName: r.repoFullName } : {}),
            ...(r.sourceInstallationId !== undefined ? { sourceInstallationId: r.sourceInstallationId } : {}),
            ...(r.subjectKind ? { subjectKind: r.subjectKind } : {}),
            ...(r.pullNumber !== undefined ? { pullNumber: r.pullNumber } : {}),
            ...(r.headSha ? { headSha: r.headSha } : {}),
            ...(r.baseSha ? { baseSha: r.baseSha } : {}),
            ...(r.reportSha ? { reportSha: r.reportSha } : {}),
            ...(r.isDraft !== undefined ? { isDraft: r.isDraft } : {}),
            ...(r.baseChanged !== undefined ? { baseChanged: r.baseChanged } : {}),
            ...(r.status === 'failed'
              ? {
                  status: 'failed' as const,
                  completedAt: r.firedAt,
                  reason: r.reason ?? 'delivery failed',
                  ...(hasFence && isRetryableHookDeliveryReason(r.reason) && supportsDurableGithubRedelivery(r.event)
                    ? { redeliveryNextAttemptAt: r.firedAt }
                    : {})
                }
              : {})
          }
        })
      }
      return { accepted: true, newlyObserved: existing === null }
    })
  }

  async refreshGithubRepoFullName(
    sourceHookId: HookId,
    repoId: bigint,
    repoFullName: string,
    observedAt: Date
  ): Promise<GithubRepoFullNameRefreshResult> {
    return this.transaction(async (tx) => {
      await lockHookReviewLifecycleScope(tx, sourceHookId)
      const source = await tx.hookDef.findFirst({
        where: { id: sourceHookId, kind: 'github', repoId },
        select: { orgId: true }
      })
      if (!source) return { hooks: [], agentIds: [] }

      const orgId = OrgId(source.orgId)
      await lockGithubRepoIdentityScope(tx, orgId, repoId)
      const freshest = await tx.hookDef.findFirst({
        where: { orgId, kind: 'github', repoId, lastFiredAt: { not: null } },
        orderBy: { lastFiredAt: 'desc' },
        select: { lastFiredAt: true }
      })
      // The caller admits only newly observed delivery keys. Equality then
      // fences concurrent first observations so an older payload cannot land
      // after a newer canonical name.
      if (freshest?.lastFiredAt?.getTime() !== observedAt.getTime()) return { hooks: [], agentIds: [] }

      const changed = await tx.hookDef.findMany({
        where: { orgId, kind: 'github', repoId, repoFullName: { not: repoFullName } },
        select: { id: true, name: true, repoFullName: true }
      })
      await tx.hookDef.updateMany({
        where: { id: { in: changed.map((hook) => hook.id) } },
        data: { repoFullName }
      })
      const autoNamedHookIds = changed
        .filter((hook) => hook.repoFullName && hook.name.toLowerCase() === hook.repoFullName.toLowerCase())
        .map((hook) => hook.id)
      if (autoNamedHookIds.length > 0) {
        await tx.hookDef.updateMany({
          where: { id: { in: autoNamedHookIds } },
          data: { name: repoFullName }
        })
      }
      // The grants carry the renamed display name into `workspace.additionalRepos`, so their
      // owners join the same configuration-ordering domain — and the same convergence fan-out —
      // as the workspace agents below. Read the owners BEFORE the write erases the predicate.
      // Provider-qualified: a GitLab project carrying this same number is a different
      // repository, and a GitHub rename must never overwrite its path (§8.1).
      const renamedGrants = { provider: 'github', repoId, agent: { orgId }, repoFullName: { not: repoFullName } }
      const renamedGrantAgentIds = [
        ...new Set(
          (await tx.agentRepoAuthorization.findMany({ where: renamedGrants, select: { agentId: true } })).map(
            (row) => row.agentId
          )
        )
      ]
      await tx.agentRepoAuthorization.updateMany({ where: renamedGrants, data: { repoFullName } })
      await bumpAgentConfigRevisions(tx, renamedGrantAgentIds)
      const gitRepo = normalizeGitUrl(repoFullName)
      const workspaceWhere = {
        orgId,
        workspaceMode: 'github',
        workspaceRepoId: repoId,
        installationId: { not: null },
        OR: [{ gitRepo: null }, { gitRepo: { not: gitRepo } }]
      } satisfies Prisma.AgentWhereInput
      const changedAgents = await tx.agent.findMany({
        where: workspaceWhere,
        orderBy: { id: 'asc' },
        select: { id: true }
      })
      if (changedAgents.length > 0) {
        await tx.agent.updateMany({
          // Repeat the identity predicate in the write itself: a concurrent
          // cold workspace switch after findMany must not receive this URL.
          where: { ...workspaceWhere, id: { in: changedAgents.map((agent) => agent.id) } },
          // `gitRepo` rides AgentSpec.workspace, so a rename repair joins the
          // agent's single configuration-ordering domain
          // (organization-secrets-and-variables.md §5).
          data: { gitRepo, configRevision: { increment: 1 } }
        })
      }
      const hooks =
        changed.length === 0
          ? []
          : (
              await tx.hookDef.findMany({
                where: { id: { in: changed.map((hook) => hook.id) } },
                include: withUsers
              })
            ).map(toRecord)
      // Both kinds of renamed agent need the live push: the workspace URL and the grant's
      // display name are two fields of the SAME spec, and an owner left out here keeps the
      // stale name on every connected daemon until it reconnects.
      const renamedAgentIds = [...new Set([...changedAgents.map((agent) => agent.id), ...renamedGrantAgentIds])].sort()
      return { hooks, agentIds: renamedAgentIds.map((id) => AgentId(id)) }
    })
  }

  async getRun(hookId: HookId, deliveryKey: string): Promise<HookRunRecord | null> {
    const row = await this.db.hookRun.findUnique({ where: { hookId_deliveryKey: { hookId, deliveryKey } } })
    return row ? toRunRecord(row) : null
  }

  async getRunById(runId: string): Promise<HookRunRecord | null> {
    const row = await this.db.hookRun.findUnique({ where: { id: runId } })
    return row ? toRunRecord(row) : null
  }

  // The PR run owning one session (§3.4): org-fenced, PR-subject rows only, newest first (redelivery).
  async latestPullRequestRunForSession(orgId: OrgId, sessionId: string): Promise<HookRunRecord | null> {
    const row = await this.db.hookRun.findFirst({
      where: { orgId, sessionId, subjectKind: 'pull_request', pullNumber: { not: null } },
      orderBy: { startedAt: 'desc' }
    })
    return row ? toRunRecord(row) : null
  }

  async listRunsNeedingReviewProjection(limit = 100): Promise<HookRunRecord[]> {
    const take = Math.max(1, Math.min(limit, 500))
    // There is intentionally no FK from HookRun to HookReviewProjection (the
    // latter must survive hook/agent deletion for cleanup). A natural-key join
    // lets the periodic repair loop detect all crash windows: before projection
    // creation, before binding, and after a lifecycle mutation but before its
    // desired-state convergence. DISTINCT ON prevents an older redelivery for
    // the same hook/repo/SHA from fighting the current revision.
    const rows = await this.db.$queryRaw<HookRun[]>(Prisma.sql`
      WITH latest AS (
        SELECT DISTINCT ON (r."hookId", r."repoId", r."reportSha", r."projectionEpoch") r.*
        FROM "hook_run" r
        INNER JOIN "hook_def" h
          ON h.id = r."hookId"
         AND h.enabled = true
         AND h."agentId" = r."agentId"
         AND h."projectionEpoch" = r."projectionEpoch"
         AND h."reportingMode"::text = 'check'
         AND h."gateMode"::text = 'informational'
        INNER JOIN "agent" a
          ON a.id = r."agentId"
        WHERE r."reportingModeSnapshot"::text = 'check'
          AND r."gateModeSnapshot"::text = 'informational'
          AND r."agentId" IS NOT NULL
          AND r."repoId" IS NOT NULL
          AND r."repoFullName" IS NOT NULL
          AND r."reportSha" IS NOT NULL
          AND r."subjectKind" = 'pull_request'
          AND r."pullNumber" IS NOT NULL
          AND r."headSha" IS NOT NULL
          AND r."baseSha" IS NOT NULL
          AND r."configRevision" IS NOT NULL
          AND r."projectionEpoch" IS NOT NULL
          AND r."dispatchRevision" IS NOT NULL
          AND r."dispatchDaemonId" IS NOT NULL
          -- Keep retryable pre-dispatch failures effect-free until their retry budget settles.
          AND NOT (
            r.status::text = 'failed'
            AND r.reason IN (${Prisma.join(RETRYABLE_HOOK_DELIVERY_REASONS)})
            AND r."redeliveryNextAttemptAt" IS NOT NULL
          )
          AND (
            r."projectionIntent" = 'revision_event'
            OR (
              r."projectionIntent" = 'review_action_only'
              AND r."reviewAttemptState" = 'submitted'
              AND r.verdict IN ('pass', 'fail')
            )
          )
        ORDER BY r."hookId", r."repoId", r."reportSha", r."projectionEpoch", r."startedAt" DESC, r.id DESC
      ), expected AS (
        SELECT latest.*,
          CASE
            WHEN latest."reviewAttemptState" = 'submitted' AND latest."reviewEvent" = 'REQUEST_CHANGES'
              THEN 'action_required'
            WHEN latest."reviewAttemptState" = 'submitted' AND latest.verdict = 'pass'
              THEN 'success'
            WHEN latest."reviewAttemptState" = 'submitted' AND latest.verdict = 'fail'
              THEN 'action_required'
            WHEN latest."reviewAttemptState" = 'submitted' AND latest.verdict = 'neutral'
              THEN 'neutral'
            WHEN latest."projectionIntent" = 'review_action_only'
              THEN NULL
            WHEN latest."reviewErrorCode" IS NOT NULL
              THEN 'failure'
            WHEN latest."orphanedAt" IS NOT NULL
              THEN 'timed_out'
            WHEN latest.status::text = 'success'
              THEN 'neutral'
            WHEN latest.status::text = 'failed'
              THEN 'skipped'
            WHEN latest."turnStartedAt" IS NOT NULL
              THEN 'in_progress'
            ELSE 'queued'
          END AS "expectedState"
        FROM latest
      )
      SELECT expected.*
      FROM expected
      LEFT JOIN "hook_review_projection" p
        ON p."hookId" = expected."hookId"
       AND p."repoId" = expected."repoId"
       AND p."reportSha" = expected."reportSha"
       AND p."projectionEpoch" = expected."projectionEpoch"
      WHERE expected."expectedState" IS NOT NULL
        AND p."tombstonedAt" IS NULL
        AND (
          p.id IS NULL
          OR expected."projectionId" IS DISTINCT FROM p.id
          OR expected."projectionGeneration" IS DISTINCT FROM p.generation
          OR p."currentHookRunId" IS DISTINCT FROM expected.id
          OR p."desiredState" IS DISTINCT FROM expected."expectedState"
          OR NOT EXISTS (
            SELECT 1
            FROM "hook_review_subject" s
            WHERE s."projectionId" = p.id
              AND s."pullNumber" = expected."pullNumber"
              AND s."headSha" = expected."headSha"
              AND s."baseSha" IS NOT DISTINCT FROM expected."baseSha"
              AND s."isOpen" = true
          )
        )
      ORDER BY expected."startedAt" ASC, expected.id ASC
      LIMIT ${take}
    `)
    return rows.map(toRunRecord)
  }

  async recordStart(hookId: HookId, reportingDaemonId: DaemonId, r: HookStartInput): Promise<boolean> {
    const authority = await this.dispatchAuthority(hookId)
    return this.transaction(async (tx) => {
      await lockHookReviewLifecycleScope(tx, hookId)
      await lockHookDeliveryRedeliveryScope(tx, r.deliveryKey)
      const found = await tx.hookRun.findUnique({
        where: { hookId_deliveryKey: { hookId, deliveryKey: r.deliveryKey } }
      })
      if (!found) return false
      const run = await this.lockHookRunById(tx, found.id)
      if (!run) return false

      // The daemon admission can win while the Relay's accepted report is
      // A claimed side-effect-free failure may use exact-current hook/start as the missing accepted report.
      if (isClaimedFailedDeliveryStage(run)) {
        const current = await tx.hookDef.findUnique({
          where: { id: hookId },
          select: {
            enabled: true,
            kind: true,
            agentId: true,
            repoId: true,
            repoFullName: true,
            configRevision: true,
            dispatchRevision: true,
            projectionEpoch: true,
            reviewPolicy: true,
            reportingMode: true,
            gateMode: true,
            agent: { select: { status: true } }
          }
        })
        if (
          !current ||
          !current.enabled ||
          current.kind !== 'github' ||
          current.agentId !== r.agentId ||
          current.configRevision !== r.configRevision ||
          current.dispatchRevision !== r.dispatchRevision ||
          !servedBy(authority, current.agentId, r.dispatchDaemonId) ||
          current.agent?.status !== 'active' ||
          reportingDaemonId !== r.dispatchDaemonId ||
          run.agentId !== r.agentId ||
          run.configRevision !== r.configRevision ||
          r.reviewPolicySnapshot === undefined ||
          current.reviewPolicy !== r.reviewPolicySnapshot ||
          r.reportingModeSnapshot === undefined ||
          current.reportingMode !== r.reportingModeSnapshot ||
          r.gateModeSnapshot === undefined ||
          current.gateMode !== r.gateModeSnapshot ||
          (r.repoId !== undefined && current.repoId !== r.repoId) ||
          (r.repoFullName !== undefined && current.repoFullName !== r.repoFullName) ||
          !hookRunMetadataIsConsistent(run, r)
        )
          return false

        const reopened = await tx.hookRun.updateMany({
          where: {
            id: run.id,
            status: 'failed',
            reason: { in: [...RETRYABLE_HOOK_DELIVERY_REASONS] },
            redeliveryAttempts: { gt: 0 },
            redeliveryLastRequestedAt: { not: null },
            turnStartedAt: null,
            orphanedAt: null,
            durationMs: null,
            sessionId: null,
            reviewAttemptId: null,
            reviewAttemptState: null,
            reviewErrorCode: null,
            reviewId: null,
            reviewEvent: null,
            verdict: null,
            reviewCommitId: null,
            publishedCommentKind: null,
            publishedCommentId: null
          },
          data: {
            status: 'running',
            agentId: r.agentId,
            configRevision: r.configRevision,
            dispatchRevision: r.dispatchRevision,
            projectionEpoch: current.projectionEpoch,
            dispatchDaemonId: r.dispatchDaemonId,
            reviewPolicySnapshot: r.reviewPolicySnapshot,
            reportingModeSnapshot: r.reportingModeSnapshot,
            gateModeSnapshot: r.gateModeSnapshot,
            turnStartedAt: r.startedAt,
            completedAt: null,
            orphanedAt: null,
            durationMs: null,
            sessionId: null,
            reason: null,
            redeliveryNextAttemptAt: null,
            ...(r.projectionIntent !== undefined ? { projectionIntent: r.projectionIntent } : {}),
            ...(r.repoId !== undefined ? { repoId: r.repoId } : {}),
            ...(r.repoFullName !== undefined ? { repoFullName: r.repoFullName } : {}),
            ...(r.sourceInstallationId !== undefined ? { sourceInstallationId: r.sourceInstallationId } : {}),
            ...(r.subjectKind !== undefined ? { subjectKind: r.subjectKind } : {}),
            ...(r.pullNumber !== undefined ? { pullNumber: r.pullNumber } : {}),
            ...(r.headSha !== undefined ? { headSha: r.headSha } : {}),
            ...(r.baseSha !== undefined ? { baseSha: r.baseSha } : {}),
            ...(r.reportSha !== undefined ? { reportSha: r.reportSha } : {}),
            ...(r.isDraft !== undefined ? { isDraft: r.isDraft } : {}),
            ...(r.baseChanged !== undefined ? { baseChanged: r.baseChanged } : {})
          }
        })
        return reopened.count === 1
      }

      if (
        run.agentId !== r.agentId ||
        run.configRevision !== r.configRevision ||
        run.dispatchRevision !== r.dispatchRevision ||
        run.dispatchDaemonId !== r.dispatchDaemonId ||
        reportingDaemonId !== r.dispatchDaemonId
      )
        return false

      const exact = <T>(stored: T | null, incoming: T | undefined): boolean =>
        incoming === undefined || stored === incoming
      const exactStart = (candidate: HookRun): boolean =>
        candidate.turnStartedAt?.getTime() === r.startedAt.getTime() &&
        exact(candidate.sessionId, r.sessionId) &&
        exact(candidate.projectionIntent, r.projectionIntent) &&
        exact(candidate.repoId, r.repoId) &&
        exact(candidate.repoFullName, r.repoFullName) &&
        exact(candidate.sourceInstallationId, r.sourceInstallationId) &&
        exact(candidate.subjectKind, r.subjectKind) &&
        exact(candidate.pullNumber, r.pullNumber) &&
        exact(candidate.headSha, r.headSha) &&
        exact(candidate.baseSha, r.baseSha) &&
        exact(candidate.reportSha, r.reportSha) &&
        exact(candidate.isDraft, r.isDraft) &&
        exact(candidate.baseChanged, r.baseChanged)

      // A duplicate whose exact barrier is already durable is idempotent even
      // if the turn completed while its ACK was in flight. A terminal row with
      // no matching barrier is never mutated by a late first start.
      if (run.turnStartedAt !== null) return exactStart(run)
      if (run.status !== 'running') return false
      if (!hookRunMetadataIsConsistent(run, r)) return false

      // Every nullable start field participates in the write predicate. Two
      // concurrent starts can therefore only fill the same value, and a
      // completion that wins after the read makes this update lose its
      // status=running CAS instead of writing a start barrier onto history.
      const nullableFences: Prisma.HookRunWhereInput[] = [
        { OR: [{ turnStartedAt: null }, { turnStartedAt: r.startedAt }] },
        ...(r.sessionId !== undefined ? [{ OR: [{ sessionId: null }, { sessionId: r.sessionId }] }] : []),
        ...(r.projectionIntent !== undefined
          ? [{ OR: [{ projectionIntent: null }, { projectionIntent: r.projectionIntent }] }]
          : []),
        ...(r.repoId !== undefined ? [{ OR: [{ repoId: null }, { repoId: r.repoId }] }] : []),
        ...(r.repoFullName !== undefined ? [{ OR: [{ repoFullName: null }, { repoFullName: r.repoFullName }] }] : []),
        ...(r.sourceInstallationId !== undefined
          ? [{ OR: [{ sourceInstallationId: null }, { sourceInstallationId: r.sourceInstallationId }] }]
          : []),
        ...(r.subjectKind !== undefined ? [{ OR: [{ subjectKind: null }, { subjectKind: r.subjectKind }] }] : []),
        ...(r.pullNumber !== undefined ? [{ OR: [{ pullNumber: null }, { pullNumber: r.pullNumber }] }] : []),
        ...(r.headSha !== undefined ? [{ OR: [{ headSha: null }, { headSha: r.headSha }] }] : []),
        ...(r.baseSha !== undefined ? [{ OR: [{ baseSha: null }, { baseSha: r.baseSha }] }] : []),
        ...(r.reportSha !== undefined ? [{ OR: [{ reportSha: null }, { reportSha: r.reportSha }] }] : []),
        ...(r.isDraft !== undefined ? [{ OR: [{ isDraft: null }, { isDraft: r.isDraft }] }] : []),
        ...(r.baseChanged !== undefined ? [{ OR: [{ baseChanged: null }, { baseChanged: r.baseChanged }] }] : [])
      ]
      const started = await tx.hookRun.updateMany({
        where: { id: run.id, status: 'running', AND: nullableFences },
        data: {
          turnStartedAt: r.startedAt,
          ...(r.sessionId !== undefined ? { sessionId: r.sessionId } : {}),
          ...(r.projectionIntent !== undefined ? { projectionIntent: r.projectionIntent } : {}),
          ...(r.repoId !== undefined ? { repoId: r.repoId } : {}),
          ...(r.repoFullName !== undefined ? { repoFullName: r.repoFullName } : {}),
          ...(r.sourceInstallationId !== undefined ? { sourceInstallationId: r.sourceInstallationId } : {}),
          ...(r.subjectKind !== undefined ? { subjectKind: r.subjectKind } : {}),
          ...(r.pullNumber !== undefined ? { pullNumber: r.pullNumber } : {}),
          ...(r.headSha !== undefined ? { headSha: r.headSha } : {}),
          ...(r.baseSha !== undefined ? { baseSha: r.baseSha } : {}),
          ...(r.reportSha !== undefined ? { reportSha: r.reportSha } : {}),
          ...(r.isDraft !== undefined ? { isDraft: r.isDraft } : {}),
          ...(r.baseChanged !== undefined ? { baseChanged: r.baseChanged } : {})
        }
      })
      if (started.count === 1) return true

      // The only successful loser is an exact duplicate whose winner already
      // persisted the barrier (and may also have completed the turn). Any
      // mismatched fill or completion-first terminal remains rejected.
      const persisted = await tx.hookRun.findUnique({ where: { id: run.id } })
      return persisted !== null && exactStart(persisted)
    })
  }

  async reserveReviewAttempt(
    hookId: HookId,
    reportingDaemonId: DaemonId,
    r: HookReviewAttemptInput
  ): Promise<HookReviewAttemptResult> {
    return this.transaction(async (tx) => {
      const run = await tx.hookRun.findUnique({
        where: { hookId_deliveryKey: { hookId, deliveryKey: r.deliveryKey } }
      })
      if (
        !run ||
        run.status !== 'running' ||
        run.turnStartedAt === null ||
        run.agentId !== r.agentId ||
        run.configRevision !== r.configRevision ||
        run.dispatchRevision !== r.dispatchRevision ||
        run.dispatchDaemonId !== r.dispatchDaemonId ||
        reportingDaemonId !== r.dispatchDaemonId
      )
        return 'rejected'
      if (run.reviewAttemptId === r.attemptId) {
        return (run.reviewAttemptState === 'reserved' || run.reviewAttemptState === 'blocked') &&
          run.reviewEvent === r.requestedEvent &&
          run.verdict === r.requestedVerdict
          ? 'idempotent'
          : 'rejected'
      }
      if (run.reviewAttemptId !== null) return 'rejected'
      const reserved = await tx.hookRun.updateMany({
        where: { id: run.id, reviewAttemptId: null, status: 'running' },
        data: {
          reviewAttemptId: r.attemptId,
          reviewAttemptState: 'reserved',
          reviewEvent: r.requestedEvent,
          verdict: r.requestedVerdict
        }
      })
      return reserved.count === 1 ? 'reserved' : 'rejected'
    })
  }

  async recordReviewResult(hookId: HookId, reportingDaemonId: DaemonId, r: HookReviewResultInput): Promise<boolean> {
    return this.transaction(async (tx) => {
      const run = await tx.hookRun.findUnique({
        where: { hookId_deliveryKey: { hookId, deliveryKey: r.deliveryKey } }
      })
      if (!run || run.dispatchDaemonId !== reportingDaemonId || run.reviewAttemptId !== r.attemptId) return false
      if (run.reviewAttemptState === 'submitted') {
        if (r.state !== 'submitted') return true
        return (
          run.reviewId === r.reviewId &&
          run.reviewEvent === r.event &&
          run.verdict === r.verdict &&
          run.reviewCommitId === r.commitId
        )
      }
      if (r.state === 'released') {
        const released = await tx.hookRun.updateMany({
          where: {
            id: run.id,
            reviewAttemptId: r.attemptId,
            reviewAttemptState: { in: ['reserved', 'blocked'] }
          },
          data: {
            reviewAttemptId: null,
            reviewAttemptState: null,
            reviewEvent: null,
            verdict: null,
            reviewErrorCode: r.code ?? null
          }
        })
        return released.count === 1
      }
      if (
        r.state === 'submitted' &&
        (!r.reviewId || !r.event || !r.verdict || !r.commitId || run.headSha !== r.commitId)
      )
        return false
      const updated = await tx.hookRun.updateMany({
        where: {
          id: run.id,
          reviewAttemptId: r.attemptId,
          reviewAttemptState: { in: ['reserved', 'blocked'] },
          ...(r.state === 'submitted' ? { reviewEvent: r.event, verdict: r.verdict } : {})
        },
        data: {
          reviewAttemptState: r.state,
          reviewErrorCode: r.code ?? null,
          ...(r.reviewId ? { reviewId: r.reviewId } : {}),
          ...(r.event ? { reviewEvent: r.event } : {}),
          ...(r.verdict ? { verdict: r.verdict } : {}),
          ...(r.commitId ? { reviewCommitId: r.commitId } : {})
        }
      })
      if (updated.count === 1 && r.state === 'submitted' && run.projectionId && run.projectionGeneration !== null) {
        const desiredState = submittedReviewProjectionState({
          projectionIntent: run.projectionIntent,
          reviewAttemptState: 'submitted',
          reviewEvent: r.event ?? null,
          verdict: r.verdict ?? null
        })
        if (desiredState) {
          await tx.hookReviewProjection.updateMany({
            where: { id: run.projectionId, generation: run.projectionGeneration, tombstonedAt: null },
            data: {
              desiredState,
              sealedThrough: run.projectionGeneration,
              nextAttemptAt: new Date()
            }
          })
        }
      }
      return updated.count === 1
    })
  }

  async recordReport(hookId: HookId, reportingDaemonId: DaemonId, r: HookReportInput, at: Date): Promise<boolean> {
    const authority = await this.dispatchAuthority(hookId)
    return this.transaction(async (tx) => {
      // Completion-first recovery can create a FK-less HookRun row. Share the
      // hook lifecycle lock with organization deletion so its final metadata
      // sweep is closed against that no-row case.
      await lockHookReviewLifecycleScope(tx, hookId)
      await lockHookDeliveryRedeliveryScope(tx, r.deliveryKey)
      const found = await tx.hookRun.findUnique({
        where: { hookId_deliveryKey: { hookId, deliveryKey: r.deliveryKey } }
      })
      let run = found ? await this.lockHookRunById(tx, found.id) : null
      if (!run) {
        // Completion-first recovery is accepted only from a daemon that currently serves the
        // hook's agent; when a full tuple is present it must also match current hook fences.
        const hookRow = await tx.hookDef.findUnique({
          where: { id: hookId },
          select: {
            orgId: true,
            agentId: true,
            kind: true,
            enabled: true,
            repoId: true,
            configRevision: true,
            dispatchRevision: true,
            projectionEpoch: true,
            reviewPolicy: true,
            reportingMode: true,
            gateMode: true
          }
        })
        const hook = hookRow && servedBy(authority, hookRow.agentId, reportingDaemonId) ? hookRow : null
        // A GitHub review token can only have been authorized against an
        // existing HookRun reservation, so completion-first may never invent
        // review metadata.
        const requiresProjectionFence = r.projectionIntent !== undefined && r.projectionIntent !== 'none'
        if (
          !hook ||
          r.reviewAttemptId !== undefined ||
          r.reviewId !== undefined ||
          r.reviewEvent !== undefined ||
          r.verdict !== undefined ||
          r.reviewCommitId !== undefined ||
          (requiresProjectionFence &&
            (hook.kind !== 'github' ||
              !hook.enabled ||
              hook.repoId === null ||
              r.repoId !== hook.repoId ||
              r.headSha === undefined ||
              r.reportSha !== r.headSha ||
              r.agentId === undefined ||
              r.configRevision === undefined ||
              r.dispatchRevision === undefined ||
              r.dispatchDaemonId === undefined ||
              r.reviewPolicySnapshot === undefined ||
              r.reportingModeSnapshot === undefined ||
              r.gateModeSnapshot === undefined))
        )
          return false
        if (
          (r.agentId !== undefined && hook.agentId !== r.agentId) ||
          (r.configRevision !== undefined && hook.configRevision !== r.configRevision) ||
          (r.dispatchRevision !== undefined && hook.dispatchRevision !== r.dispatchRevision) ||
          (r.reviewPolicySnapshot !== undefined && hook.reviewPolicy !== r.reviewPolicySnapshot) ||
          (r.reportingModeSnapshot !== undefined && hook.reportingMode !== r.reportingModeSnapshot) ||
          (r.gateModeSnapshot !== undefined && hook.gateMode !== r.gateModeSnapshot)
        )
          return false
        run = await tx.hookRun.create({
          data: {
            hookId,
            orgId: hook.orgId,
            deliveryKey: r.deliveryKey,
            event: r.event ?? null,
            startedAt: new Date(at.getTime() - (r.durationMs ?? 0)),
            ...(r.agentId ? { agentId: r.agentId } : hook.agentId ? { agentId: hook.agentId } : {}),
            configRevision: r.configRevision ?? hook.configRevision,
            dispatchRevision: r.dispatchRevision ?? hook.dispatchRevision,
            projectionEpoch: hook.projectionEpoch,
            dispatchDaemonId: r.dispatchDaemonId ?? reportingDaemonId,
            reviewPolicySnapshot: r.reviewPolicySnapshot ?? hook.reviewPolicy,
            reportingModeSnapshot: r.reportingModeSnapshot ?? hook.reportingMode,
            gateModeSnapshot: r.gateModeSnapshot ?? hook.gateMode,
            ...(r.projectionIntent ? { projectionIntent: r.projectionIntent } : {}),
            ...(r.repoId !== undefined ? { repoId: r.repoId } : {}),
            ...(r.repoFullName ? { repoFullName: r.repoFullName } : {}),
            ...(r.sourceInstallationId !== undefined ? { sourceInstallationId: r.sourceInstallationId } : {}),
            ...(r.subjectKind ? { subjectKind: r.subjectKind } : {}),
            ...(r.pullNumber !== undefined ? { pullNumber: r.pullNumber } : {}),
            ...(r.headSha ? { headSha: r.headSha } : {}),
            ...(r.baseSha ? { baseSha: r.baseSha } : {}),
            ...(r.reportSha ? { reportSha: r.reportSha } : {}),
            ...(r.isDraft !== undefined ? { isDraft: r.isDraft } : {}),
            ...(r.baseChanged !== undefined ? { baseChanged: r.baseChanged } : {}),
            status: r.status,
            completedAt: at,
            durationMs: r.durationMs ?? null,
            sessionId: r.sessionId ?? null,
            reason: r.reason ?? null,
            ...(r.publishedComment
              ? {
                  publishedCommentKind: r.publishedComment.kind,
                  publishedCommentId: r.publishedComment.commentId
                }
              : {}),
            ...(r.reviewAttemptId
              ? r.reviewAttemptState === 'released'
                ? {
                    reviewAttemptId: null,
                    reviewAttemptState: null,
                    reviewEvent: null,
                    reviewErrorCode: r.reviewErrorCode ?? null
                  }
                : {
                    reviewAttemptId: r.reviewAttemptId,
                    reviewAttemptState: r.reviewAttemptState ?? (r.reviewId ? 'submitted' : 'blocked'),
                    reviewErrorCode: r.reviewErrorCode ?? null
                  }
              : {}),
            ...(r.reviewAttemptState !== 'released' && r.reviewId ? { reviewId: r.reviewId } : {}),
            ...(r.reviewAttemptState !== 'released' && r.reviewEvent ? { reviewEvent: r.reviewEvent } : {}),
            ...(r.reviewAttemptState !== 'released' && r.verdict ? { verdict: r.verdict } : {}),
            ...(r.reviewAttemptState !== 'released' && r.reviewCommitId ? { reviewCommitId: r.reviewCommitId } : {})
          }
        })
      } else {
        // A complete claimed/current fence can close a side-effect-free retryable row with its missing accepted edge.
        if (isClaimedFailedDeliveryStage(run)) {
          if (
            r.agentId === undefined ||
            r.configRevision === undefined ||
            r.dispatchRevision === undefined ||
            r.dispatchDaemonId === undefined ||
            r.reviewPolicySnapshot === undefined ||
            r.reportingModeSnapshot === undefined ||
            r.gateModeSnapshot === undefined ||
            !mayReport(authority, run.agentId, reportingDaemonId, r.dispatchDaemonId) ||
            run.agentId !== r.agentId ||
            run.configRevision !== r.configRevision ||
            (run.event !== null && r.event !== undefined && run.event !== r.event) ||
            !hookRunMetadataIsConsistent(run, r) ||
            r.reviewAttemptId !== undefined ||
            r.reviewAttemptState !== undefined ||
            r.reviewErrorCode !== undefined ||
            r.reviewId !== undefined ||
            r.reviewEvent !== undefined ||
            r.verdict !== undefined ||
            r.reviewCommitId !== undefined
          )
            return false

          const matchesClaimedDispatch =
            run.dispatchRevision === r.dispatchRevision &&
            run.dispatchDaemonId === r.dispatchDaemonId &&
            run.reviewPolicySnapshot === r.reviewPolicySnapshot &&
            run.reportingModeSnapshot === r.reportingModeSnapshot &&
            run.gateModeSnapshot === r.gateModeSnapshot &&
            run.projectionEpoch !== null

          let projectionEpoch = run.projectionEpoch
          if (!matchesClaimedDispatch) {
            const current = await tx.hookDef.findUnique({
              where: { id: hookId },
              select: {
                enabled: true,
                kind: true,
                agentId: true,
                repoId: true,
                repoFullName: true,
                configRevision: true,
                dispatchRevision: true,
                projectionEpoch: true,
                reviewPolicy: true,
                reportingMode: true,
                gateMode: true,
                agent: { select: { status: true } }
              }
            })
            if (
              !current ||
              !current.enabled ||
              current.kind !== 'github' ||
              current.agentId !== r.agentId ||
              current.configRevision !== r.configRevision ||
              current.dispatchRevision !== r.dispatchRevision ||
              !servedBy(authority, current.agentId, r.dispatchDaemonId) ||
              current.agent?.status !== 'active' ||
              current.reviewPolicy !== r.reviewPolicySnapshot ||
              current.reportingMode !== r.reportingModeSnapshot ||
              current.gateMode !== r.gateModeSnapshot ||
              (r.repoId !== undefined && current.repoId !== r.repoId) ||
              (r.repoFullName !== undefined && current.repoFullName !== r.repoFullName)
            )
              return false
            projectionEpoch = current.projectionEpoch
          }
          if (projectionEpoch === null) return false

          const recovered = await tx.hookRun.updateMany({
            where: {
              id: run.id,
              status: 'failed',
              reason: { in: [...RETRYABLE_HOOK_DELIVERY_REASONS] },
              redeliveryAttempts: { gt: 0 },
              redeliveryLastRequestedAt: { not: null },
              turnStartedAt: null,
              orphanedAt: null,
              durationMs: null,
              sessionId: null,
              reviewAttemptId: null,
              reviewAttemptState: null,
              reviewErrorCode: null,
              reviewId: null,
              reviewEvent: null,
              verdict: null,
              reviewCommitId: null,
              publishedCommentKind: null,
              publishedCommentId: null
            },
            data: {
              event: r.event ?? run.event,
              agentId: r.agentId,
              configRevision: r.configRevision,
              dispatchRevision: r.dispatchRevision,
              projectionEpoch,
              dispatchDaemonId: r.dispatchDaemonId,
              reviewPolicySnapshot: r.reviewPolicySnapshot,
              reportingModeSnapshot: r.reportingModeSnapshot,
              gateModeSnapshot: r.gateModeSnapshot,
              ...(r.projectionIntent !== undefined ? { projectionIntent: r.projectionIntent } : {}),
              ...(r.repoId !== undefined ? { repoId: r.repoId } : {}),
              ...(r.repoFullName !== undefined ? { repoFullName: r.repoFullName } : {}),
              ...(r.sourceInstallationId !== undefined ? { sourceInstallationId: r.sourceInstallationId } : {}),
              ...(r.subjectKind !== undefined ? { subjectKind: r.subjectKind } : {}),
              ...(r.pullNumber !== undefined ? { pullNumber: r.pullNumber } : {}),
              ...(r.headSha !== undefined ? { headSha: r.headSha } : {}),
              ...(r.baseSha !== undefined ? { baseSha: r.baseSha } : {}),
              ...(r.reportSha !== undefined ? { reportSha: r.reportSha } : {}),
              ...(r.isDraft !== undefined ? { isDraft: r.isDraft } : {}),
              ...(r.baseChanged !== undefined ? { baseChanged: r.baseChanged } : {}),
              status: r.status,
              completedAt: at,
              orphanedAt: null,
              durationMs: r.durationMs ?? null,
              sessionId: r.sessionId ?? null,
              reason: r.reason ?? null,
              ...(r.publishedComment
                ? {
                    publishedCommentKind: r.publishedComment.kind,
                    publishedCommentId: r.publishedComment.commentId
                  }
                : {}),
              redeliveryNextAttemptAt: null
            }
          })
          if (recovered.count !== 1) return false
          run = await tx.hookRun.findUniqueOrThrow({ where: { id: run.id } })
          if (run.projectionId && run.projectionGeneration !== null && r.projectionDesiredState) {
            await tx.hookReviewProjection.updateMany({
              where: { id: run.projectionId, generation: run.projectionGeneration, tombstonedAt: null },
              data: {
                desiredState: r.projectionDesiredState,
                sealedThrough: run.projectionGeneration,
                nextAttemptAt: r.projectionNextAttemptAt ?? at
              }
            })
          }
          return true
        }

        // Once a delivery has entered automatic recovery, legacy optional
        // completion fences are no longer safe: an older attempt on the same
        // daemon could otherwise close a reopened row after config/session
        // authority changed. Retried rows require the complete exact tuple.
        if (
          run.redeliveryAttempts > 0 &&
          (r.agentId === undefined ||
            r.configRevision === undefined ||
            r.dispatchRevision === undefined ||
            r.dispatchDaemonId === undefined ||
            run.agentId !== r.agentId ||
            run.configRevision !== r.configRevision ||
            run.dispatchRevision !== r.dispatchRevision ||
            run.dispatchDaemonId !== r.dispatchDaemonId)
        )
          return false
        // The accepted dispatch target stays a provenance snapshot; who may close the row is the
        // daemon that dispatched it or the one that serves its agent now.
        const acceptedDaemon = run.dispatchDaemonId
        if (acceptedDaemon && !mayReport(authority, run.agentId, reportingDaemonId, acceptedDaemon)) return false
        if (!acceptedDaemon) {
          const current = await tx.hookDef.findUnique({ where: { id: hookId }, select: { agentId: true } })
          // Legacy HookRun rows predate the accepted dispatch tuple, but their
          // daemon report still carries the owning agentId. Fall back to who serves the hook's
          // agent now, without weakening that agent boundary: a different agent on the same
          // daemon must not be able to close it.
          if (!current || !servedBy(authority, current.agentId, reportingDaemonId)) return false
          if (r.agentId !== undefined && current.agentId !== r.agentId) return false
        }
        if (
          (r.agentId !== undefined && run.agentId !== null && run.agentId !== r.agentId) ||
          (r.configRevision !== undefined && run.configRevision !== null && run.configRevision !== r.configRevision) ||
          (r.dispatchRevision !== undefined &&
            run.dispatchRevision !== null &&
            run.dispatchRevision !== r.dispatchRevision) ||
          (r.reviewAttemptId !== undefined &&
            run.reviewAttemptId !== r.reviewAttemptId &&
            !(r.reviewAttemptState === 'released' && run.reviewAttemptId === null)) ||
          ((r.reviewId !== undefined || r.reviewEvent !== undefined || r.verdict !== undefined) &&
            r.reviewAttemptId === undefined)
        )
          return false
        if (r.reviewAttemptId !== undefined) {
          if (r.reviewAttemptState === 'submitted' || r.reviewId !== undefined) {
            // Completion is the lost-REP recovery path for the broker RPC, not
            // a second authority source. It must repeat the semantic tuple
            // reserved before POST and remain anchored to this run's head.
            if (
              !r.reviewId ||
              !r.reviewEvent ||
              !r.verdict ||
              !r.reviewCommitId ||
              run.reviewEvent !== r.reviewEvent ||
              run.verdict !== r.verdict ||
              run.headSha !== r.reviewCommitId ||
              (run.reviewId !== null && run.reviewId !== r.reviewId) ||
              (run.reviewCommitId !== null && run.reviewCommitId !== r.reviewCommitId)
            )
              return false
          } else if (run.reviewAttemptState === 'submitted') {
            // A delayed ambiguous/no-effect report can never downgrade an
            // already-correlated submitted review.
            return false
          }
        }
        // A real completion may replace a reaper-orphaned row or the relay's
        // ambiguous dispatch_timeout (the daemon may have durably admitted the
        // turn just before the ACK was lost). Definite delivery failures and
        // conflicting terminal reports otherwise never rewrite history.
        if (run.status !== 'running' && run.orphanedAt === null && run.reason !== HOOK_DELIVERY_REASON_DISPATCH_TIMEOUT)
          return true
        run = await tx.hookRun.update({
          where: { id: run.id },
          data: {
            status: r.status,
            completedAt: at,
            orphanedAt: null,
            durationMs: r.durationMs ?? null,
            sessionId: r.sessionId ?? run.sessionId,
            reason: r.reason ?? null,
            ...(r.publishedComment
              ? {
                  publishedCommentKind: r.publishedComment.kind,
                  publishedCommentId: r.publishedComment.commentId
                }
              : {}),
            ...(r.reviewAttemptId
              ? r.reviewAttemptState === 'released'
                ? {
                    reviewAttemptId: null,
                    reviewAttemptState: null,
                    reviewEvent: null,
                    reviewErrorCode: r.reviewErrorCode ?? null
                  }
                : {
                    reviewAttemptId: r.reviewAttemptId,
                    reviewAttemptState: r.reviewAttemptState ?? (r.reviewId ? 'submitted' : 'blocked'),
                    reviewErrorCode: r.reviewErrorCode ?? null
                  }
              : {}),
            ...(r.reviewAttemptState !== 'released' && r.reviewId ? { reviewId: r.reviewId } : {}),
            ...(r.reviewAttemptState !== 'released' && r.reviewEvent ? { reviewEvent: r.reviewEvent } : {}),
            ...(r.reviewAttemptState !== 'released' && r.verdict ? { verdict: r.verdict } : {}),
            ...(r.reviewAttemptState !== 'released' && r.reviewCommitId ? { reviewCommitId: r.reviewCommitId } : {})
          }
        })
      }
      if (run.projectionId && run.projectionGeneration !== null && r.projectionDesiredState) {
        // The HookRun row is updated before its projection in this transaction.
        // If a formal result committed first (or was folded in by this terminal
        // receipt), its semantic verdict is authoritative over generic runtime
        // success/failure. A later coordinator pass rechecks the same durable
        // tuple under the run lock in setProjectionDesired.
        const desiredState = submittedReviewProjectionState(run) ?? r.projectionDesiredState
        await tx.hookReviewProjection.updateMany({
          where: { id: run.projectionId, generation: run.projectionGeneration, tombstonedAt: null },
          data: {
            desiredState,
            sealedThrough: run.projectionGeneration,
            nextAttemptAt: r.projectionNextAttemptAt ?? at
          }
        })
      }
      return true
    })
  }

  async listRuns(orgId: OrgId, hookId: HookId, limit = 50): Promise<HookRunRecord[]> {
    // Run rows carry their own `orgId`, so the fence rides this query rather
    // than resting solely on the parent hook (org-scoped-data-layer.md §3.6).
    const rows = await this.db.hookRun.findMany({
      where: { hookId, orgId },
      orderBy: { startedAt: 'desc' },
      take: limit
    })
    return rows.map(toRunRecord)
  }

  async existingDeliveryKeys(deliveryKeys: string[]): Promise<Set<string>> {
    if (deliveryKeys.length === 0) return new Set()
    const rows = await this.db.hookRun.findMany({
      where: { deliveryKey: { in: deliveryKeys } },
      select: { deliveryKey: true }
    })
    return new Set(rows.map((r) => r.deliveryKey))
  }

  async claimReviewRequestRequiredFanoutRedelivery(
    deliveryKey: string,
    expectedHookIds: readonly HookId[],
    requestedAt: Date
  ): Promise<boolean> {
    const expected = [...new Set(expectedHookIds)].sort()
    if (expected.length < 2) return false
    return this.transaction(async (tx) => {
      for (const hookId of expected) await lockHookReviewLifecycleScope(tx, hookId)
      await lockHookDeliveryRedeliveryScope(tx, deliveryKey)
      const rows = await tx.hookRun.findMany({
        where: { deliveryKey },
        orderBy: { id: 'asc' }
      })
      if (rows.length === 0 || rows.length >= expected.length) return false

      const expectedSet = new Set<string>(expected)
      const safePartialFanout = rows.every(
        (row) =>
          expectedSet.has(row.hookId) &&
          row.status === 'failed' &&
          row.reason === HOOK_DELIVERY_REASON_REVIEW_REQUEST_REQUIRED &&
          row.event !== null &&
          isGithubPullRequestRevisionEvent(row.event, { baseChanged: row.baseChanged === true }) &&
          row.projectionIntent === 'revision_event' &&
          row.subjectKind === 'pull_request' &&
          row.completedAt !== null &&
          row.turnStartedAt === null &&
          row.orphanedAt === null &&
          row.durationMs === null &&
          row.sessionId === null &&
          row.reviewAttemptId === null &&
          row.reviewAttemptState === null &&
          row.reviewErrorCode === null &&
          row.reviewId === null &&
          row.reviewEvent === null &&
          row.verdict === null &&
          row.reviewCommitId === null &&
          row.publishedCommentKind === null &&
          row.publishedCommentId === null &&
          row.redeliveryLastRequestedAt === null &&
          row.redeliveryNextAttemptAt === null
      )
      if (!safePartialFanout || rows.some((row) => row.redeliveryAttempts > 0)) return false

      // The current candidate set must still be exactly live GitHub hook
      // definitions. Lifecycle locks keep this check stable until the claim
      // commits; the redelivered payload then re-applies the relay's exact
      // mention/rate/permission gates instead of reconstructing them in CP.
      const currentHooks = await tx.hookDef.count({
        where: {
          id: { in: expected },
          enabled: true,
          kind: 'github',
          agentId: { not: null }
        }
      })
      if (currentHooks !== expected.length) return false

      const claimed = await tx.hookRun.updateMany({
        where: { id: { in: rows.map((row) => row.id) }, redeliveryAttempts: 0 },
        data: {
          redeliveryAttempts: 1,
          redeliveryLastRequestedAt: requestedAt,
          redeliveryNextAttemptAt: null
        }
      })
      return claimed.count === rows.length
    })
  }

  async claimRetryableDeliveryRedelivery(
    deliveryKey: string,
    expectedHookIds: readonly HookId[],
    requestedAt: Date,
    backoffMs: readonly number[]
  ): Promise<boolean> {
    if (backoffMs.length === 0) return false
    const expected = [...new Set(expectedHookIds)].sort()
    if (expected.length === 0) return false
    const authorities = new Map<string, HookDispatchAuthority>()
    // Where a redelivered event lands, exactly as the relay rule names it: the placement for a
    // machine-placed agent, the current duty holder for a set-placed one.
    const dispatchTargets = new Map<string, string>()
    for (const hookId of expected) {
      const authority = await this.dispatchAuthority(hookId)
      authorities.set(hookId, authority)
      const routable = authority.ref ? await this.placement.routableDaemon(authority.ref) : null
      if (routable) dispatchTargets.set(hookId, routable)
    }
    return this.transaction(async (tx) => {
      // Hook-definition mutation paths take the lifecycle lock. Serialize the
      // expected fanout before the delivery lock; a placement move that commits
      // after the snapshot is handled by the cross-placement pin and the
      // exact-current start/completion recovery below.
      for (const hookId of expected) await lockHookReviewLifecycleScope(tx, hookId)
      // One GitHub GUID can fan out to several HookDefs. A delivery-scoped lock
      // makes that fanout one durable claim (and one external redelivery POST),
      // including across several control-plane processes.
      await lockHookDeliveryRedeliveryScope(tx, deliveryKey)
      const rows = await tx.hookRun.findMany({
        where: { deliveryKey },
        orderBy: { id: 'asc' }
      })
      const active = rows.filter(isRetryableFailedDeliveryStage)
      const settleActive = async (): Promise<void> => {
        if (active.length === 0) return
        await tx.hookRun.updateMany({
          where: { id: { in: active.map((row) => row.id) } },
          data: { redeliveryNextAttemptAt: null }
        })
      }

      // A GitHub redelivery broadcasts to every hook that currently matches
      // the GUID. It is safe only when that exact fanout already has one active,
      // side-effect-free retry row per hook. A success, pause/no-agent verdict,
      // newly-created hook, removed hook, or effect-bearing row blocks the whole
      // POST because daemon dedup is local rather than cross-placement.
      const landed = [...new Set(rows.map((row) => row.hookId))].sort()
      if (
        expected.length !== landed.length ||
        expected.some((hookId, index) => hookId !== landed[index]) ||
        active.length !== rows.length
      ) {
        await settleActive()
        return false
      }

      const currentHooks = await tx.hookDef.findMany({
        where: { id: { in: expected }, enabled: true, kind: 'github' },
        select: {
          id: true,
          agentId: true,
          configRevision: true,
          dispatchRevision: true,
          projectionEpoch: true,
          reviewPolicy: true,
          reportingMode: true,
          gateMode: true,
          agent: { select: { status: true } }
        }
      })
      const currentById = new Map(currentHooks.map((hook) => [hook.id, hook]))
      const attempt = Math.max(...rows.map((row) => row.redeliveryAttempts))
      const authoritySafe = rows.every((row) => {
        const current = currentById.get(row.hookId)
        if (!current?.agentId || current.agent?.status !== 'active') return false
        const target = dispatchTargets.get(row.hookId)
        if (authorities.get(row.hookId)?.agentId !== current.agentId || !target) return false
        // A pre-admission failure may follow placement only; after one POST, pin its captured dispatch.
        if (row.agentId !== current.agentId || row.configRevision !== current.configRevision) return false
        if (attempt > 0 && (row.dispatchRevision !== current.dispatchRevision || row.dispatchDaemonId !== target))
          return false
        return true
      })
      if (currentHooks.length !== expected.length || !authoritySafe) {
        await settleActive()
        return false
      }

      // Attempts are GUID-scoped because one external POST replays the complete
      // fanout. Normalize any historical skew before advancing the shared gate.
      const dueAt = Math.max(...rows.map((row) => row.redeliveryNextAttemptAt!.getTime()))
      if (dueAt > requestedAt.getTime()) return false
      // Only one external POST is duplicate-free; another needs global GUID admission dedup.
      if (attempt >= 1) {
        await settleActive()
        return false
      }
      const delayMs = backoffMs[0]!
      // Capture the dispatch expected by this external request before releasing
      // the GUID lock. If the Relay accepted report is lost, an exact daemon
      // start/completion can still converge against this durable authority.
      for (const row of rows) {
        const current = currentById.get(row.hookId)!
        await tx.hookRun.update({
          where: { id: row.id },
          data: {
            dispatchRevision: current.dispatchRevision,
            projectionEpoch: current.projectionEpoch,
            dispatchDaemonId: dispatchTargets.get(row.hookId)!,
            reviewPolicySnapshot: current.reviewPolicy,
            reportingModeSnapshot: current.reportingMode,
            gateModeSnapshot: current.gateMode,
            redeliveryAttempts: attempt + 1,
            redeliveryLastRequestedAt: requestedAt,
            redeliveryNextAttemptAt: new Date(requestedAt.getTime() + delayMs)
          }
        })
      }
      return true
    })
  }

  async settleRetryableDeliveryRedeliveries(
    requestedAt: Date,
    expiredBefore: Date,
    maxAttempts: number
  ): Promise<number> {
    if (maxAttempts < 1) return 0
    const candidates = await this.db.hookRun.findMany({
      where: {
        status: 'failed',
        reason: { in: [...RETRYABLE_HOOK_DELIVERY_REASONS] },
        redeliveryNextAttemptAt: { not: null },
        OR: [
          { redeliveryAttempts: { gte: maxAttempts }, redeliveryNextAttemptAt: { lte: requestedAt } },
          { startedAt: { lt: expiredBefore } }
        ]
      },
      select: { deliveryKey: true },
      distinct: ['deliveryKey'],
      orderBy: { redeliveryNextAttemptAt: 'asc' },
      take: 100
    })
    let settled = 0
    for (const { deliveryKey } of candidates) {
      settled += await this.transaction(async (tx) => {
        await lockHookDeliveryRedeliveryScope(tx, deliveryKey)
        const rows = await tx.hookRun.findMany({ where: { deliveryKey } })
        const active = rows.filter(isRetryableFailedDeliveryStage)
        if (active.length === 0) return 0
        const exhausted = active.every(
          (row) =>
            row.redeliveryAttempts >= maxAttempts &&
            row.redeliveryNextAttemptAt !== null &&
            row.redeliveryNextAttemptAt <= requestedAt
        )
        const expired = active.every((row) => row.startedAt < expiredBefore)
        if (!exhausted && !expired) return 0
        const result = await tx.hookRun.updateMany({
          where: { id: { in: active.map((row) => row.id) }, redeliveryNextAttemptAt: { not: null } },
          data: { redeliveryNextAttemptAt: null }
        })
        return result.count
      })
    }
    return settled
  }

  async reapStaleRuns(staleBefore: Date): Promise<number> {
    return this.transaction(async (tx) => {
      const rows = await tx.hookRun.findMany({
        where: { status: 'running', startedAt: { lt: staleBefore } },
        select: { id: true, projectionId: true, projectionGeneration: true }
      })
      let reaped = 0
      for (const row of rows) {
        // Share the global HookRun -> projection lock order with formal review
        // results and terminal reports. A review result that wins first must be
        // visible before the reaper chooses the projection state; a result that
        // loses this lock will overwrite timed_out authoritatively afterwards.
        const current = await this.lockHookRunById(tx, row.id)
        if (!current || current.status !== 'running' || current.startedAt >= staleBefore) continue
        const at = new Date()
        const reapedRun = await tx.hookRun.update({
          where: { id: current.id },
          data: { status: 'failed', reason: ORPHANED_RUN_REASON, completedAt: at, orphanedAt: at }
        })
        reaped += 1
        if (reapedRun.projectionId && reapedRun.projectionGeneration !== null) {
          const desiredState = submittedReviewProjectionState(reapedRun) ?? 'timed_out'
          await tx.hookReviewProjection.updateMany({
            where: {
              id: reapedRun.projectionId,
              generation: reapedRun.projectionGeneration,
              tombstonedAt: null
            },
            data: { desiredState, sealedThrough: reapedRun.projectionGeneration, nextAttemptAt: at }
          })
        }
      }
      return reaped
    })
  }

  async upsertReviewProjection(input: UpsertHookReviewProjectionInput): Promise<HookReviewProjectionRecord> {
    return this.transaction(async (tx) => {
      // Outermost owner fence, including the low-level/no-HookRun path. The
      // shared row lock conflicts with organization deletion's FOR UPDATE; an
      // upsert that starts after deletion fails instead of creating FK-less
      // projection metadata for a vanished tenant.
      await lockHookReviewOrgProducerScope(tx, input.orgId)
      const liveOrg = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "org"
        WHERE "id" = ${input.orgId}
        FOR KEY SHARE
      `)
      if (liveOrg.length === 0) throw new Error('review projection organization no longer exists')

      // Global lock order: org -> optional owning-agent lifecycle (HookDef CRUD
      // only) -> hook lifecycle -> agent/repo authorization scope ->
      // epoch-qualified natural key -> projection row. Hook edits/deletes and
      // repo-grant revocation take the corresponding prefix, so neither can
      // miss a concurrently-created row.
      await lockHookReviewLifecycleScope(tx, input.hookId)
      await lockHookReviewAgentRepoScope(tx, input.agentId, input.repoId)
      // Re-lock HookRun so a stale failed-delivery repair cannot publish after implicit recovery.
      const incomingRun = input.currentHookRunId ? await this.lockHookRunById(tx, input.currentHookRunId) : null
      if (
        input.currentHookRunId &&
        (!incomingRun ||
          incomingRun.hookId !== input.hookId ||
          incomingRun.agentId !== input.agentId ||
          incomingRun.repoId !== input.repoId ||
          incomingRun.headSha !== input.headSha ||
          incomingRun.reportSha !== input.reportSha ||
          incomingRun.projectionEpoch !== input.projectionEpoch)
      ) {
        throw new Error('review projection run does not match its natural key')
      }
      if (
        incomingRun &&
        incomingRun.redeliveryAttempts > 0 &&
        incomingRun.redeliveryLastRequestedAt !== null &&
        authoritativeHookProjectionState(toRunRecord(incomingRun)) !== input.desiredState
      ) {
        throw new Error('review projection intent is stale for the current hook run')
      }
      // The unique constraint prevents duplicate rows, but it does not make the
      // read/compare/update sequence below atomic under READ COMMITTED. Serialize
      // every natural key before reading it so two CP processes cannot both
      // create, advance, or overwrite the same generation from stale state.
      // A 64-bit hash collision only adds harmless serialization between two
      // unrelated projections; all authority still comes from the full key.
      const naturalKey = JSON.stringify([
        input.hookId,
        input.repoId.toString(),
        input.reportSha,
        input.projectionEpoch.toString()
      ])
      await tx.$queryRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtextextended(${naturalKey}, 0)) IS NULL AS "locked"
      `)
      const current = await this.lockReviewProjectionByNaturalKey(
        tx,
        input.hookId,
        input.repoId,
        input.reportSha,
        input.projectionEpoch
      )
      // Tombstones are one-way cleanup intent. Delayed WS edges and periodic
      // repair may observe historical HookRuns after disable/delete, but may
      // never validate, increment, or otherwise revive the projection.
      if (current && current.tombstonedAt !== null) return toProjectionRecord(current)

      // Production convergence always carries a HookRun id. Re-check its live
      // lifecycle under the hook lock: a delayed edge from before disable,
      // retarget, delete, or re-enable becomes a non-writing tombstone receipt,
      // never a fresh projection in the retired epoch. Low-level repository
      // tests may intentionally exercise the outbox without a HookDef/run.
      if (input.currentHookRunId) {
        const hook = await tx.hookDef.findUnique({
          where: { id: input.hookId },
          select: {
            kind: true,
            enabled: true,
            agentId: true,
            repoId: true,
            projectionEpoch: true,
            reportingMode: true,
            gateMode: true
          }
        })
        const agent = await tx.agent.findUnique({
          where: { id: input.agentId },
          select: { orgId: true, workspaceRepoId: true, workspaceMode: true, gitAccess: true }
        })
        // HookReviewProjection is the GitHub Checks ledger, so both authorities read
        // github here — the hosts number their repositories independently (§8.1).
        const workspaceIsThisRepo = agent?.workspaceRepoId === input.repoId && agent.workspaceMode === 'github'
        const additionalGrant = workspaceIsThisRepo
          ? null
          : await tx.agentRepoAuthorization.findUnique({
              where: {
                agentId_provider_repoId: { agentId: input.agentId, provider: 'github', repoId: input.repoId }
              },
              select: { access: true }
            })
        const currentRepoAuthority =
          agent?.orgId === input.orgId &&
          ((workspaceIsThisRepo && agent.gitAccess === 'write') || additionalGrant?.access === 'write')
        const currentLifecycle =
          hook?.kind === 'github' &&
          hook.enabled &&
          hook.agentId === input.agentId &&
          hook.repoId === input.repoId &&
          hook.projectionEpoch === input.projectionEpoch &&
          hook.reportingMode === input.mode &&
          hook.gateMode === input.gateMode &&
          currentRepoAuthority
        if (!currentLifecycle) {
          if (current) {
            await this.tombstoneProjectionRows(tx, [current], new Date(), 'failure')
            return toProjectionRecord(await tx.hookReviewProjection.findUniqueOrThrow({ where: { id: current.id } }))
          }
          const id = randomUUID()
          return toProjectionRecord(
            await tx.hookReviewProjection.create({
              data: {
                id,
                hookId: input.hookId,
                orgId: input.orgId,
                agentId: input.agentId,
                agentName: input.agentName,
                repoId: input.repoId,
                repoFullName: input.repoFullName,
                headSha: input.headSha,
                reportSha: input.reportSha,
                projectionEpoch: input.projectionEpoch,
                generation: 1,
                externalId: id,
                mode: input.mode,
                gateMode: input.gateMode,
                desiredState: 'failure',
                sealedThrough: 1n,
                tombstonedAt: new Date()
              }
            })
          )
        }
      }

      // An epoch-qualified key has exactly one owner. If legacy/corrupt state
      // disagrees, fail closed instead of silently minting under the old agent.
      if (current && (current.agentId !== input.agentId || current.orgId !== input.orgId)) {
        await this.tombstoneProjectionRows(tx, [current], new Date(), 'failure')
        return toProjectionRecord(await tx.hookReviewProjection.findUniqueOrThrow({ where: { id: current.id } }))
      }
      const pending =
        input.pendingIntent === undefined
          ? ({
              desiredState: input.desiredState,
              currentHookRunId: input.currentHookRunId ?? null,
              nextAttemptAt: input.nextAttemptAt.toISOString()
            } as Prisma.InputJsonValue)
          : (input.pendingIntent as Prisma.InputJsonValue)
      if (!current) {
        const id = randomUUID()
        return toProjectionRecord(
          await tx.hookReviewProjection.create({
            data: {
              id,
              hookId: input.hookId,
              orgId: input.orgId,
              agentId: input.agentId,
              agentName: input.agentName,
              repoId: input.repoId,
              repoFullName: input.repoFullName,
              headSha: input.headSha,
              reportSha: input.reportSha,
              projectionEpoch: input.projectionEpoch,
              generation: 1,
              currentHookRunId: input.currentHookRunId ?? null,
              externalId: id,
              mode: input.mode,
              gateMode: input.gateMode,
              desiredState: input.desiredState,
              ...(isTerminalProjectionState(input.desiredState) ? { sealedThrough: 1n } : {}),
              nextAttemptAt: input.nextAttemptAt
            }
          })
        )
      }
      // Duplicate accepted/start reports for the same run are idempotent.
      if (input.currentHookRunId && current.currentHookRunId === input.currentHookRunId) {
        return toProjectionRecord(current)
      }
      if (incomingRun) {
        const incumbentIds = [current.currentHookRunId, pendingCurrentHookRunId(current.pendingIntent)].filter(
          (id): id is string => id !== null && id !== incomingRun.id
        )
        if (incumbentIds.length > 0) {
          const incumbents = await tx.hookRun.findMany({
            where: { id: { in: incumbentIds } },
            select: { id: true, startedAt: true }
          })
          if (incumbents.some((incumbent) => !isStrictlyNewerRun(incomingRun, incumbent))) {
            return toProjectionRecord(current)
          }
        }
      }
      if (current.writePhase !== null) {
        return toProjectionRecord(
          await tx.hookReviewProjection.update({
            where: { id: current.id },
            data: { pendingIntent: pending }
          })
        )
      }
      const nextGeneration = current.generation + 1n
      const detachCompletedCheck =
        input.currentHookRunId !== undefined &&
        input.currentHookRunId !== null &&
        current.observedState !== null &&
        isTerminalProjectionState(current.observedState)
      return toProjectionRecord(
        await tx.hookReviewProjection.update({
          where: { id: current.id },
          data: {
            generation: nextGeneration,
            currentHookRunId: input.currentHookRunId ?? null,
            // GitHub keeps a completed Check Run terminal even when a later
            // PATCH asks for queued/in_progress. A new HookRun therefore owns
            // a fresh Check Run after a terminal result. An overlapping active
            // generation keeps its incomplete run instead of orphaning it;
            // tombstone-only generations also keep the id for cleanup.
            ...(detachCompletedCheck ? { checkRunId: null } : {}),
            agentName: input.agentName,
            repoFullName: input.repoFullName,
            headSha: input.headSha,
            mode: input.mode,
            gateMode: input.gateMode,
            desiredState: input.desiredState,
            ...(isTerminalProjectionState(input.desiredState) ? { sealedThrough: nextGeneration } : {}),
            observedState: null,
            nextAttemptAt: input.nextAttemptAt,
            attempts: 0,
            lastErrorCode: null,
            pendingIntent: Prisma.DbNull,
            leaseOwner: null,
            leaseUntil: null
          }
        })
      )
    })
  }

  async bindRunProjection(
    hookId: HookId,
    deliveryKey: string,
    projectionId: string,
    generation: bigint
  ): Promise<boolean> {
    const changed = await this.db.hookRun.updateMany({
      where: {
        hookId,
        deliveryKey,
        OR: [
          { projectionId: null, projectionGeneration: null },
          { projectionId, projectionGeneration: generation }
        ]
      },
      data: { projectionId, projectionGeneration: generation }
    })
    return changed.count === 1
  }

  async setProjectionDesired(
    projectionId: string,
    generation: bigint,
    desiredState: string,
    nextAttemptAt: Date,
    currentHookRunId?: string
  ): Promise<boolean> {
    return this.transaction(async (tx) => {
      let effectiveDesiredState = desiredState
      if (currentHookRunId !== undefined) {
        // Global mutation order for run-bound lifecycle edges is HookRun ->
        // projection. recordReviewResult/recordReport/reaper use the same order.
        // Whichever side wins, a submitted formal verdict is observed here or
        // commits afterwards and overwrites this generic edge in its own tx.
        const currentRun = await this.lockHookRunById(tx, currentHookRunId)
        if (!currentRun || currentRun.projectionId !== projectionId || currentRun.projectionGeneration !== generation)
          return false
        if (currentRun.redeliveryAttempts > 0 && currentRun.redeliveryLastRequestedAt !== null) {
          const authoritative = authoritativeHookProjectionState(toRunRecord(currentRun))
          if (authoritative === null) return false
          effectiveDesiredState = authoritative
        } else {
          effectiveDesiredState = submittedReviewProjectionState(currentRun) ?? desiredState
        }
      }
      const terminal = isTerminalProjectionState(effectiveDesiredState)
      const changed = await tx.hookReviewProjection.updateMany({
        where: {
          id: projectionId,
          generation,
          tombstonedAt: null,
          ...(currentHookRunId !== undefined ? { currentHookRunId } : {}),
          // queued/in_progress are lifecycle hints. Once any terminal authority
          // seals this generation, a delayed accepted/start edge can no longer
          // regress it even if its coordinator held a stale row snapshot.
          ...(terminal ? {} : { sealedThrough: { lt: generation } })
        },
        data: {
          desiredState: effectiveDesiredState,
          nextAttemptAt,
          ...(terminal ? { sealedThrough: generation } : {})
        }
      })
      return changed.count === 1
    })
  }

  async upsertReviewSubject(input: Omit<HookReviewSubjectRecord, 'updatedAt'>): Promise<void> {
    await this.db.hookReviewSubject.upsert({
      where: {
        projectionId_pullNumber: { projectionId: input.projectionId, pullNumber: input.pullNumber }
      },
      create: input,
      update: { headSha: input.headSha, baseSha: input.baseSha, isOpen: input.isOpen }
    })
  }

  async synchronizeReviewSubjects(
    projectionId: string,
    generation: bigint,
    subjects: readonly Omit<HookReviewSubjectRecord, 'projectionId' | 'updatedAt' | 'isOpen'>[] | null,
    errorCode: string | null
  ): Promise<boolean> {
    return this.transaction(async (tx) => {
      const changed = await tx.hookReviewProjection.updateMany({
        // Row-lock/CAS against beginProjectionWrite: whichever transaction
        // wins first establishes a strict association-before-marker order.
        where: { id: projectionId, generation, writePhase: null, writeMarker: null },
        data: { subjectSyncGeneration: generation, subjectSyncErrorCode: errorCode }
      })
      if (changed.count !== 1) return false

      // An incomplete/capped read is not an authoritative replacement set.
      // Preserve the last complete subject snapshot while recording the
      // generation-scoped fail-closed result above.
      if (subjects === null) return true

      const currentNumbers = [...new Set(subjects.map((subject) => subject.pullNumber))]
      await tx.hookReviewSubject.updateMany({
        where: {
          projectionId,
          ...(currentNumbers.length > 0 ? { pullNumber: { notIn: currentNumbers } } : {})
        },
        data: { isOpen: false }
      })
      for (const subject of subjects) {
        await tx.hookReviewSubject.upsert({
          where: { projectionId_pullNumber: { projectionId, pullNumber: subject.pullNumber } },
          create: { projectionId, ...subject, isOpen: true },
          update: { headSha: subject.headSha, baseSha: subject.baseSha, isOpen: true }
        })
      }
      return true
    })
  }

  async listReviewSubjects(projectionId: string): Promise<HookReviewSubjectRecord[]> {
    return (await this.db.hookReviewSubject.findMany({ where: { projectionId }, orderBy: { pullNumber: 'asc' } })).map(
      toSubjectRecord
    )
  }

  async getReviewProjection(projectionId: string): Promise<HookReviewProjectionRecord | null> {
    const row = await this.db.hookReviewProjection.findUnique({ where: { id: projectionId } })
    return row ? toProjectionRecord(row) : null
  }

  async findReviewProjectionByExternalId(externalId: string): Promise<HookReviewProjectionRecord | null> {
    const row = await this.db.hookReviewProjection.findUnique({ where: { externalId } })
    return row ? toProjectionRecord(row) : null
  }

  async findReviewProjectionByCheckRunId(checkRunId: string): Promise<HookReviewProjectionRecord | null> {
    const row = await this.db.hookReviewProjection.findUnique({ where: { checkRunId } })
    return row ? toProjectionRecord(row) : null
  }

  async listReviewProjectionsForSuiteRerequest(
    repoId: bigint,
    headSha: string,
    installationId: bigint
  ): Promise<HookReviewProjectionRecord[]> {
    return (
      await this.db.hookReviewProjection.findMany({
        where: {
          repoId,
          headSha,
          reportSha: headSha,
          lastResolvedInstallationId: installationId,
          checkRunId: { not: null },
          tombstonedAt: null
        },
        orderBy: { hookId: 'asc' }
      })
    ).map(toProjectionRecord)
  }

  async listReviewRequestRequiredRuns(repoId: bigint, headSha: string, pullNumber?: number): Promise<HookRunRecord[]> {
    const hooks = await this.db.hookDef.findMany({
      where: { kind: 'github', repoId, enabled: true, agentId: { not: null } },
      select: { id: true }
    })
    if (hooks.length === 0) return []
    const rows = await this.db.hookRun.findMany({
      where: {
        hookId: { in: hooks.map((hook) => hook.id) },
        repoId,
        headSha,
        reportSha: headSha,
        subjectKind: 'pull_request',
        pullNumber: pullNumber ?? { not: null }
      },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }]
    })
    const latestByPull = new Map<string, (typeof rows)[number]>()
    for (const row of rows) {
      const key = `${row.hookId}:${row.pullNumber}`
      if (!latestByPull.has(key)) latestByPull.set(key, row)
    }
    return [...latestByPull.values()]
      .filter(
        (row) =>
          row.status === 'failed' &&
          row.reason === HOOK_DELIVERY_REASON_REVIEW_REQUEST_REQUIRED &&
          row.completedAt !== null &&
          row.turnStartedAt === null &&
          row.orphanedAt === null
      )
      .sort((a, b) => a.hookId.localeCompare(b.hookId) || (a.pullNumber ?? 0) - (b.pullNumber ?? 0))
      .map(toRunRecord)
  }

  async listReviewProjectionsForAgentRepo(agentId: AgentId, repoId: bigint): Promise<HookReviewProjectionRecord[]> {
    return (await this.db.hookReviewProjection.findMany({ where: { agentId, repoId } })).map(toProjectionRecord)
  }

  async wakeReviewProjectionsForInstallation(installationId: bigint, at: Date): Promise<number> {
    const changed = await this.db.hookReviewProjection.updateMany({
      where: { lastResolvedInstallationId: installationId },
      data: { nextAttemptAt: at }
    })
    return changed.count
  }

  async wakeReviewProjectionsForOrg(orgId: OrgId, at: Date): Promise<number> {
    const changed = await this.db.hookReviewProjection.updateMany({
      where: { orgId },
      data: { nextAttemptAt: at }
    })
    return changed.count
  }

  async refreshReviewProjectionTarget(
    projectionId: string,
    generation: bigint,
    repoFullName: string,
    installationId: bigint
  ): Promise<boolean> {
    const changed = await this.db.hookReviewProjection.updateMany({
      where: { id: projectionId, generation },
      data: { repoFullName, lastResolvedInstallationId: installationId }
    })
    return changed.count === 1
  }

  async claimDueReviewProjections(
    leaseOwner: string,
    now: Date,
    leaseUntil: Date,
    limit = 25
  ): Promise<HookReviewProjectionRecord[]> {
    return this.transaction(async (tx) => {
      const candidates = await tx.hookReviewProjection.findMany({
        where: {
          nextAttemptAt: { lte: now },
          OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }, { leaseOwner }]
        },
        orderBy: [{ nextAttemptAt: 'asc' }, { updatedAt: 'asc' }],
        take: limit
      })
      const claimed: HookReviewProjectionRecord[] = []
      for (const row of candidates) {
        const changed = await tx.hookReviewProjection.updateMany({
          where: {
            id: row.id,
            generation: row.generation,
            OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }, { leaseOwner }]
          },
          data: { leaseOwner, leaseUntil }
        })
        if (changed.count !== 1) continue
        const fresh = await tx.hookReviewProjection.findUnique({ where: { id: row.id } })
        if (fresh) claimed.push(toProjectionRecord(fresh))
      }
      return claimed
    })
  }

  async beginProjectionWrite(
    projectionId: string,
    generation: bigint,
    leaseOwner: string,
    writeMarker: string,
    writePhase: string,
    startedAt: Date
  ): Promise<boolean> {
    return this.transaction(async (tx) => {
      const current = await this.lockReviewProjectionById(tx, projectionId)
      if (
        !current ||
        current.generation !== generation ||
        current.leaseOwner !== leaseOwner ||
        current.writePhase !== null ||
        current.writeMarker !== null
      )
        return false
      const changed = await tx.hookReviewProjection.updateMany({
        where: { id: projectionId, generation, leaseOwner, writePhase: null, writeMarker: null },
        data: { writeMarker, writePhase, writeStartedAt: startedAt }
      })
      return changed.count === 1
    })
  }

  async completeProjectionWrite(input: ProjectionWriteResultInput): Promise<boolean> {
    return this.transaction(async (tx) => {
      const current = await this.lockReviewProjectionById(tx, input.projectionId)
      if (
        !current ||
        current.generation !== input.generation ||
        current.leaseOwner !== input.leaseOwner ||
        current.writeMarker !== input.writeMarker
      )
        return false
      // A generation-scoped association block deliberately writes a
      // non-passing remote Check without replacing the canonical desired
      // intent. It is nevertheless settled for this generation; only a newer
      // generation re-evaluates the association.
      const needsFollowup =
        current.pendingIntent !== null ||
        (current.desiredState !== input.observedState && input.settledErrorCode === undefined)
      const changed = await tx.hookReviewProjection.updateMany({
        where: {
          id: input.projectionId,
          generation: input.generation,
          leaseOwner: input.leaseOwner,
          writeMarker: input.writeMarker
        },
        data: {
          observedState: input.observedState,
          ...(input.checkRunId ? { checkRunId: input.checkRunId } : {}),
          ...(input.lastResolvedInstallationId !== undefined
            ? { lastResolvedInstallationId: input.lastResolvedInstallationId }
            : {}),
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

  async advancePendingReviewProjection(
    projectionId: string,
    generation: bigint,
    fallbackNextAttemptAt: Date
  ): Promise<HookReviewProjectionRecord | null> {
    return this.transaction(async (tx) => {
      const current = await this.lockReviewProjectionById(tx, projectionId)
      if (
        !current ||
        current.generation !== generation ||
        current.writePhase !== null ||
        current.writeMarker !== null ||
        current.pendingIntent === null
      )
        return null
      const pending = current.pendingIntent as Record<string, unknown>
      const persistedDesired = typeof pending.desiredState === 'string' ? pending.desiredState : null
      if (!persistedDesired || !isProjectionDesiredState(persistedDesired)) return null
      if (current.tombstonedAt !== null && persistedDesired !== 'neutral' && persistedDesired !== 'failure') return null
      // Cleanup strictness is one-way even if a caller was holding a stale
      // neutral PendingProjectionIntent while revoke upgraded the durable JSON
      // to failure under this same row lock.
      const desiredState =
        current.tombstonedAt !== null && (current.desiredState === 'failure' || persistedDesired === 'failure')
          ? 'failure'
          : persistedDesired
      const hasPendingRunId = Object.prototype.hasOwnProperty.call(pending, 'currentHookRunId')
      const currentHookRunId = typeof pending.currentHookRunId === 'string' ? pending.currentHookRunId : null
      const encodedNextAttemptAt =
        typeof pending.nextAttemptAt === 'string' ? new Date(pending.nextAttemptAt) : fallbackNextAttemptAt
      const nextAttemptAt = Number.isNaN(encodedNextAttemptAt.getTime()) ? fallbackNextAttemptAt : encodedNextAttemptAt
      const nextRun = currentHookRunId
        ? await tx.hookRun.findUnique({
            where: { id: currentHookRunId },
            select: { headSha: true, repoFullName: true }
          })
        : null
      const nextGeneration = generation + 1n
      const detachCompletedCheck =
        currentHookRunId !== null && current.observedState !== null && isTerminalProjectionState(current.observedState)
      const next = await tx.hookReviewProjection.updateMany({
        where: { id: projectionId, generation, writePhase: null, writeMarker: null },
        data: {
          generation: nextGeneration,
          desiredState,
          // A pending HookRun after a terminal write needs a fresh GitHub
          // lifecycle. Active supersession and cleanup intents continue
          // updating the existing incomplete/cleanup Check instead.
          ...(detachCompletedCheck ? { checkRunId: null } : {}),
          ...(isTerminalProjectionState(desiredState) ? { sealedThrough: nextGeneration } : {}),
          observedState: null,
          nextAttemptAt,
          attempts: 0,
          lastErrorCode: null,
          pendingIntent: Prisma.DbNull,
          ...(nextRun?.headSha ? { headSha: nextRun.headSha } : {}),
          ...(nextRun?.repoFullName ? { repoFullName: nextRun.repoFullName } : {}),
          ...(hasPendingRunId ? { currentHookRunId } : {})
        }
      })
      if (next.count !== 1) return null
      const fresh = await tx.hookReviewProjection.findUnique({ where: { id: projectionId } })
      return fresh ? toProjectionRecord(fresh) : null
    })
  }

  async retryProjectionWrite(
    projectionId: string,
    generation: bigint,
    leaseOwner: string,
    nextAttemptAt: Date,
    errorCode: string,
    keepWriteMutex = false
  ): Promise<boolean> {
    return this.transaction(async (tx) => {
      const current = await this.lockReviewProjectionById(tx, projectionId)
      if (!current || current.generation !== generation || current.leaseOwner !== leaseOwner) return false
      const changed = await tx.hookReviewProjection.updateMany({
        where: { id: projectionId, generation, leaseOwner },
        data: {
          attempts: { increment: 1 },
          lastErrorCode: errorCode,
          nextAttemptAt,
          leaseOwner: null,
          leaseUntil: null,
          ...(keepWriteMutex ? {} : { writeMarker: null, writePhase: null, writeStartedAt: null })
        }
      })
      return changed.count === 1
    })
  }

  /** Nothing left to publish: drop the row out of the due set instead of leaving it to be
   *  claimed, re-written, and claimed again. Not a failure, so `lastErrorCode` clears too. */
  async settleReviewProjection(projectionId: string, generation: bigint, leaseOwner: string): Promise<boolean> {
    return this.transaction(async (tx) => {
      const current = await this.lockReviewProjectionById(tx, projectionId)
      if (!current || current.generation !== generation || current.leaseOwner !== leaseOwner) return false
      // Re-read under the row lock: a converge that landed while this worker held the lease has
      // already re-armed the row, and clearing its due time would strand the new intent.
      if (
        current.desiredState !== current.observedState ||
        current.pendingIntent !== null ||
        current.writePhase !== null ||
        current.writeMarker !== null
      ) {
        return false
      }
      const changed = await tx.hookReviewProjection.updateMany({
        where: { id: projectionId, generation, leaseOwner },
        data: { nextAttemptAt: null, leaseOwner: null, leaseUntil: null, lastErrorCode: null, attempts: 0 }
      })
      return changed.count === 1
    })
  }

  async blockProjection(
    projectionId: string,
    generation: bigint,
    errorCode: string,
    keepWriteMutex = false
  ): Promise<boolean> {
    return this.transaction(async (tx) => {
      const current = await this.lockReviewProjectionById(tx, projectionId)
      if (!current || current.generation !== generation) return false
      const cleanupPending = current.tombstonedAt !== null && current.pendingIntent !== null
      const changed = await tx.hookReviewProjection.updateMany({
        where: { id: projectionId, generation },
        data: {
          lastErrorCode: errorCode,
          // A definitive old-write failure may clear its marker, but cannot
          // strand a tombstone that was serialized immediately before it.
          nextAttemptAt: cleanupPending ? current.tombstonedAt : null,
          leaseOwner: null,
          leaseUntil: null,
          ...(keepWriteMutex ? {} : { writeMarker: null, writePhase: null, writeStartedAt: null })
        }
      })
      return changed.count === 1
    })
  }

  async tombstoneReviewProjectionsForAgentRepo(
    agentId: AgentId,
    repoId: bigint,
    at: Date,
    desiredState: string
  ): Promise<number> {
    return this.transaction(async (tx) => {
      await lockHookReviewAgentRepoScope(tx, agentId, repoId)
      const rows = await tx.hookReviewProjection.findMany({ where: { agentId, repoId } })
      return this.tombstoneProjectionRows(tx, rows, at, desiredState)
    })
  }

  async tombstoneReviewProjections(hookIds: HookId[], at: Date, desiredState: string): Promise<number> {
    if (hookIds.length === 0) return 0
    return this.transaction(async (tx) => {
      const ids = [...new Set(hookIds)].sort()
      for (const hookId of ids) await lockHookReviewLifecycleScope(tx, hookId)
      // This API is the pre-cascade Agent-delete fence. Make every affected hook
      // inert in the same transaction so a missing projection cannot appear in
      // the gap before the Agent row (and its HookDefs) is deleted.
      await tx.hookDef.updateMany({
        where: { id: { in: ids } },
        data: {
          enabled: false,
          configRevision: { increment: 1 },
          dispatchRevision: { increment: 1 },
          projectionEpoch: { increment: 1 }
        }
      })
      const rows = await tx.hookReviewProjection.findMany({ where: { hookId: { in: ids } } })
      // The Agent-delete cascade reaches the §16 ledger only here — it has no FK to ride.
      await tombstoneCodeHostRunProjections(tx, { hookIds: ids }, at)
      return this.tombstoneProjectionRows(tx, rows, at, desiredState)
    })
  }

  /**
   * Two-phase organization deletion barrier for R2a.
   *
   * The first call makes every hook inert and persists failing cleanup while
   * retaining the Org/GithubInstallation rows used by cleanup-only minting. A
   * later call deletes projection/run metadata and the org in the same
   * transaction only after every externally possible Check is durably known
   * non-passing. There is deliberately no force-delete path.
   */
  async deleteOrgWithReviewProjectionCleanup(
    orgId: OrgId,
    at: Date,
    shredTarget: { mount: string; keyName: string }
  ): Promise<{
    status: 'deleted' | 'review_cleanup_pending' | 'daemons_present'
    removedHookIds: string[]
  }> {
    return this.transaction(
      async (tx) => {
        // Outermost lifecycle fence. Agent/Hook/projection creation takes the
        // advisory lock before touching the parent row or any narrower scope, so
        // the following FOR UPDATE cannot invert parent-FK and agent locks.
        await lockHookReviewOrgLifecycleScope(tx, orgId)
        const orgRows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "org"
        WHERE "id" = ${orgId}
        FOR UPDATE
      `)
        if (orgRows.length === 0) await tx.org.findUniqueOrThrow({ where: { id: orgId } })

        // The route's registry read is only an early UX optimization. A daemon
        // may be provisioned after that read, so the parent-row lock above and
        // this transactional recheck are the authoritative RESTRICT-FK barrier.
        // Holding Org FOR UPDATE also blocks later daemon inserts until this
        // transaction either commits the delete or returns this conflict.
        if ((await tx.daemon.count({ where: { orgId } })) > 0) {
          return { status: 'daemons_present' as const, removedHookIds: [] }
        }

        // Extend the existing global order with the org row as an outer prefix:
        // org -> agent lifecycle -> hook lifecycle -> HookRun -> projection row.
        // Hook CRUD takes agent -> hook, while run/result paths take HookRun ->
        // projection, so this order cannot form a reverse wait cycle.
        const agentRows = await tx.agent.findMany({
          where: { orgId },
          select: { id: true },
          orderBy: { id: 'asc' }
        })
        for (const row of agentRows) await lockHookReviewAgentLifecycleScope(tx, AgentId(row.id))

        // Include historical/orphan projection and run hook ids as well as live
        // definitions. Delayed coordinator/report paths use the same hook lock,
        // closing both live-row and no-row creation windows.
        // Interactive transactions use one pg client; keep its queries strictly
        // sequential (parallel client.query calls are deprecated by pg@9).
        const hookRows = await tx.hookDef.findMany({ where: { orgId }, select: { id: true } })
        const projectionHooks = await tx.hookReviewProjection.findMany({
          where: { orgId },
          select: { hookId: true },
          distinct: ['hookId']
        })
        const runHooks = await tx.hookRun.findMany({
          where: { orgId },
          select: { hookId: true },
          distinct: ['hookId']
        })
        const hookIds = [
          ...new Set([
            ...hookRows.map((row) => row.id),
            ...projectionHooks.map((row) => row.hookId),
            ...runHooks.map((row) => row.hookId)
          ])
        ].sort()
        for (const id of hookIds) await lockHookReviewLifecycleScope(tx, HookId(id))

        await tx.hookDef.updateMany({
          where: { orgId },
          data: {
            enabled: false,
            configRevision: { increment: 1 },
            dispatchRevision: { increment: 1 },
            projectionEpoch: { increment: 1 }
          }
        })

        // Lock all history before any projection. Formal results/reports use the
        // same HookRun -> projection order, preventing a delete/result deadlock
        // and ensuring the final sweep sees their committed authority.
        await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "hook_run"
        WHERE "orgId" = ${orgId}
        ORDER BY "id"
        FOR UPDATE
      `)

        const projections = await tx.hookReviewProjection.findMany({ where: { orgId } })
        await this.tombstoneProjectionRows(tx, projections, at, 'failure')
        // Same sweep for the §16 ledger: its rows survive the organization's cascade by design.
        await tombstoneCodeHostRunProjections(tx, { orgId }, at)

        // A marker is durable before every external mutation. With no check id,
        // marker/phase, observed state, or write-start timestamp, there is proof
        // that no GitHub effect exists; settle those tombstones locally rather
        // than creating a cleanup Check solely to delete it.
        const afterTombstone = await tx.hookReviewProjection.findMany({ where: { orgId } })
        for (const row of afterTombstone) {
          const noExternalEffect =
            row.checkRunId === null &&
            row.writeMarker === null &&
            row.writePhase === null &&
            row.writeStartedAt === null &&
            row.observedState === null
          if (!noExternalEffect || row.desiredState !== 'failure') continue
          await tx.hookReviewProjection.update({
            where: { id: row.id },
            data: {
              observedState: row.desiredState,
              pendingIntent: Prisma.DbNull,
              leaseOwner: null,
              leaseUntil: null,
              nextAttemptAt: null,
              attempts: 0,
              lastErrorCode: null
            }
          })
        }

        const settledRows = await tx.hookReviewProjection.findMany({ where: { orgId } })
        const associationErrors = new Set([
          'pr_association_incomplete',
          'no_current_pull_request',
          'stale_head',
          'shared_head_multiple_prs'
        ])
        const allSettled = settledRows.every((row) => {
          const noOutstandingWork =
            row.tombstonedAt !== null &&
            row.writeMarker === null &&
            row.writePhase === null &&
            row.writeStartedAt === null &&
            row.pendingIntent === null &&
            row.leaseOwner === null &&
            row.leaseUntil === null &&
            row.nextAttemptAt === null
          if (!noOutstandingWork) return false
          if (row.desiredState === 'failure' && row.observedState === 'failure') return true
          return (
            row.desiredState === 'failure' &&
            row.observedState === 'action_required' &&
            row.subjectSyncGeneration === row.generation &&
            row.subjectSyncErrorCode !== null &&
            associationErrors.has(row.subjectSyncErrorCode) &&
            row.lastErrorCode === row.subjectSyncErrorCode
          )
        })

        if (!allSettled)
          return { status: 'review_cleanup_pending' as const, removedHookIds: hookRows.map((row) => row.id) }

        // These metadata tables have no owner FK by design. Remove them explicitly
        // in the same fenced transaction as the final Org cascade.
        await tx.hookReviewProjection.deleteMany({ where: { orgId } })
        await tx.hookRun.deleteMany({ where: { orgId } })
        // Record the crypto-shred intent in the SAME transaction as the delete
        // (docs/designs/per-org-secret-encryption.md §6). Deleting the Vault key
        // is a remote effect that cannot join this transaction, and after the
        // org row is gone nothing else remembers the id, so the tombstone is the
        // only durable link between "this org was deleted" and "its key must
        // die". Nothing here destroys a key — the operator-run shred CLI does,
        // under its own identity. `createMany` + skipDuplicates keeps a re-run
        // harmless if a prior attempt already recorded the intent.
        await tx.pendingKeyShred.createMany({
          data: [{ orgId, mount: shredTarget.mount, keyName: shredTarget.keyName }],
          skipDuplicates: true
        })
        await tx.org.delete({ where: { id: orgId } })
        return { status: 'deleted' as const, removedHookIds: hookRows.map((row) => row.id) }
      },
      { timeout: 30_000 }
    )
  }

  private async tombstoneProjectionRows(
    tx: Prisma.TransactionClient,
    rows: readonly HookReviewProjection[],
    at: Date,
    desiredState: string
  ): Promise<number> {
    // Deterministic id order avoids deadlocks when hook deletion and repo-grant
    // revocation overlap. Re-read every row under the same lock used by
    // begin/upsert: the initial scope query is only a candidate list and may be
    // stale by the time this transaction reaches a particular projection.
    const ids = [...new Set(rows.map((row) => row.id))].sort()
    let changed = 0
    for (const id of ids) {
      const row = await this.lockReviewProjectionById(tx, id)
      if (!row) continue
      if (row.tombstonedAt !== null) {
        // Tombstones never regain run authority, but cleanup intent may become
        // stricter: a later repository-authorization revocation must upgrade an
        // earlier neutral cleanup to failure. The reverse transition
        // is forbidden. When an old write/pending generation is still draining,
        // upgrade that pending tombstone instead of touching its write mutex.
        if (desiredState !== 'failure') continue
        if (row.writePhase !== null || row.pendingIntent !== null) {
          if (pendingDesiredState(row.pendingIntent) === 'failure') continue
          await tx.hookReviewProjection.update({
            where: { id: row.id },
            data: {
              pendingIntent: {
                desiredState: 'failure',
                tombstoned: true,
                nextAttemptAt: at.toISOString()
              },
              nextAttemptAt: at
            }
          })
          changed += 1
          continue
        }
        if (row.desiredState !== 'neutral') continue
        await tx.hookReviewProjection.update({
          where: { id: row.id },
          data: {
            generation: { increment: 1 },
            desiredState: 'failure',
            observedState: null,
            nextAttemptAt: at,
            attempts: 0,
            lastErrorCode: null,
            leaseOwner: null,
            leaseUntil: null
          }
        })
        changed += 1
        continue
      }
      if (row.writePhase !== null) {
        await tx.hookReviewProjection.update({
          where: { id: row.id },
          data: {
            tombstonedAt: at,
            pendingIntent: {
              desiredState,
              tombstoned: true,
              nextAttemptAt: at.toISOString()
            }
          }
        })
      } else {
        await tx.hookReviewProjection.update({
          where: { id: row.id },
          data: {
            tombstonedAt: at,
            generation: { increment: 1 },
            desiredState,
            observedState: null,
            nextAttemptAt: at,
            attempts: 0,
            lastErrorCode: null,
            pendingIntent: Prisma.DbNull,
            leaseOwner: null,
            leaseUntil: null
          }
        })
      }
      changed += 1
    }
    return changed
  }
}

export class PgHookSecretStore implements HookSecretStore {
  constructor(
    private readonly db: PrismaLike,
    private readonly cipher: SecretCipher
  ) {}

  async put(orgId: OrgId, hookId: HookId, hmacSecret: string): Promise<void> {
    // `hook_secret` is keyed by hookId alone, so the upsert cannot carry the org
    // in its predicate — check the parent row once instead.
    if ((await this.db.hookDef.count({ where: { id: hookId, orgId } })) === 0) {
      throw new Error('hook secret write outside its organization')
    }
    const sealed = await this.cipher.seal(hmacSecret, orgScope(orgId))
    await this.db.hookSecret.upsert({
      where: { hookId },
      create: { hookId, hmacSecret: sealed },
      update: { hmacSecret: sealed }
    })
  }

  async get(orgId: OrgId, hookId: HookId): Promise<string | null> {
    const s = await this.db.hookSecret.findFirst({ where: { hookId, hook: { orgId } } })
    return s ? this.cipher.open(s.hmacSecret, orgScope(orgId)) : null
  }

  async delete(orgId: OrgId, hookId: HookId): Promise<void> {
    // idempotent (FK cascade may have run)
    await this.db.hookSecret.deleteMany({ where: { hookId, hook: { orgId } } })
  }
}
