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
 * preset-derived window, and stays inside session visibility for ATTRIBUTION — what it
 * may not attribute is returned as an id-less residual rather than dropped, so its total
 * is the org's; a settlement job asks
 * with a workload credential (`usage-service-auth.ts`), `source=gateway`, and a closed
 * accounting period, and reads the org whole. Both get the same aggregation code, so a
 * figure on the dashboard and a figure on an invoice cannot come from two different
 * implementations.
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
        // A verified usage-reader workload reads the org WHOLE: no viewer, so no agent
        // visibility and no session predicate narrow it. That is the point of the
        // second credential — an org's spend is a fact about the org, and a settlement
        // total that silently omitted the sessions no human may read would be wrong in
        // the direction that costs someone money. There is no human to attribute the
        // read to, which is exactly why it takes an install-level principal to make it.
        // No viewer ⇒ every row is attributable ⇒ the aggregate carries no `unattributed`,
        // so this arm reads exactly as it did before the residual existed.
        if (req.usageServiceOrgId) {
          const agg = await deps.repos.sessionUsage.aggregate(
            req.usageServiceOrgId,
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
        // Viewer-scoped ATTRIBUTION: agent visibility and the request-time Session
        // predicate decide which rows this caller may see attributed to an agent, and the
        // spend series is scoped to those. They do NOT narrow `totals` — an org's spend is
        // a fact about the org — so what they withhold lands in `unattributed` instead.
        // Roles still never widen either resource boundary.
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
          ...(agg.unattributed ? { unattributed: agg.unattributed } : {}),
          series: agg.series
        }
      }
    )
  }
}
