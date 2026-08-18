/**
 * `UsageWriter` — the single CP port every session-usage report enters through.
 *
 * Two authenticated adapters, one writer: the daemon's `usage/report` EVT and the
 * service-authenticated batch endpoint both hand the SAME cumulative payload here,
 * and each stamps the `source` itself. The payload NEVER self-reports its source —
 * that is the whole point of the seam: a caller cannot claim to be a different
 * ingress than the credential it authenticated with.
 *
 * Every number is the session's cumulative total as of `lastActivityAt`, not a
 * delta. Storage stays cumulative too (`SessionUsage` snapshot + `SessionSpend`
 * checkpoint), so a duplicate delivery is an idempotent no-op and range readers
 * derive spend by diffing consecutive checkpoints.
 *
 * Money is the one field the two adapters see differently. A report may carry
 * `costAmount` as the exact decimal string OR — from any daemon shipped so far — as a
 * JSON number, so an adapter NORMALIZES to the decimal string before it gets here.
 * The writer itself only accepts the normalized shape: the money path below it has no
 * float in it, and no future caller can add one back without changing this type.
 */
import { type DecimalAmount, normalizeReportedCostAmount } from '@agentconnect.md/protocol'
import { AgentId } from '../domain/ids.js'
import type { SessionUsageRepo, UsageSource } from '../persistence/ports.js'

export type { UsageSource }

/** One session's cumulative usage snapshot as REPORTED — the shared wire payload. */
export interface SessionUsageReport {
  sessionId: string // ACP session id (agent-assigned; NOT a wire UUID)
  agentId: string
  platform?: string
  channel?: string
  /** Model observed for the delta ending at this snapshot; null ⇒ runtime default. */
  observedModel?: string | null
  lastActivityAt: string // ISO 8601
  usage: {
    totalTokens?: number
    inputTokens?: number
    outputTokens?: number
    thoughtTokens?: number
    cachedReadTokens?: number
    cachedWriteTokens?: number
    contextUsed?: number
    contextSize?: number
    costAmount?: number | DecimalAmount
    costCurrency?: string
  }
}

/** The same report with its cost normalized — what an adapter hands the writer. */
export type NormalizedSessionUsageReport = Omit<SessionUsageReport, 'usage'> & {
  usage: Omit<SessionUsageReport['usage'], 'costAmount'> & { costAmount?: DecimalAmount }
}

/**
 * Normalize a reported cost to the canonical decimal string.
 *
 * An unusable amount (negative, non-finite, out of the column's range, or a malformed
 * string) drops the cost and KEEPS the token counts: cost is best-effort telemetry on
 * the daemon path, and losing a session's token history over a bad price is worse than
 * losing the price. The gateway path does not use this leniency — it refuses the batch.
 */
export function normalizeUsageReport(report: SessionUsageReport): NormalizedSessionUsageReport {
  const { costAmount, ...rest } = report.usage
  const normalized = costAmount === undefined ? undefined : (normalizeReportedCostAmount(costAmount) ?? undefined)
  return { ...report, usage: { ...rest, ...(normalized !== undefined ? { costAmount: normalized } : {}) } }
}

export interface UsageWriter {
  record(source: UsageSource, report: NormalizedSessionUsageReport): Promise<void>
  recordBatch(source: UsageSource, reports: readonly NormalizedSessionUsageReport[]): Promise<void>
}

/** The `UsageWriter` over the CP's own usage store. */
export class SessionUsageWriter implements UsageWriter {
  constructor(private readonly usage: SessionUsageRepo) {}

  async record(source: UsageSource, report: NormalizedSessionUsageReport): Promise<void> {
    await this.usage.record({
      sessionId: report.sessionId,
      agentId: AgentId(report.agentId),
      platform: report.platform ?? null,
      channel: report.channel ?? null,
      ...(report.observedModel !== undefined ? { model: report.observedModel } : {}),
      source,
      lastActivityAt: new Date(report.lastActivityAt),
      usage: report.usage
    })
  }

  /** Sequential on purpose: one batch is one upstream's ordered view of its sessions,
   *  and writing serially keeps a large batch from monopolizing the connection pool.
   *  Each write is independently idempotent, so a caller that retries the whole batch
   *  after a mid-batch failure re-applies the landed prefix harmlessly. */
  async recordBatch(source: UsageSource, reports: readonly NormalizedSessionUsageReport[]): Promise<void> {
    for (const report of reports) await this.record(source, report)
  }
}
