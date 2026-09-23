import {
  ChannelDecisionGate,
  DecisionDraft,
  DecisionQuestion,
  DecisionToolDefinition,
  decisionConditionNeedsReview,
  type DecisionListRequest,
  type DecisionDefinition,
  type DecisionDraftInput
} from '@agentconnect.md/protocol'
import { canEdit, visibilityWhere } from '../../authorization/policy.js'
import { IntegrationId, type OrgId } from '../../domain/ids.js'
import { Prisma, type Decision } from '../../generated/prisma/client.js'
import { DecisionInUse, OrgMembershipMissing, ResourceAudienceEmpty } from '../errors.js'
import type { DecisionRepo, ViewCtx } from '../ports.js'
import { withAmbientTx, type PrismaLike } from '../prisma.js'
import { lockResourceWriteMemberships } from '../resource-membership-lock.js'

const toolSelect = { id: true, name: true, providerId: true, model: true, question: true } as const

function definition(row: Decision): DecisionDefinition {
  return {
    ...DecisionDraft.parse({
      name: row.name,
      providerId: row.providerId,
      model: row.model,
      question: row.question,
      visibility: row.visibility,
      sharedWith: row.sharedWith
    }),
    id: row.id,
    orgId: row.orgId,
    createdBy: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  }
}

export class PgDecisionRepo implements DecisionRepo {
  constructor(private readonly db: PrismaLike) {}

  // The caller supplies the agent's authorized bindings, independently of Console visibility.
  async listForAgent(
    orgId: OrgId,
    decisionIds: readonly string[],
    input: Omit<DecisionListRequest, 'requesterAgentId'>
  ): Promise<DecisionToolDefinition[]> {
    const rows = await this.db.decision.findMany({
      where: {
        orgId,
        id: { in: [...decisionIds], ...(input.cursor ? { gt: input.cursor } : {}) },
        ...(input.query ? { name: { contains: input.query, mode: 'insensitive' as const } } : {})
      },
      select: toolSelect,
      orderBy: { id: 'asc' },
      take: input.limit + 1
    })
    return rows.map((row) => DecisionToolDefinition.parse(row))
  }

  async getForAgent(orgId: OrgId, id: string): Promise<DecisionToolDefinition | null> {
    const row = await this.db.decision.findFirst({ where: { id, orgId }, select: toolSelect })
    return row ? DecisionToolDefinition.parse(row) : null
  }

  async list(orgId: OrgId, viewer: ViewCtx): Promise<DecisionDefinition[]> {
    return (
      await this.db.decision.findMany({
        where: { orgId, ...visibilityWhere(viewer) },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }]
      })
    ).map(definition)
  }

  async get(orgId: OrgId, id: string): Promise<DecisionDefinition | null> {
    const row = await this.db.decision.findUnique({ where: { id, orgId } })
    return row ? definition(row) : null
  }

  async create(orgId: OrgId, draft: DecisionDraft, actor: ViewCtx): Promise<DecisionDefinition> {
    return withAmbientTx(this.db, async (tx) => {
      const audience = await lockResourceWriteMemberships(tx, { orgId, ...draft, actorUserId: actor.userId })
      const membership = await tx.membership.findUnique({ where: { orgId_userId: { orgId, userId: actor.userId } } })
      if (!membership || membership.role === 'viewer') throw new OrgMembershipMissing()
      return definition(
        await tx.decision.create({
          data: {
            ...draft,
            sharedWith: audience.sharedWith,
            question: draft.question as Prisma.InputJsonValue,
            orgId,
            createdByUserId: actor.userId
          }
        })
      )
    })
  }

  async update(
    orgId: OrgId,
    id: string,
    input: DecisionDraftInput,
    actor: ViewCtx
  ): Promise<{ decision: DecisionDefinition; consumerIntegrationIds: IntegrationId[] } | null> {
    return withAmbientTx(this.db, async (tx) => {
      const audience = await lockResourceWriteMemberships(tx, {
        orgId,
        visibility: 'org',
        actorUserId: actor.userId,
        sharedWith: input.sharedWith
      })
      // NO KEY UPDATE: FOR UPDATE would conflict with the KEY SHARE lock a concurrent gate write takes on the FK.
      await tx.$queryRaw`SELECT "id" FROM "decision" WHERE "orgId" = ${orgId} AND "id" = ${id}::uuid FOR NO KEY UPDATE`
      const existing = await tx.decision.findUnique({ where: { id, orgId } })
      if (!existing) return null
      const membership = await tx.membership.findUnique({ where: { orgId_userId: { orgId, userId: actor.userId } } })
      if (!membership || !canEdit(existing, { userId: actor.userId, role: membership.role }))
        throw new OrgMembershipMissing()
      const next = {
        ...input,
        visibility: input.visibility ?? existing.visibility,
        sharedWith: audience.sharedWith ?? existing.sharedWith
      }
      if (next.visibility === 'restricted' && next.sharedWith.length === 0) throw new ResourceAudienceEmpty()
      const draft = DecisionDraft.parse(next)
      const decision = definition(
        await tx.decision.update({
          where: { id, orgId },
          data: {
            ...draft,
            question: draft.question as Prisma.InputJsonValue
          }
        })
      )
      // Revalidate every gate: an incompatible one stays saved but is marked Needs review (decisions.md §6.1).
      const consumers = await tx.integrationChannel.findMany({
        where: { decisionId: id },
        select: { integrationId: true, channelId: true, decisionBinding: true, decisionNeedsReview: true }
      })
      const previous = DecisionQuestion.safeParse(existing.question)
      const review = consumers.filter((c) => {
        if (c.decisionNeedsReview) return false
        const gate = ChannelDecisionGate.safeParse(c.decisionBinding)
        if (!gate.success || !previous.success) return true
        return decisionConditionNeedsReview(previous.data, draft.question, gate.data.when)
      })
      if (review.length > 0)
        await tx.integrationChannel.updateMany({
          where: { OR: review.map((c) => ({ integrationId: c.integrationId, channelId: c.channelId })) },
          data: { decisionNeedsReview: true }
        })
      return {
        decision,
        consumerIntegrationIds: [...new Set(consumers.map((c) => c.integrationId))].map(IntegrationId)
      }
    })
  }

  async delete(orgId: OrgId, id: string, actor: ViewCtx): Promise<void> {
    await withAmbientTx(this.db, async (tx) => {
      await lockResourceWriteMemberships(tx, { orgId, visibility: 'org', actorUserId: actor.userId })
      const membership = await tx.membership.findUnique({ where: { orgId_userId: { orgId, userId: actor.userId } } })
      if (!membership || membership.role === 'viewer') throw new OrgMembershipMissing()
      await tx.$queryRaw`SELECT "id" FROM "decision" WHERE "orgId" = ${orgId} AND "id" = ${id}::uuid FOR UPDATE`
      const visible = await tx.decision.findFirst({
        where: { id, orgId, ...visibilityWhere({ ...actor, role: membership.role }) }
      })
      if (!visible) return
      if (
        await tx.agent.count({
          where: {
            orgId,
            OR: [
              { runtimeOverrides: { path: ['decisionIds'], array_contains: [id] } },
              { runtimeOverrides: { path: ['modelSelection', 'decisionId'], equals: id } }
            ]
          }
        })
      )
        throw new DecisionInUse(id)
      try {
        await tx.decision.deleteMany({ where: { id, orgId, ...visibilityWhere({ ...actor, role: membership.role }) } })
      } catch (err) {
        // The channel gate FK refuses a Decision a conversation still references.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') throw new DecisionInUse(id)
        throw err
      }
    })
  }
}
