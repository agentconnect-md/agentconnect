import {
  ChannelDecisionBinding,
  DecisionBundleDefinition,
  SharedBotDecisionRouting,
  decisionChainIds,
  decisionRoutingAgentIds
} from '@agentconnect.md/protocol'
import { AgentId, BotId, OrgId } from '../../domain/ids.js'
import { Prisma, type BotDecisionRouting, type Decision } from '../../generated/prisma/client.js'
import { BotMissing, RoutingChannelInvalid, RoutingScopeChanged } from '../errors.js'
import type {
  BotDecisionRoutingRecord,
  BotDecisionRoutingRemoval,
  BotDecisionRoutingRepo,
  BotDecisionRoutingUsage,
  ViewCtx
} from '../ports.js'
import { withAmbientTx, type PrismaLike } from '../prisma.js'
import { enterDecisionBindingFence } from '../decision-binding-fence.js'

const ROUTER_BINDING = { type: 'shared_bot_routing' } as const

function definitionOf(d: Decision | null | undefined): DecisionBundleDefinition | null {
  if (!d) return null
  const parsed = DecisionBundleDefinition.safeParse({
    id: d.id,
    orgId: d.orgId,
    name: d.name,
    providerId: d.providerId,
    model: d.model,
    question: d.question
  })
  return parsed.success ? parsed.data : null
}

// Fail closed: a stored config that no longer parses reads as no router, which the compile holds.
function toRecord(row: BotDecisionRouting & { decision?: Decision | null }): BotDecisionRoutingRecord | null {
  const config = SharedBotDecisionRouting.safeParse({
    enabled: row.enabled,
    decisionId: row.decisionId,
    rules: row.rules,
    otherwise: row.otherwise,
    ...(Array.isArray(row.steps) && row.steps.length ? { steps: row.steps } : {})
  })
  if (!config.success) return null
  return {
    botId: BotId(row.botId),
    orgId: OrgId(row.orgId),
    config: config.data,
    needsReview: row.needsReview,
    updatedAt: row.updatedAt,
    definition: definitionOf(row.decision)
  }
}

async function routingRecord(
  db: PrismaLike,
  row: Parameters<typeof toRecord>[0]
): Promise<BotDecisionRoutingRecord | null> {
  const record = toRecord(row)
  if (!record?.config.steps?.length) return record
  const definitions = await db.decision.findMany({
    where: { orgId: row.orgId, id: { in: decisionChainIds(record.config) } }
  })
  return {
    ...record,
    definitions: definitions.flatMap((row) => {
      const d = definitionOf(row)
      return d ? [d] : []
    })
  }
}

const isRouted = (binding: unknown): boolean => {
  const parsed = ChannelDecisionBinding.safeParse(binding)
  return parsed.success && parsed.data.type === 'shared_bot_routing'
}

export class PgBotDecisionRoutingRepo implements BotDecisionRoutingRepo {
  constructor(private readonly db: PrismaLike) {}

  async get(orgId: OrgId, botId: BotId): Promise<BotDecisionRoutingRecord | null> {
    const row = await this.db.botDecisionRouting.findFirst({ where: { botId, orgId }, include: { decision: true } })
    return row ? routingRecord(this.db, row) : null
  }

  async getUnscoped(botId: BotId): Promise<BotDecisionRoutingRecord | null> {
    const row = await this.db.botDecisionRouting.findUnique({ where: { botId }, include: { decision: true } })
    return row ? routingRecord(this.db, row) : null
  }

  async save(
    orgId: OrgId,
    botId: BotId,
    input: {
      config: SharedBotDecisionRouting
      channelIds: readonly string[]
      removals: readonly BotDecisionRoutingRemoval[]
    },
    actor: ViewCtx
  ): Promise<BotDecisionRoutingRecord> {
    return withAmbientTx(this.db, async (tx) => {
      const authorize = await enterDecisionBindingFence(tx, orgId, decisionChainIds(input.config), actor.userId)
      authorize([])
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "bot" WHERE "id" = ${botId}::uuid AND "orgId" = ${orgId} FOR UPDATE`
      if (locked.length === 0) throw new BotMissing(botId)
      await tx.$queryRaw`
        SELECT ic."integrationId" FROM "integration_channel" ic
        JOIN "integration" i ON i."id" = ic."integrationId"
        WHERE i."botId" = ${botId}::uuid AND i."status" = 'active'
        FOR UPDATE OF ic`
      const rows = await tx.integrationChannel.findMany({
        where: { integration: { botId, orgId, status: 'active' } },
        select: { integrationId: true, channelId: true, kind: true, trigger: true, decisionBinding: true, name: true }
      })
      // The scope is re-derived from the locked rows, so a concurrent PATCH cannot slip a removal past the caller.
      const current = new Set(rows.filter((row) => isRouted(row.decisionBinding)).map((row) => row.channelId))
      const desired = new Set(input.channelIds)
      const removed = [...current].filter((id) => !desired.has(id))
      const removals = new Map(input.removals.map((removal) => [removal.channelId, removal]))
      if (removed.length !== removals.size || removed.some((id) => !removals.has(id)))
        throw new RoutingScopeChanged(botId)
      const additions = [...desired].filter((id) => !current.has(id))
      for (const channelId of additions) {
        const conversation = rows.filter((row) => row.channelId === channelId)
        if (conversation.length === 0) throw new RoutingChannelInvalid(channelId, 'missing')
        if (conversation.some((row) => row.kind === 'im')) throw new RoutingChannelInvalid(channelId, 'direct')
        if (conversation.some((row) => row.trigger === 'off')) throw new RoutingChannelInvalid(channelId, 'off')
      }
      const config = {
        enabled: input.config.enabled,
        decisionId: input.config.decisionId,
        rules: input.config.rules as unknown as Prisma.InputJsonValue,
        otherwise: input.config.otherwise as Prisma.InputJsonValue,
        steps: (input.config.steps ?? []) as unknown as Prisma.InputJsonValue,
        needsReview: false
      }
      await tx.botDecisionRouting.upsert({
        where: { botId },
        create: { botId, orgId, ...config, createdByUserId: actor.userId },
        update: config
      })
      const conversationRows = { integration: { botId, orgId, status: 'active' as const } }
      // Every sibling row flips together, replacing a gate whole: no row ever holds both consumers.
      if (additions.length > 0)
        await tx.integrationChannel.updateMany({
          where: { ...conversationRows, channelId: { in: additions } },
          data: {
            trigger: 'decision',
            decisionBinding: ROUTER_BINDING,
            decisionId: null,
            decisionNeedsReview: false,
            triggerChosen: true
          }
        })
      for (const removal of input.removals) {
        await tx.integrationChannel.updateMany({
          where: { ...conversationRows, channelId: removal.channelId },
          data: {
            trigger: removal.activation.trigger,
            decisionBinding: Prisma.DbNull,
            decisionId: null,
            decisionNeedsReview: false,
            triggerChosen: true
          }
        })
        if (removal.ownerIntegrationId) await this.moveOwner(tx, botId, orgId, removal)
      }
      const saved = await tx.botDecisionRouting.findUnique({ where: { botId }, include: { decision: true } })
      const record = saved ? await routingRecord(tx, saved) : null
      if (!record) throw new Error(`bot ${botId} routing did not persist`)
      return record
    })
  }

  // The removal's replacement owner: one canonical marked row, every sibling cleared (persistConversationOwner).
  private async moveOwner(
    tx: Prisma.TransactionClient,
    botId: BotId,
    orgId: OrgId,
    removal: BotDecisionRoutingRemoval
  ): Promise<void> {
    const owner = await tx.integration.findFirst({
      where: { id: removal.ownerIntegrationId!, botId, orgId, status: 'active' },
      select: { id: true, agentId: true }
    })
    if (!owner) throw new RoutingChannelInvalid(removal.channelId, 'missing')
    const template = await tx.integrationChannel.findFirst({
      where: { channelId: removal.channelId, integration: { botId, orgId, status: 'active' } },
      select: { kind: true, name: true, isPrivate: true, sessionMode: true }
    })
    await tx.integrationChannel.upsert({
      where: { integrationId_channelId: { integrationId: owner.id, channelId: removal.channelId } },
      create: {
        integrationId: owner.id,
        channelId: removal.channelId,
        agentId: owner.agentId,
        trigger: removal.activation.trigger,
        triggerChosen: true,
        ...(template
          ? {
              kind: template.kind,
              name: template.name,
              isPrivate: template.isPrivate,
              sessionMode: template.sessionMode
            }
          : {})
      },
      update: { agentId: owner.agentId }
    })
    await tx.integrationChannel.updateMany({
      where: {
        channelId: removal.channelId,
        integrationId: { not: owner.id },
        integration: { botId, orgId, status: 'active' }
      },
      data: { agentId: null }
    })
  }

  async listUsages(orgId: OrgId, decisionIds?: readonly string[]): Promise<BotDecisionRoutingUsage[]> {
    if (decisionIds?.length === 0) return []
    const rows = await this.db.botDecisionRouting.findMany({
      where: { orgId },
      select: {
        decisionId: true,
        botId: true,
        rules: true,
        steps: true,
        bot: { select: { name: true, integrations: { where: { status: 'active' }, select: { agentId: true } } } }
      },
      orderBy: { botId: 'asc' }
    })
    return rows.flatMap((row) => {
      const rules = SharedBotDecisionRouting.shape.rules.safeParse(row.rules)
      const steps = SharedBotDecisionRouting.shape.steps.safeParse(row.steps)
      const chain = { decisionId: row.decisionId, ...(steps.success && steps.data ? { steps: steps.data } : {}) }
      const targets = rules.success ? decisionRoutingAgentIds({ rules: rules.data, steps: chain.steps }) : []
      return decisionChainIds(chain)
        .filter((id) => !decisionIds || decisionIds.includes(id))
        .map((id) => ({
          decisionId: id,
          botId: BotId(row.botId),
          botName: row.bot.name,
          agentIds: [...new Set([...row.bot.integrations.map((i) => i.agentId), ...targets])].map(AgentId)
        }))
    })
  }
}
