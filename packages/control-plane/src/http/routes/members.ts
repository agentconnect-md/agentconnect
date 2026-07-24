/**
 * `http/routes/members.ts` — the active org's members (C2, authenticated
 * console ops, §3.2).
 *
 *   GET    /members      → list the org's members (membership + user)
 *   POST   /members      → add a member by email (owner-only; no email sent —
 *                          unknown addresses become invited rows, claimed on
 *                          first SSO sign-in)
 *   PATCH  /members/:id  → change a member's role (owner-only)
 *   DELETE /members/:id  → remove a member (owner-only)
 *
 * All scoped to `req.principal.orgId` (the console's active org). The
 * last-owner guard keeps an org from orphaning itself: the final owner can't
 * be demoted or removed.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import type { OrgMemberRecord } from '../../persistence/ports.js'
import { denyNonOwner } from '../rbac.js'
import { Tag } from '../plugins/openapi.js'
import {
  MemberDto,
  MemberListDto,
  UpdateMemberBody,
  AddMemberBody,
  IdParam,
  ErrorDto,
  type MemberDtoT
} from '../dto/index.js'
import { resolveProfilePictureUrl } from '../../icons/icon-store.js'

function toDto(m: OrgMemberRecord, deps: HttpDeps): MemberDtoT {
  return {
    userId: m.userId,
    email: m.email,
    name: m.displayName,
    picture: resolveProfilePictureUrl(m.userId, m.picture, m.profilePictureUpdatedAt, deps.iconStore),
    role: m.role,
    joinedAt: m.joinedAt.toISOString()
  }
}

export function memberRoutes(deps: HttpDeps) {
  return async function memberRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()

    r.get(
      '/members',
      {
        schema: {
          tags: [Tag.Members],
          summary: 'List members',
          description: 'The active org’s members — membership joined with each user’s profile.',
          operationId: 'listMembers',
          response: { 200: MemberListDto }
        }
      },
      async (req) => {
        const rows = await deps.repos.user.listMembers(req.orgCtx!.orgId)
        return rows.map((row) => toDto(row, deps))
      }
    )

    r.post(
      '/members',
      {
        schema: {
          tags: [Tag.Members],
          summary: 'Add a member',
          description:
            'Owner-only. Adds a member by email with the given role; no email is sent — an unknown address becomes an invited row, claimed on first SSO sign-in.',
          operationId: 'addMember',
          body: AddMemberBody,
          response: { 201: MemberDto, 403: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        const added = await deps.repos.user.addMemberByEmail(req.orgCtx!.orgId, req.body.email, req.body.role)
        return reply.code(201).send(toDto(added, deps))
      }
    )

    r.patch(
      '/members/:id',
      {
        schema: {
          tags: [Tag.Members],
          summary: 'Change a member’s role',
          description:
            'Owner-only. Changes a member’s role; the last owner can’t be demoted, which would orphan the org.',
          operationId: 'updateMember',
          params: IdParam,
          body: UpdateMemberBody,
          response: { 200: MemberDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        const orgId = req.orgCtx!.orgId
        const userId = req.params.id
        const current = (await deps.repos.user.listMembers(orgId)).find((m) => m.userId === userId)
        if (!current) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'member not found' })
        }
        // Demoting the final owner would orphan the org.
        if (current.role === 'owner' && req.body.role !== 'owner') {
          const owners = await deps.repos.org.countOwners(orgId)
          if (owners <= 1) {
            return reply
              .code(409)
              .send({ error: 'Conflict', statusCode: 409, message: 'an organization needs at least one owner' })
          }
        }
        const updated = await deps.repos.user.setMemberRole(orgId, userId, req.body.role)
        // Compensate the check-then-act window: two concurrent demotes can both
        // pass the pre-check — if the org just lost its last owner, restore.
        if (current.role === 'owner' && (await deps.repos.org.countOwners(orgId)) === 0) {
          await deps.repos.user.setMemberRole(orgId, userId, 'owner')
          return reply
            .code(409)
            .send({ error: 'Conflict', statusCode: 409, message: 'an organization needs at least one owner' })
        }
        return toDto(updated, deps)
      }
    )

    r.delete(
      '/members/:id',
      {
        schema: {
          tags: [Tag.Members],
          summary: 'Remove a member',
          description:
            'Owner-only. Removes a member from the org; the last owner can’t be removed, which would orphan the org.',
          operationId: 'removeMember',
          params: IdParam,
          response: { 204: z.null(), 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        const orgId = req.orgCtx!.orgId
        const userId = req.params.id
        const current = (await deps.repos.user.listMembers(orgId)).find((m) => m.userId === userId)
        if (!current) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'member not found' })
        }
        if (current.role === 'owner') {
          const owners = await deps.repos.org.countOwners(orgId)
          if (owners <= 1) {
            return reply
              .code(409)
              .send({ error: 'Conflict', statusCode: 409, message: 'an organization needs at least one owner' })
          }
        }
        await deps.repos.user.removeMember(orgId, userId)
        // Compensate the check-then-act window (see PATCH above): if the org just
        // lost its last owner to a concurrent removal, put this membership back.
        if (current.role === 'owner' && (await deps.repos.org.countOwners(orgId)) === 0) {
          await deps.repos.user.addMember(orgId, userId, 'owner').catch(() => {})
          return reply
            .code(409)
            .send({ error: 'Conflict', statusCode: 409, message: 'an organization needs at least one owner' })
        }
        return reply.code(204).send(null)
      }
    )
  }
}
