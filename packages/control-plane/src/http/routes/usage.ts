// Aggregate persisted spend for the console and billing without exposing session content.
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import { orgOf, ctxOf } from '../rbac.js'
import { Tag } from '../plugins/openapi.js'
import {
  ComputerScreenshotUsageDto,
  ComputerScreenshotUsageQuery,
  ComputerUsageDto,
  ErrorDto,
  UsageQueryDto,
  UsageDto
} from '../dto/index.js'
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

    // Screenshot storage for metering (computer-use.md §9); totals only, so every member and the settlement workload read it alike.
    r.get(
      '/usage/computer-screenshots',
      {
        schema: {
          tags: [Tag.Usage],
          summary: 'Get computer screenshot storage usage',
          description:
            'Totals the Computer screenshots the organization stored: `written` counts the screenshots and bytes stored in the [from, to) window by UTC day, kept after the screenshots expire, and `stored` what the organization holds now. Returns zeros when screenshot storage is not configured.',
          operationId: 'getComputerScreenshotUsage',
          querystring: ComputerScreenshotUsageQuery,
          response: { 200: ComputerScreenshotUsageDto, 400: ErrorDto }
        }
      },
      async (req) => {
        const orgId = req.usageServiceOrgId ?? orgOf(req)
        const window = { from: new Date(req.query.from), to: new Date(req.query.to) }
        const totals = deps.computerScreenshots
          ? await deps.computerScreenshots.usage(orgId, window)
          : { written: { count: 0, bytes: 0 }, stored: { count: 0, bytes: 0 } }
        return { from: req.query.from, to: req.query.to, ...totals }
      }
    )

    // Managed computer metering (computer-use.md §15.5): desktop time, kept volumes, viewer media and screenshot storage.
    r.get(
      '/usage/computers',
      {
        schema: {
          tags: [Tag.Usage],
          summary: 'Get computer usage',
          description:
            'Metered Computer use over [from, to) by UTC day: managed desktop seconds running and sleeping, the kept volume (GiB × seconds held), and viewer media the relays forwarded over TURN, in total, by allocation mode, by day and per Computer, with screenshot storage beside them. Desktop time is metered by the pool controller every 30 s and TURN bytes by each relay every minute, so the newest minute may be missing. Per-Computer names are given only for Computers the caller can see.',
          operationId: 'getComputerUsage',
          querystring: ComputerScreenshotUsageQuery,
          response: { 200: ComputerUsageDto, 400: ErrorDto }
        }
      },
      async (req) => {
        const orgId = req.usageServiceOrgId ?? orgOf(req)
        const window = { from: new Date(req.query.from), to: new Date(req.query.to) }
        const empty = { runningSeconds: 0, sleepingSeconds: 0, volumeGibSeconds: 0, relayedBytes: 0 }
        const [metered, screenshots, visible] = await Promise.all([
          deps.computerPlan?.usage(orgId, window) ?? { totals: empty, allocations: [], days: [], computers: [] },
          deps.computerScreenshots?.usage(orgId, window) ?? {
            written: { count: 0, bytes: 0 },
            stored: { count: 0, bytes: 0 }
          },
          req.usageServiceOrgId ? deps.repos.computer.list(orgId) : deps.repos.computer.list(orgId, ctxOf(req))
        ])
        const names = new Map(visible.map((c) => [c.id as string, c.name]))
        return {
          from: req.query.from,
          to: req.query.to,
          totals: metered.totals,
          allocations: metered.allocations,
          days: metered.days,
          computers: metered.computers.map((c) => ({ ...c, name: names.get(c.computerId) ?? null })),
          screenshots
        }
      }
    )
  }
}
