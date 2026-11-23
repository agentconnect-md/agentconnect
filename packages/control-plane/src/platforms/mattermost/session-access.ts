// Mattermost conversation audience resolution via Logto's stock oauth2 connector (scoped by mattermostOauthRealmKey).
import { LRUCache } from 'lru-cache'
import { cacheOptions } from '../../cache.js'
import type { Clock } from '../../domain/clock.js'
import { BotId } from '../../domain/ids.js'
import type { FetchLike } from '../../github/api.js'
import type { LogtoIdentityService } from '../../github/logto-identity.js'
import type {
  SessionAccessIssue,
  SessionAccessPlugin,
  SessionAccessResult,
  SessionAccessViewer
} from '../../http/session-access-plugin.js'
import { guardedRequest, isLinkLocalOrUnspecifiedAddress } from '../../net/guarded-fetch.js'
import type {
  BotRecord,
  BotRepo,
  BotSecretMaterial,
  BotSecretStore,
  ExternalScopeRecord,
  UserRepo
} from '../../persistence/ports.js'
import { BotAccessError } from '../bot-session-access.js'
import { mattermostExternalAppId, normalizeMattermostServerUrl } from './server-url.js'

const MM_ID_RE = /^[a-z0-9]{26}$/
const CHECK_BUDGET_MS = 5_000
const CHECK_CONCURRENCY = 4
const MAX_CACHE_ENTRIES = 10_000
const ALLOW_TTL_MS = 120_000
const DENY_TTL_MS = 30_000
const UNKNOWN_TTL_MS = 5_000

type Decision = { allowed: boolean; issue?: SessionAccessIssue; cause?: string }
type DecisionContext = {
  serverUrl: string
  botKey: string
  token: string
  channelId: string
  mmUserId: string
}
type UserState = { active: boolean; isSystemGuest: boolean }
type UserStateContext = {
  serverUrl: string
  token: string
  mmUserId: string
}
type TeamMemberContext = {
  serverUrl: string
  token: string
  teamId: string
  mmUserId: string
}

async function awaitWithinBudget<T>(
  promise: Promise<T>,
  signal: AbortSignal
): Promise<{ ok: true; value: T } | { ok: false }> {
  if (signal.aborted) {
    void promise.catch(() => {})
    return { ok: false }
  }
  let onAbort: (() => void) | undefined
  const aborted = new Promise<{ ok: false }>((resolve) => {
    onAbort = () => resolve({ ok: false })
    signal.addEventListener('abort', onAbort, { once: true })
  })
  void promise.catch(() => {})
  try {
    return await Promise.race([promise.then((value) => ({ ok: true as const, value })), aborted])
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

interface HttpResult {
  status: number
  json: unknown
}

export interface MattermostSessionAccessDeps {
  bots: Pick<BotRepo, 'getUnscoped' | 'listForOrg'>
  botSecrets: Pick<BotSecretStore, 'get'>
  clock: Clock
  identity?: Pick<LogtoIdentityService, 'chatIdentitiesFor'>
  users?: Pick<UserRepo, 'getOidcSubject'>
  /** Bound Mattermost realmKey (`mm-<16-hex>`) from MATTERMOST_OAUTH_SERVER_URL / logto.mattermostConnector.serverUrl. */
  mattermostOauthRealmKey?: string
  /** Permit dialing private/loopback Mattermost servers when not explicitly allowlisted (default: false). */
  allowPrivateNetwork?: boolean
  /** Deployment-level outbound host allowlist passed through to guardedRequest. */
  allowlist?: ReadonlySet<string>
  /** HTTP edge override for tests; omitted uses SSRF-guarded outbound requests. */
  fetchImpl?: FetchLike
  log?: { warn: (obj: object, msg: string) => void }
}

/** Derive the bound Mattermost OAuth realmKey (`mm-<16-hex>`) from deployment config or startup env. */
export function resolveMattermostOauthRealmKey(
  env: { MATTERMOST_OAUTH_SERVER_URL?: string },
  deploymentOauthServerUrl?: string | null
): string | undefined {
  const rawOauthUrl =
    deploymentOauthServerUrl !== undefined ? deploymentOauthServerUrl?.trim() : env.MATTERMOST_OAUTH_SERVER_URL?.trim()
  if (!rawOauthUrl) return undefined
  const normalized = normalizeMattermostServerUrl(rawOauthUrl)
  if (!normalized.ok) throw new Error(normalized.reason)
  return mattermostExternalAppId(normalized.serverUrl)
}

function failureCause(error: unknown): string {
  if (error instanceof BotAccessError) return error.reason
  const name = error instanceof Error ? error.name : ''
  return name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'error'
}

function serverUrlOfBot(bot: Pick<BotRecord, 'platformConfig'>): string | null {
  const raw = bot.platformConfig?.serverUrl
  if (typeof raw !== 'string') return null
  const normalized = normalizeMattermostServerUrl(raw)
  return normalized.ok ? normalized.serverUrl : null
}

/** Session access plugin for self-hosted Mattermost servers authenticated through Logto's Mattermost oauth2 connector. */
export class MattermostSessionAccessService implements SessionAccessPlugin {
  readonly provider = 'mattermost'
  private readonly mattermostOauthRealmKey?: string
  private readonly decisions: LRUCache<string, Decision, DecisionContext>
  private readonly userStates: LRUCache<string, UserState, UserStateContext>
  private readonly teamMembers: LRUCache<string, boolean, TeamMemberContext>

  constructor(private readonly deps: MattermostSessionAccessDeps) {
    this.mattermostOauthRealmKey = deps.mattermostOauthRealmKey?.trim() || undefined

    this.decisions = new LRUCache({
      ...cacheOptions(deps.clock, MAX_CACHE_ENTRIES),
      ttl: UNKNOWN_TTL_MS,
      fetchMethod: async (_key, _stale, { context, options }) => {
        const lookupSignal = AbortSignal.timeout(CHECK_BUDGET_MS)
        try {
          const allowed = await this.checkMembership(
            context.serverUrl,
            context.botKey,
            context.token,
            context.channelId,
            context.mmUserId,
            lookupSignal
          )
          options.ttl = allowed ? ALLOW_TTL_MS : DENY_TTL_MS
          return { allowed }
        } catch (error) {
          options.ttl = UNKNOWN_TTL_MS
          return {
            allowed: false,
            issue: { provider: this.provider, reason: error instanceof BotAccessError ? error.reason : 'unavailable' },
            cause: failureCause(error)
          }
        }
      }
    })

    this.userStates = new LRUCache({
      ...cacheOptions(deps.clock, MAX_CACHE_ENTRIES),
      ttl: ALLOW_TTL_MS,
      fetchMethod: async (_key, _stale, { context, options }) => {
        const lookupSignal = AbortSignal.timeout(CHECK_BUDGET_MS)
        const userRes = await this.requestJson(
          `${context.serverUrl}/api/v4/users/${context.mmUserId}`,
          context.token,
          lookupSignal
        )
        if (userRes.status === 401 || userRes.status === 403) throw new BotAccessError('app_authorization')
        if (userRes.status === 404) {
          options.ttl = DENY_TTL_MS
          return { active: false, isSystemGuest: false }
        }
        if (userRes.status !== 200 || !userRes.json || typeof userRes.json !== 'object') {
          throw new BotAccessError('unavailable')
        }
        const u = userRes.json as { id?: unknown; delete_at?: unknown; roles?: unknown }
        const active = (u.id === undefined || u.id === context.mmUserId) && u.delete_at === 0
        const roles = typeof u.roles === 'string' ? u.roles.split(/\s+/) : []
        options.ttl = active ? ALLOW_TTL_MS : DENY_TTL_MS
        return { active, isSystemGuest: roles.includes('system_guest') }
      }
    })

    this.teamMembers = new LRUCache({
      ...cacheOptions(deps.clock, MAX_CACHE_ENTRIES),
      ttl: ALLOW_TTL_MS,
      fetchMethod: async (_key, _stale, { context, options }) => {
        const lookupSignal = AbortSignal.timeout(CHECK_BUDGET_MS)
        const teamRes = await this.requestJson(
          `${context.serverUrl}/api/v4/teams/${context.teamId}/members/${context.mmUserId}`,
          context.token,
          lookupSignal
        )
        if (teamRes.status === 401 || teamRes.status === 403) throw new BotAccessError('app_authorization')
        if (teamRes.status === 404) {
          options.ttl = DENY_TTL_MS
          return false
        }
        if (teamRes.status !== 200 || !teamRes.json || typeof teamRes.json !== 'object') {
          throw new BotAccessError('unavailable')
        }
        const tm = teamRes.json as {
          user_id?: unknown
          team_id?: unknown
          delete_at?: unknown
          scheme_guest?: unknown
          roles?: unknown
        }
        const teamRoles = typeof tm.roles === 'string' ? tm.roles.split(/\s+/) : []
        const allowed =
          tm.scheme_guest !== true &&
          !teamRoles.includes('team_guest') &&
          tm.delete_at === 0 &&
          tm.user_id === context.mmUserId &&
          (tm.team_id === undefined || tm.team_id === context.teamId)
        options.ttl = allowed ? ALLOW_TTL_MS : DENY_TTL_MS
        return allowed
      }
    })
  }

  get available(): boolean {
    return this.deps.identity !== undefined && Boolean(this.mattermostOauthRealmKey)
  }

  async addViewerIdentities({ request, userId, identitySet }: SessionAccessViewer): Promise<void> {
    if (!this.available || !this.deps.identity || !this.mattermostOauthRealmKey) return
    const sub = request.oidcSubject ?? (await this.deps.users?.getOidcSubject(userId))
    if (!sub) return

    const linked = await this.deps.identity.chatIdentitiesFor(sub)
    for (const entry of linked) {
      if (
        entry.platform === this.provider &&
        entry.tenant === this.mattermostOauthRealmKey &&
        MM_ID_RE.test(entry.memberId)
      ) {
        identitySet.add(`${this.provider}:${entry.tenant}:${entry.memberId}`)
      }
    }
  }

  async resolve(
    scopes: readonly ExternalScopeRecord[],
    viewer: SessionAccessViewer,
    callerSignal?: AbortSignal
  ): Promise<SessionAccessResult> {
    const allowedScopes: SessionAccessResult['allowedScopes'] = []
    const issues = new Map<string, SessionAccessIssue>()
    const causes = new Map<string, string>()
    const timeoutSignal = AbortSignal.timeout(CHECK_BUDGET_MS)
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal

    const membersByRealm = new Map<string, string[]>()
    for (const entry of viewer.identitySet) {
      if (!entry.startsWith(`${this.provider}:`)) continue
      const rest = entry.slice(this.provider.length + 1)
      const sep = rest.indexOf(':')
      if (sep <= 0) continue
      const realmKey = rest.slice(0, sep)
      if (!this.mattermostOauthRealmKey || realmKey !== this.mattermostOauthRealmKey) continue
      const memberId = rest.slice(sep + 1)
      if (!MM_ID_RE.test(memberId)) continue
      const list = membersByRealm.get(realmKey) ?? []
      if (!list.includes(memberId)) list.push(memberId)
      membersByRealm.set(realmKey, list)
    }

    const recordIssue = (scopeId: string, reason: SessionAccessIssue['reason'], cause: string = reason) => {
      issues.set(reason, { provider: this.provider, reason })
      if (!causes.has(scopeId)) causes.set(scopeId, cause)
    }

    const botMemo = new Map<string, Promise<BotRecord | null>>()
    const secretMemo = new Map<string, Promise<BotSecretMaterial | null>>()
    const getBot = (botId: BotId) => {
      let pending = botMemo.get(botId)
      if (!pending) {
        pending = this.deps.bots.getUnscoped(botId)
        botMemo.set(botId, pending)
      }
      return pending
    }
    const getSecret = (botId: BotId) => {
      let pending = secretMemo.get(botId)
      if (!pending) {
        pending = this.deps.botSecrets.get(viewer.orgId, botId)
        secretMemo.set(botId, pending)
      }
      return pending
    }

    const checkScope = async (scope: ExternalScopeRecord) => {
      if (
        scope.orgId !== viewer.orgId ||
        scope.provider !== this.provider ||
        scope.resourceKind !== 'conversation' ||
        scope.revokedAt !== null ||
        scope.credentialKind !== 'bot' ||
        !scope.credentialId
      ) {
        return
      }
      if (!this.available) {
        recordIssue(scope.id, 'authorization')
        return
      }

      const bot = await getBot(BotId(scope.credentialId))
      if (!bot || bot.orgId !== viewer.orgId || bot.platform !== this.provider || bot.revokedAt !== null) return

      const serverUrl = serverUrlOfBot(bot)
      if (!serverUrl) return
      const realmKey = mattermostExternalAppId(serverUrl)
      if (scope.realmKey !== realmKey) return

      const members = membersByRealm.get(realmKey) ?? []
      if (members.length === 0) {
        recordIssue(scope.id, 'authorization')
        return
      }
      if (!MM_ID_RE.test(scope.resourceKey)) return

      const botKey = [bot.id, bot.credentialRevision].join(':')
      let token: string | undefined

      for (const member of members) {
        const key = [scope.id, scope.aclRevision, bot.id, bot.credentialRevision, member].join(':')
        let result = this.decisions.get(key)
        if (!result) {
          if (!token) {
            const secret = await getSecret(bot.id)
            if (!secret?.botToken) {
              recordIssue(scope.id, 'app_authorization')
              return
            }
            token = secret.botToken
          }
          const settled = await awaitWithinBudget(
            this.decisions.fetch(key, {
              context: { serverUrl, botKey, token, channelId: scope.resourceKey, mmUserId: member }
            }),
            signal
          )
          if (!settled.ok) {
            recordIssue(scope.id, 'unavailable', 'deadline')
            return
          }
          result = settled.value
        }
        if (result?.allowed) {
          allowedScopes.push({ id: scope.id, aclRevision: scope.aclRevision })
          return
        }
        if (result?.issue) {
          recordIssue(scope.id, result.issue.reason, result.cause ?? result.issue.reason)
        }
      }
    }

    let next = 0
    const worker = async () => {
      while (next < scopes.length) {
        const scope = scopes[next++]!
        if (signal.aborted) {
          recordIssue(scope.id, 'unavailable', 'deadline')
          continue
        }
        await checkScope(scope)
      }
    }
    await Promise.all(Array.from({ length: Math.min(CHECK_CONCURRENCY, scopes.length) }, worker))

    if (causes.size > 0) {
      const counts: Record<string, number> = {}
      for (const cause of causes.values()) counts[cause] = (counts[cause] ?? 0) + 1
      this.deps.log?.warn(
        { provider: this.provider, degradedScopes: causes.size, totalScopes: scopes.length, causes: counts },
        'mattermost access check degraded — affected sessions are hidden until access can be verified'
      )
    }
    return { allowedScopes, degraded: issues.size > 0, accessIssues: [...issues.values()] }
  }

  private async requestJson(url: string, token: string, signal: AbortSignal): Promise<HttpResult> {
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' }
    if (this.deps.fetchImpl) {
      try {
        const response = await this.deps.fetchImpl(url, {
          method: 'GET',
          headers,
          redirect: 'manual',
          signal: AbortSignal.any([signal, AbortSignal.timeout(CHECK_BUDGET_MS)])
        })
        const text = await response.text().catch(() => '')
        let json: unknown
        try {
          json = text.length > 0 ? JSON.parse(text) : undefined
        } catch {
          json = undefined
        }
        return { status: response.status, json }
      } catch {
        throw new BotAccessError('unavailable')
      }
    }
    const guarded = await guardedRequest(url, {
      method: 'GET',
      headers,
      ...(this.deps.allowlist ? { allowlist: this.deps.allowlist } : {}),
      ...(this.deps.allowPrivateNetwork ? { blockAddress: isLinkLocalOrUnspecifiedAddress } : {}),
      timeoutMs: CHECK_BUDGET_MS,
      signal
    })
    if (!guarded.ok) throw new BotAccessError('unavailable')
    return { status: guarded.response.status, json: guarded.response.json }
  }

  private async checkUserState(serverUrl: string, botKey: string, token: string, mmUserId: string): Promise<UserState> {
    const state = await this.userStates.fetch(`${serverUrl}:${botKey}:${mmUserId}`, {
      context: { serverUrl, token, mmUserId }
    })
    if (!state) throw new BotAccessError('unavailable')
    return state
  }

  private async checkTeamMember(
    serverUrl: string,
    botKey: string,
    token: string,
    teamId: string,
    mmUserId: string
  ): Promise<boolean> {
    const allowed = await this.teamMembers.fetch(`${serverUrl}:${botKey}:${teamId}:${mmUserId}`, {
      context: { serverUrl, token, teamId, mmUserId }
    })
    if (allowed === undefined) throw new BotAccessError('unavailable')
    return allowed
  }

  private async checkMembership(
    serverUrl: string,
    botKey: string,
    token: string,
    channelId: string,
    mmUserId: string,
    signal: AbortSignal
  ): Promise<boolean> {
    const memberRes = await this.requestJson(
      `${serverUrl}/api/v4/channels/${channelId}/members/${mmUserId}`,
      token,
      signal
    )
    if (memberRes.status === 401 || memberRes.status === 403) throw new BotAccessError('app_authorization')
    if (memberRes.status === 200) {
      if (!memberRes.json || typeof memberRes.json !== 'object') throw new BotAccessError('unavailable')
      const m = memberRes.json as { channel_id?: unknown; user_id?: unknown }
      if (m.channel_id === channelId && m.user_id === mmUserId) {
        const user = await this.checkUserState(serverUrl, botKey, token, mmUserId)
        return user.active
      }
      throw new BotAccessError('unavailable')
    }
    if (memberRes.status !== 404) throw new BotAccessError('unavailable')

    const channelRes = await this.requestJson(`${serverUrl}/api/v4/channels/${channelId}`, token, signal)
    if (channelRes.status === 401 || channelRes.status === 403) throw new BotAccessError('app_authorization')
    if (channelRes.status === 404) return false
    if (channelRes.status !== 200 || !channelRes.json || typeof channelRes.json !== 'object') {
      throw new BotAccessError('unavailable')
    }
    const ch = channelRes.json as { id?: unknown; type?: unknown; delete_at?: unknown; team_id?: unknown }
    if (
      (ch.id !== undefined && ch.id !== channelId) ||
      ch.type !== 'O' ||
      ch.delete_at !== 0 ||
      typeof ch.team_id !== 'string' ||
      !MM_ID_RE.test(ch.team_id)
    ) {
      return false
    }

    const user = await this.checkUserState(serverUrl, botKey, token, mmUserId)
    if (!user.active || user.isSystemGuest) return false

    return await this.checkTeamMember(serverUrl, botKey, token, ch.team_id, mmUserId)
  }
}
