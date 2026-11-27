// A departing member's linked platform identities, resolved as the console resolves a viewer's (session-visibility.md §2).
import type { FastifyBaseLogger } from 'fastify'
import type { HttpDeps } from './deps.js'
import { OrgId } from '../domain/ids.js'
import type { SessionAccessViewer } from './session-access-plugin.js'

/** The platform tuples beside `user:<id>` that may own the member's artifacts (artifacts.md §6.1); a provider outage leaves its tuples out. */
export async function departingMemberIdentities(
  deps: HttpDeps,
  orgId: string,
  userId: string,
  log: FastifyBaseLogger
): Promise<string[]> {
  const plugins = deps.sessionAccessPlugins ?? []
  if (plugins.length === 0) return []
  const oidcSubject = await deps.repos.user.getOidcSubject(userId)
  const viewer: SessionAccessViewer = {
    request: { log, ...(oidcSubject ? { oidcSubject } : {}) },
    orgId: OrgId(orgId),
    userId,
    identitySet: new Set()
  }
  await Promise.all(
    plugins.map(async (plugin) => {
      try {
        await plugin.addViewerIdentities?.(viewer)
      } catch (err) {
        log.warn({ err, provider: plugin.provider, userId }, 'member removal: linked identity lookup failed')
      }
    })
  )
  return [...viewer.identitySet].filter((identity) => identity !== `user:${userId}`)
}
