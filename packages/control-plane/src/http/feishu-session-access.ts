import type { FeishuRegion } from '@agentconnect.md/protocol'
import { LRUCache } from 'lru-cache'
import { cacheOptions } from '../cache.js'
import type { Clock } from '../domain/clock.js'
import { BotId } from '../domain/ids.js'
import type { FetchLike } from '../github/api.js'
import type { LogtoIdentityService } from '../github/logto-identity.js'
import type { BotRecord, BotRepo, BotSecretStore, ExternalScopeRecord } from '../persistence/ports.js'
import type {
  SessionAccessIssue,
  SessionAccessPlugin,
  SessionAccessResult,
  SessionAccessViewer
} from './session-access-plugin.js'

const REGION_ORIGIN: Record<FeishuRegion, string> = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com'
}
const MEMBER_LIST_TTL_MS = 120_000
const DENY_TTL_MS = 30_000
const UNKNOWN_TTL_MS = 5_000
const QUOTA_RETRY_MS = 60 * 60_000
const MAX_CACHE_ENTRIES = 10_000
const SCOPES_PER_BATCH = 200
const SCOPE_CONCURRENCY = 6
const TIMEOUT_MS = 5_000
const QUOTA_EXHAUSTED_CODE = 99991403

type Decision = 'allow' | 'deny' | 'unknown'
type ScopeDecision = { decision: Decision; issue?: SessionAccessIssue }
type MembershipResult =
  | { status: 'members'; unionIds: ReadonlySet<string> }
  | { status: 'deny' }
  | { status: 'unknown'; issue: SessionAccessIssue }
type MembershipLookup = {
  region: FeishuRegion
  chatId: string
  bot: BotRecord
  tokenFor: (bot: BotRecord, signal: AbortSignal) => Promise<string>
  signal: AbortSignal
  quotaKey: string
}

const DEFINITIVE_DENIALS = new Set([232006, 232009, 232010, 232011])

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
export class FeishuSessionAccessService implements SessionAccessPlugin {
  readonly provider = 'feishu'
  /** (bot, credential revision, chat) → membership. Shared across viewers: who
   *  is in a chat is a property of the CHAT, and the union_id comparison that
   *  turns it into a verdict is done per caller in `resolveScope`. `fetch` hands
   *  concurrent callers of one key the same promise, replacing the pending map
   *  this used to keep alongside. Entries carry their own TTL — see the
   *  fetchMethod, which sets it from the answer it got. */
  private readonly membership: LRUCache<string, MembershipResult, MembershipLookup>
  private readonly quotaBlockedUntil = new Map<string, number>()

  constructor(
    private readonly deps: {
      bots: BotRepo
      botSecrets: BotSecretStore
      clock: Clock
      fetchImpl?: FetchLike
      identity?: Pick<LogtoIdentityService, 'feishuIdentitiesFor'>
    }
  ) {
    this.membership = new LRUCache({
      ...cacheOptions(deps.clock, MAX_CACHE_ENTRIES),
      // A per-entry TTL is always set below; this only stops lru-cache from
      // treating an entry that somehow arrives without one as immortal.
      ttl: UNKNOWN_TTL_MS,
      fetchMethod: async (_key, _stale, { context, options }) => {
        const result = await this.listMembers(
          context.region,
          context.chatId,
          context.bot,
          context.tokenFor,
          context.signal,
          context.quotaKey
        )
        options.ttl =
          result.status === 'members' ? MEMBER_LIST_TTL_MS : result.status === 'deny' ? DENY_TTL_MS : UNKNOWN_TTL_MS
        return result
      }
    })
  }

  get available(): boolean {
    return this.deps.identity !== undefined
  }

  async addViewerIdentities({ request, orgId, identitySet }: SessionAccessViewer): Promise<void> {
    const subject = request.oidcSubject
    if (!subject || !this.deps.identity) return
    const [identities, apps] = await Promise.all([
      this.deps.identity.feishuIdentitiesFor(subject),
      this.deps.bots.listForOrg(orgId)
    ])
    for (const identity of identities) {
      for (const bot of apps) {
        if (
          bot.platform === 'feishu' &&
          bot.revokedAt === null &&
          bot.feishuAppId &&
          (bot.feishuRegion ?? 'feishu') === identity.region
        ) {
          identitySet.add(`feishu:${identity.region}:${bot.feishuAppId}:${identity.unionId}`)
        }
      }
    }
  }

  async resolve(scopes: readonly ExternalScopeRecord[], viewer: SessionAccessViewer): Promise<SessionAccessResult> {
    if (scopes.length === 0) return { allowedScopes: [], degraded: false, accessIssues: [] }
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
    viewer: SessionAccessViewer,
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
    // The credential behind a session's recorded external scope — system state,
    // resolved without an org (org-scoped-data-layer.md §4). The scope row is
    // itself reached through the session, which the caller already fenced.
    const bot = await this.deps.bots.getUnscoped(BotId(scope.credentialId)).catch(() => null)
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

    const prefix = `feishu:${region}:`
    const unionIds = [
      ...new Set(
        [...viewer.identitySet]
          .filter((identity) => identity.startsWith(prefix))
          .map((identity) => identity.split(':')[3])
          .filter((identity): identity is string => Boolean(identity))
      )
    ].sort()
    if (unionIds.length === 0) {
      return { decision: 'unknown', issue: { provider: 'feishu', region, reason: 'authorization' } }
    }
    const membership = await this.membershipFor(
      [bot.id, bot.credentialRevision, scope.resourceKey].join(':'),
      `${scope.orgId}:${region}`,
      region,
      scope.resourceKey,
      bot,
      tokenFor,
      signal
    )
    if (membership.status === 'members') {
      return { decision: unionIds.some((unionId) => membership.unionIds.has(unionId)) ? 'allow' : 'deny' }
    }
    if (membership.status === 'deny') return { decision: 'deny' }
    return { decision: 'unknown', issue: membership.issue }
  }

  private async membershipFor(
    key: string,
    quotaKey: string,
    region: FeishuRegion,
    chatId: string,
    bot: BotRecord,
    tokenFor: (bot: BotRecord, signal: AbortSignal) => Promise<string>,
    signal: AbortSignal
  ): Promise<MembershipResult> {
    const cached = this.membership.get(key)
    if (cached) return cached
    // The quota gate sits BETWEEN the cache and the provider: once this app has
    // exhausted its quota there is nothing to ask, but an answer already cached
    // above stays perfectly usable.
    if ((this.quotaBlockedUntil.get(quotaKey) ?? 0) > this.deps.clock.now()) {
      return { status: 'unknown', issue: { provider: 'feishu', region, reason: 'quota' } }
    }
    const result = await this.membership.fetch(key, {
      context: { region, chatId, bot, tokenFor, signal, quotaKey }
    })
    // Only reachable if the entry is dropped mid-flight; report it the way an
    // unanswerable check is reported everywhere else here.
    if (!result) return { status: 'unknown', issue: { provider: 'feishu', region, reason: 'unavailable' } }
    // Running out of quota says nothing about the chat, so it must not occupy
    // the entry: `quotaBlockedUntil` is what suppresses the retry storm, and it
    // is already set by the time we get here.
    if (result.status === 'unknown' && result.issue.reason === 'quota') {
      this.membership.delete(key)
    }
    return result
  }

  private async listMembers(
    region: FeishuRegion,
    chatId: string,
    bot: BotRecord,
    tokenFor: (bot: BotRecord, signal: AbortSignal) => Promise<string>,
    signal: AbortSignal,
    quotaKey: string
  ): Promise<MembershipResult> {
    let token: string
    try {
      token = await tokenFor(bot, signal)
    } catch {
      return { status: 'unknown', issue: { provider: 'feishu', region, reason: 'unavailable' } }
    }
    try {
      const unionIds = new Set<string>()
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
          if (code === QUOTA_EXHAUSTED_CODE) {
            this.quotaBlockedUntil.set(quotaKey, this.deps.clock.now() + QUOTA_RETRY_MS)
            return { status: 'unknown', issue: { provider: 'feishu', region, reason: 'quota' } }
          }
          return DEFINITIVE_DENIALS.has(code)
            ? { status: 'deny' }
            : { status: 'unknown', issue: { provider: 'feishu', region, reason: 'unavailable' } }
        }
        for (const item of body.data?.items ?? []) {
          if (typeof item.member_id === 'string') unionIds.add(item.member_id)
        }
        if (body.data?.has_more !== true) return { status: 'members', unionIds }
        const next = typeof body.data.page_token === 'string' ? body.data.page_token : undefined
        if (!next || seenPageTokens.has(next)) {
          return { status: 'unknown', issue: { provider: 'feishu', region, reason: 'unavailable' } }
        }
        seenPageTokens.add(next)
        pageToken = next
      }
    } catch {
      return { status: 'unknown', issue: { provider: 'feishu', region, reason: 'unavailable' } }
    }
  }

  private async tenantAccessToken(bot: BotRecord, signal: AbortSignal): Promise<string> {
    const region = bot.feishuRegion ?? 'feishu'
    const appId = bot.feishuAppId
    const secret = await this.deps.botSecrets.get(bot.orgId, bot.id)
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
    if (!response.ok && (typeof body !== 'object' || body === null || !('code' in body))) {
      throw new Error(`Feishu request failed: ${response.status}`)
    }
    return body
  }
}
