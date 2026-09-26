import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  DECISION_MODEL_EVALUATIONS_V1_FEATURE,
  DECISION_EVALUATION_FILTER_V1_FEATURE,
  DecisionModelEvaluationRecordDetail,
  DecisionModelEvaluationRecordPage
} from '@agentconnect.md/protocol'
import { canView, canViewSession } from '../../authorization/policy.js'
import { AgentId, SessionId } from '../../domain/ids.js'
import { ProtocolError } from '../../domain/errors.js'
import { NoConnection } from '../../orchestrator/outbound.js'
import { ConnectionClosed } from '../../ws/registry.js'
import type { HttpDeps } from '../deps.js'
import { ErrorDto } from '../dto/index.js'
import { Tag } from '../plugins/openapi.js'
import type { ZodTypeProvider } from '../plugins/zod.js'
import { ctxOf, orgOf } from '../rbac.js'
import { makeSessionAccessResolver } from '../session-access.js'

const Params = z.object({ id: z.string().uuid() })
const error = (code: number, message: string, machine?: string) => ({
  error: code === 404 ? 'Not Found' : 'Service Unavailable',
  statusCode: code,
  message,
  ...(machine ? { code: machine } : {})
})

export function agentModelEvaluationRoutes(deps: HttpDeps) {
  return async function agentModelEvaluationRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()
    const access = makeSessionAccessResolver(deps)
    const visibleAgent = async (req: FastifyRequest) => {
      const agent = await deps.repos.agent.get(orgOf(req), AgentId((req.params as { id: string }).id))
      return agent && canView(agent, ctxOf(req)) ? agent : null
    }
    const proxied = async <T>(
      req: FastifyRequest,
      reply: FastifyReply,
      agent: NonNullable<Awaited<ReturnType<typeof visibleAgent>>>,
      read: (id: string) => Promise<T>,
      decisionId?: string
    ): Promise<T | null> => {
      const ids = await deps.placementResolver.servingDaemons(agent)
      const ready = ids.filter((id) => deps.daemonConns.get(id)?.state === 'READY')
      if (!ready.length) {
        await reply.code(503).send(error(503, 'the evaluation host is offline', 'DAEMON_OFFLINE'))
        return null
      }
      const capable = ready.filter(
        (id) =>
          deps.daemonConns.get(id)?.capabilities?.features.includes(DECISION_MODEL_EVALUATIONS_V1_FEATURE) &&
          (!decisionId ||
            deps.daemonConns.get(id)?.capabilities?.features.includes(DECISION_EVALUATION_FILTER_V1_FEATURE))
      )
      if (!capable.length) {
        await reply
          .code(503)
          .send(error(503, 'upgrade the evaluation host to read model evaluations', 'DAEMON_UPGRADE_REQUIRED'))
        return null
      }
      for (const id of capable) {
        try {
          return await read(id)
        } catch (cause) {
          if (!(
            cause instanceof NoConnection ||
            cause instanceof ConnectionClosed ||
            (cause instanceof ProtocolError && cause.code === 'SCOPE_DENIED')
          ))
            throw cause
        }
      }
      await reply.code(503).send(error(503, 'the evaluation host is offline', 'DAEMON_OFFLINE'))
      return null
    }
    const readable = async (req: FastifyRequest, agentId: string, ids: string[]) => {
      const sessions = (await Promise.all(ids.map((id) => deps.repos.session.get(orgOf(req), SessionId(id))))).filter(
        (session): session is NonNullable<typeof session> => session !== null && session.agentId === agentId
      )
      const audience = await access.forSessions(req, sessions)
      return new Set<string>(
        sessions
          .filter((session) => canViewSession(session, ctxOf(req), audience.identitySet, audience.externalAccess))
          .map((session) => session.id)
      )
    }

    r.get(
      '/agents/:id/model-evaluations',
      {
        schema: {
          tags: [Tag.Decisions],
          summary: 'List recent model selection evaluations',
          description:
            "Lists this agent's recent session-start model choices from its serving daemon. `decisionId` optionally filters by the recorded root Decision before paging. Rows from sessions the caller cannot view are omitted. Detail bodies expire after 24 hours or 20 newer choices; summaries expire after seven days.",
          operationId: 'listAgentModelEvaluations',
          params: Params,
          querystring: z.object({
            cursor: z.coerce.number().int().positive().optional(),
            limit: z.coerce.number().int().min(1).max(50).default(20),
            decisionId: z.string().uuid().optional()
          }),
          response: { 200: DecisionModelEvaluationRecordPage, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const agent = await visibleAgent(req)
        if (!agent) return reply.code(404).send(error(404, 'agent not found'))
        const result = await proxied(
          req,
          reply,
          agent,
          (id) =>
            deps.control.decisionModelEvaluations(id, orgOf(req), {
              agentId: agent.id,
              ...req.query
            }),
          req.query.decisionId
        )
        if (!result) return reply
        const allowed = await readable(
          req,
          agent.id,
          result.items.map((item) => item.sessionId)
        )
        return { items: result.items.filter((item) => allowed.has(item.sessionId)), nextCursor: result.nextCursor }
      }
    )

    r.get(
      '/agents/:id/model-evaluations/:seq',
      {
        schema: {
          tags: [Tag.Decisions],
          summary: 'Get a model selection evaluation',
          description:
            'Reads a frozen session-start model choice from the serving daemon after checking the session audience. Returns the retained answer, rules, input, and provider JSON when still available.',
          operationId: 'getAgentModelEvaluation',
          params: Params.extend({ seq: z.coerce.number().int().positive() }),
          response: { 200: DecisionModelEvaluationRecordDetail, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const agent = await visibleAgent(req)
        if (!agent) return reply.code(404).send(error(404, 'agent not found'))
        const result = await proxied(req, reply, agent, (id) =>
          deps.control.decisionModelEvaluation(id, orgOf(req), {
            agentId: agent.id,
            seq: req.params.seq
          })
        )
        if (!result) return reply
        const evaluation = result.evaluation
        if (!evaluation) return reply.code(404).send(error(404, 'evaluation not found'))
        const allowed = await readable(req, agent.id, [evaluation.sessionId])
        if (!allowed.has(evaluation.sessionId)) return reply.code(404).send(error(404, 'evaluation not found'))
        return evaluation
      }
    )
  }
}
