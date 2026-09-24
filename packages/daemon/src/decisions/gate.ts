import {
  matchDecisionCondition,
  type DecisionBundle,
  type DecisionEvaluation,
  type RdMsgIm
} from '@agentconnect.md/protocol'
import type { DeliveryHandle } from '../evaluation/environment.js'
import type { NormalizedMessage } from '../messages/normalized.js'
import { threadRootResolver } from '../platforms/thread-keys.js'
import type { ChannelRecordRef, DecisionVerdictRow, LocalStore } from '../store/local-store.js'
import {
  frozenGateConfig,
  gateFingerprint,
  resolveDecisionBundle,
  type FrozenGateConfig,
  type ResolvedDecisionBundle,
  type ResolvedDecisionGate
} from './bundle.js'
import { rawAnswerFields, type DecisionEvaluationInput } from './evaluator.js'
import type { DecisionEvidence, DecisionUnavailableReason } from './evidence.js'
import { DecisionLaneRuntime, laneId, verdictKey, type Lane } from './lanes.js'
import { defaultDecisionGateMetrics, type DecisionGateMetrics } from './metrics.js'
import { buildDecisionState } from './state.js'

export const DEFAULT_DECISION_GATE_LIMITS = {
  deadlineMs: 5_000,
  providerActive: 4,
  daemonActive: 16,
  queued: 64,
  providerQueued: 16,
  ingressBarrierMs: 2_000,
  participationWaitMs: 10_000,
  backgroundRows: 50
}
export type DecisionGateLimits = typeof DEFAULT_DECISION_GATE_LIMITS

/** What a verdict releases into ordinary dispatch, persisted as its `deliveryJson`. */
export type DecisionDelivery =
  | {
      origin: 'direct'
      primary: boolean
      via: 'mention' | 'implicit'
      integrationId: string
      msg: NormalizedMessage
    }
  | { origin: 'relay'; rd: Omit<RdMsgIm, 'searchActionToken'>; msg: NormalizedMessage }

/** The admission receipt a released verdict mints with its inbox row, so it is never dispatched twice. */
export function decisionReceiptId(seq: number, agentId: string): string {
  return `decision-verdict:${seq}:${agentId}`
}

export interface DecisionReleaseRequest {
  verdict: DecisionVerdictRow
  delivery: DecisionDelivery
  evidence: DecisionEvidence
  /** False once the verdict was canceled or the gate closed; the tail checks it right before dispatch. */
  beforeDispatch: () => boolean
}

export type DecisionReleaseResult =
  { kind: 'admitted'; handle?: DeliveryHandle } | { kind: 'rejected'; reason: string; recoverable: boolean }

export type CurrentGate =
  | { status: 'unknown' }
  | { status: 'unbound' }
  | { status: 'disabled'; reason: string }
  | { status: 'enabled'; gate: ResolvedDecisionGate; sessionMode: string }

export interface DecisionGateHost {
  store(): LocalStore
  ownerFence(): string
  now(): number
  evaluate(input: DecisionEvaluationInput, signal: AbortSignal): Promise<DecisionEvaluation>
  currentGate(agentId: string, integrationId: string, channel: string): CurrentGate
  configConverged(): boolean
  servesAgent(agentId: string): boolean
  participates(agentId: string, msg: NormalizedMessage): Promise<boolean>
  release(request: DecisionReleaseRequest): Promise<DecisionReleaseResult>
  log: { debug(message: string): void; info(message: string): void; warn(message: string): void }
  metrics?: DecisionGateMetrics
}

export interface DecisionCandidate {
  agentId: string
  integrationId: string
  rawChannel: string
  record: ChannelRecordRef
  gate: ResolvedDecisionGate
  sessionMode: string
  /** The target's own copy: trigger stamped, no session coordinate yet. */
  target: NormalizedMessage
  delivery: DecisionDelivery
}

export type GateOutcome =
  | { kind: 'pending'; handle: DeliveryHandle }
  | { kind: 'admit' }
  | { kind: 'duplicate' }
  | { kind: 'held'; reason?: string }

type CancelReason = 'stop' | 'cancel' | 'config_changed' | 'integration_removed' | 'shutdown' | 'ownership'

interface Task {
  lane: Lane
  controller: AbortController
  cancelReason?: CancelReason
}

/** A verdict between its pre-release recheck and dispatch; `refused` without a reason leaves the row for later. */
interface ReleaseToken {
  lane: Lane
  integrationId: string
  config: FrozenGateConfig
  refused?: { reason?: string }
}

function parseJson<T>(text: string | null | undefined): T | undefined {
  if (!text) return undefined
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

/** The Stage 1 fixed-target gate (decisions.md §8.3): durable verdicts, bounded evaluation, per-lane in-order release. */
export class DecisionGate {
  private readonly metrics: DecisionGateMetrics
  private readonly tasks = new Map<string, Task>()
  private readonly lanes = new Map<string, Lane>()
  private readonly releasing = new Map<string, ReleaseToken>()
  // The latest bundle each integration applied (null once removed); the host's view lags it by a reconcile.
  private readonly applied = new Map<string, ResolvedDecisionBundle | null>()
  // The session modes announced with each integration's bundle, so the fence never trusts a lagging host view.
  private readonly appliedModes = new Map<string, ReadonlyMap<string, string>>()
  private readonly intake = new Map<string, Promise<GateOutcome>>()
  private closed = false

  constructor(
    private readonly host: DecisionGateHost,
    private readonly limits: DecisionGateLimits = DEFAULT_DECISION_GATE_LIMITS,
    readonly runtime: DecisionLaneRuntime = new DecisionLaneRuntime(limits)
  ) {
    this.metrics = host.metrics ?? defaultDecisionGateMetrics
  }

  /** Mark one recorded row as still travelling the ladder; later rows of its conversation wait behind it. */
  openIngress(ref: ChannelRecordRef): () => void {
    return this.runtime.openIngress(ref)
  }

  /** Step 5 for one bound, enabled target: participation admits, otherwise a verdict is reserved and owned here. */
  async candidate(c: DecisionCandidate): Promise<GateOutcome> {
    if (this.closed) return { kind: 'held', reason: 'closed' }
    const key = verdictKey(c.record.seq, c.agentId)
    // Single-flight per verdict key: a concurrent duplicate joins the owner and never reserves on its own.
    const owner = this.intake.get(key)
    if (owner) return await this.joinIntake(key, owner)
    const run = this.intakeOnce(key, c)
    this.intake.set(key, run)
    try {
      return await run
    } finally {
      if (this.intake.get(key) === run) this.intake.delete(key)
    }
  }

  private async joinIntake(key: string, owner: Promise<GateOutcome>): Promise<GateOutcome> {
    // Registered before the owner can settle, so its finish always reaches this waiter.
    const joined = this.runtime.waiterFor(key)
    const outcome = await owner.catch((): GateOutcome => ({ kind: 'held', reason: 'record_unavailable' }))
    if (outcome.kind === 'pending') return { kind: 'pending', handle: joined.handle }
    joined.drop()
    return outcome
  }

  private async intakeOnce(key: string, c: DecisionCandidate): Promise<GateOutcome> {
    const store = this.host.store()
    const { seq } = c.record
    const lane: Lane = { orgId: c.record.orgId, channel: c.record.transcriptChannel, subject: c.agentId }
    let existing: DecisionVerdictRow | undefined
    try {
      existing = await store.getDecisionVerdict(seq, c.agentId)
    } catch (err) {
      this.host.log.warn(`decision: verdict lookup failed: ${(err as Error).message}`)
      return { kind: 'held', reason: 'record_unavailable' }
    }
    if (existing) return this.joinExisting(existing, lane)
    // A mention is not participation (message-intake.md §5 step 5): an explicit address is always judged.
    if (c.target.trigger !== 'mention' && (await this.host.participates(c.agentId, c.target).catch(() => false))) {
      await this.waitBehindLane(lane, seq, this.limits.participationWaitMs)
      return { kind: 'admit' }
    }
    // Registered BEFORE the reserve commits, so a concurrent drain never mistakes the new row for an orphan.
    const task: Task = { lane, controller: new AbortController() }
    this.tasks.set(key, task)
    const now = this.host.now()
    const config = frozenGateConfig(c.gate, c.sessionMode)
    let reserved: Awaited<ReturnType<LocalStore['reserveDecisionVerdict']>>
    try {
      reserved = await store.reserveDecisionVerdict({
        seq,
        subject: c.agentId,
        orgId: lane.orgId,
        channel: lane.channel,
        agentId: c.agentId,
        integrationId: c.integrationId,
        decisionId: config.decisionId,
        configJson: JSON.stringify(config),
        deliveryJson: JSON.stringify(c.delivery),
        requestedModel: config.model,
        deadlineAt: now + this.limits.deadlineMs,
        ownerFence: this.host.ownerFence(),
        createdAt: now
      })
    } catch (err) {
      if (this.tasks.get(key) === task) this.tasks.delete(key)
      this.host.log.warn(`decision: verdict reservation failed: ${(err as Error).message}`)
      return { kind: 'held', reason: 'record_unavailable' }
    }
    if (!reserved.created) {
      if (this.tasks.get(key) === task) this.tasks.delete(key)
      if (!reserved.verdict) return { kind: 'held', reason: 'record_unavailable' }
      return this.joinExisting(reserved.verdict, lane)
    }
    this.lanes.set(laneId(lane), lane)
    const handle = this.runtime.handleFor(key)
    this.runtime.track(this.evaluateTask(key, task, reserved.verdict!, c, config))
    return { kind: 'pending', handle }
  }

  /** `!stop` / `!cancel`: every pending verdict of this agent in this conversation, without waiting for Jev. */
  async cancelForAgent(agentId: string, transcriptChannel: string, reason: 'stop' | 'cancel'): Promise<number> {
    for (const task of this.tasks.values()) {
      if (task.lane.subject !== agentId || task.lane.channel !== transcriptChannel) continue
      task.cancelReason = reason
      task.controller.abort(reason)
    }
    for (const release of this.releasing.values())
      if (release.lane.subject === agentId && release.lane.channel === transcriptChannel) release.refused ??= { reason }
    const canceled = await this.host
      .store()
      .cancelPendingDecisionVerdicts(
        { subject: agentId, channel: transcriptChannel, consumer: 'gate' },
        reason,
        this.host.now()
      )
    for (const row of canceled) this.finished(verdictKey(row.seq, row.subject), 'canceled', reason)
    this.runtime.notifyProgress()
    return canceled.length
  }

  /** A relevant binding/definition/model/provider change cancels, never reinterprets (decisions.md §8.3). */
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
    // Synchronously, before any await: a release already past its recheck must not reach dispatch.
    for (const release of this.releasing.values()) {
      if (release.integrationId !== integrationId) continue
      if (!bundle) release.refused ??= store.isShared ? {} : { reason: 'integration_removed' }
      else if (
        !this.sameGate(bundle.gates.get(release.config.binding.channel), release.config) ||
        this.modeChanged(integrationId, release.config)
      )
        release.refused ??= { reason: 'config_changed' }
    }
    const pending = await store.listPendingDecisionVerdicts({ integrationId, consumer: 'gate' })
    if (!bundle) {
      // On a shared store the new owner and retention reclaim the rows; only this process's work stops.
      for (const row of pending)
        this.abortTask(verdictKey(row.seq, row.subject), store.isShared ? 'ownership' : 'integration_removed')
      if (store.isShared) return
      for (const row of pending) await this.cancelRow(row, 'integration_removed')
      await store.purgeDecisionVerdicts({ integrationId })
      return
    }
    for (const row of pending) {
      const config = parseJson<FrozenGateConfig>(row.configJson)
      if (
        config &&
        this.sameGate(bundle.gates.get(config.binding.channel), config) &&
        !this.modeChanged(integrationId, config)
      )
        continue
      this.abortTask(verdictKey(row.seq, row.subject), 'config_changed')
      await this.cancelRow(row, 'config_changed')
    }
  }

  /** Startup / newly served agents: settle orphaned evaluations as unavailable and re-enter release. */
  async recover(agentIds?: ReadonlySet<string>): Promise<void> {
    const store = this.host.store()
    const rows = await store.listPendingDecisionVerdicts(
      agentIds ? { agentIds: [...agentIds], consumer: 'gate' } : { consumer: 'gate' }
    )
    const lanes = new Map<string, Lane>()
    for (const row of rows) {
      if (!this.host.servesAgent(row.agentId) || this.tasks.has(verdictKey(row.seq, row.subject))) continue
      try {
        await this.recoverVerdict(row)
      } catch (err) {
        this.host.log.warn(`decision: verdict recovery failed: ${(err as Error).message}`)
      }
      const lane = { orgId: row.orgId, channel: row.channel, subject: row.subject }
      lanes.set(laneId(lane), lane)
    }
    for (const lane of lanes.values()) this.drain(lane)
  }

  /** Re-drain every known lane, e.g. once the control plane's configuration converged. */
  kick(): void {
    for (const lane of this.lanes.values()) this.drain(lane)
  }

  /** Stop in-memory work for agents this daemon no longer serves; their rows stay for the next owner. */
  retainAgents(served: ReadonlySet<string>): void {
    for (const [key, task] of this.tasks) if (!served.has(task.lane.subject)) this.abortTask(key, 'ownership')
  }

  /** Shutdown aborts evaluations as cancellation and writes nothing; a restart recovers them as unavailable. */
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const key of this.tasks.keys()) this.abortTask(key, 'shutdown')
    this.runtime.close()
  }

  /** Settles once no evaluation, drain, or release is in flight (tests). */
  async idle(): Promise<void> {
    await this.runtime.idle()
  }

  private sameGate(gate: ResolvedDecisionGate | undefined, config: FrozenGateConfig): boolean {
    return gate !== undefined && gateFingerprint(gate) === config.fingerprint
  }

  private joinExisting(row: DecisionVerdictRow, lane: Lane): GateOutcome {
    if (row.state === 'admitted') return { kind: 'duplicate' }
    if (row.state === 'skipped' || row.state === 'canceled') return { kind: 'held', reason: row.state }
    const handle = this.runtime.handleFor(verdictKey(row.seq, row.subject))
    this.drain(lane)
    return { kind: 'pending', handle }
  }

  private abortTask(key: string, reason: CancelReason): void {
    const task = this.tasks.get(key)
    if (!task) return
    task.cancelReason ??= reason
    task.controller.abort(reason)
  }

  private async cancelRow(row: DecisionVerdictRow, reason: string): Promise<void> {
    if (await this.host.store().finishDecisionVerdict(row.seq, row.subject, null, 'canceled', reason, this.host.now()))
      this.finished(verdictKey(row.seq, row.subject), 'canceled', reason)
    this.drain({ orgId: row.orgId, channel: row.channel, subject: row.subject })
  }

  private async evaluateTask(
    key: string,
    task: Task,
    row: DecisionVerdictRow,
    c: DecisionCandidate,
    config: FrozenGateConfig
  ): Promise<void> {
    const store = this.host.store()
    const fence = this.host.ownerFence()
    const signal = task.controller.signal
    const settle = async (
      disposition: 'match' | 'skip' | 'unavailable',
      extra: {
        reason?: DecisionUnavailableReason
        answerJson?: string
        model?: string
        usage?: { inputTokens: number; outputTokens: number }
      } = {}
    ): Promise<void> => {
      const settledAt = this.host.now()
      const latencyMs = Math.max(0, settledAt - row.createdAt)
      const won = await store.settleDecisionVerdict(row.seq, row.subject, fence, {
        disposition,
        ...(extra.reason ? { unavailableReason: extra.reason } : {}),
        ...(extra.answerJson ? { answerJson: extra.answerJson } : {}),
        ...(extra.model ? { actualModel: extra.model } : {}),
        ...(extra.usage ? { inputTokens: extra.usage.inputTokens, outputTokens: extra.usage.outputTokens } : {}),
        latencyMs,
        settledAt
      })
      // A lost CAS means `!stop` or a config change got there first: the late result is dropped.
      if (!won) return
      this.metrics.verdict(disposition, extra.reason ?? 'none')
      this.metrics.latency(disposition, latencyMs)
      if (extra.usage) {
        this.metrics.tokens('input', extra.usage.inputTokens)
        this.metrics.tokens('output', extra.usage.outputTokens)
      }
      if (disposition === 'skip') this.finished(key, 'skipped', 'skip')
    }
    let release: (() => void) | undefined
    try {
      const slot = await this.runtime.slots.acquire(config.providerId, row.deadlineAt, signal, () => this.host.now())
      if (slot.kind === 'capacity') {
        this.metrics.capacity(slot.scope)
        await settle('unavailable', { reason: 'capacity' })
        return
      }
      if (slot.kind === 'timeout') {
        await settle('unavailable', { reason: 'timeout' })
        return
      }
      release = slot.release
      signal.throwIfAborted()
      const rootTsOf = threadRootResolver(c.target.platform, c.target.isDm)
      const window = await store.decisionWindow(row.orgId, row.channel, row.seq, undefined, rootTsOf)
      signal.throwIfAborted()
      let built: ReturnType<typeof buildDecisionState> | undefined
      try {
        built = window.current
          ? buildDecisionState({
              current: window.current,
              history: window.history,
              addressing: {
                mentions: c.target.mentionedBots ?? [],
                target: {
                  agentId: c.agentId,
                  via:
                    c.delivery.origin === 'direct'
                      ? c.delivery.via
                      : c.target.trigger === 'mention'
                        ? 'mention'
                        : 'implicit'
                }
              },
              full: window.full,
              rootMissing: window.rootMissing,
              question: config.question,
              model: config.model
            })
          : undefined
      } catch {
        built = undefined
      }
      if (!built || built.unsupported) {
        await settle('unavailable', { reason: 'unsupported_input' })
        return
      }
      if (!(await store.beginDecisionEvaluation(row.seq, row.subject, fence, JSON.stringify(built.state)))) return
      let raw: string | undefined
      let request: string | undefined
      const evaluation = await this.host.evaluate(
        {
          agentId: c.agentId,
          evaluationId: `${row.seq}:${c.agentId}`,
          decision: { providerId: config.providerId, model: config.model, question: config.question },
          state: built.state,
          deadlineAt: row.deadlineAt,
          onRawRequest: (text) => {
            request = text
          },
          onRawResponse: (text) => {
            raw = text
          }
        },
        signal
      )
      signal.throwIfAborted()
      const rawOnly =
        raw === undefined && request === undefined ? {} : { answerJson: JSON.stringify(rawAnswerFields(raw, request)) }
      if (evaluation.status === 'unavailable') {
        await settle('unavailable', { reason: evaluation.reason, ...rawOnly })
        return
      }
      let match: { matched: boolean; matchedKeys: string[] }
      try {
        match = matchDecisionCondition(config.question, config.condition, evaluation.answer)
      } catch {
        await settle('unavailable', { reason: 'invalid_response', ...rawOnly })
        return
      }
      await settle(match.matched ? 'match' : 'skip', {
        answerJson: JSON.stringify({
          answer: evaluation.answer,
          matchedKeys: match.matchedKeys,
          ...rawAnswerFields(raw, request)
        }),
        model: evaluation.model,
        usage: evaluation.usage
      })
    } catch (err) {
      const reason = task.cancelReason
      if (reason === 'shutdown' || reason === 'ownership') return
      if (reason) {
        if (await store.finishDecisionVerdict(row.seq, row.subject, null, 'canceled', reason, this.host.now()))
          this.finished(key, 'canceled', reason)
        return
      }
      // Anything else is the evaluator failing, which is unavailable, never a skip.
      this.host.log.warn(`decision: evaluation failed: ${(err as Error).message}`)
      await settle('unavailable', { reason: 'provider' }).catch(() => undefined)
    } finally {
      release?.()
      if (this.tasks.get(key) === task) this.tasks.delete(key)
      this.runtime.notifyProgress()
      this.drain(task.lane)
    }
  }

  /** Single-flight per lane: releases only its lowest pending verdict, then reads the next head. */
  private drain(lane: Lane): void {
    if (this.closed) return
    this.lanes.set(laneId(lane), lane)
    this.runtime.drain(
      lane,
      () => this.drainOnce(lane),
      (err) => this.host.log.warn(`decision: lane drain failed: ${err.message}`)
    )
  }

  private async drainOnce(lane: Lane): Promise<void> {
    const store = this.host.store()
    const fence = this.host.ownerFence()
    for (;;) {
      if (this.closed) return
      const head = await store.decisionLaneHead(lane.orgId, lane.channel, lane.subject)
      if (!head) return
      if (head.state === 'reserved' || head.state === 'evaluating') {
        if (this.tasks.has(verdictKey(head.seq, head.subject))) return
        // An orphan: an earlier process's or another member's evaluation, or one this process abandoned.
        if (!this.host.servesAgent(head.agentId)) return
        if (!(await this.recoverVerdict(head))) return
        continue
      }
      if (head.ownerFence !== fence) {
        if (!this.host.servesAgent(head.agentId)) return
        if (!(await this.recoverVerdict(head))) return
        continue
      }
      if ((await this.releaseHead(head)) === 'wait') return
    }
  }

  /** Recovery (decisions.md §8.3): adopt, trust an existing receipt, else settle unavailable with no provider call. */
  private async recoverVerdict(row: DecisionVerdictRow): Promise<boolean> {
    const store = this.host.store()
    const fence = this.host.ownerFence()
    const key = verdictKey(row.seq, row.subject)
    // A live in-process evaluation is never an orphan; its own settle decides the verdict.
    if (this.tasks.has(key)) return false
    if (row.ownerFence !== fence && !(await store.adoptDecisionVerdict(row.seq, row.subject, row.ownerFence, fence)))
      return false
    if (await store.hasInbox(decisionReceiptId(row.seq, row.subject))) {
      if (await store.finishDecisionVerdict(row.seq, row.subject, fence, 'admitted', null, this.host.now()))
        this.finished(key, 'admitted', 'recovered')
      return true
    }
    if (row.state === 'reserved' || row.state === 'evaluating') {
      const settledAt = this.host.now()
      if (
        await store.settleDecisionVerdict(row.seq, row.subject, fence, {
          disposition: 'unavailable',
          unavailableReason: 'timeout',
          answerJson: JSON.stringify({ recovered: true }),
          latencyMs: Math.max(0, settledAt - row.createdAt),
          settledAt
        })
      )
        this.metrics.verdict('unavailable', 'timeout')
    }
    return true
  }

  private async releaseHead(head: DecisionVerdictRow): Promise<'next' | 'wait'> {
    const store = this.host.store()
    const fence = this.host.ownerFence()
    const key = verdictKey(head.seq, head.subject)
    const lane = { orgId: head.orgId, channel: head.channel, subject: head.subject }
    if (await this.runtime.ingressBarrier(head)) {
      if (this.closed) return 'wait'
      // A lower row that reserved while the barrier held is now the head; let drainOnce re-read it.
      const now = await store.decisionLaneHead(lane.orgId, lane.channel, lane.subject)
      if (!now || now.seq !== head.seq || now.state !== head.state || now.ownerFence !== head.ownerFence) return 'next'
    }
    if (this.closed) return 'wait'
    // A moved-away agent's row belongs to its new owner; never cancel it from here.
    if (!this.host.servesAgent(head.agentId)) return 'wait'
    if (await store.hasInbox(decisionReceiptId(head.seq, head.subject))) {
      await this.finish(head, 'admitted', null, 'receipt')
      return 'next'
    }
    const config = parseJson<FrozenGateConfig>(head.configJson)
    const delivery = parseJson<DecisionDelivery>(head.deliveryJson)
    if (!config || !delivery) {
      await this.finish(head, 'canceled', 'delivery_missing')
      return 'next'
    }
    const stale = this.staleGate(head, config)
    if (stale === 'wait') return 'wait'
    if (stale) {
      await this.finish(head, 'canceled', stale)
      return 'next'
    }
    const token: ReleaseToken = { lane, integrationId: head.integrationId, config }
    this.releasing.set(key, token)
    // The final dispatch fence: a cancel, a close, or a gate that changed since the recheck above refuses.
    const beforeDispatch = (): boolean => {
      if (this.closed) return false
      if (!token.refused) {
        const now = this.staleGate(head, config)
        if (now) token.refused = now === 'wait' ? {} : { reason: now }
      }
      return !token.refused
    }
    let result: DecisionReleaseResult
    try {
      result = await this.host.release({
        verdict: head,
        delivery,
        evidence: this.evidenceFor(head, config),
        beforeDispatch
      })
    } finally {
      this.releasing.delete(key)
    }
    if (result.kind === 'admitted') {
      if (await store.finishDecisionVerdict(head.seq, head.subject, fence, 'admitted', null, this.host.now()))
        this.finished(key, 'admitted', 'released', result.handle)
      return 'next'
    }
    if (token.refused?.reason) {
      await this.finish(head, 'canceled', token.refused.reason)
      return 'next'
    }
    if (token.refused || result.recoverable) return 'wait'
    await this.finish(head, 'canceled', `admission:${result.reason}`)
    return 'next'
  }

  /** The cancel reason when the applied gate no longer matches the frozen one, or 'wait' while config converges. */
  // An announced mode list is sparse: a channel absent from it is createNew (channel-session-mode.md §4).
  private modeChanged(integrationId: string, config: FrozenGateConfig): boolean {
    const modes = this.appliedModes.get(integrationId)
    return modes !== undefined && (modes.get(config.binding.channel) ?? 'createNew') !== config.sessionMode
  }

  private staleGate(head: DecisionVerdictRow, config: FrozenGateConfig): string | 'wait' | undefined {
    const applied = this.applied.get(head.integrationId)
    if (applied === null) return this.host.store().isShared ? 'wait' : 'integration_removed'
    if (applied && !this.sameGate(applied.gates.get(config.binding.channel), config)) return 'config_changed'
    if (this.modeChanged(head.integrationId, config)) return 'config_changed'
    const current = this.host.currentGate(head.agentId, head.integrationId, config.binding.channel)
    if (current.status === 'unknown') return this.host.configConverged() ? 'integration_removed' : 'wait'
    if (current.status === 'unbound') return 'binding_removed'
    if (current.status === 'disabled') return current.reason
    if (!this.sameGate(current.gate, config) || current.sessionMode !== config.sessionMode) return 'config_changed'
    return undefined
  }

  private async finish(
    head: DecisionVerdictRow,
    state: 'admitted' | 'canceled',
    reason: string | null,
    label?: string
  ): Promise<void> {
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
    )
      this.finished(verdictKey(head.seq, head.subject), state, label ?? reason ?? 'none')
  }

  private evidenceFor(head: DecisionVerdictRow, config: FrozenGateConfig): DecisionEvidence {
    const answer = parseJson<{ answer?: unknown; matchedKeys?: string[]; recovered?: boolean }>(head.answerJson)
    const input = parseJson<{
      currentMessage?: { id?: string }
      context?: { partial?: boolean; reasons?: string[]; omittedMessages?: number }
    }>(head.inputJson)
    const result: DecisionEvidence['result'] =
      head.disposition === 'match' && answer?.answer
        ? { status: 'answered', answer: answer.answer as never, matchedKeys: answer.matchedKeys ?? [] }
        : {
            status: 'unavailable',
            reason: (head.unavailableReason ?? 'provider') as DecisionUnavailableReason,
            ...(answer?.recovered ? { recovered: true } : {})
          }
    return {
      verdict: { seq: head.seq, subject: head.subject },
      decisionId: config.decisionId,
      question: config.question,
      condition: config.condition,
      result,
      requestedModel: head.requestedModel,
      ...(head.actualModel ? { actualModel: head.actualModel } : {}),
      ...(head.inputTokens != null && head.outputTokens != null
        ? { usage: { inputTokens: Number(head.inputTokens), outputTokens: Number(head.outputTokens) } }
        : {}),
      evaluatedMessageId: input?.currentMessage?.id ?? String(head.seq),
      snapshotSeq: head.seq,
      partial: input?.context
        ? {
            partial: input.context.partial === true,
            reasons: input.context.reasons ?? [],
            omittedMessages: input.context.omittedMessages ?? 0
          }
        : { partial: true, reasons: ['not_evaluated'], omittedMessages: 0 }
    }
  }

  /** A participation admit waits for lower pending verdicts of its lane, bounded. */
  private async waitBehindLane(lane: Lane, seq: number, capMs: number): Promise<void> {
    const deadline = Date.now() + capMs
    for (;;) {
      if (this.closed || Date.now() >= deadline) return
      const head = await this.host
        .store()
        .decisionLaneHead(lane.orgId, lane.channel, lane.subject)
        .catch(() => undefined)
      if (!head || head.seq >= seq) return
      await this.runtime.nextProgress(deadline - Date.now())
    }
  }

  private finished(
    key: string,
    state: 'admitted' | 'canceled' | 'skipped',
    reason: string,
    handle?: DeliveryHandle
  ): void {
    this.metrics.finished(state, reason)
    this.runtime.finished(key, state, handle)
  }
}
