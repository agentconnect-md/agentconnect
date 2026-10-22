// Teams' daemon platform module (§7.4): relay ingress, the reply-chain thread strategy, the chat-member key, and relayed card clicks.
import {
  MSTEAMS_CARD_NOTE_MAX,
  MSTEAMS_PLATFORM,
  WireMsTeamsCardAction,
  type RdMsgPlatformAction,
  type WireMsTeamsCardActionResponse
} from '@agentconnect.md/protocol'
import type { ChatCardClick, DaemonPlatformModule, InteractionActor, RelayCardClicks } from '../contract.js'
import { parseMsTeamsApprovalClick } from './approval-card.js'
import { parseMsTeamsElicitClick } from './elicit-card.js'
import { msTeamsRelayIngress, type MsTeamsRelayIngressHost } from './relay-ingress.js'
import { canonicalizeMsTeamsThread } from './threading.js'

const ENTRA_OBJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The clicker's Entra object ID, the person within the integration's tenant (§4.4); a bot-specific `29:` ID is never linkable, so it refuses. */
export function msTeamsChatMemberKey(actor: InteractionActor): string | undefined {
  const id = actor.memberId ?? actor.userId
  return ENTRA_OBJECT_ID.test(id) ? id.toLowerCase() : undefined
}

/** One forwarded card click: the answer it carries, the card it was on, and the clicker by Entra object ID where Teams sent one. Pure. */
export function decodeMsTeamsCardClick(msg: Pick<RdMsgPlatformAction, 'payload'>): ChatCardClick | null {
  const parsed = WireMsTeamsCardAction.safeParse(msg.payload)
  if (!parsed.success) return null
  const click = parsed.data
  const name = click.userName?.trim()
  const actor: InteractionActor = {
    userId: click.aadObjectId ?? click.userId,
    ...(click.aadObjectId ? { memberId: click.aadObjectId } : {}),
    ...(name ? { name } : {})
  }
  const at = { ts: click.cardActivityId, actor }
  const pick = parseMsTeamsApprovalClick(click)
  if (pick) return { answer: { kind: 'approval', ...pick }, ...at }
  const elicit = parseMsTeamsElicitClick(click)
  return elicit ? { answer: elicit, ...at } : null
}

export const msTeamsCardClicks: RelayCardClicks = {
  decode: decodeMsTeamsCardClick,
  response: (privateText) =>
    ({ note: privateText.slice(0, MSTEAMS_CARD_NOTE_MAX) }) satisfies WireMsTeamsCardActionResponse
}

/** Teams' daemon platform module, bound to one daemon's host. */
export function msTeamsPlatformModule(host: MsTeamsRelayIngressHost): DaemonPlatformModule {
  return {
    platformId: MSTEAMS_PLATFORM,
    relayIngress: msTeamsRelayIngress(host),
    canonicalizeThread: canonicalizeMsTeamsThread,
    chatMemberKey: msTeamsChatMemberKey,
    cardClicks: msTeamsCardClicks
  }
}
