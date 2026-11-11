// WeCom's elicitation-card facet: a template card answered by a tap, else a numbered Markdown card answered by quoting its tag.
import { randomBytes } from 'node:crypto'
import { elicitFormBlockId } from '@agentconnect.md/protocol'
import type { CreateElicitationRequest } from '@agentclientprotocol/sdk/unstable'
import type {
  ElicitCardAsk,
  ElicitCardDraft,
  ElicitCardFacet,
  ElicitCardHandle,
  ElicitCardHost,
  ElicitCardMark,
  ElicitCardReply,
  ElicitCardSettlement,
  ElicitCardTap,
  ElicitCardTapTarget,
  ElicitCardTurn
} from '../elicit-card.js'
import {
  clampTo,
  elicitOptionToken,
  type ElicitKind,
  type ElicitSurface,
  type ElicitTarget
} from '../../slack/render.js'
import type { WeComQuestionPort } from './connection.js'
import type { WeComTurnState } from './turn-output.js'

// A button card holds at most 6 buttons and a vote card at most 20 options (template card types, path 101032).
export const WECOM_CARD_MAX_BUTTONS = 6
export const WECOM_CARD_MAX_OPTIONS = 20
// `main_title.title` is advised at 26 characters and `sub_title_text` at 112 (path 101032).
const WECOM_CARD_TITLE_CAP = 26
export const WECOM_CARD_QUESTION_CAP = 112
// Conservative choice: the doc advises 10 to 11 characters per option, so labels are clipped at 20 and a clash sends the text card.
const WECOM_CARD_OPTION_CAP = 20
const WECOM_ELICIT_DECISION_CAP = 300
const WECOM_TEXT_QUESTION_CAP = 4_000

const WECOM_ELICIT_MARK: Record<ElicitCardMark, string> = {
  answered: '✅',
  dismissed: '🚫',
  waiting: '⏳',
  blocked: '🔒'
}

// Single choice and yes/no only: one tap or one quoted number answers them whole; other asks keep the decline notice.
export const WECOM_ELICIT_SURFACE: ElicitSurface = {
  kinds: new Set<ElicitKind>(['enum', 'boolean']),
  optionLimits: { enum: { maxOptions: WECOM_CARD_MAX_OPTIONS } }
}

/** How a question card is laid out: two buttons, up to six buttons, or a single-choice vote with a submit button. */
export type WeComCardLayout = 'yesno' | 'buttons' | 'vote'

/** A tap card a build chose: its `task_id`, which names the layout and the request, and the `template_card` body. */
export interface WeComQuestionCard {
  taskId: string
  card: Record<string, unknown>
}

// A task_id may hold letters, digits and `_-@`, at most 128 bytes, unique per bot (path 101032); the request id is a UUID.
const TASK_ID = /^acq-(y|b|v)-([\w-]{1,64})$/
const BUTTON_KEY = /^o(\d{1,2})$/
const VOTE_QUESTION_KEY = 'choice'
const VOTE_SUBMIT_KEY = 'submit'

function taskLayout(taskId: string | undefined): { layout: WeComCardLayout; requestId: string } | null {
  const match = taskId === undefined ? null : TASK_ID.exec(taskId)
  if (!match) return null
  const layout = match[1] === 'y' ? 'yesno' : match[1] === 'b' ? 'buttons' : 'vote'
  return { layout, requestId: match[2]! }
}

/** Whether a card handle names a template card this daemon sent, rather than a numbered text card's tag. */
export function isWeComCardTask(ts: string | undefined): boolean {
  return taskLayout(ts) !== null
}

/** The layout a question takes as a template card, or null when only the numbered text card can ask it. */
export function weComCardLayout(target: ElicitTarget): WeComCardLayout | null {
  if (target.kind === 'boolean') return target.options.length === 2 ? 'yesno' : null
  if (target.kind !== 'enum' || !target.options.length) return null
  if (target.options.length <= WECOM_CARD_MAX_BUTTONS) return 'buttons'
  return target.options.length <= WECOM_CARD_MAX_OPTIONS ? 'vote' : null
}

// The card's header: the agent's name as the title, and the question as the second-level text.
function heading(agentName: string, question: string): Record<string, unknown> {
  return { main_title: { title: clampTo(agentName, WECOM_CARD_TITLE_CAP) || 'Question' }, sub_title_text: question }
}

/** The template card for one question, or null when its question or options do not fit WeCom's card. */
export function weComQuestionCard(
  requestId: string,
  agentName: string,
  question: string,
  target: ElicitTarget
): WeComQuestionCard | null {
  const layout = weComCardLayout(target)
  const asked = question.trim()
  // A question longer than the card's text is asked whole by the numbered text card instead.
  if (!layout || !asked || asked.length > WECOM_CARD_QUESTION_CAP || !/^[\w-]{1,64}$/.test(requestId)) return null
  const labels = target.options.map((o) => clampTo(o.label, WECOM_CARD_OPTION_CAP))
  if (labels.some((label) => !label) || new Set(labels).size !== labels.length) return null
  const tag = layout === 'yesno' ? 'y' : layout === 'buttons' ? 'b' : 'v'
  const taskId = `acq-${tag}-${requestId}`
  if (layout === 'vote')
    return {
      taskId,
      card: {
        card_type: 'vote_interaction',
        ...heading(agentName, asked),
        checkbox: {
          question_key: VOTE_QUESTION_KEY,
          mode: 0,
          option_list: labels.map((text, i) => ({ id: `o${i}`, text }))
        },
        submit_button: { text: 'Submit', key: VOTE_SUBMIT_KEY },
        task_id: taskId
      }
    }
  return {
    taskId,
    card: {
      card_type: 'button_interaction',
      ...heading(agentName, asked),
      button_list: labels.map((text, i) => ({ text, key: `o${i}` })),
      task_id: taskId
    }
  }
}

/** One tap on a question card, as the connection hands it to core; `token` is null for a tap that names no option. */
export interface WeComCardTap {
  taskId: string
  requestId: string
  token: string | null
  userId: string
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined ? [] : [value]
}

// The option a vote submitted: its own selector's first option id, reading `option_ids.option_id` or a bare list.
function votedOption(selected: unknown): string | undefined {
  const items = list(record(selected)?.selected_item ?? selected)
  for (const item of items) {
    const entry = record(item)
    if (entry?.question_key !== VOTE_QUESTION_KEY) continue
    const ids = record(entry.option_ids)?.option_id ?? entry.option_ids
    return text(list(ids)[0])
  }
  return undefined
}

/** Read one `template_card_event` callback body; null when it is not a tap on a question card this daemon sent. */
export function weComCardTap(body: Record<string, unknown>): WeComCardTap | null {
  const event = record(body.event)
  if (event?.eventtype !== 'template_card_event') return null
  // The doc nests the fields under `template_card_event`; the official SDK reads them from `event` itself, so both are read.
  const data = record(event.template_card_event) ?? event
  const taskId = text(data.task_id) ?? text(data.taskid)
  const track = taskLayout(taskId)
  const userId = text(record(body.from)?.userid)
  if (!track || !userId) return null
  const key = text(data.event_key) ?? text(data.eventkey)
  const option =
    track.layout === 'vote' ? (key === VOTE_SUBMIT_KEY ? votedOption(data.selected_items) : undefined) : key
  const index = option === undefined ? null : BUTTON_KEY.exec(option)
  return {
    taskId: taskId!,
    requestId: track.requestId,
    token: index ? elicitOptionToken(Number(index[1])) : null,
    userId
  }
}

/** The card that replaces a settled one for every viewer: a text notice with the outcome and the question, and no control. */
export function weComSettledCard(taskId: string, card: ElicitCardSettlement): Record<string, unknown> {
  const said = `${WECOM_ELICIT_MARK[card.mark]} ${card.text}`
  // Conservative choice: the official SDK's own update example replaces a tapped card with a `text_notice` and no `card_action`.
  return {
    card_type: 'text_notice',
    main_title: { title: clampTo(said, WECOM_CARD_TITLE_CAP) },
    sub_title_text: clampTo(questionOf(card.params), WECOM_CARD_QUESTION_CAP),
    task_id: taskId
  }
}

// A group delivers only messages that mention the bot, so the instruction says so there.
export function weComElicitInstruction(channel: string): string {
  return channel.startsWith('dm:')
    ? 'Quote this message and reply with a number.'
    : 'Quote this message and reply with a number, mentioning the bot.'
}

/** A fresh tag a quote of the numbered card brings back; WeCom's quote names no message, so the card's own text must. */
export function weComQuestionTag(): string {
  return `Q-${randomBytes(4).toString('hex').toUpperCase()}`
}

/** The numbered Markdown card: the question, every option, and the instruction with the card's tag. */
export function weComElicitText(message: string, target: ElicitTarget, channel: string, tag: string): string {
  return [
    `💬 ${clampTo(message, WECOM_TEXT_QUESTION_CAP)}`,
    '',
    ...target.options.map((o, i) => `${i + 1}. ${o.label}`),
    '',
    `${weComElicitInstruction(channel)} (${tag})`
  ].join('\n')
}

function choiceOf(target: ElicitTarget, said: string): number | null {
  if (/^\d{1,2}$/.test(said)) {
    const n = Number(said)
    return n >= 1 && n <= target.options.length ? n - 1 : null
  }
  const index = target.options.findIndex(
    (o) => o.label.normalize('NFKC').toLowerCase() === said || o.value.normalize('NFKC').toLowerCase() === said
  )
  return index >= 0 ? index : null
}

// The option a reply names: its number, label or value after NFKC; a group reply's leading mention is skipped word by word.
export function weComElicitChoice(target: ElicitTarget, reply: string): number | null {
  const said = reply.normalize('NFKC').trim().toLowerCase()
  const direct = choiceOf(target, said)
  if (direct !== null || !said.startsWith('@')) return direct
  // The bot's display name is unknown here and may hold spaces, so each later word boundary is tried, longest rest first.
  for (let at = said.search(/\s/); at >= 0;) {
    const index = choiceOf(target, said.slice(at).trim())
    if (index !== null) return index
    const next = said.slice(at + 1).search(/\s/)
    at = next < 0 ? -1 : at + 1 + next
  }
  return null
}

// The question text core gave the card, re-derived from its params the way core derives it.
function questionOf(params: CreateElicitationRequest): string {
  return (params as { message?: string }).message?.trim() || 'The agent needs your input'
}

interface WeComElicitDraft {
  card: WeComQuestionCard | null
  text: string
  tag: string
}

// The text cards a quote reply answered, whose reply already shows the choice.
const answeredInChat = new WeakSet<ElicitCardHandle>()

function questionPort(handle: ElicitCardHandle): Partial<WeComQuestionPort> | undefined {
  return handle.conn as Partial<WeComQuestionPort> | undefined
}

function follow(handle: ElicitCardHandle, message: string): void {
  if (handle.ts === undefined) return
  void questionPort(handle)
    ?.sendText?.(handle.channel, message)
    .catch(() => false)
}

function outcome(card: ElicitCardSettlement): string {
  const said = `${WECOM_ELICIT_MARK[card.mark]} ${clampTo(card.text, WECOM_ELICIT_DECISION_CAP)}`
  return `💬 ${clampTo(questionOf(card.params), WECOM_CARD_QUESTION_CAP)}\n${said}`
}

export const weComElicitCards: ElicitCardFacet = {
  platform: 'wecom',
  reduction: WECOM_ELICIT_SURFACE,

  // Both cards are built up front, so a template card WeCom refuses still asks with the numbered text card.
  build(_host: ElicitCardHost, turn: ElicitCardTurn, ask: ElicitCardAsk): ElicitCardDraft | null {
    const target = ask.form?.length === 1 ? ask.form[0]! : undefined
    if (ask.url || !target?.options.length) return null
    const tag = weComQuestionTag()
    const draft: WeComElicitDraft = {
      card: weComQuestionCard(ask.requestId, turn.plan.agentName, ask.message, target),
      text: weComElicitText(ask.message, target, turn.plan.channel, tag),
      tag
    }
    return draft
  },

  // Sent proactively, not under the turn's req_id: the answer stream holds that one, and a turn may ask more than once.
  async send(host: ElicitCardHost, turn: ElicitCardTurn, _ask: ElicitCardAsk, draft: ElicitCardDraft) {
    const state = host.turnState(turn) as WeComTurnState
    const conn = state.conn as (WeComTurnState['conn'] & Partial<WeComQuestionPort>) | undefined
    if (!conn?.sendQuestionCard || !conn.sendText) return undefined
    const { card, text, tag } = draft as WeComElicitDraft
    return await host.postCardSerialized(turn, async () => {
      // The answer so far is closed above the card, so what the agent writes after it reads below it.
      await state.stream?.seal()
      if (card && (await conn.sendQuestionCard!(state.channel, card.card))) return card.taskId
      conn.noteQuestionTag?.(state.channel, tag)
      if (await conn.sendText!(state.channel, text)) return tag
      conn.retireQuestionTag?.(tag)
      return undefined
    })
  },

  // Only a quote carrying THIS text card's tag answers it; a quote naming no option gets the instruction again.
  claimReply(handle: ElicitCardHandle, card: ElicitCardTapTarget, reply: ElicitCardReply): ElicitCardTap | null {
    if (handle.ts === undefined || isWeComCardTask(handle.ts) || reply.replyTo !== handle.ts) return null
    const target = card.form.length === 1 ? card.form[0]! : undefined
    if (!target) return null
    const index = weComElicitChoice(target, reply.text)
    if (index === null) {
      follow(handle, `Quote the question and reply with a number from 1 to ${target.options.length}.`)
      return { kind: 'pending' }
    }
    answeredInChat.add(handle)
    return { kind: 'submit', fields: { [elicitFormBlockId(0)]: elicitOptionToken(index) } }
  },

  // A tapped card is replaced in place under the tap's req_id; any other close-out is a new message, as WeCom updates only on a tap.
  settle(handle: ElicitCardHandle, card: ElicitCardSettlement): void {
    const ts = handle.ts
    if (ts === undefined) return
    const port = questionPort(handle)
    if (isWeComCardTask(ts)) {
      const replaced = port?.closeQuestionCard?.(ts, handle.channel, weComSettledCard(ts, card))
      void Promise.resolve(replaced)
        .then((done) => {
          if (!done) follow(handle, outcome(card))
        })
        .catch(() => follow(handle, outcome(card)))
      return
    }
    port?.retireQuestionTag?.(ts)
    if (card.mark === 'answered' && answeredInChat.has(handle)) return
    follow(handle, outcome(card))
  }
}
