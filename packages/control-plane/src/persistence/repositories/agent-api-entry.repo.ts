/** The chat APIs each agent accepts calls on (shared-bot-relay.md §10.4); the relay refuses any protocol without a row. */
import type { AgentApiProtocol } from '@agentconnect.md/protocol'
import type { AgentApiProtocol as DbAgentApiProtocol } from '../../generated/prisma/client.js'
import type { PrismaLike } from '../prisma.js'
import type { AgentApiEntryRecord, AgentApiEntryRepo } from '../ports.js'
import { AgentId } from '../../domain/ids.js'

// The wire names carry a hyphen Prisma enum members cannot.
const toDb = (protocol: AgentApiProtocol): DbAgentApiProtocol => {
  switch (protocol) {
    case 'ai-sdk-ui':
      return 'ai_sdk_ui'
  }
}
const fromDb = (protocol: DbAgentApiProtocol): AgentApiProtocol => {
  switch (protocol) {
    case 'ai_sdk_ui':
      return 'ai-sdk-ui'
  }
}

interface Row {
  agentId: string
  protocol: DbAgentApiProtocol
  createdByUserId: string | null
  createdAt: Date
}

const toRecord = (row: Row): AgentApiEntryRecord => ({
  agentId: AgentId(row.agentId),
  protocol: fromDb(row.protocol),
  createdByUserId: row.createdByUserId,
  createdAt: row.createdAt
})

export class PgAgentApiEntryRepo implements AgentApiEntryRepo {
  constructor(private readonly db: PrismaLike) {}

  async listForAgent(agentId: AgentId): Promise<AgentApiEntryRecord[]> {
    const rows = await this.db.agentApiEntry.findMany({ where: { agentId }, orderBy: { createdAt: 'asc' } })
    return rows.map(toRecord)
  }

  async enable(
    agentId: AgentId,
    protocol: AgentApiProtocol,
    createdByUserId: string | null
  ): Promise<{ entry: AgentApiEntryRecord; created: boolean }> {
    const where = { agentId_protocol: { agentId, protocol: toDb(protocol) } }
    const existing = await this.db.agentApiEntry.findUnique({ where })
    if (existing) return { entry: toRecord(existing), created: false }
    // A concurrent enable of the same pair lands on the update arm, which changes nothing.
    const row = await this.db.agentApiEntry.upsert({
      where,
      create: { agentId, protocol: toDb(protocol), createdByUserId },
      update: {}
    })
    return { entry: toRecord(row), created: true }
  }

  async disable(agentId: AgentId, protocol: AgentApiProtocol): Promise<boolean> {
    const { count } = await this.db.agentApiEntry.deleteMany({
      where: { agentId, protocol: toDb(protocol) }
    })
    return count > 0
  }
}
