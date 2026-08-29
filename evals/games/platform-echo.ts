/**
 * Production Slack echo for mention-driven games
 * (send-message-routing-rework.md §2.3/§5/§6, landed in PR #503).
 *
 * Every DELIVERED agent post fans back to every other member integration as
 * real platform ingress under the author's managed bot identity: each post
 * under its own message id carrying the daemon-stamped §4 claim (`final` on a
 * terminal section closed at post time, `streaming` otherwise — verification
 * only admits `final`), plus the response-closing `message_changed` edit under
 * the SAME msgId when one was needed, told apart by `ingressEventTag`. Whether
 * an echo activates anyone is the DAEMON's decision — mention verification,
 * hop transition, policy — never this helper's.
 */
import { SLACK_RESPONSE_FINAL_EVENT_TAG } from '../../packages/message/src/index.js'
import type {
  DeliveryHandle,
  EvaluationPlatformEvent,
  RecordedOutboundEffect
} from '../../packages/daemon/src/evaluation/index.js'
import type { ArenaWorld } from './world.js'
import type { CompiledRoom } from './types.js'

/** One echoed inbound delivery's admission outcome, reported to the game.
 *
 *  This is the only place a game can observe what the daemon's protections did
 *  with a peer wake-up: an `admitted` finalize echo is one AUTOMATIC turn the
 *  loop guard counted against that agent's per-conversation budget; a `gated`
 *  one is that budget refusing the wake. */
export interface PlatformEchoOutcome {
  integrationId: string
  /** Present on a `message_changed` closing edit; absent on an ordinary post. */
  ingressEventTag?: string
  /** The claim's delivery state — `final` marks the ONE routable event of a response,
   *  whether it arrived as a born-final post (§5.5) or as the closing edit. */
  deliveryState: 'streaming' | 'final'
  admitted: boolean
  reason?: string
  fromAlias: string
  /** The room this echo travelled through — one loop-guard circuit per room, so
   *  a member of two rooms is charged against two independent budgets. */
  room: string
}

export interface PlatformEchoOptions {
  /** Observe every echoed delivery's admission decision. */
  onOutcome?: (outcome: PlatformEchoOutcome) => void
}

export class PlatformEcho {
  private inject?: (event: EvaluationPlatformEvent) => DeliveryHandle | Promise<DeliveryHandle>
  private readonly handles: Promise<DeliveryHandle>[] = []
  /** Thread each delivered message lives in (root posts anchor themselves). */
  private readonly threadByMessageId = new Map<string, string>()
  private readonly onOutcome: PlatformEchoOptions['onOutcome']

  constructor(
    private readonly world: ArenaWorld,
    private readonly room: CompiledRoom,
    options: PlatformEchoOptions = {}
  ) {
    this.onOutcome = options.onOutcome
  }

  attach(inject: (event: EvaluationPlatformEvent) => DeliveryHandle | Promise<DeliveryHandle>): void {
    this.inject = inject
    this.world.onDelivered((effect) => this.echo(effect))
  }

  drainHandles(): Promise<DeliveryHandle>[] {
    const drained = [...this.handles]
    this.handles.length = 0
    return drained
  }

  private echo(effect: RecordedOutboundEffect): void {
    if (effect.status !== 'delivered') return
    if (effect.channel !== this.room.channel || effect.agentId === undefined) return
    if (effect.kind !== 'reply' && effect.kind !== 'finalize') return
    const botUserId = this.world.botUserIdFor(effect.integrationId)
    if (botUserId === undefined || effect.messageId === undefined) return
    const appId = this.world.botAppIdFor(effect.integrationId)
    // Slack normalizes a top-level message with thread = its own ts; the
    // finalized `message_changed` edit keeps the ORIGINAL coordinates — msgId
    // included, since that id carries the platform ts — and is told apart from
    // the post it edits by `ingressEventTag`, the extra per-connection dedup
    // dimension (packages/message SLACK_RESPONSE_FINAL_EVENT_TAG).
    let thread: string
    let ingressEventTag: string | undefined
    if (effect.kind === 'reply') {
      thread = effect.thread ?? effect.messageId
      this.threadByMessageId.set(effect.messageId, thread)
    } else {
      thread = this.threadByMessageId.get(effect.messageId) ?? effect.thread ?? effect.messageId
      ingressEventTag = SLACK_RESPONSE_FINAL_EVENT_TAG
    }
    const echoMessageId = effect.messageId
    const fromAlias = this.world.aliasOfAgent(effect.agentId)
    const mentions = [...effect.text.matchAll(/<@([A-Z0-9]+)>/g)].map((match) => match[1]!)
    const authorAgentId = effect.identity?.agentAuthorId ?? effect.agentId
    const claim =
      effect.response !== undefined
        ? {
            authorAgentId,
            responseId: effect.response.responseId,
            deliveryState: effect.response.deliveryState,
            hopCount: effect.response.hopCount,
            mentionedAgentIds: effect.response.mentionedAgentIds,
            ...(effect.response.agentCallDeliveryId !== undefined
              ? { agentCallDeliveryId: effect.response.agentCallDeliveryId }
              : {})
          }
        : undefined
    this.world.appendEvent({
      type: 'platform.echo',
      origin: 'agent_effect',
      roomId: this.room.alias,
      fromAlias,
      messageId: echoMessageId,
      ...(ingressEventTag !== undefined ? { ingressEventTag } : {}),
      deliveryState: effect.response?.deliveryState ?? 'streaming',
      mentions,
      text: effect.text
    })
    for (const integrationId of this.room.memberIntegrationIds) {
      if (integrationId === effect.integrationId) continue
      const handle = this.inject?.({
        integrationId,
        payload: {
          channel: this.room.channel,
          thread,
          messageId: echoMessageId,
          ...(ingressEventTag !== undefined ? { ingressEventTag } : {}),
          text: effect.text,
          sender: { id: botUserId, isBot: true, ...(appId !== undefined ? { appId } : {}) },
          ...(mentions.length > 0 ? { mentions } : {}),
          ...(claim !== undefined ? { agentAuthorship: claim } : {})
        }
      })
      if (handle) {
        // Test stubs still hand back a settled handle; the real harness injects a promise.
        const pending = Promise.resolve(handle)
        this.handles.push(pending)
        void pending
          .then((settled) => settled.admission)
          .then((admission) => {
            this.world.appendEvent({
              type: 'platform.echo.outcome',
              origin: 'agent_effect',
              roomId: this.room.alias,
              messageId: echoMessageId,
              ...(ingressEventTag !== undefined ? { ingressEventTag } : {}),
              deliveryState: effect.response?.deliveryState ?? 'streaming',
              integrationId,
              ...(admission.admitted
                ? { admitted: true, agentAlias: this.world.aliasOfAgent(admission.agentId) }
                : { admitted: false, reason: admission.reason })
            })
            this.onOutcome?.({
              integrationId,
              ...(ingressEventTag !== undefined ? { ingressEventTag } : {}),
              deliveryState: effect.response?.deliveryState ?? 'streaming',
              admitted: admission.admitted,
              ...(admission.admitted ? {} : { reason: admission.reason }),
              fromAlias,
              room: this.room.alias
            })
          })
          .catch(() => {})
      }
    }
  }
}
