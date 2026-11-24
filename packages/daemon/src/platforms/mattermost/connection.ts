// One Mattermost server/bot connection: WS v4 + REST v4, metadata caching, admission enrichment, threaded posts, and file transfers.
import { createHash, randomUUID } from 'node:crypto'
import {
  extractMattermostPostText,
  nativeMessageId,
  normalizeMattermostMessage,
  normalizeMattermostResponseFinalization,
  parseMattermostPost,
  readMattermostAgentAuthorshipClaim,
  toMattermostAttachment,
  type MattermostFileInfo,
  type MattermostPost,
  type MattermostPostedEvent
} from '@agentconnect.md/message'
import { conversationLink, MATTERMOST_PLATFORM, type PlaceExternalReason } from '@agentconnect.md/protocol'
import type { LoadedAgent } from '../../agents/load-agents.js'
import type { Logger } from '../../log.js'
import type { JoinedChannel } from '../../messages/channel-intro.js'
import type { MessageFile, PlatformFileInfo, SendIdentity, UploadAnchor, UploadOutcome } from '../../mcp/ops/context.js'
import type { Attachment, NormalizedMessage } from '../../messages/normalized.js'
import type { CredentialRevocation } from '../credential-revocation.js'
import type { MattermostActionCallbackConfig } from './action-button.js'
import type {
  ChatCardClick,
  PlatformChannelHistoryMessage,
  PlatformChannelHistoryOptions,
  PlatformChannelHistoryPage,
  PlatformChannelInfo,
  PlatformChannelRef,
  PlatformConnection,
  PlatformConversationSpec,
  PlatformMemberRef,
  PlatformReactionIntent,
  PlatformReactionSummary,
  PlatformSearchHit,
  PlatformSearchOptions,
  PlatformSearchResults,
  PlatformThreadMessage,
  PlatformThreadWindow,
  PlatformUserProfile
} from '../contract.js'
import { platformIntegrationConfig } from '../integration-config.js'
import { MATTERMOST_ATTACHMENT_TOOL } from './attachments.js'
import {
  MATTERMOST_DEFAULT_MAX_POST_SIZE,
  MattermostApiError,
  MattermostClient,
  type MattermostChannel,
  type MattermostClientTiming,
  type MattermostSocket,
  type MattermostTeam,
  type MattermostUser,
  type MattermostWsEvent
} from './client.js'
import { MATTERMOST_UPLOAD_MAX_FILES, uploadMattermostMedia, validateMattermostServerUrl } from './media.js'
import { mattermostExternalAppId, mattermostThreadUrl } from './module.js'
import { MattermostSendQueue } from './rate-limit.js'
import {
  SCAN_STANDARD_TAG_RE,
  STANDARD_CARD_TAG_RE,
  containsTokenBoundary,
  matchCardReply,
  matchesReplyScope,
  stripLeadingMentions,
  type MattermostCardReplyEntry,
  type QuestionTagEntry
} from './card-replies.js'

export type { MattermostCardReplyEntry } from './card-replies.js'
import { markNotJoined } from '../not-joined.js'

const MATTERMOST_POST_ID_RE = /^[a-z0-9]{26}$/
const MATTERMOST_SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const METADATA_TTL_MS = 5 * 60_000
const CHANNEL_CACHE_MAX = 2_000
const WATERMARK_CACHE_MAX = 50_000
const USER_CACHE_MAX = 5_000
const MEMBERSHIP_CACHE_MAX = 5_000
const SEEN_LIMIT = 2_000
const POST_CHANNEL_CACHE_MAX = 5_000
const QUESTION_TAG_LIMIT = 500
const DEFAULT_MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024
const DEFAULT_HISTORY_LIMIT = 60
const MAX_HISTORY_LIMIT = 200
const MEMBER_PAGE_SIZE = 200
const MEMBER_PAGE_CAP = 50
const USER_IDS_BATCH_SIZE = 200
const CATCH_UP_PER_PAGE = 60
const MATTERMOST_SINCE_SERVER_CAP = 1_000
const MAX_CATCH_UP_PAGES = 200
// Each pass refetches this long before a channel's watermark, so posts delivered inside it are remembered by id.
const CATCH_UP_OVERLAP_MS = 1_000
const CHANNEL_TAIL_MAX = 256
const CATCH_UP_RETRY_BASE_MS = 1_000
const MAX_CATCH_UP_RETRY_BACKOFF_MS = 30_000
const CATCH_UP_FAST_RETRIES = 8
const CATCH_UP_STEADY_RETRY_MS = 60_000

const MATTERMOST_REACTION_INTENT: Record<PlatformReactionIntent, string> = {
  seen: 'eyes',
  triaging: 'thinking_face'
}

export interface MattermostConnectionGroup {
  serverUrl: string
  botToken: string
  botUserId?: string
  botUsername?: string
  integrations: { agentId: string; integrationId: string; websocketRepliesOnly?: boolean }[]
}

/** Deterministic key for one Mattermost connection: normalized `serverUrl` + `botToken`. */
export function mattermostConnKey(group: Pick<MattermostConnectionGroup, 'serverUrl' | 'botToken'>): string {
  const checked = validateMattermostServerUrl(group.serverUrl)
  const serverUrl = checked.ok ? checked.serverUrl : group.serverUrl.trim().replace(/\/+$/, '')
  return createHash('sha256')
    .update(JSON.stringify([serverUrl, group.botToken]))
    .digest('hex')
}

/** Group Mattermost integrations sharing the same `(serverUrl, botToken)` onto one connection. */
export function consolidateMattermost(agents: LoadedAgent[]): Map<string, MattermostConnectionGroup> {
  const groups = new Map<string, MattermostConnectionGroup>()
  for (const agent of agents) {
    for (const integration of agent.integrations) {
      const config = platformIntegrationConfig(MATTERMOST_PLATFORM, integration)
      if (!config) continue
      const validated = validateMattermostServerUrl(config.serverUrl)
      if (!validated.ok) continue
      const key = mattermostConnKey({ serverUrl: validated.serverUrl, botToken: config.botToken })
      const group = groups.get(key) ?? {
        serverUrl: validated.serverUrl,
        botToken: config.botToken,
        ...(config.botUserId ? { botUserId: config.botUserId } : {}),
        ...(config.botUsername ? { botUsername: config.botUsername } : {}),
        integrations: []
      }
      if (!group.botUserId && config.botUserId) group.botUserId = config.botUserId
      if (!group.botUsername && config.botUsername) group.botUsername = config.botUsername
      group.integrations.push({
        agentId: agent.id,
        integrationId: integration.id,
        ...(config.websocketRepliesOnly ? { websocketRepliesOnly: true } : {})
      })
      groups.set(key, group)
    }
  }
  return groups
}

export interface MattermostConnectionDeps {
  onMessage(msg: NormalizedMessage): void
  onCardClick?: (click: ChatCardClick, agentId: string, integrationId: string) => Promise<string | undefined>
  onChannelsChanged?: (joined?: JoinedChannel) => void
  checksJoinedMembers?: () => boolean
  onPlaceExternal?: (channel: string, reason: PlaceExternalReason) => void
  onCredentialRevoked?: (revocation: CredentialRevocation) => void
  actionCallback?: (agentId?: string) => MattermostActionCallbackConfig | undefined
  log: Logger
  createSocket?(url: string, headers?: Record<string, string>): MattermostSocket
  fetchImpl?: typeof fetch
  timing?: Partial<MattermostClientTiming>
  now?(): number
  newTraceId?: () => string
  maxAttachmentBytes?: number
  sendIntervalMs?: number
  catchUpRetryBaseMs?: number
  catchUpSteadyRetryMs?: number
  catchUpMaxPages?: number
}

interface CacheEntry<T> {
  value: T
  at: number
}

function setBounded<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key)
  map.set(key, value)
  while (map.size > max) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

function getFreshCached<T>(map: Map<string, CacheEntry<T>>, key: string, nowMs: number, ttlMs: number): T | undefined {
  const cached = map.get(key)
  if (!cached) return undefined
  if (nowMs - cached.at >= ttlMs) {
    map.delete(key)
    return undefined
  }
  map.delete(key)
  map.set(key, cached)
  return cached.value
}

function isPostId(value: string | undefined): value is string {
  return typeof value === 'string' && MATTERMOST_POST_ID_RE.test(value)
}

/** Split text into chunks each within `maxChars` UTF-16 code units/codepoints, preferring paragraph/line boundaries without splitting surrogate pairs. */
export function splitMattermostPost(text: string, maxChars: number): string[] {
  const cap = Math.max(1, Math.floor(maxChars))
  if (!text) return ['']
  if (text.length <= cap) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > cap) {
    let slice = rest.slice(0, cap)
    // Avoid breaking a UTF-16 surrogate pair in half.
    const lastCode = slice.charCodeAt(slice.length - 1)
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
      slice = slice.slice(0, -1)
    }
    let cut = slice.lastIndexOf('\n\n')
    if (cut < Math.floor(cap * 0.4)) {
      const nl = slice.lastIndexOf('\n')
      if (nl >= Math.floor(cap * 0.4)) cut = nl + 1
      else {
        const sp = slice.lastIndexOf(' ')
        if (sp >= Math.floor(cap * 0.5)) cut = sp + 1
        else cut = slice.length
      }
    } else {
      cut += 2
    }
    if (cut <= 0) cut = Math.max(1, slice.length)
    const head = rest.slice(0, cut)
    if (head.trim() || out.length === 0) out.push(head)
    rest = rest.slice(cut)
  }
  if (rest.length > 0) out.push(rest)
  return out
}

function isInvalidRootIdError(error: unknown): boolean {
  if (!(error instanceof MattermostApiError) || error.status !== 400) return false
  return Boolean(error.id?.includes('root_id') || /invalid\s+root_?id/i.test(error.message))
}

function buildPostProps(
  identity?: SendIdentity,
  extraProps?: Record<string, unknown>,
  opts?: { allowUsernameOverride?: boolean; allowIconOverride?: boolean }
): Record<string, unknown> | undefined {
  const props: Record<string, unknown> = extraProps ? { ...extraProps } : {}
  const username = identity?.username?.trim()
  const iconUrl = identity?.icon_url?.trim()
  const allowUser = opts?.allowUsernameOverride !== false
  const allowIcon = opts?.allowIconOverride !== false
  if (username && allowUser) {
    props.override_username = username
    props.from_webhook = 'true'
  }
  if (iconUrl && allowIcon) props.override_icon_url = iconUrl
  const agentAuthorId = identity?.agentAuthorId?.trim()
  if (agentAuthorId) {
    const response = identity?.response
    props.agentconnect_thread_event = {
      author_agent_id: agentAuthorId,
      ...(response
        ? {
            response_id: response.responseId,
            delivery_state: response.deliveryState,
            hop_count: response.hopCount,
            mentioned_agent_ids: response.mentionedAgentIds,
            ...(response.addressedAnyone ? { addressed_anyone: true } : {}),
            ...(response.agentCallDeliveryId ? { agent_call_delivery_id: response.agentCallDeliveryId } : {})
          }
        : {})
    }
  }
  return Object.keys(props).length > 0 ? props : undefined
}

function userDisplayRealName(user: MattermostUser): string | undefined {
  const full = [user.first_name, user.last_name]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(' ')
  return full || user.nickname?.trim() || undefined
}

function userTimeZone(user: MattermostUser): string | undefined {
  const tz = user.timezone
  if (!tz) return undefined
  const picked = tz.useAutomaticTimezone === 'true' ? tz.automaticTimezone : tz.manualTimezone
  return typeof picked === 'string' && picked.trim() ? picked.trim() : undefined
}

function channelSlug(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  if (cleaned.length >= 2) return cleaned
  return `ch-${randomUUID().slice(0, 8)}`
}

function dmCounterparty(channelName: string | undefined, selfUserId: string): string | undefined {
  if (!channelName || !channelName.includes('__')) return undefined
  const parts = channelName.split('__').filter(Boolean)
  if (parts.length !== 2) return undefined
  if (selfUserId && parts[0] === selfUserId) return parts[1]
  if (selfUserId && parts[1] === selfUserId) return parts[0]
  return parts[0]
}

function normalizeReactionPostId(raw: string): string {
  const trimmed = raw.trim()
  const tail = trimmed.startsWith(`${MATTERMOST_PLATFORM}:`) ? nativeMessageId(trimmed) : trimmed
  return tail.replace(/^(?:msg-|post_)/i, '').trim()
}

export class MattermostConnection implements PlatformConnection {
  readonly workspaceUrl: string
  readonly client: MattermostClient
  private readonly sendQueue: MattermostSendQueue
  private readonly now: () => number
  private readonly newTraceId: () => string
  private readonly channels = new Map<string, CacheEntry<MattermostChannel>>()
  private readonly users = new Map<string, CacheEntry<MattermostUser>>()
  private readonly memberships = new Map<string, CacheEntry<boolean>>()
  private readonly inflightChannels = new Map<string, Promise<MattermostChannel | undefined>>()
  private readonly inflightUsers = new Map<string, Promise<MattermostUser | undefined>>()
  private readonly postChannels = new Map<string, string>()
  private readonly seen = new Set<string>()
  private readonly inboundChains = new Map<string, Promise<void>>()
  private readonly questionTags = new Map<string, QuestionTagEntry>()
  private readonly questionTagsByUpper = new Map<string, { tag: string; entry: QuestionTagEntry }>()
  private readonly cardReplies = new Map<string, MattermostCardReplyEntry>()
  private readonly cardRepliesByUpper = new Map<string, MattermostCardReplyEntry>()
  private readonly channelWatermarks = new Map<string, number>()
  private readonly recoveryWatermarks = new Map<string, number>()
  // Ids of the posts delivered within the overlap before each channel's watermark, live and as frozen with the recovery watermark.
  private readonly channelTails = new Map<string, Map<string, number>>()
  private readonly recoveryTails = new Map<string, ReadonlySet<string>>()
  private readonly recoveryCompletedChannels = new Set<string>()
  private recoveryFallbackSince: number | undefined
  private recoveryEpoch = 0
  private wsDisconnected = false
  private lastConnectedAt = 0
  private catchUpInFlight = false
  private catchUpQueued = false
  private catchUpRetryTimer?: ReturnType<typeof setTimeout>
  private catchUpRetryCount = 0
  private revocationReported = false
  private revocationProbeInFlight = false
  private teams: MattermostTeam[] = []
  private _botUserId: string
  private _botUsername: string
  private _maxPostSize = MATTERMOST_DEFAULT_MAX_POST_SIZE
  private usernameOverrideEnabled = true
  private iconOverrideEnabled = true
  private readonly _workspaceId: string
  private stopped = false

  constructor(
    private _group: MattermostConnectionGroup,
    private readonly deps: MattermostConnectionDeps
  ) {
    const validated = validateMattermostServerUrl(_group.serverUrl)
    if (!validated.ok) throw new Error(validated.reason)
    this.workspaceUrl = validated.serverUrl
    this._workspaceId = mattermostExternalAppId(this.workspaceUrl) ?? this.workspaceUrl
    this._botUserId = _group.botUserId?.trim() ?? ''
    this._botUsername = _group.botUsername?.trim() ?? ''
    this.now = deps.now ?? Date.now
    this.newTraceId = deps.newTraceId ?? randomUUID
    this.client = new MattermostClient({
      serverUrl: this.workspaceUrl,
      botToken: _group.botToken,
      onEvent: (event) => this.onWsEvent(event),
      onDisconnect: () => this.onWsDisconnect(),
      onReconnect: () => this.onWsReconnect(),
      onUnauthorized: () => void this.confirmRevocationOnUnauthorized(),
      log: deps.log,
      ...(deps.createSocket ? { createSocket: deps.createSocket } : {}),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.timing ? { timing: deps.timing } : {}),
      now: this.now
    })
    this.sendQueue = new MattermostSendQueue(this.client.rateLimiter, deps.sendIntervalMs, this.now)
  }

  get group(): MattermostConnectionGroup {
    return this._group
  }

  updateGroup(group: MattermostConnectionGroup): void {
    this._group = group
  }

  actionCallback(agentId?: string, integrationId?: string): MattermostActionCallbackConfig | undefined {
    if (
      this._group.integrations.some(
        (i) =>
          i.websocketRepliesOnly &&
          (integrationId ? i.integrationId === integrationId : !agentId || i.agentId === agentId)
      )
    )
      return undefined
    return this.deps.actionCallback?.(agentId)
  }

  get botUserId(): string {
    return this._botUserId
  }

  get botUsername(): string {
    return this._botUsername
  }

  get selfName(): string {
    return this._botUsername
  }

  get maxPostSize(): number {
    return this._maxPostSize
  }

  get connected(): boolean {
    return this.client.connected
  }

  workspaceId(): string {
    return this._workspaceId
  }

  async start(): Promise<void> {
    if (this.stopped) throw new Error('mattermost: connection stopped')
    const me = await this.client.getMe()
    this._botUserId = me.id
    this._botUsername = me.username
    setBounded(this.users, me.id, { value: me, at: this.now() }, USER_CACHE_MAX)

    const caps = await this.client.getClientCapabilities()
    this._maxPostSize = caps.maxPostSize
    this.usernameOverrideEnabled = caps.usernameOverrideEnabled
    this.iconOverrideEnabled = caps.iconOverrideEnabled

    await Promise.all([
      this.client
        .getMyTeams()
        .then((teams) => {
          this.teams = teams.filter((team) => !team.delete_at)
        })
        .catch(() => undefined),
      this.client
        .getMyChannels()
        .then((channels) => {
          const at = this.now()
          const serverAt = this.client.serverNow()
          for (const ch of channels) {
            if (!ch.delete_at) {
              setBounded(this.channels, ch.id, { value: ch, at }, CHANNEL_CACHE_MAX)
              if (!this.channelWatermarks.has(ch.id)) {
                setBounded(this.channelWatermarks, ch.id, serverAt, WATERMARK_CACHE_MAX)
              }
            }
          }
        })
        .catch(() => undefined)
    ])

    this.lastConnectedAt = this.client.serverNow()
    await this.client.start()
    this.deps.log.info(`mattermost: connected as @${this._botUsername}`)
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.clearCatchUpRetryTimer()
    this.catchUpRetryCount = 0
    await this.client.stop()
  }

  private async confirmRevocationOnUnauthorized(): Promise<void> {
    if (this.stopped || this.revocationReported || this.revocationProbeInFlight || !this._botUserId) return
    this.revocationProbeInFlight = true
    try {
      await this.client.getMe({ skipUnauthorizedHook: true })
    } catch (error) {
      if (error instanceof MattermostApiError && error.status === 401 && !this.revocationReported) {
        this.revocationReported = true
        this.deps.log.warn('mattermost: bot token rejected (401) on probe — reporting credential revocation')
        this.deps.onCredentialRevoked?.({
          reason: 'tokens_revoked',
          eventAtMs: this.now(),
          botUserId: this._botUserId,
          workspaceId: this._workspaceId
        })
      }
    } finally {
      this.revocationProbeInFlight = false
    }
  }

  private advanceChannelWatermark(channelId: string, at: number): void {
    if (at > (this.channelWatermarks.get(channelId) ?? 0)) {
      setBounded(this.channelWatermarks, channelId, at, WATERMARK_CACHE_MAX)
    }
  }

  private noteDelivered(channelId: string, postId: string, createAt: number): void {
    let tail = this.channelTails.get(channelId)
    if (!tail) {
      tail = new Map()
      setBounded(this.channelTails, channelId, tail, WATERMARK_CACHE_MAX)
    }
    setBounded(tail, postId, createAt, CHANNEL_TAIL_MAX)
    const floor = (this.channelWatermarks.get(channelId) ?? createAt) - CATCH_UP_OVERLAP_MS
    for (const [id, at] of tail) if (at < floor) tail.delete(id)
  }

  private freezeRecoveryTail(channelId: string): void {
    setBounded(this.recoveryTails, channelId, new Set(this.channelTails.get(channelId)?.keys()), WATERMARK_CACHE_MAX)
  }

  private preserveRecoveryWatermark(channelId: string, watermark: number): void {
    if (!this.recoveryWatermarks.has(channelId)) {
      setBounded(this.recoveryWatermarks, channelId, watermark, WATERMARK_CACHE_MAX)
    }
  }

  private clearCatchUpRetryTimer(): void {
    if (this.catchUpRetryTimer) clearTimeout(this.catchUpRetryTimer)
    this.catchUpRetryTimer = undefined
  }

  private scheduleCatchUpRetry(): void {
    if (this.stopped || this.wsDisconnected || this.catchUpQueued || this.catchUpRetryTimer) return
    let delay: number
    if (this.catchUpRetryCount < CATCH_UP_FAST_RETRIES) {
      const baseMs = Math.max(0, this.deps.catchUpRetryBaseMs ?? CATCH_UP_RETRY_BASE_MS)
      delay = Math.min(MAX_CATCH_UP_RETRY_BACKOFF_MS, baseMs * 2 ** this.catchUpRetryCount)
      this.catchUpRetryCount++
    } else {
      const steadyMs = Math.max(1, this.deps.catchUpSteadyRetryMs ?? CATCH_UP_STEADY_RETRY_MS)
      if (this.catchUpRetryCount === CATCH_UP_FAST_RETRIES) {
        this.deps.log.warn(
          `mattermost: reconnect catch-up exhausted ${CATCH_UP_FAST_RETRIES} fast retries; falling back to steady ${steadyMs}ms retry`
        )
        this.catchUpRetryCount = CATCH_UP_FAST_RETRIES + 1
      }
      delay = steadyMs
    }
    const timer = setTimeout(() => {
      if (this.catchUpRetryTimer !== timer) return
      this.catchUpRetryTimer = undefined
      if (this.stopped || this.wsDisconnected) return
      void this.catchUpAfterReconnect()
    }, delay)
    this.catchUpRetryTimer = timer
    timer.unref?.()
  }

  private freezeRecoveryWatermarks(): void {
    const initialFreeze = this.recoveryFallbackSince === undefined
    if (initialFreeze) {
      this.recoveryFallbackSince = this.lastConnectedAt || this.client.serverNow()
      this.recoveryCompletedChannels.clear()
    }
    for (const [channelId, wm] of this.channelWatermarks) {
      const existing = this.recoveryWatermarks.get(channelId)
      if (existing === undefined) {
        // Freeze only on the initial outage snapshot so later live events on newly joined channels still fall back to recoveryFallbackSince.
        if (initialFreeze) {
          setBounded(this.recoveryWatermarks, channelId, wm, WATERMARK_CACHE_MAX)
          this.freezeRecoveryTail(channelId)
        }
      } else if (wm < existing) {
        setBounded(this.recoveryWatermarks, channelId, wm, WATERMARK_CACHE_MAX)
      }
    }
  }

  private onWsDisconnect(): void {
    if (this.stopped) return
    this.clearCatchUpRetryTimer()
    this.catchUpRetryCount = 0
    this.freezeRecoveryWatermarks()
    this.recoveryCompletedChannels.clear()
    this.recoveryEpoch++
    this.wsDisconnected = true
  }

  private onWsReconnect(): void {
    if (this.stopped) return
    this.clearCatchUpRetryTimer()
    this.catchUpRetryCount = 0
    this.freezeRecoveryWatermarks()
    this.wsDisconnected = false
    void this.catchUpAfterReconnect()
  }

  async catchUpAfterReconnect(): Promise<void> {
    if (this.stopped) return
    this.clearCatchUpRetryTimer()
    this.freezeRecoveryWatermarks()
    if (this.catchUpInFlight) {
      this.catchUpQueued = true
      return
    }
    this.catchUpInFlight = true
    try {
      do {
        this.catchUpQueued = false
        await this.catchUpOnce()
      } while (this.catchUpQueued && !this.stopped)
    } finally {
      this.catchUpInFlight = false
    }
  }

  private async fetchChannelPostsSince(
    channelId: string,
    since: number
  ): Promise<{ posts: MattermostPost[]; maxPostAt: number; complete: boolean }> {
    const byId = new Map<string, MattermostPost>()
    const seenCursors = new Set<string>()
    let maxPostAt = 0
    let usedSinceQuery = true
    let complete = true
    let list = await this.client.getChannelPosts(channelId, { since, perPage: CATCH_UP_PER_PAGE })

    const maxPages = Math.max(1, this.deps.catchUpMaxPages ?? MAX_CATCH_UP_PAGES)
    for (let pageCount = 1; pageCount <= maxPages; pageCount++) {
      const orderIds = Array.isArray(list.order) ? list.order : []
      const postMap = list.posts ?? {}
      const rawPosts = Object.values(postMap)
      for (const rawPost of rawPosts) {
        if (!rawPost?.id) continue
        const created = typeof rawPost.create_at === 'number' ? rawPost.create_at : 0
        const updated = typeof rawPost.update_at === 'number' ? rawPost.update_at : 0
        if (created >= since || updated >= since) {
          byId.set(rawPost.id, rawPost)
        }
        if (created > maxPostAt) maxPostAt = created
        if (updated > maxPostAt) maxPostAt = updated
      }

      if (rawPosts.length === 0) {
        complete = true
        break
      }

      const orderedPosts: MattermostPost[] = []
      for (const id of orderIds) {
        const entry = postMap[id]
        if (entry) orderedPosts.push(entry)
      }
      if (orderedPosts.length === 0) {
        orderedPosts.push(...rawPosts.slice().sort((a, b) => (b.create_at ?? 0) - (a.create_at ?? 0)))
      }

      const rawOldest = orderedPosts.at(-1)
      let cursorPost: MattermostPost | undefined
      if (usedSinceQuery) {
        // An old post edited during the outage still matches `since`, so anchor `before` on the oldest post created at/after `since`.
        for (let i = orderedPosts.length - 1; i >= 0; i--) {
          const candidate = orderedPosts[i]
          if (candidate?.id && (candidate.create_at ?? 0) >= since) {
            cursorPost = candidate
            break
          }
        }
      } else {
        cursorPost = rawOldest
      }
      const oldestId = cursorPost?.id
      if (!oldestId) {
        complete = true
        break
      }

      if (!usedSinceQuery && typeof rawOldest?.create_at === 'number' && rawOldest.create_at < since) {
        complete = true
        break
      }

      const hasOlder = usedSinceQuery
        ? Boolean(list.prev_post_id) || rawPosts.length >= MATTERMOST_SINCE_SERVER_CAP
        : Boolean(list.prev_post_id) || (list.prev_post_id === undefined && rawPosts.length >= CATCH_UP_PER_PAGE)
      if (!hasOlder) {
        complete = true
        break
      }

      if (seenCursors.has(oldestId)) {
        complete = true
        break
      }

      if (this.stopped) {
        complete = false
        break
      }
      if (pageCount >= maxPages) {
        // Pages run newest to oldest, so a retry would refetch these same posts and never reach the older ones.
        this.deps.log.warn(
          `mattermost: reconnect catch-up hit ${maxPages}-page cap on channel ${channelId}; older outage posts are not recovered`
        )
        complete = true
        break
      }

      seenCursors.add(oldestId)
      usedSinceQuery = false
      list = await this.client.getChannelPosts(channelId, { before: oldestId, perPage: CATCH_UP_PER_PAGE })
    }

    return { posts: [...byId.values()], maxPostAt, complete }
  }

  private async catchUpOnce(): Promise<void> {
    if (this.stopped || this.wsDisconnected) return
    const passStartedAt = this.client.serverNow()
    const passEpoch = this.recoveryEpoch
    let listed: MattermostChannel[] = []
    let channelsListComplete = true
    try {
      listed = await this.client.getMyChannels(false)
      const at = this.now()
      for (const ch of listed) {
        if (!ch.delete_at) setBounded(this.channels, ch.id, { value: ch, at }, CHANNEL_CACHE_MAX)
      }
      this.deps.onChannelsChanged?.()
    } catch {
      channelsListComplete = false
      listed = [...this.channels.values()].map((e) => e.value)
    }
    if (this.stopped || this.wsDisconnected || this.recoveryEpoch !== passEpoch) return

    const byId = new Map<string, MattermostChannel>()
    const deletedIds = new Set<string>()
    for (const ch of listed) {
      if (!ch?.id) continue
      if (ch.delete_at) {
        deletedIds.add(ch.id)
        byId.delete(ch.id)
        continue
      }
      if (!deletedIds.has(ch.id)) byId.set(ch.id, ch)
    }
    if (!channelsListComplete) {
      for (const channelId of this.recoveryWatermarks.keys()) {
        if (!byId.has(channelId) && !deletedIds.has(channelId)) {
          byId.set(channelId, { id: channelId, type: '' })
        }
      }
    }
    const nonDeleted = [...byId.values()].sort(
      (a, b) => (b.last_post_at ?? b.update_at ?? 0) - (a.last_post_at ?? a.update_at ?? 0)
    )
    const pending = nonDeleted.filter((ch) => !this.recoveryCompletedChannels.has(ch.id))
    let allChannelsClean = channelsListComplete
    const fallbackSince = this.recoveryFallbackSince ?? (this.lastConnectedAt || passStartedAt)
    const concurrency = 4
    let idx = 0
    const worker = async () => {
      while (!this.stopped) {
        if (this.wsDisconnected || this.recoveryEpoch !== passEpoch) {
          allChannelsClean = false
          break
        }
        const ch = pending[idx++]
        if (!ch) return
        if (this.recoveryCompletedChannels.has(ch.id)) continue
        const watermark = this.recoveryWatermarks.get(ch.id) ?? fallbackSince
        const since = Math.max(1, watermark - CATCH_UP_OVERLAP_MS)
        const deliveredBeforeOutage = this.recoveryTails.get(ch.id)
        const passAt = this.client.serverNow()
        try {
          const { posts: fetchedPosts, maxPostAt, complete } = await this.fetchChannelPostsSince(ch.id, since)
          const posts = fetchedPosts
            .filter(
              (p) =>
                Boolean(p.id) &&
                Boolean(p.channel_id) &&
                Boolean(p.user_id) &&
                !(p.delete_at && p.delete_at > 0) &&
                (p.user_id !== this._botUserId ||
                  (readMattermostAgentAuthorshipClaim(p)?.deliveryState === 'final' &&
                    p.props?.agentconnect_chrome !== true))
            )
            .sort((a, b) => (a.create_at ?? 0) - (b.create_at ?? 0))
          let resolvedChannel = ch
          if (posts.length > 0 && !resolvedChannel.type) {
            const fetchedChannel = await this.getChannelCached(ch.id)
            if (!fetchedChannel) {
              throw new Error(`mattermost: missing channel metadata for ${ch.id}`)
            }
            if (fetchedChannel.delete_at) {
              if (!this.stopped && !this.wsDisconnected && this.recoveryEpoch === passEpoch) {
                this.recoveryCompletedChannels.add(ch.id)
              } else {
                allChannelsClean = false
                if (this.wsDisconnected || this.recoveryEpoch !== passEpoch) break
              }
              continue
            }
            resolvedChannel = fetchedChannel
          }
          let hadError = false
          let lastRun: Promise<void> | undefined
          for (const p of posts) {
            if (this.stopped || this.wsDisconnected || this.recoveryEpoch !== passEpoch || !p.id) break
            // A post created before the outage and only touched during it is an edit: replay it as one, and only when it closes a response.
            const type = (p.create_at ?? 0) >= since ? 'posted' : 'post_edited'
            if (type === 'post_edited' && readMattermostAgentAuthorshipClaim(p)?.deliveryState !== 'final') continue
            // The overlap refetches posts delivered just before the outage; `seen` may have forgotten them, their channel has not.
            if (type === 'posted' && deliveredBeforeOutage?.has(p.id)) continue
            const dedupKey = `${type}:${p.id}`
            if (this.seen.has(dedupKey)) continue
            this.seen.add(dedupKey)
            while (this.seen.size > SEEN_LIMIT) {
              const oldest = this.seen.values().next().value
              if (oldest === undefined) break
              this.seen.delete(oldest)
            }
            const syntheticEvent: MattermostPostedEvent = {
              event: type,
              data: {
                post: p,
                channel_type: resolvedChannel.type,
                ...(resolvedChannel.name ? { channel_name: resolvedChannel.name } : {}),
                ...(resolvedChannel.display_name ? { channel_display_name: resolvedChannel.display_name } : {}),
                ...(resolvedChannel.team_id ? { team_id: resolvedChannel.team_id } : {})
              },
              broadcast: { channel_id: resolvedChannel.id }
            }
            const prev = this.inboundChains.get(ch.id) ?? Promise.resolve()
            const run = prev
              .then(() => this.processPostEvent(type, syntheticEvent, p))
              .catch((error: unknown) => {
                hadError = true
                // Forget the post so the retry pass delivers it instead of skipping it as already seen.
                this.seen.delete(dedupKey)
                this.deps.log.warn(
                  `mattermost: catch-up process failed (${error instanceof Error ? error.message : 'unknown error'})`
                )
              })
            lastRun = run
            this.inboundChains.set(ch.id, run)
            void run.then(() => {
              if (this.inboundChains.get(ch.id) === run) this.inboundChains.delete(ch.id)
            })
          }
          if (lastRun) await lastRun
          if (!hadError && complete && !this.stopped && !this.wsDisconnected && this.recoveryEpoch === passEpoch) {
            const resolvedWatermark = Math.max(watermark, maxPostAt, passAt)
            this.advanceChannelWatermark(ch.id, resolvedWatermark)
            setBounded(this.recoveryWatermarks, ch.id, resolvedWatermark, WATERMARK_CACHE_MAX)
            this.freezeRecoveryTail(ch.id)
            this.recoveryCompletedChannels.add(ch.id)
          } else {
            allChannelsClean = false
            this.preserveRecoveryWatermark(ch.id, watermark)
            if (this.wsDisconnected || this.recoveryEpoch !== passEpoch) break
          }
        } catch (error) {
          allChannelsClean = false
          this.preserveRecoveryWatermark(ch.id, watermark)
          this.deps.log.debug(
            `mattermost: reconnect catch-up skipped channel ${ch.id} (${error instanceof Error ? error.message : 'unknown error'})`
          )
          if (this.wsDisconnected || this.recoveryEpoch !== passEpoch) break
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, () => worker()))
    if (
      allChannelsClean &&
      !this.wsDisconnected &&
      this.recoveryEpoch === passEpoch &&
      !this.catchUpQueued &&
      !this.stopped
    ) {
      this.clearCatchUpRetryTimer()
      this.catchUpRetryCount = 0
      this.lastConnectedAt = Math.max(this.lastConnectedAt, passStartedAt)
      this.recoveryWatermarks.clear()
      this.recoveryTails.clear()
      this.recoveryFallbackSince = undefined
      this.recoveryCompletedChannels.clear()
    } else if (
      !allChannelsClean &&
      !this.stopped &&
      !this.wsDisconnected &&
      this.recoveryEpoch === passEpoch &&
      !this.catchUpQueued
    ) {
      this.scheduleCatchUpRetry()
    }
  }

  // ── Inbound WebSocket handling & metadata enrichment ──

  private onWsEvent(event: MattermostWsEvent): void {
    if (this.stopped) return
    const type = event.event
    if (!type) return

    if (
      type === 'channel_created' ||
      type === 'channel_updated' ||
      type === 'channel_deleted' ||
      type === 'direct_added' ||
      type === 'group_added'
    ) {
      const chId =
        (typeof event.data?.channel_id === 'string' && event.data.channel_id) ||
        (typeof event.broadcast?.channel_id === 'string' && event.broadcast.channel_id) ||
        undefined
      if (chId) this.channels.delete(chId)
      if (type === 'channel_created' || type === 'channel_updated' || type === 'channel_deleted') {
        this.deps.onChannelsChanged?.()
      }
      return
    }

    if (type === 'user_added' || type === 'user_removed') {
      const chId =
        (typeof event.data?.channel_id === 'string' && event.data.channel_id) ||
        (typeof event.broadcast?.channel_id === 'string' && event.broadcast.channel_id) ||
        undefined
      const userId = typeof event.data?.user_id === 'string' ? event.data.user_id : undefined
      if (chId && userId) this.memberships.delete(`${chId}:${userId}`)
      if (userId && this._botUserId && userId === this._botUserId) {
        if (chId) this.channels.delete(chId)
        this.deps.onChannelsChanged?.(type === 'user_added' && chId ? { channel: chId } : undefined)
        return
      }
      if (type === 'user_added' && chId && userId && this.deps.checksJoinedMembers?.() === true) {
        void this.getUserCached(userId)
          .then((u) => {
            if (!u || this.stopped) return
            if (u.remote_id) {
              this.deps.onPlaceExternal?.(chId, 'externallyShared')
              return
            }
            const roles = (u.roles ?? '').split(/\s+/).filter(Boolean)
            if (roles.includes('system_guest')) {
              this.deps.onPlaceExternal?.(chId, 'guestMember')
            }
          })
          .catch(() => undefined)
      }
      return
    }

    if (type === 'user_updated') {
      const u = event.data?.user as Partial<MattermostUser> | undefined
      if (u && typeof u.id === 'string' && typeof u.username === 'string') {
        setBounded(this.users, u.id, { value: u as MattermostUser, at: this.now() }, USER_CACHE_MAX)
      }
      return
    }

    if (type === 'post_deleted') {
      const post = parseMattermostPost(event.data?.post)
      if (post?.id) {
        this.postChannels.delete(post.id)
        this.seen.delete(`posted:${post.id}`)
        this.seen.delete(`post_edited:${post.id}`)
      }
      return
    }

    if (type !== 'posted' && type !== 'post_edited') return

    const post = parseMattermostPost(event.data?.post)
    if (!post?.id || !post.channel_id || !post.user_id) return
    // Ignore own ephemeral/streaming/chrome posts; finalized own-bot posts pass through so peers sharing a bot can coordinate.
    if (this._botUserId && post.user_id === this._botUserId) {
      const claim = readMattermostAgentAuthorshipClaim(post)
      if (!claim || claim.deliveryState !== 'final' || post.props?.agentconnect_chrome === true) {
        this.advanceChannelWatermark(post.channel_id, post.create_at ?? this.client.serverNow())
        return
      }
    }

    if (type === 'post_edited') {
      const claim = readMattermostAgentAuthorshipClaim(post)
      if (claim?.deliveryState !== 'final') {
        this.advanceChannelWatermark(post.channel_id, post.create_at ?? this.client.serverNow())
        return
      }
    }

    const dedupKey = `${type}:${post.id}`
    if (this.seen.has(dedupKey)) return
    this.seen.add(dedupKey)
    while (this.seen.size > SEEN_LIMIT) {
      const oldest = this.seen.values().next().value
      if (oldest === undefined) break
      this.seen.delete(oldest)
    }

    const channelId = post.channel_id
    const prev = this.inboundChains.get(channelId) ?? Promise.resolve()
    const run = prev
      .then(() => this.processPostEvent(type, event as MattermostPostedEvent, post))
      .catch((error: unknown) => {
        this.deps.log.warn(
          `mattermost: failed to process ${type} event (${error instanceof Error ? error.message : 'unknown error'})`
        )
      })
    this.inboundChains.set(channelId, run)
    void run.then(() => {
      if (this.inboundChains.get(channelId) === run) this.inboundChains.delete(channelId)
    })
  }

  private async processPostEvent(
    type: 'posted' | 'post_edited',
    event: MattermostPostedEvent,
    post: MattermostPost
  ): Promise<void> {
    if (this.stopped) return
    const channelId = post.channel_id!
    const userId = post.user_id!

    let channelType = typeof event.data?.channel_type === 'string' ? event.data.channel_type.trim() : undefined
    if (!channelType) {
      const ch = await this.getChannelCached(channelId).catch(() => undefined)
      channelType = ch?.type
    } else if (!this.channels.has(channelId)) {
      const name = typeof event.data?.channel_name === 'string' ? event.data.channel_name : undefined
      const displayName =
        typeof event.data?.channel_display_name === 'string' ? event.data.channel_display_name : undefined
      const teamId = typeof event.data?.team_id === 'string' ? event.data.team_id : undefined
      setBounded(
        this.channels,
        channelId,
        {
          value: {
            id: channelId,
            type: channelType,
            ...(name ? { name } : {}),
            ...(displayName ? { display_name: displayName } : {}),
            ...(teamId ? { team_id: teamId } : {})
          },
          at: this.now()
        },
        CHANNEL_CACHE_MAX
      )
    }

    let senderIsBot = post.props?.from_bot === 'true' || post.props?.from_bot === true
    let senderName = typeof event.data?.sender_name === 'string' ? event.data.sender_name : undefined
    let profileIsBot = false
    if (!senderIsBot || !senderName || type === 'post_edited') {
      const user = await this.getUserCached(userId).catch(() => undefined)
      if (user) {
        if (user.is_bot) {
          senderIsBot = true
          profileIsBot = true
        }
        senderName ??= user.username
      }
    }
    // Anyone can set props on their own post, so a response-final claim counts only from an account the server says is a bot.
    if (type === 'post_edited' && !profileIsBot) {
      this.advanceChannelWatermark(channelId, post.create_at ?? this.client.serverNow())
      return
    }

    const context = {
      botUserId: this._botUserId,
      ...(this._botUsername ? { botUsername: this._botUsername } : {}),
      senderIsBot,
      ...(senderName ? { senderName } : {}),
      ...(channelType ? { channelType } : {}),
      serverUrl: this.workspaceUrl,
      appId: this._workspaceId,
      traceId: this.newTraceId()
    }

    const normalized =
      type === 'posted'
        ? normalizeMattermostMessage(event, context)
        : normalizeMattermostResponseFinalization(event, context)
    if (!normalized) return

    const createdAt = post.create_at ?? this.client.serverNow()
    this.advanceChannelWatermark(channelId, createdAt)
    if (type === 'posted' && post.id) this.noteDelivered(channelId, post.id, createdAt)

    const msg = normalized as NormalizedMessage
    for (const attachment of msg.attachments ?? []) {
      attachment.readerToolName = MATTERMOST_ATTACHMENT_TOOL.name
    }
    if (type === 'posted' && !msg.sender.isBot && msg.replyTo === undefined) {
      if (await this.tryHandleCardReply(msg)) return
      this.applyQuestionTagMatch(msg)
    }
    if (!this.stopped) this.deps.onMessage(msg)
  }

  // ── Question tag and card reply tracking for pure-WS fallback cards ──

  noteCardReply(entry: MattermostCardReplyEntry): void {
    this.cardReplies.delete(entry.tag)
    this.cardReplies.set(entry.tag, entry)
    this.cardRepliesByUpper.set(entry.tag.toUpperCase(), entry)
    while (this.cardReplies.size > QUESTION_TAG_LIMIT) {
      const oldest = this.cardReplies.keys().next().value
      if (oldest === undefined) break
      this.cardReplies.delete(oldest)
      this.cardRepliesByUpper.delete(oldest.toUpperCase())
    }
  }

  retireCardReply(tag: string): void {
    this.cardReplies.delete(tag)
    this.cardRepliesByUpper.delete(tag.toUpperCase())
  }

  private async tryHandleCardReply(msg: NormalizedMessage): Promise<boolean> {
    if (!this.deps.onCardClick || this.cardReplies.size === 0) return false
    const matched = matchCardReply(this.cardReplies, this.cardRepliesByUpper, this.questionTags, msg)
    if (!matched) return false
    let told: string | undefined
    try {
      told = await this.deps.onCardClick(matched.click, matched.entry.agentId, matched.entry.integrationId)
    } catch (error) {
      this.deps.log.warn(
        `mattermost: card reply handler failed (${error instanceof Error ? error.message : 'unknown error'})`
      )
      return true
    }
    if (!this.stopped && typeof told === 'string' && told.trim()) {
      await this.postEphemeral(msg.channel, msg.sender.id, told, msg.replyThread).catch((error: unknown) => {
        this.deps.log.debug(
          `mattermost: postEphemeral refusal failed (${error instanceof Error ? error.message : 'unknown error'})`
        )
      })
    }
    return true
  }

  noteQuestionTag(channel: string, tag: string, thread?: string, replyToValue?: string): void {
    const entry: QuestionTagEntry = {
      channel,
      ...(thread ? { thread } : {}),
      ...(replyToValue ? { replyToValue } : {})
    }
    this.questionTags.delete(tag)
    this.questionTags.set(tag, entry)
    this.questionTagsByUpper.set(tag.toUpperCase(), { tag, entry })
    while (this.questionTags.size > QUESTION_TAG_LIMIT) {
      const oldest = this.questionTags.keys().next().value
      if (oldest === undefined) break
      this.questionTags.delete(oldest)
      this.questionTagsByUpper.delete(oldest.toUpperCase())
    }
  }

  retireQuestionTag(tag: string): void {
    this.questionTags.delete(tag)
    this.questionTagsByUpper.delete(tag.toUpperCase())
  }

  private applyQuestionTagMatch(msg: NormalizedMessage): void {
    if (this.questionTags.size === 0) return
    const text = msg.text ?? ''
    for (const match of text.matchAll(SCAN_STANDARD_TAG_RE)) {
      const hit = this.questionTagsByUpper.get(match[0].toUpperCase())
      if (hit && hit.entry.channel === msg.channel) {
        msg.replyTo = hit.entry.replyToValue ?? hit.tag
        return
      }
    }
    let lowerText: string | undefined
    for (const [tag, entry] of this.questionTags) {
      if (entry.channel !== msg.channel || STANDARD_CARD_TAG_RE.test(tag)) continue
      lowerText ??= text.toLowerCase()
      if (containsTokenBoundary(lowerText, tag.toLowerCase())) {
        msg.replyTo = entry.replyToValue ?? tag
        return
      }
    }
    const bare = stripLeadingMentions(text)
    if (!/^\d{1,2}$/.test(bare)) return
    const threadMatches: Array<[string, QuestionTagEntry]> = []
    for (const [tag, entry] of this.questionTags) {
      if (matchesReplyScope(entry.channel, entry.thread, entry.replyToValue, msg)) {
        threadMatches.push([tag, entry])
      }
    }
    if (threadMatches.length !== 1) return
    for (const entry of this.cardReplies.values()) {
      if (matchesReplyScope(entry.channel, entry.thread, entry.postId, msg)) return
    }
    const [tag, entry] = threadMatches[0]!
    msg.replyTo = entry.replyToValue ?? tag
  }

  // ── Cached metadata helpers ──

  private async getChannelCached(channelId: string): Promise<MattermostChannel | undefined> {
    const cached = getFreshCached(this.channels, channelId, this.now(), METADATA_TTL_MS)
    if (cached) return cached
    const inflight = this.inflightChannels.get(channelId)
    if (inflight) return inflight
    const run = this.client
      .getChannel(channelId)
      .then((ch) => {
        setBounded(this.channels, channelId, { value: ch, at: this.now() }, CHANNEL_CACHE_MAX)
        return ch
      })
      .finally(() => {
        if (this.inflightChannels.get(channelId) === run) this.inflightChannels.delete(channelId)
      })
    this.inflightChannels.set(channelId, run)
    return run
  }

  private async getUserCached(userId: string): Promise<MattermostUser | undefined> {
    const cached = getFreshCached(this.users, userId, this.now(), METADATA_TTL_MS)
    if (cached) return cached
    const inflight = this.inflightUsers.get(userId)
    if (inflight) return inflight
    const run = this.client
      .getUser(userId)
      .then((user) => {
        setBounded(this.users, userId, { value: user, at: this.now() }, USER_CACHE_MAX)
        return user
      })
      .finally(() => {
        if (this.inflightUsers.get(userId) === run) this.inflightUsers.delete(userId)
      })
    this.inflightUsers.set(userId, run)
    return run
  }

  private async getUsersByIdsCached(userIds: readonly string[]): Promise<Map<string, MattermostUser>> {
    const out = new Map<string, MattermostUser>()
    const missing: string[] = []
    const now = this.now()
    for (const id of new Set(userIds)) {
      if (!id) continue
      const cached = getFreshCached(this.users, id, now, METADATA_TTL_MS)
      if (cached) {
        out.set(id, cached)
      } else {
        missing.push(id)
      }
    }
    for (let i = 0; i < missing.length; i += USER_IDS_BATCH_SIZE) {
      const batch = missing.slice(i, i + USER_IDS_BATCH_SIZE)
      const fetched = await this.client.getUsersByIds(batch).catch(() => [])
      const at = this.now()
      for (const user of fetched) {
        setBounded(this.users, user.id, { value: user, at }, USER_CACHE_MAX)
        out.set(user.id, user)
      }
    }
    return out
  }

  /** Check whether `userId` is currently a member of `channelId` (`GET /api/v4/channels/{id}/members/{userId}`). */
  async hasChannelMember(channelId: string, userId: string): Promise<boolean> {
    const key = `${channelId}:${userId}`
    const cached = getFreshCached(this.memberships, key, this.now(), METADATA_TTL_MS)
    if (cached !== undefined) return cached
    try {
      await this.client.getChannelMember(channelId, userId)
      setBounded(this.memberships, key, { value: true, at: this.now() }, MEMBERSHIP_CACHE_MAX)
      return true
    } catch (error) {
      if (error instanceof MattermostApiError && (error.status === 404 || error.status === 403)) {
        setBounded(this.memberships, key, { value: false, at: this.now() }, MEMBERSHIP_CACHE_MAX)
        return false
      }
      throw error
    }
  }

  // ── Outbound posting, streaming patch, chrome & typing ──

  async createPost(
    channel: string,
    text: string,
    opts?: {
      rootId?: string
      fileIds?: string[]
      props?: Record<string, unknown>
      identity?: SendIdentity
    }
  ): Promise<MattermostPost & { id: string }> {
    const props = buildPostProps(opts?.identity, opts?.props, {
      allowUsernameOverride: this.usernameOverrideEnabled,
      allowIconOverride: this.iconOverrideEnabled
    })
    let rootId = isPostId(opts?.rootId) ? opts?.rootId : undefined
    let activeProps = props
    const post = await this.sendQueue.enqueue(channel, async () => {
      const submit = (rid: string | undefined, p: Record<string, unknown> | undefined) =>
        this.client.createPost({
          channel_id: channel,
          message: text,
          ...(rid ? { root_id: rid } : {}),
          ...(opts?.fileIds?.length ? { file_ids: opts.fileIds } : {}),
          ...(p ? { props: p } : {})
        })

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await submit(rootId, activeProps)
        } catch (err) {
          if (err instanceof MattermostApiError) {
            if (err.status === 403 && this._botUserId) {
              const isMember = await this.hasChannelMember(channel, this._botUserId).catch(() => true)
              if (!isMember) {
                const ch = await this.getChannelCached(channel).catch(() => undefined)
                if (ch?.type === 'O' && !(ch.delete_at && ch.delete_at > 0)) {
                  throw markNotJoined(err, channel)
                }
              }
            }
            if (rootId && isInvalidRootIdError(err)) {
              const parent = await this.client.getPost(rootId).catch(() => undefined)
              rootId =
                parent?.root_id && isPostId(parent.root_id) && parent.root_id !== rootId ? parent.root_id : undefined
              continue
            }
            if (
              (err.status === 400 || err.status === 403) &&
              activeProps &&
              ('override_username' in activeProps || 'override_icon_url' in activeProps)
            ) {
              this.usernameOverrideEnabled = false
              this.iconOverrideEnabled = false
              this.deps.log.warn(
                'mattermost: post identity override rejected by server; falling back without override_username/override_icon_url'
              )
              activeProps = buildPostProps(opts?.identity, opts?.props, {
                allowUsernameOverride: false,
                allowIconOverride: false
              })
              continue
            }
          }
          throw err
        }
      }
      return await submit(rootId, activeProps)
    })
    setBounded(this.postChannels, post.id, channel, POST_CHANNEL_CACHE_MAX)
    return post
  }

  async patchPost(
    postId: string,
    text: string,
    opts?: {
      fileIds?: string[]
      props?: Record<string, unknown>
      identity?: SendIdentity
    }
  ): Promise<MattermostPost & { id: string }> {
    const props = buildPostProps(opts?.identity, opts?.props, {
      allowUsernameOverride: this.usernameOverrideEnabled,
      allowIconOverride: this.iconOverrideEnabled
    })
    const queueKey = this.postChannels.get(postId) ?? `patch:${postId}`
    return this.sendQueue.enqueue(queueKey, async () => {
      try {
        return await this.client.patchPost(postId, {
          message: text,
          ...(opts?.fileIds ? { file_ids: opts.fileIds } : {}),
          ...(props ? { props } : {})
        })
      } catch (err) {
        if (
          err instanceof MattermostApiError &&
          (err.status === 400 || err.status === 403) &&
          props &&
          ('override_username' in props || 'override_icon_url' in props)
        ) {
          this.usernameOverrideEnabled = false
          this.iconOverrideEnabled = false
          this.deps.log.warn(
            'mattermost: post identity override rejected by server; falling back without override_username/override_icon_url'
          )
          const fallbackProps = buildPostProps(opts?.identity, opts?.props, {
            allowUsernameOverride: false,
            allowIconOverride: false
          })
          return await this.client.patchPost(postId, {
            message: text,
            ...(opts?.fileIds ? { file_ids: opts.fileIds } : {}),
            ...(fallbackProps ? { props: fallbackProps } : {})
          })
        }
        throw err
      }
    })
  }

  async deletePost(postId: string): Promise<boolean> {
    const queueKey = this.postChannels.get(postId) ?? `delete:${postId}`
    try {
      await this.sendQueue.enqueue(queueKey, () => this.client.deletePost(postId))
      return true
    } catch (error) {
      this.deps.log.debug(
        `mattermost: deletePost failed (post=${postId}): ${error instanceof Error ? error.message : 'unknown error'}`
      )
      return false
    }
  }

  async deleteMessage(channel: string, ts: string): Promise<boolean> {
    try {
      await this.sendQueue.enqueue(channel, () => this.client.deletePost(ts))
      return true
    } catch (error) {
      this.deps.log.debug(
        `mattermost: deleteMessage failed (ch=${channel} post=${ts}): ${error instanceof Error ? error.message : 'unknown error'}`
      )
      return false
    }
  }

  async sendMarkdown(channel: string, text: string, threadTs?: string, identity?: SendIdentity): Promise<string[]> {
    const parts = splitMattermostPost(text, this._maxPostSize)
    let rootId = isPostId(threadTs) ? threadTs : undefined
    const ids: string[] = []
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!
      const isLast = i === parts.length - 1
      // Stamp final authorship metadata only on the last chunk if response closure is carried on a single send.
      const chunkIdentity =
        identity?.response && !isLast
          ? {
              ...identity,
              response: { ...identity.response, deliveryState: 'streaming' as const }
            }
          : identity
      const created = await this.createPost(channel, part, {
        ...(rootId ? { rootId } : {}),
        ...(chunkIdentity ? { identity: chunkIdentity } : {})
      })
      ids.push(created.id)
      rootId ??= created.id
    }
    return ids
  }

  async postMessage(
    channel: string,
    text: string,
    threadTs?: string,
    identity?: SendIdentity
  ): Promise<string | undefined> {
    const ids = await this.sendMarkdown(channel, text, threadTs, identity)
    return ids[0]
  }

  /**
   * Mirror a Console continuation prompt into Mattermost with distinct author attribution.
   * Uses a visual attachment card (rather than `override_username`, which Mattermost strips for REST bots)
   * and omits `finalizeResponse` intentionally so `ChatSessionContinuation` keeps the card intact.
   */
  async postAsAuthor(
    channel: string,
    threadTs: string | undefined,
    body: { text: string; attributedText: string },
    author: { name: string; iconUrl?: string },
    options?: { agentAuthorId?: string }
  ): Promise<{ ts: string; text: string } | undefined> {
    const safeAuthor = (author.name.replace(/\s+/g, ' ').trim() || 'User')
      .slice(0, 80)
      .replace(/([\\`*_[\]~<>])/g, '\\$1')
    const header = `💬 **${safeAuthor}** _(via console)_`
    let safeIconUrl: string | undefined
    if (author.iconUrl?.trim()) {
      try {
        const parsed = new URL(author.iconUrl.trim())
        if (parsed.protocol === 'https:' || parsed.protocol === 'http:') safeIconUrl = parsed.toString()
      } catch {
        safeIconUrl = undefined
      }
    }
    const identity: SendIdentity | undefined = options?.agentAuthorId
      ? {
          agentAuthorId: options.agentAuthorId,
          response: {
            responseId: this.newTraceId(),
            deliveryState: 'final',
            hopCount: 0,
            mentionedAgentIds: []
          }
        }
      : undefined
    const rootId = isPostId(threadTs) ? threadTs : undefined
    const cardLimit = Math.max(200, this._maxPostSize - 200)
    if (body.text.length <= cardLimit) {
      const created = await this.createPost(channel, header, {
        ...(rootId ? { rootId } : {}),
        props: {
          attachments: [
            {
              color: '#6366F1',
              text: body.text,
              fallback: body.attributedText.slice(0, 300),
              ...(safeIconUrl ? { author_icon: safeIconUrl } : {})
            }
          ]
        },
        ...(identity ? { identity } : {})
      })
      return created.id ? { ts: created.id, text: body.text } : undefined
    }
    const quoted = `${header}\n\n${body.text
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n')}`
    const ids = await this.sendMarkdown(channel, quoted, threadTs, identity)
    return ids[0] ? { ts: ids[0], text: body.text } : undefined
  }

  async postMentioning(
    channel: string,
    text: string,
    users: string[],
    identity?: SendIdentity,
    threadTs?: string
  ): Promise<string | undefined> {
    const cleanUsers = [...new Set(users.map((u) => u.trim()).filter(Boolean))]
    const resolved = await this.getUsersByIdsCached(cleanUsers.filter((u) => !u.startsWith('@')))
    const mentions = cleanUsers.map((u) => {
      if (u.startsWith('@')) return u
      const profile = resolved.get(u)
      return `@${profile?.username ?? u}`
    })
    const body = mentions.length > 0 ? `${mentions.join(' ')} ${text}` : text
    return this.postMessage(channel, body, threadTs, identity)
  }

  async sendText(channel: string, text: string, threadTs?: string): Promise<boolean> {
    try {
      const ids = await this.sendMarkdown(channel, text, threadTs)
      return ids.length > 0
    } catch (error) {
      this.deps.log.warn(`mattermost: sendText failed (${error instanceof Error ? error.message : 'unknown error'})`)
      return false
    }
  }

  async sendTyping(channel: string, parentId?: string): Promise<void> {
    await this.client.sendTyping(channel, isPostId(parentId) ? parentId : undefined)
  }

  async postEphemeral(channel: string, userId: string, text: string, rootId?: string): Promise<void> {
    await this.client.createEphemeralPost(userId, channel, text, isPostId(rootId) ? rootId : undefined)
  }

  async leaveChannel(channelId: string): Promise<void> {
    if (!this._botUserId) throw new Error('mattermost: bot user id is not known yet')
    await this.client.removeChannelMember(channelId, this._botUserId)
    this.channels.delete(channelId)
    this.memberships.delete(`${channelId}:${this._botUserId}`)
  }

  /** Enter an active public Mattermost channel (`type === 'O'`); refuses private channels, DMs, and deleted channels. */
  async joinChannel(channel: string): Promise<void> {
    if (!this._botUserId) throw new Error('mattermost: bot user id is not known yet')
    const ch = await this.client.getChannel(channel)
    if (ch.type !== 'O' || (ch.delete_at && ch.delete_at > 0)) {
      throw new Error('mattermost: joinChannel only enters active public channels')
    }
    await this.client.addChannelMember(channel, this._botUserId)
    setBounded(this.channels, ch.id, { value: ch, at: this.now() }, CHANNEL_CACHE_MAX)
    setBounded(this.memberships, `${channel}:${this._botUserId}`, { value: true, at: this.now() }, MEMBERSHIP_CACHE_MAX)
    this.deps.log.info(`mattermost: joined public channel ${channel}`)
  }

  async sendChatAction(channel: string, threadTs?: string): Promise<void> {
    await this.sendTyping(channel, isPostId(threadTs) ? threadTs : undefined)
  }

  // ── PlatformConnection / MessageGateway read & action ports ──

  async getChannelInfo(channel: string): Promise<PlatformChannelInfo> {
    const ch = await this.getChannelCached(channel)
    if (!ch) throw new Error(`mattermost: channel ${channel} not found`)
    const isIm = ch.type === 'D'
    const isMpim = ch.type === 'G'
    const isPrivate = ch.type !== 'O'
    const dmUser = isIm ? dmCounterparty(ch.name, this._botUserId) : undefined
    const name = !isIm ? ch.display_name?.trim() || ch.name?.trim() || undefined : undefined
    return {
      id: ch.id,
      ...(name ? { name } : {}),
      isIm,
      isMpim,
      isPrivate,
      ...(dmUser ? { user: dmUser } : {}),
      ...(ch.header?.trim() ? { topic: ch.header.trim() } : {}),
      ...(ch.purpose?.trim() ? { description: ch.purpose.trim() } : {}),
      externalReason: ch.shared === true ? 'externallyShared' : null
    }
  }

  async listMembers(channel: string): Promise<PlatformMemberRef[]> {
    const members = await this.client.getChannelMembers(channel, 0, MEMBER_PAGE_SIZE)
    const users = await this.getUsersByIdsCached(members.map((m) => m.user_id))
    return members.map((m) => {
      const u = users.get(m.user_id)
      return {
        id: m.user_id,
        ...(u?.username ? { name: u.username } : {}),
        isBot: u?.is_bot === true
      }
    })
  }

  async listMemberIds(channel: string): Promise<string[]> {
    const ids: string[] = []
    for (let page = 0; page < MEMBER_PAGE_CAP; page++) {
      const batch = await this.client.getChannelMembers(channel, page, MEMBER_PAGE_SIZE)
      for (const m of batch) ids.push(m.user_id)
      if (batch.length < MEMBER_PAGE_SIZE) return ids
    }
    throw new Error(`mattermost: channel ${channel} exceeded ${MEMBER_PAGE_CAP} member pages`)
  }

  /** Authoritative bot channel membership filtered to `O` (public) and `P` (private) channels. */
  async listBotChannels(): Promise<PlatformChannelRef[] | null> {
    try {
      const channels = await this.client.getMyChannels(false)
      const at = this.now()
      const out: PlatformChannelRef[] = []
      const activeChannels: MattermostChannel[] = []
      const knownTeamIds = new Set(this.teams.map((t) => t.id))
      let needsTeamRefresh = false
      for (const ch of channels) {
        if (ch.delete_at && ch.delete_at > 0) continue
        setBounded(this.channels, ch.id, { value: ch, at }, CHANNEL_CACHE_MAX)
        if (ch.type !== 'O' && ch.type !== 'P') continue
        activeChannels.push(ch)
        if (ch.team_id && !knownTeamIds.has(ch.team_id)) needsTeamRefresh = true
      }
      if (needsTeamRefresh || (activeChannels.some((c) => Boolean(c.team_id)) && this.teams.length === 0)) {
        this.teams = (await this.client.getMyTeams().catch(() => this.teams)).filter((t) => !t.delete_at)
      }
      const teamById = new Map(this.teams.map((t) => [t.id, t]))
      for (const ch of activeChannels) {
        const team = ch.team_id ? teamById.get(ch.team_id) : undefined
        const space = team?.display_name?.trim() || team?.name?.trim() || undefined
        const rawUrl =
          team?.name && ch.name
            ? `${this.workspaceUrl}/${encodeURIComponent(team.name)}/channels/${encodeURIComponent(ch.name)}`
            : undefined
        out.push({
          id: ch.id,
          ...(ch.display_name?.trim() || ch.name?.trim() ? { name: ch.display_name?.trim() || ch.name?.trim() } : {}),
          ...(ch.team_id ? { spaceId: ch.team_id } : {}),
          ...(space ? { space } : {}),
          ...conversationLink(undefined, rawUrl),
          isPrivate: ch.type === 'P',
          joined: true,
          externalReason: ch.shared === true ? 'externallyShared' : null
        })
      }
      return out
    } catch (error) {
      this.deps.log.debug(
        `mattermost: listBotChannels failed (${error instanceof Error ? error.message : 'unknown error'})`
      )
      return null
    }
  }

  async listChannels(): Promise<PlatformChannelRef[]> {
    const channels = await this.listBotChannels()
    if (!channels) throw new Error('mattermost: failed to list bot channels')
    return channels
  }

  async resolveChannelName(channel: string): Promise<string | undefined> {
    const needle = channel.replace(/^#/, '').trim().toLowerCase()
    if (!needle) return undefined
    const channels = await this.listBotChannels()
    if (!channels) return undefined
    const matches: string[] = []
    for (const ref of channels) {
      const cached = this.channels.get(ref.id)?.value
      const names = [ref.name, cached?.name, cached?.display_name]
        .filter((n): n is string => Boolean(n))
        .map((n) => n.trim().toLowerCase())
      if (names.includes(needle)) matches.push(ref.id)
    }
    return matches.length === 1 ? matches[0] : undefined
  }

  async getUserProfile(user: string): Promise<PlatformUserProfile> {
    const u = await this.getUserCached(user)
    if (!u) return { id: user }
    const realName = userDisplayRealName(u)
    const timeZone = userTimeZone(u)
    return {
      id: u.id,
      name: u.username,
      ...(realName ? { realName } : {}),
      isBot: u.is_bot === true,
      ...(timeZone ? { timeZone } : {})
    }
  }

  async isFullMember(user: string): Promise<boolean> {
    try {
      const u = await this.getUserCached(user)
      if (!u) return false
      if (u.delete_at && u.delete_at > 0) return false
      if (u.remote_id) return false
      const roles = (u.roles ?? '').split(/\s+/).filter(Boolean)
      return !roles.includes('system_guest')
    } catch {
      return false
    }
  }

  private async resolveBoundTimeMs(
    bound: string | undefined,
    posts: Record<string, MattermostPost>
  ): Promise<number | undefined> {
    if (!bound) return undefined
    if (isPostId(bound)) {
      const inMap = posts[bound]?.create_at
      if (typeof inMap === 'number') return inMap
      const post = await this.client.getPost(bound).catch(() => undefined)
      return typeof post?.create_at === 'number' ? post.create_at : undefined
    }
    const num = Number(bound)
    if (!Number.isFinite(num) || num <= 0) return undefined
    return num >= 1e12 ? num : Math.round(num * 1000)
  }

  async getThreadReplies(
    channel: string,
    thread: string,
    maxMessages = 200,
    window?: PlatformThreadWindow
  ): Promise<PlatformThreadMessage[]> {
    try {
      if (!isPostId(thread)) {
        throw new Error(`mattermost: "${thread}" is not a valid post id`)
      }
      const list = await this.client.getPostThread(thread, { perPage: Math.min(Math.max(maxMessages, 1), 200) })
      const postsMap = list.posts ?? {}
      const rawPosts = Object.values(postsMap)
        .filter((post) => {
          if (!post?.id || (typeof post.delete_at === 'number' && post.delete_at > 0)) return false
          if (typeof post.type === 'string' && post.type.startsWith('system_')) return false
          if (post.channel_id && post.channel_id !== channel) return false
          return true
        })
        .sort((a, b) => {
          const aRoot = !a.root_id || a.id === thread ? 0 : 1
          const bRoot = !b.root_id || b.id === thread ? 0 : 1
          if (aRoot !== bRoot) return aRoot - bRoot
          const diff = (a.create_at ?? 0) - (b.create_at ?? 0)
          if (diff !== 0) return diff
          return (a.id ?? '').localeCompare(b.id ?? '')
        })

      const oldestMs = await this.resolveBoundTimeMs(window?.oldest, postsMap)
      const latestMs = await this.resolveBoundTimeMs(window?.latest, postsMap)
      const bounded = rawPosts.filter((post) => {
        const at = post.create_at ?? 0
        if (oldestMs !== undefined && at <= oldestMs) return false
        if (latestMs !== undefined && at >= latestMs) return false
        return true
      })

      if (window?.readState && (bounded.length > maxMessages || Boolean(list.prev_post_id))) {
        window.readState.truncated = true
      }
      const sliced = bounded.slice(0, Math.max(1, maxMessages))
      const users = await this.getUsersByIdsCached(
        sliced.map((post) => post.user_id).filter((id): id is string => Boolean(id))
      )

      return sliced.map((post) => {
        const userId = post.user_id ?? 'unknown'
        const user = users.get(userId)
        const claim = readMattermostAgentAuthorshipClaim(post)
        const isBot = post.props?.from_bot === 'true' || post.props?.from_bot === true || user?.is_bot === true
        const attachments: Attachment[] = (post.metadata?.files ?? [])
          .map((file) => toMattermostAttachment(file, this.workspaceUrl))
          .filter((a): a is NonNullable<typeof a> => a !== null)
          .map((a) => ({ ...a, readerToolName: MATTERMOST_ATTACHMENT_TOOL.name }))
        const link = mattermostThreadUrl(this.workspaceUrl, channel, post.id!)
        return {
          sender: userId,
          ...(user?.username ? { senderName: user.username } : {}),
          ts: post.id!,
          text: extractMattermostPostText(post),
          isBot,
          chrome: post.props?.agentconnect_chrome === true,
          ...(claim?.authorAgentId ? { agentAuthorId: claim.authorAgentId } : {}),
          attachments,
          ...(link ? { link } : {})
        }
      })
    } catch (error) {
      this.deps.log.debug(
        `mattermost: getThreadReplies failed (ch=${channel} thread=${thread}): ${error instanceof Error ? error.message : 'unknown error'}`
      )
      if (window?.throwOnError) throw error
      return []
    }
  }

  async getChannelHistory(
    channel: string,
    options: PlatformChannelHistoryOptions = {}
  ): Promise<PlatformChannelHistoryPage> {
    const page = options.cursor ? Math.max(0, Number.parseInt(options.cursor, 10) || 0) : 0
    const perPage = Math.min(Math.max(Math.trunc(options.limit ?? DEFAULT_HISTORY_LIMIT), 1), MAX_HISTORY_LIMIT)
    const list = await this.client.getChannelPosts(channel, { page, perPage })
    const postsMap = list.posts ?? {}
    const orderedIds = Array.isArray(list.order) ? list.order : Object.keys(postsMap)
    const oldestMs = await this.resolveBoundTimeMs(options.oldest, postsMap)
    const latestMs = await this.resolveBoundTimeMs(options.latest, postsMap)

    const validPosts = orderedIds
      .map((id) => postsMap[id])
      .filter((post): post is MattermostPost & { id: string } => {
        if (!post?.id) return false
        if (typeof post.delete_at === 'number' && post.delete_at > 0) return false
        if (typeof post.type === 'string' && post.type.startsWith('system_')) return false
        const at = post.create_at ?? 0
        if (oldestMs !== undefined && at < oldestMs) return false
        if (latestMs !== undefined && at > latestMs) return false
        return true
      })

    const users = await this.getUsersByIdsCached(
      validPosts.map((post) => post.user_id).filter((id): id is string => Boolean(id))
    )

    const messages: PlatformChannelHistoryMessage[] = validPosts.map((post) => {
      const userId = post.user_id ?? 'unknown'
      const user = users.get(userId)
      const isBot = post.props?.from_bot === 'true' || post.props?.from_bot === true || user?.is_bot === true
      const threadTs = post.root_id || post.id
      const link = mattermostThreadUrl(this.workspaceUrl, channel, post.id)
      return {
        sender: userId,
        ...(user?.username ? { senderName: user.username } : {}),
        ts: post.id,
        text: extractMattermostPostText(post),
        isBot,
        threadTs,
        ...(link ? { link } : {})
      }
    })

    const hasMore = Boolean(list.prev_post_id) || orderedIds.length >= perPage
    return {
      messages,
      hasMore,
      ...(hasMore ? { nextCursor: String(page + 1) } : {})
    }
  }

  /** Search Mattermost public channels (`type === 'O'`) across the bot's teams; private channels, DMs, GMs, and deleted channels/posts are excluded fail-closed. */
  async searchPublicMessages(
    query: string,
    options: PlatformSearchOptions = {},
    _originMsgId?: string
  ): Promise<PlatformSearchResults> {
    const terms = query.trim()
    if (!terms) return { messages: [] }

    const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 20), 50))
    const offset = options.cursor ? Math.max(0, Number.parseInt(options.cursor, 10) || 0) : 0

    let teams = this.teams
    if (teams.length === 0) {
      teams = (await this.client.getMyTeams()).filter((t) => !t.delete_at)
      this.teams = teams
    }
    if (teams.length === 0) return { messages: [] }

    let orderedTeams = teams
    if (options.channel) {
      const targetChannel = await this.getChannelCached(options.channel).catch(() => undefined)
      if (targetChannel?.team_id) {
        const preferred = teams.find((t) => t.id === targetChannel.team_id)
        if (preferred) {
          orderedTeams = [preferred, ...teams.filter((t) => t.id !== preferred.id)]
        }
      }
    }

    const byId = new Map<string, MattermostPost & { id: string }>()
    for (const team of orderedTeams) {
      const list = await this.client.searchTeamPosts(team.id, {
        terms,
        include_deleted_channels: false,
        per_page: 60
      })
      const postsMap = list.posts ?? {}
      const ids = Array.isArray(list.order) ? list.order : Object.keys(postsMap)
      for (const id of ids) {
        const post = postsMap[id]
        if (!post?.id || !post.channel_id) continue
        if (post.delete_at && post.delete_at > 0) continue
        if (typeof post.type === 'string' && post.type.startsWith('system_')) continue
        byId.set(post.id, post as MattermostPost & { id: string })
      }
    }

    const afterMs = options.after !== undefined ? options.after * 1_000 : undefined
    const beforeMs = options.before !== undefined ? options.before * 1_000 : undefined

    const channelIds = [...new Set([...byId.values()].map((p) => p.channel_id!))]
    const publicChannels = new Map<string, MattermostChannel>()
    const lookupConcurrency = 4
    let chCursor = 0
    await Promise.all(
      Array.from({ length: Math.min(lookupConcurrency, channelIds.length) }, async () => {
        while (chCursor < channelIds.length) {
          const chId = channelIds[chCursor++]!
          const ch = await this.getChannelCached(chId).catch(() => undefined)
          if (ch && ch.type === 'O' && !(ch.delete_at && ch.delete_at > 0)) {
            publicChannels.set(chId, ch)
          }
        }
      })
    )

    const userIds = [
      ...new Set(
        [...byId.values()]
          .filter((p) => publicChannels.has(p.channel_id!))
          .map((p) => p.user_id)
          .filter((id): id is string => Boolean(id))
      )
    ]
    const users = await this.getUsersByIdsCached(userIds)

    const filtered = [...byId.values()]
      .filter((post) => {
        const ch = publicChannels.get(post.channel_id!)
        if (!ch) return false
        const createdAt = post.create_at ?? 0
        if (afterMs !== undefined && createdAt < afterMs) return false
        if (beforeMs !== undefined && createdAt > beforeMs) return false
        const user = post.user_id ? users.get(post.user_id) : undefined
        const isBot = post.props?.from_bot === 'true' || post.props?.from_bot === true || user?.is_bot === true
        if (options.includeBots === false && isBot) return false
        return true
      })
      .sort((a, b) => (b.create_at ?? 0) - (a.create_at ?? 0) || b.id.localeCompare(a.id))

    const sliced = filtered.slice(offset, offset + limit)
    const nextCursor = offset + limit < filtered.length ? String(offset + limit) : undefined

    const messages: PlatformSearchHit[] = sliced.map((post) => {
      const ch = publicChannels.get(post.channel_id!)!
      const user = post.user_id ? users.get(post.user_id) : undefined
      const channelName = ch.display_name?.trim() || ch.name?.trim() || undefined
      const author = user ? (userDisplayRealName(user) ?? user.username) : undefined
      const isBot = post.props?.from_bot === 'true' || post.props?.from_bot === true || user?.is_bot === true
      const permalink = mattermostThreadUrl(this.workspaceUrl, ch.id, post.id)
      return {
        channel: ch.id,
        ...(channelName ? { channelName } : {}),
        messageTs: post.id,
        threadTs: post.root_id || post.id,
        text: extractMattermostPostText(post),
        ...(author ? { author } : {}),
        ...(post.user_id ? { authorId: post.user_id } : {}),
        isBot,
        ...(permalink ? { permalink } : {})
      }
    })

    return {
      messages,
      ...(nextCursor ? { nextCursor } : {})
    }
  }

  private async resolveUserId(userOrName: string): Promise<string> {
    const trimmed = userOrName.trim()
    if (!trimmed) throw new Error('mattermost: user identifier must not be empty')
    if (trimmed.startsWith('@')) {
      const username = trimmed.slice(1)
      const users = await this.client.getUsersByUsernames([username])
      const found = users.find((u) => u.username.toLowerCase() === username.toLowerCase())
      if (!found) throw new Error(`mattermost: user @${username} not found`)
      setBounded(this.users, found.id, { value: found, at: this.now() }, USER_CACHE_MAX)
      return found.id
    }
    return trimmed
  }

  async openDirectMessage(user: string): Promise<string> {
    if (!this._botUserId) throw new Error('mattermost: bot user id is not initialized')
    const targetId = await this.resolveUserId(user)
    const ch = await this.client.createDirectChannel([this._botUserId, targetId])
    setBounded(this.channels, ch.id, { value: ch, at: this.now() }, CHANNEL_CACHE_MAX)
    return ch.id
  }

  async createConversation(spec: PlatformConversationSpec & { teamId?: string }): Promise<PlatformChannelInfo> {
    const users = spec.users ?? []
    if (!spec.name) {
      if (users.length === 0) throw new Error('mattermost: createConversation requires `name` or `users`')
      const resolvedIds = await Promise.all(users.map((u) => this.resolveUserId(u)))
      if (resolvedIds.length === 1) {
        const ch = await this.client.createDirectChannel([this._botUserId, resolvedIds[0]!])
        setBounded(this.channels, ch.id, { value: ch, at: this.now() }, CHANNEL_CACHE_MAX)
        return { id: ch.id, isIm: true, isPrivate: true, user: resolvedIds[0] }
      }
      const ch = await this.client.createGroupChannel([...new Set([this._botUserId, ...resolvedIds])])
      setBounded(this.channels, ch.id, { value: ch, at: this.now() }, CHANNEL_CACHE_MAX)
      return { id: ch.id, isMpim: true, isPrivate: true }
    }

    let teamId = spec.teamId?.trim()
    if (!teamId) {
      if (this.teams.length === 0) {
        this.teams = (await this.client.getMyTeams()).filter((t) => !t.delete_at)
      }
      teamId = this.teams[0]?.id
    }
    if (!teamId) {
      for (const cached of this.channels.values()) {
        if (cached.value.team_id) {
          teamId = cached.value.team_id
          break
        }
      }
    }
    if (!teamId) {
      throw new Error('mattermost: cannot create a channel because the bot belongs to no team')
    }

    const ch = await this.client.createChannel({
      team_id: teamId,
      name: channelSlug(spec.name),
      display_name: spec.name,
      type: spec.isPrivate ? 'P' : 'O'
    })
    setBounded(this.channels, ch.id, { value: ch, at: this.now() }, CHANNEL_CACHE_MAX)

    for (const rawUser of users) {
      try {
        const userId = await this.resolveUserId(rawUser)
        await this.client.addChannelMember(ch.id, userId)
      } catch (error) {
        this.deps.log.debug(
          `mattermost: addChannelMember failed (ch=${ch.id}): ${error instanceof Error ? error.message : 'unknown error'}`
        )
      }
    }

    return {
      id: ch.id,
      name: ch.display_name?.trim() || ch.name?.trim() || spec.name,
      isPrivate: ch.type === 'P'
    }
  }

  private reactionTargetPostId(raw: string): string {
    const postId = normalizeReactionPostId(raw)
    if (!postId) throw new Error('mattermost: post id must not be empty')
    if (postId === this._botUserId || this.users.has(postId)) {
      throw new Error(
        `mattermost: "${postId}" is a user ID (from [sender]), not a post ID; pass the message's post ID (use Thread for the thread root, or call getThreadReplies / getChannelHistory).`
      )
    }
    return postId
  }

  async addReaction(channel: string, messageTs: string, emoji: string): Promise<void> {
    if (!this._botUserId) throw new Error('mattermost: bot user id is not initialized')
    const clean = emoji.replace(/^:|:$/g, '').trim()
    if (!clean) throw new Error('mattermost: reaction emoji must not be empty')
    const postId = this.reactionTargetPostId(messageTs)
    try {
      await this.sendQueue.enqueue(channel, () =>
        this.client.addReaction({ user_id: this._botUserId, post_id: postId, emoji_name: clean })
      )
    } catch (error) {
      // Mattermost checks post channel permissions before existence, turning an unknown post_id into 403.
      if (error instanceof MattermostApiError && error.status === 403) {
        const probe = await this.client.getPost(postId).catch((e: unknown) => e)
        if (probe instanceof MattermostApiError && probe.isNotFound) {
          throw new Error(
            `mattermost: post "${postId}" was not found (verify messageTs via Thread or getThreadReplies / getChannelHistory; do not pass a user ID).`
          )
        }
      }
      throw error
    }
  }

  async getReactions(_channel: string, messageTs: string): Promise<PlatformReactionSummary[]> {
    const postId = this.reactionTargetPostId(messageTs)
    const reactions = await this.client.getReactions(postId)
    const grouped = new Map<string, string[]>()
    for (const r of reactions) {
      if (!r.emoji_name) continue
      const list = grouped.get(r.emoji_name) ?? []
      if (r.user_id) list.push(r.user_id)
      grouped.set(r.emoji_name, list)
    }
    return [...grouped.entries()].map(([name, users]) => ({
      name,
      count: users.length,
      users
    }))
  }

  async react(container: string, messageId: string, intent: PlatformReactionIntent): Promise<void> {
    try {
      await this.addReaction(container, messageId, MATTERMOST_REACTION_INTENT[intent])
    } catch (error) {
      this.deps.log.debug(
        `mattermost: react failed (ch=${container} post=${messageId}): ${error instanceof Error ? error.message : 'unknown error'}`
      )
    }
  }

  async unreact(container: string, messageId: string, intent: PlatformReactionIntent): Promise<void> {
    if (!this._botUserId) return
    const postId = normalizeReactionPostId(messageId)
    if (!isPostId(postId)) return
    try {
      await this.sendQueue.enqueue(container, () =>
        this.client.removeReaction(this._botUserId, postId, MATTERMOST_REACTION_INTENT[intent])
      )
    } catch (error) {
      this.deps.log.debug(
        `mattermost: unreact failed (ch=${container} post=${postId}): ${error instanceof Error ? error.message : 'unknown error'}`
      )
    }
  }

  // ── Media upload & download ──

  async uploadFile(
    channel: string,
    file: { bytes: Buffer; name: string; mimeType: string },
    comment?: string,
    anchor?: UploadAnchor,
    identity?: SendIdentity
  ): Promise<UploadOutcome> {
    return this.uploadFiles(channel, [file], comment, anchor, identity)
  }

  async uploadFiles(
    channel: string,
    files: MessageFile[],
    comment?: string,
    anchor?: UploadAnchor,
    identity?: SendIdentity
  ): Promise<UploadOutcome> {
    if (files.length === 0) return { ok: false, reason: 'platform_error', detail: 'no files to upload' }
    if (files.length > MATTERMOST_UPLOAD_MAX_FILES) {
      return {
        ok: false,
        reason: 'platform_error',
        detail: `Mattermost accepts at most ${MATTERMOST_UPLOAD_MAX_FILES} files per post`
      }
    }

    const rootId = isPostId(anchor?.thread) ? anchor?.thread : undefined
    const props = buildPostProps(identity)
    const captionChunks = comment?.trim() ? splitMattermostPost(comment.trim(), this._maxPostSize) : []
    const firstCaption = captionChunks[0]
    const overflowCaptions = captionChunks.slice(1)

    const outcome = await this.sendQueue
      .enqueue(channel, () =>
        uploadMattermostMedia(this.client, channel, files, {
          ...(firstCaption !== undefined ? { caption: firstCaption } : {}),
          ...(rootId ? { rootId } : {}),
          ...(props ? { props } : {}),
          ...(overflowCaptions.length ? { overflowCaptions } : {}),
          onWarning: (msg) => this.deps.log.warn(`mattermost: caption overflow failed (${msg})`)
        })
      )
      .catch((error): UploadOutcome => ({
        ok: false,
        reason:
          typeof error === 'object' &&
          error !== null &&
          (error as { sendQueueTimeout?: unknown }).sendQueueTimeout === true
            ? 'indeterminate'
            : 'platform_error'
      }))

    if (outcome.ok && outcome.messageId) {
      setBounded(this.postChannels, outcome.messageId, channel, POST_CHANNEL_CACHE_MAX)
    }
    return outcome
  }

  async downloadFile(ref: string, maxBytes = DEFAULT_MAX_ATTACHMENT_BYTES): Promise<Buffer | null> {
    const downloaded = await this.client.downloadFile(ref, maxBytes)
    return downloaded ? downloaded.bytes : null
  }

  async getFileInfo(fileId: string): Promise<PlatformFileInfo | undefined> {
    if (!MATTERMOST_SAFE_ID_RE.test(fileId)) return undefined
    let info: MattermostFileInfo
    try {
      info = await this.client.getFileInfo(fileId)
    } catch (error) {
      if (error instanceof MattermostApiError && error.isNotFound) return undefined
      throw error
    }
    const id = info.id ?? fileId
    if (!MATTERMOST_SAFE_ID_RE.test(id) || (typeof info.delete_at === 'number' && info.delete_at > 0)) {
      return undefined
    }
    let channelId = info.channel_id
    if (!channelId && info.post_id) {
      const post = await this.client.getPost(info.post_id).catch(() => undefined)
      channelId = post?.channel_id
    }
    const mapped = toMattermostAttachment({ ...info, id }, this.workspaceUrl)
    return {
      name: mapped?.name ?? info.name ?? id,
      mimeType: mapped?.mimeType ?? info.mime_type ?? 'application/octet-stream',
      sourceUrl: mapped?.sourceUrl ?? `${this.workspaceUrl}/api/v4/files/${id}`,
      ...(typeof info.size === 'number' ? { size: info.size } : {}),
      channels: channelId ? [channelId] : []
    }
  }
}
