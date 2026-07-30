/**
 * Durable ownership metadata for browser webchat conversations. This table
 * stores no transcript or message content; the daemon remains the content
 * authority. The CP uses it only to authorize token minting for a resume.
 */
import type { PrismaLike } from '../prisma.js'
import type { WebchatConversationBinding, WebchatConversationRepo } from '../ports.js'
import type { AgentId } from '../../domain/ids.js'

export class PgWebchatConversationRepo implements WebchatConversationRepo {
  constructor(private readonly db: PrismaLike) {}

  async create(binding: WebchatConversationBinding): Promise<void> {
    await this.db.webchatConversation.create({
      data: {
        id: binding.conversationId,
        orgId: binding.orgId,
        agentId: binding.agentId,
        userId: binding.userId
      }
    })
  }

  async findOwner(conversationId: string, agentId: AgentId): Promise<string | null> {
    const row = await this.db.webchatConversation.findFirst({
      where: { id: conversationId, agentId },
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
}
