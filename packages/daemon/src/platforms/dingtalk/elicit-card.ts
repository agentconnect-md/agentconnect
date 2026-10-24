// DingTalk's elicitation-card facet (dingtalk-integration.md §4.6): a tap card from the project's template, else a numbered text card answered by quoting it.
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
  elicitForm,
  elicitOptionToken,
  type ElicitKind,
  type ElicitSurface,
  type ElicitTarget
} from '../../slack/render.js'
import { DINGTALK_MSG_PARAM_MAX_BYTES } from './api.js'
import type { DingTalkReplyPort } from './connection.js'
import type { DingTalkTurnState } from './turn-output.js'

// Twelve numbered options keep the card short enough to read and to answer by number.
const DINGTALK_ELICIT_MAX_OPTIONS = 12
const DINGTALK_ELICIT_DECISION_CAP = 300
// Up to four options fit as buttons; more go in the card's select.
const DINGTALK_CARD_MAX_BUTTONS = 4
const DINGTALK_CARD_PROMPT_CAP = 2000
const DINGTALK_CARD_LABEL_CAP = 60
const DINGTALK_CARD_BUTTON_CAP = 40

const DINGTALK_ELICIT_MARK: Record<ElicitCardMark, string> = {
  answered: '✅',
  dismissed: '🚫',
  waiting: '⏳',
  blocked: '🔒'
}

// Single choice and yes/no only: one quoted number answers them whole; other asks keep the decline notice.
export const DINGTALK_ELICIT_SURFACE: ElicitSurface = {
  kinds: new Set<ElicitKind>(['enum', 'boolean']),
  optionLimits: { enum: { maxOptions: DINGTALK_ELICIT_MAX_OPTIONS } }
}

// Replying in a group mentions the bot for the user, so groups and DMs share one instruction (§4.1).
const DINGTALK_ELICIT_INSTRUCTION = 'Reply to this message with a number or an option.'

// UTF-8 bytes of `text` once JSON-encoded, the unit DingTalk's msgParam limit counts.
function jsonBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text)) - 2
}

function clampJsonBytes(text: string, max: number): string {
  if (jsonBytes(text) <= max) return text
  let out = ''
  let used = 0
  for (const character of text) {
    const size = jsonBytes(character)
    if (used + size > max - 3) break
    out += character
    used += size
  }
  return `${out}…`
}

export function dingTalkElicitText(message: string, target: ElicitTarget): string | null {
  const tail = ['', ...target.options.map((o, i) => `${i + 1}. ${o.label}`), '', DINGTALK_ELICIT_INSTRUCTION].join('\n')
  // The send wraps the text as `{"content": …}`; keep the whole card one message.
  const budget = DINGTALK_MSG_PARAM_MAX_BYTES - jsonBytes(tail) - jsonBytes('💬 ') - Buffer.byteLength('{"content":""}')
  if (budget < 64) return null
  return `💬 ${clampJsonBytes(message, budget)}${tail}`
}

// The option a reply names: its 1-based number or its own label or value, compared after NFKC so full-width digits count.
export function dingTalkElicitChoice(target: ElicitTarget, text: string): number | null {
  const said = text.normalize('NFKC').trim().toLowerCase()
  if (/^\d{1,2}$/.test(said)) {
    const n = Number(said)
    return n >= 1 && n <= target.options.length ? n - 1 : null
  }
  const index = target.options.findIndex(
    (o) => o.label.normalize('NFKC').toLowerCase() === said || o.value.normalize('NFKC').toLowerCase() === said
  )
  return index >= 0 ? index : null
}

/** How the question template lays a card out: yes/no buttons, up to four buttons, or a select with a submit button. */
export type DingTalkCardLayout = 'yesno' | 'buttons' | 'form'

/** A tap card a build chose: its `outTrackId` and template variables. */
export interface DingTalkQuestionCard {
  outTrackId: string
  params: Record<string, string>
}

interface DingTalkElicitDraft {
  /** The numbered text card, sent when the tap card is not delivered; null when it cannot fit. */
  text: string | null
  card: DingTalkQuestionCard | null
}

// The `outTrackId` names the layout and the request, so a callback maps back without any state; a yes/no tag also names its two options.
const CARD_TRACK = /^acq-(b|f|y(\d)(\d))-([\w-]{1,48})$/

interface DingTalkCardTrack {
  layout: DingTalkCardLayout
  requestId: string
  /** The core option index behind a yes/no card's left and right button. */
  yesno?: [number, number]
}

function cardTrack(outTrackId: string | undefined): DingTalkCardTrack | null {
  const match = outTrackId === undefined ? null : CARD_TRACK.exec(outTrackId)
  if (!match) return null
  const tag = match[1]!
  if (tag === 'b') return { layout: 'buttons', requestId: match[4]! }
  if (tag === 'f') return { layout: 'form', requestId: match[4]! }
  return { layout: 'yesno', requestId: match[4]!, yesno: [Number(match[2]), Number(match[3])] }
}

/** The layout a question takes on the tap card, or null when only the text card can ask it. */
export function dingTalkCardLayout(target: ElicitTarget): DingTalkCardLayout | null {
  if (target.kind === 'boolean') return target.options.length === 2 ? 'yesno' : null
  if (target.kind !== 'enum' || !target.options.length) return null
  if (target.options.length <= DINGTALK_CARD_MAX_BUTTONS) return 'buttons'
  return target.options.length <= DINGTALK_ELICIT_MAX_OPTIONS ? 'form' : null
}

// The form protocol's one select field; each option's value is its core index, and a settled card shows the choice.
function questionForm(question: string, target: ElicitTarget, chosen?: number): string {
  const field = {
    name: 'choice',
    label: clampTo(question, DINGTALK_CARD_PROMPT_CAP),
    type: 'SELECT',
    required: true,
    options: target.options.map((o, i) => ({ value: String(i), text: clampTo(o.label, DINGTALK_CARD_LABEL_CAP) })),
    ...(chosen !== undefined ? { defaultValue: { index: chosen, value: String(chosen) } } : {})
  }
  return JSON.stringify({ fields: [field] })
}

/** A channel post that mentions people, on the question template: the text as its body and no buttons (§4.2). */
export function dingTalkMentionCard(title: string, text: string): Record<string, string> {
  const opts = Object.fromEntries(Array.from({ length: DINGTALK_CARD_MAX_BUTTONS }, (_, slot) => [`opt${slot}`, '']))
  return {
    title: clampTo(title, DINGTALK_CARD_LABEL_CAP) || 'Message',
    lastMessage: clampTo(text, DINGTALK_CARD_LABEL_CAP),
    layout: 'buttons',
    prompt: clampTo(text, DINGTALK_CARD_PROMPT_CAP),
    ...opts,
    answer: ''
  }
}

/** The tap card for one question: the template variables per layout, or null when the layout does not fit it. */
export function dingTalkQuestionCard(
  requestId: string,
  agentName: string,
  question: string,
  target: ElicitTarget
): DingTalkQuestionCard | null {
  const layout = dingTalkCardLayout(target)
  if (!layout || !/^[\w-]{1,48}$/.test(requestId)) return null
  const base = {
    title: clampTo(agentName, DINGTALK_CARD_LABEL_CAP) || 'Question',
    lastMessage: clampTo(`💬 ${question}`, DINGTALK_CARD_LABEL_CAP),
    layout,
    prompt: clampTo(question, DINGTALK_CARD_PROMPT_CAP)
  }
  if (layout === 'form')
    return {
      outTrackId: `acq-f-${requestId}`,
      params: { ...base, form: questionForm(question, target), form_status: 'normal', form_btn_text: 'Submit' }
    }
  const label = (index: number) => clampTo(target.options[index]?.label ?? '', DINGTALK_CARD_BUTTON_CAP)
  const slots = Array.from({ length: DINGTALK_CARD_MAX_BUTTONS }, (_, slot) => `opt${slot}`)
  if (layout === 'yesno') {
    // The template's left button refuses and its right button accepts.
    const no = target.options.findIndex((o) => o.value === 'false')
    const yes = target.options.findIndex((o) => o.value === 'true')
    if (no < 0 || yes < 0) return null
    const opts = Object.fromEntries(slots.map((slot) => [slot, '']))
    return {
      outTrackId: `acq-y${no}${yes}-${requestId}`,
      params: { ...base, ...opts, opt0: label(no), opt1: label(yes), answer: '' }
    }
  }
  const opts = Object.fromEntries(slots.map((slot, i) => [slot, label(i)]))
  return { outTrackId: `acq-b-${requestId}`, params: { ...base, ...opts, answer: '' } }
}

/** One tap on a question card, as core takes it. */
export interface DingTalkCardTap {
  requestId: string
  token: string
  outTrackId: string
  /** The tapper's staff id, the id inbound messages carry as `senderStaffId`. */
  userId: string
}

function optionIndex(value: unknown): number | null {
  const text = typeof value === 'number' ? String(value) : value
  return typeof text === 'string' && /^\d{1,2}$/.test(text) ? Number(text) : null
}

/** Read one card callback's JSON `data`; null when it is not a tap on a question card this daemon sent. */
export function dingTalkCardTap(data: string): DingTalkCardTap | null {
  let payload: { outTrackId?: unknown; userId?: unknown; content?: unknown }
  let content: { cardPrivateData?: { actionIds?: unknown; params?: Record<string, unknown> } }
  try {
    payload = JSON.parse(data) as typeof payload
    content = (typeof payload.content === 'string' ? JSON.parse(payload.content) : payload.content) as typeof content
  } catch {
    return null
  }
  const outTrackId = typeof payload.outTrackId === 'string' ? payload.outTrackId : undefined
  const track = cardTrack(outTrackId)
  const userId = typeof payload.userId === 'string' && payload.userId ? payload.userId : undefined
  if (!track || !userId) return null
  const actions = Array.isArray(content?.cardPrivateData?.actionIds) ? content.cardPrivateData.actionIds : []
  const params = content?.cardPrivateData?.params ?? {}
  let index: number | null = null
  if (track.layout === 'form') {
    const choice = (params.form as { choice?: { value?: unknown } } | undefined)?.choice
    if (actions.includes('form')) index = optionIndex(choice?.value)
  } else if (actions.includes('choice')) {
    const slot = optionIndex(params.option)
    index = track.yesno ? (slot === 0 || slot === 1 ? track.yesno[slot] : null) : slot
  }
  if (index === null) return null
  return { requestId: track.requestId, token: elicitOptionToken(index), outTrackId: outTrackId!, userId }
}

// The question text core gave the card, re-derived from its params the way core derives it.
function questionOf(params: CreateElicitationRequest): string {
  return (params as { message?: string }).message?.trim() || 'The agent needs your input'
}

// A settled card hides its buttons behind the answer, or disables its form with the answer on the button.
function settledCardParams(track: DingTalkCardTrack, card: ElicitCardSettlement): Record<string, string> {
  const said = `${DINGTALK_ELICIT_MARK[card.mark]} ${clampTo(card.text, DINGTALK_ELICIT_DECISION_CAP)}`
  if (track.layout !== 'form') return { answer: said }
  const target = elicitForm(card.params, DINGTALK_ELICIT_SURFACE)?.[0]
  const chosen =
    card.mark === 'answered' && target
      ? target.options.findIndex((o) => o.value === card.text || o.label === card.text)
      : -1
  return {
    form_status: 'disabled',
    form_btn_text: clampTo(said, DINGTALK_CARD_BUTTON_CAP),
    ...(target ? { form: questionForm(questionOf(card.params), target, chosen >= 0 ? chosen : undefined) } : {})
  }
}

// The option label a chat reply chose, per card.
const answeredInChat = new WeakMap<ElicitCardHandle, string>()

// DingTalk cannot edit a sent message, so a hint or a settlement is a new message beside the card.
function follow(handle: ElicitCardHandle, text: string): void {
  if (handle.ts === undefined) return
  const conn = handle.conn as Partial<Pick<DingTalkReplyPort, 'sendText'>> | undefined
  void conn?.sendText?.(handle.channel, text).catch(() => {})
}

export const dingTalkElicitCards: ElicitCardFacet = {
  platform: 'dingtalk',
  reduction: DINGTALK_ELICIT_SURFACE,

  // Both cards are built up front, so a tap card DingTalk refuses still asks with the text card.
  build(host: ElicitCardHost, turn: ElicitCardTurn, ask: ElicitCardAsk): ElicitCardDraft | null {
    const target = ask.form?.length === 1 ? ask.form[0]! : undefined
    if (ask.url || !target?.options.length) return null
    const { conn } = host.turnState(turn) as DingTalkTurnState
    const draft: DingTalkElicitDraft = {
      text: dingTalkElicitText(ask.message, target),
      card: conn?.cards ? dingTalkQuestionCard(ask.requestId, turn.plan.agentName, ask.message, target) : null
    }
    return draft.text === null && !draft.card ? null : draft
  },

  // The handle is the tap card's outTrackId, or the text card's process query key, which a quote brings back.
  async send(host: ElicitCardHost, turn: ElicitCardTurn, _ask: ElicitCardAsk, draft: ElicitCardDraft) {
    const { conn, channel } = host.turnState(turn) as DingTalkTurnState
    if (!conn) return undefined
    const { text, card } = draft as DingTalkElicitDraft
    return await host.postCardSerialized(turn, async () => {
      if (card && (await conn.cards?.deliver(channel, card.outTrackId, card.params))) return card.outTrackId
      return text === null ? undefined : await conn.sendText(channel, text)
    })
  },

  // Only a quote of THIS text card answers it; a quote naming no option gets the instruction again.
  claimReply(handle: ElicitCardHandle, card: ElicitCardTapTarget, reply: ElicitCardReply): ElicitCardTap | null {
    if (handle.ts === undefined || cardTrack(handle.ts) || reply.replyTo !== handle.ts) return null
    const target = card.form.length === 1 ? card.form[0]! : undefined
    if (!target) return null
    const index = dingTalkElicitChoice(target, reply.text)
    if (index === null) {
      follow(handle, `Reply to the question with a number from 1 to ${target.options.length}.`)
      return { kind: 'pending' }
    }
    answeredInChat.set(handle, target.options[index]!.label)
    return { kind: 'submit', fields: { [elicitFormBlockId(0)]: elicitOptionToken(index) } }
  },

  // A tap card is closed in place; on a text card, the reply that answered in the chat already shows the choice, and any other settlement is posted.
  settle(handle: ElicitCardHandle, card: ElicitCardSettlement): void {
    const track = cardTrack(handle.ts)
    if (track) {
      const conn = handle.conn as Partial<Pick<DingTalkReplyPort, 'cards'>> | undefined
      void conn?.cards?.update(handle.ts!, settledCardParams(track, card))
      return
    }
    if (card.mark === 'answered' && answeredInChat.get(handle) === card.text) return
    follow(handle, `${DINGTALK_ELICIT_MARK[card.mark]} ${clampTo(card.text, DINGTALK_ELICIT_DECISION_CAP)}`)
  }
}
