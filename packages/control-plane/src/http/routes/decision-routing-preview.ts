import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  DECISION_PREVIEW_V1_FEATURE,
  DECISION_CHAIN_V1_FEATURE,
  DecisionChainTrace,
  runDecisionChain,
  matchDecisionCondition,
  type DecisionRoutingStep,
  type DecisionAnswer,
  type DecisionQuestion,
  DecisionEvaluation,
  DecisionPreviewRequest,
  DecisionPreviewSample,
  SharedBotDecisionRouting,
  decisionRoutingIssues,
  manifestFor,
  partitionRoutingConstraint,
  settleRoutingPreview,
  supportsDecision,
  type RoutingCandidate,
  type RoutingConstraintInput
} from '@agentconnect.md/protocol'
import { canView } from '../../authorization/policy.js'
import { routingNotApplied, routingSampleState } from '../../domain/decision-routing-preview.js'
import { AgentId, BotId } from '../../domain/ids.js'
import type { AgentRecord } from '../../persistence/ports.js'
import { gateConsumer, visibleDecisionChain } from '../decision-access.js'
import type { HttpDeps } from '../deps.js'
import { ErrorDto } from '../dto/index.js'
import { Tag } from '../plugins/openapi.js'
import type { ZodTypeProvider } from '../plugins/zod.js'
import { routingHostMembers } from '../routing-host.js'
import { ctxOf, denyViewerWrite, orgOf } from '../rbac.js'

const IdParam = z.object({ id: z.string().uuid() })
const unique = (values: readonly string[]) => new Set(values).size === values.length
const AgentIds = z.array(z.string().uuid()).min(1).max(16).refine(unique, 'Recipients must be unique.')
const Targets = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('new') }),
  z
    .strictObject({
      type: z.enum(['mention', 'thread']),
      agentIds: AgentIds,
      participantAgentIds: z.array(z.string().uuid()).max(16).default([])
    })
    .refine((t) => t.participantAgentIds.every((id) => t.agentIds.includes(id)), {
      path: ['participantAgentIds'],
      message: 'Participants must be selected recipients.'
    })
])
const PreviewBody = z.strictObject({
  config: SharedBotDecisionRouting,
  channelIds: z.array(z.string().min(1).max(512)).max(1000).refine(unique, 'Channels must be unique.'),
  channelId: z.string().min(1).max(512),
  targets: Targets,
  state: DecisionPreviewSample
})
const Issue = z.object({ path: z.array(z.union([z.string(), z.number()])), message: z.string() })
const IssuesErrorDto = ErrorDto.extend({ issues: z.array(Issue).optional(), code: z.string().optional() })
const Effect = z.enum(['participant', 'kept', 'selected', 'default_agent', 'fallback_constrained', 'fallback_default'])
const RoutingPreviewDto = z.object({
  mode: z.literal('live'),
  readiness: z.object({ status: z.enum(['ready', 'pending_sync', 'needs_review', 'unsupported']) }),
  evaluation: DecisionEvaluation.nullable(),
  chain: DecisionChainTrace.optional(),
  consumer: z.object({
    type: z.literal('shared_bot_routing'),
    outcome: z.enum(['activate', 'continue', 'skip', 'unavailable', 'not_applied']),
    notAppliedReason: z.enum(['off', 'outside_scope', 'paused', 'needs_review', 'unsupported']).optional(),
    reason: z.string().optional(),
    evaluated: z.boolean(),
    rules: z.array(z.object({ ruleId: z.string(), matched: z.boolean(), matchedKeys: z.array(z.string()) })),
    matchedRuleIds: z.array(z.string()),
    matchedKeys: z.array(z.string()),
    matchedAgentIds: z.array(z.string()),
    usedOtherwise: z.boolean(),
    fallback: z.enum(['constrained', 'default', 'none']).nullable(),
    defaultAgent: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
    targetConstraint: z.union([
      z.object({ type: z.literal('new') }),
      z.object({
        type: z.enum(['mention', 'thread']),
        agentIds: z.array(z.string()),
        participantAgentIds: z.array(z.string()).optional()
      })
    ]),
    targets: z.array(
      z.object({
        agentId: z.string(),
        name: z.string().nullable(),
        effect: Effect,
        participant: z.boolean(),
        via: z.enum(['mention', 'implicit']),
        status: z.enum(['available', 'unavailable', 'removed'])
      })
    )
  })
})
type RoutingPreview = z.infer<typeof RoutingPreviewDto>

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
const OFFLINE = 'the evaluation host daemon is offline'

export function decisionRoutingPreviewRoutes(deps: HttpDeps) {
  return async function decisionRoutingPreviewRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()
    const readyConn = (daemonId: string) => {
      const conn = deps.daemonConns.get(daemonId)
      return conn?.state === 'READY' ? conn : undefined
    }
    const nameOf = (agent: AgentRecord) => agent.displayName || agent.name

    r.post(
      '/bots/:id/decision-routing/preview',
      {
        bodyLimit: 40 * 1024,
        schema: {
          tags: [Tag.Decisions],
          summary: 'Try shared-bot routing',
          operationId: 'previewBotDecisionRouting',
          description:
            "Evaluates a draft routing configuration and draft channel scope against a sample on the bot's evaluation host, for one channel and situation (a new conversation, an explicit mention, or an established thread with participant flags), then settles the targets exactly as the router does: every matched rule's agent, deduplicated, or Otherwise; a constrained situation keeps its recipients or skips. Writes nothing and never stores or logs the sample. Off, outside-scope, paused, Needs review, and unsupported configurations return `not_applied` with the reason and no model call; a situation whose recipients all participate settles with no model call. Returns 503 when the evaluation host is offline or unreachable; a provider failure returns `unavailable` with its continuation, which is never a skip.",
          params: IdParam,
          body: PreviewBody,
          response: { 200: RoutingPreviewDto, 400: IssuesErrorDto, 403: ErrorDto, 404: IssuesErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const orgId = orgOf(req)
        const { config, channelIds, channelId, targets: situation, state: sample } = req.body
        const bot = await deps.repos.bot.get(orgId, BotId(req.params.id))
        if (!bot) return reply.code(404).send(notFound('bot not found'))
        if (bot.transport !== 'http' || !bot.shareable)
          return reply.code(400).send(badRequest('Routing requires a shared bot.'))
        if (manifestFor(bot.platform).ownerAsDefault)
          return reply.code(400).send(badRequest('By decision is not available for this platform'))
        // Visible bot members only: an invisible one is never named, used, or distinguished from a non-member.
        const members = new Map<string, AgentRecord>()
        for (const id of bot.agentIds) {
          const agent = await deps.repos.agent.get(orgId, id)
          if (agent && canView(agent, ctxOf(req))) members.set(agent.id, agent)
        }
        if (members.size === 0) return reply.code(404).send(notFound('bot not found'))
        const [installs, rows] = await Promise.all([
          deps.repos.integration.listForBot(bot.id),
          deps.repos.integrationChannel.listForBot(bot.id)
        ])
        const conversation = rows.filter((row) => row.channelId === channelId)
        if (conversation.length === 0) return reply.code(404).send(notFound('channel not found'))
        if (conversation.some((row) => row.kind === 'im'))
          return reply.code(400).send(badRequest('By decision applies only to group conversations'))
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
        if (issues.length > 0) return reply.code(400).send(badRequest('The routing configuration is invalid.', issues))
        const recipients = situation.type === 'new' ? [] : situation.agentIds
        if (recipients.some((id) => !members.has(id)))
          return reply
            .code(400)
            .send(
              badRequest('Choose recipients connected to this bot.', [
                { path: ['targets'], message: 'Choose recipients connected to this bot.' }
              ])
            )

        const description = await deps.httpBot.describeRouting(bot)
        const described = description.channels.find((c) => c.channelId === channelId)
        const install = installs.find((i) => i.status !== 'revoked') ?? installs[0]
        const owner = install ? await gateConsumer(deps, orgId, install, bot, channelId) : null
        const defaultAgentId = described?.defaultAgentId ?? owner?.agent.id ?? null
        const defaultAgent = defaultAgentId
          ? { id: defaultAgentId, name: members.has(defaultAgentId) ? nameOf(members.get(defaultAgentId)!) : null }
          : null
        const hostId = described?.evaluationDaemonId ?? description.evaluationHost?.daemonId ?? null
        const readiness = {
          status: description.readiness.status === 'pending_sync' ? 'pending_sync' : 'ready'
        } as const

        const blank = (): RoutingPreview['consumer'] => ({
          type: 'shared_bot_routing',
          outcome: 'not_applied',
          evaluated: false,
          rules: [],
          matchedRuleIds: [],
          matchedKeys: [],
          matchedAgentIds: [],
          usedOtherwise: false,
          fallback: null,
          defaultAgent,
          targetConstraint: situation,
          targets: []
        })
        const notApplied = (
          reason: NonNullable<RoutingPreview['consumer']['notAppliedReason']>,
          message?: string
        ): RoutingPreview => ({
          mode: 'live',
          readiness:
            reason === 'needs_review'
              ? { status: 'needs_review' }
              : reason === 'unsupported'
                ? { status: 'unsupported' }
                : readiness,
          evaluation: null,
          consumer: { ...blank(), notAppliedReason: reason, ...(message ? { reason: message } : {}) }
        })
        const unsupported =
          description.relay === 'unsupported'
            ? 'Upgrade the relay to use By decision routing.'
            : description.evaluationHost?.status === 'unsupported'
              ? 'The evaluation host daemon does not support By decision routing yet.'
              : null
        const reason = routingNotApplied({
          // Saving the draft turns an in-scope Off channel to By decision, so only an unrouted one previews as Off.
          channelOff: !channelIds.includes(channelId) && conversation.some((row) => row.trigger === 'off'),
          inScope: channelIds.includes(channelId),
          enabled: config.enabled,
          savedNeedsReview: description.record?.needsReview === true,
          draftIsSaved: !!description.record && isDeepStrictEqual(description.record.config, config),
          unsupported: unsupported !== null
        })
        if (reason) return notApplied(reason, reason === 'unsupported' ? (unsupported ?? undefined) : undefined)

        // Each visible member at its first ready serving daemon; a member with none is Target unavailable.
        const candidates: RoutingCandidate[] = []
        const ready = new Set<string>()
        for (const agent of members.values()) {
          const serving = await deps.placementResolver.servingDaemons(agent)
          const daemonId = serving.find((id) => readyConn(id))
          const integration = installs.find((i) => i.agentId === agent.id && i.status !== 'revoked')
          if (daemonId) ready.add(agent.id)
          candidates.push({
            agentId: agent.id,
            daemonId: daemonId ?? serving[0] ?? '',
            ...(integration ? { integrationId: integration.id } : {})
          })
        }
        const constraint: RoutingConstraintInput[] =
          situation.type === 'new'
            ? []
            : situation.agentIds.map((agentId) => ({
                agentId,
                participant: situation.participantAgentIds.includes(agentId),
                daemonId: candidates.find((c) => c.agentId === agentId)?.daemonId ?? null,
                via: situation.type === 'mention' ? 'mention' : 'implicit'
              }))
        const answers = new Map<string, { question: DecisionQuestion; answer: DecisionAnswer }>()
        let chain: DecisionChainTrace | undefined
        const settle = (answer: Parameters<typeof settleRoutingPreview>[0]['answer']) =>
          settleRoutingPreview({
            question: decision.question,
            routing: config,
            answer,
            constraint,
            ...(defaultAgentId ? { defaultAgentId } : {}),
            candidates,
            chain: answers
          })
        const result = (settled: ReturnType<typeof settle>, evaluation: DecisionEvaluation | null): RoutingPreview => ({
          mode: 'live',
          readiness,
          ...(chain ? { chain } : {}),
          evaluation:
            settled.reason === 'invalid_response' ? { status: 'unavailable', reason: 'invalid_response' } : evaluation,
          consumer: {
            ...blank(),
            outcome: settled.outcome,
            ...(settled.outcome === 'unavailable'
              ? { reason: settled.reason ?? (evaluation?.status === 'unavailable' ? evaluation.reason : 'provider') }
              : {}),
            evaluated: settled.evaluate,
            rules: settled.rules,
            matchedRuleIds: settled.match?.matchedRuleIds ?? [],
            matchedKeys: settled.match?.matchedKeys ?? [],
            matchedAgentIds: settled.match?.agentIds ?? [],
            usedOtherwise: settled.match?.usedOtherwise ?? false,
            fallback: settled.fallback ?? null,
            targets: settled.targets.map((t) => {
              const member = members.get(t.agentId)
              return {
                agentId: t.agentId,
                name: member ? nameOf(member) : null,
                effect: t.effect,
                participant: t.participant,
                via: t.via,
                status: !member ? 'removed' : ready.has(t.agentId) ? 'available' : 'unavailable'
              }
            })
          }
        })
        if (!partitionRoutingConstraint(constraint).evaluate) return result(settle(undefined), null)

        if (!hostId || !readyConn(hostId)) return reply.code(503).send(unavailable(OFFLINE, 'DAEMON_OFFLINE'))
        if (!readyConn(hostId)?.capabilities?.features.includes(DECISION_PREVIEW_V1_FEATURE))
          return notApplied('unsupported', 'Upgrade the evaluation host daemon to preview decisions.')
        if (config.steps?.length && !readyConn(hostId)?.capabilities?.features.includes(DECISION_CHAIN_V1_FEATURE))
          return notApplied('unsupported', 'Upgrade the evaluation host daemon to use Decision chains.')
        const executor = (await routingHostMembers(deps, req, bot, hostId, defaultAgentId)).find((m) =>
          members.has(m.agent.id)
        )
        if (!executor) return reply.code(503).send(unavailable(OFFLINE, 'DAEMON_OFFLINE'))
        const parsed = DecisionPreviewRequest.safeParse({
          agentId: executor.agent.id,
          evaluationId: randomUUID(),
          decision: {
            name: decision.name,
            providerId: decision.providerId,
            model: decision.model,
            question: decision.question
          },
          state: routingSampleState(sample, situation, { conversationName: conversation[0]?.name ?? undefined })
        })
        if (!parsed.success) return reply.code(400).send(badRequest('The preview must fit within 32 KiB.'))
        // Fenced on both sides of the call: role, bot visibility, the Decision, and the host still serving the member.
        const authorized = async (): Promise<boolean> => {
          const role = await deps.repos.org.roleOf(orgId, ctxOf(req).userId)
          if (!role || role === 'viewer') return false
          const viewer = { ...ctxOf(req), role }
          const [fresh, stillVisible, current] = await Promise.all([
            deps.repos.bot.get(orgId, bot.id),
            Promise.all([...definitions!.keys()].map((id) => deps.repos.decision.get(orgId, id))),
            deps.repos.agent.get(orgId, AgentId(executor.agent.id))
          ])
          if (!fresh || stillVisible.some((d) => !d || !canView(d, viewer)) || !current || !canView(current, viewer))
            return false
          if (!fresh.agentIds.includes(current.id)) return false
          return (await deps.placementResolver.servingDaemons(current)).includes(hostId)
        }
        if (!(await authorized())) return reply.code(404).send(notFound('bot not found'))
        let evaluation: DecisionEvaluation
        try {
          const deadlineAt = performance.timeOrigin + performance.now() + 5000
          const result = await runDecisionChain<DecisionRoutingStep>({
            root: config,
            steps: config.steps,
            deadlineAt,
            evaluate: async (step) => {
              if (!(await authorized())) return { status: 'unavailable', reason: 'credentials' }
              const d = definitions!.get(step.decisionId)!
              const request = DecisionPreviewRequest.safeParse({
                ...parsed.data,
                evaluationId: randomUUID(),
                decision: { name: d.name, providerId: d.providerId, model: d.model, question: d.question },
                ...(config.steps?.length
                  ? { budgetMs: Math.max(1, Math.floor(deadlineAt - (performance.timeOrigin + performance.now()))) }
                  : {})
              })
              return request.success
                ? (await deps.control.decisionPreview(hostId, orgId, request.data)).evaluation
                : { status: 'unavailable', reason: 'unsupported_input' }
            },
            next: (step, result) => {
              const question = definitions!.get(step.decisionId)!.question
              const id = config.steps?.find((s) => s === step)?.id
              if (id) answers.set(id, { question, answer: result.answer })
              return step.rules.flatMap((rule) =>
                rule.action.type === 'decision' && matchDecisionCondition(question, rule.when, result.answer).matched
                  ? [rule.action.nextStepId]
                  : []
              )
            }
          })
          evaluation = result.evaluation
          if (config.steps?.length) chain = result.trace
        } catch (err) {
          req.log.warn({ daemonId: hostId, error: (err as Error).name }, 'routing preview could not reach the host')
          return reply.code(503).send(unavailable('Routing preview is unavailable. Try again.'))
        }
        if (!(await authorized())) return reply.code(404).send(notFound('bot not found'))
        return result(settle(evaluation.status === 'answered' ? evaluation.answer : 'unavailable'), evaluation)
      }
    )
  }
}
