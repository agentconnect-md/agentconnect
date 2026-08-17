import type {
  RdChatEvent,
  RdWebchatPost,
  WebchatDone,
  WebchatOutput,
  WebchatRemoteMcpEntitlement,
  WebchatRuntimeConfig
} from '@agentconnect.md/protocol'

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

export interface WebchatTurnContext {
  conversationId: string
  turnId: string
  sink: WebchatSink
  /** Sends the turn's completed reply as a canonical conversation post
   * (`rd/webchat-post`) on the relay connection the turn arrived on, so the
   * relay can fan it to the other participants' daemons as context
   * (webchat-multi-agents.md §5.2). Absent on an older relay / synthetic turn. */
  postSink?: (post: RdWebchatPost) => void
  /** Set only for a post-only wake context built by {@link webchatWakeContext}: an
   *  agent-initiated turn inside a webchat conversation, with no browser turn of its
   *  own to stream to (#753). Carried onto the completed `RdWebchatPost` so the
   *  browser knows this reply never streamed live and needs rendering from the post. */
  initiator?: 'agent'
  /** Session-targeted continuation (§5.2): the webchat stream is an ADDITIONAL sink —
   *  turn output/status/failure still follow the origin platform's ordinary rules. */
  continuation?: true
  runtime?: WebchatRuntimeConfig
  worktree?: boolean
  /** Authority captured only from the relay's validated rd/msg envelope. It is
   * consumed by the daemon host selector and never forwarded to ACP/model input. */
  remoteMcp?: WebchatRemoteMcpEntitlement
  doneSent?: boolean
  /** This turn is driven by the local evaluation harness, not a browser. Its
   *  webchat shape is synthetic, so the session-visibility capture gate does NOT
   *  treat it as a private Playground conversation — measuring memory capture is
   *  the harness's whole purpose (session-visibility.md §4.2 applies to real
   *  user conversations). */
  evaluation?: boolean
}

/** One daemon-owned turn stream. `sink` is stable for the turn engine; `transport`
 * is rebound when a browser resumes through any relay. The replay window is
 * ephemeral, bounded, and never written to disk. */
export interface WebchatTurnStream extends WebchatTurnContext {
  agentId: string
  transport: WebchatSink
  resumeGeneration: number
  replay: BufferedWebchatEvent[]
  replayBytes: number
  replayFloor: number
  replayDisabled: boolean
  lastOutputIndex: number
  completedAt?: number
}
