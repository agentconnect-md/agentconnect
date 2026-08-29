import type { DutyGrantEntry, EventSession, ExternalSessionAudience, SessionKey } from '@agentconnect.md/protocol'
import type { AcpHost } from '../acp/acp-host.js'
import type { LoadedAgent } from '../agents/load-agents.js'
import type { TurnPlan } from './turn-plan.js'
import type { TurnEvaluationReporter } from './turn-evaluation.js'
import type { KeyGrant } from '../key-server/client.js'
import type { NormalizedMessage } from '../messages/normalized.js'
import type { ApprovalWait } from '../permissions/coordinator.js'
import type { GithubTurnState } from '../platforms/github/turn-output.js'
import type { ModelProviderTarget } from '../runtimes/model-provider-config.js'
import type { TranscriptRecorder } from '../session/transcript-recorder.js'
import type { TerminalOutputFolder } from '../session/terminal-output-folder.js'
import type { OutputConverger, SlackAction } from '../slack/render.js'
import type { TelegramAction, TelegramConverger } from '../telegram/render.js'
import type { DiscordAction, DiscordConverger } from '../discord/render.js'
import type { FeishuAction, FeishuConverger } from '../feishu/render.js'
import type { SlackConnection } from '../slack/connection.js'
import type { TelegramConnection } from '../telegram/connection.js'
import type { DiscordConnection } from '../discord/connection.js'
import type { FeishuConnection } from '../feishu/connection.js'
import type { GithubReplyTarget, HookDispatchContext } from '../github/hook-coords.js'
import type { WebchatTurnContext } from '../webchat/types.js'

/** Thrown to a `dispatch()` caller when the per-session admission queue is at its depth
 *  cap (§4.4 backpressure): the message is fast-failed, not buffered. Carries a stable
 *  `reason` so an agent-call source (P1/P2) can surface a typed `queue_full`. */
export class QueueFullError extends Error {
  readonly reason = 'queue_full' as const
  constructor(sessionKey: string) {
    super(`admission queue full for session ${sessionKey}`)
    this.name = 'QueueFullError'
  }
}

/** Thrown to the `dispatch()` callers of the messages still queued behind a turn that
 *  FAILED (§6.9 #378 fail-stop): the daemon does not auto-run buffered work onto a broken
 *  session, so each follow-up is rejected rather than silently dropped or force-run. */
export class FailStopError extends Error {
  readonly reason = 'fail_stop' as const
  constructor(sessionKey: string) {
    super(`turn failed for session ${sessionKey}; queued messages were not auto-run`)
    this.name = 'FailStopError'
  }
}

/** Internal fail-closed outcome for a turn whose process cleanup rejected. The raw
 * cleanup rejection is logged once at the lifecycle boundary; this stable sentinel
 * lets the serial gate fail-stop and release its dispatch lease without reporting the
 * same rejection again through transport fire-and-forget handlers. */
export class LifecycleCleanupBlockedError extends Error {
  readonly reason = 'lifecycle_cleanup_blocked' as const
  constructor(sessionKey: string, cause: unknown) {
    super(`lifecycle cleanup blocked for session ${sessionKey}`, { cause })
    this.name = 'LifecycleCleanupBlockedError'
  }
}

/** ACP session ids are scoped to one agent runtime, not globally unique. */
export function pendingTurnKey(agentId: string, acpSessionId: string): string {
  return JSON.stringify([agentId, acpSessionId])
}

/** Background-task leases are per (agent, ACP session) for the same reason turns are: two
 *  agents can each expose an `acp-1`. Sharing one entry would let one agent's live task
 *  suppress the other's completion wake, or overwrite its task record under a colliding id. */
export function sdkLeaseKey(agentId: string, acpSessionId: string): string {
  return pendingTurnKey(agentId, acpSessionId)
}

/** One LIVE background task — a member of the lease's liveness set. `startedAt` is when the
 *  `task_started` edge arrived, which is the only start time the feed offers. */
export interface LiveSdkTask {
  description?: string
  isSubagent: boolean
  startedAt: number
}

/** One SETTLED background task, retained for the console's `task/list` read. Display history and
 *  nothing else: it lives in the lease's `settled` array, never in `tasks`, so no reclaim
 *  decision can see it. `status` is the terminal status a runtime edge reported, when any. */
export interface SettledSdkTask extends LiveSdkTask {
  id: string
  endedAt: number
  status?: string
}

/**
 * DAEMON-PRIVATE trusted metadata for an agent-originated delivery. Authoritative
 * (never derived from model output or platform text): the caller identity the target can
 * trust, the correlationId to bounce back, and the hop/origin chain for loop protection.
 * Most deliveries run a turn whose nested `messageAgent` reads this to auto-increment
 * hopCount (§2.4); a self-authored channel root instead carries `initializeOnly`.
 */
export interface CallMeta {
  /** Trusted caller agentId (the agent that invoked `messageAgent`). */
  callFrom: string
  /** Opaque correlation id supplied by the caller (orchestration), if any. */
  correlationId?: string
  /** Depth of this agent-call chain; inbound platform/user turns are 0. */
  hopCount: number
  /** Stable id of the delivery that started this turn (== the msgId's ts segment). */
  deliveryId: string
  /**
   * send-message-routing-rework.md §8.6: the activation rendezvous key this delivery was
   * claimed under, when it has one.
   *
   * It rides on CallMeta specifically because CallMeta is PERSISTED with the durable inbox
   * row and restored on replay. That is what closes the crash window: a turn that crashed
   * after its inbox row landed is re-dispatched at startup carrying this key, so the
   * SAME central admission below completes the rendezvous — no separate replay hook, and
   * no dependence on the inbox row still existing by the time the sweep runs.
   */
  activationKey?: string
  /**
   * This delivery was OBSERVED on the platform, in the very conversation it targets — an
   * agent's ordinary reply or channel-root mention — rather than being a postless
   * `toAgent` call.
   *
   * It decides whether the woken turn may bind the conversation's external audience.
   * A postless child must not: its coordinates are derived from the caller's session and
   * the model influences the target, so binding one would let model input claim a shared
   * conversation. A platform-observed delivery has the OPPOSITE property — its channel
   * and thread come from the provider event itself, exactly like a human message in that
   * thread — so it must bind, or it can never wake an agent that already holds an
   * externally-bound session there, which is every agent already talking in the thread.
   *
   * A channel-ROOT self-post seed carries it for the same reason: the post landed, so its
   * channel and thread are the provider's own coordinates for a thread that did not exist
   * before — there is no shared conversation to claim, and the alternative (inheriting the
   * origin session's audience) binds the seed to a channel it does not live in.
   *
   * Persisted with the inbox row alongside the rest of CallMeta, so a replayed turn makes
   * the same classification it would have made live.
   */
  platformOrigin?: true
  /**
   * webchat-multi-agents.md §5.2a (#549 parity): this delivery is a conversation-roster
   * CONTINUATION — a peer participant's committed post fanned to this agent — not a
   * direct `sendMessage` call. It keeps the full trusted call chain (hop budget,
   * exactly-once rendezvous, caller identity) but must NOT assert "this activation is
   * addressed to you": the standing response-choice contract decides whether the woken
   * agent answers, exactly as it does for the user-targeted roster fan-out. Persisted
   * with the inbox row like the rest of CallMeta.
   */
  conversationContinuation?: true
  /** A self-authored channel-root post initializes its new session but is not a model turn.
   *  Persisted with the inbox row so crash replay cannot accidentally activate the model. */
  initializeOnly?: boolean
  /** session-concept §5.3: the WAKING (parent/origin) session's stable acpSessionId. This
   *  is the value surfaced to the child as its `Parent session` (§2.3) and the SessionTarget
   *  the child replies into via `sendMessage`. Absent on root turns (human-initiated) and the
   *  self-introduce fan-out — those have no parent, so the child gets no `Parent session` line
   *  and cannot address a SessionTarget. */
  originSessionId?: string
  /** session-concept §5.3: the origin session's landing coords. Used to route a SessionTarget
   *  reply back when the origin session lives on ANOTHER daemon (the relay has no
   *  sessionId→daemon registry, so a cross-daemon reply routes by these coords + `callFrom`).
   *  Set alongside `originSessionId`. */
  originCoords?: { platform: Exclude<NormalizedMessage['platform'], 'hook'>; channel: string; thread?: string }
  /** Immutable external source inherited from the waking Session. This is
   * daemon-authored metadata and never comes from model text. The credential
   * locator stays at the direct ingress; descendants inherit only the stable
   * provider/realm/resource tuple. */
  externalOrigin?: ExternalSessionAudience
  /** Daemon-internal (issue #536, never a tool input): when this turn calls
   *  `messageAgent`, deliver the woken peer's turn HEADLESS so it records silently
   *  with no channel output. Set only by the self-introduce-on-join fan-out; does
   *  NOT cascade (the peer's own callMeta doesn't carry it). */
  deliverHeadless?: boolean
  /** Daemon-internal (issue #536, never a tool input): the channel this turn exists to
   *  introduce the agent into. It HARD-BOUNDS peer discovery for the turn — the
   *  `channelAgents` dep forces this channel as the directory filter even when the model
   *  omits (or widens, or redirects) the tool's `channel` argument. Without a code-level
   *  bound the org-wide default would fan one channel join out to every agent in the org;
   *  `MAX_AGENT_CALL_HOPS` bounds depth and `INTRO_MAX_BURST` bounds channels per snapshot,
   *  but neither bounds PEERS per intro. The prompt asks for the same filter (belt and
   *  braces); this is what makes it true regardless of model compliance. Set only by the
   *  self-introduce-on-join dispatch and, like `deliverHeadless`, does NOT cascade. */
  introChannel?: string
  /** session-concept §5.3: the waking parent asked this session to report back when it is done
   *  or has failed (`sendMessage`'s `toAgent.needsReply`). Handed to prompt assembly, which turns
   *  it into a standing directive on the child naming `originSessionId` as the reply target.
   *  Like `deliverHeadless` it does NOT cascade — a grandchild is only obliged if its own parent
   *  asks. Absent ⇒ an ordinary fire-and-forget wake. */
  needsReply?: boolean
  /** session-visibility.md §5.1: the WAKING session is private, so this child's
   *  transcript holds prompt text copied out of it and must not feed shared agent
   *  memory. Strictly ONE-DIRECTIONAL — it can only tighten. A `false`/absent
   *  value never opens capture: an A2A child always starts excluded, and only a
   *  CP-confirmed `org` state (which the CP derives from the post-cascade parent)
   *  may open it. That is what makes a stale hint in flight during a §4.3
   *  tightening harmless. */
  parentPrivate?: boolean
}

/** `handover` is the infrastructure class — this daemon stopped serving the agent, which is the
 *  duty teardown alone (`stopServingAgentSettled`: revoke, self-fence, registry shrink, shutdown
 *  release) and NOT the drain paths, which keep their own reasons. Deliberately not `stop`: a user
 *  stop is a verdict about the work, a handover says nothing about it, and outcome reporting has
 *  to tell them apart. */
export type TurnInterruptReason =
  'pause' | 'loop protection' | 'stop' | 'cancel' | 'shutdown' | 'superseded' | 'handover'

/** What an interrupt means for the agent's admitted-but-unrun durable rows. `terminal` ends that
 *  work here (pause, removal, host respawn); `handoff` leaves the rows for the successor holder to
 *  replay (#1050). Orthogonal to `reason`: a removal and a host respawn are both terminal `stop`. */
export type TurnInterruptDisposition = 'terminal' | 'handoff'

/**
 * One admitted message waiting in (or entering) the per-sessionKey serial gate (design
 * §4.3/§6.9). Carries the FULL DispatchContext so a queued turn dispatches identically to
 * one that ran immediately — same reply transport (`integrationId`), same webchat sink,
 * same trusted `callMeta` — and settles its OWN `dispatch()` promise (§6.9 #367). The gate
 * is keyed by the LOGICAL sessionKey (platform:channel:thread:agentId[:transportScope]), NOT the ACP
 * sessionId, so a cold session (no ACP id yet) is serialized too.
 */
export interface SelectedTurnHost {
  host: AcpHost
  /** Full lifecycle cleanup for the exact process selected for this turn. */
  stop: (deadlineMs?: number) => Promise<void>
  /** The exact stop operation once lifecycle cleanup has begun, or an already
   * settled promise while the selected process has not been asked to stop. */
  waitForCleanup: () => Promise<void>
}

export interface ModelSessionHost {
  agentId: string
  sessionKey: string
  target: ModelProviderTarget
  grant: KeyGrant
  host?: AcpHost
  /** In-progress start, joined by release so a host born after teardown is still stopped. */
  starting?: Promise<AcpHost>
  stopping?: Promise<void>
  released?: boolean
}

export type TurnLifecycleCleanupOutcome = { blocked: false } | { blocked: true; error: unknown }

export interface QueueEntry {
  agentId: string
  msg: NormalizedMessage
  /** Cancels the entire cold SessionManager initialization path after the bounded
   *  host-stop backstop, including non-host awaits such as workspace/history I/O. */
  initAbort: AbortController
  integrationId?: string
  webchat?: WebchatTurnContext
  callMeta?: CallMeta
  hookContext?: HookDispatchContext
  /** Best-effort lifecycle notification after ACP session initialization but
   *  before prompting. Used by trigger sources that expose a live deep-link. */
  onSessionReady?: (sessionId: string) => void
  /** True when this entry was buffered via the user `!queue` command (ACK wording only —
   *  it is one and the same admission queue as ordinary inbound, per §6.9 #390). */
  isQueueCmd?: boolean
  /** Settles the `dispatch()` promise for THIS message: resolve with its ACP sessionId
   *  (or null when a gate skipped it), reject with its own turn error. */
  resolve: (sessionId: string | null) => void
  reject: (err: unknown) => void
  /** §6.9 #353 durable inbox: the stable id (deliveryId/msgId) of the row persisted for
   *  this entry BEFORE its admission ACK, or undefined when nothing was persisted (webchat
   *  turns, or a replayed entry re-admitted from an already-present row). Set once on
   *  admission and used to delete the row on every terminal path. */
  inboxId?: string
  /** P3 outbound: publish the turn's completed reply on this GitHub thread. Hook
   * deliveries duplicate this reference in their durable HookDispatchContext so
   * restart replay can recreate the poster behind its publish-state fence. */
  githubReply?: GithubReplyTarget
  /** Selected before session/new|load so cancellation uses the exact host. */
  selectedHost?: SelectedTurnHost
  /** Session initialization must await cleanup before releasing ownership. */
  lifecycleCleanup?: Promise<void>
  /** Permanent fail-closed latch after lifecycle cleanup rejects. The serial
   * dispatch lease may terminate, but admission must remain fenced until restart. */
  lifecycleCleanupBlocked?: Promise<never>
  /** Deduplicates cleanup-failure observability across error, backstop, and final
   * cleanup observers of the same admitted turn. */
  lifecycleCleanupFailureLogged?: boolean
  /** Latched cancellation for an already-admitted head. Unlike reading the current
   *  pause/loop state, this survives a quick pause→unpause or trip→!resume race while
   *  a cold sessions.handle() call is still initializing. */
  cancelledReason?: TurnInterruptReason
  /** A newer turn took this conversation's Slack status slot over: teardown leaves it alone. */
  displacedByNewerTurn?: boolean
  /** Settles when dispatch() finishes this placed entry's admission bookkeeping: 'run' to
   *  start it, 'drop' when a late rejection withdrew it. The runner awaits this before
   *  starting a shifted entry, so a rejected caller's turn can never already be running. */
  admissionHold?: Promise<'run' | 'drop'>
  /** Cross-session GitHub coordination must settle before this durable entry can start. */
  coordinationWait?: Promise<void>
  /** An admitted continuation waits for its platform mirror; false skips only this entry. */
  admissionWait?: Promise<boolean>
  /** Record chat observation only after admissionWait succeeds. */
  deferObservedInbound?: boolean
  posterPublishState?: 'not_started' | 'in_flight' | 'settled'
  /** The live inbox row was redacted into a durable terminal HookReport
   * receipt; removeInbox must retain it for restart-safe redelivery dedup. */
  hookTerminalReceipt?: boolean
  /** A duty handoff released this row to the successor holder instead of ending it, so the
   *  entry's later terminal settle must not delete it either (#1050). */
  inboxHandedOff?: boolean
}

/** The platform transport a turn's ordinary output posts through. */
export type ReplyConnection = SlackConnection | TelegramConnection | DiscordConnection | FeishuConnection

/** What `SessionManager.handle()` hands back to a dispatched turn. */
export interface HandledTurnSession {
  sessionId: string
  blocks: import('@agentclientprotocol/sdk').ContentBlock[]
  created: boolean
  skipped?: boolean
  captureInput?: string
  turnId?: string
  initializedOnly?: boolean
  contextRevision?: number
  contextEvents?: { ts: string; text?: string }[]
  providerCheckpoint?: string
  additionalMcpServersAttached?: boolean
}

/** The handles every `dispatchOne` phase shares: the entry being run, the pure plan for it,
 *  the agent snapshot the turn was planned against, and the reporters bound before host work. */
export interface TurnRun {
  readonly entry: QueueEntry
  /** Logical session key. */
  readonly key: string
  readonly plan: TurnPlan
  readonly agent: LoadedAgent
  readonly replyConn: ReplyConnection | undefined
  readonly evaluation: TurnEvaluationReporter
}

/** A turn whose answer may be committed: the prompt loop settled on one accepted generation. */
export interface AnsweredTurn {
  kind: 'answered'
  stopReason: Awaited<ReturnType<AcpHost['prompt']>>['stopReason']
  usage: Awaited<ReturnType<AcpHost['prompt']>>['usage']
  /** The recall query the accepted generation was actually prompted with. */
  finalCaptureInput: string
}

/** `cancelled` covers every prompt-loop exit that commits no answer (operator interrupt,
 *  context churn). The caller re-issues its own `return null` so settlement still runs. */
export type TurnPromptOutcome = AnsweredTurn | { kind: 'cancelled' }

/** The two try-scoped facts `dispatchOne`'s phases hand to its settlement. `finalPhase`
 *  becomes the session outcome + CP snapshot phase; `propagatingTurnError` keeps a genuine
 *  prompt failure the outward error even when cleanup also fails. */
export interface TurnSettlement {
  finalPhase: EventSession['phase']
  propagatingTurnError: boolean
}

/** Where in the cold-session window a fence sits. The site name is also the log label, and it
 *  selects which unwind steps the call point owns — see `Daemon.coldSessionFence`. */
export type ColdFenceSite = 'admitted' | 'initialized' | 'ready'

/** The per-turn handles a cold fence needs to unwind its call point's state. Which fields are
 *  read depends on the site: `admitted` runs before any host work and uses only the reporter. */
export interface ColdFenceContext {
  finishEvaluation: (type: 'turn.cancelled', data: Record<string, unknown>) => void
  /** Clear the transient platform activity indicator. Unused at `admitted` — none is showing yet. */
  clearActivity?: () => void
  /** Release the reply-connection lease. Only `initialized` owns it; `ready` leaves it to the outer finally. */
  releaseReplyConn?: () => void
  /** Undo the delivery-binding install done before session/new|load. */
  restoreDeliveryBinding?: () => void
  /** The ACP session id, once known. `ready` reports it in the hook payload. */
  sessionId?: string
  /** sessions.handle() created this ACP session on this very turn. */
  created?: boolean
}

export interface MemoryExtractionCollector {
  chunks: string[]
  sessionKey?: string
  runtimeCostReported?: boolean
  /** Dream sessions expose the same original reasoning/tool activity as ordinary
   *  sessions. Background distillation has no transcript and leaves this unset. */
  transcript?: { channel: string; thread: string; recorder: TranscriptRecorder }
}

/** The union of every platform's renderer action, and of every platform's
 *  converger. Each surface narrows to its own arm; the unions exist because the
 *  turn record is still core-owned (they dissolve when the convergers move with
 *  their platforms). */
export type DaemonRenderAction = SlackAction | TelegramAction | DiscordAction | FeishuAction
export type DaemonConverger = OutputConverger | TelegramConverger | DiscordConverger | FeishuConverger

/**
 * §7.3 per-turn platform state. Each shape is owned by exactly one turn-output
 * surface and reached only through {@link turnState} from that surface's
 * applier — core stores the slot and never looks inside. These used to be
 * platform-named fields on the turn record itself, which is precisely the
 * accretion the opaque slot exists to stop.
 */
/** Read a turn's opaque platform state as the owning surface's shape. Only that
 *  surface's applier (and the platform-scoped timers it arms) calls this.
 *
 *  The slot materializes on first read: a turn whose surface seeded nothing — or
 *  whose record was built directly, as isolated applier tests do — simply starts
 *  with empty platform state, which is what "no state yet" means. Seeding is an
 *  optimization for platforms that HAVE an initial value (Telegram's reply
 *  anchor), never a precondition for reading. */
export function turnState<S extends object>(p: Pending): S {
  return (p.turnState ??= {} as S) as S
}

/** The in-place platform chrome anchors a turn edits rather than re-posts. Each `*Ts` is the
 *  message id of a single row, and its `*Attempted` sibling records that the first post was
 *  tried so a failed post cannot spam a duplicate on the next action. */
export interface TurnChromeCursors {
  /** ts of the single in-place "main progress" message, once posted (medium/high). */
  progressTs?: string
  /** Whether the progress message's first post was attempted. */
  progressAttempted?: boolean
  /** ts of the single in-place plan-summary message, once posted (medium/high). */
  planTs?: string
  planAttempted?: boolean
  /** ts of the single in-place reasoning "context block" message, once posted (high). */
  reasoningTs?: string
  reasoningAttempted?: boolean
  /** ts of the single in-place agent reply message (minimal mode's `live-reply`), once posted. */
  liveReplyTs?: string
  liveReplyAttempted?: boolean
  /** Text last written to the live-reply message — skip a chat.update when unchanged. */
  liveReplyText?: string
  /** Set after an interactive card that needs a human answer (permission / elicitation) is
   *  posted: the current live reply is now ABOVE that card, so the NEXT live-reply action
   *  starts a FRESH reply BELOW the card (leaving the old one frozen above) instead of
   *  editing the one above in place. Consumed lazily by the next live-reply so an empty tail
   *  keeps the old message (and its settled footer). */
  liveReplyReanchor?: boolean
  /** ts of the session's interactive status-bar message, once known. Persisted in the
   *  session row so later turns update the first line instead of posting duplicates. */
  statusBarTs?: string
  statusBarAttempted?: boolean
  /** Dedup key for the last status snapshot emitted this turn, so a `usage_update` that
   *  changes nothing observable skips a redundant edit. */
  lastStatusBar?: string
}

/** What one turn has said so far: the raw stream, the generation-local attempt held behind
 *  the context fence, and the pointers to what is actually posted. */
export interface ReplyAccumulator {
  /** Complete raw assistant text, used only as input to opt-in memory distillation. */
  text: string
  /** IM answer text staged since the last committed segment boundary; the final
   *  context fence commits the closing segment (the only regenerable one). */
  attemptText: string
  /** Answer-bearing ACP updates withheld from the platform converger until their
   *  segment commits — at a tool/thought/plan boundary, or at the final fence. */
  attemptAnswerUpdates: any[]
  /** Current successfully-delivered agent reply message. `footerKey` records which footer
   *  it owns; progress/tool/reasoning chrome never replaces this pointer. */
  lastReply?: { ts: string; text: string; footerKey?: string }
  /** The LAST agent-authored conversational message posted this turn, with the exact
   *  text it currently shows — the message turn finalization re-stamps as
   *  `delivery_state: 'final'` (§5.5). The text is carried because chat.update REPLACES
   *  content, so closing the response means re-sending what is already displayed.
   *  Undefined when the turn posted no conversational body (chrome-only, `none` mode, or
   *  a headless turn): there is then no response event to close. */
  lastResponse?: { ts: string; text: string }
  /** send-message-routing-rework.md §5.1: the id of the ONE complete logical response
   *  this turn produces. Every physical message of a long answer carries it, so a peer
   *  deduplicates on (responseId, target agent) and activates exactly once even when the
   *  answer was split across several Slack messages. Minted per turn, never per post. */
  responseId: string
  /** Routing facts of the COMPLETE response, resolved at final flush (§5.5): recipients,
   *  the addressed-anyone bit, whether any peer agent shares this conversation, and
   *  whether one of them posts as the SAME bot (their ingress admits only the closing
   *  edit past its self-echo filter, so those conversations keep the re-stamp). Unset
   *  until then — and left unset without an org/snapshot, which makes the closure fall
   *  back to the unconditional re-stamp. */
  finalRouting?: {
    mentionedAgentIds: string[]
    addressedAnyone: boolean
    hasPeers: boolean
    peerSharesBot: boolean
  }
  /** ts of the body message born `delivery_state: 'final'` — a terminal section posted at
   *  finalization with the closing metadata already aboard, so `closeResponse` skips its
   *  content-identical edit (which would mark the visible reply "(edited)"). */
  finalStamped?: string
}

/** The turn's completion machinery: what settles it, what defers it, and the once-only
 *  latches that keep its terminal reporting from firing twice. */
export interface TurnSignals {
  /** Resolves when this turn leaves `pending` (success or failure) — drain awaits it. */
  done: Promise<void>
  /** Settles `done`; called once from dispatch's finally. */
  resolveDone: () => void
  /** Pending idle-flush timer (§9.1). */
  idleTimer?: NodeJS.Timeout
  /** Serializes applyAction so in-place edits don't race on the chrome cursors. */
  applyChain: Promise<void>
  /** True once the normal turn-end usage/report has been emitted. */
  usageReportSent: boolean
  /** Whether this turn received an ACP-native cost. When true, it wins and the
   *  public-pricing fallback must not add another amount for the same turn. */
  runtimeCostReported: boolean
}

/** Per-in-flight-turn rendering state, keyed by ACP sessionId in `this.pending`.
 *
 *  Everything a turn DECIDED before it ran lives on the readonly `plan` and is read
 *  through it; the mutable rest is grouped by who writes it — platform chrome cursors,
 *  reply accumulation, the approval-wait meter (permissions/), and completion signals. */
export interface Pending {
  /** The pure decisions this turn was planned with — its identity, coordinates, output
   *  mode, and surface. Readonly by construction: nothing here is turn state. */
  readonly plan: TurnPlan
  chrome: TurnChromeCursors
  reply: ReplyAccumulator
  /** Explicit human-approval wait meter (permissions/coordinator owns every write). */
  approval: ApprovalWait
  signals: TurnSignals
  /** Admitted-turn lifecycle owner. Backstops and finalization share its cleanup
   * failure latch so one rejected stop cannot be logged or fenced twice. */
  entry: QueueEntry
  // Platform-tagged converger: OutputConverger emits SlackAction[] (slack/webchat),
  // TelegramConverger emits TelegramAction[]. enqueueApply routes by `platform`.
  conv: OutputConverger | TelegramConverger | DiscordConverger | FeishuConverger
  /** Captures the full activity log (tool/reasoning) from the raw ACP stream,
   *  independent of output mode. Text/result rows are recorded at send time. */
  rec: TranscriptRecorder
  /** Folds codex-acp's out-of-band `_meta.terminal_output*` stream back into the owning tool
   *  call at ingress, so every consumer sees the command's real output. */
  termOut: TerminalOutputFolder
  /** Tool-call ids structurally identified as this daemon's own MCP tools. Approval
   *  requests may carry only this opaque id, regardless of which ACP path is used. */
  builtinSystemToolCallIds: Set<string>
  /** Tool-call ids for the internal Codex title fallback. Its MCP call updates the
   *  session metadata, but housekeeping must not appear in platform/webchat output
   *  or the persisted user-visible activity log. */
  hiddenSessionTitleToolCallIds: Set<string>
  /** The live ACP session id for this turn (part of the `this.pending` map key). */
  acpSessionId: string
  /** The same session's OUTWARD id (session-concept.md §1.1) — what the console knows it by, so
   *  every deep link and status payload this turn produces addresses a row the CP actually has.
   *  Stamped once here because most of those producers are synchronous. */
  outwardSessionId: string
  /** The exact host selected for this turn, including its full cleanup boundary. */
  selectedHost?: SelectedTurnHost
  /** Once an operator pause or loop trip targets this turn, no subsequent ACP update
   *  or queued renderer action may publish output, even if the gate is later reset. */
  outputSuppressed?: TurnInterruptReason
  /** P3 outbound: the final-answer selector + completed comment on the triggering
   *  GitHub issue/PR. Commentary stays transcript-local; final is awaited at turn end.
   *  For a headless hook, explicit final chunks are withheld from OutputConverger and
   *  persisted once from the collector so transport flushes cannot split one answer. */
  github?: GithubTurnState
  conn?: SlackConnection | TelegramConnection | DiscordConnection | FeishuConnection
  /** §7.3 OPAQUE per-turn platform state, seeded by this turn's output surface and
   *  read only by that surface (see {@link turnState}). Core carries the slot and
   *  never inspects it — the reason platform-shaped fields stopped accreting here. */
  turnState?: unknown
  /** Linked footer prepared before the runtime starts streaming. Every reply section is
   *  initially posted with these trailing blocks so Slack can suppress unfurls. */
  attribution?: { blocks: unknown[]; key: string }
  /**
   * DAEMON-PRIVATE trusted call metadata for an agent→agent turn (design §3.3a/§6.6/§6.7).
   * Present iff this turn was started by `messageAgent`. Holds the AUTHORITATIVE caller
   * identity, correlationId, hop/origin, and stable deliveryId — kept OUT of the
   * model-visible prompt (that only ever sees `msg.text`); it is the trust basis for a
   * future auto-hop/auto-correlation of a nested `messageAgent` (§2.4). Keyed here by the
   * turn's Pending so a tool call within this turn can read it.
   * TODO(P4): move into the unified sessionKey QueueEntry/DispatchContext (§6.9 #367).
   */
  callMeta?: CallMeta
  /**
   * Present iff this is a webchat turn received over relay `rd/*`. When set,
   * onAcpUpdate maps each SessionUpdate to a WebchatEvent and streams it through
   * the relay reply sink instead of driving the Slack renderer. `index` is the per-turn monotonic
   * assembly counter incremented on each emitted WebchatOutput payload. `replyText`
   * accumulates the agent's message chunks so the finished reply is recorded to the
   * transcript once (webchat has no Slack post boundary where text is otherwise saved).
   */
  webchat?: WebchatTurnContext & { index: number; replyText: string; heldText: string; messageEmitted: boolean }
}

/** Visible Slack thread messages that establish a new chronological boundary. Any live
 * in-place chrome from the active turn must continue below one of these messages. */
export type LiveChromeBoundaryMessageType = 'human-input-card' | 'agent-message'

export const LIVE_CHROME_BOUNDARY_MESSAGE_TYPES = new Set<LiveChromeBoundaryMessageType>([
  'human-input-card',
  'agent-message'
])

/** Exact platform delivery route retained after a turn leaves `pending`, so a
 *  late ACP title update can still rename the same Slack DM it came from. */
export interface SessionDeliveryBinding {
  agentId: string
  platform: string
  integrationId?: string
  isDm: boolean
}

/** Build the wire SessionKey (protocol §5) for a pending turn — what `drain/done`
 *  reports as released so the CP may reassign it. Uses the real `thread` (absent for
 *  a channel-root message), NOT `statusThread` (which falls back to msgId): the CP
 *  keys assignments by `thread ?? "-"`, so reporting the msgId would miss the match. */
export function pendingSessionKey(p: Pending): SessionKey {
  const { platform: rawPlatform, channel, thread } = p.plan
  const platform = rawPlatform as SessionKey['platform']
  return thread !== undefined ? { platform, channel, thread } : { platform, channel }
}

/** One shutdown duty drain: its bound, its counters, and the grants that landed after the latch. */
export interface ShutdownDutyDrain {
  deadlineAt: number
  stats: { groups: number; agents: number; late: number; acked: number; lapsing: number }
  /** Grants that landed after the latch: never installed, never acknowledged before the loop is done. */
  late: Map<string, DutyGrantEntry>
  /** Agents of groups the loop left to lapse — a late grant covering any of them lapses too. */
  lapsedAgents: Set<string>
  /** Set once the main loop has finished with every held group. */
  loopDone: boolean
}
