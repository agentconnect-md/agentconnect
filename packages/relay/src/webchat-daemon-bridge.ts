// The daemon-facing half of a webchat op, shared by the browser socket and the AI SDK chat route: find the live rd/* socket, deliver one rd/msg.
import { randomUUID } from 'node:crypto'
import {
  ErrorCode,
  RD_ACK_NOT_HOLDER,
  type RdAck,
  type RdMsgWebchat,
  type RelayWebchatOp,
  type WebchatRemoteMcpEntitlement
} from '@agentconnect.md/protocol'
import { WireError } from '@agentconnect.md/connection'
import type { RelayDaemonConnection } from './relay-daemon-connection.js'
import type { Logger } from './log.js'

const ACK_TIMEOUT_MESSAGE =
  /^no ack after [1-9]\d* tries for [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REMOTE_PROTOCOL_CODES: ReadonlySet<string> = new Set([
  'UNKNOWN_FRAME',
  'FRAME_TOO_LARGE',
  'PROTOCOL_STATE',
  'BAD_PAYLOAD'
])

/** Delivery telemetry that never copies an error's message or details, which may hold the rd/msg and its content. */
export function deliveryFailureDiagnostic(error: unknown): string {
  if (!(error instanceof WireError)) return 'kind=unknown_error'

  const parsedCode = ErrorCode.safeParse(error.code)
  if (!parsedCode.success) return 'kind=unknown_wire_error'

  const code = parsedCode.data
  let kind = 'wire_error'
  if (code === 'INTERNAL' && error.retryable && ACK_TIMEOUT_MESSAGE.test(error.message)) {
    kind = 'ack_timeout'
  } else if (code === 'INTERNAL' && error.retryable && error.message === 'connection closed') {
    kind = 'connection_closed'
  } else if (REMOTE_PROTOCOL_CODES.has(code)) {
    kind = 'remote_protocol'
  }
  return `kind=${kind} code=${code} retryable=${error.retryable}`
}

/** One conversation participant, as verified by the CP. */
export interface WebchatParticipant {
  agentId: string
  /** Current placement; absent ⇒ unplaced or not READY at verify, so its turns are refused `no_agent`. */
  daemonId?: string
  /** Where this participant's content is (#2218); never healed, since the recorder decides whether another member may take a turn. */
  recordedDaemonId?: string
  primary?: boolean
  /** This participant's own continuation target, set on a hook conversation's peers (#2500); wins over the binding's. */
  targetSessionId?: string
}

/** The verdict-bound fields every rd/msg of one conversation carries; never browser or request input. */
export interface WebchatConversationBinding {
  chatId: string
  targetSessionId?: string
  remoteMcp?: Readonly<WebchatRemoteMcpEntitlement>
}

export interface WebchatDaemonDeps {
  /** Resolve a live rd/* connection to a participant's daemon (absent if it dropped). */
  daemonConnFor: (daemonId: string) => RelayDaemonConnection | undefined
  /** Any live duty-governed pool connection, tried when the recorded daemon is gone (§4.4). */
  rendezvousDaemonConn?: () => { daemonId: string; conn: RelayDaemonConnection } | undefined
  log: Logger
}

export interface WebchatDaemonTarget {
  daemonId: string
  conn: RelayDaemonConnection
}

/** The participant's placed daemon, else a pool member that claims the duty or names its holder. */
export function resolveWebchatDaemon(
  deps: WebchatDaemonDeps,
  participant: WebchatParticipant | undefined,
  agentId: string
): WebchatDaemonTarget | undefined {
  const daemonId = participant?.daemonId
  const conn = daemonId ? deps.daemonConnFor(daemonId) : undefined
  if (daemonId && conn) return { daemonId, conn }
  const fallback = deps.rendezvousDaemonConn?.()
  if (fallback) {
    deps.log.info(`webchat: recorded daemon for ${agentId} is gone — rendezvousing via ${fallback.daemonId}`)
  }
  return fallback
}

/** One pre-addressed `rd/msg(webchat)` for `agentId` in the bound conversation. */
export function webchatRdMsg(
  binding: WebchatConversationBinding,
  agentId: string,
  participant: WebchatParticipant | undefined,
  payload: RelayWebchatOp
): RdMsgWebchat {
  const targetSessionId = participant?.targetSessionId ?? binding.targetSessionId
  return {
    source: 'webchat',
    agentId,
    sessionKey: binding.chatId,
    msgId: randomUUID(),
    chatId: binding.chatId,
    ...(targetSessionId ? { targetSessionId } : {}),
    ...(participant?.recordedDaemonId ? { recordedDaemonId: participant.recordedDaemonId } : {}),
    ...(binding.remoteMcp ? { remoteMcp: binding.remoteMcp } : {}),
    payload
  }
}

/** Send one rd/msg, following a `not_holder` refusal once to the named holder (same msgId), and heal the participant's placement. */
export async function deliverWebchatMsg(
  deps: WebchatDaemonDeps,
  target: WebchatDaemonTarget,
  rdMsg: RdMsgWebchat,
  participant: WebchatParticipant | undefined,
  capability?: string
): Promise<{ ack: RdAck } & WebchatDaemonTarget> {
  // A daemon that did not advertise `capability` cannot decode the op, so it is refused here rather than sent.
  const send = (c: RelayDaemonConnection): Promise<RdAck> =>
    capability && !c.supports(capability)
      ? Promise.resolve({
          msgId: rdMsg.msgId,
          accepted: false,
          reason: 'unsupported',
          detail: "the agent's daemon must be upgraded to take this API"
        })
      : c.sendMsg(rdMsg)
  let { daemonId, conn } = target
  let ack = await send(conn)
  if (!ack.accepted && ack.reason === RD_ACK_NOT_HOLDER && ack.holderDaemonId) {
    const holder = deps.daemonConnFor(ack.holderDaemonId)
    if (holder) {
      deps.log.info(`webchat: re-routing ${rdMsg.agentId} to duty holder ${ack.holderDaemonId}`)
      daemonId = ack.holderDaemonId
      conn = holder
      ack = await send(holder)
    }
  }
  // The member that answered is serving the agent now, so the next op goes direct.
  if (participant && ack.reason !== RD_ACK_NOT_HOLDER && participant.daemonId !== daemonId) {
    participant.daemonId = daemonId
  }
  return { ack, daemonId, conn }
}
