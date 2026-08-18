/**
 * `http/routes/usage.ts` — the org's usage aggregate, for the console AND for billing.
 *
 * `GET /usage?from=…&to=…` sums the persisted per-session token usage (the
 * `SessionUsage` store fed by the daemon's `usage/report` EVT and the collector batch)
 * over an explicit half-open `[from, to)` window, grouped by agent, effective model,
 * and metering ingress, plus workspace totals. Unlike `/sessions` (a live fan-out to
 * daemons), this reads the CP's own historical store — so it survives TTL-closed
 * sessions and daemon restarts.
 *
 * ONE route serves two callers. The console asks with a human credential and its
 * preset-derived window, and stays inside session visibility; a billing caller asks
 * with a service credential, `source=gateway`, and a closed accounting period. Both
 * get the same aggregation code, so a figure on the dashboard and a figure on an
 * invoice cannot come from two different implementations.
 */
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import { orgOf, ctxOf } from '../rbac.js'
import { Tag } from '../plugins/openapi.js'
import { UsageQueryDto, UsageDto } from '../dto/index.js'
import { makeSessionAccessResolver } from '../session-access.js'

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
            'Sums persisted per-session token usage over the half-open [from, to) window, with agent, effective-model, and metering-source breakdowns plus workspace totals. Optionally scoped to one metering source.',
          operationId: 'getUsage',
          querystring: UsageQueryDto,
          response: { 200: UsageDto }
        }
      },
      async (req) => {
        const window = { from: new Date(req.query.from), to: new Date(req.query.to) }
        // Viewer-scoped: both agent visibility and the request-time Session
        // predicate apply to counts, tokens, costs, and buckets. Roles do not
        // widen either resource boundary.
        const ctx = ctxOf(req)
        const visibleAgentIds = (await deps.repos.agent.list(orgOf(req), ctx)).map((agent) => agent.id)
        const access = await sessionAccess.forQuery(req, { agentIds: visibleAgentIds })
        const agg = await deps.repos.sessionUsage.aggregate(
          orgOf(req),
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
          series: agg.series
        }
      }
    )
  }
}
