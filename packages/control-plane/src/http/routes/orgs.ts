/**
 * `http/routes/orgs.ts` — the caller's organizations (C2, §3.2).
 *
 * Root surface (identity-scoped, outside the org boundary):
 *   GET  /orgs → every org the caller belongs to + their role (the picker).
 *                An empty list is a legitimate state — the console sends that
 *                caller to org onboarding.
 *   POST /orgs → create an org; the caller becomes its first owner.
 *
 * Org surface (mounted under `/orgs/:orgId` behind the org-scope guard):
 *   GET    / → the org itself, from the caller's perspective
 *   PUT    /selection → remember it as the caller's active org
 *   PATCH  / → update identity / new-agent visibility default (owner-only)
 *   DELETE / → delete the org (owner-only; refused while it still has
 *              daemons — remove them first; everything else cascades)
 *
 * Signup creates no organization: every membership comes from an explicit act
 * (POST /orgs, or accepting an invite). In no-auth mode (devAuth) the fixed
 * principal owns the seeded default org, so `GET /orgs` returns exactly that
 * one — the console hides the picker.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import type { OrgRecord } from '../../persistence/ports.js'
import { denyNonOwner, orgOf } from '../rbac.js'
import { Tag } from '../plugins/openapi.js'
import { resolveOrgIconUrl, type IconUrlBases } from '../../agents/agent-icon.js'
import { OrgDto, OrgListDto, CreateOrgBody, UpdateOrgBody, ErrorDto, type OrgDtoT } from '../dto/index.js'
import { OrgCreationLimitReached } from '../../persistence/errors.js'
import { NoConnection } from '../../orchestrator/outbound.js'

function toDto(o: OrgRecord, deps: HttpDeps): OrgDtoT {
  const bases: IconUrlBases = {
    ...(deps.config.PUBLIC_CP_URL ? { cp: deps.config.PUBLIC_CP_URL } : {}),
    ...(deps.config.S3_PUBLIC_BASE_URL ? { store: deps.config.S3_PUBLIC_BASE_URL } : {})
  }
  return {
    id: o.id,
    name: o.name,
    slug: o.slug,
    icon: o.icon,
    defaultAgentVisibility: o.defaultAgentVisibility,
    // Only `image` org icons resolve to a URL (object-store public URL); glyph/default
    // render locally in the console. Cache-busted by the org's updatedAt.
    iconUrl: o.icon?.kind === 'image' ? resolveOrgIconUrl(o.id, o.icon, bases, o.updatedAt.getTime()) : null,
    iconUploadEnabled: !!deps.iconStore,
    role: o.role,
    memberCount: o.memberCount,
    daemonCount: o.daemonCount,
    createdAt: o.createdAt.toISOString()
  }
}

/** Root routes — the only console surface outside `/orgs/:orgId`. */
export function orgRoutes(deps: HttpDeps) {
  return async function orgRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()

    r.get(
      '/orgs',
      {
        preHandler: app.humanAuth,
        schema: {
          tags: [Tag.Organizations],
          summary: 'List your organizations',
          description:
            'Every organization the caller belongs to, with their role. An empty list means the caller belongs to none yet and should create or join one.',
          operationId: 'listOrganizations',
          response: { 200: OrgListDto }
        }
      },
      async (req) => {
        const rows = await deps.repos.org.listForUser(req.principal!.userId)
        return rows.map((o) => toDto(o, deps))
      }
    )

    // ADMIN accounts bypass the deployment quota; local no-auth mode is the admin path.
    // A slug collision surfaces as 409 via the P2002 branch in the error mapper.
    r.post(
      '/orgs',
      {
        preHandler: app.humanAuth,
        schema: {
          tags: [Tag.Organizations],
          summary: 'Create an organization',
          description: 'Create an organization; the caller becomes its first owner. A slug collision returns 409.',
          operationId: 'createOrganization',
          body: CreateOrgBody,
          response: { 201: OrgDto, 403: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        // Closed-beta gate (waitlist-and-login.md §8, requirement 5): only a formal
        // (activated) user may create orgs. An invited-but-not-activated member can
        // work inside orgs they were added to, but cannot create new ones.
        if (deps.config.WAITLIST_MODE) {
          const { activated } = await deps.waitlist.access(req.principal!.userId)
          if (!activated) {
            return reply.code(403).send({
              error: 'Forbidden',
              statusCode: 403,
              message: 'activate your account (redeem your invite link) to create an organization',
              code: 'WAITLIST_NOT_ACTIVATED'
            })
          }
        }
        const isAdmin = !deps.config.OIDC_ISSUER || req.principal!.isAdmin === true
        let org: OrgRecord
        try {
          org = await deps.repos.org.create({
            name: req.body.name ?? null,
            slug: req.body.slug,
            ownerUserId: req.principal!.userId,
            ...(isAdmin ? {} : { maxOrgsPerUser: deps.maxOrgsPerNonAdminUser ?? 1 })
          })
        } catch (error) {
          if (error instanceof OrgCreationLimitReached) {
            return reply.code(403).send({
              error: 'Forbidden',
              statusCode: 403,
              message: error.message,
              code: error.code
            })
          }
          throw error
        }
        // A pool-born preset (preset-agents.md §3.2) is placed the moment the org
        // exists, so mint its duty group now — a pool member can claim it on its next
        // beat instead of waiting for the recompute sweep to rotate onto this org.
        deps.recomputeDuties?.(org.id)
        return reply.code(201).send(toDto(org, deps))
      }
    )
  }
}

/** Org-scoped routes — mounted under `/orgs/:orgId` (guard attaches `orgCtx`). */
export function orgScopedRoutes(deps: HttpDeps) {
  return async function orgScopedRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()

    const myRecord = async (req: { principal?: { userId: string }; orgCtx?: { orgId: string } }) => {
      const mine = await deps.repos.org.listForUser(req.principal!.userId)
      return mine.find((o) => o.id === req.orgCtx!.orgId) ?? null
    }

    r.get(
      '/',
      {
        schema: {
          tags: [Tag.Organizations],
          summary: 'Get the organization',
          description: 'The organization from the caller’s perspective, including its new-agent visibility default.',
          operationId: 'getOrganization',
          response: { 200: OrgDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const record = await myRecord(req)
        if (!record) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'organization not found' })
        }
        return toDto(record, deps)
      }
    )

    r.put(
      '/selection',
      {
        schema: {
          tags: [Tag.Organizations],
          summary: 'Select the organization',
          description: 'Remember this organization as the signed-in user’s active organization.',
          operationId: 'selectOrganization',
          response: { 204: z.null(), 404: ErrorDto }
        }
      },
      async (req, reply) => {
        await deps.repos.org.selectForUser(req.orgCtx!.orgId, req.principal!.userId, new Date(deps.clock.now()))
        return reply.code(204).send(null)
      }
    )

    r.patch(
      '/',
      {
        schema: {
          tags: [Tag.Organizations],
          summary: 'Update the organization',
          description:
            'Update organization identity or the default visibility policy for newly created agents (owner only). A slug collision returns 409.',
          operationId: 'updateOrganization',
          body: UpdateOrgBody,
          response: { 200: OrgDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        await deps.repos.org.update(req.orgCtx!.orgId, req.body)
        const record = await myRecord(req)
        return record
          ? toDto(record, deps)
          : reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'organization not found' })
      }
    )

    // Delete the org. Daemons are physical machines behind a RESTRICT FK —
    // remove them first (the daemons page). If an R2a Check may exist, the first
    // request irreversibly retires the current hook lifecycles and returns 409
    // while cleanup converges; retrying performs the final cascade. Deleting
    // your LAST org is fine: the console then sends you to org onboarding.
    r.delete(
      '/',
      {
        schema: {
          tags: [Tag.Organizations],
          summary: 'Delete the organization',
          description:
            'Delete the organization (owner only). Refused with 409 while it still has daemons — remove them first. If a GitHub Check may already exist, the first DELETE permanently tombstones and disables the current hook lifecycles, starts asynchronous non-passing cleanup, and returns 409; retry DELETE after cleanup converges to complete the metadata purge and cascade.',
          operationId: 'deleteOrganization',
          response: { 204: z.null(), 403: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        const orgId = orgOf(req)
        const daemons = await deps.registry.list(orgId)
        if (daemons.length > 0) {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'the organization still has daemons — remove them first'
          })
        }
        // Resolved BEFORE the cascade and sent after it: the duty ledger cascades from the org, so
        // once the delete lands there is nothing left to say which pool member serves these agents.
        // Without this an agent placed on a pool keeps its sandbox claim — and the pod and workspace
        // volume the claim owns — with no row left anywhere to reap it from.
        const announceRemovals = await deps.agentDelivery.planRemoval(await deps.repos.agent.list(orgId), orgId)
        const deleted = await deps.repos.org.delete(req.orgCtx!.orgId)
        for (const hookId of deleted.removedHookIds) deps.hooks.remove(hookId)
        if (deleted.status === 'daemons_present') {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'the organization still has daemons — remove them first'
          })
        }
        if (deleted.status === 'review_cleanup_pending') {
          deps.kickGithubRunReporter?.()
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'GitHub Check cleanup is pending — retry organization deletion after cleanup converges'
          })
        }
        // Best-effort, like the agent delete's own removal push: the rows are gone either way, and a
        // member that missed this drops the agents on its next register roster.
        await announceRemovals((err, daemonId) => {
          if (err instanceof NoConnection) {
            app.log.debug({ orgId, daemonId }, 'agent/remove skipped on org delete: daemon offline')
          } else {
            app.log.warn({ err, orgId, daemonId }, 'agent/remove failed on org delete (backstop: reconnect roster)')
          }
        })
        return reply.code(204).send(null)
      }
    )
  }
}
