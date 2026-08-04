/**
 * Production Slack echo for mention-driven games
 * (send-message-routing-rework.md §2.3/§5/§6, landed in PR #503).
 *
 * Every DELIVERED agent post fans back to every other member integration as
 * real platform ingress under the author's managed bot identity: the streaming
 * post under its own message id (unroutable — verification only admits
 * `final`), and the response-closing `message_changed` edit under the SAME
 * msgId, told apart by `ingressEventTag` and carrying the daemon-stamped §4
 * claim. Whether an echo activates anyone is the DAEMON's decision — mention
 * verification, hop transition, policy — never this helper's.
 */
import { SLACK_RESPONSE_FINAL_EVENT_TAG } from '../../packages/message/src/index.js'
import type {
  DeliveryHandle,
  EvaluationPlatformEvent,
  RecordedOutboundEffect
} from '../../packages/daemon/src/evaluation/index.js'
import type { ArenaWorld } from './world.js'
import type { CompiledRoom } from './types.js'

export class PlatformEcho {
  private inject?: (event: EvaluationPlatformEvent) => DeliveryHandle
  private readonly handles: DeliveryHandle[] = []
  /** Thread each delivered message lives in (root posts anchor themselves). */
  private readonly threadByMessageId = new Map<string, string>()

  constructor(
    private readonly world: ArenaWorld,
    private readonly room: CompiledRoom
  ) {}

  attach(inject: (event: EvaluationPlatformEvent) => DeliveryHandle): void {
    this.inject = inject
    this.world.onDelivered((effect) => this.echo(effect))
  }

  drainHandles(): DeliveryHandle[] {
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
      fromAlias: this.world.aliasOfAgent(effect.agentId),
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
        this.handles.push(handle)
        void handle.admission
          .then((admission) => {
            this.world.appendEvent({
              type: 'platform.echo.outcome',
              origin: 'agent_effect',
              roomId: this.room.alias,
              messageId: echoMessageId,
              ...(ingressEventTag !== undefined ? { ingressEventTag } : {}),
              integrationId,
              ...(admission.admitted
                ? { admitted: true, agentAlias: this.world.aliasOfAgent(admission.agentId) }
                : { admitted: false, reason: admission.reason })
            })
          })
          .catch(() => {})
      }
    }
  }
}
