// PgComputerAuditRepo — the `computer_audit` rows a desktop daemon reports (computer-use.md §8.2).
import type { ComputerAudit } from '../../generated/prisma/client.js'
import type { PrismaLike } from '../prisma.js'
import type { ComputerAuditQuery, ComputerAuditRecord, ComputerAuditRepo } from '../ports.js'
import { ComputerId, type OrgId } from '../../domain/ids.js'
import { COMPUTER_APPROVAL_RESULTS, type ComputerApprovalResult } from '@agentconnect.md/protocol'

const approvalOf = (value: string | null): ComputerApprovalResult | null =>
  (COMPUTER_APPROVAL_RESULTS as readonly string[]).includes(value ?? '') ? (value as ComputerApprovalResult) : null

function toRecord(row: ComputerAudit): ComputerAuditRecord {
  const args = row.args
  return {
    id: row.id,
    computerId: ComputerId(row.computerId),
    at: row.at,
    tool: row.tool,
    client: row.client,
    agentId: row.agentId,
    sessionId: row.sessionId,
    outcome: row.outcome === 'ok' ? 'ok' : 'error',
    code: row.code,
    approval: approvalOf(row.approval),
    args: args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {},
    textLength: row.textLength,
    ms: row.ms,
    screenshotRef: row.screenshotRef
  }
}

export class PgComputerAuditRepo implements ComputerAuditRepo {
  constructor(private readonly db: PrismaLike) {}

  async append(
    orgId: OrgId,
    computerId: ComputerId,
    entries: Omit<ComputerAuditRecord, 'computerId'>[],
    keepAfter: Date
  ): Promise<number> {
    const { count } = await this.db.computerAudit.createMany({
      data: entries.map((entry) => ({
        computerId,
        orgId,
        id: entry.id,
        at: entry.at,
        tool: entry.tool,
        client: entry.client,
        agentId: entry.agentId,
        sessionId: entry.sessionId,
        outcome: entry.outcome,
        code: entry.code,
        approval: entry.approval,
        args: entry.args as object,
        textLength: entry.textLength,
        ms: entry.ms,
        screenshotRef: entry.screenshotRef
      })),
      skipDuplicates: true
    })
    await this.db.computerAudit.deleteMany({ where: { computerId, at: { lt: keepAfter } } })
    return count
  }

  async list(orgId: OrgId, computerId: ComputerId, query: ComputerAuditQuery): Promise<ComputerAuditRecord[]> {
    const before = query.before
    const rows = await this.db.computerAudit.findMany({
      where: {
        computerId,
        orgId,
        ...(query.agentId ? { agentId: query.agentId } : {}),
        ...(query.sessionId ? { sessionId: query.sessionId } : {}),
        ...(before ? { OR: [{ at: { lt: before.at } }, { at: before.at, id: { lt: before.id } }] } : {})
      },
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
      take: query.limit
    })
    return rows.map(toRecord)
  }
}
