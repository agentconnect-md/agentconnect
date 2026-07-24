/**
 * `http/org-scope.ts` — the org boundary for the path-scoped console API
 * (§3.2). Every org resource lives under `/orgs/:orgId/…`; this guard runs as
 * a plugin-level preHandler on that subtree (after `humanAuth`), verifies the
 * caller's membership in the PATH org, and attaches `req.orgCtx = { orgId,
 * role }` for the routes + the RBAC helpers. A non-member (or nonexistent org)
 * reads as 404 — the resource simply isn't theirs to see.
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { OrgRepo, OrgMemberRole } from '../persistence/ports.js'
import { OrgId } from '../domain/ids.js'

/** The org an authenticated request acts on + the caller's role and id in it.
 *  `userId` is plumbed here so per-resource visibility guards (`ctxOf` →
 *  `canView`/`canEdit`) read a single `req.orgCtx`. */
export interface OrgCtx {
  orgId: OrgId
  role: OrgMemberRole
  userId: string
}

declare module 'fastify' {
  interface FastifyRequest {
    orgCtx?: OrgCtx
  }
}

/** Build the org-scope preHandler for the `/orgs/:orgId` subtree. */
export function makeOrgScope(orgs: OrgRepo) {
  return async function orgScope(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    // The prefix param — present on every route registered under `/orgs/:orgId`.
    const orgId = (req.params as { orgId?: string }).orgId
    if (!orgId) {
      return reply.code(400).send({ error: 'Bad Request', statusCode: 400, message: 'missing orgId' })
    }
    // A personal API key is bound to ONE org — it may not reach another org's
    // subtree even if the caller is a member there. Reads as 404, like any org
    // that isn't yours to see (the membership check below is the same verdict).
    if (req.apiKeyOrgId && req.apiKeyOrgId !== orgId) {
      return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'organization not found' })
    }
    const role = await orgs.roleOf(orgId, req.principal!.userId)
    if (!role) {
      return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'organization not found' })
    }
    // Scope confinement (agent-assistant.md §6.3): an OAuth access token carries the
    // user's identity but is confined to its granted scopes. A non-empty scope set
    // WITHOUT `mcp:write` may not mutate org resources — otherwise a `mcp:read`
    // browser consent would silently authorize writes across the whole REST surface.
    // Personal keys have empty scopes (unrestricted). The MCP endpoint (POST
    // /api/v1/mcp) is outside this org subtree, so its tool-call POSTs are not
    // caught here; the MCP layer mirrors this rule per tool (write tools hidden and
    // refused without `mcp:write`, `http/mcp/routes.ts`), and the injected REST
    // request a write tool issues lands right back on this guard — the backstop.
    const scopes = req.apiKeyScopes
    if (scopes && scopes.length > 0 && !isReadMethod(req.method) && !scopes.includes('mcp:write')) {
      return reply
        .code(403)
        .send({ error: 'Forbidden', statusCode: 403, message: 'this token is limited to read-only access' })
    }
    req.orgCtx = { orgId: OrgId(orgId), role, userId: req.principal!.userId }
  }
}

/** GET/HEAD/OPTIONS are non-mutating; everything else is a write for scope purposes. */
function isReadMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
}
