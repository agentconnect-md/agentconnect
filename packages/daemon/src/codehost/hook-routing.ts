import {
  DecisionAnswer,
  DecisionQuestion,
  HookRouteSelection,
  runDecisionChain,
  decisionChainUsage,
  matchDecisionCondition,
  matchDecisionRouting,
  type DecisionChainTrace,
  type DecisionBundleDefinition,
  type DecisionRoutingStep,
  type DecisionEvaluation,
  type HookRoutingProjection,
  type RdHookRouteCandidate,
  type RdHookRouting,
  type RdMsgHook,
  type SharedBotDecisionRouting
} from '@agentconnect.md/protocol'
import { canonicalJson } from '../decisions/bundle.js'
import { rawAnswerFields, type DecisionEvaluationInput } from '../decisions/evaluator.js'
import { DEFAULT_DECISION_GATE_LIMITS } from '../decisions/gate.js'
import type { DecisionStateResult } from '../decisions/state.js'
import type { ChannelRecordRef, DecisionVerdictRow, LocalStore } from '../store/local-store.js'
import { buildCodeHostHookState } from './decision-state.js'

/** A code-host routing's verdict subject (code-host-decisions.md §5 step 4). */
export const hookRouterSubject = (routingId: string): string => `hook-router:${routingId}`

export type HookRouteReason = HookRouteSelection['reason']

/** One selected hook as `targetsJson` keeps it. */
export interface HookRouteTarget {
  hookId: string
  agentId: string
  reason: HookRouteReason
}

/** The frozen, credential-free routing configuration a host verdict carries. */
export interface FrozenHookRoutingConfig {
  routingId: string
  repoFullName: string
  family: HookRoutingProjection['family']
  decisionId: string
  providerId: string
  model: string
  question: DecisionQuestion
  routing: SharedBotDecisionRouting
  definitions?: DecisionBundleDefinition[]
  fingerprint: string
  candidates: RdHookRouteCandidate[]
}

/** What the host verdict's answerJson keeps beside the raw provider bodies. */
interface HookRouteAnswer {
  answer?: DecisionAnswer
  chain?: DecisionChainTrace
  matchedKeys: string[]
  matchedRuleIds: string[]
  usedOtherwise: boolean
  evaluated: boolean
  routeReason: HookRouteReason
}

export type HookRouteOutcome =
  | { accepted: true; targets: Array<{ hookId: string; selection: HookRouteSelection }> }
  | { accepted: false; reason: string }

export interface HookRouterHost {
  store(): LocalStore
  evaluate(input: DecisionEvaluationInput, signal?: AbortSignal): Promise<DecisionEvaluation>
  now(): number
  ownerFence(): string
  /** The routing this host applies now, re-read after the provider call so a mid-call edit is never missed. */
  currentProjection(agentId: string, routingId: string): HookRoutingProjection | undefined
  log: { warn(message: string): void }
}

export const DEFAULT_HOOK_ROUTER_LIMITS = {
  deadlineMs: DEFAULT_DECISION_GATE_LIMITS.deadlineMs,
  /** How long a redelivery waits past a foreign pending verdict's deadline before taking it over. */
  takeoverGraceMs: 1_000,
  pollMs: 100
}

const TERMINAL = new Set(['admitted', 'skipped', 'canceled'])

function parseJson<T>(text: string | null | undefined): T | undefined {
  if (!text) return undefined
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

/** What a routing verdict is bound to; a Decision rename alone leaves it unchanged. */
export function hookRoutingFingerprint(projection: HookRoutingProjection): string {
  return canonicalJson({
    routingId: projection.routingId,
    enabled: projection.config.enabled,
    decisionId: projection.definition.id,
    providerId: projection.definition.providerId,
    model: projection.definition.model,
    question: projection.definition.question,
    rules: projection.config.rules,
    otherwise: projection.config.otherwise,
    steps: projection.config.steps,
    definitions: projection.definitions
      ?.map(({ id, providerId, model, question }) => ({ id, providerId, model, question }))
      .sort((a, b) => a.id.localeCompare(b.id))
  })
}

// The evaluation host records the event before running its Decision chain.
export class HookRouter {
  private readonly inflight = new Map<string, Promise<HookRouteOutcome>>()

  constructor(
    private readonly host: HookRouterHost,
    private readonly limits = DEFAULT_HOOK_ROUTER_LIMITS
  ) {}

  /** Choose for a host copy recorded at `record`; a redelivery of the same copy returns the stored choice. */
  choose(
    msg: RdMsgHook & { routing: RdHookRouting },
    record: ChannelRecordRef,
    projection: HookRoutingProjection
  ): Promise<HookRouteOutcome> {
    const subject = hookRouterSubject(projection.routingId)
    const key = `${record.seq}:${subject}`
    const running = this.inflight.get(key)
    if (running) return running
    const task = this.run(msg, record, projection, subject).finally(() => this.inflight.delete(key))
    this.inflight.set(key, task)
    return task
  }

  private async run(
    msg: RdMsgHook & { routing: RdHookRouting },
    record: ChannelRecordRef,
    projection: HookRoutingProjection,
    subject: string
  ): Promise<HookRouteOutcome> {
    const store = this.host.store()
    const existing = await store.getDecisionVerdict(record.seq, subject)
    if (existing) return await this.awaitExisting(existing)
    const candidates = dedupeCandidates(msg.routing.candidates)
    const definition = projection.definition
    const config: FrozenHookRoutingConfig = {
      routingId: projection.routingId,
      repoFullName: projection.repoFullName,
      family: projection.family,
      decisionId: definition.id,
      providerId: definition.providerId,
      model: definition.model,
      question: definition.question,
      routing: projection.config,
      ...(projection.definitions ? { definitions: projection.definitions } : {}),
      fingerprint: hookRoutingFingerprint(projection),
      candidates
    }
    const now = this.host.now()
    const reserved = await store.reserveDecisionVerdict({
      seq: record.seq,
      subject,
      orgId: record.orgId,
      channel: record.transcriptChannel,
      agentId: msg.agentId,
      integrationId: projection.routingId,
      decisionId: definition.id,
      configJson: JSON.stringify(config),
      deliveryJson: null,
      requestedModel: definition.model,
      deadlineAt: now + this.limits.deadlineMs,
      ownerFence: this.host.ownerFence(),
      createdAt: now
    })
    if (!reserved.verdict) return { accepted: false, reason: 'durability' }
    if (!reserved.created) return await this.awaitExisting(reserved.verdict)
    // Every event is judged: a mention and the thread's earlier choice are context, never a shortcut.
    return await this.evaluate(reserved.verdict, config, msg, record.thread)
  }

  private async evaluate(
    row: DecisionVerdictRow,
    frozen: FrozenHookRoutingConfig,
    msg: RdMsgHook,
    thread: string | null
  ): Promise<HookRouteOutcome> {
    const store = this.host.store()
    const fence = this.host.ownerFence()
    let config = frozen
    let trace: DecisionChainTrace = []
    const unavailable = (reason: string, raw?: { raw?: string; request?: string }) =>
      this.finish(row, config, config.candidates, 'unavailable', {
        evaluated: true,
        unavailableReason: reason,
        ...(config.routing.steps?.length ? { chain: trace, usage: decisionChainUsage(trace) } : {}),
        ...raw
      })
    let built: DecisionStateResult | undefined
    try {
      const window = await store.decisionWindow(row.orgId, row.channel, row.seq, undefined, undefined, { thread })
      built = window.current
        ? buildCodeHostHookState({
            msg,
            current: window.current,
            history: window.history,
            full: window.full,
            question: config.question,
            model: config.model
          })
        : undefined
    } catch {
      built = undefined
    }
    if (!built || built.unsupported) return await unavailable('unsupported_input')
    if (!(await store.beginDecisionEvaluation(row.seq, row.subject, fence, JSON.stringify(built.state))))
      return await this.awaitExisting((await store.getDecisionVerdict(row.seq, row.subject)) ?? row)
    let raw: string | undefined
    let request: string | undefined
    let evaluation: DecisionEvaluation
    const definitions = new Map(config.definitions?.map((d) => [d.id, d]))
    const definitionOf = (id: string) => (id === config.decisionId ? config : definitions.get(id))
    const answers = new Map<string, { question: DecisionQuestion; answer: DecisionAnswer }>()
    try {
      const result = await runDecisionChain<DecisionRoutingStep>({
        root: config.routing,
        steps: config.routing.steps,
        deadlineAt: row.deadlineAt,
        now: () => this.host.now(),
        evaluate: (step, index, signal) => {
          const decision = definitionOf(step.decisionId)
          if (!decision) return Promise.resolve({ status: 'unavailable', reason: 'unsupported_input' } as const)
          return this.host.evaluate(
            {
              agentId: row.agentId,
              evaluationId: `${row.seq}:${row.subject}:${index}`,
              decision: { providerId: decision.providerId, model: decision.model, question: decision.question },
              state: built.state,
              deadlineAt: row.deadlineAt,
              ...(index === 0
                ? {
                    onRawRequest: (text: string) => {
                      request = text
                    },
                    onRawResponse: (text: string) => {
                      raw = text
                    }
                  }
                : {})
            },
            signal
          )
        },
        next: (step, result) => {
          const question = definitionOf(step.decisionId)!.question
          return step.rules.flatMap((rule) =>
            rule.action.type === 'decision' && matchDecisionCondition(question, rule.when, result.answer).matched
              ? [rule.action.nextStepId]
              : []
          )
        }
      })
      evaluation = result.evaluation
      trace = result.trace
      for (const step of trace) {
        if (step.stepId && step.evaluation.status === 'answered')
          answers.set(step.stepId, {
            question: definitionOf(step.decisionId)!.question,
            answer: step.evaluation.answer
          })
      }
    } catch (err) {
      this.host.log.warn(`hook-router: evaluation failed: ${(err as Error).message}`)
      return await unavailable('provider', { raw, request })
    }
    if (evaluation.status === 'unavailable') return await unavailable(evaluation.reason, { raw, request })
    const current = this.host.currentProjection(row.agentId, config.routingId)
    const decisionChanged =
      !current ||
      !current.config.enabled ||
      current.definition.id !== config.decisionId ||
      current.definition.model !== config.model ||
      current.definition.providerId !== config.providerId ||
      canonicalJson(current.definition.question) !== canonicalJson(config.question) ||
      (!!(config.routing.steps?.length || current.config.steps?.length) &&
        hookRoutingFingerprint(current) !== config.fingerprint)
    if (decisionChanged) return await this.cancel(row, 'config_changed')
    // Rules or Otherwise edited during the call: the answer still fits the same question, so the current rules decide.
    if (hookRoutingFingerprint(current) !== config.fingerprint)
      config = { ...config, routing: current.config, fingerprint: hookRoutingFingerprint(current) }
    let match: ReturnType<typeof matchDecisionRouting>
    try {
      match = matchDecisionRouting(config.question, config.routing, evaluation.answer, undefined, answers)
    } catch {
      return await unavailable('invalid_response', { raw, request })
    }
    const answered = {
      evaluated: true,
      answer: evaluation.answer,
      matchedKeys: match.matchedKeys,
      matchedRuleIds: match.matchedRuleIds,
      usedOtherwise: match.usedOtherwise,
      model: evaluation.model,
      usage: decisionChainUsage(trace),
      ...(config.routing.steps?.length ? { chain: trace } : {}),
      raw,
      request
    }
    // An unmatched branch contributes every candidate only when Otherwise asks for them.
    if (match.usedOtherwise && config.routing.otherwise.type === 'default_agent')
      return await this.finish(row, config, config.candidates, 'otherwise', answered)
    const agents = new Set(match.agentIds)
    return await this.finish(
      row,
      config,
      config.candidates.filter((c) => agents.has(c.agentId)),
      match.usedOtherwise && match.agentIds.length === 0 ? 'otherwise' : 'decision',
      answered
    )
  }

  /** Settle the verdict with its targets, then admit it unless nobody was selected. */
  private async finish(
    row: DecisionVerdictRow,
    config: FrozenHookRoutingConfig,
    selected: readonly RdHookRouteCandidate[],
    reason: HookRouteReason,
    extra: {
      evaluated: boolean
      unavailableReason?: string
      answer?: DecisionAnswer
      chain?: DecisionChainTrace
      matchedKeys?: string[]
      matchedRuleIds?: string[]
      usedOtherwise?: boolean
      model?: string
      usage?: { inputTokens: number; outputTokens: number }
      raw?: string
      request?: string
    }
  ): Promise<HookRouteOutcome> {
    const store = this.host.store()
    const fence = this.host.ownerFence()
    const targets: HookRouteTarget[] = selected.map((c) => ({ hookId: c.hookId, agentId: c.agentId, reason }))
    const disposition = extra.unavailableReason !== undefined ? 'unavailable' : targets.length > 0 ? 'match' : 'skip'
    const answerJson: HookRouteAnswer & ReturnType<typeof rawAnswerFields> = {
      ...(extra.answer ? { answer: extra.answer } : {}),
      ...(extra.chain ? { chain: extra.chain } : {}),
      matchedKeys: extra.matchedKeys ?? [],
      matchedRuleIds: extra.matchedRuleIds ?? [],
      usedOtherwise: extra.usedOtherwise ?? false,
      evaluated: extra.evaluated,
      routeReason: reason,
      ...rawAnswerFields(extra.raw, extra.request)
    }
    const settledAt = this.host.now()
    const won = await store.settleDecisionVerdict(row.seq, row.subject, fence, {
      disposition,
      ...(extra.unavailableReason !== undefined ? { unavailableReason: extra.unavailableReason } : {}),
      answerJson: JSON.stringify(answerJson),
      ...(extra.model ? { actualModel: extra.model } : {}),
      ...(extra.usage ? { inputTokens: extra.usage.inputTokens, outputTokens: extra.usage.outputTokens } : {}),
      targetsJson: JSON.stringify(targets),
      latencyMs: Math.max(0, settledAt - row.createdAt),
      settledAt
    })
    if (won && disposition !== 'skip')
      await store.finishDecisionVerdict(row.seq, row.subject, fence, 'admitted', null, this.host.now())
    const after = await store.getDecisionVerdict(row.seq, row.subject)
    // A lost CAS means another owner finished it first; its choice is the one returned.
    if (!after || !TERMINAL.has(after.state)) return { accepted: false, reason: 'durability' }
    return replayHookRoute(after)
  }

  /** A routing whose Decision changed or stopped mid-call: the verdict is canceled and nothing fires. */
  private async cancel(row: DecisionVerdictRow, reason: string): Promise<HookRouteOutcome> {
    await this.host
      .store()
      .finishDecisionVerdict(row.seq, row.subject, this.host.ownerFence(), 'canceled', reason, this.host.now())
    return { accepted: false, reason }
  }

  /** A verdict that already exists: its stored choice once final, or a takeover once a foreign owner overran its deadline. */
  private async awaitExisting(row: DecisionVerdictRow): Promise<HookRouteOutcome> {
    const store = this.host.store()
    const waiting = (r: DecisionVerdictRow) =>
      (r.state === 'reserved' || r.state === 'evaluating') &&
      this.host.now() < r.deadlineAt + this.limits.takeoverGraceMs
    let current: DecisionVerdictRow | undefined = row
    const until = Date.now() + this.limits.deadlineMs + this.limits.takeoverGraceMs
    while (current && waiting(current) && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, this.limits.pollMs))
      current = await store.getDecisionVerdict(row.seq, row.subject)
    }
    if (!current) return { accepted: false, reason: 'durability' }
    if (TERMINAL.has(current.state)) return replayHookRoute(current)
    const config = parseJson<FrozenHookRoutingConfig>(current.configJson)
    const fence = this.host.ownerFence()
    const owned =
      current.ownerFence === fence ||
      (await store.adoptDecisionVerdict(current.seq, current.subject, current.ownerFence, fence))
    if (!config || !owned) return { accepted: false, reason: 'busy' }
    // Settled but never admitted (a crash between the two writes): its targets stand.
    if (current.state === 'settled') {
      await store.finishDecisionVerdict(current.seq, current.subject, fence, 'admitted', null, this.host.now())
      const after = await store.getDecisionVerdict(current.seq, current.subject)
      return after && TERMINAL.has(after.state) ? replayHookRoute(after) : { accepted: false, reason: 'durability' }
    }
    return await this.finish({ ...current, ownerFence: fence }, config, config.candidates, 'unavailable', {
      evaluated: true,
      unavailableReason: 'timeout'
    })
  }
}

function dedupeCandidates(candidates: readonly RdHookRouteCandidate[]): RdHookRouteCandidate[] {
  const seen = new Set<string>()
  return candidates.filter((c) => !seen.has(c.hookId) && seen.add(c.hookId) !== undefined)
}

/** Rebuild the ack targets from a final host verdict, so a redelivery never evaluates again. */
export function replayHookRoute(row: DecisionVerdictRow): HookRouteOutcome {
  const config = parseJson<FrozenHookRoutingConfig>(row.configJson)
  const stored = parseJson<HookRouteAnswer>(row.answerJson)
  const answer = DecisionAnswer.safeParse(stored?.answer)
  const question = DecisionQuestion.safeParse(config?.question)
  const evaluated = stored?.evaluated === true
  const matchedKeys = (stored?.matchedKeys ?? []).filter((k) => typeof k === 'string').slice(0, 32)
  const targets = row.state === 'admitted' ? (parseJson<HookRouteTarget[]>(row.targetsJson) ?? []) : []
  return {
    accepted: true,
    targets: targets.flatMap((t) => {
      const selection = HookRouteSelection.safeParse({
        routingId: row.integrationId,
        decisionId: row.decisionId,
        reason: t?.reason,
        ...(evaluated ? { verdictSeq: row.seq } : {}),
        ...(evaluated && question.success ? { question: question.data } : {}),
        ...(answer.success ? { answer: answer.data } : {}),
        ...(matchedKeys.length > 0 ? { matchedKeys } : {}),
        ...(row.actualModel ? { model: row.actualModel } : {}),
        ...(row.unavailableReason ? { unavailableReason: row.unavailableReason } : {})
      })
      return selection.success && typeof t.hookId === 'string' ? [{ hookId: t.hookId, selection: selection.data }] : []
    })
  }
}
