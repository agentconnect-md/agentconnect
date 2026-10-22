// Teams' §7.4 relay-ingress strategy (teams-integration.md §4.2): a durable receipt per activity, no pre-spawn acknowledgement.
import type { RdMsgIm } from '@agentconnect.md/protocol'
import type { NormalizedMessage } from '../../messages/normalized.js'
import type { RelayIngressStrategy } from '../contract.js'
import type { RelayIngressHost } from '../relay-ingress-host.js'
import { msTeamsTargetOf, type MsTeamsConnection } from './connection.js'
import { msTeamsActivityId } from './threading.js'

export type MsTeamsRelayIngressHost = RelayIngressHost<MsTeamsConnection>

/** The receipt outliving the dispatch row: the bot, the raw conversation and the activity, since an activity ID is unique only within its conversation (§4.2). */
export function msTeamsDeliveryReceiptId(normalized: NormalizedMessage): string {
  const conversation = msTeamsTargetOf(normalized)?.conversationId ?? normalized.channel
  return ['msteams-served', normalized.transportScope ?? '', conversation, msTeamsActivityId(normalized)].join('\u001f')
}

export function msTeamsRelayIngress(host: MsTeamsRelayIngressHost): RelayIngressStrategy {
  return {
    // Chat platforms post no startup message (product-conventions.md), so the delivery goes straight to dispatch.
    prepare: async (msg: RdMsgIm, normalized: NormalizedMessage, trace: { stage: string }) => {
      const conn = host.connection(msg.integrationId)
      if (conn) {
        // The activity's serviceUrl is the one every later write into this conversation uses (§3).
        conn.noteMessage(normalized)
        host.noteMessage(conn, normalized)
      }
      trace.stage = 'msteams:dispatch'
      return 'dispatch'
    },
    // A 503 buys exactly one redelivery, so the ack waits for the durable row it is answered from (§4.2).
    requireDurable: true,
    receiptId: msTeamsDeliveryReceiptId
  }
}
