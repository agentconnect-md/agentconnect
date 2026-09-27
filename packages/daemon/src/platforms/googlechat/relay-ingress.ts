// Google Chat's §7.4 relay-ingress strategy (google-chat-integration.md §4): a durable receipt per delivery, no pre-spawn acknowledgement.
import { GOOGLE_CHAT_PLATFORM, type RdMsgIm } from '@agentconnect.md/protocol'
import { formatErr } from '../../daemon/text.js'
import { stableMessageId, type NormalizedMessage } from '../../messages/normalized.js'
import type { DaemonPlatformModule, RelayIngressStrategy } from '../contract.js'
import type { RelayIngressHost } from '../relay-ingress-host.js'
import type { GoogleChatConnection } from './connection.js'

export type GoogleChatRelayIngressHost = RelayIngressHost<GoogleChatConnection>

/** Bound on the Space-name read a Space's first delivery triggers; the row is reported without one after that. */
const SPACE_NAME_LOOKUP_MS = 1_500

/** The receipt outliving the dispatch row (§4); the delivery id already scopes the Google message identity by the app's transport scope. */
export function googleChatDeliveryReceiptId(deliveryId: string): string {
  return `googlechat-served\u001f${deliveryId}`
}

/** Google Chat's daemon platform module, bound to one daemon's host. */
export function googleChatPlatformModule(host: GoogleChatRelayIngressHost): DaemonPlatformModule {
  return { platformId: GOOGLE_CHAT_PLATFORM, relayIngress: googleChatRelayIngress(host) }
}

function googleChatRelayIngress(host: GoogleChatRelayIngressHost): RelayIngressStrategy {
  // `<integrationId>\u0000<space>` per Space reported from its first delivery: one report per Space per integration.
  const reportedSpaces = new Set<string>()

  /** The Space's display name: the cache, else one bounded read; absent leaves the row named by its id. */
  async function spaceName(conn: GoogleChatConnection, space: string): Promise<string | undefined> {
    const cached = (await host.store().getDisplayNames([space])).get(space)
    if (cached) return cached
    return await conn
      .getChannelInfo(space, { signal: AbortSignal.timeout(SPACE_NAME_LOOKUP_MS) })
      .then((info) => info.name)
      .catch(() => undefined)
  }

  /** Observed membership from traffic: a Space this build has not listed yet earns its row from its first delivery. */
  function noteSpace(integrationId: string, space: string): void {
    const key = `${integrationId}\u0000${space}`
    if (reportedSpaces.has(key)) return
    reportedSpaces.add(key)
    const conn = host.connection(integrationId)
    void (async () => {
      const name = conn ? await spaceName(conn, space) : undefined
      await host.observePlatformChat(GOOGLE_CHAT_PLATFORM, { id: space, ...(name ? { name } : {}), isPrivate: false }, [
        integrationId
      ])
    })().catch((err: unknown) => {
      reportedSpaces.delete(key)
      host.log().warn(`googlechat: reporting ${space} as an observed conversation failed: ${formatErr(err)}`)
    })
  }

  return {
    // Chat platforms post no startup message (product-conventions.md), so the delivery goes straight to dispatch.
    prepare: async (msg: RdMsgIm, normalized: NormalizedMessage, trace: { stage: string }) => {
      const conn = host.connection(msg.integrationId)
      if (conn) host.noteMessage(conn, normalized)
      if (!normalized.isDm) noteSpace(msg.integrationId, normalized.channel)
      trace.stage = 'googlechat:dispatch'
      return 'dispatch'
    },
    requireDurable: true,
    receiptId: (normalized) => googleChatDeliveryReceiptId(stableMessageId(normalized))
  }
}
