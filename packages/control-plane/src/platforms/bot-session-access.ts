import { LRUCache } from 'lru-cache'
import { cacheOptions } from '../cache.js'
import type { Clock } from '../domain/clock.js'
import { BotId } from '../domain/ids.js'
import type { LogtoIdentityService } from '../github/logto-identity.js'
import type { BotRepo, BotSecretStore, ExternalScopeRecord } from '../persistence/ports.js'
import type {
  SessionAccessIssue,
  SessionAccessPlugin,
  SessionAccessResult,
  SessionAccessViewer
} from '../http/session-access-plugin.js'

type Decision = { allowed: boolean; issue?: SessionAccessIssue }
type Check = { token: string; resource: string; member: string; signal: AbortSignal }

export class BotAccessError extends Error {
  constructor(readonly reason: SessionAccessIssue['reason']) {
    super(reason)
  }
}

export interface BotSessionAccessDeps {
  bots: Pick<BotRepo, 'getUnscoped' | 'listForOrg'>
  botSecrets: Pick<BotSecretStore, 'get'>
  clock: Clock
  identity?: Pick<LogtoIdentityService, 'chatIdentitiesFor'>
  configured: boolean
}

// Bot credentials prove conversation access; verified global account ids identify the viewer.
export class BotSessionAccessService implements SessionAccessPlugin {
  private readonly decisions: LRUCache<string, Decision, Check>

  constructor(
    readonly provider: string,
    private readonly deps: BotSessionAccessDeps,
    private readonly realm: (token: string) => string | null,
    check: (input: Check, signal: AbortSignal) => Promise<boolean>
  ) {
    this.decisions = new LRUCache({
      ...cacheOptions(deps.clock, 10_000),
      ttl: 5_000,
      fetchMethod: async (_key, _stale, { context, options }) => {
        try {
          const allowed = await check(context, context.signal)
          options.ttl = allowed ? 120_000 : 30_000
          return { allowed }
        } catch (error) {
          options.ttl = 5_000
          return {
            allowed: false,
            issue: { provider, reason: error instanceof BotAccessError ? error.reason : 'unavailable' }
          }
        }
      }
    })
  }

  get available(): boolean {
    return this.deps.configured && this.deps.identity !== undefined
  }

  async addViewerIdentities({ request, orgId, identitySet }: SessionAccessViewer): Promise<void> {
    if (!request.oidcSubject || !this.deps.identity) return
    const members = (await this.deps.identity.chatIdentitiesFor(request.oidcSubject))
      .filter((identity) => identity.platform === this.provider && identity.tenant === 'global')
      .map((identity) => identity.memberId)
    if (members.length === 0) return
    for (const member of members) identitySet.add(`${this.provider}:global:${member}`)
    for (const bot of await this.deps.bots.listForOrg(orgId)) {
      if (bot.platform !== this.provider || bot.revokedAt !== null) continue
      const secret = await this.deps.botSecrets.get(orgId, bot.id)
      const realm = secret && this.realm(secret.botToken)
      if (realm) for (const member of members) identitySet.add(`${this.provider}:${realm}:${member}`)
    }
  }

  async resolve(scopes: readonly ExternalScopeRecord[], viewer: SessionAccessViewer): Promise<SessionAccessResult> {
    const prefix = `${this.provider}:global:`
    const members = [...viewer.identitySet]
      .filter((identity) => identity.startsWith(prefix))
      .map((identity) => identity.slice(prefix.length))
    const allowedScopes: SessionAccessResult['allowedScopes'] = []
    const issues = new Map<string, SessionAccessIssue>()
    const signal = AbortSignal.timeout(5_000)
    for (let start = 0; start < scopes.length; start += 4) {
      if (signal.aborted) {
        issues.set('unavailable', { provider: this.provider, reason: 'unavailable' })
        break
      }
      await Promise.all(
        scopes.slice(start, start + 4).map(async (scope) => {
          if (
            scope.orgId !== viewer.orgId ||
            scope.provider !== this.provider ||
            scope.resourceKind !== 'conversation' ||
            scope.revokedAt !== null ||
            scope.credentialKind !== 'bot' ||
            !scope.credentialId
          )
            return
          if (!this.available || members.length === 0) {
            issues.set('authorization', { provider: this.provider, reason: 'authorization' })
            return
          }
          const bot = await this.deps.bots.getUnscoped(BotId(scope.credentialId))
          if (!bot || bot.orgId !== viewer.orgId || bot.platform !== this.provider || bot.revokedAt !== null) return
          const secret = await this.deps.botSecrets.get(viewer.orgId, bot.id)
          if (!secret || this.realm(secret.botToken) !== scope.realmKey) return
          for (const member of members) {
            const key = [scope.id, scope.aclRevision, bot.credentialRevision, member].join(':')
            const result = await this.decisions.fetch(key, {
              context: { token: secret.botToken, resource: scope.resourceKey, member, signal }
            })
            if (result?.allowed) {
              allowedScopes.push({ id: scope.id, aclRevision: scope.aclRevision })
              return
            }
            const issue = result?.issue
            if (issue) issues.set(issue.reason, issue)
          }
        })
      )
    }
    return { allowedScopes, degraded: issues.size > 0, accessIssues: [...issues.values()] }
  }
}
