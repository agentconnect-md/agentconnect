/**
 * `http/routes/usage.ts` — the console's Usage dashboard aggregate.
 *
 * `GET /usage?range=d1|d7|d30|d90` sums the persisted per-session token usage (the
 * `SessionUsage` store fed by the daemon's `usage/report` EVT) over the selected
 * time window, grouped by agent, plus workspace totals. Unlike `/sessions` (a
 * live fan-out to daemons), this reads the CP's own historical store — so it
 * survives TTL-closed sessions and daemon restarts. Org-scoped to the single-
 * tenant default org (as with `/agents`).
 */
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import { orgOf, ctxOf } from '../rbac.js'
import { Tag } from '../plugins/openapi.js'
import { UsageQueryDto, UsageDto } from '../dto/index.js'

const RANGE_DAYS = { d1: 1, d7: 7, d30: 30, d90: 90 } as const
const DAY_MS = 24 * 60 * 60 * 1000

export function usageRoutes(deps: HttpDeps) {
  return async function usageRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()

    r.get(
      '/usage',
      {
        schema: {
          tags: [Tag.Usage],
          summary: 'Get token usage',
          description:
            'Sums the persisted per-session token usage over the selected time window, grouped by agent, plus workspace totals.',
          operationId: 'getUsage',
          querystring: UsageQueryDto,
          response: { 200: UsageDto }
        }
      },
      async (req) => {
        const since = new Date(Date.now() - RANGE_DAYS[req.query.range] * DAY_MS)
        // Viewer-scoped: a restricted agent the caller can't see drops out of both
        // the totals and the per-agent breakdown (owner ⇒ full org rollup).
        const agg = await deps.repos.sessionUsage.aggregate(orgOf(req), since, ctxOf(req))
        return { range: req.query.range, totals: agg.totals, agents: agg.agents }
      }
    )
  }
}
