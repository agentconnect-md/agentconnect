import type { ToolDescriptor } from './tools.js'
import type { MemoryProvider } from '../agents/memory-provider.js'
import {
  rootPostNeedsThreadMaterialization,
  rootPostThreadName,
  threadKeyForPost,
  threadKeyNeedsDmClassification
} from '../platforms/thread-keys.js'
import {
  directMessagePlatformFor,
  directMessagePlatformList,
  isAttachmentReadTool,
  offersDirectMessages,
  platformLabel
} from '../platforms/read-ports.js'
import type {
  ChannelAgentsReq,
  ChannelAgentsOk,
  KnowledgeSearchOk,
  OrgSkillsOk,
  Platform
} from '@agentconnect.md/protocol'
import { randomUUID } from 'node:crypto'
import { MemoryPathError, MemoryTooLargeError } from '../agents/memory.js'
import type {
  GithubInlineReviewComment,
  GithubReviewEffect,
  GithubReviewEvent,
  GithubReviewVerdict,
  SubmitGithubReviewInput
} from '../github/review.js'

/**
 * The platform-neutral slice a session's tools need. `SlackConnection` and
 * `TelegramConnection` both implement this; tests pass a fake. Read methods
 * return already-shaped plain objects so the tool results are stable regardless
 * of the underlying platform SDK response. "channel" is the platform conversation
 * id (Slack channel `C…` / Telegram chat id); "user" is a platform user id.
 */
/** Optional per-message sender identity for {@link MessageGateway}. Slack can render
 *  the name/avatar (via `chat:write.customize`) and persist the stable AgentConnect
 *  author id in message metadata; other platforms ignore these fields. */
export interface SendIdentity {
  username?: string
  /** Public https image URL for the message avatar (the agent's icon). */
  icon_url?: string
  /** Stable AgentConnect author id persisted in Slack message metadata. */
  agentAuthorId?: string
  /**
   * The finalized-response block for the VISIBLE half of a paired `toAgent + channel`
   * send (send-message-routing-rework.md §3.2/§4).
   *
   * Unlike a streamed turn reply, this post is complete the moment it is made — there is
   * no later finalization edit to close it — so it is stamped `final` here, carrying the
   * pairing id the target's activation rendezvous keys on. Without it the platform half
   * of a paired call arrives at ingress indistinguishable from an ordinary agent reply,
   * and the platform-first arrival order can never be recognized as one.
   */
  response?: {
    responseId: string
    deliveryState: 'streaming' | 'final'
    hopCount: number
    mentionedAgentIds: string[]
    agentCallDeliveryId?: string
  }
}

export interface MessageGateway {
  /** Layer-1 `openDirectMessage`: resolve one platform user to the app's real
   *  direct-message conversation. Optional because it is a declared read port,
   *  not a universal one — Slack needs it before posting with a customized agent
   *  identity (sending to a raw U… id routes the message through Slack's
   *  system-notification DM); a platform without the port has no `toUser` form. */
  openDirectMessage?(user: string): Promise<string>
  /** Post a message; returns the resulting message id (`ts` / message_id) so the
   *  daemon can record it. `identity` carries the agent's stable id and optional
   *  visual identity; other platforms may ignore it. */
  postMessage(channel: string, text: string, threadTs?: string, identity?: SendIdentity): Promise<string | undefined>
  /** Materialize a provider-native thread from a root message when that platform
   *  requires one before the post can own a follow-up session (Discord). */
  createThread?(channel: string, messageId: string, name: string): Promise<string | undefined>
  getChannelInfo(channel: string): Promise<{ id: string; name?: string; isIm?: boolean; isPrivate?: boolean }>
  listMembers(channel: string): Promise<{ id: string; name?: string; isBot?: boolean }[]>
  listChannels(): Promise<{ id: string; name?: string; isPrivate?: boolean }[]>
  getUserProfile(user: string): Promise<{ id: string; name?: string; realName?: string; isBot?: boolean }>
  /** Download an auth-gated file (Slack url_private / Telegram file_id) with the
   *  bot credentials; null on failure / over-cap. Backs the `read*File` tools so
   *  the agent can read attachments without ever holding the token. */
  downloadFile(sourceUrl: string, maxBytes?: number): Promise<Buffer | null>
}

/**
 * A tool result that should be handed to the agent as native MCP content blocks
 * (e.g. a viewable image) rather than JSON-stringified text. The bridge detects
 * the `mcpContent` marker and passes the blocks through verbatim.
 */
export interface McpContentResult {
  mcpContent: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]
  /** Preserve a remote MCP tool's semantic error without converting its content. */
  mcpIsError?: boolean
}

/** Per-session binding captured at `session/new`, keyed by the IPC token. */
export interface SessionContext {
  agentId: string
  /** The platform that triggered this session (slack/telegram/…). Trusted — set
   *  by the daemon from the real triggering message, never a tool input. Used to
   *  build the coords for peer-discovery (`listAgents`). */
  platform: string
  /** The exact platform integration that delivered this session. Absent for a
   *  platform-free session; daemon-local universal tools still work there. */
  integrationId?: string
  /** Opaque physical-bot identity captured by the daemon. Platform coordinates
   *  can overlap across bots, so daemon-local session lookups include this scope. */
  transportScope?: string
  /** Whether the trusted source conversation is a direct message. Slack native
   *  thread titles are valid only for app-DM sessions. */
  isDm: boolean
  channel: string
  thread: string
  tools: ToolDescriptor[]
  /** Snapshot of the agent's integrations (id + platform) at session/new. Lets the
   *  platform-neutral `sendMessage` tool route to ANY connected platform,
   *  not just the one that triggered this session. Absent ⇒ fall back to the
   *  current session's own integration (same-platform send only). */
  integrations?: { id: string; platform: string }[]
  /** The agent's display identity (displayName || name), stamped on tool sends so
   *  they match the agent's ordinary replies. The model never supplies this. */
  agentName?: string
  /** The agent's public avatar URL, sibling of {@link agentName}. */
  iconUrl?: string
}

/** A trusted session-title update. Every coordinate comes from the registered
 *  session context; the model supplies only `title`. */
export interface SetSessionTitleReq {
  agentId: string
  platform: string
  integrationId?: string
  transportScope?: string
  isDm: boolean
  channel: string
  thread: string
  title: string
}

/**
 * A trusted agent-authored thread-message + attention request, assembled by the daemon
 * from the caller's session context — NOT from tool input. The daemon appends the public
 * first-class row, applies target wake policy, and dispatches only the addressed agent.
 */
export interface MessageAgentReq {
  /** Trusted caller identity (== `ctx.agentId`). Never a tool input. */
  callerAgentId: string
  /** Trusted source platform (== `ctx.platform`). Never a tool input. */
  platform: string
  /** Trusted source integration. Used to publish the agent's first-class thread
   *  message through the same platform identity as its current session. */
  callerIntegrationId?: string
  /** Trusted physical-bot scope of the caller session. */
  callerTransportScope?: string
  /** Trusted caller session coords (== the caller's {@link SessionContext} channel/thread).
   *  Never a tool input. The daemon uses these + `callerAgentId` to recompute the caller's
   *  logical sessionKey and resolve the CURRENT turn's trusted call metadata (§6.7), so a
   *  nested `messageAgent` can auto-inherit hop/origin (all calls) and correlationId (replies
   *  only) without the agent hand-copying anything. */
  callerChannel: string
  callerThread: string
  toAgentId: string
  text: string
  /** Target channel; defaults (in the handler) to the caller's current channel. */
  channel: string
  /** Target thread; undefined ⇒ channel root / target's default thread. */
  thread?: string
  /** When this wake was preceded by a visible channel post (`toAgent`+`channel`), the post's
   *  real platform `ts`. Threaded through so the woken turn's transcript row lands on the SAME
   *  (channel, thread, ts) primary key as the recorded post — deduping the two representations —
   *  and so the new session's read cursor stays a canonical platform ts (mirrors
   *  {@link spawnChannelRootSession}). Absent for a postless wake. */
  transcriptTs?: string
  correlationId?: string
  /** session-concept §5.3: the caller asked the woken session to report back when it is done or
   *  has failed (`toAgent.needsReply`). The daemon turns this into a standing directive on the
   *  child's session — it is NOT part of the delivered message text. */
  needsReply?: boolean
  /**
   * send-message-routing-rework.md §3.2: the daemon-minted id shared by this wake and the
   * visible post that accompanied it. Present only on the paired `toAgent + channel` form;
   * it is what lets the target's activation rendezvous recognize the internal wake and the
   * platform echo as ONE delivery in either arrival order.
   */
  agentCallDeliveryId?: string
  /**
   * send-message-routing-rework.md §3.1: this is the POSTLESS `toAgent` form (no
   * `channel`), so the woken child runs HEADLESS — it emits no platform output of its own.
   *
   * Without it, "postless" would only describe the wake and not the delegation: nothing is
   * posted to announce the call, but the child's own answer would still appear in the
   * caller's channel, which is exactly the interruption the postless form exists to avoid.
   * The child keeps everything that makes it followable — origin lineage, hop count,
   * correlation, `needsReply`, and `viewSessionStatus` — and reports back through the
   * parent-session reply, whose injected body is likewise never published.
   *
   * Set only by `sendMessage`'s agent target. Other internal callers (orchestration, the
   * intro fan-out) keep their existing visibility, which they express themselves.
   */
  postless?: boolean
}

/** The result of an agent→agent delivery. `delivered:false` carries a typed `reason`
 *  (`self` / `invalid_target` / `not_allowed` / `not_local` / `no_agent`). `targetSession` is the local
 *  session key the message was (or would be) delivered into. */
export interface MessageAgentResult {
  delivered: boolean
  targetSession: string
  reason?: string
}

/**
 * A trusted request to read the status of a session the caller STARTED. Everything except
 * `sessionId` comes from the trusted {@link SessionContext}; the caller coords let the daemon
 * recompute the caller's own session and verify that `sessionId` really is one of its children
 * (the mirror image of {@link ReplyToSessionReq}'s origin-only rule — a parent may read down
 * its own lineage, a child may reply up it, and nobody may reach sideways).
 */
export interface SessionStatusReq {
  /** Trusted caller identity (== `ctx.agentId`). Never a tool input. */
  callerAgentId: string
  /** Trusted source platform / caller session coords (== the caller's {@link SessionContext}). */
  platform: string
  callerChannel: string
  callerThread: string
  /** Trusted physical-bot scope of the caller's session, when it has one. Part of the caller's
   *  logical session key, so it must travel for the lineage lookup to find the right row. */
  callerTransportScope?: string
  /** The ONLY untrusted field: the child session's id, as handed back by `sendMessage`. */
  sessionId: string
}

/** A child session's coarse progress, collapsed from the §7.3 lifecycle state plus the last
 *  completed turn's outcome. `in-progress` covers "queued but not started yet" too. */
export interface SessionStatusResult {
  /** Echo of the requested id, so a polling caller can match up concurrent children. */
  sessionId: string
  /** The agent that owns the child session. */
  agentId: string
  status: 'in-progress' | 'failed' | 'done'
  /** The underlying lifecycle state, for a caller that wants the detail: one of the §7.3
   *  states, or 'starting' when the wake was admitted but the session has not opened yet. */
  state: 'starting' | 'idle' | 'prompting' | 'cancelling' | 'resuming' | 'closed'
  /** Epoch ms of the last state change; absent while the session is still 'starting'. */
  updatedAt?: number
}

/**
 * A trusted request to reply into an existing session addressed by its stable id
 * (session-concept §5.2 — `sendMessage`'s SessionTarget). Every field except `sessionId`,
 * `text`, and the optional `correlationId` override is filled by the daemon from the trusted
 * {@link SessionContext}; the caller coords let the daemon recompute the caller's logical
 * sessionKey and read the CURRENT turn's trusted call metadata, which is the ONLY basis for
 * authorizing `sessionId` (it must equal the turn's `originSessionId`) — an agent can only
 * reply into its own origin, never inject into an arbitrary session.
 */
export interface ReplyToSessionReq {
  /** Trusted caller identity (== `ctx.agentId`). Never a tool input. */
  callerAgentId: string
  /** Trusted source platform / caller session coords (== the caller's {@link SessionContext}). */
  platform: string
  callerTransportScope?: string
  callerChannel: string
  callerThread: string
  /** The ONLY untrusted field: the target session's stable id (the child's `Parent session`).
   *  The daemon authorizes it against the caller's active-turn origin. */
  sessionId: string
  text: string
  /** Optional correlationId override (advanced). Normally inherited from the origin turn. */
  correlationId?: string
}

/** The result of a SessionTarget reply. `delivered:false` carries a typed reason
 *  ('not_authorized' when the sessionId isn't the caller's origin; 'unsupported' when a
 *  cross-daemon reply reached a target too old to advertise `headless-agent-delivery-v1`,
 *  which is REFUSED rather than delivered — a legacy fence from when this delivery kind
 *  muted the parent turn, send-message-routing-rework.md §7/§8.4; the rest mirror the
 *  cross-daemon agent-msg verdicts for a reply that had to route over the relay). */
export interface ReplyToSessionResult {
  delivered: boolean
  targetSession?: string
  reason?:
    | 'not_authorized'
    | 'not_found'
    | 'hop_limit'
    | 'offline'
    | 'not_local'
    | 'busy'
    | 'queue_full'
    | 'not_allowed'
    | 'unsupported'
}

/** One subtask of a {@link StartOrchestrationReq}: an instruction for one worker. */
export interface OrchestrationSubtaskInput {
  toAgentId: string
  text: string
}

/**
 * A trusted request to start an orchestration (§3.4/§6.8), assembled by the daemon from
 * the caller's session context — the main identity + session coords come from the trusted
 * {@link SessionContext}, NEVER from tool input. Tool input contributes only the subtasks,
 * the optional deadline, and the opaque replyTarget.
 */
export interface StartOrchestrationReq {
  /** Trusted main agentId (== `ctx.agentId`). */
  mainAgentId: string
  /** Trusted source platform / coords (== the caller's SessionContext). */
  platform: string
  channel: string
  thread: string
  integrationId?: string
  transportScope?: string
  subtasks: OrchestrationSubtaskInput[]
  deadlineMs?: number
  replyTarget?: string
}

export interface StartOrchestrationResult {
  orchestrationId: string
  delivered: string[]
  failed: { correlationId: string; reason: string }[]
}

/** A trusted owner-checked read/cancel of an orchestration (§3.5a). The owning main
 *  identity + session coords come from the trusted {@link SessionContext}. */
export interface OrchestrationOwnerReq {
  mainAgentId: string
  platform: string
  channel: string
  thread: string
  transportScope?: string
  orchestrationId: string
}

/** A formal PR review request with its caller identity/session coordinates
 * filled from the trusted MCP SessionContext. No GitHub target is model input. */
export interface SubmitGithubReviewReq extends SubmitGithubReviewInput {
  agentId: string
  platform: string
  channel: string
  thread: string
  transportScope?: string
}

/** Refusal surfaced to the model when an isolated session tries to access
 *  agent memory shared with other users. Phrased so the agent stops retrying
 *  instead of attempting to reconstruct or persist the content another way. */
export const MEMORY_ACCESS_BLOCKED =
  'Shared agent memory is unavailable in this session. Keep the information in this conversation instead; do not retry.'

/**
 * A peer-discovery request, i.e. `ChannelAgentsReq` plus the caller's own session
 * coordinates. `channel` is what the AGENT asked for (absent ⇒ the org-wide directory);
 * every `current*` field is the TRUSTED session context, never tool input, carried
 * separately for two daemon-side jobs:
 *  - substituting the current channel when the CP does not advertise
 *    `agent-directory-org-scope-v1` (an old CP rejects a channel-less payload), and
 *  - resolving the caller's LOGICAL sessionKey, so the daemon can recognize a turn whose
 *    discovery scope it FIXED itself (the self-introduce-on-join turn, whose fan-out must
 *    stay bounded to the joined channel however the model calls the tool).
 */
export interface ChannelAgentsRequest extends ChannelAgentsReq {
  currentChannel?: string
  currentThread?: string
  currentTransportScope?: string
}

export interface OpsDeps {
  /** Fail-closed turn gate checked before every daemon bridge tool. Used to make
   *  pause/cancel/loop interrupts terminal even while the runtime is still unwinding. */
  canRun?: (ctx: SessionContext) => boolean
  /** Persist and fan out a model-authored user-facing session title. */
  setSessionTitle: (req: SetSessionTitleReq) => Promise<void> | void
  /** Resolve the live platform connection that owns this integration (may rotate). */
  gatewayFor: (integrationId: string) => MessageGateway | undefined
  /** Conversation targets this agent has been triggered in on a platform, from local
   *  session history. Backs the `listChannels` fallback for platforms whose bot API
   *  can't enumerate chats (Telegram). Absent ⇒ no fallback (empty live list stands). */
  observedChannels?: (agentId: string, platform: string) => { id: string; name?: string }[]
  /** Users this agent has been triggered by on a platform, from local session history.
   *  Backs `listKnownUsers` so an agent can find a user id to DM where there is no
   *  user directory to search. */
  observedUsers?: (agentId: string, platform: string) => { id: string; name?: string }[]
  /** Ask the CP for the caller's callable peers (peer discovery). The daemon fills
   *  `requesterAgentId` from the trusted session context, never tool input. An absent
   *  `channel` asks for the ORG-WIDE directory; a present one narrows it to that
   *  channel. Rejects (throws) when the control plane isn't connected — discovery
   *  fails closed rather than returning a partial/empty roster. */
  channelAgents: (req: ChannelAgentsRequest) => Promise<ChannelAgentsOk>
  /**
   * The exact platform-native `@mention` addressing `agentId` in one conversation
   * (send-message-routing-rework.md §8.5), or undefined when it has none there.
   *
   * Two callers, one source of truth: `listAgents` exposes it so the model can address a
   * peer in its ordinary reply without guessing from a display name, and a
   * `toAgent + channel` send renders it into the visible post. Resolved from the daemon's
   * conversation directory — never from model text — so it can only ever name an agent the
   * caller could already reach, and it stays consistent with what INGRESS will resolve the
   * same token back to. Undefined on a daemon with no collaboration snapshot.
   */
  mentionAddressFor?: (req: { agentId: string; platform: string; channel: string }) => string | undefined
  /**
   * TRUSTED depth of the caller's CURRENT turn — 0 for a human/root turn
   * (send-message-routing-rework.md §4.1).
   *
   * A DEP rather than a `SessionContext` field because depth is per-TURN while the MCP
   * session context is registered once per ACP session: a snapshotted value would be
   * correct on the first turn and silently stale on every one after it, which for a loop
   * guard is the worst kind of wrong. The daemon resolves it from active-turn call
   * metadata at call time; the model can neither read nor set it.
   */
  currentHopCount?: (ctx: SessionContext) => number
  /** Owner-approved organization knowledge search; requester identity is bound
   * from the trusted session context. */
  findKnowledge?: (req: {
    requesterAgentId: string
    query: string
    limit: number
    maxBytes: number
    tags?: string[]
  }) => Promise<KnowledgeSearchOk>
  /** Browse recent org knowledge (query-less); requester identity bound from the
   * trusted session context. */
  listKnowledge?: (req: {
    requesterAgentId: string
    limit: number
    maxBytes: number
    tags?: string[]
  }) => Promise<KnowledgeSearchOk>
  /** List or search accepted org skills (metadata only); requester identity bound
   * from the trusted session context. `query` present ⇒ filter, absent ⇒ list. */
  orgSkills?: (req: { requesterAgentId: string; query?: string; limit: number }) => Promise<OrgSkillsOk>
  /** Deliver a message into another agent's session (agent→agent wake). The daemon
   *  fills the trusted caller identity from the session context; this callback owns
   *  the same-daemon delivery (policy check, coord/integration resolution, dispatch)
   *  and the cross-daemon `not_local` stub. */
  messageAgent: (req: MessageAgentReq) => Promise<MessageAgentResult>
  /** Side-effect-free preflight for a peer wake: returns a typed rejection reason if
   *  {@link messageAgent} would refuse this wake for a locally-decidable reason (capability
   *  disabled, invalid target id, a postless self-call, hop-limit, caller outbound policy, or a LOCAL
   *  target's inbound policy/channel membership), else null. `sendMessage` uses it to skip the visible channel post for a
   *  `toAgent`+`channel` wake that will not be delivered. Absent in the chat CLI / tests with
   *  no daemon ⇒ the post is not gated (treated as null). */
  preflightWake?: (req: MessageAgentReq) => string | null
  /** Reply into an existing session addressed by its stable id (session-concept §5.2). The
   *  daemon fills the trusted caller identity from the session context, authorizes `sessionId`
   *  against the caller's active-turn origin (origin-only, fail-closed), auto-inherits the
   *  origin turn's correlationId, and inserts a {type:system, from:<caller>} message —
   *  routing local or cross-daemon. Backs `sendMessage`'s SessionTarget. */
  replyToSession: (req: ReplyToSessionReq) => Promise<ReplyToSessionResult>
  /** How a channel-ROOT post this session just made relates to the conversations the session is
   *  ALREADY part of: `parent` = the origin session waiting on an answer (named, so the caller can
   *  address it), `self` = this session's own conversation, undefined = an unrelated destination,
   *  i.e. the ordinary new-topic post. The daemon answers because it owns the identity rules —
   *  a channel id means a different conversation under a different transport scope, and the
   *  parent link may only exist as the durable origin on the session row (a relayed answer runs
   *  on a human-triggered turn with no call metadata at all). Absent in the chat CLI / tests with
   *  no daemon ⇒ no notice. */
  rootPostRelation?: (req: {
    callerAgentId: string
    platform: string
    callerTransportScope?: string
    callerChannel: string
    callerThread: string
    targetPlatform: string
    targetChannel: string
    /** The post's own session-thread key ({@link threadKeyForPost}). A conversation is only
     *  FORKED when this differs from the thread that conversation lives on. Discord guild roots
     *  are materialized as native threads; Telegram / Feishu / Discord DMs map back onto their
     *  continuous conversation, so they fork nothing and the reader did receive the post. */
    targetThread: string
    targetIntegrationId?: string
  }) => { kind: 'parent'; sessionId: string } | { kind: 'self' } | undefined
  /** Read the progress of a session the caller started (backs `viewSessionStatus`). The daemon
   *  fills the trusted caller identity from the session context and authorizes `sessionId`
   *  against the caller's own children, fail-closed. Returns null when the id is unknown or is
   *  not a child of the calling session — the tool surfaces both as the same error, so a caller
   *  cannot probe for the existence of sessions it may not read. Absent in the chat CLI / tests
   *  with no daemon ⇒ the tool reports that status is unavailable. */
  viewSessionStatus?: (req: SessionStatusReq) => Promise<SessionStatusResult | null>
  /** session-concept case 2a: an agent's channel-ROOT post seeds a NEW session owned by the same
   *  agent (origin = the current session), so a deliberate top-level post starts its own context.
   *  Only called for a root post (no thread) with no toAgent. Fire-and-forget; the daemon creates
   *  the session without running a model turn, then replays the root as context on the first real
   *  reply. Absent in the chat CLI / tests (no daemon) — then a root post is a plain post with no
   *  session spawn. Returns whether the daemon ACCEPTED the post as a seed — `false` when it
   *  declines outright (the agent-call hop limit). Acceptance is not completion: the seed itself
   *  is dispatched fire-and-forget and can still fail later, so nothing downstream may state a
   *  session as an accomplished fact. */
  spawnChannelRootSession?: (req: {
    agentId: string
    platform: string
    integrationId?: string
    channel: string
    /** The post's session-thread key ({@link threadKeyForPost}) — the new session's thread
     *  segment, and the same key an inbound reply to this post canonicalizes to. */
    thread: string
    /** The post's RAW platform ts. The seed's transcript row must carry a real, comparable
     *  platform ts (see the dedup note in `spawnChannelRootSession`), which on Telegram is
     *  NOT the same string as `thread`. */
    postTs: string
    text: string
    /** Current (origin) session coords, for the new session's origin lineage. The origin
     *  may be on a DIFFERENT platform than the post (e.g. a Telegram turn posting to Slack),
     *  so its platform must travel too — otherwise the origin session key can't be resolved. */
    originPlatform: string
    originTransportScope?: string
    originChannel: string
    originThread: string
  }) => boolean
  /** Start an orchestration (§3.4/§6.8): record-first, then deliver each subtask, then
   *  schedule the deadline. The daemon fills the trusted main identity + coords from the
   *  session context. Returns null when the caller is not allowed to orchestrate (never today). */
  startOrchestration: (req: StartOrchestrationReq) => Promise<StartOrchestrationResult>
  /** Read one orchestration, owner-checked (only the owning main+session). Returns null
   *  when the id is unknown or the caller is not the owner. */
  getOrchestration: (req: OrchestrationOwnerReq) => Promise<unknown | null>
  /** Cancel one orchestration, owner-checked. Returns false when unknown / not the owner. */
  cancelOrchestration: (req: OrchestrationOwnerReq) => Promise<boolean>
  /** Execute the R1 formal-review effect against the daemon-private active PR
   * turn. The implementation owns action-time CP authorization and head/base
   * fencing; ordinary sessions fail closed. */
  submitGithubReview?: (req: SubmitGithubReviewReq) => Promise<GithubReviewEffect>
  /** The agent memory provider — backs the `readMemory`/`writeMemory` tools.
   *  Universal (every agent has memory), independent of the platform. */
  memory: MemoryProvider
  /** Session-isolation gate for the explicit memory-tool path, by operation
   *  (#653). Agent memory is shared across users: every session may READ it
   *  (read/search/get), but only a non-isolated session may WRITE it
   *  (write/save/update/delete), so a private DM/A2A turn cannot push its content
   *  into shared memory. Automatic recall is always allowed; post-turn capture and
   *  Dream selection are gated at their own boundaries. Checked at CALL time so a
   *  mid-session policy change takes effect immediately. Absent ⇒ allowed (e.g. in
   *  unit fixtures). */
  memoryAccessAllowed?: (ctx: SessionContext, mode: 'read' | 'write') => boolean
  /** Collaboration Arena §6: resolve + execute an evaluation-registry tool.
   *  Returns undefined when `name` is not an evaluation tool. Visibility and
   *  role-aware authorization live behind this seam (the daemon guarantees
   *  authentic caller identity; the game decides whether the action is legal). */
  evaluationTool?: (
    ctx: SessionContext,
    name: string,
    args: Record<string, unknown>
  ) => Promise<{ result: unknown } | undefined>
  /** Record an agent-sent message into the session transcript. */
  recordOutbound: (
    ctx: SessionContext,
    channel: string,
    thread: string | undefined,
    text: string,
    ts: string,
    integrationId: string
  ) => void
  /** Monotonic-ish clock for synthesizing a message id when the platform doesn't return one. */
  now: () => number
  /** Byte cap for `read*File` downloads (defaults to 8 MiB). */
  maxAttachmentBytes?: number
}

const DEFAULT_MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024

/**
 * Resolve the live gateway for one of the agent's OWN platforms, used by every
 * platform-neutral tool (send + reads). The candidate set is the trusted session
 * snapshot (never tool input); the caller can only reach its own integrations.
 * `wantIntegrationId` picks a specific bot; otherwise it prefers the current
 * session's integration on that platform (so a same-conversation call stays put)
 * and falls back to the first candidate for a genuine cross-platform target.
 * `sameConvo` reports whether the resolved target is this session's own integration.
 */
/** The agent's own integrations from the trusted session snapshot (never tool input),
 *  falling back to the session's single integration in minimal contexts. */
function knownIntegrations(ctx: SessionContext): { id: string; platform: string }[] {
  return ctx.integrations && ctx.integrations.length > 0
    ? ctx.integrations
    : ctx.integrationId
      ? [{ id: ctx.integrationId, platform: ctx.platform }]
      : []
}

/** The agent's own integrations on one platform (0, 1, or many). >1 means a read
 *  tool can't attribute agent+platform-scoped history to a specific bot. */
function integrationsOnPlatform(ctx: SessionContext, platform: string): { id: string; platform: string }[] {
  return knownIntegrations(ctx).filter((i) => i.platform === platform)
}

/** Returned by the history-backed tools when the agent has multiple bots on the target
 *  platform: the local store pools history by agent+platform, so ids can't be attributed
 *  to one bot, and a chat reached via one bot is not reachable by another. */
const MULTI_INTEGRATION_NOTE =
  'This agent has multiple integrations on this platform; observed history is not tracked per bot, ' +
  'so it is suppressed to avoid returning ids that belong to another bot. Pass a specific `integrationId` to ' +
  'listChannels/listChannelMembers/getUserProfile to query a known target on a chosen bot.'

const SEND_MESSAGE_TARGET_HELP =
  'Valid targets: agent {"toAgent":"<agent-id>","message":"..."}; ' +
  'user DM {"toUser":"<Slack-user-id>","message":"..."}; ' +
  'channel users {"toUser":["<id-1>","<id-2>"],"channel":"<channel-id>","message":"..."}; ' +
  'channel {"channel":"<channel-id>","message":"..."}; ' +
  'session {"sessionId":"<Parent session>","message":"..."}'

function resolveGatewayForPlatform(
  ctx: SessionContext,
  deps: OpsDeps,
  platform: string,
  wantIntegrationId?: string
): { gw: MessageGateway; integrationId: string; sameConvo: boolean } {
  const candidates = knownIntegrations(ctx).filter((i) => i.platform === platform)
  if (candidates.length === 0) throw new Error(`this agent has no ${platform} integration`)
  const target = wantIntegrationId
    ? candidates.find((i) => i.id === wantIntegrationId)
    : (candidates.find((i) => i.id === ctx.integrationId) ?? candidates[0])
  if (!target) throw new Error(`this agent has no ${platform} integration with id ${wantIntegrationId}`)
  const gw = deps.gatewayFor(target.id)
  if (!gw) throw new Error(`no live ${platform} connection for integration ${target.id}`)
  return { gw, integrationId: target.id, sameConvo: target.id === ctx.integrationId }
}

/** Best-effort MIME guess from a Slack file URL's extension (used when the caller
 *  doesn't pass a mimeType hint). */
function guessMimeFromUrl(url: string): string | undefined {
  const ext = url.split('?')[0]?.split('.').pop()?.toLowerCase()
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    txt: 'text/plain',
    md: 'text/markdown',
    json: 'application/json',
    csv: 'text/csv'
  }
  return ext ? map[ext] : undefined
}

/**
 * Execute one tool call inside the daemon and return a plain result object (the
 * bridge wraps it into an MCP `CallToolResult`). Throws on bad input or a
 * missing connection — the caller turns that into an MCP `isError` result.
 */
export async function executeTool(
  ctx: SessionContext,
  name: string,
  args: Record<string, unknown>,
  deps: OpsDeps
): Promise<unknown> {
  if (deps.canRun && !deps.canRun(ctx)) throw new Error('this agent turn has been stopped')
  // Collaboration Arena evaluation tools (collaboration-arena.md §6): game-owned
  // structured actions merged into the session tool set at composition time.
  // Name collisions with product tools are rejected at daemon startup, so this
  // dispatch can never shadow a product tool. The handler receives the trusted
  // token-bound SessionContext — never tool-input-supplied identity.
  if (deps.evaluationTool) {
    const handled = await deps.evaluationTool(ctx, name, args)
    if (handled !== undefined) return handled.result
  }
  // Session naming is daemon-local and platform-neutral. SECURITY: the model
  // contributes only the title; all routing coordinates come from the trusted
  // token-bound SessionContext.
  if (name === 'setSessionTitle') {
    const title = requireString(args, 'title').replace(/\s+/g, ' ').trim()
    if (!title) throw new Error('missing required string argument: title')
    if ([...title].length > 80) throw new Error('session title must be at most 80 characters')
    await deps.setSessionTitle({
      agentId: ctx.agentId,
      platform: ctx.platform,
      ...(ctx.integrationId !== undefined ? { integrationId: ctx.integrationId } : {}),
      ...(ctx.transportScope !== undefined ? { transportScope: ctx.transportScope } : {}),
      isDm: ctx.isDm,
      channel: ctx.channel,
      thread: ctx.thread,
      title
    })
    // Empty native content avoids rendering a redundant tool-result body. The ACP
    // tool activity itself remains observable in the session transcript.
    const result: McpContentResult = { mcpContent: [] }
    return result
  }
  // Memory tools are universal (every agent has memory) and daemon-local — handle
  // them before the platform-gateway gate so an agent with no platform integration works.
  if (name === 'readMemory' || name === 'writeMemory') {
    const mode = name === 'writeMemory' ? 'write' : 'read'
    if (deps.memoryAccessAllowed?.(ctx, mode) === false) throw new Error(MEMORY_ACCESS_BLOCKED)
    const scope = { agentId: ctx.agentId }
    try {
      if (name === 'readMemory') {
        const path = optionalString(args, 'path') ?? 'MEMORY.md'
        return await deps.memory.read(scope, path)
      }
      // writeMemory — exactly one of two modes: full-write (`content`) OR targeted edit
      // (`oldString` + `newString`). Validate the pair ATOMICALLY: either edit field present
      // selects edit mode, and BOTH are then required (so a stray `newString` isn't silently
      // ignored, and an omitted `newString` isn't silently treated as a deletion — deletion
      // must be an explicit `newString: ""`).
      const path = optionalString(args, 'path') ?? 'MEMORY.md'
      const oldString = optionalString(args, 'oldString')
      const newString = optionalString(args, 'newString')
      const content = optionalString(args, 'content')
      const editMode = oldString !== undefined || newString !== undefined
      if (editMode) {
        if (content !== undefined)
          throw new Error('writeMemory: pass EITHER `content` (full write) OR `oldString`+`newString` (edit), not both')
        if (oldString === undefined || newString === undefined)
          throw new Error(
            'writeMemory: an edit needs BOTH `oldString` and `newString` (pass `newString: ""` to delete the matched text)'
          )
        // str-replace: read → replace the single exact occurrence → write the whole file back.
        // Writes are serialized per agent turn, so a read-modify-write race is not a concern.
        const current = (await deps.memory.read(scope, path)).content
        const occurrences = oldString === '' ? 0 : current.split(oldString).length - 1
        if (occurrences === 0)
          throw new Error(
            'writeMemory: `oldString` was not found in the target memory file. Call `readMemory` and copy it from ' +
              'the current `content`; the attempted text may be stale or copied from non-memory session context.'
          )
        if (occurrences > 1)
          throw new Error(
            'writeMemory: `oldString` occurs multiple times — include more surrounding context to make it unique'
          )
        const updated = current.replace(oldString, newString)
        return await deps.memory.write(scope, path, updated, undefined, 'tool')
      }
      const full = requireStringAllowEmpty(args, 'content')
      return await deps.memory.write(scope, path, full, undefined, 'tool')
    } catch (err) {
      if (err instanceof MemoryPathError) throw new Error(`invalid memory path: ${err.message}`)
      if (err instanceof MemoryTooLargeError) throw new Error(err.message)
      throw err
    }
  }

  // External-memory tools are also daemon-local, but operate on canonical
  // records instead of pretending the plugin has files. Re-resolve the current
  // provider on every call so a stale session tool cannot cross a provider or
  // capability change. The trusted agent scope is always ctx.agentId.
  if (['searchMemory', 'saveMemory', 'getMemory', 'updateMemory', 'deleteMemory'].includes(name)) {
    const mode = name === 'searchMemory' || name === 'getMemory' ? 'read' : 'write'
    if (deps.memoryAccessAllowed?.(ctx, mode) === false) throw new Error(MEMORY_ACCESS_BLOCKED)
    const surface = deps.memory.adminSurfaceForAgent?.(ctx.agentId) ?? deps.memory.adminSurface()
    if (!surface || surface.shape !== 'records') throw new Error('record memory is not available for this agent')
    const scope = { agentId: ctx.agentId }
    const requireCapability = (operation: 'recall' | 'create' | 'get' | 'update' | 'delete'): void => {
      if (!surface.capabilities.has(operation)) throw new Error(`record memory does not support ${operation}`)
    }
    if (name === 'searchMemory') {
      requireCapability('recall')
      const topK = optionalBoundedInt(args, 'topK', 1, 20) ?? 5
      const maxBytes = optionalBoundedInt(args, 'maxBytes', 1, 32_768) ?? 8_192
      const records = await surface.search(scope, {
        turnId: randomUUID(),
        query: requireString(args, 'query'),
        topK,
        maxBytes,
        timeoutMs: 3_000
      })
      return { records }
    }
    if (name === 'saveMemory') {
      requireCapability('create')
      const metadata = optionalObject(args, 'metadata')
      const record = await surface.create(scope, {
        operationId: randomUUID(),
        text: requireString(args, 'text'),
        ...(metadata ? { metadata } : {})
      })
      return { record }
    }
    if (name === 'getMemory') {
      requireCapability('get')
      return { record: await surface.get(scope, requireString(args, 'id')) }
    }
    if (name === 'updateMemory') {
      requireCapability('update')
      const metadata = optionalObject(args, 'metadata')
      const version = optionalString(args, 'version')
      const record = await surface.update(scope, {
        operationId: randomUUID(),
        id: requireString(args, 'id'),
        text: requireString(args, 'text'),
        ...(metadata ? { metadata } : {}),
        ...(version ? { version } : {})
      })
      return { record }
    }
    requireCapability('delete')
    const id = requireString(args, 'id')
    const version = optionalString(args, 'version')
    return {
      id,
      deleted: await surface.delete(scope, {
        operationId: randomUUID(),
        id,
        ...(version ? { version } : {})
      })
    }
  }

  // Peer discovery is daemon→CP (not a platform gateway op) and org-level, so it is
  // handled before the gateway gate — a memory-only agent can still discover peers.
  // `channel` is now an OPTIONAL FILTER with NO default: omitted ⇒ the org-wide
  // directory of peers the call policy admits, which is the only scope a session with
  // no IM integration (webchat, hook, dream) can be listed in at all. `listChannelAgents`
  // stays a working alias so sessions already warm with the old tool set keep working.
  // SECURITY: requesterAgentId + platform come from the trusted session context, never
  // from tool input; `channel` is the only agent-supplied field, and it can only narrow —
  // and even that is overridden for a turn the daemon itself scoped (see the `current*`
  // coords below / ChannelAgentsRequest).
  if (name === 'listAgents' || name === 'listChannelAgents') {
    const channel = optionalString(args, 'channel')
    const res = await deps.channelAgents({
      platform: ctx.platform as Platform,
      ...(channel !== undefined ? { channel } : {}),
      // Trusted coordinates, not a scope request — see ChannelAgentsRequest (they carry the
      // old-CP fallback channel and identify THIS turn for a daemon-fixed discovery scope).
      currentChannel: ctx.channel,
      currentThread: ctx.thread,
      ...(ctx.transportScope !== undefined ? { currentTransportScope: ctx.transportScope } : {}),
      requesterAgentId: ctx.agentId
    })
    // §8.5: a CHANNEL-FILTERED listing carries each peer's exact `mention` token, so the
    // model can address it in its ordinary reply (§2.1) instead of guessing an address
    // from a display name. An ORG-WIDE listing deliberately omits it — there is no single
    // conversation-specific address for an agent that may appear in many channels behind
    // different bots, and a wrong token would silently address nobody.
    const scopedChannel = res.channel
    const agents =
      scopedChannel !== undefined && deps.mentionAddressFor
        ? res.agents.map((agent) => {
            const mention = deps.mentionAddressFor?.({
              agentId: agent.agentId,
              platform: res.platform,
              channel: scopedChannel
            })
            return mention ? { ...agent, mention } : agent
          })
        : res.agents
    return {
      platform: res.platform,
      ...(res.channel !== undefined ? { channel: res.channel } : {}),
      agents
    }
  }

  if (name === 'findKnowledge') {
    if (!deps.findKnowledge) throw new Error('organization knowledge is not available in this session')
    const query = requireString(args, 'query').trim()
    if (!query) throw new Error('query must not be blank')
    const rawLimit = args.limit
    const limit = rawLimit === undefined ? 5 : Number(rawLimit)
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error('limit must be an integer from 1 to 10')
    const rawTags = args.tags
    if (rawTags !== undefined && (!Array.isArray(rawTags) || rawTags.some((tag) => typeof tag !== 'string'))) {
      throw new Error('tags must be an array of strings')
    }
    const tags = rawTags as string[] | undefined
    const result = await deps.findKnowledge({
      requesterAgentId: ctx.agentId,
      query,
      limit,
      maxBytes: 8192,
      ...(tags?.length ? { tags } : {})
    })
    return { items: result.items }
  }

  if (name === 'listKnowledge') {
    if (!deps.listKnowledge) throw new Error('organization knowledge is not available in this session')
    const rawLimit = args.limit
    const limit = rawLimit === undefined ? 10 : Number(rawLimit)
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('limit must be an integer from 1 to 20')
    const rawTags = args.tags
    if (rawTags !== undefined && (!Array.isArray(rawTags) || rawTags.some((tag) => typeof tag !== 'string'))) {
      throw new Error('tags must be an array of strings')
    }
    const tags = rawTags as string[] | undefined
    const result = await deps.listKnowledge({
      requesterAgentId: ctx.agentId,
      limit,
      maxBytes: 8192,
      ...(tags?.length ? { tags } : {})
    })
    return { items: result.items }
  }

  if (name === 'listOrgSkills') {
    if (!deps.orgSkills) throw new Error('organization skills are not available in this session')
    const query = optionalString(args, 'query')?.trim()
    const rawLimit = args.limit
    const limit = rawLimit === undefined ? 20 : Number(rawLimit)
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('limit must be an integer from 1 to 50')
    const result = await deps.orgSkills({
      requesterAgentId: ctx.agentId,
      ...(query ? { query } : {}),
      limit
    })
    return { items: result.items }
  }

  // Unified outbound send (session-concept §3). One tool merges the old `sendPlatformMessage`
  // (post to a platform channel/user) and `messageAgent` (wake a peer agent), plus SessionTarget
  // replies. Universal (any agent — a memory-only agent can still wake a peer / reply), handled
  // before the platform-gateway gate. A MessageTarget uses `toAgent` (wake a peer), `toUser`
  // (reach humans), or a bare `channel`. Omitting `channel` selects a postless peer wake or a
  // user DM; providing it always selects a channel-root post. `sessionId` is a separate reply
  // branch for an existing session.
  // SECURITY: the caller identity + coords come from the trusted session context, never tool input.
  if (name === 'sendMessage') {
    const message = requireString(args, 'message')

    // Discriminant (§3.3): a `sessionId` ⇒ SessionTarget — reply into that existing session.
    const sessionId = optionalString(args, 'sessionId')
    if (sessionId !== undefined) {
      assertOnlyKeys(args, ['sessionId', 'correlationId', 'message'], 'session target')
      const correlationId = optionalString(args, 'correlationId')
      return await deps.replyToSession({
        callerAgentId: ctx.agentId,
        platform: ctx.platform,
        ...(ctx.transportScope !== undefined ? { callerTransportScope: ctx.transportScope } : {}),
        callerChannel: ctx.channel,
        callerThread: ctx.thread,
        sessionId,
        text: message,
        ...(correlationId !== undefined ? { correlationId } : {})
      })
    }

    // MessageTarget — exactly ONE target mode: `toAgent` wakes a peer agent, `toUser` reaches
    // platform users, and `channel` alone posts a bare visible message without addressing
    // anyone. For the two recipient modes, omitting `channel` selects a postless peer wake or
    // user DM; providing `channel` selects a channel-root post. Branch-specific validation
    // below keeps ignored/mixed fields out even when a caller bypasses the advertised JSON
    // Schema (as unit tests and older clients can).
    const { toAgent, needsReply } = parseAgentTarget(args.toAgent)
    const toUsers = parseUserTargets(args.toUser)
    const channel = optionalString(args, 'channel')
    if (toAgent === undefined && toUsers === undefined && channel === undefined) {
      throw new Error(
        `sendMessage: \`toAgent\`, \`toUser\`, or \`channel\` must select the target. ${SEND_MESSAGE_TARGET_HELP}`
      )
    }
    if (toAgent !== undefined && toUsers !== undefined) {
      throw new Error(
        `sendMessage: \`toAgent\` and \`toUser\` are mutually exclusive — pick one mode. ${SEND_MESSAGE_TARGET_HELP}`
      )
    }
    // send-message-routing-rework.md §2.2: NO branch accepts `thread`. A visible send is
    // either a direct message or a channel-ROOT post; addressing the CURRENT thread is the
    // ordinary turn reply's job (§2.1), which already owns the right coordinates,
    // streaming lifecycle, and sender identity. `assertOnlyKeys` is what rejects a `thread`
    // a caller supplies anyway — a stale client, or a model working from an old example —
    // and it rejects LOUDLY rather than ignoring it, because silently posting at the root
    // what the caller meant for a thread is the confusing outcome.
    if (toAgent !== undefined) assertOnlyKeys(args, ['toAgent', 'channel', 'message'], 'agent target')
    else if (toUsers !== undefined) {
      assertOnlyKeys(args, ['toUser', 'channel', 'platform', 'integrationId', 'message'], 'user target')
    } else {
      assertOnlyKeys(args, ['channel', 'platform', 'integrationId', 'message'], 'channel target')
    }
    if (toUsers !== undefined && channel === undefined && Array.isArray(args.toUser)) {
      throw new Error('sendMessage: a `toUser` array requires `channel` — direct messages accept exactly one user id')
    }

    // The trusted wake request (built once) — also fed to the preflight below. `thread` and
    // `transcriptTs` are filled AFTER the post (they depend on the post's ts), so this base copy
    // omits them.
    const baseWakeReq: MessageAgentReq | undefined =
      toAgent !== undefined
        ? {
            callerAgentId: ctx.agentId,
            platform: ctx.platform,
            ...(ctx.integrationId !== undefined ? { callerIntegrationId: ctx.integrationId } : {}),
            ...(ctx.transportScope !== undefined ? { callerTransportScope: ctx.transportScope } : {}),
            callerChannel: ctx.channel,
            callerThread: ctx.thread,
            toAgentId: toAgent,
            text: message,
            channel: channel ?? ctx.channel,
            ...(needsReply ? { needsReply: true } : {}),
            // §3.1: no `channel` ⇒ the postless form, whose child is headless.
            ...(channel === undefined ? { postless: true } : {})
          }
        : undefined
    // PREFLIGHT (side-effect-free): would messageAgent refuse this wake for a locally-decidable
    // reason (capability off / bad target id / postless self-call / hop-limit / a local target
    // that disallows this caller)? If so we must NOT leave a misleading public post for a peer that is never
    // woken — so the post below is gated on `wakeRejection === null`. The wake itself still runs
    // through messageAgent (it re-checks, emits the evaluation event, and returns the typed
    // reason). A REMOTE target's call-policy can't be preflighted here (that verdict lives on the
    // owning daemon); such a rare reject can still leave a post — an accepted residual.
    const wakeRejection = baseWakeReq !== undefined ? (deps.preflightWake?.(baseWakeReq) ?? null) : null

    // (A) Post a visible IM at a platform channel's ROOT, or to a user's DM. The
    // destination is the `channel` for the channel-root form; the `toUser` DM form (no
    // channel) first resolves the member id to the app's own 1:1 conversation through
    // the platform's Layer-1 `openDirectMessage` read port.
    // Routing is by `platform` (+ optional `integrationId`) to ANY platform the agent is
    // connected to; identity is stamped from the trusted session.
    //
    // ALWAYS THE ROOT (send-message-routing-rework.md §2.2): there is no in-thread form at
    // all. Speaking in the current thread is the ordinary turn reply's job (§2.1), and a
    // second visible delivery path into the same thread would compete with it. We post
    // BEFORE any peer wake (B) so the wake can anchor to the post a human sees — that
    // thread is the post's own `ts`, which only exists after the send.
    let post:
      { platform: string; integrationId: string; channel: string; thread: string | null; ts: string } | undefined
    // Set when the root post just forked a conversation this agent is already part of — see the
    // notice built below. Surfaced in the tool RESULT, where the agent reads it inside the same
    // turn it made the call, and can still answer the right way.
    let notice: string | undefined
    // The thread the peer wake / new session anchors to: the root post's own `ts`
    // (undefined if no real ts came back — the peer then falls back to messageAgent's
    // default thread).
    let postedThread: string | undefined
    // A provider-issued id proves that the visible root has a stable conversation
    // boundary. `post.ts` may still use a synthetic local id for display/recording when
    // a best-effort gateway returns no id; that fallback must not authorize a paired wake.
    let providerPostId: string | undefined
    // §3.2: the daemon-minted id that makes the visible post and the internal wake ONE
    // logical delivery. Minted before the post so both halves carry it, and only for the
    // paired form — an ordinary channel post has no wake to pair with, and stamping one
    // would make ingress hold it for an envelope that is never coming.
    const agentCallDeliveryId = toAgent !== undefined && channel !== undefined ? randomUUID() : undefined
    // Destination: an explicit `channel` (channel-root form), else the `toUser` DM form
    // starts from the user id and resolves it below.
    const requestedChannel = channel ?? toUsers?.[0]
    if (requestedChannel !== undefined && wakeRejection === null) {
      const directMessage = toUsers !== undefined && channel === undefined
      // A DM has to land on a platform that can OPEN one, which is rarely the session's
      // own: the caller may be answering in Telegram and DM-ing a colleague elsewhere.
      // The default is therefore the DM-capable platform (Layer-1 `openDirectMessage`),
      // preferring this session's when it qualifies — the generalization of the literal
      // `'slack'` that used to sit here.
      const wantPlatform =
        optionalString(args, 'platform') ?? (directMessage ? directMessagePlatformFor(ctx.platform) : ctx.platform)
      const wantIntegrationId = optionalString(args, 'integrationId')
      const { gw, integrationId: targetId } = resolveGatewayForPlatform(ctx, deps, wantPlatform, wantIntegrationId)
      let body = message
      if (toUsers !== undefined) {
        // Whole `toUser` mode — DM and the channel-root mention form alike — is gated on
        // the DM read port: the mention syntax rendered below is the same platform's.
        if (!offersDirectMessages(wantPlatform)) {
          throw new Error(
            `sendMessage: toUser is only supported on ${directMessagePlatformList()} (not ${wantPlatform}) yet`
          )
        }
        // dm form: the one user id IS the destination and the body is unchanged; the
        // channel-root form @-mentions every named user inside the one visible post.
        if (channel !== undefined) {
          const mentions = toUsers.map((user) => (/^<@[^>]+>$/.test(user) ? user : `<@${user}>`))
          body = `${mentions.join(' ')} ${message}`
        }
      }
      // §3.2: a `toAgent + channel` post RENDERS the target's platform-native mention into
      // the visible body. Without it the post says nothing about who it is for — a human
      // reading the channel sees an unaddressed message, and the peer's own activation
      // would rest entirely on invisible metadata. The address comes from the daemon's
      // conversation directory, never from model text, so it cannot name an agent the
      // caller could not otherwise reach. A target with no address in this conversation
      // (no platform presence there) simply gets an unmentioned post plus its internal
      // wake — the delivery still happens, it is only less legible.
      if (toAgent !== undefined && channel !== undefined) {
        const address = deps.mentionAddressFor?.({
          agentId: toAgent,
          platform: wantPlatform,
          channel: requestedChannel
        })
        if (address) body = `${address} ${message}`
      }
      const postChannel = directMessage ? await openDirectMessage(gw, requestedChannel, wantPlatform) : requestedChannel
      const identity: SendIdentity = {
        ...(ctx.agentName ? { username: ctx.agentName } : {}),
        ...(ctx.iconUrl ? { icon_url: ctx.iconUrl } : {}),
        agentAuthorId: ctx.agentId,
        // §3.2/§4: the visible half of a paired call is COMPLETE when posted — no later
        // finalization edit closes it — so it is stamped `final` with the pairing id here.
        //
        // The recipient set NAMES THE TARGET, and must: ingress selects targets from this
        // field, so an empty set makes the echo unroutable and the platform-first
        // rendezvous unreachable — a lost wake would then leave no record at all, silently,
        // instead of the delivery failure §8.6 promises. It cannot double-activate: the
        // pairing id is checked first at ingress, which routes this event to the
        // claim-an-observation branch and never to dispatch.
        ...(agentCallDeliveryId !== undefined && toAgent !== undefined
          ? {
              response: {
                responseId: agentCallDeliveryId,
                deliveryState: 'final' as const,
                hopCount: deps.currentHopCount?.(ctx) ?? 0,
                mentionedAgentIds: [toAgent],
                agentCallDeliveryId
              }
            }
          : {})
      }
      providerPostId = await gw.postMessage(postChannel, body, undefined, identity)
      const ts = providerPostId ?? `local-${deps.now()}`
      // Whether the target is a DM decides the thread key on the platforms that keep a DM as one
      // continuous conversation, and no id carries that — ask the platform, once, and only where
      // the answer can change the key. A failed lookup falls back to the non-DM conversation
      // rather than failing the send that already happened.
      const isDmTarget = threadKeyNeedsDmClassification(wantPlatform)
        ? ((await gw.getChannelInfo(postChannel).catch(() => undefined))?.isIm ?? false)
        : false
      const mustMaterializeThread = !isDmTarget && rootPostNeedsThreadMaterialization(wantPlatform)
      const materializedThread =
        providerPostId !== undefined && mustMaterializeThread
          ? await gw.createThread?.(postChannel, providerPostId, rootPostThreadName(body))
          : undefined
      const canonicalPostThread =
        providerPostId === undefined
          ? undefined
          : threadKeyForPost(wantPlatform, postChannel, providerPostId, isDmTarget)
      postedThread =
        providerPostId === undefined ? undefined : mustMaterializeThread ? materializedThread : canonicalPostThread
      // Record the post in the thread it BELONGS to — the one it just created for a root post,
      // not the caller's own thread (the daemon's fallback, which for a cross-channel post keys a
      // row to coords that match no session at all). It is also what resolves a later reply to
      // this post back onto this thread, so it must be the same canonical key the session uses.
      deps.recordOutbound(ctx, postChannel, postedThread ?? canonicalPostThread, body, ts, targetId)
      post = { platform: wantPlatform, integrationId: targetId, channel: postChannel, thread: null, ts }
      if (providerPostId !== undefined && mustMaterializeThread && postedThread === undefined) {
        throw new Error(
          `sendMessage: posted root message ${ts}, but its required thread could not be created; no session was started`
        )
      }
      // session-concept case 2a: a root post with NO peer wake seeds a NEW session owned by
      // this agent, keyed by the post's own thread, origin = the current session. When there
      // IS a `toAgent`, the woken peer owns that thread instead (see (B)) — so skip the
      // caller-owned spawn. Also skip when the platform returned no real ts (synthesized
      // `local-*`), which leaves `postedThread` undefined and nothing to key a session on.
      if (toAgent === undefined && postedThread !== undefined && deps.spawnChannelRootSession) {
        const seeded = deps.spawnChannelRootSession({
          agentId: ctx.agentId,
          platform: wantPlatform,
          ...(targetId ? { integrationId: targetId } : {}),
          channel: postChannel,
          thread: postedThread,
          postTs: ts,
          text: body,
          originPlatform: ctx.platform,
          ...(ctx.transportScope !== undefined ? { originTransportScope: ctx.transportScope } : {}),
          originChannel: ctx.channel,
          originThread: ctx.thread
        })
        // A root post is a legitimate way to open a new topic, so this is never blocked — but
        // when it FORKS a conversation the agent is ALREADY part of, the intent was almost
        // certainly to answer, not to fork. Two cases, both observed on relay-the-answer-back
        // agents: forking the conversation of the parent session that is waiting for the answer,
        // and forking the current session's own, whose ordinary turn reply already goes there.
        // Say which one happened and name the address that would have replied.
        //
        // Gated twice, because both claims can be false. `seeded` — the daemon declines outright
        // at the hop limit, and nothing may then say a context opened. And `targetThread`, which
        // the daemon compares against the conversation's own thread: in Telegram / Feishu /
        // Discord DMs a "root" post maps back onto the continuous conversation, so it forks
        // nothing and the message DID reach the reader — saying otherwise would talk an agent
        // into sending twice. Discord guild posts have already materialized a native thread.
        const relation =
          seeded && postedThread !== undefined
            ? deps.rootPostRelation?.({
                callerAgentId: ctx.agentId,
                platform: ctx.platform,
                ...(ctx.transportScope !== undefined ? { callerTransportScope: ctx.transportScope } : {}),
                callerChannel: ctx.channel,
                callerThread: ctx.thread,
                targetPlatform: wantPlatform,
                targetChannel: postChannel,
                targetThread: postedThread,
                ...(targetId ? { targetIntegrationId: targetId } : {})
              })
            : undefined
        if (relation?.kind === 'parent') {
          notice =
            `This posted at the ROOT of the conversation your parent session occupies, so it starts a separate ` +
            `context there instead of answering — the conversation waiting on you did not receive it. To answer ` +
            `it, call sendMessage with {"sessionId":"${relation.sessionId}"}.`
        } else if (relation?.kind === 'self') {
          notice =
            `This posted at the ROOT of the conversation this session is already in, so it starts a separate ` +
            `context instead of continuing it. Your ordinary reply for this turn already reaches this conversation ` +
            `— no sendMessage needed.`
        }
      }
    }

    // (B) Wake a peer agent (A2A, §4). Delivery is DIRECT — the peer is woken with a
    // caller-framed message. WHERE the woken session lands depends on whether a `channel`
    // was given:
    //   • no `channel` ⇒ POSTLESS (#854, send-message-routing-rework.md §3.1): nothing is
    //     left in any channel, and the child session is HEADLESS. Its coordinates are
    //     derived from the trusted caller session rather than from any channel the model
    //     named — availability is not authorization, and a model-supplied channel is not
    //     evidence the caller may reach it.
    //   • with `channel` ⇒ the wake anchors to the VISIBLE root post from (A) (§3.2), so
    //     the collaboration is visible AND threaded: the human-facing post and the peer's
    //     reply share one thread. `transcriptTs` carries the post's real ts so the wake's
    //     transcript row collapses onto the recorded post's (channel, thread, ts) PK — no
    //     duplicate hand-off — and the woken session's cursor stays a canonical platform
    //     ts. This holds cross-daemon too: the ts is forwarded through the relay frames and
    //     stamped on the remote target's turn, so a target that snapshots the shared thread
    //     (conversations.replies) dedups the same way. It is also the pairing key for the
    //     activation rendezvous that admits this delivery exactly once (§8.6).
    let wake: MessageAgentResult | undefined
    if (baseWakeReq !== undefined) {
      const threadForWake = channel !== undefined ? postedThread : ctx.thread
      wake = await deps.messageAgent({
        ...baseWakeReq,
        ...(threadForWake !== undefined ? { thread: threadForWake } : {}),
        ...(channel !== undefined && providerPostId !== undefined ? { transcriptTs: providerPostId } : {}),
        // §3.2: the SAME id the visible post carries, so the target's rendezvous can
        // recognize the two as one delivery whichever arrives first.
        ...(agentCallDeliveryId !== undefined && providerPostId !== undefined ? { agentCallDeliveryId } : {})
      })
    }

    // The woken peer runs in its OWN session, keyed by the coords the wake landed on. Hand that
    // id back at the top level so the caller can follow the work it just delegated
    // (`viewSessionStatus`) without having to reconstruct the key. Only for an ADMITTED wake: a
    // rejected one opened nothing, and `wake.reason` explains why.
    const childSessionId = wake?.delivered === true ? wake.targetSession : undefined
    return {
      ok: true,
      ...(wake !== undefined ? { wake } : {}),
      ...(post !== undefined ? { post } : {}),
      ...(childSessionId !== undefined ? { childSessionId } : {}),
      ...(notice !== undefined ? { notice } : {})
    }
  }

  // Read the progress of a session THIS session started (session-concept §5.3, the read
  // counterpart of a SessionTarget reply). SECURITY: the caller identity + coords come from the
  // trusted session context; `sessionId` is the only tool input and the daemon authorizes it
  // against the caller's own children — an agent cannot inspect an arbitrary session.
  if (name === 'viewSessionStatus') {
    const sessionId = requireString(args, 'sessionId')
    if (!deps.viewSessionStatus) throw new Error('session status is unavailable on this daemon')
    const status = await deps.viewSessionStatus({
      callerAgentId: ctx.agentId,
      platform: ctx.platform,
      callerChannel: ctx.channel,
      callerThread: ctx.thread,
      ...(ctx.transportScope !== undefined ? { callerTransportScope: ctx.transportScope } : {}),
      sessionId
    })
    // Unknown and not-yours are deliberately ONE message: distinguishing them would let a
    // caller probe for sessions it is not allowed to read.
    if (!status) {
      throw new Error(
        `viewSessionStatus: ${sessionId} is not a session started by this session. You can only check sessions you ` +
          'opened yourself — use the `childSessionId` returned by the `sendMessage` call that started it.'
      )
    }
    return status
  }

  // Main-agent orchestration (§3.4/§6.8), daemon→daemon-local — handled before the
  // platform-gateway gate like messageAgent (a memory-only main can still orchestrate).
  // SECURITY: the main identity (mainAgentId) + session coords come from the trusted
  // session context, NEVER from tool input; only the subtasks / deadline / replyTarget
  // come from args. The daemon owns record-first persistence, per-subtask atomic
  // delivered|failed via the messageAgent path, and the one-shot deadline.
  if (name === 'startOrchestration') {
    const rawSubtasks = args.subtasks
    if (!Array.isArray(rawSubtasks) || rawSubtasks.length === 0) {
      throw new Error('missing required argument: subtasks (non-empty array)')
    }
    const subtasks: OrchestrationSubtaskInput[] = rawSubtasks.map((s, i) => {
      if (typeof s !== 'object' || s === null) throw new Error(`subtasks[${i}] must be an object`)
      const so = s as Record<string, unknown>
      return { toAgentId: requireString(so, 'toAgentId'), text: requireString(so, 'text') }
    })
    const deadlineMs = optionalNumber(args, 'deadlineMs')
    const replyTarget = optionalString(args, 'replyTarget')
    return await deps.startOrchestration({
      mainAgentId: ctx.agentId,
      platform: ctx.platform,
      channel: ctx.channel,
      thread: ctx.thread,
      ...(ctx.integrationId !== undefined ? { integrationId: ctx.integrationId } : {}),
      ...(ctx.transportScope !== undefined ? { transportScope: ctx.transportScope } : {}),
      subtasks,
      ...(deadlineMs !== undefined ? { deadlineMs } : {}),
      ...(replyTarget !== undefined ? { replyTarget } : {})
    })
  }

  if (name === 'getOrchestration' || name === 'cancelOrchestration') {
    const orchestrationId = requireString(args, 'orchestrationId')
    const req: OrchestrationOwnerReq = {
      mainAgentId: ctx.agentId,
      platform: ctx.platform,
      channel: ctx.channel,
      thread: ctx.thread,
      ...(ctx.transportScope !== undefined ? { transportScope: ctx.transportScope } : {}),
      orchestrationId
    }
    if (name === 'getOrchestration') {
      const rec = await deps.getOrchestration(req)
      if (rec === null) throw new Error(`no orchestration ${orchestrationId} owned by this session`)
      return rec
    }
    const cancelled = await deps.cancelOrchestration(req)
    if (!cancelled) throw new Error(`no orchestration ${orchestrationId} owned by this session`)
    return { orchestrationId, cancelled: true }
  }

  // Structured formal PR review. Target identity is intentionally absent from
  // args; the daemon recomputes the logical session key from these trusted
  // SessionContext fields and resolves the CURRENT active hook turn.
  if (name === 'submitGithubReview') {
    if (!deps.submitGithubReview) throw new Error('formal GitHub reviews are unavailable on this daemon')
    const event = requireEnum<GithubReviewEvent>(args, 'event', ['COMMENT', 'REQUEST_CHANGES', 'APPROVE'])
    const verdict = requireEnum<GithubReviewVerdict>(args, 'verdict', ['pass', 'fail', 'neutral'])
    const body = requireStringAllowEmpty(args, 'body')
    const comments = parseReviewComments(args.comments)
    return deps.submitGithubReview({
      agentId: ctx.agentId,
      platform: ctx.platform,
      channel: ctx.channel,
      thread: ctx.thread,
      ...(ctx.transportScope !== undefined ? { transportScope: ctx.transportScope } : {}),
      event,
      verdict,
      body,
      ...(comments ? { comments } : {})
    })
  }

  // (Outbound send is handled by the unified `sendMessage` branch above — it merged the
  // former `sendPlatformMessage` + `messageAgent` tools, session-concept §3.)

  // Platform-neutral READ tools. Like the send path, they route by a `platform`
  // argument (defaulting to the current session's platform) to ANY platform the agent
  // is connected to — so an agent handling a Telegram chat can discover Slack channel /
  // user ids to cross-post. Resolved BEFORE the session-gateway gate so the target need
  // not be the integration that triggered this session. SECURITY: the candidate set comes
  // from the trusted session snapshot, never tool input.
  // Known-users discovery is history-backed (no live gateway needed) — a memory of who
  // has messaged this agent on a platform, for platforms with no user directory to search
  // (Telegram/Discord). Handle it before gateway resolution so it works even if that
  // platform's connection is momentarily down. The local session store is keyed by
  // agent+platform, NOT by integration, so when the agent has MORE THAN ONE bot on the
  // platform the pooled history can't be attributed to a specific bot (and a Telegram/
  // Discord chat reached via bot A is not reachable by bot B). Suppress the ambiguous
  // result rather than return ids that may belong to another bot; a specific target is
  // still reachable via getUserProfile(integrationId) once known.
  // ponytail: single-integration attribution; add a per-integration `sessions.integrationId`
  // column if multi-bot-per-platform discovery ever needs the observed history scoped.
  if (name === 'listKnownUsers') {
    const platform = optionalString(args, 'platform') ?? ctx.platform
    if (integrationsOnPlatform(ctx, platform).length === 0) throw new Error(`this agent has no ${platform} integration`)
    if (integrationsOnPlatform(ctx, platform).length > 1) return { platform, users: [], note: MULTI_INTEGRATION_NOTE }
    return { platform, users: deps.observedUsers?.(ctx.agentId, platform) ?? [] }
  }

  if (name === 'listChannels' || name === 'listChannelMembers' || name === 'getUserProfile') {
    const platform = optionalString(args, 'platform') ?? ctx.platform
    const wantIntegrationId = optionalString(args, 'integrationId')
    const { gw, sameConvo } = resolveGatewayForPlatform(ctx, deps, platform, wantIntegrationId)
    if (name === 'listChannels') {
      const live = await gw.listChannels()
      // A platform whose bot API can't enumerate chats (Telegram) returns []; fall back to
      // the chats this agent has actually been active in, from local session history.
      if (live.length > 0) return { platform, channels: live, source: 'live' }
      // The observed fallback is agent+platform-scoped, not per-integration: suppress it
      // when the agent has multiple bots on this platform (see listKnownUsers note).
      if (integrationsOnPlatform(ctx, platform).length > 1)
        return { platform, channels: [], source: 'observed', note: MULTI_INTEGRATION_NOTE }
      const observed = deps.observedChannels?.(ctx.agentId, platform) ?? []
      return { platform, channels: observed, source: observed.length > 0 ? 'observed' : 'live' }
    }
    if (name === 'listChannelMembers') {
      // The current channel only defaults in for a same-platform read; a different
      // platform has no meaningful "current channel", so `channel` is required there.
      const channel = optionalString(args, 'channel') ?? (sameConvo ? ctx.channel : undefined)
      if (!channel)
        throw new Error(`channel is required to list members on ${platform} (a different platform than this session)`)
      return { platform, channel, members: await gw.listMembers(channel) }
    }
    const user = requireString(args, 'user')
    return { platform, ...(await gw.getUserProfile(user)) }
  }

  // Past this point are the session-bound read tools — they need the session's message
  // gateway (bound to the integration that triggered this session). A memory-only
  // session has no `integrationId` and never carries these tools, so this only fires
  // if a read tool is called without a live connection.
  const gw = ctx.integrationId ? deps.gatewayFor(ctx.integrationId) : undefined
  if (!gw) throw new Error(`no live platform connection for integration ${ctx.integrationId ?? '(none)'}`)

  // Any platform's CREDENTIALED attachment read (`readSlackFile`, `readTelegramFile`, …).
  // ONE body for all of them: a platform contributes only the descriptor by declaring the
  // read port, and the fetch itself is the Layer-1 `downloadFile` every connection has, on
  // the gateway this session is already bound to.
  if (isAttachmentReadTool(name)) {
    const url = requireString(args, 'url')
    const max = deps.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES
    const bytes = await gw.downloadFile(url, max)
    if (!bytes) {
      throw new Error(
        `could not download the file at ${url} — it may be inaccessible, larger than ${max} bytes, or the bot ` +
          `may lack permission to read it (e.g. the Slack files:read scope)`
      )
    }
    const mimeType = optionalString(args, 'mimeType') ?? guessMimeFromUrl(url) ?? 'application/octet-stream'
    if (mimeType.startsWith('image/')) {
      const result: McpContentResult = {
        mcpContent: [{ type: 'image', data: bytes.toString('base64'), mimeType }]
      }
      return result
    }
    if (mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'text/csv') {
      const result: McpContentResult = { mcpContent: [{ type: 'text', text: bytes.toString('utf8') }] }
      return result
    }
    // Non-image binary: don't inline a base64 blob as text; report what we got.
    const result: McpContentResult = {
      mcpContent: [
        { type: 'text', text: `Downloaded ${bytes.byteLength} bytes of ${mimeType} (binary — not shown inline).` }
      ]
    }
    return result
  }

  switch (name) {
    case 'getCurrentChannel': {
      const info = await gw.getChannelInfo(ctx.channel).catch(() => undefined)
      return { channel: ctx.channel, thread: ctx.thread, name: info?.name ?? null, isIm: info?.isIm ?? null }
    }
    default:
      throw new Error(`unknown tool: ${name}`)
  }
}

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  if (typeof v !== 'string' || v.length === 0) throw new Error(`missing required string argument: ${key}`)
  return v
}

/** Like `requireString` but accepts '' — for `updateMemory`, where an empty string
 *  is a valid value (clear the memory). */
function requireStringAllowEmpty(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  if (typeof v !== 'string') throw new Error(`missing required string argument: ${key}`)
  return v
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw new Error(`argument ${key} must be a string`)
  return v
}

/**
 * Normalize `toAgent`, which accepts either the bare agent id or
 * `{ agentId, needsReply }`. The bare-string form stays supported indefinitely: it is what
 * every published example and every warm ACP session's tool descriptor teaches, and the object
 * form only adds delivery options on top of it. `undefined` ⇒ this is not an agent target.
 */
function parseAgentTarget(value: unknown): { toAgent?: string; needsReply?: boolean } {
  if (value === undefined || value === null) return {}
  if (typeof value === 'string') {
    if (value.length === 0) throw new Error('sendMessage: `toAgent` must be a non-empty agent id')
    return { toAgent: value }
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('sendMessage: `toAgent` must be an agent id string or {"agentId":"…","needsReply":bool}')
  }
  const target = value as Record<string, unknown>
  assertOnlyKeys(target, ['agentId', 'needsReply'], 'agent target `toAgent`')
  const needsReply = target.needsReply
  if (needsReply !== undefined && needsReply !== null && typeof needsReply !== 'boolean') {
    throw new Error('sendMessage: `toAgent.needsReply` must be a boolean')
  }
  return { toAgent: requireString(target, 'agentId'), ...(needsReply === true ? { needsReply: true } : {}) }
}

/** Normalize `toUser`: one id works for every delivery form; a non-empty array is reserved
 * for one visible channel-root post that @-mentions every listed Slack member. */
function parseUserTargets(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined
  const users = typeof value === 'string' ? [value] : value
  if (!Array.isArray(users)) {
    throw new Error('sendMessage: `toUser` must be a user id string or a non-empty array of user id strings')
  }
  if (users.length === 0 || users.some((user) => typeof user !== 'string' || user.trim().length === 0)) {
    throw new Error('sendMessage: `toUser` must be a user id string or a non-empty array of user id strings')
  }
  const ids = users as string[]
  const canonicalIds = ids.map((id) => /^<@([^>]+)>$/.exec(id)?.[1] ?? id)
  if (new Set(canonicalIds).size !== canonicalIds.length) {
    throw new Error('sendMessage: `toUser` must not contain duplicate user ids')
  }
  return ids
}

/** Resolve `user` to the app's own 1:1 conversation through the platform's Layer-1
 *  `openDirectMessage` port. The platform already declared it (that gate ran before
 *  the gateway was resolved); this is the LIVE probe on the connection actually
 *  selected — a send-only or stubbed gateway can still lack the method. */
async function openDirectMessage(gateway: MessageGateway, user: string, platform: string): Promise<string> {
  if (!gateway.openDirectMessage) {
    throw new Error(`sendMessage: the selected ${platformLabel(platform)} integration cannot open direct messages`)
  }
  return gateway.openDirectMessage(user)
}

function assertOnlyKeys(args: Record<string, unknown>, allowed: readonly string[], target: string): void {
  const allowedSet = new Set(allowed)
  const unexpected = Object.keys(args).filter((key) => !allowedSet.has(key))
  if (unexpected.length === 0) return
  throw new Error(
    `sendMessage: ${target} allows only ${allowed.map((key) => `\`${key}\``).join(', ')}; ` +
      `unexpected ${unexpected.map((key) => `\`${key}\``).join(', ')}. ${SEND_MESSAGE_TARGET_HELP}`
  )
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`argument ${key} must be a finite number`)
  return v
}

function optionalBoundedInt(args: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const value = optionalNumber(args, key)
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`argument ${key} must be an integer between ${min} and ${max}`)
  }
  return value
}

function optionalObject(args: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`argument ${key} must be an object`)
  return value as Record<string, unknown>
}

function requireEnum<T extends string>(args: Record<string, unknown>, key: string, values: readonly T[]): T {
  const value = args[key]
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new Error(`argument ${key} must be one of: ${values.join(', ')}`)
  }
  return value as T
}

function requirePositiveInt(args: Record<string, unknown>, key: string): number {
  const value = args[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`argument ${key} must be a positive integer`)
  }
  return value
}

function parseReviewComments(value: unknown): GithubInlineReviewComment[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new Error('argument comments must be an array')
  if (value.length > 100) throw new Error('argument comments may contain at most 100 entries')
  return value.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`comments[${index}] must be an object`)
    }
    const row = item as Record<string, unknown>
    const startLine = row.startLine === undefined ? undefined : requirePositiveInt(row, 'startLine')
    const startSide =
      row.startSide === undefined ? undefined : requireEnum(row, 'startSide', ['LEFT', 'RIGHT'] as const)
    return {
      path: requireString(row, 'path'),
      body: requireString(row, 'body'),
      line: requirePositiveInt(row, 'line'),
      side: requireEnum(row, 'side', ['LEFT', 'RIGHT'] as const),
      ...(startLine !== undefined ? { startLine } : {}),
      ...(startSide !== undefined ? { startSide } : {})
    }
  })
}
