// The chat APIs an agent accepts calls on (shared-bot-relay.md §10.4), anchored on the agent like a hook: reads need visibility, writes `denyViewerWrite`.
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { AgentApiProtocol } from '@agentconnect.md/protocol'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import type { AgentApiEntryRecord } from '../../persistence/ports.js'
import { AgentId } from '../../domain/ids.js'
import { canView } from '../../authorization/policy.js'
import { ctxOf, denyViewerWrite, orgOf } from '../rbac.js'
import { ErrorDto } from '../dto/index.js'
import { Tag } from '../plugins/openapi.js'

const AgentParams = z.object({ orgId: z.string(), agentId: z.string().uuid() })
const EntryParams = AgentParams.extend({ protocol: AgentApiProtocol })
const AgentApiEntryDto = z.object({
  protocol: AgentApiProtocol,
  createdBy: z.string().nullable(),
  createdAt: z.string().datetime()
})
const AgentApiEntryListDto = z.object({ entries: z.array(AgentApiEntryDto) })

const toDto = (e: AgentApiEntryRecord): z.infer<typeof AgentApiEntryDto> => ({
  protocol: e.protocol,
  createdBy: e.createdByUserId,
  createdAt: e.createdAt.toISOString()
})

export function agentApiRoutes(deps: HttpDeps) {
  return async function agentApiRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()
    const notFound = (reply: FastifyReply, message: string) =>
      reply.code(404).send({ error: 'Not Found', statusCode: 404, message })

    r.get(
      '/agents/:agentId/api',
      {
        schema: {
          tags: [Tag.Agents],
          summary: "List an agent's chat APIs",
          description:
            'The chat APIs this agent accepts calls on. An API key reaches an agent over a protocol only after it is added here; the relay refuses the rest.',
          operationId: 'listAgentApiEntries',
          params: AgentParams,
          response: { 200: AgentApiEntryListDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const agent = await deps.repos.agent.get(orgOf(req), AgentId(req.params.agentId))
        if (!agent || !canView(agent, ctxOf(req))) return notFound(reply, 'agent not found')
        const entries = await deps.repos.agentApiEntry.listForAgent(agent.id)
        return reply.send({ entries: entries.map(toDto) })
      }
    )

    r.put(
      '/agents/:agentId/api/:protocol',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Add a chat API to an agent',
          description:
            'Lets API keys that select this agent call it over `protocol`. Idempotent: adding an API the agent already accepts returns the existing entry.',
          operationId: 'addAgentApiEntry',
          params: EntryParams,
          response: { 200: AgentApiEntryDto, 403: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const agent = await deps.repos.agent.get(orgOf(req), AgentId(req.params.agentId))
        if (!agent || !canView(agent, ctxOf(req))) return notFound(reply, 'agent not found')
        const actorUserId = req.principal?.userId ?? null
        const { entry, created } = await deps.repos.agentApiEntry.enable(agent.id, req.params.protocol, actorUserId)
        if (created) {
          void deps.repos.audit
            .append({
              kind: 'agent_api_change',
              orgId: agent.orgId,
              agentId: agent.id,
              ...(actorUserId ? { actorUserId } : {}),
              message: `api ${entry.protocol} added`,
              details: { protocol: entry.protocol, enabled: true }
            })
            .catch(() => {})
        }
        return reply.send(toDto(entry))
      }
    )

    r.delete(
      '/agents/:agentId/api/:protocol',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Remove a chat API from an agent',
          description:
            'Stops the agent accepting calls over `protocol`: new tokens are refused at once, and a token already in use within its five-minute lifetime. Keys that select the agent stay valid for other agents.',
          operationId: 'removeAgentApiEntry',
          params: EntryParams,
          response: { 204: z.null(), 403: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const agent = await deps.repos.agent.get(orgOf(req), AgentId(req.params.agentId))
        if (!agent || !canView(agent, ctxOf(req))) return notFound(reply, 'agent not found')
        if (!(await deps.repos.agentApiEntry.disable(agent.id, req.params.protocol))) {
          return notFound(reply, 'the agent does not accept this API')
        }
        const actorUserId = req.principal?.userId
        void deps.repos.audit
          .append({
            kind: 'agent_api_change',
            orgId: agent.orgId,
            agentId: agent.id,
            ...(actorUserId ? { actorUserId } : {}),
            message: `api ${req.params.protocol} removed`,
            details: { protocol: req.params.protocol, enabled: false }
          })
          .catch(() => {})
        return reply.code(204).send(null)
      }
    )
  }
}
