import {
  DECISION_EVALUATION_DETAIL_MAX_BYTES,
  DECISION_LIST_MAX_BYTES,
  DecisionModelEvaluationRecord,
  DecisionModelEvaluationRecordDetail,
  type DecisionModelEvaluationsRequest,
  type DecisionModelEvaluationsReply,
  type DecisionModelEvaluationRequest,
  type DecisionModelEvaluationReply
} from '@agentconnect.md/protocol'
import type { LocalStore, DecisionModelEvaluationRow } from '../store/local-store.js'
import { DecisionEvaluationScopeError } from './evaluations.js'

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength

export class DecisionModelEvaluationReader {
  constructor(
    private readonly deps: {
      store(): LocalStore
      servesAgent(orgId: string, agentId: string): boolean
    }
  ) {}

  private assertScope(orgId: string, agentId: string): void {
    if (!this.deps.servesAgent(orgId, agentId)) throw new DecisionEvaluationScopeError()
  }

  private summary(row: DecisionModelEvaluationRow): DecisionModelEvaluationRecord | null {
    try {
      const value = DecisionModelEvaluationRecord.safeParse({
        ...JSON.parse(row.summaryJson),
        seq: Number(row.seq),
        detailsExpired: row.detailJson === null
      })
      return value.success ? value.data : null
    } catch {
      return null
    }
  }

  async list(orgId: string, req: DecisionModelEvaluationsRequest): Promise<DecisionModelEvaluationsReply> {
    this.assertScope(orgId, req.agentId)
    const rows = await this.deps
      .store()
      .listDecisionModelEvaluations(orgId, req.agentId, req.cursor, req.limit + 1, req.decisionId)
    const items: DecisionModelEvaluationRecord[] = []
    let more = rows.length > req.limit
    for (const row of rows.slice(0, req.limit)) {
      const summary = this.summary(row)
      if (!summary || (req.decisionId && summary.decisionId !== req.decisionId)) continue
      if (bytes({ items: [...items, summary], nextCursor: Number.MAX_SAFE_INTEGER }) > DECISION_LIST_MAX_BYTES) {
        more = true
        break
      }
      items.push(summary)
    }
    const last = items.at(-1)?.seq ?? Number(rows[0]?.seq)
    return { items, nextCursor: more && Number.isFinite(last) ? last : null }
  }

  async get(orgId: string, req: DecisionModelEvaluationRequest): Promise<DecisionModelEvaluationReply> {
    this.assertScope(orgId, req.agentId)
    const row = await this.deps.store().getDecisionModelEvaluation(orgId, req.agentId, req.seq)
    const summary = row && this.summary(row)
    if (!row || !summary) return { evaluation: null }
    let kept: Record<string, unknown> = {}
    if (row.detailJson) {
      try {
        kept = JSON.parse(row.detailJson) as Record<string, unknown>
      } catch {
        return { evaluation: null }
      }
    }
    const parsed = DecisionModelEvaluationRecordDetail.safeParse({
      ...summary,
      selection: kept.selection ?? null,
      question: kept.question ?? null,
      input: kept.input ?? null,
      fullAnswer: kept.fullAnswer ?? null,
      ...(kept.chain ? { chain: kept.chain } : {}),
      rawRequest: kept.rawRequest ?? null,
      rawResponse: kept.rawResponse ?? null
    })
    if (!parsed.success) return { evaluation: null }
    const detail = parsed.data
    for (const key of ['rawRequest', 'rawResponse', 'input', 'selection', 'chain'] as const) {
      if (bytes({ evaluation: detail }) <= DECISION_EVALUATION_DETAIL_MAX_BYTES) break
      if (key === 'chain') delete detail.chain
      else (detail as Record<string, unknown>)[key] = null
    }
    return { evaluation: bytes({ evaluation: detail }) <= DECISION_EVALUATION_DETAIL_MAX_BYTES ? detail : null }
  }
}
