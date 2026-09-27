// Google Chat's relay ingress plugin (google-chat-integration.md §2, §4): a pure HTTP decoder — no `start`, a no-op
// `stop`, no `egress` facet and no secret on the relay; Google signs each callback and the daemon owns every write.
import { randomUUID } from 'node:crypto'
import { normalizeGoogleChatEvent, type GoogleChatEvent } from '@agentconnect.md/message'
import { GOOGLE_CHAT_PLATFORM } from '@agentconnect.md/protocol'
import {
  GoogleChatHttpIngest,
  UNKNOWN_APP_USER_NAME,
  googleChatDedupId,
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

export function createGoogleChatIngressPlugin(deps: GoogleChatIngressPluginDeps = {}): GoogleChatIngressPlugin {
  const certificates = new GoogleChatCertificateStore((input, init) => (deps.fetch ?? fetch)(input, init))
  return {
    platformId: GOOGLE_CHAT_PLATFORM,
    certificates,

    // `POST /googlechat/events`, the path the Setup Server publishes; pinned by route-mounts.test.ts.
    installRoutes: registerGoogleChatHttpIngress,

    buildIngest(a: BotAssignment, host: RelayIngressHost): GoogleChatHttpIngest | undefined {
      // The relay holds no Google secret; the project number IS the credential check (the token audience).
      if (!a.apiAppId || Object.keys(a.secrets).length !== 0) {
        host.log.warn(`relay-ingress(${a.botId}): incomplete Google Chat assignment`)
        return undefined
      }
      certificates.log ??= host.log
      return new GoogleChatHttpIngest(a.botId, a.apiAppId, a.botUserId, certificates, a.credentialRevision)
    },

    extractDemuxHints(_rawBody: Buffer, _body: unknown, headers): DemuxHints {
      // The unverified `aud` picks the candidate; `verify` decides.
      const appId = unverifiedAudience(headers.authorization)
      return appId ? { appId } : {}
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
      if (result.kind === 'ignored' || result.kind === 'unsupported') {
        host.dedupMark(googleChatDedupId(event))
        return {}
      }
      // Both remaining kinds may carry a membership change; a message-bearing add reports it before forwarding.
      if (result.membership) {
        host.reportChannels({
          botId,
          channels: ingest.observeMembership(result.membership, event.space?.displayName)
        })
      }
      if (result.kind === 'membership') return {}
      const { message } = result
      if (appUserName === undefined && ingest.firstUnknownIdentity())
        host.log.warn(`relay-ingress(${botId}): the Chat app's identity is not known yet — forwarding text unstripped`)
      // A repeat of a settled attempt answers 200 without forwarding; an unsettled one is forwarded again.
      if (host.dedupPeek(message.msgId)) return {}
      const admission = await host.forwardStrict(botId, message)
      if (admission.disposition !== 'retry') host.dedupMark(message.msgId)
      return { admission }
    }
  }
}

export const googleChatIngressPlugin: GoogleChatIngressPlugin = createGoogleChatIngressPlugin()
