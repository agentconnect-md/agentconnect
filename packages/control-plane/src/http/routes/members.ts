/**
 * `http/routes/members.ts` — the active org's members (C2, authenticated
 * console ops, §3.2).
 *
 *   GET    /members      → list the org's members (membership + user)
 *   POST   /members      → add a member by email (owner-only; no email sent —
 *                          unknown addresses become invited rows, claimed on
 *                          first SSO sign-in)
 *   PATCH  /members/:id  → change a member's role (owner-only)
 *   GET    /members/:id/removal-preview
 *                        → who would inherit their resources, and how many
 *   DELETE /members/:id  → leave the org; owners may remove another member
 *
 * All scoped to `req.principal.orgId` (the console's active org). The
 * last-owner guard keeps an org from orphaning itself: the final owner can't
 * be demoted or leave.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import type { OrgMemberRecord } from '../../persistence/ports.js'
import { denyMemberRemoval, denyNonOwner } from '../rbac.js'
import { Tag } from '../plugins/openapi.js'
import {
  MemberDto,
  MemberListDto,
  MemberRemovalPreviewDto,
  UpdateMemberBody,
  AddMemberBody,
  IdParam,
  ErrorDto,
  type MemberDtoT
} from '../dto/index.js'
import { resolveProfilePictureUrl } from '../../icons/icon-store.js'

function toDto(m: OrgMemberRecord, currentUserId: string, deps: HttpDeps): MemberDtoT {
  return {
    userId: m.userId,
    email: m.email,
    name: m.displayName,
    picture: resolveProfilePictureUrl(m.userId, m.picture, m.profilePictureUpdatedAt, deps.iconStore),
    role: m.role,
    isCurrentUser: m.userId === currentUserId,
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
        return rows.map((row) => toDto(row, req.orgCtx!.userId, deps))
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
        return reply.code(201).send(toDto(added, req.orgCtx!.userId, deps))
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
        const updated = await deps.repos.user.setMemberRole(orgId, userId, req.body.role, req.orgCtx!.userId)
        return toDto(updated, req.orgCtx!.userId, deps)
      }
    )

    r.get(
      '/members/:id/removal-preview',
      {
        schema: {
          tags: [Tag.Members],
          summary: 'Preview a leave or removal',
          description:
            'What DELETE /members/:id would do to Selected audiences: which current member would be added only where the audience would otherwise become empty, and per-resource-kind counts for all affected and reassigned audiences. Same authorization as the removal itself. Advisory only: nothing is locked, and the removal re-derives the replacement inside the transaction.',
          operationId: 'previewMemberRemoval',
          params: IdParam,
          response: { 200: MemberRemovalPreviewDto, 403: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyMemberRemoval(req, reply, req.params.id)) return
        const preview = await deps.repos.user.previewMemberRemoval(req.orgCtx!.orgId, req.params.id, req.orgCtx!.userId)
        return {
          replacement: preview.replacement ? toDto(preview.replacement, req.orgCtx!.userId, deps) : null,
          resources: preview.resources
        }
      }
    )

    r.delete(
      '/members/:id',
      {
        schema: {
          tags: [Tag.Members],
          summary: 'Leave or remove a member',
          description:
            'Any member can remove their own membership to leave the org. Only owners can remove another member. The last owner can’t leave, which would orphan the org.',
          operationId: 'removeMember',
          params: IdParam,
          response: { 204: z.null(), 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        const orgId = req.orgCtx!.orgId
        const userId = req.params.id
        const actingUserId = req.orgCtx!.userId
        if (denyMemberRemoval(req, reply, userId)) return
        await deps.repos.user.removeMember(orgId, userId, actingUserId)
        return reply.code(204).send(null)
      }
    )
  }
}
