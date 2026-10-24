// Microsoft Teams' relay ingress plugin (teams-integration.md §3, §4): a pure HTTP decoder of Bot Connector activities with no secret on the relay.
import { randomUUID } from 'node:crypto'
import { msTeamsActivityTenantId, normalizeMsTeamsActivity } from '@agentconnect.md/message'
import {
  MSTEAMS_PLATFORM,
  WireMsTeamsCardActionResponse,
  type RcDeploymentConfig,
  type RdMsgPlatformAction,
  type WireMsTeamsBotAdded,
  type WireMsTeamsCardAction,
  type WireMsTeamsMembersAdded
} from '@agentconnect.md/protocol'
import {
  MSTEAMS_CARD_ACTION_INVOKE,
  MsTeamsHttpIngest,
  msTeamsActionMsgId,
  msTeamsActivityOf,
  msTeamsBotAdded,
  msTeamsBotAddedMsgId,
  msTeamsCardClick,
  msTeamsDedupKey,
  msTeamsInvokeNote,
  msTeamsMembersAdded,
  msTeamsMembersAddedMsgId,
  type VerifiedMsTeamsDelivery
} from './http-ingest.js'
import { registerMsTeamsHttpIngress } from './http-ingress.js'
import { MsTeamsAnchorEgress, answerMsTeamsAnchor } from './anchor.js'
import { MsTeamsTokenVerifier, bearerToken, unverifiedAppId } from './token.js'
import type { BotAssignment } from '../../bot-arbitration.js'
import type { DemuxHints, HandledDelivery, RelayIngressHost, RelayPlatformIngressPlugin } from '../contract.js'

export interface MsTeamsIngressPluginDeps {
  /** The HTTP layer that fetches the Bot Framework's signing keys; tests pass a fake. Defaults to the global fetch. */
  fetch?: typeof fetch
}

export type MsTeamsIngressPlugin = RelayPlatformIngressPlugin<MsTeamsHttpIngest, VerifiedMsTeamsDelivery> & {
  /** The platform-wide token verifier over the Bot Framework's signing keys, exposed for inspection. */
  readonly verifier: MsTeamsTokenVerifier
}

/** How long a click waits on the daemon's ack before the relay answers the client anyway; the client allows about five seconds. */
export const MSTEAMS_CARD_ACTION_FORWARD_TIMEOUT_MS = 2_000

/** The notes a clicker sees under the card (§4.4). */
export const MSTEAMS_CLICK_NOTES = {
  received: 'Answer received.',
  undelivered: 'This answer could not be delivered. Please try again.',
  unsupported: 'This card action is not available.'
} as const

// Forward one card click to the bot's integration and pick the note: a bounded race, since the daemon settles the card itself; a refusal the daemon returns in time is the note.
async function forwardCardClick(host: RelayIngressHost, botId: string, click: WireMsTeamsCardAction): Promise<string> {
  const route = host.directory.soleTarget(botId)
  if (!route) {
    host.log.warn(`relay-ingress(${botId}): Teams card click has no current integration target`)
    return MSTEAMS_CLICK_NOTES.undelivered
  }
  const rd: RdMsgPlatformAction = {
    source: 'platform_action',
    platformId: MSTEAMS_PLATFORM,
    agentId: route.agentId,
    integrationId: route.integrationId,
    sessionKey: `msteams-action:${click.conversationId}/${click.cardActivityId}`,
    msgId: msTeamsActionMsgId(botId, click),
    botId,
    userId: click.aadObjectId ?? click.userId,
    payload: click
  }
  let timeout: ReturnType<typeof setTimeout> | undefined
  const forwarded = host.forwardAction(rd, route).then(
    (ack) => {
      if (!ack.accepted) {
        host.log.warn(`relay-ingress(${botId}): daemon rejected a Teams card click (${ack.reason ?? 'unknown'})`)
        return MSTEAMS_CLICK_NOTES.undelivered
      }
      const told = ack.response === undefined ? undefined : WireMsTeamsCardActionResponse.safeParse(ack.response)
      return told?.success ? told.data.note : MSTEAMS_CLICK_NOTES.received
    },
    (err: unknown) => {
      host.log.warn(`relay-ingress(${botId}): Teams card click forward failed: ${(err as Error).message}`)
      return MSTEAMS_CLICK_NOTES.undelivered
    }
  )
  // A click still in flight at the deadline most likely lands; the daemon's card update is the real answer.
  const note = await Promise.race([
    forwarded,
    new Promise<string>(
      (resolve) =>
        (timeout = setTimeout(() => resolve(MSTEAMS_CLICK_NOTES.received), MSTEAMS_CARD_ACTION_FORWARD_TIMEOUT_MS))
    )
  ])
  if (timeout) clearTimeout(timeout)
  return note
}

// Forward a roster change to the bot's agent: the people it added for the daemon to look up, or the bot's own install for it to welcome; bounded like a click, since Teams waits on the answer.
async function forwardRosterChange(
  host: RelayIngressHost,
  botId: string,
  change: { sessionKey: string; msgId: string; payload: WireMsTeamsMembersAdded | WireMsTeamsBotAdded; what: string }
): Promise<void> {
  const route = host.directory.soleTarget(botId)
  if (!route) return
  const rd: RdMsgPlatformAction = {
    source: 'platform_action',
    platformId: MSTEAMS_PLATFORM,
    agentId: route.agentId,
    integrationId: route.integrationId,
    sessionKey: change.sessionKey,
    msgId: change.msgId,
    botId,
    payload: change.payload
  }
  let timeout: ReturnType<typeof setTimeout> | undefined
  const forwarded = host.forwardAction(rd, route).then(
    (ack) => {
      if (!ack.accepted)
        host.log.debug(`relay-ingress(${botId}): daemon declined a Teams ${change.what} (${ack.reason ?? 'unknown'})`)
    },
    (err: unknown) =>
      host.log.warn(`relay-ingress(${botId}): Teams ${change.what} forward failed: ${(err as Error).message}`)
  )
  await Promise.race([
    forwarded,
    new Promise<void>((resolve) => (timeout = setTimeout(resolve, MSTEAMS_CARD_ACTION_FORWARD_TIMEOUT_MS)))
  ])
  if (timeout) clearTimeout(timeout)
}

// Teams' 1:1 chats are addressed by nature and a mention of the bot is an address; anything else is the activation policy's call, as on Slack.
function triggerOf(isDm: boolean, mentionedBots: readonly string[], appId: string): 'dm' | 'mention' | undefined {
  if (isDm) return 'dm'
  return mentionedBots.some((id) => id.toLowerCase() === `28:${appId}`) ? 'mention' : undefined
}

/** The deployment app's anchor id: not a UUID, so no CP row can ever carry it. */
export const MSTEAMS_ANCHOR_BOT_ID = 'deployment:msteams:anchor'

export function createMsTeamsIngressPlugin(deps: MsTeamsIngressPluginDeps = {}): MsTeamsIngressPlugin {
  const fetchImpl: typeof fetch = (input, init) => (deps.fetch ?? fetch)(input, init)
  const verifier = new MsTeamsTokenVerifier(fetchImpl)
  // The latest snapshot's anchor, which carries the secret the anchor's ingest sends with; an assignment never does.
  let anchor: MsTeamsAnchorEgress | undefined
  return {
    platformId: MSTEAMS_PLATFORM,
    verifier,

    // `POST /msteams/messages`, the messaging endpoint the bot registration names; pinned by route-mounts.test.ts.
    installRoutes: registerMsTeamsHttpIngress,

    // The anchor the CP's snapshot names (§8.4): an app-only entry that answers a tenant no customer row serves.
    deploymentAssignments(snapshot: RcDeploymentConfig | undefined): BotAssignment[] {
      const config = snapshot?.msTeamsAnchor
      if (!config) {
        anchor = undefined
        return []
      }
      if (anchor) anchor.update(config)
      else anchor = new MsTeamsAnchorEgress(config, fetchImpl)
      return [
        {
          botId: MSTEAMS_ANCHOR_BOT_ID,
          platform: MSTEAMS_PLATFORM,
          secrets: {},
          apiAppId: config.appId,
          claimUrl: config.connectUrl,
          members: [],
          agents: [],
          routes: []
        }
      ]
    },

    buildIngest(a: BotAssignment, host: RelayIngressHost): MsTeamsHttpIngest | undefined {
      if (a.botId === MSTEAMS_ANCHOR_BOT_ID) {
        if (!anchor || !a.apiAppId) return undefined
        verifier.log ??= host.log
        return new MsTeamsHttpIngest(a.botId, a.apiAppId.toLowerCase(), '', verifier, undefined, anchor)
      }
      // No Teams secret here, the signed token is the check; the tenant is the composite demux key and the strict fence.
      if (!a.apiAppId || !a.teamId || Object.keys(a.secrets).length !== 0) {
        host.log.warn(`relay-ingress(${a.botId}): incomplete Microsoft Teams assignment`)
        return undefined
      }
      verifier.log ??= host.log
      return new MsTeamsHttpIngest(
        a.botId,
        a.apiAppId.toLowerCase(),
        a.teamId.toLowerCase(),
        verifier,
        a.credentialRevision
      )
    },

    extractDemuxHints(_rawBody: Buffer, body: unknown, headers): DemuxHints {
      // The token's unverified audience picks the candidate app and the activity's tenant its row; `verify` decides.
      const appId = unverifiedAppId(headers.authorization)
      const tenantId = msTeamsActivityTenantId(body)?.toLowerCase()
      return { ...(appId ? { appId } : {}), ...(tenantId ? { tenantId } : {}) }
    },

    async verify(ingest, _rawBody, body, headers, now): Promise<VerifiedMsTeamsDelivery | undefined> {
      const token = bearerToken(headers.authorization)
      const activity = msTeamsActivityOf(body)
      const serviceUrl = typeof activity?.serviceUrl === 'string' ? activity.serviceUrl : undefined
      if (!token || !activity || !serviceUrl) return undefined
      const claims = await ingest.verifier.verify(token, { appId: ingest.appId, serviceUrl }, now)
      return claims ? { activity, traceId: randomUUID() } : undefined
    },

    async handle(ingest, verified, host): Promise<HandledDelivery> {
      const botId = ingest.botId
      const { activity } = verified
      // A tenant no organization connected: the anchor answers it itself and forwards nothing (§8.4).
      if (ingest.anchor) {
        await answerMsTeamsAnchor(ingest.anchor, activity, msTeamsActivityTenantId(activity)?.toLowerCase(), host.log)
        return {}
      }
      if (activity.type === 'invoke') {
        // Every invoke is answered 200; only a card click carries a note, and an unknown invoke an empty body.
        if (activity.name !== MSTEAMS_CARD_ACTION_INVOKE) return {}
        const click = msTeamsCardClick(activity)
        if (!click) {
          host.log.warn(`relay-ingress(${botId}): dropped a malformed Teams card click`)
          return { syncResponse: msTeamsInvokeNote(MSTEAMS_CLICK_NOTES.unsupported) }
        }
        return { syncResponse: msTeamsInvokeNote(await forwardCardClick(host, botId, click)) }
      }
      // The bot's own install is welcomed once in the conversation it joined (teams-integration.md §4.7).
      const added = msTeamsBotAdded(activity, ingest.appId)
      if (added)
        await forwardRosterChange(host, botId, {
          sessionKey: `msteams-bot-added:${added.conversationId}`,
          msgId: msTeamsBotAddedMsgId(botId, activity),
          payload: added,
          what: 'bot install'
        })
      // People added to a conversation are looked up for a guest or another organization (assistant-mode.md §5.3).
      const joined = msTeamsMembersAdded(activity, ingest.appId)
      if (joined)
        await forwardRosterChange(host, botId, {
          sessionKey: `msteams-members:${joined.conversationId}`,
          msgId: msTeamsMembersAddedMsgId(botId, activity),
          payload: joined,
          what: 'member join'
        })
      if (added || joined) return {}
      // Typing, reactions, edits, deletes, installs and other roster changes start nothing on the relay (§4.2).
      if (activity.type !== 'message') return {}
      const result = normalizeMsTeamsActivity(activity, {
        appId: ingest.appId,
        tenantId: ingest.tenantId,
        traceId: verified.traceId
      })
      const dedupKey = msTeamsDedupKey(botId, activity)
      if (result.kind === 'invalid') {
        // Authenticated but permanently malformed: a 4xx would not help, and Teams retries a 503 once.
        host.log.warn(`relay-ingress(${botId}): dropped a malformed Teams activity (${result.reason})`)
        return {}
      }
      if (result.kind === 'ignored' || result.kind === 'unsupported') {
        host.dedupMark(dedupKey)
        return {}
      }
      const message = result.message
      const trigger = triggerOf(message.isDm, message.mentionedBots, ingest.appId)
      // A repeat of a settled attempt answers 200 without forwarding; an unsettled one is forwarded again.
      if (host.dedupPeek(dedupKey)) return {}
      const admission = await host.forwardStrict(botId, trigger ? { ...message, trigger } : message)
      if (admission.disposition !== 'retry') host.dedupMark(dedupKey)
      return { admission }
    }
  }
}

export const msTeamsIngressPlugin: MsTeamsIngressPlugin = createMsTeamsIngressPlugin()
