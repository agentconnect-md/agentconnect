import type { FeishuRegion } from '@agentconnect.md/protocol'
import type { Clock } from '../domain/clock.js'
import { BotId } from '../domain/ids.js'
import type { FetchLike } from '../github/api.js'
import type { BotRepo, ExternalScopeRecord } from '../persistence/ports.js'

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

const DEFINITIVE_DENIALS = new Set([232006, 232009, 232010, 232011])

export interface FeishuSessionViewer {
  subject: string
  accessTokenFor(region: FeishuRegion): Promise<string>
}

export interface FeishuSessionAccessResult {
  allowedScopes: Array<{ id: string; aclRevision: bigint }>
  degraded: boolean
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

/** Current Feishu/Lark conversation audience, proven by the official login
 * app's user token against the custom Bot app's immutable chat id. No app-scoped
 * open_id values are compared. Only bounded membership verdicts are retained. */
export class FeishuSessionAccessService implements FeishuSessionAccessResolver {
  private readonly cache = new Map<string, { decision: Decision; expiresAt: number }>()

  constructor(private readonly deps: { bots: BotRepo; clock: Clock; fetchImpl?: FetchLike }) {}

  async resolve(
    scopes: readonly ExternalScopeRecord[],
    viewer?: FeishuSessionViewer
  ): Promise<FeishuSessionAccessResult> {
    if (scopes.length === 0) return { allowedScopes: [], degraded: false }
    if (!viewer) return { allowedScopes: [], degraded: true }
    const tokens = new Map<FeishuRegion, Promise<string>>()
    const tokenFor = (region: FeishuRegion): Promise<string> => {
      let pending = tokens.get(region)
      if (!pending) {
        pending = viewer.accessTokenFor(region)
        tokens.set(region, pending)
      }
      return pending
    }
    let degraded = false
    const decisions: Array<{ scope: ExternalScopeRecord; decision: Decision }> = []
    for (let start = 0; start < scopes.length; start += SCOPES_PER_BATCH) {
      const signal = AbortSignal.timeout(TIMEOUT_MS)
      decisions.push(
        ...(await mapLimited(scopes.slice(start, start + SCOPES_PER_BATCH), SCOPE_CONCURRENCY, async (scope) => {
          const decision = await this.resolveScope(scope, viewer, tokenFor, signal)
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
    viewer: FeishuSessionViewer,
    tokenFor: (region: FeishuRegion) => Promise<string>,
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
    if (
      !bot ||
      bot.orgId !== scope.orgId ||
      bot.platform !== 'feishu' ||
      bot.revokedAt !== null ||
      !region ||
      !appId ||
      scope.realmKey !== `${region}:${appId}`
    ) {
      return 'deny'
    }

    const key = [scope.id, scope.aclRevision.toString(), bot.credentialRevision, viewer.subject].join(':')
    const cached = this.cache.get(key)
    let decision = cached && cached.expiresAt > this.deps.clock.now() ? cached.decision : undefined
    if (!decision) {
      decision = await this.checkMembership(region, scope.resourceKey, tokenFor, signal)
      this.putCache(key, decision)
    }
    return decision
  }

  private async checkMembership(
    region: FeishuRegion,
    chatId: string,
    tokenFor: (region: FeishuRegion) => Promise<string>,
    signal: AbortSignal
  ): Promise<Decision> {
    try {
      const token = await tokenFor(region)
      const body = await this.call<{ code?: unknown; data?: { is_in_chat?: unknown } }>(
        region,
        `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members/is_in_chat`,
        token,
        signal
      )
      const code = typeof body.code === 'number' ? body.code : Number(body.code)
      if (code !== 0) return DEFINITIVE_DENIALS.has(code) ? 'deny' : 'unknown'
      if (body.data?.is_in_chat === true) return 'allow'
      if (body.data?.is_in_chat === false) return 'deny'
    } catch {
      return 'unknown'
    }
    return 'unknown'
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

  private putCache(key: string, decision: Decision): void {
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value as string | undefined
      if (oldest) this.cache.delete(oldest)
    }
    const ttl = decision === 'allow' ? ALLOW_TTL_MS : decision === 'deny' ? DENY_TTL_MS : UNKNOWN_TTL_MS
    this.cache.set(key, { decision, expiresAt: this.deps.clock.now() + ttl })
  }
}
