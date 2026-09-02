/**
 * Feishu / Lark's **relay ingress plugin** (§8, stage S3). What moved here from
 * `relay-ingress-manager.ts`:
 *
 *  - the `assign()` fork's Feishu arm: credential-shape validation + the
 *    `FeishuHttpIngest` construction, callbacks wired to the platform-free
 *    {@link RelayIngressHost};
 *  - the card-action forwarder (`forwardFeishuAction`) with its dedup-id
 *    minting — target selection reads the DIRECTORY (`integrationTarget` for a
 *    card that carries its rendered target; `soleTarget` as the
 *    rolling-compatibility fallback for cards rendered before action values
 *    embedded one), never a conversation rule: the daemon's active-card map is
 *    the terminal fence.
 *
 * verify/handle delegate to the SAME primitives the manager and route use
 * today (`ingest.decode`, `ingest.seen`, `ingest.handle`), so the staged route
 * adoption cannot diverge. The plugin owns the platform's ~2.5s card-action
 * response window (§8) — raced on the host clock, degrading to an ack-only
 * body on timeout; core keeps only the route's outer hard cap.
 *
 * Feishu deliberately has NO egress facet: relay ingress is receive-only and
 * bot egress stays on the daemon (§8, optional by design).
 */
import { createHash } from 'node:crypto'
import {
  WireFeishuCardActionValue,
  WireFeishuCardActionResponse,
  type RdMsgPlatformAction,
  type WireFeishuCardActionEvent
} from '@agentconnect.md/protocol'
import { FeishuHttpIngest, type FeishuCallbackHeaders, type VerifiedFeishuCallback } from './http-ingest.js'
import { registerFeishuHttpIngress } from './http-ingress.js'
import type { BotAssignment } from '../../bot-arbitration.js'
import type { DemuxHints, HandledDelivery, RelayIngressHost, RelayPlatformIngressPlugin } from '../contract.js'

/** The platform's synchronous response window for a card action (toast on the
 *  HTTP 200 body). Plugin-owned per §8. */
const CARD_ACTION_RESPONSE_TIMEOUT_MS = 2_500

export function httpFeishuActionMsgId(
  botId: string,
  eventId: string | undefined,
  action: WireFeishuCardActionEvent
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({ v: 1, botId, eventId, action }))
    .digest('hex')
  return `feishu-action:${digest}`
}

/** Forward one verified Lark / Feishu card callback to the integration that
 *  rendered it. The daemon resolves the provider message id against its local
 *  active-card map and returns the callback response for the HTTP edge. */
export async function forwardFeishuCardAction(
  host: RelayIngressHost,
  botId: string,
  action: WireFeishuCardActionEvent,
  eventId: string | undefined
): Promise<WireFeishuCardActionResponse | undefined> {
  const value = WireFeishuCardActionValue.safeParse(action.action?.value)
  const route =
    value.success && value.data.target
      ? host.directory.integrationTarget(botId, value.data.target.agentId, value.data.target.integrationId)
      : host.directory.soleTarget(botId)
  if (!route) {
    host.log.warn(`relay-ingress(${botId}): Feishu card action has no current integration target`)
    return undefined
  }
  const messageId = action.context?.open_message_id ?? action.open_message_id
  if (!messageId) return undefined
  const rd: RdMsgPlatformAction = {
    source: 'platform_action',
    platformId: 'feishu',
    agentId: route.agentId,
    integrationId: route.integrationId,
    sessionKey: `feishu-action:${messageId}`,
    msgId: httpFeishuActionMsgId(botId, eventId, action),
    botId,
    payload: action
  }
  try {
    const ack = await host.forwardAction(rd, route)
    if (!ack.accepted) {
      host.log.warn(`relay-ingress(${botId}): daemon rejected Feishu card action (${ack.reason ?? 'unknown'})`)
    }
    // §6.6: the generic opaque `response` is the ONE answer slot.
    const generic = WireFeishuCardActionResponse.safeParse(ack.response)
    return generic.success && ack.response !== undefined ? generic.data : undefined
  } catch (err) {
    host.log.warn(`relay-ingress(${botId}): Feishu card action forward failed: ${(err as Error).message}`)
    return undefined
  }
}

export const feishuIngressPlugin: RelayPlatformIngressPlugin<FeishuHttpIngest, VerifiedFeishuCallback> = {
  platformId: 'feishu',

  // `POST /feishu/events`, declared by the module that owns it — the bootstrap
  // no longer imports this by name (audit F5).
  installRoutes: registerFeishuHttpIngress,

  buildIngest(a: BotAssignment, host: RelayIngressHost): FeishuHttpIngest | undefined {
    if (!a.apiAppId || !('verificationToken' in a.secrets)) {
      host.log.warn(`relay-ingress(${a.botId}): incomplete Feishu HTTP assignment`)
      return undefined
    }
    const botId = a.botId
    return new FeishuHttpIngest(botId, a.apiAppId, a.secrets, {
      onMessage: async (message) => void (await host.forward(botId, message)),
      onCardAction: (action, eventId) => forwardFeishuCardAction(host, botId, action, eventId),
      now: () => host.clock.now()
    })
  },

  extractDemuxHints(_rawBody: Buffer, body: unknown, _headers): DemuxHints {
    // Unencrypted v2 callbacks carry `header.app_id`; encrypted callbacks have
    // no readable id (the scan verifies/decrypts against the bounded pool).
    const b = body as { header?: { app_id?: string }; app_id?: string } | undefined
    const appId = b?.header?.app_id ?? b?.app_id
    return appId ? { appId } : {}
  },

  verify(ingest, rawBody, body, headers): VerifiedFeishuCallback | undefined {
    // The seam hands RAW HTTP headers; extracting Lark's signature triple is
    // the plugin's job (the route used to do it before the seam existed).
    const header = (v: string | string[] | undefined): string | undefined =>
      typeof v === 'string' && v.length > 0 ? v : undefined
    const timestamp = header(headers['x-lark-request-timestamp'])
    const nonce = header(headers['x-lark-request-nonce'])
    const signature = header(headers['x-lark-signature'])
    const callbackHeaders: FeishuCallbackHeaders = {
      ...(timestamp ? { timestamp } : {}),
      ...(nonce ? { nonce } : {}),
      ...(signature ? { signature } : {})
    }
    // Token compare / AES decrypt — the typed decrypted product derives exactly
    // once and flows into handle (the #560 review's first blocking finding).
    return ingest.decode(rawBody, body, callbackHeaders) ?? undefined
  },

  async handle(ingest, verified, host): Promise<HandledDelivery> {
    // Feishu's challenge is ENCRYPTED, so unlike Slack's it flows through
    // verify → handle rather than being answered pre-candidate (§8 exception
    // note on the contract).
    if (verified.kind === 'challenge') return { syncResponse: { challenge: verified.challenge } }
    if (ingest.seen(verified.eventId)) return { syncResponse: {} }
    if (verified.eventType === 'card.action.trigger') {
      // The card toast must ride THIS request's 200 — race the daemon round
      // trip against the platform window, degrading to an ack-only body.
      // Failures log exactly as the live route logs them today.
      let timeout: ReturnType<typeof setTimeout> | undefined
      const response = await Promise.race([
        ingest.handle(verified).catch((err) => {
          host.log.warn(`feishu ingress: card action handler error: ${(err as Error).message}`)
          return undefined
        }),
        new Promise<undefined>((resolve) => {
          timeout = setTimeout(() => resolve(undefined), CARD_ACTION_RESPONSE_TIMEOUT_MS)
        })
      ])
      if (timeout) clearTimeout(timeout)
      return { syncResponse: response ?? {} }
    }
    void ingest
      .handle(verified)
      .catch((err) => host.log.warn(`feishu ingress: event handler error: ${(err as Error).message}`))
    return { syncResponse: {} }
  }
}
