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
 */
import { AgentId } from '../domain/ids.js'
import type { SessionUsageRepo, UsageSource } from '../persistence/ports.js'

export type { UsageSource }

/** One session's cumulative usage snapshot, shared by both ingress adapters. */
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
    costAmount?: number
    costCurrency?: string
  }
}

export interface UsageWriter {
  record(source: UsageSource, report: SessionUsageReport): Promise<void>
  recordBatch(source: UsageSource, reports: readonly SessionUsageReport[]): Promise<void>
}

/** The `UsageWriter` over the CP's own usage store. */
export class SessionUsageWriter implements UsageWriter {
  constructor(private readonly usage: SessionUsageRepo) {}

  async record(source: UsageSource, report: SessionUsageReport): Promise<void> {
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
  async recordBatch(source: UsageSource, reports: readonly SessionUsageReport[]): Promise<void> {
    for (const report of reports) await this.record(source, report)
  }
}
