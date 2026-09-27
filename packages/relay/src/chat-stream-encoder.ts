// Encoders from one turn's `rd/chat` output to a chat wire protocol; the AI SDK UI message stream is the first (shared-bot-relay.md §10.4).
import type { WebchatDone, WebchatOutput } from '@agentconnect.md/protocol'

/** One turn's encoder: each call returns the wire text to write, possibly empty. */
export interface ChatStreamEncoder {
  /** The response headers of this protocol. */
  readonly headers: Readonly<Record<string, string>>
  /** The stream's opening, written once the turn is admitted. */
  open(): string
  output(output: WebchatOutput): string
  /** The turn's terminal `done`; the stream ends after it. */
  done(done: WebchatDone): string
  /** The turn ended without a `done` (the daemon link dropped); the stream ends after it. */
  fail(message: string): string
  /** A no-op the client ignores, keeping idle intermediaries from closing a silent turn. */
  keepalive(): string
}

export type ChatStreamEncoderFactory = (turnId: string) => ChatStreamEncoder

/** The subset of the `ai` package's `UIMessageChunk` this encoder emits; the tests pin it to that type. */
export type UiMessageChunk =
  | { type: 'start'; messageId?: string }
  | { type: 'start-step' }
  | { type: 'finish-step' }
  | { type: 'finish'; finishReason?: UiFinishReason }
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
  | { type: 'reasoning-start'; id: string }
  | { type: 'reasoning-delta'; id: string; delta: string }
  | { type: 'reasoning-end'; id: string }
  | { type: 'message-metadata'; messageMetadata: { title: string } }
  | { type: 'error'; errorText: string }
  | { type: `data-${string}`; id?: string; data: unknown }

export type UiFinishReason = 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other'

// The AI SDK's `UI_MESSAGE_STREAM_HEADERS`, minus `connection`, which the HTTP server owns.
export const UI_MESSAGE_STREAM_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  'x-vercel-ai-ui-message-stream': 'v1',
  'x-accel-buffering': 'no'
}

/** ACP `stopReason` → the AI SDK finish reason; anything unrecognized is `other`. */
export function uiFinishReason(stopReason: string | undefined): UiFinishReason {
  switch (stopReason) {
    case undefined:
    case 'end_turn':
      return 'stop'
    case 'max_tokens':
      return 'length'
    case 'refusal':
      return 'content-filter'
    default:
      return 'other'
  }
}

const sse = (chunk: UiMessageChunk): string => `data: ${JSON.stringify(chunk)}\n\n`
const SSE_DONE = 'data: [DONE]\n\n'

/** The AI SDK UI message stream (protocol v1): SSE parts in the §10.4 mapping table. */
export class UiMessageStreamEncoder implements ChatStreamEncoder {
  readonly headers = UI_MESSAGE_STREAM_HEADERS
  private openPart?: { kind: 'text' | 'reasoning'; id: string; segmentId?: string }
  private partSeq = 0
  private noticeSeq = 0
  // A `tool_update` carries only what changed, so each part is rebuilt from the call's last full state.
  private readonly tools = new Map<string, { toolCallId: string; title: string; status: string }>()

  constructor(private readonly turnId: string) {}

  open(): string {
    return sse({ type: 'start', messageId: this.turnId }) + sse({ type: 'start-step' })
  }

  output(output: WebchatOutput): string {
    const ev = output.event
    if (!ev) return '' // a status-only snapshot has no part
    switch (ev.kind) {
      case 'message':
        return this.delta('text', ev.text, ev.segmentId)
      case 'thinking':
        return this.delta('reasoning', ev.text)
      case 'tool_call': {
        const tool = { toolCallId: ev.toolCallId, title: ev.title, status: ev.status }
        this.tools.set(ev.toolCallId, tool)
        return this.close() + sse({ type: 'data-tool', id: ev.toolCallId, data: tool })
      }
      case 'tool_update': {
        const prior = this.tools.get(ev.toolCallId)
        const tool = { toolCallId: ev.toolCallId, title: ev.title ?? prior?.title ?? '', status: ev.status }
        this.tools.set(ev.toolCallId, tool)
        return this.close() + sse({ type: 'data-tool', id: ev.toolCallId, data: tool })
      }
      case 'plan':
        // ACP resends the whole list, so one id replaces the part in place.
        return this.close() + sse({ type: 'data-plan', id: 'plan', data: { entries: ev.entries } })
      case 'session_info':
        return sse({ type: 'message-metadata', messageMetadata: { title: ev.title } })
      case 'notice':
        // A wait notice replaces the last one (empty text clears it); a standing one stays.
        return (
          this.close() +
          (ev.standing
            ? sse({ type: 'data-notice', id: `notice-${++this.noticeSeq}`, data: { text: ev.text, standing: true } })
            : sse({ type: 'data-notice', id: 'notice', data: { text: ev.text } }))
        )
      default:
        return '' // elicitation, MCP App, and `superseded` kinds have no representation here
    }
  }

  done(done: WebchatDone): string {
    if (done.error !== undefined) return this.fail(done.error)
    return (
      this.close() +
      sse({ type: 'finish-step' }) +
      sse({ type: 'finish', finishReason: uiFinishReason(done.stopReason) }) +
      SSE_DONE
    )
  }

  fail(message: string): string {
    return this.close() + sse({ type: 'error', errorText: message }) + SSE_DONE
  }

  keepalive(): string {
    return ': keepalive\n\n'
  }

  private delta(kind: 'text' | 'reasoning', text: string, segmentId?: string): string {
    if (text === '') return ''
    let out = ''
    const current = this.openPart
    if (!current || current.kind !== kind || (segmentId !== undefined && current.segmentId !== segmentId)) {
      out += this.close()
      const id = `${kind}-${++this.partSeq}`
      this.openPart = { kind, id, ...(segmentId !== undefined ? { segmentId } : {}) }
      out += sse({ type: kind === 'text' ? 'text-start' : 'reasoning-start', id })
    }
    const id = this.openPart!.id
    return (
      out +
      sse(kind === 'text' ? { type: 'text-delta', id, delta: text } : { type: 'reasoning-delta', id, delta: text })
    )
  }

  /** End the open text or reasoning part, so the next one starts after whatever part comes between. */
  private close(): string {
    const current = this.openPart
    if (!current) return ''
    this.openPart = undefined
    return sse({ type: current.kind === 'text' ? 'text-end' : 'reasoning-end', id: current.id })
  }
}
