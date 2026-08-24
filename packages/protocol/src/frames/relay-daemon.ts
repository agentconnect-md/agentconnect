import { z } from 'zod'
import { ExternalSessionAudience } from './telemetry.js'
import {
  NormalizedPlatformMessageSchema,
  PlatformAttachmentSchema,
  type NormalizedPlatformMessage,
  type PlatformAttachment
} from '../normalized-message.js'
import { frameSchema } from '../envelope.js'
import { ErrorFrame } from './error.js'
import { WebchatDone, WebchatImageAttachment, WebchatOutput, WebchatPost } from './webchat.js'
import { GitlabHookMetadata, GithubHookMetadata, HookContext, OptionalHookConfigSnapshot } from './hook.js'
import { CronTarget } from './cron.js'
import { Platform } from './route.js'
import { WebchatRemoteMcpEntitlement } from './remote-mcp.js'
import { buildEnvelopeRaw, decodeEnvelopeWith, type BuildOpts, type DecodeResultOf } from '../wire.js'

/**
 * relay↔daemon frames (`rd/*`) — shared-bot-relay.md §7.2.
 *
 * The daemon dials OUT to every relay in its roster (one WS per (daemon, relay)
 * pair, multiplexing every source). This wire CARRIES MESSAGE CONTENT — it is
 * the ingress data plane — so nothing on it is ever logged with its payload.
 *
 * Direction per frame:
 *  - `rd/hello` (+ `rd/hello/ok`)  D→R REQ / R→D REP — authenticate the dial-in
 *  - `rd/msg`                      R→D REQ — one inbound item, already routed
 *  - `rd/ack`                      D→R REP — receipt (+ webchat turn verdict)
 *  - `rd/chat`                     D→R EVT — webchat output stream back to the
 *                                  browser (webchat is the one BIDIRECTIONAL
 *                                  source: its far end hangs off the relay)
 *
 * Milestone A carried the webchat slice; milestone B-github adds the `hook`
 * member (webhook-triggers-and-github-events.md). The `im` (shared bot) member
 * joins the `rd/msg` union with milestone B-slack.
 */

/** Subprotocol negotiated on the relay↔daemon socket. */
export const RELAY_DAEMON_SUBPROTOCOL = 'agentconnect.rd.v1'

/** The canonical path the relay mounts its daemon-facing `rd/*` server at, and
 *  the daemon appends to a roster `daemonUrl` origin when dialing (mirrors the
 *  daemon↔CP `/daemon/ws` convention). A roster url already ending in it is used
 *  verbatim. */
export const RELAY_DAEMON_WS_PATH = '/rd/ws'

// ── hello (first frame; §9) ──────────────────────────────────────────────────

/**
 * Optional behaviors a daemon advertises at hello so the relay can refuse — rather
 * than silently degrade — a delivery the target cannot honor
 * (send-message-routing-rework.md §8.4). Unknown strings are ignored, so a newer
 * daemon may advertise capabilities an older relay has never heard of.
 *
 * `headless-agent-delivery-v1`: this daemon understands the `session-reply` delivery
 * kind — it dispatches the reply into the parent session named by `lineageReplyTo`
 * (which §7 then resumes as an ordinary turn) instead of keying by coordinates. Without
 * it, such a reply must FAIL (retryable/unsupported) rather than land in the wrong
 * session. The name is historical: the kind once also required muting the parent turn.
 */
export const RD_HEADLESS_AGENT_DELIVERY_V1 = 'headless-agent-delivery-v1'

/**
 * `agent-implicit-routing-v1`: this daemon understands {@link RdMsgIm.trustedRouteVia}
 * and applies its `!stop` thread mute to an implicitly-selected per-target delivery.
 *
 * Without it the relay must NOT forward such a continuation at all: an older daemon
 * ignores the field and can treat an implicit peer copy as an explicit mention, which
 * would clear the mute — so during a mixed-version rollout the one control a human has
 * over a runaway agent exchange would silently stop working. Refusing to forward
 * degrades to the pre-change behavior (the agent conversation simply does not continue
 * through that daemon), which is the fail-closed direction.
 */
export const RD_AGENT_IMPLICIT_ROUTING_V1 = 'agent-implicit-routing-v1'

/**
 * `github-thread-worktree-cleanup-v2`: this daemon treats the relay-authored
 * `pull_request:merged`, `issues:closed`, and `issues:deleted` hook events as
 * maintenance only. It never opens a model turn and applies the existing safe
 * retention deletion.
 *
 * A relay must not send those synthetic events to a daemon without this
 * capability: an older daemon would otherwise interpret them as ordinary hook
 * prompts during a mixed-version rollout. V1 is not equivalent because it did
 * not cover `issues:deleted`.
 */
export const RD_GITHUB_THREAD_WORKTREE_CLEANUP_V2 = 'github-thread-worktree-cleanup-v2'

// D→R REQ → rd/hello/ok. The daemon presents the same credential it uses on the CP
// socket — an API key, or an in-cluster daemon's projected ServiceAccount token. The
// relay holds no database, so it delegates either to the CP via `rc/verify` and caches
// the verdict until this connection closes. Secret material — NEVER log.
export const RdHello = z.object({
  apiKey: z.string().min(1).optional(),
  // Projected ServiceAccount token of an operator-provisioned daemon pod, audience-scoped
  // to CP_TOKEN_AUDIENCE. Takes precedence over `apiKey`; verified by the CP, never here.
  serviceAccountToken: z.string().min(1).optional(),
  daemonId: z.string().uuid(),
  // Bounded so a hostile/buggy daemon cannot grow the relay's per-connection state.
  // Absent ⇒ an older daemon that advertises nothing; the relay must then assume the
  // capability is UNSUPPORTED rather than optimistically forwarding.
  capabilities: z.array(z.string().min(1)).max(32).optional()
})
export type RdHello = z.infer<typeof RdHello>

// R→D REP (corr = rd/hello id). Echoes the relay's identity so the daemon can
// confirm it reached the roster entry it dialed: roster `url`s must be
// per-instance routable (design §5), so a relayId mismatch means the deployment
// put a random LB in front of the daemon dial path — the daemon MUST treat it
// as a misroute (close + backoff), never silently continue on the wrong
// instance. Rejection is an `error` REP + close, not a reply.
export const RdHelloOk = z.object({
  relayId: z.string().uuid()
})
export type RdHelloOk = z.infer<typeof RdHelloOk>

// ── inbound delivery (R→D) ───────────────────────────────────────────────────

// The webchat operations a browser can issue, folded into one payload union so
// the wire stays at the four designed frames. `turn` is the user message; the
// rest are the session controls the old daemon↔CP webchat EVTs carried.
//
export const WebchatRuntimeConfig = z.object({
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
  permissionMode: z.string().min(1).optional(),
  fastMode: z.boolean().optional()
})
export type WebchatRuntimeConfig = z.infer<typeof WebchatRuntimeConfig>

export const RelayWebchatOp = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('turn'),
    text: z.string(),
    // The author's mutable display handle — the transcript author line and the name a
    // session worktree's branch is cut under.
    user: z.string().optional(),
    // The author's STABLE CP principal, which is what the daemon records as the
    // transcript sender so a display-name change never re-identifies past rows.
    // Absent on frames from an older relay; the daemon then falls back to `user`.
    userId: z.string().optional(),
    // New browsers allocate this before sending so a pre-ack reconnect can name
    // the exact turn. Optional for older clients; the daemon allocates a fallback.
    turnId: z.string().uuid().optional(),
    // Structured mentions from the composer (agent ids ⊆ the conversation roster).
    // The daemon maps them onto `mentionedBots` so a mentioned agent activates
    // with `trigger:'mention'`. Targeting is separate: the relay already picked
    // THIS frame's target (RdMsgWebchat.agentId); mentions are prompt context.
    mentions: z.array(z.string().uuid()).max(16).optional(),
    // Canonical post identity, minted ONCE by the relay when it accepts the turn
    // and shared by every per-target copy — see WebchatPost. Absent on frames
    // from an older relay; the daemon then mints locally (single-agent shape).
    post: z.object({ postId: z.string().uuid(), at: z.number().int() }).optional(),
    attachments: z.array(WebchatImageAttachment).max(1).optional(),
    // A fresh Playground has no daemon session to receive standalone `set_*`
    // operations yet. Carry only the settings the user changed with its first turn.
    runtime: WebchatRuntimeConfig.optional(),
    // Per-conversation workspace override. The daemon honors it only while
    // creating the logical session; later turns cannot move an existing session.
    worktree: z.boolean().optional()
  }),
  // A conversation post another participant produced (a user turn targeted
  // elsewhere, or a peer agent's reply), fanned out by the relay so THIS frame's
  // agent sees the full conversation. The daemon always records it (deduplicated
  // by postId). A USER-authored post stays transcript-only (user turns activate
  // via pre-addressed `turn` frames); an AGENT-authored post carrying a usable
  // `author.hopCount` additionally CONTINUES the conversation for this
  // pre-addressed participant — the #549 parity of webchat-multi-agents.md §5.2a,
  // bounded by the hop transition, exactly-once admission, and call policy on the
  // receiving daemon. An agent post without a depth stays transcript-only.
  z.object({
    op: z.literal('context'),
    post: WebchatPost
  }),
  // Rebind an in-flight/recent turn to this relay connection and replay every
  // output after the browser's contiguous cursor. The generation monotonically
  // fences delayed resume requests from older browser connections.
  // `agentId` addresses the stream's owner in a multi-agent conversation (streams
  // are keyed per (turnId, agentId)); absent ⇒ the conversation's sole agent.
  z.object({
    op: z.literal('resume'),
    turnId: z.string().uuid(),
    agentId: z.string().uuid().optional(),
    generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    afterIndex: z.number().int().min(-1)
  }),
  z.object({ op: z.literal('set_model'), model: z.string() }),
  z.object({ op: z.literal('set_effort'), effort: z.string() }),
  z.object({ op: z.literal('set_permission_mode'), permissionMode: z.string() }),
  z.object({ op: z.literal('set_fast'), fastMode: z.boolean() }),
  // `agentId` cancels one participant's live turn; absent ⇒ every live turn in
  // the conversation (and the sole agent's, in a single-agent conversation).
  z.object({ op: z.literal('cancel'), agentId: z.string().uuid().optional() }),
  z.object({ op: z.literal('close') })
])
export type RelayWebchatOp = z.infer<typeof RelayWebchatOp>

// R→D REQ → rd/ack. One inbound item, already routed: the relay names the target
// agent, so the daemon takes the explicit-agent short-circuit into dispatch —
// no local trigger arbitration (same precedent as webchat today).
export const RdMsgWebchat = z.object({
  source: z.literal('webchat'),
  agentId: z.string().uuid(), // explicit target (webchat names its agent)
  // Dedup scope: the daemon drops an already-seen (sessionKey, msgId). For
  // webchat, sessionKey == chatId (the conversation IS the session).
  sessionKey: z.string().min(1),
  msgId: z.string().min(1), // relay-minted idempotency key (unique per op)
  chatId: z.string().uuid(), // == conversationId (SessionKey.channel for 'webchat')
  // Session-targeted continuation: the CP-verified target session by its outward id (§1.1),
  // copied verbatim from the rc/verify verdict. Absent ⇒ today's behavior
  // (conversation-derived webchat session). Never originates in the browser.
  targetSessionId: z.string().min(1).optional(),
  remoteMcp: WebchatRemoteMcpEntitlement.optional(),
  payload: RelayWebchatOp
})
export type RdMsgWebchat = z.infer<typeof RdMsgWebchat>

// ── shared-bot inbound (`im`) ────────────────────────────────────────────────

// Provider attachment metadata. The bytes NEVER cross this wire (or the relay):
// the daemon fetches them directly with its assigned provider token.
export const WireAttachment = PlatformAttachmentSchema
export type WireAttachment = PlatformAttachment

// The relay and direct daemon adapters share this pure normalized message model.
// The daemon explicitly enriches it with local-only runtime fields after receipt.
export const WireNormalizedMessage = NormalizedPlatformMessageSchema
export type WireNormalizedMessage = NormalizedPlatformMessage

// R→D REQ → rd/ack. One shared-bot inbound the relay already arbitrated: it names
// the target `agentId` + the `integrationId` the daemon replies through, so the
// daemon takes the explicit-agent short-circuit into dispatch (no local
// arbitration — the routing happened in the relay, §10). `msgId` is the platform
// event id (Slack event_id / TG update_id) — the idempotency key that survives a
// relay re-assign (§12). Dedup scope is (botId, sessionKey, msgId): separate bot
// assignments may receive the same platform event and must wake independently.
//
// When the sender is a VERIFIED AgentConnect agent, the relay additionally mints the
// `trusted*` block below. It lives OUTSIDE `payload` on purpose: `payload` carries the
// provider's own (untrusted) `agentAuthorship` claim, and the target must always be
// able to tell a relay assertion apart from a provider field (§8.2).
export const RdMsgIm = z.object({
  source: z.literal('im'),
  agentId: z.string().uuid(),
  sessionKey: z.string().min(1),
  msgId: z.string().min(1),
  botId: z.string().uuid(),
  integrationId: z.string().uuid(),
  chatId: z.string().optional(), // platform channel id (observability)
  payload: WireNormalizedMessage,
  // The author the relay VERIFIED after checking the provider event, the sending app's
  // AgentConnect ownership in this org+conversation, and that the claimed author is one
  // of the agents that identity represents. Absent ⇒ not an agent-authored message, or
  // authorship could not be proven exactly (a shared bot with no exact claim fails
  // closed and is never promoted to call-policy identity, §4).
  trustedFromAgentId: z.string().uuid().optional(),
  // The verified logical response this physical message belongs to, and the target(s)
  // the relay minted for this pre-addressed edge. The target never trusts provider
  // metadata to substitute a different agent; ordinary participant selection already
  // happened at the relay, while paired delivery keeps its exact tool-named target.
  trustedResponseId: z.string().min(1).optional(),
  trustedRecipientAgentIds: z.array(z.string().uuid()).max(64).optional(),
  // Correlates the visible half of a paired `toAgent + channel` send with the internal
  // wake that carries the authoritative call envelope (§3.2). The relay forwards the
  // verified pairing id but NEVER synthesizes or stores the envelope itself; the target
  // daemon owns the durable rendezvous, because both observations converge there.
  trustedAgentCallDeliveryId: z.string().min(1).optional(),
  // The DELIVERY depth for this edge, computed by the relay exactly once as verified
  // source depth + 1 and already cap-checked (§4.1 step 4). The target TERMINAL-verifies
  // its range and installs it as trusted active-turn call metadata WITHOUT incrementing
  // it a second time — double-counting here would halve the effective hop budget.
  trustedDeliveryHopCount: z.number().int().nonnegative().optional(),
  // WHICH cause applies to THIS target, because one body can explicitly join one agent
  // while existing peers receive implicit copies. The causes are not interchangeable at
  // `!stop`: a human mention clears the named target's mute, while implicit participants
  // stay silenced. Absent ⇒ 'mention' for compatibility with older relay frames.
  trustedRouteVia: z.enum(['mention', 'implicit']).optional()
})
export type RdMsgIm = z.infer<typeof RdMsgIm>

// One daemon-owned Slack interaction received by the shared app's relay HTTP edge.
// It remains typed inside rd/msg so status controls and message-card choices reuse the
// existing receipt, dedup, and relay→daemon delivery path.
export const RdSlackAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('open-config'), triggerId: z.string().min(1) }),
  z.object({
    kind: z.literal('open-config-for-thread'),
    triggerId: z.string().min(1),
    channelId: z.string().min(1),
    threadTs: z.string().min(1)
  }),
  // Slack's native agent-session Stop, addressed by conversation: the relay never sees a session
  // key on the event, so the daemon resolves the owning session exactly as Socket Mode does.
  z.object({
    kind: z.literal('agent-session-stopped'),
    channelId: z.string().min(1),
    threadTs: z.string().min(1)
  }),
  z.object({ kind: z.literal('set-model'), model: z.string().min(1) }),
  z.object({ kind: z.literal('set-effort'), effort: z.string().min(1) }),
  z.object({ kind: z.literal('set-permission-mode'), permissionMode: z.string().min(1) }),
  z.object({ kind: z.literal('set-fast'), fastMode: z.boolean() }),
  z.object({ kind: z.literal('set-output'), outputMode: z.enum(['none', 'minimal', 'low', 'medium', 'high']) }),
  z.object({ kind: z.literal('cancel') }),
  z.object({ kind: z.literal('permission-choice'), requestId: z.string().min(1), optionId: z.string() }),
  z.object({ kind: z.literal('elicitation-choice'), requestId: z.string().min(1), value: z.string().nullable() })
])
export type RdSlackAction = z.infer<typeof RdSlackAction>

/** The provider-authenticated body of one Lark / Feishu `card.action.trigger`.
 * The daemon deliberately resolves the opaque message id against its local active-card
 * map instead of trusting relay-supplied session coordinates. */
export const WireFeishuCardActionTarget = z.object({
  v: z.literal(1),
  agentId: z.string().uuid(),
  integrationId: z.string().uuid()
})
export type WireFeishuCardActionTarget = z.infer<typeof WireFeishuCardActionTarget>

export const WireFeishuCardActionValue = z.object({
  action: z.string(),
  target: WireFeishuCardActionTarget.optional()
})
export type WireFeishuCardActionValue = z.infer<typeof WireFeishuCardActionValue>

export const WireFeishuCardActionEvent = z.object({
  context: z
    .object({
      open_message_id: z.string().optional(),
      open_chat_id: z.string().optional()
    })
    .optional(),
  open_message_id: z.string().optional(),
  open_chat_id: z.string().optional(),
  operator: z
    .object({
      open_id: z.string().optional(),
      user_id: z.string().optional(),
      union_id: z.string().optional(),
      name: z.string().optional()
    })
    .optional(),
  action: z
    .object({
      value: z.unknown().optional(),
      tag: z.string().optional(),
      name: z.string().optional(),
      option: z.string().optional()
    })
    .optional()
})
export type WireFeishuCardActionEvent = z.infer<typeof WireFeishuCardActionEvent>

export const WireFeishuCardActionResponse = z.object({
  toast: z
    .object({
      type: z.enum(['info', 'success', 'warning', 'error']),
      content: z.string()
    })
    .optional()
})
export type WireFeishuCardActionResponse = z.infer<typeof WireFeishuCardActionResponse>

/**
 * R→D REQ → rd/ack (§6.6). The ONE platform-interaction envelope replacing the
 * per-platform `slack_action` / `feishu_action` members: the ENVELOPE is
 * core-typed — the routing fields relay core needs plus the dedup identity —
 * and the PAYLOAD is opaque to relay core. The relay-side platform module
 * parsed the provider interaction and minted `msgId`; the SAME platform's
 * daemon-side module decodes `payload` into StatusAction / PermissionChoice /
 * Elicitation calls. Reader-first: this build ACCEPTS the member while the
 * relay keeps emitting the legacy members; the emission flips after the next
 * fleet cycle and the legacy members retire after that. Dedup scope is
 * (botId, sessionKey, msgId), identical to the legacy members — the daemon
 * replays the prior ack on retransmit, and fencing is unaffected.
 */
export const RdMsgPlatformAction = z.object({
  source: z.literal('platform_action'),
  platformId: z.string().min(1),
  agentId: z.string().uuid(),
  sessionKey: z.string().min(1),
  msgId: z.string().min(1),
  botId: z.string().uuid(),
  integrationId: z.string().uuid(),
  // The platform user who tapped it (attribution); optional — absent records as
  // an unknown actor, never a fabricated one.
  userId: z.string().min(1).optional(),
  payload: z.unknown()
})
export type RdMsgPlatformAction = z.infer<typeof RdMsgPlatformAction>

// R→D REQ → rd/ack. One already-adjudicated trigger delivery: the relay matched
// the hook rule and names the target agent (explicit-agent short-circuit, same
// as webchat — no local trigger arbitration). The daemon synthesizes a
// NormalizedMessage from `prompt` + `context` (fencing the context as untrusted
// external content) and dispatches; the turn's outcome goes to the CP as a
// `hook/report` EVT on the control WS, NOT back over this wire.
export const RdMsgHook = z.object({
  source: z.literal('hook'),
  agentId: z.string().uuid(),
  // (sessionKey, msgId) is the daemon's dedup key. msgId folds in the hookId:
  // one GitHub delivery fanning out to two hooks on the same agent+repo must
  // not swallow each other.
  sessionKey: z.string().min(1), // relay-computed: github perThread '<stable-prefix>#42';
  // webhook perDelivery '<hookId>:<deliveryKey>' / shared '<hookId>'
  msgId: z.string().min(1), // `${hookId}:${deliveryKey}`
  hookId: z.string().uuid(),
  deliveryKey: z.string().min(1),
  firedAt: z.string().datetime(), // relay ingest time
  // Rolling-compatible policy + durable dispatch fence. Older rules omit
  // these; the daemon must then keep review/reporting off while still running
  // the ordinary hook turn.
  ...OptionalHookConfigSnapshot.shape,
  event: z.string().min(1).optional(), // normalized 'family:action' (or bare push)
  // Signature-verified, rule-fenced metadata. Kept outside HookContext because
  // the latter contains model-visible, attacker-authored excerpts.
  github: GithubHookMetadata.optional(),
  // GitLab counterpart (gitlab-com-integration.md §12.3): the daemon's trusted
  // normalization discriminator. Optional member — an older daemon never sees
  // it (dispatch is gated on the daemon advertising gitlab-com-v1).
  gitlab: GitlabHookMetadata.optional(),
  context: HookContext.optional(), // trimmed envelope; message extraction/fencing happens on the daemon
  target: CronTarget.optional() // output anchoring; absent ⇒ headless
})
export type RdMsgHook = z.infer<typeof RdMsgHook>

// Shared-bot IM + status actions and webhook fires join the webchat union.
// The platform-named interaction members (`slack_action` / `feishu_action`)
// RETIRED here (S1b cleanup): nothing has emitted them since the relay's §6.6
// flip shipped a release earlier, so the union now carries the one
// platform_action envelope. A frame from an older relay fails the decode and is
// dropped with a log — never crashing the pipe.
export const RdMsg = z.discriminatedUnion('source', [RdMsgWebchat, RdMsgIm, RdMsgPlatformAction, RdMsgHook])
export type RdMsg = z.infer<typeof RdMsg>

// D→R REP (corr = rd/msg id). Receipt for dedup/ack bookkeeping; for a webchat
// `turn` it also carries the dispatch verdict the relay forwards to the browser
// (`turnId` correlates the `rd/chat` stream; `reason` e.g. 'no_agent'|'paused').
/** The one refusal reason the ROUTER acts on rather than reports: this daemon
 *  does not hold the target agent's duty, so the trigger must be re-routed to
 *  `holderDaemonId` (design §4.4). Every other reason stays a free-form string
 *  the relay forwards or logs — this is deliberately not a closed enum, so a
 *  daemon can keep minting new descriptive reasons without a wire revision. */
export const RD_ACK_NOT_HOLDER = 'not_holder'

export const RdAck = z.object({
  msgId: z.string(),
  accepted: z.boolean(),
  turnId: z.string().uuid().optional(),
  reason: z.string().optional(),
  /** Bounded human-readable cause for a refusal the browser should explain (see WebchatAck.detail). */
  detail: z.string().max(240).optional(),
  /** Set with `reason: 'not_holder'`: the member that holds the duty now, as the
   *  losing claimant learned it from the CP. Absent when even the CP could not
   *  name one — the router then retries rather than re-routing. */
  holderDaemonId: z.string().uuid().optional(),
  /** §6.6 opaque interaction response for a `platform_action` — the payload the
   *  relay-side platform module surfaces on the synchronous HTTP body (Feishu
   *  toast, Slack block_suggestion options). Decoded only by the platform
   *  module. (The Feishu-named `feishuCardAction` slot retired with the legacy
   *  interaction members.) */
  response: z.unknown().optional()
})
export type RdAck = z.infer<typeof RdAck>

// ── cross-daemon agent→agent (`rd/agentmsg`) ─────────────────────────────────

/**
 * What kind of delivery a cross-daemon agent message is
 * (send-message-routing-rework.md §8.3). It selects the target's AUTOMATIC-OUTPUT
 * behavior; it never changes authorization, which stays the caller/target policy pair.
 *
 *  - `wake` — the ordinary postless `toAgent` call. The woken child is headless in the
 *    existing sense: nothing is posted to any channel on its behalf.
 *  - `session-reply` — a `sendMessage({sessionId})` injection into the caller's
 *    authorized parent session (§7). The target dispatches it into the named
 *    `lineageReplyTo` session instead of keying by coordinates. What stays invisible is
 *    the REPORT: no component publishes the injected body to a platform. The resumed
 *    parent then runs an ORDINARY turn and may answer in its own thread — muting it hid
 *    delegated outcomes from the humans watching that thread whenever the child had
 *    answered elsewhere or nowhere.
 *
 * A relay still MUST NOT forward `session-reply` to a daemon that has not advertised
 * {@link RD_HEADLESS_AGENT_DELIVERY_V1}, and returns `unsupported` (§8.4). That gate is
 * now a LEGACY fence, kept because such a daemon predates the delivery kind entirely;
 * it no longer guards a silence requirement. Absent ⇒ `wake`, which is what every older
 * daemon means.
 */
export const RdAgentMsgDeliveryKind = z.enum(['wake', 'session-reply'])
export type RdAgentMsgDeliveryKind = z.infer<typeof RdAgentMsgDeliveryKind>

/**
 * D→R REQ → `rd/agentmsg/ack`. A cross-daemon `messageAgent` (agent-collaboration
 * §2.3 / §6.2): the SOURCE daemon found the target is not local and routes over the
 * relay data plane (the body NEVER touches the CP).
 *
 * `claimedFromAgentId` is UNTRUSTED (§2.5/§6.2): a daemon hosts many agents, and the
 * `rd/hello` handshake only authenticates the socket's `daemonId` — it cannot prove
 * WHICH agent originated the call. The relay binds the request to the socket's
 * AUTHENTICATED daemonId, validates `claimedFromAgentId` actually belongs to that
 * daemon AND is in `coords` via the collaboration snapshot, checks caller outbound
 * and target inbound policies, resolves `toAgentId → daemonId`, and only then
 * forwards a TRUSTED claim (`RdAgentMsgFwd.trustedFromAgentId`) to the owning daemon.
 *
 * `deliveryId` is stable end-to-end (dedup at each hop, §6.3/§6.7). `hopCount` is
 * the depth of the SOURCE turn; the relay/target reject `hopCount + 1 >= cap` (§2.4).
 */
export const RdAgentMsg = z.object({
  claimedFromAgentId: z.string().uuid(), // UNTRUSTED self-claim — relay validates against the socket daemonId
  toAgentId: z.string().uuid(),
  text: z.string(),
  coords: z.object({
    // S1a open reader (route.ts Platform policy): an unknown chat-shaped id
    // decodes fine and is refused fail-closed by `coordsDecision`, never by
    // the schema (refusing here would kill the frame, not the item).
    platform: Platform,
    channel: z.string().min(1),
    thread: z.string().optional()
  }),
  correlationId: z.string().optional(),
  hopCount: z.number().int().nonnegative(),
  deliveryId: z.string().min(1),
  // When this cross-daemon wake was preceded by a VISIBLE channel post (a `toAgent`+`channel`
  // `sendMessage`), the post's real platform `ts`. The target daemon stamps it as the woken
  // turn's `transcriptTs` so its transcript row collapses onto the SAME (channel, thread, ts)
  // primary key it fetches for the visible post via `conversations.replies` — no duplicate
  // hand-off, canonical read cursor. Optional: a postless wake / old daemon omits it.
  transcriptTs: z.string().min(1).optional(),
  // session-concept §5.3: the WAKING session's lineage, so the woken child can reply
  // back to it via `sendMessage`'s SessionTarget even across daemons/platforms.
  // `originSessionId` is the stable acpSessionId the child surfaces as its `Parent session`
  // (§2.3); `originCoords` are the origin session's landing coords, used to route a reply
  // when the origin lives on another daemon (no sessionId→daemon registry on the relay).
  // Both optional — a root / self-introduce wake has no origin, and old daemons omit them.
  originSessionId: z.string().min(1).optional(),
  originCoords: z
    .object({
      platform: Platform, // S1a open reader (route.ts policy)
      channel: z.string().min(1),
      thread: z.string().optional()
    })
    .optional(),
  // Immutable external source inherited from the caller's Session. The relay
  // forwards it opaquely; the target daemon uses it only for its local
  // pre-prompt source-binding gate.
  externalOrigin: ExternalSessionAudience.optional(),
  // session-concept §5.3 lineage REPLY (SessionTarget): when set, this delivery is a
  // reply INTO the named existing session on the target daemon (its acpSessionId) —
  // never a wake that may mint one. The sender's daemon enforced origin-only
  // authorization (the replier's turn originated from exactly this session), and
  // possession of the high-entropy id — handed out only through wake lineage — is the
  // cross-daemon capability. The target daemon terminally validates the session
  // exists and is owned by `toAgentId`, dispatches into it, and NAKs `not_found`
  // when it is gone; it never substitutes a synthetic coordinate for a lineage
  // reply (a channel-free origin's coordinate is not its key). Absent = ordinary
  // coordinate-keyed wake.
  lineageReplyTo: z.string().min(1).optional(),
  // session-concept §5.4: the caller asked the woken session to report its outcome back into
  // `originSessionId` (`sendMessage`'s `toAgent.needsReply`). The target daemon turns this into a
  // standing directive on the child; it is never part of the delivered `text`. Meaningless without
  // an origin to report to, so the target ignores it when `originSessionId` is absent. Optional —
  // an ordinary fire-and-forget wake and any older daemon omit it.
  needsReply: z.boolean().optional(),
  // session-visibility.md §5.1: the ORIGIN session's current privacy bit, so the
  // target daemon can seed the woken child's memory-capture gate without a CP
  // round-trip. TIGHTEN-ONLY: `true` excludes the child immediately; `false` or
  // absent must NEVER enable capture — an A2A child always starts excluded and
  // opens only on CP confirmation. Optional — old daemons omit it.
  parentPrivate: z.boolean().optional(),
  // send-message-routing-rework.md §8.3. Absent ⇒ `wake` (what every older daemon
  // means). `session-reply` dispatches into `lineageReplyTo` — see
  // {@link RdAgentMsgDeliveryKind}.
  deliveryKind: RdAgentMsgDeliveryKind.optional()
})
export type RdAgentMsg = z.infer<typeof RdAgentMsg>

/**
 * R→D REQ → `rd/agentmsg/ack`. The relay forwards the validated call to the TARGET's
 * owning daemon, replacing the untrusted `claimedFromAgentId` with a TRUSTED caller
 * claim the relay minted after snapshot validation: `trustedFromAgentId` + the `orgId`
 * the caller's own directory entry places it in (never an org the frame asserted). The
 * target daemon TERMINAL-verifies this claim + both directional policies against its
 * LOCAL snapshot (defense in depth, §2.5 #4) before dispatching `source:'agent'`.
 *
 * What `coords` is and is NOT: it is the ASSERTED delivery coordinate, not evidence of a
 * shared channel — A2A authorization is channel-free (postless delivery, #854), so caller and
 * target need share no channel and the target may have no IM integration at all. It is
 * integrity-checked on BOTH sides by one identical rule (`coordsDecision`), which has three
 * outcomes rather than two:
 *   (1) the snapshot holds a non-empty placement at `(orgId, channel)` ⇒ the caller must
 *       resolve in it, else the wake is refused `not_allowed`. A direct conversation counts
 *       wherever its row exists — placements are selected with no `kind` filter, so an
 *       `im`/`mpim` row is an ordinary placement. Admitted, and the woken session keys off
 *       `coords` as sent, which is how a wake deliberately lands in the same thread a human sees;
 *   (2) no such placement and `coords.platform` is a PERSISTED IM platform (slack / telegram /
 *       discord / feishu) ⇒ refused, FAIL CLOSED. An unrecorded IM coordinate is a channel the
 *       caller cannot reach, a departed row, or a guess, and admitting it is what would let a
 *       caller alias an existing platform session (and with `needsReply`, read it back). Note
 *       an `im`/`mpim` row is only WRITTEN for a GATED integration's not-yet-enabled
 *       conversations, so an ordinary integration's DM lands here — deliberate, and the same
 *       answer the channel-membership check this replaced gave;
 *   (3) no such placement and the platform is channel-free (`webchat`, and anything else) ⇒
 *       admitted, but the asserted channel NEVER becomes the session coordinate: the TARGET
 *       daemon keys the woken session off `a2a:<trustedFromAgentId>` instead, which cannot
 *       collide with any real conversation id. The relay forwards `coords` verbatim; only the
 *       daemon that mints the key substitutes, so the two can never disagree about it.
 * The row LOOKUP keys on the CHANNEL ID alone, deliberately NOT on `coords.platform`. That
 * closed a relabelling dodge under the daemon's old `narrowPlatform` fold (session keys were
 * narrowed while snapshot rows are keyed by the integration platform, so a platform-keyed
 * lookup searched a different key space than the key it protects); the fold is deleted
 * (S1a §6.3) and session keys carry the raw platform, but the channel-only match remains
 * the rule on both sides. The platform only picks between (2) and (3), for a coordinate (1)
 * already found nothing for. Read `coords` as "the caller may assert this", never as
 * "verified member of" — and never assume the woken session key echoes it (case 3).
 */
export const RdAgentMsgFwd = z.object({
  trustedFromAgentId: z.string().uuid(), // minted by the relay — the target may trust this
  // Org ids are opaque strings (normally cuid()), not UUIDs.
  orgId: z.string().min(1), // org the relay asserted the caller belongs to (cross-org guard)
  toAgentId: z.string().uuid(),
  integrationId: z.string().uuid().optional(), // DEFINITE target reply integration (§6.2)
  text: z.string(),
  coords: z.object({
    platform: Platform, // S1a open reader (route.ts policy); coordsDecision fail-closes unknown chat ids
    channel: z.string().min(1),
    thread: z.string().optional()
  }),
  correlationId: z.string().optional(),
  hopCount: z.number().int().nonnegative(), // already incremented by the relay
  deliveryId: z.string().min(1),
  // Forwarded verbatim from RdAgentMsg: the visible post's real platform `ts` (if any), so the
  // target stamps it as the woken turn's `transcriptTs` and dedups against the post it fetches
  // from the shared thread. The relay neither mints nor validates it.
  transcriptTs: z.string().min(1).optional(),
  // Carried through from RdAgentMsg (session-concept §5.3): the origin session the woken
  // child may reply into. The relay forwards these opaquely — they are the caller's own
  // lineage, not a claim the relay mints or validates.
  originSessionId: z.string().min(1).optional(),
  originCoords: z
    .object({
      platform: Platform, // S1a open reader (route.ts policy)
      channel: z.string().min(1),
      thread: z.string().optional()
    })
    .optional(),
  // Forwarded verbatim from RdAgentMsg. It is daemon-authored lineage metadata,
  // never inferred from model text or target coordinates.
  externalOrigin: ExternalSessionAudience.optional(),
  // Forwarded verbatim from RdAgentMsg (§5.3 lineage reply): the target session's
  // acpSessionId this delivery replies into. Opaque to the relay — the TARGET
  // daemon terminally validates it with an AGENT-SCOPED lookup (ACP ids are
  // runtime/agent-local) and dispatches into the existing session instead of
  // coordinate keying. Both the relay and the target SKIP the wake-coordinate
  // membership gate for lineage replies: nothing is keyed or created from
  // `coords` on this path, so the aliasing threat that gate closes is absent,
  // and membership would wrongly reject a replier that does not share the
  // origin's channel. Org + directional policy and the session capability
  // (possession of the id + ownership by `toAgentId`) still gate delivery.
  lineageReplyTo: z.string().min(1).optional(),
  // Forwarded verbatim from RdAgentMsg (session-concept §5.4): the caller's request that the woken
  // session report its outcome back into `originSessionId`. Opaque to the relay — it is the
  // caller's own instruction about its own lineage, not a claim the relay mints or validates.
  needsReply: z.boolean().optional(),
  // Forwarded verbatim from RdAgentMsg (session-visibility.md §5.1): the origin session's
  // privacy bit, a TIGHTEN-ONLY hint for the target's memory-capture gate. Opaque to the
  // relay — the caller's own statement about its own session, not a claim the relay mints
  // or validates; an `org`/absent value never opens capture on the target.
  parentPrivate: z.boolean().optional(),
  // Forwarded verbatim from RdAgentMsg (§8.3). The relay does not merely pass this
  // through: for `session-reply` it first checks the TARGET daemon advertised
  // `headless-agent-delivery-v1` at hello, and refuses with `unsupported` when it did not
  // — a legacy fence against a daemon that predates this delivery kind altogether.
  deliveryKind: RdAgentMsgDeliveryKind.optional()
})
export type RdAgentMsgFwd = z.infer<typeof RdAgentMsgFwd>

/** The typed admission verdict for an agent-call (§6.4). The ACK is returned after the
 *  TARGET daemon durably admits/enqueues the turn (P4-gate) — NOT after the model turn.
 *  `reason` is only set when `delivered:false`. */
// `unsupported` is the §8.4 refusal: the delivery required a capability the target
// daemon has not advertised (today, `session-reply`). It is deliberately distinct from
// `offline` — the target IS reachable, it is simply too old to honor this delivery kind,
// so the caller learns the reply was refused rather than having it land in the wrong
// session.
// `not_ready` is the one RETRYABLE verdict: the target is known but nobody is addressable for it YET (an
// unconfirmed pool grant, a lapsed lease awaiting a claim, a lagging directory copy). No hop caches it
// against the `deliveryId`; the SOURCE daemon re-sends the same id with backoff for a bounded window.
export const RdAgentMsgReason = z.enum([
  'busy',
  'offline',
  'queue_full',
  'not_allowed',
  'not_found',
  'hop_limit',
  'unsupported',
  'not_ready'
])
export type RdAgentMsgReason = z.infer<typeof RdAgentMsgReason>

/** The retryable `rd/agentmsg/ack` reason — see {@link RdAgentMsgReason}. */
export const RD_AGENTMSG_NOT_READY = 'not_ready' satisfies RdAgentMsgReason

export const RdAgentMsgAck = z.object({
  deliveryId: z.string().min(1),
  delivered: z.boolean(),
  reason: RdAgentMsgReason.optional(),
  // session-concept §5.4: the CANONICAL logical session key the target computed for the woken
  // child. The source cannot derive this itself — the target's key includes a transport scope
  // derived from the reply integration the RELAY chose, which the source never sees — so without
  // it a `childSessionId` handed to the caller could never match the child's real row. Returned on
  // admission (before the row exists), and optional so an older target daemon simply yields no
  // followable handle rather than a wrong one.
  childSessionId: z.string().min(1).optional()
})
export type RdAgentMsgAck = z.infer<typeof RdAgentMsgAck>

/** Is this admission verdict one the sender should retry (same `deliveryId`) rather than record? */
export function isRetryableAgentMsgAck(ack: Pick<RdAgentMsgAck, 'delivered' | 'reason'>): boolean {
  return !ack.delivered && ack.reason === RD_AGENTMSG_NOT_READY
}

// ── webchat output stream (D→R) ──────────────────────────────────────────────

// One item of a webchat reply stream. Reuses the webchat frame payloads verbatim
// (they already carry conversationId/turnId/index) so the daemon-side emitters
// and the browser-facing shapes migrate unchanged.
export const RdChatEvent = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('output'), output: WebchatOutput }),
  z.object({ kind: z.literal('done'), done: WebchatDone })
])
export type RdChatEvent = z.infer<typeof RdChatEvent>

// D→R EVT — streamed back to the browser hanging off the relay. `seq` is a
// per-chat monotonic counter (the relay forwards in arrival order; the browser
// renders by arrival, `seq` is for observability/assembly only).
export const RdChat = z.object({
  chatId: z.string().uuid(),
  seq: z.number().int(),
  event: RdChatEvent
})
export type RdChat = z.infer<typeof RdChat>

// D→R EVT — one completed conversation post from a participant agent (its
// canonical identity was minted by the owning daemon at the reply-record
// boundary). The relay (a) delivers it to the browser sink when one is
// connected — the live stream already showed the text, so this is the
// canonical `(postId, at)` the browser keys the message by — and (b) fans it
// as a `context` op to every OTHER participant's daemon so the whole roster
// sees the conversation at its next activation. Fire-and-forget with `postId`
// dedup downstream.
export const RdWebchatPost = z.object({
  conversationId: z.string().uuid(),
  agentId: z.string().uuid(), // authoring participant (== post.author.agentId)
  post: WebchatPost,
  // Set only when this turn had NO live rd/chat stream of its own — an agent
  // waking another agent (or its own lineage reply) inside a webchat
  // conversation (#753). The browser renders a post carrying this marker as a
  // fresh transcript step; every other post is the canonical record of a
  // reply it already rendered live and is dropped to avoid double-rendering.
  initiator: z.literal('agent').optional()
})
export type RdWebchatPost = z.infer<typeof RdWebchatPost>

// ── the wire union ───────────────────────────────────────────────────────────

/** `type` string → payload schema for the relay↔daemon wire. */
export const RELAY_DAEMON_SCHEMAS = {
  'rd/hello': RdHello,
  'rd/hello/ok': RdHelloOk,
  'rd/msg': RdMsg,
  'rd/ack': RdAck,
  'rd/agentmsg': RdAgentMsg,
  'rd/agentmsg/fwd': RdAgentMsgFwd,
  'rd/agentmsg/ack': RdAgentMsgAck,
  'rd/chat': RdChat,
  'rd/webchat-post': RdWebchatPost,
  error: ErrorFrame
} as const

/** Union of every legal `type` discriminator on the relay↔daemon wire. */
export type RelayDaemonFrameType = keyof typeof RELAY_DAEMON_SCHEMAS

/** All relay↔daemon frame `type` strings, as a runtime array (guards / tests). */
export const RELAY_DAEMON_FRAME_TYPES = Object.keys(RELAY_DAEMON_SCHEMAS) as RelayDaemonFrameType[]

/** The discriminated union of every fully-validated relay↔daemon frame. */
export const RelayDaemonFrame = z.discriminatedUnion('type', [
  frameSchema('rd/hello', RELAY_DAEMON_SCHEMAS['rd/hello']),
  frameSchema('rd/hello/ok', RELAY_DAEMON_SCHEMAS['rd/hello/ok']),
  frameSchema('rd/msg', RELAY_DAEMON_SCHEMAS['rd/msg']),
  frameSchema('rd/ack', RELAY_DAEMON_SCHEMAS['rd/ack']),
  frameSchema('rd/agentmsg', RELAY_DAEMON_SCHEMAS['rd/agentmsg']),
  frameSchema('rd/agentmsg/fwd', RELAY_DAEMON_SCHEMAS['rd/agentmsg/fwd']),
  frameSchema('rd/agentmsg/ack', RELAY_DAEMON_SCHEMAS['rd/agentmsg/ack']),
  frameSchema('rd/chat', RELAY_DAEMON_SCHEMAS['rd/chat']),
  frameSchema('rd/webchat-post', RELAY_DAEMON_SCHEMAS['rd/webchat-post']),
  frameSchema('error', RELAY_DAEMON_SCHEMAS['error'])
])
export type RelayDaemonFrame = z.infer<typeof RelayDaemonFrame>

/** Runtime guard: is `t` a known relay↔daemon frame `type`? */
export function isRelayDaemonFrameType(t: string): t is RelayDaemonFrameType {
  return Object.prototype.hasOwnProperty.call(RELAY_DAEMON_SCHEMAS, t)
}

/** Decode one relay↔daemon wire frame (envelope + typed payload). */
export function decodeRelayDaemonFrame(text: string): DecodeResultOf<RelayDaemonFrame> {
  return decodeEnvelopeWith<RelayDaemonFrame>(RELAY_DAEMON_SCHEMAS, text)
}

/** Build a relay↔daemon frame with a compile-time-typed payload. */
export function buildRelayDaemonFrame<T extends RelayDaemonFrameType>(
  type: T,
  payload: z.input<(typeof RELAY_DAEMON_SCHEMAS)[T]>,
  opts: BuildOpts = {}
): RelayDaemonFrame {
  return buildEnvelopeRaw(type, payload, opts) as RelayDaemonFrame
}
