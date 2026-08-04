/**
 * `PgThreadAffinityStore` (slack-http-mode §10) — the durable per-sessionKey
 * thread-affinity table for http-transport shared bots.
 *
 * A relay reports (botId, sessionKey)→{agentId, daemonId} the first time it routes
 * a thread (rc/thread-assign); the CP persists it here (single writer) and
 * broadcasts it to every relay (rc/assign), and answers a pull-on-miss lookup
 * (rc/thread-lookup). Relay-opaque `sessionKey`; no FKs — daemon/agent may churn.
 */
import type { PrismaLike } from '../prisma.js'
import type { ThreadAffinityStore } from '../ports.js'
import { AgentId, BotId, DaemonId } from '../../domain/ids.js'

export class PgThreadAffinityStore implements ThreadAffinityStore {
  constructor(private readonly db: PrismaLike) {}

  async upsert(botId: BotId, sessionKey: string, agentId: AgentId, daemonId: DaemonId): Promise<void> {
    await this.db.sharedThreadAgent.upsert({
      where: { botId_sessionKey: { botId, sessionKey } },
      create: { botId, sessionKey, agentId, daemonId },
      update: { agentId, daemonId }
    })
  }

  async get(botId: BotId, sessionKey: string): Promise<{ agentId: AgentId; daemonId: DaemonId } | null> {
    const row = await this.db.sharedThreadAgent.findUnique({ where: { botId_sessionKey: { botId, sessionKey } } })
    return row ? { agentId: AgentId(row.agentId), daemonId: DaemonId(row.daemonId) } : null
  }

  async listForBot(botId: BotId): Promise<{ sessionKey: string; agentId: AgentId; daemonId: DaemonId }[]> {
    const rows = await this.db.sharedThreadAgent.findMany({ where: { botId }, orderBy: { updatedAt: 'asc' } })
    return rows.map((r) => ({ sessionKey: r.sessionKey, agentId: AgentId(r.agentId), daemonId: DaemonId(r.daemonId) }))
  }

  async upsertParticipant(botId: BotId, sessionKey: string, agentId: AgentId, daemonId: DaemonId): Promise<void> {
    await this.db.sharedThreadParticipant.upsert({
      where: { botId_sessionKey_agentId: { botId, sessionKey, agentId } },
      create: { botId, sessionKey, agentId, daemonId },
      update: { daemonId }
    })
  }

  async participants(botId: BotId, sessionKey: string): Promise<Array<{ agentId: AgentId; daemonId: DaemonId }>> {
    const rows = await this.db.sharedThreadParticipant.findMany({ where: { botId, sessionKey } })
    return rows.map((r) => ({ agentId: AgentId(r.agentId), daemonId: DaemonId(r.daemonId) }))
  }

  async participantsForBot(botId: BotId): Promise<Array<{ sessionKey: string; agentId: AgentId; daemonId: DaemonId }>> {
    const rows = await this.db.sharedThreadParticipant.findMany({ where: { botId }, orderBy: { updatedAt: 'asc' } })
    return rows.map((r) => ({ sessionKey: r.sessionKey, agentId: AgentId(r.agentId), daemonId: DaemonId(r.daemonId) }))
  }
}
