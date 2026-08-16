/**
 * `SlackHttpIngest` (shared-bot-relay.md §12) — per-HTTP-bot inbound handler,
 * held by the relay. Inbound no longer rides a Socket Mode websocket: the relay
 * exposes ONE shared HTTP Events API surface (`/slack/events` + `/slack/interactions`,
 * see `http-ingress.ts`) behind the pool's stable public URL, and after the
 * POST is demuxed to a bot + its signing secret verified, the route calls
 * {@link SlackHttpIngest.handleEvent} / {@link SlackHttpIngest.handleInteraction}.
 * There is no MANUAL-ack seam anymore: Slack's HTTP 200 IS the ack. We answer 200
 * immediately (Slack's 3s window) and forward asynchronously — a forward miss is
 * still counted as bounded loss by the forwarder, honestly declared.
 *
 * The bot's Slack user id + bot id are resolved here via `auth.test` on `start()`.
 * The user id drives mention matching; both identities suppress exact self echoes.
 * The `WebClient` also opens the config modal (`views.open`).
 *
 * Secret material (`botToken`/`signingSecret`) MUST NEVER be logged.
 */
import { WebClient, type FetchFunction, type WebClientOptions } from '@slack/web-api'
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici'
import {
  isSlackSystemMessage,
  normalizeSlackMessage,
  normalizeSlackResponseFinalization,
  type SlackMessageLike
} from '@agentconnect.md/message'
import {
  ELICIT_ACTION_PREFIX,
  ELICIT_DISMISS_ACTION,
  PERMISSION_ACTION_PREFIX,
  SHARED_AGENT_SELECT_ACTION_ID,
  SHARED_CONFIG_ACTION_ID,
  SLACK_MANAGE_SESSION_SHORTCUT_CALLBACK_ID,
  SLACK_STATUS_ACTION,
  decodePermValue,
  decodeSlackStatusOverflowValue,
  decodeSharedSlackStatusTarget,
  type RdSlackAction,
  type SharedSlackStatusTarget,
  type WireNormalizedMessage
} from '@agentconnect.md/protocol'
import type { Logger } from '../../log.js'

export { normalizeSlackMessage } from '@agentconnect.md/message'
export type SlackMessageEvent = SlackMessageLike

/** block_id / action_id of the modal's agent selector (local to this file). */
const CONFIG_BLOCK = 'agent_block'
const CONFIG_ACTION = 'agent_select'

/** The subset of a Slack interactive (block_actions / view_submission) payload we read.
 *  `api_app_id` / `team` are demux hints the HTTP route reads BEFORE dispatch. */
export interface SlackInteractiveBody {
  type: string
  api_app_id?: string
  team?: { id?: string }
  user?: { id?: string }
  trigger_id?: string
  callback_id?: string
  action_id?: string
  block_id?: string
  value?: string
  channel?: { id?: string }
  container?: { channel_id?: string; message_ts?: string }
  message?: { ts?: string; thread_ts?: string }
  actions?: {
    action_id?: string
    action_ts?: string
    block_id?: string
    value?: string
    selected_option?: { value?: string }
  }[]
  view?: {
    callback_id?: string
    private_metadata?: string
    state?: { values?: Record<string, Record<string, { selected_option?: { value?: string } }>> }
  }
}

interface HttpSlackInteractionReceipt {
  /** Stable across Slack redelivery of the same interaction. The manager hashes this
   *  with the target + operation before placing it on rd/msg, so trigger ids never
   *  appear in logs while daemon-side (sessionKey,msgId) dedup remains effective. */
  interactionId: string
}

export type HttpSlackSessionAction = HttpSlackInteractionReceipt & {
  target: SharedSlackStatusTarget
  /** Who tapped it (Slack `body.user`), forwarded so the daemon can attribute the
   *  session change. Absent when the payload names no user. */
  userId?: string
} & Exclude<RdSlackAction, { kind: 'open-config-for-thread' }>

export interface HttpSlackSessionShortcut extends HttpSlackInteractionReceipt {
  channelId: string
  threadTs: string
  triggerId: string
  userId?: string
}

type HttpSlackAgent = { agentId: string; name: string }

function httpSlackAgentOption(agent: HttpSlackAgent) {
  const label = agent.name.trim() || agent.agentId
  return {
    text: { type: 'plain_text' as const, text: label.length > 75 ? `${label.slice(0, 74)}…` : label },
    value: agent.agentId
  }
}

/** Build one external-select response from the relay's current HTTP-bot member
 *  directory. Slack caps a suggestion response at 100 options. Matching both name
 *  and id keeps a pasted agent id useful without changing the visible label. */
export function httpSlackAgentOptions(agents: HttpSlackAgent[], query = '') {
  const needle = query.trim().toLocaleLowerCase()
  return agents
    .filter((agent) => !needle || agent.name.toLocaleLowerCase().includes(needle) || agent.agentId.includes(needle))
    .slice(0, 100)
    .map(httpSlackAgentOption)
}

/** Decode and locally validate the relay-managed status bar's agent selection. The CP
 *  validates membership again when it persists the channel owner; this edge check
 *  avoids forwarding stale/tampered option values in the common case. */
export function parseHttpSlackAgentSelection(
  body: SlackInteractiveBody,
  agents: HttpSlackAgent[]
): { channelId: string; threadTs?: string; agentId: string } | null {
  if (body.type !== 'block_actions') return null
  const action = body.actions?.find((candidate) => candidate.action_id === SHARED_AGENT_SELECT_ACTION_ID)
  const channelId = body.channel?.id ?? body.container?.channel_id
  const agentId = action?.selected_option?.value
  if (!channelId || !agentId || !agents.some((agent) => agent.agentId === agentId)) return null
  const threadTs = body.message?.thread_ts
  return { channelId, ...(threadTs ? { threadTs } : {}), agentId }
}

/** Decode the relay-managed status overflow's Switch agent choice. Slack has no nested
 *  overflow menus, so this choice opens the relay-owned picker modal instead. */
export function parseHttpSlackAgentSwitch(
  body: SlackInteractiveBody
): { channelId: string; threadTs?: string; currentAgentId: string } | null {
  if (body.type !== 'block_actions') return null
  const action = body.actions?.find((candidate) => candidate.action_id === SLACK_STATUS_ACTION.more)
  const choice = action?.selected_option?.value ? decodeSlackStatusOverflowValue(action.selected_option.value) : null
  if (choice?.action !== 'switch-agent') return null
  const rawTarget = action?.block_id ?? choice.target
  const target = rawTarget ? decodeSharedSlackStatusTarget(rawTarget) : null
  const channelId = body.channel?.id ?? body.container?.channel_id
  if (!target || !channelId) return null
  const threadTs = body.message?.thread_ts ?? body.message?.ts
  return { channelId, ...(threadTs ? { threadTs } : {}), currentAgentId: target.agentId }
}

type HttpSlackAgentModalContext = { channelId: string; threadTs?: string }

function encodeAgentModalContext(context: HttpSlackAgentModalContext): string {
  return context.threadTs ? JSON.stringify({ v: 1, ...context }) : context.channelId
}

function decodeAgentModalContext(value: string): HttpSlackAgentModalContext | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as { v?: unknown; channelId?: unknown; threadTs?: unknown }
    if (parsed.v !== 1 || typeof parsed.channelId !== 'string') return null
    if (parsed.threadTs !== undefined && typeof parsed.threadTs !== 'string') return null
    return { channelId: parsed.channelId, ...(parsed.threadTs ? { threadTs: parsed.threadTs } : {}) }
  } catch {
    // Older channel-default modals store the channel id directly.
    return { channelId: value }
  }
}

/** Decode one daemon-owned session control from an HTTP app's Slack interaction.
 *  The target is opaque user-interface state at this edge; RelayIngressManager validates
 *  its agent against the current bot assignment before choosing a daemon/integration. */
export function parseHttpSlackSessionAction(body: SlackInteractiveBody): HttpSlackSessionAction | null {
  const parsed = decodeHttpSlackSessionAction(body)
  if (!parsed) return null
  // Attach the actor at the single exit so every decoded verb carries it.
  return body.user?.id ? { ...parsed, userId: body.user.id } : parsed
}

function decodeHttpSlackSessionAction(body: SlackInteractiveBody): HttpSlackSessionAction | null {
  if (body.type !== 'block_actions') return null
  const action = body.actions?.[0]
  if (!action?.action_id) return null
  const receipt = action.action_ts || body.trigger_id
  if (!receipt) return null
  const target = action.block_id ? decodeSharedSlackStatusTarget(action.block_id) : null
  if (target && action.action_id.startsWith(`${PERMISSION_ACTION_PREFIX}:`)) {
    const choice = action.value ? decodePermValue(action.value) : null
    return choice
      ? {
          target,
          interactionId: JSON.stringify([action.action_id, receipt]),
          kind: 'permission-choice',
          ...choice
        }
      : null
  }
  if (target && action.action_id.startsWith(`${ELICIT_ACTION_PREFIX}:`)) {
    const choice = action.value ? decodePermValue(action.value) : null
    return choice
      ? {
          target,
          interactionId: JSON.stringify([action.action_id, receipt]),
          kind: 'elicitation-choice',
          requestId: choice.requestId,
          value: choice.optionId
        }
      : null
  }
  if (target && action.action_id === ELICIT_DISMISS_ACTION && action.value) {
    return {
      target,
      interactionId: JSON.stringify([action.action_id, receipt]),
      kind: 'elicitation-choice',
      requestId: action.value,
      value: null
    }
  }
  const overflow =
    action.action_id === SLACK_STATUS_ACTION.more && action.selected_option?.value
      ? decodeSlackStatusOverflowValue(action.selected_option.value)
      : null
  if (action.action_id === SLACK_STATUS_ACTION.more && (!overflow || overflow.action === 'switch-agent')) return null
  const effectiveActionId =
    overflow?.action === 'manage'
      ? SLACK_STATUS_ACTION.manage
      : overflow?.action === 'cancel'
        ? SLACK_STATUS_ACTION.cancel
        : action.action_id
  const rawTarget =
    (overflow ? (action.block_id ?? overflow.target) : undefined) ??
    (effectiveActionId === SLACK_STATUS_ACTION.manage ? action.value : (body.view?.private_metadata ?? action.value))
  if (!rawTarget) return null
  const statusTarget = decodeSharedSlackStatusTarget(rawTarget)
  if (!statusTarget) return null
  // Slack supplies action_ts on Block Kit actions. Keep trigger_id as a defensive
  // fallback for SDK/test payloads that omit it; both values are stable when Slack
  // redelivers the same HTTP interaction.
  const interactionId = JSON.stringify([effectiveActionId, receipt])

  const selected = action.selected_option?.value
  switch (effectiveActionId) {
    case SLACK_STATUS_ACTION.manage:
      return body.trigger_id
        ? { target: statusTarget, interactionId, kind: 'open-config', triggerId: body.trigger_id }
        : null
    case SLACK_STATUS_ACTION.setModel:
      return selected ? { target: statusTarget, interactionId, kind: 'set-model', model: selected } : null
    case SLACK_STATUS_ACTION.setEffort:
      return selected ? { target: statusTarget, interactionId, kind: 'set-effort', effort: selected } : null
    case SLACK_STATUS_ACTION.setPermissionMode:
      return selected
        ? { target: statusTarget, interactionId, kind: 'set-permission-mode', permissionMode: selected }
        : null
    case SLACK_STATUS_ACTION.setFast:
      return selected === 'on' || selected === 'off'
        ? { target: statusTarget, interactionId, kind: 'set-fast', fastMode: selected === 'on' }
        : null
    case SLACK_STATUS_ACTION.setOutput:
      return selected === 'none' ||
        selected === 'minimal' ||
        selected === 'low' ||
        selected === 'medium' ||
        selected === 'high'
        ? { target: statusTarget, interactionId, kind: 'set-output', outputMode: selected }
        : null
    case SLACK_STATUS_ACTION.cancel:
      return { target: statusTarget, interactionId, kind: 'cancel' }
    default:
      return null
  }
}

/** Proxy dispatcher from HTTPS_PROXY/HTTP_PROXY (as the daemon's SlackConnection
 *  does), or undefined for a direct connection. */
function proxyDispatcher(): ProxyAgent | undefined {
  const url = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY
  return url ? new ProxyAgent(url) : undefined
}

function fetchWithDispatcher(dispatcher: Dispatcher): FetchFunction {
  return (url, init) => undiciFetch(url, { ...(init as Parameters<typeof undiciFetch>[1]), dispatcher })
}

/**
 * Slack error codes that mean THIS TOKEN IS DEAD, as opposed to a transient
 * failure. Deliberately narrow: a false positive would revoke a live bot, so
 * network errors, rate limits, and `missing_scope` must NOT match.
 *
 * `account_inactive` is what a workspace uninstall leaves behind;
 * `token_revoked` / `invalid_auth` cover an explicitly killed token.
 */
const DEAD_CREDENTIAL_ERRORS = new Set(['account_inactive', 'token_revoked', 'invalid_auth'])

function isDeadCredentialError(err: unknown): boolean {
  // @slack/web-api puts the API's `error` string on `err.data.error`.
  const code = (err as { data?: { error?: unknown } })?.data?.error
  return typeof code === 'string' && DEAD_CREDENTIAL_ERRORS.has(code)
}

/** Top-level chat subtypes. Structural/system records stay out of routing. */
function isRoutableSubtype(subtype: string | undefined): boolean {
  return (
    subtype === undefined ||
    subtype === 'file_share' ||
    subtype === 'me_message' ||
    subtype === 'thread_broadcast' ||
    subtype === 'reply_broadcast'
  )
}

function isRoutableEvent(event: SlackMessageEvent): boolean {
  return (
    Boolean(event.user || event.bot_id) &&
    !event.hidden &&
    event.message === undefined &&
    (isRoutableSubtype(event.subtype) || event.subtype === 'bot_message')
  )
}

export interface SlackHttpIngestDeps {
  /** Hand a normalized message to the router/forwarder; resolves once the delivery
   *  outcome is known (delivered or dropped). NEVER throws — runs after the HTTP 200. */
  onMessage: (msg: WireNormalizedMessage) => Promise<void>
  /** Report the resolved bot user id (from auth.test) for arbitration. */
  onBotUserId: (botUserId: string) => void
  /** Report the bot's complete Slack channel-membership snapshot after an event
   *  says the bot itself joined or left a channel. */
  onChannelsChanged: (channels: { id: string; name?: string; isPrivate?: boolean }[]) => void
  /** Candidate agents for the config modal's "default agent" selector (bot members). */
  agents: () => { agentId: string; name: string }[]
  /** This channel's current default agent (initial modal selection), if any. */
  currentOwner: (channelId: string) => string | undefined
  /** Persist the operator's pick (→ CP `rc/set-channel-agent`). */
  onSetChannelAgent: (channelId: string, agentId: string) => void
  /** Rebind this Slack thread immediately, then persist the same agent as the
   *  channel default. The thread timestamp comes from the source status message. */
  onSelectThreadAgent: (channelId: string, threadTs: string, agentId: string) => void
  /** Forward the current agent/session controls to its owning daemon. */
  onSessionAction: (action: HttpSlackSessionAction) => void
  /** Resolve and forward the app-level message shortcut. False opens a local
   *  unavailable modal while the one-shot trigger id is still valid. */
  onSessionShortcut: (shortcut: HttpSlackSessionShortcut) => boolean
  /** The workspace uninstalled the app / revoked its tokens — the bot's credential
   *  is dead; report upstream so the CP marks it revoked. */
  /** `eventAtMs` = Slack's envelope `event_time` (when the uninstall HAPPENED),
   *  forwarded so the CP can reject an event that predates the credential it
   *  would revoke. Undefined when the envelope carried no `event_time`. */
  onBotRevoked?: (reason: 'app_uninstalled' | 'tokens_revoked', eventAtMs?: number) => void
  /** Test seam for the bot-token Web API client. */
  webClientFactory?: (botToken: string, options?: WebClientOptions) => WebClient
  log: Logger
}

export class SlackHttpIngest {
  private web?: WebClient // bot-token Web API client (auth.test + views.open for the modal)
  private botUserId = ''
  private slackBotId = ''
  private channelRefresh?: Promise<void>
  private channelRefreshQueued = false
  /** users.info label cache for DM counterpart names (null = lookup failed). */
  private readonly userNames = new Map<string, string | null>()

  constructor(
    readonly botId: string,
    private readonly secrets: { botToken: string; signingSecret: string },
    private readonly deps: SlackHttpIngestDeps
  ) {}

  /** The Slack signing secret — the HTTP ingress HMACs inbound POSTs with it to
   *  demux+authenticate a request to this bot. Read-only; NEVER log it. */
  get signingSecret(): string {
    return this.secrets.signingSecret
  }

  /** §8 relay-side egress/read facet: Slack is the platform whose relay ingest
   *  owns bot egress (the §14 gating notice, DM-row labeling). Its PRESENCE is
   *  the platform-neutral fact core reads — a platform that keeps egress on the
   *  daemon simply exposes none. */
  readonly egress = {
    notice: (channelId: string, text: string, threadTs?: string): Promise<void> =>
      this.postText(channelId, text, threadTs),
    lookupUserName: (userId: string): Promise<string | undefined> => this.lookupUserName(userId)
  }

  /** Post one plain, chrome-marked text message (the §14 gating notice) — chrome so
   *  peer daemons' thread backfill never re-ingests it as conversation. */
  async postText(channel: string, text: string, threadTs?: string): Promise<void> {
    await this.web?.chat.postMessage({
      channel,
      text,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      metadata: { event_type: 'agentconnect_chrome', event_payload: {} }
    })
  }

  /** Cached best-effort users.info lookup → "@Display Name" label for a DM
   *  conversation row. Undefined when the lookup fails (the row lands nameless). */
  async lookupUserName(userId: string): Promise<string | undefined> {
    if (this.userNames.has(userId)) return this.userNames.get(userId) ?? undefined
    try {
      const res = await this.web?.users.info({ user: userId })
      const u = res?.user as
        { profile?: { display_name?: string; real_name?: string }; real_name?: string; name?: string } | undefined
      const name = u?.profile?.display_name || u?.profile?.real_name || u?.real_name || u?.name
      const label = name ? `@${name}` : null
      this.userNames.set(userId, label)
      return label ?? undefined
    } catch {
      this.userNames.set(userId, null)
      return undefined
    }
  }

  /** Best-effort setup: resolve the bot user id for arbitration. No socket to open —
   *  inbound arrives on the pool-wide HTTP routes and is dispatched via `handle*`. */
  async start(): Promise<void> {
    const dispatcher = proxyDispatcher()
    const options: WebClientOptions = dispatcher ? { fetch: fetchWithDispatcher(dispatcher) } : {}
    this.web = this.deps.webClientFactory
      ? this.deps.webClientFactory(this.secrets.botToken, options)
      : new WebClient(this.secrets.botToken, options)
    // Resolve the bot user id (best-effort — arbitration degrades to keyword/default
    // if it fails; a later re-assign retries).
    try {
      const auth = await this.web.auth.test()
      if (auth.bot_id) this.slackBotId = auth.bot_id
      if (auth.user_id) {
        this.botUserId = auth.user_id
        this.deps.onBotUserId(auth.user_id)
      }
    } catch (err) {
      this.deps.log.warn(`slack-http-ingest(${this.botId}): auth.test failed: ${(err as Error).message}`)
      // A DEAD-credential answer is positive evidence, not a transient miss: it
      // says the token this very assignment carries no longer works. Report it as
      // a revocation so the CP converges even when the `app_uninstalled` event
      // itself was lost — Slack acks that event before the handler runs and never
      // redelivers it, and a relay that crashed holding a queued report would
      // otherwise leave an uninstalled app shown as active forever. Every
      // (re)assign and every pod restart re-probes here, so this is the backstop
      // the in-memory retry queue cannot be.
      //
      // No `eventAtMs`: we don't know WHEN the workspace pulled the app. The
      // revision arm alone is the correct fence here anyway — it identifies the
      // exact credential this probe just found dead.
      if (isDeadCredentialError(err)) {
        this.deps.log.warn(`slack-http-ingest(${this.botId}): credential is dead — reporting revocation`)
        this.deps.onBotRevoked?.('tokens_revoked')
      }
    }
  }

  /** Handle one verified `/slack/events` envelope after demux + HMAC. Forwards
   *  top-level chat after removing this app's own echo. Never throws — HTTP 200 was
   *  already sent; a forward miss is bounded loss at the forwarder. */
  async handleEvent(event: SlackMessageEvent | undefined, eventAtMs?: number): Promise<void> {
    try {
      // App lifecycle: the workspace pulled the app / revoked its tokens. Not a
      // chat event (no user/bot_id — isRoutableEvent would drop it), so branch
      // before the chat filters. `tokens_revoked` is treated as a full revoke —
      // the app has exactly one bot token, and Slack sends it when that dies.
      if (event?.type === 'app_uninstalled' || event?.type === 'tokens_revoked') {
        this.deps.onBotRevoked?.(event.type, eventAtMs)
        return
      }
      if (event && this.isOwnMembershipChange(event)) {
        await this.refreshChannels()
        return
      }
      if (event?.bot_id && (!this.botUserId || !this.slackBotId)) return
      if (!event || isSlackSystemMessage(event)) return
      // send-message-routing-rework.md §5: the ONE edit wrapper that survives ingest is
      // the one closing an agent's logical response. It deliberately runs BEFORE the
      // own-echo and routability filters, both of which would otherwise discard it:
      //  - `isRoutableEvent` drops every `message_changed`, yet a streamed answer can
      //    only be declared complete by editing its last message; and
      //  - on a SHARED bot every agent posts as the same bot user, so echo suppression
      //    would silently make agent-to-agent mentions impossible exactly where the
      //    shared-bot address form (§8.5) exists to make them work.
      // Recognition is by daemon-written metadata, so mid-answer `streaming` edits and
      // ordinary human edits still return null here and stay filtered.
      const finalization = normalizeSlackResponseFinalization(event)
      if (finalization) {
        await this.deps.onMessage(finalization)
        return
      }
      const ownMessage = event.user === this.botUserId || event.bot_id === this.slackBotId
      if (ownMessage || !isRoutableEvent(event)) return
      if (event.type !== 'message' && event.type !== 'app_mention') return
      const msg = normalizeSlackMessage(event)
      if (msg) await this.deps.onMessage(msg)
    } catch (err) {
      this.deps.log.warn(`slack-http-ingest(${this.botId}): event handler error: ${(err as Error).message}`)
    }
  }

  /** Slack's member_joined_channel fires for every member in channels the bot can
   *  see, so only the bot's own user id means its membership changed. channel_left
   *  and group_left are already self-scoped ("you left") events. */
  private isOwnMembershipChange(event: SlackMessageEvent): boolean {
    return (
      (event.type === 'member_joined_channel' && !!this.botUserId && event.user === this.botUserId) ||
      event.type === 'channel_left' ||
      event.type === 'group_left'
    )
  }

  /** Coalesce concurrent membership events but retain one trailing refresh, so a
   *  leave arriving while a join-triggered API call is in flight cannot be lost. */
  private refreshChannels(): Promise<void> {
    if (this.channelRefresh) {
      this.channelRefreshQueued = true
      return this.channelRefresh
    }
    const refresh = (async () => {
      do {
        this.channelRefreshQueued = false
        await this.refreshChannelsOnce()
      } while (this.channelRefreshQueued)
    })().finally(() => {
      if (this.channelRefresh === refresh) this.channelRefresh = undefined
    })
    this.channelRefresh = refresh
    return refresh
  }

  /** Re-list the authenticated bot user's public/private channel membership. A full
   *  snapshot makes join and leave handling idempotent and self-correcting. */
  private async refreshChannelsOnce(): Promise<void> {
    const web = this.web
    if (!web) return
    const channels: { id: string; name?: string; isPrivate?: boolean }[] = []
    let cursor: string | undefined
    do {
      const res = await web.users.conversations({
        types: 'public_channel,private_channel',
        exclude_archived: true,
        limit: 200,
        ...(cursor ? { cursor } : {})
      })
      for (const channel of res.channels ?? []) {
        if (!channel.id || channel.is_im || channel.is_mpim) continue
        channels.push({
          id: channel.id,
          ...(channel.name ? { name: channel.name } : {}),
          ...(channel.is_private ? { isPrivate: true } : {})
        })
      }
      cursor = res.response_metadata?.next_cursor || undefined
    } while (cursor)
    this.deps.onChannelsChanged(channels)
  }

  /** Handle one verified `/slack/interactions` payload. The returned value is the
   *  SYNCHRONOUS 200 body (only `block_suggestion` rides data on it — the external
   *  select options); every other branch returns '' (empty 200) and runs its
   *  side-effects — `views.open`, forwards — after we've computed the return value.
   *  Mirrors the old `socket.on('interactive')` branch order (§10.1). */
  async handleInteraction(body: SlackInteractiveBody): Promise<unknown> {
    try {
      if (body.type === 'block_suggestion' && body.action_id === SHARED_AGENT_SELECT_ACTION_ID) {
        // The one branch whose result rides the 200 body (replaces `ack({ options })`).
        return { options: httpSlackAgentOptions(this.deps.agents(), body.value) }
      }
      if (body.type === 'message_action' && body.callback_id === SLACK_MANAGE_SESSION_SHORTCUT_CALLBACK_ID) {
        const triggerId = body.trigger_id
        const channelId = body.channel?.id
        const threadTs = body.message?.thread_ts ?? body.message?.ts
        const forwarded =
          !!triggerId &&
          !!channelId &&
          !!threadTs &&
          this.deps.onSessionShortcut({
            triggerId,
            channelId,
            threadTs,
            interactionId: triggerId,
            ...(body.user?.id ? { userId: body.user.id } : {})
          })
        if (triggerId && !forwarded) void this.openUnavailableModal(triggerId)
        return ''
      }
      if (
        body.type === 'block_actions' &&
        body.actions?.some((action) => action.action_id === SHARED_AGENT_SELECT_ACTION_ID)
      ) {
        const selected = parseHttpSlackAgentSelection(body, this.deps.agents())
        if (selected?.threadTs) this.deps.onSelectThreadAgent(selected.channelId, selected.threadTs, selected.agentId)
        else if (selected) this.deps.onSetChannelAgent(selected.channelId, selected.agentId)
        return ''
      }
      const agentSwitch = parseHttpSlackAgentSwitch(body)
      if (agentSwitch && body.trigger_id) {
        // trigger_id is valid ~3s — fire promptly, don't block the 200.
        void this.openConfigModal(
          body.trigger_id,
          agentSwitch.channelId,
          agentSwitch.threadTs,
          agentSwitch.currentAgentId
        )
        return ''
      }
      if (
        body.type === 'block_actions' &&
        body.actions?.some((a) => a.action_id === SHARED_CONFIG_ACTION_ID) &&
        body.trigger_id &&
        body.channel?.id
      ) {
        void this.openConfigModal(body.trigger_id, body.channel.id)
        return ''
      }
      const view = body.view
      if (body.type === 'view_submission' && view && view.callback_id === SHARED_CONFIG_ACTION_ID) {
        const context = decodeAgentModalContext(view.private_metadata || '')
        const picked = view.state?.values?.[CONFIG_BLOCK]?.[CONFIG_ACTION]?.selected_option?.value
        if (context?.threadTs && picked) this.deps.onSelectThreadAgent(context.channelId, context.threadTs, picked)
        else if (context && picked) this.deps.onSetChannelAgent(context.channelId, picked)
        return '' // empty 200 closes the modal (same as the old empty ack)
      }
      const sessionAction = parseHttpSlackSessionAction(body)
      if (sessionAction) {
        this.deps.onSessionAction(sessionAction)
        return ''
      }
      return ''
    } catch (err) {
      this.deps.log.warn(`slack-http-ingest(${this.botId}): interactive error: ${(err as Error).message}`)
      return ''
    }
  }

  private async openUnavailableModal(triggerId: string): Promise<void> {
    try {
      await this.web?.views.open({
        trigger_id: triggerId,
        view: {
          type: 'modal',
          title: { type: 'plain_text', text: 'Session options' },
          close: { type: 'plain_text', text: 'Close' },
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: 'No AgentConnect session was found for this conversation.'
              }
            }
          ]
        }
      } as never)
    } catch (err) {
      this.deps.log.warn(`slack-http-ingest(${this.botId}): views.open failed: ${(err as Error).message}`)
    }
  }

  /** Open the "default agent for this channel" modal (a single static_select of the
   *  bot's member agents), seeded with the channel's current owner if set. */
  private async openConfigModal(
    triggerId: string,
    channelId: string,
    threadTs?: string,
    currentAgentId?: string
  ): Promise<void> {
    const agents = this.deps.agents()
    if (agents.length === 0) return // nothing to pick from
    const options = agents.map((a) => ({ text: { type: 'plain_text', text: a.name }, value: a.agentId }))
    const owner = currentAgentId ?? this.deps.currentOwner(channelId)
    const initial = owner ? options.find((o) => o.value === owner) : undefined
    await this.web?.views.open({
      trigger_id: triggerId,
      view: {
        type: 'modal',
        callback_id: SHARED_CONFIG_ACTION_ID,
        private_metadata: encodeAgentModalContext({ channelId, ...(threadTs ? { threadTs } : {}) }),
        title: { type: 'plain_text', text: threadTs ? 'Switch agent' : 'Default agent' },
        submit: { type: 'plain_text', text: 'Save' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'input',
            block_id: CONFIG_BLOCK,
            label: {
              type: 'plain_text',
              text: threadTs
                ? 'Which agent should handle this thread?'
                : 'Which agent should answer this channel by default?'
            },
            element: {
              type: 'static_select',
              action_id: CONFIG_ACTION,
              options,
              ...(initial ? { initial_option: initial } : {})
            }
          }
        ]
      }
    } as never)
  }

  async stop(): Promise<void> {
    // No socket to close — inbound is the pool-wide HTTP surface. Drop the WebClient so a
    // re-assign rebuilds it with (possibly rotated) credentials.
    this.web = undefined
  }
}
