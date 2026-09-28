// The chat APIs an agent accepts calls on (shared-bot-relay.md §10.4), anchored on the agent like a hook: reads need visibility, writes `denyViewerWrite`.
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import {
  AgentApiProtocol,
  ChannelDecisionGate,
  decisionGateIssues,
  type AgentApiGates
} from '@agentconnect.md/protocol'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import type { AgentApiEntryRecord, AgentRecord } from '../../persistence/ports.js'
import { DecisionBindingDenied } from '../../persistence/decision-binding-fence.js'
import { NoConnection } from '../../orchestrator/outbound.js'
import { AgentId } from '../../domain/ids.js'
import { canEdit, canView } from '../../authorization/policy.js'
import { ctxOf, denyViewerWrite, orgOf } from '../rbac.js'
import { apiGateReadiness, visibleDecisionChain } from '../decision-access.js'
import { ErrorDto } from '../dto/index.js'
import { Tag } from '../plugins/openapi.js'

const AgentParams = z.object({ orgId: z.string(), agentId: z.string().uuid() })
const EntryParams = AgentParams.extend({ protocol: AgentApiProtocol })
const AgentApiEntryDto = z.object({
  protocol: AgentApiProtocol,
  createdBy: z.string().nullable(),
  createdAt: z.string().datetime(),
  // The Decision a turn over this API must pass, or null when every turn is admitted.
  gate: ChannelDecisionGate.nullable()
})
const AgentApiEntryListDto = z.object({ entries: z.array(AgentApiEntryDto) })
const GateBody = z.object({ gate: ChannelDecisionGate.nullable() })

const toDto = (e: AgentApiEntryRecord, gates: AgentApiGates | undefined): z.infer<typeof AgentApiEntryDto> => ({
  protocol: e.protocol,
  createdBy: e.createdByUserId,
  createdAt: e.createdAt.toISOString(),
  gate: gates?.[e.protocol] ?? null
})

export function agentApiRoutes(deps: HttpDeps) {
  return async function agentApiRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()
    const notFound = (reply: FastifyReply, message: string) =>
      reply.code(404).send({ error: 'Not Found', statusCode: 404, message })
    // Persist the agent's gates and ship its spec; the daemon evaluates them at API turn admission.
    const saveGates = async (agent: AgentRecord, gates: AgentApiGates, actorUserId?: string) => {
      const saved = await deps.repos.agentConfig.update(agent.orgId, agent.id, {
        apiGates: gates,
        ...(actorUserId ? { lastModifiedByUserId: actorUserId } : {})
      })
      await deps.agentDelivery.upsert(saved, (err, daemonId) => {
        // The row is persisted; an unreachable daemon catches up from the reconnect roster.
        if (err instanceof NoConnection) app.log.debug({ agentId: saved.id, daemonId }, 'agent/upsert skipped')
        else app.log.warn({ err, agentId: saved.id, daemonId }, 'agent/upsert after an API gate change failed')
      })
      return saved
    }

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
        return reply.send({ entries: entries.map((e) => toDto(e, agent.apiGates)) })
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
        return reply.send(toDto(entry, agent.apiGates))
      }
    )

    r.put(
      '/agents/:agentId/api/:protocol/gate',
      {
        schema: {
          tags: [Tag.Agents],
          summary: "Set a chat API's Decision gate",
          description:
            'Admits a turn over `protocol` only when the Decision chain matches; a negative answer refuses it with 422 `declined`, and a turn whose evaluation is unavailable is admitted. `gate: null` admits every turn. Every daemon serving the agent must support it (409 otherwise).',
          operationId: 'setAgentApiGate',
          params: EntryParams,
          body: GateBody,
          response: { 200: AgentApiEntryDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const agent = await deps.repos.agent.get(orgOf(req), AgentId(req.params.agentId))
        if (!agent || !canView(agent, ctxOf(req))) return notFound(reply, 'agent not found')
        if (!canEdit(agent, ctxOf(req)))
          return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this agent' })
        const protocol = req.params.protocol
        const entry = (await deps.repos.agentApiEntry.listForAgent(agent.id)).find((e) => e.protocol === protocol)
        if (!entry) return notFound(reply, 'the agent does not accept this API')
        const gate = req.body.gate
        if (gate) {
          // Validated like a channel's By decision (decisions.md §6.3): 404 when invisible, 400 on the condition.
          const chain = await visibleDecisionChain(deps, req, gate)
          const root = chain?.get(gate.decisionId)
          if (!chain || !root) return notFound(reply, 'decision not found')
          const issues = decisionGateIssues(root.question, gate, new Map([...chain].map(([id, d]) => [id, d.question])))
          if (issues.length > 0)
            return reply.code(400).send({
              error: 'Bad Request',
              statusCode: 400,
              message: 'The condition does not match the Decision question',
              issues
            })
          const readiness = await apiGateReadiness(deps, agent, (gate.steps?.length ?? 0) > 0)
          if (readiness.status !== 'ready')
            return reply
              .code(409)
              .send({ error: 'Conflict', statusCode: 409, message: readiness.reason ?? 'the gate cannot run yet' })
        }
        const next: AgentApiGates = { ...agent.apiGates }
        if (gate) next[protocol] = gate
        else delete next[protocol]
        let saved: AgentRecord
        try {
          saved = await saveGates(agent, next, req.principal?.userId)
        } catch (e) {
          if (e instanceof DecisionBindingDenied)
            return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: e.message })
          throw e
        }
        return reply.send(toDto(entry, saved.apiGates))
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
        // The gate goes with its API, so the Decision is no longer in use here.
        if (agent.apiGates?.[req.params.protocol]) {
          const next: AgentApiGates = { ...agent.apiGates }
          delete next[req.params.protocol]
          await saveGates(agent, next, actorUserId)
        }
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
