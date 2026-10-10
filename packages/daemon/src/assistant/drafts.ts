// Assistant-mode drafts (assistant-mode.md §5.5, §5.10): a post or a patrol's proposed task that needs approval is recorded, carded to an internal member, and run once approved.
import { randomUUID } from 'node:crypto'
import type {
  AgentApprovalRoute,
  AgentApprovalRouted,
  AssistantDraftDecisionResult,
  AssistantModePolicy
} from '@agentconnect.md/protocol'
import type { MessageGateway, SendIdentity } from '../mcp/ops/context.js'
import type { SubsessionApprover } from '../permissions/subsession-approval.js'
import type { AssistantDraftCardView, AssistantDraftChoice } from '../slack/render.js'
import {
  assistantDraftHash,
  assistantTaskHash,
  type AssistantDraft,
  type AssistantDraftApprover,
  type AssistantDraftDestination,
  type AssistantDraftKind,
  type AssistantDraftLedger,
  type AssistantDraftSource,
  type AssistantDraftStatus,
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
      /** Why the last approval did not run, shown under the buttons it keeps. */
      notice?: string
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
  /** Open the sub-session an approved task runs in; it claims the record itself (§5.10). */
  startTask?(draft: AssistantDraft, by: { id: string | null; name: string | null }): Promise<TaskStart>
  /** An observation on a proposal's item, so its next patrol knows how the proposal went. */
  observe?(agentId: string, itemId: string, text: string): Promise<void>
}

/** How an approved task's start went: running, refused for the sub-session limit, lost to another decision, or failed for good. */
export type TaskStart =
  { kind: 'started' } | { kind: 'busy'; reason: string } | { kind: 'lost' } | { kind: 'failed'; reason: string }

/** A patrol's proposal (§5.10), as the patrol hands it over. */
export interface ProposalInput {
  agentId: string
  /** The item's place of origin, where the approved task runs and reports. */
  target: AssistantDraftTarget
  destination: Partial<AssistantDraftDestination>
  task: string
  sentence: string
  why: string
  itemId: string
  itemVersion: number
  source: AssistantDraftSource
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

/** What one decision did: `decided` settled the draft (a task: started it); any other result posted or ran nothing. */
export interface DraftDecision {
  result: AssistantDraftDecisionResult
  status: AssistantDraftStatus | null
  granted: boolean
  failure: string | null
}

/** The console user an editor's decision is recorded under, beside a card's `<workspace>:<member>`. */
export const consoleDecider = (userId: string): string => `user:${userId}`

type ApproverRung = 'asker' | 'responsible' | 'fallback'

const APPROVER_LABEL: Record<ApproverRung, string> = {
  asker: 'the person who asked, in a direct message',
  responsible: "the agent's responsible user, in a direct message",
  fallback: "the agent's fallback conversation"
}

const isChoice = (optionId: string): optionId is AssistantDraftChoice =>
  optionId === 'approve' || optionId === 'discard' || optionId === 'always'

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

export class AssistantDrafts {
  /** Each proposal's card rewrites, one after another, so the last one shows the record as it ended. */
  private readonly taskCards = new Map<string, Promise<void>>()

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
    await this.decide(draft, input.optionId, by)
    return true
  }

  /** An editor's decision from the console; the control plane checked the editor, so only the agent must match. */
  async decideFromConsole(input: {
    agentId: string
    draftId: string
    choice: AssistantDraftChoice
    decider: { userId: string; name: string | null }
  }): Promise<DraftDecision> {
    const draft = await this.host.ledger().get(input.draftId)
    if (!draft || draft.agentId !== input.agentId) {
      return { result: 'not-found', status: null, granted: false, failure: null }
    }
    return await this.decide(draft, input.choice, {
      id: consoleDecider(input.decider.userId),
      name: input.decider.name
    })
  }

  /** Expire the due drafts of these agents; an expired draft is never posted. */
  async sweep(agentIds: readonly string[]): Promise<void> {
    for (const draft of await this.host.ledger().expireDue(agentIds, this.host.now())) {
      await this.rewriteDraft(draft)
      if (draft.action === 'task') await this.observeTask(draft)
    }
  }

  /** A post cut short by a restart or handover is `outcome_unknown`, never retried (§5.10). */
  async recover(agentIds: readonly string[]): Promise<void> {
    for (const draft of await this.host.ledger().recoverExecuting(agentIds, this.host.now())) {
      await this.rewriteDraft(draft)
    }
  }

  /** A patrol's proposal (§5.10): recorded and carded like a draft with no asker, so it goes to the responsible user or the fallback conversation. */
  async propose(input: ProposalInput): Promise<{ draft: AssistantDraft; approver: string | null }> {
    const id = randomUUID()
    const routed = await this.route(input.agentId, id, undefined)
    const draft = await this.host.ledger().createTask({
      id,
      agentId: input.agentId,
      target: input.target,
      destination: input.destination,
      task: input.task,
      sentence: input.sentence,
      why: input.why,
      itemId: input.itemId,
      itemVersion: input.itemVersion,
      source: input.source,
      approver: routed?.approver ?? null,
      now: this.host.now()
    })
    const carded = await this.card(draft, routed)
    if (!carded.rung)
      this.host.log.warn(`assistant proposal ${id}: no approver could be reached for agent "${input.agentId}"`)
    return { draft: carded.draft, approver: carded.rung ? APPROVER_LABEL[carded.rung] : null }
  }

  /** Where another card for an external place goes instead (§5.5), routed as a proposal's is: a linked editor's DM, or the fallback conversation. */
  async cardApprover(agentId: string, requestId: string): Promise<SubsessionApprover | undefined> {
    const approver = (await this.route(agentId, requestId, undefined))?.approver
    if (approver?.kind === 'conversation')
      return { kind: 'conversation', integrationId: approver.integrationId, channel: approver.channel }
    if (!approver?.userId || !approver.teamId || !approver.consoleUserId) return undefined
    const { integrationId, teamId, userId, consoleUserId } = approver
    return { kind: 'member', channel: approver.channel, target: { integrationId, teamId, userId, consoleUserId } }
  }

  /** A task's sub-session ended or was cut: the card shows the outcome and the item records it. */
  async taskSettled(draft: AssistantDraft): Promise<void> {
    await this.rewriteDraft(draft)
    await this.observeTask(draft)
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
    const routed = await this.route(input.agentId, id, input.asker)
    const draft = await this.host.ledger().create({
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
    return await this.card(draft, routed)
  }

  private async route(
    agentId: string,
    id: string,
    asker: DraftAsker | undefined
  ): Promise<{ approver: AssistantDraftApprover; rung: ApproverRung } | undefined> {
    return await this.approverFor(agentId, id, asker).catch((err: unknown) => {
      this.host.log.warn(`assistant draft ${id}: approver lookup failed: ${(err as Error).message}`)
      return undefined
    })
  }

  /** Post the pending card to its approver and keep its handle; undefined rung when no card went out. */
  private async card(
    draft: AssistantDraft,
    routed: { approver: AssistantDraftApprover; rung: ApproverRung } | undefined
  ): Promise<{ draft: AssistantDraft; rung: ApproverRung | undefined }> {
    if (!routed) return { draft, rung: undefined }
    const ledger = this.host.ledger()
    const port = this.host.cardPortFor(routed.approver.integrationId)
    const ts = await port?.postCard(routed.approver.channel, this.pendingCard(draft)).catch((err: unknown) => {
      this.host.log.warn(`assistant draft ${draft.id}: card post failed: ${(err as Error).message}`)
      return undefined
    })
    if (!ts) return { draft, rung: undefined }
    await ledger.setCard(draft.id, ts)
    // A click can land before the card handle is stored; settle the card here if it did.
    const live = await ledger.get(draft.id)
    if (live && live.status !== 'awaiting_review') await this.rewriteDraft(live)
    return { draft: live ?? draft, rung: routed.rung }
  }

  private pendingCard(draft: AssistantDraft, notice?: string): DraftCard {
    return {
      draftId: draft.id,
      agentId: draft.agentId,
      sessionKey: draft.source?.sessionKey ?? null,
      view: this.viewOf(draft),
      offerAlways: draft.offerAlways,
      ...(notice ? { notice } : {})
    }
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

  /** Approve or discard: the one path a card click and the console share, so one CAS admits one execution. */
  private async decide(
    draft: AssistantDraft,
    choice: AssistantDraftChoice,
    by: { id: string | null; name: string | null }
  ): Promise<DraftDecision> {
    // A proposal offers no "always allow": either approval only starts it.
    if (choice !== 'discard')
      return draft.action === 'task'
        ? await this.approveTask(draft, by)
        : await this.approve(draft, by, choice === 'always')
    const now = this.host.now()
    if (!(await this.host.ledger().deny(draft.id, by, now))) return await this.refused(draft.id, now)
    await this.rewrite(draft.id)
    if (draft.action === 'task') await this.observeTask({ ...draft, status: 'denied', decidedByName: by.name })
    return { result: 'decided', status: 'denied', granted: false, failure: null }
  }

  /** Start an approved task (§5.10); a full sub-session limit leaves it awaiting review, and a changed record never runs. */
  private async approveTask(
    draft: AssistantDraft,
    by: { id: string | null; name: string | null }
  ): Promise<DraftDecision> {
    const ledger = this.host.ledger()
    const now = this.host.now()
    if (draft.status !== 'awaiting_review' || draft.expiresAt <= now) return await this.refused(draft.id, now)
    const failure = this.taskRefusal(draft)
    const started: TaskStart = failure
      ? (await ledger.failTask(draft.id, by, failure, now))
        ? { kind: 'failed', reason: failure }
        : { kind: 'lost' }
      : this.host.startTask
        ? await this.host.startTask(draft, by)
        : { kind: 'busy', reason: 'this daemon cannot run approved tasks' }
    switch (started.kind) {
      case 'lost':
        return await this.refused(draft.id, now)
      case 'busy': {
        // Still awaiting review: the card keeps its buttons and says why nothing ran; one decided meanwhile says so.
        const live = await ledger.get(draft.id)
        if (live?.status !== 'awaiting_review') return await this.refused(draft.id, now)
        if (live.approver && live.cardTs) {
          await this.host
            .cardPortFor(live.approver.integrationId)
            ?.updateCard(live.approver.channel, live.cardTs, this.pendingCard(live, started.reason))
            .catch((err: unknown) =>
              this.host.log.warn(`assistant proposal ${draft.id}: card update failed: ${(err as Error).message}`)
            )
        }
        return { result: 'busy', status: 'awaiting_review', granted: false, failure: started.reason }
      }
      case 'started':
        await this.rewriteDraft(draft)
        // The approval itself, even when the task already ended and recorded how.
        await this.observeTask({ ...draft, status: 'executing', decidedByName: by.name })
        return { result: 'decided', status: 'executing', granted: false, failure: null }
      case 'failed': {
        await this.rewriteDraft(draft)
        await this.observeTask({ ...draft, status: 'failed', failure: started.reason, subsessionKey: null })
        return { result: 'decided', status: 'failed', granted: false, failure: started.reason }
      }
    }
  }

  /** Why an approved task must not run at all: its record changed, or the agent left assistant mode. */
  private taskRefusal(draft: AssistantDraft): string | undefined {
    const proposal = draft.proposal
    if (!proposal || assistantTaskHash(draft.agentId, proposal.itemId, proposal.itemVersion, draft.text) !== draft.hash)
      return 'the proposal changed after it was written'
    if (this.host.agent(draft.agentId)?.assistantMode?.enabled !== true)
      return 'the agent is no longer in assistant mode'
    return undefined
  }

  /** One line on the proposal's item for each step it takes, so its next patrol knows. */
  private async observeTask(draft: AssistantDraft): Promise<void> {
    const proposal = draft.proposal
    if (!proposal || !this.host.observe) return
    const what = `"${oneLine(proposal.sentence)}"`
    const by = draft.decidedByName ? ` by ${draft.decidedByName}` : ''
    let text: string
    switch (draft.status) {
      case 'executing':
        text = `Proposal ${what} was approved${by}; it runs in a background session.`
        break
      case 'denied':
        text = `Proposal ${what} was denied${by}; nothing was run.`
        break
      case 'expired':
        text = `Proposal ${what} expired without a decision; nothing was run.`
        break
      case 'succeeded':
        text = `The approved task ${what} reported back.`
        break
      case 'outcome_unknown':
        text = `The approved task ${what} was cut short before it reported; it may have partly run and will not run again.`
        break
      case 'failed':
        text = draft.subsessionKey
          ? `The approved task ${what} ended without reporting back.`
          : `Proposal ${what} could not run: ${draft.failure ?? 'unknown error'}.`
        break
      default:
        return
    }
    await this.host
      .observe(draft.agentId, proposal.itemId, text)
      .catch((err: unknown) =>
        this.host.log.warn(`assistant proposal ${draft.id}: observation failed: ${(err as Error).message}`)
      )
  }

  /** A decision that lost the CAS: a due draft expires here, and the card shows whatever settled it. */
  private async refused(id: string, now: number): Promise<DraftDecision> {
    const ledger = this.host.ledger()
    await ledger.expire(id, now)
    await this.rewrite(id)
    const live = await ledger.get(id)
    const result = !live ? 'not-found' : live.status === 'expired' ? 'expired' : 'already-decided'
    return { result, status: live?.status ?? null, granted: false, failure: null }
  }

  private async approve(
    draft: AssistantDraft,
    by: { id: string | null; name: string | null },
    always: boolean
  ): Promise<DraftDecision> {
    const ledger = this.host.ledger()
    const now = this.host.now()
    if (!(await ledger.begin(draft.id, by, now))) return await this.refused(draft.id, now)
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
    return { result: 'decided', status: outcome.status, granted, failure: outcome.detail.failure ?? null }
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
    try {
      const messageId = await postAsAgent(gw, { id: draft.agentId, ...agent }, target, draft.text)
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
    if (draft.action === 'task') return await this.rewriteTaskCard(draft.id)
    const approver = draft.approver
    // A pending card keeps its buttons, and only the click that is posting writes the outcome; a running task drops them.
    const pending = draft.status === 'awaiting_review' || (draft.status === 'executing' && draft.action === 'post')
    if (!approver || !draft.cardTs || pending) return
    const port = this.host.cardPortFor(approver.integrationId)
    await port
      ?.updateCard(approver.channel, draft.cardTs, { view: this.viewOf(draft), outcome: outcomeOf(draft, granted) })
      .catch((err: unknown) =>
        this.host.log.warn(`assistant draft ${draft.id}: card update failed: ${(err as Error).message}`)
      )
  }

  /** A proposal's card from its record as it stands now, one rewrite at a time, so a late one never shows an older state. */
  private async rewriteTaskCard(id: string): Promise<void> {
    const write = async (): Promise<void> => {
      const live = await this.host.ledger().get(id)
      const approver = live?.approver
      if (!live || !approver || !live.cardTs || live.status === 'awaiting_review') return
      await this.host
        .cardPortFor(approver.integrationId)
        ?.updateCard(approver.channel, live.cardTs, { view: this.viewOf(live), outcome: outcomeOf(live, false) })
    }
    const next = (this.taskCards.get(id) ?? Promise.resolve())
      .then(write)
      .catch((err: unknown) =>
        this.host.log.warn(`assistant proposal ${id}: card update failed: ${(err as Error).message}`)
      )
    this.taskCards.set(id, next)
    await next
    if (this.taskCards.get(id) === next) this.taskCards.delete(id)
  }

  private viewOf(draft: AssistantDraft): AssistantDraftCardView {
    const sessionId = draft.source?.sessionId
    return {
      agentName: this.host.agent(draft.agentId)?.name ?? 'The agent',
      kind: draft.kind,
      ...(draft.proposal ? { proposal: { sentence: draft.proposal.sentence, why: draft.proposal.why } } : {}),
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

/** The daemon's own post as the agent, with no turn: an approved draft's, and a due reminder's (§5.9). */
export async function postAsAgent(
  gw: MessageGateway,
  agent: { id: string; name: string; iconUrl?: string },
  target: { channel: string; thread: string | null },
  text: string
): Promise<string | undefined> {
  const identity: SendIdentity = {
    username: agent.name,
    ...(agent.iconUrl ? { icon_url: agent.iconUrl } : {}),
    agentAuthorId: agent.id,
    // A post into a thread arrives finalized, like sendMessage's update form, so the thread routes it.
    ...(target.thread
      ? { response: { responseId: randomUUID(), deliveryState: 'final' as const, hopCount: 0, mentionedAgentIds: [] } }
      : {})
  }
  return await gw.postMessage(target.channel, text, target.thread ?? undefined, identity)
}

/** A grant's end of a place: integration and conversation, never a thread. */
function grantPlace(place: { platform: string; integrationId: string | null; channel: string }): AssistantGrantPlace {
  return { platform: place.platform, integrationId: place.integrationId, channel: place.channel }
}

function outcomeOf(draft: AssistantDraft, granted: boolean): string {
  const where = draft.decidedBy?.startsWith(consoleDecider('')) ? ' in the console' : ''
  const by = draft.decidedByName ? ` by ${draft.decidedByName}${where}` : where
  if (draft.action === 'task') return taskOutcomeOf(draft, by)
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

/** A proposal's card once it left review: running, how it ended, or why it never ran. */
function taskOutcomeOf(draft: AssistantDraft, by: string): string {
  switch (draft.status) {
    case 'executing':
      return `▶️ Approved${by}. Running in the background; it reports back in the conversation the item was taken in.`
    case 'succeeded':
      return `✅ Approved${by}. It ran and reported back in the conversation the item was taken in.`
    case 'denied':
      return `🚫 Denied${by}. Nothing was run.`
    case 'expired':
      return '⌛ Expired. Nothing was run.'
    case 'outcome_unknown':
      return `⚠️ Approved${by}, but not sure this went through: it was cut short before it reported. Please check. It will not be run again.`
    case 'failed':
      return draft.subsessionKey
        ? `⚠️ Approved${by}. It ended without reporting back; check the conversation the item was taken in.`
        : `⚠️ Could not run: ${draft.failure ?? 'unknown error'}. Nothing was run.`
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
