import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { MessageGateway, SendIdentity, SessionContext } from './context.js'
import { resolveGatewayForPlatform, type GatewayDeps } from './gateway.js'
import type { TaskReachDeps } from './task-reach.js'
import type { InterceptedPost, PostInterception } from '../../assistant/drafts.js'
import { optionalString, parseArgs, requiredString } from './args.js'
import { assertChannelReachable } from './channel-reach.js'
import { JoinRefused } from './join-ask.js'
import {
  offersThreadUpdates,
  rootPostNeedsThreadMaterialization,
  rootPostThreadName,
  threadKeyForPost,
  threadKeyForUpdate,
  threadKeyNeedsDmClassification
} from '../../platforms/thread-keys.js'
import {
  directMessagePlatformFor,
  directMessagePlatformList,
  offersDirectMessages,
  platformLabel,
  channelMentionsFor
} from '../../platforms/read-ports.js'

/** The repair every pre-effect `sendMessage` rejection ends with: the action's guide, then a retry. */
export function sendMessageGuidePointer(action?: string): string {
  const query = action === undefined ? '{"tool":"sendMessage"}' : `{"tool":"sendMessage","action":"${action}"}`
  return `Nothing was sent. Call getToolGuide ${query} for the required arguments, then retry with a valid action and target.`
}

const AGENT_TARGET_SHAPE_ERROR =
  'sendMessage: `toAgent` must be an agent id string or {"agentId":"…","needsReply":bool}'
export const USER_ARRAY_NEEDS_CHANNEL =
  'a `toUser` array requires `channel` — direct messages accept exactly one user id'
const USER_TARGET_ERROR = 'sendMessage: `toUser` must be a user id string or a non-empty array of user id strings'

/** Reject any key the branch does not accept, naming the repair — silently ignoring a `thread` or a stray identity field is the confusing outcome (send-message-routing-rework.md §2.2). */
function branchKeyError(target: string, allowed: readonly string[], action: string): { error: z.core.$ZodErrorMap } {
  const quoted = (keys: readonly PropertyKey[]) => keys.map((key) => `\`${String(key)}\``).join(', ')
  return {
    error: (issue) =>
      issue.code === 'unrecognized_keys'
        ? `sendMessage: ${target} allows only ${quoted(allowed)}; unexpected ${quoted(issue.keys)}. ` +
          sendMessageGuidePointer(action)
        : undefined
  }
}

/** One delivery form's full key set, checked after the adapter removed the validated `action`. */
function targetBranch<T extends z.ZodRawShape>(target: string, action: string, shape: T) {
  return z.strictObject(shape, branchKeyError(target, ['action', ...Object.keys(shape)], action))
}

export const messageField = requiredString('message')
export const channelField = optionalString('channel')
/** §2.4: an EXISTING thread's root id, carried by the bare-`channel` update form only. */
export const threadField = optionalString('thread')
/** A file the caller RECEIVED here, by the name its `[attached: …]` marker shows. */
export const attachmentField = optionalString('attachment')
export const platformField = optionalString('platform')
export const integrationIdField = optionalString('integrationId')

/** `toAgent` accepts the bare agent id or `{agentId, needsReply}`. The bare-string form stays
 *  supported indefinitely: every published example and every warm ACP session teaches it, and
 *  the object form only adds delivery options on top of it. */
const AGENT_ID = z.string(AGENT_TARGET_SHAPE_ERROR).min(1, 'sendMessage: `toAgent` must be a non-empty agent id')
const AGENT_TARGET_OBJECT = z.strictObject(
  {
    agentId: requiredString('agentId'),
    needsReply: z
      .union([
        z.boolean('sendMessage: `toAgent.needsReply` must be a boolean'),
        z.string().regex(/^(?:true|false)$/i, 'sendMessage: `toAgent.needsReply` must be a boolean')
      ])
      .nullish()
  },
  branchKeyError('agent target `toAgent`', ['agentId', 'needsReply'], 'callAgent')
)
export const AGENT_TARGET = z.union([AGENT_ID, AGENT_TARGET_OBJECT])

function normalizeNeedsReply(value: boolean | string | null | undefined): boolean | undefined {
  if (value === true) return true
  if (typeof value === 'string' && value.toLowerCase() === 'true') return true
  return undefined
}

/** `toUser`: one id for every form; a non-empty array only for one channel-root post mentioning them all. */
const USER_ID = z.string(USER_TARGET_ERROR).refine((id) => id.trim().length > 0, USER_TARGET_ERROR)
export const USER_TARGETS = z
  .union([USER_ID, z.array(USER_ID).min(1, USER_TARGET_ERROR)], USER_TARGET_ERROR)
  .transform((value) => (typeof value === 'string' ? [value] : value))
  .refine(
    (ids) => new Set(ids.map((id) => /^<@([^>]+)>$/.exec(id)?.[1] ?? id)).size === ids.length,
    'sendMessage: `toUser` must not contain duplicate user ids'
  )

/** The four delivery forms the actions map onto (send-message-guide.md §3.3), one strict key set each. */
export const SEND_MESSAGE_BRANCHES = {
  toAgent: targetBranch('action `callAgent`', 'callAgent', {
    toAgent: AGENT_TARGET,
    channel: channelField,
    platform: platformField,
    integrationId: integrationIdField,
    message: messageField
  }),
  toUser: targetBranch('action `postMessage` with `toUser`', 'postMessage', {
    toUser: USER_TARGETS,
    channel: channelField,
    platform: platformField,
    integrationId: integrationIdField,
    attachment: attachmentField,
    message: messageField
  }),
  channel: targetBranch('action `postMessage` with `channel`', 'postMessage', {
    channel: requiredString('channel'),
    thread: threadField,
    platform: platformField,
    integrationId: integrationIdField,
    attachment: attachmentField,
    message: messageField
  }),
  messageId: targetBranch('action `replyToSession`', 'replyToSession', {
    messageId: requiredString('messageId'),
    message: messageField
  })
}

/** Normalize `toAgent`. `undefined` ⇒ this is not an agent target. */
export function parseAgentTarget(value: unknown): { toAgent?: string; needsReply?: boolean } {
  if (value === undefined || value === null) return {}
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.startsWith('{')) {
      let decoded: unknown
      try {
        decoded = JSON.parse(trimmed)
      } catch {
        throw new Error(AGENT_TARGET_SHAPE_ERROR)
      }
      if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
        throw new Error(AGENT_TARGET_SHAPE_ERROR)
      }
      const target = parseArgs(AGENT_TARGET_OBJECT, decoded)
      return {
        toAgent: target.agentId,
        ...(normalizeNeedsReply(target.needsReply) === true ? { needsReply: true } : {})
      }
    }
    return { toAgent: parseArgs(AGENT_ID, value) }
  }
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(AGENT_TARGET_SHAPE_ERROR)
  const target = parseArgs(AGENT_TARGET_OBJECT, value)
  return {
    toAgent: target.agentId,
    ...(normalizeNeedsReply(target.needsReply) === true ? { needsReply: true } : {})
  }
}

const MENTION = /<@!?([^>|\s]+)(?:\|[^>]*)?>/g

/** Refuse a post that names an agent's bot — in `toUser` or as a mention — since a post never wakes it and nothing replies. */
function refuseAgentBotTargets(
  ctx: SessionContext,
  deps: MessagingDeps,
  platform: string,
  userIds: readonly string[],
  where: { channel?: string; platform?: string }
): void {
  if (!deps.agentsForPlatformUser) return
  for (const raw of userIds) {
    const userId = /^<@!?([^>|]+)/.exec(raw)?.[1] ?? raw
    const agents = deps.agentsForPlatformUser({ callerAgentId: ctx.agentId, platform, userId })
    if (agents.length === 0) continue
    if (agents.every((id) => id === ctx.agentId)) {
      throw new Error(
        `sendMessage: ${userId} is your own bot, not a person. Nothing was sent. Answer this conversation with your ` +
          'ordinary reply, or post without naming yourself.'
      )
    }
    const peers = agents.filter((id) => id !== ctx.agentId)
    const call = JSON.stringify({
      action: 'callAgent',
      toAgent: { agentId: peers.length === 1 ? peers[0] : '<one of those agent ids>', needsReply: true },
      ...(where.channel !== undefined ? { channel: where.channel } : {}),
      ...(where.platform !== undefined ? { platform: where.platform } : {}),
      message: '<the same message>'
    })
    throw new Error(
      `sendMessage: ${userId} is the bot of AgentConnect agent ${peers.join(', ')}, not a person. A post never wakes ` +
        'an agent and nothing replies to it, so nothing was sent. To have that agent work and answer you, call ' +
        `sendMessage ${call}`
    )
  }
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
  /** Trusted caller coords; with `callerAgentId` they resolve the current turn's call metadata (§6.7) for hop/origin. */
  callerChannel: string
  callerThread: string
  toAgentId: string
  text: string
  /** Target channel; defaults (in the handler) to the caller's current channel. */
  channel: string
  /** Platform of `channel` when it differs from the caller's; only a `callAgent` with `channel` sets it, after posting there. */
  targetPlatform?: string
  /** Target thread; undefined ⇒ channel root / target's default thread. */
  thread?: string
  /** When this wake was preceded by a visible channel post (`toAgent`+`channel`), the post's
   *  real platform `ts`. Threaded through so the woken turn's transcript row lands on the SAME
   *  (channel, thread, ts) primary key as the recorded post — deduping the two representations —
   *  and so the new session's read cursor stays a canonical platform ts (mirrors
   *  `spawnChannelRootSession`). Absent for a postless wake. */
  transcriptTs?: string
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
  /** send-message-routing-rework.md §3.1: the postless `toAgent` form, whose child runs headless; set only by `sendMessage`'s agent target. */
  postless?: boolean
  /** send-message-guide.md §9.2: `callAgent.sessionId`, the target's existing session by key or outward id; never a new one. */
  targetSessionId?: string
  /** The transport's stable id of this call, so a replay of it keeps its message id (send-message-guide.md §9.3). */
  submissionId?: string
  /** A self-delegation's task title (auto-session-mode.md §5.1); derived from `text` when absent. */
  title?: string
}

/** The guidance a started task's receipt hands back (send-message-guide.md §8.6). */
export const TASK_STARTED =
  'Task started in the background. Tell the people here it has started and end this turn; it reports back into ' +
  'this session when it finishes or fails. Do not do the work here as well.'

/** An owning session's message into its own task (send-message-guide.md §8.1): only the handle and `text` come from the model. */
export interface ContinueSubsessionReq {
  callerAgentId: string
  platform: string
  callerTransportScope?: string
  callerChannel: string
  callerThread: string
  /** The task's handle: the `taskId` `delegateTask` returned, or its outward id. */
  sessionId: string
  text: string
  /** A stable id of this submission, so a replay of it is admitted once; minted by the daemon when absent. */
  submissionId?: string
  /** The caller delegates no task (auto-session-mode.md §5.1), so only a follow-up or research takes the message. */
  assistantTasksOnly?: boolean
}

/** The result of an agent→agent delivery. `delivered:false` carries a typed `reason`
 *  (`self` / `invalid_target` / `not_allowed` / `not_local` / `no_agent`, or a cross-daemon
 *  verdict such as `not_ready` — a target nobody could be addressed at within the retry
 *  window). `targetSession` is the local session key the message was (or would be) delivered into. */
export interface MessageAgentResult {
  delivered: boolean
  targetSession: string
  reason?: string
  /** A refusal the agent must read in words, beside its `reason`. */
  message?: string
  /** send-message-guide.md §8.5: the wake started or messaged a background task, which always reports back. */
  subsession?: true
  /** assistant-mode.md §5.12: a follow-up took the message, for a check now or the one after the check that runs. */
  followUp?: 'checking' | 'queued'
}

/** A reply to one message the caller received (send-message-guide.md §9.4): only `messageId` and `text` come from the model. */
export interface ReplyToSessionReq {
  /** Trusted caller identity (== `ctx.agentId`). Never a tool input. */
  callerAgentId: string
  /** Trusted source platform / caller session coords (== the caller's {@link SessionContext}). */
  platform: string
  callerTransportScope?: string
  callerChannel: string
  callerThread: string
  /** The only untrusted field: the answered message's id, resolved against what this session received. */
  messageId: string
  text: string
  /** The transport's stable id of this call, so a replay of it is one reply. */
  submissionId?: string
}

/** A reply's receipt (send-message-guide.md §9.4): `message_not_found` names nothing, and the rest mirror delivery verdicts. */
export interface ReplyToSessionResult {
  delivered: boolean
  targetSession?: string
  /** The message this reply answers. */
  inReplyTo: string
  reason?:
    | 'message_not_found'
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
    // send-message-guide.md §8.5: the daemon already reported this round's end to the owning session.
    | 'task_ended'
}

/** The deps of the unified outbound send: peer wake, session reply, the visible post, and
 *  the daemon-side session bookkeeping a root post triggers. */
export interface MessagingDeps extends GatewayDeps, TaskReachDeps {
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
  /** The AgentConnect agents a platform user id is the bot of, so a post never addresses an agent as a person. */
  agentsForPlatformUser?: (req: { callerAgentId: string; platform: string; userId: string }) => string[]
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
  /** Side-effect-free: the reason {@link MessagingDeps.messageAgent} would refuse this wake locally, else null, so no post precedes it; absent ⇒ not gated. */
  preflightWake?: (req: MessageAgentReq) => string | null
  /** Backs `replyToSession`: a reply to one message the caller received, routed by that message's record (send-message-guide.md §9.4). */
  replyToSession: (req: ReplyToSessionReq) => Promise<ReplyToSessionResult>
  /** Backs a coordinator session's `sendMessage` (auto-session-mode.md §5.1); absent ⇒ unavailable. */
  coordinatorDecision?: (ctx: SessionContext, args: Record<string, unknown>) => Promise<unknown>
  /** The person's message a coordinator's place-tool call names, or why it names none (§5.4); absent ⇒ unavailable. */
  coordinatorMessage?: (
    ctx: SessionContext,
    messageId: unknown
  ) => { msg: NonNullable<SessionContext['forMessage']> } | { error: string }
  /** Backs `messageTask` (send-message-guide.md §8): the caller's own task only; absent ⇒ unavailable. */
  continueSubsession?: (req: ContinueSubsessionReq) => Promise<MessageAgentResult>
  /** The transport's stable id of this tool call, when it has one, so a resent call is one submission. */
  callId?: string
  /** How a channel-root post relates to conversations this session is in: `source` = that of a message it owes an answer (by id), `self` = its own; absent without a daemon. */
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
  }) => Promise<{ kind: 'source'; messageId: string } | { kind: 'self' } | undefined>
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
    /** Whether the destination is a DM, as the platform reports it — it decides the new
     *  session's audience the same way it decides the thread key. */
    isDm?: boolean
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
  /** Set per call: the write rule on a resolved post target (assistant-mode.md §5.5); throws a refusal, or says the post needs approval. */
  judgePost?: (target: PostTarget) => Promise<'post' | 'draft'>
  /** Set per call: drafts a post the write rule sent for an internal member's approval. */
  interceptPost?: (post: InterceptedPost) => Promise<PostInterception>
  /** Record an agent-sent message into the session transcript. */
  recordOutbound: (
    ctx: PostOrigin,
    channel: string,
    thread: string | undefined,
    text: string,
    ts: string,
    integrationId: string
  ) => Promise<void>
  /** Monotonic-ish clock for synthesizing a message id when the platform doesn't return one. */
  now: () => number
}

/** Where a post lands once resolved: the conversation on one bot, and a direct message's recipient. */
export interface PostTarget {
  platform: string
  integrationId: string
  channel: string
  recipient?: string
}

/** The posting session's coordinates: what an outbound record is admitted into, and the lineage a seeded session keeps. */
export type PostOrigin = Pick<
  SessionContext,
  'agentId' | 'platform' | 'channel' | 'thread' | 'transportScope' | 'deliveryThread'
>

/** One confirmed post, as the bookkeeping after it needs it. */
export interface ConfirmedPost {
  platform: string
  integrationId: string
  channel: string
  /** The existing thread an update joined; absent for a root post. */
  updateThread?: string
  body: string
  /** The platform's own id for the post; absent when it returned none. */
  providerPostId?: string
  ts: string
  directMessage: boolean
  /** Seed the author's session in the post's thread (no model turn). */
  seed: boolean
}

/**
 * What every confirmed post gets, from sendMessage and from an approved assistant-mode draft alike: the platform's
 * required root thread, the outbound record in the thread the post belongs to, and the author's seeded session.
 */
export async function settlePost(
  origin: PostOrigin,
  deps: Pick<MessagingDeps, 'recordOutbound' | 'spawnChannelRootSession'>,
  gw: MessageGateway,
  post: ConfirmedPost
): Promise<{ postedThread?: string; seeded: boolean }> {
  const { platform, channel, updateThread, providerPostId, body, ts } = post
  // Only a root post is classified and materialized: an update already has its conversation.
  const isDmTarget =
    updateThread === undefined && threadKeyNeedsDmClassification(platform)
      ? ((await gw.getChannelInfo(channel).catch(() => undefined))?.isIm ?? false)
      : false
  const mustMaterializeThread =
    updateThread === undefined && !isDmTarget && rootPostNeedsThreadMaterialization(platform)
  const materializedThread =
    providerPostId !== undefined && mustMaterializeThread
      ? await gw.createThread?.(channel, providerPostId, rootPostThreadName(body))
      : undefined
  const canonicalPostThread =
    updateThread !== undefined
      ? threadKeyForUpdate(platform, channel, updateThread)
      : providerPostId === undefined
        ? undefined
        : threadKeyForPost(platform, channel, gw.threadOfPost?.(providerPostId) ?? providerPostId, isDmTarget)
  const postedThread =
    updateThread !== undefined
      ? canonicalPostThread
      : providerPostId === undefined
        ? undefined
        : mustMaterializeThread
          ? materializedThread
          : canonicalPostThread
  // Recorded in the thread the post belongs to, the same canonical key a reply to it resolves to.
  await deps.recordOutbound(origin, channel, postedThread ?? canonicalPostThread, body, ts, post.integrationId)
  if (providerPostId !== undefined && mustMaterializeThread && postedThread === undefined) {
    throw new Error(
      `sendMessage: posted root message ${ts}, but its required thread could not be created; no session was started`
    )
  }
  // session-concept case 2a and §2.4: the author joins the post's thread with a session whose origin is the posting one.
  if (!post.seed || postedThread === undefined || providerPostId === undefined || !deps.spawnChannelRootSession) {
    return { ...(postedThread !== undefined ? { postedThread } : {}), seeded: false }
  }
  const seeded = await deps.spawnChannelRootSession({
    agentId: origin.agentId,
    platform,
    integrationId: post.integrationId,
    channel,
    thread: postedThread,
    postTs: ts,
    isDm: isDmTarget || post.directMessage,
    text: body,
    originPlatform: origin.platform,
    ...(origin.transportScope !== undefined ? { originTransportScope: origin.transportScope } : {}),
    originChannel: origin.channel,
    originThread: origin.thread
  })
  return { postedThread, seeded }
}

/** Resolve `user` to the app's own 1:1 conversation through the platform's Layer-1
 *  `openDirectMessage` port. The platform already declared it (that gate ran before
 *  the gateway was resolved); this is the LIVE probe on the connection actually
 *  selected — a send-only or stubbed gateway can still lack the method. */
/** A gateway-mention post, through the gateway that declared it. */
async function postMentioning(
  gateway: MessageGateway,
  channel: string,
  text: string,
  users: string[],
  identity: SendIdentity,
  platform: string
): Promise<string | undefined> {
  if (!gateway.postMentioning) {
    throw new Error(
      `sendMessage: the selected ${platformLabel(platform)} integration cannot mention people in a channel`
    )
  }
  return gateway.postMentioning(channel, text, users, identity)
}

async function openDirectMessage(gateway: MessageGateway, user: string, platform: string): Promise<string> {
  if (!gateway.openDirectMessage) {
    throw new Error(`sendMessage: the selected ${platformLabel(platform)} integration cannot open direct messages`)
  }
  return gateway.openDirectMessage(user)
}

/** The delivery behind every validated `sendMessage` action, on its target-shaped arguments; caller identity and coords come from trusted context only. */
export async function deliverSendMessage(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: MessagingDeps,
  task?: { title: string }
): Promise<unknown> {
  const message = parseArgs(messageField, args.message)

  // send-message-guide.md §9.4: a `messageId` answers that message, decided by its record alone.
  const messageId = parseArgs(optionalString('messageId'), args.messageId)
  if (messageId !== undefined) {
    // Validation only: the strict branch rejects any key this form does not accept.
    parseArgs(SEND_MESSAGE_BRANCHES.messageId, args)
    return await deps.replyToSession({
      callerAgentId: ctx.agentId,
      platform: ctx.platform,
      ...(ctx.transportScope !== undefined ? { callerTransportScope: ctx.transportScope } : {}),
      callerChannel: ctx.channel,
      callerThread: ctx.thread,
      messageId,
      text: message,
      ...(deps.callId !== undefined ? { submissionId: deps.callId } : {})
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
  const namedPlatform = parseArgs(platformField, args.platform)
  const attachmentName = parseArgs(attachmentField, args.attachment)
  if (toAgent === undefined && toUsers === undefined && channel === undefined) {
    throw new Error(
      `sendMessage: action \`postMessage\` requires \`toUser\` or \`channel\`. ${sendMessageGuidePointer('postMessage')}`
    )
  }
  if (toAgent !== undefined && toUsers !== undefined) {
    throw new Error(`sendMessage: \`toAgent\` and \`toUser\` are mutually exclusive. ${sendMessageGuidePointer()}`)
  }
  // send-message-routing-rework.md §2.2: ONLY the bare-`channel` branch accepts `thread`,
  // and only to name a thread that already exists — the update form (§2.4). Addressing the
  // CURRENT thread is still the ordinary turn reply's job (§2.1), which already owns the
  // right coordinates, streaming lifecycle, and sender identity. The selected branch schema
  // is what rejects a `thread` on any OTHER branch, and it rejects LOUDLY rather than
  // ignoring it: silently posting at the root what the caller meant for a thread is the
  // confusing outcome, and it is the outcome §2.4 exists to end.
  const branch =
    toAgent !== undefined
      ? SEND_MESSAGE_BRANCHES.toAgent
      : toUsers !== undefined
        ? SEND_MESSAGE_BRANCHES.toUser
        : SEND_MESSAGE_BRANCHES.channel
  parseArgs(branch, args)
  // Read only after the branch check, so `thread` on a non-channel branch has already failed.
  const updateThread = toAgent === undefined && toUsers === undefined ? parseArgs(threadField, args.thread) : undefined
  if (toUsers !== undefined && channel === undefined && Array.isArray(args.toUser)) {
    throw new Error(`sendMessage: ${USER_ARRAY_NEEDS_CHANNEL}`)
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
          // The wake lands on the platform its visible post did, which may be another of the agent's platforms.
          ...(channel !== undefined && namedPlatform !== undefined && namedPlatform !== ctx.platform
            ? { targetPlatform: namedPlatform }
            : {}),
          ...(needsReply ? { needsReply: true } : {}),
          // §3.1: no `channel` ⇒ the postless form, whose child is headless.
          ...(channel === undefined ? { postless: true } : {}),
          ...(task !== undefined ? { title: task.title } : {}),
          ...(deps.callId !== undefined ? { submissionId: deps.callId } : {})
        }
      : undefined
  // No visible post for a wake messageAgent would refuse locally; a remote target's call policy can still leave one (accepted).
  const wakeRejection = baseWakeReq !== undefined ? (deps.preflightWake?.(baseWakeReq) ?? null) : null

  // (A) Post a visible IM at a platform channel's ROOT, or to a user's DM. The
  // destination is the `channel` for the channel-root form; the `toUser` DM form (no
  // channel) first resolves the member id to the app's own 1:1 conversation through
  // the platform's Layer-1 `openDirectMessage` read port.
  // Routing is by `platform` (+ optional `integrationId`) to ANY platform the agent is
  // connected to; identity is stamped from the trusted session.
  //
  // THE ROOT, unless this is the update form (§2.4): `thread` names a conversation that
  // already exists and the post lands inside it. Speaking in the CURRENT thread remains the
  // ordinary turn reply's job (§2.1) — a second visible delivery path into the same thread
  // would compete with it — which is why an update into the caller's own thread is refused
  // below rather than served. We post BEFORE any peer wake (B) so the wake can anchor to the
  // post a human sees — for a root post that thread is the post's own `ts`, which only
  // exists after the send.
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
    const wantPlatform = namedPlatform ?? (directMessage ? directMessagePlatformFor(ctx.platform) : ctx.platform)
    // A platform whose mention is not body text would show the `<@id>` raw and notify nobody; refused before anything is read.
    const mentionStyle = channelMentionsFor(wantPlatform)
    if (toUsers !== undefined && channel !== undefined && offersDirectMessages(wantPlatform) && !mentionStyle) {
      throw new Error(
        `sendMessage: toUser with channel (an @-mention in a channel) is not supported on ${platformLabel(wantPlatform)}; ` +
          'send toUser alone for a direct message, or post to the channel without toUser'
      )
    }
    if (toAgent === undefined) {
      const named = [...(toUsers ?? []), ...[...message.matchAll(MENTION)].map((match) => match[1]!)]
      refuseAgentBotTargets(ctx, deps, wantPlatform, named, {
        ...(channel !== undefined ? { channel } : {}),
        ...(namedPlatform !== undefined ? { platform: namedPlatform } : {})
      })
    }
    const wantIntegrationId = parseArgs(integrationIdField, args.integrationId)
    const { gw, integrationId: targetId } = resolveGatewayForPlatform(ctx, deps, wantPlatform, wantIntegrationId)
    // A platform post passes the write rule before anything reads the target; the agent-to-agent channel form keeps the reach rule.
    let verdict: 'post' | 'draft' = 'post'
    if (channel !== undefined) {
      if (deps.judgePost) verdict = await deps.judgePost({ platform: wantPlatform, integrationId: targetId, channel })
      else await assertChannelReachable(ctx, gw, wantPlatform, channel, 'sendMessage')
    }
    // §2.4 refusals, all BEFORE the post — an update that cannot be honored must not fall back
    // to the channel root, which loses the message where the caller was looking for it.
    if (updateThread !== undefined) {
      if (!offersThreadUpdates(wantPlatform)) {
        throw new Error(
          `sendMessage: ${platformLabel(wantPlatform)} cannot post inside an existing thread — ` +
            'drop `thread` to post at the channel root, or say where else the update should go.'
        )
      }
      // The caller's own thread: the ordinary reply already reaches it, and a second delivery
      // path would compete with the one this turn is already streaming (§2.1).
      if (wantPlatform === ctx.platform && requestedChannel === ctx.channel && updateThread === ctx.thread) {
        throw new Error(
          'sendMessage: `thread` is the conversation you are answering right now. Your ordinary reply for this ' +
            'turn already reaches it — no sendMessage needed.'
        )
      }
      // A thread root is what both halves need; a reply's own id would key a session no reply reaches, so it is refused.
      const head = await gw
        .getThreadReplies?.(requestedChannel, updateThread, 1, { throwOnError: true })
        .catch((err) => {
          if (err instanceof JoinRefused) throw err
          return undefined
        })
      if (head === undefined) {
        throw new Error(
          `sendMessage: could not read thread "${updateThread}" in that channel — check the id (and that this bot ` +
            'is in the channel) before retrying.'
        )
      }
      if (head.length === 0 || head[0]?.ts !== updateThread) {
        throw new Error(
          `sendMessage: "${updateThread}" is not a thread root. Pass the id of the message the thread hangs off — ` +
            '`getChannelHistory` reports it as `threadTs`.'
        )
      }
    }
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
    // A gateway-mention platform carries the mentioned users beside the text, never inside it.
    let mentionUsers: string[] | undefined
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
      if (channel !== undefined && mentionStyle === 'gateway') {
        if (attachment)
          throw new Error(`sendMessage: ${platformLabel(wantPlatform)} cannot mention people on a file post`)
        mentionUsers = toUsers
      } else if (channel !== undefined) {
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
    if (directMessage && deps.judgePost) {
      verdict = await deps.judgePost({
        platform: wantPlatform,
        integrationId: targetId,
        channel: postChannel,
        recipient: requestedChannel
      })
    }
    const identity: SendIdentity = {
      ...(ctx.agentName ? { username: ctx.agentName } : {}),
      ...(ctx.iconUrl ? { icon_url: ctx.iconUrl } : {}),
      agentAuthorId: ctx.agentId,
      // §2.4: an update is routed by ingress like any other agent-authored message, so it must
      // arrive FINALIZED and carrying this turn's hop. Unstamped it would either be unroutable
      // or start a fresh chain at depth 0 — and a depth-0 update lets a cron-woken agent re-arm
      // a conversation on every tick, which is exactly the terminating guarantee §2.3 promises.
      ...(updateThread !== undefined
        ? {
            response: {
              responseId: randomUUID(),
              deliveryState: 'final' as const,
              hopCount: deps.currentHopCount?.(ctx) ?? 0,
              mentionedAgentIds: []
            }
          }
        : {}),
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
    // A post the write rule sent for approval is drafted here, once its target is fully resolved.
    if (verdict === 'draft') {
      if (!deps.interceptPost) throw new Error('sendMessage: this post needs approval, and none can be asked for here.')
      if (mentionUsers) {
        throw new Error(
          'sendMessage: a post to that conversation needs approval, and an approved post cannot carry mentions there. ' +
            'Nothing was sent; send it without toUser.'
        )
      }
      if (attachment) {
        throw new Error(
          'sendMessage: a post to that conversation needs approval, and a file cannot be sent for approval. ' +
            'Nothing was sent; send the text alone.'
        )
      }
      const intercepted = await deps.interceptPost({
        platform: wantPlatform,
        integrationId: targetId,
        channel: postChannel,
        ...(updateThread !== undefined ? { thread: updateThread } : {}),
        text: body,
        directMessage,
        ...(directMessage ? { recipient: requestedChannel } : {})
      })
      if (intercepted.handled) return intercepted.result
    }
    // A file share IS the message — the caption is `body`, not a second post. It anchors like
    // any other post where the platform answers with a message id; Slack's does not, and that
    // arm degrades on the path a gateway returning no id already takes. A failed share is
    // raised rather than reported as sent — except `indeterminate`, the queue abandoning a
    // still-running upload, which must say "may have landed" or a retry double-posts.
    if (attachment) {
      const shared = await gw.uploadFile?.(
        postChannel,
        attachment,
        body,
        updateThread !== undefined ? { thread: updateThread } : undefined,
        identity
      )
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
      providerPostId = mentionUsers
        ? await postMentioning(gw, postChannel, body, mentionUsers, identity, wantPlatform)
        : await gw.postMessage(postChannel, body, updateThread, identity)
    }
    const ts = providerPostId ?? `local-${deps.now()}`
    const settled = await settlePost(ctx, deps, gw, {
      platform: wantPlatform,
      integrationId: targetId,
      channel: postChannel,
      ...(updateThread !== undefined ? { updateThread } : {}),
      body,
      ...(providerPostId !== undefined ? { providerPostId } : {}),
      ts,
      directMessage,
      // A peer wake owns the thread it anchors to, so only a post without one seeds the author's session.
      seed: toAgent === undefined
    })
    postedThread = settled.postedThread
    post = {
      platform: wantPlatform,
      integrationId: targetId,
      channel: postChannel,
      thread: updateThread ?? null,
      ts
    }
    if (settled.seeded) {
      // A root post that forked a conversation the agent is already in (a source's or its own) names the call that would have answered.
      const relation =
        postedThread !== undefined && updateThread === undefined
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
      if (relation?.kind === 'source') {
        notices.push(
          `This posted at the ROOT of the conversation of the session that sent you message ${relation.messageId}, ` +
            `so it starts a separate context there instead of answering — the session waiting on you did not ` +
            `receive it. To answer it, call sendMessage with ` +
            `{"action":"replyToSession","messageId":"${relation.messageId}","message":"..."}.`
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
    // `callerThread` / `originThread` above are SESSION identity — the coordinator feeds them
    // to `sessionKey()` to recompute `callerKey` and to route a cross-daemon reply — so they
    // stay on the session coordinate. Only the wake's own thread is a delivery default.
    const threadForWake = channel !== undefined ? postedThread : (deps.deliveryThreadNow?.(ctx) ?? ctx.deliveryThread)
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
  // send-message-guide.md §8.6: a task reports back whether or not `needsReply` was set, and its handle is `taskId`.
  const subsession = wake?.subsession === true
  return {
    ok: true,
    ...(wake !== undefined ? { wake } : {}),
    ...(post !== undefined ? { post } : {}),
    ...(childSessionId !== undefined ? (subsession ? { taskId: childSessionId } : { childSessionId }) : {}),
    ...(childSessionId !== undefined && (needsReply || subsession)
      ? {
          reply: { requested: true, state: 'awaiting' as const },
          nextAction: 'finish-turn-and-wait' as const,
          message: subsession
            ? TASK_STARTED
            : 'Message delivered. The agent will reply by waking this session in a later turn. End this turn and wait; do not retry or ask it to repeat the work.'
        }
      : {}),
    ...(notices.length ? { notice: notices.join(' ') } : {})
  }
}
