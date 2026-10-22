// Teams' daemon platform module (§7.4): relay ingress, the reply-chain thread strategy, and the chat-member key.
import { MSTEAMS_PLATFORM } from '@agentconnect.md/protocol'
import type { DaemonPlatformModule, InteractionActor } from '../contract.js'
import { msTeamsRelayIngress, type MsTeamsRelayIngressHost } from './relay-ingress.js'
import { canonicalizeMsTeamsThread } from './threading.js'

const ENTRA_OBJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The clicker's Entra object ID, the person within the integration's tenant (§4.4); a bot-specific `29:` ID is never linkable, so it refuses. */
export function msTeamsChatMemberKey(actor: InteractionActor): string | undefined {
  const id = actor.memberId ?? actor.userId
  return ENTRA_OBJECT_ID.test(id) ? id.toLowerCase() : undefined
}

/** Teams' daemon platform module, bound to one daemon's host. */
export function msTeamsPlatformModule(host: MsTeamsRelayIngressHost): DaemonPlatformModule {
  return {
    platformId: MSTEAMS_PLATFORM,
    relayIngress: msTeamsRelayIngress(host),
    canonicalizeThread: canonicalizeMsTeamsThread,
    chatMemberKey: msTeamsChatMemberKey
  }
}
