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
type ConversationAudience = 'public' | 'members' | 'gone' | 'unknown'
type WorkspaceAccess = 'allow' | 'membership' | 'deny' | 'unknown'
type SlackPrincipal = { key: string; teamId: string; userId: string }

type CachedDecision = { decision: Decision; expiresAt: number }
type CachedWorkspaceAccess = { access: WorkspaceAccess; expiresAt: number }

export interface SlackSessionAccessResult {
  allowedScopes: Array<{ id: string; aclRevision: bigint }>
  degraded: boolean
}

export interface SlackSessionAccessResolver {
  resolve(scopes: readonly ExternalScopeRecord[], identitySet: ReadonlySet<string>): Promise<SlackSessionAccessResult>
}

// `ok: false` covers two very different answers, and conflating them is what
// made an ordinary event — a private channel deleted, or the bot removed from
// it — report as a degraded access check. These codes are Slack ANSWERING: this
// credential cannot see that conversation / that user is not in the workspace.
// Nothing about a later retry changes them, so they are a plain deny (cached for
// DENY_TTL rather than re-asked every UNKNOWN_TTL). Everything else — auth,
// scope, rate limiting, outages, unrecognized codes, transport failures — is the
// CHECK failing, stays 'unknown', and is what `degraded` is for.
const DEFINITIVE_DENIALS = new Set([
  'channel_not_found',
  'not_in_channel',
  'user_not_found',
  'users_not_found',
  'user_not_visible'
])

function failureDecision(error: unknown): Decision {
  return typeof error === 'string' && DEFINITIVE_DENIALS.has(error) ? 'deny' : 'unknown'
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

/** Slack v1 current-access resolver. Public channels follow workspace access;
 * restricted conversations follow membership. Caches retain only bounded ACL
 * verdicts; linked identity remains request-local and provider-owned. */
export class SlackSessionAccessService implements SlackSessionAccessResolver {
  private readonly cache = new Map<string, CachedDecision>()
  private readonly workspaceAccessCache = new Map<string, CachedWorkspaceAccess>()

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
        decision = await this.checkAccess(scope, principal, bot.id, bot.credentialRevision, signal)
        this.putCache(key, decision)
      }
      if (decision === 'allow') return 'allow'
      if (decision === 'unknown') sawUnknown = true
    }
    return sawUnknown ? 'unknown' : 'deny'
  }

  private async checkAccess(
    scope: ExternalScopeRecord,
    principal: SlackPrincipal,
    botId: string,
    credentialRevision: number,
    signal: AbortSignal
  ): Promise<Decision> {
    const secret = await this.deps.botSecrets.get(BotId(botId)).catch(() => null)
    if (!secret?.botToken) return 'unknown'
    try {
      const audience = await this.conversationAudience(scope.resourceKey, secret.botToken, signal)
      // The conversation is gone (or the bot is no longer in it): a settled fact
      // about the audience, not an unavailable check.
      if (audience === 'gone') return 'deny'
      if (audience === 'unknown') return 'unknown'
      if (audience === 'public') {
        const access = await this.workspaceAccess(
          scope.realmKey,
          principal,
          credentialRevision,
          secret.botToken,
          signal
        )
        if (access !== 'membership') return access
        return this.checkMembership(scope.resourceKey, principal.userId, secret.botToken, signal)
      }

      const member = await this.checkMembership(scope.resourceKey, principal.userId, secret.botToken, signal)
      if (member !== 'allow' || principal.teamId === scope.realmKey) return member

      // Slack Connect can return a member from another workspace. Verify the
      // identity's home team instead of treating the installing team as proof.
      const access = await this.workspaceAccess(scope.realmKey, principal, credentialRevision, secret.botToken, signal)
      return access === 'unknown' || access === 'deny' ? access : 'allow'
    } catch {
      return 'unknown'
    }
  }

  private async conversationAudience(
    channel: string,
    token: string,
    signal: AbortSignal
  ): Promise<ConversationAudience> {
    const body = await this.slackCall<{
      ok?: boolean
      error?: unknown
      channel?: { is_private?: unknown; is_im?: unknown; is_mpim?: unknown }
    }>(`conversations.info?channel=${encodeURIComponent(channel)}`, token, signal)
    if (!body.ok) return failureDecision(body.error) === 'deny' ? 'gone' : 'unknown'
    if (!body.channel) return 'unknown'
    if (body.channel.is_private === false && body.channel.is_im !== true && body.channel.is_mpim !== true) {
      return 'public'
    }
    if (body.channel.is_private === true || body.channel.is_im === true || body.channel.is_mpim === true) {
      return 'members'
    }
    return 'unknown'
  }

  private async workspaceAccess(
    realmKey: string,
    principal: SlackPrincipal,
    credentialRevision: number,
    token: string,
    signal: AbortSignal
  ): Promise<WorkspaceAccess> {
    const key = [realmKey, credentialRevision, principal.key].join(':')
    const cached = this.workspaceAccessCache.get(key)
    if (cached && cached.expiresAt > this.deps.clock.now()) return cached.access

    const body = await this.slackCall<{
      ok?: boolean
      error?: unknown
      user?: {
        team_id?: unknown
        profile?: { team?: unknown }
        enterprise_user?: { teams?: unknown }
        deleted?: unknown
        suspended?: unknown
        is_bot?: unknown
        is_profile_only_user?: unknown
        is_invited_user?: unknown
        is_restricted?: unknown
        is_ultra_restricted?: unknown
        is_stranger?: unknown
        is_external?: unknown
      }
    }>(`users.info?user=${encodeURIComponent(principal.userId)}`, token, signal)

    // A user Slack does not know in this workspace is a verdict, not an outage.
    let access: WorkspaceAccess = body.ok ? 'unknown' : failureDecision(body.error) === 'deny' ? 'deny' : 'unknown'
    if (body.ok && body.user) {
      const teams = new Set<string>()
      if (typeof body.user.team_id === 'string') teams.add(body.user.team_id)
      if (typeof body.user.profile?.team === 'string') teams.add(body.user.profile.team)
      if (Array.isArray(body.user.enterprise_user?.teams)) {
        for (const team of body.user.enterprise_user.teams) if (typeof team === 'string') teams.add(team)
      }
      if (
        !teams.has(principal.teamId) ||
        body.user.deleted === true ||
        body.user.suspended === true ||
        body.user.is_bot === true ||
        body.user.is_profile_only_user === true ||
        body.user.is_invited_user === true
      ) {
        access = 'deny'
      } else if (
        !teams.has(realmKey) ||
        body.user.is_restricted === true ||
        body.user.is_ultra_restricted === true ||
        body.user.is_stranger === true ||
        body.user.is_external === true
      ) {
        access = 'membership'
      } else {
        access = 'allow'
      }
    }
    this.putWorkspaceAccess(key, access)
    return access
  }

  private async checkMembership(
    channel: string,
    userId: string,
    token: string,
    signal: AbortSignal
  ): Promise<Decision> {
    let cursor = ''
    for (let page = 0; page < MAX_MEMBER_PAGES; page++) {
      const query = new URLSearchParams({ channel, limit: String(PAGE_SIZE) })
      if (cursor) query.set('cursor', cursor)
      const body = await this.slackCall<{
        ok?: boolean
        error?: unknown
        members?: unknown
        response_metadata?: { next_cursor?: unknown }
      }>(`conversations.members?${query}`, token, signal)
      if (!body.ok) return failureDecision(body.error)
      if (!Array.isArray(body.members)) return 'unknown'
      if (body.members.includes(userId)) return 'allow'
      cursor = typeof body.response_metadata?.next_cursor === 'string' ? body.response_metadata.next_cursor : ''
      if (!cursor) return 'deny'
      if (page === MAX_MEMBER_PAGES - 1) return 'unknown'
    }
    return 'unknown'
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

  private putWorkspaceAccess(key: string, access: WorkspaceAccess): void {
    if (this.workspaceAccessCache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.workspaceAccessCache.keys().next().value as string | undefined
      if (oldest) this.workspaceAccessCache.delete(oldest)
    }
    const ttl = access === 'allow' ? ALLOW_TTL_MS : access === 'unknown' ? UNKNOWN_TTL_MS : DENY_TTL_MS
    this.workspaceAccessCache.set(key, { access, expiresAt: this.deps.clock.now() + ttl })
  }
}
