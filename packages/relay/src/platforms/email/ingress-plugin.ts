// Email's relay ingress plugin (email-integration.md §4, §5.5, §6.2, §8): mail the ingress Worker posts is checked, normalized and forwarded, and a daemon's reply is sent with the deployment's token.
import { randomUUID } from 'node:crypto'
import {
  canonicalEmailAddress,
  emailAutomaticReason,
  emailParticipants,
  evaluateEmailAuthentication,
  normalizeEmailMessage,
  type EmailInboundMessage
} from '@agentconnect.md/message'
import {
  EMAIL_PLATFORM,
  WireEmailCall,
  type RcDeploymentConfig,
  type RcEmailDeployment,
  type RdPlatformReply,
  type WireEmailAdapterExt,
  type WireNormalizedMessage
} from '@agentconnect.md/protocol'
import { EmailInboundRate } from './counters.js'
import { EMAIL_PROVIDER_API_BASE, EmailRelayEgress } from './egress.js'
import {
  EMAIL_REJECT_REASONS,
  VerifiedEmailPost,
  emailAccepted,
  emailReject,
  registerEmailHttpIngress
} from './http-ingress.js'
import { readEmailMime } from './mime.js'
import { mintEmailTicket } from './ticket.js'
import type { BotAssignment } from '../../bot-arbitration.js'
import type { DemuxHints, HandledDelivery, RelayIngressHost, RelayPlatformIngressPlugin } from '../contract.js'

/** How long after a registration an address no bot holds is answered for a retry: bot assignments are replayed behind the snapshot, with nothing marking their end. */
export const EMAIL_ASSIGNMENT_SETTLE_MS = 30_000

/** One address's ingest: it holds no credential, only the address mail is demuxed by. */
export class EmailIngest {
  constructor(
    readonly botId: string,
    /** The agent address, canonical. */
    readonly address: string
  ) {}

  stop(): void {}
}

export interface EmailIngressPluginDeps {
  /** The HTTP layer the provider is called with; defaults to the global fetch. */
  fetch?: typeof fetch
  /** The provider's REST root; a test names a local server. */
  apiBase?: string
  now?: () => number
  /** Overrides the route's settle deadline and the send's budget; only for tests of their expiry. */
  deadlineMs?: number
  sendBudgetMs?: number
}

export type EmailIngressPlugin = RelayPlatformIngressPlugin<EmailIngest, VerifiedEmailPost>

const INVALID_REASONS = {
  sender: EMAIL_REJECT_REASONS.sender,
  message_id: EMAIL_REJECT_REASONS.messageId,
  recipients: EMAIL_REJECT_REASONS.recipients
} as const

export function createEmailIngressPlugin(deps: EmailIngressPluginDeps = {}): EmailIngressPlugin {
  const now = deps.now ?? Date.now
  // The latest snapshot's Email configuration: the ingress secret, the sending token and the ticket key; no assignment carries any.
  let config: RcEmailDeployment | undefined
  let registeredAtMs = Number.NEGATIVE_INFINITY
  const rate = new EmailInboundRate()
  const egress = new EmailRelayEgress(
    (input, init) => (deps.fetch ?? fetch)(input, init),
    deps.apiBase ?? EMAIL_PROVIDER_API_BASE,
    now,
    deps.sendBudgetMs
  )
  // The address an assignment serves, when it is one on the mail domain the deployment serves now.
  const servedAddress = (a: BotAssignment): string | undefined => {
    const address = a.apiAppId === undefined ? undefined : canonicalEmailAddress(a.apiAppId)
    return address && config && address.endsWith(`@${config.mailDomain}`) ? address : undefined
  }
  return {
    platformId: EMAIL_PLATFORM,

    // `POST /email/inbound`, the URL the ingress Worker is configured with; pinned by route-mounts.test.ts.
    installRoutes: (app, routeDeps) =>
      registerEmailHttpIngress(app, routeDeps, {
        config: () => config,
        settling: (at) => at - registeredAtMs < EMAIL_ASSIGNMENT_SETTLE_MS,
        now,
        ...(deps.deadlineMs !== undefined ? { deadlineMs: deps.deadlineMs } : {})
      }),

    // Mail has no deployment-owned bot; the snapshot is read here for the configuration every address shares.
    deploymentAssignments(snapshot: RcDeploymentConfig | undefined): BotAssignment[] {
      config = snapshot?.email
      registeredAtMs = now()
      return []
    },

    buildIngest(a: BotAssignment, host: RelayIngressHost): EmailIngest | undefined {
      const address = a.apiAppId === undefined ? undefined : canonicalEmailAddress(a.apiAppId)
      if (!address || Object.keys(a.secrets).length !== 0) {
        host.log.warn(`relay-ingress(${a.botId}): incomplete Email assignment`)
        return undefined
      }
      // The address is what a group mail names the agent by, and what an echo of its own mail would come from.
      host.reportBotUserId(a.botId, address)
      return new EmailIngest(a.botId, address)
    },

    // A reply (§6.2); core checked the daemon serves the bot, and everything the payload asks for is checked here.
    async daemonRequest(a: BotAssignment, payload: unknown): Promise<RdPlatformReply> {
      const address = servedAddress(a)
      // No configuration, or an address off the served domain: this relay's snapshot may trail another's, and nothing was called.
      if (!config || !address) return { outcome: 'refused', reason: 'not_configured', retryable: true }
      const call = WireEmailCall.safeParse(payload)
      if (!call.success) return { outcome: 'refused', reason: 'invalid' }
      // An assignment from a Control Plane that names no organization is budgeted as an organization of its own.
      return await egress.send(
        config,
        { botId: a.botId, address, organization: a.orgSlug ?? `bot:${a.botId}` },
        call.data
      )
    },

    extractDemuxHints(_rawBody: Buffer, body: unknown): DemuxHints {
      return body instanceof VerifiedEmailPost && body.agentAddress ? { appId: body.agentAddress } : {}
    },

    // The route checked the signature; a post belongs to the one ingest whose address the envelope recipient names.
    verify(ingest, _rawBody, body): VerifiedEmailPost | undefined {
      return body instanceof VerifiedEmailPost && body.agentAddress === ingest.address ? body : undefined
    },

    async handle(ingest, post, host): Promise<HandledDelivery> {
      const { botId } = ingest
      const reject = (reason: string, why: string): HandledDelivery => {
        host.log.info(`relay-ingress(${botId}): mail rejected (${why})`)
        return { syncResponse: emailReject(reason) }
      }
      // The snapshot left between the route's check and this one: nothing can be judged, so the sender's server tries again.
      if (!config) return { admission: { disposition: 'retry', reason: 'not_ready' } }
      const { mailDomain, authservId } = config
      let mail: EmailInboundMessage
      try {
        mail = await readEmailMime(post.raw, post.truncated)
      } catch {
        return reject(EMAIL_REJECT_REASONS.unreadable, 'unreadable')
      }
      const from = mail.from?.[0]?.address ?? ''
      // §4 step 1: automatic mail is accepted and discarded, so two automatic responders never answer each other.
      const automatic = emailAutomaticReason({
        headers: mail.headers,
        envelopeFrom: post.envelopeFrom,
        from,
        mailDomain
      })
      if (automatic) {
        host.log.info(`relay-ingress(${botId}): automatic mail discarded (${automatic})`)
        return { syncResponse: emailAccepted }
      }
      // §4 step 2: only the topmost `Authentication-Results`, which the receiving provider prepended, is believed.
      const authenticated = evaluateEmailAuthentication({ headers: mail.headers, authservId, from })
      if (!authenticated.ok) return reject(EMAIL_REJECT_REASONS.unauthenticated, `sender: ${authenticated.reason}`)
      const receivedAtMs = host.clock.now()
      const normalized = normalizeEmailMessage(mail, {
        agentAddress: ingest.address,
        traceId: randomUUID(),
        receivedAtMs
      })
      if (normalized.kind === 'invalid') return reject(INVALID_REASONS[normalized.reason], normalized.reason)
      const ext = normalized.message.adapterExt![EMAIL_PLATFORM] as WireEmailAdapterExt
      // A repeat of an admitted message is settled without a second forward; any other repeat is judged again (§5.5).
      const dedupKey = `${EMAIL_PLATFORM}:${botId}:${ext.messageId}`
      if (host.dedupPeek(dedupKey)) {
        host.log.info(`relay-ingress(${botId}): mail not forwarded (repeat of an admitted message)`)
        return { syncResponse: emailAccepted }
      }
      // §4 step 4, counted per authenticated sender and bot.
      if (!rate.allows(botId, ext.from.address, receivedAtMs))
        return reject(EMAIL_REJECT_REASONS.rateLimited, 'rate limit')
      // §6.2: the ticket names the thread and the people this mail reached, which is everyone a reply may go to.
      const ticket = mintEmailTicket(
        Buffer.from(config.ticketKey, 'base64url'),
        botId,
        { threadKey: normalized.message.thread ?? ext.messageId, issuedAtMs: receivedAtMs },
        emailParticipants(ext, ingest.address)
      )
      const message: WireNormalizedMessage = {
        ...normalized.message,
        // Mail that reached the address is addressed to the agent wherever the address appears (§5.2).
        trigger: normalized.message.isDm ? 'dm' : 'mention',
        adapterExt: { ...normalized.message.adapterExt, [EMAIL_PLATFORM]: { ...ext, ...(ticket ? { ticket } : {}) } }
      }
      const admission = await host.forwardStrict(botId, message)
      // A retry is neither marked nor counted: the same message comes again, and must be forwarded again.
      if (admission.disposition === 'retry') return { admission }
      rate.record(botId, ext.from.address, receivedAtMs)
      if (admission.disposition === 'admitted') {
        host.dedupMark(dedupKey)
        return { syncResponse: emailAccepted, admission }
      }
      // §4 step 3 is the daemon's, and its refusal reads the same whatever the cause.
      host.log.info(`relay-ingress(${botId}): mail rejected (not admitted: ${admission.reason ?? 'rejected'})`)
      return { syncResponse: emailReject(EMAIL_REJECT_REASONS.notMember), admission }
    }
  }
}

export const emailIngressPlugin: EmailIngressPlugin = createEmailIngressPlugin()
