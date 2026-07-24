/**
 * `http/rbac.ts` — role checks for the C2 console routes (§3.2).
 *
 * The org-scope guard (`http/org-scope.ts`) verifies the caller's membership
 * in the PATH org (`/orgs/:orgId/…`) and attaches `req.orgCtx = { orgId,
 * role }`: `owner` edits everything plus members/org info, `collaborator`
 * edits everything except members/org info, `viewer` is read-only. Routes call
 * these tiny guards at the top of a handler; a `true` return means the reply
 * was already sent (403) and the handler must bail.
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { OrgId } from '../domain/ids.js'
import type { ViewCtx } from './visibility.js'

/** The org the request acts on — set by the org-scope guard on every
 *  `/orgs/:orgId` route before the handler runs. */
export function orgOf(req: FastifyRequest): OrgId {
  return req.orgCtx!.orgId
}

/** The caller's visibility context (id + role) for the `canView`/`canEdit`/
 *  `canManageSharing` predicates — the single place routes read it from. */
export function ctxOf(req: FastifyRequest): ViewCtx {
  return { userId: req.orgCtx!.userId, role: req.orgCtx!.role }
}

function forbid(reply: FastifyReply, message: string): void {
  void reply.code(403).send({ error: 'Forbidden', statusCode: 403, message })
}

/** Writes on org resources (agents, daemons, integrations, crons, bots):
 *  owners and collaborators pass, viewers are read-only. */
export function denyViewerWrite(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.orgCtx!.role !== 'viewer') return false
  forbid(reply, 'viewers are read-only')
  return true
}

/** Member management + org info changes: owners only. */
export function denyNonOwner(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.orgCtx!.role === 'owner') return false
  forbid(reply, 'only an organization owner can do this')
  return true
}
