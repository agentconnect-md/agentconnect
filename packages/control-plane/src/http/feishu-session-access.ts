import type { FeishuRegion } from '@agentconnect.md/protocol'
import type { Clock } from '../domain/clock.js'
import { BotId } from '../domain/ids.js'
import type { FetchLike } from '../github/api.js'
import type { BotRecord, BotRepo, BotSecretStore, ExternalScopeRecord } from '../persistence/ports.js'
import type { SessionAccessIssue } from './session-access.js'

const REGION_ORIGIN: Record<FeishuRegion, string> = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com'
}
const ALLOW_TTL_MS = 120_000
const DENY_TTL_MS = 30_000
const UNKNOWN_TTL_MS = 5_000
const MAX_CACHE_ENTRIES = 10_000
const SCOPES_PER_BATCH = 200
const SCOPE_CONCURRENCY = 6
const TIMEOUT_MS = 5_000

type Decision = 'allow' | 'deny' | 'unknown'
type ScopeDecision = { decision: Decision; issue?: SessionAccessIssue }

const DEFINITIVE_DENIALS = new Set([232006, 232009, 232010, 232011])

export interface FeishuSessionViewer {
  unionIdsFor(region: FeishuRegion): readonly string[]
}

export interface FeishuSessionAccessResult {
  allowedScopes: Array<{ id: string; aclRevision: bigint }>
  degraded: boolean
  accessIssues: SessionAccessIssue[]
}

export interface FeishuSessionAccessResolver {
  resolve(scopes: readonly ExternalScopeRecord[], viewer?: FeishuSessionViewer): Promise<FeishuSessionAccessResult>
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

/** Current Feishu/Lark conversation audience, resolved with the installed Bot
 * app's durable credential and compared against the viewer's login union_id.
 * No request-bound user token is fetched or retained. */
export class FeishuSessionAccessService implements FeishuSessionAccessResolver {
  private readonly cache = new Map<string, { result: ScopeDecision; expiresAt: number }>()

  constructor(
    private readonly deps: { bots: BotRepo; botSecrets: BotSecretStore; clock: Clock; fetchImpl?: FetchLike }
  ) {}

  async resolve(
    scopes: readonly ExternalScopeRecord[],
    viewer?: FeishuSessionViewer
  ): Promise<FeishuSessionAccessResult> {
    if (scopes.length === 0) return { allowedScopes: [], degraded: false, accessIssues: [] }
    if (!viewer) return { allowedScopes: [], degraded: true, accessIssues: [] }
    const tokens = new Map<string, Promise<string>>()
    const tokenFor = (bot: BotRecord, signal: AbortSignal): Promise<string> => {
      const key = `${bot.id}:${bot.credentialRevision}`
      let pending = tokens.get(key)
      if (!pending) {
        pending = this.tenantAccessToken(bot, signal)
        tokens.set(key, pending)
      }
      return pending
    }
    let degraded = false
    const accessIssues = new Map<string, SessionAccessIssue>()
    const decisions: Array<{ scope: ExternalScopeRecord; decision: Decision }> = []
    for (let start = 0; start < scopes.length; start += SCOPES_PER_BATCH) {
      const signal = AbortSignal.timeout(TIMEOUT_MS)
      decisions.push(
        ...(await mapLimited(scopes.slice(start, start + SCOPES_PER_BATCH), SCOPE_CONCURRENCY, async (scope) => {
          const { decision, issue } = await this.resolveScope(scope, viewer, tokenFor, signal)
          if (decision === 'unknown') degraded = true
          if (issue) accessIssues.set(`${issue.provider}:${issue.region ?? ''}:${issue.reason}`, issue)
          return { scope, decision }
        }))
      )
    }
    return {
      allowedScopes: decisions
        .filter(({ decision }) => decision === 'allow')
        .map(({ scope }) => ({ id: scope.id, aclRevision: scope.aclRevision })),
      degraded,
      accessIssues: [...accessIssues.values()]
    }
  }

  private async resolveScope(
    scope: ExternalScopeRecord,
    viewer: FeishuSessionViewer,
    tokenFor: (bot: BotRecord, signal: AbortSignal) => Promise<string>,
    signal: AbortSignal
  ): Promise<ScopeDecision> {
    if (
      scope.provider !== 'feishu' ||
      scope.resourceKind !== 'conversation' ||
      scope.revokedAt !== null ||
      scope.credentialKind !== 'bot' ||
      !scope.credentialId
    ) {
      return { decision: 'deny' }
    }
    const bot = await this.deps.bots.get(BotId(scope.credentialId)).catch(() => null)
    const region = bot?.platform === 'feishu' ? (bot.feishuRegion ?? 'feishu') : undefined
    const appId = bot?.feishuAppId ?? undefined
    if (
      !bot ||
      bot.orgId !== scope.orgId ||
      bot.platform !== 'feishu' ||
      bot.revokedAt !== null ||
      !region ||
      !appId ||
      scope.realmKey !== `${region}:${appId}`
    ) {
      return { decision: 'deny' }
    }

    const unionIds = [...new Set(viewer.unionIdsFor(region))].sort()
    if (unionIds.length === 0) {
      return { decision: 'unknown', issue: { provider: 'feishu', region, reason: 'authorization' } }
    }
    const key = [scope.id, scope.aclRevision.toString(), bot.credentialRevision, ...unionIds].join(':')
    const cached = this.cache.get(key)
    let result = cached && cached.expiresAt > this.deps.clock.now() ? cached.result : undefined
    if (!result) {
      result = await this.checkMembership(region, scope.resourceKey, bot, unionIds, tokenFor, signal)
      this.putCache(key, result)
    }
    return result
  }

  private async checkMembership(
    region: FeishuRegion,
    chatId: string,
    bot: BotRecord,
    unionIds: readonly string[],
    tokenFor: (bot: BotRecord, signal: AbortSignal) => Promise<string>,
    signal: AbortSignal
  ): Promise<ScopeDecision> {
    let token: string
    try {
      token = await tokenFor(bot, signal)
    } catch {
      return { decision: 'unknown', issue: { provider: 'feishu', region, reason: 'unavailable' } }
    }
    try {
      const wanted = new Set(unionIds)
      const seenPageTokens = new Set<string>()
      let pageToken: string | undefined
      for (;;) {
        const query = new URLSearchParams({ member_id_type: 'union_id', page_size: '100' })
        if (pageToken) query.set('page_token', pageToken)
        const body = await this.call<{
          code?: unknown
          data?: {
            items?: Array<{ member_id?: unknown }>
            has_more?: unknown
            page_token?: unknown
          }
        }>(region, `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members?${query}`, token, signal)
        const code = typeof body.code === 'number' ? body.code : Number(body.code)
        if (code !== 0) {
          return DEFINITIVE_DENIALS.has(code)
            ? { decision: 'deny' }
            : { decision: 'unknown', issue: { provider: 'feishu', region, reason: 'unavailable' } }
        }
        if (body.data?.items?.some((item) => typeof item.member_id === 'string' && wanted.has(item.member_id))) {
          return { decision: 'allow' }
        }
        if (body.data?.has_more !== true) return { decision: 'deny' }
        const next = typeof body.data.page_token === 'string' ? body.data.page_token : undefined
        if (!next || seenPageTokens.has(next)) {
          return { decision: 'unknown', issue: { provider: 'feishu', region, reason: 'unavailable' } }
        }
        seenPageTokens.add(next)
        pageToken = next
      }
    } catch {
      return { decision: 'unknown', issue: { provider: 'feishu', region, reason: 'unavailable' } }
    }
  }

  private async tenantAccessToken(bot: BotRecord, signal: AbortSignal): Promise<string> {
    const region = bot.feishuRegion ?? 'feishu'
    const appId = bot.feishuAppId
    const secret = await this.deps.botSecrets.get(bot.id)
    if (!appId || !secret || secret.appToken !== appId) throw new Error('Feishu app credential is unavailable')
    const body = await this.call<{ code?: unknown; tenant_access_token?: unknown }>(
      region,
      '/open-apis/auth/v3/tenant_access_token/internal',
      undefined,
      signal,
      {
        method: 'POST',
        body: JSON.stringify({ app_id: appId, app_secret: secret.botToken })
      }
    )
    if (Number(body.code) !== 0 || typeof body.tenant_access_token !== 'string') {
      throw new Error('Feishu rejected the app credential')
    }
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
    headers.set('content-type', 'application/json; charset=utf-8')
    const response = await (this.deps.fetchImpl ?? (fetch as FetchLike))(`${REGION_ORIGIN[region]}${path}`, {
      ...init,
      headers,
      signal
    })
    const body = (await response.json()) as T
    if (!response.ok) throw new Error(`Feishu request failed: ${response.status}`)
    return body
  }

  private putCache(key: string, result: ScopeDecision): void {
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value as string | undefined
      if (oldest) this.cache.delete(oldest)
    }
    const ttl = result.decision === 'allow' ? ALLOW_TTL_MS : result.decision === 'deny' ? DENY_TTL_MS : UNKNOWN_TTL_MS
    this.cache.set(key, { result, expiresAt: this.deps.clock.now() + ttl })
  }
}
