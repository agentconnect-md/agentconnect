import type { FetchLike } from '../github/api.js'
import type { Clock } from '../domain/clock.js'
import type { BotRepo, BotSecretStore, ExternalScopeRecord } from '../persistence/ports.js'
import { BotId } from '../domain/ids.js'

const ALLOW_TTL_MS = 120_000
const DENY_TTL_MS = 30_000
const UNKNOWN_TTL_MS = 5_000
const MAX_CACHE_ENTRIES = 10_000
const MAX_SCOPES_PER_REQUEST = 200
const MAX_MEMBER_PAGES = 50
const PAGE_SIZE = 200
const TIMEOUT_MS = 5_000

type Decision = 'allow' | 'deny' | 'unknown'
type SlackPrincipal = { key: string; teamId: string; userId: string }

type CachedDecision = { decision: Decision; expiresAt: number }

export interface SlackSessionAccessResult {
  allowedScopes: Array<{ id: string; aclRevision: bigint }>
  degraded: boolean
}

export interface SlackSessionAccessResolver {
  resolve(scopes: readonly ExternalScopeRecord[], identitySet: ReadonlySet<string>): Promise<SlackSessionAccessResult>
}

function slackPrincipals(identitySet: ReadonlySet<string>): SlackPrincipal[] {
  const principals: SlackPrincipal[] = []
  for (const key of identitySet) {
    const match = /^slack:([^:]+):([^:]+)$/.exec(key)
    if (match) principals.push({ key, teamId: match[1]!, userId: match[2]! })
  }
  return principals
}

async function mapLimited<T, R>(values: readonly T[], limit: number, fn: (value: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(values.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (next < values.length) {
        const index = next++
        out[index] = await fn(values[index]!)
      }
    })
  )
  return out
}

/** Slack v1 current-conversation membership resolver. The cache retains only a
 * bounded ACL verdict; linked identity remains request-local and provider-owned. */
export class SlackSessionAccessService implements SlackSessionAccessResolver {
  private readonly cache = new Map<string, CachedDecision>()

  constructor(
    private readonly deps: {
      bots: BotRepo
      botSecrets: BotSecretStore
      clock: Clock
      fetchImpl?: FetchLike
    }
  ) {}

  async resolve(
    scopes: readonly ExternalScopeRecord[],
    identitySet: ReadonlySet<string>
  ): Promise<SlackSessionAccessResult> {
    const principals = slackPrincipals(identitySet)
    if (principals.length === 0 || scopes.length === 0) return { allowedScopes: [], degraded: false }
    const bounded = scopes.slice(0, MAX_SCOPES_PER_REQUEST)
    const signal = AbortSignal.timeout(TIMEOUT_MS)
    let degraded = scopes.length > bounded.length
    const decisions = await mapLimited(bounded, 6, async (scope) => {
      const result = await this.resolveScope(scope, principals, signal)
      if (result === 'unknown') degraded = true
      return { scope, decision: result }
    })
    return {
      allowedScopes: decisions
        .filter(({ decision }) => decision === 'allow')
        .map(({ scope }) => ({ id: scope.id, aclRevision: scope.aclRevision })),
      degraded
    }
  }

  private async resolveScope(
    scope: ExternalScopeRecord,
    principals: readonly SlackPrincipal[],
    signal: AbortSignal
  ): Promise<Decision> {
    if (
      scope.provider !== 'slack' ||
      scope.resourceKind !== 'conversation' ||
      scope.revokedAt !== null ||
      scope.credentialKind !== 'bot' ||
      !scope.credentialId
    ) {
      return 'deny'
    }
    const bot = await this.deps.bots.get(BotId(scope.credentialId)).catch(() => null)
    const realm = bot?.workspaceId ?? bot?.teamId
    if (
      !bot ||
      bot.orgId !== scope.orgId ||
      bot.platform !== 'slack' ||
      bot.revokedAt !== null ||
      realm !== scope.realmKey
    ) {
      return 'unknown'
    }
    let sawUnknown = false
    for (const principal of principals) {
      const key = [scope.id, scope.aclRevision.toString(), bot.credentialRevision, principal.key].join(':')
      const cached = this.cache.get(key)
      let decision = cached && cached.expiresAt > this.deps.clock.now() ? cached.decision : undefined
      if (!decision) {
        decision = await this.checkMembership(scope, principal, bot.id, signal)
        this.putCache(key, decision)
      }
      if (decision === 'allow') return 'allow'
      if (decision === 'unknown') sawUnknown = true
    }
    return sawUnknown ? 'unknown' : 'deny'
  }

  private async checkMembership(
    scope: ExternalScopeRecord,
    principal: SlackPrincipal,
    botId: string,
    signal: AbortSignal
  ): Promise<Decision> {
    const secret = await this.deps.botSecrets.get(BotId(botId)).catch(() => null)
    if (!secret?.botToken) return 'unknown'
    try {
      let cursor = ''
      let found = false
      for (let page = 0; page < MAX_MEMBER_PAGES; page++) {
        const query = new URLSearchParams({ channel: scope.resourceKey, limit: String(PAGE_SIZE) })
        if (cursor) query.set('cursor', cursor)
        const body = await this.slackCall<{
          ok?: boolean
          error?: string
          members?: unknown
          response_metadata?: { next_cursor?: unknown }
        }>(`conversations.members?${query}`, secret.botToken, signal)
        if (!body.ok || !Array.isArray(body.members)) return 'unknown'
        if (body.members.includes(principal.userId)) {
          found = true
          break
        }
        cursor = typeof body.response_metadata?.next_cursor === 'string' ? body.response_metadata.next_cursor : ''
        if (!cursor) break
        if (page === MAX_MEMBER_PAGES - 1) return 'unknown'
      }
      if (!found) return 'deny'
      if (principal.teamId === scope.realmKey) return 'allow'

      // Slack Connect can return a member from another workspace. Verify the
      // identity's home team instead of treating the installing team as proof.
      const user = await this.slackCall<{
        ok?: boolean
        user?: {
          team_id?: unknown
          profile?: { team?: unknown }
          enterprise_user?: { teams?: unknown }
        }
      }>(`users.info?user=${encodeURIComponent(principal.userId)}`, secret.botToken, signal)
      if (!user.ok || !user.user) return 'unknown'
      const teams = new Set<string>()
      if (typeof user.user.team_id === 'string') teams.add(user.user.team_id)
      if (typeof user.user.profile?.team === 'string') teams.add(user.user.profile.team)
      if (Array.isArray(user.user.enterprise_user?.teams)) {
        for (const team of user.user.enterprise_user.teams) if (typeof team === 'string') teams.add(team)
      }
      return teams.has(principal.teamId) ? 'allow' : 'deny'
    } catch {
      return 'unknown'
    }
  }

  private async slackCall<T>(path: string, token: string, signal: AbortSignal): Promise<T> {
    const fetchImpl = this.deps.fetchImpl ?? (fetch as FetchLike)
    const response = await fetchImpl(`https://slack.com/api/${path}`, {
      headers: { authorization: `Bearer ${token}` },
      signal
    })
    if (!response.ok) throw new Error(`Slack request failed: ${response.status}`)
    return (await response.json()) as T
  }

  private putCache(key: string, decision: Decision): void {
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value as string | undefined
      if (oldest) this.cache.delete(oldest)
    }
    const ttl = decision === 'allow' ? ALLOW_TTL_MS : decision === 'deny' ? DENY_TTL_MS : UNKNOWN_TTL_MS
    this.cache.set(key, { decision, expiresAt: this.deps.clock.now() + ttl })
  }
}
