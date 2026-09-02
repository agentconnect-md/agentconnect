// ACP permission + elicitation policy — the human-approval half of a turn, hoisted out of
// `Daemon` verbatim. Resolution here is a race between the runtime request, the chat card, the
// Agent-editor decision, and turn cancellation: every await order and map write is load-bearing.
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
  ApprovalRouteTarget
} from '@agentconnect.md/protocol'
import type { Clock } from '@agentconnect.md/connection'
import type { Logger } from '../log.js'
import type { LocalStore } from '../store/local-store.js'
import type { LoadedAgent } from '../agents/load-agents.js'
import type { AcpPermissionPolicyEvent } from '../acp/acp-host.js'
import type { DaemonEvaluationHooks } from '../evaluation/daemon-hooks.js'
import { SlackConnection } from '../slack/connection.js'
import type { InteractionActor } from '../platforms/contract.js'
import {
  buildApprovalDmIntro,
  buildElicitationCard,
  buildElicitationResolvedCard,
  buildPermissionCard,
  buildPermissionResolvedCard,
  elicitTarget
} from '../slack/render.js'
import { slackThreadUrl } from '../platforms/slack/permalink.js'
import { slackAgentIdentityOptions } from '../platforms/slack/turn-output.js'
import { turnChromeFor } from '../platforms/turn-chrome.js'
import { formatErr } from '../daemon/text.js'
import {
  elicitationApprovalSummary,
  isBuiltinSystemTool,
  isBuiltinSystemToolElicitation,
  isMcpToolApprovalElicitation,
  permissionRequestSummary
} from '../daemon/tool-classification.js'
import { pendingTurnKey, type DaemonRenderAction, type Pending } from '../daemon/turn-types.js'

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

/** The turn's platform surfaces a permission or elicitation card renders through. */
export interface PermissionSurfaceHost {
  enqueueApply(p: Pending, action: DaemonRenderAction): void
  /** Post a chronological boundary card serialized on the turn's apply chain. */
  postCardSerialized(
    p: Pending,
    post: (conn: SlackConnection) => Promise<string | undefined>
  ): Promise<string | undefined>
  httpSlackSessionTarget(p: Pick<Pending, 'plan'>): string | undefined
  maskAgentSecrets<T>(agentId: string, payload: T): T
  logSessionAction(verb: string, sessionKey: string, actor?: InteractionActor): void
  /** Tell the CP a session started or stopped waiting on a human (slack-approval-dm.md §7); fire-and-forget. */
  emitApprovalActivity(agentId: string, acpSessionId: string, state: 'awaiting_permission' | 'idle'): void
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
  valueKind?: 'enum' | 'boolean'
}

interface EditorPermissionEntry {
  kind: 'permission'
  agentId: string
  sessionId: string
  params: RequestPermissionRequest
  evaluationParams: RequestPermissionRequest
  resolve: (res: RequestPermissionResponse) => void
  notify?: DmNotice
}

interface EditorElicitationEntry {
  kind: 'elicitation'
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

  // ── Interactive elicitations (ACP elicitation/create, form mode) ─────────────
  private elicitSeq = 0
  private pendingElicits = new Map<
    string,
    {
      agentId: string
      sessionId: string
      params: CreateElicitationRequest
      propName: string
      kind: 'enum' | 'boolean'
      approval: boolean
      conn: SlackConnection
      channel: string
      ts?: string
      resolve: (res: CreateElicitationResponse) => void
    }
  >()

  /** Sessions the CP currently believes are waiting, keyed by `pendingTurnKey` — emit only on a change. */
  private readonly awaitingApproval = new Map<string, { agentId: string; sessionId: string }>()

  constructor(private readonly host: PermissionHost) {}

  /** Any answerable request for the session across the three pending maps (approval elicitations only). */
  private hasPendingApproval(agentId: string, sessionId: string): boolean {
    for (const e of this.pendingEditorPermissions.values())
      if (e.agentId === agentId && e.sessionId === sessionId) return true
    for (const e of this.pendingChatPermissions.values())
      if (e.agentId === agentId && e.sessionId === sessionId) return true
    for (const e of this.pendingElicits.values())
      if (e.approval && e.agentId === agentId && e.sessionId === sessionId) return true
    return false
  }

  /** Re-derive the session's wait state after a map write and report it when it flipped (§7). */
  private syncApprovalActivity(agentId: string, sessionId: string): void {
    const key = pendingTurnKey(agentId, sessionId)
    const awaiting = this.hasPendingApproval(agentId, sessionId)
    if (awaiting === this.awaitingApproval.has(key)) return
    if (awaiting) this.awaitingApproval.set(key, { agentId, sessionId })
    else this.awaitingApproval.delete(key)
    try {
      this.host.emitApprovalActivity(agentId, sessionId, awaiting ? 'awaiting_permission' : 'idle')
    } catch (err) {
      this.host.log().warn(`approval activity not reported: ${formatErr(err)}`)
    }
  }

  /** The sessions currently waiting on a human, by runtime session id. */
  liveApprovalWaits(): ReadonlyArray<{ agentId: string; sessionId: string }> {
    return [...this.awaitingApproval.values()]
  }

  /** Re-assert every live wait after a (re)connect: the CP reset them when this daemon dropped (§7). */
  replayApprovalActivity(): void {
    for (const { agentId, sessionId } of this.awaitingApproval.values()) {
      this.host.emitApprovalActivity(agentId, sessionId, 'awaiting_permission')
    }
  }

  private async noteEditorPermissionRequest(
    id: string,
    agentId: string,
    sessionId: string,
    command: string,
    p: Pending,
    notifyChat = true
  ): Promise<{ requesterName: string | null }> {
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
      // A continuation turn notifies the origin platform thread too (§5.2).
      if ((!p.webchat || p.webchat.continuation) && p.conn) {
        this.host.enqueueApply(p, { kind: 'notice', text })
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
      agentId,
      sessionId,
      params,
      evaluationParams,
      resolve: resolveResult
    })
    this.syncApprovalActivity(agentId, sessionId)
    // The human wait starts when the request becomes answerable, not when its row lands — the
    // write used to be synchronous, and billing it to the turn's retry budget would shrink it.
    const wait = this.trackHumanApprovalWait(p, result)
    const recorded = this.noteEditorPermissionRequest(id, agentId, sessionId, permissionRequestSummary(params), p)
    this.recordedWrites.set(id, recorded)
    let requesterName: string | null = null
    try {
      requesterName = (await recorded).requesterName
    } catch (err) {
      this.pendingEditorPermissions.delete(id)
      this.syncApprovalActivity(agentId, sessionId)
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
      agentId,
      sessionId,
      params,
      resolve: resolveResult
    })
    this.syncApprovalActivity(agentId, sessionId)
    const wait = this.trackHumanApprovalWait(p, result)
    const recorded = this.noteEditorPermissionRequest(id, agentId, sessionId, elicitationApprovalSummary(params), p)
    this.recordedWrites.set(id, recorded)
    let requesterName: string | null = null
    try {
      requesterName = (await recorded).requesterName
    } catch (err) {
      this.pendingEditorPermissions.delete(id)
      this.syncApprovalActivity(agentId, sessionId)
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
      agentId,
      sessionId,
      params,
      evaluationParams,
      conn,
      channel: p.plan.channel,
      resolve: resolveResult
    })
    this.syncApprovalActivity(agentId, sessionId)
    const recorded = this.noteEditorPermissionRequest(
      requestId,
      agentId,
      sessionId,
      permissionRequestSummary(params),
      p,
      false
    )
    this.recordedWrites.set(requestId, recorded)
    try {
      await recorded
    } catch (err) {
      this.pendingChatPermissions.delete(requestId)
      this.syncApprovalActivity(agentId, sessionId)
      this.recordedWrites.delete(requestId)
      throw err
    }
    this.recordedWrites.delete(requestId)
    // Settled while the row was being written: never post a card for a request already resolved.
    if (!this.pendingChatPermissions.has(requestId)) return await result
    const blocks = buildPermissionCard(requestId, params, this.host.httpSlackSessionTarget(p))
    const fallback = `Permission requested: ${params.toolCall?.title ?? 'a tool call'}`
    const ts = await this.host.postCardSerialized(p, (slack) =>
      slack.postBlocks(p.plan.channel, blocks, fallback, p.plan.statusThread, {
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
      this.syncApprovalActivity(agentId, sessionId)
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
    const card =
      rec.kind === 'permission'
        ? buildPermissionCard(requestId, rec.params, sessionTarget)
        : (buildElicitationCard(requestId, rec.params, sessionTarget) ?? [])
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
    const elicit = rec.kind === 'elicitation' ? elicitTarget(rec.params) : null
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
    this.syncApprovalActivity(rec.agentId, rec.sessionId)
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
      const chosen = notify.valueKind === 'boolean' ? value === 'true' : value
      res = { action: 'accept', content: { [notify.propName]: chosen } }
      decision = `:white_check_mark: ${notify.valueKind === 'boolean' ? (chosen ? 'Yes' : 'No') : value}`
    } else {
      return
    }
    const by = this.dmDecider(notify, verdict.name)
    if (!(await this.resolveStoredPermissionRequest(rec.agentId, requestId, value === null ? 'denied' : 'allowed', by)))
      return
    this.host.logSessionAction(`permission:${value === null ? 'denied' : 'allowed'}`, rec.sessionId, actor)
    this.pendingEditorPermissions.delete(requestId)
    this.syncApprovalActivity(rec.agentId, rec.sessionId)
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
        this.syncApprovalActivity(elicitation.agentId, elicitation.sessionId)
        if (elicitation.ts) {
          const decision =
            req.decision === 'allow'
              ? ':white_check_mark: Allowed by Agent editor'
              : ':no_entry_sign: Denied by Agent editor'
          void elicitation.conn
            .updateBlocks(
              elicitation.channel,
              elicitation.ts,
              buildElicitationResolvedCard(elicitation.params, decision),
              'Permission resolved',
              true
            )
            .catch(() => {})
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
      this.syncApprovalActivity(chat.agentId, chat.sessionId)
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
    this.syncApprovalActivity(pending.agentId, pending.sessionId)
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
    this.syncApprovalActivity(pending.agentId, pending.sessionId)
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
      if (pending.agentId !== agentId || !pending.approval || !pending.ts) continue
      void pending.conn
        .updateBlocks(
          pending.channel,
          pending.ts,
          buildElicitationResolvedCard(pending.params, ':lock: Ask an Agent editor to allow it'),
          'Permission requires an Agent editor',
          true
        )
        .catch(() => {})
    }
  }

  async releaseChatPermissions(agentId: string, sessionId: string): Promise<void> {
    for (const [id, pending] of this.pendingChatPermissions) {
      if (pending.agentId !== agentId || pending.sessionId !== sessionId) continue
      this.pendingChatPermissions.delete(id)
      this.syncApprovalActivity(agentId, sessionId)
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

  async releaseEditorPermissions(agentId: string, sessionId: string): Promise<void> {
    for (const [id, pending] of this.pendingEditorPermissions) {
      if (pending.agentId !== agentId || pending.sessionId !== sessionId) continue
      this.pendingEditorPermissions.delete(id)
      this.syncApprovalActivity(agentId, sessionId)
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
    agentId: string,
    sessionId: string,
    params: RequestPermissionRequest,
    event: AcpPermissionPolicyEvent
  ): void {
    const pending = this.host.pending().get(pendingTurnKey(agentId, sessionId))
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
    agentId: string,
    sessionId: string,
    params: RequestPermissionRequest
  ): Promise<RequestPermissionResponse> {
    try {
      return await this.resolveAcpPermission(agentId, sessionId, params)
    } catch (err) {
      this.permissionEvaluationDetails.set(params, { reason: 'permission_policy_error' })
      this.host.log().error(`permission policy failed closed for agent "${agentId}": ${formatErr(err)}`)
      return { outcome: { outcome: 'cancelled' } }
    }
  }

  private async resolveAcpPermission(
    agentId: string,
    sessionId: string,
    params: RequestPermissionRequest
  ): Promise<RequestPermissionResponse> {
    const evaluationParams = params
    // The tool title/preview can embed a secret the agent interpolated into a command.
    // Mask before anything renders it (Slack card now, resolved-card edit later via
    // the pending request).
    params = this.host.maskAgentSecrets(agentId, params)
    // Extraction is a silent background operation: it may never gain side effects
    // merely because the user agent normally runs in an auto-approval mode.
    if (this.host.memoryExtractionInFlight(pendingTurnKey(agentId, sessionId))) {
      this.permissionEvaluationDetails.set(evaluationParams, { reason: 'memory_extraction' })
      return { outcome: { outcome: 'cancelled' } }
    }
    // Platform system tools (this daemon's OWN MCP tools — sendMessage, listAgents,
    // orchestration, memory, …) are always granted: a human should never
    // have to approve them per call. Auto-allow without rendering a card. Non-system tools
    // (incl. the runtime's dangerous built-ins) fall through to the interactive policy below.
    const p = this.host.pending().get(pendingTurnKey(agentId, sessionId))
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
    agentId: string,
    sessionId: string,
    params: CreateElicitationRequest
  ): Promise<CreateElicitationResponse | undefined> {
    // Same reason as onAcpPermission: the elicitation message/labels are agent-authored
    // text headed for a platform card — mask any embedded secret value first.
    params = this.host.maskAgentSecrets(agentId, params)
    const p = this.host.pending().get(pendingTurnKey(agentId, sessionId))
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
    const conn = p.conn
    if (!turnChromeFor(p.plan.platform).chatInputCards || !(conn instanceof SlackConnection)) return undefined
    const target = elicitTarget(params)
    if (!target) return undefined
    const requestId = isApproval ? randomUUID() : `elicit-${++this.elicitSeq}`
    const blocks = buildElicitationCard(requestId, params, this.host.httpSlackSessionTarget(p))
    if (!blocks) return undefined
    const fallback = (params as { message?: string }).message ?? 'The agent needs your input'
    let resolveResult!: (res: CreateElicitationResponse) => void
    const result = new Promise<CreateElicitationResponse>((resolve) => (resolveResult = resolve))
    this.pendingElicits.set(requestId, {
      agentId,
      sessionId,
      params,
      propName: target.propName,
      kind: target.kind,
      approval: isApproval,
      conn,
      channel: p.plan.channel,
      resolve: resolveResult
    })
    this.syncApprovalActivity(agentId, sessionId)
    if (isApproval) {
      const recorded = this.noteEditorPermissionRequest(
        requestId,
        agentId,
        sessionId,
        elicitationApprovalSummary(params),
        p,
        false
      )
      this.recordedWrites.set(requestId, recorded)
      try {
        await recorded
      } catch (err) {
        this.pendingElicits.delete(requestId)
        this.syncApprovalActivity(agentId, sessionId)
        this.recordedWrites.delete(requestId)
        throw err
      }
      this.recordedWrites.delete(requestId)
      if (!this.pendingElicits.has(requestId)) return await result
    }
    const ts = await this.host.postCardSerialized(p, (sc) =>
      sc.postBlocks(p.plan.channel, blocks, fallback, p.plan.statusThread, {
        ...(slackAgentIdentityOptions(p.plan) ?? {}),
        chrome: true
      })
    )
    const live = this.pendingElicits.get(requestId)
    if (!live) {
      if (ts)
        void conn
          .updateBlocks(
            p.plan.channel,
            ts,
            buildElicitationResolvedCard(params, ':hourglass: Cancelled'),
            'Cancelled',
            true
          )
          .catch(() => {})
      return await result
    }
    if (!ts) {
      this.pendingElicits.delete(requestId)
      this.syncApprovalActivity(agentId, sessionId)
      if (isApproval) await this.resolveStoredPermissionRequest(agentId, requestId, 'expired')
      live.resolve({ action: 'cancel' })
      return await result
    }
    live.ts = ts
    return isApproval ? await this.trackHumanApprovalWait(p, result) : await result
  }

  /** A tapped elicitation-card button (SlackDeps.onElicitChoice): resolve the pending ACP
   *  request — `accept` with the chosen value (under the field name), or `decline` for the
   *  Dismiss button (value === null) — and edit the card in place. No-op if already gone. */
  async handleElicitChoice(a: { requestId: string; value: string | null; actor?: InteractionActor }): Promise<void> {
    // A DM elicitation card's request lives on the editor path (§2/§6.4).
    const editor = this.pendingEditorPermissions.get(a.requestId)
    if (editor?.kind === 'elicitation' && editor.notify) {
      return await this.handleDmElicitChoice(a.requestId, editor, a.value, a.actor)
    }
    const rec = this.pendingElicits.get(a.requestId)
    if (!rec) return
    if (rec.approval && this.host.agents().get(rec.agentId)?.allowRuntimeChangesInChat !== true) {
      if (rec.ts) {
        void rec.conn
          .updateBlocks(
            rec.channel,
            rec.ts,
            buildElicitationResolvedCard(rec.params, ':lock: Ask an Agent editor to allow it'),
            'Permission requires an Agent editor',
            true
          )
          .catch(() => {})
      }
      return
    }
    let res: CreateElicitationResponse
    let decision: string
    if (a.value === null) {
      res = { action: 'decline' }
      decision = ':no_entry_sign: Dismissed'
    } else {
      const value = rec.kind === 'boolean' ? a.value === 'true' : a.value
      res = { action: 'accept', content: { [rec.propName]: value } }
      decision = `:white_check_mark: ${rec.kind === 'boolean' ? (value ? 'Yes' : 'No') : a.value}`
    }
    if (rec.approval) {
      const team = rec.conn.workspaceId()
      const by = a.actor
        ? { resolvedBy: team ? `slack:${team}:${a.actor.userId}` : null, resolvedByName: a.actor.name ?? null }
        : undefined
      if (
        !(await this.resolveStoredPermissionRequest(
          rec.agentId,
          a.requestId,
          a.value === null ? 'denied' : 'allowed',
          by
        ))
      )
        return
    }
    this.pendingElicits.delete(a.requestId)
    this.syncApprovalActivity(rec.agentId, rec.sessionId)
    if (rec.ts)
      void rec.conn
        .updateBlocks(rec.channel, rec.ts, buildElicitationResolvedCard(rec.params, decision), 'Input received', true)
        .catch(() => {})
    rec.resolve(res)
  }

  /** Resolve every outstanding elicitation for a session as `cancel` — ACP's cancellation
   *  contract, and it unblocks a turn whose card the user abandoned. */
  async releaseElicits(agentId: string, sessionId: string): Promise<void> {
    for (const [id, rec] of this.pendingElicits) {
      if (rec.agentId !== agentId || rec.sessionId !== sessionId) continue
      this.pendingElicits.delete(id)
      this.syncApprovalActivity(agentId, sessionId)
      if (rec.approval) await this.resolveStoredPermissionRequest(agentId, id, 'expired')
      if (rec.ts)
        void rec.conn
          .updateBlocks(
            rec.channel,
            rec.ts,
            buildElicitationResolvedCard(rec.params, ':hourglass: Cancelled'),
            'Cancelled',
            true
          )
          .catch(() => {})
      rec.resolve({ action: 'cancel' })
    }
  }
}
