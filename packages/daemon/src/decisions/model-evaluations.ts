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
import { dropStepRaw } from './chain-steps.js'
import { DecisionEvaluationScopeError } from './evaluations.js'
import { mentionedUserIds, substituteUserMentions } from '../slack/mentions.js'

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
        title: null,
        ...JSON.parse(row.summaryJson),
        seq: Number(row.seq),
        detailsExpired: row.detailJson === null
      })
      return value.success ? value.data : null
    } catch {
      return null
    }
  }

  // Each row reads as its session's title does in the console: the stored title with its mentions named.
  private async titled(
    items: DecisionModelEvaluationRecord[],
    agentId: string
  ): Promise<DecisionModelEvaluationRecord[]> {
    const store = this.deps.store()
    const raw = new Map<string, string | null>()
    for (const { sessionId } of items)
      if (!raw.has(sessionId))
        raw.set(sessionId, (await store.getSessionByOutwardId(sessionId, agentId))?.title?.trim() || null)
    const names = await store.getDisplayNames([...raw.values()].flatMap((title) => mentionedUserIds(title)))
    return items.map((item) => {
      const title = raw.get(item.sessionId)
      return { ...item, title: title ? [...substituteUserMentions(title, names)].slice(0, 256).join('') : null }
    })
  }

  async list(orgId: string, req: DecisionModelEvaluationsRequest): Promise<DecisionModelEvaluationsReply> {
    this.assertScope(orgId, req.agentId)
    const rows = await this.deps
      .store()
      .listDecisionModelEvaluations(orgId, req.agentId, req.cursor, req.limit + 1, req.decisionId)
    const items: DecisionModelEvaluationRecord[] = []
    let more = rows.length > req.limit
    const summaries = rows.slice(0, req.limit).flatMap((row) => {
      const summary = this.summary(row)
      return summary && (!req.decisionId || summary.decisionId === req.decisionId) ? [summary] : []
    })
    for (const summary of await this.titled(summaries, req.agentId)) {
      if (bytes({ items: [...items, summary], nextCursor: Number.MAX_SAFE_INTEGER }) > DECISION_LIST_MAX_BYTES) {
        more = true
        break
      }
      items.push(summary)
    }
    const last = items.at(-1)?.seq ?? Number(rows[Math.min(req.limit, rows.length) - 1]?.seq)
    return { items, nextCursor: more && Number.isFinite(last) ? last : null }
  }

  async get(orgId: string, req: DecisionModelEvaluationRequest): Promise<DecisionModelEvaluationReply> {
    this.assertScope(orgId, req.agentId)
    const row = await this.deps.store().getDecisionModelEvaluation(orgId, req.agentId, req.seq)
    const stored = row && this.summary(row)
    if (!row || !stored) return { evaluation: null }
    const [summary] = await this.titled([stored], req.agentId)
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
      ...(req.includeSteps && kept.steps ? { steps: kept.steps } : {}),
      rawRequest: kept.rawRequest ?? null,
      rawResponse: kept.rawResponse ?? null
    })
    if (!parsed.success) return { evaluation: null }
    const detail = parsed.data
    const fits = () => bytes({ evaluation: detail }) <= DECISION_EVALUATION_DETAIL_MAX_BYTES
    dropStepRaw(detail.steps, fits)
    for (const key of ['rawRequest', 'rawResponse', 'input', 'selection', 'chain'] as const) {
      if (fits()) break
      if (key === 'chain') {
        delete detail.steps
        delete detail.chain
      } else (detail as Record<string, unknown>)[key] = null
    }
    return { evaluation: bytes({ evaluation: detail }) <= DECISION_EVALUATION_DETAIL_MAX_BYTES ? detail : null }
  }
}
