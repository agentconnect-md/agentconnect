// Recent evaluations for an agent's chat API gate (shared-bot-relay.md §10.4), read back in the shape a channel verdict has.
import {
  DECISION_EVALUATION_DETAIL_MAX_BYTES,
  DECISION_LIST_MAX_BYTES,
  DecisionEvaluationRecord,
  DecisionEvaluationRecordDetail,
  type AgentApiGateProjection,
  type ApiGateEvaluationReply,
  type ApiGateEvaluationRequest,
  type ApiGateEvaluationsReply,
  type ApiGateEvaluationsRequest
} from '@agentconnect.md/protocol'
import type { DecisionApiGateEvaluationRow, LocalStore } from '../store/local-store.js'
import { clampSessionTitle } from '../messages/hook-message.js'
import type { ApiGateEvidence, ApiGateVerdict } from './api-gate.js'
import { chainStepDetails, dropStepRaw } from './chain-steps.js'
import { DecisionEvaluationScopeError, summaryOf } from './evaluations.js'
import { modelSelectionState } from './model-selection.js'
import type { DecisionAgentContext } from './state.js'

type Summary = Omit<DecisionEvaluationRecord, 'seq' | 'title' | 'detailsExpired'>
type Detail = Pick<
  DecisionEvaluationRecordDetail,
  'snapshot' | 'input' | 'fullAnswer' | 'chain' | 'steps' | 'rawRequest' | 'rawResponse'
>

const RAW_MAX_CHARS = 16 * 1024
const raw = (text: string | null) =>
  text === null ? null : { text: text.slice(0, RAW_MAX_CHARS), truncated: text.length > RAW_MAX_CHARS }
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength

/** One gated API turn as a stored row; null when the gate's root Decision was not in the spec, as nothing was asked. */
export function apiGateEvaluationRecord(input: {
  projection: AgentApiGateProjection
  verdict: ApiGateVerdict
  evidence: ApiGateEvidence
  messageId: string
  /** The caller as the relay names it, shown as the judged message's sender. */
  sender: string
  /** The agent the gate decided for, as its state named it. */
  agent?: DecisionAgentContext
  text: string
  at: number
}): { summary: Summary; detail: Detail } | null {
  const { projection, verdict, evidence } = input
  const root = evidence.root
  if (!root) return null
  const result = evidence.evaluation
  const answer = result?.status === 'answered' ? result.answer : null
  const state = modelSelectionState('chat', input.text, input.agent) as {
    currentMessage: { text: string }
    truncated: boolean
  }
  return {
    summary: {
      at: new Date(input.at).toISOString(),
      messageId: input.messageId.slice(0, 256),
      decisionId: projection.gate.decisionId,
      outcome: verdict.reason === 'matched' ? 'triggered' : verdict.reason === 'declined' ? 'skipped' : 'unavailable',
      reason: verdict.reason === 'unavailable' ? ((verdict.detail ?? null)?.slice(0, 128) ?? null) : null,
      answer: answer ? summaryOf(answer) : null,
      matchedKeys: [],
      latencyMs: evidence.latencyMs,
      requestedModel: root.model,
      actualModel: result?.status === 'answered' ? result.model.slice(0, 256) : null,
      usage: result?.status === 'answered' ? result.usage : null
    },
    detail: {
      snapshot: {
        decisionId: root.id,
        providerId: root.providerId,
        model: root.model,
        question: root.question,
        condition: projection.gate.when,
        sessionMode: 'api'
      },
      input: {
        ...(input.agent ? { agent: input.agent } : {}),
        currentMessage: {
          id: input.messageId.slice(0, 256),
          sender: { id: input.sender.slice(0, 256) },
          text: state.currentMessage.text,
          threadId: null,
          ...(state.truncated ? { truncated: true as const } : {})
        },
        history: [],
        historyOmitted: 0,
        context: { partial: false, reasons: [], omittedMessages: 0 }
      },
      fullAnswer: answer,
      chain: evidence.chain,
      ...stepsOf(projection, evidence),
      rawRequest: raw(evidence.rawRequest),
      rawResponse: raw(evidence.rawResponse)
    }
  }
}

// The projection a verdict ran against is the frozen config: its Decisions and each gate step's condition.
function stepsOf(projection: AgentApiGateProjection, evidence: ApiGateEvidence): Pick<Detail, 'steps'> {
  if (evidence.chain.length < 2) return {}
  const steps = chainStepDetails({
    trace: evidence.chain,
    definition: (id) => projection.definitions.find((d) => d.id === id),
    condition: (stepId) => (stepId ? projection.gate.steps?.find((s) => s.id === stepId)?.when : projection.gate.when),
    raw: (index) => ({
      rawRequest: raw(evidence.stepRaw[index]?.request ?? null),
      rawResponse: raw(evidence.stepRaw[index]?.response ?? null)
    })
  })
  return steps ? { steps } : {}
}

export class DecisionApiGateEvaluationReader {
  constructor(
    private readonly deps: {
      store(): LocalStore
      servesAgent(orgId: string, agentId: string): boolean
    }
  ) {}

  private assertScope(orgId: string, agentId: string): void {
    if (!this.deps.servesAgent(orgId, agentId)) throw new DecisionEvaluationScopeError()
  }

  private parse(
    row: DecisionApiGateEvaluationRow
  ): { summary: DecisionEvaluationRecord; detail: Detail | null } | null {
    try {
      const detail = row.detailJson === null ? null : (JSON.parse(row.detailJson) as Detail)
      const line = detail?.input?.currentMessage.text
        .split('\n')
        .map((l) => l.trim())
        .find(Boolean)
      const summary = DecisionEvaluationRecord.safeParse({
        ...JSON.parse(row.summaryJson),
        seq: Number(row.seq),
        title: line ? clampSessionTitle(line) : null,
        detailsExpired: row.detailJson === null
      })
      return summary.success ? { summary: summary.data, detail } : null
    } catch {
      return null
    }
  }

  async list(orgId: string, req: ApiGateEvaluationsRequest): Promise<ApiGateEvaluationsReply> {
    this.assertScope(orgId, req.agentId)
    const rows = await this.deps
      .store()
      .listDecisionApiGateEvaluations(orgId, req.agentId, req.protocol, req.cursor, req.limit + 1, req.decisionId)
    const items: DecisionEvaluationRecord[] = []
    let more = rows.length > req.limit
    for (const row of rows.slice(0, req.limit)) {
      const summary = this.parse(row)?.summary
      if (!summary) continue
      if (bytes({ items: [...items, summary], nextCursor: Number.MAX_SAFE_INTEGER }) > DECISION_LIST_MAX_BYTES) {
        more = true
        break
      }
      items.push(summary)
    }
    const last = items.at(-1)?.seq ?? Number(rows[Math.min(req.limit, rows.length) - 1]?.seq)
    return { items, nextCursor: more && Number.isFinite(last) ? last : null }
  }

  async get(orgId: string, req: ApiGateEvaluationRequest): Promise<ApiGateEvaluationReply> {
    this.assertScope(orgId, req.agentId)
    const row = await this.deps.store().getDecisionApiGateEvaluation(orgId, req.agentId, req.protocol, req.seq)
    const stored = row && this.parse(row)
    if (!stored) return { evaluation: null }
    const parsed = DecisionEvaluationRecordDetail.safeParse({
      ...stored.summary,
      snapshot: stored.detail?.snapshot ?? null,
      input: stored.detail?.input ?? null,
      fullAnswer: stored.detail?.fullAnswer ?? null,
      ...(stored.detail?.chain?.length ? { chain: stored.detail.chain } : {}),
      ...(req.includeSteps && stored.detail?.steps?.length ? { steps: stored.detail.steps } : {}),
      rawRequest: stored.detail?.rawRequest ?? null,
      rawResponse: stored.detail?.rawResponse ?? null,
      evidence: null
    })
    if (!parsed.success) return { evaluation: null }
    const detail = parsed.data
    const fits = () => bytes({ evaluation: detail }) <= DECISION_EVALUATION_DETAIL_MAX_BYTES
    dropStepRaw(detail.steps, fits)
    for (const key of ['rawRequest', 'rawResponse', 'chain', 'input'] as const) {
      if (fits()) break
      if (key === 'chain') {
        delete detail.steps
        delete detail.chain
      } else detail[key] = null
    }
    return { evaluation: bytes({ evaluation: detail }) <= DECISION_EVALUATION_DETAIL_MAX_BYTES ? detail : null }
  }
}
