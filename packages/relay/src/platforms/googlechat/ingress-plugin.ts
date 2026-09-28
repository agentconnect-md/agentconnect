// Google Chat's relay ingress plugin (google-chat-integration.md §2, §4, §11): a pure HTTP decoder of add-on requests with no secret on the relay.
import { createHash, randomUUID } from 'node:crypto'
import {
  googleChatPayloadOf,
  googleChatTenantKey,
  normalizeGoogleChatEvent,
  type GoogleChatEventObject,
  type GoogleChatEventResult,
  type GoogleChatInteraction
} from '@agentconnect.md/message'
import {
  GOOGLE_CHAT_ELICIT_FUNCTION,
  GOOGLE_CHAT_PLATFORM,
  googleChatEventsUrl,
  type RcDeploymentConfig,
  type RdMsgPlatformAction,
  type WireGoogleChatCardAction
} from '@agentconnect.md/protocol'
import {
  GoogleChatHttpIngest,
  UNKNOWN_APP_USER_NAME,
  UnclaimedTenantMemo,
  googleChatClaimPrompt,
  googleChatWelcomeCard,
  googleChatDedupId,
  googleChatDedupKey,
  provenAppUserName,
  type VerifiedGoogleChatDelivery
} from './http-ingest.js'
import { registerGoogleChatHttpIngress } from './http-ingress.js'
import { GoogleChatTokenVerifier, bearerToken, unverifiedProjectNumber } from './token.js'
import type { BotAssignment } from '../../bot-arbitration.js'
import type { DemuxHints, HandledDelivery, RelayIngressHost, RelayPlatformIngressPlugin } from '../contract.js'

export interface GoogleChatIngressPluginDeps {
  /** The HTTP layer that fetches Google's signing keys; tests pass a fake. Defaults to the global fetch. */
  fetch?: typeof fetch
}

export type GoogleChatIngressPlugin = RelayPlatformIngressPlugin<GoogleChatHttpIngest, VerifiedGoogleChatDelivery> & {
  /** The platform-wide token verifier over Google's signing keys, exposed for inspection. */
  readonly verifier: GoogleChatTokenVerifier
}

type ClassifiedResult = Exclude<GoogleChatEventResult, { kind: 'invalid' }>

/** How long a button click waits on the daemon before the relay answers Google anyway; Chat allows 30 s. */
const CARD_ACTION_FORWARD_TIMEOUT_MS = 10_000

/** A button click's dedup identity: one click is one event, so its content is its identity. */
export function googleChatActionMsgId(botId: string, interaction: GoogleChatInteraction, eventTime?: string): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({ v: 1, botId, eventTime, interaction }))
    .digest('hex')
  return `googlechat-action:${digest}`
}

// Forward one elicitation-card click to the bot's integration; the daemon settles the card itself, so Google gets `{}`.
async function forwardElicitClick(
  host: RelayIngressHost,
  botId: string,
  interaction: GoogleChatInteraction,
  eventTime: string | undefined
): Promise<void> {
  const route = host.directory.soleTarget(botId)
  if (!route) {
    host.log.warn(`relay-ingress(${botId}): Google Chat card click has no current integration target`)
    return
  }
  const payload: WireGoogleChatCardAction = {
    function: interaction.function,
    parameters: interaction.parameters,
    formInputs: interaction.formInputs,
    ...(interaction.message ? { message: interaction.message } : {})
  }
  const rd: RdMsgPlatformAction = {
    source: 'platform_action',
    platformId: GOOGLE_CHAT_PLATFORM,
    agentId: route.agentId,
    integrationId: route.integrationId,
    sessionKey: `googlechat-action:${interaction.message ?? interaction.space}`,
    msgId: googleChatActionMsgId(botId, interaction, eventTime),
    botId,
    userId: interaction.user,
    payload
  }
  let timeout: ReturnType<typeof setTimeout> | undefined
  const forwarded = host.forwardAction(rd, route).then(
    (ack) => {
      if (!ack.accepted)
        host.log.warn(`relay-ingress(${botId}): daemon rejected a Google Chat card click (${ack.reason ?? 'unknown'})`)
    },
    (err: unknown) =>
      host.log.warn(`relay-ingress(${botId}): Google Chat card click forward failed: ${(err as Error).message}`)
  )
  await Promise.race([
    forwarded,
    new Promise<void>((resolve) => (timeout = setTimeout(resolve, CARD_ACTION_FORWARD_TIMEOUT_MS)))
  ])
  if (timeout) clearTimeout(timeout)
}

/** The deployment app's anchor id: not a UUID, so no CP row can ever carry it. */
export const GOOGLE_CHAT_ANCHOR_BOT_ID = 'deployment:googlechat:anchor'

/** The anchor the CP's snapshot names (§10.4): an app-only entry for the deployment app that routes nothing and answers the unclaimed. */
export function googleChatAnchorAssignment(snapshot: RcDeploymentConfig | undefined): BotAssignment[] {
  const anchor = snapshot?.googleChatAnchor
  if (!anchor) return []
  return [
    {
      botId: GOOGLE_CHAT_ANCHOR_BOT_ID,
      platform: GOOGLE_CHAT_PLATFORM,
      secrets: {},
      apiAppId: anchor.projectNumber,
      claimUrl: anchor.claimUrl,
      members: [],
      agents: [],
      routes: []
    }
  ]
}

// An unclaimed tenant's answer (§10.4): the welcome card on an add, the authorization prompt on a message, nothing otherwise or without a tenant.
function unclaimedAnswer(
  ingest: GoogleChatHttpIngest,
  claimUrl: string,
  result: ClassifiedResult,
  nowMs: number
): { body: unknown; tenant: string } | undefined {
  if (result.kind === 'ignored' || result.kind === 'unsupported' || result.tenant === undefined) return undefined
  const tenant = result.tenant
  const iat = Math.floor(nowMs / 1000)
  if (result.kind === 'membership' && result.membership.change === 'added') {
    const added = result.membership
    const kind = added.isDm ? 'dm' : 'space'
    const state = { v: 1, app: ingest.projectNumber, space: added.channel, kind, tenant, iat } as const
    return { body: googleChatWelcomeCard(claimUrl, state), tenant }
  }
  if (result.kind !== 'message') return undefined
  const body = googleChatClaimPrompt(claimUrl, {
    v: 1,
    app: ingest.projectNumber,
    space: result.message.channel,
    user: result.message.sender.id,
    kind: result.message.isDm ? 'dm' : 'space',
    tenant,
    ...(result.configCompleteRedirectUri ? { redirect: result.configCompleteRedirectUri } : {}),
    iat
  })
  return { body, tenant }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

// An add-on request is an object with its `chat` object; anything else is never verified.
function eventObjectOf(body: unknown): GoogleChatEventObject | undefined {
  return isObject(body) && isObject(body.chat) ? (body as GoogleChatEventObject) : undefined
}

export function createGoogleChatIngressPlugin(deps: GoogleChatIngressPluginDeps = {}): GoogleChatIngressPlugin {
  const verifier = new GoogleChatTokenVerifier((input, init) => (deps.fetch ?? fetch)(input, init))
  const unclaimed = new UnclaimedTenantMemo()
  const refused = new UnclaimedTenantMemo()
  return {
    platformId: GOOGLE_CHAT_PLATFORM,
    verifier,

    // `POST /googlechat/events`, the path the Setup Server publishes; pinned by route-mounts.test.ts.
    installRoutes: registerGoogleChatHttpIngress,

    deploymentAssignments: googleChatAnchorAssignment,

    buildIngest(a: BotAssignment, host: RelayIngressHost): GoogleChatHttpIngest | undefined {
      // No Google secret here, the signed token is the check; a row cannot be a customer and the anchor, nor own-fenced and either.
      const multiTenant = a.tenantIds !== undefined || a.claimUrl !== undefined
      if (
        !a.apiAppId ||
        Object.keys(a.secrets).length !== 0 ||
        (a.tenantIds && a.claimUrl) ||
        (a.ownTenantIds && multiTenant)
      ) {
        host.log.warn(`relay-ingress(${a.botId}): incomplete Google Chat assignment`)
        return undefined
      }
      verifier.log ??= host.log
      // Read per request, so a snapshot that names the origin after this ingest was built still applies.
      const eventsUrl = (): string | undefined => {
        const origin = host.publicRelayUrl()
        return origin ? googleChatEventsUrl(origin) : undefined
      }
      return new GoogleChatHttpIngest(
        a.botId,
        a.apiAppId,
        a.botUserId,
        verifier,
        eventsUrl,
        a.credentialRevision,
        a.tenantIds,
        a.claimUrl,
        a.ownTenantIds
      )
    },

    extractDemuxHints(_rawBody: Buffer, body: unknown, headers): DemuxHints {
      // The token's unverified project number picks the candidate app and the unverified tenant key its row (§10.4); `verify` decides.
      const appId = unverifiedProjectNumber(headers.authorization)
      const tenantId = googleChatTenantKey(body)
      return { ...(appId ? { appId } : {}), ...(tenantId ? { tenantId } : {}) }
    },

    async verify(ingest, _rawBody, body, headers, now): Promise<VerifiedGoogleChatDelivery | undefined> {
      const token = bearerToken(headers.authorization)
      const event = eventObjectOf(body)
      // The token's audience is the relay's own events URL, so nothing verifies until the CP's snapshot names it.
      const eventsUrl = ingest.eventsUrl()
      if (!token || !event || !eventsUrl) return undefined
      const claims = await ingest.verifier.verify(token, { projectNumber: ingest.projectNumber, eventsUrl }, now)
      return claims ? { event, traceId: randomUUID() } : undefined
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
      // The anchor serves no tenant (§10.4): what core routed to it is unclaimed, answered in the body, never forwarded, reported, or marked.
      if (ingest.claimUrl !== undefined) {
        const now = host.clock.now()
        const answer = unclaimedAnswer(ingest, ingest.claimUrl, result, now)
        if (!answer) return {}
        if (unclaimed.first(`${ingest.projectNumber}\0${answer.tenant}`, now))
          host.log.info(`relay-ingress(${botId}): answering an unclaimed Google Chat tenant with the claim prompt`)
        return { syncResponse: answer.body }
      }
      // The own-tenant fence (§10.3): a foreign customer's Space gets a 200 Google never retries; a learned key is reported.
      if (ingest.singleTenant && result.kind !== 'ignored' && result.kind !== 'unsupported' && result.tenant) {
        const verdict = ingest.admitTenant(result.tenant)
        if (verdict === 'refused') {
          if (refused.first(`${botId}\0${result.tenant}`, host.clock.now()))
            host.log.warn(`relay-ingress(${botId}): refused a Google Chat event from another Workspace customer`)
          return {}
        }
        if (verdict === 'learned') host.reportTenant(botId, result.tenant)
      }
      if (result.kind === 'ignored' || result.kind === 'unsupported') {
        host.dedupMark(googleChatDedupKey(botId, googleChatDedupId(event)))
        return {}
      }
      // An elicitation card's click goes to the daemon that posted it; any other click has nothing left to do here.
      if (result.kind === 'interaction') {
        if (result.interaction.function === GOOGLE_CHAT_ELICIT_FUNCTION)
          await forwardElicitClick(host, botId, result.interaction, event.chat?.eventTime)
        return {}
      }
      if (result.kind === 'membership') {
        const displayName = googleChatPayloadOf(event)?.space?.displayName
        const name = typeof displayName === 'string' ? displayName : undefined
        host.reportChannels({ botId, channels: ingest.observeMembership(result.membership, name) })
        return {}
      }
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
