// Recent evaluations of an agent's coordinator filter (auto-session-mode.md §4.7), read back in the shape a channel verdict has.
import {
  COORDINATOR_FILTER_DECISION_ID,
  DECISION_EVALUATION_DETAIL_MAX_BYTES,
  DECISION_LIST_MAX_BYTES,
  DecisionEvaluationInput,
  DecisionEvaluationRecord,
  DecisionEvaluationRecordDetail,
  type CoordinatorFilterEvaluationReply,
  type CoordinatorFilterEvaluationRequest,
  type CoordinatorFilterEvaluationsReply,
  type CoordinatorFilterEvaluationsRequest,
  type DecisionEvaluation
} from '@agentconnect.md/protocol'
import type { CoordinatorFilterEvaluationRow, LocalStore } from '../store/local-store.js'
import { clampSessionTitle } from '../messages/hook-message.js'
import { DecisionEvaluationScopeError, evaluationInputOf, summaryOf } from '../decisions/evaluations.js'
import { modelSelectionState } from '../decisions/model-selection.js'
import { COORDINATOR_FILTER_QUESTION } from './coordinator-filter.js'

type Summary = Omit<DecisionEvaluationRecord, 'seq' | 'title' | 'detailsExpired'>
// The title rides the summary, so a row still names its message once retention strips the body.
type StoredSummary = Summary & { title: string | null }
type Detail = Pick<DecisionEvaluationRecordDetail, 'snapshot' | 'input' | 'fullAnswer' | 'rawRequest' | 'rawResponse'>

const RAW_MAX_CHARS = 16 * 1024
const raw = (text: string | undefined) =>
  text === undefined ? null : { text: text.slice(0, RAW_MAX_CHARS), truncated: text.length > RAW_MAX_CHARS }
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength

/** One filter verdict as a stored row: let through (`triggered`), skipped, or let through because no answer came (`unavailable`). */
export function coordinatorFilterEvaluationRecord(input: {
  filter: { providerId: string; model: string }
  messageId: string
  /** The judged message's text, whose first line titles the row. */
  text: string
  /** The judged message's sender, for an input built from the message alone. */
  sender: string
  /** The state the filter asked about; absent when none could be built and nothing was asked. */
  state: Record<string, unknown> | undefined
  evaluation: DecisionEvaluation | undefined
  admits: boolean
  latencyMs: number | null
  rawRequest?: string
  rawResponse?: string
  at: number
}): { summary: StoredSummary; detail: Detail } {
  const { evaluation } = input
  const answer = evaluation?.status === 'answered' ? evaluation.answer : null
  // A state without a recorded conversation names only the text; the message itself then fills the entry.
  const message = modelSelectionState('chat', input.text) as { currentMessage: { text: string }; truncated: boolean }
  const stored = evaluationInputOf(input.state) ?? {
    currentMessage: {
      id: input.messageId.slice(0, 256),
      sender: { id: input.sender.slice(0, 256) },
      text: message.currentMessage.text,
      threadId: null,
      ...(message.truncated ? { truncated: true as const } : {})
    },
    history: [],
    historyOmitted: 0,
    context: { partial: false, reasons: [], omittedMessages: 0 }
  }
  const parsedInput = DecisionEvaluationInput.safeParse(stored)
  return {
    summary: {
      at: new Date(input.at).toISOString(),
      messageId: input.messageId.slice(0, 256),
      title: coordinatorFilterTitle(input.text),
      decisionId: COORDINATOR_FILTER_DECISION_ID,
      outcome: evaluation?.status === 'answered' ? (input.admits ? 'triggered' : 'skipped') : 'unavailable',
      reason: evaluation?.status === 'unavailable' ? evaluation.reason.slice(0, 128) : null,
      answer: answer ? summaryOf(answer) : null,
      matchedKeys: [],
      latencyMs: input.latencyMs,
      requestedModel: input.filter.model,
      actualModel: evaluation?.status === 'answered' ? evaluation.model.slice(0, 256) : null,
      usage: evaluation?.status === 'answered' ? evaluation.usage : null
    },
    detail: {
      snapshot: {
        decisionId: COORDINATOR_FILTER_DECISION_ID,
        providerId: input.filter.providerId,
        model: input.filter.model,
        question: COORDINATOR_FILTER_QUESTION,
        condition: { type: 'boolean', values: [true] },
        sessionMode: 'auto'
      },
      input: parsedInput.success ? parsedInput.data : null,
      fullAnswer: answer,
      rawRequest: raw(input.rawRequest),
      rawResponse: raw(input.rawResponse)
    }
  }
}

export class CoordinatorFilterEvaluationReader {
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
    row: CoordinatorFilterEvaluationRow
  ): { summary: DecisionEvaluationRecord; detail: Detail | null } | null {
    try {
      const detail = row.detailJson === null ? null : (JSON.parse(row.detailJson) as Detail)
      const stored = JSON.parse(row.summaryJson) as Partial<StoredSummary>
      const summary = DecisionEvaluationRecord.safeParse({
        title: null,
        ...stored,
        seq: Number(row.seq),
        detailsExpired: row.detailJson === null
      })
      return summary.success ? { summary: summary.data, detail } : null
    } catch {
      return null
    }
  }

  async list(orgId: string, req: CoordinatorFilterEvaluationsRequest): Promise<CoordinatorFilterEvaluationsReply> {
    this.assertScope(orgId, req.agentId)
    const rows = await this.deps.store().listCoordinatorFilterEvaluations(orgId, req.agentId, req.cursor, req.limit + 1)
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

  async get(orgId: string, req: CoordinatorFilterEvaluationRequest): Promise<CoordinatorFilterEvaluationReply> {
    this.assertScope(orgId, req.agentId)
    const row = await this.deps.store().getCoordinatorFilterEvaluation(orgId, req.agentId, req.seq)
    const stored = row && this.parse(row)
    if (!stored) return { evaluation: null }
    const parsed = DecisionEvaluationRecordDetail.safeParse({
      ...stored.summary,
      snapshot: stored.detail?.snapshot ?? null,
      input: stored.detail?.input ?? null,
      fullAnswer: stored.detail?.fullAnswer ?? null,
      rawRequest: stored.detail?.rawRequest ?? null,
      rawResponse: stored.detail?.rawResponse ?? null,
      evidence: null
    })
    if (!parsed.success) return { evaluation: null }
    const detail = parsed.data
    for (const key of ['rawRequest', 'rawResponse', 'input'] as const) {
      if (bytes({ evaluation: detail }) <= DECISION_EVALUATION_DETAIL_MAX_BYTES) break
      detail[key] = null
    }
    return { evaluation: bytes({ evaluation: detail }) <= DECISION_EVALUATION_DETAIL_MAX_BYTES ? detail : null }
  }
}

/** The list row's title: the judged message's first line, as a session title reads. */
export function coordinatorFilterTitle(text: string): string | null {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean)
  return line ? clampSessionTitle(line) : null
}
