import {
  DecisionDraft,
  DecisionToolDefinition,
  type DecisionListRequest,
  type DecisionDefinition,
  type DecisionDraftInput
} from '@agentconnect.md/protocol'
import { canEdit, visibilityWhere } from '../../authorization/policy.js'
import type { OrgId } from '../../domain/ids.js'
import { Prisma, type Decision } from '../../generated/prisma/client.js'
import { OrgMembershipMissing, ResourceAudienceEmpty } from '../errors.js'
import type { DecisionRepo, ViewCtx } from '../ports.js'
import { withAmbientTx, type PrismaLike } from '../prisma.js'
import { lockResourceWriteMemberships } from '../resource-membership-lock.js'
import { DecisionInUse } from '../decision-binding-fence.js'

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
  ): Promise<DecisionDefinition | null> {
    return withAmbientTx(this.db, async (tx) => {
      const audience = await lockResourceWriteMemberships(tx, {
        orgId,
        visibility: 'org',
        actorUserId: actor.userId,
        sharedWith: input.sharedWith
      })
      await tx.$queryRaw`SELECT "id" FROM "decision" WHERE "orgId" = ${orgId} AND "id" = ${id}::uuid FOR UPDATE`
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
      return definition(
        await tx.decision.update({
          where: { id, orgId },
          data: {
            ...draft,
            question: draft.question as Prisma.InputJsonValue
          }
        })
      )
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
      if (await tx.agent.count({ where: { orgId, runtimeOverrides: { path: ['decisionIds'], array_contains: [id] } } }))
        throw new DecisionInUse()
      await tx.decision.deleteMany({ where: { id, orgId, ...visibilityWhere({ ...actor, role: membership.role }) } })
    })
  }
}
