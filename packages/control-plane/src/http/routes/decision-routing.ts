import { isDeepStrictEqual } from 'node:util'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  SharedBotDecisionRouting,
  decisionRoutingIssues,
  manifestFor,
  supportsDecision,
  type DecisionValidationIssue
} from '@agentconnect.md/protocol'
import { canEdit, canView } from '../../authorization/policy.js'
import { AgentId, BotId, DaemonId } from '../../domain/ids.js'
import { DecisionBindingDenied } from '../../persistence/decision-binding-fence.js'
import { Prisma } from '../../generated/prisma/client.js'
import { RoutingChannelInvalid, RoutingScopeChanged } from '../../persistence/errors.js'
import type { AgentRecord, BotRecord, SeedTrigger } from '../../persistence/ports.js'
import { pickConversationOwner, type RoutingDescription } from '../../orchestrator/httpBot.js'
import { refreshMutationAgent } from '../mutation-agent.js'
import type { HttpDeps } from '../deps.js'
import { visibleDecisionChain } from '../decision-access.js'
import { ErrorDto } from '../dto/index.js'
import { Tag } from '../plugins/openapi.js'
import type { ZodTypeProvider } from '../plugins/zod.js'
import { ctxOf, denyViewerWrite, orgOf } from '../rbac.js'

const IdParam = z.object({ id: z.string().uuid() })
const unique = (values: readonly string[]) => new Set(values).size === values.length
const SaveBody = z.strictObject({
  config: SharedBotDecisionRouting,
  channelIds: z.array(z.string().min(1).max(512)).max(1000).refine(unique, 'Channels must be unique.'),
  removals: z
    .array(
      z.strictObject({
        channelId: z.string().min(1).max(512),
        settings: z.strictObject({ trigger: z.enum(['off', 'mention', 'auto']) }),
        agentId: z.string().uuid().optional()
      })
    )
    .max(1000)
    .refine((removals) => unique(removals.map((r) => r.channelId)), 'Replacement channels must be unique.')
})
const Issue = z.object({ path: z.array(z.union([z.string(), z.number()])), message: z.string() })
const ReadinessDto = z.object({
  status: z.enum([
    'ready',
    'pending_sync',
    'needs_review',
    'missing_credentials',
    'daemon_offline',
    'unsupported',
    'insufficient_credits'
  ]),
  reason: z.string().optional(),
  issues: z.array(Issue).optional()
})
const DetailDto = z.object({
  botId: z.string(),
  config: SharedBotDecisionRouting.nullable(),
  channelIds: z.array(z.string()),
  readiness: ReadinessDto,
  evaluationHost: z
    .object({
      daemonId: z.string(),
      name: z.string().nullable(),
      source: z.enum(['default_agent', 'earliest_candidate']),
      status: z.enum(['ready', 'daemon_offline', 'unsupported'])
    })
    .nullable(),
  channels: z.array(
    z.object({
      channelId: z.string(),
      name: z.string().nullable(),
      defaultAgent: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
      evaluationDaemonId: z.string().nullable(),
      readiness: ReadinessDto
    })
  ),
  updatedAt: z.string().nullable()
})
const IssuesErrorDto = ErrorDto.extend({ issues: z.array(Issue).optional(), code: z.string().optional() })

const notFound = (message: string, code?: string) => ({
  error: 'Not Found',
  statusCode: 404,
  message,
  ...(code ? { code } : {})
})
const forbidden = (message: string) => ({ error: 'Forbidden', statusCode: 403, message })
const conflict = (message: string, code?: string) => ({
  error: 'Conflict',
  statusCode: 409,
  message,
  ...(code ? { code } : {})
})
const badRequest = (message: string, issues?: DecisionValidationIssue[]) => ({
  error: 'Bad Request',
  statusCode: 400,
  message,
  ...(issues ? { issues } : {})
})

export function decisionRoutingRoutes(deps: HttpDeps) {
  return async function decisionRoutingRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()

    // Names only for what the caller can view; ids are never replaced by names.
    const detail = async (req: FastifyRequest, bot: BotRecord, description: RoutingDescription) => {
      const agentName = async (id: string) => {
        const agent = await deps.repos.agent.get(orgOf(req), AgentId(id))
        return agent && canView(agent, ctxOf(req)) ? agent.displayName || agent.name : null
      }
      // Conversation names follow the integrations list: hidden unless the caller can view one of the bot's agents.
      const visibleAgents = new Set((await deps.repos.agent.list(orgOf(req), ctxOf(req))).map((a) => a.id))
      const botVisible = bot.agentIds.some((id) => visibleAgents.has(id))
      const host = description.evaluationHost
      const daemon = host ? await deps.registry.getAvailable(orgOf(req), DaemonId(host.daemonId)) : null
      return {
        botId: bot.id,
        config: description.record?.config ?? null,
        channelIds: description.channels.map((c) => c.channelId),
        readiness: description.readiness,
        evaluationHost: host
          ? {
              daemonId: host.daemonId,
              name: daemon && canView(daemon, ctxOf(req)) ? (daemon.name ?? null) : null,
              source: host.source,
              status: host.status
            }
          : null,
        channels: await Promise.all(
          description.channels.map(async (c) => ({
            channelId: c.channelId,
            name: botVisible ? c.name : null,
            defaultAgent: c.defaultAgentId ? { id: c.defaultAgentId, name: await agentName(c.defaultAgentId) } : null,
            evaluationDaemonId: c.evaluationDaemonId,
            readiness: c.readiness
          }))
        ),
        updatedAt: description.record?.updatedAt.toISOString() ?? null
      }
    }

    const sharedBot = async (req: FastifyRequest, reply: FastifyReply): Promise<BotRecord | null> => {
      const bot = await deps.repos.bot.get(orgOf(req), BotId((req.params as { id: string }).id))
      if (!bot) {
        reply.code(404).send(notFound('bot not found'))
        return null
      }
      return bot
    }

    r.get(
      '/bots/:id/decision-routing',
      {
        schema: {
          tags: [Tag.Decisions],
          summary: 'Get shared-bot routing',
          operationId: 'getBotDecisionRouting',
          description:
            "Returns the shared bot's By decision routing configuration, its effective channel scope, and readiness, including the evaluation host daemon and each channel's resolved default agent. Names appear only for agents and daemons the caller can view; conversation names only when the caller can view one of the bot's agents.",
          params: IdParam,
          response: { 200: DetailDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const bot = await sharedBot(req, reply)
        if (!bot) return
        return detail(req, bot, await deps.httpBot.describeRouting(bot))
      }
    )

    r.put(
      '/bots/:id/decision-routing',
      {
        schema: {
          tags: [Tag.Decisions],
          summary: 'Save shared-bot routing',
          operationId: 'saveBotDecisionRouting',
          description:
            'Saves the complete routing configuration and its channel scope in one transaction. `channelIds` is the complete desired scope: an addition must be an enabled group channel and becomes By decision on every sibling row, replacing any gate; every removed channel must appear in `removals` with its replacement trigger and optional default agent. `enabled: false` pauses routing and keeps the scope. Adding channels is refused with `code` DECISION_UNSUPPORTED_CONSUMER (409) while the relay or the evaluation host does not support routing; an invisible Decision is `code` DECISION_NOT_FOUND (404).',
          params: IdParam,
          body: SaveBody,
          response: {
            200: DetailDto,
            400: IssuesErrorDto,
            403: ErrorDto,
            404: IssuesErrorDto,
            409: IssuesErrorDto
          }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const bot = await sharedBot(req, reply)
        if (!bot) return
        if (bot.transport !== 'http' || !bot.shareable)
          return reply.code(400).send(badRequest('Routing requires a shared bot.'))
        if (manifestFor(bot.platform).ownerAsDefault)
          return reply.code(400).send(badRequest('By decision is not available for this platform'))
        const { config, channelIds, removals } = req.body
        const definitions = await visibleDecisionChain(deps, req, config)
        const decision = definitions?.get(config.decisionId)
        if (!decision) return reply.code(404).send(notFound('decision not found', 'DECISION_NOT_FOUND'))
        if ([...definitions!.values()].some((d) => !supportsDecision(d)))
          return reply.code(400).send(badRequest('Unsupported Decision provider, model, or question type.'))
        const issues = decisionRoutingIssues(
          decision.question,
          config,
          new Map([...definitions!].map(([id, d]) => [id, d.question]))
        )
        // Same message for a non-member and an invisible agent, so the check discloses nothing.
        const targets = new Map<string, AgentRecord>()
        for (const [index, rule] of [config, ...(config.steps ?? [])].flatMap((step) => step.rules).entries()) {
          if (rule.action.type !== 'agent') continue
          const id = rule.action.agentId
          const agent = bot.agentIds.includes(AgentId(id)) ? await deps.repos.agent.get(orgOf(req), AgentId(id)) : null
          if (!agent || !canView(agent, ctxOf(req)))
            issues.push({ path: ['rules', index, 'action'], message: 'Choose an agent connected to this bot.' })
          else targets.set(agent.id, agent)
        }
        if (issues.length > 0) return reply.code(400).send(badRequest('The routing configuration is invalid.', issues))
        if ([...targets.values()].some((agent) => !canEdit(agent, ctxOf(req))))
          return reply.code(403).send(forbidden('cannot edit a routing target agent'))

        const description = await deps.httpBot.describeRouting(bot)
        const current = new Set(description.channels.map((c) => c.channelId))
        const desired = new Set(channelIds)
        const removed = [...current].filter((id) => !desired.has(id))
        const removalFor = new Map(removals.map((removal) => [removal.channelId, removal]))
        const scopeChanged = () =>
          reply.code(409).send(conflict('Specify replacement settings for every channel removed from routing.'))
        if (removed.length !== removalFor.size || removed.some((id) => !removalFor.has(id))) return scopeChanged()
        const additions = channelIds.filter((id) => !current.has(id))
        // A config change governs every retained channel too, so each of them is an affected conversation.
        const configChanged = !isDeepStrictEqual(config, description.record?.config ?? null)
        const retained = configChanged ? channelIds.filter((id) => current.has(id)) : []

        // Every affected conversation is edited under its own permissions: its current owner must be editable.
        const [installs, rows] = await Promise.all([
          deps.repos.integration.listForBot(bot.id),
          deps.repos.integrationChannel.listForBot(bot.id)
        ])
        const expectedOwners = new Map<string, string>()
        const mutationAgents = new Map<string, AgentRecord>(targets)
        for (const channelId of [...additions, ...removed, ...retained]) {
          const conversation = rows.filter((row) => row.channelId === channelId)
          if (conversation.length === 0) return reply.code(404).send(notFound('channel not found'))
          if (conversation.some((row) => row.kind === 'im'))
            return reply.code(400).send(badRequest('By decision applies only to group conversations'))
          if (additions.includes(channelId) && conversation.some((row) => row.trigger === 'off'))
            return reply.code(400).send(badRequest('Enable the channel before adding it to routing.'))
          const owner = pickConversationOwner(installs, conversation)
          const ownerAgent = owner ? await deps.repos.agent.get(orgOf(req), owner.agentId) : null
          if (!owner || !ownerAgent)
            return reply.code(409).send(conflict('conversation owner changed; refresh and retry the routing change'))
          if (!canEdit(ownerAgent, ctxOf(req)))
            return reply.code(403).send(forbidden('cannot edit the owner of an affected conversation'))
          expectedOwners.set(channelId, ownerAgent.id)
          mutationAgents.set(ownerAgent.id, ownerAgent)
        }
        for (const removal of removals) {
          if (!removal.agentId) continue
          if (!bot.agentIds.includes(AgentId(removal.agentId)))
            return reply.code(409).send(conflict('default agent must be an agent that uses this bot'))
          const agent = await deps.repos.agent.get(orgOf(req), AgentId(removal.agentId))
          if (!agent || !canEdit(agent, ctxOf(req)))
            return reply.code(403).send(forbidden('cannot edit the selected default agent'))
          mutationAgents.set(agent.id, agent)
        }
        // Like a gate PATCH: new channels are refused while a consumer would hold them; pause and removal never are.
        if (additions.length > 0) {
          const reason =
            description.relay === 'unsupported'
              ? 'Upgrade the relay to use By decision routing.'
              : description.evaluationHost?.status === 'unsupported'
                ? 'The evaluation host daemon does not support By decision routing yet.'
                : null
          if (reason) return reply.code(409).send(conflict(reason, 'DECISION_UNSUPPORTED_CONSUMER'))
        }

        const release = deps.agentMutations.tryBeginMutation([...mutationAgents.keys()])
        if (!release) return reply.code(409).send(conflict('agent move is in progress; retry the routing change'))
        try {
          for (const observed of mutationAgents.values()) {
            if (!(await refreshMutationAgent(deps.repos.agent, observed)))
              return reply.code(409).send(conflict('agent placement changed; refresh and retry the routing change'))
          }
          const saved = await deps.httpBot.saveDecisionRouting(
            bot,
            {
              config,
              channelIds,
              removals: removals.map((removal) => ({
                channelId: removal.channelId,
                trigger: (removal.settings.trigger === 'auto' ? 'any' : removal.settings.trigger) as SeedTrigger,
                ...(removal.agentId ? { agentId: removal.agentId } : {})
              }))
            },
            { expectedOwners, actor: ctxOf(req) }
          )
          if (!saved)
            return reply.code(409).send(conflict('conversation owner changed; refresh and retry the routing change'))
        } catch (err) {
          if (err instanceof RoutingScopeChanged) return scopeChanged()
          if (err instanceof RoutingChannelInvalid)
            return err.reason === 'missing'
              ? reply.code(404).send(notFound('channel not found'))
              : reply
                  .code(400)
                  .send(
                    badRequest(
                      err.reason === 'off'
                        ? 'Enable the channel before adding it to routing.'
                        : 'By decision applies only to group conversations'
                    )
                  )
          // The Decision was deleted between validation and the write (FK RESTRICT on the router).
          if (
            err instanceof DecisionBindingDenied ||
            (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003')
          )
            return reply.code(404).send(notFound('decision not found', 'DECISION_NOT_FOUND'))
          throw err
        } finally {
          release()
        }
        const fresh = (await deps.repos.bot.get(orgOf(req), bot.id)) ?? bot
        return detail(req, fresh, await deps.httpBot.describeRouting(fresh))
      }
    )
  }
}
