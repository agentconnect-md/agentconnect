// A coordinator turn's delivered messages and the one outcome each may take (auto-session-mode.md §4.2–§4.5).
import type { CallMeta } from '../daemon/turn-types.js'
import type { NormalizedMessage } from '../messages/normalized.js'
import { coordinatorMessageId, type CoordinatorMessage, type ReportAbout } from './coordinator-prompt.js'

/** One message a coordinator turn decides on, with what acting on it needs. */
export interface DeliveredMessage {
  /** The {@link coordinatorMessageId} the model names it by. */
  id: string
  msg: NormalizedMessage
  integrationId?: string
  mentionsYou: boolean
  /** A report, a follow-up's result or another agent's answer rather than a channel message: it is answered, never handed to a task (§3.4). */
  report?: true
  /** What a report speaks for, which its block names. */
  about?: ReportAbout
  /** Its turn streams to a webchat browser, which commits the turn's text as the reply. */
  streamed?: true
}

/** What a message's one call did. */
export type CoordinatorOutcome = 'delegate' | 'route' | 'reply' | 'ignore'

interface Turn {
  messages: DeliveredMessage[]
  outcomes: Map<string, CoordinatorOutcome | 'pending'>
  /** The text after the turn's last tool call, which answers the message left without a call. */
  tail: string
  /** Takes back what shows the turn's messages are being decided (§4.4). */
  clearFeedback: () => void
}

/** How a turn ended for its messages without an outcome. */
export interface SettledCoordinatorTurn {
  messages: DeliveredMessage[]
  /** Messages left without an answer: those no call decided, and those `ignoreMessage` left. */
  undecided: DeliveredMessage[]
}

/** A turn's final text with the message it answers. */
export interface SpokenReply {
  to: DeliveredMessage
  text: string
}

/** The message a turn's text answers: the one person's message left without a call, else the one of those that mentions the agent; never a report (§4.3). */
export function spokenTo<T extends { report?: boolean; mentionsYou: boolean }>(undecided: readonly T[]): T | undefined {
  const people = undecided.filter((message) => !message.report)
  if (people.length === 1) return people[0]
  const mentions = people.filter((message) => message.mentionsYou)
  return mentions.length === 1 ? mentions[0] : undefined
}

type MessageIdentity = Pick<NormalizedMessage, 'msgId' | 'transcriptTs' | 'transcriptPostId'>

/** The platform message id inside a normalized message id (`slack:<channel>:<ts>` → `<ts>`); a webchat post is named by its post id. */
export function platformMessageIdOf(msg: MessageIdentity): string {
  return msg.transcriptPostId ?? msg.transcriptTs ?? msg.msgId.split(':').at(-1) ?? msg.msgId
}

/** Whether a webchat message has no thread, as only a post-less console message has, so its task continues on its own page (webchat-threads.md §5.1). */
export function threadless(msg: Pick<NormalizedMessage, 'platform' | 'thread'>): boolean {
  return msg.platform === 'webchat' && msg.thread === undefined
}

/** Whether a room is one thread named after it, as a platform keys a room of its own (a task's place, auto-session-mode.md §6.8): it has no root to coordinate. */
export function wholeRoomThread(msg: {
  channel: string
  thread?: string
  isDm?: boolean
  isGroupDm?: boolean
}): boolean {
  return !msg.isDm && msg.isGroupDm !== true && msg.thread === msg.channel
}

/** Whether a message sits in a thread under another message, rather than at the conversation root. */
export function inThread(msg: Pick<NormalizedMessage, 'thread'> & MessageIdentity): boolean {
  return msg.thread !== undefined && msg.thread !== platformMessageIdOf(msg)
}

/** The thread a message's replies go to: its own thread, or the one it starts at the root; a threadless message's own id stands for one. */
export function replyThreadOf(msg: Pick<NormalizedMessage, 'thread'> & MessageIdentity): string {
  return msg.thread ?? platformMessageIdOf(msg)
}

/** Where an answer to a delivered entry goes: a channel message's thread, the root for a threadless one, else a report's reply thread. */
export function answerThreadOf(
  msg: Pick<NormalizedMessage, 'source' | 'thread' | 'platform'> & MessageIdentity
): string | undefined {
  if (msg.source !== 'user') return msg.thread
  return threadless(msg) ? undefined : replyThreadOf(msg)
}

/** The message as the coordinator's batch shows it. */
export function coordinatorView(message: DeliveredMessage, text: string): CoordinatorMessage {
  const { msg } = message
  if (message.report)
    return { id: message.id, from: msg.sender.id, mentionsYou: false, text, report: true, ...message.about }
  return {
    id: message.id,
    from: msg.sender.id,
    mentionsYou: message.mentionsYou,
    text,
    ...(inThread(msg) ? { thread: coordinatorMessageId(msg.thread!) } : {})
  }
}

/** How a coordinator's queue is cut into batches: entries that take a turn of their own, reports, and each message's permission class. */
export interface BatchRules<T> {
  /** It never joins a batch nor takes one: a webchat message, whose reply streams to its own browser turn (§10). */
  ownTurn(entry: T): boolean
  /** Anything else no person sent, such as a getting-to-know report, whose turn's metadata it needs: it heads a turn and so ends the batch before it (§3.4). */
  heads(entry: T): boolean
  /** A report with no turn metadata: it joins the batch it arrives in and brings no class (assistant-mode.md §5.18 ④). */
  report(entry: T): boolean
  classOf(entry: T): Promise<string>
}

/** How many of the queued entries join the head's batch: the messages of its class and the reports among them, in arrival order and never reordered (assistant-mode.md §5.18 ③). */
export async function batchCut<T>(head: T, queued: readonly T[], rules: BatchRules<T>): Promise<number> {
  if (rules.ownTurn(head)) return 0
  let batchClass: string | undefined
  let taken = 0
  for (const next of queued) {
    if (rules.ownTurn(next) || rules.heads(next)) break
    if (!rules.report(next)) {
      const nextClass = await rules.classOf(next)
      // An entry no person sent brings no class of its own: the first message of its batch sets it.
      batchClass ??= rules.heads(head) || rules.report(head) ? nextClass : await rules.classOf(head)
      if (nextClass !== batchClass) break
    }
    taken += 1
  }
  return taken
}

/** Whether a queued entry is a report that joins a coordinator's batch: one no turn metadata rides on, as a getting-to-know report's proposals or a place's opening do (assistant-mode.md §5.18 ④). */
export function reportJoinsBatch(
  msg: Pick<NormalizedMessage, 'source' | 'parentReport'>,
  callMeta: CallMeta | undefined
): boolean {
  return (
    msg.source !== 'user' &&
    msg.parentReport === true &&
    callMeta?.gettingToKnowReport === undefined &&
    callMeta?.opensPlace !== true
  )
}

/** What a report's block names beside its id: the task it speaks for, or that it is another agent's answer. */
export function reportAboutOf(
  agentId: string,
  msg: Pick<NormalizedMessage, 'source'>,
  callMeta: Pick<CallMeta, 'reportOf' | 'callFrom'> | undefined
): ReportAbout | undefined {
  if (msg.source === 'user') return undefined
  const of = callMeta?.reportOf
  if (of) return { task: of.taskId, kind: of.kind, ...(of.title ? { title: of.title } : {}) }
  const from = callMeta?.callFrom
  return from !== undefined && from !== agentId ? { kind: 'agent answer' } : undefined
}

/** Every coordinator session's live turn, keyed by the session key. */
export class CoordinatorTurns {
  private readonly turns = new Map<string, Turn>()

  /** Open a turn on its batch, replacing any turn the session left behind; `clearFeedback` runs once the turn ends. */
  begin(key: string, messages: DeliveredMessage[], clearFeedback: () => void = () => {}): void {
    this.turns.get(key)?.clearFeedback()
    this.turns.set(key, { messages, outcomes: new Map(), tail: '', clearFeedback })
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

  /** A delivered message of the live turn, without holding it; undefined when the turn has none by that id. */
  find(key: string, messageId: string): DeliveredMessage | undefined {
    return this.turns.get(key)?.messages.find((candidate) => candidate.id === messageId)
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

  /** Take the live turn's final text with the message it answers, when it is a reply rather than silence (§4.3); `silent` is a sentinel test, and the text is taken once. */
  takeSpoken(key: string, silent: (text: string) => boolean): SpokenReply | undefined {
    const turn = this.turns.get(key)
    const text = turn?.tail.trim()
    if (!turn || !text) return undefined
    turn.tail = ''
    if (silent(text)) return undefined
    const undecided = turn.messages.filter((message) => !turn.outcomes.has(message.id))
    const to = spokenTo(undecided)
    return to ? { to, text } : undefined
  }

  /** Close the turn and report what it left undecided. */
  end(key: string): SettledCoordinatorTurn | undefined {
    const turn = this.turns.get(key)
    if (!turn) return undefined
    this.turns.delete(key)
    turn.clearFeedback()
    const unanswered = (message: DeliveredMessage): boolean => (turn.outcomes.get(message.id) ?? 'ignore') === 'ignore'
    return { messages: turn.messages, undecided: turn.messages.filter(unanswered) }
  }
}
