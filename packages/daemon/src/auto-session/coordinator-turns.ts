// A coordinator turn's delivered messages and the one outcome each may take (auto-session-mode.md §4.2–§4.5).
import type { NormalizedMessage } from '../messages/normalized.js'
import { coordinatorMessageId, type CoordinatorMessage } from './coordinator-prompt.js'

/** One message a coordinator turn decides on, with what acting on it needs. */
export interface DeliveredMessage {
  /** The {@link coordinatorMessageId} the model names it by. */
  id: string
  msg: NormalizedMessage
  integrationId?: string
  mentionsYou: boolean
}

/** What a message's one call did. */
export type CoordinatorOutcome = 'delegate' | 'route' | 'reply'

interface Turn {
  messages: DeliveredMessage[]
  outcomes: Map<string, CoordinatorOutcome | 'pending'>
  /** The text after the turn's last tool call, which a one-message turn answers with. */
  tail: string
}

/** How a turn ended for its messages without an outcome. */
export interface SettledCoordinatorTurn {
  messages: DeliveredMessage[]
  /** A one-message turn's final text, when it is a reply rather than silence. */
  reply?: string
  /** Messages left without an outcome. */
  undecided: DeliveredMessage[]
}

/** The platform message id inside a normalized message id (`slack:<channel>:<ts>` → `<ts>`). */
export function platformMessageIdOf(msg: Pick<NormalizedMessage, 'msgId' | 'transcriptTs'>): string {
  return msg.transcriptTs ?? msg.msgId.split(':').at(-1) ?? msg.msgId
}

/** Whether a message sits in a thread under another message, rather than at the conversation root. */
export function inThread(msg: Pick<NormalizedMessage, 'thread' | 'msgId' | 'transcriptTs'>): boolean {
  return msg.thread !== undefined && msg.thread !== platformMessageIdOf(msg)
}

/** The thread a message's replies go to: its own thread, or the one it starts at the root. */
export function replyThreadOf(msg: Pick<NormalizedMessage, 'thread' | 'msgId' | 'transcriptTs'>): string {
  return msg.thread ?? platformMessageIdOf(msg)
}

/** The message as the coordinator's batch shows it. */
export function coordinatorView(message: DeliveredMessage, text: string): CoordinatorMessage {
  const { msg } = message
  return {
    id: message.id,
    from: msg.sender.id,
    mentionsYou: message.mentionsYou,
    text,
    ...(inThread(msg) ? { thread: coordinatorMessageId(msg.thread!) } : {})
  }
}

/** Every coordinator session's live turn, keyed by the session key. */
export class CoordinatorTurns {
  private readonly turns = new Map<string, Turn>()

  /** Open a turn on its batch, replacing any turn the session left behind. */
  begin(key: string, messages: DeliveredMessage[]): void {
    this.turns.set(key, { messages, outcomes: new Map(), tail: '' })
  }

  has(key: string): boolean {
    return this.turns.has(key)
  }

  /** Text the model streamed; a tool call starts the tail over. */
  noteText(key: string, text: string): void {
    const turn = this.turns.get(key)
    if (turn) turn.tail += text
  }

  noteToolCall(key: string): void {
    const turn = this.turns.get(key)
    if (turn) turn.tail = ''
  }

  /** Hold a message for one call, or say why the call may not act on it. */
  reserve(key: string, messageId: string): { message: DeliveredMessage } | { error: string } {
    const turn = this.turns.get(key)
    if (!turn) return { error: 'no channel message is waiting for a decision in this turn; nothing was done' }
    const message = turn.messages.find((candidate) => candidate.id === messageId)
    if (!message) {
      const ids = turn.messages.map((candidate) => candidate.id).join(', ')
      return {
        error: `messageId ${messageId} is not a message delivered in this turn; copy one of these ids exactly: ${ids}`
      }
    }
    if (turn.outcomes.has(messageId))
      return { error: `message ${messageId} already has an outcome; each message takes one, so nothing more was done` }
    turn.outcomes.set(messageId, 'pending')
    return { message }
  }

  /** Record the outcome a reserved message took. */
  settle(key: string, messageId: string, outcome: CoordinatorOutcome): void {
    this.turns.get(key)?.outcomes.set(messageId, outcome)
  }

  /** Give back a reservation whose call failed, so the message can still be decided. */
  release(key: string, messageId: string): void {
    const turn = this.turns.get(key)
    if (turn?.outcomes.get(messageId) === 'pending') turn.outcomes.delete(messageId)
  }

  /** Close the turn and report what it left undecided; `silent` is a sentinel test for the final text. */
  end(key: string, silent: (text: string) => boolean): SettledCoordinatorTurn | undefined {
    const turn = this.turns.get(key)
    if (!turn) return undefined
    this.turns.delete(key)
    const undecided = turn.messages.filter((message) => !turn.outcomes.has(message.id))
    const text = turn.tail.trim()
    // A turn's final text answers its message only when there is exactly one (§4.3).
    const reply = turn.messages.length === 1 && undecided.length === 1 && text && !silent(text) ? text : undefined
    return { messages: turn.messages, undecided, ...(reply !== undefined ? { reply } : {}) }
  }
}
