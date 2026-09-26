import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  CodeHostRoutingFamily,
  CodeHostRoutingProvider,
  DECISION_EVALUATIONS_V1_FEATURE,
  DECISION_EVALUATION_FILTER_V1_FEATURE,
  DecisionEvaluationRecordDetail,
  DecisionEvaluationRecordPage,
  SharedBotDecisionRouting,
  isCodeHostRoutingScope,
  supportsDecision,
  type DecisionValidationIssue
} from '@agentconnect.md/protocol'
import { codeHostsOf } from '../../codehost/registry.js'
import { canEdit, canView } from '../../authorization/policy.js'
import { ProtocolError } from '../../domain/errors.js'
import { OrgId } from '../../domain/ids.js'
import { Prisma } from '../../generated/prisma/client.js'
import { routingMembers, hookRoutingStatus, hookRoutingIssues } from '../../hooks/hook-routing.js'
import { NoConnection } from '../../orchestrator/outbound.js'
import type {
  AgentRecord,
  CodeHostDecisionRoutingRecord,
  CodeHostRoutingScope,
  HookRecord
} from '../../persistence/ports.js'
import { ConnectionClosed } from '../../ws/registry.js'
import { visibleDecisionChain } from '../decision-access.js'
import { DecisionBindingDenied } from '../../persistence/decision-binding-fence.js'
import type { HttpDeps } from '../deps.js'
import { ErrorDto } from '../dto/index.js'
import { Tag } from '../plugins/openapi.js'
import type { ZodTypeProvider } from '../plugins/zod.js'
import { ctxOf, denyViewerWrite, orgOf } from '../rbac.js'

// The family must be one its provider routes (CODE_HOST_ROUTING_PROVIDER_FAMILIES), as the hook rows name it.
const routableScope = <T extends { provider: string; family: string }>(schema: z.ZodType<T>) =>
  schema.refine((params) => isCodeHostRoutingScope(params.provider, params.family), {
    path: ['family'],
    message: 'The family is not routable for this provider.'
  })
const ScopeShape = z.object({
  provider: CodeHostRoutingProvider,
  repoId: z.string().regex(/^[1-9]\d{0,18}$/),
  family: CodeHostRoutingFamily
})
const ScopeParams = routableScope(ScopeShape)
const EvaluationParams = routableScope(ScopeShape.extend({ seq: z.coerce.number().int().nonnegative() }))
const Issue = z.object({ path: z.array(z.union([z.string(), z.number()])), message: z.string() })
const IssuesErrorDto = ErrorDto.extend({ issues: z.array(Issue).optional(), code: z.string().optional() })
const DetailDto = z.object({
  provider: CodeHostRoutingProvider,
  repoId: z.string(),
  repoFullName: z.string(),
  family: CodeHostRoutingFamily,
  config: SharedBotDecisionRouting.nullable(),
  status: z.enum(['enabled', 'needs_review', 'access_revoked']).nullable(),
  // Every agent with an enabled trigger of this provider on this repository and family: the only valid rule targets.
  members: z.array(z.object({ agentId: z.string(), hookId: z.string(), name: z.string().nullable() })),
  evaluationAgentId: z.string().nullable()
})

const notFound = (message: string, code?: string) => ({
  error: 'Not Found',
  statusCode: 404,
  message,
  ...(code ? { code } : {})
})
const forbidden = (message: string) => ({ error: 'Forbidden', statusCode: 403, message })
const badRequest = (message: string, issues?: DecisionValidationIssue[]) => ({
  error: 'Bad Request',
  statusCode: 400,
  message,
  ...(issues ? { issues } : {})
})
const conflict = (message: string, code?: string) => ({
  error: 'Conflict',
  statusCode: 409,
  message,
  ...(code ? { code } : {})
})
const unavailable = (message: string, code: string) => ({
  error: 'Service Unavailable',
  statusCode: 503,
  message,
  code
})
const OFFLINE = 'the evaluation host daemon is offline'
const UNSUPPORTED = 'upgrade the evaluation host daemon to read recent evaluations'
const REPOSITORY_NOT_FOUND = 'repository routing not found'

/** The scope as the caller may see it now: members with their agents, and the stored routing. */
interface ScopeView {
  scope: CodeHostRoutingScope
  record: CodeHostDecisionRoutingRecord | null
  members: Array<{ hook: HookRecord; agent: AgentRecord }>
  repoFullName: string
}

export function codeHostDecisionRoutingRoutes(deps: HttpDeps) {
  return async function codeHostDecisionRoutingRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()
    const routingOf = (scope: CodeHostRoutingScope) => codeHostsOf(deps)[scope.provider].routing

    const scopeOf = (req: FastifyRequest): CodeHostRoutingScope => {
      const params = req.params as z.infer<typeof ScopeParams>
      return {
        orgId: OrgId(orgOf(req)),
        provider: params.provider,
        repoId: BigInt(params.repoId),
        family: params.family
      }
    }

    // Null when there is neither a routing nor a member; members whose agent is gone are dropped.
    const load = async (req: FastifyRequest): Promise<ScopeView | null> => {
      const scope = scopeOf(req)
      const [record, hooks] = await Promise.all([
        deps.repos.codeHostDecisionRouting.get(scope),
        deps.repos.hook.listForOrgKind(scope.orgId, scope.provider)
      ])
      const members: ScopeView['members'] = []
      for (const hook of routingMembers(hooks, scope)) {
        const agent = await deps.repos.agent.get(scope.orgId, hook.agentId)
        if (agent) members.push({ hook, agent })
      }
      if (!record && members.length === 0) return null
      const repoFullName =
        (await routingOf(scope).repositoryPath(deps, scope.orgId, scope.repoId)) ??
        record?.repoFullName ??
        members[0]?.hook.repoFullName
      if (!repoFullName) return null
      return { scope, record, members, repoFullName }
    }

    // Every feature a relay or host daemon needs before this provider's routed scope reaches it.
    const requiredFeatures = (scope: CodeHostRoutingScope) => routingOf(scope).requiredFeatures

    // Reading needs view access to one member; an orphaned routing (no member left) is visible to the owner only.
    const readable = (req: FastifyRequest, view: ScopeView | null): view is ScopeView =>
      !!view &&
      (view.members.some((m) => canView(m.agent, ctxOf(req))) ||
        (view.members.length === 0 && ctxOf(req).role === 'owner'))

    // Writing changes which of the members fire, so it needs edit access to every one of them.
    const editable = (req: FastifyRequest, view: ScopeView): boolean =>
      view.members.length > 0 ? view.members.every((m) => canEdit(m.agent, ctxOf(req))) : ctxOf(req).role === 'owner'

    const detail = (req: FastifyRequest, view: ScopeView) => {
      const agentIds = new Set(view.members.map((m) => m.agent.id))
      return {
        provider: view.scope.provider,
        repoId: view.scope.repoId.toString(),
        repoFullName: view.repoFullName,
        family: view.scope.family,
        config: view.record?.config ?? null,
        status: view.record ? hookRoutingStatus(view.record, agentIds) : null,
        members: view.members.map((m) => ({
          agentId: m.agent.id,
          hookId: m.hook.id,
          name: canView(m.agent, ctxOf(req)) ? m.agent.displayName || m.agent.name : null
        })),
        evaluationAgentId: view.record?.evaluationAgentId ?? null
      }
    }

    r.get(
      '/decision-routing/:provider/:repoId/:family',
      {
        schema: {
          tags: [Tag.Decisions],
          summary: 'Get repository routing',
          operationId: 'getCodeHostDecisionRouting',
          description:
            "Returns the Decision routing for one code-host repository and subject family — `github` with `issues` or `pull_request`, `gitlab` or `gitea` with `issues` or `merge_request` (400 for another pair): its config (null when none is saved), status (`enabled`, `needs_review`, `access_revoked`; pause is the config's own `enabled`), the members — every agent with an enabled trigger of that provider on that repository and family, the only valid rule targets — and the evaluation agent. Needs view access to one member; member names appear only for agents the caller can view.",
          params: ScopeParams,
          response: { 200: DetailDto, 400: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const view = await load(req)
        if (!readable(req, view)) return reply.code(404).send(notFound(REPOSITORY_NOT_FOUND))
        return detail(req, view)
      }
    )

    r.put(
      '/decision-routing/:provider/:repoId/:family',
      {
        schema: {
          tags: [Tag.Decisions],
          summary: 'Save repository routing',
          operationId: 'saveCodeHostDecisionRouting',
          description:
            "Saves the complete routing config for one code-host repository and subject family and clears Needs review. The Decision must be visible and supported (`code` DECISION_NOT_FOUND, 404), the rules must fit its question, and every rule's agent must be a member (400 with `issues`). Needs edit access to every member agent, since the routing decides which of them fire. `enabled: false` pauses routing: the members' triggers fire unrouted. Enabling is refused with `code` DECISION_UNSUPPORTED_CONSUMER (409) while a connected relay does not support routing for this provider.",
          params: ScopeParams,
          body: z.strictObject({ config: SharedBotDecisionRouting }),
          response: { 200: DetailDto, 400: IssuesErrorDto, 403: ErrorDto, 404: IssuesErrorDto, 409: IssuesErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const view = await load(req)
        if (!readable(req, view)) return reply.code(404).send(notFound(REPOSITORY_NOT_FOUND))
        if (view.members.length === 0)
          return reply
            .code(400)
            .send(
              badRequest(
                `No enabled ${codeHostsOf(deps)[view.scope.provider].displayName} trigger watches this repository and family.`
              )
            )
        if (!editable(req, view)) return reply.code(403).send(forbidden('cannot edit every agent watching this scope'))
        const { config } = req.body
        const definitions = await visibleDecisionChain(deps, req, config)
        const decision = definitions?.get(config.decisionId)
        if (!decision) return reply.code(404).send(notFound('decision not found', 'DECISION_NOT_FOUND'))
        if ([...definitions!.values()].some((d) => !supportsDecision(d)))
          return reply.code(400).send(badRequest('Unsupported Decision provider, model, or question type.'))
        const members = new Set(view.members.map((m) => m.agent.id as string))
        const issues = hookRoutingIssues(
          {
            orgId: view.scope.orgId,
            decisionId: config.decisionId,
            config,
            needsReview: false,
            definition: decision,
            definitions: [...definitions!.values()]
          },
          members
        )
        if (issues.length > 0) return reply.code(400).send(badRequest('The routing configuration is invalid.', issues))
        // An older relay drops a routed scope's rules, so turning routing on there would silence the scope.
        const turningOn = config.enabled && !view.record?.enabled
        if (
          turningOn &&
          requiredFeatures(view.scope).some((feature) => deps.httpBot.relayFeatureSupport(feature).missing > 0)
        )
          return reply
            .code(409)
            .send(conflict('Upgrade the relay to use Decision routing.', 'DECISION_UNSUPPORTED_CONSUMER'))
        try {
          await deps.repos.codeHostDecisionRouting.save(
            { ...view.scope, repoFullName: view.repoFullName },
            config,
            req.principal?.userId ?? null
          )
        } catch (err) {
          // The Decision was deleted between validation and the write (FK RESTRICT).
          if (
            err instanceof DecisionBindingDenied ||
            (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003')
          )
            return reply.code(404).send(notFound('decision not found', 'DECISION_NOT_FOUND'))
          throw err
        }
        await deps.hookRouting.reconcile(view.scope)
        const fresh = await load(req)
        if (!fresh) return reply.code(404).send(notFound(REPOSITORY_NOT_FOUND))
        return detail(req, fresh)
      }
    )

    r.delete(
      '/decision-routing/:provider/:repoId/:family',
      {
        schema: {
          tags: [Tag.Decisions],
          summary: 'Delete repository routing',
          operationId: 'deleteCodeHostDecisionRouting',
          description:
            "Removes the routing for one code-host repository and subject family; the members' triggers fire unrouted again. Needs edit access to every member agent (an owner for a routing with no member left).",
          params: ScopeParams,
          response: { 204: z.null(), 400: ErrorDto, 403: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const view = await load(req)
        if (!readable(req, view) || !view.record) return reply.code(404).send(notFound(REPOSITORY_NOT_FOUND))
        if (!editable(req, view)) return reply.code(403).send(forbidden('cannot edit every agent watching this scope'))
        const removed = await deps.repos.codeHostDecisionRouting.delete(view.scope)
        if (removed)
          await deps.hookRouting
            .reconcile(view.scope, { formerHost: removed.evaluationAgentId })
            .catch((err: unknown) => req.log.warn({ err }, 'hook routing reconcile after delete failed'))
        return reply.code(204).send(null)
      }
    )

    const readyConn = (daemonId: string) => {
      const conn = deps.daemonConns.get(daemonId)
      return conn?.state === 'READY' ? conn : undefined
    }

    // The routing's lane on the evaluation host's serving daemons; bodies are proxied, never stored or logged.
    const proxied = async <T>(
      req: FastifyRequest,
      reply: FastifyReply,
      host: AgentRecord,
      scope: CodeHostRoutingScope,
      read: (daemonId: string) => Promise<T>,
      decisionId?: string
    ): Promise<{ ok: true; value: T } | { ok: false }> => {
      const ready = (await deps.placementResolver.servingDaemons(host)).filter((id) => readyConn(id))
      if (ready.length === 0) {
        await reply.code(503).send(unavailable(OFFLINE, 'DAEMON_OFFLINE'))
        return { ok: false }
      }
      // `source: 'hook_routing'` reaches only a peer that reads routing lanes; an older strict one would reject it.
      const capable = ready.filter((id) => {
        const features = readyConn(id)?.capabilities?.features ?? []
        return [
          DECISION_EVALUATIONS_V1_FEATURE,
          ...requiredFeatures(scope),
          ...(decisionId ? [DECISION_EVALUATION_FILTER_V1_FEATURE] : [])
        ].every((f) => features.includes(f))
      })
      if (capable.length === 0) {
        await reply.code(503).send(unavailable(UNSUPPORTED, 'DAEMON_UPGRADE_REQUIRED'))
        return { ok: false }
      }
      let failure: unknown
      for (const daemonId of capable) {
        try {
          return { ok: true, value: await read(daemonId) }
        } catch (err) {
          const moved =
            err instanceof NoConnection ||
            err instanceof ConnectionClosed ||
            (err instanceof ProtocolError && err.code === 'SCOPE_DENIED')
          if (!moved) {
            failure = err
            req.log.warn(
              { daemonId, error: (err as Error).name },
              'routing evaluations read failed; trying the next daemon'
            )
          }
        }
      }
      if (failure !== undefined) throw failure
      await reply.code(503).send(unavailable(OFFLINE, 'DAEMON_OFFLINE'))
      return { ok: false }
    }

    // The routing and its host as the caller may read them now; re-run after the daemon replies so a revoked caller gets nothing.
    const lane = async (
      req: FastifyRequest,
      opts: { bodies?: boolean } = {}
    ): Promise<
      | { record: CodeHostDecisionRoutingRecord; host: AgentRecord | null; scope: CodeHostRoutingScope }
      | 'forbidden'
      | null
    > => {
      const view = await load(req)
      if (!readable(req, view) || !view.record) return null
      if (opts.bodies && !editable(req, view)) return 'forbidden'
      const hostId = view.record.evaluationAgentId
      const host = hostId ? await deps.repos.agent.get(view.scope.orgId, hostId) : null
      return { record: view.record, host, scope: view.scope }
    }
    const sameLane = (
      a: { record: CodeHostDecisionRoutingRecord; host: AgentRecord | null },
      b: Awaited<ReturnType<typeof lane>>
    ) => !!b && b !== 'forbidden' && b.record.id === a.record.id && b.host?.id === a.host?.id

    r.get(
      '/decision-routing/:provider/:repoId/:family/evaluations',
      {
        schema: {
          tags: [Tag.Decisions],
          summary: 'List repository routing evaluations',
          operationId: 'listCodeHostDecisionRoutingEvaluations',
          description:
            "Recent evaluations of one repository routing, newest first, read from the evaluation agent's serving daemon and proxied without being stored or logged. `decisionId` optionally filters by the recorded root Decision before paging. Needs view access to one member. Pages by `cursor` (the previous page's `nextCursor`) up to 50 rows and 32 KiB. Returns 503 when the host daemon is offline (`DAEMON_OFFLINE`) or must be upgraded (`DAEMON_UPGRADE_REQUIRED`).",
          params: ScopeParams,
          querystring: z.object({
            cursor: z.coerce.number().int().positive().optional(),
            limit: z.coerce.number().int().min(1).max(50).default(20),
            decisionId: z.string().uuid().optional()
          }),
          response: { 200: DecisionEvaluationRecordPage, 400: ErrorDto, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const asked = await lane(req)
        if (!asked || asked === 'forbidden') return reply.code(404).send(notFound(REPOSITORY_NOT_FOUND))
        if (!asked.host) return reply.code(503).send(unavailable(OFFLINE, 'DAEMON_OFFLINE'))
        const host = asked.host
        const result = await proxied(
          req,
          reply,
          host,
          asked.scope,
          (daemonId) =>
            deps.control.decisionEvaluations(daemonId, orgOf(req), {
              agentId: host.id,
              integrationId: asked.record.id,
              channel: asked.record.id,
              source: 'hook_routing',
              ...(req.query.decisionId ? { decisionId: req.query.decisionId } : {}),
              ...(req.query.cursor !== undefined ? { cursor: req.query.cursor } : {}),
              limit: req.query.limit
            }),
          req.query.decisionId
        )
        if (!result.ok) return reply
        if (!sameLane(asked, await lane(req))) return reply.code(404).send(notFound(REPOSITORY_NOT_FOUND))
        const { conversation: _namespace, ...page } = result.value
        return page
      }
    )

    r.get(
      '/decision-routing/:provider/:repoId/:family/evaluations/:seq',
      {
        schema: {
          tags: [Tag.Decisions],
          summary: 'Get a repository routing evaluation',
          operationId: 'getCodeHostDecisionRoutingEvaluation',
          description:
            "One routing evaluation with its frozen Decision and rules snapshot, input and history, answer, model, usage, the raw provider request and response JSON (from daemons that support it), and evidence while the host still retains the bodies (bounded to 64 KiB); once stripped, `detailsExpired` is true. Proxied from the evaluation agent's serving daemon, never stored or logged. Needs edit access to every member agent. Returns 404 when the evaluation is gone and 503 when the host daemon is offline or must be upgraded.",
          params: EvaluationParams,
          response: { 200: DecisionEvaluationRecordDetail, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const asked = await lane(req, { bodies: true })
        if (!asked) return reply.code(404).send(notFound(REPOSITORY_NOT_FOUND))
        if (asked === 'forbidden')
          return reply.code(403).send(forbidden('evaluation details need edit access to every member agent'))
        if (!asked.host) return reply.code(503).send(unavailable(OFFLINE, 'DAEMON_OFFLINE'))
        const host = asked.host
        const result = await proxied(req, reply, host, asked.scope, (daemonId) =>
          deps.control.decisionEvaluation(daemonId, orgOf(req), {
            agentId: host.id,
            integrationId: asked.record.id,
            channel: asked.record.id,
            source: 'hook_routing',
            seq: req.params.seq
          })
        )
        if (!result.ok) return reply
        if (!sameLane(asked, await lane(req, { bodies: true })))
          return reply.code(404).send(notFound(REPOSITORY_NOT_FOUND))
        if (!result.value.evaluation) return reply.code(404).send(notFound('evaluation not found'))
        return result.value.evaluation
      }
    )
  }
}
