// Aggregate persisted spend for the console and billing without exposing session content.
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import { orgOf, ctxOf } from '../rbac.js'
import { Tag } from '../plugins/openapi.js'
import { UsageQueryDto, UsageDto } from '../dto/index.js'
import { makeSessionAccessResolver } from '../session-access.js'
import { AuthorizationAction, can } from '../../authorization/policy.js'

export function usageRoutes(deps: HttpDeps) {
  return async function usageRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()
    const sessionAccess = makeSessionAccessResolver(deps)

    r.get(
      '/usage',
      {
        schema: {
          tags: [Tag.Usage],
          summary: 'Get token usage',
          description:
            'Sums persisted token usage over the half-open [from, to) window. Organization owners receive complete agent, model, and time-series attribution; other members receive access-scoped attribution and an unattributed residual. Totals and metering-source totals stay organization-wide. Optionally scoped to one metering source.',
          operationId: 'getUsage',
          querystring: UsageQueryDto,
          response: { 200: UsageDto }
        }
      },
      async (req) => {
        const window = { from: new Date(req.query.from), to: new Date(req.query.to) }
        const orgId = req.usageServiceOrgId ?? orgOf(req)
        // Owners and verified settlement workloads may attribute the whole org without resolving session audiences.
        if (req.usageServiceOrgId || can(ctxOf(req), { action: AuthorizationAction.UsageAttributeAll })) {
          const agg = await deps.repos.sessionUsage.aggregate(
            orgId,
            window,
            undefined,
            req.query.tz,
            undefined,
            req.query.source
          )
          return {
            from: req.query.from,
            to: req.query.to,
            totals: agg.totals,
            agents: agg.agents,
            models: agg.models,
            sources: agg.sources,
            series: agg.series
          }
        }
        // Other members' attribution follows both agent and session access; totals stay org-wide.
        // Caller-chosen windows can reveal the unattributed timeline; see session-visibility.md for this accepted trade.
        const ctx = ctxOf(req)
        const visibleAgentIds = (await deps.repos.agent.list(orgId, ctx)).map((agent) => agent.id)
        const access = await sessionAccess.forQuery(req, { agentIds: visibleAgentIds })
        const agg = await deps.repos.sessionUsage.aggregate(
          orgId,
          window,
          ctx,
          req.query.tz,
          {
            role: ctx.role,
            identitySet: [...access.identitySet],
            externalAccess: access.externalAccess
          },
          req.query.source
        )
        return {
          from: req.query.from,
          to: req.query.to,
          accessSyncDegraded: access.degraded,
          accessIssues: access.accessIssues,
          totals: agg.totals,
          agents: agg.agents,
          models: agg.models,
          sources: agg.sources,
          ...(agg.unattributed ? { unattributed: agg.unattributed } : {}),
          series: agg.series
        }
      }
    )
  }
}
