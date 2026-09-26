import {
  isRetryableRouteAck,
  runDecisionChain,
  decisionChainUsage,
  type DecisionRoutingStep,
  matchDecisionCondition,
  type DecisionBundleDefinition,
  type DecisionChainEvaluation,
  partitionRoutingConstraint,
  resolveRoutingTargets,
  type DecisionBundle,
  type DecisionEvaluation,
  type DecisionQuestion,
  type RdMsgIm,
  type RdRouteAck,
  type RdRouteAgentRef,
  type RdRouteBackfillRow,
  type RdRouteEffect,
  type RdRouteReport,
  type RdRouteResult,
  type RdRouteSelectionBody,
  type RdRoutingConstraintEntry,
  type RoutingConstraintInput,
  type SharedBotDecisionRouting
} from '@agentconnect.md/protocol'
import type { NormalizedMessage } from '../messages/normalized.js'
import { threadRootResolver } from '../platforms/thread-keys.js'
import { AsyncMutex } from '../store/async-mutex.js'
import type { ChannelRecordRef, DecisionVerdictRow, LocalStore, RouterTargetUpdate } from '../store/local-store.js'
import {
  resolveDecisionBundle,
  routerFingerprint,
  type ResolvedDecisionBundle,
  type ResolvedRoutedChannel
} from './bundle.js'
import { rawAnswerFields, type DecisionEvaluationInput } from './evaluator.js'
import type { DecisionEvidence, DecisionUnavailableReason } from './evidence.js'
import { DEFAULT_DECISION_GATE_LIMITS } from './gate.js'
import { DecisionLaneRuntime, laneId, verdictKey, type Lane } from './lanes.js'
import { defaultDecisionGateMetrics, type DecisionGateMetrics } from './metrics.js'
import { buildDecisionState, largestDecisionRequest, type DecisionStateBudget } from './state.js'

export const DEFAULT_DECISION_ROUTER_LIMITS = {
  ...DEFAULT_DECISION_GATE_LIMITS,
  /** How long an early follow-up waits for its thread root's result (decisions.md §7.4). */
  rootWaitMs: DEFAULT_DECISION_GATE_LIMITS.participationWaitMs,
  /** How long a remote target may keep answering `retry` before it is Target unavailable. */
  targetRetryMs: 60_000,
  /** Delay before a lane re-drains a head whose targets asked to retry. */
  retryDelayMs: 1_000,
  /** Concurrent target admissions or forwards of one verdict. */
  forwardActive: 4,
  /** How long an unaccepted owner/participant report keeps retrying with backoff. */
  reportRetryMs: 10 * 60_000,
  /** The report retry backoff's ceiling. */
  reportBackoffMaxMs: 30_000
}
export type DecisionRouterLimits = typeof DEFAULT_DECISION_ROUTER_LIMITS

/** The router's subject: one verdict per row for the bot's routing scope (message-intake.md §4.3). */
export const routerSubject = (botId: string): string => `router:${botId}`

/** The admission receipt of one routed target; on a shared store host and remote admissions share it. */
export function decisionRouteReceiptId(seq: number, agentId: string): string {
  return `decision-route:${seq}:${agentId}`
}

export type RouterTargetDisposition = 'pending' | 'admitted' | 'rejected' | 'unavailable'

/** One entry of a router verdict's frozen target set, persisted in `targetsJson`. */
export interface RouterTarget {
  agentId: string
  daemonId: string | null
  integrationId?: string
  participant: boolean
  effect: RdRouteEffect
  via: 'mention' | 'implicit'
  sessionMode?: string
  disposition: RouterTargetDisposition
  reason?: string
  backgroundSeqs?: number[]
  attempts?: number
  retryUntil?: number
}

/** The frozen, credential-free routing configuration a router verdict carries. */
export interface FrozenRouterConfig {
  definitions?: DecisionBundleDefinition[]
  botId: string
  channel: string
  decisionId: string
  providerId: string
  model: string
  question: DecisionQuestion
  routing: SharedBotDecisionRouting
  defaultAgentId?: string
  fingerprint: string
  hostDaemonId: string
}

/** What a router verdict releases, persisted as its `deliveryJson` until every target is terminal. */
export interface RouterDelivery {
  rd: Omit<RdMsgIm, 'searchActionToken'>
  msg: NormalizedMessage
  relayId?: string
  constraint: RdRoutingConstraintEntry[]
  /** The constraint as frozen for evaluation (root recipients and local participants added), written with `evaluating`. */
  frozenConstraint?: RoutingConstraintInput[]
  candidates: RdRouteAgentRef[]
  /** The recorded row's physical thread, which an early follow-up waits on. */
  thread: string | null
}

export interface RouterCandidate {
  botId: string
  integrationId: string
  carrierAgentId: string
  rawChannel: string
  record: ChannelRecordRef
  routing: NonNullable<ResolvedRoutedChannel['routing']>
  delivery: RouterDelivery
}

export type RouterIntakeOutcome = { kind: 'pending' } | { kind: 'duplicate' } | { kind: 'held'; reason: string }

export type CurrentRouting =
  | { status: 'unknown' }
  | { status: 'not_host' }
  | { status: 'disabled'; reason: string }
  | { status: 'enabled'; routing: NonNullable<ResolvedRoutedChannel['routing']>; fingerprint: string }

export interface RouterAdmitRequest {
  verdict: DecisionVerdictRow
  target: RouterTarget & { integrationId: string }
  delivery: RouterDelivery
  evidence: DecisionEvidence
  receiptId: string
  beforeDispatch: () => boolean
}

export type RouterAdmitResult = { kind: 'admitted' } | { kind: 'rejected'; reason: string; recoverable: boolean }

export interface RouterForwardRequest {
  verdict: DecisionVerdictRow
  target: RouterTarget
  delivery: RouterDelivery
  deliveryId: string
  selection: RdRouteSelectionBody
  backfill: RdRouteBackfillRow[]
}

export interface DecisionRouterHost {
  store(): LocalStore
  ownerFence(): string
  now(): number
  selfDaemonId(): string
  evaluate(input: DecisionEvaluationInput, signal: AbortSignal): Promise<DecisionEvaluation>
  currentRouting(integrationId: string, channel: string): CurrentRouting
  configConverged(): boolean
  /** A local agent with an install on this bot, its session mode here, and whether this member holds its duty. */
  localTarget(
    botId: string,
    agentId: string,
    channel: string
  ): { integrationId: string; sessionMode: string; served: boolean } | undefined
  participates(agentId: string, msg: NormalizedMessage): Promise<boolean>
  admitLocal(request: RouterAdmitRequest): Promise<RouterAdmitResult>
  forwardRemote(request: RouterForwardRequest): Promise<RdRouteAck>
  report(report: RdRouteReport, relayId?: string): Promise<{ accepted: boolean; reason?: string }>
  backfill(orgId: string, channel: string, seq: number): Promise<RdRouteBackfillRow[]>
  log: { debug(message: string): void; info(message: string): void; warn(message: string): void }
  metrics?: DecisionGateMetrics
}

type CancelReason = 'stop' | 'config_changed' | 'host_reassigned' | 'integration_removed' | 'shutdown' | 'ownership'

interface Task {
  lane: Lane
  integrationId: string
  channel: string
  controller: AbortController
  cancelReason?: CancelReason
}

interface ReleaseToken {
  integrationId: string
  config: FrozenRouterConfig
  targetIntegrationId: string
  targetSessionMode?: string
  agentId: string
  channel: string
  refused?: { reason?: string }
}

interface PendingReport {
  report: RdRouteReport
  relayId?: string
  attempts: number
  giveUpAt: number
  timer?: ReturnType<typeof setTimeout>
  inFlight?: boolean
}

interface RouterAnswer {
  chain?: DecisionChainEvaluation[]
  answer?: unknown
  matchedRuleIds?: string[]
  matchedKeys?: string[]
  usedOtherwise?: boolean
  evaluated?: false
  recovered?: boolean
  fallback?: string
  request?: string
  raw?: string
  rawTruncated?: true
}

const TERMINAL_UNAVAILABLE = new Set(['not_member', 'unsupported', 'off', 'routing_disabled', 'no_agent'])

function parseJson<T>(text: string | null | undefined): T | undefined {
  if (!text) return undefined
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

/** The routed-forward target check (message-intake.md §6 step 6), pure over what the target daemon knows. */
export function routedTargetCheck(input: {
  agentAuthored: boolean
  admitted: boolean
  command: { kind: string } | null
  routing: ResolvedRoutedChannel | undefined
}): { ok: true } | { ok: false; reason: 'rejected' | 'off' | 'routing_disabled' | 'not_ready'; recoverable: boolean } {
  if (input.agentAuthored) return { ok: false, reason: 'rejected', recoverable: false }
  if (input.command && input.command.kind !== 'queue') return { ok: false, reason: 'rejected', recoverable: false }
  // No binding here is Pending sync (decisions.md §7.2): this bundle lags the relay, so the host retries, bounded.
  if (!input.routing) return { ok: false, reason: 'not_ready', recoverable: true }
  if (!input.admitted) return { ok: false, reason: 'off', recoverable: false }
  // Pause and needs-review are refusals here, never a fallback; the relay already verified the host.
  if (!input.routing.enabled) return { ok: false, reason: 'routing_disabled', recoverable: false }
  return { ok: true }
}

/** The Stage 2 shared-bot router (decisions.md §7.4): one evaluation per row, a frozen target set, in-order release. */
export class DecisionRouter {
  private readonly metrics: DecisionGateMetrics
  private readonly tasks = new Map<string, Task>()
  private readonly lanes = new Map<string, Lane>()
  private readonly intakes = new Map<string, Promise<RouterIntakeOutcome>>()
  private readonly releasing = new Map<string, ReleaseToken>()
  private readonly applied = new Map<string, ResolvedDecisionBundle | null>()
  private readonly appliedModes = new Map<string, ReadonlyMap<string, string>>()
  private readonly stopped = new Map<string, Set<string>>()
  private readonly mutexes = new Map<string, AsyncMutex>()
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>()
  private readonly reports = new Map<string, PendingReport>()
  private closed = false

  constructor(
    private readonly host: DecisionRouterHost,
    readonly runtime: DecisionLaneRuntime = new DecisionLaneRuntime(DEFAULT_DECISION_ROUTER_LIMITS),
    private readonly limits: DecisionRouterLimits = DEFAULT_DECISION_ROUTER_LIMITS
  ) {
    this.metrics = host.metrics ?? defaultDecisionGateMetrics
  }

  /** A relay-forwarded routed message, recorded at `record`: reserve its verdict, then evaluate off the ACK path. */
  async intake(c: RouterCandidate): Promise<RouterIntakeOutcome> {
    if (this.closed) return { kind: 'held', reason: 'closed' }
    const key = verdictKey(c.record.seq, routerSubject(c.botId))
    const owner = this.intakes.get(key)
    // Single-flight per row: a concurrent duplicate joins the owner and never reserves on its own.
    if (owner) return await owner.catch((): RouterIntakeOutcome => ({ kind: 'held', reason: 'record_unavailable' }))
    const run = this.intakeOnce(key, c)
    this.intakes.set(key, run)
    try {
      return await run
    } finally {
      if (this.intakes.get(key) === run) this.intakes.delete(key)
    }
  }

  private async intakeOnce(key: string, c: RouterCandidate): Promise<RouterIntakeOutcome> {
    const store = this.host.store()
    const subject = routerSubject(c.botId)
    const { seq } = c.record
    const lane: Lane = { orgId: c.record.orgId, channel: c.record.transcriptChannel, subject }
    let existing: DecisionVerdictRow | undefined
    try {
      existing = await store.getDecisionVerdict(seq, subject)
    } catch (err) {
      this.host.log.warn(`decision-router: verdict lookup failed: ${(err as Error).message}`)
      return { kind: 'held', reason: 'record_unavailable' }
    }
    if (existing) return this.joinExisting(existing, lane)
    const task: Task = {
      lane,
      integrationId: c.integrationId,
      channel: c.rawChannel,
      controller: new AbortController()
    }
    this.tasks.set(key, task)
    const now = this.host.now()
    const config: FrozenRouterConfig = {
      botId: c.botId,
      channel: c.rawChannel,
      decisionId: c.routing.definition.id,
      ...(c.routing.definitions ? { definitions: c.routing.definitions } : {}),
      providerId: c.routing.definition.providerId,
      model: c.routing.definition.model,
      question: c.routing.definition.question,
      routing: c.routing.config,
      ...(c.routing.defaultAgentId ? { defaultAgentId: c.routing.defaultAgentId } : {}),
      fingerprint: routerFingerprint(c.routing, c.rawChannel),
      hostDaemonId: this.host.selfDaemonId()
    }
    // An early follow-up waits for its root before it may evaluate, so its deadline covers that wait.
    const rootPending = await this.pendingRootIn(c.record, subject).catch(() => false)
    let reserved: Awaited<ReturnType<LocalStore['reserveDecisionVerdict']>>
    try {
      reserved = await store.reserveDecisionVerdict({
        seq,
        subject,
        orgId: lane.orgId,
        channel: lane.channel,
        agentId: c.carrierAgentId,
        integrationId: c.integrationId,
        decisionId: config.decisionId,
        configJson: JSON.stringify(config),
        deliveryJson: JSON.stringify(c.delivery),
        requestedModel: config.model,
        deadlineAt: now + this.limits.deadlineMs + (rootPending ? this.limits.rootWaitMs : 0),
        ownerFence: this.host.ownerFence(),
        createdAt: now
      })
    } catch (err) {
      if (this.tasks.get(key) === task) this.tasks.delete(key)
      this.host.log.warn(`decision-router: verdict reservation failed: ${(err as Error).message}`)
      return { kind: 'held', reason: 'record_unavailable' }
    }
    if (!reserved.created) {
      if (this.tasks.get(key) === task) this.tasks.delete(key)
      if (!reserved.verdict) return { kind: 'held', reason: 'record_unavailable' }
      return this.joinExisting(reserved.verdict, lane)
    }
    this.lanes.set(laneId(lane), lane)
    this.runtime.track(this.evaluateTask(key, task, reserved.verdict!, c.delivery, config))
    return { kind: 'pending' }
  }

  private joinExisting(row: DecisionVerdictRow, lane: Lane): RouterIntakeOutcome {
    if (row.state === 'admitted') return { kind: 'duplicate' }
    if (row.state === 'skipped' || row.state === 'canceled') return { kind: 'held', reason: row.state }
    this.drain(lane)
    return { kind: 'pending' }
  }

  /** `!stop` / `!cancel`: refuse this agent's pending targets in this conversation; its siblings keep running. */
  async cancelForAgent(agentId: string, transcriptChannel: string, reason: 'stop' | 'cancel'): Promise<number> {
    const store = this.host.store()
    const rows = await store.listPendingDecisionVerdicts({ channel: transcriptChannel, consumer: 'router' })
    let refused = 0
    for (const row of rows) {
      const key = verdictKey(row.seq, row.subject)
      const stopped = this.stopped.get(key) ?? new Set<string>()
      stopped.add(agentId)
      this.stopped.set(key, stopped)
      const token = this.releasing.get(`${key}:${agentId}`)
      if (token) token.refused ??= { reason: 'stopped' }
      if (row.state === 'settled') {
        const targets = parseJson<RouterTarget[]>(row.targetsJson) ?? []
        if (!targets.some((t) => t.agentId === agentId && t.disposition === 'pending')) continue
        await this.updateTargets(row, [
          { agentId, disposition: 'rejected', reason: reason === 'stop' ? 'stopped' : 'canceled' }
        ])
        refused += 1
      } else refused += 1
      this.drain({ orgId: row.orgId, channel: row.channel, subject: row.subject })
    }
    return refused
  }

  /** A relevant routing change, a pause, or host reassignment cancels pending work; it never reinterprets it. */
  async onConfigApplied(
    integrationId: string,
    _previous?: DecisionBundle,
    next?: DecisionBundle,
    sessionModes?: readonly { channel: string; mode: string }[]
  ): Promise<void> {
    const store = this.host.store()
    const bundle = next ? resolveDecisionBundle(next) : undefined
    this.applied.set(integrationId, bundle ?? null)
    if (sessionModes) this.appliedModes.set(integrationId, new Map(sessionModes.map((m) => [m.channel, m.mode])))
    else if (!bundle) this.appliedModes.delete(integrationId)
    // Synchronously, before any await: a local admission already past its recheck must not reach dispatch.
    for (const token of this.releasing.values()) {
      if (token.integrationId === integrationId) {
        const stale = this.appliedStale(integrationId, token.config)
        if (stale) token.refused ??= stale === 'wait' ? {} : { reason: stale }
      }
      if (
        token.targetIntegrationId === integrationId &&
        this.modeChanged(integrationId, token.channel, token.targetSessionMode)
      )
        token.refused ??= { reason: 'config_changed' }
    }
    const pending = await store.listPendingDecisionVerdicts({ integrationId, consumer: 'router' })
    for (const row of pending) {
      const config = parseJson<FrozenRouterConfig>(row.configJson)
      const stale = config ? this.appliedStale(integrationId, config) : 'config_changed'
      if (!stale) continue
      const key = verdictKey(row.seq, row.subject)
      // A shared store's new host adopts the row; only this process's work stops.
      if (stale === 'wait' || (stale === 'host_reassigned' && store.isShared)) {
        this.abortTask(key, 'ownership')
        continue
      }
      this.abortTask(key, stale === 'integration_removed' ? 'integration_removed' : 'config_changed')
      await this.cancelRow(row, stale)
    }
    await this.recover()
  }

  /** Startup and reconfiguration: settle orphaned evaluations as unavailable and resume unfinished targets. */
  async recover(): Promise<void> {
    const store = this.host.store()
    const rows = await store.listPendingDecisionVerdicts({ consumer: 'router' })
    const lanes = new Map<string, Lane>()
    for (const row of rows) {
      if (this.tasks.has(verdictKey(row.seq, row.subject))) continue
      const config = parseJson<FrozenRouterConfig>(row.configJson)
      if (!config) continue
      const current = this.host.currentRouting(row.integrationId, config.channel)
      if (current.status === 'unknown' && !this.host.configConverged()) continue
      if (current.status !== 'enabled' || current.fingerprint !== config.fingerprint) {
        // Not hosted here: a shared store leaves it for the new host; an exclusive one cancels it.
        if (store.isShared && (current.status === 'not_host' || current.status === 'unknown')) continue
        const reason =
          current.status === 'enabled'
            ? 'config_changed'
            : current.status === 'disabled'
              ? current.reason
              : current.status === 'unknown'
                ? 'integration_removed'
                : 'host_reassigned'
        await this.cancelRow(row, reason).catch((err) =>
          this.host.log.warn(`decision-router: recovery cancel failed: ${(err as Error).message}`)
        )
        continue
      }
      const lane = { orgId: row.orgId, channel: row.channel, subject: row.subject }
      try {
        // An unsettled follow-up whose root is still pending settles in lane order, once the root's recipients are known.
        if (!(await this.rootPendingFor(row))) await this.recoverVerdict(row, config)
      } catch (err) {
        this.host.log.warn(`decision-router: verdict recovery failed: ${(err as Error).message}`)
      }
      lanes.set(laneId(lane), lane)
    }
    for (const lane of lanes.values()) this.drain(lane)
  }

  /** Re-drain every known lane and resend unaccepted reports, e.g. once the control plane's configuration converged. */
  kick(): void {
    for (const lane of this.lanes.values()) this.drain(lane)
    for (const [key, pending] of this.reports) {
      if (pending.inFlight) continue
      if (pending.timer) clearTimeout(pending.timer)
      pending.timer = undefined
      this.sendReport(key, pending)
    }
  }

  /** Stop in-memory work for conversations this daemon no longer hosts; their rows stay for the next host. */
  retainHosted(): void {
    for (const [key, task] of this.tasks) {
      const current = this.host.currentRouting(task.integrationId, task.channel)
      if (current.status === 'not_host' || current.status === 'unknown') this.abortTask(key, 'ownership')
    }
  }

  /** Shutdown aborts evaluations and writes nothing; a restart recovers them as unavailable. */
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const key of this.tasks.keys()) this.abortTask(key, 'shutdown')
    for (const timer of this.retryTimers) clearTimeout(timer)
    this.retryTimers.clear()
    for (const pending of this.reports.values()) if (pending.timer) clearTimeout(pending.timer)
    this.reports.clear()
    this.runtime.close()
  }

  /** Settles once no evaluation, drain, or release is in flight (tests). */
  async idle(): Promise<void> {
    await this.runtime.idle()
  }

  private abortTask(key: string, reason: CancelReason): void {
    const task = this.tasks.get(key)
    if (!task) return
    task.cancelReason ??= reason
    task.controller.abort(reason)
  }

  private mutexFor(key: string): AsyncMutex {
    let mutex = this.mutexes.get(key)
    if (!mutex) {
      if (this.mutexes.size > 1000) this.mutexes.clear()
      mutex = new AsyncMutex()
      this.mutexes.set(key, mutex)
    }
    return mutex
  }

  /** Serialized per verdict: pending → terminal only, under the owner fence. */
  private async updateTargets(
    row: DecisionVerdictRow,
    updates: RouterTargetUpdate[]
  ): Promise<RouterTarget[] | undefined> {
    const key = verdictKey(row.seq, row.subject)
    const fence = this.host.ownerFence()
    return (await this.mutexFor(key).run(() =>
      this.host.store().updateRouterTargets(row.seq, row.subject, fence, updates)
    )) as RouterTarget[] | undefined
  }

  /** Cancel a pending verdict: an unsettled one outright, a settled one by refusing its pending targets. */
  private async cancelRow(row: DecisionVerdictRow, reason: string): Promise<void> {
    const store = this.host.store()
    const key = verdictKey(row.seq, row.subject)
    const current = await store.getDecisionVerdict(row.seq, row.subject)
    if (!current) return
    if (current.state === 'settled') {
      if (current.ownerFence !== this.host.ownerFence())
        await store.adoptDecisionVerdict(current.seq, current.subject, current.ownerFence, this.host.ownerFence())
      const targets = parseJson<RouterTarget[]>(current.targetsJson) ?? []
      const updates = targets
        .filter((t) => t.disposition === 'pending')
        .map((t) => ({ agentId: t.agentId, disposition: 'rejected' as const, reason }))
      const fresh = (await store.getDecisionVerdict(row.seq, row.subject)) ?? current
      const written = updates.length ? await this.updateTargets(fresh, updates) : targets
      await this.finalize(
        fresh,
        parseJson<FrozenRouterConfig>(fresh.configJson),
        parseJson<RouterDelivery>(fresh.deliveryJson),
        written ?? targets
      )
      return
    }
    if (await store.finishDecisionVerdict(row.seq, row.subject, null, 'canceled', reason, this.host.now()))
      this.finished(key, 'canceled', reason)
    this.drain({ orgId: row.orgId, channel: row.channel, subject: row.subject })
  }

  /** Is there an earlier, unfinished router verdict in this row's physical thread? */
  private async pendingRootIn(record: ChannelRecordRef, subject: string): Promise<boolean> {
    if (!record.thread) return false
    const rows = await this.host.store().routerVerdictsInThread({
      orgId: record.orgId,
      channel: record.transcriptChannel,
      subject,
      thread: record.thread,
      beforeSeq: record.seq
    })
    return rows.some((r) => r.state === 'reserved' || r.state === 'evaluating' || r.state === 'settled')
  }

  /** Is this unsettled row an early follow-up whose root has not finished? */
  private async rootPendingFor(row: DecisionVerdictRow): Promise<boolean> {
    if (row.state !== 'reserved' && row.state !== 'evaluating') return false
    const thread = parseJson<RouterDelivery>(row.deliveryJson)?.thread
    if (!thread) return false
    return await this.pendingRootIn(
      { seq: row.seq, orgId: row.orgId, transcriptChannel: row.channel, thread },
      row.subject
    )
  }

  private async evaluateTask(
    key: string,
    task: Task,
    row: DecisionVerdictRow,
    delivery: RouterDelivery,
    config: FrozenRouterConfig
  ): Promise<void> {
    const store = this.host.store()
    const fence = this.host.ownerFence()
    const signal = task.controller.signal
    let release: (() => void) | undefined
    let constraint: RoutingConstraintInput[] | undefined
    try {
      constraint = await this.freezeConstraint(row, delivery, signal)
      const { participants, eligible, evaluate } = partitionRoutingConstraint(constraint)
      if (!evaluate) {
        // Every constrained recipient already participates: the set settles with no model call.
        await this.settle(key, row, config, delivery, constraint, 'none', { answerJson: { evaluated: false } })
        return
      }
      const slot = await this.runtime.slots.acquire(config.providerId, row.deadlineAt, signal, () => this.host.now())
      if (slot.kind === 'capacity') {
        this.metrics.capacity(slot.scope)
        await this.settle(key, row, config, delivery, constraint, 'unavailable', { reason: 'capacity' })
        return
      }
      if (slot.kind === 'timeout') {
        await this.settle(key, row, config, delivery, constraint, 'unavailable', { reason: 'timeout' })
        return
      }
      release = slot.release
      signal.throwIfAborted()
      const rootTsOf = threadRootResolver(delivery.msg.platform, delivery.msg.isDm)
      const window = await store.decisionWindow(row.orgId, row.channel, row.seq, undefined, rootTsOf)
      signal.throwIfAborted()
      let built: ReturnType<typeof buildDecisionState> | undefined
      try {
        const budget = largestDecisionRequest<DecisionStateBudget>([config, ...(config.definitions ?? [])])
        built = window.current
          ? buildDecisionState({
              current: window.current,
              history: window.history,
              addressing: {
                mentions: delivery.msg.mentionedBots ?? [],
                constraint: {
                  eligibleAgentIds: eligible.map((e) => e.agentId),
                  participantAgentIds: participants.map((p) => p.agentId)
                }
              },
              full: window.full,
              rootMissing: window.rootMissing,
              question: budget.question,
              model: budget.model
            })
          : undefined
      } catch {
        built = undefined
      }
      if (!built || built.unsupported) {
        await this.settle(key, row, config, delivery, constraint, 'unavailable', { reason: 'unsupported_input' })
        return
      }
      const frozen = JSON.stringify({ ...delivery, frozenConstraint: constraint } satisfies RouterDelivery)
      if (!(await store.beginDecisionEvaluation(row.seq, row.subject, fence, JSON.stringify(built.state), frozen)))
        return
      let raw: string | undefined
      let request: string | undefined
      const definitions = new Map((config.definitions ?? []).map((definition) => [definition.id, definition]))
      const definitionOf = (id: string) => (id === config.decisionId ? config : definitions.get(id)!)
      const { evaluation, trace } = await runDecisionChain<DecisionRoutingStep>({
        root: config.routing,
        steps: config.routing.steps,
        deadlineAt: row.deadlineAt,
        now: () => this.host.now(),
        signal,
        evaluate: (step, index, signal) =>
          this.host.evaluate(
            {
              agentId: row.agentId,
              evaluationId: `${row.seq}:${row.subject}:${index}`,
              decision: definitionOf(step.decisionId),
              state: built.state,
              deadlineAt: row.deadlineAt,
              onRawRequest: (text) => {
                if (index === 0) request = text
              },
              onRawResponse: (text) => {
                if (index === 0) raw = text
              }
            },
            signal
          ),
        next: (step, result) =>
          step.rules.flatMap((rule) =>
            rule.action.type === 'decision' &&
            matchDecisionCondition(definitionOf(step.decisionId).question, rule.when, result.answer).matched
              ? [rule.action.nextStepId]
              : []
          )
      })
      signal.throwIfAborted()
      if (evaluation.status === 'unavailable') {
        await this.settle(key, row, config, delivery, constraint, 'unavailable', {
          reason: evaluation.reason,
          usage: decisionChainUsage(trace),
          chain: trace,
          raw,
          request
        })
        return
      }
      await this.settle(key, row, config, delivery, constraint, evaluation.answer, {
        model: evaluation.model,
        usage: decisionChainUsage(trace),
        chain: trace,
        raw,
        request
      })
    } catch (err) {
      const reason = task.cancelReason
      if (reason === 'shutdown' || reason === 'ownership') return
      if (reason) {
        if (await store.finishDecisionVerdict(row.seq, row.subject, null, 'canceled', reason, this.host.now()))
          this.finished(key, 'canceled', reason)
        return
      }
      this.host.log.warn(`decision-router: evaluation failed: ${(err as Error).message}`)
      // A failure keeps the thread's continuing recipients; it never falls back as if the conversation were new.
      await (async () => {
        const kept = constraint ?? (await this.freezeConstraint(row, delivery, undefined, false))
        await this.settle(key, row, config, delivery, kept, 'unavailable', { reason: 'provider' })
      })().catch(() => undefined)
    } finally {
      release?.()
      if (this.tasks.get(key) === task) this.tasks.delete(key)
      this.runtime.notifyProgress()
      this.drain(task.lane)
    }
  }

  /** An early follow-up waits (bounded) for its root, then adds the thread's admitted recipients and local participants. */
  private async freezeConstraint(
    row: DecisionVerdictRow,
    delivery: RouterDelivery,
    signal: AbortSignal | undefined,
    waitForRoot = true
  ): Promise<RoutingConstraintInput[]> {
    const constraint: RoutingConstraintInput[] = delivery.constraint.map((c) => ({ ...c }))
    const thread = delivery.thread
    if (thread) {
      const record = { seq: row.seq, orgId: row.orgId, transcriptChannel: row.channel, thread }
      const deadline = Date.now() + (waitForRoot ? this.limits.rootWaitMs : 0)
      while (Date.now() < deadline && !this.closed && (await this.pendingRootIn(record, row.subject))) {
        signal?.throwIfAborted()
        await this.runtime.nextProgress(Math.min(250, deadline - Date.now()))
      }
      signal?.throwIfAborted()
      const earlier = await this.host.store().routerVerdictsInThread({
        orgId: row.orgId,
        channel: row.channel,
        subject: row.subject,
        thread,
        beforeSeq: row.seq
      })
      for (const verdict of earlier) {
        for (const target of parseJson<RouterTarget[]>(verdict.targetsJson) ?? []) {
          if (target.disposition !== 'admitted') continue
          const known = constraint.find((c) => c.agentId === target.agentId)
          if (known) known.participant = true
          else
            constraint.push({
              agentId: target.agentId,
              daemonId: target.daemonId,
              ...(target.integrationId ? { integrationId: target.integrationId } : {}),
              participant: true,
              via: 'implicit'
            })
        }
      }
    }
    const self = this.host.selfDaemonId()
    for (const candidate of delivery.candidates) {
      if (candidate.daemonId !== self) continue
      const known = constraint.find((c) => c.agentId === candidate.agentId)
      if (known?.participant) continue
      if (!(await this.host.participates(candidate.agentId, delivery.msg).catch(() => false))) continue
      if (known) known.participant = true
      else constraint.push({ ...candidate, participant: true, via: 'implicit' })
    }
    return constraint
  }

  private async settle(
    key: string,
    row: DecisionVerdictRow,
    config: FrozenRouterConfig,
    delivery: RouterDelivery,
    constraint: readonly RoutingConstraintInput[],
    answer: Extract<DecisionEvaluation, { status: 'answered' }>['answer'] | 'unavailable' | 'none',
    extra: {
      reason?: DecisionUnavailableReason
      model?: string
      usage?: { inputTokens: number; outputTokens: number }
      answerJson?: RouterAnswer
      chain?: DecisionChainEvaluation[]
      recovered?: boolean
      /** The provider's response body text, kept with the answer until retention strips it. */
      raw?: string
      /** The exact request body sent, kept verbatim alongside the response. */
      request?: string
    }
  ): Promise<boolean> {
    let resolved: ReturnType<typeof resolveRoutingTargets>
    let reason = extra.reason
    try {
      resolved = resolveRoutingTargets({
        question: config.question,
        routing: config.routing,
        answer: answer === 'none' ? undefined : answer,
        constraint,
        ...(config.defaultAgentId ? { defaultAgentId: config.defaultAgentId } : {}),
        candidates: delivery.candidates,
        chain: new Map(
          extra.chain?.flatMap((entry) => {
            const definition = config.definitions?.find((definition) => definition.id === entry.decisionId)
            return entry.stepId && definition && entry.evaluation.status === 'answered'
              ? [[entry.stepId, { question: definition.question, answer: entry.evaluation.answer }] as const]
              : []
          })
        )
      })
    } catch {
      reason = 'invalid_response'
      resolved = resolveRoutingTargets({
        question: config.question,
        routing: config.routing,
        answer: 'unavailable',
        constraint,
        ...(config.defaultAgentId ? { defaultAgentId: config.defaultAgentId } : {}),
        candidates: delivery.candidates
      })
    }
    const stopped = this.stopped.get(key)
    const targets: RouterTarget[] = resolved.targets.map((t) => {
      const local =
        t.daemonId === this.host.selfDaemonId()
          ? this.host.localTarget(config.botId, t.agentId, config.channel)
          : undefined
      const base: RouterTarget = {
        agentId: t.agentId,
        daemonId: t.daemonId,
        ...(t.integrationId ? { integrationId: t.integrationId } : {}),
        participant: t.participant,
        effect: t.effect,
        via: t.via,
        ...(local ? { sessionMode: local.sessionMode } : {}),
        disposition: 'pending'
      }
      if (t.unavailableReason) return { ...base, disposition: 'unavailable', reason: t.unavailableReason }
      if (stopped?.has(t.agentId)) return { ...base, disposition: 'rejected', reason: 'stopped' }
      return base
    })
    const disposition =
      reason !== undefined || resolved.disposition === 'unavailable' ? 'unavailable' : resolved.disposition
    const match = resolved.match
    const answerJson: RouterAnswer = extra.answerJson ?? {
      ...(answer !== 'unavailable' && answer !== 'none' ? { answer } : {}),
      ...(config.routing.steps?.length && extra.chain ? { chain: extra.chain } : {}),
      matchedRuleIds: match?.matchedRuleIds ?? [],
      matchedKeys: match?.matchedKeys ?? [],
      usedOtherwise: match?.usedOtherwise ?? false,
      ...(resolved.fallback ? { fallback: resolved.fallback } : {}),
      ...(extra.recovered ? { recovered: true } : {}),
      ...rawAnswerFields(extra.raw, extra.request)
    }
    const settledAt = this.host.now()
    const latencyMs = Math.max(0, settledAt - row.createdAt)
    const won = await this.host.store().settleDecisionVerdict(row.seq, row.subject, this.host.ownerFence(), {
      disposition,
      ...(disposition === 'unavailable' ? { unavailableReason: reason ?? 'provider' } : {}),
      answerJson: JSON.stringify(answerJson),
      ...(extra.model ? { actualModel: extra.model } : {}),
      ...(extra.usage ? { inputTokens: extra.usage.inputTokens, outputTokens: extra.usage.outputTokens } : {}),
      targetsJson: JSON.stringify(targets),
      latencyMs,
      settledAt
    })
    // A lost CAS means a stop, a config change, or a new host got there first: the late result is dropped.
    if (!won) return false
    this.metrics.verdict(disposition, reason ?? 'none')
    this.metrics.latency(disposition, latencyMs)
    if (extra.usage) {
      this.metrics.tokens('input', extra.usage.inputTokens)
      this.metrics.tokens('output', extra.usage.outputTokens)
    }
    if (disposition === 'skip') this.finished(key, 'skipped', 'skip')
    return true
  }

  private drain(lane: Lane): void {
    if (this.closed) return
    this.lanes.set(laneId(lane), lane)
    this.runtime.drain(
      lane,
      () => this.drainOnce(lane),
      (err) => this.host.log.warn(`decision-router: lane drain failed: ${err.message}`)
    )
  }

  private async drainOnce(lane: Lane): Promise<void> {
    const store = this.host.store()
    const fence = this.host.ownerFence()
    for (;;) {
      if (this.closed) return
      const head = await store.decisionLaneHead(lane.orgId, lane.channel, lane.subject)
      if (!head) return
      if (this.tasks.has(verdictKey(head.seq, head.subject))) return
      if (head.state === 'reserved' || head.state === 'evaluating' || head.ownerFence !== fence) {
        const config = parseJson<FrozenRouterConfig>(head.configJson)
        const current = config ? this.host.currentRouting(head.integrationId, config.channel) : undefined
        if (!config || current?.status !== 'enabled' || current.fingerprint !== config.fingerprint) return
        if (!(await this.recoverVerdict(head, config))) return
        continue
      }
      if ((await this.releaseHead(head)) === 'wait') return
    }
  }

  /** Recovery (decisions.md §8.3): adopt, then settle an orphaned evaluation as unavailable with no provider call. */
  private async recoverVerdict(row: DecisionVerdictRow, config: FrozenRouterConfig): Promise<boolean> {
    const store = this.host.store()
    const fence = this.host.ownerFence()
    const key = verdictKey(row.seq, row.subject)
    if (this.tasks.has(key)) return false
    if (row.ownerFence !== fence && !(await store.adoptDecisionVerdict(row.seq, row.subject, row.ownerFence, fence)))
      return false
    if (row.state === 'reserved' || row.state === 'evaluating') {
      const delivery = parseJson<RouterDelivery>(row.deliveryJson)
      if (!delivery) {
        await store.finishDecisionVerdict(row.seq, row.subject, fence, 'canceled', 'delivery_missing', this.host.now())
        return true
      }
      // The frozen constraint, or one rebuilt from durable state: never the relay's bare one, which may predate the root.
      const adopted = { ...row, ownerFence: fence }
      const constraint = delivery.frozenConstraint ?? (await this.freezeConstraint(adopted, delivery, undefined, false))
      await this.settle(key, adopted, config, delivery, constraint, 'unavailable', {
        reason: 'timeout',
        recovered: true
      })
    }
    return true
  }

  private appliedStale(integrationId: string, config: FrozenRouterConfig): string | 'wait' | undefined {
    const applied = this.applied.get(integrationId)
    if (applied === null) return this.host.store().isShared ? 'wait' : 'integration_removed'
    if (!applied) return undefined
    const routed = applied.routed.get(config.channel)
    if (!routed) return 'config_changed'
    if (!routed.enabled) return routed.disabledReason ?? 'routing_disabled'
    if (!routed.routing) return 'host_reassigned'
    if (routerFingerprint(routed.routing, config.channel) !== config.fingerprint) return 'config_changed'
    return undefined
  }

  // An announced mode list is sparse: a channel absent from it is createNew (channel-session-mode.md §4).
  private modeChanged(integrationId: string, channel: string, frozen: string | undefined): boolean {
    const modes = this.appliedModes.get(integrationId)
    return frozen !== undefined && modes !== undefined && (modes.get(channel) ?? 'createNew') !== frozen
  }

  /** The release recheck: still this conversation's host, same routing, configuration converged. */
  private staleRouting(head: DecisionVerdictRow, config: FrozenRouterConfig): string | 'wait' | undefined {
    if (this.closed) return 'wait'
    const applied = this.appliedStale(head.integrationId, config)
    if (applied) return applied
    const current = this.host.currentRouting(head.integrationId, config.channel)
    if (current.status === 'unknown') return this.host.configConverged() ? 'integration_removed' : 'wait'
    if (current.status === 'not_host') return this.host.store().isShared ? 'wait' : 'host_reassigned'
    if (current.status === 'disabled') return current.reason
    if (current.fingerprint !== config.fingerprint) return 'config_changed'
    return undefined
  }

  private async releaseHead(head: DecisionVerdictRow): Promise<'next' | 'wait'> {
    const store = this.host.store()
    const lane = { orgId: head.orgId, channel: head.channel, subject: head.subject }
    if (await this.runtime.ingressBarrier(head)) {
      if (this.closed) return 'wait'
      const now = await store.decisionLaneHead(lane.orgId, lane.channel, lane.subject)
      if (!now || now.seq !== head.seq || now.state !== head.state || now.ownerFence !== head.ownerFence) return 'next'
    }
    if (this.closed) return 'wait'
    const config = parseJson<FrozenRouterConfig>(head.configJson)
    const delivery = parseJson<RouterDelivery>(head.deliveryJson)
    let targets = parseJson<RouterTarget[]>(head.targetsJson)
    if (!config || !delivery || !targets) {
      await this.finish(head, 'canceled', 'delivery_missing')
      return 'next'
    }
    const stale = this.staleRouting(head, config)
    if (stale === 'wait') return 'wait'
    if (stale) {
      await this.cancelRow(head, stale)
      return 'next'
    }
    const pending = targets.filter((t) => t.disposition === 'pending')
    let retrying = false
    for (let i = 0; i < pending.length; i += this.limits.forwardActive) {
      const batch = pending.slice(i, i + this.limits.forwardActive)
      const outcomes = await Promise.all(
        batch.map((target) => this.releaseTarget(head, config, delivery, targets!, target))
      )
      const updates = outcomes.filter((o): o is RouterTargetUpdate => o !== 'retry' && o !== 'wait')
      if (outcomes.some((o) => o === 'retry' || o === 'wait')) retrying = true
      if (updates.length) targets = (await this.updateTargets(head, updates)) ?? targets
      if (this.closed) return 'wait'
    }
    const fresh = await store.getDecisionVerdict(head.seq, head.subject)
    if (!fresh || fresh.state !== 'settled') return 'next'
    targets = parseJson<RouterTarget[]>(fresh.targetsJson) ?? targets
    if (targets.some((t) => t.disposition === 'pending')) {
      if (retrying) this.scheduleRetry(lane)
      return 'wait'
    }
    await this.finalize(fresh, config, delivery, targets)
    return 'next'
  }

  private scheduleRetry(lane: Lane): void {
    if (this.closed) return
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer)
      this.drain(lane)
    }, this.limits.retryDelayMs)
    timer.unref?.()
    this.retryTimers.add(timer)
  }

  /** One pending target: admit locally through step 6, or forward to its daemon; a retry keeps it pending. */
  private async releaseTarget(
    head: DecisionVerdictRow,
    config: FrozenRouterConfig,
    delivery: RouterDelivery,
    targets: readonly RouterTarget[],
    target: RouterTarget
  ): Promise<RouterTargetUpdate | 'retry' | 'wait'> {
    const store = this.host.store()
    const key = verdictKey(head.seq, head.subject)
    if (this.stopped.get(key)?.has(target.agentId))
      return { agentId: target.agentId, disposition: 'rejected', reason: 'stopped' }
    const receiptId = decisionRouteReceiptId(head.seq, target.agentId)
    // A durable receipt (local, or a remote admission on a shared store) means this target is already admitted.
    if (await store.hasInbox(receiptId))
      return { agentId: target.agentId, disposition: 'admitted', daemonId: target.daemonId }
    const self = this.host.selfDaemonId()
    const local =
      target.daemonId === self ? this.host.localTarget(config.botId, target.agentId, config.channel) : undefined
    if (target.daemonId === self && !local)
      return { agentId: target.agentId, disposition: 'unavailable', reason: 'not_member' }
    // Served here: step 6 on this daemon; a local agent whose duty a pool sibling holds goes through the relay's rendezvous.
    if (local?.served) {
      const evidence = this.evidenceFor(head, config, targets, target)
      if (target.sessionMode !== undefined && local.sessionMode !== target.sessionMode)
        return { agentId: target.agentId, disposition: 'rejected', reason: 'config_changed' }
      const token: ReleaseToken = {
        integrationId: head.integrationId,
        config,
        targetIntegrationId: local.integrationId,
        ...(target.sessionMode !== undefined ? { targetSessionMode: target.sessionMode } : {}),
        agentId: target.agentId,
        channel: config.channel
      }
      const tokenKey = `${key}:${target.agentId}`
      this.releasing.set(tokenKey, token)
      const beforeDispatch = (): boolean => {
        if (this.closed) return false
        if (!token.refused) {
          const now = this.staleRouting(head, config)
          if (now) token.refused = now === 'wait' ? {} : { reason: now }
          else if (this.stopped.get(key)?.has(target.agentId)) token.refused = { reason: 'stopped' }
        }
        return !token.refused
      }
      let result: RouterAdmitResult
      try {
        result = await this.host.admitLocal({
          verdict: head,
          target: { ...target, integrationId: local.integrationId },
          delivery,
          evidence,
          receiptId,
          beforeDispatch
        })
      } finally {
        this.releasing.delete(tokenKey)
      }
      if (result.kind === 'admitted') return { agentId: target.agentId, disposition: 'admitted', daemonId: self }
      if (token.refused?.reason)
        return { agentId: target.agentId, disposition: 'rejected', reason: token.refused.reason }
      if (token.refused || result.recoverable) return 'wait'
      return { agentId: target.agentId, disposition: 'rejected', reason: result.reason }
    }
    const now = this.host.now()
    const retryUntil = target.retryUntil ?? now + this.limits.targetRetryMs
    const deliveryId = `${config.botId}:${delivery.rd.payload.msgId}#${target.agentId}`
    let ack: RdRouteAck
    try {
      ack = await this.host.forwardRemote({
        verdict: head,
        target,
        delivery,
        deliveryId,
        selection: this.selectionFor(head, config, targets, target),
        backfill: await this.host.backfill(head.orgId, head.channel, head.seq).catch(() => [])
      })
    } catch (err) {
      this.host.log.warn(`decision-router: forward of ${deliveryId} failed: ${(err as Error).message}`)
      ack = { deliveryId, disposition: 'retry', reason: 'offline' }
    }
    if (ack.disposition === 'admitted')
      return { agentId: target.agentId, disposition: 'admitted', daemonId: ack.daemonId ?? target.daemonId }
    if (isRetryableRouteAck(ack, { converging: !this.host.configConverged() })) {
      if (now >= retryUntil) return { agentId: target.agentId, disposition: 'unavailable', reason: 'timeout' }
      if (target.retryUntil === undefined) await this.recordRetry(head, target, retryUntil)
      return 'retry'
    }
    const reason = ack.reason ?? 'rejected'
    // A refused target is recorded and never rerouted; its siblings go on and Otherwise is not invoked.
    return {
      agentId: target.agentId,
      disposition: TERMINAL_UNAVAILABLE.has(reason) ? 'unavailable' : 'rejected',
      reason
    }
  }

  /** Freeze a retrying target's deadline so a restart keeps the same bound. */
  private async recordRetry(head: DecisionVerdictRow, target: RouterTarget, retryUntil: number): Promise<void> {
    await this.updateTargets(head, [
      { agentId: target.agentId, disposition: 'pending', retryUntil, attempts: (target.attempts ?? 0) + 1 }
    ])
    target.retryUntil = retryUntil
  }

  /** Send one report; an unaccepted one retries with backoff until accepted, refused by a converged host check, or bounded. */
  private sendReport(key: string, pending: PendingReport): void {
    if (this.closed) return
    pending.inFlight = true
    this.runtime.track(
      (async () => {
        const ack = await this.host
          .report(pending.report, pending.relayId)
          .catch((err: unknown) => ({ accepted: false, reason: (err as Error).message }))
        pending.inFlight = false
        if (this.reports.get(key) !== pending) return
        if (ack.accepted) {
          this.reports.delete(key)
          return
        }
        pending.attempts += 1
        const finalRefusal = ack.reason === 'not_host' && this.host.configConverged()
        if (finalRefusal || this.closed || this.host.now() >= pending.giveUpAt) {
          this.reports.delete(key)
          this.host.log.warn(
            `decision-router: owner/participant report ${key} not accepted after ${pending.attempts} attempts (${ack.reason ?? 'refused'})`
          )
          return
        }
        const delay = Math.min(this.limits.reportBackoffMaxMs, this.limits.retryDelayMs * 2 ** (pending.attempts - 1))
        pending.timer = setTimeout(() => {
          pending.timer = undefined
          this.sendReport(key, pending)
        }, delay)
        pending.timer.unref?.()
      })()
    )
  }

  /** All targets terminal: report owner and participants once, then finish the verdict (release as one unit). */
  private async finalize(
    row: DecisionVerdictRow,
    config: FrozenRouterConfig | undefined,
    delivery: RouterDelivery | undefined,
    targets: readonly RouterTarget[]
  ): Promise<void> {
    const admitted = targets.filter((t) => t.disposition === 'admitted' && t.daemonId)
    if (config && delivery && admitted.length > 0) {
      // Owner: the first admitted target in frozen rule order, only for a new, unconstrained conversation.
      const owner = delivery.constraint.length === 0 ? admitted[0] : undefined
      const participants = admitted.filter((t) => !t.participant)
      if (owner || participants.length > 0) {
        const report: RdRouteReport = {
          botId: config.botId,
          sessionKey: delivery.rd.sessionKey,
          channel: config.channel,
          ...(owner ? { owner: { agentId: owner.agentId, daemonId: owner.daemonId! } } : {}),
          participants: participants.map((t) => ({ agentId: t.agentId, daemonId: t.daemonId! }))
        }
        const key = verdictKey(row.seq, row.subject)
        if (!this.reports.has(key)) {
          const pending: PendingReport = {
            report,
            ...(delivery.relayId ? { relayId: delivery.relayId } : {}),
            attempts: 0,
            giveUpAt: this.host.now() + this.limits.reportRetryMs
          }
          this.reports.set(key, pending)
          this.sendReport(key, pending)
        }
      }
    }
    const reason = targets.length === 0 ? 'no_default' : 'targets_rejected'
    await this.finish(row, admitted.length > 0 ? 'admitted' : 'canceled', admitted.length > 0 ? null : reason)
  }

  private async finish(head: DecisionVerdictRow, state: 'admitted' | 'canceled', reason: string | null): Promise<void> {
    if (
      await this.host
        .store()
        .finishDecisionVerdict(
          head.seq,
          head.subject,
          this.host.ownerFence(),
          state,
          state === 'canceled' ? reason : null,
          this.host.now()
        )
    ) {
      this.stopped.delete(verdictKey(head.seq, head.subject))
      this.finished(verdictKey(head.seq, head.subject), state, reason ?? 'released')
    }
  }

  private resultOf(head: DecisionVerdictRow): RdRouteResult {
    const answer = parseJson<RouterAnswer>(head.answerJson)
    if (answer?.evaluated === false) return { status: 'not_evaluated', reason: 'all_participants' }
    if (head.disposition !== 'unavailable' && answer?.answer)
      return {
        status: 'answered',
        answer: answer.answer as never,
        matchedRuleIds: answer.matchedRuleIds ?? [],
        matchedKeys: answer.matchedKeys ?? [],
        usedOtherwise: answer.usedOtherwise ?? false
      }
    return {
      status: 'unavailable',
      reason: (head.unavailableReason ?? 'provider') as DecisionUnavailableReason,
      ...(answer?.recovered ? { recovered: true } : {})
    }
  }

  private partialOf(head: DecisionVerdictRow): DecisionEvidence['partial'] {
    const input = parseJson<{ context?: { partial?: boolean; reasons?: string[]; omittedMessages?: number } }>(
      head.inputJson
    )
    return input?.context
      ? {
          partial: input.context.partial === true,
          reasons: input.context.reasons ?? [],
          omittedMessages: input.context.omittedMessages ?? 0
        }
      : { partial: true, reasons: ['not_evaluated'], omittedMessages: 0 }
  }

  private selectionFor(
    head: DecisionVerdictRow,
    config: FrozenRouterConfig,
    targets: readonly RouterTarget[],
    target: RouterTarget
  ): RdRouteSelectionBody {
    const input = parseJson<{ currentMessage?: { id?: string } }>(head.inputJson)
    const delivery = parseJson<RouterDelivery>(head.deliveryJson)
    return {
      selectionId: `${head.seq}:${head.subject}`,
      hostSeq: head.seq,
      decisionId: config.decisionId,
      question: config.question,
      requestedModel: head.requestedModel,
      ...(head.actualModel ? { actualModel: head.actualModel } : {}),
      result: this.resultOf(head),
      effect: target.effect,
      constrained: (delivery?.constraint.length ?? 0) > 0 || targets.some((t) => t.participant),
      targetAgentIds: targets
        .filter((t) => t.disposition !== 'unavailable' || t.reason !== 'not_member')
        .map((t) => t.agentId),
      evaluatedMessageId: input?.currentMessage?.id ?? delivery?.rd.payload.msgId ?? String(head.seq),
      partial: this.partialOf(head)
    }
  }

  private evidenceFor(
    head: DecisionVerdictRow,
    config: FrozenRouterConfig,
    targets: readonly RouterTarget[],
    target: RouterTarget
  ): DecisionEvidence {
    const selection = this.selectionFor(head, config, targets, target)
    const r = selection.result
    return {
      verdict: { seq: head.seq, subject: head.subject },
      decisionId: config.decisionId,
      question: config.question,
      result:
        r.status === 'answered'
          ? { status: 'answered', answer: r.answer, matchedKeys: r.matchedKeys }
          : r.status === 'unavailable'
            ? { status: 'unavailable', reason: r.reason, ...(r.recovered ? { recovered: true } : {}) }
            : { status: 'not_evaluated', reason: 'all_participants' },
      routing: {
        botId: config.botId,
        matchedRuleIds: r.status === 'answered' ? r.matchedRuleIds : [],
        usedOtherwise: r.status === 'answered' ? r.usedOtherwise : false,
        effect: target.effect,
        constrained: selection.constrained,
        targetAgentIds: selection.targetAgentIds
      },
      requestedModel: head.requestedModel,
      ...(head.actualModel ? { actualModel: head.actualModel } : {}),
      evaluatedMessageId: selection.evaluatedMessageId,
      snapshotSeq: head.seq,
      partial: selection.partial
    }
  }

  private finished(key: string, state: 'admitted' | 'canceled' | 'skipped', reason: string): void {
    this.metrics.finished(state, reason)
    this.runtime.finished(key, state)
  }
}
