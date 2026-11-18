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
import type { OrgSsoSessionRule } from '../org-sso/session.js'

/** The browser session must sign in through the organization's SSO connection first (organization-sso.md §4.5). */
export const ORG_SSO_SIGN_IN_REQUIRED = 'ORG_SSO_SIGN_IN_REQUIRED'

/** Refuse an interactive session that organization SSO sends through the organization's connection; true when it replied. */
export async function refuseWithoutOrgSso(
  rule: OrgSsoSessionRule | undefined,
  req: FastifyRequest,
  reply: FastifyReply,
  orgId: string
): Promise<boolean> {
  // Only a browser session has a sign-in method; API keys, OAuth tokens and delegated calls are credentials issued earlier.
  if (!rule || req.oidcSubject === undefined || req.apiKeyId !== undefined) return false
  let required: Awaited<ReturnType<OrgSsoSessionRule['requirement']>>
  try {
    required = await rule.requirement(orgId, {
      subject: req.oidcSubject,
      ssoConnectorId: req.signInSsoConnectorId ?? null
    })
  } catch (err) {
    req.log.warn({ err }, 'org sso: could not check the session against the organization connection')
    void reply.code(503).send({ error: 'Service Unavailable', statusCode: 503, message: 'temporarily unavailable' })
    return true
  }
  if (!required) return false
  void reply.code(403).send({
    error: 'Forbidden',
    statusCode: 403,
    message: `sign in through ${required.name} to open this organization`,
    code: ORG_SSO_SIGN_IN_REQUIRED
  })
  return true
}

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
export function makeOrgScope(orgs: OrgRepo, orgSso?: OrgSsoSessionRule) {
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
    // After membership, so a non-member learns nothing about the organization's sign-in.
    if (await refuseWithoutOrgSso(orgSso, req, reply, orgId)) return
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
