import type { RdChatEvent, WebchatDone, WebchatOutput } from '@agentconnect.md/protocol'
import type { ChatTurnContext } from '../session/chat-turn.js'

// A reconnectable turn keeps a bounded in-memory output window on the daemon,
// where the stream originates. This survives a browser moving between relay
// instances without putting message bodies on the Control Plane or disk.
export const WEBCHAT_REPLAY_MAX_EVENTS = 256
export const WEBCHAT_REPLAY_MAX_BYTES = 1024 * 1024
export const WEBCHAT_REPLAY_MAX_STREAMS = 64
export const WEBCHAT_REPLAY_TTL_MS = 5 * 60_000
/** A genuine webchat conversationId, as opposed to a synthetic `a2a:<agentId>` channel
 *  (see `webchatWakeContext`). */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Where a webchat turn's reply stream goes — the transport-neutral sink the turn engine
 * writes to instead of a hardcoded client. The relay path streams each item as `rd/chat`
 * over the relay socket the turn arrived on (milestone A4: the only webchat transport).
 */
export interface WebchatSink {
  output(o: WebchatOutput): void
  done(d: WebchatDone): void
}

export interface BufferedWebchatEvent {
  event: RdChatEvent
  bytes: number
}

export type WebchatTurnContext = ChatTurnContext

/** One daemon-owned turn stream: `sink` is stable for the turn engine; the replay window is ephemeral and bounded. */
export interface WebchatTurnStream extends WebchatTurnContext {
  agentId: string
  // The transport that admitted the turn keeps receiving it, so a resuming watcher never starves the requester.
  origin: WebchatSink
  // The latest resumer's transport, rebound when a browser resumes through any relay.
  transport: WebchatSink
  resumeGeneration: number
  replay: BufferedWebchatEvent[]
  replayBytes: number
  replayFloor: number
  replayDisabled: boolean
  lastOutputIndex: number
  completedAt?: number
}
