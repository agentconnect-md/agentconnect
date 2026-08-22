import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { MessageGateway, SendIdentity, SessionContext } from './context.js'
import { resolveGatewayForPlatform, type GatewayDeps } from './gateway.js'
import { optionalString, parseArgs, requiredString } from './args.js'
import {
  rootPostNeedsThreadMaterialization,
  rootPostThreadName,
  threadKeyForPost,
  threadKeyNeedsDmClassification
} from '../../platforms/thread-keys.js'
import {
  directMessagePlatformFor,
  directMessagePlatformList,
  offersDirectMessages,
  platformLabel
} from '../../platforms/read-ports.js'

export const SEND_MESSAGE_TARGET_HELP =
  'Valid targets: agent {"toAgent":"<agent-id>","message":"..."}; ' +
  'user DM {"toUser":"<Slack-user-id>","message":"..."}; ' +
  'channel users {"toUser":["<id-1>","<id-2>"],"channel":"<channel-id>","message":"..."}; ' +
  'channel {"channel":"<channel-id>","message":"..."}; ' +
  'session {"sessionId":"<Parent session>","message":"..."}'

const AGENT_TARGET_SHAPE_ERROR =
  'sendMessage: `toAgent` must be an agent id string or {"agentId":"…","needsReply":bool}'
const USER_TARGET_ERROR = 'sendMessage: `toUser` must be a user id string or a non-empty array of user id strings'

/** Reject any key the branch does not accept, naming the repair — silently ignoring a `thread`
 *  or a stray identity field is the confusing outcome (send-message-routing-rework.md §2.2). */
function branchKeyError(target: string, allowed: readonly string[]): { error: z.core.$ZodErrorMap } {
  const quoted = (keys: readonly PropertyKey[]) => keys.map((key) => `\`${String(key)}\``).join(', ')
  return {
    error: (issue) =>
      issue.code === 'unrecognized_keys'
        ? `sendMessage: ${target} allows only ${quoted(allowed)}; unexpected ${quoted(issue.keys)}. ` +
          SEND_MESSAGE_TARGET_HELP
        : undefined
  }
}

/** One call mode's full key set — the runtime twin of a `oneOf` branch in the advertised schema. */
function targetBranch<T extends z.ZodRawShape>(target: string, shape: T) {
  return z.strictObject(shape, branchKeyError(target, Object.keys(shape)))
}

const messageField = requiredString('message')
const channelField = optionalString('channel')
/** The name of a file the caller RECEIVED in this conversation, forwarded as-is. Named
 *  rather than id'd because the name is what the agent already has: it reads it in the
 *  `[attached: …]` marker on the triggering message. */
const attachmentField = optionalString('attachment')
const platformField = optionalString('platform')
const integrationIdField = optionalString('integrationId')

/** `toAgent` accepts the bare agent id or `{agentId, needsReply}`. The bare-string form stays
 *  supported indefinitely: every published example and every warm ACP session teaches it, and
 *  the object form only adds delivery options on top of it. */
const AGENT_ID = z.string(AGENT_TARGET_SHAPE_ERROR).min(1, 'sendMessage: `toAgent` must be a non-empty agent id')
const AGENT_TARGET_OBJECT = z.strictObject(
  {
    agentId: requiredString('agentId'),
    needsReply: z.boolean('sendMessage: `toAgent.needsReply` must be a boolean').nullish()
  },
  branchKeyError('agent target `toAgent`', ['agentId', 'needsReply'])
)
const AGENT_TARGET = z.union([AGENT_ID, AGENT_TARGET_OBJECT])

/** `toUser`: one id works for every delivery form; a non-empty array is reserved for one visible
 *  channel-root post that @-mentions every listed member. */
const USER_ID = z.string(USER_TARGET_ERROR).refine((id) => id.trim().length > 0, USER_TARGET_ERROR)
const USER_TARGETS = z
  .union([USER_ID, z.array(USER_ID).min(1, USER_TARGET_ERROR)], USER_TARGET_ERROR)
  .transform((value) => (typeof value === 'string' ? [value] : value))
  .refine(
    (ids) => new Set(ids.map((id) => /^<@([^>]+)>$/.exec(id)?.[1] ?? id)).size === ids.length,
    'sendMessage: `toUser` must not contain duplicate user ids'
  )

/** The four mutually exclusive call modes (§3.3), one strict key set each. */
export const SEND_MESSAGE_BRANCHES = {
  toAgent: targetBranch('agent target', { toAgent: AGENT_TARGET, channel: channelField, message: messageField }),
  toUser: targetBranch('user target', {
    toUser: USER_TARGETS,
    channel: channelField,
    platform: platformField,
    integrationId: integrationIdField,
    attachment: attachmentField,
    message: messageField
  }),
  channel: targetBranch('channel target', {
    channel: requiredString('channel'),
    platform: platformField,
    integrationId: integrationIdField,
    attachment: attachmentField,
    message: messageField
  }),
  sessionId: targetBranch('session target', {
    sessionId: requiredString('sessionId'),
    correlationId: optionalString('correlationId'),
    message: messageField
  })
}

/** Normalize `toAgent`. `undefined` ⇒ this is not an agent target. */
function parseAgentTarget(value: unknown): { toAgent?: string; needsReply?: boolean } {
  if (value === undefined || value === null) return {}
  if (typeof value === 'string') return { toAgent: parseArgs(AGENT_ID, value) }
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(AGENT_TARGET_SHAPE_ERROR)
  const target = parseArgs(AGENT_TARGET_OBJECT, value)
  return { toAgent: target.agentId, ...(target.needsReply === true ? { needsReply: true } : {}) }
}

/** Normalize `toUser` to the id list both delivery forms work from. */
function parseUserTargets(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined
  return parseArgs(USER_TARGETS, value)
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
   *  `spawnChannelRootSession`). Absent for a postless wake. */
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
 *  (`self` / `invalid_target` / `not_allowed` / `not_local` / `no_agent`, or a cross-daemon
 *  verdict such as `not_ready` — a target nobody could be addressed at within the retry
 *  window). `targetSession` is the local session key the message was (or would be) delivered into. */
export interface MessageAgentResult {
  delivered: boolean
  targetSession: string
  reason?: string
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
    | 'not_ready'
}

/** The deps of the unified outbound send: peer wake, session reply, the visible post, and
 *  the daemon-side session bookkeeping a root post triggers. */
export interface MessagingDeps extends GatewayDeps {
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
  /** Deliver a message into another agent's session (agent→agent wake). The daemon
   *  fills the trusted caller identity from the session context; this callback owns
   *  the same-daemon delivery (policy check, coord/integration resolution, dispatch)
   *  and the cross-daemon `not_local` stub. */
  messageAgent: (req: MessageAgentReq) => Promise<MessageAgentResult>
  /** Side-effect-free preflight for a peer wake: returns a typed rejection reason if
   *  {@link MessagingDeps.messageAgent} would refuse this wake for a locally-decidable reason (capability
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
  }) => Promise<{ kind: 'parent'; sessionId: string } | { kind: 'self' } | undefined>
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
  }) => boolean | Promise<boolean>
  /** Resolve a file the caller RECEIVED here, by the name it read in the `[attached: …]` marker,
   *  to daemon-local bytes — this is what lets an image the agent can only SEE be passed on. The
   *  bytes are the bounded copy already kept for transcript replay, so a forward re-fetches
   *  nothing, never routes bytes through the model, and can be lower-resolution than the original.
   *  Scoped to the caller's own (channel, thread). Absent with no daemon ⇒ no file can be named. */
  resolveAttachment?: (
    ctx: SessionContext,
    name: string
  ) => Promise<{ bytes: Buffer; name: string; mimeType: string } | undefined>
  /** Record an agent-sent message into the session transcript. */
  recordOutbound: (
    ctx: SessionContext,
    channel: string,
    thread: string | undefined,
    text: string,
    ts: string,
    integrationId: string
  ) => Promise<void>
  /** Monotonic-ish clock for synthesizing a message id when the platform doesn't return one. */
  now: () => number
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

// Unified outbound send (session-concept §3). One tool merges the old `sendPlatformMessage`
// (post to a platform channel/user) and `messageAgent` (wake a peer agent), plus SessionTarget
// replies. Universal (any agent — a memory-only agent can still wake a peer / reply), handled
// before the platform-gateway gate. A MessageTarget uses `toAgent` (wake a peer), `toUser`
// (reach humans), or a bare `channel`. Omitting `channel` selects a postless peer wake or a
// user DM; providing it always selects a channel-root post. `sessionId` is a separate reply
// branch for an existing session.
// SECURITY: the caller identity + coords come from the trusted session context, never tool input.
export async function sendMessage(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: MessagingDeps
): Promise<unknown> {
  const message = parseArgs(messageField, args.message)

  // Discriminant (§3.3): a `sessionId` ⇒ SessionTarget — reply into that existing session.
  const sessionId = parseArgs(optionalString('sessionId'), args.sessionId)
  if (sessionId !== undefined) {
    const { correlationId } = parseArgs(SEND_MESSAGE_BRANCHES.sessionId, args)
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
  const channel = parseArgs(channelField, args.channel)
  const attachmentName = parseArgs(attachmentField, args.attachment)
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
  // ordinary turn reply's job (§2.1), which already owns the right coordinates, streaming
  // lifecycle, and sender identity. The selected branch schema is what rejects a `thread` a
  // caller supplies anyway — a stale client, or a model working from an old example — and it
  // rejects LOUDLY rather than ignoring it, because silently posting at the root what the
  // caller meant for a thread is the confusing outcome.
  const branch =
    toAgent !== undefined
      ? SEND_MESSAGE_BRANCHES.toAgent
      : toUsers !== undefined
        ? SEND_MESSAGE_BRANCHES.toUser
        : SEND_MESSAGE_BRANCHES.channel
  parseArgs(branch, args)
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
  let post: { platform: string; integrationId: string; channel: string; thread: string | null; ts: string } | undefined
  // What the agent must know inside THIS turn: a root post that forked a conversation it is
  // already in, or a file share that landed without all of its caption. Surfaced in the tool
  // RESULT, where it is read in time to still answer the right way. Collected rather than
  // assigned because a forward can raise both.
  const notices: string[] = []
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
      parseArgs(platformField, args.platform) ?? (directMessage ? directMessagePlatformFor(ctx.platform) : ctx.platform)
    const wantIntegrationId = parseArgs(integrationIdField, args.integrationId)
    const { gw, integrationId: targetId } = resolveGatewayForPlatform(ctx, deps, wantPlatform, wantIntegrationId)
    // Resolved before anything is posted: a bad name or a fileless target fails the whole send.
    let attachment: { bytes: Buffer; name: string; mimeType: string } | undefined
    if (attachmentName !== undefined) {
      if (!gw.uploadFile) {
        throw new Error(`sendMessage: the selected ${platformLabel(wantPlatform)} integration cannot post files`)
      }
      attachment = await deps.resolveAttachment?.(ctx, attachmentName)
      // Not necessarily a wrong name: the `[attached: …]` marker lists EVERY file on a
      // message, while only the one retained image is forwardable. Saying "no such name"
      // would send the agent back to retry a name it read correctly.
      if (!attachment) {
        // Wording matters here: an earlier phrasing listed the unforwardable kinds and an agent
        // read the list backwards, asking the user to RE-SEND the picture as a document. State
        // what can be forwarded, then close the loop on the retries that cannot work.
        throw new Error(
          `sendMessage: "${attachmentName}" cannot be forwarded. Only ONE shared image per message is ` +
            'retained, and only PNG, JPEG or WEBP. Do NOT ask anyone to re-send it in another format ' +
            '— a document or a second image on the same message can never be forwarded, and re-sending ' +
            'will not change that. Check the spelling once against the `[attached: …]` marker; if it ' +
            'matches, describe the image in your reply instead.'
        )
      }
    }
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
    // A file share IS the message — the caption is `body`, not a second post. It anchors like
    // any other post where the platform answers with a message id; Slack's does not, and that
    // arm degrades on the path a gateway returning no id already takes. A failed share is
    // raised rather than reported as sent — except `indeterminate`, the queue abandoning a
    // still-running upload, which must say "may have landed" or a retry double-posts.
    if (attachment) {
      const shared = await gw.uploadFile?.(postChannel, attachment, body, undefined, identity)
      if (!shared || !shared.ok) {
        const reason = shared && !shared.ok ? shared.reason : 'platform_error'
        if (reason === 'indeterminate') {
          throw new Error(
            `sendMessage: the ${platformLabel(wantPlatform)} file share for "${attachment.name}" timed out and ` +
              'MAY still have been delivered — do NOT retry; say the send may have gone through instead.'
          )
        }
        const detail = shared && !shared.ok && shared.detail ? `: ${shared.detail}` : ''
        throw new Error(
          `sendMessage: ${platformLabel(wantPlatform)} rejected the file "${attachment.name}" ` +
            `(${reason.replace('_', ' ')}${detail}) — nothing was sent.`
        )
      }
      providerPostId = shared.messageId
      if (shared.warning) notices.push(`This send partly failed: ${shared.warning}.`)
    } else {
      providerPostId = await gw.postMessage(postChannel, body, undefined, identity)
    }
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
      providerPostId === undefined ? undefined : threadKeyForPost(wantPlatform, postChannel, providerPostId, isDmTarget)
    postedThread =
      providerPostId === undefined ? undefined : mustMaterializeThread ? materializedThread : canonicalPostThread
    // Record the post in the thread it BELONGS to — the one it just created for a root post,
    // not the caller's own thread (the daemon's fallback, which for a cross-channel post keys a
    // row to coords that match no session at all). It is also what resolves a later reply to
    // this post back onto this thread, so it must be the same canonical key the session uses.
    await deps.recordOutbound(ctx, postChannel, postedThread ?? canonicalPostThread, body, ts, targetId)
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
      const seeded = await deps.spawnChannelRootSession({
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
          ? await deps.rootPostRelation?.({
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
        notices.push(
          `This posted at the ROOT of the conversation your parent session occupies, so it starts a separate ` +
            `context there instead of answering — the conversation waiting on you did not receive it. To answer ` +
            `it, call sendMessage with {"sessionId":"${relation.sessionId}"}.`
        )
      } else if (relation?.kind === 'self') {
        notices.push(
          `This posted at the ROOT of the conversation this session is already in, so it starts a separate ` +
            `context instead of continuing it. Your ordinary reply for this turn already reaches this ` +
            `conversation — no sendMessage needed.`
        )
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
    ...(childSessionId !== undefined && needsReply
      ? {
          reply: { requested: true, state: 'awaiting' as const },
          nextAction: 'finish-turn-and-wait' as const,
          message:
            'Message delivered. The agent will reply by waking this session in a later turn. End this turn and wait; do not retry or ask it to repeat the work.'
        }
      : {}),
    ...(notices.length ? { notice: notices.join(' ') } : {})
  }
}
