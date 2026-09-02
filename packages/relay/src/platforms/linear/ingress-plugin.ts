// Linear's relay ingress plugin (linear-integration.md §6.1): a pure HTTP decoder — no `start`,
// a no-op `stop`, and no `egress` facet, because every Linear write belongs to the daemon (§4.6).
import type { RdMsgPlatformAction } from '@agentconnect.md/protocol'
import {
  LinearHttpIngest,
  linearChannelOf,
  linearDedupId,
  linearIsStop,
  normalizeLinearEvent,
  type LinearAgentSessionEvent,
  type VerifiedLinearDelivery
} from './http-ingest.js'
import { registerLinearHttpIngress } from './http-ingress.js'
import { sessionKeyOf } from '../../bot-arbitration.js'
import type { BotAssignment } from '../../bot-arbitration.js'
import type { DemuxHints, HandledDelivery, RelayIngressHost, RelayPlatformIngressPlugin } from '../contract.js'

/** The stop payload the daemon's linear module decodes into `interruptTurn` (§6.3). */
export interface LinearStopAction {
  kind: 'stop'
  agentSessionId: string
}

// A stop is an interaction, not a message, and a Linear session is bound to one agent at
// creation (§4.5) — so it takes the BOUND-target lookup, never ordinary arbitration: reaching
// the channel's current default instead would settle a session another runtime still holds.
export async function forwardLinearStop(
  host: RelayIngressHost,
  ingest: LinearHttpIngest,
  event: LinearAgentSessionEvent,
  msgId: string
): Promise<void> {
  const botId = ingest.botId
  const session = event.agentSession
  const channelId = linearChannelOf(event, ingest.identity)
  const sessionKey = sessionKeyOf({ channel: channelId, thread: session.id })
  const route = await host.directory.resolveBoundTarget(botId, sessionKey)
  if (!route) {
    host.log.warn(`relay-ingress(${botId}): Linear stop for session ${session.id} reaches no bound agent — dropped`)
    return
  }
  const payload: LinearStopAction = { kind: 'stop', agentSessionId: session.id }
  const rd: RdMsgPlatformAction = {
    source: 'platform_action',
    platformId: 'linear',
    agentId: route.agentId,
    integrationId: route.integrationId,
    sessionKey,
    msgId,
    botId,
    ...(event.agentActivity?.user?.id ? { userId: event.agentActivity.user.id } : {}),
    payload
  }
  await host
    .forwardAction(rd, route)
    .then((ack) => {
      if (!ack.accepted) host.log.warn(`relay-ingress(${botId}): daemon rejected Linear stop (${ack.reason ?? '?'})`)
    })
    .catch((err) => host.log.warn(`relay-ingress(${botId}): Linear stop forward failed: ${(err as Error).message}`))
}

export const linearIngressPlugin: RelayPlatformIngressPlugin<LinearHttpIngest, VerifiedLinearDelivery> = {
  platformId: 'linear',

  // `POST /linear/events`, declared by the module that owns it and pinned by route-mounts.test.ts.
  installRoutes: registerLinearHttpIngress,

  buildIngest(a: BotAssignment, host: RelayIngressHost): LinearHttpIngest | undefined {
    // §6.2's opaque bags, read through the assignment's platform-free identity slots: Linear's
    // `clientId` is the provider app id, `organizationId` the tenant, `appUserId` the bot identity.
    const secrets = a.secrets as { signingSecret?: unknown }
    const signingSecret = typeof secrets.signingSecret === 'string' ? secrets.signingSecret : ''
    const clientId = a.apiAppId
    const organizationId = a.teamId ?? a.workspaceId
    if (!signingSecret || !clientId || !organizationId) {
      host.log.warn(`relay-ingress(${a.botId}): incomplete Linear assignment`)
      return undefined
    }
    return new LinearHttpIngest(
      a.botId,
      { clientId, organizationId, ...(a.botUserId ? { appUserId: a.botUserId } : {}) },
      signingSecret,
      () => host.clock.now(),
      a.credentialRevision
    )
  },

  extractDemuxHints(_rawBody: Buffer, body: unknown, _headers): DemuxHints {
    // Pre-verify HINTS only. Every Linear assignment is tenant-scoped, so the composite
    // `(oauthClientId, organizationId)` is the only demux that cannot leak across workspaces.
    const b = body as { oauthClientId?: string; organizationId?: string } | undefined
    return {
      ...(b?.oauthClientId ? { appId: b.oauthClientId } : {}),
      ...(b?.organizationId ? { tenantId: b.organizationId } : {})
    }
  },

  verify(ingest, rawBody, body, headers, now): VerifiedLinearDelivery | undefined {
    return ingest.decode(rawBody, body, headers, now)
  },

  async handle(ingest, verified, host): Promise<HandledDelivery> {
    const botId = ingest.botId
    if (verified.kind === 'ignored') return {}
    if (verified.kind === 'revoked') {
      host.log.warn(`relay-ingress(${botId}): workspace revoked the Linear app`)
      // The revision is the OBSERVING assignment's, captured at buildIngest — a fire-and-forget
      // older ingest must never revoke a credential a re-connect has since replaced.
      host.reportRevoked(botId, 'tokens_revoked', verified.eventAtMs, ingest.credentialRevision)
      return {}
    }
    const event = verified.event
    const msgId = linearDedupId(event)
    // An action this build does not handle (or a `prompted` with no activity) is bounded loss, not
    // an unkeyed forward: without a content-derived identity a redelivery could never converge.
    if (!msgId) return {}
    // The bucket is taken BEFORE the dedup mark so a throttled delivery stays unseen and Linear's
    // retry can still land; a redelivery of an already-forwarded event costs one token and stops.
    if (!ingest.allow()) {
      host.log.warn(`relay-ingress(${botId}): Linear ingress rate limit exhausted — dropped ${msgId}`)
      return {}
    }
    if (host.dedupSeen(msgId)) return {}
    if (linearIsStop(event)) {
      void forwardLinearStop(host, ingest, event, msgId)
      return {}
    }
    const message = normalizeLinearEvent(event, msgId, ingest.identity)
    void host
      .forward(botId, message)
      .then((outcome) => {
        // §6.2's terminal refusal: the team's default moved off the gated agent bound to this
        // session, so the delivery is dropped — Linear still gets its 200, and nothing answers.
        if (outcome === 'refused') {
          host.log.debug(`relay-ingress(${botId}): dropped Linear ${msgId} — the session's grant was withdrawn`)
        }
      })
      .catch((err) => host.log.warn(`linear ingress: event handler error: ${(err as Error).message}`))
    return {}
  }
}
