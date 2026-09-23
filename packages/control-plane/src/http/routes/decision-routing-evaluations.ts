import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  DECISION_ROUTING_EVALUATIONS_V1_FEATURE,
  DecisionRoutingEvaluationRecordDetail,
  DecisionRoutingEvaluationRecordPage,
  type DecisionEvaluationConversation
} from '@agentconnect.md/protocol'
import { canView } from '../../authorization/policy.js'
import { ProtocolError } from '../../domain/errors.js'
import { BotId } from '../../domain/ids.js'
import type { BotRecord } from '../../persistence/ports.js'
import { NoConnection } from '../../orchestrator/outbound.js'
import { ConnectionClosed } from '../../ws/registry.js'
import { conversationAudienceAllows, readableRoutedConversation } from '../conversation-access.js'
import type { HttpDeps } from '../deps.js'
import { ErrorDto } from '../dto/index.js'
import { Tag } from '../plugins/openapi.js'
import type { ZodTypeProvider } from '../plugins/zod.js'
import { routingHostMembers } from '../routing-host.js'
import { ctxOf, orgOf } from '../rbac.js'

const IdParam = z.object({ id: z.string().uuid() })
const MAX_CHANNELS = 100
const notFound = (message: string) => ({ error: 'Not Found', statusCode: 404, message })
const unavailable = (message: string, code?: string) => ({
  error: 'Service Unavailable',
  statusCode: 503,
  message,
  ...(code ? { code } : {})
})
const OFFLINE = 'the evaluation host daemon is offline'
const UNSUPPORTED = 'upgrade the evaluation host daemon to read routing evaluations'

type Proxied<T> = { ok: true; value: T } | { ok: false }

export function decisionRoutingEvaluationRoutes(deps: HttpDeps) {
  return async function decisionRoutingEvaluationRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()
    const readyConn = (daemonId: string) => {
      const conn = deps.daemonConns.get(daemonId)
      return conn?.state === 'READY' ? conn : undefined
    }

    // A shared bot the caller can see through at least one of its agents; anything else is a 404.
    const visibleBot = async (req: FastifyRequest): Promise<BotRecord | null> => {
      const orgId = orgOf(req)
      const bot = await deps.repos.bot.get(orgId, BotId((req.params as { id: string }).id))
      if (!bot || bot.transport !== 'http' || !bot.shareable) return null
      const role = await deps.repos.org.roleOf(orgId, ctxOf(req).userId)
      if (!role) return null
      const viewer = { ...ctxOf(req), role }
      for (const id of bot.agentIds) {
        const agent = await deps.repos.agent.get(orgId, id)
        if (agent && canView(agent, viewer)) return bot
      }
      return null
    }

    // The bot's members on the host, in order; the first that serves the lane answers, as the gate reads do.
    const proxied = async <T>(
      req: FastifyRequest,
      reply: FastifyReply,
      bot: BotRecord,
      hostId: string | null,
      preferAgentId: string | null,
      read: (agentId: string, integrationId: string) => Promise<T>
    ): Promise<Proxied<T>> => {
      const conn = hostId ? readyConn(hostId) : undefined
      if (!hostId || !conn) {
        await reply.code(503).send(unavailable(OFFLINE, 'DAEMON_OFFLINE'))
        return { ok: false }
      }
      if (!conn.capabilities?.features.includes(DECISION_ROUTING_EVALUATIONS_V1_FEATURE)) {
        await reply.code(503).send(unavailable(UNSUPPORTED, 'DAEMON_UPGRADE_REQUIRED'))
        return { ok: false }
      }
      let failure: unknown
      for (const member of await routingHostMembers(deps, req, bot, hostId, preferAgentId)) {
        try {
          return { ok: true, value: await read(member.agent.id, member.integration.id) }
        } catch (err) {
          const moved =
            err instanceof NoConnection ||
            err instanceof ConnectionClosed ||
            (err instanceof ProtocolError && err.code === 'SCOPE_DENIED')
          if (!moved) {
            failure = err
            req.log.warn(
              { daemonId: hostId, error: (err as Error).name },
              'routing evaluations read failed; trying the next member'
            )
          }
        }
      }
      if (failure !== undefined) throw failure
      await reply.code(503).send(unavailable(OFFLINE, 'DAEMON_OFFLINE'))
      return { ok: false }
    }

    // Runs on the reply before anything is returned; a refused channel's rows are dropped unread and never logged.
    const channelReadable = (
      req: FastifyRequest,
      bot: BotRecord,
      namespace: DecisionEvaluationConversation,
      opts: { bodies?: boolean } = {}
    ) => {
      const cache = new Map<string, Promise<boolean>>()
      return (channel: string): Promise<boolean> => {
        let pending = cache.get(channel)
        if (!pending) {
          pending = (async () => {
            const conversation = await readableRoutedConversation(deps, req, bot, channel)
            return !!conversation && (await conversationAudienceAllows(deps, req, conversation, namespace, opts))
          })()
          cache.set(channel, pending)
        }
        return pending
      }
    }

    r.get(
      '/bots/:id/decision-routing/evaluations',
      {
        schema: {
          tags: [Tag.Decisions],
          summary: 'List recent routing evaluations',
          operationId: 'listBotDecisionRoutingEvaluations',
          description:
            "Recent shared-bot routing evaluations, newest first, read from the bot's evaluation host and proxied without being stored or logged: the answer, matched rules or Otherwise, each target with its admission status, and the outcome (Routed, Partially routed, Skipped, Fallback, Unavailable, Canceled, Pending). Covers `channelId`, or else every routed channel the bot-level host evaluates (up to 100). Each row is returned only when the caller can read its conversation: the audience of the newest session any bot agent holds there in the namespace the host names, or before any session the organization baseline (closed while an external-access policy is active); refused rows are dropped, so a page may be short while `nextCursor` continues. Returns 503 when the host is offline or must be upgraded, including a reply that names no namespace.",
          params: IdParam,
          querystring: z.object({
            channelId: z.string().min(1).max(512).optional(),
            cursor: z.coerce.number().int().positive().optional(),
            limit: z.coerce.number().int().min(1).max(50).default(20)
          }),
          response: { 200: DecisionRoutingEvaluationRecordPage, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const bot = await visibleBot(req)
        if (!bot) return reply.code(404).send(notFound('bot not found'))
        const { channelId, cursor, limit } = req.query
        const description = await deps.httpBot.describeRouting(bot)
        const botHost = description.evaluationHost?.daemonId ?? null
        let hostId = botHost
        let channels: string[]
        let preferAgentId: string | null = null
        if (channelId) {
          if (!(await readableRoutedConversation(deps, req, bot, channelId)))
            return reply.code(404).send(notFound('conversation not found'))
          const described = description.channels.find((c) => c.channelId === channelId)
          hostId = described?.evaluationDaemonId ?? botHost
          preferAgentId = described?.defaultAgentId ?? null
          channels = [channelId]
        } else {
          channels = description.channels
            .filter((c) => (c.evaluationDaemonId ?? botHost) === botHost)
            .map((c) => c.channelId)
            .slice(0, MAX_CHANNELS)
          if (channels.length === 0) return { items: [], nextCursor: null }
        }
        const result = await proxied(req, reply, bot, hostId, preferAgentId, (agentId, integrationId) =>
          deps.control.decisionRoutingEvaluations(hostId!, orgOf(req), {
            agentId,
            integrationId,
            botId: bot.id,
            channels,
            ...(cursor !== undefined ? { cursor } : {}),
            limit
          })
        )
        if (!result.ok) return reply
        const { conversation: namespace, items, nextCursor } = result.value
        // A reply that names no namespace cannot be scoped to its install, so it fails closed as an upgrade.
        if (!namespace) return reply.code(503).send(unavailable(UNSUPPORTED, 'DAEMON_UPGRADE_REQUIRED'))
        const readable = channelReadable(req, bot, namespace)
        const allowed = await Promise.all(items.map((item) => readable(item.channel)))
        return { items: items.filter((_, index) => allowed[index]), nextCursor }
      }
    )

    r.get(
      '/bots/:id/decision-routing/evaluations/:seq',
      {
        schema: {
          tags: [Tag.Decisions],
          summary: 'Get a routing evaluation',
          operationId: 'getBotDecisionRoutingEvaluation',
          description:
            "One routing evaluation with its frozen Decision and routing snapshot, target constraint (agents, participation, and mention or implicit only), input and history, answer, model, usage, and every target's admission status while the host still retains the bodies (bounded to 64 KiB); once stripped, `detailsExpired` is true and only the summary and snapshot remain. Proxied from the evaluation host, never stored or logged, and returned only after the conversation audience check; before any session there names an audience the bodies need edit access to the conversation's owner agent. Returns 404 when the evaluation is gone or unreadable and 503 when the host is offline or must be upgraded, including a reply that names no namespace.",
          params: IdParam.extend({ seq: z.coerce.number().int().nonnegative() }),
          querystring: z.object({ channelId: z.string().min(1).max(512) }),
          response: { 200: DecisionRoutingEvaluationRecordDetail, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const bot = await visibleBot(req)
        if (!bot) return reply.code(404).send(notFound('bot not found'))
        const { channelId } = req.query
        if (!(await readableRoutedConversation(deps, req, bot, channelId)))
          return reply.code(404).send(notFound('conversation not found'))
        const description = await deps.httpBot.describeRouting(bot)
        const described = description.channels.find((c) => c.channelId === channelId)
        const hostId = described?.evaluationDaemonId ?? description.evaluationHost?.daemonId ?? null
        const result = await proxied(
          req,
          reply,
          bot,
          hostId,
          described?.defaultAgentId ?? null,
          (agentId, integrationId) =>
            deps.control.decisionRoutingEvaluation(hostId!, orgOf(req), {
              agentId,
              integrationId,
              botId: bot.id,
              channel: channelId,
              seq: req.params.seq
            })
        )
        if (!result.ok) return reply
        const namespace = result.value.conversation
        if (!namespace) return reply.code(503).send(unavailable(UNSUPPORTED, 'DAEMON_UPGRADE_REQUIRED'))
        if (!(await channelReadable(req, bot, namespace, { bodies: true })(channelId)))
          return reply.code(404).send(notFound('conversation not found'))
        if (!result.value.evaluation) return reply.code(404).send(notFound('evaluation not found'))
        return result.value.evaluation
      }
    )
  }
}
