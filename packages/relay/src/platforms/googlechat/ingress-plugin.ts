// Google Chat's relay ingress plugin (google-chat-integration.md §2, §4): a pure HTTP decoder — no `start`, a no-op
// `stop`, no `egress` facet and no secret on the relay; Google signs each callback and the daemon owns every write.
import { randomUUID } from 'node:crypto'
import {
  googleChatTenantKey,
  normalizeGoogleChatEvent,
  type GoogleChatEvent,
  type GoogleChatEventResult
} from '@agentconnect.md/message'
import { GOOGLE_CHAT_PLATFORM } from '@agentconnect.md/protocol'
import {
  GOOGLE_CHAT_CLAIM_FUNCTION,
  GOOGLE_CHAT_WELCOME_CARD,
  GoogleChatHttpIngest,
  UNKNOWN_APP_USER_NAME,
  UnclaimedTenantMemo,
  googleChatClaimPrompt,
  googleChatDedupId,
  googleChatDedupKey,
  provenAppUserName,
  type VerifiedGoogleChatDelivery
} from './http-ingest.js'
import { registerGoogleChatHttpIngress } from './http-ingress.js'
import { GoogleChatCertificateStore, bearerToken, unverifiedAudience } from './token.js'
import type { BotAssignment } from '../../bot-arbitration.js'
import type { DemuxHints, HandledDelivery, RelayIngressHost, RelayPlatformIngressPlugin } from '../contract.js'

export interface GoogleChatIngressPluginDeps {
  /** The HTTP layer that fetches Google's certificate map; tests pass a fake. Defaults to the global fetch. */
  fetch?: typeof fetch
}

export type GoogleChatIngressPlugin = RelayPlatformIngressPlugin<GoogleChatHttpIngest, VerifiedGoogleChatDelivery> & {
  /** The platform-wide certificate cache, exposed for inspection. */
  readonly certificates: GoogleChatCertificateStore
}

type ClassifiedResult = Exclude<GoogleChatEventResult, { kind: 'invalid' }>

// The unclaimed tenant's answer (§10.4): the welcome card on an add, the claim prompt on a message or the card's own
// click, nothing (`undefined`) for the rest. A tenant-less event (a personal account) gets nothing either.
function unclaimedAnswer(
  ingest: GoogleChatHttpIngest,
  claimUrl: string,
  event: GoogleChatEvent,
  result: ClassifiedResult,
  nowMs: number
): { body: unknown; tenant: string } | undefined {
  if (result.kind === 'ignored' || result.kind === 'unsupported' || result.tenant === undefined) return undefined
  const tenant = result.tenant
  if (event.type === 'ADDED_TO_SPACE') return { body: GOOGLE_CHAT_WELCOME_CARD, tenant }
  if (result.kind === 'membership') return undefined
  if (result.kind === 'interaction' && result.interaction.function !== GOOGLE_CHAT_CLAIM_FUNCTION) return undefined
  const [space, user, isDm] =
    result.kind === 'interaction'
      ? [result.interaction.space, result.interaction.user, result.interaction.isDm]
      : [result.message.channel, result.message.sender.id, result.message.isDm]
  const body = googleChatClaimPrompt(claimUrl, {
    v: 1,
    app: ingest.audience,
    space,
    user,
    kind: isDm ? 'dm' : 'space',
    tenant,
    ...(result.configCompleteRedirectUrl ? { redirect: result.configCompleteRedirectUrl } : {}),
    iat: Math.floor(nowMs / 1000)
  })
  return { body, tenant }
}

export function createGoogleChatIngressPlugin(deps: GoogleChatIngressPluginDeps = {}): GoogleChatIngressPlugin {
  const certificates = new GoogleChatCertificateStore((input, init) => (deps.fetch ?? fetch)(input, init))
  const unclaimed = new UnclaimedTenantMemo()
  return {
    platformId: GOOGLE_CHAT_PLATFORM,
    certificates,

    // `POST /googlechat/events`, the path the Setup Server publishes; pinned by route-mounts.test.ts.
    installRoutes: registerGoogleChatHttpIngress,

    buildIngest(a: BotAssignment, host: RelayIngressHost): GoogleChatHttpIngest | undefined {
      // The relay holds no Google secret; the project number IS the credential check (the token audience). A row
      // that is both a customer (`tenantIds`) and the anchor (`claimUrl`) would prompt the tenants it serves forever.
      if (!a.apiAppId || Object.keys(a.secrets).length !== 0 || (a.tenantIds && a.claimUrl)) {
        host.log.warn(`relay-ingress(${a.botId}): incomplete Google Chat assignment`)
        return undefined
      }
      certificates.log ??= host.log
      return new GoogleChatHttpIngest(
        a.botId,
        a.apiAppId,
        a.botUserId,
        certificates,
        a.credentialRevision,
        a.tenantIds,
        a.claimUrl
      )
    },

    extractDemuxHints(_rawBody: Buffer, body: unknown, headers): DemuxHints {
      // The unverified `aud` picks the candidate app and the unverified tenant key its row (§10.4); `verify` decides.
      const appId = unverifiedAudience(headers.authorization)
      const tenantId = googleChatTenantKey(body)
      return { ...(appId ? { appId } : {}), ...(tenantId ? { tenantId } : {}) }
    },

    async verify(ingest, _rawBody, body, headers, now): Promise<VerifiedGoogleChatDelivery | undefined> {
      const token = bearerToken(headers.authorization)
      if (!token || typeof body !== 'object' || body === null || Array.isArray(body)) return undefined
      const claims = await ingest.certificates.verify(token, ingest.audience, now)
      return claims ? { event: body as GoogleChatEvent, traceId: randomUUID() } : undefined
    },

    async handle(ingest, verified, host): Promise<HandledDelivery> {
      const botId = ingest.botId
      const { event } = verified
      // Identity order: the assignment's, then the one learned earlier, then what this event itself proves.
      if (ingest.appUserName === undefined) {
        const proven = provenAppUserName(event)
        if (proven && ingest.learn(proven)) host.reportBotUserId(botId, proven)
      }
      const appUserName = ingest.appUserName
      const result = normalizeGoogleChatEvent(event, {
        appUserName: appUserName ?? UNKNOWN_APP_USER_NAME,
        traceId: verified.traceId
      })
      if (result.kind === 'invalid') {
        // Authenticated but permanently malformed: a 200 stops Google from redelivering it forever.
        host.log.warn(`relay-ingress(${botId}): dropped a malformed Google Chat event (${result.reason})`)
        return {}
      }
      // A multi-tenant app's anchor serves no tenant: an event core routed to it has no customer row (§10.4), so it
      // is answered in the body and never forwarded, reported, or marked.
      if (ingest.claimUrl !== undefined) {
        const now = host.clock.now()
        const answer = unclaimedAnswer(ingest, ingest.claimUrl, event, result, now)
        if (!answer) return {}
        if (unclaimed.first(`${ingest.audience}\0${answer.tenant}`, now))
          host.log.info(`relay-ingress(${botId}): answering an unclaimed Google Chat tenant with the claim prompt`)
        return { syncResponse: answer.body }
      }
      if (result.kind === 'ignored' || result.kind === 'unsupported') {
        host.dedupMark(googleChatDedupKey(botId, googleChatDedupId(event)))
        return {}
      }
      // The only card is the welcome card, and a click on it in a claimed conversation has nothing left to do.
      if (result.kind === 'interaction') return {}
      // Both remaining kinds may carry a membership change; a message-bearing add reports it before forwarding.
      if (result.membership) {
        host.reportChannels({
          botId,
          channels: ingest.observeMembership(result.membership, event.space?.displayName)
        })
      }
      if (result.kind === 'membership') return {}
      // Google delivers a Space message only to the apps it mentions or adds, and a DM is addressed by nature: the
      // trusted cause rides the payload, so the relay treats the delivery as an address before the identity is known.
      const message = { ...result.message, trigger: result.message.isDm ? ('dm' as const) : ('mention' as const) }
      if (appUserName === undefined && ingest.firstUnknownIdentity())
        host.log.warn(`relay-ingress(${botId}): the Chat app's identity is not known yet — forwarding text unstripped`)
      // A repeat of a settled attempt answers 200 without forwarding; an unsettled one is forwarded again. The key is
      // scoped by bot: the manager's table is shared, and a Space message mentioning two apps is delivered once per app.
      const dedupKey = googleChatDedupKey(botId, message.msgId)
      if (host.dedupPeek(dedupKey)) return {}
      const admission = await host.forwardStrict(botId, message)
      if (admission.disposition !== 'retry') host.dedupMark(dedupKey)
      return { admission }
    }
  }
}

export const googleChatIngressPlugin: GoogleChatIngressPlugin = createGoogleChatIngressPlugin()
