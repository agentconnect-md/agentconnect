import { z } from 'zod'
import { Platform } from './frames/route.js'

/**
 * Provider-backed attachment metadata shared by direct daemon ingress and relay
 * HTTP ingress. The relay never downloads or forwards the bytes; the daemon
 * fetches them directly from the provider using its assigned token.
 */
export const PlatformAttachmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  size: z.number().optional(),
  sourceUrl: z.string(),
  /** A smaller provider-rendered rendition (Slack thumb_*, a smaller Telegram
   *  PhotoSize, a resized Discord proxy_url), when the provider offers one.
   *  Console transcript rendering only — the agent's own prompt always gets
   *  `sourceUrl`'s full-resolution bytes. */
  thumbnailUrl: z.string().optional()
})
export type PlatformAttachment = z.infer<typeof PlatformAttachmentSchema>

export const QuotedMessageSchema = z.object({
  messageId: z.string().optional(),
  sender: z.string().optional(),
  text: z.string(),
  selection: z.boolean().optional(),
  excerpt: z.boolean().optional()
})
export type QuotedMessage = z.infer<typeof QuotedMessageSchema>

/**
 * Provider-carried authorship claims found on an inbound platform message that
 * *says* it was produced by an AgentConnect agent (send-message-routing-rework.md §4).
 *
 * EVERY field here is UNTRUSTED. A normalizer copies it straight out of provider
 * metadata (Slack `metadata.event_payload`), which any app in the workspace could
 * have written — model-visible text is never proof of identity either. The relay or
 * daemon promotes these to a trusted claim only after verifying, in order, that the
 * provider event is authentic, that the sending app/bot identity belongs to
 * AgentConnect in this organization and conversation, that the claimed author is one
 * of the agents that identity represents, and that the resolved author→target edge
 * passes outbound policy, inbound call policy, org equality, and the conversation
 * gate. A driver that cannot prove an EXACT agent author must classify the sender as
 * an ordinary third-party bot instead of promoting a partial claim — which is why a
 * shared bot with no exact `authorAgentId` fails closed (§4).
 */
export const AgentAuthorshipClaimSchema = z.object({
  /** Claimed AgentConnect agent that authored this message. */
  authorAgentId: z.string().min(1),
  /** Claimed id of the complete LOGICAL response this physical message belongs to.
   *  Several platform messages of one long answer share it; routing deduplicates on
   *  (responseId, target agent) so a split answer activates a target exactly once. */
  responseId: z.string().min(1),
  /** Claimed lifecycle position. Only `final` is routable — a `streaming` post (or an
   *  intermediate edit) may hold a prefix of the eventual answer, and routing it would
   *  prompt the target with partial text (§5). */
  deliveryState: z.enum(['streaming', 'final']),
  /** Claimed SOURCE-turn depth: the trusted depth of the author's current turn BEFORE
   *  this delivery, never an already-incremented delivery depth (§4.1/§8.1). A
   *  human/root turn is `0`. Every routing edge computes `deliveryHopCount = this + 1`
   *  and rejects the edge when that exceeds the shared cap; a missing, non-integer, or
   *  negative value is transcript-only and can never reset to zero. */
  hopCount: z.number().int().nonnegative(),
  /** Claimed agents addressed by the COMPLETE logical response, resolved by the author's
   *  daemon against the conversation-specific agent directory before platform splitting.
   *  The final routing event carries the whole set even when the visible mention landed
   *  in an earlier physical message (§5.2). Model text cannot populate it directly. */
  mentionedAgentIds: z.array(z.string().min(1)),
  /** Did the COMPLETE logical response address ANYONE — a human, another app, or a bare
   *  shared bot — as opposed to naming no one at all?
   *
   * Needed because §2.3's "addressing anyone is binding" cannot be evaluated from the
   * final event alone. `mentionedAgentIds` is response-complete, but every OTHER mention
   * is only visible as `mentionedBots`, reparsed from the last physical section's text.
   * A long answer that mentions a human in section one and ends without a mention would
   * therefore arrive with both sets empty and read as unaddressed — making the outcome
   * depend on where the splitter happened to cut.
   *
   * Absent ⇒ false, which is the pre-field behavior: an older author daemon splits the
   * same way but cannot report this, so its unaddressed-looking finals stay routable
   * exactly as they were rather than becoming silently unroutable. */
  addressedAnyone: z.boolean().optional(),
  /** Present ONLY on the visible half of a paired `toAgent + channel` send (§3.2); an
   *  ordinary agent reply omits it. It correlates this platform observation with the
   *  internal wake that carries the authoritative call envelope, so the two are admitted
   *  as ONE logical delivery. Correlation, never authority: a platform observation whose
   *  internal envelope never arrives expires transcript-only rather than dispatching an
   *  envelope-less child. */
  agentCallDeliveryId: z.string().min(1).optional()
})
export type AgentAuthorshipClaim = z.infer<typeof AgentAuthorshipClaimSchema>

/**
 * The transport-neutral platform message contract used by pure normalizers.
 *
 * This is deliberately narrower than the daemon's runtime message: daemon-only
 * transcript, session, and inline-content fields are added after ingress. It is
 * the exact payload carried by relay `rd/msg` IM frames.
 */
export const NormalizedPlatformMessageSchema = z.object({
  msgId: z.string(),
  traceId: z.string(),
  source: z.enum(['user', 'cron', 'agent']),
  // S1a open reader (frames/route.ts Platform policy): writers emit only known
  // ids; an unknown id decodes and is handled fail-closed downstream.
  platform: Platform,
  /** Enclosing configurable conversation id. A provider that models threads as
   * channels (Discord) still emits the parent channel here. */
  channel: z.string(),
  /** Stable logical thread id within `channel`. The output adapter maps this
   * provider-neutral pair onto the provider's concrete send target. */
  thread: z.string().optional(),
  /** Platform-native HTTPS link for the integration represented by this
   *  message's session coordinates. The adapter owns construction; core only
   *  persists and forwards it as session metadata. Optional because some
   *  transports expose no stable user-facing permalink and older adapters do
   *  not emit one. */
  threadUrl: z
    .string()
    .url({ protocol: /^https$/ })
    .optional(),
  sender: z.object({
    id: z.string(),
    isBot: z.boolean(),
    /** Provider-observed public display label. Presentation only; never an identity or auth input. */
    name: z.string().optional(),
    appId: z.string().optional(),
    /** Public provider-hosted profile image. Auth-gated file URLs must not be exposed here. */
    avatarUrl: z.string().url().optional()
  }),
  text: z.string(),
  mentionedBots: z.array(z.string()),
  /** An EXTRA dedup dimension for two arrivals that describe the SAME platform message.
   *
   * A streamed agent reply is posted once and then closed by an edit, and both events
   * carry the same Slack `ts` — but only the closing edit is routable, and it is the one
   * that carries the recipient set. Ingress dedups on `msgId`, so without a second
   * dimension the closing edit is dropped as a duplicate of the post.
   *
   * It lives here rather than being folded into `msgId` because `msgId` also CARRIES the
   * platform ts: consumers recover it by splitting the id, and the transcript uses that ts
   * as both its dedup key and its ordering key. Encoding an arrival distinction there
   * corrupts both — which is exactly what a `:final` msgId suffix did.
   *
   * Absent ⇒ the ordinary single arrival. */
  ingressEventTag: z.string().min(1).max(32).optional(),
  attachments: z.array(PlatformAttachmentSchema).optional(),
  isDm: z.boolean(),
  /** Slack `mpim`: classification only; a group DM remains mention-gated. */
  isGroupDm: z.boolean().optional(),
  /** Provider id of the message this one replies to. */
  replyTo: z.string().optional(),
  /** Provider-supplied quoted reply content, already bounded and humanized. */
  quoted: QuotedMessageSchema.optional(),
  // ── §6.4 generic thread coordinates (integration-plugin-architecture.md) ──
  // The platform-agnostic model core session-keying consumes. Dual-shape window:
  // normalizers emit these ALONGSIDE the named per-platform fields below and
  // readers prefer them; the named fields stop being emitted once the fleet
  // reads the generic ones. (`thread` above stays the CANONICAL post-ingress
  // coordinate these feed; the design's `threadId` is named `threadRoot` here
  // because `thread` already occupies that slot.)
  /** Platform topic/forum container the message lives in (Telegram forum topic id). */
  topicId: z.string().optional(),
  /** Platform reply-chain root when threads are reply-derived rather than native. */
  threadRoot: z.string().optional(),
  /** Top-level post the daemon should promote into a real thread before dispatch. */
  promoteToThread: z.boolean().optional(),
  /** Opaque per-adapter extension bag, namespaced by platformId
   *  (`adapterExt.telegram`, …). Never read by core; round-tripped back to the
   *  platform adapter at render time (S2 renderer seam). */
  adapterExt: z.record(z.string(), z.unknown()).optional(),
  // The platform-named coordinate twins (`telegramTopicId` / `telegramThreadRoot` /
  // `discordTopLevel`) RETIRED here (S1b cleanup): the generic fields above are the
  // only emitted shape since the §6.5 flip; an older peer's named fields are simply
  // stripped by this non-strict object schema.
  trigger: z.enum(['mention', 'dm', 'keyword', 'auto', 'cron']).optional(),
  /** Provider-reported send time (epoch ms). Set when the platform's message id
   *  is not itself chronological (Telegram sequence ids, Feishu om_ ids) or the
   *  time is embedded in it (Discord snowflakes, decoded at normalization).
   *  The daemon stamps it onto the transcript row's normalized event-time axis
   *  so cross-source merges order correctly (merged-conversation-view.md §6). */
  platformTimeMs: z.number().int().positive().optional(),
  headless: z.boolean().optional(),
  /** Daemon-minted coordinates, not a platform destination: a headless cron keeps a key it never posts to. */
  syntheticChannel: z.literal(true).optional(),
  /** UNTRUSTED provider authorship claim for an agent-authored platform message
   *  (see {@link AgentAuthorshipClaimSchema}). Absent on human and third-party-bot
   *  traffic. Kept as one nested object so a consumer can never mistake a verified
   *  relay assertion for a provider field: the relay's own trusted mint travels
   *  OUTSIDE this payload, on the `rd/msg` IM frame (§8.2). */
  agentAuthorship: AgentAuthorshipClaimSchema.optional()
})
export type NormalizedPlatformMessage = z.infer<typeof NormalizedPlatformMessageSchema>
