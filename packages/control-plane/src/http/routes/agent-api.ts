// The chat APIs an agent accepts calls on (shared-bot-relay.md §10.4), anchored on the agent like a hook: reads need visibility, writes `denyViewerWrite`.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import {
  API_GATE_EVALUATIONS_V1_FEATURE,
  AgentApiProtocol,
  ApiGateTryState,
  ChannelDecisionGate,
  DECISION_PREVIEW_V1_FEATURE,
  DecisionPreviewRequest,
  decisionAgentContext,
  supportsDecision,
  DecisionEvaluationRecordDetail,
  DecisionEvaluationRecordPage,
  decisionGateIssues,
  type AgentApiGates
} from '@agentconnect.md/protocol'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import type { AgentApiEntryRecord, AgentRecord } from '../../persistence/ports.js'
import { DecisionBindingDenied } from '../../persistence/decision-binding-fence.js'
import { NoConnection } from '../../orchestrator/outbound.js'
import { ConnectionClosed } from '../../ws/registry.js'
import { ProtocolError } from '../../domain/errors.js'
import { AgentId } from '../../domain/ids.js'
import { canEdit, canView } from '../../authorization/policy.js'
import { ctxOf, denyViewerWrite, orgOf } from '../rbac.js'
import { apiGateReadiness, apiProtocolUnsupported, visibleDecisionChain } from '../decision-access.js'
import { ErrorDto } from '../dto/index.js'
import { Tag } from '../plugins/openapi.js'
import { apiGateSampleState } from '../../domain/decision-gate-preview.js'
import { previewsRaw, runGatePreview, type GatePreviewRun } from '../gate-preview.js'
import { gatePreviewDetail } from '../../domain/decision-preview-detail.js'
import { GatePreviewDto } from './integration-channel-decisions.js'

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
const unavailable = (message: string, code: string) => ({
  error: 'Service Unavailable',
  statusCode: 503,
  message,
  code
})

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
            'Lets API keys that select this agent call it over `protocol`. Idempotent: adding an API the agent already accepts returns the existing entry. Refused with 409 `DAEMON_UPGRADE_REQUIRED` while a connected daemon serving the agent cannot take the protocol.',
          operationId: 'addAgentApiEntry',
          params: EntryParams,
          response: { 200: AgentApiEntryDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const agent = await deps.repos.agent.get(orgOf(req), AgentId(req.params.agentId))
        if (!agent || !canView(agent, ctxOf(req))) return notFound(reply, 'agent not found')
        const protocol = req.params.protocol
        const added = (await deps.repos.agentApiEntry.listForAgent(agent.id)).some((e) => e.protocol === protocol)
        // An older daemon cannot decode this protocol's turns or gates; one offline now catches up from its reconnect roster.
        if (!added && (await apiProtocolUnsupported(deps, agent, protocol)))
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'Upgrade the daemon serving this agent to accept this API.',
            code: 'DAEMON_UPGRADE_REQUIRED'
          })
        const actorUserId = req.principal?.userId ?? null
        const { entry, created } = await deps.repos.agentApiEntry.enable(agent.id, protocol, actorUserId)
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
            'Admits a turn over `protocol` only when the Decision chain matches; a negative answer refuses it with 422 `declined`, and a turn whose evaluation is unavailable is admitted. `gate: null` admits every turn. Refusals carry `code` DECISION_NOT_FOUND (404) or, when a connected daemon serving the agent cannot run the gate, DECISION_UNSUPPORTED_CONSUMER (409).',
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
          if (!chain || !root)
            return reply
              .code(404)
              .send({ error: 'Not Found', statusCode: 404, message: 'decision not found', code: 'DECISION_NOT_FOUND' })
          const issues = decisionGateIssues(root.question, gate, new Map([...chain].map(([id, d]) => [id, d.question])))
          if (issues.length > 0)
            return reply.code(400).send({
              error: 'Bad Request',
              statusCode: 400,
              message: 'The condition does not match the Decision question',
              issues
            })
          // An offline daemon takes the gate from its reconnect roster; only a connected one that cannot run it refuses.
          const readiness = await apiGateReadiness(deps, agent, protocol, (gate.steps?.length ?? 0) > 0)
          if (readiness.status === 'unsupported')
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: readiness.reason ?? 'A daemon serving this agent cannot run the gate',
              code: 'DECISION_UNSUPPORTED_CONSUMER'
            })
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

    // Gate verdicts judge callers' messages, so only those who may edit the agent read them.
    const editableAgent = async (req: FastifyRequest<{ Params: z.infer<typeof AgentParams> }>, reply: FastifyReply) => {
      const agent = await deps.repos.agent.get(orgOf(req), AgentId(req.params.agentId))
      if (!agent || !canView(agent, ctxOf(req))) {
        await notFound(reply, 'agent not found')
        return null
      }
      if (!canEdit(agent, ctxOf(req))) {
        await reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this agent' })
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
        deps.daemonConns.get(id)?.capabilities?.features.includes(API_GATE_EVALUATIONS_V1_FEATURE)
      )
      if (ready.length && !capable.length) {
        await reply
          .code(503)
          .send(unavailable('upgrade the evaluation host to read API gate evaluations', 'DAEMON_UPGRADE_REQUIRED'))
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
      await reply.code(503).send(unavailable('the evaluation host is offline', 'DAEMON_OFFLINE'))
      return null
    }

    r.post(
      '/agents/:agentId/api/:protocol/gate/preview',
      {
        bodyLimit: 40 * 1024,
        schema: {
          tags: [Tag.Decisions],
          summary: 'Try a chat API gate',
          operationId: 'previewAgentApiGate',
          description:
            'Evaluates a draft Decision gate for `protocol` against a sample call on a daemon serving the agent, in the state the live gate builds (`currentMessage.text`, no history; the agent and source are bound here), then applies the draft condition. Writes nothing and never stores the sample. Needs edit access to the agent. An unsupported daemon returns `not_applied` without a model call; 503 when no serving daemon is connected; a provider failure returns `unavailable`, which admits the call and never means skip.',
          params: EntryParams,
          body: z.strictObject({ gate: ChannelDecisionGate, state: ApiGateTryState }),
          response: { 200: GatePreviewDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const agent = await editableAgent(req, reply)
        if (!agent) return reply
        const protocol = req.params.protocol
        if (!(await deps.repos.agentApiEntry.listForAgent(agent.id)).some((e) => e.protocol === protocol))
          return notFound(reply, 'the agent does not accept this API')
        const { gate, state } = req.body
        const definitions = await visibleDecisionChain(deps, req, gate)
        const decision = definitions?.get(gate.decisionId)
        if (!definitions || !decision)
          return reply
            .code(404)
            .send({ error: 'Not Found', statusCode: 404, message: 'decision not found', code: 'DECISION_NOT_FOUND' })
        const badRequest = (message: string, issues?: Array<{ path: Array<string | number>; message: string }>) =>
          reply.code(400).send({ error: 'Bad Request', statusCode: 400, message, ...(issues ? { issues } : {}) })
        if ([...definitions.values()].some((d) => !supportsDecision(d)))
          return badRequest('Unsupported Decision provider, model, or question type.')
        const issues = decisionGateIssues(
          decision.question,
          gate,
          new Map([...definitions].map(([id, d]) => [id, d.question]))
        )
        if (issues.length > 0) return badRequest('The condition does not match the Decision question', issues)
        const target = { agentId: agent.id, name: agent.displayName ?? agent.name }
        const notApplied = (message: string) => ({
          mode: 'live' as const,
          readiness: { status: 'unsupported' as const },
          evaluation: null,
          consumer: {
            type: 'gate' as const,
            outcome: 'not_applied' as const,
            notAppliedReason: 'unsupported' as const,
            reason: message,
            matched: false,
            matchedKeys: [],
            target
          }
        })
        const readiness = await apiGateReadiness(deps, agent, protocol, (gate.steps?.length ?? 0) > 0)
        if (readiness.status === 'unsupported')
          return notApplied(readiness.reason ?? 'Upgrade the daemon to gate API calls by decision.')
        const readyConn = (id: string) => {
          const conn = deps.daemonConns.get(id)
          return conn?.state === 'READY' ? conn : undefined
        }
        const daemonId = (await deps.placementResolver.servingDaemons(agent)).find((id) => readyConn(id))
        if (!daemonId) return reply.code(503).send(unavailable('the evaluation host is offline', 'DAEMON_OFFLINE'))
        if (!readyConn(daemonId)?.capabilities?.features.includes(DECISION_PREVIEW_V1_FEATURE))
          return notApplied('Upgrade the daemon to preview decisions.')
        const parsed = DecisionPreviewRequest.safeParse({
          agentId: agent.id,
          evaluationId: randomUUID(),
          decision: {
            name: decision.name,
            providerId: decision.providerId,
            model: decision.model,
            question: decision.question
          },
          state: apiGateSampleState(state, decisionAgentContext(agent)),
          ...(previewsRaw(deps, daemonId) ? { raw: true } : {})
        })
        if (!parsed.success) return badRequest('The preview must fit within 32 KiB.')
        // Fenced on both sides of the call: role, edit access, serving placement, and the Decisions themselves.
        const authorized = async (): Promise<boolean> => {
          const role = await deps.repos.org.roleOf(agent.orgId, ctxOf(req).userId)
          if (!role || role === 'viewer') return false
          const viewer = { ...ctxOf(req), role }
          const [current, stillVisible] = await Promise.all([
            deps.repos.agent.get(agent.orgId, agent.id),
            Promise.all([...definitions.keys()].map((id) => deps.repos.decision.get(agent.orgId, id)))
          ])
          return (
            !!current &&
            canEdit(current, viewer) &&
            stillVisible.every((d) => !!d && canView(d, viewer)) &&
            (await deps.placementResolver.servingDaemons(current)).includes(daemonId)
          )
        }
        if (!(await authorized())) return notFound(reply, 'agent not found')
        let result: GatePreviewRun
        try {
          result = await runGatePreview(deps, {
            orgId: agent.orgId,
            daemonId,
            gate,
            definitions,
            request: parsed.data,
            authorized
          })
        } catch (err) {
          req.log.warn({ daemonId, error: (err as Error).name }, 'API gate preview could not reach the serving daemon')
          return reply.code(503).send(unavailable('Decision preview is unavailable. Try again.', 'DAEMON_OFFLINE'))
        }
        if (!(await authorized())) return notFound(reply, 'agent not found')
        return {
          mode: 'live' as const,
          readiness: { status: 'ready' as const },
          evaluation: result.evaluation,
          ...(result.chain ? { chain: result.chain } : {}),
          detail: gatePreviewDetail({
            gate,
            definitions,
            state: parsed.data.state,
            run: result.run,
            outcome: result.outcome,
            matchedKeys: result.matchedKeys,
            sessionMode: 'api'
          }),
          consumer: {
            type: 'gate' as const,
            outcome: result.outcome,
            matched: result.matched,
            matchedKeys: result.matchedKeys,
            target
          }
        }
      }
    )

    r.get(
      '/agents/:agentId/api/:protocol/evaluations',
      {
        schema: {
          tags: [Tag.Decisions],
          summary: "List a chat API gate's recent evaluations",
          description:
            "Lists the verdicts this agent's Decision gate on `protocol` reached, newest first, from its serving daemon: `triggered` admitted the turn, `skipped` refused it, `unavailable` admitted it without an answer. `decisionId` filters by the root Decision before paging. Only callers who can edit the agent may read them. Each row's `title` is the call's first line; detail bodies expire after 24 hours or 20 newer verdicts, summaries after seven days.",
          operationId: 'listAgentApiGateEvaluations',
          params: EntryParams,
          querystring: z.object({
            cursor: z.coerce.number().int().positive().optional(),
            limit: z.coerce.number().int().min(1).max(50).default(20),
            decisionId: z.string().uuid().optional()
          }),
          response: { 200: DecisionEvaluationRecordPage, 403: ErrorDto, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const agent = await editableAgent(req, reply)
        if (!agent) return reply
        const page = await fromDaemon(reply, agent, (id) =>
          deps.control.decisionApiGateEvaluations(id, orgOf(req), {
            agentId: agent.id,
            protocol: req.params.protocol,
            ...req.query
          })
        )
        return page ?? reply
      }
    )

    r.get(
      '/agents/:agentId/api/:protocol/evaluations/:seq',
      {
        schema: {
          tags: [Tag.Decisions],
          summary: "Get a chat API gate's evaluation",
          description:
            'Reads one frozen gate verdict from the serving daemon: the Decision as it was asked, the call it judged, the answer, the chain trace, and the provider JSON while retained. Only callers who can edit the agent may read it.',
          operationId: 'getAgentApiGateEvaluation',
          params: EntryParams.extend({ seq: z.coerce.number().int().positive() }),
          response: { 200: DecisionEvaluationRecordDetail, 403: ErrorDto, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const agent = await editableAgent(req, reply)
        if (!agent) return reply
        const result = await fromDaemon(reply, agent, (id) =>
          deps.control.decisionApiGateEvaluation(id, orgOf(req), {
            agentId: agent.id,
            protocol: req.params.protocol,
            seq: req.params.seq
          })
        )
        if (!result) return reply
        return result.evaluation ?? notFound(reply, 'evaluation not found')
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
