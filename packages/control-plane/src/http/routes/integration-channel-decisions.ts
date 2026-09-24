import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import {
  ChannelDecisionGate,
  DECISION_EVALUATIONS_V1_FEATURE,
  DECISION_PREVIEW_V1_FEATURE,
  DecisionEvaluation,
  type DecisionEvaluationConversation,
  DecisionEvaluationRecordDetail,
  DecisionEvaluationRecordPage,
  DecisionPreviewRequest,
  DecisionPreviewSample,
  decisionGateIssues,
  nextGateStep,
  runDecisionChain,
  DecisionChainTrace,
  type DecisionGateStep,
  supportsDecision
} from '@agentconnect.md/protocol'
import { canView } from '../../authorization/policy.js'
import { gatePreviewOutcome, gateSampleState } from '../../domain/decision-gate-preview.js'
import { ProtocolError } from '../../domain/errors.js'
import { AgentId, IntegrationId } from '../../domain/ids.js'
import type { AgentRecord } from '../../persistence/ports.js'
import { NoConnection } from '../../orchestrator/outbound.js'
import { ConnectionClosed } from '../../ws/registry.js'
import { conversationAudienceAllows, readableConversation, type ReadableConversation } from '../conversation-access.js'
import { decisionGateReadiness, gateConsumer, visibleDecisionChain } from '../decision-access.js'
import type { HttpDeps } from '../deps.js'
import { ErrorDto } from '../dto/index.js'
import { Tag } from '../plugins/openapi.js'
import type { ZodTypeProvider } from '../plugins/zod.js'
import { ctxOf, denyViewerWrite, orgOf } from '../rbac.js'

const ConversationParams = z.object({ id: z.string().uuid(), channelId: z.string().min(1).max(512) })
const PreviewBody = z.strictObject({ decisionBinding: ChannelDecisionGate, state: DecisionPreviewSample })
const ReadinessDto = z.object({
  status: z.enum(['ready', 'pending_sync', 'needs_review', 'daemon_offline', 'unsupported'])
})
const GatePreviewDto = z.object({
  mode: z.literal('live'),
  readiness: ReadinessDto,
  evaluation: DecisionEvaluation.nullable(),
  chain: DecisionChainTrace.optional(),
  consumer: z.object({
    type: z.literal('gate'),
    outcome: z.enum(['trigger', 'skip', 'unavailable', 'not_applied']),
    notAppliedReason: z.enum(['off', 'unsupported', 'needs_review']).optional(),
    reason: z.string().optional(),
    matched: z.boolean(),
    matchedKeys: z.array(z.string()),
    target: z.object({ agentId: z.string(), name: z.string() })
  })
})
type GatePreview = z.infer<typeof GatePreviewDto>

const notFound = (message: string, code?: string) => ({
  error: 'Not Found',
  statusCode: 404,
  message,
  ...(code ? { code } : {})
})
const badRequest = (message: string, issues?: Array<{ path: Array<string | number>; message: string }>) => ({
  error: 'Bad Request',
  statusCode: 400,
  message,
  ...(issues ? { issues } : {})
})
const unavailable = (message: string, code?: string) => ({
  error: 'Service Unavailable',
  statusCode: 503,
  message,
  ...(code ? { code } : {})
})
const OFFLINE = 'owning daemon is offline'
const UNSUPPORTED = 'upgrade the daemon to read recent evaluations'

export function integrationChannelDecisionRoutes(deps: HttpDeps) {
  return async function integrationChannelDecisionRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()
    const targetOf = (agent: AgentRecord) => ({ agentId: agent.id, name: agent.displayName ?? agent.name })
    const readyConn = (daemonId: string) => {
      const conn = deps.daemonConns.get(daemonId)
      return conn?.state === 'READY' ? conn : undefined
    }

    r.post(
      '/integrations/:id/channels/:channelId/decision-preview',
      {
        bodyLimit: 40 * 1024,
        schema: {
          tags: [Tag.Decisions],
          summary: 'Try a conversation gate',
          operationId: 'previewIntegrationChannelDecision',
          description:
            "Evaluates a draft By decision gate against a sample (history lines with sender ids and a current message) on the daemon serving the conversation's consumer agent, then applies the draft condition. Writes nothing: no observation, verdict, or session, and the sample is never stored. Off, unsupported, and Needs review gates return `not_applied` without a model call. Returns 503 when no serving daemon is connected; a provider failure returns `unavailable`, which continues to the target and never means skip.",
          params: ConversationParams,
          body: PreviewBody,
          response: { 200: GatePreviewDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const orgId = orgOf(req)
        const { decisionBinding: gate, state: sample } = req.body
        const integration = await deps.repos.integration.get(orgId, IntegrationId(req.params.id))
        if (!integration) return reply.code(404).send(notFound('integration not found'))
        const agent = await deps.repos.agent.get(orgId, integration.agentId)
        if (!agent || !canView(agent, ctxOf(req))) return reply.code(404).send(notFound('integration not found'))
        const bot = await deps.repos.bot.get(orgId, integration.botId)
        const row = (await deps.repos.integrationChannel.listForIntegration(integration.id)).find(
          (candidate) => candidate.channelId === req.params.channelId
        )
        if (!bot || !row) return reply.code(404).send(notFound('channel not found'))
        if (row.kind === 'im')
          return reply.code(400).send(badRequest('By decision applies only to group conversations'))
        const definitions = await visibleDecisionChain(deps, req, gate)
        const decision = definitions?.get(gate.decisionId)
        if (!decision) return reply.code(404).send(notFound('decision not found', 'DECISION_NOT_FOUND'))
        if ([...definitions!.values()].some((d) => !supportsDecision(d)))
          return reply.code(400).send(badRequest('Unsupported Decision provider, model, or question type.'))
        const issues = decisionGateIssues(
          decision.question,
          gate,
          new Map([...definitions!].map(([id, d]) => [id, d.question]))
        )
        if (issues.length > 0)
          return reply.code(400).send(badRequest('The condition does not match the Decision question', issues))
        const consumer = await gateConsumer(deps, orgId, integration, bot, req.params.channelId)
        if (!consumer || !canView(consumer.agent, ctxOf(req)))
          return reply.code(404).send(notFound('channel not found'))
        const target = targetOf(consumer.agent)
        const notApplied = (
          reason: 'off' | 'unsupported' | 'needs_review',
          readiness: GatePreview['readiness'],
          message?: string
        ): GatePreview => ({
          mode: 'live',
          readiness,
          evaluation: null,
          consumer: {
            type: 'gate',
            outcome: 'not_applied',
            notAppliedReason: reason,
            ...(message ? { reason: message } : {}),
            matched: false,
            matchedKeys: [],
            target
          }
        })
        const readiness = await decisionGateReadiness(deps, consumer.agent, bot, !!gate.steps?.length)
        if (integration.status === 'revoked' || consumer.integration.status === 'revoked')
          return notApplied('off', { status: readiness.status }, 'The integration is revoked.')
        if (readiness.status === 'unsupported')
          return notApplied('unsupported', { status: 'unsupported' }, readiness.reason)
        const saved = consumer.row.trigger === 'decision' ? consumer.row.decisionBinding : null
        if (consumer.row.decisionNeedsReview && saved && isDeepStrictEqual(saved, gate))
          return notApplied('needs_review', { status: 'needs_review' }, 'The Decision changed; review this condition.')
        if (readiness.status === 'daemon_offline') return reply.code(503).send(unavailable(OFFLINE, 'DAEMON_OFFLINE'))
        const daemonId = (await deps.placementResolver.servingDaemons(consumer.agent)).find((id) => readyConn(id))
        if (!daemonId) return reply.code(503).send(unavailable(OFFLINE, 'DAEMON_OFFLINE'))
        if (!readyConn(daemonId)?.capabilities?.features.includes(DECISION_PREVIEW_V1_FEATURE))
          return notApplied('unsupported', { status: 'unsupported' }, 'Upgrade the daemon to preview decisions.')
        const parsed = DecisionPreviewRequest.safeParse({
          agentId: consumer.agent.id,
          evaluationId: randomUUID(),
          decision: {
            name: decision.name,
            providerId: decision.providerId,
            model: decision.model,
            question: decision.question
          },
          state: gateSampleState(sample, { agentId: consumer.agent.id, conversationName: row.name ?? undefined })
        })
        if (!parsed.success) return reply.code(400).send(badRequest('The preview must fit within 32 KiB.'))
        // Fenced on both sides of the call: role, consumer visibility, serving placement, and the Decision itself.
        const authorized = async (): Promise<boolean> => {
          const role = await deps.repos.org.roleOf(orgId, ctxOf(req).userId)
          if (!role || role === 'viewer') return false
          const viewer = { ...ctxOf(req), role }
          const [current, stillVisible] = await Promise.all([
            deps.repos.agent.get(orgId, AgentId(consumer.agent.id)),
            Promise.all([...definitions!.keys()].map((id) => deps.repos.decision.get(orgId, id)))
          ])
          return (
            !!current &&
            canView(current, viewer) &&
            stillVisible.every((d) => !!d && canView(d, viewer)) &&
            (await deps.placementResolver.servingDaemons(current)).includes(daemonId)
          )
        }
        if (!(await authorized())) return reply.code(404).send(notFound('channel not found'))
        let evaluation: DecisionEvaluation
        let chain: DecisionChainTrace | undefined
        let matched = false
        let matchedKeys: string[] = []
        try {
          const deadlineAt = performance.timeOrigin + performance.now() + 5000
          const result = await runDecisionChain<DecisionGateStep>({
            root: gate,
            steps: gate.steps,
            deadlineAt,
            evaluate: async (step) => {
              if (!(await authorized())) return { status: 'unavailable', reason: 'credentials' }
              const d = definitions!.get(step.decisionId)!
              const request = DecisionPreviewRequest.safeParse({
                ...parsed.data,
                evaluationId: randomUUID(),
                decision: { name: d.name, providerId: d.providerId, model: d.model, question: d.question },
                ...(gate.steps?.length
                  ? { budgetMs: Math.max(1, Math.floor(deadlineAt - (performance.timeOrigin + performance.now()))) }
                  : {})
              })
              return request.success
                ? (await deps.control.decisionPreview(daemonId, orgId, request.data)).evaluation
                : { status: 'unavailable', reason: 'unsupported_input' }
            },
            next: (step, evaluation) => {
              const result = nextGateStep(definitions!.get(step.decisionId)!.question, step, evaluation.answer)
              matched = result.matched
              matchedKeys = result.matchedKeys
              return result.nextStepId ? [result.nextStepId] : []
            }
          })
          evaluation = result.evaluation
          if (gate.steps?.length) chain = result.trace
        } catch (err) {
          req.log.warn({ daemonId, error: (err as Error).name }, 'gate preview could not reach the serving daemon')
          return reply.code(503).send(unavailable('Decision preview is unavailable. Try again.'))
        }
        if (!(await authorized())) return reply.code(404).send(notFound('channel not found'))
        const result =
          evaluation.status === 'unavailable'
            ? gatePreviewOutcome(decision.question, gate.when, evaluation)
            : { evaluation, outcome: matched ? ('trigger' as const) : ('skip' as const), matched, matchedKeys }
        return {
          mode: 'live' as const,
          readiness: { status: readiness.status === 'pending_sync' ? ('pending_sync' as const) : ('ready' as const) },
          evaluation: result.evaluation,
          ...(chain ? { chain } : {}),
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

    // Every serving daemon that advertises the feature, in placement order; the first that serves the lane answers.
    const proxied = async <T>(
      req: FastifyRequest,
      reply: FastifyReply,
      conversation: ReadableConversation,
      read: (daemonId: string, agentId: string, integrationId: string) => Promise<T>
    ): Promise<{ ok: true; value: T } | { ok: false }> => {
      const agent = conversation.consumer.agent
      const ready = (await deps.placementResolver.servingDaemons(agent)).filter((id) => readyConn(id))
      if (ready.length === 0) {
        await reply.code(503).send(unavailable(OFFLINE, 'DAEMON_OFFLINE'))
        return { ok: false }
      }
      const capable = ready.filter((id) =>
        readyConn(id)?.capabilities?.features.includes(DECISION_EVALUATIONS_V1_FEATURE)
      )
      if (capable.length === 0) {
        await reply.code(503).send(unavailable(UNSUPPORTED, 'DAEMON_UPGRADE_REQUIRED'))
        return { ok: false }
      }
      let failure: unknown
      for (const daemonId of capable) {
        try {
          return { ok: true, value: await read(daemonId, agent.id, conversation.consumer.integration.id) }
        } catch (err) {
          const moved =
            err instanceof NoConnection ||
            err instanceof ConnectionClosed ||
            (err instanceof ProtocolError && err.code === 'SCOPE_DENIED')
          if (!moved) {
            failure = err
            req.log.warn(
              { daemonId, error: (err as Error).name },
              'decision evaluations read failed; trying the next daemon'
            )
          }
        }
      }
      if (failure !== undefined) throw failure
      await reply.code(503).send(unavailable(OFFLINE, 'DAEMON_OFFLINE'))
      return { ok: false }
    }

    // Runs after the daemon replies and before anything is returned; a refused reply is discarded unread and never logged.
    const audienceAllows = async (
      req: FastifyRequest<{ Params: { id: string; channelId: string } }>,
      reply: FastifyReply,
      asked: ReadableConversation,
      namespace: DecisionEvaluationConversation | undefined,
      opts: { bodies?: boolean } = {}
    ): Promise<boolean> => {
      const fresh = await readableConversation(deps, req, req.params.id, req.params.channelId)
      const sameLane =
        fresh?.consumer.agent.id === asked.consumer.agent.id &&
        fresh.consumer.integration.id === asked.consumer.integration.id
      if (!fresh || !sameLane) {
        await reply.code(404).send(notFound('conversation not found'))
        return false
      }
      // A reply that names no namespace cannot be scoped to its install, so it fails closed as an upgrade.
      if (!namespace) {
        await reply.code(503).send(unavailable(UNSUPPORTED, 'DAEMON_UPGRADE_REQUIRED'))
        return false
      }
      if (!(await conversationAudienceAllows(deps, req, fresh, namespace, opts))) {
        await reply.code(404).send(notFound('conversation not found'))
        return false
      }
      return true
    }

    r.get(
      '/integrations/:id/channels/:channelId/decision-evaluations',
      {
        schema: {
          tags: [Tag.Decisions],
          summary: 'List recent conversation evaluations',
          operationId: 'listIntegrationChannelDecisionEvaluations',
          description:
            "Recent By decision evaluations for one conversation, newest first, read from the serving daemon and proxied without being stored or logged. The caller must be able to read the conversation: the audience of its newest session in the namespace (platform and tenant scope) the serving daemon names for the install, or, before any session exists there, the organization baseline (closed while an external-access policy is active); the check runs on the reply before anything is returned. Pages by `cursor` (the previous page's `nextCursor`) up to 50 rows and 32 KiB. Returns 503 when the serving daemon is offline, including while its connection to the install has not yet reported the tenant scope, or must be upgraded, including a reply that names no namespace.",
          params: ConversationParams,
          querystring: z.object({
            cursor: z.coerce.number().int().positive().optional(),
            limit: z.coerce.number().int().min(1).max(50).default(20)
          }),
          response: { 200: DecisionEvaluationRecordPage, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const conversation = await readableConversation(deps, req, req.params.id, req.params.channelId)
        if (!conversation) return reply.code(404).send(notFound('conversation not found'))
        const result = await proxied(req, reply, conversation, (daemonId, agentId, integrationId) =>
          deps.control.decisionEvaluations(daemonId, orgOf(req), {
            agentId,
            integrationId,
            channel: req.params.channelId,
            ...(req.query.cursor !== undefined ? { cursor: req.query.cursor } : {}),
            limit: req.query.limit
          })
        )
        if (!result.ok) return reply
        const { conversation: namespace, ...page } = result.value
        if (!(await audienceAllows(req, reply, conversation, namespace))) return reply
        return page
      }
    )

    r.get(
      '/integrations/:id/channels/:channelId/decision-evaluations/:seq',
      {
        schema: {
          tags: [Tag.Decisions],
          summary: 'Get a conversation evaluation',
          operationId: 'getIntegrationChannelDecisionEvaluation',
          description:
            'One evaluation with its frozen Decision and condition snapshot, input and history, answer, model, usage, the raw provider request and response JSON (from daemons that support it, each capped at 16K characters), and evidence while the daemon still retains the bodies (bounded to 64 KiB); once stripped, `detailsExpired` is true and only the summary and snapshot remain. Proxied from the serving daemon, never stored or logged, and returned only after the conversation audience check on the namespace the daemon names for the install; before any session there names an audience the bodies need edit access to the consumer agent rather than the organization read baseline. Returns 404 when the evaluation is gone and 503 when the daemon is offline, including while its connection to the install has not yet reported the tenant scope, or must be upgraded, including a reply that names no namespace.',
          params: ConversationParams.extend({ seq: z.coerce.number().int().nonnegative() }),
          response: { 200: DecisionEvaluationRecordDetail, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const conversation = await readableConversation(deps, req, req.params.id, req.params.channelId)
        if (!conversation) return reply.code(404).send(notFound('conversation not found'))
        const result = await proxied(req, reply, conversation, (daemonId, agentId, integrationId) =>
          deps.control.decisionEvaluation(daemonId, orgOf(req), {
            agentId,
            integrationId,
            channel: req.params.channelId,
            seq: req.params.seq
          })
        )
        if (!result.ok) return reply
        if (!(await audienceAllows(req, reply, conversation, result.value.conversation, { bodies: true }))) return reply
        if (!result.value.evaluation) return reply.code(404).send(notFound('evaluation not found'))
        return result.value.evaluation
      }
    )
  }
}
