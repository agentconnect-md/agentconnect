// Assistant-mode drafts (assistant-mode.md §5.5, §5.10): a post that needs approval is recorded, carded to an internal member, and posted by the daemon itself once approved.
import { randomUUID } from 'node:crypto'
import type { AgentApprovalRoute, AgentApprovalRouted, AssistantModePolicy } from '@agentconnect.md/protocol'
import type { MessageGateway, SendIdentity } from '../mcp/ops/context.js'
import type { AssistantDraftCardView, AssistantDraftChoice } from '../slack/render.js'
import {
  assistantDraftHash,
  type AssistantDraft,
  type AssistantDraftApprover,
  type AssistantDraftDestination,
  type AssistantDraftKind,
  type AssistantDraftLedger,
  type AssistantDraftSource,
  type AssistantDraftTarget,
  type AssistantGrantPlace
} from '../store/assistant-drafts.js'

/** A pending card or the settled rewrite of one, as the platform's card surface renders it. */
export type DraftCard =
  | {
      draftId: string
      agentId: string
      /** The session the draft came from, for the click's routing target; absent for a placeless session. */
      sessionKey: string | null
      view: AssistantDraftCardView
      offerAlways: boolean
    }
  | { view: AssistantDraftCardView; outcome: string }

/** The approval card surface of one integration; only a platform with interactive DM cards offers one. */
export interface DraftCardPort {
  openDirectMessage(user: string): Promise<string>
  /** Whether a user is a full member of the installing organization; fails closed. */
  isFullMember?(user: string): Promise<boolean>
  /** The workspace a member id lives in, for the decision record. */
  scope?(): string | undefined
  postCard(channel: string, card: DraftCard): Promise<string | undefined>
  updateCard(channel: string, ts: string, card: DraftCard): Promise<void>
}

/** Who asked for the post. */
export interface DraftAsker {
  /** A platform member, reached through the integration the turn came in on. */
  integrationId?: string
  userId?: string
  /** A console user (webchat), reached through the control plane. */
  consoleUserId?: string
  /** The asker spoke in an internal place, which trusts everyone in it (§5.3). */
  trusted: boolean
}

export interface AssistantDraftsHost {
  ledger(): AssistantDraftLedger
  now(): number
  log: { info(message: string): void; warn(message: string): void }
  agent(agentId: string):
    | {
        name: string
        iconUrl?: string
        assistantMode?: AssistantModePolicy
        integrations: { id: string }[]
      }
    | undefined
  gatewayFor(integrationId: string): MessageGateway | undefined
  /** The agent is enabled in this conversation (conversation gating). */
  placeEnabled(agentId: string, integrationId: string, channel: string): boolean
  placeExternal(agentId: string, integrationId: string, channel: string): boolean
  cardPortFor(integrationId: string): DraftCardPort | undefined
  /** The control plane's approval route; undefined without one. */
  approvalRoute?(agentId: string, req: Omit<AgentApprovalRoute, 'agentId'>): Promise<AgentApprovalRouted>
  sessionLink?(sessionId: string): string
  platformName(platform: string): string
  /** Who or what a target is: the conversation's name, the DM recipient, a thread link. Best effort. */
  describeDestination(
    target: AssistantDraftTarget,
    opts: { dm: boolean; recipient?: string }
  ): Promise<Partial<AssistantDraftDestination>>
  /** The post-success bookkeeping a sent message gets (outbound record, root thread, seeded session); no model turn, no retry. */
  afterPost?(draft: AssistantDraft, messageId: string): Promise<void>
}

/** A post `sendMessage` resolved and is about to make. */
export interface InterceptedPost {
  platform: string
  integrationId: string
  channel: string
  thread?: string
  text: string
  directMessage: boolean
  /** The DM recipient's platform user id, for the card. */
  recipient?: string
}

export type PostInterception = { handled: false } | { handled: true; result: unknown }

type ApproverRung = 'asker' | 'responsible' | 'fallback'

const APPROVER_LABEL: Record<ApproverRung, string> = {
  asker: 'the person who asked, in a direct message',
  responsible: "the agent's responsible user, in a direct message",
  fallback: "the agent's fallback conversation"
}

const isChoice = (optionId: string): optionId is AssistantDraftChoice =>
  optionId === 'approve' || optionId === 'discard' || optionId === 'always'

export class AssistantDrafts {
  constructor(private readonly host: AssistantDraftsHost) {}

  /** A post to another place (§5.5): refused outside an enabled place, sent under a grant, drafted otherwise. */
  async interceptPost(
    agentId: string,
    source: AssistantDraftSource,
    post: InterceptedPost,
    asker: DraftAsker | undefined
  ): Promise<PostInterception> {
    if (!this.host.placeEnabled(agentId, post.integrationId, post.channel)) {
      throw new Error(
        'sendMessage: this agent is not enabled in that conversation, so it cannot post there. Nothing was sent.'
      )
    }
    const target: AssistantDraftTarget = {
      platform: post.platform,
      integrationId: post.integrationId,
      channel: post.channel,
      thread: post.thread ?? null
    }
    const external = this.host.placeExternal(agentId, post.integrationId, post.channel)
    const fromPlace = source.place && !external
    if (fromPlace && (await this.host.ledger().granted(agentId, grantPlace(source), grantPlace(target)))) {
      return { handled: false }
    }
    const destination = await this.host
      .describeDestination(target, { dm: post.directMessage, ...(post.recipient ? { recipient: post.recipient } : {}) })
      .catch(() => ({}))
    const { draft, rung } = await this.create({
      agentId,
      kind: 'elsewhere',
      target,
      targetDm: post.directMessage,
      targetExternal: external,
      destination,
      text: post.text,
      source,
      asker,
      offerAlways: fromPlace
    })
    return { handled: true, result: draftedResult(draft, rung) }
  }

  /** The turn's reply in an external place (§5.5): drafted to an internal member, never posted unapproved. */
  async draftReply(input: {
    agentId: string
    target: AssistantDraftTarget
    targetDm: boolean
    text: string
    source: AssistantDraftSource
    asker: DraftAsker | undefined
  }): Promise<AssistantDraft> {
    const destination = await this.host.describeDestination(input.target, { dm: input.targetDm }).catch(() => ({}))
    const { draft, rung } = await this.create({
      ...input,
      kind: 'reply',
      targetExternal: true,
      destination,
      offerAlways: false
    })
    if (!rung)
      this.host.log.warn(`assistant draft ${draft.id}: no approver could be reached for agent "${draft.agentId}"`)
    return draft
  }

  /**
   * A card button. True when the id names a draft — its click is then consumed here, whatever came of it.
   * `integrationId` / `agentId` come with a relayed click and must match the card's own.
   */
  async handleChoice(input: {
    requestId: string
    optionId: string
    actor?: { userId: string; name?: string }
    integrationId?: string
    agentId?: string
  }): Promise<boolean> {
    if (!isChoice(input.optionId)) return false
    const draft = await this.host.ledger().get(input.requestId)
    if (!draft) return false
    const approver = draft.approver
    if (!approver) return true
    if (input.agentId !== undefined && input.agentId !== draft.agentId) return true
    if (input.integrationId !== undefined && input.integrationId !== approver.integrationId) return true
    if (!(await this.authorized(draft, approver, input.actor))) {
      this.host.log.info(`assistant draft ${draft.id}: refused a click from someone it was not addressed to`)
      return true
    }
    const port = this.host.cardPortFor(approver.integrationId)
    const scope = port?.scope?.()
    const by = {
      id: input.actor ? (scope ? `${scope}:${input.actor.userId}` : input.actor.userId) : null,
      name: input.actor?.name ?? null
    }
    if (input.optionId === 'discard') {
      await this.host.ledger().deny(draft.id, by, this.host.now())
      await this.rewrite(draft.id)
      return true
    }
    await this.approve(draft, by, input.optionId === 'always')
    return true
  }

  /** Expire the due drafts of these agents; an expired draft is never posted. */
  async sweep(agentIds: readonly string[]): Promise<void> {
    for (const draft of await this.host.ledger().expireDue(agentIds, this.host.now())) await this.rewriteDraft(draft)
  }

  /** A post cut short by a restart or handover is `outcome_unknown`, never retried (§5.10). */
  async recover(agentIds: readonly string[]): Promise<void> {
    for (const draft of await this.host.ledger().recoverExecuting(agentIds, this.host.now())) {
      await this.rewriteDraft(draft)
    }
  }

  private async create(input: {
    agentId: string
    kind: AssistantDraftKind
    target: AssistantDraftTarget
    targetDm: boolean
    targetExternal: boolean
    destination: Partial<AssistantDraftDestination>
    text: string
    source: AssistantDraftSource | null
    asker: DraftAsker | undefined
    offerAlways: boolean
  }): Promise<{ draft: AssistantDraft; rung: ApproverRung | undefined }> {
    const id = randomUUID()
    const routed = await this.approverFor(input.agentId, id, input.asker).catch((err: unknown) => {
      this.host.log.warn(`assistant draft ${id}: approver lookup failed: ${(err as Error).message}`)
      return undefined
    })
    const ledger = this.host.ledger()
    const draft = await ledger.create({
      id,
      agentId: input.agentId,
      kind: input.kind,
      target: input.target,
      targetDm: input.targetDm,
      targetExternal: input.targetExternal,
      destination: input.destination,
      text: input.text,
      source: input.source,
      approver: routed?.approver ?? null,
      offerAlways: input.offerAlways,
      now: this.host.now()
    })
    if (!routed) return { draft, rung: undefined }
    const port = this.host.cardPortFor(routed.approver.integrationId)
    const ts = await port
      ?.postCard(routed.approver.channel, {
        draftId: id,
        agentId: input.agentId,
        sessionKey: input.source?.sessionKey ?? null,
        view: this.viewOf(draft),
        offerAlways: input.offerAlways
      })
      .catch((err: unknown) => {
        this.host.log.warn(`assistant draft ${id}: card post failed: ${(err as Error).message}`)
        return undefined
      })
    if (!ts) return { draft, rung: undefined }
    await ledger.setCard(id, ts)
    // A click can land before the card handle is stored; settle the card here if it did.
    const live = await ledger.get(id)
    if (live && live.status !== 'awaiting_review') await this.rewriteDraft(live)
    return { draft: live ?? draft, rung: routed.rung }
  }

  /** The asker when an internal member, a console asker, the responsible user, then the fallback conversation. */
  private async approverFor(
    agentId: string,
    draftId: string,
    asker: DraftAsker | undefined
  ): Promise<{ approver: AssistantDraftApprover; rung: ApproverRung } | undefined> {
    if (asker?.integrationId && asker.userId) {
      const port = this.host.cardPortFor(asker.integrationId)
      const internal = port && (asker.trusted || (await port.isFullMember?.(asker.userId)) === true)
      const channel = internal ? await port.openDirectMessage(asker.userId).catch(() => undefined) : undefined
      if (port && channel) {
        return {
          rung: 'asker',
          approver: {
            kind: 'member',
            integrationId: asker.integrationId,
            channel,
            userId: asker.userId,
            teamId: port.scope?.() ?? null,
            consoleUserId: null
          }
        }
      }
    }
    if (asker?.consoleUserId) {
      const approver = await this.routeConsoleUser(agentId, draftId, asker.consoleUserId)
      if (approver) return { approver, rung: 'asker' }
    }
    const policy = this.host.agent(agentId)?.assistantMode
    if (policy?.responsibleUserId) {
      const approver = await this.routeConsoleUser(agentId, draftId, policy.responsibleUserId)
      if (approver) return { approver, rung: 'responsible' }
    }
    const fallback = policy?.fallbackConversation
    if (fallback && this.host.cardPortFor(fallback.integrationId)) {
      return {
        rung: 'fallback',
        approver: {
          kind: 'conversation',
          integrationId: fallback.integrationId,
          channel: fallback.channelId,
          userId: null,
          teamId: null,
          consoleUserId: null
        }
      }
    }
    return undefined
  }

  /** A console user's linked member on one of the agent's card-capable integrations, chosen by the control plane. */
  private async routeConsoleUser(
    agentId: string,
    draftId: string,
    consoleUserId: string
  ): Promise<AssistantDraftApprover | undefined> {
    const integrationIds = (this.host.agent(agentId)?.integrations ?? [])
      .map((i) => i.id)
      .filter((id) => this.host.cardPortFor(id) !== undefined)
      .slice(0, 8)
    if (integrationIds.length === 0 || !this.host.approvalRoute) return undefined
    const routed = await this.host
      .approvalRoute(agentId, { requestId: draftId, integrationIds, consoleUserId })
      .catch(() => undefined)
    const target = routed?.target
    // A control plane that predates the named route answers with its own chain; only the named user counts.
    if (!target || target.consoleUserId !== consoleUserId) return undefined
    const port = this.host.cardPortFor(target.integrationId)
    const channel = await port?.openDirectMessage(target.userId).catch(() => undefined)
    if (!channel) return undefined
    return {
      kind: 'member',
      integrationId: target.integrationId,
      channel,
      userId: target.userId,
      teamId: target.teamId,
      consoleUserId
    }
  }

  /** The addressed member, re-verified with the control plane when it chose them; anyone in a fallback conversation. */
  private async authorized(
    draft: AssistantDraft,
    approver: AssistantDraftApprover,
    actor: { userId: string } | undefined
  ): Promise<boolean> {
    if (!actor?.userId) return false
    if (approver.kind === 'conversation') return true
    if (actor.userId !== approver.userId) return false
    if (!approver.consoleUserId) return true
    if (!this.host.approvalRoute || !approver.teamId) return false
    const verified = await this.host
      .approvalRoute(draft.agentId, {
        requestId: draft.id,
        integrationIds: [approver.integrationId],
        verify: {
          integrationId: approver.integrationId,
          teamId: approver.teamId,
          userId: actor.userId,
          consoleUserId: approver.consoleUserId
        }
      })
      .catch(() => undefined)
    return verified?.allowed === true
  }

  private async approve(
    draft: AssistantDraft,
    by: { id: string | null; name: string | null },
    always: boolean
  ): Promise<void> {
    const ledger = this.host.ledger()
    const now = this.host.now()
    if (!(await ledger.begin(draft.id, by, now))) {
      await ledger.expire(draft.id, now)
      await this.rewrite(draft.id)
      return
    }
    // Never while assistant mode is off; the store refuses a card from an earlier generation (§5.5).
    const granted =
      always &&
      draft.offerAlways &&
      draft.source?.place === true &&
      !draft.targetExternal &&
      this.host.agent(draft.agentId)?.assistantMode?.enabled === true &&
      (await ledger.grant(
        draft.agentId,
        grantPlace(draft.source),
        grantPlace(draft.target),
        by.id,
        draft.grantEpoch,
        now
      ))
    const outcome = await this.execute(draft)
    await ledger.settle(draft.id, outcome.status, outcome.detail, this.host.now())
    // The sent message's bookkeeping, once and after the outcome is recorded: a failure here never re-posts.
    if (outcome.status === 'succeeded' && outcome.detail.messageId) {
      await this.host
        .afterPost?.(draft, outcome.detail.messageId)
        .catch((err: unknown) =>
          this.host.log.warn(
            `assistant draft ${draft.id}: bookkeeping after the post failed: ${(err as Error).message}`
          )
        )
    }
    await this.rewrite(draft.id, granted)
  }

  /** Post the text unchanged. Only a returned message id is success; anything uncertain is never retried. */
  private async execute(draft: AssistantDraft): Promise<{
    status: 'succeeded' | 'failed' | 'outcome_unknown'
    detail: { messageId?: string; failure?: string }
  }> {
    const failed = (failure: string) => ({ status: 'failed' as const, detail: { failure } })
    if (assistantDraftHash(draft.target, draft.text) !== draft.hash)
      return failed('the draft changed after it was written')
    const agent = this.host.agent(draft.agentId)
    if (!agent) return failed('the agent is no longer here')
    const { target } = draft
    if (!this.host.placeEnabled(draft.agentId, target.integrationId, target.channel)) {
      return failed('the agent is no longer enabled in that conversation')
    }
    const gw = this.host.gatewayFor(target.integrationId)
    if (!gw) return failed('the conversation cannot be reached right now')
    const identity: SendIdentity = {
      username: agent.name,
      ...(agent.iconUrl ? { icon_url: agent.iconUrl } : {}),
      agentAuthorId: draft.agentId,
      // A post into a thread arrives finalized, like sendMessage's update form, so the thread routes it.
      ...(target.thread
        ? {
            response: { responseId: randomUUID(), deliveryState: 'final' as const, hopCount: 0, mentionedAgentIds: [] }
          }
        : {})
    }
    try {
      const messageId = await gw.postMessage(target.channel, draft.text, target.thread ?? undefined, identity)
      return messageId
        ? { status: 'succeeded', detail: { messageId } }
        : { status: 'outcome_unknown', detail: { failure: 'the platform returned no message id' } }
    } catch (err) {
      return { status: 'outcome_unknown', detail: { failure: (err as Error).message } }
    }
  }

  private async rewrite(id: string, granted = false): Promise<void> {
    const draft = await this.host.ledger().get(id)
    if (draft) await this.rewriteDraft(draft, granted)
  }

  private async rewriteDraft(draft: AssistantDraft, granted = false): Promise<void> {
    const approver = draft.approver
    // A pending card keeps its buttons, and only the click that is posting writes the outcome.
    if (!approver || !draft.cardTs || draft.status === 'awaiting_review' || draft.status === 'executing') return
    const port = this.host.cardPortFor(approver.integrationId)
    await port
      ?.updateCard(approver.channel, draft.cardTs, { view: this.viewOf(draft), outcome: outcomeOf(draft, granted) })
      .catch((err: unknown) =>
        this.host.log.warn(`assistant draft ${draft.id}: card update failed: ${(err as Error).message}`)
      )
  }

  private viewOf(draft: AssistantDraft): AssistantDraftCardView {
    const sessionId = draft.source?.sessionId
    return {
      agentName: this.host.agent(draft.agentId)?.name ?? 'The agent',
      kind: draft.kind,
      target: {
        platform: draft.target.platform,
        channel: draft.target.channel,
        isDm: draft.targetDm,
        external: draft.targetExternal,
        ...(draft.destination.name ? { name: draft.destination.name } : {}),
        ...(draft.destination.userId ? { userId: draft.destination.userId } : {}),
        ...(draft.target.thread ? { thread: draft.target.thread } : {}),
        ...(draft.destination.threadLink ? { threadLink: draft.destination.threadLink } : {})
      },
      platformName: this.host.platformName(draft.target.platform),
      text: draft.text,
      ...(sessionId && this.host.sessionLink ? { sessionUrl: this.host.sessionLink(sessionId) } : {})
    }
  }
}

/** A grant's end of a place: integration and conversation, never a thread. */
function grantPlace(place: { platform: string; integrationId: string | null; channel: string }): AssistantGrantPlace {
  return { platform: place.platform, integrationId: place.integrationId, channel: place.channel }
}

function outcomeOf(draft: AssistantDraft, granted: boolean): string {
  const by = draft.decidedByName ? ` by ${draft.decidedByName}` : ''
  switch (draft.status) {
    case 'succeeded':
      return granted
        ? `✅ Posted — approved${by}. Posts from here to there now go out without asking.`
        : `✅ Posted — approved${by}.`
    case 'denied':
      return `🗑️ Discarded${by}. Nothing was posted.`
    case 'expired':
      return '⌛ Expired. Nothing was posted.'
    case 'outcome_unknown':
      return '⚠️ Not sure this went through — please check the conversation. It will not be posted again.'
    case 'failed':
      return `⚠️ Could not post: ${draft.failure ?? 'unknown error'}. Nothing was sent.`
    default:
      return ''
  }
}

/** What the model reads back from a drafted post. */
function draftedResult(draft: AssistantDraft, rung: ApproverRung | undefined): Record<string, unknown> {
  const base = { drafted: true, draftId: draft.id, expiresAt: new Date(draft.expiresAt).toISOString() }
  if (!rung) {
    return {
      ...base,
      approver: null,
      note:
        'Not posted: a post to another conversation needs approval, and no approver could be reached for this agent. ' +
        'Nothing was sent; say so here.'
    }
  }
  return {
    ...base,
    approver: APPROVER_LABEL[rung],
    note:
      `Not posted yet: ${APPROVER_LABEL[rung]} was shown the target and the exact text, and it posts unchanged once ` +
      'approved (within 24 hours). Do not send it again; tell the person here it is waiting for approval.'
  }
}
