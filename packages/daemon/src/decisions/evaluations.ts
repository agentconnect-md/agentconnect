import {
  DECISION_EVALUATION_DETAIL_MAX_BYTES,
  DECISION_LIST_MAX_BYTES,
  DecisionAnswer,
  DecisionCondition,
  DecisionEvaluationEntry,
  DecisionEvaluationRecord,
  DecisionQuestion,
  type DecisionAnswerSummary,
  type DecisionEvaluationConversation,
  type DecisionEvaluationOutcome,
  type DecisionEvaluationRecordDetail,
  type DecisionEvaluationReply,
  type DecisionEvaluationRequest,
  type DecisionEvaluationsReply,
  type DecisionEvaluationsRequest
} from '@agentconnect.md/protocol'
import { transcriptChannelKey, type DecisionVerdictRow, type LocalStore } from '../store/local-store.js'

/** Refused because this daemon does not serve the lane the frame names (answered as SCOPE_DENIED). */
export class DecisionEvaluationScopeError extends Error {
  constructor() {
    super('this daemon does not serve the requested integration')
    this.name = 'DecisionEvaluationScopeError'
  }
}

export interface DecisionEvaluationReaderDeps {
  store(): LocalStore
  /** The served lane's transport scope and session namespace; undefined when not served or the namespace is not yet known. */
  servedIntegration(
    orgId: string,
    agentId: string,
    integrationId: string
  ): Promise<({ transportScope?: string } & DecisionEvaluationConversation) | undefined>
}

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
    reason: clip(row.unavailableReason ?? row.cancelReason, 128),
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

/** Recent evaluations (decisions.md §9.5): bounded, read-only views of one conversation lane's verdicts. */
export class DecisionEvaluationReader {
  constructor(private readonly deps: DecisionEvaluationReaderDeps) {}

  private async lane(orgId: string, req: { agentId: string; integrationId: string; channel: string }) {
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
      evidence:
        row.state === 'admitted' ? { snapshotSeq: Number(row.seq), suppliedBackground: suppliedCount(row) } : null
    }
    const fits = () => encodedBytes({ evaluation: detail, conversation }) <= DECISION_EVALUATION_DETAIL_MAX_BYTES
    // The oldest history goes first; the current message is kept or the whole input is.
    while (!fits() && detail.input && detail.input.history.length > 0) {
      detail.input.history.shift()
      detail.input.historyOmitted += 1
    }
    if (!fits()) detail.input = null
    return { evaluation: detail, conversation }
  }
}
