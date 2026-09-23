import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  DECISION_PREVIEW_V1_FEATURE,
  DECISION_PROVIDER_PROFILES,
  DecisionDraft,
  DecisionEvaluation,
  DecisionPreviewRequest,
  supportsDecision,
  type DecisionDefinition
} from '@agentconnect.md/protocol'
import { canEdit, canView } from '../../authorization/policy.js'
import { AgentId, DaemonId } from '../../domain/ids.js'
import { DecisionInUse } from '../../persistence/errors.js'
import type { AgentRecord, BotDecisionRoutingUsage, DecisionChannelUsage } from '../../persistence/ports.js'
import { convergeDecisionConsumers } from '../../orchestrator/integrationPush.js'
import type { HttpDeps } from '../deps.js'
import { visibleDecision } from '../decision-access.js'
import { ErrorDto } from '../dto/index.js'
import { Tag } from '../plugins/openapi.js'
import type { ZodTypeProvider } from '../plugins/zod.js'
import { ctxOf, denyViewerWrite, orgOf } from '../rbac.js'
import { resolveShareSet } from '../sharing.js'

const DefinitionDto = z.object({
  ...DecisionDraft.shape,
  id: z.string(),
  orgId: z.string(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  canEdit: z.boolean()
})
const IdParam = z.object({ id: z.string().uuid() })
const UsageDto = z.object({
  kind: z.enum(['gate', 'shared_bot_routing', 'agent_tool', 'model_selection']),
  id: z.string(),
  label: z.string(),
  integrationId: z.string().optional(),
  channelId: z.string().optional()
})
const DecisionInUseDto = ErrorDto.extend({ usages: z.array(UsageDto), hiddenUsageCount: z.number().int() })
const ReadinessDto = z.object({
  status: z.enum(['ready', 'pending_sync', 'missing_credentials', 'daemon_offline', 'unsupported'])
})
const ProviderDto = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  daemonId: z.string(),
  daemonName: z.string(),
  pool: z.boolean(),
  memberSetId: z.string().nullable(),
  source: z.enum(['byok', 'ac_credits']).nullable(),
  readiness: ReadinessDto,
  models: z.array(
    z.object({ id: z.string(), label: z.string(), questionTypes: z.array(z.enum(['boolean', 'choice', 'score'])) })
  )
})
const UpdateBody = z.strictObject({
  ...DecisionDraft.shape,
  visibility: z.enum(['org', 'restricted']).optional(),
  sharedWith: z.array(z.string().min(1).max(128)).max(1000).optional()
})
const PreviewBody = z
  .strictObject({
    decision: DecisionDraft,
    daemonId: z.string().uuid().optional(),
    target: z
      .discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('daemon'), daemonId: z.string().uuid() }),
        z.strictObject({ kind: z.literal('pool') }),
        z.strictObject({ kind: z.literal('set'), setId: z.string().uuid() })
      ])
      .optional(),
    state: z.record(z.string(), z.unknown()),
    consumer: z.strictObject({ type: z.literal('none') })
  })
  .refine((input) => !!input.daemonId !== !!input.target, 'Select exactly one execution target.')
const PreviewDto = z.object({
  mode: z.literal('live'),
  readiness: ReadinessDto,
  evaluation: DecisionEvaluation,
  consumer: z.null()
})
const notFound = { error: 'Not Found', statusCode: 404, message: 'Decision or execution resource not found.' }
const unavailable = {
  error: 'Service Unavailable',
  statusCode: 503,
  message: 'Decision preview is unavailable. Check the selected execution target and try again.'
}
const invalidModel = {
  error: 'Bad Request',
  statusCode: 400,
  message: 'Unsupported Decision provider, model, or question type.'
}
const invalidAudience = {
  error: 'Bad Request',
  statusCode: 400,
  message: 'Select at least one current organization member.'
}

export function decisionRoutes(deps: HttpDeps) {
  return async function decisionRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()
    const dto = (row: DecisionDefinition, req: FastifyRequest) => ({ ...row, canEdit: canEdit(row, ctxOf(req)) })
    const visible = (req: FastifyRequest, id: string) => visibleDecision(deps, req, id)
    // Channel gates on these Decisions whose agent the caller can see, one per shared-bot conversation.
    const visibleUsages = async (req: FastifyRequest, decisionIds?: readonly string[]) => {
      const all = await deps.repos.integrationChannel.listDecisionUsages(orgOf(req), decisionIds)
      if (all.length === 0) return { all, visible: [] as Array<DecisionChannelUsage & { agentName: string }> }
      const agents = new Map((await deps.repos.agent.list(orgOf(req), ctxOf(req))).map((a) => [a.id, a]))
      const seen = new Set<string>()
      const shown: Array<DecisionChannelUsage & { agentName: string }> = []
      for (const usage of all) {
        const agent = agents.get(usage.agentId)
        if (!agent) continue
        const key = `${usage.decisionId}\u0000${usage.botId}\u0000${usage.channelId}`
        if (seen.has(key)) continue
        seen.add(key)
        shown.push({ ...usage, agentName: agent.displayName || agent.name })
      }
      return { all, visible: shown }
    }
    const usageDto = (u: DecisionChannelUsage & { agentName: string }) => ({
      kind: 'gate' as const,
      id: `${u.integrationId}:${u.channelId}`,
      label: `#${u.channelName ?? u.channelId} · ${u.agentName}`,
      integrationId: u.integrationId,
      channelId: u.channelId
    })
    // Shared-bot routers on these Decisions, visible when the caller can see at least one of the bot's agents.
    const routingUsages = async (req: FastifyRequest, decisionIds?: readonly string[]) => {
      const all = await deps.repos.botDecisionRouting.listUsages(orgOf(req), decisionIds)
      if (all.length === 0) return { all, visible: [] as BotDecisionRoutingUsage[] }
      const agents = new Set((await deps.repos.agent.list(orgOf(req), ctxOf(req))).map((a) => a.id))
      return { all, visible: all.filter((usage) => usage.agentIds.some((id) => agents.has(id))) }
    }
    const routingUsageDto = (u: BotDecisionRoutingUsage) => ({
      kind: 'shared_bot_routing' as const,
      id: u.botId,
      label: u.botName
    })
    // Distinct conversations, counted across sibling rows the same way as the visible set.
    const conversationCount = (usages: readonly DecisionChannelUsage[]) =>
      new Set(usages.map((u) => `${u.botId}\u0000${u.channelId}`)).size
    const agentReferences = (agents: readonly AgentRecord[]) =>
      agents.flatMap((agent) => [
        ...(agent.modelSelection
          ? [
              {
                decisionId: agent.modelSelection.decisionId,
                kind: 'model_selection' as const,
                id: agent.id,
                label: agent.displayName ?? agent.name
              }
            ]
          : []),
        ...(agent.decisionIds ?? []).map((decisionId) => ({
          decisionId,
          kind: 'agent_tool' as const,
          id: agent.id,
          label: agent.displayName ?? agent.name
        }))
      ])
    const agentUsages = async (req: FastifyRequest) =>
      agentReferences(await deps.repos.agent.list(orgOf(req), ctxOf(req)))
    // A preview borrows a visible placed agent's credential identity without executing that agent.
    const executionAgent = async (req: FastifyRequest, daemonId: string) => {
      const agents = await deps.repos.agent.list(orgOf(req), ctxOf(req))
      for (const agent of agents) {
        if ((await deps.placementResolver.routableDaemons(agent)).includes(daemonId)) return agent
      }
      return null
    }
    const catalog = async (
      req: FastifyRequest,
      scope: { daemonId?: string; setId?: string } = {}
    ): Promise<z.infer<typeof ProviderDto>[]> => {
      const daemons = (await deps.registry.listAvailable(orgOf(req), ctxOf(req))).filter(
        (daemon) =>
          (!scope.daemonId || daemon.daemonId === scope.daemonId) &&
          (!scope.setId || daemon.memberSetId === scope.setId)
      )
      const keys = await deps.repos.providerKey.list(orgOf(req))
      const result: z.infer<typeof ProviderDto>[] = []
      for (const daemon of daemons) {
        const conn = deps.daemonConns.get(daemon.daemonId)
        let status: 'ready' | 'daemon_offline' | 'unsupported' | 'pending_sync' =
          conn?.state !== 'READY'
            ? 'daemon_offline'
            : conn.capabilities?.features.includes(DECISION_PREVIEW_V1_FEATURE)
              ? 'ready'
              : 'unsupported'
        let profiles = DECISION_PROVIDER_PROFILES.map((profile) => ({ ...profile, cloudAvailable: false }))
        if (status === 'ready') {
          try {
            profiles = (await deps.control.decisionCatalog(daemon.daemonId, orgOf(req))).providers
          } catch {
            status = 'daemon_offline'
          }
          if (status === 'ready' && !(await executionAgent(req, daemon.daemonId))) status = 'pending_sync'
        }
        for (const profile of profiles) {
          const source = keys.some((key) => key.provider === profile.id)
            ? 'byok'
            : profile.cloudAvailable
              ? 'ac_credits'
              : null
          result.push({
            id: profile.id,
            name: profile.name,
            kind: profile.kind,
            models: profile.models,
            daemonId: daemon.daemonId,
            daemonName: daemon.name ?? daemon.daemonId,
            pool: daemon.orgId === null,
            memberSetId: daemon.memberSetId,
            source,
            readiness: { status: status === 'ready' && !source ? 'missing_credentials' : status }
          })
        }
      }
      return result
    }

    r.get(
      '/decisions/providers',
      {
        schema: {
          tags: [Tag.Decisions],
          summary: 'List Decision providers',
          operationId: 'listDecisionProviders',
          description:
            'Authorized daemon capabilities and organization credential readiness. Does not decrypt keys or make provider calls.',
          querystring: z.object({ daemonId: z.string().uuid().optional() }),
          response: { 200: z.array(ProviderDto) }
        }
      },
      (req) => catalog(req, req.query)
    )

    r.get(
      '/decisions',
      {
        schema: {
          tags: [Tag.Decisions],
          summary: 'List Decisions',
          operationId: 'listDecisions',
          description:
            'Lists reusable Decision definitions visible to the caller, each with the number of visible consumers: conversations it gates, shared-bot routers, and agents. Message consumers are not enabled by saving a definition.',
          response: { 200: z.array(DefinitionDto.extend({ usageCount: z.number().int() })) }
        }
      },
      async (req) => {
        const [rows, agents] = await Promise.all([deps.repos.decision.list(orgOf(req), ctxOf(req)), agentUsages(req)])
        const ids = rows.map((row) => row.id)
        const [{ visible: gates }, { visible: routers }] = await Promise.all([
          visibleUsages(req, ids),
          routingUsages(req, ids)
        ])
        const counts = new Map<string, number>()
        for (const usage of [...gates, ...routers, ...agents])
          counts.set(usage.decisionId, (counts.get(usage.decisionId) ?? 0) + 1)
        return rows.map((row) => ({ ...dto(row, req), usageCount: counts.get(row.id) ?? 0 }))
      }
    )

    r.get(
      '/decisions/:id',
      {
        schema: {
          tags: [Tag.Decisions],
          summary: 'Get a Decision',
          operationId: 'getDecision',
          description:
            'Returns a visible Decision and its visible consumers: each By decision conversation gate whose agent the caller can see, each shared-bot router whose bot connects an agent the caller can see, and each agent that uses it.',
          params: IdParam,
          response: { 200: z.object({ decision: DefinitionDto, usages: z.array(UsageDto) }), 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const row = await visible(req, req.params.id)
        if (!row) return reply.code(404).send(notFound)
        const { visible: gates } = await visibleUsages(req, [row.id])
        const { visible: routers } = await routingUsages(req, [row.id])
        const agents = (await agentUsages(req)).filter((usage) => usage.decisionId === row.id)
        return {
          decision: dto(row, req),
          usages: [
            ...gates.map(usageDto),
            ...routers.map(routingUsageDto),
            ...agents.map(({ decisionId: _decisionId, ...usage }) => usage)
          ]
        }
      }
    )

    r.post(
      '/decisions',
      {
        schema: {
          tags: [Tag.Decisions],
          summary: 'Create a Decision',
          operationId: 'createDecision',
          description: 'Saves a reusable typed question independently of daemon availability or message triggers.',
          body: DecisionDraft,
          response: { 201: DefinitionDto, 400: ErrorDto, 403: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        if (!supportsDecision(req.body)) return reply.code(400).send(invalidModel)
        const sharedWith = await resolveShareSet(deps.repos.user, orgOf(req), req.body.sharedWith)
        const draft = DecisionDraft.safeParse({ ...req.body, sharedWith })
        if (!draft.success) return reply.code(400).send(invalidAudience)
        return reply.code(201).send(dto(await deps.repos.decision.create(orgOf(req), draft.data, ctxOf(req)), req))
      }
    )

    r.patch(
      '/decisions/:id',
      {
        schema: {
          tags: [Tag.Decisions],
          summary: 'Update a Decision',
          operationId: 'updateDecision',
          description:
            'Replaces the definition atomically. Omitted visibility and selected members preserve the current audience. Revalidates every By decision conversation gate, marks incompatible ones Needs review (disabled, condition preserved), and re-pushes affected routing.',
          params: IdParam,
          body: UpdateBody,
          response: { 200: DefinitionDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const existing = await visible(req, req.params.id)
        if (!existing) return reply.code(404).send(notFound)
        if (!supportsDecision(req.body)) return reply.code(400).send(invalidModel)
        const input = {
          ...req.body,
          ...(req.body.sharedWith !== undefined
            ? {
                sharedWith: await resolveShareSet(deps.repos.user, orgOf(req), req.body.sharedWith)
              }
            : {})
        }
        const checked = DecisionDraft.safeParse({
          ...input,
          visibility: input.visibility ?? existing.visibility,
          sharedWith: input.sharedWith ?? existing.sharedWith
        })
        if (!checked.success) return reply.code(400).send(invalidAudience)
        const result = await deps.repos.decision.update(orgOf(req), req.params.id, input, ctxOf(req))
        if (!result) return reply.code(404).send(notFound)
        await convergeDecisionConsumers(deps, result.consumerIntegrationIds, req.log, result.consumerBotIds)
        return dto(result.decision, req)
      }
    )

    r.delete(
      '/decisions/:id',
      {
        schema: {
          tags: [Tag.Decisions],
          summary: 'Delete a Decision',
          operationId: 'deleteDecision',
          description:
            'Deletes a visible definition. Refused with 409 while a conversation gate, a shared-bot router, or an agent still references it: usages lists what the caller can see and hiddenUsageCount counts the conversations, routers, and agents it cannot.',
          params: IdParam,
          response: { 204: z.null(), 403: ErrorDto, 404: ErrorDto, 409: DecisionInUseDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        if (!(await visible(req, req.params.id))) return reply.code(404).send(notFound)
        const inUse = async () => {
          const { all, visible: shown } = await visibleUsages(req, [req.params.id])
          const routing = await routingUsages(req, [req.params.id])
          const agents = (await agentUsages(req)).filter((usage) => usage.decisionId === req.params.id)
          // Org-wide references count agents the caller cannot see, so the refusal never reads as unused.
          const referencing = new Set(
            agentReferences(await deps.repos.agent.list(orgOf(req)))
              .filter((usage) => usage.decisionId === req.params.id)
              .map((usage) => usage.id)
          )
          const hiddenAgents = [...referencing].filter((id) => !agents.some((usage) => usage.id === id)).length
          const conversations = conversationCount(all)
          const routers = routing.all.length
          const parts = [
            ...(conversations ? [`${conversations} conversation${conversations === 1 ? '' : 's'}`] : []),
            ...(routers ? [`${routers} shared bot${routers === 1 ? '' : 's'}`] : []),
            ...(referencing.size ? [`${referencing.size} agent${referencing.size === 1 ? '' : 's'}`] : [])
          ]
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: parts.length
              ? `This Decision is used by ${parts.join(' and ')}.`
              : 'This Decision is still in use.',
            usages: [
              ...shown.map(usageDto),
              ...routing.visible.map(routingUsageDto),
              ...agents.map(({ decisionId: _decisionId, ...usage }) => usage)
            ],
            hiddenUsageCount:
              Math.max(0, conversations - shown.length) + (routers - routing.visible.length) + hiddenAgents
          })
        }
        if (
          (await deps.repos.integrationChannel.listDecisionUsages(orgOf(req), [req.params.id])).length > 0 ||
          (await deps.repos.botDecisionRouting.listUsages(orgOf(req), [req.params.id])).length > 0
        )
          return inUse()
        try {
          await deps.repos.decision.delete(orgOf(req), req.params.id, ctxOf(req))
        } catch (err) {
          // An agent attachment, or a gate saved between the pre-check and the delete (the FK refuses it).
          if (err instanceof DecisionInUse) return inUse()
          throw err
        }
        return reply.code(204).send(null)
      }
    )

    r.post(
      '/decisions/preview',
      {
        bodyLimit: 40 * 1024,
        schema: {
          tags: [Tag.Decisions],
          summary: 'Try a Decision',
          operationId: 'previewDecision',
          description:
            'Evaluates a draft and bounded sample state on an authorized daemon, resolving pool or organization group targets within their current ready members. Does not create a session or store sample content.',
          body: PreviewBody,
          response: { 200: PreviewDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const { decision, state } = req.body
        if (!supportsDecision(decision)) return reply.code(400).send(invalidModel)
        const target = req.body.target ?? { kind: 'daemon' as const, daemonId: req.body.daemonId! }
        let daemonId: string
        let setId: string | null = null
        if (target.kind === 'daemon') {
          daemonId = target.daemonId
        } else {
          const set = target.kind === 'set' ? await deps.repos.memberSet.get(target.setId) : null
          setId =
            target.kind === 'pool'
              ? await deps.repos.memberSet.crossOrgSetId()
              : set?.orgId === orgOf(req)
                ? set.id
                : null
          if (!setId) return reply.code(404).send(notFound)
          const provider = (await catalog(req, { setId })).find(
            (entry) =>
              entry.id === decision.providerId &&
              entry.readiness.status === 'ready' &&
              entry.models.some(
                (model) => model.id === decision.model && model.questionTypes.includes(decision.question.type)
              )
          )
          if (!provider) return reply.code(503).send(unavailable)
          daemonId = provider.daemonId
        }
        const daemon = await deps.registry.getAvailable(orgOf(req), DaemonId(daemonId))
        if (!daemon || !canView(daemon, ctxOf(req))) return reply.code(404).send(notFound)
        const agent = await executionAgent(req, daemonId)
        if (!agent) return reply.code(503).send(unavailable)
        const parsed = DecisionPreviewRequest.safeParse({
          agentId: agent.id,
          evaluationId: randomUUID(),
          decision,
          state
        })
        if (!parsed.success)
          return reply
            .code(400)
            .send({ error: 'Bad Request', statusCode: 400, message: 'The preview must fit within 32 KiB.' })
        const input = parsed.data
        const authorized = async () => {
          const role = await deps.repos.org.roleOf(orgOf(req), ctxOf(req).userId)
          if (!role || role === 'viewer') return false
          const viewer = { ...ctxOf(req), role }
          const [currentAgent, currentDaemon] = await Promise.all([
            deps.repos.agent.get(orgOf(req), AgentId(agent.id)),
            deps.registry.getAvailable(orgOf(req), DaemonId(daemonId))
          ])
          return (
            !!currentAgent &&
            canView(currentAgent, viewer) &&
            !!currentDaemon &&
            canView(currentDaemon, viewer) &&
            (!setId || currentDaemon.memberSetId === setId) &&
            (await deps.placementResolver.routableDaemons(currentAgent)).includes(daemonId)
          )
        }
        if (!(await authorized())) return reply.code(404).send(notFound)
        let result
        try {
          result = await deps.control.decisionPreview(daemonId, orgOf(req), input)
        } catch {
          return reply.code(503).send(unavailable)
        }
        if (!(await authorized())) return reply.code(404).send(notFound)
        return {
          mode: 'live' as const,
          readiness: { status: 'ready' as const },
          evaluation: result.evaluation,
          consumer: null
        }
      }
    )
  }
}
