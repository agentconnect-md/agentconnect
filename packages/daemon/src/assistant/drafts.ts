// Drafts (assistant-mode.md §5.5, §5.10): a post or a check's proposed task that needs approval is recorded, carded to its approvers, and run once approved.
import { randomUUID } from 'node:crypto'
import type {
  AgentApprovalRoute,
  AgentApprovalRouted,
  AssistantDraftDecisionResult,
  AssistantModePolicy
} from '@agentconnect.md/protocol'
import type { MessageGateway, SendIdentity } from '../mcp/ops/context.js'
import type { SubsessionApprover } from '../permissions/subsession-approval.js'
import type { ReadAsker } from './place-access.js'
import { isSendQueueTimeout } from '../platforms/send-queue.js'
import type { AssistantDraftCardView, AssistantDraftChoice } from '../slack/render.js'
import {
  assistantDraftHash,
  assistantProposalHash,
  type AssistantDraft,
  type AssistantDraftApprover,
  type AssistantDraftDestination,
  type AssistantDraftKind,
  type AssistantDraftLedger,
  type AssistantDraftSource,
  type AssistantDraftStatus,
  type AssistantDraftTarget,
  type AssistantProposalFollowUp
} from '../store/assistant-drafts.js'

/** A pending card or the settled rewrite of one, as the platform's card surface renders it. */
export type DraftCard =
  | {
      draftId: string
      agentId: string
      /** The session the draft came from, for the click's routing target; absent for a placeless session. */
      sessionKey: string | null
      view: AssistantDraftCardView
      /** Why the last approval did not run, shown under the buttons it keeps. */
      notice?: string
    }
  | { view: AssistantDraftCardView; outcome: string }

/** The approval card surface of one integration; only a platform with interactive DM cards offers one. */
export interface DraftCardPort {
  openDirectMessage(user: string): Promise<string>
  /** Whether a user is a full member of the installing organization, the only way an asker approves; fails closed. */
  isFullMember(user: string): Promise<boolean>
  /** The workspace a member id lives in, for the decision record. */
  scope?(): string | undefined
  /** Whether a member is a person rather than a bot; fails closed. */
  isPerson?(user: string): Promise<boolean>
  /** A member's display name, for a click that arrived without one (a relayed click carries only the id). */
  nameOf?(user: string): Promise<string | undefined>
  /** The person a one-to-one direct message is with; null for any other conversation; throws when it cannot tell. */
  directMessageWith?(channel: string): Promise<string | null>
  /** `thread` posts into a platform thread rather than at the conversation's root. */
  postCard(channel: string, card: DraftCard, thread?: string): Promise<string | undefined>
  /** False when the platform refused the edit. */
  updateCard(channel: string, ts: string, card: DraftCard): Promise<boolean | void>
}

/** The internal member who asked, in their own DM: an external place's approval goes there as a draft's would (§5.5). */
export interface AskerApprover {
  integrationId: string
  teamId: string
  userId: string
  channel: string
}

/** Who asked for the post. */
export interface DraftAsker {
  /** A platform member, reached through the integration the turn came in on. */
  integrationId?: string
  userId?: string
  /** A console user (webchat), reached through the control plane. */
  consoleUserId?: string
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
  placeExternal(agentId: string, integrationId: string, channel: string): boolean
  cardPortFor(integrationId: string): DraftCardPort | undefined
  /** The control plane's approval route; undefined without one. */
  approvalRoute?(agentId: string, req: Omit<AgentApprovalRoute, 'agentId'>): Promise<AgentApprovalRouted>
  /** Whether the control plane answers the route's `responsible` form (`assistant-responsible-route-v1`); without it nobody is asked. */
  routesResponsible?(): boolean
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
  /** Take an approved follow-up form's follow-up with the approver as its asker; it claims the record itself (§5.13). */
  takeFollowUp?(draft: AssistantDraft, by: Decider): Promise<FollowUpTake>
  /** A card clicker's asker identity, as their own message there would carry it. */
  memberAsker?(integrationId: string, userId: string): Promise<string | undefined>
  /** Whether the follow-up an approved follow-up form named was taken. */
  followUpTaken?(agentId: string, itemId: string): Promise<boolean>
  /** An observation on a proposal's item, so its next check knows how the proposal went. */
  observe?(agentId: string, itemId: string, text: string): Promise<void>
  /** Whether a person's own message in this conversation would start a turn of the agent right now; fails closed. */
  admitsAsker?(agentId: string, integrationId: string, channel: string, isDm: boolean): boolean
}

/** How an approved task's start went: running, refused for the sub-session limit, lost to another decision, or failed for good. */
export type TaskStart =
  { kind: 'started' } | { kind: 'busy'; reason: string } | { kind: 'lost' } | { kind: 'failed'; reason: string }

/** How an approved follow-up form went: the follow-up it took, or why it took none. */
export type FollowUpTake =
  | { kind: 'taken'; itemId: string; parentSessionId: string }
  | { kind: 'busy'; reason: string }
  | { kind: 'lost' }
  | { kind: 'failed'; reason: string }

/** Who decided: the record's decider and name, and for an approval the asker identity a follow-up form's follow-up takes. */
export interface Decider {
  id: string | null
  name: string | null
  asker?: string
}

/** The conversation a proposal's card goes to in place, its item's own (§5.10). */
export interface ProposalPlace {
  integrationId: string
  channel: string
  /** The platform thread the conversation's replies land in; absent posts at the root. */
  thread?: string
}

/** A check's proposal (§5.10), as the check hands it over. */
export interface ProposalInput {
  agentId: string
  /** The item's place of origin, where the approved task runs and reports. */
  target: AssistantDraftTarget
  destination: Partial<AssistantDraftDestination>
  /** The task an approval runs; absent with `followUp`. */
  task?: string
  /** The follow-up form (§5.13): the follow-up an approval takes in place of a task. */
  followUp?: AssistantProposalFollowUp
  /** A getting-to-know task report round's proposal (§5.13): recorded now, carded once the round's reply posts. */
  hold?: { round: string; seq: number }
  sentence: string
  why: string
  itemId: string
  itemVersion: number
  source: AssistantDraftSource
  /** The item's conversation, for its card; absent for one with no integration (webchat). */
  place?: ProposalPlace
  /** The item lives in a webchat conversation: whoever may continue it decides on its page, so no card is posted. */
  webchat?: boolean
}

/** A conversation a console decision is bound to: only a proposal whose item lives there may be decided. */
export interface DecisionConversation {
  platform: string
  channel: string
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
  failure: string | null
  /** The follow-up an approved follow-up form took, and the conversation it belongs to. */
  followUp?: { id: string; parentSessionId: string }
}

/** The console user an editor's decision is recorded under, beside a card's `<workspace>:<member>`. */
export const consoleDecider = (userId: string): string => `user:${userId}`

type ApproverRung = 'asker' | 'responsible' | 'place'

const APPROVER_LABEL: Record<ApproverRung, string> = {
  asker: 'the person who asked, in a direct message',
  responsible: "the agent's responsible user, in a direct message",
  place: 'the people in the conversation the follow-up belongs to'
}

type Routed = { approver: AssistantDraftApprover; rung: ApproverRung }

const isChoice = (optionId: string): optionId is AssistantDraftChoice =>
  optionId === 'approve' || optionId === 'discard'

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

export class AssistantDrafts {
  /** Each proposal's card rewrites, one after another, so the last one shows the record as it ended. */
  private readonly taskCards = new Map<string, Promise<void>>()

  constructor(private readonly host: AssistantDraftsHost) {}

  /** A post the write rule sent for approval (§5.5): one into a shared or unconfirmed conversation, or from a run no person started; an agent outside assistant mode is refused when its asker cannot approve. */
  async interceptPost(
    agentId: string,
    source: AssistantDraftSource,
    post: InterceptedPost,
    asker: DraftAsker | undefined
  ): Promise<PostInterception> {
    const target: AssistantDraftTarget = {
      platform: post.platform,
      integrationId: post.integrationId,
      channel: post.channel,
      thread: post.thread ?? null
    }
    const destination = await this.host
      .describeDestination(target, { dm: post.directMessage, ...(post.recipient ? { recipient: post.recipient } : {}) })
      .catch(() => ({}))
    const { draft, rung } = await this.create({
      agentId,
      kind: 'elsewhere',
      target,
      targetDm: post.directMessage,
      targetExternal: this.host.placeExternal(agentId, post.integrationId, post.channel),
      destination,
      text: post.text,
      source,
      asker,
      requireApprover: true
    })
    return { handled: true, result: draftedResult(draft, rung) }
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
    const actor = input.actor
    const name = actor?.name ?? (actor ? await port?.nameOf?.(actor.userId).catch(() => undefined) : undefined)
    // The approver of a follow-up form becomes its follow-up's asker, as their own message there would.
    const asker =
      actor && draft.proposal?.followUp
        ? await this.host.memberAsker?.(approver.integrationId, actor.userId).catch(() => undefined)
        : undefined
    const by: Decider = {
      id: actor ? (scope ? `${scope}:${actor.userId}` : actor.userId) : null,
      name: name ?? null,
      ...(asker ? { asker } : {})
    }
    await this.decide(draft, input.optionId, by)
    return true
  }

  /** A console decision: an editor's, or with `conversation` one made on that webchat conversation's page; the control plane checked the caller, so only the agent and the conversation must match. */
  async decideFromConsole(input: {
    agentId: string
    draftId: string
    choice: AssistantDraftChoice
    decider: { userId: string; name: string | null }
    conversation?: DecisionConversation
  }): Promise<DraftDecision> {
    const draft = await this.host.ledger().get(input.draftId)
    const { conversation } = input
    const elsewhere =
      conversation !== undefined &&
      (draft?.action !== 'task' ||
        draft.target.platform !== conversation.platform ||
        draft.target.channel !== conversation.channel)
    if (!draft || draft.agentId !== input.agentId || elsewhere) {
      return { result: 'not-found', status: null, failure: null }
    }
    // A console user is a follow-up's asker by the same identity a webchat turn of theirs carries.
    const id = consoleDecider(input.decider.userId)
    return await this.decide(draft, input.choice, { id, name: input.decider.name, asker: id })
  }

  /** Rewrite this integration's cards, of agents held here, that were not edited when their draft was decided, as after a restart. */
  async retireStaleCards(integrationId: string): Promise<void> {
    for (const draft of await this.host.ledger().staleCards(integrationId))
      if (this.host.agent(draft.agentId)) await this.rewriteDraft(draft)
  }

  /** Expire the due drafts of these agents; an expired draft is never posted. */
  async sweep(agentIds: readonly string[]): Promise<void> {
    for (const draft of await this.host.ledger().expireDue(agentIds, this.host.now())) {
      await this.rewriteDraft(draft)
      if (draft.action === 'task') await this.observeTask(draft)
    }
  }

  /** A post cut short by a restart or handover is `outcome_unknown`, never retried (§5.10); a follow-up form cut short settles by whether its follow-up was taken. */
  async recover(agentIds: readonly string[]): Promise<void> {
    const ledger = this.host.ledger()
    for (const draft of await ledger.recoverExecuting(agentIds, this.host.now())) {
      await this.rewriteDraft(draft)
    }
    for (const draft of await ledger.executingFollowUps(agentIds)) {
      const itemId = draft.proposal?.tookItemId
      const taken = itemId ? await this.host.followUpTaken?.(draft.agentId, itemId).catch(() => false) : false
      const failure = taken ? null : 'a restart cut it short before the follow-up was taken'
      if (!(await ledger.settleFollowUp(draft.id, taken ? 'succeeded' : 'failed', failure, this.host.now()))) continue
      const live = await ledger.get(draft.id)
      if (!live) continue
      await this.rewriteDraft(live)
      await this.observeTask(live)
    }
  }

  /** A check's proposal (§5.10): carded in its follow-up's conversation, decided on a webchat conversation's page, else carded like a draft with no asker (the responsible user, else Activity); a getting-to-know task report round's waits for {@link releaseRound}. */
  async propose(input: ProposalInput): Promise<{ draft: AssistantDraft; approver: string | null }> {
    const id = randomUUID()
    const ledger = this.host.ledger()
    const record = async (approver: AssistantDraftApprover | null): Promise<AssistantDraft> =>
      await ledger.createTask({
        id,
        agentId: input.agentId,
        target: input.target,
        destination: input.destination,
        task: input.task ?? '',
        ...(input.followUp ? { followUp: input.followUp } : {}),
        ...(input.hold ? { round: { id: input.hold.round, seq: input.hold.seq } } : {}),
        sentence: input.sentence,
        why: input.why,
        itemId: input.itemId,
        itemVersion: input.itemVersion,
        source: input.source,
        approver,
        now: this.host.now()
      })
    // A webchat conversation has no card: its people decide on its page and editors in Activity, never the responsible user.
    if (input.webchat)
      return { draft: await record(placeApprover('', input.target.channel)), approver: APPROVER_LABEL.place }
    // Only a place whose people could ask the agent there gets the card: anyone else could not approve it.
    const place = input.place && (await this.askers(input.agentId, input.place)) ? input.place : undefined
    const routed: Routed | undefined = place
      ? { rung: 'place', approver: placeApprover(place.integrationId, place.channel) }
      : await this.route(input.agentId, id, undefined)
    const draft = await record(routed?.approver ?? null)
    // A getting-to-know task report round's cards wait for its reply, so they land in that reply's thread (§5.13).
    if (input.hold) return { draft, approver: routed ? APPROVER_LABEL[routed.rung] : null }
    return await this.cardProposal(draft, routed, place?.thread)
  }

  /** A getting-to-know task report round's held cards (§5.13), in the order proposed: in `thread`, its reply's once that posted, else where the place's cards go. */
  async releaseRound(agentId: string, round: string, thread: string | undefined): Promise<void> {
    const ledger = this.host.ledger()
    for (const held of await ledger.heldInRound(agentId, round)) {
      if (!(await ledger.unhold(held.id))) continue
      const live = (await ledger.get(held.id)) ?? held
      // One decided from the console meanwhile, or expired, needs no card.
      if (live.status !== 'awaiting_review') continue
      const approver = live.approver
      const routed: Routed | undefined = approver
        ? { approver, rung: approver.kind === 'place' ? 'place' : 'responsible' }
        : undefined
      await this.cardProposal(live, routed, approver?.kind === 'place' ? thread : undefined).catch((err: unknown) =>
        this.host.log.warn(`assistant proposal ${live.id}: its held card was not posted: ${(err as Error).message}`)
      )
    }
  }

  /** Card a recorded proposal; a place that could not take it hands it to the responsible user, and only there. */
  private async cardProposal(
    draft: AssistantDraft,
    routed: Routed | undefined,
    thread: string | undefined
  ): Promise<{ draft: AssistantDraft; approver: string | null }> {
    const ledger = this.host.ledger()
    const { id } = draft
    let carded = await this.card(draft, routed, thread)
    if (carded.mayHaveLanded) {
      // The in-place card may still land, so it is never carded twice: its people decide it, or editors in Activity.
      this.host.log.warn(`assistant proposal ${id}: its card's post timed out and may still land; not rerouted`)
      return { draft: carded.draft, approver: APPROVER_LABEL.place }
    }
    if (routed?.rung === 'place' && !carded.rung) {
      const responsible = await this.route(draft.agentId, id, undefined)
      if (await ledger.reroute(id, responsible?.approver ?? null))
        carded = await this.card((await ledger.get(id)) ?? draft, responsible)
    }
    if (!carded.rung)
      this.host.log.warn(`assistant proposal ${id}: no approver could be reached for agent "${draft.agentId}"`)
    return { draft: carded.draft, approver: carded.rung ? APPROVER_LABEL[carded.rung] : null }
  }

  /** Where any agent's sub-session request for an external place goes instead (§5.5, §5.6): the responsible user's DM. */
  async cardApprover(agentId: string, requestId: string): Promise<SubsessionApprover | undefined> {
    const approver = await this.routeConsoleUser(agentId, requestId, undefined).catch((err: unknown) => {
      this.host.log.warn(`sub-session request ${requestId}: approver lookup failed: ${(err as Error).message}`)
      return undefined
    })
    if (!approver?.userId || !approver.teamId || !approver.consoleUserId) return undefined
    const { integrationId, teamId, userId, consoleUserId } = approver
    return { channel: approver.channel, target: { integrationId, teamId, userId, consoleUserId } }
  }

  /** The asker's own DM when they are an internal member, the first approver a draft tries; undefined otherwise. */
  async askerApprover(asker: DraftAsker): Promise<AskerApprover | undefined> {
    const approver = await this.askerRung(asker).catch(() => undefined)
    if (!approver?.userId || !approver.teamId) return undefined
    const { integrationId, teamId, userId, channel } = approver
    return { integrationId, teamId, userId, channel }
  }

  /** A person behind a turn in their own DM, routed as a draft's approver: a member's own DM, else a console user's linked one. */
  async personApprover(
    agentId: string,
    requestId: string,
    asker: ReadAsker
  ): Promise<{ target: AskerApprover & { consoleUserId?: string }; channel: string } | undefined> {
    const approver = await (
      asker.kind === 'member'
        ? this.askerRung({ integrationId: asker.integrationId, userId: asker.userId })
        : this.routeConsoleUser(agentId, requestId, asker.userId)
    ).catch(() => undefined)
    if (!approver?.userId || !approver.teamId) return undefined
    const { integrationId, teamId, userId, channel, consoleUserId } = approver
    return { target: { integrationId, teamId, userId, channel, ...(consoleUserId ? { consoleUserId } : {}) }, channel }
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
    /** Outside assistant mode no one else may approve, so a draft no one could approve is refused, never kept. */
    requireApprover?: boolean
  }): Promise<{ draft: AssistantDraft; rung: ApproverRung | undefined }> {
    const id = randomUUID()
    const routed = await this.route(input.agentId, id, input.asker)
    if (!routed && input.requireApprover && !this.assistantOn(input.agentId)) {
      throw new Error(
        'sendMessage: a post to that conversation needs the approval of an internal member, and the person who asked ' +
          'cannot be reached for it. Nothing was sent.'
      )
    }
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
      now: this.host.now()
    })
    return await this.card(draft, routed)
  }

  private async route(agentId: string, id: string, asker: DraftAsker | undefined): Promise<Routed | undefined> {
    return await this.approverFor(agentId, id, asker).catch((err: unknown) => {
      this.host.log.warn(`assistant draft ${id}: approver lookup failed: ${(err as Error).message}`)
      return undefined
    })
  }

  /** Post the pending card to its approver and keep its handle; undefined rung when no card went out, `mayHaveLanded` when a timed-out post may still. */
  private async card(
    draft: AssistantDraft,
    routed: Routed | undefined,
    thread?: string
  ): Promise<{ draft: AssistantDraft; rung: ApproverRung | undefined; mayHaveLanded?: true }> {
    if (!routed) return { draft, rung: undefined }
    const ledger = this.host.ledger()
    const port = this.host.cardPortFor(routed.approver.integrationId)
    const posted = await port?.postCard(routed.approver.channel, this.pendingCard(draft), thread).then(
      (ts) => ({ ts, mayHaveLanded: false }),
      (err: unknown) => {
        this.host.log.warn(`assistant draft ${draft.id}: card post failed: ${(err as Error).message}`)
        return { ts: undefined, mayHaveLanded: isSendQueueTimeout(err) }
      }
    )
    const ts = posted?.ts
    if (!ts) return posted?.mayHaveLanded ? { draft, rung: undefined, mayHaveLanded: true } : { draft, rung: undefined }
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
      ...(notice ? { notice } : {})
    }
  }

  /** The asker when an internal member, a console asker, then in assistant mode the responsible user the control plane derives; else nobody, and Activity decides it. */
  private async approverFor(
    agentId: string,
    draftId: string,
    asker: DraftAsker | undefined
  ): Promise<Routed | undefined> {
    const own = await this.askerRung(asker)
    if (own) return { rung: 'asker', approver: own }
    if (asker?.consoleUserId) {
      const approver = await this.routeConsoleUser(agentId, draftId, asker.consoleUserId)
      if (approver) return { approver, rung: 'asker' }
    }
    if (!this.assistantOn(agentId)) return undefined
    const approver = await this.routeConsoleUser(agentId, draftId, undefined)
    return approver ? { approver, rung: 'responsible' } : undefined
  }

  /** The platform asker's own DM when their card port says they are a full member, for every agent and in any place; a failed lookup is not one. */
  private async askerRung(asker: DraftAsker | undefined): Promise<AssistantDraftApprover | undefined> {
    if (!asker?.integrationId || !asker.userId) return undefined
    const port = this.host.cardPortFor(asker.integrationId)
    const internal =
      port &&
      (await port.isFullMember(asker.userId).then(
        (full) => full === true,
        () => false
      ))
    const channel = internal ? await port.openDirectMessage(asker.userId).catch(() => undefined) : undefined
    if (!port || !channel) return undefined
    return {
      kind: 'member',
      integrationId: asker.integrationId,
      channel,
      userId: asker.userId,
      teamId: port.scope?.() ?? null,
      consoleUserId: null
    }
  }

  /** A console user's linked member on one of the agent's card-capable integrations, chosen by the control plane; undefined names the agent's responsible user. */
  private async routeConsoleUser(
    agentId: string,
    draftId: string,
    consoleUserId: string | undefined
  ): Promise<AssistantDraftApprover | undefined> {
    const integrationIds = (this.host.agent(agentId)?.integrations ?? [])
      .map((i) => i.id)
      .filter((id) => this.host.cardPortFor(id) !== undefined)
      .slice(0, 8)
    if (integrationIds.length === 0 || !this.host.approvalRoute) return undefined
    if (consoleUserId === undefined && this.host.routesResponsible?.() !== true) return undefined
    const routed = await this.host
      .approvalRoute(agentId, {
        requestId: draftId,
        integrationIds,
        ...(consoleUserId ? { consoleUserId } : { responsible: true as const })
      })
      .catch(() => undefined)
    const target = routed?.target
    // A control plane that predates the named route answers with its own chain; only the named user counts.
    if (!target || (consoleUserId !== undefined && target.consoleUserId !== consoleUserId)) return undefined
    const port = this.host.cardPortFor(target.integrationId)
    const channel = await port?.openDirectMessage(target.userId).catch(() => undefined)
    if (!channel) return undefined
    return {
      kind: 'member',
      integrationId: target.integrationId,
      channel,
      userId: target.userId,
      teamId: target.teamId,
      consoleUserId: target.consoleUserId
    }
  }

  /** The addressed member, re-verified with the control plane when it chose them; in a proposal's place, whoever could ask the agent there. */
  private async authorized(
    draft: AssistantDraft,
    approver: AssistantDraftApprover,
    actor: { userId: string } | undefined
  ): Promise<boolean> {
    if (!actor?.userId) return false
    if (approver.kind === 'place') {
      const askers = await this.askers(draft.agentId, approver)
      if (!askers || (askers.dmWith !== null && askers.dmWith !== actor.userId)) return false
      const port = this.host.cardPortFor(approver.integrationId)
      return (await port?.isPerson?.(actor.userId).catch(() => false)) === true
    }
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

  /** Who may ask the agent in a place right now: its DM's person, or anyone its admission lets start a turn; undefined when no one may or it cannot tell. */
  private async askers(
    agentId: string,
    place: { integrationId: string; channel: string }
  ): Promise<{ dmWith: string | null } | undefined> {
    const port = this.host.cardPortFor(place.integrationId)
    if (!port?.isPerson || !port.directMessageWith || !this.host.admitsAsker) return undefined
    const dmWith = await port.directMessageWith(place.channel).catch(() => undefined)
    if (dmWith === undefined) return undefined
    return this.host.admitsAsker(agentId, place.integrationId, place.channel, dmWith !== null) ? { dmWith } : undefined
  }

  private assistantOn(agentId: string): boolean {
    return this.host.agent(agentId)?.assistantMode?.enabled === true
  }

  /** Approve or discard: the one path a card click and the console share, so one CAS admits one execution. */
  private async decide(draft: AssistantDraft, choice: AssistantDraftChoice, by: Decider): Promise<DraftDecision> {
    if (choice === 'approve') {
      if (draft.proposal?.followUp) return await this.approveFollowUp(draft, by)
      return draft.action === 'task' ? await this.approveTask(draft, by) : await this.approve(draft, by)
    }
    const now = this.host.now()
    if (!(await this.host.ledger().deny(draft.id, by, now))) return await this.refused(draft.id, now)
    await this.rewrite(draft.id)
    if (draft.action === 'task') await this.observeTask({ ...draft, status: 'denied', decidedByName: by.name })
    return { result: 'decided', status: 'denied', failure: null }
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
        : { kind: 'busy', reason: 'this daemon cannot run approved proposals' }
    switch (started.kind) {
      case 'lost':
        return await this.refused(draft.id, now)
      case 'busy':
        return await this.stillWaiting(draft, started.reason)
      case 'started':
        await this.rewriteDraft(draft)
        // The approval itself, even when the task already ended and recorded how.
        await this.observeTask({ ...draft, status: 'executing', decidedByName: by.name })
        return { result: 'decided', status: 'executing', failure: null }
      case 'failed': {
        await this.rewriteDraft(draft)
        await this.observeTask({ ...draft, status: 'failed', failure: started.reason, subsessionKey: null })
        return { result: 'decided', status: 'failed', failure: started.reason }
      }
    }
  }

  /** Take an approved follow-up form's follow-up (§5.13): no task runs and no limit counts; a changed record takes none. */
  private async approveFollowUp(draft: AssistantDraft, by: Decider): Promise<DraftDecision> {
    const ledger = this.host.ledger()
    const now = this.host.now()
    if (draft.status !== 'awaiting_review' || draft.expiresAt <= now) return await this.refused(draft.id, now)
    const failure = this.taskRefusal(draft) ?? (by.asker ? undefined : 'the approver could not be identified')
    const taken: FollowUpTake = failure
      ? (await ledger.failTask(draft.id, by, failure, now))
        ? { kind: 'failed', reason: failure }
        : { kind: 'lost' }
      : this.host.takeFollowUp
        ? await this.host.takeFollowUp(draft, by)
        : { kind: 'busy', reason: 'this daemon cannot take follow-ups from proposals' }
    switch (taken.kind) {
      case 'lost':
        return await this.refused(draft.id, now)
      case 'busy':
        return await this.stillWaiting(draft, taken.reason)
      case 'taken': {
        const live = (await ledger.get(draft.id)) ?? draft
        await this.rewriteDraft(live)
        await this.observeTask({ ...live, decidedByName: by.name })
        return {
          result: 'decided',
          status: 'succeeded',
          failure: null,
          followUp: { id: taken.itemId, parentSessionId: taken.parentSessionId }
        }
      }
      case 'failed': {
        const live = (await ledger.get(draft.id)) ?? { ...draft, status: 'failed' as const, failure: taken.reason }
        await this.rewriteDraft(live)
        await this.observeTask({ ...live, subsessionKey: null })
        return { result: 'decided', status: 'failed', failure: taken.reason }
      }
    }
  }

  /** Still awaiting review: the card keeps its buttons and says why nothing ran; one decided meanwhile says so. */
  private async stillWaiting(draft: AssistantDraft, reason: string): Promise<DraftDecision> {
    const ledger = this.host.ledger()
    const live = await ledger.get(draft.id)
    if (live?.status !== 'awaiting_review') return await this.refused(draft.id, this.host.now())
    if (live.approver && live.cardTs) {
      await this.host
        .cardPortFor(live.approver.integrationId)
        ?.updateCard(live.approver.channel, live.cardTs, this.pendingCard(live, reason))
        .catch((err: unknown) =>
          this.host.log.warn(`assistant proposal ${draft.id}: card update failed: ${(err as Error).message}`)
        )
    }
    return { result: 'busy', status: 'awaiting_review', failure: reason }
  }

  /** Why an approved task must not run at all: its record changed, or the agent left assistant mode. */
  private taskRefusal(draft: AssistantDraft): string | undefined {
    const proposal = draft.proposal
    if (!proposal || assistantProposalHash(draft.agentId, proposal, draft.text) !== draft.hash)
      return 'the proposal changed after it was written'
    if (this.host.agent(draft.agentId)?.assistantMode?.enabled !== true)
      return 'the agent is no longer in assistant mode'
    return undefined
  }

  /** One line on the proposal's item for each step it takes, so its next check knows. */
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
      case 'succeeded':
        if (proposal.followUp) {
          text = `Proposal ${what} was approved${by}; it was taken as the follow-up "${oneLine(proposal.followUp.title)}".`
          break
        }
        text = `The approved proposal ${what} reported back.`
        break
      case 'denied':
        text = `Proposal ${what} was denied${by}; nothing was run.`
        break
      case 'expired':
        text = `Proposal ${what} expired without a decision; nothing was run.`
        break
      case 'outcome_unknown':
        text = `The approved proposal ${what} was cut short before it reported; it may have partly run and will not run again.`
        break
      case 'failed':
        text = draft.subsessionKey
          ? `The approved proposal ${what} ended without reporting back.`
          : `Proposal ${what} could not ${proposal.followUp ? 'be taken' : 'run'}: ${draft.failure ?? 'unknown error'}.`
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
    return { result, status: live?.status ?? null, failure: null }
  }

  private async approve(draft: AssistantDraft, by: { id: string | null; name: string | null }): Promise<DraftDecision> {
    const ledger = this.host.ledger()
    const now = this.host.now()
    if (!(await ledger.begin(draft.id, by, now))) return await this.refused(draft.id, now)
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
    await this.rewrite(draft.id)
    return { result: 'decided', status: outcome.status, failure: outcome.detail.failure ?? null }
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

  private async rewrite(id: string): Promise<void> {
    const draft = await this.host.ledger().get(id)
    if (draft) await this.rewriteDraft(draft)
  }

  private async rewriteDraft(draft: AssistantDraft): Promise<void> {
    if (draft.action === 'task') return await this.rewriteTaskCard(draft.id)
    const approver = draft.approver
    // A pending card keeps its buttons, and only the click that is posting writes the outcome; a running task drops them.
    const pending = draft.status === 'awaiting_review' || (draft.status === 'executing' && draft.action === 'post')
    if (!approver || !draft.cardTs || pending) return
    const port = this.host.cardPortFor(approver.integrationId)
    if (!port) return
    const shown = await port
      .updateCard(approver.channel, draft.cardTs, { view: this.viewOf(draft), outcome: outcomeOf(draft) })
      .catch((err: unknown) => {
        this.host.log.warn(`assistant draft ${draft.id}: card update failed: ${(err as Error).message}`)
        return false
      })
    if (shown !== false) await this.host.ledger().markCard(draft.id, draft.status)
  }

  /** A proposal's card from its record as it stands now, one rewrite at a time, so a late one never shows an older state. */
  private async rewriteTaskCard(id: string): Promise<void> {
    const write = async (): Promise<void> => {
      const ledger = this.host.ledger()
      const live = await ledger.get(id)
      const approver = live?.approver
      if (!live || !approver || !live.cardTs || live.status === 'awaiting_review') return
      const port = this.host.cardPortFor(approver.integrationId)
      if (!port) return
      const shown = await port.updateCard(approver.channel, live.cardTs, {
        view: this.viewOf(live),
        outcome: outcomeOf(live)
      })
      if (shown !== false) await ledger.markCard(id, live.status)
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
      ...(draft.proposal
        ? {
            proposal: {
              sentence: draft.proposal.sentence,
              why: draft.proposal.why,
              ...(draft.proposal.followUp ? { followUp: draft.proposal.followUp } : {})
            }
          }
        : {}),
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

/** Whoever could ask the agent in a proposal's own place; a webchat place has no integration (''). */
const placeApprover = (integrationId: string, channel: string): AssistantDraftApprover => ({
  kind: 'place',
  integrationId,
  channel,
  userId: null,
  teamId: null,
  consoleUserId: null
})

function outcomeOf(draft: AssistantDraft): string {
  const where = draft.decidedBy?.startsWith(consoleDecider('')) ? ' in the console' : ''
  const by = draft.decidedByName ? ` by ${draft.decidedByName}${where}` : where
  if (draft.action === 'task') return taskOutcomeOf(draft, by)
  switch (draft.status) {
    case 'succeeded':
      return `✅ Posted — approved${by}.`
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

/** A proposal's card once it left review: running, how it ended, or why it never ran; a follow-up form's, the follow-up it took. */
function taskOutcomeOf(draft: AssistantDraft, by: string): string {
  if (draft.proposal?.followUp) return followUpOutcomeOf(draft, by)
  switch (draft.status) {
    case 'executing':
      return `▶️ Approved${by}. Running in the background; it reports back in the conversation the follow-up belongs to.`
    case 'succeeded':
      return `✅ Approved${by}. It ran and reported back in the conversation the follow-up belongs to.`
    case 'denied':
      return `🚫 Denied${by}. Nothing was run.`
    case 'expired':
      return '⌛ Expired. Nothing was run.'
    case 'outcome_unknown':
      return `⚠️ Approved${by}, but not sure this went through: it was cut short before it reported. Please check. It will not be run again.`
    case 'failed':
      return draft.subsessionKey
        ? `⚠️ Approved${by}. It ended without reporting back; check the conversation the follow-up belongs to.`
        : `⚠️ Could not run: ${draft.failure ?? 'unknown error'}. Nothing was run.`
    default:
      return ''
  }
}

/** A follow-up form's card once it left review: the follow-up taken, or why none was. */
function followUpOutcomeOf(draft: AssistantDraft, by: string): string {
  switch (draft.status) {
    case 'executing':
      return `▶️ Approved${by}. Taking the follow-up.`
    case 'succeeded':
      return (
        `✅ Approved${by}. The follow-up was taken; it reports in the conversation it belongs to.` +
        (draft.failure ? ` It is not watched: ${draft.failure}.` : '')
      )
    case 'denied':
      return `🚫 Denied${by}. No follow-up was taken.`
    case 'expired':
      return '⌛ Expired. No follow-up was taken.'
    case 'failed':
      return `⚠️ Could not take the follow-up: ${draft.failure ?? 'unknown error'}.`
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
        'Not posted: a post to that conversation needs approval, and no approver could be reached for this agent. ' +
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
