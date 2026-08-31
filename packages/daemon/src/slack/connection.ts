import { App, LogLevel, SocketModeReceiver } from '@slack/bolt'
import { WebClient, type FetchFunction, type WebClientOptions } from '@slack/web-api'
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici'
import { decodeSlackStatusOverflowValue, SLACK_MANAGE_SESSION_SHORTCUT_CALLBACK_ID } from '@agentconnect.md/protocol'
import {
  extractSlackMessageText,
  isSlackSystemMessage,
  normalizeSlackResponseFinalization
} from '@agentconnect.md/message'
import type { Agent } from '../agents/agent-schema.js'
import { integrationCore, platformIntegrationConfig } from '../platforms/integration-config.js'
import { normalizeSlackEvent, toAttachment, type SlackFile, type SlackMessageEvent } from './normalize.js'
import type { Attachment, NormalizedMessage } from '../messages/normalized.js'
import type { Logger } from '../log.js'
import { isSendQueueTimeout, PlatformSendQueue } from '../platforms/send-queue.js'
import type { UploadAnchor, UploadFailReason, UploadOutcome } from '../mcp/ops/context.js'
import {
  STATUS_ACTION,
  ELICIT_ACTION_PREFIX,
  ELICIT_DISMISS_ACTION,
  PERMISSION_ACTION_PREFIX,
  PERMISSION_UPDATE_ACTION,
  buildPermissionUpdateCard,
  buildStatusModal,
  buildStatusUnavailableModal,
  decodePermValue,
  type SlackStreamChunk,
  type StatusBarInfo,
  type StatusModalIdentity
} from './render.js'
import type {
  InteractionActor,
  PlatformCanvas,
  PlatformCanvasEdit,
  PlatformChannelHistoryOptions,
  PlatformChannelHistoryPage,
  PlatformChannelInfo,
  PlatformConnection,
  PlatformConversationSpec,
  PlatformReactionIntent,
  PlatformBookmark,
  PlatformListColumn,
  PlatformListFieldWrite,
  PlatformListItem,
  PlatformListPage,
  PlatformReactionSummary,
  PlatformScheduledMessage
} from '../platforms/contract.js'

/**
 * A List column's schema `type` is NOT always the key a write uses, so everything crosses this
 * table before an agent sees it.
 *
 * The case that matters most is the one every list has: the primary column is always a text
 * column, and Slack is explicit that "you may see the `text` property appear in a response as a
 * fallback, but it is not accepted in the request payload" — a write to it must be `rich_text`.
 * Reporting the schema type verbatim therefore handed the agent the one key the write endpoints
 * reject, on the column it would reach for first.
 *
 * `null` marks a column Slack computes and no request may set. Those are reported read-only
 * rather than given a key that would be refused.
 */
export const LIST_WRITE_KEY_BY_TYPE: Record<string, string | null> = {
  text: 'rich_text',
  rich_text: 'rich_text',
  message: 'message',
  number: 'number',
  select: 'select',
  date: 'date',
  user: 'user',
  attachment: 'attachment',
  checkbox: 'checkbox',
  email: 'email',
  phone: 'phone',
  channel: 'channel',
  rating: 'rating',
  reference: 'reference',
  link: 'link',
  timestamp: 'timestamp',
  // Task columns, which every todo-mode list has. Slack names them semantically in the schema
  // and writes them as the ordinary field they are made of, so a task list — the common case —
  // is exactly where reporting the schema name would fail.
  assignee: 'user',
  todo_assignee: 'user',
  due_date: 'date',
  todo_due_date: 'date',
  completed: 'checkbox',
  todo_completed: 'checkbox',
  created_by: null,
  last_edited_by: null,
  created_time: null,
  last_edited_time: null,
  vote: null,
  canvas: null
}

/** Every column `type` Slack's List schema documents. Exported so a test can assert the table
 *  above answers for ALL of them — the gap that kept reaching review was always a type nobody
 *  had enumerated, not a mapping anyone got wrong. */
export const LIST_SCHEMA_TYPES = [
  'text',
  'message',
  'number',
  'select',
  'date',
  'user',
  'attachment',
  'checkbox',
  'email',
  'phone',
  'channel',
  'rating',
  'created_by',
  'last_edited_by',
  'created_time',
  'last_edited_time',
  'vote',
  'canvas',
  'reference',
  'link',
  'assignee',
  'due_date',
  'completed',
  'todo_assignee',
  'todo_due_date',
  'todo_completed'
] as const

/** The keys a RESPONSE field may carry its value under. `text` is here to be read and is
 *  deliberately absent from the write side above's value set — it is a fallback, never a key. */
const LIST_FIELD_TYPES = [
  'rich_text',
  'text',
  'message',
  'number',
  'select',
  'date',
  'user',
  'channel',
  'attachment',
  'checkbox',
  'email',
  'phone',
  'rating',
  'timestamp',
  'link',
  'reference'
] as const

/** Core names the intent; Slack's alphabet is emoji shortcodes. */
const SLACK_REACTION_NAMES: Record<PlatformReactionIntent, string> = { seen: 'eyes' }

export interface ConsolidatedGroup {
  appToken: string
  botToken: string
  /** Public Slack app id (A…) used only to build the OAuth permission-update URL. */
  appId?: string
  integrations: { agentId: string; integrationId: string }[]
}

/** Optional per-message rendering controls. `username` / `icon_url` require Slack's
 *  `chat:write.customize` scope; {@link SlackConnection} transparently falls back to
 *  the app identity for older installations that do not have it yet. Stable AgentConnect
 *  authorship travels separately in message metadata. */
export interface SlackPostOptions {
  username?: string
  /** Public https image URL for the message avatar (the agent's icon). */
  icon_url?: string
  /** Stable AgentConnect author identity for first-class agent thread events.
   *  Slack's bot_id identifies the shared app, not the individual agent, so this
   *  rides in message metadata and survives cross-daemon history reconstruction. */
  agentAuthorId?: string
  /** Reply-only trailing blocks (the linked attribution context). When present they
   *  are included in the initial chat.postMessage and link/media unfurls are disabled. */
  trailingBlocks?: unknown[]
  /** Marks this message as daemon CHROME (status bar, progress/plan/reasoning, notices,
   *  cards) rather than a conversational message. Stamps a distinguishing `event_type` in
   *  Slack metadata so a peer daemon's thread backfill can skip it — chrome is never
   *  conversation and must not be re-ingested as a transcript text row. */
  chrome?: boolean
  /** Stable AgentConnect owner for agent-scoped chrome such as a session status bar.
   *  Multiple agents can share one Slack app identity, so bot_id/app_id alone cannot
   *  safely decide which agent may adopt and edit an existing chrome row. */
  chromeOwnerAgentId?: string
  /** The finalized-response routing block for an agent-authored conversational message
   *  (send-message-routing-rework.md §4). Ignored on chrome, which is never routable.
   *  Requires `agentAuthorId` — a response block without an exact author proves nothing
   *  and would be discarded at ingress anyway. */
  response?: SlackResponseMetadata
}

/**
 * Daemon-owned response metadata carried in Slack message metadata so a peer's ingress
 * can route an agent-authored message (send-message-routing-rework.md §4).
 *
 * The daemon derives every field; model text can never populate one. It rides in
 * provider metadata rather than the body precisely so the visible text stays exactly
 * what the agent wrote.
 */
export interface SlackResponseMetadata {
  /** One id for the COMPLETE logical response. Every physical message of a long answer
   *  shares it, so a target dedups on (responseId, target agent) and activates once. */
  responseId: string
  /** `streaming` while the answer is still being written (including intermediate edits);
   *  `final` on the ONE event that closes the response. Only `final` enters routing —
   *  routing a prefix would prompt the peer with a half-written message (§5). */
  deliveryState: 'streaming' | 'final'
  /** The author's own trusted turn depth BEFORE this delivery — a human/root turn is 0.
   *  Each routing edge adds one and caps; the model cannot set or reset it (§4.1). */
  hopCount: number
  /** Agents addressed by the COMPLETE logical response, resolved against the
   *  conversation's agent directory before splitting. The final event carries the whole
   *  set even when the visible mention landed in an earlier physical message (§5.2). */
  mentionedAgentIds: string[]
  /** Did the COMPLETE response address anyone at all (a human or another app included)?
   *  `mentionedAgentIds` cannot answer that, and the final event's own text may not hold
   *  the mention when the answer was split — see AgentAuthorshipClaimSchema. */
  addressedAnyone?: boolean
  /** Only on the visible half of a paired `toAgent + channel` send (§3.2); it correlates
   *  this post with the internal wake that carries the authoritative call envelope. */
  agentCallDeliveryId?: string
}

/** A handle to ONE open Slack streaming message (`chat.startStream` → `chat.appendStream` →
 *  `chat.stopStream`). Carries the conversation as well as the message, because the stream is
 *  bookkept per conversation. */
export interface SlackTurnStream {
  readonly channel: string
  readonly threadTs: string
  readonly ts: string
}

/**
 * What Slack did with an append. `refused` means this card update did not land and the handle
 * is still good — chrome is lossy-tolerant, so it is simply dropped. `stopped` means the
 * message is definitively no longer streaming, so the handle is retired and nothing more is
 * appended to it or stopped against it.
 */
export type SlackStreamAppendOutcome = 'ok' | 'refused' | 'stopped'

/** Per-agent identity for the working indicator (agents.sessions.setStatus). Slack keeps
 *  these STICKY on the session until rewritten, so every `processing` write carries the
 *  current agent's identity and the dedupe key includes it. Needs chat:write.customize;
 *  a bot without it falls back to app identity (see setSessionLifecycle). */
export interface SlackStatusOptions {
  username?: string
  /** Public https image URL for the working-indicator avatar. */
  icon_url?: string
  /** Logical session this write acts for — recorded as the slot's displayed owner, so the
   *  native Stop can target the turn the user is actually looking at. */
  sessionKey?: string
}

/** Slack message `metadata.event_type` marking a message as daemon chrome (see
 *  `SlackPostOptions.chrome`). Exported so the backfill can recognize it. */
export const SLACK_CHROME_EVENT_TYPE = 'agentconnect_chrome'

function slackMessageMetadata(
  options?: Pick<SlackPostOptions, 'agentAuthorId' | 'chrome' | 'chromeOwnerAgentId' | 'response'>
) {
  if (options?.chrome) {
    const ownerAgentId = options.chromeOwnerAgentId?.trim()
    return {
      metadata: {
        event_type: SLACK_CHROME_EVENT_TYPE,
        event_payload: ownerAgentId ? { owner_agent_id: ownerAgentId } : {}
      }
    }
  }
  const agentAuthorId = options?.agentAuthorId?.trim()
  if (agentAuthorId) {
    // The response block is gated on an exact author for the same reason ingress is: a
    // recipient set with no provable author is not a weaker claim, it is no claim at all.
    const response = options?.response
    return {
      metadata: {
        event_type: 'agentconnect_thread_event',
        event_payload: {
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
    }
  }
  return {}
}

/** App-level tokens are structured `xapp-1-{APP_ID}-{epoch}-{hex}`. Keep this
 * local fallback for hand-authored direct integrations; CP-pushed shared specs
 * carry the same public id explicitly because they intentionally omit xapp. */
function slackAppIdFromAppToken(appToken: string): string | undefined {
  const segment = appToken.split('-')[2]
  return segment && /^A[A-Z0-9]+$/.test(segment) ? segment : undefined
}

/** §6.1: one Slack Socket Mode connection per unique appToken.
 *  Shared-mode integrations are SKIPPED here — their inbound lives on a relay, so
 *  the daemon opens no socket for them (it reaches them send-only via RelayClient;
 *  see shared-bot-relay.md §11). They carry no appToken, so there is nothing to
 *  consolidate on. */
export function consolidate(agents: Agent[]): Map<string, ConsolidatedGroup> {
  const groups = new Map<string, ConsolidatedGroup>()
  for (const a of agents) {
    for (const int of a.integrations) {
      if (int.platform !== 'slack') continue
      // §6.4: the opaque config is validated by THIS platform's module schema;
      // an invalid/absent payload fails closed (no socket). The appToken guard
      // stays the consolidator's own: a hand-authored direct entry may simply
      // not have one yet (CP-pushed specs are refused at ingest without it).
      const slack = platformIntegrationConfig('slack', int)
      if (!slack || integrationCore(int).mode === 'shared' || !slack.appToken) continue
      const k = slack.appToken
      const appId = slack.appId ?? slackAppIdFromAppToken(k)
      const g = groups.get(k) ?? {
        appToken: k,
        botToken: slack.botToken,
        ...(appId ? { appId } : {}),
        integrations: []
      }
      if (!g.appId && appId) g.appId = appId
      g.integrations.push({ agentId: a.id, integrationId: int.id })
      groups.set(k, g)
    }
  }
  return groups
}

/** Group SHARED-mode Slack integrations by xoxb (one send-only client per bot
 *  token). These have no appToken (the relay owns inbound), so they can't be keyed
 *  by appToken like {@link consolidate} — the bot token is the identity. */
/** §7.5 opaque identity of one Slack SOCKET connection. The app token pins the
 *  Socket Mode consumer and the bot token the send credential, so a change in
 *  either is a different connection. Takes the shape shared by a consolidated
 *  group and a live `SlackConnection`, so both hash identically by construction. */
export function slackSocketKey(c: { appToken: string; botToken: string }): string {
  return `${c.appToken}\u0000${c.botToken}`
}

/** §7.5 opaque identity of one SEND-ONLY (shared / HTTP) Slack client. A shared
 *  bot has no app token — the relay owns its inbound — so the bot token is the
 *  whole identity. */
export function slackSharedKey(c: { botToken: string }): string {
  return c.botToken
}

export function consolidateShared(agents: Agent[]): Map<string, ConsolidatedGroup> {
  const groups = new Map<string, ConsolidatedGroup>()
  for (const a of agents) {
    for (const int of a.integrations) {
      if (int.platform !== 'slack' || integrationCore(int).mode !== 'shared') continue
      const slack = platformIntegrationConfig('slack', int)
      if (!slack) continue
      const k = slack.botToken
      const g = groups.get(k) ?? {
        appToken: '',
        botToken: k,
        ...(slack.appId ? { appId: slack.appId } : {}),
        integrations: []
      }
      if (!g.appId && slack.appId) g.appId = slack.appId
      g.integrations.push({ agentId: a.id, integrationId: int.id })
      groups.set(k, g)
    }
  }
  return groups
}

export interface SlackDeps {
  group: ConsolidatedGroup
  onMessage: (msg: NormalizedMessage) => void
  /** Fired when the bot's channel membership changes (invited to / removed from a
   *  channel), so the daemon can re-list + re-report the membership snapshot. */
  onChannelsChanged?: () => void
  /** Fired when a user interacts with the status modal's selects, or raises a cancel —
   *  Slack's native Stop, or a status row posted while the overflow still rendered one.
   *  `sessionKey` comes from the modal's `private_metadata`; payload fields are present
   *  only for their matching action. */
  onStatusAction?: (a: {
    kind: 'set-model' | 'set-effort' | 'set-permission-mode' | 'set-fast' | 'set-output' | 'cancel'
    sessionKey: string
    /** Who tapped it (Block Kit `body.user`), so the daemon can record the operator
     *  behind a session change. Absent only if Slack omits the actor on the payload. */
    actor?: InteractionActor
    model?: string
    effort?: string
    permissionMode?: string
    fastMode?: boolean
    outputMode?: 'none' | 'minimal' | 'low' | 'medium' | 'high'
  }) => void
  /** Synchronous getter into the daemon (source of truth) for a session's agent identity,
   *  current status snapshot, and deep link — used to build the Configure controls modal on
   *  demand. Undefined for an unknown/closed session key. */
  onStatusInfo?: (
    sessionKey: string
  ) => Promise<{ info: StatusBarInfo; identity?: StatusModalIdentity; link?: string } | undefined>
  /** Resolve the exact local session owned by the selected Slack conversation, awaited
   *  before the one-shot shortcut trigger opens its modal. */
  onMessageShortcut?: (a: { channel: string; thread: string; userId: string }) => Promise<string | undefined>
  /** Every local session in one Slack conversation, newest first — the stop's fallback
   *  resolver when no displayed owner is recorded (e.g. right after a reconnect). */
  onThreadSessions?: (a: { channel: string; thread: string }) => Promise<string[]>
  /** Settle the conversation's ONE status slot after a stop: re-assert a surviving sibling's
   *  `processing`, or transition an empty thread to `active`. Owned by the daemon. */
  onSlotSettle?: (a: { channel: string; thread: string; exclude?: string }) => void
  /** Fired when a user taps a button on an interactive permission card
   *  (render.buildPermissionCard). The decoded `requestId` ties the click back to the
   *  pending ACP `session/request_permission`; `optionId` is the chosen option. */
  onPermissionChoice?: (a: { requestId: string; optionId: string; actor?: InteractionActor }) => void
  /** Fired when a user taps a button on an interactive elicitation card
   *  (render.buildElicitationCard). `value` is the chosen option's wire value, or null
   *  for the Dismiss button (decline). */
  onElicitChoice?: (a: { requestId: string; value: string | null }) => void
  newTraceId: () => string
  log?: Logger
  /** When true, hand Bolt LogLevel.DEBUG so socket-mode internals are visible. */
  boltDebug?: boolean
  /** Min spacing (ms) between outbound writes (serialized send-queue). Tests pass 0. */
  sendIntervalMs?: number
  /**
   * SEND-ONLY mode (shared-bot-relay.md §11): the bot's INBOUND lives on a relay,
   * so this connection opens NO Socket Mode socket — it is just the xoxb Web-API
   * client + the send queue, wired into `connByIntegration` so replies, attachment
   * fetches, MCP platform tools and cron anchors reuse it unchanged. `group.appToken`
   * is empty here (the daemon never holds the shared bot's xapp). `onMessage` is
   * never called (the relay delivers inbound as `rd/msg`).
   */
  sendOnly?: boolean
}

type SlackUserResult = {
  id?: string
  name?: string
  real_name?: string
  is_bot?: boolean
  profile?: { real_name?: string; display_name?: string; image_48?: string; image_72?: string }
}

/** The subset of a Block Kit `block_actions` payload we read: the interacted element
 *  (`action_id` + its value / selected option) and the enclosing block's `block_id`; on the
 *  message it's the `trigger_id` (to open a modal), inside a modal the `view` (id +
 *  `private_metadata`, which carries the session key). */
type BlockActionArgs = {
  ack: () => Promise<void>
  action: { action_id?: string; block_id?: string; value?: string; selected_option?: { value?: string } }
  body?: {
    trigger_id?: string
    view?: { id?: string; private_metadata?: string }
    actions?: { block_id?: string }[]
    user?: { id?: string; username?: string; name?: string }
  }
}

type MessageShortcutArgs = {
  ack: () => Promise<void>
  shortcut: {
    trigger_id?: string
    channel?: { id?: string }
    message?: { ts?: string; thread_ts?: string }
    user?: { id?: string }
  }
}

/** The clicking user off a `block_actions` payload, for the action's audit record. */
function actorOf(body: BlockActionArgs['body']): InteractionActor | undefined {
  const user = body?.user
  if (!user?.id) return undefined
  const name = (user.username ?? user.name)?.trim()
  return { userId: user.id, ...(name ? { name } : {}) }
}

/** The Slack surface `SlackConnection` drives. Exported so a caller can supply its own — see
 *  {@link SlackAppFactory}. */
export type AppLike = {
  message: (handler: (args: { message: unknown }) => Promise<void> | void) => void
  event: (type: string, handler: (args: { event: unknown }) => Promise<void> | void) => void
  action: (actionId: string | RegExp, handler: (args: BlockActionArgs) => Promise<void> | void) => void
  shortcut: (callbackId: string, handler: (args: MessageShortcutArgs) => Promise<void> | void) => void
  client: {
    views: {
      open: (a: unknown) => Promise<unknown>
      update: (a: unknown) => Promise<unknown>
    }
    // auth.test also returns the team id and `url`, the workspace's base Slack
    // URL (e.g. "https://acme.slack.com/").
    auth: {
      test: () => Promise<{
        user_id?: string
        bot_id?: string
        team_id?: string
        url?: string
      }>
    }
    chat: {
      postMessage: (a: unknown) => Promise<{ ts?: string }>
      getPermalink: (a: unknown) => Promise<{ permalink?: string }>
      update: (a: unknown) => Promise<{ ts?: string }>
      delete: (a: unknown) => Promise<unknown>
      // Native tool-call chrome (slack-streaming-turn-output.md §3). Optional because
      // absence IS one of the capability refusals §7 latches on — which is also what keeps
      // every inert test app on the legacy path without edits.
      // Delivery the platform performs later, with no daemon involvement and no agent
      // identity — Slack takes no username/icon_url here.
      scheduleMessage: (a: unknown) => Promise<{ scheduled_message_id?: string; channel?: string }>
      startStream?: (a: unknown) => Promise<{ ts?: string }>
      appendStream?: (a: unknown) => Promise<unknown>
      stopStream?: (a: unknown) => Promise<unknown>
    }
    // The external upload flow (`files:write`). chat.postMessage cannot carry bytes at all,
    // so this is the ONLY way to put a file in a conversation.
    files: {
      getUploadURLExternal: (a: unknown) => Promise<{ upload_url?: string; file_id?: string }>
      completeUploadExternal: (a: unknown) => Promise<unknown>
      uploadV2: (a: unknown) => Promise<unknown>
      info: (a: unknown) => Promise<{
        file?: {
          shares?: { public?: SlackFileShares; private?: SlackFileShares }
          // A canvas is a file: its title, link, and private body URL all come from here,
          // because Slack publishes no full canvas read of its own.
          title?: string
          permalink?: string
          url_private?: string
        }
      }>
    }
    conversations: {
      open: (a: unknown) => Promise<{
        channel?: { id?: string; name?: string; is_im?: boolean; is_mpim?: boolean }
      }>
      // `conversations.create` + `invite` back the agent's createConversation
      // (`channels:manage` / `groups:write`); both are capability scopes, not required ones.
      create: (a: unknown) => Promise<{ channel?: { id?: string; name?: string; is_private?: boolean } }>
      invite: (a: unknown) => Promise<unknown>
      canvases: { create: (a: unknown) => Promise<{ canvas_id?: string }> }
      info: (a: unknown) => Promise<{
        channel?: {
          id?: string
          name?: string
          is_im?: boolean
          is_mpim?: boolean
          is_private?: boolean
          user?: string
        }
      }>
      members: (a: unknown) => Promise<{ members?: string[] }>
      // The one WRITE call this adapter makes against a conversation — see leaveChannel.
      leave: (a: unknown) => Promise<unknown>
      list: (a: unknown) => Promise<{ channels?: { id?: string; name?: string; is_private?: boolean }[] }>
      replies: (a: unknown) => Promise<{
        messages?: {
          user?: string
          bot_id?: string
          app_id?: string
          bot_profile?: { app_id?: string }
          ts?: string
          text?: string
          subtype?: string
          files?: SlackFile[]
          metadata?: {
            event_type?: string
            event_payload?: { author_agent_id?: unknown; owner_agent_id?: unknown }
          }
        }[]
        has_more?: boolean
        response_metadata?: { next_cursor?: string }
      }>
      history: (a: unknown) => Promise<{
        messages?: {
          user?: string
          bot_id?: string
          app_id?: string
          bot_profile?: { app_id?: string }
          ts?: string
          text?: string
          blocks?: unknown
          attachments?: unknown
          thread_ts?: string
          reply_count?: number
        }[]
        has_more?: boolean
        response_metadata?: { next_cursor?: string }
      }>
    }
    users: {
      info: (a: unknown) => Promise<{ user?: SlackUserResult }>
      // users.conversations — channels the AUTHED BOT is a member of (not the
      // workspace-wide conversations.list). Needs channels:read / groups:read.
      conversations: (a: unknown) => Promise<{
        channels?: { id?: string; name?: string; is_private?: boolean; is_im?: boolean; is_mpim?: boolean }[]
        response_metadata?: { next_cursor?: string }
      }>
    }
    reactions: {
      add: (a: unknown) => Promise<unknown>
      // reactions.get needs `reactions:read`, a capability scope — an installation that
      // predates it fails here with missing_scope rather than being marked broken.
      get: (a: unknown) => Promise<{ message?: { reactions?: { name?: string; count?: number; users?: string[] }[] } }>
    }
    // Slack Canvas (`canvases:write`, plus `canvases:read` for the section anchors).
    canvases: {
      create: (a: unknown) => Promise<{ canvas_id?: string }>
      edit: (a: unknown) => Promise<unknown>
      sections: { lookup: (a: unknown) => Promise<{ sections?: { id?: string }[] }> }
    }
    bookmarks: {
      list: (a: unknown) => Promise<{ bookmarks?: { id?: string; title?: string; link?: string; emoji?: string }[] }>
      add: (a: unknown) => Promise<{ bookmark?: { id?: string; title?: string; link?: string; emoji?: string } }>
      remove: (a: unknown) => Promise<unknown>
    }
    slackLists: {
      items: {
        list: (a: unknown) => Promise<{
          items?: { id?: string; fields?: { column_id?: string; [k: string]: unknown }[] }[]
          list?: { columns?: { id?: string; key?: string; name?: string; type?: string }[] }
          response_metadata?: { next_cursor?: string }
        }>
        create: (a: unknown) => Promise<{ item?: { id?: string } }>
        update: (a: unknown) => Promise<unknown>
      }
    }
    agents: {
      sessions: {
        setStatus: (a: unknown) => Promise<unknown>
        rename: (a: unknown) => Promise<unknown>
      }
    }
  }
  init?: () => Promise<void>
  start: () => Promise<void>
  stop: () => Promise<void>
}

type AssistantThreadStartedEvent = {
  assistant_thread?: {
    channel_id?: string
    thread_ts?: string
  }
}

/** Only top-level chat shapes enter routing. Slack emits edits, deletes,
 *  assistant-thread metadata/title updates, and system records through the same generic
 *  `message` listener. In particular, `message_changed` keeps the actual sender and
 *  text in a nested `message` object; normalizing that outer wrapper would turn it
 *  into an anonymous empty DM and could feed our own update back into the agent.
 *  `me_message` and thread broadcasts still carry genuine user text and must remain
 *  routable. Keep this allowlist aligned with the relay's shared Slack ingest. */
function isRoutableMessageSubtype(subtype: string | undefined): boolean {
  return (
    subtype === undefined ||
    subtype === 'file_share' ||
    subtype === 'me_message' ||
    subtype === 'thread_broadcast' ||
    subtype === 'reply_broadcast'
  )
}

function isRoutableMessageEvent(ev: SlackMessageEvent): boolean {
  // Slack documents an Events API bug where a message_replied structural wrapper may
  // omit its subtype. Author + shape checks keep that hidden/nested wrapper out while
  // retaining genuine human and bot chat at the top level. `deliver` removes the
  // exact receiving connection's own echo.
  return (
    Boolean(ev.user || ev.bot_id) &&
    !ev.hidden &&
    ev.message === undefined &&
    // A streaming chrome message is not conversation: its body is Slack's fixed placeholder,
    // and ingesting that as a message would put it in a peer agent's context.
    !isSlackStreamChromeMessage(ev) &&
    (isRoutableMessageSubtype(ev.subtype) || ev.subtype === 'bot_message')
  )
}

/** Cap on members enriched per `listChannelMembers` call (bounds users.info fan-out). */
const MEMBER_ENRICH_CAP = 50
const SLACK_CHANNEL_HISTORY_DEFAULT_LIMIT = 100
const SLACK_CHANNEL_HISTORY_MAX_LIMIT = 200
const SLACK_FILE_ORIGIN = 'https://files.slack.com'

/**
 * Build a chat.postMessage/update payload that renders the body as a Block Kit
 * `markdown` block — Slack renders standard CommonMark there natively, so the agent's
 * markdown is sent verbatim (no markdown→mrkdwn conversion). `text` is kept as the
 * notification/accessibility fallback. Callers pre-chunk to SLACK_MARKDOWN_BLOCK_LIMIT.
 */
function markdownBlock(text: string): { text: string; blocks: { type: 'markdown'; text: string }[] } {
  return { text, blocks: [{ type: 'markdown', text }] }
}

/** Slack Web API platform errors carry rejected OAuth scopes in `data.needed`.
 * Preserve an `unknown` marker when a test/adapter exposes only the error name:
 * the user-facing card does not print scope names, but should still appear. */
function missingScopesFrom(err: unknown): string[] {
  if (!err || typeof err !== 'object') return []
  const data = (err as { data?: unknown }).data
  const record = data && typeof data === 'object' ? (data as { error?: unknown; needed?: unknown }) : undefined
  const message = err instanceof Error ? err.message : ''
  if (record?.error !== 'missing_scope' && !/\bmissing_scope\b/.test(message)) return []
  const needed = Array.isArray(record?.needed) ? record.needed : String(record?.needed ?? '').split(',')
  const scopes = needed.map((scope) => String(scope).trim()).filter((scope) => /^[a-z0-9._:-]+$/i.test(scope))
  return scopes.length > 0 ? [...new Set(scopes)] : ['unknown']
}

/** Match that exact capability so a real chat:write/network failure is never
 * retried and cannot duplicate a message whose first result was ambiguous. */
function isMissingCustomizeScope(err: unknown): boolean {
  return missingScopesFrom(err).includes('chat:write.customize')
}

function slackApiErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined
  const data = (err as { data?: unknown }).data
  if (!data || typeof data !== 'object') return undefined
  const code = (data as { error?: unknown }).error
  return typeof code === 'string' ? code : undefined
}

// Re-probe periodically so granting chat:write.customize to an existing Slack app
// takes effect without requiring a daemon restart, while avoiding one rejected API
// call per message for installations that have not been upgraded yet.
const CUSTOM_USERNAME_REPROBE_MS = 5 * 60_000

/** Streaming re-probes on the same cadence: a workspace can GAIN the capability (plan
 *  change, app upgrade), so a permanent latch would be wrong. */
const STREAM_REPROBE_MS = CUSTOM_USERNAME_REPROBE_MS

/** Refusals that say this INSTALLATION cannot stream at all — latch and re-probe (§7). */
const STREAM_CAPABILITY_REFUSALS = new Set([
  'unknown_method',
  'missing_scope',
  'channel_type_not_supported',
  'messages_tab_disabled'
])

/** Not failures: the message is already settled, by our own stop or by the person's Stop.
 *  A stopped stream is unrecoverable, so there is nothing to retry or report. */
const STREAM_ALREADY_STOPPED = new Set(['message_not_in_streaming_state', 'stopped_by_user'])

/** Backoff for a settle+stop Slack has not resolved, after the owning turn is gone. */
const OWED_STOP_BACKOFF_MS = [5_000, 15_000, 45_000, 120_000]

/** The container label for a stream the daemon opened but no turn ever owned. */
const STREAM_ABANDONED_TITLE = 'Stopped'

/** Streams are bookkept per MESSAGE. One connection can host sibling turns in the same
 *  (channel, thread) — same-message multi-agent fan-out — and a conversation key would let the
 *  second open orphan the first, leaving it streaming forever. */
function streamKey(channel: string, ts: string): string {
  return `${channel}:${ts}`
}

/** Does this error PROVE the message is no longer streaming? Only a definite answer retires a
 *  handle — a rate limit or a dropped connection leaves the message live and stays retryable. */
function isStreamAlreadyStopped(err: unknown): boolean {
  const code = slackApiErrorCode(err)
  return code !== undefined && STREAM_ALREADY_STOPPED.has(code)
}

/** The text Slack gives a cards-only streaming message, and the marker it carries while it is
 *  still open (verified live 2026-08-28). Neither is conversation, so ingress and thread
 *  backfill must never read one back as a message body. */
export const SLACK_STREAM_PLACEHOLDER_TEXT = 'This message contains interactive elements.'

/** A message that is (or was) one of our streaming chrome messages rather than a body.
 *  `streaming_state` is read structurally — the SDK's message type does not declare it. */
export function isSlackStreamChromeMessage(m: { text?: string; bot_id?: string; app_id?: string }): boolean {
  if ((m as { streaming_state?: unknown }).streaming_state !== undefined) return true
  // The placeholder alone is evidence only from an app: a person typing that sentence is
  // ordinary conversation and must not disappear.
  return Boolean(m.bot_id || m.app_id) && m.text?.trim() === SLACK_STREAM_PLACEHOLDER_TEXT
}

/** Per-request bound on every Slack egress call. Shared with the byte upload, which rides the
 *  same serial queue and would otherwise block all delivery on undici's 300 s defaults. */
const SLACK_API_TIMEOUT_MS = 30_000

/** Map a Slack API error to the port's typed failure vocabulary — every arm already had the
 *  raw material (`missing_scope` payloads, stable error codes); this only names them. */
/** The `files.info` share record, keyed by channel id (docs: `shares.public|private`). */
type SlackFileShares = Record<string, { ts?: string }[] | undefined>

/**
 * Completion outcomes that do NOT prove the share was refused. Slack documents both as
 * possibly raised AFTER some aspect of the operation succeeded, so a one-shot completion that
 * answers with either may already be visible in the channel.
 */
const COMPLETION_MAY_HAVE_LANDED = new Set(['internal_error', 'fatal_error'])

/**
 * The only completion refusals worth a second, undecorated attempt: pure request validation
 * (so provably before publication) AND plausibly caused by `username`/`icon_url` themselves,
 * which is the one thing the retry can change. A pre-publication refusal this set omits —
 * `not_in_channel`, `channel_not_found` — would fail identically undecorated, so retrying it
 * only spends a call and replaces the real error with its echo.
 */
const DECORATION_REFUSALS = new Set(['missing_scope', 'invalid_arguments', 'invalid_arg_name', 'invalid_array_arg'])

/** `uploadV2` answers with one `completeUploadExternal` response per file. */
type SlackUploadV2Result = { files?: { files?: { id?: string }[] }[] } | undefined

/** The provider's own words, for the arm that has no category: without this a refusal
 *  reports only `platform error`, which no operator can act on. */
function slackErrorDetail(err: unknown): { detail?: string } {
  const code = slackApiErrorCode(err)
  const text = code ?? (err as Error | undefined)?.message
  return text ? { detail: text.slice(0, 120) } : {}
}

function classifySlackUploadError(err: unknown): UploadFailReason {
  if (missingScopesFrom(err).length > 0) return 'missing_scope'
  const code = slackApiErrorCode(err)
  if (code === 'message_not_found' || code === 'channel_not_found' || code === 'thread_not_found') return 'not_found'
  if (code === 'not_in_channel' || code === 'restricted_action' || code === 'access_denied') return 'forbidden'
  if (code === 'file_size_limit_exceeded' || code === 'too_large') return 'too_large'
  return 'platform_error'
}

function proxyDispatcher(): ProxyAgent | undefined {
  const url = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY
  return url ? new ProxyAgent(url) : undefined
}

function fetchWithDispatcher(dispatcher: Dispatcher): FetchFunction {
  return (url, init) => undiciFetch(url, { ...(init as Parameters<typeof undiciFetch>[1]), dispatcher })
}

/** Build the send-only {@link AppLike}: a real Slack `WebClient` (xoxb) for the send
 *  surface + inert event/start/stop members (shared-bot-relay.md §11). Same proxy +
 *  timeout/retry tuning as the socket-mode factory. */
function sendOnlyApp(botToken: string): AppLike {
  const dispatcher = proxyDispatcher()
  const client = new WebClient(botToken, {
    ...(dispatcher ? { fetch: fetchWithDispatcher(dispatcher) } : {}),
    timeout: SLACK_API_TIMEOUT_MS,
    retryConfig: { retries: 2 }
  })
  return {
    message: () => {},
    event: () => {},
    action: () => {},
    shortcut: () => {},
    client: client as unknown as AppLike['client'],
    start: async () => {},
    stop: async () => {}
  }
}

/** Builds the Slack app a connection drives. The default reaches slack.com; daemon tests inject an
 *  inert one so a unit suite never depends on Slack being reachable. */
export type SlackAppFactory = (opts: { token: string; appToken: string }) => AppLike

/** The production socket-mode app: a real Bolt/`WebClient` pair that reaches slack.com. */
function realSocketModeApp(o: { token: string; appToken: string }, boltDebug?: boolean): AppLike {
  // If HTTPS_PROXY or HTTP_PROXY is set, route all Slack API calls and
  // WebSocket connections through that proxy.
  const dispatcher = proxyDispatcher()
  const clientOptions: WebClientOptions = {
    ...(dispatcher ? { fetch: fetchWithDispatcher(dispatcher) } : {}),
    // Bound the Web API per-request time + retries. The @slack/web-api default
    // "10 retries over ~30 minutes" would, combined with our serial send-queue,
    // let one transient failure block all delivery for a whole turn. 30s is a
    // compromise: long enough for auth.test and sends to survive a slow/VPN link,
    // yet still bounded so a stuck call cannot wedge the queue indefinitely.
    timeout: SLACK_API_TIMEOUT_MS,
    retryConfig: { retries: 2 }
  }
  const logLevel = boltDebug ? LogLevel.DEBUG : undefined
  const receiver = new SocketModeReceiver({
    appToken: o.appToken,
    ...(dispatcher ? { dispatcher } : {}),
    installerOptions: { clientOptions },
    ...(logLevel ? { logLevel } : {})
  })
  return new App({
    token: o.token,
    receiver,
    clientOptions,
    // Bolt v5 otherwise starts token verification from its constructor without
    // an awaitable lifecycle. start() calls init() before opening the socket.
    deferInitialization: true,
    ...(logLevel ? { logLevel } : {})
  }) as unknown as AppLike
}

export class SlackConnection implements PlatformConnection {
  private app: AppLike
  // §9.1: all outbound writes (post/update/setStatus/setTitle) funnel through one queue so
  // streamed edits are FIFO-ordered and rate-limited per Slack app connection.
  private queue: PlatformSendQueue
  /** Cooldown after Slack proves this installation lacks chat:write.customize. */
  private customUsernameRetryAt = 0
  /** Last title written per `channel:thread` — every turn re-pushes the stored title, so
   *  unchanged repeats must not spend an API call. Grows like sessionLifecycle: unevicted. */
  private lastTitles = new Map<string, string>()
  /** Slack app/workspace ids are public metadata used only for the OAuth settings link. */
  private appId = ''
  private teamId = ''
  /** A workspace-wide missing scope should create one card, not one per streamed write. */
  private missingScopes = new Set<string>()
  private permissionUpdateAnnounced = false
  // Slack's Agent/assistant DM surface can announce the real app-thread root via
  // assistant_thread_started, while later message.im payloads may arrive without
  // thread_ts. Keep the active DM thread root so replies stay inside that thread.
  private assistantDmThreads = new Map<string, string>()
  /** Last agent-session lifecycle state per `channel:thread`, so an unchanged one refires nothing. */
  private sessionLifecycle = new Map<string, string>()
  /** The slot's displayed owner per `channel:thread`: the sessionKey of the last `processing`
   *  writer — the turn the native Stop control is showing, and therefore targets. */
  private slotOwner = new Map<string, string>()
  /** Latched when the bot lacks chat:write.customize — the indicator keeps the app identity. */
  private statusIdentityUnsupported = false
  /** Cooldown after Slack proves this installation cannot stream (§7 capability refusal). */
  private streamingUnavailableUntil = 0
  /** Chrome streams still open, keyed by MESSAGE (see `streamKey`). An entry disappears the
   *  moment the stream settles — by our stop, or by Slack proving it already stopped. */
  private openStreams = new Set<string>()
  /** Settle+stop pairs Slack has not resolved, retried on a backoff after the owning turn is
   *  gone. Without an owner here a transient double failure leaves the row working forever. */
  private owedStops = new Map<string, { timer: NodeJS.Timeout }>()
  botUserId = ''
  /** The appToken this socket is keyed by (one socket per unique appToken). */
  readonly appToken: string
  /** The botToken this socket authenticated with (used to detect a same-appToken swap). */
  readonly botToken: string
  // The bot's `B…` id (distinct from the `U…` user id). Used to recognize our own
  // echoes that arrive with bot_id but no user field. Resolved at start() via auth.test.
  botId = ''
  // The workspace's base Slack URL (e.g. "https://acme.slack.com/"), resolved at
  // start() via auth.test. The root for building thread permalinks (session deep
  // links). Empty until start() completes.
  workspaceUrl = ''

  constructor(
    private deps: SlackDeps,
    factory?: SlackAppFactory
  ) {
    this.appToken = deps.group.appToken
    this.botToken = deps.group.botToken
    this.appId = deps.group.appId ?? slackAppIdFromAppToken(deps.group.appToken) ?? ''
    // Send-only: a bare Web-API client (no Socket Mode, no appToken) wrapped in the
    // AppLike send surface. The event/action/start/stop members are inert — nothing
    // ever registers a handler or opens a socket in this mode.
    // An injected factory wins in BOTH modes: send-only otherwise hard-coded `sendOnlyApp`, whose
    // `auth.test()` reaches Slack, which left injected tests network-dependent on that path.
    this.app = factory
      ? factory({ token: deps.group.botToken, appToken: deps.group.appToken })
      : deps.sendOnly
        ? sendOnlyApp(deps.group.botToken)
        : realSocketModeApp({ token: deps.group.botToken, appToken: deps.group.appToken }, deps.boltDebug)
    this.queue = new PlatformSendQueue(deps.sendIntervalMs ?? 350)
  }

  async start(): Promise<void> {
    const log = this.deps.log
    log?.debug('slack: initializing Bolt authorization…')
    await this.app.init?.()
    log?.debug('slack: auth.test → resolving bot identity (HTTPS)…')
    const auth = await this.app.client.auth.test()
    this.botUserId = auth.user_id ?? ''
    this.botId = auth.bot_id ?? ''
    this.workspaceUrl = auth.url ?? ''
    this.teamId = auth.team_id && /^T[A-Z0-9]+$/.test(auth.team_id) ? auth.team_id : ''
    log?.debug(`slack: auth.test ok → bot user ${this.botUserId} (bot_id ${this.botId || 'n/a'})`)
    // Send-only (shared bot): no Socket Mode socket, no event/action handlers, no
    // app.start(). Identity is resolved above (for mention rendering / echo id); the
    // relay owns inbound. Return before any handler registration.
    if (this.deps.sendOnly) {
      log?.info('slack: send-only connection ready (shared bot — inbound via relay)')
      return
    }
    const deliver = (ev: SlackMessageEvent, kind: string) => {
      if (isSlackSystemMessage(ev) || ev.user === this.botUserId || ev.bot_id === this.botId) return
      const msg = normalizeSlackEvent(this.withAssistantThread(ev), { traceId: this.deps.newTraceId() })
      log?.debug(
        `slack: inbound ${kind} ch=${msg.channel} thread=${msg.thread ?? 'none'} user=${msg.sender.id} isBot=${msg.sender.isBot} isDm=${msg.isDm} mentions=[${msg.mentionedBots.join(',')}] text=${JSON.stringify(msg.text.slice(0, 80))}`
      )
      this.deps.onMessage(msg)
    }
    // message.* events: DMs, and channels the bot reads (needs the matching
    // `message.channels`/`message.groups`/`message.im` bot-event subscriptions).
    this.app.message(async ({ message }) => {
      const ev = message as SlackMessageEvent
      if (ev.type !== 'message' || !ev.channel) {
        log?.debug(
          `slack: inbound event ignored (type=${ev.type}, subtype=${ev.subtype ?? 'none'}, channel=${ev.channel ?? 'none'})`
        )
        return
      }
      // send-message-routing-rework.md §5: edit wrappers stay filtered — EXCEPT the one
      // that closes an agent's logical response. A streamed answer can only be declared
      // complete by editing its last message, so dropping every edit would mean no agent
      // reply could ever be routed. Selective by daemon-written metadata, not by being an
      // edit: a mid-answer `streaming` edit still returns null here.
      const finalization = normalizeSlackResponseFinalization(ev, { traceId: this.deps.newTraceId() })
      if (finalization) {
        log?.debug(
          `slack: inbound response finalization ch=${finalization.channel} thread=${finalization.thread ?? 'none'} ` +
            `author=${finalization.agentAuthorship?.authorAgentId ?? 'unknown'} ` +
            `recipients=[${finalization.agentAuthorship?.mentionedAgentIds.join(',') ?? ''}]`
        )
        this.deps.onMessage(finalization)
        return
      }
      if (!isRoutableMessageEvent(ev)) {
        log?.debug(
          `slack: inbound event ignored (type=${ev.type}, subtype=${ev.subtype ?? 'none'}, channel=${ev.channel})`
        )
        return
      }
      deliver(ev, 'message')
    })
    // app_mention events: fired whenever the bot is @-mentioned (needs only the
    // `app_mentions:read` scope). Dedup against the message.* path happens in the
    // daemon by msgId, since both carry the same channel:ts.
    this.app.event('app_mention', async ({ event }) => {
      const ev = event as SlackMessageEvent
      if (!ev.channel) return
      deliver(ev, 'app_mention')
    })
    // Agent/assistant DM threads expose their canonical thread root through this
    // event. Normal message.im payloads remain the source of user text; this event
    // only preserves routing coordinates for those messages.
    this.app.event('assistant_thread_started', async ({ event }) => {
      const thread = this.rememberAssistantThread(event as AssistantThreadStartedEvent)
      if (thread) log?.debug(`slack: assistant thread started ch=${thread.channel} thread=${thread.threadTs}`)
    })
    // Native stop button, Socket Mode arm. The HTTP arm reaches the same method through the relay.
    this.app.event('agent_session_stopped', async ({ event }) => {
      const ev = event as { channel?: string; thread_ts?: string; user?: string }
      if (!ev.channel || !ev.thread_ts) return
      await this.agentSessionStopped(ev.channel, ev.thread_ts, ev.user)
    })
    // Membership changes: the bot was invited to (member_joined_channel, filtered
    // to our own user id) or removed from (channel_left / group_left) a channel.
    // The daemon re-lists + re-reports the membership snapshot on each fire.
    this.app.event('member_joined_channel', async ({ event }) => {
      const ev = event as { user?: string; channel?: string }
      if (ev.user !== this.botUserId) return
      log?.debug(`slack: bot joined channel ${ev.channel ?? '?'}`)
      this.deps.onChannelsChanged?.()
    })
    for (const type of ['channel_left', 'group_left']) {
      this.app.event(type, async ({ event }) => {
        log?.debug(`slack: bot left channel ${(event as { channel?: string }).channel ?? '?'} (${type})`)
        this.deps.onChannelsChanged?.()
      })
    }
    this.app.shortcut(SLACK_MANAGE_SESSION_SHORTCUT_CALLBACK_ID, async ({ ack, shortcut }) => {
      await ack()
      const triggerId = shortcut.trigger_id
      if (!triggerId) return
      const channel = shortcut.channel?.id
      const thread = shortcut.message?.thread_ts ?? shortcut.message?.ts
      const userId = shortcut.user?.id
      const sessionKey =
        channel && thread && userId ? await this.deps.onMessageShortcut?.({ channel, thread, userId }) : undefined
      await this.openStatusModal(triggerId, sessionKey)
    })
    // Status-bar interactivity (Block Kit block_actions over Socket Mode). Each handler
    // MUST ack() promptly (Slack drops the interaction / trigger_id after ~3s). Configure
    // opens the controls modal; its selects carry the session key in `view.private_metadata`.
    // No-op when interactivity is unsubscribed (the handler never fires).
    this.app.action(STATUS_ACTION.more, async ({ ack, action, body }) => {
      await ack()
      const choice = action.selected_option?.value ? decodeSlackStatusOverflowValue(action.selected_option.value) : null
      const sessionKey = action.block_id ?? choice?.target
      if (!choice || !sessionKey) return
      if (choice.action === 'manage') {
        const triggerId = body?.trigger_id
        if (triggerId) await this.openStatusModal(triggerId, sessionKey)
      } else if (choice.action === 'cancel') {
        this.deps.onStatusAction?.({ kind: 'cancel', sessionKey, actor: actorOf(body) })
      }
    })
    this.app.action(STATUS_ACTION.manage, async ({ ack, action, body }) => {
      await ack()
      const sessionKey = action.value // Configure carries the key
      const triggerId = body?.trigger_id
      if (!sessionKey || !triggerId) return
      await this.openStatusModal(triggerId, sessionKey)
    })
    this.app.action(STATUS_ACTION.setModel, async ({ ack, action, body }) => {
      await ack()
      const sessionKey = body?.view?.private_metadata ?? action.block_id
      const model = action.selected_option?.value
      if (sessionKey && model)
        this.deps.onStatusAction?.({ kind: 'set-model', sessionKey, model, actor: actorOf(body) })
    })
    this.app.action(STATUS_ACTION.setEffort, async ({ ack, action, body }) => {
      await ack()
      const sessionKey = body?.view?.private_metadata ?? action.block_id
      const effort = action.selected_option?.value
      if (sessionKey && effort)
        this.deps.onStatusAction?.({ kind: 'set-effort', sessionKey, effort, actor: actorOf(body) })
    })
    this.app.action(STATUS_ACTION.setPermissionMode, async ({ ack, action, body }) => {
      await ack()
      const sessionKey = body?.view?.private_metadata ?? action.block_id
      const permissionMode = action.selected_option?.value
      if (sessionKey && permissionMode)
        this.deps.onStatusAction?.({ kind: 'set-permission-mode', sessionKey, permissionMode, actor: actorOf(body) })
    })
    this.app.action(STATUS_ACTION.setFast, async ({ ack, action, body }) => {
      await ack()
      const sessionKey = body?.view?.private_metadata ?? action.block_id
      const value = action.selected_option?.value
      if (sessionKey && value)
        this.deps.onStatusAction?.({ kind: 'set-fast', sessionKey, fastMode: value === 'on', actor: actorOf(body) })
    })
    this.app.action(STATUS_ACTION.setOutput, async ({ ack, action, body }) => {
      await ack()
      const sessionKey = body?.view?.private_metadata ?? action.block_id
      const mode = action.selected_option?.value
      if (
        sessionKey &&
        (mode === 'none' || mode === 'minimal' || mode === 'low' || mode === 'medium' || mode === 'high')
      )
        this.deps.onStatusAction?.({ kind: 'set-output', sessionKey, outputMode: mode, actor: actorOf(body) })
    })
    this.app.action(STATUS_ACTION.cancel, async ({ ack, action, body }) => {
      await ack()
      const sessionKey = body?.view?.private_metadata ?? action.value
      if (sessionKey) this.deps.onStatusAction?.({ kind: 'cancel', sessionKey, actor: actorOf(body) })
    })
    this.app.action(STATUS_ACTION.view, async ({ ack }) => {
      await ack() // URL button — the browser follows the link; nothing to do here.
    })
    this.app.action(PERMISSION_UPDATE_ACTION, async ({ ack }) => {
      await ack() // URL button — Slack still sends an interaction payload.
    })
    // Interactive permission card (buildPermissionCard): every option button shares the
    // `ac_perm:<index>` prefix, matched here by RegExp. The chosen requestId+optionId ride
    // the button `value`; the daemon resolves the pending ACP request from them.
    this.app.action(new RegExp(`^${PERMISSION_ACTION_PREFIX}:`), async ({ ack, action, body }) => {
      await ack()
      const decoded = action.value ? decodePermValue(action.value) : null
      if (decoded) this.deps.onPermissionChoice?.({ ...decoded, actor: actorOf(body) })
    })
    // Interactive elicitation card (buildElicitationCard): option buttons share the
    // `ac_elicit:<index>` prefix (value = `<requestId>|<optionValue>`); the Dismiss button
    // is `ac_elicit_dismiss` (value = bare requestId → decline).
    this.app.action(new RegExp(`^${ELICIT_ACTION_PREFIX}:`), async ({ ack, action }) => {
      await ack()
      const decoded = action.value ? decodePermValue(action.value) : null
      if (decoded) this.deps.onElicitChoice?.({ requestId: decoded.requestId, value: decoded.optionId })
    })
    this.app.action(ELICIT_DISMISS_ACTION, async ({ ack, action }) => {
      await ack()
      if (action.value) this.deps.onElicitChoice?.({ requestId: action.value, value: null })
    })
    log?.debug('slack: app.start → opening Socket Mode WebSocket (wss://…slack.com)…')
    await this.app.start()
    log?.debug('slack: app.start resolved → socket established')
  }

  /** Open the existing per-session controls modal. Direct bots call this from their
   *  local Socket Mode action handler; shared bots call it after the relay forwards the
   *  click over `rd/msg(slack_action)`. `privateMetadata` stays opaque to Slack and lets the
   *  relay route subsequent select/cancel interactions back to this daemon. */
  async openStatusModal(triggerId: string, sessionKey?: string, privateMetadata = sessionKey ?? ''): Promise<void> {
    const data = sessionKey ? await this.deps.onStatusInfo?.(sessionKey) : undefined
    try {
      await this.app.client.views.open({
        trigger_id: triggerId,
        view:
          data && sessionKey
            ? buildStatusModal(data.info, sessionKey, data.link, privateMetadata, data.identity)
            : buildStatusUnavailableModal()
      })
    } catch (err) {
      this.deps.log?.debug(`slack: views.open failed: ${(err as Error).message}`)
    }
  }

  private rememberAssistantThread(ev: AssistantThreadStartedEvent): { channel: string; threadTs: string } | null {
    const channel = ev.assistant_thread?.channel_id
    const threadTs = ev.assistant_thread?.thread_ts
    if (!channel || !threadTs) return null
    this.assistantDmThreads.set(channel, threadTs)
    return { channel, threadTs }
  }

  private withAssistantThread(ev: SlackMessageEvent): SlackMessageEvent {
    if (ev.thread_ts || !ev.channel) return ev
    if (ev.channel_type !== 'im' && !ev.channel.startsWith('D')) return ev
    const threadTs = this.assistantDmThreads.get(ev.channel)
    return threadTs ? { ...ev, thread_ts: threadTs } : ev
  }

  private rememberMissingScopes(err: unknown): void {
    const added = missingScopesFrom(err).filter((scope) => {
      if (this.missingScopes.has(scope)) return false
      this.missingScopes.add(scope)
      return true
    })
    if (added.length > 0) this.deps.log?.warn(`slack: bot token missing OAuth scope(s): ${added.join(', ')}`)
  }

  /** The Slack workspace (team) id this connection authenticated into, or ''
   *  before `auth.test` resolves. A DURABLE tenant id — unlike the bot token it
   *  survives credential rotation, which is what session-visibility.md §2
   *  requires of the middle segment of an owner identity. */
  workspaceId(): string {
    return this.teamId
  }

  private permissionUpdateUrl(): string | undefined {
    if (!/^A[A-Z0-9]+$/.test(this.appId)) return undefined
    const appId = encodeURIComponent(this.appId)
    return this.teamId
      ? `https://app.slack.com/app-settings/${encodeURIComponent(this.teamId)}/${appId}/oauth`
      : `https://api.slack.com/apps/${appId}/install-on-team?`
  }

  /** Post the reauthorization notice once with the Slack App identity. */
  private async postPermissionUpdateCard(channel: string, threadTs?: string): Promise<void> {
    if (this.permissionUpdateAnnounced || this.missingScopes.size === 0) return
    const updateUrl = this.permissionUpdateUrl()
    if (!updateUrl) return
    // Claim before the first await so overlapping status/title failures cannot
    // race into duplicate cards. A failed post releases the claim for a later retry.
    this.permissionUpdateAnnounced = true
    const text =
      'Permissions update required. Please update and re-authorize this Slack app to ensure all features work correctly.'
    try {
      const posted = await this.postIfThreadExists(channel, threadTs, {
        channel,
        thread_ts: threadTs,
        text,
        blocks: buildPermissionUpdateCard(updateUrl),
        unfurl_links: false,
        unfurl_media: false,
        metadata: { event_type: SLACK_CHROME_EVENT_TYPE, event_payload: {} }
      })
      if (!posted) this.permissionUpdateAnnounced = false
    } catch (err) {
      this.permissionUpdateAnnounced = false
      this.rememberMissingScopes(err)
      this.deps.log?.debug(`slack: permission update card failed (ch=${channel}): ${(err as Error).message}`)
    }
  }

  /** Post only while a threaded reply's root remains extant. */
  private async postIfThreadExists(
    channel: string,
    threadTs: string | undefined,
    payload: Record<string, unknown>
  ): Promise<{ ts?: string } | undefined> {
    if (threadTs) {
      try {
        await this.app.client.chat.getPermalink({ channel, message_ts: threadTs })
      } catch (err) {
        if (slackApiErrorCode(err) !== 'message_not_found') throw err
        this.deps.log?.info(`slack: skipped reply to deleted root ch=${channel} thread=${threadTs}`)
        return undefined
      }
    }
    return this.app.client.chat.postMessage(payload)
  }

  /** Shared chat.postMessage boundary with optional per-message identity. */
  private async postChatMessage(
    channel: string,
    threadTs: string | undefined,
    payload: Record<string, unknown>,
    options?: SlackPostOptions
  ): Promise<{ ts?: string } | undefined> {
    const customize: Record<string, unknown> = {}
    const username = options?.username?.trim()
    const iconUrl = options?.icon_url?.trim()
    if (username) customize.username = username
    if (iconUrl) customize.icon_url = iconUrl
    try {
      let result: { ts?: string } | undefined
      if (Object.keys(customize).length === 0 || Date.now() < this.customUsernameRetryAt) {
        result = await this.postIfThreadExists(channel, threadTs, payload)
      } else {
        try {
          result = await this.postIfThreadExists(channel, threadTs, { ...payload, ...customize })
          this.customUsernameRetryAt = 0
        } catch (err) {
          this.rememberMissingScopes(err)
          if (!isMissingCustomizeScope(err)) throw err
          this.customUsernameRetryAt = Date.now() + CUSTOM_USERNAME_REPROBE_MS
          this.deps.log?.debug('slack: chat:write.customize missing — retrying with the app default identity')
          result = await this.postIfThreadExists(channel, threadTs, payload)
        }
      }
      await this.postPermissionUpdateCard(channel, threadTs)
      return result
    } catch (err) {
      this.rememberMissingScopes(err)
      await this.postPermissionUpdateCard(channel, threadTs)
      throw err
    }
  }

  async postMessage(
    channel: string,
    text: string,
    threadTs?: string,
    options?: SlackPostOptions
  ): Promise<string | undefined> {
    return this.queue.enqueue(async () => {
      const body = markdownBlock(text)
      const trailing = options?.trailingBlocks
      const res = await this.postChatMessage(
        channel,
        threadTs,
        {
          channel,
          thread_ts: threadTs,
          ...body,
          // A conversational agent message carries its author id; chrome carries a distinct
          // marker so a peer daemon's backfill can skip it. The two are mutually exclusive.
          ...slackMessageMetadata(options),
          ...(trailing?.length
            ? {
                blocks: [...body.blocks, ...trailing],
                unfurl_links: false,
                unfurl_media: false
              }
            : {})
        },
        options
      )
      return res?.ts
    })
  }

  /** Edit a previously-posted message in place (chat.update) — the §9.1 "in-place update"
   *  primitive for the main progress / plan message. Best-effort: swallows errors.
   *  `chrome` / `agentAuthorId` re-stamp metadata: chat.update drops metadata that isn't
   *  re-supplied, so an updated row would otherwise lose its transcript identity. */
  async updateMessage(
    channel: string,
    ts: string,
    text: string,
    chrome = false,
    agentAuthorId?: string
  ): Promise<void> {
    await this.queue.enqueue(async () => {
      try {
        await this.app.client.chat.update({
          channel,
          ts,
          ...markdownBlock(text),
          ...slackMessageMetadata({ chrome, agentAuthorId })
        })
      } catch (err) {
        this.deps.log?.debug(`slack: chat.update failed (ch=${channel} ts=${ts}): ${(err as Error).message}`)
      }
    })
  }

  /** Post an explicit Block Kit message (the interactive status bar) — `text` is the
   *  notification/accessibility fallback. `unfurl_links`/`unfurl_media` are off so the
   *  status bar's "View session" URL doesn't sprout a link-preview card. Returns the ts
   *  for later in-place edits. */
  async postBlocks(
    channel: string,
    blocks: unknown[],
    text: string,
    threadTs?: string,
    options?: SlackPostOptions
  ): Promise<string | undefined> {
    return this.queue.enqueue(async () => {
      const res = await this.postChatMessage(
        channel,
        threadTs,
        {
          channel,
          thread_ts: threadTs,
          text,
          blocks,
          unfurl_links: false,
          unfurl_media: false,
          // Block Kit chrome (status bar, cards) — mark it so the backfill skips it.
          ...slackMessageMetadata(options)
        },
        options
      )
      return res?.ts
    })
  }

  /**
   * Re-stamp an already-posted agent reply as the FINAL event of its logical response
   * (send-message-routing-rework.md §5.5), leaving the visible content byte-identical.
   *
   * A streamed answer is posted before its own text is complete, so the daemon cannot
   * know at post time which message will end up last, nor which agents the COMPLETE
   * response addresses. Both are only knowable at turn finalization — hence one closing
   * edit that flips `delivery_state` to `final` and attaches the recipient set resolved
   * from the whole response. Ingress routes that event and no other, which is what keeps
   * a half-streamed prefix from prompting a peer (§5.4).
   *
   * `blocks` and `text` must be exactly what the message already shows: chat.update
   * REPLACES content, and it also drops any metadata that isn't re-supplied — so the
   * caller passes the content back unchanged and this method re-attaches the full
   * authorship block. Best-effort like the other edits: a failed re-stamp leaves the
   * message `streaming`, which means it is not routed — the safe direction, since the
   * alternative would be routing an answer nobody confirmed was finished.
   */
  async finalizeResponse(
    channel: string,
    ts: string,
    blocks: unknown[],
    text: string,
    agentAuthorId: string,
    response: SlackResponseMetadata
  ): Promise<boolean> {
    try {
      return await this.queue.enqueue(async () => {
        await this.app.client.chat.update({
          channel,
          ts,
          text,
          blocks,
          unfurl_links: false,
          unfurl_media: false,
          ...slackMessageMetadata({ agentAuthorId, response })
        })
        return true
      })
    } catch (err) {
      this.deps.log?.debug(`slack: response finalization failed (ch=${channel} ts=${ts}): ${(err as Error).message}`)
      return false
    }
  }

  /** Edit a previously-posted Block Kit message in place (chat.update). Best-effort;
   *  returns false after logging so footer migration can retry a failed cleanup. `text`
   *  is optional so callers can preserve the original notification fallback. */
  async updateBlocks(
    channel: string,
    ts: string,
    blocks: unknown[],
    text?: string,
    chrome = false,
    agentAuthorId?: string,
    chromeOwnerAgentId?: string
  ): Promise<boolean> {
    try {
      return await this.queue.enqueue(async () => {
        await this.app.client.chat.update({
          channel,
          ts,
          ...(text !== undefined ? { text } : {}),
          blocks,
          unfurl_links: false,
          unfurl_media: false,
          ...slackMessageMetadata({ chrome, agentAuthorId, chromeOwnerAgentId })
        })
        return true
      })
    } catch (err) {
      // Catch both Slack API failures and PlatformSendQueue's outer timeout rejection.
      this.deps.log?.debug(`slack: chat.update (blocks) failed (ch=${channel} ts=${ts}): ${(err as Error).message}`)
      return false
    }
  }

  // ── Native tool-call chrome (slack-streaming-turn-output.md §3) ─────────────
  // One cards-only stream per turn, opened at the turn's first task and settled at its end.
  // All three calls ride the same send queue as every other write, one enqueue each, and
  // none of them calls another from inside a queued task.

  /** Cheap synchronous capability read the daemon builds a turn's converger from (§3.1).
   *  Optimistic by design — `chat.startStream` itself is the authoritative answer. */
  streamingLikely(): boolean {
    return typeof this.app.client.chat.startStream === 'function' && Date.now() >= this.streamingUnavailableUntil
  }

  /**
   * Open this turn's chrome stream. `undefined` means "render chrome the legacy way": the
   * SDK, the workspace, or this channel cannot stream, and §7 has already decided whether
   * that latches the capability off or degrades only this turn.
   *
   * `thread_ts` is REQUIRED — omitting it fails `invalid_thread_ts`, in DMs too (verified
   * live 2026-08-28; the documented "omit for a top-level message" does not hold).
   */
  async startTurnStream(
    channel: string,
    threadTs: string,
    options: { isDm?: boolean; recipientUserId?: string; identity?: SlackPostOptions } = {}
  ): Promise<SlackTurnStream | undefined> {
    const start = this.app.client.chat.startStream
    if (typeof start !== 'function') {
      this.streamingUnavailableUntil = Date.now() + STREAM_REPROBE_MS
      return undefined
    }
    // A DM passes no recipient. Outside one Slack requires a pair, and a turn with no human
    // initiator (agent-to-agent, cron, hook, dream) names the bot itself — accepted live, and
    // it keeps every such turn on the same code path instead of carving it out (§7).
    const recipient = options.isDm ? undefined : options.recipientUserId || this.botUserId
    // The send queue's 30 s timeout rejects while the queued task KEEPS RUNNING, so a rejection
    // here is indeterminate: the open may still land. `opened` carries the task's real answer,
    // so a stream the degraded turn no longer owns is settled instead of working forever.
    let publish: (stream: SlackTurnStream | undefined) => void = () => {}
    const opened = new Promise<SlackTurnStream | undefined>((resolve) => {
      publish = resolve
    })
    return this.queue
      .enqueue(async () => {
        let result: SlackTurnStream | undefined
        try {
          result = await this.openStream(start, channel, threadTs, recipient, options.identity)
          return result
        } finally {
          publish(result)
        }
      })
      .catch(() => {
        void opened.then((late) => {
          if (late) void this.abandonStream(late)
        })
        return undefined
      })
  }

  /** The `chat.startStream` call itself. Runs inside the send queue's task, so it never
   *  enqueues again; the caller owns the timeout semantics. */
  private async openStream(
    start: (a: unknown) => Promise<{ ts?: string }>,
    channel: string,
    threadTs: string,
    recipient: string | undefined,
    identity?: SlackPostOptions
  ): Promise<SlackTurnStream | undefined> {
    // `plan` folds every task card into ONE collapsed-by-default container labelled by the
    // `plan_update` title. `timeline` — the default — renders each card flat and separate.
    const payload: Record<string, unknown> = {
      channel,
      thread_ts: threadTs,
      task_display_mode: 'plan',
      ...(recipient ? { recipient_user_id: recipient } : {}),
      ...(recipient && this.teamId ? { recipient_team_id: this.teamId } : {})
    }
    const decorate = Date.now() >= this.customUsernameRetryAt
    const username = decorate ? identity?.username?.trim() : undefined
    const iconUrl = decorate ? identity?.icon_url?.trim() : undefined
    const customize = { ...(username ? { username } : {}), ...(iconUrl ? { icon_url: iconUrl } : {}) }
    try {
      let res: { ts?: string } | undefined
      try {
        res = await start({ ...payload, ...customize })
        if (Object.keys(customize).length > 0) this.customUsernameRetryAt = 0
      } catch (err) {
        // Same cooldown the post boundary uses: retry undecorated, re-probe in 5 minutes.
        if (Object.keys(customize).length === 0 || !isMissingCustomizeScope(err)) throw err
        this.customUsernameRetryAt = Date.now() + CUSTOM_USERNAME_REPROBE_MS
        this.deps.log?.debug('slack: chat:write.customize missing — streaming with the app default identity')
        res = await start(payload)
      }
      const ts = res?.ts
      if (!ts) {
        this.deps.log?.debug(`slack: chat.startStream returned no ts (ch=${channel} thread=${threadTs})`)
        return undefined
      }
      this.streamingUnavailableUntil = 0
      // Keyed by MESSAGE, not by conversation: same-(channel, thread) sibling turns coexist on
      // one connection, and a conversation key would let the second open orphan the first.
      this.openStreams.add(streamKey(channel, ts))
      return { channel, threadTs, ts }
    } catch (err) {
      this.rememberMissingScopes(err)
      this.noteStreamFailure(err, 'chat.startStream', channel)
      return undefined
    }
  }

  /** Settle and stop a stream no turn owns: the queue timed out on the open, the caller
   *  degraded, and the open landed anyway. Nothing was ever appended, so a bare label is the
   *  whole settle. Best-effort, and an unresolved stop joins the owed-stop sweep. */
  private async abandonStream(stream: SlackTurnStream): Promise<void> {
    this.deps.log?.debug(`slack: settling an unowned stream (ch=${stream.channel} ts=${stream.ts})`)
    await this.settleAndStop(stream, [{ type: 'plan_update', title: STREAM_ABANDONED_TITLE }], {})
  }

  /** Append card chunks to an open stream. A `refused` update is simply lost — chrome is
   *  lossy-tolerant — while `stopped` retires the handle for good. */
  async appendTurnStream(stream: SlackTurnStream, chunks: SlackStreamChunk[]): Promise<SlackStreamAppendOutcome> {
    const append = this.app.client.chat.appendStream
    if (chunks.length === 0) return 'ok'
    if (typeof append !== 'function') return 'refused'
    // The handle is retired, so the message is settled and this append is stale.
    if (!this.openStreams.has(streamKey(stream.channel, stream.ts))) return 'refused'
    try {
      return await this.queue.enqueue(async () => {
        await append({ channel: stream.channel, ts: stream.ts, chunks })
        return 'ok' as const
      })
    } catch (err) {
      this.rememberMissingScopes(err)
      this.noteStreamFailure(err, 'chat.appendStream', stream.channel)
      // Only a DEFINITE already-stopped answer proves the message is settled — in practice
      // the person's Stop. A transient failure leaves it streaming, so the handle stays and
      // the settling stop still has a target.
      if (!isStreamAlreadyStopped(err)) return 'refused'
      this.closeStream(stream)
      return 'stopped'
    }
  }

  /**
   * Settle a stream. Answers whether the message is now DEFINITELY not streaming: true on
   * success, and true when it was already settled. `false` means Slack left it unresolved,
   * which is the caller's cue to keep the handle and let the settlement backstop retry;
   * dropping it there would strand the message streaming.
   *
   * `session_status` is deliberately never passed: its default is already `active`, and the
   * agent-session lifecycle path stays the enum's single writer.
   */
  async stopTurnStream(stream: SlackTurnStream, options: { chromeOwnerAgentId?: string } = {}): Promise<boolean> {
    const stop = this.app.client.chat.stopStream
    // Nothing left to settle: no such method (so no stream was ever opened here) or the handle
    // is already retired. Idempotent by construction — a stopped stream is unrecoverable.
    if (typeof stop !== 'function' || !this.openStreams.has(streamKey(stream.channel, stream.ts))) return true
    try {
      return await this.queue.enqueue(async () => {
        await stop({
          channel: stream.channel,
          ts: stream.ts,
          // chat.startStream carries no metadata, so the chrome marker is stamped here —
          // otherwise a peer's thread backfill would read the finalized card as conversation.
          ...slackMessageMetadata({
            chrome: true,
            ...(options.chromeOwnerAgentId ? { chromeOwnerAgentId: options.chromeOwnerAgentId } : {})
          })
        })
        // Retired only now that Slack has accepted it.
        this.closeStream(stream)
        return true
      })
    } catch (err) {
      this.rememberMissingScopes(err)
      this.noteStreamFailure(err, 'chat.stopStream', stream.channel)
      if (!isStreamAlreadyStopped(err)) return false
      this.closeStream(stream)
      return true
    }
  }

  /**
   * Settle a stream and stop it, as ONE unit, retried until Slack gives a definite answer.
   *
   * The two halves cannot be split: stopping while cards are still `in_progress` makes Slack
   * render the container as "Something went wrong" (§4 fact 3), so a refused settle must hold
   * the stop back. And the turn that owned the stream is gone long before a retry is due —
   * `Pending` is dropped at turn settlement — so the connection owns the retry, on a bounded
   * backoff, keeping the settle content verbatim.
   */
  async settleAndStop(
    stream: SlackTurnStream,
    settle: SlackStreamChunk[],
    options: { chromeOwnerAgentId?: string }
  ): Promise<void> {
    await this.runSettleAndStop(stream, settle, options, 0)
  }

  /** One settle+stop attempt. `attempts` is how many have ALREADY been made, so the backoff
   *  advances across the whole chain rather than restarting on each one. */
  private async runSettleAndStop(
    stream: SlackTurnStream,
    settle: SlackStreamChunk[],
    options: { chromeOwnerAgentId?: string },
    attempts: number
  ): Promise<void> {
    const key = streamKey(stream.channel, stream.ts)
    if (!this.openStreams.has(key)) return this.forgetOwedStop(key)
    if (settle.length > 0) {
      const outcome = await this.appendTurnStream(stream, settle)
      // The person ended it: the message is settled and nothing more is owed.
      if (outcome === 'stopped') return this.forgetOwedStop(key)
      if (outcome === 'refused') return this.scheduleOwedStop(stream, settle, options, attempts)
    }
    if (await this.stopTurnStream(stream, options)) return this.forgetOwedStop(key)
    // Slack left it unresolved: the settle already landed, so only the stop is still owed.
    this.scheduleOwedStop(stream, [], options, attempts)
  }

  /**
   * Re-arm the owed settle+stop on a bounded backoff. A handful of attempts over a few minutes:
   * past that the row is stuck for a reason retrying cannot fix.
   *
   * The attempt count is CARRIED, never read back from `owedStops`: the fired entry is deleted
   * before its retry runs, so recomputing the count from the map would see none and re-arm at
   * the ladder's shortest delay every time — an unbounded 5-second loop against the shared send
   * queue for a refusal that is never going to resolve.
   */
  private scheduleOwedStop(
    stream: SlackTurnStream,
    settle: SlackStreamChunk[],
    options: { chromeOwnerAgentId?: string },
    attempts: number
  ): void {
    const key = streamKey(stream.channel, stream.ts)
    this.forgetOwedStop(key)
    const delay = OWED_STOP_BACKOFF_MS[attempts]
    if (delay === undefined) {
      this.deps.log?.debug(`slack: giving up on an unresolved stream stop (ch=${stream.channel} ts=${stream.ts})`)
      return
    }
    const timer = setTimeout(() => {
      this.owedStops.delete(key)
      void this.runSettleAndStop(stream, settle, options, attempts + 1)
    }, delay)
    timer.unref?.()
    this.owedStops.set(key, { timer })
  }

  private forgetOwedStop(key: string): void {
    const owed = this.owedStops.get(key)
    if (!owed) return
    clearTimeout(owed.timer)
    this.owedStops.delete(key)
  }

  /** A stopped stream is unrecoverable: drop the handle so nothing appends to it and no
   *  second stop is attempted, whoever ended it. */
  private closeStream(stream: SlackTurnStream): void {
    this.openStreams.delete(streamKey(stream.channel, stream.ts))
  }

  /** §7's two error classes. A capability refusal latches streaming off for a re-probe window;
   *  everything else — a bad channel, a rate limit, a queue timeout — degrades only the turn
   *  that hit it, because a per-channel error must never kill streaming workspace-wide. */
  private noteStreamFailure(err: unknown, method: string, channel: string): void {
    if (isStreamAlreadyStopped(err)) return
    const code = slackApiErrorCode(err)
    if (code && STREAM_CAPABILITY_REFUSALS.has(code)) {
      this.streamingUnavailableUntil = Date.now() + STREAM_REPROBE_MS
      this.deps.log?.info(`slack: streaming unavailable (${code}) — using the legacy chrome, re-probing in 5m`)
      return
    }
    this.deps.log?.debug(`slack: ${method} failed (ch=${channel}): ${(err as Error).message}`)
  }

  /** Turn-start acknowledgement (`reactions.add`) on the message that fired the turn.
   *  Best-effort: an `already_reacted` repeat and a workspace whose grant predates
   *  `reactions:write` both degrade to nothing visible. */
  async react(channel: string, messageId: string, intent: PlatformReactionIntent): Promise<void> {
    // The catch is on the ENQUEUE, not just the call: an abandoned queue task rejects too,
    // and this method is never awaited by a caller that could handle it.
    await this.queue
      .enqueue(async () => {
        try {
          await this.app.client.reactions.add({ channel, timestamp: messageId, name: SLACK_REACTION_NAMES[intent] })
        } catch (err) {
          this.rememberMissingScopes(err)
          this.deps.log?.debug(`slack: reactions.add failed (ch=${channel} ts=${messageId}): ${(err as Error).message}`)
        }
      })
      .catch(() => {})
  }

  /** Delete one of this app's own messages. Used when chronological re-anchoring
   *  replaces live chrome with a newer message. Best-effort so a cleanup failure
   *  never interrupts the agent turn. */
  async deleteMessage(channel: string, ts: string): Promise<boolean> {
    try {
      return await this.queue.enqueue(async () => {
        await this.app.client.chat.delete({ channel, ts })
        return true
      })
    } catch (err) {
      this.deps.log?.debug(`slack: chat.delete failed (ch=${channel} ts=${ts}): ${(err as Error).message}`)
      return false
    }
  }

  /**
   * Pull a Slack thread's full history (conversations.replies, cursor-paginated)
   * for §8.4/§9.2 mid-thread context. Returns root + replies in Slack ts order;
   * best-effort (returns what it fetched, [] on error) unless a final-fence caller
   * requests `throwOnError`. Bot/system frames keep their bot_id as the sender so
   * the caller can attribute them.
   */
  async getThreadReplies(
    channel: string,
    threadTs: string,
    maxMessages = 200,
    window?: {
      oldest?: string
      latest?: string
      throwOnError?: boolean
      readState?: { truncated: boolean }
    }
  ): Promise<
    {
      sender: string
      agentAuthorId?: string
      chromeOwnerAgentId?: string
      appId?: string
      ts: string
      text: string
      isBot: boolean
      chrome: boolean
      attachments: Attachment[]
    }[]
  > {
    const out: {
      sender: string
      agentAuthorId?: string
      chromeOwnerAgentId?: string
      appId?: string
      ts: string
      text: string
      isBot: boolean
      chrome: boolean
      attachments: Attachment[]
    }[] = []
    let cursor: string | undefined
    try {
      do {
        const res = await this.app.client.conversations.replies({
          channel,
          ts: threadTs,
          limit: 200,
          // Slack otherwise returns only metadata.event_type and omits the payload
          // that carries the stable agent author id.
          include_all_metadata: true,
          ...(window?.oldest ? { oldest: window.oldest } : {}),
          ...(window?.latest ? { latest: window.latest } : {}),
          // `oldest` is the already-delivered watermark; exclude it. `latest` is a
          // wall-clock cutoff rather than a real message ts, so excluding it is inert.
          ...(window?.oldest || window?.latest ? { inclusive: false } : {}),
          ...(cursor ? { cursor } : {})
        })
        const messages = res.messages ?? []
        for (let index = 0; index < messages.length; index += 1) {
          const m = messages[index]!
          if (!m.ts) continue
          const appId = m.app_id ?? m.bot_profile?.app_id
          const metadataAuthor =
            m.metadata?.event_type === 'agentconnect_thread_event' &&
            typeof m.metadata.event_payload?.author_agent_id === 'string'
              ? m.metadata.event_payload.author_agent_id.trim()
              : ''
          const chromeOwnerAgentId =
            m.metadata?.event_type === SLACK_CHROME_EVENT_TYPE &&
            typeof m.metadata.event_payload?.owner_agent_id === 'string'
              ? m.metadata.event_payload.owner_agent_id.trim()
              : ''
          out.push({
            // Some Slack bot rows expose both `user` and `bot_id`. Keep the stable bot
            // identity as sender so legacy rows from the same app reconcile consistently.
            sender: m.bot_id ?? m.user ?? 'unknown',
            ...(metadataAuthor ? { agentAuthorId: metadataAuthor } : {}),
            ...(chromeOwnerAgentId ? { chromeOwnerAgentId } : {}),
            ...(appId ? { appId } : {}),
            ts: m.ts,
            text: extractSlackMessageText(m),
            isBot: Boolean(m.bot_id || appId),
            // A settled chrome stream carries the marker its stop stamped; one still open
            // carries none, so its `streaming_state` / placeholder body answers for it.
            chrome: m.metadata?.event_type === SLACK_CHROME_EVENT_TYPE || isSlackStreamChromeMessage(m),
            attachments: (m.files ?? [])
              .map(toAttachment)
              .filter((attachment): attachment is NonNullable<typeof attachment> => attachment !== null)
          })
          if (out.length >= maxMessages) {
            if (window?.readState && (index < messages.length - 1 || Boolean(res.has_more))) {
              window.readState.truncated = true
            }
            return out
          }
        }
        cursor = res.has_more ? res.response_metadata?.next_cursor : undefined
      } while (cursor)
    } catch (err) {
      this.deps.log?.debug(
        `slack: conversations.replies failed (ch=${channel} thread=${threadTs}): ${(err as Error).message}`
      )
      if (window?.throwOnError) throw err
    }
    return out
  }

  /** Fetch one bounded, cursor-paginated page of Slack channel messages. */
  async getChannelHistory(
    channel: string,
    options: PlatformChannelHistoryOptions = {}
  ): Promise<PlatformChannelHistoryPage> {
    const limit = Math.min(
      Math.max(options.limit ?? SLACK_CHANNEL_HISTORY_DEFAULT_LIMIT, 1),
      SLACK_CHANNEL_HISTORY_MAX_LIMIT
    )
    const hasTimeBounds = Boolean(options.oldest || options.latest)
    try {
      const res = await this.app.client.conversations.history({
        channel,
        limit,
        ...(options.cursor ? { cursor: options.cursor } : {}),
        ...(options.oldest ? { oldest: options.oldest } : {}),
        ...(options.latest ? { latest: options.latest } : {}),
        ...(hasTimeBounds ? { inclusive: true } : {})
      })
      const nextCursor = res.response_metadata?.next_cursor?.trim() || undefined
      const messages = (res.messages ?? []).flatMap((m) => {
        if (!m.ts) return []
        const appId = m.app_id ?? m.bot_profile?.app_id
        const replyCount = typeof m.reply_count === 'number' && m.reply_count > 0 ? m.reply_count : undefined
        return [
          {
            sender: m.bot_id ?? m.user ?? 'unknown',
            ts: m.ts,
            text: extractSlackMessageText(m),
            isBot: Boolean(m.bot_id || appId),
            ...(m.thread_ts ? { threadTs: m.thread_ts } : {}),
            ...(replyCount !== undefined ? { replyCount } : {})
          }
        ]
      })
      return {
        messages,
        hasMore: Boolean(res.has_more || nextCursor),
        ...(nextCursor ? { nextCursor } : {})
      }
    } catch (err) {
      const code = slackApiErrorCode(err)
      const safeCode = code && /^[a-z0-9._:-]{1,64}$/i.test(code) ? code : undefined
      this.deps.log?.debug('slack: conversations.history failed (ch=' + channel + '): ' + (safeCode ?? 'unknown'))
      throw new Error(safeCode ? 'Slack channel history failed: ' + safeCode : 'Slack channel history failed')
    }
  }

  /**
   * Put a file INTO a conversation — Slack's three-step external upload (`files:write`).
   *
   * `chat.postMessage` cannot carry bytes at all: it can only reference an image by public
   * URL or by the id of a file already hosted in Slack. So the completion call IS the
   * message here — `comment` rides as `initial_comment`, and the agent's conversational
   * identity as username/icon, exactly as {@link postChatMessage} applies it to a text post.
   *
   * `ok: false` means the share FAILED and nothing is in the conversation, with a typed
   * reason — `indeterminate` alone means the queue abandoned a still-running upload that may
   * yet land. Success carries no `messageId`: Slack answers with the file and no ts, so a
   * shared file is the one post kind that cannot anchor a session seed or a paired wake.
   */
  async uploadFile(
    channel: string,
    file: { bytes: Buffer; name: string; mimeType?: string },
    comment?: string,
    anchor?: UploadAnchor,
    options?: SlackPostOptions
  ): Promise<UploadOutcome> {
    const threadTs = anchor?.thread
    const task: Promise<UploadOutcome> = this.queue.enqueue(async () => {
      try {
        // `uploadV2` IS the three-step external upload — reserve a URL, POST the bytes, share
        // the file — and we call it instead of driving those steps ourselves because the
        // middle one is not a Slack API request and its exact wire shape is undocumented.
        // Two live failures came out of reimplementing it (a multipart part Slack answers
        // with HTTP 500 unless it is named `body`, and at least one more), so the transport
        // now belongs to the SDK that Slack maintains, along with the agent/proxy/timeout
        // configuration the rest of this client already got from `WebClient`.
        //
        // The cost is the file share's identity decoration: `completeUploadExternal` accepts
        // `username`/`icon_url` per the docs but not per the SDK's types, and `uploadV2`
        // builds its completion arguments from an explicit key list that omits both. So a
        // shared file posts under the app's identity while the agent's text reply posts under
        // the agent's. That decoration was never verified against live Slack anyway — it was
        // already being dropped on any rejection — so this gives up nothing that worked.
        //
        // Sharing is what makes the file a message; without `channel_id` it stays a private
        // upload nobody can see. `thread_ts` must be the PARENT's ts, never a reply's.
        // A CAPTION IS MRKDWN HERE, unlike every other send in this file. `postMessage`
        // renders through a Block Kit `markdown` block, but the completion step documents
        // `blocks` as IGNORED whenever `initial_comment` is set — and it has no separate
        // `text` argument, so blocks-only would buy CommonMark at the price of the
        // notification preview for every forwarded file. Keeping the comment is the better
        // half of that trade; the cost is that `**bold**` and `[label](url)` read literally.
        // The identity path first: `completeUploadExternal` documents `username`/`icon_url`
        // for the share message, which is the ONLY way a file post can carry the agent's own
        // name and avatar — no manifest field sets an app icon, and `uploadV2` drops both
        // arguments when it builds its completion from an explicit key list.
        const shared = await this.shareWithIdentity(channel, file, comment, threadTs, options)
        if (shared !== undefined) return { ok: true, ...(await this.shareMessageTs(shared, channel)) }
        // Only a refused BYTE POST lands here, and that step runs before anything reaches the
        // conversation — which is what makes retrying through the SDK's own transport safe
        // rather than a double post. It costs the identity; the delivery outranks it.
        this.deps.log?.debug(`slack: uploadFile falling back to the SDK transport for ${file.name}`)
        const done = (await this.app.client.files.uploadV2({
          file: file.bytes,
          filename: file.name,
          channel_id: channel,
          ...(threadTs ? { thread_ts: threadTs } : {}),
          ...(comment ? { initial_comment: comment } : {})
        })) as SlackUploadV2Result
        // `uploadV2` answers with one completion response per file, each carrying the FILE.
        const fileId = done?.files?.[0]?.files?.[0]?.id
        return { ok: true, ...(await this.shareMessageTs(fileId, channel)) }
      } catch (err) {
        this.rememberMissingScopes(err)
        this.deps.log?.debug(`slack: uploadFile ${file.name} → ch=${channel} failed: ${(err as Error).message}`)
        // A share whose outcome Slack never confirmed must say "may have landed", never
        // "nothing was sent" — the same rule the send queue's abandonment already follows.
        // Two things forfeit that proof, and BOTH have to be read here: a completion Slack
        // marked as possibly-partial (`completeShare` stamps it), and any failure with no
        // provider code at all — the SDK raises one `WebAPIHTTPError` for every non-200, so a
        // rejected byte POST and a lost response to an accepted share look identical.
        const mayHaveLanded = (err as { shareMayHaveLanded?: unknown } | null)?.shareMayHaveLanded === true
        return !mayHaveLanded && slackApiErrorCode(err) !== undefined
          ? { ok: false, reason: classifySlackUploadError(err), ...slackErrorDetail(err) }
          : { ok: false, reason: 'indeterminate', ...slackErrorDetail(err) }
      }
    })
    // The queue abandons a task at 30 s but the task KEEPS RUNNING — the share may still
    // land, so this must not read as "nothing was sent" (a retry would double-post).
    return task.catch((err) => ({
      ok: false,
      reason: isSendQueueTimeout(err) ? 'indeterminate' : 'platform_error'
    }))
  }

  /**
   * Steps 1-3 with the agent's identity on the share. Returns the file id once the share is
   * PUBLISHED, or `undefined` when the byte POST was refused — the one failure that provably
   * happened before anything reached the conversation, which is what lets the caller retry
   * through the SDK. Every later failure throws, because it may have landed.
   */
  private async shareWithIdentity(
    channel: string,
    file: { bytes: Buffer; name: string },
    comment: string | undefined,
    threadTs: string | undefined,
    options?: SlackPostOptions
  ): Promise<string | undefined> {
    const reserved = await this.app.client.files.getUploadURLExternal({
      filename: file.name,
      length: file.bytes.byteLength
    })
    const uploadUrl = reserved.upload_url
    const fileId = reserved.file_id
    if (!uploadUrl || !fileId) return undefined
    if (!(await this.putUploadBytes(uploadUrl, file))) return undefined
    // Sharing is what makes the file a message; without `channel_id` it stays a private
    // upload nobody can see. `thread_ts` must be the PARENT's ts, never a reply's.
    // A CAPTION IS MRKDWN HERE, unlike every other send in this file: this method documents
    // `blocks` as IGNORED whenever `initial_comment` is set and has no separate `text`
    // argument, so blocks-only would buy CommonMark at the price of the notification preview.
    await this.completeUpload(
      {
        files: [{ id: fileId, title: file.name }],
        channel_id: channel,
        ...(threadTs ? { thread_ts: threadTs } : {}),
        ...(comment ? { initial_comment: comment } : {})
      },
      options
    )
    return fileId
  }

  /**
   * Step 2: POST the bytes to the reserved URL. Not a Slack API endpoint — no JSON envelope,
   * no published wire contract — so it goes out through undici with the same proxy dispatcher
   * the Web API client uses. Every field here is copied from what the SDK sends, because two
   * live failures came out of choosing any of them differently: the multipart part is named
   * `body` and carries an untyped Blob, and the reserved URL is given the bot token. That
   * last one is not optional despite reading like it should be — a POST without it is
   * answered with HTTP 500. Returns false rather than throwing: nothing is published yet, so
   * the caller may still fall back.
   */
  private async putUploadBytes(uploadUrl: string, file: { bytes: Buffer; name: string }): Promise<boolean> {
    const form = new FormData()
    form.append('body', new Blob([new Uint8Array(file.bytes)]), file.name)
    const dispatcher = proxyDispatcher()
    try {
      // Same cast seam as `fetchWithDispatcher`: undici's own FormData/RequestInit types and
      // the Node globals are structurally identical but nominally distinct.
      const init = {
        method: 'POST',
        body: form,
        headers: { Authorization: `Bearer ${this.deps.group.botToken}` },
        signal: AbortSignal.timeout(SLACK_API_TIMEOUT_MS),
        ...(dispatcher ? { dispatcher } : {})
      }
      const res = await undiciFetch(uploadUrl, init as Parameters<typeof undiciFetch>[1])
      // An unread body leaves the request in flight, and the graceful close below waits for
      // exactly that — outside the signal's reach.
      await res.body?.cancel().catch(() => {})
      if (!res.ok) this.deps.log?.debug(`slack: uploadFile byte POST for ${file.name} → HTTP ${res.status}`)
      return res.ok
    } catch (err) {
      this.deps.log?.debug(`slack: uploadFile byte POST for ${file.name} failed: ${(err as Error).message}`)
      return false
    } finally {
      // Unlike the two long-lived clients this agent serves one request; closing it keeps a
      // proxied deployment from leaking a keep-alive socket pool per share.
      await dispatcher?.close()
    }
  }

  /** `completeUploadExternal` is ONE-SHOT — a second call after a lost response would double
   *  post — so any outcome that does not PROVE a refusal is marked ambiguous, not retried.
   *  A lost response is one such outcome; so is Slack answering with a partial-success code. */
  private async completeShare(payload: Record<string, unknown>): Promise<void> {
    try {
      await this.app.client.files.completeUploadExternal(payload)
    } catch (err) {
      const code = slackApiErrorCode(err)
      if (code === undefined || COMPLETION_MAY_HAVE_LANDED.has(code)) {
        throw Object.assign(err as Error, { shareMayHaveLanded: true })
      }
      throw err
    }
  }

  /** Step 3. The identity decoration is BEST-EFFORT: `username`/`icon_url` are documented for
   *  this method but absent from the SDK's argument type, so a rejection can be the arguments
   *  rather than the `chat:write.customize` scope. Any DEFINITE refusal is retried once
   *  undecorated — the file lands either way, and the agent's name on it is what we can lose. */
  private async completeUpload(share: Record<string, unknown>, options?: SlackPostOptions): Promise<void> {
    const customize: Record<string, unknown> = {}
    const username = options?.username?.trim()
    const iconUrl = options?.icon_url?.trim()
    if (username) customize.username = username
    if (iconUrl) customize.icon_url = iconUrl
    if (Object.keys(customize).length === 0 || Date.now() < this.customUsernameRetryAt) {
      await this.completeShare(share)
      return
    }
    try {
      await this.completeShare({ ...share, ...customize })
      this.customUsernameRetryAt = 0
    } catch (err) {
      this.rememberMissingScopes(err)
      // A second completion is only safe when the FIRST provably published nothing and the
      // decoration is what it refused — anything else is re-sending a share that may already
      // be visible, which is the double post this whole vocabulary exists to prevent.
      const code = slackApiErrorCode(err)
      if (code === undefined || !DECORATION_REFUSALS.has(code)) throw err
      if (isMissingCustomizeScope(err)) this.customUsernameRetryAt = Date.now() + CUSTOM_USERNAME_REPROBE_MS
      this.deps.log?.debug(`slack: decorated file share refused (${code}) — retrying under the app identity`)
      await this.completeShare(share)
    }
  }

  /**
   * The ts of the message a shared file became. Slack's completion answers with the FILE, not
   * the message, so a share has no timestamp of its own — and a post the daemon cannot name is
   * not an ANCHOR: replying under it lands in a thread whose root the daemon does not
   * recognize as its own, so the reply wakes nobody. `files.info` publishes the share record
   * that does carry the ts, which is why the file post costs one extra read.
   *
   * Best-effort by construction: the file is already in the conversation by the time this
   * runs, so a failure here must degrade to an unanchored share, never to a failed one.
   */
  private async shareMessageTs(fileId: string | undefined, channel: string): Promise<{ messageId?: string }> {
    if (!fileId) return {}
    try {
      const info = await this.app.client.files.info({ file: fileId })
      const shares = info.file?.shares
      // A share is filed under the channel's own visibility, so read both arms by channel id.
      const ts = (shares?.public?.[channel] ?? shares?.private?.[channel])?.[0]?.ts
      if (!ts) this.deps.log?.debug(`slack: uploadFile share of ${fileId} carried no ts for ${channel}`)
      return ts ? { messageId: ts } : {}
    } catch (err) {
      this.deps.log?.debug(`slack: uploadFile could not read the share ts of ${fileId}: ${(err as Error).message}`)
      return {}
    }
  }

  /**
   * Download an auth-gated Slack file (url_private[_download]) with the bot token,
   * up to `maxBytes` (bounds daemon RSS + the inlined prompt frame). Returns the
   * bytes, or null on any failure / over-cap (best-effort — a failed or oversized
   * attachment degrades to a resource_link, never breaks the prompt). §9.2: bytes
   * stay daemon-local.
   */
  async downloadFile(sourceUrl: string, maxBytes = 8 * 1024 * 1024): Promise<Buffer | null> {
    let url: URL
    try {
      url = new URL(sourceUrl)
    } catch {
      this.deps.log?.debug('slack: downloadFile rejected an invalid file URL')
      return null
    }
    if (url.protocol !== 'https:' || url.origin !== SLACK_FILE_ORIGIN || url.username || url.password) {
      this.deps.log?.debug('slack: downloadFile rejected a non-Slack file URL')
      return null
    }

    try {
      const res = await fetch(url.href, {
        headers: { Authorization: `Bearer ${this.deps.group.botToken}` },
        redirect: 'error'
      })
      if (!res.ok) {
        this.deps.log?.debug(`slack: downloadFile ${url.href} → HTTP ${res.status}`)
        return null
      }
      const declared = Number(res.headers.get('content-length'))
      if (Number.isFinite(declared) && declared > maxBytes) {
        this.deps.log?.debug(`slack: downloadFile ${url.href} skipped — ${declared} bytes > cap ${maxBytes}`)
        return null
      }
      // An unauthorized url_private fetch is redirected to an HTML login page
      // (HTTP 200, text/html) rather than 401 — never mistake that for the file.
      const ctype = res.headers.get('content-type') ?? ''
      if (ctype.includes('text/html')) {
        this.deps.log?.debug(`slack: downloadFile ${url.href} got text/html (login page?) — treating as inaccessible`)
        return null
      }
      // Defensively bound the read even when content-length is absent/untrustworthy.
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.byteLength > maxBytes) {
        this.deps.log?.debug(`slack: downloadFile ${url.href} discarded — ${buf.byteLength} bytes > cap ${maxBytes}`)
        return null
      }
      return buf
    } catch (err) {
      this.deps.log?.debug(`slack: downloadFile ${url.href} failed: ${(err as Error).message}`)
      return null
    }
  }

  // ── MCP MessageGateway: read helpers backing the injected channel tools ──

  /** Open or reuse the app's actual DM with one Slack member. Passing a U… id
   * directly to chat.postMessage while customizing the agent identity makes Slack
   * deliver through its notification-only USLACK conversation instead. */
  async openDirectMessage(user: string): Promise<string> {
    const res = await this.app.client.conversations.open({ users: user })
    const channel = res.channel?.id
    if (!channel) throw new Error('Slack conversations.open did not return a direct-message channel')
    return channel
  }

  async getChannelInfo(
    channel: string
  ): Promise<{ id: string; name?: string; isIm?: boolean; isMpim?: boolean; isPrivate?: boolean; user?: string }> {
    const res = await this.app.client.conversations.info({ channel })
    const c = res.channel ?? {}
    // `user` is the DM counterpart — only set on im ("D…") conversations. `is_mpim`
    // marks a multi-person DM, which shares the "G…" id space with legacy private
    // channels and so cannot be told apart from the id alone.
    return {
      id: c.id ?? channel,
      name: c.name,
      isIm: c.is_im,
      isMpim: c.is_mpim,
      isPrivate: c.is_private,
      user: c.user
    }
  }

  async listMembers(channel: string): Promise<{ id: string; name?: string; isBot?: boolean }[]> {
    const res = await this.app.client.conversations.members({ channel, limit: 200 })
    const ids = (res.members ?? []).slice(0, MEMBER_ENRICH_CAP)
    return Promise.all(
      ids.map((id) =>
        this.getUserProfile(id)
          .then((p) => ({ id: p.id, name: p.name, isBot: p.isBot }))
          .catch(() => ({ id }))
      )
    )
  }

  /**
   * The channels this bot is a MEMBER of (users.conversations, cursor-paginated) —
   * the membership snapshot behind the console's per-channel trigger config. DMs /
   * group DMs are excluded (they are not configurable channels). Returns null on
   * any API failure so the caller never mistakes an error for "left all channels".
   */
  async listBotChannels(): Promise<{ id: string; name?: string; isPrivate?: boolean }[] | null> {
    const out: { id: string; name?: string; isPrivate?: boolean }[] = []
    let cursor: string | undefined
    try {
      do {
        const res = await this.app.client.users.conversations({
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 200,
          ...(cursor ? { cursor } : {})
        })
        for (const c of res.channels ?? []) {
          if (!c.id || c.is_im || c.is_mpim) continue
          out.push({ id: c.id, ...(c.name ? { name: c.name } : {}), ...(c.is_private ? { isPrivate: true } : {}) })
        }
        cursor = res.response_metadata?.next_cursor || undefined
      } while (cursor)
    } catch (err) {
      this.deps.log?.debug(`slack: users.conversations failed: ${(err as Error).message}`)
      return null
    }
    return out
  }

  async listChannels(): Promise<{ id: string; name?: string; isPrivate?: boolean }[]> {
    const channels = await this.listBotChannels()
    if (!channels) throw new Error('failed to list Slack channels for bot membership')
    return channels
  }

  /**
   * Leave one channel (`conversations.leave`). THROWS the platform's own refusal —
   * a missing scope, `last_member`, an archived channel — because the caller relays
   * it to the operator verbatim; swallowing it here would report a silent success
   * for a bot that is demonstrably still in the channel.
   *
   * Needs a WRITE scope (`channels:manage` / `groups:write`), unlike everything else
   * this adapter does. Slack emits `channel_left` / `group_left` afterwards, which
   * re-lists membership and retires the row on its own — so this method deliberately
   * reports nothing about the channel set.
   */
  async leaveChannel(channel: string): Promise<void> {
    await this.app.client.conversations.leave({ channel })
    this.deps.log?.debug(`slack: left channel ${channel}`)
  }

  async getUserProfile(
    user: string
  ): Promise<{ id: string; name?: string; realName?: string; isBot?: boolean; avatarUrl?: string }> {
    const res = await this.app.client.users.info({ user })
    const u = res.user ?? {}
    return {
      id: u.id ?? user,
      name: u.name,
      realName: u.real_name ?? u.profile?.real_name,
      isBot: u.is_bot,
      avatarUrl: u.profile?.image_72 ?? u.profile?.image_48
    }
  }

  // ── MCP MessageGateway: the agent-callable ACTIONS (mcp/ops/platform-actions.ts) ──
  //
  // Unlike the chrome above, every one of these is something the AGENT asked for, so each
  // reports Slack's own refusal instead of degrading quietly: `missing_scope` on a workspace
  // that installed before the capability scopes existed is the message the agent must see.

  // ── bookmarks ───────────────────────────────────────────────────────────────────
  async listBookmarks(channel: string): Promise<PlatformBookmark[]> {
    try {
      const res = await this.app.client.bookmarks.list({ channel_id: channel })
      return (res.bookmarks ?? []).map((b) => ({
        id: b.id ?? '',
        title: b.title ?? '',
        ...(b.link ? { link: b.link } : {}),
        ...(b.emoji ? { emoji: b.emoji } : {})
      }))
    } catch (err) {
      throw this.toolFailure(err, 'listing bookmarks')
    }
  }

  async addBookmark(channel: string, spec: { title: string; link: string; emoji?: string }): Promise<PlatformBookmark> {
    try {
      // `type: 'link'` is the only kind an agent can meaningfully create; the others name
      // existing Slack entities and would need an id the model has no way to hold.
      const res = await this.app.client.bookmarks.add({
        channel_id: channel,
        title: spec.title,
        type: 'link',
        link: spec.link,
        ...(spec.emoji ? { emoji: spec.emoji } : {})
      })
      const b = res.bookmark ?? {}
      return {
        id: b.id ?? '',
        title: b.title ?? spec.title,
        ...((b.link ?? spec.link) ? { link: b.link ?? spec.link } : {}),
        ...(b.emoji ? { emoji: b.emoji } : {})
      }
    } catch (err) {
      throw this.toolFailure(err, 'adding a bookmark')
    }
  }

  async removeBookmark(channel: string, bookmarkId: string): Promise<void> {
    try {
      await this.app.client.bookmarks.remove({ channel_id: channel, bookmark_id: bookmarkId })
    } catch (err) {
      throw this.toolFailure(err, 'removing a bookmark')
    }
  }

  // ── lists ───────────────────────────────────────────────────────────────────────
  /**
   * One page of a list, WITH its columns.
   *
   * Slack publishes no schema read for a list, and a write needs `column_id` plus a value
   * keyed by that column's TYPE. Both are only observable on rows that already exist, so the
   * columns are derived from the page and returned alongside it — same shape as the canvas
   * section ids, and for the same reason: the write is unusable without the read.
   */
  async readList(listId: string, options: { cursor?: string; limit?: number } = {}): Promise<PlatformListPage> {
    try {
      const res = await this.app.client.slackLists.items.list({
        list_id: listId,
        // `include_list` returns the parent's COLUMN SCHEMA — authoritative, and the only view
        // that shows a column no row has filled in yet.
        include_list: true,
        ...(options.cursor ? { cursor: options.cursor } : {}),
        ...(options.limit !== undefined ? { limit: options.limit } : {})
      })
      const rows = res.items ?? []
      const columns = new Map<string, PlatformListColumn>()
      for (const c of res.list?.columns ?? []) {
        const id = c.id ?? c.key
        if (!id || !c.type) continue
        const write = LIST_WRITE_KEY_BY_TYPE[c.type]
        columns.set(id, {
          id,
          type: write ?? c.type,
          ...(c.name ? { name: c.name } : {}),
          ...(write === null ? { readOnly: true } : {})
        })
      }
      const items: PlatformListItem[] = rows.map((row) => {
        const fields: Record<string, unknown> = {}
        for (const f of row.fields ?? []) {
          const id = f.column_id
          if (!id) continue
          // A field carries `key`, `value` and often `text` ALONGSIDE the typed property, so the
          // type is the one key that is a known type name. Taking the first non-`column_id`
          // property returns `key` and reports a type the write endpoints reject.
          const seen = LIST_FIELD_TYPES.find((t) => f[t] !== undefined)
          // Through the same table: a `text` value read off a response still means the column
          // is written as `rich_text`.
          const type = seen ? (LIST_WRITE_KEY_BY_TYPE[seen] ?? seen) : undefined
          if (type && !columns.has(id)) columns.set(id, { id, type })
          fields[id] = seen ? f[seen] : f.value
        }
        return { id: row.id ?? '', fields }
      })
      return {
        columns: [...columns.values()],
        items,
        ...(res.response_metadata?.next_cursor?.trim() ? { nextCursor: res.response_metadata.next_cursor.trim() } : {})
      }
    } catch (err) {
      throw this.toolFailure(err, 'reading a list')
    }
  }

  async addListItem(listId: string, fields: PlatformListFieldWrite[]): Promise<PlatformListItem> {
    try {
      const res = await this.app.client.slackLists.items.create({
        list_id: listId,
        initial_fields: fields.map((f) => ({ column_id: f.columnId, [f.type]: f.value }))
      })
      return { id: res.item?.id ?? '', fields: Object.fromEntries(fields.map((f) => [f.columnId, f.value])) }
    } catch (err) {
      throw this.toolFailure(err, 'adding a list item')
    }
  }

  async updateListItem(listId: string, itemId: string, fields: PlatformListFieldWrite[]): Promise<void> {
    try {
      await this.app.client.slackLists.items.update({
        // The row is named PER CELL: `slackLists.items.update` takes no top-level id, and a cell
        // without `row_id` is refused with `row_id_not_provided`.
        list_id: listId,
        cells: fields.map((f) => ({ row_id: itemId, column_id: f.columnId, [f.type]: f.value }))
      })
    } catch (err) {
      throw this.toolFailure(err, 'updating a list item')
    }
  }

  /** Slack's error code for one agent-visible failure, sanitized before it reaches a model. */
  private toolFailure(err: unknown, what: string): Error {
    this.rememberMissingScopes(err)
    const code = slackApiErrorCode(err)
    const safeCode = code && /^[a-z0-9._:-]{1,64}$/i.test(code) ? code : undefined
    this.deps.log?.debug(`slack: ${what} failed: ${safeCode ?? (err as Error).message}`)
    return new Error(safeCode ? `Slack ${what} failed: ${safeCode}` : `Slack ${what} failed`)
  }

  /** An arbitrary reaction the agent chose, as opposed to {@link react}'s turn-start intent.
   *  Needs `reactions:write`, which every installation already grants. */
  async addReaction(channel: string, messageTs: string, emoji: string): Promise<void> {
    try {
      await this.queue.enqueue(() => this.app.client.reactions.add({ channel, timestamp: messageTs, name: emoji }))
    } catch (err) {
      // The queue abandoning a still-running call means the reaction MAY have landed, so
      // this must not read as "nothing happened" — the same rule uploadFile follows.
      if (isSendQueueTimeout(err)) throw new Error('Slack did not answer in time — the reaction may still have landed')
      // A repeat of the same emoji is the state the caller asked for, not a failure.
      if (slackApiErrorCode(err) === 'already_reacted') return
      throw this.toolFailure(err, 'adding a reaction')
    }
  }

  /** The reactions on one message (`reactions.get`, `reactions:read`). */
  async getReactions(channel: string, messageTs: string): Promise<PlatformReactionSummary[]> {
    try {
      const res = await this.app.client.reactions.get({ channel, timestamp: messageTs, full: true })
      const reactions = res.message?.reactions ?? []
      return reactions.flatMap((r) =>
        r.name ? [{ name: r.name, count: r.count ?? 0, ...(r.users ? { users: r.users } : {}) }] : []
      )
    } catch (err) {
      throw this.toolFailure(err, 'reading reactions')
    }
  }

  /**
   * Create a channel, or open the direct conversation with a set of users.
   *
   * Two Slack methods behind one member: `conversations.create` for a named channel
   * (`channels:manage` / `groups:write`) and `conversations.open` for a 1:1 or group DM
   * (`im:write` / `mpim:write`). Inviting people into a NEW channel is a second call, and it
   * is best-effort on purpose — the channel exists either way, and reporting it as a failure
   * would invite a retry that then trips `name_taken`.
   */
  async createConversation(spec: PlatformConversationSpec): Promise<PlatformChannelInfo> {
    const users = spec.users ?? []
    if (!spec.name) {
      try {
        const res = await this.app.client.conversations.open({ users: users.join(','), return_im: true })
        const c = res.channel ?? {}
        if (!c.id) throw new Error('Slack conversations.open returned no conversation')
        return { id: c.id, ...(c.name ? { name: c.name } : {}), isIm: c.is_im, isMpim: c.is_mpim }
      } catch (err) {
        throw this.toolFailure(err, 'opening a conversation')
      }
    }
    let created: { id?: string; name?: string; is_private?: boolean }
    try {
      const res = await this.app.client.conversations.create({
        name: spec.name,
        ...(spec.isPrivate !== undefined ? { is_private: spec.isPrivate } : {})
      })
      created = res.channel ?? {}
    } catch (err) {
      throw this.toolFailure(err, 'creating a channel')
    }
    if (!created.id) throw new Error('Slack conversations.create returned no channel')
    if (users.length > 0) {
      try {
        await this.app.client.conversations.invite({ channel: created.id, users: users.join(',') })
      } catch (err) {
        this.deps.log?.debug(`slack: conversations.invite failed (ch=${created.id}): ${(err as Error).message}`)
      }
    }
    return { id: created.id, ...(created.name ? { name: created.name } : {}), isPrivate: created.is_private }
  }

  /** Hand Slack a message to post later (`chat.scheduleMessage`, `chat:write`). Slack takes no
   *  `username`/`icon_url` here, so the post wears the bare app identity, not the agent's. */
  async scheduleMessage(channel: string, text: string, postAt: number): Promise<PlatformScheduledMessage> {
    try {
      const res = await this.queue.enqueue(() =>
        this.app.client.chat.scheduleMessage({ channel, text, post_at: postAt })
      )
      const id = res.scheduled_message_id
      if (!id) throw new Error('Slack chat.scheduleMessage returned no scheduled_message_id')
      return { id, channel: res.channel ?? channel, postAt }
    } catch (err) {
      if (isSendQueueTimeout(err))
        throw new Error('Slack did not answer in time — the message may still have been scheduled; do not retry')
      throw this.toolFailure(err, 'scheduling a message')
    }
  }

  /** Create a canvas (`canvases:write`). With a channel it is tabbed onto that conversation,
   *  which is also the only shape a free workspace can create at all. */
  async createCanvas(title: string, markdown: string, channel?: string): Promise<PlatformCanvas> {
    const document_content = { type: 'markdown' as const, markdown }
    try {
      const res = channel
        ? await this.app.client.conversations.canvases.create({ channel_id: channel, title, document_content })
        : await this.app.client.canvases.create({ title, document_content })
      const id = res.canvas_id
      if (!id) throw new Error('Slack canvas creation returned no canvas_id')
      return { id, title, ...(await this.canvasLink(id)) }
    } catch (err) {
      throw this.toolFailure(err, 'creating a canvas')
    }
  }

  /**
   * Read a canvas back.
   *
   * Slack publishes NO full-content read: `canvases:read` buys `canvases.sections.lookup`,
   * which answers with section ids and no text. So the body is fetched the way any other
   * Slack file is — `files.info` for the private URL, then the credentialed download this
   * connection already performs — and is simply ABSENT when that path does not serve text.
   * The metadata and the section anchors an edit needs are always returned.
   */
  async readCanvas(canvasId: string): Promise<PlatformCanvas> {
    let file: { title?: string; permalink?: string; url_private?: string }
    try {
      const res = await this.app.client.files.info({ file: canvasId })
      file = res.file ?? {}
    } catch (err) {
      throw this.toolFailure(err, 'reading a canvas')
    }
    const sections = await this.canvasSections(canvasId)
    const bytes = file.url_private ? await this.downloadFile(file.url_private) : null
    return {
      id: canvasId,
      ...(file.title ? { title: file.title } : {}),
      ...(file.permalink ? { url: file.permalink } : {}),
      ...(bytes ? { markdown: bytes.toString('utf8') } : {}),
      ...(sections ? { sections } : {})
    }
  }

  /** Apply edits to a canvas (`canvases.edit`, `canvases:write`). */
  async updateCanvas(canvasId: string, edits: PlatformCanvasEdit[]): Promise<void> {
    const changes = edits.map((edit) => ({
      operation: edit.operation,
      ...(edit.sectionId ? { section_id: edit.sectionId } : {}),
      ...(edit.markdown !== undefined
        ? { document_content: { type: 'markdown' as const, markdown: edit.markdown } }
        : {})
    }))
    try {
      await this.app.client.canvases.edit({ canvas_id: canvasId, changes })
    } catch (err) {
      throw this.toolFailure(err, 'updating a canvas')
    }
  }

  /** A canvas's shareable link, from the file record Slack creates for it. Best-effort: a
   *  canvas that exists is still worth returning without one. */
  private async canvasLink(canvasId: string): Promise<{ url?: string }> {
    try {
      const res = await this.app.client.files.info({ file: canvasId })
      return res.file?.permalink ? { url: res.file.permalink } : {}
    } catch (err) {
      this.deps.log?.debug(`slack: files.info for canvas ${canvasId} failed: ${(err as Error).message}`)
      return {}
    }
  }

  /**
   * The addressable sections of a canvas, or undefined when the workspace did not grant
   * `canvases:read` — the edit anchors are then unknown, not an error.
   *
   * HEADINGS ONLY, and that is the public API's ceiling rather than a choice: `criteria` is
   * required and its `section_types` vocabulary is `any_header|h1|h2|h3`, so there is no
   * request that returns every section. The ids are also invalidated by each edit, which is
   * why `readCanvas` is documented as a call to make immediately before `updateCanvas`.
   */
  private async canvasSections(canvasId: string): Promise<{ id: string }[] | undefined> {
    try {
      const res = await this.app.client.canvases.sections.lookup({
        canvas_id: canvasId,
        criteria: { section_types: ['any_header'] }
      })
      return (res.sections ?? []).flatMap((s) => (s.id ? [{ id: s.id }] : []))
    } catch (err) {
      this.rememberMissingScopes(err)
      this.deps.log?.debug(`slack: canvases.sections.lookup failed (${canvasId}): ${(err as Error).message}`)
      return undefined
    }
  }

  /** Best-effort working indicator: the agent-session lifecycle enum. A non-empty `status`
   *  marks the session `processing` (Slack renders "is working…" + the Stop control in the
   *  DM container) under the acting agent's identity; '' marks it `active`. The text itself
   *  is never displayed — Slack's enum API takes no custom text. Never throws into dispatch. */
  async setStatus(channel: string, threadTs: string, status: string, options?: SlackStatusOptions): Promise<void> {
    await this.queue.enqueue(() =>
      this.setSessionLifecycle(channel, threadTs, status ? 'processing' : 'active', options)
    )
  }

  /** The native Stop. Socket arm — the daemon holding this socket owns every turn the bot runs,
   *  so the stop targets the turn the user is looking at: the slot's displayed owner (the last
   *  `processing` writer), falling back to the thread's newest addressable session. Settlement
   *  is the daemon's: a surviving sibling's `processing` takes the row over (Slack resolves the
   *  transient "Stopping…" into it), and only an empty thread transitions to `active` — Slack
   *  leaves the session in `processing` on its own.
   *  Relay-forwarded arm (send-only): the same event reaches EVERY participant daemon and
   *  per-daemon survivor settlement could disagree — one daemon's `active` racing another's
   *  `processing` re-assert for Slack's one global slot. Until displayed ownership has a
   *  cross-daemon authority, this arm keeps the globally consistent all-stop: every local turn
   *  cancels and every daemon's final write is `active`. */
  async agentSessionStopped(channel: string, threadTs: string, userId?: string): Promise<void> {
    this.deps.log?.debug(`slack: agent session stopped ch=${channel} thread=${threadTs} user=${userId ?? '?'}`)
    if (this.deps.sendOnly) {
      const sessionKeys = (await this.deps.onThreadSessions?.({ channel, thread: threadTs })) ?? []
      for (const sessionKey of sessionKeys)
        this.deps.onStatusAction?.({ kind: 'cancel', sessionKey, ...(userId ? { actor: { userId } } : {}) })
      await this.queue.enqueue(() => this.setSessionLifecycle(channel, threadTs, 'active'))
      return
    }
    const displayed = this.slotOwner.get(`${channel}:${threadTs}`)
    const target = displayed ?? (await this.deps.onThreadSessions?.({ channel, thread: threadTs }))?.[0]
    if (target)
      this.deps.onStatusAction?.({ kind: 'cancel', sessionKey: target, ...(userId ? { actor: { userId } } : {}) })
    this.deps.onSlotSettle?.({ channel, thread: threadTs, ...(target ? { exclude: target } : {}) })
  }

  // The lifecycle half of setStatus. Posting a message does NOT end the loading UX — only `active` does.
  // Deduped per (channel, thread) INCLUDING the identity, so a same-state write from a different
  // agent still refires — Slack keeps username/icon sticky on the session until rewritten.
  private async setSessionLifecycle(
    channel: string,
    threadTs: string,
    status: 'processing' | 'active',
    options?: SlackStatusOptions
  ): Promise<void> {
    const key = `${channel}:${threadTs}`
    const username = status === 'processing' && !this.statusIdentityUnsupported ? options?.username?.trim() : undefined
    const iconUrl = status === 'processing' && !this.statusIdentityUnsupported ? options?.icon_url?.trim() : undefined
    // The owner joins the dedupe key: an identity-identical handover between two turns must
    // still refire, or the slot's displayed owner would keep pointing the Stop at the old one.
    const signature = `${status}|${username ?? ''}|${iconUrl ?? ''}|${options?.sessionKey ?? ''}`
    if (this.sessionLifecycle.get(key) === signature) return
    try {
      await this.app.client.agents.sessions.setStatus({
        channel_id: channel,
        thread_ts: threadTs,
        status,
        ...(username ? { username } : {}),
        ...(iconUrl ? { icon_url: iconUrl } : {})
      })
      this.sessionLifecycle.set(key, signature)
      if (status === 'processing' && options?.sessionKey) this.slotOwner.set(key, options.sessionKey)
      else if (status === 'active') this.slotOwner.delete(key)
    } catch (err) {
      // Identity needs chat:write.customize (the enum alone runs on chat:write). A manually
      // created bot without it keeps the working indicator under the app identity.
      if ((username || iconUrl) && missingScopesFrom(err).length > 0) {
        this.statusIdentityUnsupported = true
        // Same options: the latch above already blanks the identity, and sessionKey must survive.
        return this.setSessionLifecycle(channel, threadTs, status, options)
      }
      // Left unrecorded so the next status update retries instead of deduping a failure.
      this.deps.log?.debug(
        `slack: session lifecycle ${status} failed (ch=${channel} thread=${threadTs}): ${(err as Error).message}`
      )
    }
  }

  /** Best-effort agent-session title, DMs and channels alike: Slack renders it as the thread
   *  panel's header once the thread is a registered agent session — which every turn's
   *  lifecycle `setStatus` (and any card stream) makes it. Unregistered threads answer
   *  `not_authorized` and degrade here. */
  async setTitle(channel: string, threadTs: string, title: string): Promise<void> {
    if (this.lastTitles.get(`${channel}:${threadTs}`) === title) return
    try {
      await this.queue.enqueue(() =>
        this.app.client.agents.sessions.rename({
          channel_id: channel,
          thread_ts: threadTs,
          title
        })
      )
      this.lastTitles.set(`${channel}:${threadTs}`, title)
    } catch (err) {
      this.rememberMissingScopes(err)
      await this.postPermissionUpdateCard(channel, threadTs)
      this.deps.log?.debug(`slack: setTitle failed (ch=${channel} thread=${threadTs}): ${(err as Error).message}`)
    }
  }

  async stop(): Promise<void> {
    for (const key of [...this.owedStops.keys()]) this.forgetOwedStop(key)
    await this.app.stop()
  }
}
