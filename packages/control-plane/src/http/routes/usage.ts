/**
 * `http/routes/usage.ts` — the console's Usage dashboard aggregate.
 *
 * `GET /usage?range=d1|d7|d30|d90` sums the persisted per-session token usage (the
 * `SessionUsage` store fed by the daemon's `usage/report` EVT) over the selected
 * time window, grouped by agent and effective model, plus workspace totals. Unlike `/sessions` (a
 * live fan-out to daemons), this reads the CP's own historical store — so it
 * survives TTL-closed sessions and daemon restarts. Org-scoped to the single-
 * tenant default org (as with `/agents`).
 */
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import { orgOf, ctxOf } from '../rbac.js'
import { Tag } from '../plugins/openapi.js'
import { UsageQueryDto, UsageDto, ErrorDto } from '../dto/index.js'
import { makeSessionAccessResolver } from '../session-access.js'
import { UsageReport } from '@agentconnect.md/protocol'
import { z } from 'zod'
import { AgentId } from '../../domain/ids.js'

const RANGE_DAYS = { d1: 1, d7: 7, d30: 30, d90: 90 } as const
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * A batch, because the reporter is a metering pipeline rather than a turn: one entry per session
 * whose cumulative usage moved, on its own cadence. A request per session per interval would be
 * thousands of requests a minute on a busy install.
 */
const UsageIngestDto = z.object({ reports: z.array(UsageReport).min(1).max(1000) }).strict()
const UsageIngestResultDto = z.object({ accepted: z.number().int(), skipped: z.number().int() }).strict()

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
            'Sums persisted per-session token usage over the selected time window, with agent and effective-model breakdowns plus workspace totals.',
          operationId: 'getUsage',
          querystring: UsageQueryDto,
          response: { 200: UsageDto }
        }
      },
      async (req) => {
        const since = new Date(Date.now() - RANGE_DAYS[req.query.range] * DAY_MS)
        // Viewer-scoped: both agent visibility and the request-time Session
        // predicate apply to counts, tokens, costs, and buckets. Roles do not
        // widen either resource boundary.
        const ctx = ctxOf(req)
        const visibleAgentIds = (await deps.repos.agent.list(orgOf(req), ctx)).map((agent) => agent.id)
        const access = await sessionAccess.forQuery(req, { agentIds: visibleAgentIds })
        const agg = await deps.repos.sessionUsage.aggregate(orgOf(req), since, ctx, req.query.tz, {
          role: ctx.role,
          identitySet: [...access.identitySet],
          externalAccess: access.externalAccess
        })
        return {
          range: req.query.range,
          accessSyncDegraded: access.degraded,
          accessIssues: access.accessIssues,
          totals: agg.totals,
          agents: agg.agents,
          models: agg.models,
          series: agg.series
        }
      }
    )

    r.post(
      '/usage/reports',
      {
        schema: {
          tags: [Tag.Usage],
          summary: 'Ingest metered session usage',
          description:
            "Accepts cumulative per-session usage from this install's usage reporter — whatever meters model traffic outside the daemons, when a deployment runs one — authenticated by its projected Kubernetes identity. Same payload and same persistence as a daemon's usage report: latest-wins per (agent, session), so re-sending a snapshot is a no-op and a partial failure is fixed by the next round.",
          operationId: 'ingestUsageReports',
          body: UsageIngestDto,
          response: { 200: UsageIngestResultDto, 401: ErrorDto }
        },
        // Its own door: this caller is neither a console user nor an API-key principal, so the
        // human/API-key preHandler does not apply. A deployment with no reporter configured has no
        // verifier and therefore refuses every request here.
        preHandler: async (req, reply) => {
          const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
          const ok = bearer ? await deps.clusterUsageReporter?.verify(bearer) : false
          if (!ok) {
            return reply.code(401).send({ error: 'Unauthorized', statusCode: 401, message: 'Unauthorized' })
          }
        }
      },
      async (req) => {
        let accepted = 0
        let skipped = 0
        for (const report of req.body.reports) {
          const agentId = AgentId(report.agentId)
          // No placement check, deliberately: that fence stops one daemon rewriting another's
          // usage, and a reporter legitimately meters every org's agents — it holds no placement to
          // check against. The mutation lease still applies; it guards the write against a
          // concurrent cold move and is not part of the fence.
          const release = deps.agentMutations.tryBeginMutation(agentId)
          if (!release) {
            // Contended, not failed: the next round re-sends the same cumulative snapshot.
            skipped += 1
            continue
          }
          try {
            // An unknown agent is skipped rather than failing the batch: an agent can be deleted
            // between the gateway metering a call and this report landing.
            const outcome = await deps.repos.sessionUsage.record({
              sessionId: report.sessionId,
              agentId,
              platform: report.platform ?? null,
              channel: report.channel ?? null,
              ...(report.observedModel !== undefined ? { model: report.observedModel } : {}),
              lastActivityAt: new Date(report.lastActivityAt),
              usage: report.usage
            })
            if (outcome === 'recorded') accepted += 1
            else skipped += 1
          } finally {
            release()
          }
        }
        return { accepted, skipped }
      }
    )
  }
}
