/** Organization invite links: owner management + authenticated redemption. */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { HttpDeps } from '../deps.js'
import type { ZodTypeProvider } from '../plugins/zod.js'
import { Tag } from '../plugins/openapi.js'
import { denyNonOwner } from '../rbac.js'
import {
  AcceptOrgInviteLinkBody,
  AcceptedOrgInviteLinkDto,
  CreatedOrgInviteLinkDto,
  CreateOrgInviteLinkBody,
  ErrorDto,
  IdParam,
  OrgInviteLinkDto,
  type OrgInviteLinkDtoT
} from '../dto/index.js'
import type { OrgInviteLinkView } from '../../registry/orgInviteLinkService.js'

function toDto(link: OrgInviteLinkView): OrgInviteLinkDtoT {
  return {
    id: link.id,
    displayTail: link.displayTail,
    status: link.status,
    expiresAt: link.expiresAt.toISOString(),
    revokedAt: link.revokedAt?.toISOString() ?? null,
    createdAt: link.createdAt.toISOString()
  }
}

/** OIDC + owner-only routes mounted inside `/orgs/:orgId`. */
export function orgInviteLinkRoutes(deps: HttpDeps) {
  return async function orgInviteLinkRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()

    r.get(
      '/invite-links',
      {
        preHandler: app.oidcAuth,
        schema: {
          tags: [Tag.Members],
          summary: 'Get the organization invite link',
          description:
            'Owner-only. Returns the organization’s single invite-link slot, including expired or revoked state. The plaintext token is never returned.',
          operationId: 'getOrganizationInviteLink',
          response: { 200: OrgInviteLinkDto.nullable(), 401: ErrorDto, 403: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        const link = await deps.inviteLinks.getForOrg(req.orgCtx!.orgId)
        return link ? toDto(link) : null
      }
    )

    r.post(
      '/invite-links',
      {
        preHandler: app.oidcAuth,
        schema: {
          tags: [Tag.Members],
          summary: 'Generate the organization invite link',
          description:
            'Owner-only. Generates the single seven-day, unlimited-use collaborator link. An active link must be revoked or expire first. The token is returned exactly once.',
          operationId: 'createOrganizationInviteLink',
          body: CreateOrgInviteLinkBody,
          response: { 201: CreatedOrgInviteLinkDto, 401: ErrorDto, 403: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        const created = await deps.inviteLinks.create(req.orgCtx!.orgId, req.principal!.userId)
        if (!created) {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'an active invite link already exists'
          })
        }
        return reply.code(201).send({ ...toDto(created), token: created.token })
      }
    )

    r.delete(
      '/invite-links/:id',
      {
        preHandler: app.oidcAuth,
        schema: {
          tags: [Tag.Members],
          summary: 'Revoke the organization invite link',
          description: 'Owner-only. Immediately revokes the link. Existing memberships are unchanged.',
          operationId: 'revokeOrganizationInviteLink',
          params: IdParam,
          response: { 204: z.null(), 401: ErrorDto, 403: ErrorDto, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        const found = await deps.inviteLinks.revoke(req.orgCtx!.orgId, req.params.id, req.principal!.userId)
        if (!found) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'invite link not found' })
        }
        return reply.code(204).send(null)
      }
    )
  }
}

/** OIDC-only root route: callers are not members of the target org yet. */
export function orgInviteAcceptRoutes(deps: HttpDeps) {
  return async function orgInviteAcceptRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()

    r.post(
      '/invite-links/accept',
      {
        preHandler: app.oidcAuth,
        schema: {
          tags: [Tag.Members],
          summary: 'Accept an organization invite link',
          description:
            'Redeems a valid link for the signed-in account as collaborator. A removed account cannot redeem the same link again.',
          operationId: 'acceptOrganizationInviteLink',
          body: AcceptOrgInviteLinkBody,
          response: { 200: AcceptedOrgInviteLinkDto, 401: ErrorDto, 410: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const result = await deps.inviteLinks.accept(req.body.token, req.principal!.userId)
        if (result.status === 'unavailable') {
          return reply.code(410).send({
            error: 'Gone',
            statusCode: 410,
            message: 'this invite link is no longer available',
            code: 'INVITE_LINK_UNAVAILABLE'
          })
        }
        return result
      }
    )
  }
}
