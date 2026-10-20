// Computer use audit (computer-use.md §8.2): stores what desktop daemons report and answers the owner's per-Computer query.
import { computerAuditArgs, type ComputerAuditEntry } from '@agentconnect.md/protocol'
import type { Clock } from '../domain/clock.js'
import { ComputerId, OrgId } from '../domain/ids.js'
import type { ComputerAuditQuery, ComputerAuditRecord, ComputerAuditRepo } from '../persistence/ports.js'

/** How long audit entries are kept; older ones are dropped as new ones arrive. */
export const COMPUTER_AUDIT_RETENTION_MS = 90 * 24 * 60 * 60_000

export class ComputerAuditLog {
  constructor(
    private readonly repo: ComputerAuditRepo,
    private readonly clock: Clock,
    private readonly retentionMs = COMPUTER_AUDIT_RETENTION_MS
  ) {}

  /** Store one desktop's batch; arguments are summarized again here, so no typed text is stored whatever the desktop sent. */
  async record(orgId: string, computerId: string, entries: ComputerAuditEntry[]): Promise<number> {
    const rows = entries.map((entry) => {
      const summary = computerAuditArgs(entry.args ?? {})
      const textLength = (entry.textLength ?? 0) + (summary.textLength ?? 0)
      return {
        id: entry.id,
        at: new Date(entry.at),
        tool: entry.tool,
        client: entry.client,
        agentId: entry.agentId ?? null,
        sessionId: entry.sessionId ?? null,
        outcome: entry.outcome,
        code: entry.code ?? null,
        approval: entry.approval ?? null,
        args: summary.args,
        textLength: entry.textLength !== undefined || summary.textLength !== undefined ? textLength : null,
        ms: entry.ms,
        screenshotRef: entry.screenshotRef ?? null
      }
    })
    const keepAfter = new Date(this.clock.now() - this.retentionMs)
    return this.repo.append(OrgId(orgId), ComputerId(computerId), rows, keepAfter)
  }

  list(orgId: OrgId, computerId: ComputerId, query: ComputerAuditQuery): Promise<ComputerAuditRecord[]> {
    return this.repo.list(orgId, computerId, query)
  }
}
