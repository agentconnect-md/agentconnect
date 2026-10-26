// Capability requests on the daemon (capability-requests.md §4): the agent's ask, its cards, a Decline from a card, and the settling wake.
import { randomUUID } from 'node:crypto'
import type {
  CapabilityAsk,
  CapabilityAskers,
  CapabilityDecideReq,
  CapabilityDecideResult,
  CapabilityForward,
  CapabilityForwardResult,
  CapabilityReopened,
  CapabilityRequestReq,
  CapabilityRequestResult,
  CapabilityWithdrawReq,
  CapabilityWithdrawResult,
  SessionCapabilitySettled,
  SessionCapabilitySettledResult
} from '@agentconnect.md/protocol'
import { CAPABILITY_REQUEST_SESSION_CAP } from '@agentconnect.md/protocol'
import {
  parseCapabilityDeclineOption,
  type CapabilityCardFacet,
  type CapabilityCardModel,
  type CapabilityCardOutcome
} from '../platforms/capability-card.js'
import type { ElicitCardHost, ElicitCardTurn } from '../platforms/elicit-card.js'
import type { CapabilityCardLedger, CapabilityCardRow, CapabilityCardView } from '../store/capability-cards.js'
import type { ReadAsker } from '../assistant/place-access.js'
import { capabilityReminderText } from './reminder.js'

/** The CP calls this module makes. */
export interface CapabilityCp {
  capabilityRequest(payload: CapabilityRequestReq, orgId?: string): Promise<CapabilityRequestResult>
  capabilityWithdraw(payload: CapabilityWithdrawReq, orgId?: string): Promise<CapabilityWithdrawResult>
  capabilityDecide(payload: CapabilityDecideReq, orgId?: string): Promise<CapabilityDecideResult>
}

/** A console user's or the responsible user's chat identity on one of the agent's integrations with a card. */
export interface CapabilityDmTarget {
  integrationId: string
  userId: string
}

export interface CapabilityRequestsHost {
  now(): number
  log: { info(message: string): void; warn(message: string): void }
  /** The CP when it serves capability requests; undefined otherwise. */
  cp(): CapabilityCp | undefined
  orgForAgent(agentId: string): string | undefined
  agent(
    agentId: string
  ): { name: string; iconUrl?: string; integrations: readonly { id: string; platform: string }[] } | undefined
  /** The platform's own card facet, exact lookup: webchat, hook and dream turns have none. */
  facet(platform: string): CapabilityCardFacet | undefined
  cardHost: ElicitCardHost
  /** The session's live turn, which a card in its own conversation is posted on. */
  liveTurn(sessionKey: string): ElicitCardTurn | undefined
  conn(integrationId: string): unknown
  cards(): CapabilityCardLedger
  /** A named console user's linked identity, or without one the agent's responsible user, on a card-capable integration. */
  routeDm(agentId: string, requestId: string, consoleUserId?: string): Promise<CapabilityDmTarget | undefined>
  /** Whether a person's own message in this conversation would start a turn of the agent; fails closed. */
  admitsAsker(agentId: string, integrationId: string, channel: string, isDm: boolean): boolean
  /** Make the session's next turn re-attach with `session/load` (§4.8). */
  forgetSession(agentId: string, sessionKey: string): Promise<void>
  /** Enqueue the durable reminder into the origin session, speaking for `askers` (§4.7.2). */
  dispatchWake(
    req: SessionCapabilitySettled,
    text: string,
    askers: CapabilityAskers
  ): Promise<SessionCapabilitySettledResult>
}

/** The session the tool was called from, as the daemon resolved it from the trusted session context. */
export interface CapabilityOrigin {
  agentId: string
  sessionKey: string
  sessionId: string
  platform: string
  channel: string
  integrationId?: string
  askers: CapabilityAskers
  /** Who the turn spoke for, for the card's context line. */
  askedBy?: string
  placeLabel?: string
  /** The place is shared with another organization (§4.4.5). */
  external: boolean
}

/** What `requestCapability` returns to the model. */
export interface CapabilityToolResult {
  status: CapabilityRequestResult['status']
  requestId?: string
  link?: string
  message: string
}

/** The prefix a forwarded card's row is keyed by, so every origin's settlement rewrites it too. */
const FORWARD_KEY = 'capability-forward:'

const END_TURN = 'Stop the work that needs it and end your turn; you are woken in this conversation when it is settled.'

/** Members of the agent's own integrations and console users; anyone else is dropped, never widened (§4.7.2). */
export function ownAskers(askers: CapabilityAskers, integrationIds: readonly string[]): CapabilityAskers {
  const own = new Set(integrationIds)
  const people = askers.people.filter((p) => p.kind === 'console' || own.has(p.integrationId))
  return { people, nobody: askers.nobody || people.length < askers.people.length || people.length === 0 }
}

export class CapabilityRequests {
  constructor(private readonly host: CapabilityRequestsHost) {}

  /** `requestCapability` (§4.1): forward the ask, then post its card where the people it concerns will see it. */
  async request(origin: CapabilityOrigin, ask: CapabilityAsk, reason: string): Promise<CapabilityToolResult> {
    const cp = this.host.cp()
    if (!cp) throw new Error('requestCapability is not available: this agent cannot ask for changes right now')
    void this.host
      .cards()
      .sweep(this.host.now())
      .catch(() => undefined)
    const result = await cp.capabilityRequest(
      {
        agentId: origin.agentId,
        sessionId: origin.sessionId,
        sessionKey: origin.sessionKey,
        ask,
        reason,
        askers: origin.askers,
        platform: origin.platform,
        ...(origin.placeLabel ? { placeLabel: origin.placeLabel } : {}),
        ...(origin.external ? { external: true } : {})
      },
      this.host.orgForAgent(origin.agentId)
    )
    if (result.status !== 'pending') return refusedResult(result)
    const { requestId, generation, link } = result
    if (!requestId || !generation || !link) throw new Error('requestCapability: the request was not recorded')
    const summary = result.summary ?? 'the change you asked for'
    const base = { status: 'pending' as const, requestId, link }
    const joined = result.joined
      ? ' Another conversation had already asked for the same thing; this conversation now waits for it too.'
      : ''
    if ((await this.host.cards().forRequest(requestId, origin.sessionKey)).some((row) => row.settledAt === null)) {
      return {
        ...base,
        message: `You already asked for this in this conversation and its card is still open. Do not ask again. ${END_TURN}`
      }
    }
    const view: CapabilityCardView = {
      summary,
      reason,
      link,
      agentName: this.host.agent(origin.agentId)?.name ?? 'The agent',
      ...(origin.askedBy ? { context: `Asked for ${origin.askedBy}` } : {})
    }
    // An external place sees no request details, and a turn nobody is behind has nobody to show it to (§4.4.5).
    if (origin.external || origin.askers.people.length === 0) {
      const dm = await this.postToDm(origin.agentId, requestId, generation, origin.sessionKey, view, undefined)
      if (origin.external) {
        return {
          ...base,
          message:
            'Say only: "I\'ve asked an admin for access." This conversation includes people from another organization, ' +
            `so do not describe the request or share its link here.${joined} ${END_TURN}`
        }
      }
      return {
        ...base,
        message:
          (dm
            ? 'Nobody is in this conversation to see a card, so it was sent to the person responsible for you in a direct message.'
            : 'Nobody is in this conversation to see a card; the request is listed in your Activity for the people who manage you.') +
          `${joined} ${END_TURN}`
      }
    }
    const posted = await this.postInTurn(origin, requestId, generation, view)
    if (posted) {
      return {
        ...base,
        message:
          'A card with your request was posted here, with a link for someone who can make the change and a Decline ' +
          `button. Tell the people here in one sentence what you are waiting for; do not repeat the link.${joined} ${END_TURN}`
      }
    }
    return {
      ...base,
      message:
        `No card can be shown here. Put this in your reply, with the link: "I've asked for ${summary}. Someone who can ` +
        `change my setup can complete or decline it here: ${link}".${joined} ${END_TURN}`
    }
  }

  /** `withdrawCapabilityRequest`: the agent no longer needs it; this conversation's cards say so and nobody is woken. */
  async withdraw(origin: Pick<CapabilityOrigin, 'agentId' | 'sessionId' | 'sessionKey'>, requestId: string) {
    const cp = this.host.cp()
    if (!cp) throw new Error('withdrawCapabilityRequest is not available right now')
    const result = await cp.capabilityWithdraw(
      { agentId: origin.agentId, sessionId: origin.sessionId, requestId },
      this.host.orgForAgent(origin.agentId)
    )
    if (result.status === 'withdrawn') {
      await this.rewrite(requestId, (row) => row.sessionKey === origin.sessionKey, { status: 'withdrawn' })
      return { status: result.status, message: 'Withdrawn. Its card here now says it is no longer needed.' }
    }
    return {
      status: result.status,
      message:
        result.status === 'already_settled'
          ? 'That request was already settled; there is nothing to withdraw.'
          : 'No open request of yours has that id.'
    }
  }

  /** A card button whose option is a capability Decline: true when it was one, whatever became of it (§4.4.3, §4.4.4). */
  async decline(click: {
    requestId: string
    optionId: string
    actor?: { userId: string; name?: string }
    integrationId?: string
    agentId?: string
  }): Promise<boolean> {
    const option = parseCapabilityDeclineOption(click.optionId)
    if (!option) return false
    const row = await this.host
      .cards()
      .get(option.cardId)
      .catch(() => undefined)
    if (!row || row.requestId !== click.requestId) return true
    if (click.agentId !== undefined && click.agentId !== row.agentId) return true
    if (click.integrationId !== undefined && click.integrationId !== row.integrationId) return true
    const facet = this.host.facet(row.platform)
    const conn = this.host.conn(row.integrationId)
    const actor = click.actor
    if (!facet || !conn || !actor?.userId) return true
    const handle = { conn, channel: row.channel, ...(row.thread ? { thread: row.thread } : {}) }
    const tell = (text: string) => void facet.tellPrivately(handle, actor.userId, text).catch(() => undefined)
    if (!(await this.mayDecline(row, facet, conn, actor.userId))) {
      tell(`Only someone who can ask ${row.view.agentName} here can decline this request.`)
      return true
    }
    const cp = this.host.cp()
    const name = actor.name ?? (await facet.nameOf(conn, actor.userId).catch(() => undefined))
    const decided = cp
      ? await cp
          .capabilityDecide(
            {
              agentId: row.agentId,
              requestId: row.requestId,
              generation: option.generation,
              decision: 'decline',
              by: {
                kind: 'member',
                platform: row.platform,
                integrationId: row.integrationId,
                userId: actor.userId,
                ...(name ? { name } : {})
              }
            },
            this.host.orgForAgent(row.agentId)
          )
          .catch(() => undefined)
      : undefined
    // The card changes only when the settlement comes back as a wake; a click alone settles nothing here.
    if (!decided) tell('This request could not be declined right now. Try again in a moment.')
    else if (decided.result === 'already_settled') tell('This request was already settled.')
    else if (decided.result === 'not_found') tell('This request no longer exists.')
    return true
  }

  /** The CP's settling wake for one origin (§4.7.2): rewrite its cards, forget the session if asked, enqueue the reminder. */
  async settled(req: SessionCapabilitySettled): Promise<SessionCapabilitySettledResult> {
    const agent = this.host.agent(req.agentId)
    if (!agent) return { accepted: false, reason: 'not_ready' }
    const outcome: CapabilityCardOutcome =
      req.status === 'completed'
        ? { status: 'completed', outcome: req.outcome, ...(req.by ? { by: req.by.name } : {}) }
        : req.status === 'declined'
          ? { status: 'declined', ...(req.by ? { by: req.by.name } : {}) }
          : { status: 'expired' }
    await this.rewrite(
      req.requestId,
      (row) => row.sessionKey === req.sessionKey || row.sessionKey === `${FORWARD_KEY}${req.requestId}`,
      outcome
    ).catch((err: unknown) => this.host.log.warn(`capability ${req.requestId}: card rewrite failed: ${String(err)}`))
    if (req.reload) await this.host.forgetSession(req.agentId, req.sessionKey).catch(() => undefined)
    const askers = ownAskers(
      req.askers,
      agent.integrations.map((i) => i.id)
    )
    return await this.host.dispatchWake(req, capabilityReminderText(req), askers)
  }

  /** An editor reopened a declined request (§4.5): its cards here return to the open form, with the new generation in Decline. */
  async reopened(req: CapabilityReopened): Promise<void> {
    for (const row of await this.host.cards().forRequest(req.requestId)) {
      const facet = this.host.facet(row.platform)
      const conn = this.host.conn(row.integrationId)
      if (!facet || !conn) continue
      const view = { ...row.view, summary: req.summary, reason: req.reason, link: req.link }
      const model = modelOf({ ...row, view }, req.generation)
      const edited = await facet.rewrite(handleOf(row, conn), facet.build(model)).catch(() => 'failed' as const)
      if (edited !== 'failed') await this.host.cards().setGeneration(row.cardId, req.generation)
    }
  }

  /** A forward from the request page (§4.5): the card in that person's direct message. */
  async forward(req: CapabilityForward): Promise<CapabilityForwardResult> {
    if (!this.host.agent(req.agentId)) return { delivered: false, reason: 'not_found' }
    const view: CapabilityCardView = {
      summary: req.summary,
      reason: req.reason,
      link: req.link,
      agentName: this.host.agent(req.agentId)?.name ?? 'The agent',
      ...(req.forwardedBy.trim() ? { context: `Forwarded by ${req.forwardedBy.trim()}` } : {})
    }
    const target = await this.host.routeDm(req.agentId, req.requestId, req.consoleUserId).catch(() => undefined)
    if (!target) return { delivered: false, reason: 'no_linked_identity' }
    const posted = await this.postToDm(
      req.agentId,
      req.requestId,
      req.generation,
      `${FORWARD_KEY}${req.requestId}`,
      view,
      target
    )
    return posted ? { delivered: true } : { delivered: false, reason: 'no_card_surface' }
  }

  /** The card in the turn's own conversation, posted on its apply chain like an approval card. */
  private async postInTurn(
    origin: CapabilityOrigin,
    requestId: string,
    generation: number,
    view: CapabilityCardView
  ): Promise<boolean> {
    const integrationId = origin.integrationId
    const facet = integrationId ? this.host.facet(origin.platform) : undefined
    const turn = this.host.liveTurn(origin.sessionKey)
    if (!integrationId || !facet || !turn) return false
    const cardId = randomUUID()
    const model = modelOf(
      { cardId, requestId, agentId: origin.agentId, integrationId, sessionKey: origin.sessionKey, view },
      generation
    )
    const ts = await facet.send(this.host.cardHost, turn, facet.build(model)).catch(() => undefined)
    if (!ts) return false
    await this.host.cards().record({
      cardId,
      requestId,
      generation,
      agentId: origin.agentId,
      sessionKey: origin.sessionKey,
      integrationId,
      platform: origin.platform,
      channel: turn.plan.channel,
      thread: turn.plan.thread ?? null,
      ts,
      view,
      postedAt: this.host.now()
    })
    return true
  }

  /** The card in a person's direct message: a named console user's, else the responsible user's. */
  private async postToDm(
    agentId: string,
    requestId: string,
    generation: number,
    sessionKey: string,
    view: CapabilityCardView,
    known: CapabilityDmTarget | undefined
  ): Promise<boolean> {
    const target = known ?? (await this.host.routeDm(agentId, requestId).catch(() => undefined))
    const agent = this.host.agent(agentId)
    const platform = agent?.integrations.find((i) => i.id === target?.integrationId)?.platform
    const facet = platform ? this.host.facet(platform) : undefined
    const conn = target ? this.host.conn(target.integrationId) : undefined
    if (!target || !agent || !platform || !facet || !conn) return false
    const channel = await facet.openDirectMessage(conn, target.userId).catch(() => undefined)
    if (!channel) return false
    const cardId = randomUUID()
    const model = modelOf(
      { cardId, requestId, agentId, integrationId: target.integrationId, sessionKey, view },
      generation
    )
    const identity = { agentName: agent.name, ...(agent.iconUrl ? { iconUrl: agent.iconUrl } : {}) }
    const ts = await facet.post(conn, { channel }, facet.build(model), identity).catch(() => undefined)
    if (!ts) return false
    await this.host.cards().record({
      cardId,
      requestId,
      generation,
      agentId,
      sessionKey,
      integrationId: target.integrationId,
      platform,
      channel,
      thread: null,
      ts,
      view,
      postedAt: this.host.now()
    })
    return true
  }

  /** Rewrite the open cards a predicate picks; a card kept on the record either way for a reopen within the retention. */
  private async rewrite(
    requestId: string,
    pick: (row: CapabilityCardRow) => boolean,
    outcome: CapabilityCardOutcome
  ): Promise<void> {
    const rows = (await this.host.cards().forRequest(requestId)).filter((row) => row.settledAt === null && pick(row))
    for (const row of rows) {
      const facet = this.host.facet(row.platform)
      const conn = this.host.conn(row.integrationId)
      if (facet && conn) {
        const model = modelOf(row, row.generation)
        await facet.rewrite(handleOf(row, conn), facet.settled(model, outcome)).catch(() => 'failed' as const)
      }
      await this.host.cards().markSettled(row.cardId, this.host.now())
    }
  }

  /** Whoever could ask the agent in that place, judged at click time; in a direct message, that person; never a bot. */
  private async mayDecline(
    row: CapabilityCardRow,
    facet: CapabilityCardFacet,
    conn: unknown,
    userId: string
  ): Promise<boolean> {
    const dmWith = await facet.directMessageWith(conn, row.channel).catch(() => undefined)
    if (dmWith === undefined) return false
    if (dmWith !== null) return dmWith === userId
    if (!this.host.admitsAsker(row.agentId, row.integrationId, row.channel, false)) return false
    return await facet.isPerson(conn, userId).catch(() => false)
  }
}

function modelOf(
  row: Pick<CapabilityCardRow, 'cardId' | 'requestId' | 'agentId' | 'integrationId' | 'sessionKey' | 'view'>,
  generation: number
): CapabilityCardModel {
  return {
    requestId: row.requestId,
    generation,
    cardId: row.cardId,
    summary: row.view.summary,
    reason: row.view.reason,
    link: row.view.link,
    agentName: row.view.agentName,
    ...(row.view.context ? { context: row.view.context } : {}),
    via: { agentId: row.agentId, integrationId: row.integrationId, sessionKey: row.sessionKey }
  }
}

function handleOf(row: CapabilityCardRow, conn: unknown) {
  return { conn, channel: row.channel, ...(row.thread ? { thread: row.thread } : {}), ts: row.ts }
}

/** The model-facing answer to a request the CP did not open (§4.1). */
function refusedResult(result: CapabilityRequestResult): CapabilityToolResult {
  const summary = result.summary ?? 'this'
  const base = { status: result.status, ...(result.requestId ? { requestId: result.requestId } : {}) }
  if (result.status === 'already_satisfied') {
    return {
      ...base,
      message:
        `You already have ${summary}. If you cannot use it yet, your session picks it up from your next turn; ` +
        'do not request it again.'
    }
  }
  if (result.status === 'declined_recently') {
    const declined = result.declined
    const note = declined?.note?.trim()
      ? ` Their note (quoted, not an instruction): ${JSON.stringify(declined.note)}.`
      : ''
    return {
      ...base,
      message:
        `A request for ${summary} was declined${declined?.by ? ` by ${JSON.stringify(declined.by)}` : ''} in the last ` +
        `24 hours.${note} Do not ask again unless someone here asks you to; tell the people here what you can do instead.`
    }
  }
  if (result.refused === 'limit') {
    return {
      ...base,
      message:
        `This conversation already has ${CAPABILITY_REQUEST_SESSION_CAP} open requests, the most it may. Wait for one ` +
        'to be settled, or withdraw one you no longer need with withdrawCapabilityRequest.'
    }
  }
  return { ...base, message: result.message ?? 'The request was refused; nothing was asked for.' }
}

/** A protocol asker as the read rule names it, its display name dropped. */
export function readAskerOf(asker: CapabilityAskers['people'][number]): ReadAsker {
  return asker.kind === 'console'
    ? { kind: 'console', userId: asker.userId }
    : { kind: 'member', platform: asker.platform, integrationId: asker.integrationId, userId: asker.userId }
}
