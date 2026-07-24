/**
 * Durable ownership metadata for browser webchat conversations. This table
 * stores no transcript or message content; the daemon remains the content
 * authority. The CP uses it only to authorize token minting for a resume.
 */
import type { PrismaLike } from '../prisma.js'
import type { WebchatConversationBinding, WebchatConversationRepo } from '../ports.js'

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
