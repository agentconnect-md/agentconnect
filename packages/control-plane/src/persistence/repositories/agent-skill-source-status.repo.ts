// Daemon-reported skill Source failure codes per agent (source-cache.md §11): a code and a time, never Git or CLI output.
import type { SkillSourceFailureCode } from '@agentconnect.md/protocol'
import type { AgentId } from '../../domain/ids.js'
import type { PrismaClient } from '../../generated/prisma/client.js'
import type { AgentSkillSourceStatusRecord, AgentSkillSourceStatusRepo } from '../ports.js'

export class PgAgentSkillSourceStatusRepo implements AgentSkillSourceStatusRepo {
  constructor(private readonly prisma: PrismaClient) {}

  async replace(
    agentId: AgentId,
    failed: Array<{ sourceName: string; code: SkillSourceFailureCode }>,
    reportedAt: Date
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.agentSkillSourceStatus.deleteMany({
        where: { agentId, sourceName: { notIn: failed.map((entry) => entry.sourceName) } }
      }),
      ...failed.map((entry) =>
        this.prisma.agentSkillSourceStatus.upsert({
          where: { agentId_sourceName: { agentId, sourceName: entry.sourceName } },
          create: { agentId, sourceName: entry.sourceName, code: entry.code, reportedAt },
          update: { code: entry.code, reportedAt }
        })
      )
    ])
  }

  async list(agentId: AgentId): Promise<AgentSkillSourceStatusRecord[]> {
    const rows = await this.prisma.agentSkillSourceStatus.findMany({
      where: { agentId },
      orderBy: { sourceName: 'asc' }
    })
    return rows.map((row) => ({
      sourceName: row.sourceName,
      code: row.code as SkillSourceFailureCode,
      reportedAt: row.reportedAt
    }))
  }
}
