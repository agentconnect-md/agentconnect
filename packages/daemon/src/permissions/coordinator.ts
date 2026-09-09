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
} from '@agentclientprotocol/sdk'
import type {
  Ack,
  AgentApprovalRoute,
  AgentApprovalRouted,
  AgentPermissionDecision,
  ApprovalRouteTarget,
  ElicitCard,
  ElicitOutcome
} from '@agentconnect.md/protocol'
import type { Clock } from '@agentconnect.md/connection'
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
  buildElicitationCard,
  buildElicitDmUnanswerableCard,
  buildElicitationResolvedCard,
  buildPermissionCard,
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
  textAccepts,
  WEBCHAT_ELICIT_SURFACE
} from '../slack/render.js'
import type { ElicitKind, ElicitSurface, ElicitTarget } from '../slack/render.js'
import { slackThreadUrl } from '../platforms/slack/permalink.js'
import { slackAgentIdentityOptions } from '../platforms/slack/turn-output.js'
import { turnChromeFor } from '../platforms/turn-chrome.js'
import { monotonicTs } from '../store/monotonic-ts.js'
import { buildElicitDeclinedNotice } from './elicit-notice.js'
import { elicitCardPayload, elicitRowBody, elicitUnrenderablePayload, elicitUrlCardPayload } from './elicit-record.js'
import { formatErr } from '../daemon/text.js'
import {
  approvalRequestSummary,
  elicitationApprovalParts,
  isBuiltinSystemTool,
  isBuiltinSystemToolElicitation,
  isMcpToolApprovalElicitation,
  permissionRequestParts,
  type ApprovalRequestParts
} from '../daemon/tool-classification.js'
import { pendingTurnKey, turnState, type DaemonRenderAction, type Pending } from '../daemon/turn-types.js'
import { isSyntheticA2aChannel } from '../cp/cp-collab-routes.js'
import type { MemoryWriteAsk } from '../mcp/ops/memory.js'
import {
  memoryWriteApprovalElicitation,
  memoryWriteApprovalFrom,
  type MemoryWriteApprovalOutcome
} from './memory-write-approval.js'

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
  log(): Logger
  clock(): Clock
  store(): LocalStore
  agents(): ReadonlyMap<string, LoadedAgent>
  /** Live turns keyed by `pendingTurnKey(agentId, acpSessionId)`. */
  pending(): ReadonlyMap<string, Pending>
  evalHooks(): DaemonEvaluationHooks
  /** A silent background extraction turn: it may never gain side effects. */
  memoryExtractionInFlight(turnKey: string): boolean
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

/** How a card the turn ended under is labelled: nothing was decided, so it says so. */
const ELICIT_CANCELLED: ElicitCardLabel = { mark: 'waiting', text: 'Cancelled', fallback: 'Cancelled' }

/** How a card is re-labelled once chat approval is no longer allowed: the ask is still open, but
 *  only an Agent editor can settle it now. */
const ELICIT_EDITOR_ONLY: ElicitCardLabel = {
  mark: 'blocked',
  text: 'Ask an Agent editor to allow it',
  fallback: 'Permission requires an Agent editor'
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

/** One outstanding `elicitation/create` awaiting a human answer. */
type PendingElicit = PendingElicitSurface & {
  owner: HostKey
  agentId: string
  sessionId: string
  params: CreateElicitationRequest
  propName: string
  kind: ElicitKind
  /** Set on every card whose fields are `input` blocks — webchat's multi-field card and Slack's
   *  Confirm-bearing one — the fields it rendered, in schema order. Absent ⇒ a one-tap button
   *  row, answered by a scalar as it always was. */
  form?: ElicitTarget[]
  /** Set only for a URL-mode consent card: the ACP `elicitationId` and the exact URL shown.
   *  Present ⇒ `propName`/`kind`/`form` mean nothing — the card has no field, and its only
   *  answers are consent (this same URL back) or Dismiss. */
  url?: { elicitationId: string; url: string }
  /** Where this card's transcript row lives (#1794), so the settlement rewrites the very row the
   *  ask wrote rather than appending a second one below the reply that followed it. Absent on an
   *  approval elicitation, whose durable record is `permission_requests`. */
  row?: ElicitRow
  approval: boolean
  resolve: (res: CreateElicitationResponse) => void
}

/** One card's `elicit` transcript row: its coordinates, and the card the ask recorded there. */
type ElicitRow = { channel: string; thread: string; ts: string; sender: string; card: ElicitCard }

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
  /** The agent's LIVE Slack integration ids, `preferred` first. */
  approvalDmIntegrations(agentId: string, preferred?: string): string[]
  /** Unconditional shared-target block_id for a DM card (§5.3). */
  slackDmSessionTarget(p: Pick<Pending, 'plan'>, integrationId: string): string
}

/** Everything the permission coordinator touches on the `Daemon`. */
export interface PermissionHost extends PermissionCoreHost, PermissionSurfaceHost {}

/** A live DM approval card (§5): its addressed target, connection, and message handle.
 *  `propName`/`valueKind` mirror the elicitation card's one rendered field. */
interface DmNotice {
  target: ApprovalRouteTarget
  conn: SlackConnection
  channel: string
  ts: string
  /** The §5.2 context header (session link, source quote/permalink). Every in-place
   *  rewrite prepends it — a resolved card must not lose the links (issue feedback). */
  intro: unknown[]
  propName?: string
  valueKind?: ElicitKind
}

interface EditorPermissionEntry {
  kind: 'permission'
  owner: HostKey
  agentId: string
  sessionId: string
  params: RequestPermissionRequest
  evaluationParams: RequestPermissionRequest
  resolve: (res: RequestPermissionResponse) => void
  notify?: DmNotice
}

interface EditorElicitationEntry {
  kind: 'elicitation'
  owner: HostKey
  agentId: string
  sessionId: string
  params: CreateElicitationRequest
  resolve: (res: CreateElicitationResponse) => void
  notify?: DmNotice
}

export class PermissionCoordinator {
  // ── Permission requests (ACP session/request_permission) ─────────────────────
  /** Durable rows still being written. Admission publishes its resolver first, so anything that
   *  settles a request must wait for the row it settles to exist. */
  private readonly recordedWrites = new Map<string, Promise<unknown>>()
  private pendingEditorPermissions = new Map<string, EditorPermissionEntry | EditorElicitationEntry>()

  private pendingChatPermissions = new Map<
    string,
    {
      owner: HostKey
      agentId: string
      sessionId: string
      params: RequestPermissionRequest
      /** Original ACP object used by the host's final policy observer. */
      evaluationParams: RequestPermissionRequest
      conn: SlackConnection
      channel: string
      ts?: string
      resolve: (res: RequestPermissionResponse) => void
    }
  >()
  /** Decision details discovered inside the platform policy and merged into the
   * single terminal event emitted by AcpHost's policy observer. */
  private readonly permissionEvaluationDetails = new WeakMap<RequestPermissionRequest, Record<string, unknown>>()

  // ── Interactive elicitations (ACP elicitation/create, form + url mode) ──────
  /** One outstanding card per id, and the id is a `randomUUID()` — never a process-local
   *  sequence. A card lives in a Slack MESSAGE, which outlives the daemon that posted it, so a
   *  restart minting `elicit-1` again would let a stale button answer whatever request now holds
   *  that id: the card carries its option's POSITION (#1794), and a position resolves against the
   *  NEW question's options, so the stale tap would accept an answer to a question its reader
   *  never saw. A literal used to be rejected by the new option list by accident; nothing should
   *  rest on that accident, and one id shape is also one less branch. */
  private pendingElicits = new Map<string, PendingElicit>()
  /** URL-mode cards already consented to, keyed by `<owner>\x00<elicitationId>` and awaiting
   *  an `elicitation/complete` that may never come — their ACP request resolved at consent, so
   *  these hold only the surface coordinates the "Completed" re-label is said on. Bounded:
   *  an agent that never completes its flows must not grow this without limit. */
  private readonly consentedUrlElicits = new Map<string, { requestId: string; rec: PendingElicit }>()
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

  /** Any answerable request for the session across the three pending maps (approval elicitations only). */
  private hasPendingApproval(owner: HostKey, sessionId: string): boolean {
    for (const e of this.pendingEditorPermissions.values())
      if (e.owner === owner && e.sessionId === sessionId) return true
    for (const e of this.pendingChatPermissions.values())
      if (e.owner === owner && e.sessionId === sessionId) return true
    for (const e of this.pendingElicits.values())
      if (e.approval && e.owner === owner && e.sessionId === sessionId) return true
    return false
  }

  /** Re-derive the session's wait state after a map write and report it when it flipped (§7). `closed`
   *  names the gate this write removed, so the turn's surface closes that one gate, not the session. */
  private syncApprovalActivity(owner: HostKey, sessionId: string, closed?: ClosedGate): void {
    if (closed) this.reportGateClosed(owner, sessionId, closed)
    const key = pendingTurnKey(owner, sessionId)
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
    notifyChat = true
  ): Promise<{ requesterName: string | null }> {
    const command = approvalRequestSummary(request)
    const store = this.host.store()
    const session = await store.getSessionByAcpIdForAgent(agentId, sessionId)
    const requesterId = p.plan.requesterId ?? session?.triggeredBy ?? null
    const requesterName = requesterId ? ((await store.getDisplayNames([requesterId])).get(requesterId) ?? null) : null
    await store.createPermissionRequest({
      id,
      agentId,
      sessionId,
      createdAt: this.host.clock().now(),
      requesterId,
      requesterName,
      command,
      status: 'pending',
      resolvedAt: null
    })

    if (!notifyChat) return { requesterName }
    const text = '🔒 Permission requested. Ask an Agent editor to allow it from the Agent or Session page.'
    try {
      if (p.webchat) {
        p.webchat.sink.output({
          conversationId: p.webchat.conversationId,
          turnId: p.webchat.turnId,
          index: p.webchat.index++,
          event: { kind: 'message', text }
        })
      }
      // A continuation turn notifies the origin platform thread too (§5.2). The turn's own
      // surface owns that notice where it has one — Linear's feed has no chat transport at all,
      // so without this the gate would be invisible until the session went stale.
      if (!p.webchat || p.webchat.continuation) {
        if (!this.host.approvalGateOpened(p, id, request) && p.conn) this.host.enqueueApply(p, { kind: 'notice', text })
      }
    } catch (err) {
      // The durable editor request is authoritative. A best-effort chat notice
      // must never discard the live resolver or silently fall back to auto-allow.
      this.host.log().warn(`permission request notice failed for "${p.plan.sessionKey}": ${formatErr(err)}`)
    }
    return { requesterName }
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

  private async awaitEditorPermission(
    agentId: string,
    sessionId: string,
    params: RequestPermissionRequest,
    evaluationParams: RequestPermissionRequest,
    p: Pending
  ): Promise<RequestPermissionResponse> {
    const id = randomUUID()
    let resolveResult!: (res: RequestPermissionResponse) => void
    const result = new Promise<RequestPermissionResponse>((resolve) => (resolveResult = resolve))
    // Publish BEFORE the store write: the write awaits, and a cancellation sweep landing in
    // that window must find this entry or the agent waits on a resolver nobody can reach.
    this.pendingEditorPermissions.set(id, {
      kind: 'permission',
      owner: p.hostKey,
      agentId,
      sessionId,
      params,
      evaluationParams,
      resolve: resolveResult
    })
    this.syncApprovalActivity(p.hostKey, sessionId)
    // The human wait starts when the request becomes answerable, not when its row lands — the
    // write used to be synchronous, and billing it to the turn's retry budget would shrink it.
    const wait = this.trackHumanApprovalWait(p, result)
    const recorded = this.noteEditorPermissionRequest(id, agentId, sessionId, permissionRequestParts(params), p)
    this.recordedWrites.set(id, recorded)
    let requesterName: string | null = null
    try {
      requesterName = (await recorded).requesterName
    } catch (err) {
      this.pendingEditorPermissions.delete(id)
      this.syncApprovalActivity(p.hostKey, sessionId, { id })
      this.recordedWrites.delete(id)
      resolveResult({ outcome: { outcome: 'cancelled' } })
      await wait
      throw err
    }
    this.recordedWrites.delete(id)
    this.dispatchApprovalDm(id, agentId, p, requesterName)
    return wait
  }

  private async awaitEditorElicitation(
    agentId: string,
    sessionId: string,
    params: CreateElicitationRequest,
    p: Pending
  ): Promise<CreateElicitationResponse> {
    const id = randomUUID()
    let resolveResult!: (res: CreateElicitationResponse) => void
    const result = new Promise<CreateElicitationResponse>((resolve) => (resolveResult = resolve))
    this.pendingEditorPermissions.set(id, {
      kind: 'elicitation',
      owner: p.hostKey,
      agentId,
      sessionId,
      params,
      resolve: resolveResult
    })
    this.syncApprovalActivity(p.hostKey, sessionId)
    const wait = this.trackHumanApprovalWait(p, result)
    const recorded = this.noteEditorPermissionRequest(id, agentId, sessionId, elicitationApprovalParts(params), p)
    this.recordedWrites.set(id, recorded)
    let requesterName: string | null = null
    try {
      requesterName = (await recorded).requesterName
    } catch (err) {
      this.pendingEditorPermissions.delete(id)
      this.syncApprovalActivity(p.hostKey, sessionId, { id })
      this.recordedWrites.delete(id)
      resolveResult({ action: 'cancel' })
      await wait
      throw err
    }
    this.recordedWrites.delete(id)
    this.dispatchApprovalDm(id, agentId, p, requesterName)
    return wait
  }

  private async awaitChatPermission(
    agentId: string,
    sessionId: string,
    params: RequestPermissionRequest,
    evaluationParams: RequestPermissionRequest,
    p: Pending
  ): Promise<RequestPermissionResponse> {
    const requestId = randomUUID()
    const conn = p.conn as SlackConnection
    let resolveResult!: (res: RequestPermissionResponse) => void
    const result = new Promise<RequestPermissionResponse>((resolve) => (resolveResult = resolve))
    this.pendingChatPermissions.set(requestId, {
      owner: p.hostKey,
      agentId,
      sessionId,
      params,
      evaluationParams,
      conn,
      channel: p.plan.channel,
      resolve: resolveResult
    })
    this.syncApprovalActivity(p.hostKey, sessionId)
    const recorded = this.noteEditorPermissionRequest(
      requestId,
      agentId,
      sessionId,
      permissionRequestParts(params),
      p,
      false
    )
    this.recordedWrites.set(requestId, recorded)
    try {
      await recorded
    } catch (err) {
      this.pendingChatPermissions.delete(requestId)
      this.syncApprovalActivity(p.hostKey, sessionId, { id: requestId })
      this.recordedWrites.delete(requestId)
      throw err
    }
    this.recordedWrites.delete(requestId)
    // Settled while the row was being written: never post a card for a request already resolved.
    if (!this.pendingChatPermissions.has(requestId)) return await result
    const blocks = buildPermissionCard(requestId, params, this.host.httpSlackSessionTarget(p))
    const fallback = `Permission requested: ${params.toolCall?.title ?? 'a tool call'}`
    const ts = await this.host.postCardSerialized(p, (slack) =>
      (slack as SlackConnection).postBlocks(p.plan.channel, blocks, fallback, p.plan.statusThread, {
        ...(slackAgentIdentityOptions(p.plan) ?? {}),
        chrome: true
      })
    )
    const live = this.pendingChatPermissions.get(requestId)
    if (!live) {
      if (ts) {
        void conn
          .updateBlocks(
            p.plan.channel,
            ts,
            buildPermissionResolvedCard(params, 'Cancelled', undefined),
            'Permission cancelled',
            true
          )
          .catch(() => {})
      }
      return await result
    }
    if (!ts) {
      this.pendingChatPermissions.delete(requestId)
      this.syncApprovalActivity(p.hostKey, sessionId, { id: requestId })
      await this.resolveStoredPermissionRequest(agentId, requestId, 'expired')
      this.permissionEvaluationDetails.set(evaluationParams, { reason: 'permission_card_failed' })
      live.resolve({ outcome: { outcome: 'cancelled' } })
      return await result
    }
    live.ts = ts
    return await this.trackHumanApprovalWait(p, result)
  }

  /** Fire the best-effort §5 approval DM. Never blocks or fails the approval itself. */
  private dispatchApprovalDm(requestId: string, agentId: string, p: Pending, requesterName: string | null): void {
    void this.sendApprovalDm(requestId, agentId, p, requesterName).catch((err) => {
      this.host.log().warn(`approval DM for "${p.plan.sessionKey}" failed: ${formatErr(err)}`)
    })
  }

  private async sendApprovalDm(
    requestId: string,
    agentId: string,
    p: Pending,
    requesterName: string | null
  ): Promise<void> {
    const cp = this.host.cpApprovalRoute()
    if (!cp) return
    const preferred = p.plan.platform === 'slack' ? p.plan.integrationId : undefined
    const integrationIds = this.host.approvalDmIntegrations(agentId, preferred)
    if (integrationIds.length === 0) return
    const requesterId = p.plan.platform === 'slack' && p.plan.requesterId ? p.plan.requesterId : undefined
    const routed = await cp.approvalRoute(
      {
        agentId,
        requestId,
        sessionId: p.outwardSessionId,
        ...(requesterId ? { requesterId } : {}),
        integrationIds
      },
      this.host.orgForAgent(agentId)
    )
    const target = routed.target
    if (!target) return
    const rec = this.pendingEditorPermissions.get(requestId)
    if (!rec) return
    const conn = this.host.slackConnFor(target.integrationId)
    if (!conn) return
    const channel = await conn.openDirectMessage(target.userId)
    const sessionTarget = this.host.slackDmSessionTarget(p, target.integrationId)
    // A question this DM has no control for still gets its own block: the reader is handed the
    // ask and the console, never an intro with nothing under it (#1794). The request itself is
    // untouched — it stays open on the editor path, which is where the DM points.
    const card =
      rec.kind === 'permission'
        ? buildPermissionCard(requestId, rec.params, sessionTarget)
        : (buildElicitationCard(requestId, rec.params, sessionTarget, SLACK_DM_ELICIT_SURFACE) ??
          buildElicitDmUnanswerableCard(rec.params))
    const fromSlack = p.plan.platform === 'slack'
    const sourceUrl =
      fromSlack && p.conn instanceof SlackConnection
        ? slackThreadUrl(p.conn.workspaceUrl, p.plan.channel, p.plan.thread ?? p.plan.statusThread)
        : undefined
    // Quote the triggering Slack message only for its own author (§5.2): routing proves
    // canEdit, not that the recipient may read the source conversation — a private
    // channel's text must not ride a DM past Slack's ACL. Same integration ⇒ same
    // workspace, so the member-id comparison is sound; everyone else keeps the
    // permalink, where Slack enforces access itself.
    const sourceText =
      fromSlack && target.integrationId === p.plan.integrationId && target.userId === p.plan.requesterId
        ? p.entry.msg.text
        : undefined
    const intro = buildApprovalDmIntro({
      agentName: p.plan.agentName,
      requesterName,
      sessionUrl: this.host.sessionLink(p.outwardSessionId, 'slack'),
      ...(sourceUrl ? { sourceUrl } : {}),
      ...(sourceText ? { sourceText } : {})
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
    const handleStored = await this.host
      .store()
      .setPermissionRequestNotify(agentId, requestId, target.integrationId, channel, ts)
    // Re-read AFTER the write: a decision landing inside that await saw no `notify`, so
    // it neither rewrote this card nor cleared the handle — both fall to us here.
    const live = this.pendingEditorPermissions.get(requestId)
    if (!handleStored || !live) {
      // Settled while posting: never leave live buttons on a decided request.
      const resolved =
        rec.kind === 'permission'
          ? buildPermissionResolvedCard(rec.params, 'Already decided', undefined)
          : buildElicitationResolvedCard(rec.params, ':hourglass: Already decided')
      void conn.updateBlocks(channel, ts, [...intro, ...resolved], 'Permission resolved', true).catch(() => {})
      if (handleStored)
        void this.host
          .store()
          .clearPermissionRequestNotify(agentId, requestId)
          .catch(() => {})
      return
    }
    const elicit = rec.kind === 'elicitation' ? elicitTarget(rec.params, SLACK_DM_ELICIT_SURFACE) : null
    live.notify = {
      target,
      conn,
      channel,
      ts,
      intro,
      ...(elicit ? { propName: elicit.propName, valueKind: elicit.kind } : {})
    }
  }

  /** Whether this request's DM card was addressed through `integrationId` (§5.3). The relay
   *  click path routes such clicks here directly: a DM lives outside any session conversation,
   *  so the in-conversation session gate can never admit it — authorization is the click-time
   *  actor + verify checks, fenced on the agent and the integration the card was posted via. */
  dmNotifiedVia(requestId: string, agentId: string, integrationId: string): boolean {
    const rec = this.pendingEditorPermissions.get(requestId)
    return rec?.agentId === agentId && rec.notify?.target.integrationId === integrationId
  }

  /** §6.3 click-time checks: actor equality, then the CP verify — both fail closed.
   *  `authoritative: true` means the refusal is a rights answer, not an outage. */
  private async verifyDmActor(
    agentId: string,
    requestId: string,
    notify: DmNotice,
    actor: InteractionActor | undefined
  ): Promise<{ ok: true; name: string | null } | { ok: false; authoritative: boolean }> {
    if (!actor || actor.userId !== notify.target.userId) return { ok: false, authoritative: false }
    const cp = this.host.cpApprovalRoute()
    if (!cp) return { ok: false, authoritative: false }
    try {
      const res = await cp.approvalRoute(
        {
          agentId,
          requestId,
          integrationIds: [notify.target.integrationId],
          verify: {
            integrationId: notify.target.integrationId,
            teamId: notify.target.teamId,
            userId: actor.userId,
            consoleUserId: notify.target.consoleUserId
          }
        },
        this.host.orgForAgent(agentId)
      )
      return res.allowed === true
        ? { ok: true, name: res.displayName ?? notify.target.displayName ?? actor.name ?? null }
        : { ok: false, authoritative: true }
    } catch {
      return { ok: false, authoritative: false }
    }
  }

  private dmDecider(notify: DmNotice, name: string | null): { resolvedBy: string; resolvedByName: string | null } {
    return { resolvedBy: `slack:${notify.target.teamId}:${notify.target.userId}`, resolvedByName: name }
  }

  private async handleDmPermissionChoice(
    requestId: string,
    rec: EditorPermissionEntry,
    optionId: string,
    actor: InteractionActor | undefined
  ): Promise<void> {
    const notify = rec.notify!
    const verdict = await this.verifyDmActor(rec.agentId, requestId, notify, actor)
    if (!verdict.ok) {
      this.host.logSessionAction(`permission:${optionId} (refused)`, rec.sessionId, actor)
      // An outage or a wrong actor leaves the live card alone; only a rights answer retires it.
      if (verdict.authoritative) {
        void notify.conn
          .updateBlocks(
            notify.channel,
            notify.ts,
            [
              ...notify.intro,
              ...buildPermissionResolvedCard(
                rec.params,
                'No longer authorized — decide it from the Agent or Session page',
                undefined
              )
            ],
            'Permission requires an Agent editor',
            true
          )
          .catch(() => {})
      }
      return
    }
    const option = rec.params.options.find((candidate) => candidate.optionId === optionId)
    if (!option) return
    const allowed = option.kind === 'allow_once' || option.kind === 'allow_always'
    const by = this.dmDecider(notify, verdict.name)
    if (!(await this.resolveStoredPermissionRequest(rec.agentId, requestId, allowed ? 'allowed' : 'denied', by))) return
    this.host.logSessionAction(`permission:${allowed ? 'allowed' : 'denied'}`, rec.sessionId, actor)
    this.pendingEditorPermissions.delete(requestId)
    this.syncApprovalActivity(rec.owner, rec.sessionId, { id: requestId, allowed })
    this.permissionEvaluationDetails.set(rec.evaluationParams, { reason: 'agent_editor' })
    void notify.conn
      .updateBlocks(
        notify.channel,
        notify.ts,
        [
          ...notify.intro,
          ...buildPermissionResolvedCard(
            rec.params,
            verdict.name ? `${option.name} — ${verdict.name}` : option.name,
            allowed
          )
        ],
        'Permission resolved',
        true
      )
      .catch(() => {})
    void this.host
      .store()
      .clearPermissionRequestNotify(rec.agentId, requestId)
      .catch(() => {})
    rec.resolve({ outcome: { outcome: 'selected', optionId: option.optionId } })
  }

  private async handleDmElicitChoice(
    requestId: string,
    rec: EditorElicitationEntry,
    value: string | null,
    actor: InteractionActor | undefined
  ): Promise<void> {
    const notify = rec.notify!
    const verdict = await this.verifyDmActor(rec.agentId, requestId, notify, actor)
    if (!verdict.ok) {
      this.host.logSessionAction(`permission:elicit (refused)`, rec.sessionId, actor)
      if (verdict.authoritative) {
        void notify.conn
          .updateBlocks(
            notify.channel,
            notify.ts,
            [
              ...notify.intro,
              ...buildElicitationResolvedCard(rec.params, ':lock: No longer authorized — decide it from the console')
            ],
            'Permission requires an Agent editor',
            true
          )
          .catch(() => {})
      }
      return
    }
    let res: CreateElicitationResponse
    let decision: string
    if (value === null) {
      res = { action: 'decline' }
      decision = ':no_entry_sign: Dismissed'
    } else if (notify.propName && notify.valueKind) {
      // Same card builder, same re-derivation: the actor checks above say who tapped, not what
      // this card offered, so an unoffered value is dropped and the DM card stays live.
      const target = elicitTarget(rec.params, SLACK_DM_ELICIT_SURFACE)
      // The DM card is a Slack button row, so it carries positions too (#1794).
      const picked = target ? elicitOptionLiteral(target, value) : null
      if (!target || picked === null || !fieldAccepts(target, picked)) return
      const chosen = notify.valueKind === 'boolean' ? picked === 'true' : picked
      res = { action: 'accept', content: { [notify.propName]: chosen } }
      decision = `:white_check_mark: ${notify.valueKind === 'boolean' ? (chosen ? 'Yes' : 'No') : picked}`
    } else {
      return
    }
    const by = this.dmDecider(notify, verdict.name)
    if (!(await this.resolveStoredPermissionRequest(rec.agentId, requestId, value === null ? 'denied' : 'allowed', by)))
      return
    this.host.logSessionAction(`permission:${value === null ? 'denied' : 'allowed'}`, rec.sessionId, actor)
    this.pendingEditorPermissions.delete(requestId)
    this.syncApprovalActivity(rec.owner, rec.sessionId, { id: requestId, allowed: value !== null })
    void notify.conn
      .updateBlocks(
        notify.channel,
        notify.ts,
        [
          ...notify.intro,
          ...buildElicitationResolvedCard(rec.params, verdict.name ? `${decision} — ${verdict.name}` : decision)
        ],
        'Permission resolved',
        true
      )
      .catch(() => {})
    void this.host
      .store()
      .clearPermissionRequestNotify(rec.agentId, requestId)
      .catch(() => {})
    rec.resolve(res)
  }

  async decideEditorPermission(req: AgentPermissionDecision): Promise<Ack> {
    const decidedBy = { resolvedBy: req.decidedBy ?? null, resolvedByName: req.decidedByName ?? null }
    const decidedAllow = req.decision === 'allow'
    const pending = this.pendingEditorPermissions.get(req.requestId)
    if (!pending || pending.agentId !== req.agentId) {
      const chat = this.pendingChatPermissions.get(req.requestId)
      if (!chat || chat.agentId !== req.agentId) {
        const elicitation = this.pendingElicits.get(req.requestId)
        if (!elicitation?.approval || elicitation.agentId !== req.agentId) {
          return { ok: false, reason: 'permission request is no longer pending' }
        }
        if (
          !(await this.resolveStoredPermissionRequest(
            req.agentId,
            req.requestId,
            req.decision === 'allow' ? 'allowed' : 'denied',
            decidedBy
          ))
        ) {
          return { ok: false, reason: 'permission request is no longer pending' }
        }
        this.pendingElicits.delete(req.requestId)
        this.syncApprovalActivity(elicitation.owner, elicitation.sessionId, {
          id: req.requestId,
          allowed: decidedAllow
        })
        // Only a chat card is rewritten here: an editor decision settles approvals, and an
        // approval elicitation never lands on the webchat surface.
        if (elicitation.surface === 'chat') {
          const label: ElicitCardLabel =
            req.decision === 'allow'
              ? { mark: 'answered', text: 'Allowed by Agent editor', fallback: 'Permission resolved' }
              : { mark: 'dismissed', text: 'Denied by Agent editor', fallback: 'Permission resolved' }
          // Through settleChatCard, so a decision that beats the post leaves its label for the
          // posting path instead of leaving a card standing with buttons nobody awaits.
          this.settleChatCard(elicitation, req.requestId, false, label)
        }
        elicitation.resolve(req.decision === 'allow' ? { action: 'accept' } : { action: 'cancel' })
        return { ok: true }
      }
      const option =
        req.decision === 'allow'
          ? (chat.params.options.find((candidate) => candidate.kind === 'allow_once') ??
            chat.params.options.find((candidate) => candidate.kind === 'allow_always'))
          : (chat.params.options.find((candidate) => candidate.kind === 'reject_once') ??
            chat.params.options.find((candidate) => candidate.kind === 'reject_always'))
      if (req.decision === 'allow' && !option) return { ok: false, reason: 'runtime did not offer an allow option' }
      if (
        !(await this.resolveStoredPermissionRequest(
          req.agentId,
          req.requestId,
          req.decision === 'allow' ? 'allowed' : 'denied',
          decidedBy
        ))
      ) {
        return { ok: false, reason: 'permission request is no longer pending' }
      }
      this.pendingChatPermissions.delete(req.requestId)
      this.syncApprovalActivity(chat.owner, chat.sessionId, { id: req.requestId, allowed: decidedAllow })
      this.permissionEvaluationDetails.set(chat.evaluationParams, { reason: 'agent_editor' })
      if (chat.ts) {
        void chat.conn
          .updateBlocks(
            chat.channel,
            chat.ts,
            buildPermissionResolvedCard(
              chat.params,
              option?.name ?? 'Denied by Agent editor',
              req.decision === 'allow'
            ),
            'Permission resolved',
            true
          )
          .catch(() => {})
      }
      chat.resolve(
        option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } }
      )
      return { ok: true }
    }

    let permissionResponse: RequestPermissionResponse | undefined
    let elicitationResponse: CreateElicitationResponse | undefined
    if (pending.kind === 'permission') {
      const option =
        req.decision === 'allow'
          ? (pending.params.options.find((o) => o.kind === 'allow_once') ??
            pending.params.options.find((o) => o.kind === 'allow_always'))
          : (pending.params.options.find((o) => o.kind === 'reject_once') ??
            pending.params.options.find((o) => o.kind === 'reject_always'))
      if (req.decision === 'allow' && !option) return { ok: false, reason: 'runtime did not offer an allow option' }
      this.permissionEvaluationDetails.set(pending.evaluationParams, { reason: 'agent_editor' })
      permissionResponse = option
        ? { outcome: { outcome: 'selected', optionId: option.optionId } }
        : { outcome: { outcome: 'cancelled' } }
    } else {
      elicitationResponse = req.decision === 'allow' ? { action: 'accept' } : { action: 'cancel' }
    }

    if (
      !(await this.resolveStoredPermissionRequest(
        req.agentId,
        req.requestId,
        req.decision === 'allow' ? 'allowed' : 'denied',
        decidedBy
      ))
    ) {
      return { ok: false, reason: 'permission request is no longer pending' }
    }
    this.pendingEditorPermissions.delete(req.requestId)
    this.syncApprovalActivity(pending.owner, pending.sessionId, { id: req.requestId, allowed: decidedAllow })
    if (pending.notify) {
      const label = `${req.decision === 'allow' ? 'Allowed' : 'Denied'} by ${req.decidedByName ?? 'an Agent editor'}`
      const blocks =
        pending.kind === 'permission'
          ? buildPermissionResolvedCard(pending.params, label, req.decision === 'allow')
          : buildElicitationResolvedCard(
              pending.params,
              `${req.decision === 'allow' ? ':white_check_mark:' : ':no_entry_sign:'} ${label}`
            )
      void pending.notify.conn
        .updateBlocks(
          pending.notify.channel,
          pending.notify.ts,
          [...pending.notify.intro, ...blocks],
          'Permission resolved',
          true
        )
        .catch(() => {})
      void this.host
        .store()
        .clearPermissionRequestNotify(req.agentId, req.requestId)
        .catch(() => {})
    }
    if (pending.kind === 'permission') pending.resolve(permissionResponse!)
    else pending.resolve(elicitationResponse!)
    return { ok: true }
  }

  async handlePermissionChoice(input: {
    requestId: string
    optionId: string
    actor?: InteractionActor
  }): Promise<void> {
    // A DM card's request lives on the editor path (§2) — the chat gate never applies to it.
    const editor = this.pendingEditorPermissions.get(input.requestId)
    if (editor?.kind === 'permission' && editor.notify) {
      return await this.handleDmPermissionChoice(input.requestId, editor, input.optionId, input.actor)
    }
    const pending = this.pendingChatPermissions.get(input.requestId)
    if (!pending) return
    if (this.host.agents().get(pending.agentId)?.allowRuntimeChangesInChat !== true) {
      // Refused, so it decided nothing — recorded as an attempt, never as the decision.
      this.host.logSessionAction(`permission:${input.optionId} (refused)`, pending.sessionId, input.actor)
      if (pending.ts) {
        void pending.conn
          .updateBlocks(
            pending.channel,
            pending.ts,
            buildPermissionResolvedCard(pending.params, 'Ask an Agent editor to allow it', undefined),
            'Permission requires an Agent editor',
            true
          )
          .catch(() => {})
      }
      return
    }
    const option = pending.params.options.find((candidate) => candidate.optionId === input.optionId)
    if (!option) return
    const allowed = option.kind === 'allow_once' || option.kind === 'allow_always'
    const team = pending.conn.workspaceId()
    const by = input.actor
      ? {
          resolvedBy: team ? `slack:${team}:${input.actor.userId}` : null,
          resolvedByName: input.actor.name ?? null
        }
      : undefined
    if (
      !(await this.resolveStoredPermissionRequest(pending.agentId, input.requestId, allowed ? 'allowed' : 'denied', by))
    )
      return
    // Only now is this click the decision: the guard passed, the option was real, and
    // the request resolved. Logging any earlier would attribute a tool call to someone
    // whose click changed nothing.
    this.host.logSessionAction(`permission:${allowed ? 'allowed' : 'denied'}`, pending.sessionId, input.actor)
    this.pendingChatPermissions.delete(input.requestId)
    this.syncApprovalActivity(pending.owner, pending.sessionId, { id: input.requestId, allowed })
    this.permissionEvaluationDetails.set(pending.evaluationParams, { reason: 'chat_user' })
    if (pending.ts) {
      void pending.conn
        .updateBlocks(
          pending.channel,
          pending.ts,
          buildPermissionResolvedCard(pending.params, option.name, allowed),
          'Permission resolved',
          true
        )
        .catch(() => {})
    }
    pending.resolve({ outcome: { outcome: 'selected', optionId: option.optionId } })
  }

  /** Remove stale Allow/Deny controls immediately when an editor disables chat-side
   * runtime controls. The permission requests remain pending for the Agent-page queue. */
  disableChatPermissionSurfaces(agentId: string): void {
    for (const pending of this.pendingChatPermissions.values()) {
      if (pending.agentId !== agentId || !pending.ts) continue
      void pending.conn
        .updateBlocks(
          pending.channel,
          pending.ts,
          buildPermissionResolvedCard(pending.params, 'Ask an Agent editor to allow it', undefined),
          'Permission requires an Agent editor',
          true
        )
        .catch(() => {})
    }
    for (const pending of this.pendingElicits.values()) {
      if (pending.agentId !== agentId || !pending.approval || pending.surface !== 'chat' || !pending.ts) continue
      pending.facet.settle(pending, elicitSettlement(pending.params, false, ELICIT_EDITOR_ONLY))
    }
  }

  async releaseChatPermissions(owner: HostKey, sessionId: string): Promise<void> {
    const agentId = hostKeyAgentId(owner)
    for (const [id, pending] of this.pendingChatPermissions) {
      if (pending.owner !== owner || pending.sessionId !== sessionId) continue
      this.pendingChatPermissions.delete(id)
      this.syncApprovalActivity(owner, sessionId, { id })
      await this.resolveStoredPermissionRequest(agentId, id, 'expired')
      this.permissionEvaluationDetails.set(pending.evaluationParams, { reason: 'turn_cancelled' })
      if (pending.ts) {
        void pending.conn
          .updateBlocks(
            pending.channel,
            pending.ts,
            buildPermissionResolvedCard(pending.params, 'Cancelled', undefined),
            'Permission cancelled',
            true
          )
          .catch(() => {})
      }
      pending.resolve({ outcome: { outcome: 'cancelled' } })
    }
  }

  async releaseEditorPermissions(owner: HostKey, sessionId: string): Promise<void> {
    const agentId = hostKeyAgentId(owner)
    for (const [id, pending] of this.pendingEditorPermissions) {
      if (pending.owner !== owner || pending.sessionId !== sessionId) continue
      this.pendingEditorPermissions.delete(id)
      this.syncApprovalActivity(owner, sessionId, { id })
      await this.resolveStoredPermissionRequest(agentId, id, 'expired')
      // Dead buttons must not survive the request (§5.4): retire the DM card in place.
      if (pending.notify) {
        const blocks =
          pending.kind === 'permission'
            ? buildPermissionResolvedCard(pending.params, 'Cancelled', undefined)
            : buildElicitationResolvedCard(pending.params, ':hourglass: Cancelled')
        void pending.notify.conn
          .updateBlocks(
            pending.notify.channel,
            pending.notify.ts,
            [...pending.notify.intro, ...blocks],
            'Permission cancelled',
            true
          )
          .catch(() => {})
        void this.host
          .store()
          .clearPermissionRequestNotify(agentId, id)
          .catch(() => {})
      }
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

  /**
   * ACP `session/request_permission` policy (wired as AcpHost.onPermission). Built-in
   * AgentConnect tools are trusted; every other live request waits for an Agent editor by
   * default. An editor may explicitly opt an agent into Slack chat-side decisions.
   */
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
    // Extraction is a silent background operation: it may never gain side effects
    // merely because the user agent normally runs in an auto-approval mode.
    if (this.host.memoryExtractionInFlight(pendingTurnKey(owner, sessionId))) {
      this.permissionEvaluationDetails.set(evaluationParams, { reason: 'memory_extraction' })
      return { outcome: { outcome: 'cancelled' } }
    }
    // Platform system tools (this daemon's OWN MCP tools — sendMessage, listAgents,
    // orchestration, memory, …) are always granted: a human should never
    // have to approve them per call. Auto-allow without rendering a card. Non-system tools
    // (incl. the runtime's dangerous built-ins) fall through to the interactive policy below.
    const p = this.host.pending().get(pendingTurnKey(owner, sessionId))
    if (isBuiltinSystemTool(params, p?.builtinSystemToolCallIds)) {
      const allow = params.options.find((o) => o.kind === 'allow_always' || o.kind === 'allow_once')
      if (allow) {
        this.permissionEvaluationDetails.set(evaluationParams, { reason: 'agentconnect_system_tool' })
        this.host.evalHooks().emit({
          type: 'permission.auto_allowed',
          agentId,
          sessionId,
          ...(p?.plan.evaluationTurnId ? { turnId: p.plan.evaluationTurnId } : {}),
          data: { reason: 'agentconnect_system_tool', optionId: allow.optionId }
        })
        return { outcome: { outcome: 'selected', optionId: allow.optionId } }
      }
    }
    if (!p || p.outputSuppressed) {
      this.permissionEvaluationDetails.set(evaluationParams, {
        reason: p?.outputSuppressed ?? 'permission_without_live_turn'
      })
      return { outcome: { outcome: 'cancelled' } }
    }
    const chatApprovalEnabled =
      this.host.agents().get(agentId)?.allowRuntimeChangesInChat === true &&
      turnChromeFor(p.plan.platform).chatInputCards === true &&
      p.conn instanceof SlackConnection &&
      !p.plan.approvalSurfaceSuppressed &&
      params.options.length > 0
    if (chatApprovalEnabled) {
      return await this.awaitChatPermission(agentId, sessionId, params, evaluationParams, p)
    }
    // Default policy: hold the runtime request and surface only a neutral notice
    // in chat. The bounded, masked request is decided by an Agent editor.
    return await this.awaitEditorPermission(agentId, sessionId, params, evaluationParams, p)
  }

  /**
   * ACP `elicitation/create` policy (wired as AcpHost.onElicit). Renders the form's first
   * choice/boolean field as a Slack card and resolves with the user's pick. Returns
   * `undefined` — so the host declines — when there's no live turn, the turn isn't on
   * Slack, or the form has no field we can render inline. Stays pending until the user
   * taps a button (handleElicitChoice) or the turn ends/cancels (releaseElicits).
   */
  async onAcpElicit(
    owner: HostKey,
    sessionId: string,
    params: CreateElicitationRequest
  ): Promise<CreateElicitationResponse | undefined> {
    const agentId = hostKeyAgentId(owner)
    // Same reason as onAcpPermission: the elicitation message/labels are agent-authored
    // text headed for a platform card — mask any embedded secret value first.
    params = this.host.maskAgentSecrets(agentId, params)
    const p = this.host.pending().get(pendingTurnKey(owner, sessionId))
    if (!p) return undefined
    if (p.outputSuppressed) return { action: 'cancel' }
    // Codex maps MCP approval to `elicitation/create` when form support is
    // advertised. Correlate its opaque id with a preceding trusted tool event;
    // never infer trust from the human-facing elicitation message.
    if (isBuiltinSystemToolElicitation(params, p.builtinSystemToolCallIds)) return { action: 'accept' }
    const isApproval = isMcpToolApprovalElicitation(params)
    if (isApproval) {
      const chatApprovalEnabled =
        this.host.agents().get(agentId)?.allowRuntimeChangesInChat === true &&
        turnChromeFor(p.plan.platform).chatInputCards === true &&
        p.conn instanceof SlackConnection &&
        !p.plan.approvalSurfaceSuppressed
      if (!chatApprovalEnabled) return await this.awaitEditorElicitation(agentId, sessionId, params, p)
    }
    // A `none` Slack turn has no generic human-input card to answer this request.
    if (p.plan.approvalSurfaceSuppressed) return { action: 'cancel' }
    // Webchat is a core-owned surface, not a chat-platform module, so it is answered here
    // rather than through turn-chrome's per-platform table. An MCP approval never reaches
    // this line — it took the editor queue above, since chat approval needs Slack — and the
    // `!isApproval` guard keeps that true if the branches above ever move. A continuation
    // mirrors an origin platform, so it keeps falling through to the Slack path.
    // URL mode is the seam the spec reserves for credentials, OAuth and payment — the page must
    // stay out of the model's context and off every card, so only a surface that can render the
    // consent card takes it and every other one declines (elicitTarget is null for it anyway).
    const url = elicitUrl(params)
    if (p.webchat && !p.webchat.continuation && !isApproval) {
      return url
        ? await this.awaitWebchatUrlElicitation(agentId, sessionId, params, p, p.webchat, url)
        : await this.awaitWebchatElicitation(agentId, sessionId, params, p, p.webchat)
    }
    // A platform name is never core knowledge (integration-plugin-architecture.md): the turn
    // surface's own elicitation-card facet says whether this chat can collect an answer, and the
    // lookup is EXACT so a hook or dream turn rendering through the core surface does not inherit
    // Slack's cards. No connection means no surface at all, headless included.
    const facet = p.conn ? this.host.elicitCardFacet(p.plan.platform) : undefined
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

  /**
   * The daemon's own ask: a capture-excluded session's memory write waits for the human in that
   * session (session-visibility.md §5.1). One synthetic three-way form takes the SAME surfaces an
   * agent's elicitation does — webchat's in-stream card, the platform's elicitation card where it
   * has one, else the Agent-editor queue — and a turn with no human behind it (none live,
   * suppressed, headless, an A2A child) answers `no_approver` at once rather than hanging the tool.
   * Turn cancellation settles it through `releaseElicits`/`releaseEditorPermissions` as a decline.
   */
  async askMemoryWriteApproval(
    owner: HostKey,
    sessionId: string,
    ask: MemoryWriteAsk
  ): Promise<MemoryWriteApprovalOutcome> {
    const agentId = hostKeyAgentId(owner)
    const p = this.host.pending().get(pendingTurnKey(owner, sessionId))
    if (!p || p.outputSuppressed) return 'no_approver'
    if (p.entry.msg.headless === true || p.callMeta || isSyntheticA2aChannel(p.plan.channel)) return 'no_approver'
    // The summary is model-authored text headed for a card: mask a secret it may have interpolated.
    const params = this.host.maskAgentSecrets(agentId, memoryWriteApprovalElicitation(sessionId, ask))
    try {
      if (p.webchat && !p.webchat.continuation) {
        const res = this.awaitWebchatElicitation(agentId, sessionId, params, p, p.webchat)
        return memoryWriteApprovalFrom(await this.trackHumanApprovalWait(p, res))
      }
      const facet = p.conn && !p.plan.approvalSurfaceSuppressed ? this.host.elicitCardFacet(p.plan.platform) : undefined
      const form = facet ? elicitForm(params, facet.reduction) : null
      if (facet && form) {
        const res = this.awaitChatElicitation(agentId, sessionId, params, p, facet, { form }, false)
        return memoryWriteApprovalFrom(await this.trackHumanApprovalWait(p, res))
      }
      // No card in this chat: the editor queue (console Approval requests, approval DM) decides.
      return memoryWriteApprovalFrom(await this.awaitEditorElicitation(agentId, sessionId, params, p))
    } catch (err) {
      this.host.log().warn(`memory write approval could not be asked for "${p.plan.sessionKey}": ${formatErr(err)}`)
      return 'no_approver'
    }
  }

  /**
   * Post ONE elicitation card on the turn's own chat surface and park the resolver until it is
   * answered, dismissed, or the turn ends.
   *
   * The three Slack paths this replaces — the one-tap button row, the filled-in card with its
   * Confirm, and URL mode's consent card — differed only in which card was built and what the
   * record carried, so the facet builds the card and what is left here is everything that is NOT
   * platform-shaped: the record, the mid-post settlement race, and the approval bookkeeping.
   *
   * A card this surface has no control for is declined with the notice every other unrenderable
   * ask gets: `build` returns null and nothing is posted or recorded as open.
   */
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
    // A card whose fields have to be filled in answers with a RECORD, and a consent card has no
    // field at all: both carry the one-tap card's field shape unused, and neither path reads it.
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
    this.pendingElicits.set(requestId, {
      owner: p.hostKey,
      agentId,
      sessionId,
      params,
      propName: inputs || url ? '' : (target?.propName ?? ''),
      kind: inputs || url ? 'text' : (target?.kind ?? 'text'),
      ...(inputs && form ? { form } : {}),
      ...(url ? { url } : {}),
      approval: isApproval,
      surface: 'chat',
      facet,
      conn: p.conn,
      channel: p.plan.channel,
      answerConv: p.plan.transcriptChannel,
      // An MCP approval keeps its durable record in `permission_requests` and its own console
      // surface, so it is not also a transcript card.
      ...(isApproval
        ? {}
        : this.recordElicitCard(
            p,
            url
              ? elicitUrlCardPayload(requestId, message, url.url)
              : elicitCardPayload(requestId, message, params, form ?? [])
          )),
      resolve: resolveResult
    })
    this.syncApprovalActivity(p.hostKey, sessionId)
    if (isApproval) {
      const recorded = this.noteEditorPermissionRequest(
        requestId,
        agentId,
        sessionId,
        elicitationApprovalParts(params),
        p,
        false
      )
      this.recordedWrites.set(requestId, recorded)
      try {
        await recorded
      } catch (err) {
        this.pendingElicits.delete(requestId)
        this.syncApprovalActivity(p.hostKey, sessionId, { id: requestId })
        this.recordedWrites.delete(requestId)
        throw err
      }
      this.recordedWrites.delete(requestId)
      if (!this.pendingElicits.has(requestId)) return await result
    }
    const ts = await facet.send(this.elicitCardHost, p, ask, draft)
    const live = this.pendingElicits.get(requestId)
    // Settled mid-post — the card must stop offering an answer nobody awaits, and must say how it
    // actually ended. A tap can reach the daemon before the platform has answered the post that
    // carried it, and calling that answer Cancelled contradicts what the reader just did; the
    // settlement left its own label here (#1794).
    if (!live) {
      const settled = this.takeSettledBeforePost(requestId)
      if (ts && settled)
        facet.settle({ conn: p.conn, channel: p.plan.channel, ts }, elicitSettlement(params, !!url, settled))
      return await result
    }
    if (!ts) {
      this.pendingElicits.delete(requestId)
      this.syncApprovalActivity(p.hostKey, sessionId, { id: requestId })
      if (isApproval) await this.resolveStoredPermissionRequest(agentId, requestId, 'expired')
      // A card the platform never took is closed on the row too, or it would read as open forever.
      this.settleElicitRow(live, 'cancelled')
      live.resolve({ action: 'cancel' })
      return await result
    }
    if (live.surface === 'chat') live.ts = ts
    return isApproval ? await this.trackHumanApprovalWait(p, result) : await result
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

  /** Webchat's peer of the Slack elicitation card: stream the card as an in-band event and
   *  park the same resolver. Takes the WHOLE form (`elicitForm`) rather than Slack's one field,
   *  so a multi-field ask renders one control per field and answers with a record; a one-field
   *  form takes the single-field path and its payload is unchanged. Returns `undefined`
   *  (⇒ decline) when the surface cannot render the form — including a `required` property it
   *  has no control for, which is the same verdict Slack reaches by the same rule — and now says
   *  so in the stream rather than declining into silence (#1794). */
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
    this.pendingElicits.set(requestId, {
      owner: p.hostKey,
      agentId,
      sessionId,
      params,
      propName: target.propName,
      kind: target.kind,
      ...(form.length > 1 ? { form } : {}),
      approval: false,
      surface: 'webchat',
      wc,
      ...this.recordElicitCard(p, card),
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
      // An undelivered card can never be answered — drop the resolver and decline now
      // rather than stall the runtime until the turn ends. No notice: this sink IS the only thing
      // that speaks to this reader, so a line saying the ask could not be shown would go out
      // through the very call that just threw, and a webchat turn has no second surface for it.
      const stillPending = this.pendingElicits.get(requestId)
      this.pendingElicits.delete(requestId)
      this.syncApprovalActivity(p.hostKey, sessionId, { id: requestId })
      // A card nobody was shown is closed on the row too, or it would read as open forever.
      if (stillPending) this.settleElicitRow(stillPending, 'cancelled')
      this.host.log().warn(`webchat elicitation card not delivered for "${p.plan.sessionKey}": ${formatErr(err)}`)
      return undefined
    }
    return await result
  }

  /** URL mode's peer of {@link awaitWebchatElicitation}: stream a CONSENT card carrying the
   *  exact URL and park the resolver until the reader consents or dismisses. The daemon never
   *  fetches the URL and never sees the page — the browser opens it in a tab of its own — so
   *  the only thing this seam decides is whether the user agreed to go there. */
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
    this.pendingElicits.set(requestId, {
      owner: p.hostKey,
      agentId,
      sessionId,
      params,
      // A URL card has no field; these are the record's unused shape, never read on this path.
      propName: '',
      kind: 'text',
      url,
      approval: false,
      surface: 'webchat',
      wc,
      ...this.recordElicitCard(p, card),
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
      const stillPending = this.pendingElicits.get(requestId)
      this.pendingElicits.delete(requestId)
      this.syncApprovalActivity(p.hostKey, sessionId, { id: requestId })
      // A card nobody was shown is closed on the row too, or it would read as open forever.
      if (stillPending) this.settleElicitRow(stillPending, 'cancelled')
      this.host.log().warn(`webchat consent card not delivered for "${p.plan.sessionKey}": ${formatErr(err)}`)
      return undefined
    }
    return await result
  }

  /**
   * The field list a live card's `input` blocks were built from, re-derived from its OWN params
   * rather than read back off the record (#1815) — the same reduction, on the same surface, so it
   * is the very list the card rendered. Null when this card has no inputs to submit.
   */
  private cardForm(rec: PendingElicit): ElicitTarget[] | null {
    return rec.form ? elicitForm(rec.params, surfaceOf(rec)) : null
  }

  /**
   * Answer a form card from its Confirm tap (SlackDeps.onElicitFormSubmit, and the relay's
   * `elicitation-confirm`). `fields` is the message state that tap carried, so it is what THIS
   * reader had filled in; nothing is held between a field change and the Confirm. The whole
   * record is re-derived against the form THAT CARD rendered, exactly as webchat's is (#1807) and
   * as every tapped option is (#1815): the rendered property set, every `required` name present,
   * an omitted optional field allowed, each value valid for its own field.
   *
   * One bad field refuses the whole answer, says which in the thread — a message card has no
   * modal to hand the errors back to — and leaves the card LIVE, which is the same verdict every
   * other surface's re-derivation reaches. Dismiss stays the only explicit refusal.
   */
  async submitElicitForm(a: {
    requestId: string
    fields: Record<string, string | string[]>
    actor?: InteractionActor
  }): Promise<void> {
    const rec = this.pendingElicits.get(a.requestId)
    if (!rec || rec.surface !== 'chat' || !rec.form) return
    const form = this.cardForm(rec)
    if (!form) return
    const submission = elicitFormSubmission(rec.params, form, a.fields)
    if (submission.errors) {
      this.noticeInTurn(rec, elicitFormRefusalNotice(rec.params, form, submission.errors))
      return
    }
    // No await between the check above and the settlement below, so two concurrent Confirms
    // cannot both pass: the loser finds no record at all.
    await this.handleElicitChoice({
      requestId: a.requestId,
      value: submission.answer ?? {},
      ...(a.actor ? { actor: a.actor } : {})
    })
  }

  /** Settle a URL-mode consent card. `accept` means only that the user agreed to OPEN the URL —
   *  not that whatever happens on that page finished — so the ACP request resolves right here
   *  and any later `elicitation/complete` is a re-label, not a second resolution. Dismiss is the
   *  spec's explicit `decline`; the turn ending is `cancel`, via releaseElicits. */
  private async handleUrlElicitConsent(
    requestId: string,
    rec: PendingElicit & { url: NonNullable<PendingElicit['url']> },
    a: { value: ElicitAnswer; webchatConversationId?: string }
  ): Promise<void> {
    // A card settles only from its own surface: its webchat conversation, or a Slack tap (no conversation).
    if (rec.surface === 'webchat') {
      if (a.webchatConversationId === undefined || rec.wc.conversationId !== a.webchatConversationId) return
    } else if (a.webchatConversationId !== undefined) return
    // Consent echoes the card's own ONE option back, checked the way every other card checks that
    // an answer was one it actually rendered. A Slack button carries that option as its position
    // (#1794), which is what keeps a URL too long for a button `value` from losing its card;
    // webchat's card carries the URL itself.
    const consented = a.value === (rec.surface === 'chat' ? elicitOptionToken(0) : rec.url.url)
    if (!consented && a.value !== null) return
    this.pendingElicits.delete(requestId)
    this.syncApprovalActivity(rec.owner, rec.sessionId, { id: requestId, allowed: consented })
    this.settleUrlElicit(rec, requestId, consented ? 'accepted' : 'dismissed')
    if (consented) this.rememberConsentedUrlElicit(requestId, rec)
    rec.resolve({ action: consented ? 'accept' : 'decline' })
  }

  /** Say on the card's own surface how a consent card ended: webchat appends a stream event, a
   *  chat surface rewrites the message. Best effort on both — no ACP resolution depends on it. */
  private settleUrlElicit(
    rec: PendingElicit,
    requestId: string,
    outcome: 'accepted' | 'dismissed' | 'cancelled' | 'completed'
  ): void {
    const label = outcome === 'accepted' ? 'Opened' : undefined
    this.settleElicitRow(rec, outcome, label)
    if (rec.surface === 'webchat') {
      this.emitWebchatElicitResolved(rec, requestId, outcome, label)
      return
    }
    this.settleChatCard(rec, requestId, true, URL_CONSENT_DECISION[outcome])
  }

  /** Park a consented card's coordinates so a later `elicitation/complete` can find it. Oldest
   *  out at the cap — a flow that never completes must not pin this map open forever. */
  private rememberConsentedUrlElicit(
    requestId: string,
    rec: PendingElicit & { url: NonNullable<PendingElicit['url']> }
  ): void {
    while (this.consentedUrlElicits.size >= CONSENTED_URL_ELICIT_CAP) {
      const oldest = this.consentedUrlElicits.keys().next().value
      if (oldest === undefined) break
      this.consentedUrlElicits.delete(oldest)
    }
    this.consentedUrlElicits.set(consentedUrlKey(rec.owner, rec.url.elicitationId), { requestId, rec })
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

  /** Append the settled card to a webchat stream — the append-only equivalent of Slack
   *  rewriting its message. Best effort: the ACP resolution never depends on it. */
  private emitWebchatElicitResolved(
    rec: Extract<PendingElicit, { surface: 'webchat' }>,
    requestId: string,
    outcome: 'accepted' | 'dismissed' | 'cancelled' | 'completed',
    label?: string
  ): void {
    try {
      rec.wc.sink.output({
        conversationId: rec.wc.conversationId,
        turnId: rec.wc.turnId,
        index: rec.wc.index++,
        event: { kind: 'elicitation_resolved', requestId, outcome, ...(label !== undefined ? { label } : {}) }
      })
    } catch (err) {
      this.host.log().warn(`webchat elicitation card not settled for ${requestId}: ${formatErr(err)}`)
    }
  }

  /**
   * Route one tap on a chat elicitation card, for a surface whose card ASSEMBLES its answer.
   *
   * Slack needs none of this: its message carries the reader's half-filled state itself, and every
   * value arrives on the Confirm. A Telegram keyboard has no state at all — a tap carries 64 bytes
   * and nothing else — so the card is assembled here instead, tap by tap, and the Confirm submits
   * through the very same {@link submitElicitForm} a Slack Confirm does. That is the point of
   * routing it through core rather than letting the surface answer on its own: ONE re-derivation
   * of the rendered form (#1815), one per-field validation, one refusal wording.
   *
   * Dismiss (`token === null`) is not folded into anything — it is the reader's one explicit
   * refusal on every card, assembled or not, and settles through the choice path unchanged.
   */
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
  }): Promise<void> {
    const actor = a.actor ? { actor: a.actor } : {}
    const rec = this.pendingElicits.get(a.requestId)
    // A one-tap card, an unknown request, and Dismiss all answer with the token as it came.
    if (a.token === null || !rec || rec.surface !== 'chat' || !rec.facet.tap || !rec.form)
      return await this.handleElicitChoice({ requestId: a.requestId, value: a.token, ...actor })
    // Only ever fills a gap: a recorded id is the send's own and is never overwritten by a tap.
    if (rec.ts === undefined && a.ts !== undefined) rec.ts = a.ts
    const form = this.cardForm(rec)
    if (!form) return
    const folded = rec.facet.tap(rec, { requestId: a.requestId, params: rec.params, form }, a.token)
    // A token naming nothing this card offers is refused aloud and leaves the card live, exactly
    // as an unoffered option value is: the reader just acted, so silence would read as a dead card.
    if (!folded) {
      this.noticeInTurn(rec, ELICIT_ANSWER_REFUSED)
      return
    }
    if (folded.kind === 'pending') return
    await this.submitElicitForm({ requestId: a.requestId, fields: folded.fields, ...actor })
  }

  /**
   * Offer one typed message to the live cards of its own conversation, answering the first that
   * claims it. True ⇒ it WAS an answer and must never also reach the agent as a prompt.
   *
   * A surface with no typed control claims nothing, so this is a no-op on every chat but the one
   * that asked someone to type. Where it does claim, the reply is validated by the same
   * {@link submitElicitForm} a Confirm goes through — a number that is not a number, a string
   * breaking its own `pattern`, are refused with the field's own words and the card left live.
   *
   * The claim is per CARD, never per person: anyone who can see a card may answer it, which is the
   * same rule its buttons follow. What keeps one answer to one card is the message it replies TO.
   */
  async claimElicitReply(reply: ElicitCardReply & { actor?: InteractionActor }): Promise<boolean> {
    if (reply.replyTo === undefined) return false
    for (const [requestId, rec] of this.pendingElicits) {
      if (rec.surface !== 'chat' || !rec.facet.claimReply || !rec.form) continue
      // Matched on the BOT-QUALIFIED conversation, never the bare channel: a person's DMs with two
      // Telegram bots share one chat id and one message-number sequence, so a bare channel would
      // let a reply to bot B's prompt settle bot A's card — and suppress B's own delivery with it.
      if (rec.answerConv !== reply.conversation) continue
      const form = this.cardForm(rec)
      if (!form) continue
      const claimed = rec.facet.claimReply(rec, { requestId, params: rec.params, form }, reply)
      if (!claimed || claimed.kind !== 'submit') continue
      await this.submitElicitForm({
        requestId,
        fields: claimed.fields,
        ...(reply.actor ? { actor: reply.actor } : {})
      })
      return true
    }
    return false
  }

  /** A tapped elicitation-card button (SlackDeps.onElicitChoice): resolve the pending ACP
   *  request — `accept` with the chosen value (a LIST of them for a multi-select, a real number
   *  for a numeric field, a RECORD of value-per-field for a form, under the field name(s)), or
   *  `decline` for the Dismiss button (value === null) — and edit the card in place. No-op if
   *  already gone. */
  async handleElicitChoice(a: {
    requestId: string
    value: ElicitAnswer
    actor?: InteractionActor
    /** Set only by the webchat ingress: the answering browser's conversation. It confines the
     *  answer to a card THIS conversation was shown — a webchat client may answer neither a Slack
     *  card nor another conversation's. Kept alongside the unguessable request id rather than
     *  replaced by it: an id is a secret, and a scope is a rule. */
    webchatConversationId?: string
  }): Promise<void> {
    // A DM elicitation card's request lives on the editor path (§2/§6.4).
    const editor = this.pendingEditorPermissions.get(a.requestId)
    if (editor?.kind === 'elicitation' && editor.notify) {
      // A DM card is a Slack button row: never answered by a list, a number, a form record,
      // or a browser.
      if (
        a.webchatConversationId !== undefined ||
        Array.isArray(a.value) ||
        typeof a.value === 'number' ||
        isFormAnswer(a.value)
      )
        return
      return await this.handleDmElicitChoice(a.requestId, editor, a.value, a.actor)
    }
    const rec = this.pendingElicits.get(a.requestId)
    if (!rec) return
    // A URL consent card has no field to validate — it takes its own URL back, or Dismiss.
    if (rec.url) return await this.handleUrlElicitConsent(a.requestId, { ...rec, url: rec.url }, a)
    // A FORM card is answered by a record and nothing else, and every other card by a scalar
    // or a list — re-derived from the card's own params, exactly as `target` is below.
    const form = this.cardForm(rec)
    if (rec.form && !form) return
    if (a.value !== null && isFormAnswer(a.value) !== !!form) return
    // Each kind takes one shape of answer and no other: a list for a multi-select, a number
    // for a numeric field, a string for the rest. Dismiss (null) settles any of them.
    if (a.value !== null && !isFormAnswer(a.value) && !answerFitsKind(rec.kind, a.value)) return
    const target = elicitTarget(rec.params, surfaceOf(rec))
    // A browser answers only a card ITS OWN conversation was shown: both surfaces mint ids from
    // one place, so the scope is what keeps one conversation's answer out of another's card.
    if (a.webchatConversationId !== undefined) {
      if (rec.surface !== 'webchat' || rec.wc.conversationId !== a.webchatConversationId) return
      // And a card settles only from its own surface, so a Slack tap never answers a webchat one.
    } else if (rec.surface === 'webchat') return
    // A Slack one-tap card carries each option's POSITION, not its value (#1794) — resolve it
    // against the card THAT card rendered, so an option whose value is a path, an id or a URL can
    // be tapped at all. ONE rule for the whole surface: what comes back is a position or it is not
    // an answer, exactly as `elicitFormSubmission` reads a Confirm. A form answer came through
    // that function, which resolved it already, and webchat carries literals: neither is remapped.
    const resolved: ElicitAnswer =
      rec.surface === 'chat' && !rec.form && target && typeof a.value === 'string'
        ? elicitOptionLiteral(target, a.value)
        : a.value
    // A position naming no option this card offered is refused with the same words, and the card
    // stays live — Dismiss is still the only `null` that settles anything.
    if (resolved === null && a.value !== null) {
      this.noticeInTurn(rec, ELICIT_ANSWER_REFUSED)
      return
    }
    const answer: ElicitAnswer = resolved
    // Every surface's answer is re-derived against the card that offered it: a signed interaction
    // and a relay that checks the block target say who tapped, never what the card offered.
    // An unoffered value would inject content the agent never asked for, so it is dropped and the
    // card stays live — one bad field refusing a whole form answer, as on webchat all along.
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
    // A refused answer is not a silent one (#1794): the reader just acted, the card is still
    // standing, so its own surface says the answer was not taken — the same words a refused
    // Confirm gets, on whichever transport that card was posted to. Nothing here changes WHAT is
    // refused, and there is no per-question dedup: one line per tap, as #1836's notice already is.
    if (!offered) {
      this.noticeInTurn(rec, ELICIT_ANSWER_REFUSED)
      return
    }
    if (rec.approval && this.host.agents().get(rec.agentId)?.allowRuntimeChangesInChat !== true) {
      if (rec.surface === 'chat') rec.facet.settle(rec, elicitSettlement(rec.params, false, ELICIT_EDITOR_ONLY))
      return
    }
    let res: CreateElicitationResponse
    let mark: ElicitCardMark
    // What the settled card says the answer WAS — the webchat label, and the decision's own tail.
    let answered: string | undefined
    // What the card's own words say beside the mark, which is not always the label: a scalar
    // answer's decision echoes the VALUE, where the row's label names the option.
    let decisionText: string
    if (answer === null) {
      res = { action: 'decline' }
      mark = 'dismissed'
      decisionText = 'Dismissed'
    } else if (isFormAnswer(answer)) {
      if (!form) return
      // A form's accepted content is the whole record: every answered field under its own name.
      res = { action: 'accept', content: elicitFormContent(form, answer) }
      answered = formAnswerLabel(rec.params, form, answer)
      mark = 'answered'
      decisionText = answered
    } else if (Array.isArray(answer)) {
      // The array property's accepted content is the chosen list itself.
      res = { action: 'accept', content: { [rec.propName]: answer } }
      answered = chosenLabel(target, answer)
      mark = 'answered'
      decisionText = answered
    } else {
      // The accepted content carries the schema's own type: a boolean for a boolean field and a
      // real number for a numeric one, never the string the wire happened to spell it with.
      const value = rec.kind === 'boolean' ? answer === 'true' : answer
      res = { action: 'accept', content: { [rec.propName]: value } }
      answered = chosenLabel(target, answer)
      mark = 'answered'
      decisionText = rec.kind === 'boolean' ? (value ? 'Yes' : 'No') : String(answer)
    }
    if (rec.approval) {
      // A chat approval's actor id is scoped the way its own surface scopes one (undefined where
      // the surface's ids are already global), so a recorded resolver is unique either way.
      const team = rec.surface === 'chat' ? rec.facet.answerScope?.(rec) : undefined
      const by = a.actor
        ? { resolvedBy: team ? `slack:${team}:${a.actor.userId}` : null, resolvedByName: a.actor.name ?? null }
        : undefined
      if (
        !(await this.resolveStoredPermissionRequest(
          rec.agentId,
          a.requestId,
          answer === null ? 'denied' : 'allowed',
          by
        ))
      )
        return
    }
    this.pendingElicits.delete(a.requestId)
    this.syncApprovalActivity(rec.owner, rec.sessionId, { id: a.requestId, allowed: answer !== null })
    const outcome = answer === null ? 'dismissed' : 'accepted'
    this.settleElicitRow(rec, outcome, answered)
    if (rec.surface === 'webchat') {
      this.emitWebchatElicitResolved(rec, a.requestId, outcome, answered)
    } else this.settleChatCard(rec, a.requestId, false, { mark, text: decisionText, fallback: 'Input received' })
    rec.resolve(res)
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
        text: row.card.message,
        body: elicitRowBody(row.card, settled)
      })
      .catch((err: unknown) => {
        this.host.log().warn(`elicitation row not recorded for ${row.card.requestId}: ${formatErr(err)}`)
      })
  }

  /** Say on the card's own row how it ended, so a reader loading the conversation later sees the
   *  settled card rather than one that still looks open. */
  private settleElicitRow(rec: PendingElicit, outcome: ElicitOutcome, answerLabel?: string): void {
    if (!rec.row) return
    this.writeElicitRow(rec.row, { outcome, ...(answerLabel !== undefined ? { answerLabel } : {}) })
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
        ts: monotonicTs(),
        sender: p.plan.agentId,
        card
      },
      { outcome: 'unrenderable' }
    )
  }

  /** Rewrite a settled chat card through the facet that posted it, or — when its post is still in
   *  flight and there is no message to rewrite — leave the label for the posting path, which would
   *  otherwise call every such card Cancelled (#1794). The row is settled either way: it needs no
   *  message id. Best effort: no ACP resolution depends on the rewrite. */
  private settleChatCard(
    rec: PendingElicit & { surface: 'chat' },
    requestId: string,
    consent: boolean,
    label: ElicitCardLabel
  ): void {
    if (rec.ts) {
      rec.facet.settle(rec, elicitSettlement(rec.params, consent, label))
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

  /** Post one daemon-authored line on the card's OWN surface — a notice, so it lands where every
   *  other one does: in the channel for a Slack card, on the stream for a webchat one. False when
   *  that turn is already gone, or when the surface refused it. Best effort by construction: no
   *  elicitation outcome depends on it. */
  private noticeInTurn(rec: PendingElicit, text: string): boolean {
    if (rec.surface === 'webchat') return this.streamWebchatNotice(rec.wc, text)
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

  /** Resolve every outstanding elicitation for a session as `cancel` — ACP's cancellation
   *  contract, and it unblocks a turn whose card the user abandoned. */
  async releaseElicits(owner: HostKey, sessionId: string): Promise<void> {
    const agentId = hostKeyAgentId(owner)
    for (const [id, rec] of this.pendingElicits) {
      if (rec.owner !== owner || rec.sessionId !== sessionId) continue
      this.pendingElicits.delete(id)
      this.syncApprovalActivity(owner, sessionId, { id })
      if (rec.approval) await this.resolveStoredPermissionRequest(agentId, id, 'expired')
      // A consent card settles through its own shape, so the cancelled message still shows the URL.
      if (rec.url) this.settleUrlElicit(rec, id, 'cancelled')
      else {
        this.settleElicitRow(rec, 'cancelled')
        if (rec.surface === 'webchat') this.emitWebchatElicitResolved(rec, id, 'cancelled')
        else this.settleChatCard(rec, id, false, ELICIT_CANCELLED)
      }
      rec.resolve({ action: 'cancel' })
    }
  }
}
