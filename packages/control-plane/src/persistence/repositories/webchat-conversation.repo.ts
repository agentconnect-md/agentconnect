/**
 * Durable ownership metadata for browser webchat conversations. This table
 * stores no transcript or message content; the daemon remains the content
 * authority. The CP uses it only to authorize token minting for a resume and
 * to resolve the conversation's participant roster (webchat-multi-agents.md
 * §3.1 — the roster is fixed at creation; `webchat_conversation.agentId`
 * mirrors the `role='primary'` participant row).
 */
import type { PrismaClient, Prisma } from '../../generated/prisma/client.js'
import type { PrismaLike } from '../prisma.js'
import type { WebchatConversationBinding, WebchatConversationRepo, WebchatParticipant } from '../ports.js'
import { AgentId, type OrgId } from '../../domain/ids.js'

export class PgWebchatConversationRepo implements WebchatConversationRepo {
  constructor(private readonly db: PrismaLike) {}

  private inTx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    if ('$transaction' in this.db) return (this.db as PrismaClient).$transaction(fn)
    return fn(this.db as Prisma.TransactionClient)
  }

  async create(binding: WebchatConversationBinding, memberAgentIds: AgentId[] = []): Promise<void> {
    await this.inTx(async (tx) => {
      await tx.webchatConversation.create({
        data: {
          id: binding.conversationId,
          orgId: binding.orgId,
          agentId: binding.agentId,
          userId: binding.userId
        }
      })
      await tx.webchatConversationAgent.createMany({
        data: [
          {
            conversationId: binding.conversationId,
            agentId: binding.agentId,
            role: 'primary',
            ord: 0,
            addedByUserId: binding.userId
          },
          ...memberAgentIds.map((agentId, i) => ({
            conversationId: binding.conversationId,
            agentId,
            role: 'member',
            ord: i + 1,
            addedByUserId: binding.userId
          }))
        ]
      })
    })
  }

  async participants(conversationId: string): Promise<WebchatParticipant[]> {
    const rows = await this.db.webchatConversationAgent.findMany({
      where: { conversationId },
      orderBy: { ord: 'asc' },
      select: { agentId: true, role: true }
    })
    return rows.map((r) => ({ agentId: AgentId(r.agentId), role: r.role === 'primary' ? 'primary' : 'member' }))
  }

  async addParticipant(conversationId: string, agentId: AgentId, addedByUserId: string): Promise<void> {
    await this.inTx(async (tx) => {
      const last = await tx.webchatConversationAgent.aggregate({
        where: { conversationId },
        _max: { ord: true }
      })
      await tx.webchatConversationAgent.createMany({
        data: [
          {
            conversationId,
            agentId,
            role: 'member',
            ord: (last._max.ord ?? 0) + 1,
            addedByUserId
          }
        ],
        skipDuplicates: true
      })
    })
  }

  async findOwner(conversationId: string, agentId: AgentId): Promise<string | null> {
    const row = await this.db.webchatConversation.findFirst({
      where: {
        id: conversationId,
        OR: [{ agentId }, { participants: { some: { agentId } } }]
      },
      select: { userId: true }
    })
    return row?.userId ?? null
  }

  async owns(binding: WebchatConversationBinding): Promise<boolean> {
    const row = await this.db.webchatConversation.findFirst({
      where: {
        id: binding.conversationId,
        orgId: binding.orgId,
        agentId: binding.agentId,
        userId: binding.userId
      },
      select: { id: true }
    })
    return row !== null
  }

  async ownedBy(conversationId: string, orgId: OrgId, userId: string): Promise<{ primaryAgentId: AgentId } | null> {
    const row = await this.db.webchatConversation.findFirst({
      where: { id: conversationId, orgId, userId },
      select: { agentId: true }
    })
    return row ? { primaryAgentId: AgentId(row.agentId) } : null
  }
}
