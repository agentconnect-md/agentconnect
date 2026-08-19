/**
 * Durable ownership metadata for browser webchat conversations. This table
 * stores no transcript or message content; the daemon remains the content
 * authority. The CP uses it only to authorize token minting for a resume and
 * to resolve the conversation's participant roster (webchat-multi-agents.md
 * §3.1 — the roster is fixed at creation; `webchat_conversation.agentId`
 * mirrors the `role='primary'` participant row).
 */
import { randomUUID } from 'node:crypto'
import type { PrismaClient, Prisma } from '../../generated/prisma/client.js'
import type { PrismaLike } from '../prisma.js'
import type {
  WebchatConversationBinding,
  WebchatConversationRepo,
  WebchatParticipant,
  WebchatResumeBinding
} from '../ports.js'
import { AgentId, SessionId, type OrgId } from '../../domain/ids.js'

/** CP-minted webchat conversation ids are UUIDs. Daemon-local A2A children can
 * retain `platform: webchat` while using an `a2a:<caller>` channel; repository
 * reads must treat that synthetic coordinate as a miss instead of handing it to
 * a UUID-backed Prisma column. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

  async participants(orgId: OrgId, conversationId: string): Promise<WebchatParticipant[]> {
    if (!UUID_RE.test(conversationId)) return []
    // Roster rows carry no org of their own, so the fence rides the relational
    // filter on the owning conversation (org-scoped-data-layer.md §3.6): a
    // cross-org id yields the same empty roster as an unknown one, and every
    // caller already fails closed on empty.
    const rows = await this.db.webchatConversationAgent.findMany({
      where: { conversationId, conversation: { orgId } },
      orderBy: { ord: 'asc' },
      select: { agentId: true, role: true }
    })
    return rows.map((r) => ({ agentId: AgentId(r.agentId), role: r.role === 'primary' ? 'primary' : 'member' }))
  }

  async addParticipant(orgId: OrgId, conversationId: string, agentId: AgentId, addedByUserId: string): Promise<void> {
    await this.inTx(async (tx) => {
      // Org fence on the conversation itself, inside the same transaction as the
      // roster insert: a cross-org id adds nothing (§3.6).
      const conversation = await tx.webchatConversation.findFirst({
        where: { id: conversationId, orgId },
        select: { id: true }
      })
      if (!conversation) return
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
    if (!UUID_RE.test(conversationId)) return null
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

  async resumeBinding(conversationId: string, orgId: OrgId): Promise<WebchatResumeBinding | null> {
    if (!UUID_RE.test(conversationId)) return null
    const row = await this.db.webchatConversation.findFirst({
      where: { id: conversationId, orgId },
      select: {
        agentId: true,
        userId: true,
        currentSessionId: true,
        participants: { select: { currentSessionId: true } }
      }
    })
    if (!row) return null
    // One slot per roster participant, null where that participant has not materialized a session
    // yet (a partial roster is a normal state); the conversation's own pointer only on a pre-roster row.
    const currentSessionIds =
      row.participants.length > 0
        ? row.participants.map((p) => (p.currentSessionId === null ? null : SessionId(p.currentSessionId)))
        : [row.currentSessionId === null ? null : SessionId(row.currentSessionId)]
    return { primaryAgentId: AgentId(row.agentId), ownerUserId: row.userId, currentSessionIds }
  }

  async ownedBy(conversationId: string, orgId: OrgId, userId: string): Promise<{ primaryAgentId: AgentId } | null> {
    const row = await this.db.webchatConversation.findFirst({
      where: { id: conversationId, orgId, userId },
      select: { agentId: true }
    })
    return row ? { primaryAgentId: AgentId(row.agentId) } : null
  }

  async upsertSessionTargeted(
    binding: Omit<WebchatConversationBinding, 'conversationId'>,
    targetSessionId: string
  ): Promise<{ conversationId: string }> {
    const existing = await this.db.webchatConversation.findFirst({
      where: { userId: binding.userId, targetSessionId, orgId: binding.orgId, agentId: binding.agentId },
      select: { id: true }
    })
    if (existing) return { conversationId: existing.id }
    const conversationId = randomUUID()
    try {
      await this.inTx(async (tx) => {
        await tx.webchatConversation.create({
          data: {
            id: conversationId,
            orgId: binding.orgId,
            agentId: binding.agentId,
            userId: binding.userId,
            targetSessionId,
            // The adoption IS the current-session fence — installed atomically
            // at creation, not by a later milestone.
            currentSessionId: targetSessionId
          }
        })
        await tx.webchatConversationAgent.create({
          data: {
            conversationId,
            agentId: binding.agentId,
            role: 'primary',
            ord: 0,
            addedByUserId: binding.userId,
            currentSessionId: targetSessionId
          }
        })
      })
    } catch (err) {
      // A concurrent mint won the (userId, targetSessionId) unique — converge on its row.
      const raced = await this.db.webchatConversation.findFirst({
        where: { userId: binding.userId, targetSessionId, orgId: binding.orgId, agentId: binding.agentId },
        select: { id: true }
      })
      if (raced) return { conversationId: raced.id }
      throw err
    }
    return { conversationId }
  }

  async target(conversationId: string): Promise<{ targetSessionId: string | null } | null> {
    if (!UUID_RE.test(conversationId)) return null
    const row = await this.db.webchatConversation.findUnique({
      where: { id: conversationId },
      select: { targetSessionId: true }
    })
    return row ? { targetSessionId: row.targetSessionId } : null
  }
}
