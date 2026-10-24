// Teams' §7.4 relay-ingress strategy (teams-integration.md §4.2): a durable receipt per activity, no pre-spawn acknowledgement, and `help` answered without a turn.
import { COMMAND_HELP } from '@agentconnect.md/activation-policy'
import type { RdMsgIm } from '@agentconnect.md/protocol'
import type { NormalizedMessage } from '../../messages/normalized.js'
import type { RelayIngressStrategy } from '../contract.js'
import type { RelayIngressHost } from '../relay-ingress-host.js'
import { CHAT_PLATFORMS_GUIDE_URL, SUPPORT_EMAIL } from '../welcome.js'
import { msTeamsTargetOf, type MsTeamsConnection } from './connection.js'
import { msTeamsActivityId } from './threading.js'

export type MsTeamsRelayIngressHost = RelayIngressHost<MsTeamsConnection>

/** The receipt outliving the dispatch row: the bot, the raw conversation and the activity, since an activity ID is unique only within its conversation (§4.2). */
export function msTeamsDeliveryReceiptId(normalized: NormalizedMessage): string {
  const conversation = msTeamsTargetOf(normalized)?.conversationId ?? normalized.channel
  return ['msteams-served', normalized.transportScope ?? '', conversation, msTeamsActivityId(normalized)].join('\u001f')
}

/** The answer to `help` (teams-integration.md §4.7): how to use the bot, every command, and where to go next, never a turn. */
export function msTeamsHelpText(): string {
  const commands = Object.values(COMMAND_HELP).map(({ usage, does }) => `- ${usage} — ${does}`)
  return [
    'I’m an AI agent powered by AgentConnect. Send me a task here, or @mention me in a channel or group chat and I answer in that thread.',
    '',
    'Commands (send one as a message; in a channel, @mention me with it):',
    ...commands,
    '- help — show this help',
    '',
    `Guide: ${CHAT_PLATFORMS_GUIDE_URL} · Contact: ${SUPPORT_EMAIL}`
  ].join('\n')
}

/** Whether a message is the bare `help` command, as the app's command list sends it. */
export function isMsTeamsHelp(text: string | undefined): boolean {
  return text?.trim().toLowerCase() === 'help'
}

export function msTeamsRelayIngress(host: MsTeamsRelayIngressHost): RelayIngressStrategy {
  return {
    // The activity's serviceUrl is the one every later write into this conversation uses (§3), a gate notice's included.
    observe: (msg: RdMsgIm, normalized: NormalizedMessage) => {
      const conn = host.connection(msg.integrationId)
      if (!conn) return
      conn.noteMessage(normalized)
      host.noteMessage(conn, normalized)
    },
    // Chat platforms post no startup message (product-conventions.md), so the delivery goes straight to dispatch.
    prepare: async (msg: RdMsgIm, normalized: NormalizedMessage, trace: { stage: string }) => {
      const conn = host.connection(msg.integrationId)
      const target = msTeamsTargetOf(normalized)
      if (conn && target && isMsTeamsHelp(normalized.text)) {
        trace.stage = 'msteams:help'
        // A help that did not post is refused, so the one redelivery Teams makes can answer it.
        return await conn.postText(target, msTeamsHelpText()).then(
          () => 'settled' as const,
          () => 'refused' as const
        )
      }
      // A post in a shared channel carries the share, as Slack's envelope does, before the turn it starts reads it.
      if (conn && !normalized.isDm && (await conn.sharedChannel(normalized.channel))) {
        normalized.externallyShared = true
        host.placeExternal([msg.integrationId], normalized.channel, 'externallyShared')
      }
      trace.stage = 'msteams:dispatch'
      return 'dispatch'
    },
    // A 503 buys exactly one redelivery, so the ack waits for the durable row it is answered from (§4.2).
    requireDurable: true,
    receiptId: msTeamsDeliveryReceiptId
  }
}
