/**
 * Slack's **relay ingress plugin** (§8, stage S3) — the first implementer of
 * the #560 contract. What moved here from `relay-ingress-manager.ts`:
 *
 *  - the `assign()` fork's Slack arm: credential-shape validation + the
 *    `SlackHttpIngest` construction, with every ingest callback now wired to
 *    the platform-free {@link RelayIngressHost} instead of manager privates;
 *  - the two interaction forwarders (`forwardSessionAction` /
 *    `forwardSessionShortcut`) — platform-named parallel functions the audit
 *    flagged as "a switch expressed as duplicated call sites" — including
 *    their dedup-id minting (§8: the plugin mints the dedup id, core owns the
 *    table);
 *  - the verify/handle pair, delegating to the SAME primitives the manager's
 *    `resolveVerified` ladder uses today (`verifySlackSignature`, the ingest's
 *    `handleEvent`/`handleInteraction`), so the staged route adoption cannot
 *    diverge from the live path.
 *
 * The module's other halves sit beside this file: the ingest class in
 * `http-ingest.ts`, the shared HTTP Events API routes in `http-ingress.ts`.
 */
import { createHash } from 'node:crypto'
import type { RdMsgPlatformAction } from '@agentconnect.md/protocol'
import {
  SlackHttpIngest,
  type HttpSlackSessionAction,
  type HttpSlackSessionShortcut,
  type HttpSlackSessionStop,
  type SlackInteractiveBody,
  type SlackMessageEvent
} from './http-ingest.js'
import { registerSlackHttpIngress } from './http-ingress.js'
import { verifySlackSignature } from '../../hooks/signature.js'
import { sessionKeyOf } from '../../bot-arbitration.js'
import type { BotAssignment } from '../../bot-arbitration.js'
import type { DemuxHints, HandledDelivery, RelayIngressHost, RelayPlatformIngressPlugin } from '../contract.js'

/** Stable daemon-side dedup id for one Slack interaction. The hash deliberately omits
 *  open-config's one-shot triggerId (interactionId already identifies that click), so
 *  sensitive trigger material never leaks into logs or dedup keys. */
export function httpSlackActionMsgId(botId: string, action: HttpSlackSessionAction): string {
  const { target, interactionId, kind } = action
  let value: string | boolean | undefined
  switch (action.kind) {
    case 'set-model':
      value = action.model
      break
    case 'set-effort':
      value = action.effort
      break
    case 'set-permission-mode':
      value = action.permissionMode
      break
    case 'set-fast':
      value = action.fastMode
      break
    case 'set-output':
      value = action.outputMode
      break
    case 'permission-choice':
      value = `${action.requestId}:${action.optionId}`
      break
    case 'elicitation-choice':
      value = `${action.requestId}:${action.value ?? ''}`
      break
    case 'open-config':
    case 'cancel':
      break
  }
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        v: 1,
        botId,
        target: [target.v, target.agentId, target.integrationId, target.sessionKey],
        interactionId,
        kind,
        value
      })
    )
    .digest('hex')
  return `slack-action:${digest}`
}

export function httpSlackShortcutMsgId(botId: string, shortcut: HttpSlackSessionShortcut): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        v: 1,
        botId,
        channelId: shortcut.channelId,
        threadTs: shortcut.threadTs,
        interactionId: shortcut.interactionId
      })
    )
    .digest('hex')
  return `slack-action:${digest}`
}

/** Stable daemon-side dedup id for one native agent-session Stop. `kind` keeps it distinct
 *  from a shortcut that happened to reuse the same conversation + receipt. */
export function httpSlackStopMsgId(botId: string, stop: HttpSlackSessionStop): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        v: 1,
        botId,
        kind: 'agent-session-stopped',
        channelId: stop.channelId,
        threadTs: stop.threadTs,
        interactionId: stop.interactionId
      })
    )
    .digest('hex')
  return `slack-action:${digest}`
}

/** Forward an HTTP Slack status-modal action to the exact agent that rendered
 *  the button. This intentionally does not use channel ownership: the operator
 *  may click an older Bob session after switching the channel default to Alice.
 *  Exact-pair validation and delivery both live in the host. */
export function forwardSessionAction(host: RelayIngressHost, botId: string, action: HttpSlackSessionAction): void {
  const { target, interactionId: _interactionId, userId, ...payload } = action
  const route = host.directory.targetForAgent(botId, target.agentId, target.integrationId)
  if (!route) {
    host.log.warn(`relay-ingress(${botId}): ignored stale session action for agent ${target.agentId}`)
    return
  }
  const rd: RdMsgPlatformAction = {
    source: 'platform_action',
    platformId: 'slack',
    agentId: route.agentId,
    integrationId: route.integrationId,
    sessionKey: target.sessionKey,
    msgId: httpSlackActionMsgId(botId, action),
    botId,
    ...(userId ? { userId } : {}),
    payload
  }
  void host
    .forwardAction(rd, route)
    .then((ack) => {
      if (!ack.accepted)
        host.log.warn(`relay-ingress(${botId}): daemon rejected session action (${ack.reason ?? 'unknown'})`)
    })
    .catch((err) => host.log.warn(`relay-ingress(${botId}): session action forward failed: ${(err as Error).message}`))
}

/** Resolve a message shortcut from live conversation ownership (the core-owned
 *  affinity → owner → default ladder behind `directory.resolveTarget`), then
 *  let the daemon resolve the exact bot-scoped session before it opens the
 *  modal. False ⇒ the caller opens a local unavailable modal while the one-shot
 *  trigger id is still valid. */
export function forwardSessionShortcut(
  host: RelayIngressHost,
  botId: string,
  shortcut: HttpSlackSessionShortcut
): boolean {
  const route = host.directory.resolveTarget(botId, { channelId: shortcut.channelId, threadTs: shortcut.threadTs })
  // A shortcut's trigger id is one-shot: returning true here CONSUMES it, so
  // delivery must be possible NOW — an offline daemon falls back to the local
  // unavailable modal exactly as an unroutable conversation does.
  if (!route || !host.canDeliver(route)) return false
  const rd: RdMsgPlatformAction = {
    source: 'platform_action',
    platformId: 'slack',
    agentId: route.agentId,
    integrationId: route.integrationId,
    sessionKey: sessionKeyOf({ channel: shortcut.channelId, thread: shortcut.threadTs }),
    msgId: httpSlackShortcutMsgId(botId, shortcut),
    botId,
    ...(shortcut.userId ? { userId: shortcut.userId } : {}),
    payload: {
      kind: 'open-config-for-thread',
      triggerId: shortcut.triggerId,
      channelId: shortcut.channelId,
      threadTs: shortcut.threadTs
    }
  }
  void host
    .forwardAction(rd, route)
    .then((ack) => {
      if (!ack.accepted)
        host.log.warn(`relay-ingress(${botId}): daemon rejected session shortcut (${ack.reason ?? 'unknown'})`)
    })
    .catch((err) =>
      host.log.warn(`relay-ingress(${botId}): session shortcut forward failed: ${(err as Error).message}`)
    )
  return true
}

/** Forward the native Stop over the same seam a message shortcut takes: the event names no
 *  session, so the conversation-ownership ladder picks the daemon and the daemon resolves the
 *  session itself — exactly what Socket Mode does with the same event. Nothing is returned to
 *  Slack, so an unroutable or offline target is bounded loss like any other forwarded event. */
export function forwardSessionStop(host: RelayIngressHost, botId: string, stop: HttpSlackSessionStop): void {
  const route = host.directory.resolveTarget(botId, { channelId: stop.channelId, threadTs: stop.threadTs })
  if (!route) {
    host.log.warn(`relay-ingress(${botId}): no owner for the agent-session stop in ${stop.channelId}`)
    return
  }
  const rd: RdMsgPlatformAction = {
    source: 'platform_action',
    platformId: 'slack',
    agentId: route.agentId,
    integrationId: route.integrationId,
    sessionKey: sessionKeyOf({ channel: stop.channelId, thread: stop.threadTs }),
    msgId: httpSlackStopMsgId(botId, stop),
    botId,
    ...(stop.userId ? { userId: stop.userId } : {}),
    payload: { kind: 'agent-session-stopped', channelId: stop.channelId, threadTs: stop.threadTs }
  }
  void host
    .forwardAction(rd, route)
    .then((ack) => {
      if (!ack.accepted)
        host.log.warn(`relay-ingress(${botId}): daemon rejected the agent-session stop (${ack.reason ?? 'unknown'})`)
    })
    .catch((err) =>
      host.log.warn(`relay-ingress(${botId}): agent-session stop forward failed: ${(err as Error).message}`)
    )
}

/** The plugin's typed verified product: one authenticated Slack delivery, as
 *  the two HTTP routes parse it. Opaque to core (§8). */
export type SlackVerifiedDelivery =
  | { kind: 'event'; event?: SlackMessageEvent; eventAtMs?: number; dedupKey?: string; eventId?: string }
  | { kind: 'interaction'; body: SlackInteractiveBody }

function headerString(v: string | string[] | undefined): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

export const slackIngressPlugin: RelayPlatformIngressPlugin<SlackHttpIngest, SlackVerifiedDelivery> = {
  platformId: 'slack',

  // `POST /slack/events` + `POST /slack/interactions`, declared by the module
  // that owns them — the bootstrap no longer imports this by name (audit F5).
  installRoutes: registerSlackHttpIngress,

  buildIngest(a: BotAssignment, host: RelayIngressHost): SlackHttpIngest | undefined {
    if (!('botToken' in a.secrets)) {
      host.log.warn(`relay-ingress(${a.botId}): incomplete Slack HTTP assignment`)
      return undefined
    }
    const botId = a.botId
    return new SlackHttpIngest(
      botId,
      { botToken: a.secrets.botToken, signingSecret: a.secrets.signingSecret },
      {
        onMessage: (msg) => host.forward(botId, msg),
        onBotUserId: (uid) => host.reportBotUserId(botId, uid),
        onChannelsChanged: (channels) => host.reportChannels({ botId, channels }),
        agents: () => host.directory.agents(botId),
        currentOwner: (channelId) => host.directory.channelOwner(botId, channelId),
        onSetChannelAgent: (channelId, agentId) => host.setChannelAgent(botId, channelId, agentId),
        onSelectThreadAgent: (channelId, threadTs, agentId) =>
          host.selectThreadAgent(botId, channelId, threadTs, agentId),
        onSessionAction: (action) => forwardSessionAction(host, botId, action),
        onSessionShortcut: (shortcut) => forwardSessionShortcut(host, botId, shortcut),
        onSessionStopped: (stop) => forwardSessionStop(host, botId, stop),
        onBotRevoked: (reason, eventAtMs) => {
          host.log.warn(`relay-ingress(${botId}): workspace revoked the app (${reason})`)
          // Fence with the generation THIS ingest was built from — assignments
          // start fire-and-forget, and an older ingest's auth.test finishing
          // after a re-assign must not revoke the replacement credential.
          host.reportRevoked(botId, reason, eventAtMs, a.credentialRevision)
        },
        log: host.log
      }
    )
  },

  extractDemuxHints(_rawBody: Buffer, body: unknown, _headers): DemuxHints {
    // Events carry the ids at the envelope top level; interactions nest the
    // team id under `team.id`. Both are pre-verify HINTS only.
    const b = body as { api_app_id?: string; team_id?: string; team?: { id?: string } } | undefined
    return {
      ...(b?.api_app_id ? { appId: b.api_app_id } : {}),
      ...((b?.team_id ?? b?.team?.id) ? { tenantId: b?.team_id ?? b?.team?.id } : {})
    }
  },

  verify(ingest, rawBody, body, headers, now): SlackVerifiedDelivery | undefined {
    const signature = headerString(headers['x-slack-signature'])
    const timestamp = headerString(headers['x-slack-request-timestamp'])
    if (!verifySlackSignature(ingest.signingSecret, timestamp, rawBody, signature, now)) return undefined
    const b = body as
      { type?: string; event?: SlackMessageEvent; event_time?: number } | SlackInteractiveBody | undefined
    // POSITIVE discrimination: an Events API envelope is exactly
    // `type === 'event_callback'` (url_verification never reaches verify — the
    // route answers it pre-candidate). Everything else on this seam is an
    // interaction payload, pre-extracted from the urlencoded `payload=` field
    // by the route.
    if (b && typeof b === 'object' && (b as { type?: string }).type !== 'event_callback')
      return { kind: 'interaction', body: b as SlackInteractiveBody }
    const env = b as
      | { event?: SlackMessageEvent; event_time?: number; event_id?: string; api_app_id?: string; team_id?: string }
      | undefined
    // The dedup identity is the (api_app_id, team_id, event_id) composite: a
    // retry for one app/install reuses it, while one Slack message delivered to
    // several explicitly mentioned apps must reach each of their agents.
    const dedupKey = env?.event_id ? `${env.api_app_id ?? ''}\0${env.team_id ?? ''}\0${env.event_id}` : undefined
    return {
      kind: 'event',
      ...(env?.event ? { event: env.event } : {}),
      ...(env?.event_time ? { eventAtMs: env.event_time * 1000 } : {}),
      ...(dedupKey ? { dedupKey } : {}),
      // The per-delivery receipt a redelivery reuses — the daemon-side dedup id of a
      // forwarded non-chat event is minted from it.
      ...(env?.event_id ? { eventId: env.event_id } : {})
    }
  },

  async handle(ingest, verified, host): Promise<HandledDelivery> {
    // Plugin-minted identity, core-owned table (§8).
    if (verified.kind === 'event' && host.dedupSeen(verified.dedupKey)) return {}
    if (verified.kind === 'interaction') {
      // block_suggestion needs its options ON the 200 body; every other branch
      // resolves to '' — the same contract the interactions route holds today.
      const result = await ingest.handleInteraction(verified.body)
      return { syncResponse: result ?? '' }
    }
    // Events are ACK'd by the route within Slack's 3s window; handling is async
    // and a forward miss is bounded loss. Failures log exactly as the live
    // route logs them today.
    void ingest
      .handleEvent(verified.event, verified.eventAtMs, verified.eventId)
      .catch((err) => host.log.warn(`slack ingress: event handler error: ${(err as Error).message}`))
    return {}
  }
}
