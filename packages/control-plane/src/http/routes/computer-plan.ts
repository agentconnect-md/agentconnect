// Managed computer quotas and egress per organization (computer-use.md §15.4, §15.5): read by members, set by admins and owners.
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import { orgOf, ctxOf, denyViewerWrite } from '../rbac.js'
import { Tag } from '../plugins/openapi.js'
import { AuthorizationAction, can } from '../../authorization/policy.js'
import type { ComputerQuotaOverride } from '../../domain/computerQuotas.js'
import {
  ComputerEgressDto,
  ComputerQuotaStatusDto,
  ErrorDto,
  SetComputerEgressBody,
  SetComputerQuotasBody
} from '../dto/index.js'

const unavailable = {
  error: 'Service Unavailable',
  statusCode: 503,
  message: 'managed computer settings are not available on this Control Plane'
}

// A shorter retention quota also shortens what is already stored; a failed clamp is retried by the reaper.
async function setOverride(deps: HttpDeps, orgId: string, override: ComputerQuotaOverride | null): Promise<void> {
  await deps.computerPlan!.setOverride(orgId, override)
  await deps.computerScreenshots?.applyOrgRetention(orgId).catch(() => 0)
}

const AdminOrgParams = z.object({ orgId: z.string().min(1).max(64) })

/** The deployment administrator's quota surface: outside the org subtree, so it needs no membership in the organization. */
export function computerPlanAdminRoutes(deps: HttpDeps) {
  return async function computerPlanAdminRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()
    const forbidden = {
      error: 'Forbidden',
      statusCode: 403,
      message: 'only a deployment administrator can change managed computer quotas'
    }
    const notFound = { error: 'Not Found', statusCode: 404, message: 'organization not found' }
    const isDeploymentAdmin = (req: FastifyRequest): boolean =>
      !deps.config.OIDC_ISSUER || req.principal?.isAdmin === true

    r.get(
      '/admin/orgs/:orgId/computers/quotas',
      {
        preHandler: app.humanAuth,
        schema: {
          tags: [Tag.Computers],
          summary: 'Get an organization’s managed computer quotas (admin)',
          description:
            'A deployment administrator’s view of any organization’s managed computer quotas and usage, as `GET /orgs/{orgId}/computers/quotas` returns them, without being a member. 403 for anyone else; 404 for an unknown organization.',
          operationId: 'adminGetComputerQuotas',
          params: AdminOrgParams,
          response: { 200: ComputerQuotaStatusDto, 403: ErrorDto, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (!deps.computerPlan) return reply.code(503).send(unavailable)
        if (!isDeploymentAdmin(req)) return reply.code(403).send(forbidden)
        if ((await deps.repos.org.slugById(req.params.orgId)) === null) return reply.code(404).send(notFound)
        return { ...(await deps.computerPlan.status(req.params.orgId)), canEdit: true }
      }
    )

    r.put(
      '/admin/orgs/:orgId/computers/quotas',
      {
        preHandler: app.humanAuth,
        schema: {
          tags: [Tag.Computers],
          summary: 'Set an organization’s managed computer quotas (admin)',
          description:
            'Replaces any organization’s quota override, as `PUT /orgs/{orgId}/computers/quotas` does, for a deployment administrator who need not be a member. 403 for anyone else; 404 for an unknown organization.',
          operationId: 'adminSetComputerQuotas',
          params: AdminOrgParams,
          body: SetComputerQuotasBody,
          response: { 200: ComputerQuotaStatusDto, 403: ErrorDto, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (!deps.computerPlan) return reply.code(503).send(unavailable)
        if (!isDeploymentAdmin(req)) return reply.code(403).send(forbidden)
        if ((await deps.repos.org.slugById(req.params.orgId)) === null) return reply.code(404).send(notFound)
        await setOverride(deps, req.params.orgId, req.body.override)
        return { ...(await deps.computerPlan.status(req.params.orgId)), canEdit: true }
      }
    )
  }
}

export function computerPlanRoutes(deps: HttpDeps) {
  return async function computerPlanRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()
    // A deployment administrator sets quotas, never the organization being limited; local no-auth mode is the admin path.
    const isDeploymentAdmin = (req: FastifyRequest): boolean =>
      !deps.config.OIDC_ISSUER || req.principal?.isAdmin === true
    const canEditEgress = (req: FastifyRequest): boolean =>
      can(ctxOf(req), { action: AuthorizationAction.OrganizationManage })

    r.get(
      '/computers/quotas',
      {
        schema: {
          tags: [Tag.Computers],
          summary: 'Get managed computer quotas',
          description:
            'The organization’s managed computer quotas and what it uses now: managed desktops running and held (sleeping ones and their kept volumes included), per allocation mode, the GiB those volumes hold, running desktop hours this UTC month, open viewers, viewer media the relays forwarded this month, and stored screenshots. `limits` is what applies: the deployment’s `defaults` with the organization’s `override` on top; null is unlimited. Allocations, wakes and viewers over a limit are refused with `code: COMPUTER_QUOTA_EXCEEDED`.',
          operationId: 'getComputerQuotas',
          response: { 200: ComputerQuotaStatusDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (!deps.computerPlan) return reply.code(503).send(unavailable)
        return { ...(await deps.computerPlan.status(orgOf(req))), canEdit: isDeploymentAdmin(req) }
      }
    )

    r.put(
      '/computers/quotas',
      {
        schema: {
          tags: [Tag.Computers],
          summary: 'Set managed computer quotas',
          description:
            'Replaces the organization’s quota override: any subset of the quotas, null for unlimited; `override: null` returns the organization to the deployment’s defaults. Only a deployment administrator may change it; one who is not a member uses `PUT /admin/orgs/{orgId}/computers/quotas`. Existing desktops are not stopped: a lower limit refuses the next allocation, wake or viewer, and a shorter screenshot retention applies to screenshots already stored.',
          operationId: 'setComputerQuotas',
          body: SetComputerQuotasBody,
          response: { 200: ComputerQuotaStatusDto, 403: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (!deps.computerPlan) return reply.code(503).send(unavailable)
        if (!isDeploymentAdmin(req))
          return reply.code(403).send({
            error: 'Forbidden',
            statusCode: 403,
            message: 'only a deployment administrator can change managed computer quotas'
          })
        await setOverride(deps, orgOf(req), req.body.override)
        return { ...(await deps.computerPlan.status(orgOf(req))), canEdit: true }
      }
    )

    r.get(
      '/computers/egress',
      {
        schema: {
          tags: [Tag.Computers],
          summary: 'Get managed computer egress',
          description:
            'Where the organization’s managed computers’ browser traffic leaves. `deployment` is the deployment’s own egress: data-centre addresses, which some sites refuse or challenge. `proxy` sends it through the organization’s own HTTP(S) proxy, such as a residential proxy or a fixed address; its password is never returned (`passwordSet`). Self-hosted computers always use their own network.',
          operationId: 'getComputerEgress',
          response: { 200: ComputerEgressDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (!deps.computerPlan) return reply.code(503).send(unavailable)
        return { ...(await deps.computerPlan.egressView(orgOf(req))), canEdit: canEditEgress(req) }
      }
    )

    // Carries a proxy credential, so API keys and agents' delegated calls cannot reach it.
    r.put(
      '/computers/egress',
      {
        config: { interactiveOnly: true },
        schema: {
          tags: [Tag.Computers],
          summary: 'Set managed computer egress',
          description:
            'Sets where the organization’s managed computers’ browser traffic leaves: `{ mode: "deployment" }`, or `{ mode: "proxy", url, username?, password? }` with an `http://` or `https://` proxy URL and no credentials in it. An omitted password keeps the stored one only while the URL stays the same; null clears it. Running managed desktops switch at once; new connections use it. 403 unless the caller manages the organization, or when the deployment allows no organization proxies.',
          operationId: 'setComputerEgress',
          body: SetComputerEgressBody,
          response: { 200: ComputerEgressDto, 403: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        if (!deps.computerPlan) return reply.code(503).send(unavailable)
        if (!canEditEgress(req))
          return reply
            .code(403)
            .send({ error: 'Forbidden', statusCode: 403, message: 'only an organization owner can change egress' })
        if (!(await deps.computerPlan.setEgress(orgOf(req), req.body)))
          return reply.code(403).send({
            error: 'Forbidden',
            statusCode: 403,
            message: 'this deployment does not allow organization egress proxies'
          })
        return { ...(await deps.computerPlan.egressView(orgOf(req))), canEdit: true }
      }
    )
  }
}
