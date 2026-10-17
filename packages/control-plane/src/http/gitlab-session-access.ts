import { LRUCache } from 'lru-cache'
import { cacheOptions } from '../cache.js'
import type { Clock } from '../domain/clock.js'
import type { LogtoIdentityService } from '../github/logto-identity.js'
import {
  GITLAB_ACCESS_REPORTER,
  GitlabApiError,
  gitlabEffectiveMembership,
  gitlabProject,
  membershipSatisfies,
  type GitlabApiClient
} from '../gitlab/api.js'
import type { GitlabOauthService } from '../gitlab/oauth.service.js'
import type {
  ExternalScopeRecord,
  GitlabConnectionRepo,
  GitlabProjectBindingRepo,
  UserRepo
} from '../persistence/ports.js'
import type {
  SessionAccessIssue,
  SessionAccessPlugin,
  SessionAccessResult,
  SessionAccessViewer
} from './session-access-plugin.js'

type Verdict = { allowed: boolean; issue?: SessionAccessIssue['reason'] }

// Project audiences use the connected administrator for reads and the viewer's issuer-bound login for membership.
export class GitlabSessionAccessService implements SessionAccessPlugin {
  readonly provider = 'gitlab'
  private readonly verdicts: LRUCache<string, Verdict, () => Promise<Verdict>>

  constructor(
    private readonly deps: {
      bindings: Pick<GitlabProjectBindingRepo, 'get'>
      connections: Pick<GitlabConnectionRepo, 'get'>
      users: Pick<UserRepo, 'getOidcSubject'>
      clock: Clock
      configured: boolean
      api?: GitlabApiClient
      oauth?: Pick<GitlabOauthService, 'withAccessToken'>
      identity?: Pick<LogtoIdentityService, 'gitlabUserIdFor'>
    }
  ) {
    this.verdicts = new LRUCache({
      ...cacheOptions(deps.clock, 10_000),
      ttl: 120_000,
      fetchMethod: async (_key, _stale, { context, options }) => {
        const result = await context()
        options.ttl = result.issue ? 5_000 : result.allowed ? 120_000 : 30_000
        return result
      }
    })
  }

  get available(): boolean {
    return !!(this.deps.configured && this.deps.api && this.deps.oauth && this.deps.identity)
  }

  async resolve(scopes: readonly ExternalScopeRecord[], viewer: SessionAccessViewer): Promise<SessionAccessResult> {
    const allowedScopes: SessionAccessResult['allowedScopes'] = []
    const issues = new Set<SessionAccessIssue['reason']>()
    let identity: Promise<string | null> | undefined
    const userId = () =>
      (identity ??= (async () => {
        const sub = viewer.request.oidcSubject ?? (await this.deps.users.getOidcSubject(viewer.userId))
        return sub && this.deps.api && this.deps.identity
          ? this.deps.identity.gitlabUserIdFor(sub, this.deps.api.baseUrl)
          : null
      })())
    for (let start = 0; start < scopes.length; start += 6) {
      await Promise.all(
        scopes.slice(start, start + 6).map(async (scope) => {
          const verdict = await this.resolveScope(scope, viewer, userId).catch((error: unknown): Verdict => ({
            allowed: false,
            issue:
              error instanceof GitlabApiError && error.code === 'AUTH_REQUIRED' ? 'app_authorization' : 'unavailable'
          }))
          if (verdict.allowed) allowedScopes.push({ id: scope.id, aclRevision: scope.aclRevision })
          if (verdict.issue) issues.add(verdict.issue)
        })
      )
    }
    return {
      allowedScopes,
      degraded: issues.size > 0,
      accessIssues: [...issues].map((reason) => ({ provider: this.provider, reason }))
    }
  }

  private async resolveScope(
    scope: ExternalScopeRecord,
    viewer: SessionAccessViewer,
    userId: () => Promise<string | null>
  ): Promise<Verdict> {
    const { api, oauth } = this.deps
    if (!api || !oauth) return { allowed: false, issue: 'app_authorization' }
    if (
      scope.provider !== this.provider ||
      scope.orgId !== viewer.orgId ||
      scope.realmKey !== api.baseUrl ||
      scope.resourceKind !== 'repository' ||
      scope.revokedAt !== null ||
      scope.credentialKind !== 'gitlab_project_binding' ||
      !scope.credentialId ||
      !/^[1-9]\d*$/.test(scope.resourceKey)
    )
      return { allowed: false }
    const binding = await this.deps.bindings.get(viewer.orgId, scope.credentialId)
    if (
      !binding ||
      binding.orgId !== viewer.orgId ||
      binding.projectId.toString() !== scope.resourceKey ||
      binding.state === 'cleanup_pending'
    )
      return { allowed: false }
    if (!binding.installerConnectionId) return { allowed: false, issue: 'app_authorization' }
    const connection = await this.deps.connections.get(viewer.orgId, binding.installerConnectionId)
    if (!connection || connection.state !== 'connected') return { allowed: false, issue: 'app_authorization' }
    const key = [
      scope.id,
      scope.aclRevision,
      binding.credentialEpoch,
      connection.id,
      connection.tokenVersion,
      viewer.userId
    ].join(':')
    return (
      (await this.verdicts.fetch(key, {
        context: async () => {
          const token = await oauth.withAccessToken(viewer.orgId, connection.id)
          const project = await gitlabProject(token, binding.projectId, api)
          if (!project || !['enabled', 'private'].includes(project.repository_access_level ?? ''))
            return { allowed: false }
          if (project.visibility === 'public' && project.repository_access_level === 'enabled') return { allowed: true }
          const id = await userId()
          if (!id) return { allowed: false, issue: 'authorization' }
          const membership = await gitlabEffectiveMembership(token, binding.projectId, BigInt(id), api)
          return { allowed: membershipSatisfies(membership, GITLAB_ACCESS_REPORTER, this.deps.clock.now()) }
        }
      })) ?? { allowed: false, issue: 'unavailable' }
    )
  }
}
