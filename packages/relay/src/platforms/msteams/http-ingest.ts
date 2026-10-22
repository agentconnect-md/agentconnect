// Microsoft Teams' per-bot relay ingest (teams-integration.md §3, §4): a pure decoder holding the bot's app and tenant IDs, and no secret.
import { createHash } from 'node:crypto'
import type { WireMsTeamsCardAction } from '@agentconnect.md/protocol'
import type { MsTeamsTokenVerifier } from './token.js'

/** Hard cap on one activity's raw body; Teams caps a message at 100 KB, and its HTML twin rides beside the text. */
export const MSTEAMS_BODY_LIMIT = 1024 * 1024

/** The invoke name of an Adaptive Card `Action.Execute` click (§4.4). */
export const MSTEAMS_CARD_ACTION_INVOKE = 'adaptiveCard/action'

/** The invoke response type the Teams client shows as a dismissible note under the card. */
export const MSTEAMS_INVOKE_MESSAGE_TYPE = 'application/vnd.microsoft.activity.message'

/** The plugin's typed verified product: the activity, whose token proved the Bot Connector sent it to this bot for its `serviceUrl`. */
export interface VerifiedMsTeamsDelivery {
  activity: Record<string, unknown>
  traceId: string
}

type Obj = Record<string, unknown>

function obj(value: unknown): Obj | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** The activity a request body carries, when it is one: an object with a `type`. */
export function msTeamsActivityOf(body: unknown): Obj | undefined {
  const activity = obj(body)
  return activity && str(activity.type) ? activity : undefined
}

/** The relay's dedup key (§4.2): Teams message IDs are unique only within a conversation, so the bot and the raw conversation ID scope it. */
export function msTeamsDedupKey(botId: string, activity: Obj): string | undefined {
  const conversationId = str(obj(activity.conversation)?.id)
  const activityId = str(activity.id)
  return conversationId && activityId ? `${botId}\0${conversationId}\0${activityId}` : undefined
}

/** One `adaptiveCard/action` invoke read into the wire click, or undefined for anything that is not a complete `Action.Execute`. */
export function msTeamsCardClick(activity: Obj): WireMsTeamsCardAction | undefined {
  if (activity.type !== 'invoke' || activity.name !== MSTEAMS_CARD_ACTION_INVOKE) return undefined
  const action = obj(obj(activity.value)?.action)
  const verb = str(action?.verb)
  if (action?.type !== 'Action.Execute' || !verb || verb.length > 256) return undefined
  const data = action.data === undefined ? {} : obj(action.data)
  const cardActivityId = str(activity.replyToId)
  const conversationId = str(obj(activity.conversation)?.id)
  const serviceUrl = str(activity.serviceUrl)
  const from = obj(activity.from)
  const userId = str(from?.id)
  if (!data || !cardActivityId || !conversationId || !serviceUrl || !userId) return undefined
  const aadObjectId = str(from?.aadObjectId)
  const userName = str(from?.name)?.trim().slice(0, 256)
  return {
    verb,
    data,
    cardActivityId,
    conversationId,
    serviceUrl,
    ...(aadObjectId ? { aadObjectId } : {}),
    userId,
    ...(userName ? { userName } : {})
  }
}

/** A click's dedup identity: one click is one event, so its content is its identity, and a client retry of it collapses. */
export function msTeamsActionMsgId(botId: string, click: WireMsTeamsCardAction): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        v: 1,
        botId,
        conversationId: click.conversationId,
        cardActivityId: click.cardActivityId,
        user: click.aadObjectId ?? click.userId,
        verb: click.verb,
        data: click.data
      })
    )
    .digest('hex')
  return `msteams-action:${digest}`
}

/** The synchronous invoke answer: a short text the clicker alone sees as a note under the card. */
export function msTeamsInvokeNote(text: string): { statusCode: 200; type: string; value: string } {
  return { statusCode: 200, type: MSTEAMS_INVOKE_MESSAGE_TYPE, value: text }
}

export class MsTeamsHttpIngest {
  constructor(
    readonly botId: string,
    /** The Entra application (client) ID, lower-cased: the token audience and the bot's `28:` identity. */
    readonly appId: string,
    /** The tenant the bot is registered in, lower-cased: the normalizer's tenant fence. */
    readonly tenantId: string,
    /** Shared across the platform's ingests; the keys are the Bot Framework's, not the bot's. */
    readonly verifier: MsTeamsTokenVerifier,
    /** The generation THIS ingest was built from. */
    readonly credentialRevision?: number
  ) {}

  /** §8 RelayBotIngress: a pure decoder has nothing to release. */
  stop(): void {}
}
