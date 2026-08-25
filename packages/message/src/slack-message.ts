import type { NormalizedPlatformMessage, PlatformAttachment } from '@agentconnect.md/protocol'
import { extractSlackMessageText } from './slack-message-text.js'

/** The subset of a Slack file element carried through normalization. */
export interface SlackFile {
  id?: string
  name?: string | null
  title?: string | null
  mimetype?: string
  filetype?: string
  size?: number
  url_private?: string
  url_private_download?: string
  mode?: string
  /** Slack only sets these on image files; smallest-first is enough for a
   *  console transcript preview. */
  thumb_360?: string
  thumb_720?: string
  thumb_1024?: string
}

/**
 * Plain-object Slack event view accepted by both Socket Mode and HTTP Events
 * API ingress. Membership and other non-message events may omit chat fields.
 */
export interface SlackMessageLike {
  type: string
  subtype?: string
  channel?: string
  channel_type?: string
  thread_ts?: string
  ts?: string
  user?: string
  bot_id?: string
  app_id?: string
  bot_profile?: { app_id?: string; icons?: { image_72?: string } }
  user_profile?: { image_72?: string }
  hidden?: boolean
  message?: unknown
  text?: string
  files?: SlackFile[]
  blocks?: unknown[]
  attachments?: unknown[]
  /** Slack message metadata. AgentConnect stamps its own authorship/response block
   *  here (`event_type: 'agentconnect_thread_event'`); chrome carries a different
   *  event type. Any app in the workspace can write metadata, so what is read out of
   *  it is a CLAIM until the ingress verifies the sending app — see
   *  {@link readAgentAuthorshipClaim}. */
  metadata?: { event_type?: string; event_payload?: Record<string, unknown> }
}

/** `event_type` AgentConnect stamps on an agent-authored conversational message. */
export const AGENTCONNECT_THREAD_EVENT_TYPE = 'agentconnect_thread_event'

function optionalString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/**
 * Read the UNTRUSTED agent-authorship claim out of Slack message metadata
 * (send-message-routing-rework.md §4/§8.1), or undefined when the message carries none.
 *
 * This function PARSES; it does not verify. Everything it returns is attacker-writable
 * — any app in the workspace can stamp the same `event_type` — so a caller must
 * promote it only after proving the provider event is authentic, the sending app
 * belongs to AgentConnect in this org and conversation, and the claimed author is one
 * of the agents that identity represents.
 *
 * A structurally invalid claim yields `undefined` rather than a partial object: a
 * half-read claim is exactly the shape that would later be mistaken for a verified
 * one. In particular a missing or non-integer `hop_count` drops the whole claim rather
 * than defaulting to 0 — §4.1 requires an unverifiable depth to be transcript-only,
 * and defaulting would silently reset an agent's loop-protection budget.
 */
export function readAgentAuthorshipClaim(
  message: Pick<SlackMessageLike, 'metadata'>
): NormalizedPlatformMessage['agentAuthorship'] | undefined {
  const metadata = message.metadata
  if (!metadata || metadata.event_type !== AGENTCONNECT_THREAD_EVENT_TYPE) return undefined
  const payload = metadata.event_payload
  if (!payload || typeof payload !== 'object') return undefined
  const authorAgentId = optionalString(payload, 'author_agent_id')
  const responseId = optionalString(payload, 'response_id')
  if (!authorAgentId || !responseId) return undefined
  const deliveryState = payload.delivery_state
  if (deliveryState !== 'streaming' && deliveryState !== 'final') return undefined
  const hopCount = payload.hop_count
  if (typeof hopCount !== 'number' || !Number.isInteger(hopCount) || hopCount < 0) return undefined
  const rawMentioned = payload.mentioned_agent_ids
  if (!Array.isArray(rawMentioned)) return undefined
  const mentionedAgentIds = rawMentioned.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
  const agentCallDeliveryId = optionalString(payload, 'agent_call_delivery_id')
  // Absent ⇒ false: an older author daemon cannot report it, and its finals must stay
  // routable exactly as before rather than becoming silently unroutable. Only an explicit
  // `true` asserts it, so a malformed value degrades to "named nobody" instead of
  // blocking every continuation.
  const addressedAnyone = payload.addressed_anyone === true
  return {
    authorAgentId,
    responseId,
    deliveryState,
    hopCount,
    mentionedAgentIds,
    ...(addressedAnyone ? { addressedAnyone } : {}),
    ...(agentCallDeliveryId ? { agentCallDeliveryId } : {})
  }
}

/** A Slack chat event whose identity fields have already been validated. */
export type SlackMessage = SlackMessageLike & { channel: string; ts: string }

const MENTION_RE = /<@([A-Z0-9]+)>/g

/**
 * Does this text address ANYONE — an agent, a human, or another app?
 *
 * Deliberately the same pattern `mentionedBots` is built from, so the author's
 * "did I address someone" claim and the reader's own parse can never disagree about what
 * counts as a mention (send-message-routing-rework.md §2.3, where any address is
 * binding). Callers pass the COMPLETE logical response: the final physical section alone
 * cannot answer this once an answer has been split.
 */
export function slackTextAddressesAnyone(text: string): boolean {
  // A fresh lastIndex per call — the shared /g regex is stateful and `test` advances it.
  return new RegExp(MENTION_RE.source).test(text)
}

/** Map provider file metadata to a fetchable attachment, dropping malformed or
 * tombstoned files that have no stable id and provider URL. */
export function toSlackAttachment(file: SlackFile | null | undefined): PlatformAttachment | null {
  if (!file || typeof file !== 'object') return null
  const sourceUrl = file.url_private_download ?? file.url_private
  if (!file.id || !sourceUrl) return null
  const thumbnailUrl = file.thumb_360 ?? file.thumb_720 ?? file.thumb_1024
  return {
    id: file.id,
    name: file.name ?? file.title ?? file.id,
    mimeType: file.mimetype ?? 'application/octet-stream',
    ...(typeof file.size === 'number' ? { size: file.size } : {}),
    sourceUrl,
    ...(thumbnailUrl ? { thumbnailUrl } : {})
  }
}

export function normalizeSlackMessage(message: SlackMessage, context: { traceId: string }): NormalizedPlatformMessage
export function normalizeSlackMessage(
  message: SlackMessageLike,
  context?: { traceId?: string }
): NormalizedPlatformMessage | null
export function normalizeSlackMessage(
  message: SlackMessageLike,
  context: { traceId?: string } = {}
): NormalizedPlatformMessage | null {
  if (typeof message.channel !== 'string' || typeof message.ts !== 'string') return null

  const text = extractSlackMessageText(message)
  const mentionedBots = [...text.matchAll(MENTION_RE)].map((match) => match[1]!)
  const attachments = (message.files ?? [])
    .map(toSlackAttachment)
    .filter((attachment): attachment is PlatformAttachment => attachment !== null)
  const appId = message.app_id ?? message.bot_profile?.app_id
  const avatarUrl = message.user_profile?.image_72 ?? message.bot_profile?.icons?.image_72
  const msgId = `slack:${message.channel}:${message.ts}`
  const agentAuthorship = readAgentAuthorshipClaim(message)

  return {
    msgId,
    traceId: context.traceId ?? msgId,
    source: 'user',
    platform: 'slack',
    channel: message.channel,
    thread: message.thread_ts ?? message.ts,
    sender: {
      id: message.user ?? message.bot_id ?? 'unknown',
      isBot: Boolean(message.bot_id || appId),
      ...(appId ? { appId } : {}),
      ...(avatarUrl ? { avatarUrl } : {})
    },
    text,
    mentionedBots,
    ...(attachments.length ? { attachments } : {}),
    isDm: message.channel_type === 'im',
    // `app_mention` payloads omit channel_type. Do not guess from the channel
    // prefix because Slack uses "G…" for both mpims and legacy private channels.
    ...(message.channel_type === 'mpim' ? { isGroupDm: true } : {}),
    // Carried, never trusted — the verifier downstream decides whether it means anything.
    ...(agentAuthorship ? { agentAuthorship } : {})
  }
}

/**
 * `ingressEventTag` marking a response-FINALIZATION event apart from the ordinary post
 * it edits.
 *
 * Both events describe the same Slack message and therefore the same `ts`, but they are
 * two distinct arrivals: the streaming post (transcript-only) and the closing edit (the
 * one routable event). Sharing an ingress identity would make per-connection dedup drop
 * whichever arrived second — and the second is exactly the one that carries the
 * recipient set.
 *
 * This used to be a `:final` SUFFIX ON THE msgId, which was wrong: `msgId` also carries
 * the platform ts, recovered downstream by splitting the id. The transcript uses that ts
 * as BOTH its uniqueness key and (parsed) its ordering key, so every finalization
 * collapsed onto the literal ts `'final'` — one row per thread survived, and it sorted to
 * epoch 0 as the oldest message. Keeping the distinction in its own field leaves `msgId`
 * meaning exactly one thing.
 */
export const SLACK_RESPONSE_FINAL_EVENT_TAG = 'response-final'

/**
 * Normalize the event that CLOSES an AgentConnect logical response
 * (send-message-routing-rework.md §5), or return null for every other event.
 *
 * A response is finalized two ways, and BOTH are recognized by the same daemon-written
 * `final` metadata rather than by the event's shape (slack-streaming-turn-output.md
 * §3.3/§7.1):
 *  - the legacy pipeline's closing `chat.update`, delivered as a `message_changed` edit
 *    whose NESTED message carries the metadata (the wrapper owns the channel); and
 *  - a native streamed turn's `chat.stopStream`, which emits NO edit — the finalized
 *    message arrives as an ordinary event carrying the metadata at top level.
 *
 * Slack ingest drops edit wrappers wholesale, and for human edits that is still right:
 * normalizing the outer wrapper would produce an anonymous empty message, and re-routing
 * arbitrary edits would let one message activate an agent repeatedly. So only the shape
 * carrying `final` metadata survives, whether it arrives as an edit or as a stop-time post.
 *
 * Selectivity is the whole point: a `streaming` claim (an in-place update mid-answer, or a
 * streamed append) returns null, so intermediate states never route, and an event with no
 * agent claim at all returns null. Verification of the CLAIM still happens downstream —
 * this function proves nothing about who authored the message.
 */
export function normalizeSlackResponseFinalization(
  event: SlackMessageLike & { message?: unknown },
  context: { traceId?: string } = {}
): NormalizedPlatformMessage | null {
  // A `message_changed` nests the real message; a stop-time finalization is already the
  // top-level event. Either way the metadata to key on lives on `source`.
  const source = event.subtype === 'message_changed' ? event.message : event
  if (!source || typeof source !== 'object') return null
  const nested = source as SlackMessageLike
  const claim = readAgentAuthorshipClaim(nested)
  if (claim?.deliveryState !== 'final') return null
  // The `message_changed` nested message carries no `channel` (the wrapper owns it) and its
  // `ts` is the ORIGINAL post's; a stop-time event is `source === event`, so `event.channel`
  // is its own channel. Either way the identity that matters downstream is on the event.
  const normalized = normalizeSlackMessage(
    {
      ...nested,
      channel: event.channel,
      ...(event.channel_type !== undefined ? { channel_type: event.channel_type } : {}),
      // The wrapper's own `subtype` must not travel (a stop-time event has none): every later
      // stage must see an ordinary post.
      subtype: undefined,
      message: undefined
    },
    context
  )
  if (!normalized) return null
  // `msgId` deliberately stays the ORIGINAL post's — it is the visible message's identity
  // everywhere downstream (transcript key, transcript ordering, activation key). Only the
  // arrival is different, and that is what the tag says.
  return {
    ...normalized,
    ingressEventTag: SLACK_RESPONSE_FINAL_EVENT_TAG,
    ...(context.traceId === undefined ? { traceId: `${normalized.msgId}#${SLACK_RESPONSE_FINAL_EVENT_TAG}` } : {})
  }
}

/** Slack's platform-defined sender for system notifications. */
const SLACK_SYSTEM_USER_ID = 'USLACK'

/** System notifications are not user turns and must never enter agent routing. */
export function isSlackSystemMessage(message: { user?: unknown }): boolean {
  return message.user === SLACK_SYSTEM_USER_ID
}
