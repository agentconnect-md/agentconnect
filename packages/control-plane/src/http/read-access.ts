// The console's session-visibility verdict for an identified asker, not the caller, for the daemon's read rule (assistant-mode.md §5.5).
import type { FastifyBaseLogger, FastifyRequest } from 'fastify'
import { canViewSession } from '../authorization/policy.js'
import { OrgId, SessionId } from '../domain/ids.js'
import type { ReadAccessViewer } from '../orchestrator/readAccess.js'
import type { SessionMetaRecord } from '../persistence/ports.js'
import type { HttpDeps } from './deps.js'
import { makeSessionAccessResolver } from './session-access.js'

/** Which of an agent's sessions `viewer` could see in the console: the same resolver and predicate the console's own reads use. */
export function sessionsVisibleTo(deps: HttpDeps, log: () => FastifyBaseLogger) {
  return async (viewer: ReadAccessViewer, agentId: string, sessionIds: readonly string[]): Promise<string[]> => {
    const rows = (await Promise.all(sessionIds.map((id) => deps.repos.session.getUnscoped(SessionId(id))))).filter(
      (row): row is SessionMetaRecord =>
        row !== null && String(row.orgId) === viewer.orgId && String(row.agentId) === agentId
    )
    if (rows.length === 0) return []
    const sub = await deps.repos.user.getOidcSubject(viewer.userId)
    // The resolver reads its viewer off a request; this one stands for the identified asker and carries nothing else.
    const request = {
      orgCtx: { orgId: OrgId(viewer.orgId), role: viewer.role, userId: viewer.userId },
      ...(sub ? { oidcSubject: sub } : {}),
      log: log()
    } as unknown as FastifyRequest
    const access = await makeSessionAccessResolver(deps).forSessions(request, rows)
    const principal = { userId: viewer.userId, role: viewer.role }
    return rows
      .filter((row) => canViewSession(row, principal, access.identitySet, access.externalAccess))
      .map((row) => String(row.id))
  }
}
