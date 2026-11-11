// An agent's coordinator filter verdicts (auto-session-mode.md §4.7): proxied from a serving daemon, never stored by the CP.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  COORDINATOR_FILTER_EVALUATIONS_V1_FEATURE,
  DecisionEvaluationRecordDetail,
  DecisionEvaluationRecordPage
} from '@agentconnect.md/protocol'
import { canEdit, canView } from '../../authorization/policy.js'
import { AgentId } from '../../domain/ids.js'
import { ProtocolError } from '../../domain/errors.js'
import type { AgentRecord } from '../../persistence/ports.js'
import { NoConnection } from '../../orchestrator/outbound.js'
import { ConnectionClosed } from '../../ws/registry.js'
import type { HttpDeps } from '../deps.js'
import { ErrorDto } from '../dto/index.js'
import { Tag } from '../plugins/openapi.js'
import type { ZodTypeProvider } from '../plugins/zod.js'
import { ctxOf, orgOf } from '../rbac.js'

const Params = z.object({ id: z.string().uuid() })
const error = (code: 403 | 404 | 503, message: string, machine?: string) => ({
  error: code === 404 ? 'Not Found' : code === 403 ? 'Forbidden' : 'Service Unavailable',
  statusCode: code,
  message,
  ...(machine ? { code: machine } : {})
})

export function agentCoordinatorFilterEvaluationRoutes(deps: HttpDeps) {
  return async function agentCoordinatorFilterEvaluationRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()
    // The verdicts quote the messages judged, so only the agent's editors read them, as for a chat API gate.
    const editableAgent = async (req: FastifyRequest, reply: FastifyReply): Promise<AgentRecord | null> => {
      const agent = await deps.repos.agent.get(orgOf(req), AgentId((req.params as { id: string }).id))
      if (!agent || !canView(agent, ctxOf(req))) {
        await reply.code(404).send(error(404, 'agent not found'))
        return null
      }
      if (!canEdit(agent, ctxOf(req))) {
        await reply.code(403).send(error(403, 'cannot edit this agent'))
        return null
      }
      return agent
    }
    // Read from a serving daemon that records verdicts, trying the next on a dropped connection or a lane it no longer serves.
    const fromDaemon = async <T>(reply: FastifyReply, agent: AgentRecord, read: (id: string) => Promise<T>) => {
      const ready = (await deps.placementResolver.servingDaemons(agent)).filter(
        (id) => deps.daemonConns.get(id)?.state === 'READY'
      )
      const capable = ready.filter((id) =>
        deps.daemonConns.get(id)?.capabilities?.features.includes(COORDINATOR_FILTER_EVALUATIONS_V1_FEATURE)
      )
      if (ready.length && !capable.length) {
        await reply
          .code(503)
          .send(error(503, 'upgrade the daemon to read coordinator filter evaluations', 'DAEMON_UPGRADE_REQUIRED'))
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

    r.get(
      '/agents/:id/coordinator-filter/evaluations',
      {
        schema: {
          tags: [Tag.Decisions],
          summary: "List an agent's coordinator filter evaluations",
          description:
            "Lists the verdicts this agent's coordinator filter reached on unaddressed messages, newest first, from its serving daemon: `triggered` let the message through to the coordinator, `skipped` kept it from the coordinator, `unavailable` let it through without an answer (`reason` names why). Only callers who can edit the agent may read them. Each row's `title` is the message's first line and `decisionId` is `coordinator-filter`; detail bodies expire after 24 hours or 20 newer verdicts, summaries after seven days.",
          operationId: 'listAgentCoordinatorFilterEvaluations',
          params: Params,
          querystring: z.object({
            cursor: z.coerce.number().int().positive().optional(),
            limit: z.coerce.number().int().min(1).max(50).default(20)
          }),
          response: { 200: DecisionEvaluationRecordPage, 403: ErrorDto, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const agent = await editableAgent(req, reply)
        if (!agent) return reply
        const page = await fromDaemon(reply, agent, (id) =>
          deps.control.coordinatorFilterEvaluations(id, orgOf(req), { agentId: agent.id, ...req.query })
        )
        return page ?? reply
      }
    )

    r.get(
      '/agents/:id/coordinator-filter/evaluations/:seq',
      {
        schema: {
          tags: [Tag.Decisions],
          summary: "Get an agent's coordinator filter evaluation",
          description:
            'Reads one frozen coordinator filter verdict from the serving daemon: the question and model as asked, the message and conversation it judged, the answer, and the provider JSON while retained. Only callers who can edit the agent may read it.',
          operationId: 'getAgentCoordinatorFilterEvaluation',
          params: Params.extend({ seq: z.coerce.number().int().positive() }),
          response: { 200: DecisionEvaluationRecordDetail, 403: ErrorDto, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const agent = await editableAgent(req, reply)
        if (!agent) return reply
        const result = await fromDaemon(reply, agent, (id) =>
          deps.control.coordinatorFilterEvaluation(id, orgOf(req), { agentId: agent.id, seq: req.params.seq })
        )
        if (!result) return reply
        return result.evaluation ?? reply.code(404).send(error(404, 'evaluation not found'))
      }
    )
  }
}
