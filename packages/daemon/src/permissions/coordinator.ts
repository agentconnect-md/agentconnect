// ACP permission + elicitation policy — the human-approval half of a turn, hoisted out of
// `Daemon` verbatim. Resolution here is a race between the runtime request, the chat card, the
// Agent-editor decision, and turn cancellation: every await order and map write is load-bearing.
import { hostKeyAgentId, type HostKey } from '../acp/host-key.js'
import { randomUUID } from 'node:crypto'
import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse
} from '@agentclientprotocol/sdk/unstable'
import type {
  Ack,
  AgentApprovalRoute,
  AgentApprovalRouted,
  AgentPermissionDecision,
  AgentPermissionOption,
  ApprovalRouteTarget,
  AssistantActivityPermission,
  ElicitCard,
  ChatCallerRole,
  ElicitOutcome
} from '@agentconnect.md/protocol'
import {
  API_CALLER_ANSWER_PROTOCOLS,
  API_CALLER_ANSWER_TIMEOUT_MS,
  ASSISTANT_ACTIVITY_PERMISSIONS_MAX,
  elicitFormBlockId,
  PERMISSION_REQUEST_NOT_IN_CONVERSATION
} from '@agentconnect.md/protocol'
import type { Clock, TimerHandle } from '@agentconnect.md/connection'
import type { Logger } from '../log.js'
import type { LocalStore } from '../store/local-store.js'
import type { LoadedAgent } from '../agents/load-agents.js'
import type { AcpPermissionPolicyEvent } from '../acp/acp-host.js'
import type { DaemonEvaluationHooks } from '../evaluation/daemon-hooks.js'
import { SlackConnection } from '../slack/connection.js'
import type { InteractionActor } from '../platforms/contract.js'
import type {
  ElicitCardAsk,
  ElicitCardFacet,
  ElicitCardHandle,
  ElicitCardHost,
  ElicitCardMark,
  ElicitCardReply,
  ElicitCardSettlement
} from '../platforms/elicit-card.js'
import {
  buildApprovalDmIntro,
  buildComputerCallerApprovalNotice,
  buildElicitationCard,
  buildElicitDmUnanswerableCard,
  buildElicitationResolvedCard,
  buildPermissionCard,
  buildPermissionDmUnanswerableCard,
  permToolLabel,
  buildPermissionResolvedCard,
  clampTo,
  elicitCardShape,
  elicitForm,
  elicitFormFieldLabel,
  elicitFormAccepts,
  elicitFormContent,
  elicitFormRefusalNotice,
  ELICIT_ANSWER_REFUSED,
  elicitFormSubmission,
  elicitOptionLiteral,
  elicitOptionToken,
  elicitRequiredProps,
  elicitTarget,
  elicitUrl,
  fieldAccepts,
  multiSelectAccepts,
  numberAccepts,
  SLACK_DM_ELICIT_SURFACE,
  SLACK_PERMISSION_MAX_OPTIONS,
  textAccepts,
  WEBCHAT_ELICIT_SURFACE
} from '../slack/render.js'
import type { ElicitKind, ElicitSurface, ElicitTarget, SubsessionNoticeOutcome } from '../slack/render.js'
import type {
  ApprovalCardContext,
  ApprovalCardDraft,
  ApprovalCardFacet,
  ApprovalCardHandle,
  ApprovalCardPlace,
  SubsessionAsker,
  SubsessionNoticeView
} from '../platforms/approval-card.js'
import { TURN_NOTICE_TEXT } from '../platforms/approval-card.js'
import { sessionLinkSourceFor } from '../platforms/link-source.js'
import type { ChatEvent } from '../session/chat-turn.js'
import { consolePermissionOptions, isAllowOption } from './editor-options.js'
import {
  choiceById,
  elicitationApprovalChoices,
  elicitationFallback,
  permissionChoices,
  permissionFallback,
  pickChoice,
  type ApprovalChoice,
  type PickedChoice
} from './approval-choices.js'
import { slackThreadUrl } from '../platforms/slack/permalink.js'
import { slackAgentIdentityOptions } from '../platforms/slack/turn-output.js'
import { turnChromeFor, type NoticeMarkup } from '../platforms/turn-chrome.js'
import { monotonicTs } from '../store/monotonic-ts.js'
import { buildElicitDeclinedNotice, defuseNoticeText } from './elicit-notice.js'
import { elicitCardPayload, elicitRowBody, elicitUnrenderablePayload, elicitUrlCardPayload } from './elicit-record.js'
import { formatErr } from '../daemon/text.js'
import {
  approvalRequestSummary,
  elicitationApprovalParts,
  isBuiltinSystemTool,
  isBuiltinSystemToolElicitation,
  isMcpToolApprovalElicitation,
  permissionRequestParts,
  titledPermissionRequest,
  type ApprovalRequestParts
} from '../daemon/tool-classification.js'
import { pendingTurnKey, turnState, type DaemonRenderAction, type Pending } from '../daemon/turn-types.js'
import { isCheckCoordinate, isSubsessionCoordinate } from '../session/subsession-coordinate.js'
import { isCoordinatorCoordinate } from '../session/append-coordinate.js'
import { inConversation, requestConversation } from './request-conversation.js'
import {
  subsessionLabel,
  waitExpiredDecider,
  type SubsessionApprovalRoute,
  type SubsessionApprover
} from './subsession-approval.js'
import {
  approvalRefusalText,
  computerApprovalRefusalText,
  CHAT_APPROVALS_OFF,
  chatApprovalsAllowed,
  type ApprovalRefusal,
  type ChatActorVerdict,
  type ChatSurface
} from '../agents/chat-actions.js'
import type { AskerApprover } from '../assistant/drafts.js'
import type { ReadAsker } from '../assistant/place-access.js'
import {
  JOIN_ANSWER_REFUSED,
  JOIN_EXPIRED_TEXT,
  JOIN_OPTION,
  joinDecidedByAsker,
  joinDecidedText,
  joinRequestParams,
  parseStoredJoinAsk,
  type JoinAnswer,
  type JoinAsk,
  type JoinOffered,
  type StoredJoinAsk
} from './join-confirmation.js'

/** The union of a turn's explicit human-approval waits, measured here and nowhere else.
 *  Regeneration budgets subtract it while retaining runtime/tool work time; `depth` counts
 *  overlapping requests so the union is measured once, and `startedAt` marks the open interval. */
export interface ApprovalWait {
  waitMs: number
  depth: number
  startedAt?: number
}

/** Process-wide daemon state the permission path reads. */
export interface PermissionCoreHost {
  // A read-only view of the existing platform turn; absence never creates a chat execution context.
  chatObservation?(p: Pending): { turnId: string; emit(event: ChatEvent): void } | undefined
  log(): Logger
  clock(): Clock
  store(): LocalStore
  agents(): ReadonlyMap<string, LoadedAgent>
  /** Whether people in a conversation may answer approvals there ("What people can do in chat"); an unknown one is closed. */
  chatSurface(
    agentId: string,
    integrationId: string | undefined,
    channel: string,
    externallyShared?: boolean
  ): ChatSurface
  /** Whether a conversation is held external (a share or a guest detected), whatever its chat surface; one it cannot place counts as such. */
  placeExternal(agentId: string, integrationId: string | undefined, channel: string): boolean
  /** Whether chat actions on this integration are taken only from the agent's editors (its platform's permissions are synced). */
  chatEditorsOnly(agentId: string, integrationId: string | undefined): boolean
  /** Whether this person may act in chat past the level and the conversation; fails closed where permissions are synced. */
  chatActor(
    agentId: string,
    integrationId: string | undefined,
    actor: InteractionActor | undefined
  ): Promise<ChatActorVerdict>
  /** Whether the CP answers approval routes by a Computer's allowed members (`computer-approvers-v1`). */
  servesComputerApprovers(): boolean
  /** Whether this chat member is one of the Computer's allowed members, by their linked identity; fails closed. */
  computerActor(
    agentId: string,
    integrationId: string | undefined,
    computerId: string,
    actor: InteractionActor | undefined
  ): Promise<ChatActorVerdict>
  /** Live turns keyed by `pendingTurnKey(agentId, acpSessionId)`. */
  pending(): ReadonlyMap<string, Pending>
  evalHooks(): DaemonEvaluationHooks
  /** The live extraction turn on this key, if any: only its bound bridge tools may be granted (#2091). */
  memoryExtraction(turnKey: string): MemoryExtractionTurn | undefined
  /** End a turn as its caller's cancel would; a sub-session whose approval wait ran out names that instead. */
  cancelTurn(p: Pending, reason?: 'approval wait expired'): Promise<void>
}

/** The Computer a computer-use approval asks about, whose owner it also reaches and whose allowed members answer it (§4.2). */
export interface ComputerAskScope {
  computerId: string
  ownerUserId?: string
  /** The console users who may answer; absent from an older CP, which leaves the agent's usual approvers. */
  approvers?: readonly string[]
}

/** What the permission path knows about a live extraction turn: the bridge calls it has issued so far. */
export interface MemoryExtractionTurn {
  builtinSystemToolCallIds: ReadonlySet<string>
}

/** The CP exchange behind approval-DM routing — present only when connected AND the
 *  CP advertises `approval-dm-route-v1` (slack-approval-dm.md §4.2). */
export interface ApprovalRouteChannel {
  approvalRoute(payload: AgentApprovalRoute, orgId?: string): Promise<AgentApprovalRouted>
}

/** A gate that just left the pending maps; `allowed` is set only when a human decided it. */
interface ClosedGate {
  id: string
  allowed?: boolean
}

/** Which surface an interactive elicitation card was posted to, and what it takes to settle it
 *  there: a chat surface rewrites its own message through the facet that posted it; webchat
 *  appends a second stream event. The chat arm names no platform — the facet does, and the
 *  handle's three fields are the coordinates BOTH chat surfaces identify a posted card by. */
type PendingElicitSurface =
  | ({
      surface: 'chat'
      facet: ElicitCardFacet
      /** The conversation a typed answer must have been written in, qualified by the bot that owns
       *  the card (`plan.transcriptChannel`). `channel` is the bare platform channel a rewrite is
       *  addressed to, which cannot tell two bots apart in one person's DMs. */
      answerConv: string
    } & ElicitCardHandle)
  | { surface: 'webchat'; wc: NonNullable<Pending['webchat']> }

/** What the surface a card was posted to renders — re-deriving its target has to ask the same
 *  question the post did, or a card could be read back as a field its surface never showed. */
function surfaceOf(rec: PendingElicitSurface): ElicitSurface {
  return rec.surface === 'webchat' ? WEBCHAT_ELICIT_SURFACE : rec.facet.reduction
}

/** How a settled card names the answer: the chosen option's LABEL, or every chosen label for a
 *  multi-select — what the reader picked, in the words the card used, never the wire values.
 *  An accepted empty list (a `minItems: 0` form) still says something rather than nothing.
 *  A typed answer has no label but itself, so it is echoed (clamped): the card is the reader's
 *  own words back, and MCP forbids eliciting secrets, so there is nothing here to withhold. */
function chosenLabel(target: ElicitTarget | null, value: string | string[] | number): string {
  const label = (v: string) => target?.options.find((o) => o.value === v)?.label ?? v
  if (typeof value === 'number') return String(value)
  if (!Array.isArray(value)) return clampTo(label(value), 200)
  return value.length ? value.map(label).join(', ') : 'Nothing selected'
}

/** A chat card's answering actor, scoped the way its own surface scopes user ids (§11.3). */
function surfaceActorId(rec: PendingElicitSurface & { surface: 'chat' }, userId: string): string {
  const scope = rec.facet.answerScope?.(rec)
  return scope ? `${rec.facet.platform}:${scope}:${userId}` : `${rec.facet.platform}:${userId}`
}

/** The connection a turn's chat output goes through: its reply connection, else the egress it leased (Google Chat), unless its output is suppressed. */
function chatOut(p: Pending): unknown {
  return p.conn ?? (p.plan.suppressReplyConn ? undefined : p.egress)
}

/** The requester a background sub-session's request is recorded under: the agent itself. */
const agentAsker = (p: Pending): { id: null; name: string } => ({ id: null, name: p.plan.agentName })

/** One card's settlement, as its own surface re-renders it: the label, plus the ask it re-renders
 *  from and whether that ask was a consent. Pure. */
function elicitSettlement(
  params: CreateElicitationRequest,
  consent: boolean,
  label: ElicitCardLabel
): ElicitCardSettlement {
  return {
    params,
    consent,
    mark: label.mark,
    text: label.text,
    ...(label.fallback !== undefined ? { fallback: label.fallback } : {})
  }
}

/** Whether a submitted answer has the SHAPE this kind is answered with — the arity check a card
 *  applies before it looks at the value at all. The string kinds are indistinguishable here;
 *  each one's own accept check is what separates them. */
function answerFitsKind(kind: ElicitKind, value: string | string[] | number): boolean {
  if (kind === 'multi-enum') return Array.isArray(value)
  if (kind === 'number') return typeof value === 'number'
  return typeof value === 'string'
}

/** A multi-field form card's answer: one value per answered field, keyed by property name. */
type ElicitFormAnswer = Record<string, string | number | string[]>

/** The answer shapes a card settles with — a record only ever answers a FORM card. */
type ElicitAnswer = string | string[] | number | ElicitFormAnswer | null

function isFormAnswer(value: ElicitAnswer): value is ElicitFormAnswer {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** How a settled FORM card names its answer: every answered field as `label: answer`, in the
 *  card's own words, clamped as ONE line. Naming the fields is what keeps the thread of what
 *  was agreed; the clamp is what stops a long form pasting a wall of values into a transcript. */
function formAnswerLabel(
  params: CreateElicitationRequest,
  form: readonly ElicitTarget[],
  answer: ElicitFormAnswer
): string {
  const parts: string[] = []
  for (const t of form) {
    const value = answer[t.propName]
    // Named exactly as a form card names its fields, companion box included ("Branch (Other)"):
    // "Other: dev" in a transcript says which words were typed but not what they answer.
    if (value !== undefined) parts.push(`${elicitFormFieldLabel(params, t)}: ${chosenLabel(t, value)}`)
  }
  // An all-optional form left alone is still an answer — settling it as nothing would read
  // as a card that never resolved, the same reason a `minItems: 0` selection says so too.
  return parts.length ? clampTo(parts.join(' · '), 200) : 'Nothing filled in'
}

/** Why a console decision on a computer-use approval was refused. */
const COMPUTER_ANSWER_REFUSED = 'Only people allowed to use this Computer can answer this request.'

/** How a card the turn ended under is labelled: nothing was decided, so it says so. */
const ELICIT_CANCELLED: ElicitCardLabel = { mark: 'waiting', text: 'Cancelled', fallback: 'Cancelled' }

/** How an approval card reads for everyone once approving in chat is turned off: still open, for an editor. */
const ELICIT_CHAT_APPROVALS_OFF: ElicitCardLabel = {
  mark: 'blocked',
  text: CHAT_APPROVALS_OFF,
  fallback: 'Approving in chat was turned off'
}

/** How many consented URL elicitations wait for an `elicitation/complete` that may never come. */
const CONSENTED_URL_ELICIT_CAP = 64

/** How a settled consent card labels each outcome — the MARK and the words, so each surface
 *  spells the mark its own way. "Opened" is deliberately not "Done": consent is all the tap
 *  proves, and only the agent's own `elicitation/complete` says more. */
const URL_CONSENT_DECISION: Record<'accepted' | 'dismissed' | 'cancelled' | 'completed', ElicitCardLabel> = {
  accepted: { mark: 'answered', text: 'Opened' },
  dismissed: { mark: 'dismissed', text: 'Dismissed' },
  cancelled: { mark: 'waiting', text: 'Cancelled' },
  completed: { mark: 'answered', text: 'Completed' }
}

/** How a settled card is labelled, before the ask it re-renders from is known: the mark, the words
 *  beside it, and the notification fallback — absent when the rendered decision doubles as one,
 *  which is what a consent card's settlement has always sent. */
type ElicitCardLabel = { mark: ElicitCardMark; text: string; fallback?: string }

/** `elicitation/complete` carries no session, so a consented card is keyed by its ACP id within
 *  the agent host that raised it — two agents may hold the same id concurrently. */
function consentedUrlKey(owner: HostKey, elicitationId: string): string {
  return `${owner}\x00${elicitationId}`
}

/** An elicitation's own card in the turn's conversation, chat or webchat, and the shape its answer is re-derived against. */
type TurnElicitCard = PendingElicitSurface & {
  observe?: (event: ChatEvent) => void
  propName: string
  kind: ElicitKind
  /** The fields an `input`-block card rendered, in schema order; absent ⇒ a one-tap button row answered by a scalar. */
  form?: ElicitTarget[]
  /** A URL-mode consent card's ACP `elicitationId` and exact URL; its only answers are that URL back or Dismiss. */
  url?: { elicitationId: string; url: string }
  /** The card's transcript row (#1794), rewritten in place when it settles; absent on an approval, recorded in `permission_requests`. */
  row?: ElicitRow
  /** An approval card's conversation, rechecked when it is clicked. */
  place?: ChatPlace
}

type ChatElicitCard = Extract<TurnElicitCard, { surface: 'chat' }>

/** One card's `elicit` transcript row: its coordinates, and the card the ask recorded there. */
type ElicitRow = { channel: string; thread: string; sessionKey: string; ts: string; sender: string; card: ElicitCard }

/** The turn's platform surfaces a permission or elicitation card renders through. */
export interface PermissionSurfaceHost {
  enqueueApply(p: Pending, action: DaemonRenderAction): void
  /** Post a chronological boundary card serialized on the turn's apply chain. The connection is
   *  opaque: an elicitation-card facet casts it to its own, as every Layer-2 applier already does. */
  postCardSerialized(p: Pending, post: (conn: unknown) => Promise<string | undefined>): Promise<string | undefined>
  httpSlackSessionTarget(p: Pick<Pending, 'plan'>): string | undefined
  /** `platform`'s Layer-2 elicitation-card facet, EXACT (no core fallback) — undefined when this
   *  surface cannot collect an answer, which is the whole of what core needs to know about it. */
  elicitCardFacet(platform: string): ElicitCardFacet | undefined
  /** `platform`'s Layer-2 approval-card facet, EXACT; undefined when approvals there go to the console with a notice. */
  approvalCardFacet(platform: string): ApprovalCardFacet | undefined
  /** One integration's approval-card facet and live connection, for a card or notice posted outside the turn. */
  chatCardsAt(integrationId: string): { facet: ApprovalCardFacet; conn: unknown } | undefined
  maskAgentSecrets<T>(agentId: string, payload: T): T
  logSessionAction(verb: string, sessionKey: string, actor?: InteractionActor): void
  /** Tell the CP a session started or stopped waiting on a human (slack-approval-dm.md §7); fire-and-forget. */
  emitApprovalActivity(owner: HostKey, acpSessionId: string, state: 'awaiting_permission' | 'idle'): void
  /** Render the gate on the turn's OWN surface; false when the platform has none and the neutral chat notice should post. */
  approvalGateOpened(p: Pending, gateId: string, request: ApprovalRequestParts): boolean
  /** One gate went away — `allowed` is set only for a human decision, which the surface reports. */
  approvalGateClosed(p: Pending, gateId: string, allowed?: boolean): void
  // ── approval-DM routing (slack-approval-dm.md §4–§6) ──
  cpApprovalRoute(): ApprovalRouteChannel | undefined
  orgForAgent(agentId: string): string | undefined
  sessionLink(sessionId: string, source?: string): string
  slackConnFor(integrationId: string): SlackConnection | undefined
  /** The agent's LIVE Slack integration ids, `preferred` first; `cards` adds those whose platform takes an editor's card in a 1:1 chat. */
  approvalDmIntegrations(agentId: string, preferred?: string, cards?: boolean): string[]
  /** Unconditional shared-target block_id for a DM card (§5.3). */
  slackDmSessionTarget(p: Pick<Pending, 'plan'>, integrationId: string): string
  // ── assistant-mode sub-sessions (assistant-mode.md §5.6) ──
  /** Where a background sub-session's request goes; undefined for every other turn. */
  subsessionApprovalRoute?(p: Pending): Promise<SubsessionApprovalRoute | undefined>
  /** The approver an external place's card goes to instead, as drafts route theirs (§5.5). */
  assistantApprover?(agentId: string, requestId: string): Promise<SubsessionApprover | undefined>
  /** The person whose message started the turn, in their own DM, when they are an internal member (§5.5). */
  externalAskerDm?(p: Pending): Promise<AskerApprover | undefined>
  /** That asker's DM on a platform whose connection opens one, for a card through its facet; undefined where none reaches them. */
  askerDirectMessage?(p: Pending): Promise<{ integrationId: string; userId: string; channel: string } | undefined>
  /** A person's 1:1 chat on a platform whose connection opens one, for an editor's card through its facet; undefined where none does. */
  directMessageAt?(integrationId: string, userId: string): Promise<string | undefined>
  /** A join card a restart left pending was rewritten as expired: its session hears that the call did nothing. */
  joinCardExpired?(agentId: string, acpSessionId: string, ask: StoredJoinAsk): void
  /** One person behind a turn in their own direct message, routed as drafts route an approver; undefined when no card reaches them. */
  personDm?(
    agentId: string,
    requestId: string,
    asker: ReadAsker
  ): Promise<{ target: DmTarget; channel: string } | undefined>
}

/** Everything the permission coordinator touches on the `Daemon`. */
export interface PermissionHost extends PermissionCoreHost, PermissionSurfaceHost {}

/** The conversation a chat-side answer is rechecked against when it is clicked. */
interface ChatPlace {
  integrationId?: string
  channel: string
}

/** A DM card's addressee: an editor the control plane chose carries their console user, the asker of an external place does not. */
export type DmTarget = Omit<ApprovalRouteTarget, 'consoleUserId'> & { consoleUserId?: string }

/** A live DM approval card (§5): its target, connection and handle; `propName`/`valueKind` mirror an elicitation's one field. */
interface DmNotice {
  target: DmTarget
  conn: SlackConnection
  channel: string
  ts: string
  /** The §5.2 context header (session link, source quote/permalink), which every rewrite keeps. */
  intro: unknown[]
  propName?: string
  valueKind?: ElicitKind
  /** Set on the asker's own card for an external place, whose click answers while chat approvals stay open there. */
  asker?: ChatPlace
  /** Sent beside a card in the conversation that keeps the row's notify handle, so this DM's handle is the beside one. */
  beside?: true
}

/** A permission request's in-conversation card (§1's chat path), drawn by its surface's facet; `ts` is set once its post returns. */
interface ChatPermissionCard extends ApprovalCardHandle {
  facet: ApprovalCardFacet
  /** The conversation the card was posted in, rechecked when it is clicked. */
  place: ChatPlace
  /** A sub-session's card names who is asking above the request, on every rewrite too (assistant-mode.md §5.6). */
  subsession?: SubsessionAsker
  /** Its handle is also on the stored row, so a restart's sweep retires it; cleared once rewritten. */
  stored?: { agentId: string; requestId: string }
  /** Posted outside the turn's own conversation through this integration, which its relayed click names. */
  routedVia?: string
  /** Posted in this asker's own DM for an external place: only they answer, judged as the asker of `place` (§5.5). */
  askerId?: string
  /** Posted in this editor's own chat on the editor path: only they answer, rechecked by the control plane (§6.3). */
  editor?: DmTarget
  /** What an editor's card says it is for, on every rewrite too. */
  context?: ApprovalCardContext
  /** How the card must read once its post returns, when its request settled first. */
  settledFirst?: ApprovalCardDraft
}

/** A neutral notice: a sub-session's in its conversation (§5.6), or the turn's own on the editor path (view unset); its handle is on the row too, so a restart's sweep settles it. */
interface NeutralNotice {
  facet: ApprovalCardFacet
  handle: ApprovalCardHandle
  view?: SubsessionNoticeView
  /** The turn's notice in an external conversation, whose settled line names nobody. */
  anonymous?: boolean
}

/** Where people may answer a turn's approval: its conversation's card, the asker's DM for an external one, or only the editor path. */
type ChatApprovalRoute = { to: 'card'; facet: ApprovalCardFacet } | { to: 'asker' | 'none' }

/** A chat card's answerer, scoped as its surface scopes user ids; null when that scope is unknown. */
function cardAnswererId(chat: ChatPermissionCard, userId: string): string | null {
  if (!chat.facet.answerScope) return `${chat.facet.platform}:${userId}`
  const scope = chat.facet.answerScope(chat)
  return scope ? `${chat.facet.platform}:${scope}:${userId}` : null
}

/** A background sub-session's wait on one request (assistant-mode.md §5.6). */
interface SubsessionWait {
  route: SubsessionApprovalRoute
  /** The sub-session's outward id. */
  sessionId: string
  /** What it asks to run, as the approval queue shows it. */
  tool: string
  createdAt: number
  deadline: number
  timer: TimerHandle
}

/** One approval every surface settles through (§11.1): the console always, plus whichever cards it was offered on. */
interface ApprovalEntry<P, R> {
  chatScope?: ChatRequestIdentity
  owner: HostKey
  agentId: string
  sessionId: string
  /** When it was asked: the start of the human's answer window, which runtime activity does not move. */
  askedAt: number
  params: P
  resolve: (res: R) => void
  notify?: DmNotice
  /** Set on a background sub-session's request: denied and stopped once its wait runs out. */
  subsession?: SubsessionWait
  notice?: NeutralNotice
  /** How it settled, for a notice whose post returns after that. */
  settled?: SubsessionNoticeOutcome
}

interface PermissionApproval extends ApprovalEntry<RequestPermissionRequest, RequestPermissionResponse> {
  kind: 'permission'
  /** Original ACP object used by the host's final policy observer. */
  evaluationParams: RequestPermissionRequest
  chat?: ChatPermissionCard
  /** The routed editor's card in their own chat, beside a conversation card only editors may answer; kept on the row's beside handle. */
  beside?: ChatPermissionCard
  /** Set on the daemon's own confirmation before the bot joins a channel: only the people behind the turn answer it. */
  join?: JoinWait
}

/** A join confirmation while it waits: its deadline, and how it ended when no one decided it. */
interface JoinWait extends JoinAsk {
  timer?: TimerHandle
  ended?: 'expired'
  /** The person behind the turn whose answer decided it. */
  answeredBy?: ReadAsker
}

interface ElicitationApproval extends ApprovalEntry<CreateElicitationRequest, CreateElicitationResponse> {
  kind: 'elicitation'
  /** The answers whoever asked it offers (§11.2); absent ⇒ Allow/Deny. A permission request re-derives its own (#1815). */
  choices?: ApprovalChoice<CreateElicitationResponse>[]
  /** What its cards name it by, resolved while its turn could still say which call it is. */
  parts: ApprovalRequestParts
  /** The routed editor's card in their own chat, drawn from `choices` by the platform's approval-card facet (teams-integration.md §4.4). */
  chat?: ChatPermissionCard
  /** The elicitation card the turn's own surface drew it as, answered in the conversation. */
  card?: TurnElicitCard
}

/** A question the agent asks the reader: only its own card answers it, and no permission row records it. */
interface ElicitationQuestion extends ApprovalEntry<CreateElicitationRequest, CreateElicitationResponse> {
  kind: 'question'
  card: TurnElicitCard
}

/** A pending elicitation that has a card in the turn's own conversation. */
type CardRequest = (ElicitationApproval | ElicitationQuestion) & { card: TurnElicitCard }

function hasCard(rec: PendingRequest | undefined): rec is CardRequest {
  return !!rec && rec.kind !== 'permission' && rec.card !== undefined
}

/** How an elicitation's own card says an answer settled it, beyond the label every surface shares. */
interface CardAnswer {
  mark: ElicitCardMark
  fallback: string
  /** What the transcript row and webchat name the answer by. */
  answered?: string
  answers?: Record<string, string | number | boolean | string[]>
}

/** The permission request an approval-card facet draws: a permission request as asked, an MCP approval as its choices; null without choices. */
function cardRequest(rec: PendingRequest): RequestPermissionRequest | null {
  if (rec.kind === 'permission') return rec.params
  if (rec.kind === 'question' || !rec.choices) return null
  const toolCallId = 'toolCallId' in rec.params ? rec.params.toolCallId : undefined
  return {
    sessionId: rec.sessionId,
    toolCall: {
      toolCallId: typeof toolCallId === 'string' ? toolCallId : '',
      title: rec.parts.tool
    },
    options: rec.choices.map((choice) => choice.option)
  }
}

type PendingApproval = PermissionApproval | ElicitationApproval

/** Every request awaiting a human, approval or question, whichever surfaces it was offered on (§11). */
type PendingRequest = PendingApproval | ElicitationQuestion

/** Whether a request holds its turn: a join confirmation outlives it, answered after the call returned. */
const holdsTurn = (e: PendingRequest): boolean => !(e.kind === 'permission' && e.join)

/** Whether a request is a permission the session waits on (§7): a question is not. */
const awaitsPermission = (e: PendingRequest): boolean => holdsTurn(e) && e.kind !== 'question'

/** The person behind the turn a join DM was addressed to: its console user, else the chat member it went to. */
function joinDmAsker(join: JoinWait, target: DmTarget): ReadAsker | undefined {
  if (target.consoleUserId) return { kind: 'console', userId: target.consoleUserId }
  return join.askers.find(
    (asker) => asker.kind === 'member' && asker.integrationId === target.integrationId && asker.userId === target.userId
  )
}

/** What a webchat conversation is told while its owner may answer the request on its page. */
const WEBCHAT_OWNER_APPROVAL_NOTICE =
  '🔒 Permission requested. The conversation’s owner or an Agent editor can answer it on its Session page.'

/** Who settled an approval, as `permission_requests` records it. */
type Decider = { resolvedBy: string | null; resolvedByName: string | null }

/** One runtime approval handed to an API caller (shared-bot-relay.md §10.4); an editor sees it only when the caller allows what it may not. */
export interface ChatRequestScope {
  agentId: string
  conversationId: string
  outwardSessionId: string
  turnId: string
  requestId: string
}

type ChatRequestIdentity = Omit<ChatRequestScope, 'requestId' | 'conversationId'> & { conversationId?: string }

type PermissionResult = Pick<Extract<ChatEvent, { kind: 'permission_resolved' }>, 'outcome' | 'selectedOptionId'>

interface CallerApproval {
  scope: ChatRequestIdentity
  options?: { id: string; label: string; allow: boolean }[]
  owner: HostKey
  sessionId: string
  conversationId: string
  answer(allow: boolean, mayAllow: boolean, selectedOptionId?: string): boolean
  /** The turn ended unanswered. */
  cancel(): void
}

/** An API turn whose caller is handed the agent's questions: the webchat context a protocol that carries them set up. */
type CallerTurn = Pending & { webchat: NonNullable<Pending['webchat']> }

/** A session no one answers for: whatever its runtime would ask is refused (assistant-mode.md §5.12, auto-session-mode.md §5.4). */
function refusesEveryAsk(thread: string | null | undefined): boolean {
  return isCheckCoordinate(thread) || isCoordinatorCoordinate(thread)
}

export class PermissionCoordinator {
  // ── Permission requests (ACP session/request_permission) ─────────────────────
  /** Durable rows still being written. Admission publishes its resolver first, so anything that
   *  settles a request must wait for the row it settles to exist. */
  private readonly recordedWrites = new Map<string, Promise<unknown>>()
  /** Every request awaiting a human, by a `randomUUID()` id: a posted card outlives a restart, so an id is never reused (#1794). */
  private readonly pendingApprovals = new Map<string, PendingRequest>()
  /** Runtime approvals handed to an API caller, keyed by the id its answer names. */
  private readonly pendingCallerApprovals = new Map<string, CallerApproval>()
  /** A computer-use approval's Computer, owner and approvers, by its request's tool call id (computer-use.md §4.2). */
  private readonly computerAsks = new Map<string, ComputerAskScope>()

  /** Decision details discovered inside the platform policy and merged into the
   * single terminal event emitted by AcpHost's policy observer. */
  private readonly permissionEvaluationDetails = new WeakMap<RequestPermissionRequest, Record<string, unknown>>()

  // ── Interactive elicitations (ACP elicitation/create, form + url mode) ──────
  /** Consented URL cards awaiting an `elicitation/complete` that may never come, by `<owner>\x00<elicitationId>`; bounded. */
  private readonly consentedUrlElicits = new Map<string, { requestId: string; rec: CardRequest }>()
  /** How a card that settled while its own `chat.postMessage` was still in flight must be
   *  labelled once that post finally returns — recorded by the settlement, consumed by the
   *  posting path, which would otherwise stamp every such card Cancelled (#1794). Bounded by
   *  the posting path deleting its own entry on every exit. */
  private readonly settledBeforePost = new Map<string, ElicitCardLabel>()

  /** Sessions the CP currently believes are waiting, keyed by `pendingTurnKey` — emit only on a change. */
  private readonly awaitingApproval = new Map<string, { owner: HostKey; agentId: string; sessionId: string }>()

  /** The two core capabilities an elicitation-card facet is allowed to reach, and nothing wider. */
  private readonly elicitCardHost: ElicitCardHost = {
    postCardSerialized: (turn, post) => this.host.postCardSerialized(turn as Pending, post),
    sessionTarget: (turn) => this.host.httpSlackSessionTarget(turn as Pending),
    turnState: (turn) => turnState(turn as Pending)
  }

  constructor(private readonly host: PermissionHost) {}

  /** A pending approval by id, for the editor path's surfaces; a question is answered on its own card alone. */
  private approvalAt(id: string): PendingApproval | undefined {
    const rec = this.pendingApprovals.get(id)
    return rec?.kind === 'question' ? undefined : rec
  }

  /** Any answerable permission the session waits on; a question is not one. */
  private hasPendingApproval(owner: HostKey, sessionId: string): boolean {
    for (const e of this.pendingApprovals.values())
      if (awaitsPermission(e) && e.owner === owner && e.sessionId === sessionId) return true
    return false
  }

  /** Re-derive the session's wait state after a map write and report it when it flipped (§7). `closed`
   *  names the gate this write removed, so the turn's surface closes that one gate, not the session. */
  private syncApprovalActivity(owner: HostKey, sessionId: string, closed?: ClosedGate): void {
    const key = pendingTurnKey(owner, sessionId)
    if (closed) {
      // Any settled human wait — approval, form, URL consent — restarts the stall watchdog's clock (#1915).
      const turn = this.host.pending().get(key)
      if (turn) turn.runtimeActivityAt = this.host.clock().now()
      this.reportGateClosed(owner, sessionId, closed)
    }
    const awaiting = this.hasPendingApproval(owner, sessionId)
    if (awaiting === this.awaitingApproval.has(key)) return
    if (awaiting) this.awaitingApproval.set(key, { owner, agentId: hostKeyAgentId(owner), sessionId })
    else this.awaitingApproval.delete(key)
    try {
      this.host.emitApprovalActivity(owner, sessionId, awaiting ? 'awaiting_permission' : 'idle')
    } catch (err) {
      this.host.log().warn(`approval activity not reported: ${formatErr(err)}`)
    }
  }

  /** Close one gate on the turn's own surface, if the turn is still live. */
  private reportGateClosed(owner: HostKey, sessionId: string, closed: ClosedGate): void {
    const p = this.host.pending().get(pendingTurnKey(owner, sessionId))
    if (!p) return
    try {
      this.host.approvalGateClosed(p, closed.id, closed.allowed)
    } catch (err) {
      this.host.log().warn(`approval follow-through not rendered: ${formatErr(err)}`)
    }
  }

  /** The sessions currently waiting on a human, by runtime session id. */
  liveApprovalWaits(): ReadonlyArray<{ owner: HostKey; agentId: string; sessionId: string }> {
    return [...this.awaitingApproval.values()]
  }

  /** Whether the session still has an answerable request — the emit-time check behind every `awaiting_permission`. */
  isAwaitingApproval(owner: HostKey, sessionId: string): boolean {
    return this.awaitingApproval.has(pendingTurnKey(owner, sessionId))
  }

  /** Re-assert every live wait after a (re)connect: the CP reset them when this daemon dropped (§7). */
  replayApprovalActivity(): void {
    for (const { owner, sessionId } of this.awaitingApproval.values()) {
      this.host.emitApprovalActivity(owner, sessionId, 'awaiting_permission')
    }
  }

  private async noteEditorPermissionRequest(
    id: string,
    agentId: string,
    sessionId: string,
    request: ApprovalRequestParts,
    p: Pending,
    notifyChat = true,
    requester?: { id: null; name: string },
    joinAsk?: StoredJoinAsk
  ): Promise<{ requesterName: string | null }> {
    const command = approvalRequestSummary(request)
    const store = this.host.store()
    const session = requester ? undefined : await store.getSessionByAcpIdForAgent(agentId, sessionId)
    const requesterId = requester ? requester.id : (p.plan.requesterId ?? session?.triggeredBy ?? null)
    const requesterName = requester
      ? requester.name
      : requesterId
        ? ((await store.getDisplayNames([requesterId])).get(requesterId) ?? null)
        : null
    await store.createPermissionRequest({
      id,
      agentId,
      sessionId,
      createdAt: this.host.clock().now(),
      requesterId,
      requesterName,
      command,
      status: 'pending',
      resolvedAt: null,
      ...(joinAsk ? { joinAsk: JSON.stringify(joinAsk) } : {})
    })

    if (!notifyChat) return { requesterName }
    const text = TURN_NOTICE_TEXT
    try {
      if (p.webchat) {
        // A webchat conversation's owner answers it there too once people in chat may approve.
        const owner = !p.webchat.continuation && chatApprovalsAllowed(this.host.agents().get(agentId))
        p.webchat.sink.output({
          conversationId: p.webchat.conversationId,
          turnId: p.webchat.turnId,
          index: p.webchat.index++,
          event: { kind: 'message', text: owner ? WEBCHAT_OWNER_APPROVAL_NOTICE : text }
        })
      }
      // A continuation turn notifies the origin platform thread too (§5.2). The turn's own
      // surface owns that notice where it has one — Linear's feed has no chat transport at all,
      // so without this the gate would be invisible until the session went stale.
      if (!p.webchat || p.webchat.continuation) {
        if (!this.host.approvalGateOpened(p, id, request) && chatOut(p)) this.postTurnNotice(id, agentId, p)
      }
    } catch (err) {
      // The durable editor request is authoritative. A best-effort chat notice
      // must never discard the live resolver or silently fall back to auto-allow.
      this.host.log().warn(`permission request notice failed for "${p.plan.sessionKey}": ${formatErr(err)}`)
    }
    return { requesterName }
  }

  /** The editor path's notice in the turn's conversation; a card surface keeps its handle so it says how the request settled. */
  private postTurnNotice(id: string, agentId: string, p: Pending): void {
    const rec = this.approvalAt(id)
    const facet = p.plan.approvalSurfaceSuppressed ? undefined : this.host.approvalCardFacet(p.plan.platform)
    const integrationId = p.plan.integrationId
    if (!rec || !facet || integrationId === undefined) {
      this.host.enqueueApply(p, { kind: 'notice', text: TURN_NOTICE_TEXT })
      return
    }
    const thread = p.plan.thread ? { thread: p.plan.thread } : {}
    const handle: ApprovalCardHandle = {
      conn: chatOut(p),
      channel: facet.cardChannel?.({ channel: p.plan.channel, ...thread }) ?? p.plan.channel,
      ...thread
    }
    // Read from the audience, not the chat surface: a closed surface outranks external there.
    const anonymous =
      p.entry.msg.externallyShared === true || this.host.placeExternal(agentId, integrationId, p.plan.channel)
    void facet
      .send(this.elicitCardHost, p, facet.turnNotice())
      .catch(() => undefined)
      .then(async (ts) => {
        // A card that did not land still leaves the plain notice.
        if (!ts) return this.host.enqueueApply(p, { kind: 'notice', text: TURN_NOTICE_TEXT })
        await this.keepNotice(
          id,
          rec,
          { facet, handle: { ...handle, ts }, ...(anonymous ? { anonymous } : {}) },
          integrationId
        )
      })
      .catch((err: unknown) =>
        this.host.log().warn(`permission request notice for "${p.plan.sessionKey}" not kept: ${formatErr(err)}`)
      )
  }

  private async resolveStoredPermissionRequest(
    agentId: string,
    requestId: string,
    status: 'allowed' | 'denied' | 'expired',
    by?: { resolvedBy: string | null; resolvedByName: string | null }
  ): Promise<boolean> {
    try {
      // The row may still be in flight — a decision or sweep in that window settles nothing
      // unless it waits for the write it is settling.
      await this.recordedWrites.get(requestId)?.catch(() => undefined)
      return await this.host.store().resolvePermissionRequest(agentId, requestId, status, this.host.clock().now(), by)
    } catch (err) {
      this.host.log().error(`permission request "${requestId}" could not be resolved locally: ${formatErr(err)}`)
      return false
    }
  }

  /** Exclude only explicit human decision latency from regeneration wall time.
   * A depth counter measures the union of overlapping approval intervals. */
  private async trackHumanApprovalWait<T>(p: Pending, result: Promise<T>): Promise<T> {
    const a = p.approval
    if (a.depth === 0) a.startedAt = this.host.clock().now()
    a.depth += 1
    try {
      return await result
    } finally {
      a.depth = Math.max(0, a.depth - 1)
      if (a.depth === 0 && a.startedAt !== undefined) {
        a.waitMs += Math.max(0, this.host.clock().now() - a.startedAt)
        delete a.startedAt
      }
    }
  }

  /** A permission card or elicitation for `sessionId` still awaits a human — that wait is not the runtime's (#1915). */
  awaitingHuman(owner: HostKey, sessionId: string): boolean {
    const mine = (pending: { owner: HostKey; sessionId: string }): boolean =>
      pending.owner === owner && pending.sessionId === sessionId
    for (const pending of this.pendingApprovals.values()) if (holdsTurn(pending) && mine(pending)) return true
    for (const pending of this.pendingCallerApprovals.values()) if (mine(pending)) return true
    return false
  }

  /** When the session's oldest unanswered request or question was asked, or undefined when none waits. */
  oldestHumanWaitAskedAt(owner: HostKey, sessionId: string): number | undefined {
    let oldest: number | undefined
    for (const pending of this.pendingApprovals.values()) {
      if (!holdsTurn(pending) || pending.owner !== owner || pending.sessionId !== sessionId) continue
      if (oldest === undefined || pending.askedAt < oldest) oldest = pending.askedAt
    }
    return oldest
  }

  /** Whether a request the session waits on carries a wait cap of its own: a background sub-session's (assistant-mode.md §5.6) or an API caller's. */
  hasOwnWaitCap(owner: HostKey, sessionId: string): boolean {
    const mine = (pending: { owner: HostKey; sessionId: string }): boolean =>
      pending.owner === owner && pending.sessionId === sessionId
    for (const pending of this.pendingApprovals.values()) if (pending.subsession && mine(pending)) return true
    for (const pending of this.pendingCallerApprovals.values()) if (mine(pending)) return true
    return false
  }

  /** Whether this turn's caller answers the agent's questions: an API turn over a protocol whose stream carries them. */
  private callerAnswers(p: Pending): p is CallerTurn {
    const wc = p.webchat
    return (
      wc?.apiProtocol !== undefined &&
      !wc.continuation &&
      (wc.apiProtocol === 'ahp' || API_CALLER_ANSWER_PROTOCOLS.has(wc.apiProtocol))
    )
  }

  /** Whether an API caller in this conversation still holds a question the turn waits on. */
  awaitsApiCaller(conversationId: string): boolean {
    for (const c of this.pendingCallerApprovals.values()) if (c.conversationId === conversationId) return true
    for (const e of this.pendingApprovals.values()) {
      const card = hasCard(e) ? e.card : undefined
      if (card?.surface === 'webchat' && card.wc.conversationId === conversationId && card.wc.apiProtocol !== undefined)
        return true
    }
    return false
  }

  /** Cancel the turn when its caller still has not answered once the deadline passes. */
  private armCallerDeadline(p: Pending, stillPending: () => boolean): void {
    this.host.clock().setTimeout(() => {
      if (!stillPending()) return
      this.host.log().info(`API caller left a question unanswered in "${p.plan.sessionKey}"; cancelling the turn`)
      void this.host
        .cancelTurn(p)
        .catch((err) => this.host.log().warn(`unanswered API turn not cancelled: ${formatErr(err)}`))
    }, API_CALLER_ANSWER_TIMEOUT_MS)
  }

  /** Hand one runtime approval to the API caller; a refusal settles it, an allow the caller may not make waits for an editor. */
  private async askCaller<T>(
    p: CallerTurn,
    sessionId: string,
    parts: ApprovalRequestParts,
    settle: {
      allow: (optionId?: string) => T
      deny: (optionId?: string) => T
      escalate: () => Promise<T>
      cancelled: T
      outcome: (result: T) => PermissionResult
      options?: { id: string; label: string; allow: boolean }[]
    }
  ): Promise<T> {
    const requestId = randomUUID()
    const wc = p.webchat
    let resolve!: (res: T | Promise<T>) => void
    const result = new Promise<T>((r) => (resolve = r))
    const done = (res: () => T | Promise<T>): boolean => {
      if (!this.pendingCallerApprovals.delete(requestId)) return false
      resolve(res())
      return true
    }
    this.pendingCallerApprovals.set(requestId, {
      owner: p.hostKey,
      sessionId,
      conversationId: wc.conversationId,
      scope: this.chatScope(p)!,
      options: settle.options,
      answer: (allow, mayAllow, optionId) =>
        done(!allow ? () => settle.deny(optionId) : mayAllow ? () => settle.allow(optionId) : settle.escalate),
      cancel: () => done(() => settle.cancelled)
    })
    try {
      wc.sink.output({
        conversationId: wc.conversationId,
        turnId: wc.turnId,
        index: wc.index++,
        event: {
          kind: 'permission',
          requestId,
          tool: parts.tool,
          detail: parts.detail,
          ...(settle.options ? { options: settle.options } : {})
        }
      })
    } catch (err) {
      this.pendingCallerApprovals.delete(requestId)
      this.host.log().warn(`API approval not delivered for "${p.plan.sessionKey}": ${formatErr(err)}`)
      return settle.cancelled
    }
    this.armCallerDeadline(p, () => this.pendingCallerApprovals.has(requestId))
    const resolved = await this.trackHumanApprovalWait(p, result)
    this.emitChatEvent(p, { kind: 'permission_resolved', requestId, ...settle.outcome(resolved) })
    return resolved
  }

  /** An API caller's answer to a runtime approval it was handed, confined to its own conversation. */
  handleCallerPermissionChoice(a: {
    requestId: string
    allow: boolean
    mayAllow: boolean
    conversationId: string
    actor?: InteractionActor
    outwardSessionId?: string
    turnId?: string
    selectedOptionId?: string
  }): boolean {
    const pending = this.pendingCallerApprovals.get(a.requestId)
    if (
      !pending ||
      pending.conversationId !== a.conversationId ||
      (a.outwardSessionId !== undefined && pending.scope.outwardSessionId !== a.outwardSessionId) ||
      (a.turnId !== undefined && pending.scope.turnId !== a.turnId)
    )
      return false
    if (
      a.selectedOptionId !== undefined &&
      !pending.options?.some((o) => o.id === a.selectedOptionId && o.allow === a.allow)
    )
      return false
    const verb = !a.allow ? 'denied' : a.mayAllow ? 'allowed' : 'referred to an Agent editor'
    this.host.logSessionAction(`permission:${verb} (API caller)`, pending.sessionId, a.actor)
    return pending.answer(a.allow, a.mayAllow, a.selectedOptionId)
  }

  private chatScope(p: Pending): ChatRequestIdentity | undefined {
    const turnId = p.webchat?.turnId ?? this.host.chatObservation?.(p)?.turnId
    return turnId
      ? {
          agentId: p.plan.agentId,
          ...(p.webchat ? { conversationId: p.webchat.conversationId } : {}),
          outwardSessionId: p.outwardSessionId,
          turnId
        }
      : undefined
  }

  private matchesChatScope(scope: ChatRequestIdentity | undefined, a: ChatRequestScope): boolean {
    return (
      !!scope &&
      scope.agentId === a.agentId &&
      (scope.conversationId === undefined || scope.conversationId === a.conversationId) &&
      scope.outwardSessionId === a.outwardSessionId &&
      scope.turnId === a.turnId
    )
  }

  private liveChatRequest(rec: { owner: HostKey; sessionId: string }, a: ChatRequestScope): boolean {
    const p = this.host.pending().get(pendingTurnKey(rec.owner, rec.sessionId))
    return !!p && !p.outputSuppressed && this.matchesChatScope(this.chatScope(p), a)
  }

  // Authority is CP-verified by ingress; a conversation owner never inherits the editor gate.
  async handleChatPermissionChoice(
    a: ChatRequestScope & {
      allow: boolean
      mayAllow: boolean
      callerRole: ChatCallerRole
      userId: string
      user?: string
      selectedOptionId?: string
    }
  ): Promise<boolean> {
    if (!a.userId || !['owner', 'editor', 'participant'].includes(a.callerRole)) return false
    const caller = this.pendingCallerApprovals.get(a.requestId)
    if (caller) {
      if (!this.matchesChatScope(caller.scope, a) || !this.liveChatRequest(caller, a)) return false
      return this.handleCallerPermissionChoice({
        ...a,
        actor: { userId: a.userId, ...(a.user ? { name: a.user } : {}) }
      })
    }
    const editor = this.pendingApprovals.get(a.requestId)
    if (
      a.callerRole !== 'editor' ||
      !editor ||
      editor.kind === 'question' ||
      !this.matchesChatScope(editor.chatScope, a) ||
      !this.liveChatRequest(editor, a)
    )
      return false
    return (
      await this.decideEditorPermission({
        agentId: a.agentId,
        requestId: a.requestId,
        decision: a.allow ? 'allow' : 'deny',
        ...(a.selectedOptionId !== undefined ? { optionId: a.selectedOptionId } : {}),
        decidedBy: `user:${a.userId}`,
        ...(a.user ? { decidedByName: a.user } : {})
      })
    ).ok
  }

  private emitChatEvent(p: Pending, event: ChatEvent): void {
    const wc = p.webchat
    try {
      if (wc) wc.sink.output({ conversationId: wc.conversationId, turnId: wc.turnId, index: wc.index++, event })
      else this.host.chatObservation?.(p)?.emit(this.host.maskAgentSecrets(p.plan.agentId, event))
    } catch (err) {
      this.host.log().warn(`chat request observation failed: ${formatErr(err)}`)
    }
  }

  private permissionResult(result: RequestPermissionResponse, params: RequestPermissionRequest): PermissionResult {
    if (result.outcome.outcome !== 'selected') return { outcome: 'cancelled' }
    const selectedOptionId = result.outcome.optionId
    const selected = params.options.find((o) => o.optionId === selectedOptionId)
    return {
      outcome: selected && isAllowOption(selected) ? 'allowed' : 'denied',
      selectedOptionId: result.outcome.optionId
    }
  }

  private observeEditorPermission<T>(
    p: Pending,
    requestId: string,
    parts: ApprovalRequestParts,
    result: Promise<T>,
    outcome: (result: T) => PermissionResult
  ): void {
    this.emitChatEvent(p, {
      kind: 'permission',
      requestId,
      tool: parts.tool,
      detail: parts.detail,
      editorOnly: true,
      options: this.pendingPermissionOptions(p.plan.agentId, requestId)?.map((o) => ({
        id: o.optionId,
        label: o.name,
        allow: isAllowOption(o)
      }))
    })
    void result.then((value) => this.emitChatEvent(p, { kind: 'permission_resolved', requestId, ...outcome(value) }))
  }

  private async awaitEditorPermission(
    agentId: string,
    sessionId: string,
    params: RequestPermissionRequest,
    evaluationParams: RequestPermissionRequest,
    p: Pending,
    route?: SubsessionApprovalRoute,
    askerFirst = false
  ): Promise<RequestPermissionResponse> {
    const id = randomUUID()
    let resolveResult!: (res: RequestPermissionResponse) => void
    const result = new Promise<RequestPermissionResponse>((resolve) => (resolveResult = resolve))
    // Publish BEFORE the store write: the write awaits, and a cancellation sweep landing in
    // that window must find this entry or the agent waits on a resolver nobody can reach.
    const entry: PermissionApproval = {
      kind: 'permission',
      chatScope: this.chatScope(p),
      owner: p.hostKey,
      agentId,
      sessionId,
      askedAt: this.host.clock().now(),
      params,
      evaluationParams,
      resolve: resolveResult
    }
    this.pendingApprovals.set(id, entry)
    const parts = permissionRequestParts(params, p.knownToolCalls)
    this.observeEditorPermission(p, id, parts, result, (value) => this.permissionResult(value, params))
    if (route) this.armSubsessionWait(id, entry, p, route, parts)
    this.syncApprovalActivity(p.hostKey, sessionId)
    // The human wait starts when the request becomes answerable, not when its row lands — the
    // write used to be synchronous, and billing it to the turn's retry budget would shrink it.
    const wait = this.trackHumanApprovalWait(p, result)
    // A sub-session's turn was started by the agent itself, so the agent is who asks.
    const recorded = this.noteEditorPermissionRequest(id, agentId, sessionId, parts, p, !route, route && agentAsker(p))
    this.recordedWrites.set(id, recorded)
    let requesterName: string | null = null
    try {
      requesterName = (await recorded).requesterName
    } catch (err) {
      this.pendingApprovals.delete(id)
      this.clearSubsessionWait(entry)
      this.syncApprovalActivity(p.hostKey, sessionId, { id })
      this.recordedWrites.delete(id)
      resolveResult({ outcome: { outcome: 'cancelled' } })
      await wait
      throw err
    }
    this.recordedWrites.delete(id)
    if (route) this.dispatchSubsessionApproval(id, agentId, p, route, requesterName)
    else this.dispatchApprovalDm(id, agentId, p, requesterName, askerFirst)
    return wait
  }

  private async awaitEditorElicitation(
    agentId: string,
    sessionId: string,
    params: CreateElicitationRequest,
    p: Pending,
    choices: ApprovalChoice<CreateElicitationResponse>[] | undefined,
    route?: SubsessionApprovalRoute,
    askerFirst = false
  ): Promise<CreateElicitationResponse> {
    const id = randomUUID()
    let resolveResult!: (res: CreateElicitationResponse) => void
    const result = new Promise<CreateElicitationResponse>((resolve) => (resolveResult = resolve))
    const parts = this.elicitationParts(agentId, params, p)
    const entry: ElicitationApproval = {
      kind: 'elicitation',
      chatScope: this.chatScope(p),
      owner: p.hostKey,
      agentId,
      sessionId,
      askedAt: this.host.clock().now(),
      params,
      ...(choices ? { choices } : {}),
      parts,
      resolve: resolveResult
    }
    this.pendingApprovals.set(id, entry)
    this.observeEditorPermission(p, id, parts, result, (value) => ({
      outcome: value.action === 'accept' ? 'allowed' : value.action === 'decline' ? 'denied' : 'cancelled'
    }))
    if (route) this.armSubsessionWait(id, entry, p, route, parts)
    this.syncApprovalActivity(p.hostKey, sessionId)
    const wait = this.trackHumanApprovalWait(p, result)
    // A sub-session's turn was started by the agent itself, so the agent is who asks.
    const recorded = this.noteEditorPermissionRequest(id, agentId, sessionId, parts, p, !route, route && agentAsker(p))
    this.recordedWrites.set(id, recorded)
    let requesterName: string | null = null
    try {
      requesterName = (await recorded).requesterName
    } catch (err) {
      this.pendingApprovals.delete(id)
      this.clearSubsessionWait(entry)
      this.syncApprovalActivity(p.hostKey, sessionId, { id })
      this.recordedWrites.delete(id)
      resolveResult({ action: 'cancel' })
      await wait
      throw err
    }
    this.recordedWrites.delete(id)
    if (route) this.dispatchSubsessionApproval(id, agentId, p, route, requesterName)
    else this.dispatchApprovalDm(id, agentId, p, requesterName, askerFirst)
    return wait
  }

  private async awaitChatPermission(
    agentId: string,
    sessionId: string,
    params: RequestPermissionRequest,
    evaluationParams: RequestPermissionRequest,
    p: Pending,
    facet: ApprovalCardFacet
  ): Promise<RequestPermissionResponse> {
    const requestId = randomUUID()
    let resolveResult!: (res: RequestPermissionResponse) => void
    const result = new Promise<RequestPermissionResponse>((resolve) => (resolveResult = resolve))
    const thread = p.plan.thread ? { thread: p.plan.thread } : {}
    const chat: ChatPermissionCard = {
      facet,
      conn: chatOut(p),
      // Where the card lands, which is not always the turn's channel (a Discord thread).
      channel: facet.cardChannel?.({ channel: p.plan.channel, ...thread }) ?? p.plan.channel,
      ...thread,
      place: { integrationId: p.plan.integrationId, channel: p.plan.channel }
    }
    this.pendingApprovals.set(requestId, {
      kind: 'permission',
      chatScope: this.chatScope(p),
      owner: p.hostKey,
      agentId,
      sessionId,
      askedAt: this.host.clock().now(),
      params,
      evaluationParams,
      chat,
      resolve: resolveResult
    })
    this.observeEditorPermission(p, requestId, permissionRequestParts(params, p.knownToolCalls), result, (value) =>
      this.permissionResult(value, params)
    )
    this.syncApprovalActivity(p.hostKey, sessionId)
    const recorded = this.noteEditorPermissionRequest(
      requestId,
      agentId,
      sessionId,
      permissionRequestParts(params, p.knownToolCalls),
      p,
      false
    )
    this.recordedWrites.set(requestId, recorded)
    let requesterName: string | null
    try {
      requesterName = (await recorded).requesterName
    } catch (err) {
      this.pendingApprovals.delete(requestId)
      this.syncApprovalActivity(p.hostKey, sessionId, { id: requestId })
      this.recordedWrites.delete(requestId)
      resolveResult({ outcome: { outcome: 'cancelled' } })
      throw err
    }
    this.recordedWrites.delete(requestId)
    // Settled while the row was being written: never post a card for a request already resolved.
    if (!this.pendingApprovals.has(requestId)) return await result
    const via = p.plan.integrationId ? { via: { agentId, integrationId: p.plan.integrationId } } : {}
    const draft = facet.build(
      { requestId, params, sessionTarget: this.host.httpSlackSessionTarget(p), ...via },
      chat.conn
    )
    // The gate above admits only a list this card can offer whole; a null card is treated as never posting, not trusted away.
    const ts = draft ? await facet.send(this.elicitCardHost, p, draft) : undefined
    const live = this.approvalAt(requestId)
    if (!live) {
      // Settled while it posted: it says how, unless a click that beat the post already rewrote it.
      if (ts && chat.settledFirst) facet.rewrite({ ...chat, ts }, chat.settledFirst)
      return await result
    }
    if (!ts) {
      this.pendingApprovals.delete(requestId)
      this.syncApprovalActivity(p.hostKey, sessionId, { id: requestId })
      await this.resolveStoredPermissionRequest(agentId, requestId, 'expired')
      this.permissionEvaluationDetails.set(evaluationParams, { reason: 'permission_card_failed' })
      resolveResult({ outcome: { outcome: 'cancelled' } })
      return await result
    }
    chat.ts = ts
    // Approving in chat was turned off while it posted: retire it as the switch retired the others.
    if (!chatApprovalsAllowed(this.host.agents().get(agentId))) this.retireChatApprovalsOffCard(live)
    else {
      const editorsOnly = this.host.chatEditorsOnly(agentId, p.plan.integrationId)
      if (editorsOnly || this.computerAskOf(requestId))
        void this.dmBesideCard(requestId, agentId, p, requesterName, editorsOnly).catch((err) => {
          this.host.log().warn(`approval DM beside the card for "${p.plan.sessionKey}" failed: ${formatErr(err)}`)
        })
    }
    return await this.trackHumanApprovalWait(p, result)
  }

  /** Ask a person behind the turn before the bot joins a public channel (#2979); `offered` names whom and the turn's thread once a card is up, and the answer may come after the turn ended. */
  async askToJoin(p: Pending, ask: JoinAsk, waitMs: number, offered: JoinOffered): Promise<JoinAnswer> {
    const { hostKey: owner, acpSessionId: sessionId } = p
    const agentId = hostKeyAgentId(owner)
    // A check never asks (assistant-mode.md §5.12).
    if (!this.turnStillLive(owner, sessionId, p) || isCheckCoordinate(p.plan.sessionThread))
      return { outcome: 'unavailable' }
    const requestId = randomUUID()
    const webchat = p.webchat !== undefined && !p.webchat.continuation
    const facet = webchat ? undefined : this.joinCardFacet(agentId, p)
    const dm = webchat || facet ? undefined : await this.joinDm(agentId, requestId, ask.askers)
    if ((!webchat && !facet && !dm) || !this.turnStillLive(owner, sessionId, p)) return { outcome: 'unavailable' }
    const params = joinRequestParams(sessionId, p.plan.agentName, ask)
    let resolveResult!: (res: RequestPermissionResponse) => void
    const result = new Promise<RequestPermissionResponse>((resolve) => (resolveResult = resolve))
    const join: JoinWait = { ...ask }
    const entry: PermissionApproval = {
      kind: 'permission',
      owner,
      agentId,
      sessionId,
      askedAt: this.host.clock().now(),
      params,
      evaluationParams: params,
      join,
      resolve: resolveResult
    }
    this.pendingApprovals.set(requestId, entry)
    // The asking turn's thread, where its session hears the outcome even after a restart.
    const thread = p.plan.thread
    const stored: StoredJoinAsk = {
      name: ask.name,
      purpose: ask.purpose,
      ...(ask.tool ? { tool: ask.tool } : {}),
      ...(thread !== undefined ? { thread } : {})
    }
    const recorded = this.noteEditorPermissionRequest(
      requestId,
      agentId,
      sessionId,
      permissionRequestParts(params, p.knownToolCalls),
      p,
      false,
      undefined,
      stored
    )
    this.recordedWrites.set(requestId, recorded)
    let requesterName: string | null
    try {
      requesterName = (await recorded).requesterName
    } catch (err) {
      this.pendingApprovals.delete(requestId)
      throw err
    } finally {
      this.recordedWrites.delete(requestId)
    }
    if (this.pendingApprovals.get(requestId) === entry) {
      join.timer = this.host.clock().setTimeout(() => {
        void this.expireJoinAsk(requestId, entry).catch((err) =>
          this.host.log().warn(`join confirmation for "${p.plan.sessionKey}" did not settle: ${formatErr(err)}`)
        )
      }, waitMs)
      const posted = webchat
        ? this.noticeWebchatJoin(p, params)
        : facet
          ? await this.postJoinCard(requestId, entry, p, facet)
          : dm !== undefined &&
            (await this.sendApprovalDm(requestId, agentId, p, requesterName, undefined, dm).then(
              () => entry.notify !== undefined || this.pendingApprovals.get(requestId) !== entry,
              (err: unknown) => {
                this.host.log().warn(`join confirmation DM for "${p.plan.sessionKey}" failed: ${formatErr(err)}`)
                return false
              }
            ))
      if (!posted) await this.abandonJoinAsk(requestId, entry)
      else offered(dm?.target.displayName ?? requesterName, thread)
    }
    const res = await result
    const by = join.answeredBy ? { by: join.answeredBy } : {}
    if (res.outcome.outcome === 'selected')
      return { outcome: res.outcome.optionId === JOIN_OPTION ? 'join' : 'declined', ...by }
    return { outcome: join.ended ?? 'unavailable' }
  }

  /** The turn's own card surface for a join confirmation: an open conversation it can post in, never a sub-session's. */
  private joinCardFacet(agentId: string, p: Pending): ApprovalCardFacet | undefined {
    if (isSubsessionCoordinate(p.plan.sessionThread) || p.plan.approvalSurfaceSuppressed || !chatOut(p))
      return undefined
    const facet = this.host.approvalCardFacet(p.plan.platform)
    if (!facet) return undefined
    // An external place gets no card naming another channel: it goes to the person's DM instead.
    const surface = this.host.chatSurface(
      agentId,
      p.plan.integrationId,
      p.plan.channel,
      p.entry.msg.externallyShared === true
    )
    return surface === 'open' ? facet : undefined
  }

  /** The first person behind the turn a DM card reaches. */
  private async joinDm(
    agentId: string,
    requestId: string,
    askers: readonly ReadAsker[]
  ): Promise<{ target: DmTarget; channel: string } | undefined> {
    for (const asker of askers) {
      const dm = await this.host.personDm?.(agentId, requestId, asker).catch(() => undefined)
      if (dm) return dm
    }
    return undefined
  }

  /** Post the join card in the turn's own conversation, its handle kept on the row so a restart's sweep retires it. */
  private async postJoinCard(
    requestId: string,
    rec: PermissionApproval,
    p: Pending,
    facet: ApprovalCardFacet
  ): Promise<boolean> {
    const thread = p.plan.thread ? { thread: p.plan.thread } : {}
    const chat: ChatPermissionCard = {
      facet,
      conn: chatOut(p),
      channel: facet.cardChannel?.({ channel: p.plan.channel, ...thread }) ?? p.plan.channel,
      ...thread,
      place: { integrationId: p.plan.integrationId, channel: p.plan.channel }
    }
    rec.chat = chat
    const via = p.plan.integrationId ? { via: { agentId: rec.agentId, integrationId: p.plan.integrationId } } : {}
    const draft = facet.build(
      { requestId, params: rec.params, sessionTarget: this.host.httpSlackSessionTarget(p), ...via },
      chat.conn
    )
    const ts = draft ? await facet.send(this.elicitCardHost, p, draft).catch(() => undefined) : undefined
    if (!ts) return this.pendingApprovals.get(requestId) !== rec
    chat.ts = ts
    if (this.pendingApprovals.get(requestId) !== rec) {
      if (chat.settledFirst) facet.rewrite(chat, chat.settledFirst)
      return true
    }
    const integrationId = p.plan.integrationId
    const stored =
      integrationId !== undefined &&
      (await this.host
        .store()
        .setPermissionRequestNotify(rec.agentId, requestId, integrationId, chat.channel, ts)
        .catch(() => false))
    if (stored && this.pendingApprovals.get(requestId) === rec) chat.stored = { agentId: rec.agentId, requestId }
    else if (stored)
      void this.host
        .store()
        .clearPermissionRequestNotify(rec.agentId, requestId)
        .catch(() => {})
    return true
  }

  /** A webchat conversation's people answer among its pending requests; its stream says where. */
  private noticeWebchatJoin(p: Pending, params: RequestPermissionRequest): boolean {
    const wc = p.webchat
    if (!wc) return false
    try {
      wc.sink.output({
        conversationId: wc.conversationId,
        turnId: wc.turnId,
        index: wc.index++,
        event: {
          kind: 'message',
          text: `🔒 ${permToolLabel(params)} Answer it among this conversation’s pending requests.`
        }
      })
    } catch (err) {
      this.host.log().warn(`join confirmation notice failed for "${p.plan.sessionKey}": ${formatErr(err)}`)
    }
    return true
  }

  /** Nobody answered in time: the card says so and the call goes on without joining. */
  private async expireJoinAsk(id: string, rec: PermissionApproval): Promise<void> {
    if (this.pendingApprovals.get(id) !== rec || !rec.join) return
    if (!(await this.resolveStoredPermissionRequest(rec.agentId, id, 'expired'))) return
    if (this.pendingApprovals.get(id) !== rec) return
    this.pendingApprovals.delete(id)
    rec.join.ended = 'expired'
    this.retireApprovalCards(id, rec, JOIN_EXPIRED_TEXT, undefined, { kind: 'cancelled' })
    rec.resolve({ outcome: { outcome: 'cancelled' } })
  }

  /** No card reached anyone: the request ends unanswered and leaves nothing to sweep. */
  private async abandonJoinAsk(id: string, rec: PermissionApproval): Promise<void> {
    if (this.pendingApprovals.get(id) !== rec) return
    this.pendingApprovals.delete(id)
    this.clearJoinWait(rec)
    await this.resolveStoredPermissionRequest(rec.agentId, id, 'expired')
    rec.resolve({ outcome: { outcome: 'cancelled' } })
  }

  private clearJoinWait(rec: PendingRequest): void {
    if (rec.kind === 'permission' && rec.join?.timer) this.host.clock().clearTimeout(rec.join.timer)
  }

  /** Who answered a join card, and as which person behind the turn: a chat member there, or a console user by the account they linked; undefined for anyone else. */
  private async joinCardAnswerer(
    requestId: string,
    rec: PermissionApproval & { join: JoinWait },
    chat: ChatPermissionCard,
    actor: InteractionActor
  ): Promise<{ by: Decider; asker: ReadAsker } | undefined> {
    const integrationId = chat.place.integrationId
    const named = async () => actor.name ?? (await this.cardMemberName(chat, actor.userId)) ?? null
    const decider = async (name?: string | null): Promise<Decider> => ({
      resolvedBy: cardAnswererId(chat, actor.userId),
      resolvedByName: name ?? (await named())
    })
    const member = rec.join.askers.find(
      (asker) => asker.kind === 'member' && asker.integrationId === integrationId && asker.userId === actor.userId
    )
    if (member) return { by: await decider(), asker: member }
    const linked = rec.join.linked?.find((l) => l.integrationId === integrationId && l.userId === actor.userId)
    if (linked) return { by: await decider(), asker: { kind: 'console', userId: linked.consoleUserId } }
    const cp = this.host.cpApprovalRoute()
    const teamId = chat.facet.answerScope?.(chat)
    if (!cp || !teamId || !integrationId) return undefined
    for (const asker of rec.join.askers) {
      if (asker.kind !== 'console') continue
      const verified = await cp
        .approvalRoute(
          {
            agentId: rec.agentId,
            requestId,
            integrationIds: [integrationId],
            verify: { integrationId, teamId, userId: actor.userId, consoleUserId: asker.userId }
          },
          this.host.orgForAgent(rec.agentId)
        )
        .catch(() => undefined)
      if (verified?.allowed === true) return { by: await decider(verified.displayName), asker }
    }
    return undefined
  }

  /** Where only editors may answer a card, an editor also gets it in their own chat unless the person who asked is one; the first answer decides. */
  private async dmEditorBeside(requestId: string, agentId: string, p: Pending, requesterName: string | null) {
    const asker = p.plan.requesterId
    // The asker as their own message named them, with the cross-app id a synced platform matches by.
    const sender = p.entry.msg.sender
    const memberId = sender?.id === asker ? sender.memberId : undefined
    const actor = asker ? { userId: asker, ...(memberId ? { memberId } : {}) } : undefined
    if (actor && (await this.host.chatActor(agentId, p.plan.integrationId, actor)) === 'allowed') return false
    if (!this.pendingApprovals.has(requestId)) return true
    await this.sendApprovalDm(requestId, agentId, p, requesterName, undefined, undefined, true)
    return true
  }

  /** The DMs beside a card: the Computer owner's for a computer-use approval (§4.2), else an editor's where only editors may answer. */
  private async dmBesideCard(
    requestId: string,
    agentId: string,
    p: Pending,
    requesterName: string | null,
    editorsOnly: boolean
  ): Promise<void> {
    if (this.computerAskOf(requestId)) await this.dmComputerOwnerBeside(requestId, agentId, p, requesterName)
    else if (editorsOnly) await this.dmEditorBeside(requestId, agentId, p, requesterName)
  }

  /** Say in the channel that a too-long option list was declined; every surface, the console included, shares the cap (#1969). */
  private noticePermissionOptionsUnrenderable(p: Pending, params: RequestPermissionRequest): void {
    // The webchat copy joins the agent's Markdown reply; a chat copy is read as its surface's notice markup.
    const notice = (markup?: NoticeMarkup) =>
      `:lock: The agent asked for permission to run ${defuseNoticeText(permToolLabel(params), markup)} with more options ` +
      `than any surface here can show (${params.options.length}), so it was declined. Nothing was allowed.`
    try {
      // Said on whichever surface this turn HAS, exactly as the editor path's own notice is: a
      // webchat turn hears it on its stream, every chat turn in its channel.
      if (p.webchat) {
        p.webchat.sink.output({
          conversationId: p.webchat.conversationId,
          turnId: p.webchat.turnId,
          index: p.webchat.index++,
          event: { kind: 'message', text: notice('markdown') }
        })
      }
      if ((!p.webchat || p.webchat.continuation) && chatOut(p))
        this.host.enqueueApply(p, { kind: 'notice', text: notice(turnChromeFor(p.plan.platform).noticeMarkup) })
    } catch (err) {
      this.host.log().warn(`permission option notice failed for "${p.plan.sessionKey}": ${formatErr(err)}`)
    }
  }

  /** Fire the best-effort §5 approval DM, to the asker first for an external place; never blocks or fails the approval. */
  private dispatchApprovalDm(
    requestId: string,
    agentId: string,
    p: Pending,
    requesterName: string | null,
    askerFirst = false
  ): void {
    void (async () => {
      const asker = askerFirst ? await this.host.externalAskerDm?.(p).catch(() => undefined) : undefined
      if (asker) {
        const approver = {
          target: { integrationId: asker.integrationId, teamId: asker.teamId, userId: asker.userId },
          channel: asker.channel,
          asker: { integrationId: p.plan.integrationId, channel: p.plan.channel }
        }
        await this.sendApprovalDm(requestId, agentId, p, requesterName, undefined, approver).catch((err) => {
          this.host.log().warn(`asker approval DM for "${p.plan.sessionKey}" failed: ${formatErr(err)}`)
        })
        // An asker's DM that did not land leaves the request to the editor path.
        const rec = this.approvalAt(requestId)
        if (!rec || rec.notify) return
      } else if (askerFirst && (await this.sendAskerCard(requestId, agentId, p).catch(() => false))) return
      await this.sendApprovalDm(requestId, agentId, p, requesterName)
    })().catch((err) => {
      this.host.log().warn(`approval DM for "${p.plan.sessionKey}" failed: ${formatErr(err)}`)
    })
  }

  private async sendApprovalDm(
    requestId: string,
    agentId: string,
    p: Pending,
    requesterName: string | null,
    subsession?: SubsessionApprovalRoute,
    approver?: { target: DmTarget; channel: string; asker?: ChatPlace },
    beside = false
  ): Promise<void> {
    const target = approver?.target ?? (await this.routeApprovalDm(requestId, agentId, p, subsession !== undefined))
    if (!target) return
    const rec = this.approvalAt(requestId)
    if (!rec) return
    const conn = this.host.slackConnFor(target.integrationId)
    if (!conn) {
      // Off Slack the chosen editor's card goes through their platform's own facet, beside the conversation's card if one is up.
      if (!approver) await this.sendEditorCard(requestId, agentId, p, target, requesterName)
      return
    }
    const channel = approver?.channel ?? (await conn.openDirectMessage(target.userId))
    const sessionTarget = this.host.slackDmSessionTarget(p, target.integrationId)
    // A question this DM has no control for still gets its own block: the reader is handed the
    // ask and the console, never an intro with nothing under it (#1794). The request itself is
    // untouched — it stays open on the editor path, which is where the DM points.
    const card =
      rec.kind === 'permission'
        ? (buildPermissionCard(requestId, rec.params, sessionTarget) ?? buildPermissionDmUnanswerableCard(rec.params))
        : (buildElicitationCard(requestId, rec.params, sessionTarget, SLACK_DM_ELICIT_SURFACE) ??
          buildElicitDmUnanswerableCard(rec.params))
    // A sub-session's turn came from no message anyone wrote: its DM names the sub-session instead (assistant-mode.md §5.6).
    const fromSlack = p.plan.platform === 'slack' && !subsession
    const sourceUrl =
      fromSlack && p.conn instanceof SlackConnection
        ? slackThreadUrl(p.conn.workspaceUrl, p.plan.channel, p.plan.thread ?? p.plan.statusThread)
        : undefined
    // Quote the triggering message only for its own author (§5.2): routing proves canEdit, not that the recipient may read the source.
    const sourceText =
      fromSlack && target.integrationId === p.plan.integrationId && target.userId === p.plan.requesterId
        ? p.entry.msg.text
        : undefined
    const intro = buildApprovalDmIntro({
      agentName: p.plan.agentName,
      requesterName,
      sessionUrl: this.host.sessionLink(p.outwardSessionId, 'slack'),
      ...(sourceUrl ? { sourceUrl } : {}),
      ...(sourceText ? { sourceText } : {}),
      ...(subsession ? { subsession: { title: subsession.title, waitHours: subsession.waitHours } } : {})
    })
    const ts = await conn.postBlocks(
      channel,
      [...intro, ...card],
      `Approval requested by ${p.plan.agentName}`,
      undefined,
      {
        ...(slackAgentIdentityOptions(p.plan) ?? {}),
        chrome: true
      }
    )
    if (!ts) return
    // Beside a card that keeps the notify handle, the DM keeps its own, so a restart's sweep retires both.
    const store = this.host.store()
    const handleStored = beside
      ? await store.setPermissionRequestBeside(agentId, requestId, target.integrationId, channel, ts)
      : await store.setPermissionRequestNotify(agentId, requestId, target.integrationId, channel, ts)
    // Re-read AFTER the write: a decision landing inside that await saw no `notify`, so
    // it neither rewrote this card nor cleared the handle — both fall to us here.
    const live = this.approvalAt(requestId)
    if (!handleStored || !live) {
      // Settled while posting: never leave live buttons on a decided request.
      const resolved =
        rec.kind === 'permission'
          ? buildPermissionResolvedCard(rec.params, 'Already decided', undefined)
          : buildElicitationResolvedCard(rec.params, ':hourglass: Already decided')
      void conn.updateBlocks(channel, ts, [...intro, ...resolved], 'Permission resolved', true).catch(() => {})
      if (handleStored) void this.clearDmHandle(agentId, requestId, beside)
      return
    }
    const elicit = rec.kind === 'elicitation' ? elicitTarget(rec.params, SLACK_DM_ELICIT_SURFACE) : null
    live.notify = {
      target,
      conn,
      channel,
      ts,
      intro,
      ...(elicit ? { propName: elicit.propName, valueKind: elicit.kind } : {}),
      ...(approver?.asker ? { asker: approver.asker } : {}),
      ...(beside ? { beside: true as const } : {})
    }
  }

  /** The asker's card in their own DM through their platform's facet, where no Slack DM card reaches them (§5.5); true once it is live. */
  private async sendAskerCard(requestId: string, agentId: string, p: Pending): Promise<boolean> {
    const rec = this.approvalAt(requestId)
    // An MCP approval with no choices has no card to send; it goes on to the editor path.
    if (!rec || rec.chat || rec.notify || !cardRequest(rec)) return false
    const dm = await this.host.askerDirectMessage?.(p).catch(() => undefined)
    return dm ? await this.sendDirectCard(requestId, agentId, p, dm, { askerId: dm.userId }) : false
  }

  /** The chosen editor's card in their own chat through their platform's facet (§5); true once it is live. */
  private async sendEditorCard(
    requestId: string,
    agentId: string,
    p: Pending,
    target: DmTarget,
    requesterName: string | null
  ): Promise<boolean> {
    const rec = this.approvalAt(requestId)
    if (!rec || rec.notify) return false
    if (rec.kind === 'permission' ? rec.beside || rec.chat?.editor || rec.chat?.askerId : rec.chat) return false
    const channel = await this.host.directMessageAt?.(target.integrationId, target.userId).catch(() => undefined)
    if (!channel) return false
    const dm = { integrationId: target.integrationId, channel }
    return await this.sendDirectCard(
      requestId,
      agentId,
      p,
      dm,
      { editor: target, requesterName },
      rec.kind === 'permission' && rec.chat !== undefined
    )
  }

  /** Post a permission card into one person's own chat, answered by them alone as the asker or the routed editor; true once it is live. */
  private async sendDirectCard(
    requestId: string,
    agentId: string,
    p: Pending,
    dm: { integrationId: string; channel: string },
    who: { askerId: string } | { editor: DmTarget; requesterName: string | null },
    beside = false
  ): Promise<boolean> {
    const rec = this.approvalAt(requestId)
    if (!rec || rec.notify || (rec.kind === 'permission' && rec.beside) || (rec.chat !== undefined) !== beside)
      return false
    const params = cardRequest(rec)
    const cards = this.host.chatCardsAt(dm.integrationId)
    if (!params || !cards || params.options.length > cards.facet.maxOptions) return false
    const { facet, conn } = cards
    const context: ApprovalCardContext | undefined =
      'editor' in who
        ? {
            agentName: p.plan.agentName,
            requesterName: who.requesterName,
            sessionUrl: this.host.sessionLink(p.outwardSessionId, sessionLinkSourceFor(facet.platform))
          }
        : undefined
    const draft = facet.build(
      {
        requestId,
        params,
        sessionTarget: this.host.slackDmSessionTarget(p, dm.integrationId),
        via: { agentId, integrationId: dm.integrationId },
        ...(context ? { context } : {})
      },
      conn
    )
    const where: ApprovalCardPlace = { channel: dm.channel }
    const landed: ApprovalCardHandle = { conn, ...where, channel: facet.cardChannel?.(where) ?? dm.channel }
    const ts = draft
      ? await facet.post(conn, where, draft, p).catch((err: unknown) => {
          this.host.log().warn(`approval card in a direct chat for "${p.plan.sessionKey}" failed: ${formatErr(err)}`)
          return undefined
        })
      : undefined
    if (!ts) return false
    // Kept on the row as well, so the sweep after a restart retires a card no resolver answers any more.
    const store = this.host.store()
    const stored = beside
      ? await store.setPermissionRequestBeside(agentId, requestId, dm.integrationId, landed.channel, ts)
      : await store.setPermissionRequestNotify(agentId, requestId, dm.integrationId, landed.channel, ts)
    if (!stored || this.pendingApprovals.get(requestId) !== rec) {
      facet.rewrite(
        { ...landed, ts },
        facet.settled({
          params,
          ...(context ? { context } : {}),
          text: 'Already decided',
          fallback: 'Permission resolved'
        })
      )
      if (stored) void this.clearDmHandle(agentId, requestId, beside)
      return true
    }
    const card: ChatPermissionCard = {
      facet,
      ...landed,
      ts,
      place: { integrationId: p.plan.integrationId, channel: p.plan.channel },
      routedVia: dm.integrationId,
      ...('editor' in who ? { editor: who.editor, ...(context ? { context } : {}) } : { askerId: who.askerId })
    }
    if (beside && rec.kind === 'permission') rec.beside = card
    else rec.chat = { ...card, stored: { agentId, requestId } }
    return true
  }

  /** Drop a DM card's stored handle once it says how its request ended; a DM beside a card keeps its own. */
  private async clearDmHandle(agentId: string, requestId: string, beside: boolean | undefined): Promise<void> {
    const store = this.host.store()
    await (
      beside
        ? store.clearPermissionRequestBeside(agentId, requestId)
        : store.clearPermissionRequestNotify(agentId, requestId)
    ).catch(() => {})
  }

  /** The editor the CP's chain (§3) picks for a DM, or nobody; a sub-session's turn has no requester to start it from. */
  private async routeApprovalDm(
    requestId: string,
    agentId: string,
    p: Pending,
    subsession: boolean
  ): Promise<ApprovalRouteTarget | undefined> {
    const cp = this.host.cpApprovalRoute()
    if (!cp) return undefined
    // A permission request may also go to an editor's card off Slack, alone or beside the conversation's, as may an MCP approval with choices; Slack's own integration stays first.
    const rec = this.approvalAt(requestId)
    const cards =
      !!rec &&
      !rec.notify &&
      (rec.kind === 'permission'
        ? !rec.beside && !rec.chat?.editor && !rec.chat?.askerId
        : !rec.chat && rec.choices !== undefined)
    const preferred = this.host.slackConnFor(p.plan.integrationId ?? '') ? p.plan.integrationId : undefined
    const integrationIds = this.host.approvalDmIntegrations(agentId, preferred, cards)
    if (integrationIds.length === 0) return undefined
    // A computer-use approval, a sub-session's too, goes to the Computer's owner first (computer-use.md §4.2), else down the chain of its allowed members.
    const computer = this.computerAskOf(requestId)
    if (computer?.ownerUserId) {
      const routed = await cp.approvalRoute(
        { agentId, requestId, consoleUserId: computer.ownerUserId, integrationIds, ...this.computerRoute(computer) },
        this.host.orgForAgent(agentId)
      )
      if (routed.target) return routed.target
    }
    // The person behind the turn, as a member of its own integration where the chain can match them.
    const requesterId =
      p.plan.requesterId && !subsession && p.plan.integrationId && integrationIds.includes(p.plan.integrationId)
        ? p.plan.requesterId
        : undefined
    const routed = await cp.approvalRoute(
      {
        agentId,
        requestId,
        sessionId: p.outwardSessionId,
        ...(requesterId ? { requesterId } : {}),
        integrationIds,
        ...this.computerRoute(computer)
      },
      this.host.orgForAgent(agentId)
    )
    if (!routed.target)
      this.host
        .log()
        .info(
          `approval DM for "${p.plan.sessionKey}" not sent: the control plane found no editor on the ${integrationIds.length} integration(s) offered`
        )
    return routed.target
  }

  /** Deliver a background sub-session's request to the conversation it belongs to (assistant-mode.md §5.6); never blocks or fails it. */
  private dispatchSubsessionApproval(
    requestId: string,
    agentId: string,
    p: Pending,
    route: SubsessionApprovalRoute,
    requesterName: string | null
  ): void {
    void this.deliverSubsessionApproval(requestId, agentId, p, route, requesterName).catch((err) => {
      this.host.log().warn(`sub-session approval for "${p.plan.sessionKey}" was not delivered: ${formatErr(err)}`)
    })
  }

  /** The conversation's own path: its in-chat card where anyone there may answer, else its notice plus the editor DM; an external place's goes to the approver drafts go to. */
  private async deliverSubsessionApproval(
    requestId: string,
    agentId: string,
    p: Pending,
    route: SubsessionApprovalRoute,
    requesterName: string | null
  ): Promise<void> {
    const editorDm = (beside = false) =>
      this.sendApprovalDm(requestId, agentId, p, requesterName, route, undefined, beside)
    const place = route.place
    if (place.kind !== 'chat') return await editorDm()
    const at: { integrationId: string; channel: string; thread?: string } = place
    const computer = this.computerAskOf(requestId)
    if (place.external) {
      // A card is output too, so an external place gets none (§5.5): the responsible user's DM, else an editor's; a computer-use approval's goes the Computer's route.
      const approver = computer
        ? undefined
        : await this.host.assistantApprover?.(agentId, requestId).catch(() => undefined)
      return approver
        ? await this.sendApprovalDm(requestId, agentId, p, requesterName, route, approver)
        : await editorDm()
    }
    const rec = this.approvalAt(requestId)
    const cards = this.host.chatCardsAt(at.integrationId)
    if (!rec) return
    if (!cards) return await editorDm()
    const { facet, conn } = cards
    const asker: SubsessionAsker = {
      agentName: p.plan.agentName,
      title: route.title,
      sessionUrl: this.host.sessionLink(p.outwardSessionId, sessionLinkSourceFor(facet.platform)),
      waitHours: route.waitHours
    }
    const where: ApprovalCardPlace = { channel: at.channel, ...(at.thread ? { thread: at.thread } : {}) }
    const landed: ApprovalCardHandle = { conn, ...where, channel: facet.cardChannel?.(where) ?? at.channel }
    // A failed post still leaves the editor DM to try.
    const post = (draft: ApprovalCardDraft) =>
      facet.post(conn, where, draft, p).catch((err: unknown) => {
        this.host.log().warn(`sub-session approval post for "${p.plan.sessionKey}" failed: ${formatErr(err)}`)
        return undefined
      })
    const permission = rec.kind === 'permission' ? rec : undefined
    // A closed conversation gets the notice and the editor DM, as when people may only talk to the agent.
    const chatOn =
      chatApprovalsAllowed(this.host.agents().get(agentId)) &&
      this.host.chatSurface(agentId, at.integrationId, at.channel) === 'open'
    // The card goes where the conversation is, outside the sub-session, so its click comes home through this integration.
    const draft =
      chatOn && permission && permission.params.options.length <= facet.maxOptions
        ? facet.build(
            {
              requestId,
              params: permission.params,
              sessionTarget: this.host.slackDmSessionTarget(p, at.integrationId),
              via: { agentId, integrationId: at.integrationId },
              subsession: asker
            },
            conn
          )
        : null
    if (!permission || !draft) {
      const ts = await post(facet.notice(asker))
      if (ts) await this.keepNotice(requestId, rec, { facet, handle: { ...landed, ts }, view: asker }, at.integrationId)
      return await editorDm()
    }
    const ts = await post(draft)
    if (!ts) return await editorDm()
    // Kept on the row as well, so the sweep after a restart retires a card no resolver answers any more.
    const stored = await this.host
      .store()
      .setPermissionRequestNotify(agentId, requestId, at.integrationId, landed.channel, ts)
    const live = this.approvalAt(requestId)
    if (!stored || live !== permission) {
      const settled = { params: permission.params, subsession: asker, text: 'Already decided' }
      facet.rewrite({ ...landed, ts }, facet.settled({ ...settled, fallback: 'Permission resolved' }))
      if (stored)
        void this.host
          .store()
          .clearPermissionRequestNotify(agentId, requestId)
          .catch(() => {})
      return
    }
    permission.chat = {
      facet,
      ...landed,
      ts,
      place: { integrationId: at.integrationId, channel: at.channel },
      subsession: asker,
      routedVia: at.integrationId,
      stored: { agentId, requestId }
    }
    // Where only editors may answer the card, an editor is told in a DM too, on a handle of its own; a computer-use card's goes to the Computer's owner.
    if (computer || this.host.chatEditorsOnly(agentId, at.integrationId)) await editorDm(true)
  }

  /** Hold the notice's handle until its request settles, on the row too; a request settled while it posted gets its settled line now. */
  private async keepNotice(
    requestId: string,
    rec: PendingApproval,
    notice: NeutralNotice & { handle: { ts: string } },
    integrationId: string
  ): Promise<void> {
    const store = this.host.store()
    const { channel, ts } = notice.handle
    const kind = notice.view ? undefined : 'turn'
    const stored = await store
      .setPermissionRequestNotice(rec.agentId, requestId, integrationId, channel, ts, kind)
      .catch(() => false)
    // Still listed, a decision in flight included: whichever path settles it rewrites the notice.
    if (this.pendingApprovals.get(requestId) === rec) {
      rec.notice = notice
      return
    }
    // Only a turn's release awaits between unlisting and settling, and it settles as cancelled.
    this.settleNotice(notice, rec.settled ?? { kind: 'cancelled' })
    if (stored) void store.clearPermissionRequestNotice(rec.agentId, requestId).catch(() => {})
  }

  private settleNotice(notice: NeutralNotice, outcome: SubsessionNoticeOutcome): void {
    const { facet, view } = notice
    const named = notice.anonymous && 'by' in outcome ? { ...outcome, by: null } : outcome
    facet.rewrite(notice.handle, view ? facet.noticeSettled(view, outcome) : facet.turnNoticeSettled(named))
  }

  /** Rewrite the cards whose rows settled while no process could edit them (a restart): the reconnect sweep (slack-approval-dm.md §5.4). */
  async retireOrphanedCards(integrationId: string): Promise<void> {
    const cards = this.host.chatCardsAt(integrationId)
    if (!cards) return
    for (const row of await this.host.store().takeOrphanedPermissionNotices(integrationId)) {
      const handle = { conn: cards.conn, channel: row.notifyChannel, ts: row.notifyTs }
      cards.facet.rewrite(handle, cards.facet.orphaned(row))
      // A join card the restart left pending did nothing: its session is told so, as after a timeout.
      const join = row.status === 'expired' ? parseStoredJoinAsk(row.joinAsk) : undefined
      if (join) this.host.joinCardExpired?.(row.agentId, row.sessionId, join)
    }
  }

  /** Settle neutral notices whose requests ended while no process could edit them (a restart): the reconnect sweep's half for §5.6. */
  async retireOrphanedSubsessionNotices(integrationId: string): Promise<void> {
    const cards = this.host.chatCardsAt(integrationId)
    if (!cards) return
    const store = this.host.store()
    for (const row of await store.takeOrphanedSubsessionNotices(integrationId)) {
      const outcome: SubsessionNoticeOutcome =
        row.status === 'allowed' || row.status === 'denied' ? { kind: row.status, by: null } : { kind: 'cancelled' }
      const handle = { conn: cards.conn, channel: row.noticeChannel, ts: row.noticeTs }
      if (row.noticeKind === 'turn') {
        cards.facet.rewrite(handle, cards.facet.turnNoticeSettled(outcome))
        continue
      }
      const agent = this.host.agents().get(row.agentId)
      const session = await store.getSessionByAcpIdForAgent(row.agentId, row.sessionId).catch(() => undefined)
      const source = sessionLinkSourceFor(cards.facet.platform)
      const view: SubsessionNoticeView = {
        agentName: agent?.displayName?.trim() || agent?.name || row.agentId,
        title: subsessionLabel(session?.title, undefined),
        ...(session?.sessionId ? { sessionUrl: this.host.sessionLink(session.sessionId, source) } : {})
      }
      cards.facet.rewrite(handle, cards.facet.noticeSettled(view, outcome))
    }
  }

  /** Whether this request's card was posted outside its session's conversation via `integrationId` (a DM, §5.3, or a sub-session's card in its conversation), so a relayed click is authorized by the card's own checks. */
  dmNotifiedVia(requestId: string, agentId: string, integrationId: string): boolean {
    const rec = this.approvalAt(requestId)
    if (rec?.agentId !== agentId) return false
    return (
      rec.notify?.target.integrationId === integrationId ||
      rec.chat?.routedVia === integrationId ||
      (rec.kind === 'permission' && rec.beside?.routedVia === integrationId)
    )
  }

  /** Whether a chat-side answer is still taken: the level allows it and its conversation is open, or external for the asker's own card. */
  private chatAnswerOpen(agentId: string, place: ChatPlace, askerCard = false): boolean {
    if (!chatApprovalsAllowed(this.host.agents().get(agentId))) return false
    const surface = this.host.chatSurface(agentId, place.integrationId, place.channel)
    return surface === 'open' || (askerCard && surface === 'external')
  }

  /** This person's chat-side answer: closed by the level or the conversation, else judged by who they are where permissions are synced. */
  private async chatAnswerVerdict(
    agentId: string,
    place: ChatPlace,
    actor: InteractionActor | undefined,
    askerCard = false
  ): Promise<ChatActorVerdict | 'closed'> {
    if (!this.chatAnswerOpen(agentId, place, askerCard)) return 'closed'
    return await this.host.chatActor(agentId, place.integrationId, actor)
  }

  /** What a refused chat-side answer on a card's surface is told, within its limit; a synced platform's refusal names no console link. */
  private chatRefusal(
    rec: { owner: HostKey; sessionId: string },
    why: ApprovalRefusal,
    surface: { platform: string; privateTextLimit?: number }
  ): string {
    const link = why === 'closed' ? this.approvalConsoleLink(rec, surface.platform) : undefined
    return approvalRefusalText(why, link, surface.privateTextLimit)
  }

  /** §6.3 click-time checks, failing closed: actor equality, then the asker's place or the CP verify; `authoritative` marks a rights answer. */
  private async verifyDmActor(
    agentId: string,
    requestId: string,
    notify: DmNotice,
    actor: InteractionActor | undefined
  ): Promise<{ ok: true; name: string | null } | { ok: false; authoritative: boolean }> {
    if (!actor || actor.isBot || actor.userId !== notify.target.userId) return { ok: false, authoritative: false }
    // A join confirmation's DM went to a person behind the turn; one routed by their chat account needs no console recheck.
    const asked = this.approvalAt(requestId)
    if (asked?.kind === 'permission' && asked.join && !notify.target.consoleUserId)
      return { ok: true, name: actor.name ?? null }
    if (notify.asker) {
      const computer = this.host.servesComputerApprovers() ? this.computerAskOf(requestId) : undefined
      const verdict = !computer
        ? await this.chatAnswerVerdict(agentId, notify.asker, actor, true)
        : this.chatAnswerOpen(agentId, notify.asker, true)
          ? await this.host.computerActor(agentId, notify.asker.integrationId, computer.computerId, actor)
          : 'closed'
      if (verdict === 'allowed') return { ok: true, name: actor.name ?? null }
      return { ok: false, authoritative: verdict !== 'unavailable' }
    }
    return await this.verifyEditor(agentId, requestId, notify.target, actor)
  }

  /** The control plane's recheck of a routed editor's click (§6.3): still an editor, still linked to the account that clicked. */
  private async verifyEditor(
    agentId: string,
    requestId: string,
    target: DmTarget,
    actor: InteractionActor | undefined
  ): Promise<{ ok: true; name: string | null } | { ok: false; authoritative: boolean }> {
    const cp = this.host.cpApprovalRoute()
    const consoleUserId = target.consoleUserId
    if (!actor || actor.isBot || actor.userId !== target.userId || !cp || !consoleUserId)
      return { ok: false, authoritative: false }
    try {
      const res = await cp.approvalRoute(
        {
          agentId,
          requestId,
          integrationIds: [target.integrationId],
          verify: { integrationId: target.integrationId, teamId: target.teamId, userId: actor.userId, consoleUserId },
          ...this.computerRoute(this.computerAskOf(requestId))
        },
        this.host.orgForAgent(agentId)
      )
      return res.allowed === true
        ? { ok: true, name: res.displayName ?? target.displayName ?? actor.name ?? null }
        : { ok: false, authoritative: true }
    } catch {
      return { ok: false, authoritative: false }
    }
  }

  private dmDecider(notify: DmNotice, name: string | null): Decider {
    return { resolvedBy: `slack:${notify.target.teamId}:${notify.target.userId}`, resolvedByName: name }
  }

  /** Settle one request exactly once from any surface, which has already authorized the actor and re-derived the choice (§11.1). */
  private async settle<R>(
    id: string,
    rec: PendingRequest & { resolve: (res: R) => void },
    picked: PickedChoice<R> & { card?: CardAnswer },
    by: Decider | undefined,
    surface: 'console' | 'chat' | 'dm',
    actor?: InteractionActor,
    answeredBy?: ReadAsker
  ): Promise<boolean> {
    if (rec.kind !== 'question') {
      const status = picked.allow ? 'allowed' : 'denied'
      if (!(await this.resolveStoredPermissionRequest(rec.agentId, id, status, by))) return false
    }
    // The record is the in-memory compare-and-swap, and all a question has: nothing awaits between this and the delete.
    if (this.pendingApprovals.get(id) !== rec) return false
    // Only the answer that won the row speaks for the join's continuation; one that lost touches nothing.
    if (rec.kind === 'permission' && rec.join && answeredBy) rec.join.answeredBy = answeredBy
    // Only now is this answer the decision: the surface admitted it, the choice was real, and the row resolved.
    if (actor && rec.kind !== 'question')
      this.host.logSessionAction(`permission:${picked.allow ? 'allowed' : 'denied'}`, rec.sessionId, actor)
    this.pendingApprovals.delete(id)
    this.clearSubsessionWait(rec)
    this.clearJoinWait(rec)
    if (holdsTurn(rec)) this.syncApprovalActivity(rec.owner, rec.sessionId, { id, allowed: picked.allow })
    if (rec.kind === 'permission') {
      this.permissionEvaluationDetails.set(rec.evaluationParams, {
        reason: surface === 'chat' ? 'chat_user' : 'agent_editor'
      })
    }
    const name = by?.resolvedByName ?? (surface === 'console' ? 'an Agent editor' : null)
    const label = rec.kind === 'permission' && rec.join ? joinDecidedText(rec.join, picked.allow) : picked.label
    this.retireApprovalCards(
      id,
      rec,
      name ? `${label} — ${name}` : label,
      picked.allow,
      { kind: picked.allow ? 'allowed' : 'denied', by: name },
      picked.card
    )
    rec.resolve(picked.response)
    return true
  }

  /** Rewrite every card a request was offered on to its settled state; `allowed` is unset when nothing was decided. */
  private retireApprovalCards(
    id: string,
    rec: PendingRequest,
    label: string,
    allowed: boolean | undefined,
    outcome: SubsessionNoticeOutcome,
    answer?: CardAnswer
  ): void {
    rec.settled = outcome
    if (hasCard(rec)) this.retireElicitCard(id, rec, label, allowed, answer)
    if (rec.kind === 'question') return
    if (rec.notice) {
      this.settleNotice(rec.notice, outcome)
      void this.host
        .store()
        .clearPermissionRequestNotice(rec.agentId, id)
        .catch(() => {})
    }
    const fallback = allowed === undefined ? 'Permission cancelled' : 'Permission resolved'
    const params = cardRequest(rec)
    if (params)
      for (const chat of [rec.chat, rec.kind === 'permission' ? rec.beside : undefined]) {
        if (!chat) continue
        const settled = chat.facet.settled({
          params,
          ...(chat.subsession ? { subsession: chat.subsession } : {}),
          ...(chat.context ? { context: chat.context } : {}),
          text: label,
          ...(allowed !== undefined ? { allowed } : {}),
          fallback
        })
        // A card whose post has not returned is rewritten by its posting path, in these words.
        if (chat.ts === undefined) chat.settledFirst = settled
        else chat.facet.rewrite(chat, settled)
      }
    if (rec.chat?.ts) {
      if (rec.chat.stored)
        void this.host
          .store()
          .clearPermissionRequestNotify(rec.chat.stored.agentId, rec.chat.stored.requestId)
          .catch(() => {})
    }
    if (rec.kind === 'permission' && rec.beside) void this.clearDmHandle(rec.agentId, id, true)
    if (!rec.notify) return
    const mark = allowed === undefined ? ':hourglass:' : allowed ? ':white_check_mark:' : ':no_entry_sign:'
    const blocks =
      rec.kind === 'permission'
        ? buildPermissionResolvedCard(rec.params, label, allowed)
        : buildElicitationResolvedCard(rec.params, `${mark} ${label}`)
    void rec.notify.conn
      .updateBlocks(rec.notify.channel, rec.notify.ts, [...rec.notify.intro, ...blocks], fallback, true)
      .catch(() => {})
    void this.clearDmHandle(rec.agentId, id, rec.notify.beside)
  }

  /** Settle an elicitation's own card, its transcript row and webchat stream included; a consent card keeps its URL. */
  private retireElicitCard(
    id: string,
    rec: CardRequest,
    label: string,
    allowed: boolean | undefined,
    answer: CardAnswer | undefined
  ): void {
    const outcome = allowed === undefined ? 'cancelled' : allowed ? 'accepted' : 'dismissed'
    if (rec.card.url) {
      this.settleUrlElicit(rec, id, outcome)
      if (outcome === 'accepted') this.rememberConsentedUrlElicit(id, rec)
      return
    }
    this.settleElicitRow(rec, outcome, answer?.answered, answer?.answers)
    if (rec.card.surface === 'webchat') {
      this.emitWebchatElicitResolved(rec, rec.card, id, outcome, answer?.answered, answer?.answers)
      return
    }
    const settled: ElicitCardLabel =
      allowed === undefined
        ? ELICIT_CANCELLED
        : {
            mark: answer?.mark ?? (allowed ? 'answered' : 'dismissed'),
            text: label,
            fallback: answer?.fallback ?? 'Permission resolved'
          }
    this.settleChatCard(rec, rec.card, id, false, settled)
  }

  /** The DM surface's authorization (§6.3); a rights refusal retires the DM card, an outage leaves it live. */
  private async authorizeDm(
    requestId: string,
    rec: PendingApproval & { notify: DmNotice },
    actor: InteractionActor | undefined,
    attempt: string
  ): Promise<Decider | undefined> {
    const verdict = await this.verifyDmActor(rec.agentId, requestId, rec.notify, actor)
    if (verdict.ok) return this.dmDecider(rec.notify, verdict.name)
    this.host.logSessionAction(`permission:${attempt} (refused)`, rec.sessionId, actor)
    if (verdict.authoritative) {
      const blocks =
        rec.kind === 'permission'
          ? buildPermissionResolvedCard(
              rec.params,
              'No longer authorized — decide it from the Agent or Session page',
              undefined
            )
          : buildElicitationResolvedCard(rec.params, ':lock: No longer authorized — decide it from the console')
      void rec.notify.conn
        .updateBlocks(
          rec.notify.channel,
          rec.notify.ts,
          [...rec.notify.intro, ...blocks],
          'Permission requires an Agent editor',
          true
        )
        .catch(() => {})
    }
    return undefined
  }

  /** A DM elicitation card's tap, read as the one field that card rendered. */
  private dmElicitPick(
    rec: ElicitationApproval & { notify: DmNotice },
    value: string | null
  ): PickedChoice<CreateElicitationResponse> | undefined {
    if (value === null) return { ok: true, allow: false, label: 'Dismissed', response: { action: 'decline' } }
    const { propName, valueKind } = rec.notify
    if (!propName || !valueKind) return undefined
    // Same card builder, same re-derivation: the actor checks say who tapped, not what this card offered.
    const target = elicitTarget(rec.params, SLACK_DM_ELICIT_SURFACE)
    // The DM card is a Slack button row, so it carries positions too (#1794).
    const literal = target ? elicitOptionLiteral(target, value) : null
    if (!target || literal === null || !fieldAccepts(target, literal)) return undefined
    const chosen = valueKind === 'boolean' ? literal === 'true' : literal
    const label =
      valueKind === 'boolean'
        ? chosen
          ? 'Yes'
          : 'No'
        : (target.options.find((o) => o.value === literal)?.label ?? literal)
    return { ok: true, allow: true, label, response: { action: 'accept', content: { [propName]: chosen } } }
  }

  /** A background sub-session's route to its conversation (assistant-mode.md §5.6); a check never asks, and a failed lookup keeps today's path. */
  private async subsessionRoute(p: Pending): Promise<SubsessionApprovalRoute | undefined> {
    const thread = p.plan.sessionThread
    if (!isSubsessionCoordinate(thread) || isCheckCoordinate(thread) || !this.host.subsessionApprovalRoute)
      return undefined
    try {
      return await this.host.subsessionApprovalRoute(p)
    } catch (err) {
      this.host.log().warn(`sub-session approval route for "${p.plan.sessionKey}" failed: ${formatErr(err)}`)
      return undefined
    }
  }

  /** Start the wait cap; in memory only, since a restart ends the turn and expires the request with it. */
  private armSubsessionWait(
    id: string,
    rec: PendingApproval,
    p: Pending,
    route: SubsessionApprovalRoute,
    request: ApprovalRequestParts
  ): void {
    const clock = this.host.clock()
    const now = clock.now()
    const ms = route.waitHours * 3_600_000
    rec.subsession = {
      route,
      sessionId: p.outwardSessionId,
      tool: approvalRequestSummary(request),
      createdAt: now,
      deadline: now + ms,
      timer: clock.setTimeout(() => {
        void this.expireSubsessionWait(id, rec, p).catch((err) =>
          this.host.log().warn(`sub-session approval wait for "${p.plan.sessionKey}" did not settle: ${formatErr(err)}`)
        )
      }, ms)
    }
  }

  private clearSubsessionWait(rec: PendingRequest): void {
    if (rec.subsession) this.host.clock().clearTimeout(rec.subsession.timer)
  }

  /** The wait ran out (assistant-mode.md §5.6): denied once, like any answer, then the sub-session stops and its end reports to its conversation. */
  private async expireSubsessionWait(id: string, rec: PendingApproval, p: Pending): Promise<void> {
    const wait = rec.subsession
    if (this.pendingApprovals.get(id) !== rec || !wait) return
    const by = waitExpiredDecider(wait.route.waitHours)
    if (!(await this.resolveStoredPermissionRequest(rec.agentId, id, 'denied', by))) return
    this.pendingApprovals.delete(id)
    this.syncApprovalActivity(rec.owner, rec.sessionId, { id, allowed: false })
    if (rec.kind === 'permission')
      this.permissionEvaluationDetails.set(rec.evaluationParams, { reason: 'approval_wait_expired' })
    this.retireApprovalCards(id, rec, `Denied — ${by.resolvedByName}`, false, {
      kind: 'expired',
      hours: wait.route.waitHours
    })
    this.host
      .log()
      .info(`sub-session "${p.plan.sessionKey}": ${by.resolvedByName.toLowerCase()} to "${wait.tool}"; stopping it`)
    // The stop is latched before the runtime hears the answer, so the turn ends stopped rather than finished.
    const stopping = this.host.cancelTurn(p, 'approval wait expired')
    if (rec.kind === 'permission') rec.resolve({ outcome: { outcome: 'cancelled' } })
    else rec.resolve({ action: 'cancel' })
    await stopping
  }

  /** Background sub-sessions' requests still awaiting a human, oldest first, for the Activity view (assistant-mode.md §5.11). */
  pendingSubsessionApprovals(agentId: string): AssistantActivityPermission[] {
    const waits: Array<{ id: string; wait: SubsessionWait }> = []
    for (const [id, rec] of this.pendingApprovals)
      if (rec.agentId === agentId && rec.subsession) waits.push({ id, wait: rec.subsession })
    return waits
      .sort((a, b) => a.wait.createdAt - b.wait.createdAt)
      .slice(0, ASSISTANT_ACTIVITY_PERMISSIONS_MAX)
      .map(({ id, wait }) => {
        const options = this.pendingPermissionOptions(agentId, id)
        return {
          requestId: id,
          sessionId: wait.sessionId,
          parentSessionId: wait.route.parentSessionId,
          tool: wait.tool,
          createdAt: new Date(wait.createdAt).toISOString(),
          expiresAt: new Date(wait.deadline).toISOString(),
          ...(options ? { options } : {})
        }
      })
  }

  /** A pending join confirmation's console askers, the only console users it takes an answer from; undefined for any other request. */
  pendingJoinAskers(agentId: string, requestId: string): string[] | undefined {
    const rec = this.approvalAt(requestId)
    if (rec?.agentId !== agentId || rec.kind !== 'permission' || !rec.join) return undefined
    return rec.join.askers.flatMap((asker) => (asker.kind === 'console' ? [asker.userId] : []))
  }

  /** The options a live approval offers the console; undefined once it is settled or when it offers no choices (#1969). */
  pendingPermissionOptions(agentId: string, requestId: string): AgentPermissionOption[] | undefined {
    const rec = this.approvalAt(requestId)
    if (rec?.agentId !== agentId) return undefined
    return rec.kind === 'permission' ? consolePermissionOptions(rec.params) : rec.choices?.map((c) => c.option)
  }

  async decideEditorPermission(req: AgentPermissionDecision): Promise<Ack> {
    const decidedBy = { resolvedBy: req.decidedBy ?? null, resolvedByName: req.decidedByName ?? null }
    const gone = { ok: false as const, reason: 'permission request is no longer pending' }
    if (req.conversation && (await this.askedElsewhere(req.agentId, req.requestId, req.conversation.sessionId)))
      return { ok: false, reason: PERMISSION_REQUEST_NOT_IN_CONVERSATION }
    const rec = this.pendingApprovals.get(req.requestId)
    // A question is the reader's to answer on its own card, never an editor's.
    if (rec?.agentId !== req.agentId || rec.kind === 'question') return gone
    if (rec.kind === 'permission') {
      // Only a person behind the turn decides whether the bot joins a channel, an Agent editor included.
      if (rec.join && !joinDecidedByAsker(rec.join, req.decidedBy)) return { ok: false, reason: JOIN_ANSWER_REFUSED }
      // Only the Computer's allowed members decide a computer-use approval (computer-use.md §4.2).
      const approvers = this.computerAskOf(req.requestId)?.approvers
      if (approvers && !approvers.some((userId) => req.decidedBy === `user:${userId}`))
        return { ok: false, reason: COMPUTER_ANSWER_REFUSED }
      const choices = permissionChoices(rec.params)
      const picked = pickChoice(choices, req, permissionFallback(choices))
      if (!picked.ok) return picked
      const answeredBy: ReadAsker | undefined =
        rec.join && req.decidedBy ? { kind: 'console', userId: req.decidedBy.slice('user:'.length) } : undefined
      return (await this.settle(req.requestId, rec, picked, decidedBy, 'console', undefined, answeredBy))
        ? { ok: true }
        : gone
    }
    const picked = pickChoice(rec.choices, req, elicitationFallback)
    if (!picked.ok) return picked
    return (await this.settle(req.requestId, rec, picked, decidedBy, 'console')) ? { ok: true } : gone
  }

  /** Whether a pending request of this agent was asked outside that conversation and its background sub-sessions; one no longer pending is left to the decision to refuse. */
  private async askedElsewhere(agentId: string, requestId: string, sessionId: string): Promise<boolean> {
    const asked = this.pendingApprovals.get(requestId)
    if (asked?.agentId !== agentId) return false
    const where = await requestConversation(this.host.store(), agentId, asked.sessionId, this.host.clock().now())
    return !inConversation(where, sessionId)
  }

  /** A permission card's button, from the conversation or an approval DM; returns what only the clicker is told when the card's surface cannot tell them itself. */
  async handlePermissionChoice(input: {
    requestId: string
    /** The option a Slack button names by id; a surface whose button payload is capped names its position instead. */
    optionId?: string
    option?: number
    /** The card's message id as the click reports it, adopted by a click that beats its post's return. */
    ts?: string
    actor?: InteractionActor
  }): Promise<string | undefined> {
    const rec = this.approvalAt(input.requestId)
    if (!rec) return
    const optionId =
      input.optionId ?? (input.option === undefined ? undefined : cardRequest(rec)?.options[input.option]?.optionId)
    if (optionId === undefined) return
    // An MCP approval's only card here is in one person's own chat: the routed editor's, or an external place's asker's.
    if (rec.kind === 'elicitation') {
      const chat = rec.chat
      if (!chat) return
      if (chat.ts === undefined && input.ts !== undefined) chat.ts = input.ts
      if (chat.editor) {
        await this.answerEditorCard(input.requestId, rec, { ...chat, editor: chat.editor }, optionId, input.actor)
        return
      }
      if (input.actor?.isBot) {
        this.host.logSessionAction(`permission:${optionId} (refused)`, rec.sessionId, input.actor)
        return
      }
      return await this.answerChatCard(input.requestId, rec, chat, optionId, input.actor)
    }
    // A DM card's request lives on the editor path (§2): its addressee's click is checked there, anyone else's on the card beside it.
    if (rec.notify && (!rec.chat || input.actor?.userId === rec.notify.target.userId)) {
      const by = await this.authorizeDm(input.requestId, { ...rec, notify: rec.notify }, input.actor, optionId)
      if (!by) return
      const picked = choiceById(permissionChoices(rec.params), optionId)
      if (!picked) return
      const answeredBy = rec.join ? joinDmAsker(rec.join, rec.notify.target) : undefined
      await this.settle(input.requestId, rec, picked, by, 'dm', input.actor, answeredBy)
      return
    }
    // The routed editor's card beside the conversation's is told apart by the card clicked, else by who clicked.
    const besideClicked =
      rec.beside &&
      (input.ts !== undefined ? input.ts === rec.beside.ts : input.actor?.userId === rec.beside.editor?.userId)
    // A request no card was posted for is the console's alone.
    const chat = besideClicked ? rec.beside : rec.chat
    if (!chat) return
    if (chat.ts === undefined && input.ts !== undefined) chat.ts = input.ts
    // A bot never answers, and its click leaves the card for the people there.
    if (input.actor?.isBot) {
      this.host.logSessionAction(`permission:${optionId} (refused)`, rec.sessionId, input.actor)
      return
    }
    // A join confirmation is answered only by a person behind the turn, whatever the agent lets people do in chat.
    if (rec.join) {
      const answered = input.actor
        ? await this.joinCardAnswerer(input.requestId, { ...rec, join: rec.join }, chat, input.actor)
        : undefined
      if (!answered) {
        this.host.logSessionAction(`permission:${optionId} (refused)`, rec.sessionId, input.actor)
        if (!input.actor) return
        if (!chat.facet.tellPrivately) return JOIN_ANSWER_REFUSED
        chat.facet.tellPrivately(chat, input.actor.userId, JOIN_ANSWER_REFUSED)
        return
      }
      const picked = choiceById(permissionChoices(rec.params), optionId)
      if (!picked) return
      await this.settle(input.requestId, rec, picked, answered.by, 'chat', input.actor, answered.asker)
      return
    }
    // An editor's card in their own chat is the editor path: the chat level does not reach it, the control plane rechecks the clicker.
    if (chat.editor) {
      await this.answerEditorCard(input.requestId, rec, { ...chat, editor: chat.editor }, optionId, input.actor)
      return
    }
    return await this.answerChatCard(input.requestId, rec, chat, optionId, input.actor)
  }

  /** A click on a card the chat level governs, or an asker's card in their own chat; returns what only the clicker is told when the card's surface cannot tell them itself. */
  private async answerChatCard(
    requestId: string,
    rec: PendingApproval,
    chat: ChatPermissionCard,
    optionId: string,
    actor: InteractionActor | undefined
  ): Promise<string | undefined> {
    // A computer-use approval is answered by the Computer's allowed members alone (computer-use.md §4.2).
    const computer = this.computerAskOf(requestId)
    const byComputer = computer !== undefined && this.host.servesComputerApprovers()
    // The level was lowered, the conversation closed, or only editors may answer here and this person is not one; an asker's card answers to them alone.
    const verdict = byComputer
      ? this.chatAnswerOpen(rec.agentId, chat.place, chat.askerId !== undefined) &&
        (chat.askerId === undefined || actor?.userId === chat.askerId)
        ? await this.host.computerActor(rec.agentId, chat.place.integrationId, computer.computerId, actor)
        : 'closed'
      : chat.askerId === undefined
        ? await this.chatAnswerVerdict(rec.agentId, chat.place, actor)
        : actor?.userId === chat.askerId
          ? await this.chatAnswerVerdict(rec.agentId, chat.place, actor, true)
          : 'closed'
    if (verdict !== 'allowed') {
      // Refused, so it decided nothing — recorded as an attempt, never as the decision.
      this.host.logSessionAction(`permission:${optionId} (refused)`, rec.sessionId, actor)
      if (!actor) return
      // Only the clicker is told; the card stays as everyone else sees it.
      const text =
        byComputer && verdict !== 'closed'
          ? computerApprovalRefusalText(verdict, chat.facet.privateTextLimit)
          : this.chatRefusal(rec, verdict, chat.facet)
      if (!chat.facet.tellPrivately) return text
      chat.facet.tellPrivately(chat, actor.userId, text)
      return
    }
    // A relayed click carries only the member's id, so the settled card names them by a lookup.
    const name = actor ? (actor.name ?? (await this.cardMemberName(chat, actor.userId))) : undefined
    const by = actor ? { resolvedBy: cardAnswererId(chat, actor.userId), resolvedByName: name ?? null } : undefined
    if (rec.kind === 'permission') {
      const picked = choiceById(permissionChoices(rec.params), optionId)
      if (picked) await this.settle(requestId, rec, picked, by, 'chat', actor)
      return
    }
    const picked = choiceById(rec.choices, optionId)
    if (picked) await this.settle(requestId, rec, picked, by, 'chat', actor)
  }

  /** A click on a routed editor's card in their own chat: the control plane rechecks the clicker, and a rights refusal retires the card. */
  private async answerEditorCard(
    requestId: string,
    rec: PendingApproval,
    chat: ChatPermissionCard & { editor: DmTarget },
    optionId: string,
    actor: InteractionActor | undefined
  ): Promise<void> {
    const checked = await this.verifyEditor(rec.agentId, requestId, chat.editor, actor)
    if (!checked.ok || !actor) {
      this.host.logSessionAction(`permission:${optionId} (refused)`, rec.sessionId, actor)
      const params = cardRequest(rec)
      if (!checked.ok && checked.authoritative && params) {
        const settled = chat.facet.settled({
          params,
          ...(chat.context ? { context: chat.context } : {}),
          text: 'No longer authorized — decide it from the Agent or Session page',
          fallback: 'Permission requires an Agent editor'
        })
        chat.facet.rewrite(chat, settled)
      }
      return
    }
    const by = {
      resolvedBy: cardAnswererId(chat, actor.userId) ?? `${chat.facet.platform}:${actor.userId}`,
      resolvedByName: checked.name
    }
    if (rec.kind === 'permission') {
      const picked = choiceById(permissionChoices(rec.params), optionId)
      if (picked) await this.settle(requestId, rec, picked, by, 'dm', actor)
      return
    }
    const picked = choiceById(rec.choices, optionId)
    if (picked) await this.settle(requestId, rec, picked, by, 'dm', actor)
  }

  /** A card clicker's name for a click that carried none; a failed lookup names nobody and never blocks the decision. */
  private async cardMemberName(chat: ChatPermissionCard, userId: string): Promise<string | undefined> {
    try {
      return await chat.facet.nameOf?.(chat, userId)
    } catch {
      return undefined
    }
  }

  /** Where an Agent editor answers a request in the console: its session's page, while its turn is live. */
  private approvalConsoleLink(rec: { owner: HostKey; sessionId: string }, platform: string): string | undefined {
    const p = this.host.pending().get(pendingTurnKey(rec.owner, rec.sessionId))
    return p ? this.host.sessionLink(p.outwardSessionId, sessionLinkSourceFor(platform)) : undefined
  }

  /** Rewrite one in-chat permission card for everyone once approving in chat is turned off; its request stays pending for editors. */
  private retireChatApprovalsOffCard(rec: PendingApproval): void {
    // An editor's card is the editor path, which the chat level does not reach.
    if (!rec.chat?.ts || rec.chat.editor) return
    const chat = rec.chat
    const params = cardRequest(rec)
    if (!params) return
    const settled = chat.facet.settled({
      params,
      ...(chat.subsession ? { subsession: chat.subsession } : {}),
      text: CHAT_APPROVALS_OFF,
      fallback: 'Approving in chat was turned off'
    })
    chat.facet.rewrite(chat, settled)
  }

  /** Retire in-chat Allow/Deny controls once the agent no longer lets people approve in chat; the requests stay pending for editors. */
  disableChatPermissionSurfaces(agentId: string): void {
    for (const pending of this.pendingApprovals.values()) {
      // A join confirmation is not a tool-call approval, so the level does not reach it, and a question is no approval.
      if (pending.agentId !== agentId || pending.kind === 'question' || (pending.kind === 'permission' && pending.join))
        continue
      const card = pending.kind === 'elicitation' ? pending.card : undefined
      if (pending.kind === 'elicitation' && card?.surface === 'chat' && card.ts)
        card.facet.settle(card, elicitSettlement(pending.params, false, ELICIT_CHAT_APPROVALS_OFF))
      // The asker's own card for an external place was a chat-side answer too.
      const dm = pending.notify?.asker ? pending.notify : undefined
      if (dm) {
        const blocks =
          pending.kind === 'permission'
            ? buildPermissionResolvedCard(pending.params, CHAT_APPROVALS_OFF, undefined)
            : buildElicitationResolvedCard(pending.params, CHAT_APPROVALS_OFF)
        void dm.conn
          .updateBlocks(dm.channel, dm.ts, [...dm.intro, ...blocks], 'Approving in chat was turned off', true)
          .catch(() => {})
      }
      this.retireChatApprovalsOffCard(pending)
    }
  }

  /** Cancel every approval and question a session still holds — the turn ended, so nothing was decided (ACP's `cancel`). */
  async releaseApprovals(owner: HostKey, sessionId: string): Promise<void> {
    const agentId = hostKeyAgentId(owner)
    for (const caller of this.pendingCallerApprovals.values())
      if (caller.owner === owner && caller.sessionId === sessionId) caller.cancel()
    for (const [id, pending] of this.pendingApprovals) {
      // A join confirmation outlives the turn that asked: its own wait ends it.
      if (pending.owner !== owner || pending.sessionId !== sessionId || !holdsTurn(pending)) continue
      this.pendingApprovals.delete(id)
      this.clearSubsessionWait(pending)
      this.syncApprovalActivity(owner, sessionId, { id })
      if (pending.kind !== 'question') await this.resolveStoredPermissionRequest(agentId, id, 'expired')
      // Dead buttons must not survive the request (§5.4): retire every card in place.
      this.retireApprovalCards(id, pending, 'Cancelled', undefined, { kind: 'cancelled' })
      if (pending.kind === 'permission') {
        this.permissionEvaluationDetails.set(pending.evaluationParams, { reason: 'turn_cancelled' })
        pending.resolve({ outcome: { outcome: 'cancelled' } })
      } else {
        pending.resolve({ action: 'cancel' })
      }
    }
  }

  onAcpPermissionEvent(
    owner: HostKey,
    sessionId: string,
    params: RequestPermissionRequest,
    event: AcpPermissionPolicyEvent
  ): void {
    const agentId = hostKeyAgentId(owner)
    const pending = this.host.pending().get(pendingTurnKey(owner, sessionId))
    const context = {
      agentId,
      sessionId,
      ...(pending?.plan.evaluationTurnId ? { turnId: pending.plan.evaluationTurnId } : {})
    }
    const toolCallId = typeof params.toolCall?.toolCallId === 'string' ? params.toolCall.toolCallId : undefined
    if (event.kind === 'requested') {
      this.host.evalHooks().emit({
        type: 'permission.requested',
        ...context,
        data: { ...(toolCallId ? { toolCallId } : {}), optionCount: params.options.length }
      })
      return
    }

    const outcome = event.response.outcome
    const policyDetails = this.permissionEvaluationDetails.get(params)
    this.permissionEvaluationDetails.delete(params)
    const resultData = {
      ...(policyDetails ?? {}),
      source: event.source,
      ...(event.fallbackReason ? { fallbackReason: event.fallbackReason } : {}),
      outcome: outcome.outcome,
      ...('optionId' in outcome ? { optionId: outcome.optionId } : {}),
      ...(toolCallId ? { toolCallId } : {})
    }
    const selectedOption =
      'optionId' in outcome ? params.options.find((option) => option.optionId === outcome.optionId) : undefined
    if (
      event.source === 'fallback' &&
      outcome.outcome === 'selected' &&
      (selectedOption?.kind === 'allow_once' || selectedOption?.kind === 'allow_always')
    ) {
      this.host.evalHooks().emit({ type: 'permission.auto_allowed', ...context, data: resultData })
    }
    this.host.evalHooks().emit({
      type: outcome.outcome === 'cancelled' ? 'permission.cancelled' : 'permission.resolved',
      ...context,
      data: resultData
    })
  }

  /** A computer-use approval (computer-use.md §4.2): the turn's own approval path, plus the Computer's owner in their DM. */
  async askComputerApproval(
    p: Pending,
    params: RequestPermissionRequest,
    computer: ComputerAskScope
  ): Promise<RequestPermissionResponse> {
    const callId = params.toolCall.toolCallId
    this.computerAsks.set(callId, computer)
    try {
      return await this.onAcpPermission(p.hostKey, p.acpSessionId, params)
    } finally {
      this.computerAsks.delete(callId)
    }
  }

  /** The Computer a pending computer-use approval asks about. */
  private computerAskOf(requestId: string): ComputerAskScope | undefined {
    if (this.computerAsks.size === 0) return undefined
    const rec = this.approvalAt(requestId)
    return rec?.kind === 'permission' ? this.computerAsks.get(rec.params.toolCall.toolCallId) : undefined
  }

  /** What makes an approval route judge by a Computer's allowed members; an older CP keeps the editors. */
  private computerRoute(computer: ComputerAskScope | undefined): { computerId?: string } {
    return computer && this.host.servesComputerApprovers() ? { computerId: computer.computerId } : {}
  }

  /** An API caller answers a computer-use approval on its own stream; the Computer's owner is told in their DM (§4.2). */
  private async noticeComputerOwner(
    agentId: string,
    p: Pending,
    params: RequestPermissionRequest,
    computer: ComputerAskScope & { ownerUserId: string }
  ) {
    const cp = this.host.cpApprovalRoute()
    if (!cp) return
    const integrationIds = this.host.approvalDmIntegrations(agentId, undefined)
    if (integrationIds.length === 0) return
    const { target } = await cp.approvalRoute(
      {
        agentId,
        requestId: params.toolCall.toolCallId,
        consoleUserId: computer.ownerUserId,
        integrationIds,
        ...this.computerRoute(computer)
      },
      this.host.orgForAgent(agentId)
    )
    const conn = target ? this.host.slackConnFor(target.integrationId) : undefined
    if (!target || !conn) return
    const channel = await conn.openDirectMessage(target.userId)
    const blocks = buildComputerCallerApprovalNotice({
      agentName: p.plan.agentName,
      title: permToolLabel(params),
      sessionUrl: this.host.sessionLink(p.outwardSessionId, 'slack')
    })
    await conn.postBlocks(channel, blocks, `Computer use asked by ${p.plan.agentName}`, undefined, {
      ...(slackAgentIdentityOptions(p.plan) ?? {}),
      chrome: true
    })
  }

  /** A computer-use card in the conversation also reaches the Computer's owner in their DM, unless they asked there. */
  private async dmComputerOwnerBeside(requestId: string, agentId: string, p: Pending, requesterName: string | null) {
    const cp = this.host.cpApprovalRoute()
    const computer = this.computerAskOf(requestId)
    if (!cp || !computer?.ownerUserId) return
    const preferred = p.plan.platform === 'slack' ? p.plan.integrationId : undefined
    const integrationIds = this.host.approvalDmIntegrations(agentId, preferred)
    if (integrationIds.length === 0) return
    const { target } = await cp.approvalRoute(
      { agentId, requestId, consoleUserId: computer.ownerUserId, integrationIds, ...this.computerRoute(computer) },
      this.host.orgForAgent(agentId)
    )
    if (!target || (target.integrationId === p.plan.integrationId && target.userId === p.plan.requesterId)) return
    const conn = this.host.slackConnFor(target.integrationId)
    if (!conn || !this.pendingApprovals.has(requestId)) return
    const channel = await conn.openDirectMessage(target.userId)
    await this.sendApprovalDm(requestId, agentId, p, requesterName, undefined, { target, channel }, true)
  }

  /** ACP `session/request_permission` policy (AcpHost.onPermission): built-in tools are trusted, the rest wait for an editor unless chat decisions are on. */
  async onAcpPermission(
    owner: HostKey,
    sessionId: string,
    params: RequestPermissionRequest
  ): Promise<RequestPermissionResponse> {
    try {
      return await this.resolveAcpPermission(owner, sessionId, params)
    } catch (err) {
      this.permissionEvaluationDetails.set(params, { reason: 'permission_policy_error' })
      this.host.log().error(`permission policy failed closed for agent "${hostKeyAgentId(owner)}": ${formatErr(err)}`)
      return { outcome: { outcome: 'cancelled' } }
    }
  }

  private async resolveAcpPermission(
    owner: HostKey,
    sessionId: string,
    params: RequestPermissionRequest
  ): Promise<RequestPermissionResponse> {
    const agentId = hostKeyAgentId(owner)
    const evaluationParams = params
    // The tool title/preview can embed a secret the agent interpolated into a command.
    // Mask before anything renders it (Slack card now, resolved-card edit later via
    // the pending request).
    params = this.host.maskAgentSecrets(agentId, params)
    // Extraction stays silent: cancel everything but the daemon's own bound bridge tools, its only output path on a runtime that asks per MCP call (#2091).
    const extraction = this.host.memoryExtraction(pendingTurnKey(owner, sessionId))
    if (extraction) {
      const allowed = isBuiltinSystemTool(params, extraction.builtinSystemToolCallIds)
        ? this.autoAllowSystemTool(agentId, sessionId, params, evaluationParams, 'memory_extraction_bound_tool')
        : undefined
      if (allowed) return allowed
      this.permissionEvaluationDetails.set(evaluationParams, { reason: 'memory_extraction' })
      return { outcome: { outcome: 'cancelled' } }
    }
    // This daemon's OWN MCP tools are always granted without a card; everything else takes the interactive policy.
    const p = this.host.pending().get(pendingTurnKey(owner, sessionId))
    if (isBuiltinSystemTool(params, p?.builtinSystemToolCallIds)) {
      const allowed = this.autoAllowSystemTool(
        agentId,
        sessionId,
        params,
        evaluationParams,
        'agentconnect_system_tool',
        p?.plan.evaluationTurnId
      )
      if (allowed) return allowed
    }
    if (!p || p.outputSuppressed) {
      this.permissionEvaluationDetails.set(evaluationParams, {
        reason: p?.outputSuppressed ?? 'permission_without_live_turn'
      })
      return { outcome: { outcome: 'cancelled' } }
    }
    // codex-acp asks to approve an MCP call by id and kind alone; every card names it by what the call said (#3289).
    params = this.host.maskAgentSecrets(agentId, titledPermissionRequest(params, p.knownToolCalls))
    // A check (assistant-mode.md §5.12) and a coordinator (auto-session-mode.md §5.4) are read-only: whatever would need approval is refused, never asked.
    if (refusesEveryAsk(p.plan.sessionThread)) {
      this.permissionEvaluationDetails.set(evaluationParams, {
        reason: isCheckCoordinate(p.plan.sessionThread) ? 'assistant_check' : 'coordinator'
      })
      const reject = params.options.find((o) => o.kind === 'reject_once' || o.kind === 'reject_always')
      return reject
        ? { outcome: { outcome: 'selected', optionId: reject.optionId } }
        : { outcome: { outcome: 'cancelled' } }
    }
    // A list no surface can offer whole is declined, never truncated: the cards and the console share this cap (#1811, #1969).
    if (params.options.length > SLACK_PERMISSION_MAX_OPTIONS) {
      this.permissionEvaluationDetails.set(evaluationParams, { reason: 'permission_options_unrenderable' })
      this.noticePermissionOptionsUnrenderable(p, params)
      return { outcome: { outcome: 'cancelled' } }
    }
    // An API caller decides first: its refusal stands, and only an allow it may not make reaches an Agent editor.
    if (this.callerAnswers(p)) {
      const computer = this.computerAsks.get(params.toolCall.toolCallId)
      if (computer?.ownerUserId)
        void this.noticeComputerOwner(agentId, p, params, { ...computer, ownerUserId: computer.ownerUserId }).catch(
          (err) => {
            this.host.log().warn(`computer owner notice for "${p.plan.sessionKey}" failed: ${formatErr(err)}`)
          }
        )
      const option = (...kinds: string[]) =>
        kinds.map((kind) => params.options.find((o) => o.kind === kind)).find((o) => o !== undefined)
      const select = (o: { optionId: string } | undefined): RequestPermissionResponse => {
        this.permissionEvaluationDetails.set(evaluationParams, { reason: 'api_caller' })
        return o ? { outcome: { outcome: 'selected', optionId: o.optionId } } : { outcome: { outcome: 'cancelled' } }
      }
      return await this.askCaller(p, sessionId, permissionRequestParts(params, p.knownToolCalls), {
        allow: (id) =>
          select(id ? params.options.find((o) => o.optionId === id) : option('allow_once', 'allow_always')),
        deny: (id) =>
          select(id ? params.options.find((o) => o.optionId === id) : option('reject_once', 'reject_always')),
        options: params.options.map((o) => ({ id: o.optionId, label: o.name, allow: isAllowOption(o) })),
        outcome: (value) => this.permissionResult(value, params),
        escalate: () => this.awaitEditorPermission(agentId, sessionId, params, evaluationParams, p),
        cancelled: { outcome: { outcome: 'cancelled' } }
      })
    }
    const inChat: ChatApprovalRoute =
      params.options.length > 0 ? this.chatApprovalRoute(agentId, p, params.options.length) : { to: 'none' }
    if (inChat.to === 'card') {
      return await this.awaitChatPermission(agentId, sessionId, params, evaluationParams, p, inChat.facet)
    }
    // Default policy: hold the runtime request and surface only a neutral notice in chat; a sub-session's goes to its conversation (assistant-mode.md §5.6).
    const route = await this.subsessionRoute(p)
    // The lookup awaited, so a Stop's release sweep may have passed without seeing this request: never open it then.
    if (!this.turnStillLive(owner, sessionId, p)) {
      this.permissionEvaluationDetails.set(evaluationParams, {
        reason: p.outputSuppressed ?? 'permission_without_live_turn'
      })
      return { outcome: { outcome: 'cancelled' } }
    }
    // An external place's asker may not be the Computer's member, so a computer-use approval skips their DM for the owner's (§4.2).
    const askerFirst = inChat.to === 'asker' && !this.computerAsks.has(params.toolCall.toolCallId)
    return await this.awaitEditorPermission(agentId, sessionId, params, evaluationParams, p, route, askerFirst)
  }

  /** An MCP approval's name and input, from the call it approves when the turn saw it; masked like the request. */
  private elicitationParts(agentId: string, params: CreateElicitationRequest, p: Pending): ApprovalRequestParts {
    return this.host.maskAgentSecrets(agentId, elicitationApprovalParts(params, p.knownToolCalls))
  }

  /** Where people may answer a turn's approval: its surface's card in an open conversation, the asker's DM for an external one, or only the editor path. */
  private chatApprovalRoute(agentId: string, p: Pending, options?: number): ChatApprovalRoute {
    if (!chatApprovalsAllowed(this.host.agents().get(agentId))) return { to: 'none' }
    const facet = this.host.approvalCardFacet(p.plan.platform)
    if (!facet || p.plan.approvalSurfaceSuppressed) return { to: 'none' }
    const msg = p.entry.msg
    const surface = this.host.chatSurface(agentId, p.plan.integrationId, p.plan.channel, msg.externallyShared === true)
    // Where permissions are synced only an editor may answer, so the editor path reaches the asker when they are one.
    if (surface === 'external')
      return { to: this.host.chatEditorsOnly(agentId, p.plan.integrationId) ? 'none' : 'asker' }
    // A list longer than this card holds goes to the console, which offers it whole.
    const fits = options === undefined || options <= facet.maxOptions
    return surface === 'open' && chatOut(p) && fits ? { to: 'card', facet } : { to: 'none' }
  }

  /** Whether `p` is still the session's live, unsuppressed turn after an await. */
  private turnStillLive(owner: HostKey, sessionId: string, p: Pending): boolean {
    return this.host.pending().get(pendingTurnKey(owner, sessionId)) === p && !p.outputSuppressed
  }

  /** Grant one of this daemon's own tools without a card; undefined when the runtime offered no allow option. */
  private autoAllowSystemTool(
    agentId: string,
    sessionId: string,
    params: RequestPermissionRequest,
    evaluationParams: RequestPermissionRequest,
    reason: 'agentconnect_system_tool' | 'memory_extraction_bound_tool',
    turnId?: string
  ): RequestPermissionResponse | undefined {
    const allow = params.options.find((o) => o.kind === 'allow_always' || o.kind === 'allow_once')
    if (!allow) return undefined
    this.permissionEvaluationDetails.set(evaluationParams, { reason })
    this.host.evalHooks().emit({
      type: 'permission.auto_allowed',
      agentId,
      sessionId,
      ...(turnId ? { turnId } : {}),
      data: { reason, optionId: allow.optionId }
    })
    return { outcome: { outcome: 'selected', optionId: allow.optionId } }
  }

  /** ACP `elicitation/create` policy: a card on the turn's own surface, pending until answered or the turn ends; undefined ⇒ the host declines. */
  async onAcpElicit(
    owner: HostKey,
    sessionId: string,
    params: CreateElicitationRequest
  ): Promise<CreateElicitationResponse | undefined> {
    const agentId = hostKeyAgentId(owner)
    // Same reason as onAcpPermission: the elicitation message/labels are agent-authored
    // text headed for a platform card — mask any embedded secret value first.
    params = this.host.maskAgentSecrets(agentId, params)
    // Codex carries MCP approval here when form elicitation is advertised: same extraction rule as above (#2091).
    const extraction = this.host.memoryExtraction(pendingTurnKey(owner, sessionId))
    if (extraction) {
      return isBuiltinSystemToolElicitation(params, extraction.builtinSystemToolCallIds)
        ? { action: 'accept' }
        : { action: 'cancel' }
    }
    const p = this.host.pending().get(pendingTurnKey(owner, sessionId))
    if (!p) return undefined
    if (p.outputSuppressed) return { action: 'cancel' }
    // Codex maps MCP approval to `elicitation/create` when form support is
    // advertised. Correlate its opaque id with a preceding trusted tool event;
    // never infer trust from the human-facing elicitation message.
    if (isBuiltinSystemToolElicitation(params, p.builtinSystemToolCallIds)) return { action: 'accept' }
    // A check and a coordinator ask no one.
    if (refusesEveryAsk(p.plan.sessionThread)) return { action: 'decline' }
    const isApproval = isMcpToolApprovalElicitation(params)
    if (isApproval && this.callerAnswers(p)) {
      return await this.askCaller<CreateElicitationResponse>(p, sessionId, this.elicitationParts(agentId, params, p), {
        allow: () => ({ action: 'accept' }),
        deny: () => ({ action: 'decline' }),
        outcome: (value) => ({
          outcome: value.action === 'accept' ? 'allowed' : value.action === 'decline' ? 'denied' : 'cancelled'
        }),
        escalate: () => this.awaitEditorElicitation(agentId, sessionId, params, p, elicitationApprovalChoices(params)),
        cancelled: { action: 'cancel' }
      })
    }
    if (isApproval) {
      // The surface's approval-card facet says it takes approvals in chat; its elicitation card draws this one.
      const inChat = this.chatApprovalRoute(agentId, p)
      if (inChat.to !== 'card') {
        const route = await this.subsessionRoute(p)
        // As for a permission request: a Stop during the lookup must not leave an answerable approval behind.
        if (!this.turnStillLive(owner, sessionId, p)) return { action: 'cancel' }
        return await this.awaitEditorElicitation(
          agentId,
          sessionId,
          params,
          p,
          elicitationApprovalChoices(params),
          route,
          inChat.to === 'asker'
        )
      }
    }
    // A `none` Slack turn has no generic human-input card to answer this request.
    if (p.plan.approvalSurfaceSuppressed) return { action: 'cancel' }
    // Webchat's card is core-owned; an MCP approval never takes it (webchat has no approval-card facet), and a continuation falls through to its origin platform.
    // URL mode is the seam the spec reserves for credentials, OAuth and payment — the page must
    // stay out of the model's context and off every card, so only a surface that can render the
    // consent card takes it and every other one declines (elicitTarget is null for it anyway).
    const url = elicitUrl(params)
    if (p.webchat && !p.webchat.continuation && !isApproval) {
      return url
        ? await this.awaitWebchatUrlElicitation(agentId, sessionId, params, p, p.webchat, url)
        : await this.awaitWebchatElicitation(agentId, sessionId, params, p, p.webchat)
    }
    // The surface's own facet (EXACT lookup) decides; no transport, reply or leased egress, means no surface.
    const facet = (p.conn ?? p.egress) ? this.host.elicitCardFacet(p.plan.platform) : undefined
    if (!facet) return this.noticeUnrenderableElicit(p, params, isApproval)
    // A second SURFACE for #1810's URL mode: the notice is only for an ask this chat still cannot
    // render. A consent card is never an approval, so it takes the approval-free path.
    if (url) return await this.awaitChatElicitation(agentId, sessionId, params, p, facet, { url }, false)
    if (params.mode === 'url') return this.noticeUnrenderableElicit(p, params, isApproval)
    // ONE reduction decides the card's shape (#1794), against THIS surface's own declaration.
    // Anything the reader has to fill in before submitting — several questions, a question with
    // its own free-text box, a multi-select, a typed box — is a card of inputs with one Confirm;
    // only a lone single-select or boolean, which one tap answers, keeps its row of buttons below.
    // An approval is allow/deny by construction, so it is always the button row: chat approval has
    // no shape for a filled-in field, and its own bookkeeping lives on the button path.
    const form = elicitForm(params, facet.reduction)
    if (!form) return this.noticeUnrenderableElicit(p, params, isApproval)
    if (isApproval && elicitCardShape(form) === 'inputs') return this.noticeUnrenderableElicit(p, params, isApproval)
    return await this.awaitChatElicitation(agentId, sessionId, params, p, facet, { form }, isApproval)
  }

  /** Post one elicitation card on the turn's chat surface through its facet and park the resolver until it is answered or the turn ends. */
  private async awaitChatElicitation(
    agentId: string,
    sessionId: string,
    params: CreateElicitationRequest,
    p: Pending,
    facet: ElicitCardFacet,
    shape: { form?: ElicitTarget[]; url?: { elicitationId: string; url: string } },
    isApproval: boolean
  ): Promise<CreateElicitationResponse | undefined> {
    const { form, url } = shape
    const requestId = randomUUID()
    // An inputs card answers with a record and a consent card has no field: both leave the one-tap field shape unused.
    const inputs = !!form && elicitCardShape(form) === 'inputs'
    const defaulted = url ? 'The agent needs you to open a link' : 'The agent needs your input'
    const message = (params as { message?: string }).message?.trim() || defaulted
    const fallback = (params as { message?: string }).message ?? defaulted
    const ask: ElicitCardAsk = {
      requestId,
      params,
      message,
      fallback,
      ...(form ? { form } : {}),
      ...(url ? { url } : {})
    }
    const draft = facet.build(this.elicitCardHost, p, ask)
    if (draft === null || draft === undefined) return this.noticeUnrenderableElicit(p, params, isApproval)
    const target = form?.[0]
    let resolveResult!: (res: CreateElicitationResponse) => void
    const result = new Promise<CreateElicitationResponse>((resolve) => (resolveResult = resolve))
    const card: TurnElicitCard = {
      propName: inputs || url ? '' : (target?.propName ?? ''),
      kind: inputs || url ? 'text' : (target?.kind ?? 'text'),
      ...(inputs && form ? { form } : {}),
      ...(url ? { url } : {}),
      ...(isApproval ? { place: { integrationId: p.plan.integrationId, channel: p.plan.channel } } : {}),
      surface: 'chat',
      facet,
      conn: p.conn ?? p.egress,
      // Where the card actually lands: a Discord thread is a channel of its own.
      channel: facet.cardChannel?.(p) ?? p.plan.channel,
      ...(p.plan.thread ? { thread: p.plan.thread } : {}),
      answerConv: p.plan.transcriptChannel,
      // An MCP approval's durable record is `permission_requests`, so it is not also a transcript card.
      ...(isApproval
        ? {}
        : this.recordElicitCard(
            p,
            url
              ? elicitUrlCardPayload(requestId, message, url.url)
              : elicitCardPayload(requestId, message, params, form ?? [])
          ))
    }
    const parts = isApproval ? this.elicitationParts(agentId, params, p) : undefined
    // An approval offers the console its choices, so an editor can pick one there too (§11.2).
    const choices = parts && elicitationApprovalChoices(params)
    const entry: CardRequest = {
      ...(parts
        ? { kind: 'elicitation' as const, parts, ...(choices ? { choices } : {}) }
        : { kind: 'question' as const }),
      chatScope: this.chatScope(p),
      owner: p.hostKey,
      agentId,
      sessionId,
      askedAt: this.host.clock().now(),
      params,
      card,
      resolve: resolveResult
    }
    this.pendingApprovals.set(requestId, entry)
    if (parts) {
      this.observeEditorPermission(p, requestId, parts, result, (value) => ({
        outcome: value.action === 'accept' ? 'allowed' : value.action === 'decline' ? 'denied' : 'cancelled'
      }))
    } else if (card.row) {
      card.observe = (event) =>
        this.emitChatEvent(
          p,
          event.kind === 'elicitation' || event.kind === 'elicitation_resolved'
            ? { ...event, observationOnly: true }
            : event
        )
      card.observe({ kind: 'elicitation', ...card.row.card })
    }
    this.syncApprovalActivity(p.hostKey, sessionId)
    if (parts) {
      const recorded = this.noteEditorPermissionRequest(requestId, agentId, sessionId, parts, p, false)
      this.recordedWrites.set(requestId, recorded)
      try {
        await recorded
      } catch (err) {
        this.pendingApprovals.delete(requestId)
        this.syncApprovalActivity(p.hostKey, sessionId, { id: requestId })
        this.recordedWrites.delete(requestId)
        resolveResult({ action: 'cancel' })
        throw err
      }
      this.recordedWrites.delete(requestId)
      if (!this.pendingApprovals.has(requestId)) return await result
    }
    const ts = await facet.send(this.elicitCardHost, p, ask, draft)
    // Settled mid-post: the card must stop offering an answer and say how it ended, which the settlement left here (#1794).
    if (this.pendingApprovals.get(requestId) !== entry) {
      const settled = this.takeSettledBeforePost(requestId)
      if (ts && settled)
        facet.settle(
          { conn: p.conn ?? p.egress, channel: facet.cardChannel?.(p) ?? p.plan.channel, ts },
          elicitSettlement(params, !!url, settled)
        )
      return await result
    }
    if (!ts) {
      this.pendingApprovals.delete(requestId)
      this.syncApprovalActivity(p.hostKey, sessionId, { id: requestId })
      if (parts) await this.resolveStoredPermissionRequest(agentId, requestId, 'expired')
      // A card the platform never took is closed on the row too, or it would read as open forever.
      this.settleElicitRow(entry, 'cancelled')
      entry.resolve({ action: 'cancel' })
      return await result
    }
    card.ts = ts
    // Approving in chat was turned off while it posted: retire it as the switch retired the others.
    if (parts && !chatApprovalsAllowed(this.host.agents().get(agentId)))
      facet.settle(card, elicitSettlement(params, false, ELICIT_CHAT_APPROVALS_OFF))
    return parts ? await this.trackHumanApprovalWait(p, result) : await result
  }

  /** Say in the channel that an elicitation was declined for want of a surface that can render it.
   *  Every caller is past the webchat branches, so this only ever speaks on a chat platform whose
   *  card the reader would otherwise have never seen. An MCP approval is excluded: it took the
   *  editor queue with its own notice. Returns `undefined` so a decline site stays one line.
   *  Best effort: the decline never depends on the notice landing. */
  private noticeUnrenderableElicit(p: Pending, params: CreateElicitationRequest, isApproval: boolean): undefined {
    if (isApproval || !p.conn) return undefined
    const text = this.takeElicitDeclineNotice(p, params, 'chat')
    if (text === null) return undefined
    try {
      this.host.enqueueApply(p, { kind: 'notice', text })
    } catch (err) {
      this.host.log().warn(`elicitation decline notice failed for "${p.plan.sessionKey}": ${formatErr(err)}`)
    }
    return undefined
  }

  /** Webchat's peer of {@link noticeUnrenderableElicit}: the same words, said the way webchat says
   *  anything — a STANDING stream event, since this surface has no channel to post a message into.
   *  #1819 held that webchat needed none because it renders every shape; a `required` property no
   *  control can answer (#1795) is the shape it does not, and that decline was silent. */
  private noticeUnrenderableWebchatElicit(
    p: Pending,
    wc: NonNullable<Pending['webchat']>,
    params: CreateElicitationRequest
  ): undefined {
    const text = this.takeElicitDeclineNotice(p, params, 'webchat')
    if (text !== null) this.streamWebchatNotice(wc, text)
    return undefined
  }

  /** The words one declined elicitation is described with, or null when this turn has already
   *  said them (or the text could not be built at all). ONE notice per distinct question — a
   *  runtime re-raising the same unrenderable ask floods nothing, and a genuinely different
   *  question is a second thing the reader has not been told — and the set is shared with the
   *  chat notice, so a continuation cannot say it twice on two surfaces.
   *
   *  `surface` decides two things. Markup: a chat notice is read as markdown and has its link
   *  syntax defused, while webchat's card is our own DOM, which renders the text as a text node
   *  with no label syntax to spoof, so defusing it there would only show the reader backslashes.
   *  And the console link: a webchat reader is already IN the console, and it is that console's
   *  own surface which just declined, so pointing them at it would be a lie. */
  private takeElicitDeclineNotice(
    p: Pending,
    params: CreateElicitationRequest,
    surface: 'chat' | 'webchat'
  ): string | null {
    const key = (params as { message?: string }).message?.trim() ?? ''
    const seen = (p.declinedElicitNotices ??= new Set<string>())
    if (seen.has(key)) return null
    seen.add(key)
    // The durable half of the same notice (#1794): one row per distinct declined question, on
    // whichever surface declined it, so a reader loading the conversation later still sees that
    // the agent asked something nothing here could show.
    this.recordUnrenderableElicit(p, params)
    let sessionUrl: string | undefined
    // A console link this daemon cannot compute must not cost the reader the question itself.
    try {
      sessionUrl = surface === 'chat' ? this.host.sessionLink(p.outwardSessionId) : undefined
    } catch {
      sessionUrl = undefined
    }
    try {
      // Built from the MASKED params `onAcpElicit` reassigned at its top, never an earlier capture.
      const markup = surface === 'chat' ? turnChromeFor(p.plan.platform).noticeMarkup : undefined
      return buildElicitDeclinedNotice(params, markup, sessionUrl)
    } catch (err) {
      this.host.log().warn(`elicitation decline notice failed for "${p.plan.sessionKey}": ${formatErr(err)}`)
      return null
    }
  }

  /** Say one daemon-authored line on a webchat stream, as a STANDING notice: not a wait, but
   *  something the reader has to keep, so the browser never retires it when output resumes.
   *  Best effort by construction — no elicitation outcome depends on it. */
  private streamWebchatNotice(wc: NonNullable<Pending['webchat']>, text: string): boolean {
    try {
      wc.sink.output({
        conversationId: wc.conversationId,
        turnId: wc.turnId,
        index: wc.index++,
        event: { kind: 'notice', text, standing: true }
      })
      return true
    } catch (err) {
      this.host.log().warn(`webchat notice not delivered for "${wc.conversationId}": ${formatErr(err)}`)
      return false
    }
  }

  /** Stream webchat's card for the whole form and park the resolver; undefined (decline, said in the stream) when a field has no control (#1794). */
  private async awaitWebchatElicitation(
    agentId: string,
    sessionId: string,
    params: CreateElicitationRequest,
    p: Pending,
    wc: NonNullable<Pending['webchat']>
  ): Promise<CreateElicitationResponse | undefined> {
    const form = elicitForm(params, WEBCHAT_ELICIT_SURFACE)
    if (!form) return this.noticeUnrenderableWebchatElicit(p, wc, params)
    const target = form[0]!
    const requestId = randomUUID()
    const message = (params as { message?: string }).message?.trim() || 'The agent needs your input'
    const card = elicitCardPayload(requestId, message, params, form)
    let resolveResult!: (res: CreateElicitationResponse) => void
    const result = new Promise<CreateElicitationResponse>((resolve) => (resolveResult = resolve))
    this.pendingApprovals.set(requestId, {
      kind: 'question',
      chatScope: this.chatScope(p),
      owner: p.hostKey,
      agentId,
      sessionId,
      askedAt: this.host.clock().now(),
      params,
      card: {
        propName: target.propName,
        kind: target.kind,
        ...(form.length > 1 ? { form } : {}),
        surface: 'webchat',
        wc,
        ...this.recordElicitCard(p, card)
      },
      resolve: resolveResult
    })
    this.syncApprovalActivity(p.hostKey, sessionId)
    try {
      wc.sink.output({
        conversationId: wc.conversationId,
        turnId: wc.turnId,
        index: wc.index++,
        event: { kind: 'elicitation', ...card }
      })
    } catch (err) {
      // An undelivered card can never be answered: decline now, with no notice, since this sink is the reader's only surface.
      const stillPending = this.pendingApprovals.get(requestId)
      this.pendingApprovals.delete(requestId)
      this.syncApprovalActivity(p.hostKey, sessionId, { id: requestId })
      // A card nobody was shown is closed on the row too, or it would read as open forever.
      if (hasCard(stillPending)) this.settleElicitRow(stillPending, 'cancelled')
      this.host.log().warn(`webchat elicitation card not delivered for "${p.plan.sessionKey}": ${formatErr(err)}`)
      return undefined
    }
    if (this.callerAnswers(p)) this.armCallerDeadline(p, () => this.pendingApprovals.has(requestId))
    return await result
  }

  /** Stream webchat's URL consent card and park the resolver; the daemon never fetches the URL, it only learns whether the reader agreed to go. */
  private async awaitWebchatUrlElicitation(
    agentId: string,
    sessionId: string,
    params: CreateElicitationRequest,
    p: Pending,
    wc: NonNullable<Pending['webchat']>,
    url: { elicitationId: string; url: string }
  ): Promise<CreateElicitationResponse | undefined> {
    const requestId = randomUUID()
    const message = (params as { message?: string }).message?.trim() || 'The agent needs you to open a link'
    let resolveResult!: (res: CreateElicitationResponse) => void
    const result = new Promise<CreateElicitationResponse>((resolve) => (resolveResult = resolve))
    const card = elicitUrlCardPayload(requestId, message, url.url)
    this.pendingApprovals.set(requestId, {
      kind: 'question',
      chatScope: this.chatScope(p),
      owner: p.hostKey,
      agentId,
      sessionId,
      askedAt: this.host.clock().now(),
      params,
      // A URL card has no field; `propName` and `kind` are its unused shape.
      card: { propName: '', kind: 'text', url, surface: 'webchat', wc, ...this.recordElicitCard(p, card) },
      resolve: resolveResult
    })
    this.syncApprovalActivity(p.hostKey, sessionId)
    try {
      wc.sink.output({
        conversationId: wc.conversationId,
        turnId: wc.turnId,
        index: wc.index++,
        event: { kind: 'elicitation', ...card }
      })
    } catch (err) {
      const stillPending = this.pendingApprovals.get(requestId)
      this.pendingApprovals.delete(requestId)
      this.syncApprovalActivity(p.hostKey, sessionId, { id: requestId })
      // A card nobody was shown is closed on the row too, or it would read as open forever.
      if (hasCard(stillPending)) this.settleElicitRow(stillPending, 'cancelled')
      this.host.log().warn(`webchat consent card not delivered for "${p.plan.sessionKey}": ${formatErr(err)}`)
      return undefined
    }
    if (this.callerAnswers(p)) this.armCallerDeadline(p, () => this.pendingApprovals.has(requestId))
    return await result
  }

  /** The fields a live card's inputs were built from, re-derived from its own params on its own surface (#1815); null without inputs. */
  private cardForm(rec: CardRequest): ElicitTarget[] | null {
    return rec.card.form ? elicitForm(rec.params, surfaceOf(rec.card)) : null
  }

  /** Answer a form card from the fields its Confirm carried, re-derived against the rendered form (#1807, #1815); one bad field refuses aloud and leaves it live. */
  async submitElicitForm(a: {
    requestId: string
    fields: Record<string, string | string[]>
    actor?: InteractionActor
  }): Promise<string | undefined> {
    const rec = this.pendingApprovals.get(a.requestId)
    if (!hasCard(rec) || rec.card.surface !== 'chat' || !rec.card.form) return
    const form = this.cardForm(rec)
    if (!form) return
    const submission = elicitFormSubmission(rec.params, form, a.fields)
    if (submission.errors) {
      this.noticeInTurn(rec, elicitFormRefusalNotice(rec.params, form, submission.errors))
      return
    }
    // Two concurrent Confirms cannot both settle: the record is the compare-and-swap, and the loser finds it gone.
    return await this.handleElicitChoice({
      requestId: a.requestId,
      value: submission.answer ?? {},
      ...(a.actor ? { actor: a.actor } : {})
    })
  }

  /** Settle a URL consent card: `accept` means only that the reader agreed to open it; a later `elicitation/complete` is a re-label. */
  private async handleUrlElicitConsent(
    requestId: string,
    rec: CardRequest,
    url: { elicitationId: string; url: string },
    a: { value: ElicitAnswer; webchatConversationId?: string; onSettled?: () => void }
  ): Promise<void> {
    const card = rec.card
    // A card settles only from its own surface: its webchat conversation, or a chat tap (no conversation).
    if (card.surface === 'webchat') {
      if (a.webchatConversationId === undefined || card.wc.conversationId !== a.webchatConversationId) return
    } else if (a.webchatConversationId !== undefined) return
    // Consent echoes the card's one option back: a chat button carries its position (#1794), webchat the URL itself.
    const consented = a.value === (card.surface === 'chat' ? elicitOptionToken(0) : url.url)
    if (!consented && a.value !== null) return
    const picked = consented
      ? { ok: true as const, allow: true, label: 'Opened', response: { action: 'accept' as const } }
      : { ok: true as const, allow: false, label: 'Dismissed', response: { action: 'decline' as const } }
    if (await this.settle(requestId, rec, picked, undefined, 'chat')) a.onSettled?.()
  }

  /** Say on the consent card's own surface how it ended; best effort, no ACP resolution depends on it. */
  private settleUrlElicit(
    rec: CardRequest,
    requestId: string,
    outcome: 'accepted' | 'dismissed' | 'cancelled' | 'completed'
  ): void {
    const label = outcome === 'accepted' ? 'Opened' : undefined
    this.settleElicitRow(rec, outcome, label)
    if (rec.card.surface === 'webchat') {
      this.emitWebchatElicitResolved(rec, rec.card, requestId, outcome, label)
      return
    }
    this.settleChatCard(rec, rec.card, requestId, true, URL_CONSENT_DECISION[outcome])
  }

  /** Keep a consented card's coordinates for a later `elicitation/complete`, oldest out at the cap. */
  private rememberConsentedUrlElicit(requestId: string, rec: CardRequest): void {
    const url = rec.card.url
    if (!url) return
    while (this.consentedUrlElicits.size >= CONSENTED_URL_ELICIT_CAP) {
      const oldest = this.consentedUrlElicits.keys().next().value
      if (oldest === undefined) break
      this.consentedUrlElicits.delete(oldest)
    }
    this.consentedUrlElicits.set(consentedUrlKey(rec.owner, url.elicitationId), { requestId, rec })
  }

  /** ACP `elicitation/complete` (wired as AcpHost.onElicitComplete): re-label the already
   *  settled consent card as Completed. The notification carries no session, so it is keyed by
   *  `elicitationId` within the agent host that sent it. An unknown id — never consented, from
   *  another agent, or already completed — is ignored, which is also what makes this safe to
   *  never receive at all. */
  onAcpElicitComplete(owner: HostKey, elicitationId: string): void {
    const key = consentedUrlKey(owner, elicitationId)
    const hit = this.consentedUrlElicits.get(key)
    if (!hit) return
    this.consentedUrlElicits.delete(key)
    this.settleUrlElicit(hit.rec, hit.requestId, 'completed')
  }

  /** Append the settled card to a webchat stream, webchat's rewrite; best effort. */
  private emitWebchatElicitResolved(
    rec: CardRequest,
    card: Extract<TurnElicitCard, { surface: 'webchat' }>,
    requestId: string,
    outcome: 'accepted' | 'dismissed' | 'cancelled' | 'completed',
    label?: string,
    answers?: Record<string, string | number | boolean | string[]>
  ): void {
    try {
      card.wc.sink.output({
        conversationId: card.wc.conversationId,
        turnId: card.wc.turnId,
        index: card.wc.index++,
        event: this.host.maskAgentSecrets(rec.agentId, {
          kind: 'elicitation_resolved' as const,
          requestId,
          outcome,
          ...(label !== undefined ? { label } : {}),
          ...(answers ? { answers } : {})
        })
      })
    } catch (err) {
      this.host.log().warn(`webchat elicitation card not settled for ${requestId}: ${formatErr(err)}`)
    }
  }

  /** Fold one tap into a card a surface assembles tap by tap (Telegram), submitting through {@link submitElicitForm}; Dismiss settles as a choice. */
  async handleElicitCardTap(a: {
    requestId: string
    token: string | null
    /** The card's own message id AS THE TAP REPORTS IT — the same one fact `ElicitCardHandle.ts`
     *  holds, in whichever dialect the surface spells it. A tap can beat the post it came from:
     *  the reader sees the keyboard the instant the platform has it, while `awaitChatElicitation`
     *  is still awaiting the send that will record the id. Adopting it is what lets a fold redraw
     *  a card whose own post has not landed yet; that send then records the very same value. */
    ts?: string
    actor?: InteractionActor
  }): Promise<string | undefined> {
    const actor = a.actor ? { actor: a.actor } : {}
    const rec = this.pendingApprovals.get(a.requestId)
    const card = hasCard(rec) ? rec.card : undefined
    // A one-tap card, an unknown request, and Dismiss all answer with the token as it came; a refusal only the tapper hears comes back.
    if (a.token === null || !hasCard(rec) || card?.surface !== 'chat' || !card.facet.tap || !card.form)
      return await this.handleElicitChoice({ requestId: a.requestId, value: a.token, ...actor })
    // Only ever fills a gap: a recorded id is the send's own and is never overwritten by a tap.
    if (card.ts === undefined && a.ts !== undefined) card.ts = a.ts
    const form = this.cardForm(rec)
    if (!form) return
    const folded = card.facet.tap(card, { requestId: a.requestId, params: rec.params, form }, a.token)
    // A token naming nothing this card offers is refused aloud and leaves the card live, as an unoffered value is.
    if (!folded) {
      this.noticeInTurn(rec, ELICIT_ANSWER_REFUSED)
      return
    }
    if (folded.kind === 'pending') return
    return await this.submitElicitForm({ requestId: a.requestId, fields: folded.fields, ...actor })
  }

  /** Offer a typed reply to its conversation's live cards (per card, anyone who sees it); true ⇒ it was an answer, never a prompt. */
  async claimElicitReply(reply: ElicitCardReply & { actor?: InteractionActor }): Promise<boolean> {
    if (reply.replyTo === undefined) return false
    for (const [requestId, rec] of this.pendingApprovals) {
      if (!hasCard(rec)) continue
      const card = rec.card
      if (card.surface !== 'chat' || !card.facet.claimReply || card.url) continue
      // The BOT-QUALIFIED conversation: two bots' DMs with one person share a chat id and message numbers.
      if (card.answerConv !== reply.conversation) continue
      // A one-tap card has no form of its own; its single field is re-derived from its params (#1815).
      const form = card.form ? this.cardForm(rec) : elicitForm(rec.params, surfaceOf(card))
      if (!form) continue
      const claimed = card.facet.claimReply(card, { requestId, params: rec.params, form }, reply)
      if (!claimed) continue
      // `pending` still claims the words: they filled a field the reader has yet to Confirm.
      if (claimed.kind === 'submit') {
        const actor = reply.actor ? { actor: reply.actor } : {}
        const value = claimed.fields[elicitFormBlockId(0)]
        if (card.form) await this.submitElicitForm({ requestId, fields: claimed.fields, ...actor })
        else if (typeof value === 'string') await this.handleElicitChoice({ requestId, value, ...actor })
      }
      return true
    }
    return false
  }

  /** The dialog a live card opens where a surface takes its answer outside the message (Discord's modal); undefined for any other card. */
  openElicitEditor(requestId: string): unknown | undefined {
    const rec = this.pendingApprovals.get(requestId)
    if (!hasCard(rec) || rec.card.surface !== 'chat' || !rec.card.facet.editor) return undefined
    const form = this.cardForm(rec) ?? elicitForm(rec.params, surfaceOf(rec.card))
    if (!form) return undefined
    return rec.card.facet.editor(rec.card, { requestId, params: rec.params, form }) ?? undefined
  }

  /** Answer a card from a dialog's named values, read by each field's own arity, then through {@link submitElicitForm}. */
  async submitElicitEditor(a: {
    requestId: string
    values: Record<string, string | readonly string[]>
    actor?: InteractionActor
  }): Promise<string | undefined> {
    const rec = this.pendingApprovals.get(a.requestId)
    if (!hasCard(rec) || rec.card.surface !== 'chat') return
    const form = this.cardForm(rec)
    if (!form) return
    const fields: Record<string, string | string[]> = {}
    for (const [index, target] of form.entries()) {
      const blockId = elicitFormBlockId(index)
      const raw = a.values[blockId]
      if (raw === undefined) continue
      if (target.kind === 'multi-enum') fields[blockId] = Array.isArray(raw) ? [...raw] : [raw]
      else {
        const one = Array.isArray(raw) ? raw[0] : raw
        // A blank input or untouched select is an omission: legal when optional, named as missing when required.
        if (typeof one === 'string' && one !== '') fields[blockId] = one
      }
    }
    return await this.submitElicitForm({ requestId: a.requestId, fields, ...(a.actor ? { actor: a.actor } : {}) })
  }

  // Reads the already-rendered, masked card; never reconstructs a broader form for an observer.
  chatElicitation(
    scope: Omit<ChatRequestScope, 'turnId'> & { turnId?: string }
  ): { card: ElicitCard; turnId: string } | undefined {
    const rec = this.pendingApprovals.get(scope.requestId)
    const requestScope = { ...scope, turnId: scope.turnId ?? rec?.chatScope?.turnId ?? '' }
    const row = hasCard(rec) ? rec.card.row : undefined
    if (!rec || !row || !this.matchesChatScope(rec.chatScope, requestScope) || !this.liveChatRequest(rec, requestScope))
      return undefined
    return { card: this.host.maskAgentSecrets(scope.agentId, row.card), turnId: rec.chatScope!.turnId }
  }

  callerElicitation(
    conversationId: string,
    requestId: string,
    scope: { agentId?: string; outwardSessionId: string; turnId: string }
  ): ElicitCard | undefined {
    const rec = this.pendingApprovals.get(requestId)
    if (!hasCard(rec)) return undefined
    return this.chatElicitation({ ...scope, agentId: scope.agentId ?? rec.agentId, conversationId, requestId })?.card
  }

  async handleCallerElicitChoice(
    a: Omit<ChatRequestScope, 'conversationId'> & {
      webchatConversationId: string
      value: ElicitAnswer
      callerRole?: ChatCallerRole
      userId?: string
    }
  ): Promise<boolean> {
    const scope = { ...a, conversationId: a.webchatConversationId }
    if (!this.chatElicitation(scope)) return false
    const rec = this.pendingApprovals.get(a.requestId)
    if (!hasCard(rec)) return false
    const card = rec.card
    if (card.surface === 'chat' && (a.callerRole !== 'editor' || !a.userId || rec.kind !== 'question')) return false
    let value = a.value
    if (card.surface === 'chat' && value !== null) {
      if (card.url) {
        if (value !== card.url.url) return false
        value = elicitOptionToken(0)
      } else if (card.form?.length === 1 && !isFormAnswer(value)) {
        value = { [card.form[0]!.propName]: value }
      } else if (!card.form && typeof value === 'string') {
        const target = elicitTarget(rec.params, surfaceOf(card))
        const index = target?.options.findIndex((option) => option.value === value) ?? -1
        if (index < 0) return false
        value = elicitOptionToken(index)
      }
    }
    let settled = false
    await this.handleElicitChoice({
      requestId: a.requestId,
      value,
      ...(card.surface === 'webchat' ? { webchatConversationId: a.webchatConversationId } : {}),
      onSettled: () => {
        settled = true
      }
    })
    return settled
  }

  /** An elicitation card's tap or answer, re-derived against the card that offered it and settled through {@link settle}; Dismiss (null) declines. */
  async handleElicitChoice(a: {
    requestId: string
    value: ElicitAnswer
    actor?: InteractionActor
    /** Set only by the webchat ingress: the answering browser's conversation. It confines the
     *  answer to a card THIS conversation was shown — a webchat client may answer neither a Slack
     *  card nor another conversation's. Kept alongside the unguessable request id rather than
     *  replaced by it: an id is a secret, and a scope is a rule. */
    webchatConversationId?: string
    onSettled?: () => void
  }): Promise<string | undefined> {
    const rec = this.pendingApprovals.get(a.requestId)
    if (!rec || rec.kind === 'permission') return
    // A DM elicitation card's request lives on the editor path (§2/§6.4).
    if (rec.kind === 'elicitation' && rec.notify) {
      // A DM card is a Slack button row: never answered by a list, a number, a form record, or a browser.
      if (
        a.webchatConversationId !== undefined ||
        Array.isArray(a.value) ||
        typeof a.value === 'number' ||
        isFormAnswer(a.value)
      )
        return
      const dm = { ...rec, notify: rec.notify }
      const by = await this.authorizeDm(a.requestId, dm, a.actor, 'elicit')
      const picked = by && this.dmElicitPick(dm, a.value)
      if (picked) await this.settle(a.requestId, rec, picked, by, 'dm', a.actor)
      return
    }
    if (!hasCard(rec)) return
    const card = rec.card
    // A URL consent card has no field to validate — it takes its own URL back, or Dismiss.
    if (card.url) {
      await this.handleUrlElicitConsent(a.requestId, rec, card.url, a)
      return
    }
    // A FORM card is answered by a record and every other card by a scalar or a list, re-derived from its own params.
    const form = this.cardForm(rec)
    if (card.form && !form) return
    if (a.value !== null && isFormAnswer(a.value) !== !!form) return
    // Each kind takes one shape of answer; Dismiss (null) settles any of them.
    if (a.value !== null && !isFormAnswer(a.value) && !answerFitsKind(card.kind, a.value)) return
    const target = elicitTarget(rec.params, surfaceOf(card))
    // A browser answers only a card its own conversation was shown, and a chat tap never answers a webchat card.
    if (a.webchatConversationId !== undefined) {
      if (card.surface !== 'webchat' || card.wc.conversationId !== a.webchatConversationId) return
    } else if (card.surface === 'webchat') return
    // A chat one-tap card carries each option's POSITION, not its value (#1794); a form answer and webchat's literals are not remapped.
    const answer: ElicitAnswer =
      card.surface === 'chat' && !card.form && target && typeof a.value === 'string'
        ? elicitOptionLiteral(target, a.value)
        : a.value
    // A position naming no option this card offered is refused, and the card stays live.
    if (answer === null && a.value !== null) {
      this.noticeInTurn(rec, ELICIT_ANSWER_REFUSED)
      return
    }
    // Every answer is re-derived against the card that offered it (#1815): an unoffered value is refused aloud and the card stays live.
    const offered =
      answer === null ||
      (isFormAnswer(answer)
        ? !!form && elicitFormAccepts(form, elicitRequiredProps(rec.params), answer)
        : !!target &&
          (Array.isArray(answer)
            ? multiSelectAccepts(target, answer)
            : typeof answer === 'number'
              ? numberAccepts(target, answer)
              : target.kind === 'text'
                ? textAccepts(target, answer)
                : target.options.some((o) => o.value === answer)))
    if (!offered) {
      this.noticeInTurn(rec, ELICIT_ANSWER_REFUSED)
      return
    }
    const approval = rec.kind === 'elicitation'
    // A bot never answers an approval; one whose level was lowered or whose conversation closed takes no answer from chat.
    if (approval && a.actor?.isBot) return
    const verdict = approval
      ? card.place
        ? await this.chatAnswerVerdict(rec.agentId, card.place, a.actor)
        : 'closed'
      : 'allowed'
    if (verdict !== 'allowed') {
      // Refused, so it decided nothing: only the clicker is told, and the card stays as everyone else sees it.
      this.host.logSessionAction('permission:elicit (refused)', rec.sessionId, a.actor)
      if (card.surface !== 'chat' || !a.actor) return
      const text = this.chatRefusal(rec, verdict, card.facet)
      // A surface that cannot reach the tapper from the card hands the words back to the tap's own ingress.
      if (!card.facet.tellPrivately) return text
      card.facet.tellPrivately(card, a.actor.userId, text)
      return
    }
    const picked = this.cardAnswer(rec, form, target, answer)
    if (!picked) return
    // A chat approval's decider is scoped as its surface scopes user ids, and named beside the answer on its settled card.
    let by: Decider | undefined
    if (approval && a.actor && card.surface === 'chat') {
      const decider = await this.chatDeciderName(card, a.actor)
      by = { resolvedBy: surfaceActorId(card, a.actor.userId), resolvedByName: decider ?? null }
    }
    if (await this.settle(a.requestId, rec, picked, by, 'chat', a.actor)) a.onSettled?.()
  }

  /** What an admitted answer resolves the request with, and how its card and row name it. */
  private cardAnswer(
    rec: CardRequest,
    form: ElicitTarget[] | null,
    target: ElicitTarget | null,
    answer: ElicitAnswer
  ): (PickedChoice<CreateElicitationResponse> & { card: CardAnswer }) | undefined {
    const card = rec.card
    if (answer === null) {
      const dismissed: CardAnswer = { mark: 'dismissed', fallback: 'Input received' }
      return { ok: true, allow: false, label: 'Dismissed', response: { action: 'decline' }, card: dismissed }
    }
    let content: Record<string, string | number | boolean | string[]>
    let answered: string
    // The card's own words beside the mark: a scalar answer echoes the VALUE, where the row's label names the option.
    let text: string
    if (isFormAnswer(answer)) {
      if (!form) return undefined
      // A form's accepted content is the whole record: every answered field under its own name.
      content = elicitFormContent(form, answer)
      answered = formAnswerLabel(rec.params, form, answer)
      text = answered
    } else if (Array.isArray(answer)) {
      content = { [card.propName]: answer }
      answered = chosenLabel(target, answer)
      text = answered
    } else {
      // The accepted content carries the schema's own type: a real boolean or number, never the wire's string.
      const value = card.kind === 'boolean' ? answer === 'true' : answer
      content = { [card.propName]: value }
      answered = chosenLabel(target, answer)
      text = card.kind === 'boolean' ? (value ? 'Yes' : 'No') : String(answer)
    }
    const answers = card.row?.card.fields ? content : { value: content[form?.[0]?.propName ?? card.propName]! }
    return {
      ok: true,
      allow: true,
      label: text,
      response: { action: 'accept', content },
      card: { mark: 'answered', fallback: 'Input received', answered, answers }
    }
  }

  /** Who answered a chat card, by name: the click's own, else the surface's lookup; a failed lookup names nobody. */
  private async chatDeciderName(card: ChatElicitCard, actor: InteractionActor): Promise<string | undefined> {
    if (actor.name) return actor.name
    try {
      return await card.facet.nameOf?.(card, actor.userId)
    } catch {
      return undefined
    }
  }

  /**
   * Record one elicitation card as a transcript row (#1794) and hand back the handle its
   * settlement rewrites. Losing the card on a page reload is real data loss — a reader who joins
   * later never learns a question was asked at all — so the ask becomes durable history on both
   * surfaces, Slack and webchat alike.
   *
   * The row can never be fed back to the runtime as fresh conversation: it already answered this
   * request over ACP, and asking again would be the bug. Three independent things keep it out —
   * its `kind` is not `text`, and `text` is the only kind any replay reader selects; it is
   * authored by the agent itself, which every participant gap filters; and on Slack the card
   * MESSAGE carries the `agentconnect_chrome` marker, so a peer daemon's thread backfill drops it
   * before it can become a row of its own.
   *
   * Best effort by construction: the ACP request never waits on the write and never fails with it.
   */
  private recordElicitCard(p: Pending, card: ElicitCard): { row?: ElicitRow } {
    const row: ElicitRow = {
      channel: p.plan.transcriptChannel,
      thread: p.plan.statusThread,
      sessionKey: p.plan.sessionKey,
      // The monotonic internal-event clock, as every other non-conversational row uses: it keeps
      // the card in the position it was asked and cannot collide with a second card's row.
      ts: monotonicTs(),
      sender: p.plan.agentId,
      card
    }
    this.writeElicitRow(row)
    return { row }
  }

  /** Write (or rewrite) one card's row. */
  private writeElicitRow(row: ElicitRow, settled?: { outcome: ElicitOutcome; answerLabel?: string }): void {
    void this.host
      .store()
      .upsertElicit({
        channel: row.channel,
        thread: row.thread,
        ts: row.ts,
        sender: row.sender,
        admission: { agentId: row.sender, sessionKey: row.sessionKey },
        text: row.card.message,
        body: elicitRowBody(row.card, settled)
      })
      .catch((err: unknown) => {
        this.host.log().warn(`elicitation row not recorded for ${row.card.requestId}: ${formatErr(err)}`)
      })
  }

  /** Say on the card's transcript row how it ended, so a later reader sees it settled. */
  private settleElicitRow(
    rec: CardRequest,
    outcome: ElicitOutcome,
    answerLabel?: string,
    answers?: Record<string, string | number | boolean | string[]>
  ): void {
    const row = rec.card.row
    if (!row) return
    if (outcome !== 'unrenderable')
      rec.card.observe?.(
        this.host.maskAgentSecrets(rec.agentId, {
          kind: 'elicitation_resolved' as const,
          requestId: row.card.requestId,
          outcome,
          ...(answerLabel !== undefined ? { label: answerLabel } : {}),
          ...(answers ? { answers } : {})
        })
      )
    this.writeElicitRow(row, { outcome, ...(answerLabel !== undefined ? { answerLabel } : {}) })
  }

  /** Record an ask NO surface had a control for. It offers nothing because nothing was offered:
   *  the row exists so a later reader still learns the question was asked, which #1839's live-only
   *  decline notice could not tell them. */
  private recordUnrenderableElicit(p: Pending, params: CreateElicitationRequest): void {
    const message = (params as { message?: string }).message?.trim() || 'The agent needs your input'
    const card = elicitUnrenderablePayload(randomUUID(), message)
    // Written settled in one go: this ask was never open on any surface.
    this.writeElicitRow(
      {
        channel: p.plan.transcriptChannel,
        thread: p.plan.statusThread,
        sessionKey: p.plan.sessionKey,
        ts: monotonicTs(),
        sender: p.plan.agentId,
        card
      },
      { outcome: 'unrenderable' }
    )
  }

  /** Rewrite a settled chat card through its facet, or leave the label for a post still in flight (#1794); best effort. */
  private settleChatCard(
    rec: CardRequest,
    card: ChatElicitCard,
    requestId: string,
    consent: boolean,
    label: ElicitCardLabel
  ): void {
    if (card.ts) {
      card.facet.settle(card, elicitSettlement(rec.params, consent, label))
      return
    }
    this.settledBeforePost.set(requestId, label)
  }

  /** How a card the posting path found already settled must read, or undefined when it has already
   *  been rewritten and must be left alone. Every chat-card settlement goes through
   *  {@link settleChatCard}, which leaves its label here exactly when it had no message to rewrite
   *  — so nothing left means the settlement DID rewrite the card, from a message id of its own
   *  (a tap carries the card's, adopted before the send could record it), and re-settling would
   *  call an answered card Cancelled. */
  private takeSettledBeforePost(requestId: string): ElicitCardLabel | undefined {
    const settled = this.settledBeforePost.get(requestId)
    this.settledBeforePost.delete(requestId)
    return settled
  }

  /** Post one daemon notice on the card's own surface; false when its turn is gone or the surface refused it. */
  private noticeInTurn(rec: CardRequest, text: string): boolean {
    if (rec.card.surface === 'webchat') return this.streamWebchatNotice(rec.card.wc, text)
    const p = this.host.pending().get(pendingTurnKey(rec.owner, rec.sessionId))
    if (!p) return false
    try {
      this.host.enqueueApply(p, { kind: 'notice', text })
    } catch (err) {
      this.host.log().warn(`elicitation notice not delivered for ${rec.sessionId}: ${formatErr(err)}`)
      return false
    }
    return true
  }
}
