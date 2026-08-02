import type { FeishuRegion } from '@agentconnect.md/protocol'
import type { Clock } from '../domain/clock.js'
import { BotId } from '../domain/ids.js'
import type { FeishuPlatformApps } from '../config/feishu-platform.js'
import type { FetchLike } from '../github/api.js'
import type { BotRepo, ExternalScopeRecord } from '../persistence/ports.js'

const REGION_ORIGIN: Record<FeishuRegion, string> = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com'
}
const ALLOW_TTL_MS = 120_000
const DENY_TTL_MS = 30_000
const UNKNOWN_TTL_MS = 5_000
const TOKEN_SKEW_MS = 60_000
const MAX_CACHE_ENTRIES = 10_000
const SCOPES_PER_BATCH = 200
const SCOPE_CONCURRENCY = 6
const MAX_MEMBER_PAGES = 100
const TIMEOUT_MS = 5_000

type Decision = 'allow' | 'deny' | 'unknown'
type Principal = { key: string; region: FeishuRegion; appId: string; openId: string }

const DEFINITIVE_DENIALS = new Set([232006, 232009, 232010, 232011])

export interface FeishuSessionAccessResult {
  allowedScopes: Array<{ id: string; aclRevision: bigint }>
  degraded: boolean
}

export interface FeishuSessionAccessResolver {
  resolve(scopes: readonly ExternalScopeRecord[], identitySet: ReadonlySet<string>): Promise<FeishuSessionAccessResult>
}

function principalsOf(identitySet: ReadonlySet<string>): Principal[] {
  const principals: Principal[] = []
  for (const key of identitySet) {
    const match = /^feishu:(feishu|lark):([^:]+):([^:]+)$/.exec(key)
    if (match) principals.push({ key, region: match[1] as FeishuRegion, appId: match[2]!, openId: match[3]! })
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

/** Current Feishu/Lark group-chat audience. The Logto identity and chat API
 * both use the same configured app, making their app-scoped open_id values
 * comparable. Only bounded verdicts/tokens are retained in process. */
export class FeishuSessionAccessService implements FeishuSessionAccessResolver {
  private readonly cache = new Map<string, { decision: Decision; expiresAt: number }>()
  private readonly tokens = new Map<FeishuRegion, { value: string; expiresAt: number }>()
  private readonly tokenInFlight = new Map<FeishuRegion, Promise<string>>()

  constructor(
    private readonly deps: { bots: BotRepo; apps: FeishuPlatformApps; clock: Clock; fetchImpl?: FetchLike }
  ) {}

  async resolve(
    scopes: readonly ExternalScopeRecord[],
    identitySet: ReadonlySet<string>
  ): Promise<FeishuSessionAccessResult> {
    const principals = principalsOf(identitySet)
    if (principals.length === 0 || scopes.length === 0) return { allowedScopes: [], degraded: false }
    let degraded = false
    const decisions: Array<{ scope: ExternalScopeRecord; decision: Decision }> = []
    for (let start = 0; start < scopes.length; start += SCOPES_PER_BATCH) {
      const signal = AbortSignal.timeout(TIMEOUT_MS)
      decisions.push(
        ...(await mapLimited(scopes.slice(start, start + SCOPES_PER_BATCH), SCOPE_CONCURRENCY, async (scope) => {
          const decision = await this.resolveScope(scope, principals, signal)
          if (decision === 'unknown') degraded = true
          return { scope, decision }
        }))
      )
    }
    return {
      allowedScopes: decisions
        .filter(({ decision }) => decision === 'allow')
        .map(({ scope }) => ({ id: scope.id, aclRevision: scope.aclRevision })),
      degraded
    }
  }

  private async resolveScope(
    scope: ExternalScopeRecord,
    principals: readonly Principal[],
    signal: AbortSignal
  ): Promise<Decision> {
    if (
      scope.provider !== 'feishu' ||
      scope.resourceKind !== 'conversation' ||
      scope.revokedAt !== null ||
      scope.credentialKind !== 'bot' ||
      !scope.credentialId
    ) {
      return 'deny'
    }
    const bot = await this.deps.bots.get(BotId(scope.credentialId)).catch(() => null)
    const region = bot?.platform === 'feishu' ? (bot.feishuRegion ?? 'feishu') : undefined
    const appId = bot?.feishuAppId ?? undefined
    const app = region ? this.deps.apps[region] : undefined
    if (
      !bot ||
      bot.orgId !== scope.orgId ||
      bot.platform !== 'feishu' ||
      bot.revokedAt !== null ||
      !region ||
      !appId ||
      !app ||
      app.appId !== appId ||
      scope.realmKey !== `${region}:${appId}`
    ) {
      return 'deny'
    }

    let sawUnknown = false
    for (const principal of principals) {
      if (principal.region !== region || principal.appId !== appId) continue
      const key = [scope.id, scope.aclRevision.toString(), bot.credentialRevision, principal.key].join(':')
      const cached = this.cache.get(key)
      let decision = cached && cached.expiresAt > this.deps.clock.now() ? cached.decision : undefined
      if (!decision) {
        decision = await this.checkMembership(region, scope.resourceKey, principal.openId, signal)
        this.putCache(key, decision)
      }
      if (decision === 'allow') return 'allow'
      if (decision === 'unknown') sawUnknown = true
    }
    return sawUnknown ? 'unknown' : 'deny'
  }

  private async checkMembership(
    region: FeishuRegion,
    chatId: string,
    openId: string,
    signal: AbortSignal
  ): Promise<Decision> {
    try {
      const token = await this.tenantToken(region, signal)
      let pageToken = ''
      for (let page = 0; page < MAX_MEMBER_PAGES; page++) {
        const query = new URLSearchParams({ member_id_type: 'open_id', page_size: '100' })
        if (pageToken) query.set('page_token', pageToken)
        const body = await this.call<{
          code?: unknown
          data?: { items?: Array<{ member_id?: unknown }>; has_more?: unknown; page_token?: unknown }
        }>(region, `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members?${query}`, token, signal)
        const code = typeof body.code === 'number' ? body.code : Number(body.code)
        if (code !== 0) return DEFINITIVE_DENIALS.has(code) ? 'deny' : 'unknown'
        if (!Array.isArray(body.data?.items)) return 'unknown'
        if (body.data.items.some((member) => member.member_id === openId)) return 'allow'
        if (body.data.has_more !== true) return 'deny'
        pageToken = typeof body.data.page_token === 'string' ? body.data.page_token : ''
        if (!pageToken || page === MAX_MEMBER_PAGES - 1) return 'unknown'
      }
    } catch {
      return 'unknown'
    }
    return 'unknown'
  }

  private tenantToken(region: FeishuRegion, signal: AbortSignal): Promise<string> {
    const cached = this.tokens.get(region)
    if (cached && cached.expiresAt > this.deps.clock.now()) return Promise.resolve(cached.value)
    let pending = this.tokenInFlight.get(region)
    if (!pending) {
      const tracked = this.fetchTenantToken(region, signal).finally(() => {
        if (this.tokenInFlight.get(region) === tracked) this.tokenInFlight.delete(region)
      })
      pending = tracked
      this.tokenInFlight.set(region, tracked)
    }
    return pending
  }

  private async fetchTenantToken(region: FeishuRegion, signal: AbortSignal): Promise<string> {
    const app = this.deps.apps[region]!
    const body = await this.call<{ code?: unknown; tenant_access_token?: unknown; expire?: unknown }>(
      region,
      '/open-apis/auth/v3/tenant_access_token/internal',
      undefined,
      signal,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app_id: app.appId, app_secret: app.appSecret })
      }
    )
    if (Number(body.code) !== 0 || typeof body.tenant_access_token !== 'string')
      throw new Error('token exchange failed')
    const expire = typeof body.expire === 'number' ? body.expire : 0
    this.tokens.set(region, {
      value: body.tenant_access_token,
      expiresAt: this.deps.clock.now() + Math.max(0, expire * 1000 - TOKEN_SKEW_MS)
    })
    return body.tenant_access_token
  }

  private async call<T>(
    region: FeishuRegion,
    path: string,
    token: string | undefined,
    signal: AbortSignal,
    init: RequestInit = {}
  ): Promise<T> {
    const headers = new Headers(init.headers)
    if (token) headers.set('authorization', `Bearer ${token}`)
    const response = await (this.deps.fetchImpl ?? (fetch as FetchLike))(`${REGION_ORIGIN[region]}${path}`, {
      ...init,
      headers,
      signal
    })
    const body = (await response.json()) as T
    if (!response.ok) throw new Error(`Feishu request failed: ${response.status}`)
    return body
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
