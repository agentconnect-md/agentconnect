// Agent-to-agent collaboration (A2A wake/reply/status): every delivery is DIRECT, never a visible post, and its CAS and admission orderings are load-bearing.
import { isAppendCoordinate } from '../session/append-coordinate.js'
import { deriveTitle } from '../session/derive-title.js'
import {
  SUBSESSION_COORDINATE_PREFIX,
  isDelegationCoordinate,
  isSubsessionCoordinate,
  isTaskCoordinate,
  subsessionCoordinate
} from '../session/subsession-coordinate.js'
import type { HostKey } from '../acp/host-key.js'
import { createHash, randomUUID } from 'node:crypto'
import type { Clock } from '@agentconnect.md/connection'
import {
  hasReachedAgentCallHopLimit,
  type ChildSessionStatus,
  type ExternalSessionAudience,
  type AgentCallAskers,
  type ChildSessionStatusProbe,
  type RdAgentMsgDeliveryKind,
  type UserTurnBody
} from '@agentconnect.md/protocol'
import type { Logger } from '../log.js'
import type { LoadedAgent } from '../agents/load-agents.js'
import type { DaemonEvaluationHooks } from '../evaluation/daemon-hooks.js'
import type { CpClient } from '../cp/client.js'
import type { CpAgentRegistry } from '../cp/cp-agent-registry.js'
import type { CpCollabRoutes } from '../cp/cp-collab-routes.js'
import type { RelayManager } from '../cp/relay-manager.js'
import { sendAgentMsgUntilReady } from '../cp/agentmsg-retry.js'
import { sessionKey, type LocalStore, type SessionRecord } from '../store/local-store.js'
import { monotonicTs } from '../store/monotonic-ts.js'
import { isNoResponseBody } from '../session/no-response.js'
import { codeHostReplySnapshot, sessionReplyRoute } from '../session/reply-route.js'
import type { CodeHostReplyTarget } from '../codehost/reply-target.js'
import { isPlatformMemberId } from '../platforms/member-id.js'
import { threadKeyForPost } from '../platforms/thread-keys.js'
import { sessionThreadOf, wakeThreadFields, type NormalizedMessage } from '../messages/normalized.js'
import type { AssistantSubsession } from '../store/assistant-subsessions.js'
import { newSessionMessageId, type ReceivedSessionMessage, type SessionMessageKind } from '../store/session-messages.js'
import {
  renderedSessionMessageInput,
  renderSessionMessage,
  sessionMessageInput,
  submissionMessageId,
  type SessionMessageView,
  type ShownInput
} from './session-message.js'
import { NOBODY, type TurnAskers } from '../assistant/place-access.js'
import type { WebchatTransport } from '../webchat/transport.js'
import type { WebchatTurnContext } from '../webchat/types.js'
import { formatErr } from '../daemon/text.js'
import { ACTIVATION_PAIRING_TTL_MS, activationKey } from '../daemon/helpers.js'
import {
  FailStopError,
  pendingTurnKey,
  sdkLeaseKey,
  type CallMeta,
  type Pending,
  type QueueEntry
} from '../daemon/turn-types.js'
import type {
  ContinueSubsessionReq,
  MessageAgentReq,
  MessageAgentResult,
  ReplyToSessionReq,
  ReplyToSessionResult,
  SessionStatusReq,
  SessionStatusResult
} from '../mcp/ops.js'

/** send-message-guide.md §2.1: the reason a task's own `delegateTask` is refused, and the sentence the agent reads. */
export const TASK_NESTING = 'task_nesting'
const TASK_NESTING_MESSAGE =
  'A task cannot start another task. Do this work here, or report back to the session that started you and let it decide.'
/** assistant-mode.md §5.6: the refusal once `maxConcurrentSubsessions` tasks are running; nothing is queued yet. */
export const TASK_LIMIT = 'task_limit'
export const DEFAULT_MAX_CONCURRENT_SUBSESSIONS = 3
/** How long an `open` row whose session never appeared still counts toward the cap: past it, the wake was lost. */
export const SUBSESSION_START_GRACE_MS = 10 * 60_000
/** How long an `open` sub-session may have nothing running for it before the sweep reports it ended (assistant-mode.md §5.7). */
export const SUBSESSION_IDLE_END_MS = 10 * 60_000
/** send-message-guide.md §8.6: one refusal for an unknown task and another session's, so it names nothing. */
export const TASK_NOT_FOUND = 'task_not_found'
export const TASK_NOT_FOUND_MESSAGE =
  'This session started no task with that id. Nothing was sent. Pass the `taskId` a delegateTask call in this ' +
  'session returned (listTasks shows them), or use delegateTask to delegate a new task.'
/** The previous round's end report is still on its way to the owning session, so no new round opens yet. */
export const TASK_REPORTING = 'task_reporting'
/** send-message-guide.md §8.5: a settled round's late reply is refused, never a second report. */
export const TASK_ENDED = 'task_ended'
/** The same submission of an owner message is still being admitted; it is not sent twice. */
export const SUBMISSION_IN_FLIGHT = 'submission_in_flight'
/** send-message-guide.md §9.4: one refusal for an unknown, foreign, dropped or forged message id, so it names nothing. */
export const MESSAGE_NOT_FOUND = 'message_not_found'
/** send-message-guide.md §9.3: an id already recorded for another recipient names that message, so this delivery is refused. */
export const MESSAGE_ID_IN_USE = 'message_id_in_use'
/** send-message-guide.md §9.2: one refusal for an unknown, foreign, private or closed session, so it names nothing. */
export const PEER_SESSION_NOT_FOUND = 'session_not_found'
export const PEER_SESSION_NOT_FOUND_MESSAGE =
  'That agent has no session with that id that this conversation may join. Nothing was sent and no new session was ' +
  'started. Pass the `childSessionId` an earlier callAgent returned, or omit `sessionId`; a delegated task takes ' +
  'messages only from the session that started it, through messageTask.'

/** How a sub-session's turn, or its refused start, ended (assistant-mode.md §5.7). */
export interface SubsessionTurnEnd {
  agentId: string
  /** The sub-session's logical key, the `childSessionId` its parent was handed. */
  key: string
  /** The turn's message, whose coordinate names the sub-session. */
  msg: NormalizedMessage
  outcome: 'completed' | 'interrupted' | 'failed' | 'refused'
  /** The interrupt or admission reason, when there is one. */
  reason?: string | undefined
  /** A handover kept the delivery for replay, so the replayed turn settles the row instead. */
  replayed: boolean
  /** The ended turn's hop depth, which the daemon's report continues. */
  hopCount?: number | undefined
  /** The work round the turn's input belonged to; absent for a turn no parent input started (a background wake). */
  round?: number | undefined
}

/** How many refused admissions a sub-session's failure report gets before it is given up (assistant-mode.md §5.7). */
export const SUBSESSION_REPORT_ATTEMPTS = 3

/** Where a sub-session sits, for a report the daemon makes on its behalf. */
export interface DaemonReportCaller {
  platform: string
  channel: string
  thread: string
  transportScope?: string | undefined
}

/** One daemon-authored report — a check's, a task's, or a sub-session's failure report — into the place its sub-session belongs to. */
export interface DaemonReport {
  agentId: string
  /** The sub-session the report speaks for. */
  caller: DaemonReportCaller
  /** The place whose current long session hears it; the caller's own by default. */
  place?: { platform: string; channel: string; transportScope?: string | null | undefined }
  /** The recorded parent, which hears it when the place has no current session. */
  parentSessionId: string
  text: string
  /** What the console shows of `text`; absent shows it whole. */
  shown?: ShownInput | undefined
  /** Stable per report: its delivery id and inbox receipt derive from it, so a re-send is deduplicated. */
  reportId: string
  /** The hop depth the report continues; 0 when it starts a chain. */
  hopCount?: number | undefined
  /** The session the sub-session belongs to; a report landing in another one loses its continuation hint. */
  ownerSessionKey?: string | undefined
  /** A task's round report is a session message (send-message-guide.md §9.3) under this id, when it lands in its owner. */
  messageId?: string | undefined
  /** A follow-up's report replies in this thread of an appending place, else (null) where its latest turn replied. */
  replyThread?: string | null | undefined
  /** The coordinate a place with no session yet opens its long session at, as its first message would (a first look's, assistant-mode.md §5.13). */
  opens?: string | undefined
  /** A first look's report (§5.13), by its follow-up: the round it starts may propose. */
  firstLook?: string | undefined
}

/** The long session a report opens in a place nobody spoke in yet; the report's turn creates its row. */
function openingSession(
  agentId: string,
  place: { platform: string; channel: string; transportScope?: string | null | undefined },
  thread: string,
  now: number
): SessionRecord {
  return {
    key: sessionKey(place.platform, place.channel, thread, agentId, place.transportScope),
    agentId,
    platform: place.platform,
    channel: place.channel,
    thread,
    transportScope: place.transportScope ?? null,
    acpSessionId: null,
    state: 'idle',
    lastDeliveredTs: null,
    updatedAt: now
  }
}

/** What a `reporting` row holds to send its round-end report again after a refusal or a restart. */
interface SubsessionEndReport {
  text: string
  /** What the console shows of `text`; absent on rows written before it existed. */
  shown?: ShownInput
  hopCount: number
  caller: DaemonReportCaller
  /** The round it ends; absent means the first. */
  round?: number
  /** How the round settles once the report is admitted; absent means `failed`. */
  settles?: 'done' | 'failed'
  /** The report's session-message id, minted at the claim so a re-send keeps it. */
  messageId?: string
}

function subsessionEndReportOf(json: string | undefined): SubsessionEndReport | undefined {
  try {
    const value = JSON.parse(json ?? '') as Partial<SubsessionEndReport>
    const caller = value.caller
    if (typeof value.text !== 'string' || typeof value.hopCount !== 'number') return undefined
    if (typeof caller?.platform !== 'string' || typeof caller.channel !== 'string' || typeof caller.thread !== 'string')
      return undefined
    return value as SubsessionEndReport
  } catch {
    return undefined
  }
}

/** Closes every daemon-authored report, whose own framing is English, so the parent answers in its people's language. */
export const REPORT_ANSWER_LANGUAGE =
  'Speak to the people here in the language they use, even when this report is in another.'

/** How the owning session messages a task, closing every round-end report. */
const continueHint = (key: string): string =>
  `To give it more work in the same context, call sendMessage with {"action":"messageTask","taskId":"${key}","message":"..."}.`

/** What replaces the hint where the report lands in a later session of the place, which cannot message the task. */
const ELSEWHERE_HINT =
  'It belongs to an earlier session of this conversation, so it cannot be given more work from here; delegate a new task if more is needed.'
/** A report landing in a later session swaps the continue hint for {@link ELSEWHERE_HINT}. */
const withoutContinueHint = (text: string): string =>
  text.replace(
    /To give it more work in the same context, call sendMessage with \{"action":"messageTask"[^\n]*?\}\./,
    ELSEWHERE_HINT
  )

/** Whether a reply to `inReplyTo` answers what a wait is on: its own message, or any where either names none. */
const answers = (link: { messageId?: string }, inReplyTo: string | undefined): boolean =>
  link.messageId === undefined || inReplyTo === undefined || link.messageId === inReplyTo

/** The one report a task's work round ends with (send-message-guide.md §8.5). */
export function subsessionRoundReport(
  key: string,
  end: Pick<SubsessionTurnEnd, 'outcome' | 'reason'>,
  output?: string
): { text: string; shown: ShownInput } {
  const hint = continueHint(key)
  if (end.outcome === 'completed' && output) {
    const frame = `[task finished] Task ${key} finished this round of work. Its final output, delivered on its behalf:`
    return { text: `${frame}\n\n${output}\n\n${hint}`, shown: { text: output, notes: [frame, hint] } }
  }
  const status =
    end.outcome === 'completed'
      ? `[task finished] Task ${key} finished this round of work without a final output; any reply it sent before this is its result.`
      : `[task ended] Task ${key} stopped before finishing (${endReason(end)}). Anything it sent before this is all it reported.`
  return { text: `${status} ${hint}`, shown: { text: status, notes: [hint] } }
}

/** Why a round stopped, as its report names it. */
function endReason(end: Pick<SubsessionTurnEnd, 'outcome' | 'reason'>): string {
  return end.outcome === 'failed'
    ? 'error'
    : end.outcome === 'refused'
      ? `not started: ${end.reason ?? 'refused'}`
      : (end.reason ?? 'interrupted')
}

/** The one short report an approved proposal that ended without its own gets in its owning session; a follow-up's check settles on its own path. */
export function subsessionEndReport(key: string, end: Pick<SubsessionTurnEnd, 'outcome' | 'reason'>): string {
  const tail = 'It sent no result; delegate a task if the work is still needed.'
  if (end.outcome === 'completed')
    return `[approved proposal ended] Approved proposal ${key} ended without reporting back. ${tail}`
  return `[approved proposal ended] Approved proposal ${key} stopped before finishing (${endReason(end)}). ${tail}`
}

/** Records one delivery verdict as an evaluation event and hands it back. */
type ObserveDelivery = (
  type: 'collaboration.delivery.admitted' | 'collaboration.delivery.rejected' | 'collaboration.delivery.deduplicated',
  result: MessageAgentResult,
  deliveryId?: string
) => Promise<MessageAgentResult>

/** A `session-call` as its owning daemon admits it (send-message-guide.md §9.2): everything but the session is trusted. */
export interface SessionCallAdmission {
  toAgentId: string
  callerAgentId: string
  /** The model-supplied handle: the target's session key or outward id, never an ACP id. */
  targetSessionId: string
  /** The caller's current conversation, which the read rule always lets read itself. */
  callerPlace: { platform: string; channel: string }
  askers: TurnAskers
  /** The call's body, which the owning daemon renders with its message header. */
  text: string
  /** The call's trusted metadata: its source session and its message id. */
  callMeta: CallMeta
}

/** How a received message's source is reached from here: its landing coordinates and code-host reply snapshot. */
function messageSourceRoute(message: ReceivedSessionMessage): {
  coords?: CallMeta['originCoords']
  codeHostReplyTarget?: CodeHostReplyTarget | null
} {
  const coords =
    message.sourcePlatform !== undefined && message.sourceChannel !== undefined
      ? {
          platform: message.sourcePlatform as NonNullable<CallMeta['originCoords']>['platform'],
          channel: message.sourceChannel,
          ...(message.sourceThread !== undefined ? { thread: message.sourceThread } : {})
        }
      : undefined
  let codeHostReplyTarget: CodeHostReplyTarget | null | undefined
  try {
    codeHostReplyTarget =
      message.codeHostReplyTarget !== undefined
        ? (JSON.parse(message.codeHostReplyTarget) as CodeHostReplyTarget | null)
        : undefined
  } catch {
    codeHostReplyTarget = undefined
  }
  return { ...(coords ? { coords } : {}), ...(codeHostReplyTarget !== undefined ? { codeHostReplyTarget } : {}) }
}

/** Process-wide daemon state the collaboration path reads. */
export interface CollabCoreHost {
  log(): Logger
  clock(): Clock
  store(): LocalStore
  agents(): ReadonlyMap<string, LoadedAgent>
  evalHooks(): DaemonEvaluationHooks
  /** Live turns keyed by `pendingTurnKey(agentId, acpSessionId)`. */
  pending(): ReadonlyMap<string, Pending>
  /** The owner key a session's pending/lease entries are filed under. */
  sessionOwnerKey(agentId: string, sessionKey: string): HostKey
  /** Per-session call metadata of the turn running right now — the caller's live hop depth. */
  activeTurnCallMeta(): ReadonlyMap<string, CallMeta>
  /** Shutdown/pause: an A2A obligation must not be inferred while the daemon is draining. */
  draining(): boolean
  /** Serialized queue depth and the entry executing now, keyed by logical sessionKey. */
  serialQueue(): ReadonlyMap<string, readonly QueueEntry[]>
  activeGateEntries(): ReadonlyMap<string, QueueEntry>
  /** A sub-session was opened from the parent session's live turn, whose people it then reads for (assistant-mode.md §5.5). */
  noteSubsessionOpened?(childKey: string, parentKey: string): void
  /** assistant-mode.md §5.12: a message to a follow-up from its place's current long session; anything else names nothing. */
  messageFollowUp?(req: ContinueSubsessionReq, taskKey: string, callerKey: string): Promise<MessageAgentResult>
  /** Background SDK tasks a child may still legitimately be waiting on. */
  sdkLease(): ReadonlyMap<string, { tasks: ReadonlyMap<string, unknown>; armedWakes: number }>
  /** Resolves once no interrupt is still unwinding the agent's turns, so a fresh delivery is admitted again. */
  safetyDrained(agentId: string): Promise<void>
  /** Who is asking on a session's live turn (assistant-mode.md §5.5); absent ⇒ nobody. */
  callerAskers?(agentId: string, sessionKey: string, thread: string, integrationId?: string): Promise<TurnAskers>
  /** send-message-guide.md §9.2: whether these people, calling from `callerPlace`, may join the target session; absent ⇒ never. */
  sessionParticipation?(
    target: SessionRecord,
    callerPlace: { platform: string; channel: string },
    askers: TurnAskers
  ): Promise<boolean>
}

/** The CP/relay seam a cross-daemon call, peer lookup, or remote status read goes through. */
export interface CollabRoutingHost {
  cpClient(): CpClient | undefined
  cpAgents(): CpAgentRegistry | undefined
  cpCollab(): CpCollabRoutes
  relays(): RelayManager | undefined
  /** Peer directory names cached from `channelAgents`, the only local source for a remote label. */
  channelAgentNames(): ReadonlyMap<string, { name?: string; displayName?: string }>
  botUserIds(): Record<string, string>
  resolveCpAgent(
    agentId: string,
    platform?: string
  ): { integrationId: string; botUserId: string; platform: string; mutedChannels: string[] } | null
  transportScopeForIntegrationIds(integrationIds?: readonly string[]): string | undefined
  integrationIdForSessionTransport(
    agentId: string,
    platform: string,
    transportScope?: string | null
  ): string | undefined
  /** Whether this member serves the agent's ingress edges and sweeps: duty holder, or any local daemon. */
  servesAgent(agentId: string): boolean
}

/** The turn engine an admitted collaboration wake is handed to. */
export interface CollabTurnHost {
  dispatch(
    agentId: string,
    msg: NormalizedMessage,
    integrationId?: string,
    webchat?: WebchatTurnContext,
    callMeta?: CallMeta,
    opts?: {
      requireDurable?: boolean
      receiptId?: string
      onAdmission?: (result: { accepted: boolean; reason?: string; duplicate?: boolean }) => void
    },
    codeHostReply?: CodeHostReplyTarget
  ): Promise<string | null>
  webchatTransport(): WebchatTransport
  /** The external audience of a session, by its logical key. */
  /** The TARGET's session coordinate in this conversation when it differs from the thread
   *  the wake is delivered on (channel-session-mode.md §3.1). A direct peer wake never
   *  enters the per-target ingress resolution, so it asks here instead; each agent holds its
   *  own reservation, so this is the callee's answer, not the caller's. */
  targetSessionCoordinate(
    agentId: string,
    integrationId: string | undefined,
    channel: string,
    transportScope?: string
  ): Promise<string | undefined>
  externalOriginForSession(
    agentId: string,
    sessionKey: string | undefined
  ): Promise<ExternalSessionAudience | undefined>
}

/** Everything the collaboration coordinator touches on the `Daemon`. */
export interface CollabHost extends CollabCoreHost, CollabRoutingHost, CollabTurnHost {}

export class CollabCoordinator {
  constructor(private readonly host: CollabHost) {}

  // Admission-idempotency for same-daemon agent→agent (`messageAgent`) delivery, keyed by
  // the stable `deliveryId` (design §6.3) — NOT msgId. A retry (P2) reuses the deliveryId,
  // so a second delivery of the same id returns the cached result WITHOUT a second dispatch
  // (no double-wake). Bounded like `relayMsgAcks`. Local path only; cross-daemon dedup is P2.
  readonly agentCallDeliveries = new Map<string, MessageAgentResult>()

  // Parent→child links recorded at wake ADMISSION, keyed by the child's logical sessionKey
  // (== the `childSessionId` handed back by `sendMessage`), valued by the waking session's stable
  // acpSessionId. Authorizes `viewSessionStatus` during the window where the child has been
  // admitted but its session row does not exist yet — dispatch is fire-and-forget, so the parent
  // can legitimately poll before the child's first turn reaches SessionManager. Once that row
  // exists its durable `originSessionId` is the authority, so this is a startup shim, not the
  // record: it is in-memory (a restart kills the in-flight wake it covers anyway) and bounded.
  //
  // `rowUpdatedAtAtAdmission` additionally fences a RE-wake of an already-finished child: the row
  // still reads `idle` + the PREVIOUS turn's `lastTurnOutcome` until SessionManager flips it to
  // `prompting`, so a parent polling right after re-delegating would otherwise be handed the old
  // `done`. Comparing the row's own `updatedAt` against its value at admission is clock-source
  // independent (the store stamps `Date.now()`, the daemon reads `this.clock`), so an unchanged
  // value means "has not acted on our wake yet" without comparing two clocks.
  //
  // `remote:true` marks a child admitted on ANOTHER daemon. Its row will never appear in this
  // store, so the link is the only record that the wake happened and who may follow it; the status
  // read for those is routed through the CP (§5.4) instead of the local store.
  readonly childSessionLinks = new Map<
    string,
    {
      parentSessionId: string
      agentId: string
      rowUpdatedAtAtAdmission: number | null
      replyRequested: boolean
      replyState: 'awaiting' | 'queued-for-parent' | 'failed'
      deliveryId?: string
      dispatchError?: string
      remote?: boolean
      /** The session message the wait is on (send-message-guide.md §9.3): only a reply to it ends the wait. */
      messageId?: string
    }
  >()

  // A sub-session's inferred report still in flight when its turn ends, keyed by its session key (assistant-mode.md §5.7).
  private readonly subsessionInferences = new Map<string, Promise<void>>()
  // Per sub-session: its own report and its turn's settlement take turns, so only one of them reaches the parent.
  private readonly subsessionReportLocks = new Map<string, Promise<void>>()
  // Sub-sessions whose failure report is being sent right now, so a sweep or replay does not send it alongside.
  private readonly subsessionReportSends = new Map<string, Promise<void>>()
  // Parent messages decided into a sub-session's open round and not yet admitted, so the round does not settle under them.
  private readonly subsessionAdmitting = new Map<string, number>()
  // The latest round a parent message joined (not opened) and the child accepted, per sub-session.
  private readonly subsessionJoinedRound = new Map<string, number>()
  // A delegated sub-session's latest final output, which its round-end report carries (send-message-guide.md §8.5).
  private readonly subsessionFinalOutputs = new Map<string, { round?: number | undefined; text: string }>()
  // Submissions being admitted right now, so a concurrent replay of one waits for its receipt instead.
  private readonly subsessionSubmissions = new Set<string>()
  // §8.6: each new-session call's first outcome by its submission, so a replay in this process shares it.
  private readonly callSubmissions = new Map<string, Promise<MessageAgentResult>>()
  // When the sweep first saw an `open` sub-session with nothing running for it, keyed by its session key.
  private readonly subsessionIdleSince = new Map<string, number>()

  /** An agent's channel-directory display name, used to name the caller in the
   *  text delivered to a messaged agent. Resolution order:
   *  a LOCAL agent from `host.agents()`; else the collab snapshot the CP pushes to every daemon
   *  (`cpCollab`, authoritative + always present, so it resolves a REMOTE peer even in the
   *  reply direction where this daemon never listed the channel); else the name cached from a
   *  `channelAgents` (listAgents) response; else the raw agentId (keeps a cold lookup
   *  from throwing). */
  agentDisplayLabel(agentId: string): string {
    const local = this.host.agents().get(agentId)
    if (local) return local.displayName?.trim() || local.name || agentId
    const snap = this.host.cpCollab().nameOf(agentId)
    if (snap) return snap.displayName?.trim() || snap.name || agentId
    const cached = this.host.channelAgentNames().get(agentId)
    return cached?.displayName?.trim() || cached?.name || agentId
  }

  /** send-message-guide.md §9.5: an input's text as the receiving daemon shows it, from its trusted metadata; the body alone when it is no session message. */
  /** A delivery's model input and what the console shows of it: the body, with the header and guidance folded (§9.5). */
  sessionInput(
    callMeta: CallMeta,
    body: string,
    opts: { startsTask?: boolean; shown?: ShownInput; visiblePost?: boolean } = {}
  ): { text: string; turnBody?: UserTurnBody } {
    const label = this.agentDisplayLabel(callMeta.callFrom)
    if (callMeta.messageId === undefined || callMeta.originSessionId === undefined) {
      if (!opts.shown) return { text: body }
      // A daemon report that lands where it is no session message still shows only its readable part.
      return sessionMessageInput(
        {
          kind: callMeta.messageKind ?? 'report',
          source: {
            agentId: callMeta.callFrom,
            label,
            ...(callMeta.originSessionId !== undefined ? { sessionId: callMeta.originSessionId } : {})
          }
        },
        body,
        opts.shown
      )
    }
    const view: SessionMessageView = {
      messageId: callMeta.messageId,
      kind: callMeta.messageKind ?? 'call',
      sourceAgentId: callMeta.callFrom,
      sourceLabel: label,
      sourceSessionId: callMeta.originSessionId,
      ...(callMeta.inReplyTo !== undefined ? { inReplyTo: callMeta.inReplyTo } : {}),
      replyRequested: callMeta.needsReply === true,
      ...(opts.startsTask ? { startsTask: true } : {})
    }
    // A wake paired with a visible post lands on that post's row, whose text and replay stay the post's own.
    if (opts.visiblePost) return { text: renderSessionMessage(view, body) }
    return renderedSessionMessageInput(view, body, opts.shown)
  }

  /** A call from no session is no session message, so it is framed by its sender only, never with an id. */
  private framedBySender(req: MessageAgentReq): string {
    return `From ${this.agentDisplayLabel(req.callerAgentId)}: ${req.text}`
  }

  /** send-message-guide.md §9.3: a message's id, from its submission so a replay keeps it, else a fresh one. */
  messageIdFor(agentId: string, senderKey: string, submissionId: string | undefined): string {
    return submissionId === undefined ? newSessionMessageId() : submissionMessageId(agentId, senderKey, submissionId)
  }

  /** The sending daemon's record of one message (send-message-guide.md §9.3): a reply to it lands only in its sender. */
  private async noteSent(message: {
    messageId: string
    senderKey: string
    senderAgentId: string
    senderSessionId: string
    recipientAgentId: string
    kind: SessionMessageKind
  }): Promise<void> {
    await this.host
      .store()
      .sessionMessages.recordSent({ ...message, now: this.host.clock().now() })
      .catch((err) => this.host.log().warn(`sent message ${message.messageId} not recorded: ${formatErr(err)}`))
  }

  /** A send that was refused reached no one, so nothing answers it. */
  private async forgetSent(messageId: string | undefined): Promise<void> {
    if (messageId === undefined) return
    await this.host
      .store()
      .sessionMessages.forgetSent(messageId)
      .catch(() => undefined)
  }

  /** Whether this message already reached `key`, so a replay of its submission delivers nothing new. */
  async alreadyReceived(messageId: string | undefined, key: string): Promise<boolean> {
    if (messageId === undefined) return false
    const recorded = await this.host
      .store()
      .sessionMessages.received(messageId)
      .catch(() => undefined)
    return recorded?.recipientKey === key
  }

  /** Whether `messageId` already names a message to another recipient, so this delivery must not land (§9.3). */
  private async messageIdInUse(messageId: string | undefined, key: string, agentId: string): Promise<boolean> {
    if (messageId === undefined) return false
    return await this.host
      .store()
      .sessionMessages.conflicts(messageId, key, agentId)
      .catch(() => false)
  }

  /** assistant-mode.md §5.6, the one gate of self-delegation, for every agent: itself as target, the postless form. */
  selfDelegation(req: MessageAgentReq): boolean {
    return req.toAgentId === req.callerAgentId && req.postless === true
  }

  /** assistant-mode.md §5.6: how many sub-sessions the agent may have running at once, its assistant-mode limit else the default. */
  private subsessionLimit(agentId: string): number {
    return (
      this.host.agents().get(agentId)?.assistantMode?.limits?.maxConcurrentSubsessions ??
      DEFAULT_MAX_CONCURRENT_SUBSESSIONS
    )
  }

  /** A sub-session's report reached its parent, so it is done and nothing is reported for it again. */
  private async markSubsessionReported(agentId: string, key: string): Promise<void> {
    await this.host
      .store()
      .assistantSubsessions.finish(agentId, key, 'done')
      .catch((err) => this.host.log().warn(`sub-session ${key}: could not mark it reported: ${formatErr(err)}`))
  }

  /** Run `fn` while no other report or settlement of this sub-session runs; one agent's sub-sessions all live on one daemon. */
  private async withSubsessionReportLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.subsessionReportLocks.get(key) ?? Promise.resolve()
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const tail = prior.then(() => held)
    this.subsessionReportLocks.set(key, tail)
    await prior
    try {
      return await fn()
    } finally {
      release()
      if (this.subsessionReportLocks.get(key) === tail) this.subsessionReportLocks.delete(key)
    }
  }

  /** §5.7: a sub-session's own report; once the daemon has reported it ended, a late one is refused, never a second report. */
  private async reportFromSubsession(
    req: ReplyToSessionReq,
    answered: ReceivedSessionMessage
  ): Promise<ReplyToSessionResult> {
    const key = sessionKey(
      req.platform,
      req.callerChannel,
      req.callerThread,
      req.callerAgentId,
      req.callerTransportScope
    )
    // send-message-guide.md §8.3: a delegated sub-session's reply is a message, so only a settled round refuses it.
    const rounds = isDelegationCoordinate(req.callerThread)
    return await this.withSubsessionReportLock(key, async () => {
      const index = this.host.store().assistantSubsessions
      const row = await index.get(req.callerAgentId, key)
      const ended = rounds && row?.kind !== 'follow-up' ? row !== undefined && row.state !== 'open' : undefined
      if (ended ?? (row?.state === 'failed' || row?.state === 'reporting')) {
        this.host.log().info(`sub-session ${key}: a report after its end was already reported is not delivered`)
        return { delivered: false, inReplyTo: answered.messageId, reason: TASK_ENDED }
      }
      const result = await this.deliverReply(req, answered, key)
      if (result.delivered && ended === undefined) await this.markSubsessionReported(req.callerAgentId, key)
      return result
    })
  }

  /** assistant-mode.md §5.7: once a sub-session's turn ends, leave `open` and report a failure it will not report itself, held in `reporting` until admitted. */
  async settleSubsessionTurn(end: SubsessionTurnEnd): Promise<void> {
    if (isDelegationCoordinate(sessionThreadOf(end.msg))) return await this.settleSubsessionRound(end)
    const { agentId, key } = end
    const inferred = this.subsessionInferences.get(key)
    this.subsessionInferences.delete(key)
    try {
      await inferred
      if (end.replayed) return
      const index = this.host.store().assistantSubsessions
      // Under the report lock, so a report still being admitted settles the row first.
      const claimed = await this.withSubsessionReportLock(key, async () => {
        const row = await index.get(agentId, key)
        // Done (it reported), already failed, or no sub-session at all.
        if (row?.state !== 'open') return undefined
        if (end.outcome === 'completed') {
          // The inferred report spoke for this turn; one the parent did not admit leaves nothing else to send.
          if (inferred) {
            await index.finish(agentId, key, 'failed')
            return undefined
          }
          // A background task still owes the sub-session a wake, whose turn settles it instead.
          if (await this.awaitsBackgroundWake(agentId, key)) return undefined
        }
        // The claim: whoever moves the row out of `open` is the one report, kept on the row until it is admitted.
        const report: SubsessionEndReport = {
          text: subsessionEndReport(key, end),
          hopCount: end.hopCount ?? 0,
          caller: {
            platform: end.msg.platform,
            channel: end.msg.channel,
            thread: sessionThreadOf(end.msg),
            ...(end.msg.transportScope !== undefined ? { transportScope: end.msg.transportScope } : {})
          }
        }
        return await index.claimReport(agentId, key, JSON.stringify(report))
      })
      if (claimed) void this.sendSubsessionEndReport(agentId, key)
    } catch (err) {
      this.host.log().warn(`sub-session ${key}: could not settle its turn: ${formatErr(err)}`)
    }
  }

  /** send-message-guide.md §8.4–§8.5: a delegated sub-session's turn ended; once nothing of its round is left, claim the round's one report. */
  private async settleSubsessionRound(end: SubsessionTurnEnd): Promise<void> {
    const { agentId, key } = end
    try {
      if (end.replayed) return
      const index = this.host.store().assistantSubsessions
      const claimed = await this.withSubsessionReportLock(key, async () => {
        const row = await index.get(agentId, key)
        if (row?.state !== 'open') return false
        const round = row.round ?? 1
        // A late outcome of an older round never settles a newer one.
        if (end.round !== undefined && end.round !== round) return false
        const continues = end.outcome === 'completed' || end.outcome === 'interrupted'
        // Input admitted into this round and not yet run keeps it going; its own turn settles it.
        if (continues && ((this.host.serialQueue().get(key)?.length ?? 0) > 0 || this.subsessionAdmitting.has(key)))
          return false
        if (end.outcome === 'completed' && (await this.awaitsBackgroundWake(agentId, key))) return false
        // A reply the child asked another agent for is still due; its wake continues this round, the idle sweep bounds it.
        if (end.outcome === 'completed' && (await this.awaitsPeerReply(agentId, key))) return false
        const stashed = this.subsessionFinalOutputs.get(key)
        this.subsessionFinalOutputs.delete(key)
        const output = stashed && (stashed.round === undefined || stashed.round === round) ? stashed.text : undefined
        const report: SubsessionEndReport = {
          ...subsessionRoundReport(key, end, end.outcome === 'completed' ? output : undefined),
          hopCount: end.hopCount ?? 0,
          caller: {
            platform: end.msg.platform,
            channel: end.msg.channel,
            thread: sessionThreadOf(end.msg),
            ...(end.msg.transportScope !== undefined ? { transportScope: end.msg.transportScope } : {})
          },
          ...(round > 1 ? { round } : {}),
          settles: end.outcome === 'completed' ? 'done' : 'failed',
          messageId: newSessionMessageId()
        }
        return await index.claimReport(agentId, key, JSON.stringify(report), round)
      })
      if (claimed) void this.sendSubsessionEndReport(agentId, key)
    } catch (err) {
      this.host.log().warn(`sub-session ${key}: could not settle its round: ${formatErr(err)}`)
    }
  }

  /** The session asked another agent for a reply that has neither arrived nor failed. */
  private async awaitsPeerReply(agentId: string, key: string): Promise<boolean> {
    const own = await this.host.store().ensureOutwardSessionId(key, agentId, this.host.clock().now())
    for (const [target, link] of this.childSessionLinks)
      if (target !== key && link.parentSessionId === own && link.replyRequested && link.replyState === 'awaiting')
        return true
    return false
  }

  /** A background task the sub-session started is still live, or its completion wake is armed. */
  private async awaitsBackgroundWake(agentId: string, key: string): Promise<boolean> {
    const sessionId = (await this.host.store().getSession(key))?.acpSessionId ?? undefined
    if (sessionId === undefined) return false
    const lease = this.host.sdkLease().get(sdkLeaseKey(this.host.sessionOwnerKey(agentId, key), sessionId))
    return lease !== undefined && (lease.tasks.size > 0 || lease.armedWakes > 0)
  }

  /** §5.7: send a `reporting` row's failure report; once admitted it is `failed`, and a refusal counts an attempt until the last gives up. */
  private async sendSubsessionEndReport(agentId: string, key: string): Promise<void> {
    if (this.subsessionReportSends.has(key)) return
    const sending = this.sendSubsessionEndReportOnce(agentId, key)
    this.subsessionReportSends.set(key, sending)
    await sending
  }

  private async sendSubsessionEndReportOnce(agentId: string, key: string): Promise<void> {
    try {
      const index = this.host.store().assistantSubsessions
      const row = await index.get(agentId, key)
      if (row?.state !== 'reporting') return
      if (this.host.draining()) {
        this.host
          .log()
          .info(`sub-session ${key} ended without a report while the daemon drains; it is sent on the next start`)
        return
      }
      const report = subsessionEndReportOf(row.endReport)
      if (!report) return await this.giveUpSubsessionReport(row, 'its report is unreadable')
      // The parent's place, whose current session hears it (after `!new`, the new one), else the recorded parent.
      const parent = await this.host.store().getSession(row.parentSessionKey)
      const result = await this.deliverDaemonReport({
        agentId,
        caller: report.caller,
        place: parent
          ? { platform: parent.platform, channel: parent.channel, transportScope: parent.transportScope ?? null }
          : report.caller,
        parentSessionId: row.parentSessionId,
        text: report.text,
        ...(report.shown !== undefined ? { shown: report.shown } : {}),
        // Each round's report is its own, so a later round's is not mistaken for an earlier one already admitted.
        reportId: (report.round ?? 1) > 1 ? `subsession-end:${key}:${report.round}` : `subsession-end:${key}`,
        hopCount: report.hopCount,
        ownerSessionKey: row.parentSessionKey,
        ...(report.messageId !== undefined ? { messageId: report.messageId } : {})
      })
      if (result.admitted) {
        // send-message-guide.md §9.5: the round's report, not the task's own replies, answers what its owner sent it.
        await this.host
          .store()
          .sessionMessages.settleOpenFor(key, this.host.clock().now())
          .catch(() => undefined)
        if (await index.settleReport(agentId, key, report.settles ?? 'failed'))
          await this.markChildParentReply(key, row.parentSessionId, 'queued-for-parent')
        return
      }
      if (result.reason === 'parent_gone') return await this.giveUpSubsessionReport(row, 'its parent session is gone')
      if (result.reason === 'hop_limit') return await this.giveUpSubsessionReport(row, 'hop_limit')
      // A drain that began meanwhile refused it, which the next start makes up for without counting.
      if (this.host.draining()) return
      const attempts = await index.countReportAttempt(agentId, key)
      if (attempts === undefined) return
      const reason = result.reason ?? 'unknown'
      if (attempts >= SUBSESSION_REPORT_ATTEMPTS)
        return await this.giveUpSubsessionReport(row, `${reason}, ${attempts} attempts`)
      this.host
        .log()
        .info(
          `sub-session ${key}: its end report was refused (${reason}); retried on the next sweep (${attempts} of ${SUBSESSION_REPORT_ATTEMPTS})`
        )
    } catch (err) {
      this.host.log().warn(`sub-session ${key}: its end report failed: ${formatErr(err)}`)
    } finally {
      this.subsessionReportSends.delete(key)
    }
  }

  /** A failure report that cannot be delivered: the row settles `failed` and the loss is logged. */
  private async giveUpSubsessionReport(row: AssistantSubsession, why: string): Promise<void> {
    const key = row.childSessionKey
    if (!(await this.host.store().assistantSubsessions.settleReport(row.agentId, key))) return
    await this.markChildParentReply(key, row.parentSessionId, 'failed')
    this.host
      .log()
      .warn(`sub-session ${key} ended without a report, and its end report was not delivered (${why}); none sent`)
  }

  /** §5.7: send the failure reports these agents still owe, on the duty holder — after a restart, on a duty gain, and on each sweep. */
  async resendSubsessionReports(agentIds: Iterable<string>): Promise<void> {
    const index = this.host.store().assistantSubsessions
    for (const agentId of agentIds) {
      if (this.host.draining()) return
      if (!this.host.servesAgent(agentId)) continue
      for (const row of await index.listReporting(agentId))
        await this.sendSubsessionEndReport(agentId, row.childSessionKey)
    }
  }

  /** §5.7 fallback: an `open` delegation with no turn, kept delivery or background wake for {@link SUBSESSION_IDLE_END_MS} is reported ended. */
  async endIdleSubsessions(agentIds: Iterable<string>): Promise<void> {
    const index = this.host.store().assistantSubsessions
    const now = this.host.clock().now()
    const seen = new Set<string>()
    for (const agentId of agentIds) {
      if (this.host.draining()) return
      if (!this.host.servesAgent(agentId) || this.host.agents().get(agentId)?.pause === true) continue
      for (const row of await index.listOpenWithoutInbox(agentId)) {
        const key = row.childSessionKey
        // An approved task settles its record when it ends, which its own recovery does (§5.10).
        if (isTaskCoordinate(key.slice(key.indexOf(`:${SUBSESSION_COORDINATE_PREFIX}`) + 1))) continue
        if (this.subsessionRunning(agentId, key) || (await this.awaitsBackgroundWake(agentId, key))) continue
        seen.add(key)
        const since = this.subsessionIdleSince.get(key) ?? now
        this.subsessionIdleSince.set(key, since)
        if (now - since >= SUBSESSION_IDLE_END_MS) await this.endIdleSubsession(row)
      }
    }
    for (const key of this.subsessionIdleSince.keys()) if (!seen.has(key)) this.subsessionIdleSince.delete(key)
  }

  /** A turn of the sub-session is live, queued, or still settling here. */
  private subsessionRunning(agentId: string, key: string): boolean {
    if (this.host.activeGateEntries().has(key) || (this.host.serialQueue().get(key)?.length ?? 0) > 0) return true
    if (this.subsessionInferences.has(key) || this.subsessionReportSends.has(key)) return true
    if (this.subsessionAdmitting.has(key)) return true
    for (const p of this.host.pending().values())
      if (p.entry.agentId === agentId && p.plan.sessionKey === key) return true
    return false
  }

  /** Claim and send the failure report of an `open` sub-session nothing is running for any more. */
  private async endIdleSubsession(row: AssistantSubsession): Promise<void> {
    const { agentId, childSessionKey: key } = row
    this.subsessionIdleSince.delete(key)
    try {
      const index = this.host.store().assistantSubsessions
      const caller = await this.subsessionCaller(row)
      const claimed = await this.withSubsessionReportLock(key, async () => {
        const current = await index.get(agentId, key)
        if (current?.state !== 'open' || this.subsessionRunning(agentId, key)) return false
        if (!caller) {
          await index.finish(agentId, key, 'failed')
          this.host
            .log()
            .warn(`sub-session ${key} has nothing running, and its place is unknown; settled with no report`)
          return false
        }
        const ended = { outcome: 'interrupted' as const, reason: 'no longer running' }
        const round = current.round ?? 1
        if (!isDelegationCoordinate(caller.thread)) {
          const text = subsessionEndReport(key, ended)
          return await index.claimReport(agentId, key, JSON.stringify({ text, hopCount: 0, caller }))
        }
        const report: SubsessionEndReport = {
          ...subsessionRoundReport(key, ended),
          hopCount: 0,
          caller,
          ...(round > 1 ? { round } : {}),
          messageId: newSessionMessageId()
        }
        return await index.claimReport(agentId, key, JSON.stringify(report), round)
      })
      if (!claimed) return
      this.host
        .log()
        .info(`sub-session ${key} has had nothing running for a while without reporting; reporting it ended`)
      await this.sendSubsessionEndReport(agentId, key)
    } catch (err) {
      this.host.log().warn(`sub-session ${key}: could not end it: ${formatErr(err)}`)
    }
  }

  /** A sub-session's coordinates, read from its key against its own session row, else its parent's. */
  private async subsessionCaller(row: AssistantSubsession): Promise<DaemonReportCaller | undefined> {
    const store = this.host.store()
    const rec = (await store.getSession(row.childSessionKey)) ?? (await store.getSession(row.parentSessionKey))
    if (!rec) return undefined
    const prefix = `${rec.platform}:${rec.channel}:`
    const suffix = `:${row.agentId}${rec.transportScope ? `:${rec.transportScope}` : ''}`
    const key = row.childSessionKey
    if (!key.startsWith(prefix) || !key.endsWith(suffix)) return undefined
    const thread = key.slice(prefix.length, key.length - suffix.length)
    if (sessionKey(rec.platform, rec.channel, thread, row.agentId, rec.transportScope) !== key) return undefined
    return {
      platform: rec.platform,
      channel: rec.channel,
      thread,
      ...(rec.transportScope ? { transportScope: rec.transportScope } : {})
    }
  }

  /** One daemon-authored report (check, task, sub-session failure) into the place's current session, else the recorded parent, injected as `replyToSession` would; at most once per `reportId`, and no tool reaches it. */
  async deliverDaemonReport(report: DaemonReport): Promise<{ admitted: boolean; reason?: string }> {
    const { agentId, caller, text, shown } = report
    const store = this.host.store()
    // An interrupt refuses fresh deliveries until its turns have unwound, and this report is one.
    await this.host.safetyDrained(agentId)
    const id = createHash('sha256').update(`${agentId}\n${report.reportId}`).digest('hex').slice(0, 32)
    const deliveryId = `assistant-report:${id}`
    const receiptId = `assistant-report-receipt:${id}`
    // A re-delivery after a crash: the receipt minted with the first admission says it is already in.
    if (await store.hasInbox(receiptId)) return { admitted: true }
    const sourceHopCount = report.hopCount ?? 0
    if (hasReachedAgentCallHopLimit(sourceHopCount + 1)) {
      this.host.log().warn('sub-session report not delivered (hop_limit)')
      return { admitted: false, reason: 'hop_limit' }
    }
    const callerKey = sessionKey(caller.platform, caller.channel, caller.thread, agentId, caller.transportScope)
    const callerRec = await store.getSession(callerKey)
    // A code-host parent answers where the sub-session's origin turn would have, as `replyToSession` resolves it.
    const replyTarget = callerRec?.originCodeHostReplyTarget
      ? (JSON.parse(callerRec.originCodeHostReplyTarget) as CodeHostReplyTarget | null)
      : undefined
    const place = report.place ?? caller
    // The place's current long session speaks (after `!new`, not the retired one), else the recorded parent.
    const existing =
      (await store.placeSession(agentId, place.platform, place.channel, place.transportScope ?? null)) ??
      (await store.getSessionByOutwardId(report.parentSessionId, agentId))
    const opening =
      !existing && report.opens !== undefined
        ? openingSession(agentId, place, report.opens, this.host.clock().now())
        : undefined
    const parent = existing ?? opening
    const route =
      parent && sessionReplyRoute(parent, (...args) => this.host.integrationIdForSessionTransport(...args), replyTarget)
    if (!parent || !route) {
      this.host.log().warn(`sub-session report not delivered (${parent ? 'not_found' : 'parent session is gone'})`)
      return { admitted: false, reason: parent ? 'not_found' : 'parent_gone' }
    }
    const replierSessionId = callerRec
      ? await store.ensureOutwardSessionId(callerKey, agentId, this.host.clock().now())
      : undefined
    const externalOrigin = await this.host.externalOriginForSession(agentId, callerKey)
    // The lineage `replyToSession` gives a report: from the sub-session, one hop past the turn it continues.
    const callMeta: CallMeta = {
      callFrom: agentId,
      hopCount: sourceHopCount + 1,
      deliveryId,
      ...(replierSessionId !== undefined ? { originSessionId: replierSessionId } : {}),
      originCodeHostReplyTarget: codeHostReplySnapshot(
        callerRec,
        this.host.activeGateEntries().get(callerKey)?.githubReply
      ),
      originCoords: { platform: caller.platform, channel: caller.channel, thread: caller.thread },
      ...(report.firstLook !== undefined ? { firstLookReport: report.firstLook } : {}),
      // The session it opens is the place's own root, never the reporting sub-session's child, which is the place's.
      ...(opening ? { opensPlace: true as const } : {}),
      ...(externalOrigin ? { externalOrigin } : {}),
      ...(replierSessionId !== undefined && (await store.isCaptureExcluded(agentId, callerKey))
        ? { parentPrivate: true }
        : {})
    }
    const botUserId = route.integrationId
      ? this.host.botUserIds()[route.integrationId]
      : this.host.resolveCpAgent(agentId, parent.platform)?.botUserId
    const elsewhere = report.ownerSessionKey !== undefined && parent.key !== report.ownerSessionKey
    const replyThread =
      report.replyThread !== undefined && isAppendCoordinate(parent.thread)
        ? (report.replyThread ?? parent.replyThread ?? undefined)
        : undefined
    // §9.3: a task's report into its owner is a session message; a later session of the place cannot answer the task.
    const messageId = !elsewhere && replierSessionId !== undefined ? report.messageId : undefined
    if (messageId !== undefined) {
      callMeta.messageId = messageId
      callMeta.messageKind = 'report'
      await this.noteSent({
        messageId,
        senderKey: callerKey,
        senderAgentId: agentId,
        senderSessionId: replierSessionId!,
        recipientAgentId: agentId,
        kind: 'report'
      })
    }
    const msg: NormalizedMessage = {
      msgId: `agentcall:${parent.channel}:${deliveryId}`,
      traceId: deliveryId,
      source: 'agent',
      platform: parent.platform,
      channel: parent.channel,
      // A synthetic stored thread is the session's, never a reply target: a follow-up's report replies in its thread, else at the root.
      ...wakeThreadFields(parent.thread, replyThread),
      ...(parent.transportScope ? { transportScope: parent.transportScope } : {}),
      transcriptTs: monotonicTs(),
      sender: { id: agentId, isBot: true },
      ...this.sessionInput(callMeta, `${elsewhere ? withoutContinueHint(text) : text}\n\n${REPORT_ANSWER_LANGUAGE}`, {
        shown: {
          text: shown?.text ?? text,
          notes: [
            ...(shown?.notes ?? []).map((note) => (elsewhere ? withoutContinueHint(note) : note)),
            REPORT_ANSWER_LANGUAGE
          ]
        }
      }),
      // Session-only, never a live conversation post (#966).
      parentReport: true,
      mentionedBots: botUserId ? [botUserId] : [],
      isDm: false
    }
    let settleAdmission!: (result: { accepted: boolean; reason?: string }) => void
    const admitted = new Promise<{ accepted: boolean; reason?: string }>((resolve) => {
      settleAdmission = resolve
    })
    void this.host
      .dispatch(
        agentId,
        msg,
        route.integrationId,
        this.host.webchatTransport().webchatWakeContext(parent.platform, parent.channel),
        callMeta,
        { requireDurable: true, receiptId, onAdmission: (result) => settleAdmission(result) },
        route.codeHostReply
      )
      .catch((err) => {
        this.host.log().error(`sub-session report dispatch failed for session "${parent.key}": ${formatErr(err)}`)
        settleAdmission({ accepted: false, reason: 'error' })
      })
    const admission = await admitted
    if (!admission.accepted) {
      this.host.log().warn(`sub-session report not delivered (${admission.reason ?? 'unknown'})`)
      return { admitted: false, reason: admission.reason ?? 'unknown' }
    }
    this.host.log().info(`sub-session report: ${agentId} → ${parent.key} delivery=${deliveryId}`)
    return { admitted: true }
  }

  /** An agent→agent delivery's body, delivery id and thread; the receiving daemon frames the body with its message header (§9.5). */
  prepareAgentDelivery(req: MessageAgentReq): { deliveryId: string; thread: string; text: string } {
    const deliveryId = monotonicTs()
    const thread = req.thread ?? deliveryId
    return { deliveryId, thread, text: req.text }
  }

  /**
   * The channel a DAEMON-INITIATED channel-intro turn is bound to (issue #536), resolved
   * from the turn's trusted `CallMeta` — the same §6.7 active-turn lookup a nested
   * `messageAgent` uses to inherit hop/origin, keyed by the caller's LOGICAL sessionKey.
   * Returns undefined for every ordinary turn, which is what keeps `listAgents` org-wide
   * by default. The coordinates come from the trusted MCP session context, never tool input,
   * so an agent cannot fabricate (or escape) an intro scope.
   */
  introChannelForTurn(
    agentId: string,
    platform: string,
    coords: { channel?: string; thread?: string; transportScope?: string }
  ): string | undefined {
    if (coords.channel === undefined || coords.thread === undefined) return undefined
    const key = sessionKey(platform, coords.channel, coords.thread, agentId, coords.transportScope)
    return this.host.activeTurnCallMeta().get(key)?.introChannel
  }

  /** Agent→agent routing behind `messageAgent`: a direct wake with no visible thread event; trusted `CallMeta` carries hop limits. */
  /**
   * Side-effect-free authorization for a peer wake on the SAME-DAEMON path — the typed reason
   * {@link messageAgent} would reject it with for a LOCALLY-decidable cause, or, when it is
   * admitted, the CHANNEL the woken session may key off. `sendMessage` uses the rejection half
   * as a preflight, so it never leaves a visible channel post for a `toAgent`+`channel` wake
   * that will never be delivered; `messageAgent` uses BOTH halves, which is why they are one
   * method — a coordinate decided twice could be decided differently. MUST stay in sync with
   * the fail-closed guards in {@link messageAgent}: a reason added there but not here would let
   * a doomed wake still post. A remote target's LOCAL agent config is not readable here (that
   * verdict lives on the owning daemon) — but the org-scoped directory below covers a remote
   * target too, because the CP snapshot is org-wide rather than per-daemon.
   *
   * Two independent checks, in order: the directional call POLICY (`admits`, channel-free)
   * and the COORDINATE INTEGRITY of `req.channel` (`coordsDecision`). Dropping channel from
   * the policy predicate did not drop it as a session coordinate, and this is the
   * same-daemon twin of the relay/terminal-verify gate.
   */
  localWakeDecision(req: MessageAgentReq): { rejection: string } | { rejection: null; channel: string } {
    const caller = this.host.agents().get(req.callerAgentId)
    // A self-delegation (§5.6) is no inter-agent policy edge either; coordinate integrity below still applies.
    const selfWake = (req.toAgentId === req.callerAgentId && req.postless !== true) || this.selfDelegation(req)
    if (
      !caller ||
      (!selfWake && caller.outboundPolicy === 'selected' && !caller.allowedTargetAgentIds.includes(req.toAgentId))
    ) {
      return { rejection: 'not_allowed' }
    }

    // A local id is not sufficient authority: the org-scoped directional call policy must
    // admit caller→target (CpCollabRoutes.admits). Channel membership is NOT consulted —
    // A2A delivery is already postless (#854), so `channel` is only a session coordinate,
    // and a session with no IM integration must still be able to collaborate. Evaluated
    // BEFORE the local-target lookup so it also decides a REMOTE target and an id that is
    // in no directory at all (previously the latter fell through to a misleading
    // 'offline'). Fails closed on an absent/stale snapshot, as before.
    // A self wake, channel-root or a delegation (§5.6), is no inter-agent policy edge; coordinate integrity below still applies.
    if (!selfWake && !this.host.cpCollab().admits(req.callerAgentId, req.toAgentId)) {
      return { rejection: 'not_allowed' }
    }

    // COORDINATE INTEGRITY — the SAME decision the relay's ingress and this daemon's
    // `rd/agentmsg` terminal-verify apply, so all three wake paths enforce one rule. Channel
    // stopped AUTHORIZING the call, but `req.channel` (a model-supplied `channel`, or the
    // turn's own channel) is still the woken peer's session coordinate, so without this a
    // model could name a channel its agent cannot reach and RESUME a co-located peer's
    // session there. Org comes from the caller's own directory entry, never from the
    // request; `admits` above already proved the entry exists, so undefined is unreachable
    // and fails closed anyway.
    //
    // The platform is the RAW trusted session platform — the same value session keys now
    // use everywhere (the old `narrowPlatform` fold that turned `dream` and unknown values
    // into 'slack' is deleted, §6.3). A fold here would classify a genuinely channel-free
    // session as a persisted IM coordinate and fail it closed. Only the branch-2/branch-3
    // split reads the platform at all — the row lookup itself stays platform-free — so
    // passing the raw value cannot re-open the platform-relabelling dodge.
    const callerOrg = this.host.cpCollab().orgForAgent(req.callerAgentId)
    if (callerOrg === undefined) return { rejection: 'not_allowed' }
    const coords = this.host
      .cpCollab()
      .coordsDecision(callerOrg, req.targetPlatform ?? req.platform, req.channel, req.callerAgentId)
    if (coords.verdict === 'reject') return { rejection: 'not_allowed' }

    const target = this.host.agents().get(req.toAgentId)
    if (!selfWake && target?.callPolicy === 'selected' && !target.allowedCallerAgentIds.includes(req.callerAgentId)) {
      return { rejection: 'not_allowed' }
    }
    // Branch 3 substitutes the coordinate rather than refusing the wake; branch 1 hands back
    // `req.channel` untouched so a wake into a shared channel still lands in the thread a
    // human sees.
    return { rejection: null, channel: coords.verdict === 'synthetic' ? coords.channel : req.channel }
  }

  wakeRejectionReason(req: MessageAgentReq): string | null {
    const platform = req.platform
    if (isPlatformMemberId(req.targetPlatform ?? platform, req.toAgentId)) {
      return 'invalid_target'
    }
    // A channel-root self wake preflights before its post exists; messageAgent checks the post and its pairing id.
    if (this.selfDelegation(req) && isSubsessionCoordinate(req.callerThread)) return TASK_NESTING
    const callerKey = sessionKey(
      platform,
      req.callerChannel,
      req.callerThread,
      req.callerAgentId,
      req.callerTransportScope
    )
    const inbound = this.host.activeTurnCallMeta().get(callerKey)
    if (inbound !== undefined && hasReachedAgentCallHopLimit(inbound.hopCount + 1)) return 'hop_limit'
    return this.localWakeDecision(req).rejection
  }

  async messageAgent(req: MessageAgentReq): Promise<MessageAgentResult> {
    if (req.submissionId === undefined || req.targetSessionId !== undefined) return await this.deliverToAgent(req)
    const id = [
      req.callerAgentId,
      req.platform,
      req.callerChannel,
      req.callerThread,
      req.callerTransportScope ?? '',
      req.submissionId
    ].join('\n')
    const prior = this.callSubmissions.get(id)
    if (prior) return await prior
    if (this.callSubmissions.size >= 2000) this.callSubmissions.clear()
    const outcome = this.deliverToAgent(req)
    this.callSubmissions.set(id, outcome)
    return await outcome.catch((err) => {
      this.callSubmissions.delete(id)
      throw err
    })
  }

  private async deliverToAgent(req: MessageAgentReq): Promise<MessageAgentResult> {
    // The caller's session and origin stay on its own platform; everything the wake opens is on the target's.
    const callerPlatform = req.platform
    const platform = req.targetPlatform ?? callerPlatform
    const callerKey = sessionKey(
      callerPlatform,
      req.callerChannel,
      req.callerThread,
      req.callerAgentId,
      req.callerTransportScope
    )
    const observe: ObserveDelivery = async (type, result, deliveryId) => {
      const caller = await this.host.store().getSession(callerKey)
      const pending = caller?.acpSessionId
        ? this.host
            .pending()
            .get(pendingTurnKey(this.host.sessionOwnerKey(req.callerAgentId, callerKey), caller.acpSessionId))
        : undefined
      this.host.evalHooks().emit({
        type,
        agentId: req.callerAgentId,
        ...(caller?.acpSessionId ? { sessionId: caller.acpSessionId } : {}),
        ...(pending?.plan.evaluationTurnId ? { turnId: pending.plan.evaluationTurnId } : {}),
        platform,
        channel: req.channel,
        data: {
          toAgentId: req.toAgentId,
          targetSession: result.targetSession,
          ...(deliveryId ? { deliveryId } : {}),
          ...(result.reason ? { reason: result.reason } : {})
        }
      })
      return result
    }
    // `toAgentId` is an AgentConnect id from listAgents / the trusted agent-call
    // envelope, never a platform member id. In particular, accepting Slack's U…/W… ids
    // here produces a visible `@U…` fallback before the relay can reject the unknown
    // target. Fail before publishing so a model that copied the human-facing Slack
    // mention cannot leave a misleading thread event.
    if (isPlatformMemberId(platform, req.toAgentId)) {
      const fallbackThread = req.thread ?? `agentcall:${req.channel}:invalid-target`
      return observe('collaboration.delivery.rejected', {
        delivered: false,
        targetSession: sessionKey(platform, req.channel, fallbackThread, req.toAgentId),
        reason: 'invalid_target'
      })
    }
    // A self wake is a postless delegation (§5.6) or a channel-root wake whose post `sendMessage` published; one without either is a loop.
    const pairedChannelRootSelfWake =
      req.toAgentId === req.callerAgentId &&
      req.postless !== true &&
      req.transcriptTs !== undefined &&
      !req.transcriptTs.startsWith('local-') &&
      req.agentCallDeliveryId !== undefined
    const selfDelegation = this.selfDelegation(req)
    if (req.toAgentId === req.callerAgentId && !pairedChannelRootSelfWake && !selfDelegation) {
      const fallbackThread = req.thread ?? `agentcall:${req.channel}:self`
      return observe('collaboration.delivery.rejected', {
        delivered: false,
        targetSession: sessionKey(platform, req.channel, fallbackThread, req.toAgentId),
        reason: 'self'
      })
    }
    // §5.6: sub-sessions are one level deep.
    if (selfDelegation && isSubsessionCoordinate(req.callerThread)) {
      const fallbackThread = req.thread ?? `agentcall:${req.channel}:subsession`
      return observe('collaboration.delivery.rejected', {
        delivered: false,
        targetSession: sessionKey(platform, req.channel, fallbackThread, req.toAgentId),
        reason: TASK_NESTING,
        message: TASK_NESTING_MESSAGE
      })
    }
    // send-message-guide.md §9.2: `callAgent` with `sessionId` joins that exact existing session, or nothing.
    if (req.targetSessionId !== undefined)
      return await this.callExistingSession({ ...req, targetSessionId: req.targetSessionId }, callerKey, observe)

    // Trusted source-turn metadata, independent of the delivered message; local and relay paths inherit it identically.
    const inbound = this.host.activeTurnCallMeta().get(callerKey)
    const sourceHopCount = inbound?.hopCount ?? 0
    // The caller's own session, by its outward id, is the message's source; originCoords route a reply from another daemon.
    const callerSession = await this.host.store().getSession(callerKey)
    const originCodeHostReplyTarget = codeHostReplySnapshot(
      callerSession,
      this.host.activeGateEntries().get(callerKey)?.githubReply
    )
    const originSessionId = callerSession
      ? await this.host.store().ensureOutwardSessionId(callerKey, req.callerAgentId, this.host.clock().now())
      : undefined
    const externalOrigin = await this.host.externalOriginForSession(req.callerAgentId, callerKey)
    const originCoords: CallMeta['originCoords'] = {
      platform: callerPlatform,
      channel: req.callerChannel,
      ...(req.callerThread ? { thread: req.callerThread } : {})
    }
    // send-message-guide.md §9.3: a call from a session, or a task's start, is a session message under this id.
    const messageId =
      originSessionId !== undefined ? this.messageIdFor(req.callerAgentId, callerKey, req.submissionId) : undefined
    const messageKind: SessionMessageKind = selfDelegation ? 'taskInput' : 'call'
    // §8.6: a replay of a submission already recorded at its target gets that first receipt, starting nothing.
    const first =
      req.submissionId !== undefined && messageId !== undefined
        ? await this.firstCallReceipt(req, messageId, originSessionId!, callerKey)
        : undefined
    if (first) return observe('collaboration.delivery.deduplicated', first)
    if (inbound !== undefined && hasReachedAgentCallHopLimit(sourceHopCount + 1)) {
      const fallbackThread = req.thread ?? `agentcall:${req.channel}:hop-limit`
      return observe('collaboration.delivery.rejected', {
        delivered: false,
        targetSession: sessionKey(platform, req.channel, fallbackThread, req.toAgentId),
        reason: 'hop_limit'
      })
    }
    // §5.6: a sub-session takes its parent's audience, so a caller with no session to inherit from opens none.
    if (selfDelegation && originSessionId === undefined) {
      const fallbackThread = req.thread ?? `agentcall:${req.channel}:subsession`
      return observe('collaboration.delivery.rejected', {
        delivered: false,
        targetSession: sessionKey(platform, req.channel, fallbackThread, req.toAgentId),
        reason: 'no_parent_session'
      })
    }

    const target = this.host.agents().get(req.toAgentId)
    const resolved = target ? this.host.resolveCpAgent(req.toAgentId, platform) : null
    const integrationId = resolved?.integrationId
    const targetTransportScope =
      integrationId !== undefined ? this.host.transportScopeForIntegrationIds([integrationId]) : undefined
    // The same side-effect-free authorization sendMessage's preflight ran (caller existence +
    // outbound policy, the org-scoped directional call policy, a local target's inbound policy,
    // and COORDINATE INTEGRITY). It is resolved BEFORE the coordinate is minted because it also
    // decides WHICH channel may be minted: a channel-free coordinate the snapshot knows nothing
    // about is admitted but must not become the session key, so `localWakeDecision` hands back a
    // caller-derived channel (`a2a:<callerAgentId>`) that cannot alias any platform session. The
    // rejection path keeps reporting the ASSERTED channel — nothing was opened, and the reason,
    // not the coordinate, is what the caller acts on.
    const wake = this.localWakeDecision(req)
    const coordChannel = wake.rejection === null ? wake.channel : req.channel
    // A2A delivery is direct and postless (#854): the woken peer receives a caller-framed
    // message and nothing is left in any channel. session-concept case 2c (pure wake) is thus
    // the default — a `sendMessage` with `toAgent` never posts, regardless of `channel`.
    const prepared = this.prepareAgentDelivery(req)
    // §5.6: a sub-session opens on a coordinate of its own, never the caller's thread, and is told what it is.
    const event = selfDelegation ? { ...prepared, thread: subsessionCoordinate(prepared.deliveryId) } : prepared
    const subsessionTitle = selfDelegation ? deriveTitle(req.text) : undefined
    const { deliveryId } = event
    const msgId = `agentcall:${coordChannel}:${deliveryId}`
    // Keyed on the CALLEE's coordinate where its conversation appends: this path dispatches a
    // known target directly, so it never reaches the per-target ingress resolution, and
    // keying on the delivery thread would open the peer a second session per caller.
    // A sub-session is never the conversation's append session.
    const targetCoordinate = selfDelegation
      ? undefined
      : await this.host.targetSessionCoordinate(req.toAgentId, integrationId, coordChannel, targetTransportScope)
    const targetSession = sessionKey(
      platform,
      coordChannel,
      targetCoordinate ?? event.thread,
      req.toAgentId,
      targetTransportScope
    )

    const prior = this.agentCallDeliveries.get(deliveryId)
    if (prior) return observe('collaboration.delivery.deduplicated', prior, deliveryId)
    const record = (result: MessageAgentResult): Promise<MessageAgentResult> => {
      if (this.agentCallDeliveries.size >= 2000) this.agentCallDeliveries.clear()
      this.agentCallDeliveries.set(deliveryId, result)
      return observe(
        result.delivered ? 'collaboration.delivery.admitted' : 'collaboration.delivery.rejected',
        result,
        deliveryId
      )
    }

    if (wake.rejection !== null) {
      this.host.log().info(`messageAgent: ${req.callerAgentId} not allowed to call ${req.toAgentId} in ${req.channel}`)
      return record({ delivered: false, targetSession, reason: 'not_allowed' })
    }
    if (messageId !== undefined && originSessionId !== undefined)
      await this.noteSent({
        messageId,
        senderKey: callerKey,
        senderAgentId: req.callerAgentId,
        senderSessionId: originSessionId,
        recipientAgentId: req.toAgentId,
        kind: messageKind
      })

    // Local presence: if absent, route the delivery over the relay. The relay
    // decides whether the target is allowed to be woken by this caller.
    if (!target) {
      const coordPlatform = platform
      const remote = await this.routeAgentMsgCrossDaemon(
        // A session message's body travels raw and its receiver frames it; a sessionless caller's is framed here, as before.
        { ...req, text: messageId !== undefined ? event.text : this.framedBySender(req), thread: event.thread },
        {
          platform: coordPlatform,
          // The ASSERTED coordinate, not `coordChannel`: the relay validates what the caller
          // named, and the OWNING daemon mints the session key (and any channel-free
          // substitution) — we take that canonical key back off the ACK below.
          channel: req.channel,
          thread: event.thread,
          deliveryId,
          targetSession,
          sourceHopCount,
          ...(originSessionId !== undefined ? { originSessionId } : {}),
          originSessionKey: callerKey,
          originCodeHostReplyTarget,
          originCoords,
          ...(externalOrigin ? { externalOrigin } : {}),
          ...(messageId !== undefined ? { messageId, messageKind } : {})
        }
      )
      if (!remote.delivered) await this.forgetSent(messageId)
      // §5.4: an ADMITTED remote wake is still a child this session may follow — its row lives on
      // the owning daemon, so mark the link remote and let viewSessionStatus route through the CP.
      if (remote.delivered && originSessionId !== undefined) {
        if (this.childSessionLinks.size >= 2000) this.childSessionLinks.clear()
        // Key it by the CANONICAL key the target returned (`remote.targetSession`), not our
        // pre-ACK guess — that canonical value is what we hand the agent, so it is what a later
        // `viewSessionStatus` will look up.
        this.childSessionLinks.set(remote.targetSession, {
          parentSessionId: originSessionId,
          agentId: req.toAgentId,
          rowUpdatedAtAtAdmission: null,
          replyRequested: req.needsReply === true,
          replyState: 'awaiting',
          remote: true,
          ...(messageId !== undefined ? { messageId } : {})
        })
      }
      return record(remote)
    }

    // Daemon-private CallMeta (§6.7): hop/origin always inherit.
    const hopCount = inbound ? inbound.hopCount + 1 : 0
    // §5.6: a sub-session always reports back to the conversation that opened it.
    const needsReply = req.needsReply === true || selfDelegation
    const callMeta: CallMeta = {
      callFrom: req.callerAgentId,
      hopCount,
      deliveryId,
      // §5.3: hand the child its origin so it can reply back with `sendMessage({sessionId})`.
      ...(originSessionId !== undefined ? { originSessionId } : {}),
      originCodeHostReplyTarget,
      originCoords,
      ...(externalOrigin ? { externalOrigin } : {}),
      // §5.3: `toAgent.needsReply` — tell the child to report its outcome back to that origin.
      // Meaningless without an origin to reply into, so it rides the same condition.
      ...(needsReply && originSessionId !== undefined ? { needsReply: true } : {}),
      ...(selfDelegation ? { subsessionRound: 1 } : {}),
      ...(messageId !== undefined ? { messageId, messageKind } : {}),
      // §5.1: seal the child's capture gate when the waking session is private.
      // Tighten-only — see CallMeta.parentPrivate.
      ...(originSessionId !== undefined && (await this.host.store().isCaptureExcluded(req.callerAgentId, callerKey))
        ? { parentPrivate: true }
        : {})
    }

    const normalized: NormalizedMessage = {
      msgId,
      traceId: deliveryId,
      source: 'agent',
      // `coordChannel`, so the dispatched turn lands on exactly the key `targetSession`
      // reports (identical to `req.channel` outside the channel-free branch).
      platform,
      channel: coordChannel,
      thread: event.thread,
      ...(targetCoordinate !== undefined ? { sessionThread: targetCoordinate } : {}),
      ...(targetTransportScope !== undefined ? { transportScope: targetTransportScope } : {}),
      sender: { id: req.callerAgentId, isBot: true },
      ...(messageId !== undefined
        ? this.sessionInput(callMeta, event.text, {
            startsTask: selfDelegation,
            visiblePost: req.transcriptTs !== undefined
          })
        : { text: this.framedBySender(req) }),
      // §5.6: a sub-session is born titled by its task, never the message header, as its cards name it.
      ...(subsessionTitle ? { initialSessionTitle: subsessionTitle } : {}),
      mentionedBots: resolved?.botUserId ? [resolved.botUserId] : [],
      isDm: false,
      // A `toAgent`+`channel` wake was preceded by a visible post; carry its real ts so the
      // wake's transcript row collapses onto the recorded post's (channel, thread, ts) PK
      // (no duplicate hand-off) and the session cursor stays canonical (mirrors the
      // spawnChannelRootSession seed). Absent ⇒ transcriptCoords derives ts from the msgId.
      ...(req.transcriptTs !== undefined ? { transcriptTs: req.transcriptTs } : {}),
      // Headless for an intro fan-out (#536) and the postless `toAgent` form (send-message-routing-rework.md §3.1); the child still reports back.
      ...(inbound?.deliverHeadless || req.postless ? { headless: true } : {})
    }

    // §9.3: an id already recorded for another recipient is that message's, so this delivery is refused.
    if (await this.messageIdInUse(messageId, targetSession, req.toAgentId))
      return record({ delivered: false, targetSession, reason: MESSAGE_ID_IN_USE })
    // §5.6: at most `maxConcurrentSubsessions` running; the index row is the claim, so a refusal opens nothing.
    if (selfDelegation && originSessionId !== undefined) {
      const limit = this.subsessionLimit(req.callerAgentId)
      const now = this.host.clock().now()
      const opened = await this.host.store().assistantSubsessions.openWithinLimit(
        {
          agentId: req.callerAgentId,
          childSessionKey: targetSession,
          parentSessionId: originSessionId,
          parentSessionKey: callerKey,
          now
        },
        { limit, startedSince: now - SUBSESSION_START_GRACE_MS }
      )
      if (!opened) {
        await this.forgetSent(messageId)
        return record({
          delivered: false,
          targetSession,
          reason: TASK_LIMIT,
          message: `You already have ${limit} task${limit === 1 ? '' : 's'} running, the most allowed at once. Finish this here, or wait until one of them reports.`
        })
      }
      this.host.noteSubsessionOpened?.(targetSession, callerKey)
    }

    // Fire-and-forget dispatch — mirror handleRelayIm. The wake is async: the tool returns
    // `delivered:true` on ADMISSION (the target processes the turn in its own time), not on
    // the peer's reply. dispatch() drops the turn (returns null) if the target is paused/
    // draining; that still counts as admitted for P1 (a reason-typed NAK on those gates is
    // P2's admission protocol, §6.4).
    // Record the lineage BEFORE the fire-and-forget dispatch, so a parent that polls
    // `viewSessionStatus` the instant sendMessage returns is already authorized.
    if (originSessionId !== undefined) {
      if (this.childSessionLinks.size >= 2000) this.childSessionLinks.clear()
      this.childSessionLinks.set(targetSession, {
        parentSessionId: originSessionId,
        agentId: req.toAgentId,
        // Snapshot the child row as it stands BEFORE the wake runs (null when it has never run),
        // so a re-wake of a finished child can't be reported with its previous turn's outcome.
        rowUpdatedAtAtAdmission: (await this.host.store().getSession(targetSession))?.updatedAt ?? null,
        replyRequested: needsReply,
        replyState: 'awaiting',
        deliveryId,
        ...(messageId !== undefined ? { messageId } : {})
      })
    }
    // send-message-routing-rework.md §3.2/§8.6: the wake of a paired call is the authority; the platform echo reconciles onto this durable record.
    let pairingKey: string | undefined
    if (req.transcriptTs !== undefined) {
      const key = activationKey(platform, targetTransportScope, req.transcriptTs, req.toAgentId)
      const claimed = await this.host
        .store()
        .attachActivationEnvelope(
          key,
          JSON.stringify(callMeta),
          this.host.clock().now() + ACTIVATION_PAIRING_TTL_MS,
          callMeta.deliveryId
        )
      if (!claimed.dispatch) {
        // Already admitted (a retry reusing this delivery id, or a replay). Hand back the
        // SAME child rather than dispatching again — exactly-once is the contract.
        this.host
          .log()
          .info(
            `messageAgent: paired delivery ${req.agentCallDeliveryId ?? deliveryId} already claimed — reusing the existing child`
          )
        return record({ delivered: true, targetSession: claimed.record.childSessionId ?? targetSession })
      }
      this.host
        .log()
        .debug(
          `messageAgent: paired call ${req.agentCallDeliveryId ?? deliveryId} claimed the rendezvous for "${req.toAgentId}" at ${req.transcriptTs}`
        )
      // §8.6: settled centrally in `dispatch` off `callMeta.activationKey`, which is
      // persisted with the inbox row — so a replayed turn completes this rendezvous itself.
      pairingKey = key
      callMeta.activationKey = key
    }
    void this.host
      .dispatch(
        req.toAgentId,
        normalized,
        integrationId,
        // A sub-session never posts into the conversation that opened it.
        selfDelegation ? undefined : this.host.webchatTransport().webchatWakeContext(platform, coordChannel),
        callMeta,
        {
          ...(pairingKey !== undefined ? { requireDurable: true } : {}),
          // §5.7: a sub-session refused before its first turn never reports, so the daemon does.
          ...(selfDelegation
            ? {
                onAdmission: (result: { accepted: boolean; reason?: string }) => {
                  if (result.accepted) return
                  void this.settleSubsessionTurn({
                    agentId: req.toAgentId,
                    key: targetSession,
                    msg: normalized,
                    outcome: 'refused',
                    reason: result.reason,
                    replayed: false,
                    hopCount
                  })
                }
              }
            : {})
        }
      )
      .catch(async (err) => {
        this.host.log().error(`messageAgent dispatch failed for agent "${req.toAgentId}": ${formatErr(err)}`)
        try {
          await this.failAgentDispatch(targetSession, normalized, callMeta, err, selfDelegation)
        } catch (reportErr) {
          this.host.log().error(`messageAgent failure report failed for "${targetSession}": ${formatErr(reportErr)}`)
        } finally {
          if (pairingKey !== undefined) {
            try {
              await this.host.store().releaseActivation(pairingKey)
            } catch (releaseErr) {
              this.host.log().error(`messageAgent activation release failed: ${formatErr(releaseErr)}`)
            }
          }
        }
      })
    this.host
      .log()
      .info(`messageAgent: ${req.callerAgentId} → ${req.toAgentId} (${targetSession}) delivery=${deliveryId}`)
    return record({ delivered: true, targetSession, ...(selfDelegation ? { subsession: true as const } : {}) })
  }

  /** The receipt a submission's first delivery earned, read from its recorded message; undefined when the id names none of this call. */
  private async firstCallReceipt(
    req: MessageAgentReq,
    messageId: string,
    originSessionId: string,
    callerKey: string
  ): Promise<MessageAgentResult | undefined> {
    const store = this.host.store()
    const received = await store.sessionMessages.received(messageId).catch(() => undefined)
    if (
      !received ||
      received.sourceAgentId !== req.callerAgentId ||
      received.sourceSessionId !== originSessionId ||
      received.recipientAgentId !== req.toAgentId
    )
      return undefined
    if (!this.selfDelegation(req)) return { delivered: true, targetSession: received.recipientKey }
    const task = await store.assistantSubsessions.get(req.callerAgentId, received.recipientKey)
    return task?.parentSessionKey === callerKey
      ? { delivered: true, targetSession: received.recipientKey, subsession: true }
      : undefined
  }

  /** send-message-guide.md §9.2, the caller's side: the same caller checks as any call, then the owning daemon's admission. */
  private async callExistingSession(
    req: MessageAgentReq & { targetSessionId: string },
    callerKey: string,
    observe: ObserveDelivery
  ): Promise<MessageAgentResult> {
    const store = this.host.store()
    const refuse = (reason: string, message?: string): Promise<MessageAgentResult> =>
      observe('collaboration.delivery.rejected', {
        delivered: false,
        targetSession: req.targetSessionId,
        reason,
        ...(message ? { message } : {})
      })
    const inbound = this.host.activeTurnCallMeta().get(callerKey)
    const sourceHopCount = inbound?.hopCount ?? 0
    if (inbound !== undefined && hasReachedAgentCallHopLimit(sourceHopCount + 1)) return await refuse('hop_limit')
    if (this.localWakeDecision(req).rejection !== null) return await refuse('not_allowed')
    // A source the target can reply to is a session; a caller with none is recorded nowhere.
    const callerSession = await store.getSession(callerKey)
    if (!callerSession) return await refuse(PEER_SESSION_NOT_FOUND, PEER_SESSION_NOT_FOUND_MESSAGE)
    const originSessionId = await store.ensureOutwardSessionId(callerKey, req.callerAgentId, this.host.clock().now())
    const askers =
      (await this.host
        .callerAskers?.(req.callerAgentId, callerKey, req.callerThread, req.callerIntegrationId)
        .catch(() => NOBODY)) ?? NOBODY
    const externalOrigin = await this.host.externalOriginForSession(req.callerAgentId, callerKey)
    const originCodeHostReplyTarget = codeHostReplySnapshot(
      callerSession,
      this.host.activeGateEntries().get(callerKey)?.githubReply
    )
    const originCoords: NonNullable<CallMeta['originCoords']> = {
      platform: req.platform as NonNullable<CallMeta['originCoords']>['platform'],
      channel: req.callerChannel,
      ...(req.callerThread ? { thread: req.callerThread } : {})
    }
    const parentPrivate = await store.isCaptureExcluded(req.callerAgentId, callerKey)
    const { deliveryId, text } = this.prepareAgentDelivery(req)
    const callerPlace = { platform: req.platform, channel: req.callerChannel }
    const needsReply = req.needsReply === true
    // send-message-guide.md §9.2: each call into the session is a new message with its own id and obligation.
    const messageId = this.messageIdFor(req.callerAgentId, callerKey, req.submissionId)
    await this.noteSent({
      messageId,
      senderKey: callerKey,
      senderAgentId: req.callerAgentId,
      senderSessionId: originSessionId,
      recipientAgentId: req.toAgentId,
      kind: 'call'
    })
    if (this.host.agents().get(req.toAgentId)) {
      const admitted = await this.admitSessionCall({
        toAgentId: req.toAgentId,
        callerAgentId: req.callerAgentId,
        targetSessionId: req.targetSessionId,
        callerPlace,
        askers,
        text,
        callMeta: {
          callFrom: req.callerAgentId,
          hopCount: inbound ? inbound.hopCount + 1 : 0,
          deliveryId,
          originSessionId,
          originCodeHostReplyTarget,
          originCoords,
          ...(externalOrigin ? { externalOrigin } : {}),
          ...(needsReply ? { needsReply: true } : {}),
          ...(parentPrivate ? { parentPrivate: true } : {}),
          messageId,
          messageKind: 'call'
        }
      })
      if (!admitted.accepted) {
        await this.forgetSent(messageId)
        return admitted.reason === 'not_found'
          ? await refuse(PEER_SESSION_NOT_FOUND, PEER_SESSION_NOT_FOUND_MESSAGE)
          : await refuse(admitted.reason)
      }
      this.noteSessionCallLink(admitted.key, originSessionId, req.toAgentId, needsReply, deliveryId, false, messageId)
      this.host
        .log()
        .info(
          `callAgent: ${req.callerAgentId} → ${req.toAgentId} existing session ${admitted.key} delivery=${deliveryId}`
        )
      return await observe(
        'collaboration.delivery.admitted',
        { delivered: true, targetSession: admitted.key },
        deliveryId
      )
    }
    // Another daemon owns the target: it resolves the session and judges participation itself.
    const remote = await this.routeAgentMsgCrossDaemon(
      { ...req, text },
      {
        platform: req.platform as Exclude<NormalizedMessage['platform'], 'hook'>,
        channel: req.callerChannel,
        ...(req.callerThread ? { thread: req.callerThread } : {}),
        deliveryId,
        targetSession: req.targetSessionId,
        sourceHopCount,
        originSessionId,
        originSessionKey: callerKey,
        originCodeHostReplyTarget,
        originCoords,
        ...(externalOrigin ? { externalOrigin } : {}),
        deliveryKind: 'session-call',
        targetSessionId: req.targetSessionId,
        callerAskers: { people: askers.people.slice(0, 32), nobody: askers.nobody || askers.people.length > 32 },
        messageId,
        messageKind: 'call'
      }
    )
    if (!remote.delivered) {
      await this.forgetSent(messageId)
      return remote.reason === 'not_found'
        ? await refuse(PEER_SESSION_NOT_FOUND, PEER_SESSION_NOT_FOUND_MESSAGE)
        : await refuse(remote.reason ?? 'offline')
    }
    this.noteSessionCallLink(
      remote.targetSession,
      originSessionId,
      req.toAgentId,
      needsReply,
      deliveryId,
      true,
      messageId
    )
    return await observe('collaboration.delivery.admitted', remote, deliveryId)
  }

  /** The caller may follow a session it called into, as it may a child it woke. */
  private noteSessionCallLink(
    key: string,
    parentSessionId: string,
    agentId: string,
    replyRequested: boolean,
    deliveryId: string,
    remote: boolean,
    messageId: string
  ): void {
    // A replayed submission is the same message, so a reply already admitted for it still counts.
    if (this.childSessionLinks.get(key)?.messageId === messageId) return
    if (this.childSessionLinks.size >= 2000) this.childSessionLinks.clear()
    this.childSessionLinks.set(key, {
      parentSessionId,
      agentId,
      rowUpdatedAtAtAdmission: null,
      replyRequested,
      replyState: 'awaiting',
      deliveryId,
      ...(remote ? { remote: true } : {}),
      messageId
    })
  }

  /** send-message-guide.md §9.2, local and remote alike: admit into the exact named session the calling people may read, or nothing. */
  async admitSessionCall(
    call: SessionCallAdmission
  ): Promise<{ accepted: true; key: string } | { accepted: false; reason: string }> {
    const store = this.host.store()
    const byKey = await store.getSession(call.targetSessionId)
    const target =
      byKey?.agentId === call.toAgentId
        ? byKey
        : await store.getSessionByOutwardIdOnly(call.targetSessionId, call.toAgentId)
    const notFound = { accepted: false as const, reason: 'not_found' }
    if (!target || target.agentId !== call.toAgentId) return notFound
    // A background task is its owning session's alone, reached through messageTask.
    if (isSubsessionCoordinate(target.thread)) return notFound
    if (target.sessionId != null && target.sessionId === call.callMeta.originSessionId) return notFound
    const participates = await this.host
      .sessionParticipation?.(target, call.callerPlace, call.askers)
      .catch(() => false)
    if (participates !== true) {
      this.host.log().info(`callAgent: ${call.callerAgentId} may not join ${target.key}; nothing was delivered`)
      return notFound
    }
    const route = sessionReplyRoute(target, (...args) => this.host.integrationIdForSessionTransport(...args))
    if (!route) return notFound
    if (await this.messageIdInUse(call.callMeta.messageId, target.key, target.agentId)) return notFound
    // A replay of one submission lands once (§8.6): its message is already recorded on this session.
    if (await this.alreadyReceived(call.callMeta.messageId, target.key)) return { accepted: true, key: target.key }
    const deliveryId = call.callMeta.deliveryId
    const botUserId = route.integrationId
      ? this.host.botUserIds()[route.integrationId]
      : this.host.resolveCpAgent(call.toAgentId, target.platform)?.botUserId
    // Its own coordinates and its ordinary reply route: no root post, no new conversation, no output change.
    const msg: NormalizedMessage = {
      msgId: `agentcall:${target.channel}:${deliveryId}`,
      traceId: deliveryId,
      source: 'agent',
      platform: target.platform as NormalizedMessage['platform'],
      channel: target.channel,
      ...(isAppendCoordinate(target.thread)
        ? { sessionThread: target.thread }
        : target.thread
          ? { thread: target.thread }
          : {}),
      ...(target.transportScope ? { transportScope: target.transportScope } : {}),
      transcriptTs: monotonicTs(),
      sender: { id: call.callerAgentId, isBot: true },
      ...this.sessionInput(call.callMeta, call.text),
      mentionedBots: botUserId ? [botUserId] : [],
      isDm: false
    }
    let settleAdmission!: (result: { accepted: boolean; reason?: string }) => void
    const admitted = new Promise<{ accepted: boolean; reason?: string }>((resolve) => (settleAdmission = resolve))
    let ran = false
    void this.host
      .dispatch(
        call.toAgentId,
        msg,
        route.integrationId,
        this.host.webchatTransport().webchatWakeContext(target.platform, target.channel),
        call.callMeta,
        {
          requireDurable: true,
          onAdmission: (result) => {
            ran = result.accepted
            settleAdmission(result)
          }
        },
        route.codeHostReply
      )
      .catch(async (err) => {
        this.host.log().error(`callAgent dispatch into ${target.key} failed: ${formatErr(err)}`)
        settleAdmission({ accepted: false, reason: 'error' })
        // An admitted call whose turn then failed is reported to its own source, like any other wake.
        if (ran)
          await this.failAgentDispatch(target.key, msg, call.callMeta, err, false).catch((reportErr) =>
            this.host.log().error(`callAgent failure report failed for "${target.key}": ${formatErr(reportErr)}`)
          )
      })
    const admission = await admitted
    if (!admission.accepted)
      return { accepted: false, reason: admission.reason === 'queue_full' ? 'queue_full' : 'busy' }
    return { accepted: true, key: target.key }
  }

  /** The recorded message a turn's call metadata names, when it was received by `key` and asked for a reply. */
  private async messageObligation(
    key: string,
    callMeta: CallMeta | undefined
  ): Promise<ReceivedSessionMessage | undefined> {
    if (callMeta?.needsReply !== true || callMeta.messageId === undefined) return undefined
    const message = await this.host
      .store()
      .sessionMessages.received(callMeta.messageId)
      .catch(() => undefined)
    return message?.recipientKey === key && message.replyState !== 'none' ? message : undefined
  }

  /** Admission is asynchronous: a failed start must end the parent's wait even without a child row. */
  private async failAgentDispatch(
    key: string,
    msg: NormalizedMessage,
    callMeta: CallMeta,
    err: unknown,
    selfDelegation: boolean
  ): Promise<void> {
    const link = this.childSessionLinks.get(key)
    const owned = link !== undefined && link.deliveryId === callMeta.deliveryId
    // send-message-guide.md §9.5: a call whose own message still waits on a reply reports its failure, whoever called since.
    const obligation = await this.messageObligation(key, selfDelegation ? undefined : callMeta)
    // A newer wake owns this slot now. An old rejection must not poison its status or report.
    if (!owned && obligation?.replyState !== 'open') return
    // dispatch() covers the whole turn, including work after a successful parent reply.
    // That reply still arrives; the turn engine records its later failure separately.
    if ((owned && link.replyState === 'queued-for-parent') || (obligation && obligation.replyState !== 'open')) return
    const error = formatErr(err)
    if (owned) this.childSessionLinks.set(key, { ...link, replyState: 'failed', dispatchError: error })
    await this.host.store().setSessionTurnOutcome(key, 'failed', this.host.clock().now())
    if (selfDelegation) {
      if (!owned) return
      await this.settleSubsessionTurn({
        agentId: link.agentId,
        key,
        msg,
        outcome: 'failed',
        reason: error,
        replayed: false,
        hopCount: callMeta.hopCount,
        round: callMeta.subsessionRound
      })
      return
    }
    const childAgentId = owned ? link.agentId : (obligation?.recipientAgentId ?? '')
    // A failed no-reply wake still gets visible status, but does not create an unsolicited parent turn.
    if (!(obligation ? true : owned && link.replyRequested) || !callMeta.originSessionId) return
    const parent = await this.host.store().getSessionByOutwardId(callMeta.originSessionId)
    if (!parent || (!obligation && this.childSessionLinks.get(key)?.deliveryId !== callMeta.deliveryId)) return
    // Answered once: the failure settles this message's obligation, and only this one.
    if (
      obligation &&
      !(await this.host
        .store()
        .sessionMessages.settle(obligation.messageId, 'failed', this.host.clock().now())
        .catch(() => false))
    )
      return
    const route = sessionReplyRoute(
      parent,
      (...args) => this.host.integrationIdForSessionTransport(...args),
      callMeta.originCodeHostReplyTarget
    )
    if (!route || hasReachedAgentCallHopLimit(callMeta.hopCount + 1)) {
      this.host
        .log()
        .warn(`messageAgent failure report not delivered for "${key}": ${route ? 'hop_limit' : 'not_found'}`)
      return
    }
    const deliveryId = `agentcall-failure:${callMeta.deliveryId}`
    const report: NormalizedMessage = {
      msgId: `agentcall:${parent.channel}:${deliveryId}`,
      traceId: deliveryId,
      source: 'agent',
      platform: parent.platform,
      channel: parent.channel,
      ...(isAppendCoordinate(parent.thread)
        ? { sessionThread: parent.thread }
        : parent.thread
          ? { thread: parent.thread }
          : {}),
      ...(parent.transportScope ? { transportScope: parent.transportScope } : {}),
      transcriptTs: monotonicTs(),
      sender: { id: childAgentId, isBot: true },
      text:
        `Agent "${childAgentId}" failed to process ${callMeta.messageId ? `your message ${callMeta.messageId}` : 'the message'} ` +
        `for session "${key}": ${error}\nNo reply will arrive for this delivery. Report the failure; do not retry automatically.`,
      parentReport: true,
      mentionedBots: [],
      isDm: false
    }
    // Dispatch through the parent's serial gate, just like a normal session reply. This is
    // daemon-authored, so it needs neither a child ACP session nor reply-tool authorization.
    void this.host
      .dispatch(
        parent.agentId,
        report,
        route.integrationId,
        this.host.webchatTransport().webchatWakeContext(parent.platform, parent.channel),
        {
          callFrom: childAgentId,
          deliveryId,
          hopCount: callMeta.hopCount + 1
        },
        {
          requireDurable: true,
          onAdmission: (result) => {
            if (!result.accepted)
              this.host.log().warn(`messageAgent failure report refused for "${key}": ${result.reason ?? 'unknown'}`)
          }
        },
        route.codeHostReply
      )
      .catch((reportErr) =>
        this.host.log().error(`messageAgent failure wake failed for "${key}": ${formatErr(reportErr)}`)
      )
  }

  /** #800: a clean turn started by one message that waits on a reply, which it did not send, gets its final output forwarded as that reply (send-message-guide.md §9.5). */
  async maybeInferParentReply(
    childKey: string,
    agentId: string,
    msg: NormalizedMessage,
    callMeta: CallMeta | undefined,
    p: { reply: { text: string }; outputSuppressed?: string | undefined }
  ): Promise<void> {
    // send-message-guide.md §8.5: a delegated sub-session's output rides its round-end report instead.
    if (isDelegationCoordinate(sessionThreadOf(msg))) {
      const output = p.outputSuppressed ? '' : p.reply.text.trim()
      if (output && !isNoResponseBody(output))
        this.subsessionFinalOutputs.set(childKey, { round: callMeta?.subsessionRound, text: output })
      else this.subsessionFinalOutputs.delete(childKey)
      return
    }
    if (this.host.draining()) return
    if (p.outputSuppressed) return
    // send-message-guide.md §9.5: the message that started this turn decides, so a newer caller never cancels it.
    const obligation = await this.messageObligation(childKey, callMeta)
    if (obligation?.replyState !== 'open' || obligation.replyFailed === true) return
    // Another message folded into this turn: one undifferentiated output answers no single message, so all stay open.
    const folded = this.host.activeGateEntries().get(childKey)?.foldedCalls ?? []
    if (folded.some((call) => call.deliveryId !== callMeta!.deliveryId)) {
      this.host.log().info(`inferred parent reply skipped for ${childKey}: the turn answered more than one message`)
      return
    }
    // Live background tasks: the child may legitimately be waiting to report until its
    // task settles (see wakeOnBackgroundTaskDone). Do not preempt that with a premature
    // inference of "I started the task…" narration. `armedWakes` closes the settle race
    // (review): a task that just SETTLED leaves `tasks` before its wake timer fires —
    // and that wake is deferred while this very dispatch finalizes — so a tasks-only
    // check would see zero and infer the narration while the bg wake is still owed.
    const sessionId = (await this.host.store().getSession(childKey))?.acpSessionId ?? undefined
    const lease =
      sessionId !== undefined
        ? this.host.sdkLease().get(sdkLeaseKey(this.host.sessionOwnerKey(agentId, childKey), sessionId))
        : undefined
    if (lease !== undefined && (lease.tasks.size > 0 || lease.armedWakes > 0)) return
    const finalOutput = p.reply.text.trim()
    const text =
      finalOutput && !isNoResponseBody(finalOutput)
        ? `[inferred reply] The delegated session finished its turn without sending its report ` +
          `(no sendMessage replyToSession call). This is its final output, delivered on its behalf:\n\n${finalOutput}`
        : `[inferred reply] The delegated session finished its turn without sending its report and ` +
          `produced no final output. Treat the delegation as ended without a result.`
    this.host
      .log()
      .info(
        `inferred parent reply: ${agentId} (${childKey}) → message ${obligation.messageId} of session ${obligation.sourceSessionId} ` +
          `(turn ended with obligation open; output ${finalOutput ? `${finalOutput.length} chars` : 'empty'})`
      )
    const delivery = this.replyToSession({
      callerAgentId: agentId,
      platform: msg.platform,
      ...(msg.transportScope !== undefined ? { callerTransportScope: msg.transportScope } : {}),
      callerChannel: msg.channel,
      callerThread: sessionThreadOf(msg),
      messageId: obligation.messageId,
      text
    })
      .then((result) => {
        if (!result.delivered) {
          this.host
            .log()
            .warn(
              `inferred parent reply not delivered for ${childKey}: ${result.reason ?? 'unknown'} — obligation stays visible via viewSessionStatus`
            )
        }
      })
      .catch((err) => this.host.log().error(`inferred parent reply dispatch failed for ${childKey}: ${formatErr(err)}`))
    // §5.7: a sub-session's turn end waits for this report before deciding whether one is still owed.
    if (isSubsessionCoordinate(msg.thread)) this.subsessionInferences.set(childKey, delivery)
  }

  private async markChildParentReply(
    childSessionKey: string,
    parentSessionId: string,
    state: 'queued-for-parent' | 'failed',
    inReplyTo?: string
  ): Promise<void> {
    const existing = this.childSessionLinks.get(childSessionKey)
    if (existing && existing.parentSessionId !== parentSessionId) return
    // A reply to another message leaves the wait on this one, as a remote reply does (notePeerReplyAdmitted).
    if (state === 'queued-for-parent' && existing?.replyState === 'awaiting' && !answers(existing, inReplyTo)) return
    const child = await this.host.store().getSession(childSessionKey)
    // Track an unsolicited reply too: `requested` stays false, while the parent can still see
    // that a real reply was queued instead of mistaking it for an outstanding request.
    this.childSessionLinks.set(childSessionKey, {
      parentSessionId,
      agentId: existing?.agentId ?? child?.agentId ?? '',
      // This is a reply observation, not a fresh wake. `null` keeps the re-wake fence inactive
      // once the durable child row exists.
      rowUpdatedAtAtAdmission: existing?.rowUpdatedAtAtAdmission ?? null,
      replyRequested: existing?.replyRequested ?? child?.needsParentReply === 1,
      replyState: state,
      ...(existing?.deliveryId ? { deliveryId: existing.deliveryId } : {}),
      ...(existing?.dispatchError ? { dispatchError: existing.dispatchError } : {}),
      ...(existing?.remote ? { remote: true } : {}),
      ...(existing?.messageId !== undefined ? { messageId: existing.messageId } : {})
    })
  }

  /** send-message-guide.md §9.5: a reply admitted from another daemon ends the wait its answered message opened here, as a local reply does. */
  async notePeerReplyAdmitted(reply: {
    fromAgentId: string
    inReplyTo?: string
    lineageReplyTo?: string
  }): Promise<void> {
    const sent =
      reply.inReplyTo !== undefined
        ? await this.host
            .store()
            .sessionMessages.sent(reply.inReplyTo)
            .catch(() => undefined)
        : undefined
    const source = reply.inReplyTo !== undefined ? sent?.senderSessionId : reply.lineageReplyTo
    if (source === undefined) return
    for (const [key, link] of this.childSessionLinks) {
      if (link.parentSessionId !== source || link.agentId !== reply.fromAgentId || link.replyState !== 'awaiting')
        continue
      // A pre-id peer's reply names no message, so it answers the remote call it returns for.
      if (sent ? link.messageId === sent.messageId : link.remote === true)
        this.childSessionLinks.set(key, { ...link, replyState: 'queued-for-parent' })
    }
  }

  /** A queued parent report dropped before it ran never reaches the parent, so its link stops promising it. */
  async markDroppedParentReport(parentKey: string, callMeta: CallMeta | undefined): Promise<void> {
    if (callMeta?.originSessionId === undefined) return
    const child = await this.host.store().getSessionByOutwardId(callMeta.originSessionId, callMeta.callFrom)
    const link = child ? this.childSessionLinks.get(child.key) : undefined
    // No link (a restart cleared it) or one a newer delegation re-armed: nothing promised this report.
    if (!child || link?.replyState !== 'queued-for-parent') return
    if ((await this.host.store().getSessionByOutwardId(link.parentSessionId))?.key !== parentKey) return
    this.childSessionLinks.set(child.key, { ...link, replyState: 'failed' })
  }

  /** send-message-guide.md §9.4: answer one message this session received, decided by that message's record alone. */
  async replyToSession(req: ReplyToSessionReq): Promise<ReplyToSessionResult> {
    const callerKey = sessionKey(
      req.platform,
      req.callerChannel,
      req.callerThread,
      req.callerAgentId,
      req.callerTransportScope
    )
    const answered = await this.host
      .store()
      .sessionMessages.received(req.messageId)
      .catch(() => undefined)
    // Unknown, another session's or agent's, dropped, or forged: one refusal that reveals nothing.
    if (!answered || answered.recipientKey !== callerKey || answered.recipientAgentId !== req.callerAgentId)
      return { delivered: false, inReplyTo: req.messageId, reason: MESSAGE_NOT_FOUND }
    if (isSubsessionCoordinate(req.callerThread)) return await this.reportFromSubsession(req, answered)
    return await this.deliverReply(req, answered, callerKey)
  }

  /** §8.2: an owning session's reply into its own task is admitted exactly like `messageTask`. */
  private async replyIntoTask(
    req: ReplyToSessionReq,
    answered: ReceivedSessionMessage,
    taskKey: string
  ): Promise<ReplyToSessionResult> {
    const result = await this.continueSubsession({ ...req, sessionId: taskKey })
    if (result.delivered) return { delivered: true, targetSession: taskKey, inReplyTo: answered.messageId }
    const reason: ReplyToSessionResult['reason'] =
      result.reason === TASK_NOT_FOUND
        ? 'not_authorized'
        : result.reason === 'hop_limit' || result.reason === 'queue_full'
          ? result.reason
          : 'busy'
    return {
      delivered: false,
      ...(reason === 'not_authorized' ? {} : { targetSession: taskKey }),
      inReplyTo: answered.messageId,
      reason
    }
  }

  /** The direct child this caller session opened, by its key or outward id; anything else is undefined, which names nothing. */
  private async ownedSubsession(
    agentId: string,
    id: string,
    callerKey: string
  ): Promise<{ row: AssistantSubsession; caller: DaemonReportCaller } | undefined> {
    const store = this.host.store()
    const row = await this.indexedSubsession(agentId, id)
    if (!row || row.kind === 'follow-up' || row.parentSessionKey !== callerKey) return undefined
    // The recorded parent, by outward id too: a rotated or recreated caller session is not the one that opened it.
    if (!(await store.getSession(callerKey))) return undefined
    const callerId = await store.ensureOutwardSessionId(callerKey, agentId, this.host.clock().now())
    if (row.parentSessionId !== callerId) return undefined
    const caller = await this.subsessionCaller(row)
    if (!caller || !isDelegationCoordinate(caller.thread)) return undefined
    return { row, caller }
  }

  /** send-message-guide.md §8: deliver a parent's message into its own direct child's open or next round; never creates or retargets one. */
  async continueSubsession(req: ContinueSubsessionReq): Promise<MessageAgentResult> {
    const agentId = req.callerAgentId
    const callerKey = sessionKey(req.platform, req.callerChannel, req.callerThread, agentId, req.callerTransportScope)
    const refuse = (reason: string, message: string, targetSession = req.sessionId): MessageAgentResult => ({
      delivered: false,
      targetSession,
      reason,
      message
    })
    const notFound = () => refuse(TASK_NOT_FOUND, TASK_NOT_FOUND_MESSAGE)
    if (isSubsessionCoordinate(req.callerThread)) return notFound()
    // A follow-up is owned by its place, which the host judges (assistant-mode.md §5.12).
    const indexed = await this.indexedSubsession(agentId, req.sessionId)
    const followUp = indexed?.kind === 'follow-up' && this.host.messageFollowUp ? indexed : undefined
    const owned = followUp ? undefined : await this.ownedSubsession(agentId, req.sessionId, callerKey)
    if (!followUp && !owned) return notFound()
    const key = followUp?.childSessionKey ?? owned!.row.childSessionKey
    const index = this.host.store().assistantSubsessions
    const submissionId = req.submissionId ?? randomUUID()
    // Scoped to the calling session, so a submission id names nothing outside it.
    const id = createHash('sha256').update(`${agentId}\n${callerKey}\n${submissionId}`).digest('hex').slice(0, 32)
    const deliveryId = `subsession-input:${id}`
    const receiptId = `subsession-input-receipt:${id}`
    // §9.3: the input is a session message, its id from the same submission so a replay keeps it.
    const messageId = submissionMessageId(agentId, callerKey, submissionId)
    // §8.6: a replayed submission gets its first receipt back, and never a second input, slot or round.
    const replayed = async (): Promise<MessageAgentResult | undefined> => {
      const prior = await index.getInput(agentId, id)
      if (prior?.receipt) return JSON.parse(prior.receipt) as MessageAgentResult
      if (!prior) return undefined
      if (this.subsessionSubmissions.has(id) || !(await this.host.store().hasInbox(receiptId)))
        return refuse(
          SUBMISSION_IN_FLIGHT,
          'This same message is already being delivered to the task; do not send it again.',
          key
        )
      return { delivered: true, targetSession: key, subsession: true }
    }
    const prior = await replayed()
    if (prior) return prior
    if (!(await index.claimInput(agentId, id, key, this.host.clock().now()))) {
      return (await replayed()) ?? refuse(SUBMISSION_IN_FLIGHT, 'This same message is already being delivered.', key)
    }
    this.subsessionSubmissions.add(id)
    try {
      const result = followUp
        ? { round: 0, receipt: await this.host.messageFollowUp!(req, key, callerKey) }
        : await this.admitSubsessionInput(req, {
            key,
            caller: owned!.caller,
            callerKey,
            deliveryId,
            receiptId,
            messageId,
            refuse
          })
      await index.settleInput(agentId, id, result.round, JSON.stringify(result.receipt))
      return result.receipt
    } finally {
      this.subsessionSubmissions.delete(id)
    }
  }

  /** One of the agent's indexed sub-sessions, by its key or its session's outward id. */
  private async indexedSubsession(agentId: string, id: string): Promise<AssistantSubsession | undefined> {
    const store = this.host.store()
    const index = store.assistantSubsessions
    return (
      (await index.get(agentId, id)) ??
      (await store
        .getSessionByOutwardIdOnly(id, agentId)
        .then((child) => (child ? index.get(agentId, child.key) : undefined)))
    )
  }

  /** Decide the round under the report lock, then await the child's admission outside it with the round held open. */
  private async admitSubsessionInput(
    req: ContinueSubsessionReq,
    at: {
      key: string
      caller: DaemonReportCaller
      callerKey: string
      deliveryId: string
      receiptId: string
      messageId: string
      refuse: (reason: string, message: string, targetSession?: string) => MessageAgentResult
    }
  ): Promise<{ round: number; receipt: MessageAgentResult }> {
    const agentId = req.callerAgentId
    const { key, caller, callerKey, refuse } = at
    const index = this.host.store().assistantSubsessions
    const inbound = this.host.activeTurnCallMeta().get(callerKey)
    if (inbound !== undefined && hasReachedAgentCallHopLimit(inbound.hopCount + 1))
      return { round: 0, receipt: refuse('hop_limit', 'The agent-call hop limit is reached. Nothing was sent.', key) }
    // §8.4: retained idle work starts again only where this daemon may still run it.
    if (this.host.draining() || this.host.agents().get(agentId)?.pause === true || !this.host.servesAgent(agentId)) {
      return {
        round: 0,
        receipt: refuse(
          'paused',
          'This agent is paused or draining, so the task cannot take work now. Nothing was sent.',
          key
        )
      }
    }
    type Decided = { refusal: MessageAgentResult } | { round: number; reopenedFrom: 'done' | 'failed' | undefined }
    const decided = await this.withSubsessionReportLock(key, async (): Promise<Decided> => {
      let row = await index.get(agentId, key)
      // The previous round's report is being sent right now: let it land, then open the next round.
      if (row?.state === 'reporting') {
        await this.subsessionReportSends.get(key)
        row = await index.get(agentId, key)
      }
      if (!row) return { refusal: refuse(TASK_NOT_FOUND, TASK_NOT_FOUND_MESSAGE) }
      const round = row.round ?? 1
      if (row.state === 'reporting') {
        return {
          refusal: refuse(
            TASK_REPORTING,
            'Its previous round’s report has not reached this session yet, so it cannot take new work now. ' +
              'Nothing was sent; end this turn and message it again after the report arrives.',
            key
          )
        }
      }
      if (row.state === 'open') {
        this.subsessionAdmitting.set(key, (this.subsessionAdmitting.get(key) ?? 0) + 1)
        return { round, reopenedFrom: undefined }
      }
      const limit = this.subsessionLimit(agentId)
      const now = this.host.clock().now()
      const opened = await index.reopenWithinLimit(agentId, key, round, {
        limit,
        startedSince: now - SUBSESSION_START_GRACE_MS
      })
      if (opened !== 'opened') {
        return {
          refusal:
            opened === 'limit'
              ? refuse(
                  TASK_LIMIT,
                  `You already have ${limit} task${limit === 1 ? '' : 's'} running, the most allowed at once. Nothing was sent; message it again once one of them reports.`,
                  key
                )
              : refuse('busy', 'The task changed while this message was admitted. Nothing was sent.', key)
        }
      }
      this.subsessionAdmitting.set(key, (this.subsessionAdmitting.get(key) ?? 0) + 1)
      return { round: round + 1, reopenedFrom: row.state as 'done' | 'failed' }
    })
    if ('refusal' in decided) return { round: 0, receipt: decided.refusal }
    const { round, reopenedFrom } = decided
    let accepted: { accepted: boolean; reason?: string }
    try {
      accepted = await this.dispatchSubsessionInput(req, { ...at, round, inbound })
    } finally {
      const left = (this.subsessionAdmitting.get(key) ?? 1) - 1
      if (left > 0) this.subsessionAdmitting.set(key, left)
      else this.subsessionAdmitting.delete(key)
    }
    if (accepted.accepted) {
      if (!reopenedFrom) this.subsessionJoinedRound.set(key, round)
      this.host.noteSubsessionOpened?.(key, callerKey)
      this.host.log().info(`messageTask: ${agentId} → ${key} round=${round} delivery=${at.deliveryId}`)
      return { round, receipt: { delivered: true, targetSession: key, subsession: true } }
    }
    // A round this message opened and nothing else joined never started, so it goes back to how it was.
    if (reopenedFrom)
      await this.withSubsessionReportLock(key, async () => {
        if (this.subsessionAdmitting.has(key) || this.subsessionJoinedRound.get(key) === round) return
        await index.finish(agentId, key, reopenedFrom, round)
      })
    const reason = accepted.reason ?? 'busy'
    return {
      round,
      receipt: refuse(
        reason,
        `The task did not take the message (${reason}). Nothing was sent; do not retry automatically.`,
        key
      )
    }
  }

  /** One parent input on the child's own coordinate, framed and owed back to its recorded parent. */
  private async dispatchSubsessionInput(
    req: ContinueSubsessionReq,
    at: {
      key: string
      caller: DaemonReportCaller
      callerKey: string
      deliveryId: string
      receiptId: string
      messageId: string
      round: number
      inbound: CallMeta | undefined
    }
  ): Promise<{ accepted: boolean; reason?: string }> {
    const agentId = req.callerAgentId
    const { key, caller, callerKey, deliveryId, messageId, round, inbound } = at
    const store = this.host.store()
    const parentSessionId = (await store.assistantSubsessions.get(agentId, key))?.parentSessionId
    if (parentSessionId === undefined) return { accepted: false, reason: 'not_found' }
    const callerSession = await store.getSession(callerKey)
    const externalOrigin = await this.host.externalOriginForSession(agentId, callerKey)
    const callMeta: CallMeta = {
      callFrom: agentId,
      hopCount: inbound ? inbound.hopCount + 1 : 0,
      deliveryId,
      // §8.2: the child's origin is its recorded parent on every input, never the caller's own current origin.
      originSessionId: parentSessionId,
      originCodeHostReplyTarget: codeHostReplySnapshot(
        callerSession,
        this.host.activeGateEntries().get(callerKey)?.githubReply
      ),
      originCoords: {
        platform: req.platform as NonNullable<CallMeta['originCoords']>['platform'],
        channel: req.callerChannel,
        ...(req.callerThread ? { thread: req.callerThread } : {})
      },
      ...(externalOrigin ? { externalOrigin } : {}),
      needsReply: true,
      subsessionRound: round,
      messageId,
      messageKind: 'taskInput',
      ...((await store.isCaptureExcluded(agentId, callerKey)) ? { parentPrivate: true } : {})
    }
    await this.noteSent({
      messageId,
      senderKey: callerKey,
      senderAgentId: agentId,
      senderSessionId: parentSessionId,
      recipientAgentId: agentId,
      kind: 'taskInput'
    })
    const resolved = this.host.resolveCpAgent(agentId, caller.platform)
    const msg: NormalizedMessage = {
      msgId: `agentcall:${caller.channel}:${deliveryId}`,
      traceId: deliveryId,
      source: 'agent',
      platform: caller.platform as NormalizedMessage['platform'],
      channel: caller.channel,
      thread: caller.thread,
      ...(caller.transportScope !== undefined ? { transportScope: caller.transportScope } : {}),
      transcriptTs: monotonicTs(),
      sender: { id: agentId, isBot: true },
      ...this.sessionInput(callMeta, req.text),
      mentionedBots: resolved?.botUserId ? [resolved.botUserId] : [],
      isDm: false,
      headless: true
    }
    if (this.childSessionLinks.size >= 2000) this.childSessionLinks.clear()
    this.childSessionLinks.set(key, {
      parentSessionId,
      agentId,
      rowUpdatedAtAtAdmission: (await store.getSession(key))?.updatedAt ?? null,
      replyRequested: true,
      replyState: 'awaiting',
      deliveryId
    })
    let settleAdmission!: (result: { accepted: boolean; reason?: string }) => void
    const admitted = new Promise<{ accepted: boolean; reason?: string }>((resolve) => (settleAdmission = resolve))
    void this.host
      .dispatch(agentId, msg, resolved?.integrationId, undefined, callMeta, {
        requireDurable: true,
        receiptId: at.receiptId,
        onAdmission: (result) => settleAdmission(result)
      })
      .catch(async (err) => {
        settleAdmission({ accepted: false, reason: 'error' })
        // A queued input a stop or fail-stop dropped: the turn that ended the round settles it.
        if (err instanceof FailStopError) return
        this.host.log().error(`messageTask dispatch failed for "${key}": ${formatErr(err)}`)
        await this.failAgentDispatch(key, msg, callMeta, err, true).catch((reportErr) =>
          this.host.log().error(`messageTask failure report failed for "${key}": ${formatErr(reportErr)}`)
        )
      })
    return await admitted
  }

  /** send-message-guide.md §9.4: deliver one reply to the answered message's source by its recorded route; never anywhere else. */
  private async deliverReply(
    req: ReplyToSessionReq,
    answered: ReceivedSessionMessage,
    callerKey: string
  ): Promise<ReplyToSessionResult> {
    const store = this.host.store()
    const inReplyTo = answered.messageId
    const inbound = this.host.activeTurnCallMeta().get(callerKey)
    const callerRec = await store.getSession(callerKey)
    const route = messageSourceRoute(answered)
    const replyTarget = route.codeHostReplyTarget
    // A task's explicit reply settles nothing; its round's report does (§9.5).
    const settles = !isDelegationCoordinate(req.callerThread)
    const failed = async (
      reason: NonNullable<ReplyToSessionResult['reason']>,
      targetSession?: string
    ): Promise<ReplyToSessionResult> => {
      await this.markChildParentReply(callerKey, answered.sourceSessionId, 'failed')
      await store.sessionMessages.noteReplyFailed(inReplyTo).catch(() => undefined)
      return { delivered: false, ...(targetSession ? { targetSession } : {}), inReplyTo, reason }
    }
    // A reply is an agent-call: one hop past the deeper of this turn and the answered message, so an exchange stops.
    const sourceHopCount = Math.max(inbound?.hopCount ?? 0, answered.hopCount)
    if (hasReachedAgentCallHopLimit(sourceHopCount + 1)) return failed('hop_limit')
    const local = await store.getSessionByOutwardId(answered.sourceSessionId, answered.sourceAgentId || undefined)
    if (local && local.agentId === req.callerAgentId && isSubsessionCoordinate(local.thread)) {
      // A check or approved proposal runs once (§8.9), so no reply wakes it again.
      if (!isDelegationCoordinate(local.thread)) return { delivered: false, inReplyTo, reason: 'not_authorized' }
      const row = await store.assistantSubsessions.get(local.agentId, local.key)
      // §8.2: the owner answering its own task is messaging it; any other session's reply is delivered like a peer's.
      if (row && row.kind !== 'follow-up' && row.parentSessionKey === callerKey)
        return await this.replyIntoTask(req, answered, local.key)
    }
    const replierSessionId = callerRec
      ? await store.ensureOutwardSessionId(callerKey, req.callerAgentId, this.host.clock().now())
      : undefined
    const externalOrigin = await this.host.externalOriginForSession(req.callerAgentId, callerKey)
    const replyOriginCoords: CallMeta['originCoords'] = {
      platform: req.platform as NonNullable<CallMeta['originCoords']>['platform'],
      channel: req.callerChannel,
      ...(req.callerThread ? { thread: req.callerThread } : {})
    }
    const originCodeHostReplyTarget = codeHostReplySnapshot(
      callerRec,
      this.host.activeGateEntries().get(callerKey)?.githubReply
    )
    // §9.3: the reply is itself a message, under an id its submission decides, naming the one it answers.
    const messageId =
      replierSessionId !== undefined ? this.messageIdFor(req.callerAgentId, callerKey, req.submissionId) : undefined
    const deliveryId = randomUUID()
    const callMeta: CallMeta = {
      callFrom: req.callerAgentId,
      hopCount: sourceHopCount + 1,
      deliveryId,
      ...(replierSessionId !== undefined ? { originSessionId: replierSessionId } : {}),
      originCodeHostReplyTarget,
      originCoords: replyOriginCoords,
      ...(externalOrigin ? { externalOrigin } : {}),
      ...(messageId !== undefined ? { messageId, messageKind: 'reply' as const, inReplyTo } : {}),
      // §5.1: seal the recipient's capture gate when the replying session is private; tighten-only.
      ...(replierSessionId !== undefined && (await store.isCaptureExcluded(req.callerAgentId, callerKey))
        ? { parentPrivate: true }
        : {})
    }
    if (messageId !== undefined && replierSessionId !== undefined)
      await this.noteSent({
        messageId,
        senderKey: callerKey,
        senderAgentId: req.callerAgentId,
        senderSessionId: replierSessionId,
        recipientAgentId: answered.sourceAgentId,
        kind: 'reply'
      })
    const delivered = async (targetSession: string): Promise<ReplyToSessionResult> => {
      await this.markChildParentReply(callerKey, answered.sourceSessionId, 'queued-for-parent', inReplyTo)
      // §9.5: the first delivered reply settles the message's obligation; later ones are still delivered.
      if (settles)
        await store.sessionMessages.settle(inReplyTo, 'replied', this.host.clock().now()).catch(() => undefined)
      return { delivered: true, targetSession, inReplyTo }
    }

    if (local) {
      const replyRoute = sessionReplyRoute(
        local,
        (...args) => this.host.integrationIdForSessionTransport(...args),
        replyTarget
      )
      if (!replyRoute) {
        await this.forgetSent(messageId)
        return failed('not_found', local.key)
      }
      const { integrationId, codeHostReply } = replyRoute
      // A replay of one submission lands once (§8.6): its reply is already recorded on the source.
      if (await this.alreadyReceived(messageId, local.key)) return await delivered(local.key)
      const resolved = this.host.resolveCpAgent(local.agentId, local.platform)
      // The reply is injected into the source's transcript only, never posted; its ordinary turn keeps its reply route.
      const normalized: NormalizedMessage = {
        msgId: `agentcall:${local.channel}:${deliveryId}`,
        traceId: deliveryId,
        source: 'agent',
        platform: local.platform,
        channel: local.channel,
        // A synthetic stored thread is the session's, never a reply target, so the source posts at the root.
        ...(isAppendCoordinate(local.thread)
          ? { sessionThread: local.thread }
          : local.thread
            ? { thread: local.thread }
            : {}),
        ...(local.transportScope ? { transportScope: local.transportScope } : {}),
        // Ordered as new content in the source session; a UUID-derived ts would be mis-ordered and dropped.
        transcriptTs: monotonicTs(),
        sender: { id: req.callerAgentId, isBot: true },
        ...this.sessionInput(callMeta, req.text),
        // #966: a reply resumes the source session-only, never as a live conversation post.
        parentReport: true,
        mentionedBots: integrationId
          ? this.host.botUserIds()[integrationId]
            ? [this.host.botUserIds()[integrationId]!]
            : []
          : resolved?.botUserId
            ? [resolved.botUserId]
            : [],
        isDm: false
      }
      let settleAdmission!: (result: { accepted: boolean; reason?: string }) => void
      const admitted = new Promise<{ accepted: boolean; reason?: string }>((resolve) => {
        settleAdmission = resolve
      })
      const turn = this.host.dispatch(
        local.agentId,
        normalized,
        integrationId,
        this.host.webchatTransport().webchatWakeContext(local.platform, local.channel),
        callMeta,
        { requireDurable: true, onAdmission: (result) => settleAdmission(result) },
        codeHostReply
      )
      void turn.catch((err) => {
        this.host.log().error(`replyToSession dispatch failed for message "${inReplyTo}": ${formatErr(err)}`)
        settleAdmission({ accepted: false, reason: 'error' })
      })
      // Await the admission barrier, never the model.
      const admission = await admitted
      if (!admission.accepted) {
        await this.forgetSent(messageId)
        return failed(admission.reason === 'queue_full' ? 'queue_full' : 'busy', local.key)
      }
      this.host
        .log()
        .info(
          `replyToSession: ${req.callerAgentId} → ${local.agentId} (${local.key}) in reply to ${inReplyTo} delivery=${deliveryId}`
        )
      return await delivered(local.key)
    }

    // Cross-daemon: by the recorded coordinates and agent; a source without them cannot be reached.
    const coords = route.coords
    if (!coords || !answered.sourceAgentId) {
      await this.forgetSent(messageId)
      return failed('not_found')
    }
    const targetSession = sessionKey(coords.platform, coords.channel, coords.thread ?? '', answered.sourceAgentId)
    const res = await this.routeAgentMsgCrossDaemon(
      {
        callerAgentId: req.callerAgentId,
        platform: coords.platform,
        callerChannel: req.callerChannel,
        callerThread: req.callerThread,
        toAgentId: answered.sourceAgentId,
        text: req.text,
        channel: coords.channel,
        ...(coords.thread !== undefined ? { thread: coords.thread } : {})
      },
      {
        platform: coords.platform,
        channel: coords.channel,
        ...(coords.thread !== undefined ? { thread: coords.thread } : {}),
        deliveryId,
        targetSession,
        sourceHopCount,
        ...(replierSessionId !== undefined ? { originSessionId: replierSessionId } : {}),
        originSessionKey: callerKey,
        originCodeHostReplyTarget,
        codeHostReplyTarget: replyTarget,
        originCoords: replyOriginCoords,
        ...(externalOrigin ? { externalOrigin } : {}),
        // Into the source session, never a coordinate-keyed wake that could mint another.
        lineageReplyTo: answered.sourceSessionId,
        deliveryKind: 'session-reply',
        // §9.4: the source's daemon admits it only into the session that sent the answered message; a pre-id message takes the old route.
        ...(messageId !== undefined && !answered.legacy ? { messageId, messageKind: 'reply' as const, inReplyTo } : {})
      }
    )
    if (!res.delivered) {
      await this.forgetSent(messageId)
      return await failed((res.reason ?? 'offline') as NonNullable<ReplyToSessionResult['reason']>, res.targetSession)
    }
    return await delivered(res.targetSession)
  }

  /**
   * Read the progress of a session the caller STARTED (backs the `viewSessionStatus` tool). The
   * read counterpart of {@link replyToSession}: a child may reply UP its lineage, a parent may
   * read DOWN it, and neither can reach sideways into an unrelated session.
   *
   * AUTHORIZATION (child-only, fail-closed): `sessionId` must name a session whose parent is the
   * CALLING session. Two sources, in order — the child's DURABLE `originSessionId` (authoritative
   * once the child's row exists), else the in-memory {@link childSessionLinks} entry written at
   * wake admission (covers the window before the child's first turn creates that row). Anything
   * else — an unknown id, a sibling, the caller's own session, a grandchild — returns null, which
   * the tool surfaces as one indistinguishable error so the caller cannot probe for sessions it
   * may not read.
   *
   * The reported `status` collapses the §7.3 lifecycle plus the last turn's outcome: a turn in
   * flight (or admitted-but-not-yet-open) is `in-progress`; otherwise the last completed turn's
   * outcome decides `done` vs `failed`. Note `done` means "its turn ended", not "it reported
   * back" — that is what `needsReply` is for.
   */
  async viewSessionStatus(req: SessionStatusReq): Promise<SessionStatusResult | null> {
    const platform = req.platform
    const callerKey = sessionKey(
      platform,
      req.callerChannel,
      req.callerThread,
      req.callerAgentId,
      req.callerTransportScope
    )
    // The caller names ITSELF the way lineage does — outwardly (§1.1) — because that is what the
    // durable parent link, the admission link and the CP's ownership check are all written in.
    const callerSessionId = (await this.host.store().getSession(callerKey))
      ? await this.host.store().ensureOutwardSessionId(callerKey, req.callerAgentId, this.host.clock().now())
      : undefined
    // A caller with no session id of its own has no lineage to check against — refuse rather than
    // fall through to a link lookup that could match an `undefined` parent.
    if (!callerSessionId) return null
    // Addressed ONLY by the logical sessionKey `sendMessage` handed back. An ACP-id lookup is
    // deliberately not offered: ACP ids are minted per runtime and are not unique across agents,
    // so `getSessionByAcpId` can return a row belonging to a different agent — an ambiguous status
    // read for no benefit, since the parent always has the key we gave it.
    const child = await this.host.store().getSession(req.sessionId)
    if (!child) {
      // No local row. Either the wake was admitted and dispatch is still in flight, or the child
      // lives on another daemon. Both are only answerable to the parent that actually woke it.
      const link = this.childSessionLinks.get(req.sessionId)
      if (!link || link.parentSessionId !== callerSessionId) return null
      if (link.remote) return await this.remoteChildStatus(req.sessionId, callerSessionId, link.agentId)
      return {
        sessionId: req.sessionId,
        agentId: link.agentId,
        status: link.dispatchError ? 'failed' : 'in-progress',
        state: link.dispatchError ? 'idle' : 'starting',
        ...this.childStatusGuidance('in-progress', link.replyRequested, link.replyState, link.dispatchError)
      }
    }
    if (!this.isAuthorizedChildParent(child, callerSessionId)) return null
    // A session cannot be its own child; guard the degenerate case where a caller passes its own
    // id and a stale link would otherwise vouch for it.
    if (child.key === callerKey) return null
    const collapsed = this.collapseChildStatus(child, callerSessionId)
    return { sessionId: req.sessionId, ...collapsed }
  }

  private childStatusGuidance(
    status: SessionStatusResult['status'],
    replyRequested: boolean,
    trackedReplyState?: 'awaiting' | 'queued-for-parent' | 'failed',
    dispatchError?: string
  ): Pick<SessionStatusResult, 'reply' | 'nextAction' | 'message'> {
    if (dispatchError)
      return {
        reply: { requested: replyRequested, state: 'failed' },
        nextAction: 'report-failure',
        message: `The child dispatch failed: ${dispatchError}. Do not retry automatically; report the failure.`
      }
    if (trackedReplyState === 'queued-for-parent') {
      return {
        reply: { requested: replyRequested, state: 'queued-for-parent' },
        nextAction: 'finish-turn-and-wait',
        message:
          'The agent replied. Its reply is queued for this session and will arrive in your next turn. End this turn; do not retry or ask the agent to repeat it.'
      }
    }
    if (trackedReplyState === 'failed') {
      return {
        reply: { requested: replyRequested, state: 'failed' },
        nextAction: 'report-failure',
        message: 'The agent tried to reply, but delivery failed. Do not retry automatically; report the failure.'
      }
    }
    if (!replyRequested) {
      return {
        reply: { requested: false, state: 'not-requested' },
        nextAction: status === 'in-progress' ? 'wait' : status === 'failed' ? 'report-failure' : 'none',
        message:
          status === 'in-progress'
            ? 'Message delivered; the agent is still working. No reply was requested.'
            : status === 'failed'
              ? 'The child turn failed. No reply was requested.'
              : 'The child turn finished cleanly. No reply was requested.'
      }
    }
    if (status === 'in-progress') {
      return {
        reply: { requested: true, state: 'awaiting' },
        nextAction: 'finish-turn-and-wait',
        message:
          'Message delivered; the agent is still working. End this turn and wait for its reply; do not retry or poll tightly.'
      }
    }
    if (status === 'failed') {
      return {
        reply: { requested: true, state: 'not-sent' },
        nextAction: 'report-failure',
        message:
          'The child turn failed before sending the requested reply. Do not retry automatically; report the failure.'
      }
    }
    if (trackedReplyState === 'awaiting') {
      return {
        reply: { requested: true, state: 'not-sent' },
        nextAction: 'report-missing-reply',
        message:
          'The child turn finished without sending the requested parent-session reply. Do not retry automatically; report this outcome or wait for user direction.'
      }
    }
    return {
      reply: { requested: true, state: 'unknown' },
      nextAction: 'finish-turn-and-wait',
      message:
        'The child turn finished, but reply-delivery state is unavailable. End this turn and wait; do not retry or ask the agent to repeat it.'
    }
  }

  /**
   * Collapse one child session row into the coarse §5.4 progress triple. Shared by the local
   * `viewSessionStatus` and the CP-forwarded {@link childSessionStatusProbe} so a parent gets the
   * same answer whichever daemon its child landed on.
   *
   * Work is outstanding when a turn is running, queued behind one, or admitted by a wake the child
   * has not picked up yet (its row has not moved since we admitted it — see the
   * `rowUpdatedAtAtAdmission` note on childSessionLinks). Reporting the previous turn's outcome in
   * any of those windows would tell the parent its NEW delegation had already finished.
   */
  private collapseChildStatus(
    child: SessionRecord,
    parentSessionId: string
  ): {
    agentId: string
    status: SessionStatusResult['status']
    state: SessionStatusResult['state']
    updatedAt: number
    reply: SessionStatusResult['reply']
    nextAction: SessionStatusResult['nextAction']
    message: string
  } {
    const candidateLink = this.childSessionLinks.get(child.key)
    const link = candidateLink?.parentSessionId === parentSessionId ? candidateLink : undefined
    const queuedOrRunning =
      this.host.activeGateEntries().has(child.key) || (this.host.serialQueue().get(child.key)?.length ?? 0) > 0
    const admittedNotStarted = link !== undefined && child.updatedAt === link.rowUpdatedAtAtAdmission
    const inFlight = child.state === 'prompting' || child.state === 'cancelling' || child.state === 'resuming'
    const status: SessionStatusResult['status'] = link?.dispatchError
      ? 'failed'
      : inFlight || queuedOrRunning || admittedNotStarted
        ? 'in-progress'
        : child.lastTurnOutcome === 'failed'
          ? 'failed'
          : child.lastTurnOutcome === 'done'
            ? 'done'
            : // Idle/closed with no recorded outcome: the row exists but its first turn has not
              // finished (or predates outcome tracking) — treat as still working, never as done.
              'in-progress'
    const replyRequested = link?.replyRequested ?? child.needsParentReply === 1
    return {
      agentId: child.agentId,
      status,
      state: child.state,
      updatedAt: child.updatedAt,
      ...this.childStatusGuidance(status, replyRequested, link?.replyState, link?.dispatchError)
    }
  }

  /**
   * §5.4 cross-daemon leg: ask the CP for the status of a child that lives on ANOTHER daemon.
   * The daemon has no way to address another daemon directly (the relay carries message delivery,
   * not queries), and the CP is the placement authority — so it resolves the owning daemon and
   * forwards the lineage pair there. This is a bounded metadata read: no message bodies, and the
   * CP persists nothing.
   *
   * Distinguishes three outcomes for the caller: a status, `null` (unknown / not your child — one
   * indistinguishable verdict, as locally), or a THROWN error for a transport problem, so the tool
   * says "temporarily unavailable" instead of implying the parent has no such child.
   */
  private async remoteChildStatus(
    childSessionId: string,
    parentSessionId: string,
    childAgentId: string
  ): Promise<SessionStatusResult | null> {
    const client = this.host.cpClient()
    // Degraded mode (§ graceful degradation): established sessions keep running with no CP, but a
    // cross-daemon lookup genuinely cannot be answered — say so rather than deny the lineage.
    if (!client)
      throw new Error(
        'the status of a session on another daemon is unavailable while the control plane is disconnected'
      )
    const parentAgentId = (await this.host.store().getSessionByOutwardId(parentSessionId))?.agentId
    const orgId = parentAgentId ? this.host.cpAgents()?.orgForAgent(parentAgentId) : undefined
    const res = await client.childSessionStatus({ parentSessionId, childSessionId, childAgentId }, orgId)
    if (res.reason === 'offline') {
      throw new Error(`the daemon running ${childSessionId} is not currently reachable — try again shortly`)
    }
    if (!res.found) return null
    const link = this.childSessionLinks.get(childSessionId)
    const fallback = this.childStatusGuidance(res.status ?? 'in-progress', link?.replyRequested ?? false, undefined)
    return {
      sessionId: childSessionId,
      agentId: res.agentId ?? childAgentId,
      status: res.status ?? 'in-progress',
      state: res.state ?? 'starting',
      ...(res.updatedAt !== undefined ? { updatedAt: res.updatedAt } : {}),
      reply: res.reply ?? fallback.reply,
      nextAction: res.nextAction ?? fallback.nextAction,
      message: res.message ?? fallback.message
    }
  }

  /**
   * §5.4 owning-daemon leg: answer a CP-forwarded status probe for a child WE own. This is where
   * the real lineage rule is enforced — exactly the same check as the local path, deliberately
   * duplicated here rather than trusted from the CP: the CP proves the asking daemon owns the
   * claimed parent session, and this proves the child is actually that parent's child.
   *
   * Returns the wire shape. `found:false` covers unknown-session AND not-your-child so a caller
   * cannot probe for sessions it may not read.
   */
  async childSessionStatusProbe(probe: ChildSessionStatusProbe): Promise<ChildSessionStatus> {
    const child = await this.host.store().getSession(probe.childSessionId)
    if (!child) {
      // Pre-row window: we ACKed admission immediately and dispatch is fire-and-forget, so a probe
      // can legitimately arrive before SessionManager creates the row. The admission link recorded
      // at ACK time is the only record — and the only authority — until then.
      const link = this.childSessionLinks.get(probe.childSessionId)
      if (!link || link.parentSessionId !== probe.parentSessionId) return { found: false }
      return {
        found: true,
        agentId: link.agentId,
        status: link.dispatchError ? 'failed' : 'in-progress',
        state: link.dispatchError ? 'idle' : 'starting',
        ...this.childStatusGuidance('in-progress', link.replyRequested, link.replyState, link.dispatchError)
      }
    }
    if (!this.isAuthorizedChildParent(child, probe.parentSessionId)) return { found: false }
    return { found: true, ...this.collapseChildStatus(child, probe.parentSessionId) }
  }

  /**
   * Whether `parentSessionId` is a parent this child may be reported to. A logical child session
   * can be woken by MORE THAN ONE parent over its life, and both are legitimate: the durable
   * first-wins `originSessionId`, and the most recent waker recorded at admission (the one whose
   * `sendMessage` just handed that caller the handle). Accepting only the durable link would deny a
   * second parent the child it just started — the read-side mirror of naming the current waker in
   * the report-back directive.
   */
  private isAuthorizedChildParent(child: SessionRecord, parentSessionId: string): boolean {
    if (child.originSessionId === parentSessionId) return true
    return this.childSessionLinks.get(child.key)?.parentSessionId === parentSessionId
  }

  /** Whether a channel-root post just made forked the conversation of a session this one owes an answer, or its own; backs the wrong-root notice (send-message-guide.md §7.5). */
  async rootPostRelation(req: {
    callerAgentId: string
    platform: string
    callerTransportScope?: string
    callerChannel: string
    callerThread: string
    targetPlatform: string
    targetChannel: string
    targetThread: string
    targetIntegrationId?: string
  }): Promise<{ kind: 'source'; messageId: string } | { kind: 'self' } | undefined> {
    const targetScope = this.host.transportScopeForIntegrationIds(
      req.targetIntegrationId !== undefined ? [req.targetIntegrationId] : undefined
    )
    // Same conversation and a different thread: only then did the post fork it; a continuous DM's post landed in it.
    const isForkOf = (platform: string, channel: string, thread: string, scope?: string | null): boolean =>
      platform === req.targetPlatform &&
      channel === req.targetChannel &&
      thread !== req.targetThread &&
      (scope ?? undefined) === (targetScope ?? undefined)
    const key = sessionKey(
      req.platform,
      req.callerChannel,
      req.callerThread,
      req.callerAgentId,
      req.callerTransportScope
    )
    const store = this.host.store()
    // The message this turn answers, else the oldest one still waiting on a reply; never the session's origin (§9.6).
    const inbound = this.host.activeTurnCallMeta().get(key)
    const current = inbound?.messageId
      ? await store.sessionMessages.received(inbound.messageId).catch(() => undefined)
      : undefined
    const oldestOpen = async () => {
      const first = (await store.sessionMessages.listFor(key, 1).catch(() => []))[0]
      return first?.replyState === 'open' ? first : undefined
    }
    const answered = current?.recipientKey === key ? current : await oldestOpen()
    if (answered) {
      const source = await store.getSessionByOutwardId(answered.sourceSessionId, answered.sourceAgentId || undefined)
      // A local source's row records its transport scope, so its identity is exact.
      if (source && isForkOf(source.platform, source.channel, source.thread, source.transportScope))
        return { kind: 'source', messageId: answered.messageId }
      // A remote source has only its recorded coordinates, which can over-match where one channel id serves two bots.
      if (!source && answered.sourceThread !== undefined) {
        if (answered.sourcePlatform === req.targetPlatform && answered.sourceChannel === req.targetChannel)
          return answered.sourceThread !== req.targetThread
            ? { kind: 'source', messageId: answered.messageId }
            : undefined
      }
    }
    if (isForkOf(req.platform, req.callerChannel, req.callerThread, req.callerTransportScope)) return { kind: 'self' }
    return undefined
  }

  /** session-concept 2a: initialize the session a channel-root post seeds, recording the posting session as its creator and classifying against the post's own conversation; no model turn runs. */
  async spawnChannelRootSession(req: {
    agentId: string
    platform: string
    integrationId?: string
    channel: string
    /** The post's session-thread key, already canonicalized by {@link threadKeyForPost} at the
     *  one seam that converts a platform ts into a thread segment — the same key an inbound
     *  reply to this post resolves to, so the reply meets this session instead of opening a
     *  second one. */
    thread: string
    /** The post's RAW platform ts, which on Telegram differs from `thread`. */
    postTs: string
    /** Whether the DESTINATION is a direct message, as the platform reports it. */
    isDm?: boolean
    text: string
    originPlatform?: string
    originTransportScope?: string
    originChannel: string
    originThread: string
  }): Promise<boolean> {
    const platform = req.platform
    // The origin session may live on a DIFFERENT platform than this post (e.g. a Telegram
    // turn posting to Slack). Key the origin lookup by the ORIGIN's platform, not the target's,
    // or the caller session is never found and the new session loses its parent lineage.
    const originPlatform = req.originPlatform ?? req.platform
    const originKey = sessionKey(
      originPlatform,
      req.originChannel,
      req.originThread,
      req.agentId,
      req.originTransportScope
    )
    const inbound = this.host.activeTurnCallMeta().get(originKey)
    // A self-post from a plain human/platform turn (no active callMeta) starts the self-chain at 1.
    const hopCount = inbound ? inbound.hopCount + 1 : 1
    if (hasReachedAgentCallHopLimit(hopCount)) {
      this.host.log().info(`channel-root session: hop limit reached for agent "${req.agentId}" — not spawning`)
      return false
    }
    const originRec = await this.host.store().getSession(originKey)
    const originSessionId = originRec
      ? await this.host.store().ensureOutwardSessionId(originKey, req.agentId, this.host.clock().now())
      : undefined
    const originCoordPlatform = originPlatform
    const deliveryId = randomUUID()
    const callMeta: CallMeta = {
      callFrom: req.agentId,
      hopCount,
      deliveryId,
      initializeOnly: true,
      // The seed's audience is the conversation the post LANDED in, never the origin's: it is
      // keyed by a thread this post just created there, and inheriting the origin conversation
      // would claim an audience this content was never posted to (§3.3).
      platformOrigin: true,
      ...(originSessionId ? { originSessionId } : {}),
      originCodeHostReplyTarget: codeHostReplySnapshot(
        originRec,
        this.host.activeGateEntries().get(originKey)?.githubReply
      ),
      originCoords: {
        platform: originCoordPlatform,
        channel: req.originChannel,
        ...(req.originThread ? { thread: req.originThread } : {})
      },
      // §5.1: seal the child's capture gate when the waking session is private.
      // Tighten-only — see CallMeta.parentPrivate.
      ...(originSessionId && (await this.host.store().isCaptureExcluded(req.agentId, originKey))
        ? { parentPrivate: true }
        : {})
    }
    const transportScope = this.host.transportScopeForIntegrationIds(
      req.integrationId !== undefined ? [req.integrationId] : undefined
    )
    const normalized: NormalizedMessage = {
      msgId: `agentcall:${req.channel}:${deliveryId}`,
      traceId: deliveryId,
      source: 'agent',
      platform,
      channel: req.channel,
      thread: req.thread,
      ...(transportScope !== undefined ? { transportScope } : {}),
      // The seed's transcript ts MUST be the post's real ts (the new thread's root), not the
      // random deliveryId — otherwise the session's lastDeliveredTs becomes a non-ts string and
      // a later real reply in this thread is mis-compared and wrongly skipped as already-delivered.
      // On Telegram that raw ts is NOT the thread key, hence the separate field.
      transcriptTs: req.postTs,
      sender: { id: req.agentId, isBot: true },
      text: req.text,
      mentionedBots: [],
      // Load-bearing for classification, not cosmetic: the audience strategy asks whether the
      // DESTINATION is a DM, and a Slack DM binds no conversation audience (§7.4).
      isDm: req.isDm === true,
      // No model turn runs for this seed; headless is retained as a transport backstop.
      headless: true
    }
    const targetSession = sessionKey(platform, req.channel, req.thread, req.agentId, transportScope)
    void this.host
      .dispatch(req.agentId, normalized, req.integrationId, undefined, callMeta)
      .catch((err) =>
        this.host.log().error(`channel-root session spawn failed for agent "${req.agentId}": ${formatErr(err)}`)
      )
    this.host
      .log()
      .info(
        `channel-root session: "${req.agentId}" initialized new session ${targetSession} (origin ${originSessionId ?? 'none'}, hop ${hopCount})`
      )
    return true
  }

  /**
   * Route a cross-daemon `messageAgent` over the relay data plane (agent-collaboration
   * §2.3/§6.2/§6.4, P2) and map the relay's typed admission verdict to a
   * {@link MessageAgentResult}. The `claimedFromAgentId` is our trusted caller — the
   * relay re-validates it against our authenticated daemonId (a forged claim is
   * rejected there). `sourceHopCount` is the trusted source turn's depth; the relay
   * increments it (+1, capped at MAX_AGENT_CALL_HOPS). The body never touches the CP —
   * only the relay.
   */
  private async routeAgentMsgCrossDaemon(
    req: MessageAgentReq,
    ctx: {
      platform: Exclude<NormalizedMessage['platform'], 'hook'>
      channel: string
      thread?: string
      deliveryId: string
      targetSession: string
      sourceHopCount: number
      /** §5.3: the caller's origin session, forwarded so the remote child can reply back — its
       *  OUTWARD id (§1.1), since it travels to another daemon. */
      originSessionId?: string
      originCodeHostReplyTarget?: CodeHostReplyTarget | null
      codeHostReplyTarget?: CodeHostReplyTarget | null
      /** The same session's logical key, for the gates this daemon keys by it. */
      originSessionKey?: string
      originCoords?: CallMeta['originCoords']
      externalOrigin?: CallMeta['externalOrigin']
      /** §5.3 lineage reply: the EXISTING target session this delivery replies into, by its
       *  outward id — the target dispatches into it instead of coordinate keying. */
      lineageReplyTo?: string
      /** send-message-routing-rework.md §8.3. Marks the delivery as a parent-session reply
       *  so the target dispatches it into `lineageReplyTo` instead of coordinate keying.
       *  The relay still refuses to forward this kind to a daemon that has not advertised
       *  `headless-agent-delivery-v1`; that gate is now a LEGACY fence — the resumed parent
       *  runs an ordinary turn on every current daemon (§7). Absent ⇒ `wake`, an ordinary
       *  postless call. */
      deliveryKind?: RdAgentMsgDeliveryKind
      /** send-message-guide.md §9.2: a `session-call`'s target session and the calling turn's people. */
      targetSessionId?: string
      callerAskers?: AgentCallAskers
      /** send-message-guide.md §9.3–§9.4: the session message's id and kind, and for a reply the message it answers. */
      messageId?: string
      messageKind?: SessionMessageKind
      inReplyTo?: string
    }
  ): Promise<MessageAgentResult> {
    const relays = this.host.relays()
    if (!relays) {
      return { delivered: false, targetSession: ctx.targetSession, reason: 'not_local' }
    }
    try {
      // #987: `not_ready` re-sends the SAME deliveryId for a bounded window; only a terminal verdict is recorded below.
      const ack = await sendAgentMsgUntilReady(
        {
          claimedFromAgentId: req.callerAgentId,
          // Tighten-only privacy hint for the remote child's capture gate (§5.1). The gate is
          // keyed by the runtime's id, so read it from the caller's own slot — `originSessionId`
          // is the lineage id, which is outward (§1.1).
          ...(ctx.originSessionId !== undefined &&
          ctx.originSessionKey !== undefined &&
          (await this.host.store().isCaptureExcluded(req.callerAgentId, ctx.originSessionKey))
            ? { parentPrivate: true }
            : {}),
          toAgentId: req.toAgentId,
          text: req.text,
          coords: {
            platform: ctx.platform,
            channel: ctx.channel,
            ...(ctx.thread !== undefined ? { thread: ctx.thread } : {})
          },
          hopCount: ctx.sourceHopCount,
          deliveryId: ctx.deliveryId,
          // Visible-post ts (if this wake was a `toAgent`+`channel` send) so the remote target
          // dedups the wake against the post it fetches from the shared thread and keeps a
          // canonical read cursor — same guarantee as the same-daemon path.
          ...(req.transcriptTs !== undefined ? { transcriptTs: req.transcriptTs } : {}),
          ...(ctx.originSessionId !== undefined ? { originSessionId: ctx.originSessionId } : {}),
          ...(ctx.originCodeHostReplyTarget !== undefined
            ? { originCodeHostReplyTarget: ctx.originCodeHostReplyTarget }
            : {}),
          ...(ctx.codeHostReplyTarget !== undefined ? { codeHostReplyTarget: ctx.codeHostReplyTarget } : {}),
          ...(ctx.originCoords !== undefined ? { originCoords: ctx.originCoords } : {}),
          ...(ctx.externalOrigin !== undefined ? { externalOrigin: ctx.externalOrigin } : {}),
          ...(ctx.lineageReplyTo !== undefined ? { lineageReplyTo: ctx.lineageReplyTo } : {}),
          // §5.4: ask the remote child to report its outcome back into our origin session. Gated on
          // having an origin for exactly the reason the local path is — there is nothing to report to
          // without one, and the target ignores it in that case anyway.
          ...(req.needsReply === true && ctx.originSessionId !== undefined ? { needsReply: true } : {}),
          ...(ctx.deliveryKind !== undefined ? { deliveryKind: ctx.deliveryKind } : {}),
          ...(ctx.targetSessionId !== undefined ? { targetSessionId: ctx.targetSessionId } : {}),
          ...(ctx.callerAskers !== undefined ? { callerAskers: ctx.callerAskers } : {}),
          ...(ctx.messageId !== undefined ? { messageId: ctx.messageId } : {}),
          ...(ctx.messageKind !== undefined ? { messageKind: ctx.messageKind } : {}),
          ...(ctx.inReplyTo !== undefined ? { inReplyTo: ctx.inReplyTo } : {})
        },
        {
          send: (payload) => relays.sendAgentMsg(payload),
          clock: this.host.clock(),
          onRetry: (attempt, delayMs) =>
            this.host
              .log()
              .info(
                `messageAgent: ${req.toAgentId} not routable yet (attempt ${attempt}) — retrying delivery ${ctx.deliveryId} in ${delayMs}ms`
              )
        }
      )
      // §5.4: prefer the CANONICAL key the target computed — its transport scope depends on the
      // reply integration the relay chose, which we cannot derive. Fall back to our own guess only
      // for an older target daemon that returns none (it then simply won't be followable).
      if (ack.delivered) return { delivered: true, targetSession: ack.childSessionId ?? ctx.targetSession }
      return { delivered: false, targetSession: ctx.targetSession, ...(ack.reason ? { reason: ack.reason } : {}) }
    } catch (err) {
      // No READY relay / forward failed → undeliverable (offline). Retransmit is a follow-up.
      this.host.log().warn(`messageAgent: cross-daemon route failed for ${req.toAgentId}: ${formatErr(err)}`)
      return { delivered: false, targetSession: ctx.targetSession, reason: 'offline' }
    }
  }
}
