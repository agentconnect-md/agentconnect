import {
  DECISION_EVALUATION_DETAIL_MAX_BYTES,
  DECISION_RAW_JSON_MAX_CHARS,
  DECISION_LIST_MAX_BYTES,
  DecisionAnswer,
  DecisionChainTrace,
  DecisionCondition,
  DecisionEvaluationEntry,
  DecisionEvaluationRecord,
  DecisionQuestion,
  DecisionRoutingEvaluationRecord,
  DecisionRoutingTargetRecord,
  SharedBotDecisionRouting,
  routingEvaluationOutcome,
  type DecisionAnswerSummary,
  type DecisionRawJson,
  type DecisionRoutingEvaluationRecordDetail,
  type DecisionRoutingEvaluationReply,
  type DecisionRoutingEvaluationRequest,
  type DecisionRoutingEvaluationsReply,
  type DecisionRoutingEvaluationsRequest,
  type DecisionEvaluationConversation,
  type DecisionEvaluationOutcome,
  type DecisionEvaluationRecordDetail,
  type DecisionEvaluationReply,
  type DecisionEvaluationRequest,
  type DecisionEvaluationsReply,
  type DecisionEvaluationsRequest
} from '@agentconnect.md/protocol'
import { transcriptChannelKey, type DecisionVerdictRow, type LocalStore } from '../store/local-store.js'
import { routerSubject } from './router.js'
import { hookRouterSubject } from '../codehost/hook-routing.js'

/** Refused because this daemon does not serve the lane the frame names (answered as SCOPE_DENIED). */
export class DecisionEvaluationScopeError extends Error {
  constructor() {
    super('this daemon does not serve the requested integration')
    this.name = 'DecisionEvaluationScopeError'
  }
}

export interface DecisionEvaluationReaderDeps {
  store(): LocalStore
  /** The served lane's transport scope, session namespace, and routed bot; undefined when not served or the namespace is not yet known. */
  servedIntegration(
    orgId: string,
    agentId: string,
    integrationId: string
  ): Promise<({ transportScope?: string; botId?: string } & DecisionEvaluationConversation) | undefined>
  /** Whether this daemon serves the agent and hosts that code-host routing (code-host-decisions.md §7). */
  servedHookRouting?(orgId: string, agentId: string, routingId: string): Promise<boolean>
}

/** A hook routing lane has no conversation namespace: its rows are the routing's own, across every thread. */
const HOOK_ROUTING_CONVERSATION: DecisionEvaluationConversation = { platform: 'hook', tenantScope: null }

type VerdictRow = DecisionVerdictRow & { ts: string | null }

const encodedBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8')
const clip = (value: string | null | undefined, max: number): string | null =>
  value ? (value.length > max ? value.slice(0, max) : value) : null
const count = (value: unknown): number | null => {
  if (value === null || value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null
}

function parseJson(text: string | null | undefined): unknown {
  if (!text) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

function outcomeOf(row: DecisionVerdictRow): DecisionEvaluationOutcome {
  if (row.state === 'admitted') return row.disposition === 'match' ? 'triggered' : 'unavailable'
  if (row.state === 'skipped') return 'skipped'
  if (row.state === 'canceled') return 'canceled'
  return 'pending'
}

function summaryOf(answer: DecisionAnswer): DecisionAnswerSummary {
  if (answer.type === 'boolean') return { type: 'boolean', value: answer.value, probability: answer.probability }
  if (answer.type === 'choice') return { type: 'choice', value: answer.value, confidence: answer.confidence }
  return { type: 'score', value: answer.value, confidence: answer.confidence }
}

function answerOf(row: DecisionVerdictRow): { answer: DecisionAnswer | null; matchedKeys: string[] } {
  const stored = record(parseJson(row.answerJson))
  const parsed = DecisionAnswer.safeParse(stored?.answer)
  const keys = Array.isArray(stored?.matchedKeys) ? stored.matchedKeys : []
  return {
    answer: parsed.success ? parsed.data : null,
    matchedKeys: keys
      .filter((key): key is string => typeof key === 'string' && key.trim().length > 0 && key.length <= 64)
      .slice(0, 32)
  }
}

// A hook routing verdict names how it chose (mention, thread, decision, otherwise), which a gate row never has.
function hookRouteReasonOf(row: DecisionVerdictRow): string | null {
  if (row.subject !== hookRouterSubject(row.integrationId)) return null
  const reason = record(parseJson(row.answerJson))?.routeReason
  return typeof reason === 'string' ? reason : null
}

function summaryRow(row: VerdictRow): DecisionEvaluationRecord {
  const { answer, matchedKeys } = answerOf(row)
  const input = record(parseJson(row.inputJson))
  const currentId = record(input?.currentMessage)?.id
  const inputTokens = count(row.inputTokens)
  const outputTokens = count(row.outputTokens)
  return {
    seq: Number(row.seq),
    at: new Date(Number(row.createdAt)).toISOString(),
    messageId: clip(row.ts ?? (typeof currentId === 'string' ? currentId : null), 256),
    decisionId: row.decisionId,
    outcome: outcomeOf(row),
    reason: clip(row.unavailableReason ?? row.cancelReason ?? hookRouteReasonOf(row), 128),
    answer: answer ? summaryOf(answer) : null,
    matchedKeys,
    latencyMs: count(row.latencyMs),
    requestedModel: row.requestedModel,
    actualModel: clip(row.actualModel, 256),
    usage: inputTokens !== null && outputTokens !== null ? { inputTokens, outputTokens } : null,
    detailsExpired: row.bodiesStrippedAt !== null && row.bodiesStrippedAt !== undefined
  }
}

function snapshotOf(row: DecisionVerdictRow): DecisionEvaluationRecordDetail['snapshot'] {
  const config = record(parseJson(row.configJson))
  const question = DecisionQuestion.safeParse(config?.question)
  const condition = DecisionCondition.safeParse(config?.condition)
  const text = (value: unknown, max: number) =>
    typeof value === 'string' && value.trim() && value.length <= max ? value : undefined
  const decisionId = text(config?.decisionId, 128)
  const providerId = text(config?.providerId, 128)
  const model = text(config?.model, 128)
  if (!question.success || !condition.success || !decisionId || !providerId || !model) return null
  return {
    decisionId,
    providerId,
    model,
    question: question.data,
    condition: condition.data,
    sessionMode: clip(typeof config?.sessionMode === 'string' ? config.sessionMode : null, 64) ?? 'createNew'
  }
}

function entryOf(value: unknown): DecisionEvaluationEntry | undefined {
  const parsed = DecisionEvaluationEntry.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

function inputOf(row: DecisionVerdictRow): DecisionEvaluationRecordDetail['input'] {
  const state = record(parseJson(row.inputJson))
  const currentMessage = entryOf(state?.currentMessage)
  if (!currentMessage) return null
  const all = (Array.isArray(state?.history) ? state.history : []).flatMap((entry) => entryOf(entry) ?? [])
  const history = all.slice(-100)
  const context = record(state?.context)
  const reasons = Array.isArray(context?.reasons) ? context.reasons : []
  return {
    currentMessage,
    history,
    historyOmitted: all.length - history.length,
    context: {
      partial: context?.partial === true,
      reasons: reasons.filter((r): r is string => typeof r === 'string' && r.length <= 64).slice(0, 8),
      omittedMessages: count(context?.omittedMessages) ?? 0
    }
  }
}

function suppliedCount(row: DecisionVerdictRow): number | null {
  const seqs = parseJson(row.suppliedSeqsJson)
  return Array.isArray(seqs) ? seqs.length : null
}

const text = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.trim() && value.length <= max ? value : undefined

function routerTargets(row: DecisionVerdictRow): DecisionRoutingEvaluationRecord['targets'] {
  const stored = parseJson(row.targetsJson)
  if (!Array.isArray(stored)) return []
  return stored.slice(0, 64).flatMap((entry) => {
    const target = record(entry)
    const parsed = DecisionRoutingTargetRecord.safeParse({
      agentId: target?.agentId,
      effect: target?.effect,
      via: target?.via === 'mention' ? 'mention' : 'implicit',
      participant: target?.participant === true,
      disposition: target?.disposition,
      reason: clip(typeof target?.reason === 'string' ? target.reason : null, 128)
    })
    return parsed.success ? [parsed.data] : []
  })
}

function routerSummaryRow(row: VerdictRow): DecisionRoutingEvaluationRecord {
  const base = summaryRow(row)
  const config = record(parseJson(row.configJson))
  const stored = record(parseJson(row.answerJson))
  const ids = Array.isArray(stored?.matchedRuleIds) ? stored.matchedRuleIds : []
  const fallback = stored?.fallback
  const targets = routerTargets(row)
  return {
    seq: base.seq,
    at: base.at,
    channel: clip(text(config?.channel, 512) ?? null, 512) ?? '',
    messageId: base.messageId,
    decisionId: base.decisionId,
    outcome: routingEvaluationOutcome({
      state: row.state,
      disposition: row.disposition,
      targets,
      cancelReason: row.cancelReason
    }),
    reason: base.reason,
    evaluated: stored?.evaluated !== false,
    answer: base.answer,
    matchedKeys: base.matchedKeys,
    matchedRuleIds: ids.filter((id): id is string => text(id, 128) !== undefined).slice(0, 32),
    usedOtherwise: stored?.usedOtherwise === true,
    fallback: fallback === 'constrained' || fallback === 'default' || fallback === 'none' ? fallback : null,
    targets,
    latencyMs: base.latencyMs,
    requestedModel: base.requestedModel,
    actualModel: base.actualModel,
    usage: base.usage,
    detailsExpired: base.detailsExpired
  }
}

function routerSnapshotOf(row: DecisionVerdictRow): DecisionRoutingEvaluationRecordDetail['snapshot'] {
  const config = record(parseJson(row.configJson))
  const question = DecisionQuestion.safeParse(config?.question)
  const routing = SharedBotDecisionRouting.safeParse(config?.routing)
  const decisionId = text(config?.decisionId, 128)
  const providerId = text(config?.providerId, 128)
  const model = text(config?.model, 128)
  if (!question.success || !routing.success || !decisionId || !providerId || !model) return null
  return {
    decisionId,
    providerId,
    model,
    question: question.data,
    routing: routing.data,
    defaultAgentId: text(config?.defaultAgentId, 128) ?? null
  }
}

// Agent ids and participation only; the delivery is cleared at finish, so the frozen input's addressing, then the targets, stand in.
function routerConstraintOf(
  row: DecisionVerdictRow,
  targets: DecisionRoutingEvaluationRecord['targets']
): DecisionRoutingEvaluationRecordDetail['constraint'] {
  const via = (agentId: string, stored?: unknown): 'mention' | 'implicit' =>
    stored === 'mention' || targets.find((t) => t.agentId === agentId)?.via === 'mention' ? 'mention' : 'implicit'
  const delivery = record(parseJson(row.deliveryJson))
  const frozen = Array.isArray(delivery?.frozenConstraint)
    ? delivery.frozenConstraint
    : Array.isArray(delivery?.constraint)
      ? delivery.constraint
      : null
  if (frozen)
    return frozen.slice(0, 64).flatMap((entry) => {
      const item = record(entry)
      const agentId = text(item?.agentId, 128)
      return agentId ? [{ agentId, participant: item?.participant === true, via: via(agentId, item?.via) }] : []
    })
  const addressing = record(record(parseJson(row.inputJson))?.addressing)
  const constraint = record(addressing?.constraint)
  if (constraint) {
    const ids = (value: unknown) =>
      (Array.isArray(value) ? value : []).flatMap((id) => (text(id, 128) ? [id as string] : []))
    return [
      ...ids(constraint.eligibleAgentIds).map((agentId) => ({ agentId, participant: false, via: via(agentId) })),
      ...ids(constraint.participantAgentIds).map((agentId) => ({ agentId, participant: true, via: via(agentId) }))
    ].slice(0, 64)
  }
  const constrained = targets.filter(
    (t) => t.effect === 'participant' || t.effect === 'kept' || t.effect === 'fallback_constrained'
  )
  if (constrained.length > 0)
    return constrained.map((t) => ({ agentId: t.agentId, participant: t.participant, via: t.via }))
  return row.state === 'admitted' || row.state === 'canceled' || row.state === 'skipped' ? null : []
}

/** A raw body cut to `max` characters without splitting a surrogate pair. */
function rawJson(text: string, max = DECISION_RAW_JSON_MAX_CHARS, cut = false): DecisionRawJson {
  if (text.length <= max) return { text, truncated: cut }
  const end = /[\uD800-\uDBFF]/.test(text.charAt(max - 1)) ? max - 1 : max
  return { text: text.slice(0, end), truncated: true }
}

function rawResponseOf(row: DecisionVerdictRow): DecisionRawJson | null {
  const stored = record(parseJson(row.answerJson))
  return typeof stored?.raw === 'string' ? rawJson(stored.raw, undefined, stored.rawTruncated === true) : null
}

// The request body exactly as the evaluator sent it; verdicts settled before it was stored have none.
function rawRequestText(row: DecisionVerdictRow): string | null {
  const stored = record(parseJson(row.answerJson))
  return typeof stored?.request === 'string' ? stored.request : null
}

function chainOf(row: DecisionVerdictRow): { chain?: DecisionChainTrace } {
  const parsed = DecisionChainTrace.safeParse(record(parseJson(row.answerJson))?.chain)
  return parsed.success ? { chain: parsed.data } : {}
}

type RawDetail = {
  input: DecisionEvaluationRecordDetail['input']
  snapshot?: unknown
  chain?: DecisionChainTrace
  rawRequest?: DecisionRawJson | null
  rawResponse?: DecisionRawJson | null
}

// Fit order: shorten the stored request, then drop the oldest history, then the raw response, then the input.
function fitDetail(detail: RawDetail, conversation: DecisionEvaluationConversation, requestText: string | null): void {
  const fits = () => encodedBytes({ evaluation: detail, conversation }) <= DECISION_EVALUATION_DETAIL_MAX_BYTES
  if (detail.rawRequest && requestText !== null && !fits()) {
    let lo = 0
    let hi = detail.rawRequest.text.length - 1
    let best: DecisionRawJson | null = null
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2)
      detail.rawRequest = rawJson(requestText, mid, true)
      if (fits()) {
        best = detail.rawRequest
        lo = mid + 1
      } else hi = mid - 1
    }
    detail.rawRequest = best
  }
  while (!fits() && detail.input && detail.input.history.length > 0) {
    detail.input.history.shift()
    detail.input.historyOmitted += 1
  }
  if (!fits() && detail.rawResponse) detail.rawResponse = null
  if (!fits()) detail.input = null
  if (!fits()) delete detail.chain
  if (!fits()) detail.snapshot = null
}

/** The raw provider bodies a detail carries when asked; both null once retention stripped them. */
function rawOf(
  row: DecisionVerdictRow,
  expired: boolean
): { rawRequest: DecisionRawJson | null; rawResponse: DecisionRawJson | null; requestText: string | null } {
  const requestText = expired ? null : rawRequestText(row)
  return {
    rawRequest: requestText === null ? null : rawJson(requestText),
    rawResponse: expired ? null : rawResponseOf(row),
    requestText
  }
}

/** Recent evaluations (decisions.md §9.5): bounded, read-only views of one conversation lane's verdicts. */
export class DecisionEvaluationReader {
  constructor(private readonly deps: DecisionEvaluationReaderDeps) {}

  private async lane(
    orgId: string,
    req: { agentId: string; integrationId: string; channel: string; source?: 'hook_routing' }
  ): Promise<{
    lane: { orgId: string; integrationId: string; channel?: string; subject: string }
    conversation: DecisionEvaluationConversation
  }> {
    if (req.source === 'hook_routing') {
      if (!(await this.deps.servedHookRouting?.(orgId, req.agentId, req.integrationId)))
        throw new DecisionEvaluationScopeError()
      const lane = { orgId, integrationId: req.integrationId, subject: hookRouterSubject(req.integrationId) }
      return { lane, conversation: { ...HOOK_ROUTING_CONVERSATION } }
    }
    const served = await this.deps.servedIntegration(orgId, req.agentId, req.integrationId)
    if (!served) throw new DecisionEvaluationScopeError()
    const conversation: DecisionEvaluationConversation = {
      platform: served.platform,
      tenantScope: served.tenantScope
    }
    return {
      lane: {
        orgId,
        integrationId: req.integrationId,
        channel: transcriptChannelKey(req.channel, served.transportScope),
        subject: req.agentId
      },
      conversation
    }
  }

  // Each reply names the lane's session namespace so the CP gates it on that install's audience alone.
  async list(orgId: string, req: DecisionEvaluationsRequest): Promise<DecisionEvaluationsReply> {
    const { lane, conversation } = await this.lane(orgId, req)
    const rows = await this.deps.store().listDecisionVerdicts({
      ...lane,
      ...(req.decisionId ? { decisionId: req.decisionId } : {}),
      ...(req.cursor !== undefined ? { before: req.cursor } : {}),
      limit: req.limit
    })
    const items: DecisionEvaluationRecord[] = []
    let more = rows.length > req.limit
    for (const row of rows.slice(0, req.limit)) {
      const parsed = DecisionEvaluationRecord.safeParse(summaryRow(row))
      if (!parsed.success) continue
      // The cursor placeholder is the widest a seq can print, so the real page never exceeds the cap.
      if (
        encodedBytes({ items: [...items, parsed.data], nextCursor: Number.MAX_SAFE_INTEGER, conversation }) >
        DECISION_LIST_MAX_BYTES
      ) {
        more = true
        break
      }
      items.push(parsed.data)
    }
    const last = items.at(-1)?.seq ?? rows[0]?.seq
    return { items, nextCursor: more && last !== undefined && last > 0 ? last : null, conversation }
  }

  async get(orgId: string, req: DecisionEvaluationRequest): Promise<DecisionEvaluationReply> {
    const { lane, conversation } = await this.lane(orgId, req)
    const [row] = await this.deps.store().listDecisionVerdicts({ ...lane, seq: req.seq, limit: 1 })
    if (!row) return { evaluation: null, conversation }
    const summary = DecisionEvaluationRecord.safeParse(summaryRow(row))
    if (!summary.success) return { evaluation: null, conversation }
    const expired = summary.data.detailsExpired
    const fullAnswer = expired ? null : answerOf(row).answer
    const detail: DecisionEvaluationRecordDetail = {
      ...summary.data,
      snapshot: snapshotOf(row),
      input: expired ? null : inputOf(row),
      fullAnswer,
      ...(!expired ? chainOf(row) : {}),
      evidence:
        row.state === 'admitted' ? { snapshotSeq: Number(row.seq), suppliedBackground: suppliedCount(row) } : null
    }
    const { requestText, ...raw } = req.includeRaw ? rawOf(row, expired) : { requestText: null }
    Object.assign(detail, raw)
    fitDetail(detail, conversation, requestText)
    return { evaluation: detail, conversation }
  }

  // A router lane is the bot's subject across channels; the served member must be an install of that bot.
  private async routingLane(orgId: string, req: { agentId: string; integrationId: string; botId: string }) {
    const served = await this.deps.servedIntegration(orgId, req.agentId, req.integrationId)
    if (!served || served.botId !== req.botId) throw new DecisionEvaluationScopeError()
    const conversation: DecisionEvaluationConversation = { platform: served.platform, tenantScope: served.tenantScope }
    const channel = (raw: string) => transcriptChannelKey(raw, served.transportScope)
    return { subject: routerSubject(req.botId), channel, conversation }
  }

  async listRouting(orgId: string, req: DecisionRoutingEvaluationsRequest): Promise<DecisionRoutingEvaluationsReply> {
    const { subject, channel, conversation } = await this.routingLane(orgId, req)
    const rows = await this.deps.store().listRouterVerdicts({
      orgId,
      subject,
      channels: [...new Set(req.channels.map(channel))],
      ...(req.decisionId ? { decisionId: req.decisionId } : {}),
      ...(req.cursor !== undefined ? { before: req.cursor } : {}),
      limit: req.limit
    })
    const items: DecisionRoutingEvaluationRecord[] = []
    let more = rows.length > req.limit
    for (const row of rows.slice(0, req.limit)) {
      const parsed = DecisionRoutingEvaluationRecord.safeParse(routerSummaryRow(row))
      if (!parsed.success) continue
      // The cursor placeholder is the widest a seq can print, so the real page never exceeds the cap.
      if (
        encodedBytes({ items: [...items, parsed.data], nextCursor: Number.MAX_SAFE_INTEGER, conversation }) >
        DECISION_LIST_MAX_BYTES
      ) {
        more = true
        break
      }
      items.push(parsed.data)
    }
    const last = items.at(-1)?.seq ?? rows[0]?.seq
    return { items, nextCursor: more && last !== undefined && last > 0 ? last : null, conversation }
  }

  async getRouting(orgId: string, req: DecisionRoutingEvaluationRequest): Promise<DecisionRoutingEvaluationReply> {
    const { subject, channel, conversation } = await this.routingLane(orgId, req)
    const [row] = await this.deps
      .store()
      .listRouterVerdicts({ orgId, subject, channels: [channel(req.channel)], seq: req.seq, limit: 1 })
    if (!row) return { evaluation: null, conversation }
    const summary = DecisionRoutingEvaluationRecord.safeParse(routerSummaryRow(row))
    if (!summary.success) return { evaluation: null, conversation }
    const expired = summary.data.detailsExpired
    const detail: DecisionRoutingEvaluationRecordDetail = {
      ...summary.data,
      snapshot: routerSnapshotOf(row),
      constraint: expired ? null : routerConstraintOf(row, summary.data.targets),
      input: expired ? null : inputOf(row),
      fullAnswer: expired ? null : answerOf(row).answer,
      ...(!expired ? chainOf(row) : {})
    }
    const { requestText, ...raw } = req.includeRaw ? rawOf(row, expired) : { requestText: null }
    Object.assign(detail, raw)
    fitDetail(detail, conversation, requestText)
    return { evaluation: detail, conversation }
  }
}
