import { LRUCache } from 'lru-cache'
import { cacheOptions } from '../cache.js'
import type { Clock } from '../domain/clock.js'
import { BotId } from '../domain/ids.js'
import type { LogtoIdentityService } from '../github/logto-identity.js'
import type { BotRecord, BotRepo, BotSecretStore, ExternalScopeRecord } from '../persistence/ports.js'
import type {
  SessionAccessIssue,
  SessionAccessPlugin,
  SessionAccessResult,
  SessionAccessViewer
} from '../http/session-access-plugin.js'

// `cause` names why a check could not answer, for the operator's degraded warn only.
type Decision = { allowed: boolean; issue?: SessionAccessIssue; cause?: string }
type Check = { token: string; bot: BotRecord; resource: string; member: string; signal: AbortSignal }

const CHECK_BUDGET_MS = 5_000
const CHECK_CONCURRENCY = 4

function failureCause(error: unknown): string {
  if (error instanceof BotAccessError) return error.reason
  const name = error instanceof Error ? error.name : ''
  return name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'error'
}

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
  log?: { warn: (obj: object, msg: string) => void }
}

// Bot credentials prove conversation access; verified global account ids identify the viewer.
export class BotSessionAccessService implements SessionAccessPlugin {
  private readonly decisions: LRUCache<string, Decision, Check>

  constructor(
    readonly provider: string,
    private readonly deps: BotSessionAccessDeps,
    private readonly realm: (token: string, bot: BotRecord) => string | null,
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
            issue: { provider, reason: error instanceof BotAccessError ? error.reason : 'unavailable' },
            cause: failureCause(error)
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
      const realm = secret && this.realm(secret.botToken, bot)
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
    // Per scope, the first reason its check could not answer; viewer-side `authorization` is not an operator fault.
    const causes = new Map<string, string>()
    const signal = AbortSignal.timeout(CHECK_BUDGET_MS)
    const check = async (scope: ExternalScopeRecord) => {
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
      if (!secret || this.realm(secret.botToken, bot) !== scope.realmKey) return
      for (const member of members) {
        const key = [scope.id, scope.aclRevision, bot.credentialRevision, member].join(':')
        const result = await this.decisions.fetch(key, {
          context: { token: secret.botToken, bot, resource: scope.resourceKey, member, signal }
        })
        if (result?.allowed) {
          allowedScopes.push({ id: scope.id, aclRevision: scope.aclRevision })
          return
        }
        const issue = result?.issue
        if (issue) {
          issues.set(issue.reason, issue)
          if (!causes.has(scope.id)) causes.set(scope.id, result.cause ?? issue.reason)
        }
      }
    }
    // A worker pool, not lock-step batches: one slow conversation holds only its own worker, not every scope after it.
    let next = 0
    const worker = async () => {
      while (next < scopes.length) {
        const scope = scopes[next++]!
        if (signal.aborted) {
          issues.set('unavailable', { provider: this.provider, reason: 'unavailable' })
          causes.set(scope.id, 'deadline')
          continue
        }
        await check(scope)
      }
    }
    await Promise.all(Array.from({ length: Math.min(CHECK_CONCURRENCY, scopes.length) }, worker))
    if (causes.size > 0) {
      const counts: Record<string, number> = {}
      for (const cause of causes.values()) counts[cause] = (counts[cause] ?? 0) + 1
      this.deps.log?.warn(
        { provider: this.provider, degradedScopes: causes.size, totalScopes: scopes.length, causes: counts },
        `${this.provider} access check degraded — affected sessions are hidden until access can be verified`
      )
    }
    return { allowedScopes, degraded: issues.size > 0, accessIssues: [...issues.values()] }
  }
}
