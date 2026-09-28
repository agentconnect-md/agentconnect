// AG-UI over the agent chat API (shared-bot-relay.md §10.4): a `RunAgentInput` request in, one run's SSE events out.
import { AGENT_CHAT_ID_MAX_CHARS, type WebchatDone, type WebchatOutput } from '@agentconnect.md/protocol'
import type { ChatProtocol, ChatStreamEncoder } from './chat-stream-encoder.js'

export const RELAY_AG_UI_CHAT_PATH = '/ag-ui/agents/:agentId/chat'

/** The subset of `@ag-ui/core`'s events this encoder emits; the tests pin it to that type. */
export type AgUiEvent =
  | { type: 'RUN_STARTED'; threadId: string; runId: string }
  | { type: 'RUN_FINISHED'; threadId: string; runId: string; outcome?: { type: 'cancelled' } }
  | { type: 'RUN_ERROR'; message: string }
  | { type: 'TEXT_MESSAGE_START'; messageId: string; role: 'assistant' }
  | { type: 'TEXT_MESSAGE_CONTENT'; messageId: string; delta: string }
  | { type: 'TEXT_MESSAGE_END'; messageId: string }
  | { type: 'REASONING_START'; messageId: string }
  | { type: 'REASONING_MESSAGE_START'; messageId: string; role: 'reasoning' }
  | { type: 'REASONING_MESSAGE_CONTENT'; messageId: string; delta: string }
  | { type: 'REASONING_MESSAGE_END'; messageId: string }
  | { type: 'REASONING_END'; messageId: string }
  | { type: 'ACTIVITY_SNAPSHOT'; messageId: string; activityType: string; content: Record<string, unknown> }
  | { type: 'CUSTOM'; name: string; value: unknown }

// Plain SSE: AG-UI clients pick their parser by content type, and this one is not the protobuf media type.
export const AG_UI_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  'x-accel-buffering': 'no'
}

const sse = (event: AgUiEvent): string => `data: ${JSON.stringify(event)}\n\n`

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const boundedId = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= AGENT_CHAT_ID_MAX_CHARS ? value : undefined

/** The request's `threadId`, which names the conversation, or undefined when it has none. */
export function agUiThreadId(body: unknown): string | undefined {
  return isRecord(body) ? boundedId(body.threadId) : undefined
}

/** The turn's text: the last user message's content, or its text parts joined by newlines. */
export function agUiTurnText(body: unknown): string | undefined {
  if (!isRecord(body) || !Array.isArray(body.messages)) return undefined
  for (let i = body.messages.length - 1; i >= 0; i--) {
    const message: unknown = body.messages[i]
    if (!isRecord(message) || message.role !== 'user') continue
    const content = message.content
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .filter(
                (p): p is { type: 'text'; text: string } =>
                  isRecord(p) && p.type === 'text' && typeof p.text === 'string'
              )
              .map((p) => p.text)
              .join('\n')
          : undefined
    return text === undefined || text.trim() === '' ? undefined : text
  }
  return undefined
}

/** One run's AG-UI events. Message ids are prefixed by the turn, since a client keeps them unique across the thread. */
export class AgUiEventEncoder implements ChatStreamEncoder {
  readonly headers = AG_UI_HEADERS
  private openMessage?: { kind: 'text' | 'reasoning'; id: string; segmentId?: string }
  private messageSeq = 0
  private noticeSeq = 0
  // A `tool_update` carries only what changed, so each snapshot is rebuilt from the call's last full state.
  private readonly tools = new Map<string, { toolCallId: string; title: string; status: string }>()

  constructor(
    private readonly turnId: string,
    private readonly threadId: string,
    private readonly runId: string
  ) {}

  open(): string {
    return sse({ type: 'RUN_STARTED', threadId: this.threadId, runId: this.runId })
  }

  output(output: WebchatOutput): string {
    const ev = output.event
    if (!ev) return '' // a status-only snapshot has no event
    switch (ev.kind) {
      case 'message':
        return this.delta('text', ev.text, ev.segmentId)
      case 'thinking':
        return this.delta('reasoning', ev.text)
      case 'tool_call': {
        const tool = { toolCallId: ev.toolCallId, title: ev.title, status: ev.status }
        this.tools.set(ev.toolCallId, tool)
        return this.close() + this.activity(`tool:${ev.toolCallId}`, 'tool', tool)
      }
      case 'tool_update': {
        const prior = this.tools.get(ev.toolCallId)
        const tool = { toolCallId: ev.toolCallId, title: ev.title ?? prior?.title ?? '', status: ev.status }
        this.tools.set(ev.toolCallId, tool)
        return this.close() + this.activity(`tool:${ev.toolCallId}`, 'tool', tool)
      }
      case 'plan':
        // ACP resends the whole list, so one id replaces the activity in place.
        return this.close() + this.activity('plan', 'plan', { entries: ev.entries })
      case 'session_info':
        // A title is not conversation content, so it rides outside the message list.
        return sse({ type: 'CUSTOM', name: 'session_info', value: { title: ev.title } })
      case 'notice':
        // A wait notice replaces the last one (empty text clears it); a standing one stays.
        return (
          this.close() +
          (ev.standing
            ? this.activity(`notice-${++this.noticeSeq}`, 'notice', { text: ev.text, standing: true })
            : this.activity('notice', 'notice', { text: ev.text }))
        )
      default:
        return '' // elicitation, MCP App, and `superseded` kinds have no representation here
    }
  }

  done(done: WebchatDone): string {
    if (done.error !== undefined) return this.fail(done.error)
    return (
      this.close() +
      sse({
        type: 'RUN_FINISHED',
        threadId: this.threadId,
        runId: this.runId,
        ...(done.stopReason === 'cancelled' ? { outcome: { type: 'cancelled' as const } } : {})
      })
    )
  }

  fail(message: string): string {
    return this.close() + sse({ type: 'RUN_ERROR', message })
  }

  keepalive(): string {
    return ': keepalive\n\n'
  }

  private activity(key: string, activityType: string, content: Record<string, unknown>): string {
    return sse({ type: 'ACTIVITY_SNAPSHOT', messageId: `${this.turnId}:${key}`, activityType, content })
  }

  private delta(kind: 'text' | 'reasoning', text: string, segmentId?: string): string {
    if (text === '') return ''
    let out = ''
    const current = this.openMessage
    if (!current || current.kind !== kind || (segmentId !== undefined && current.segmentId !== segmentId)) {
      out += this.close()
      const id = `${this.turnId}:${kind}-${++this.messageSeq}`
      this.openMessage = { kind, id, ...(segmentId !== undefined ? { segmentId } : {}) }
      out +=
        kind === 'text'
          ? sse({ type: 'TEXT_MESSAGE_START', messageId: id, role: 'assistant' })
          : sse({ type: 'REASONING_START', messageId: id }) +
            sse({ type: 'REASONING_MESSAGE_START', messageId: id, role: 'reasoning' })
    }
    const messageId = this.openMessage!.id
    return (
      out +
      sse(
        kind === 'text'
          ? { type: 'TEXT_MESSAGE_CONTENT', messageId, delta: text }
          : { type: 'REASONING_MESSAGE_CONTENT', messageId, delta: text }
      )
    )
  }

  /** End the open text or reasoning message, so the next one starts after whatever comes between. */
  private close(): string {
    const current = this.openMessage
    if (!current) return ''
    this.openMessage = undefined
    return current.kind === 'text'
      ? sse({ type: 'TEXT_MESSAGE_END', messageId: current.id })
      : sse({ type: 'REASONING_MESSAGE_END', messageId: current.id }) +
          sse({ type: 'REASONING_END', messageId: current.id })
  }
}

/** AG-UI: the `threadId` names the conversation; the `runId` is only echoed, falling back to the turn when unusable. */
export const AG_UI_CHAT_PROTOCOL: ChatProtocol = {
  id: 'ag-ui',
  path: RELAY_AG_UI_CHAT_PATH,
  chatIdName: 'threadId',
  chatId: agUiThreadId,
  text: agUiTurnText,
  encoder: (turnId, body) =>
    new AgUiEventEncoder(turnId, agUiThreadId(body) ?? turnId, (isRecord(body) && boundedId(body.runId)) || turnId)
}
