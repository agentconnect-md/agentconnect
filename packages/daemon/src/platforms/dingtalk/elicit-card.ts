// DingTalk's elicitation-card facet (dingtalk-integration.md §4.6): a numbered text card answered by quoting it, matched by the send's process query key.
import { elicitFormBlockId } from '@agentconnect.md/protocol'
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
import { DINGTALK_MSG_PARAM_MAX_BYTES } from './api.js'
import type { DingTalkReplyPort } from './connection.js'
import type { DingTalkTurnState } from './turn-output.js'

// Twelve numbered options keep the card short enough to read and to answer by number.
const DINGTALK_ELICIT_MAX_OPTIONS = 12
const DINGTALK_ELICIT_DECISION_CAP = 300

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

// DingTalk cannot edit a sent message, so a hint or a settlement is a new message beside the card.
function follow(handle: ElicitCardHandle, text: string): void {
  if (handle.ts === undefined) return
  const conn = handle.conn as Partial<Pick<DingTalkReplyPort, 'sendText'>> | undefined
  void conn?.sendText?.(handle.channel, text).catch(() => {})
}

export const dingTalkElicitCards: ElicitCardFacet = {
  platform: 'dingtalk',
  reduction: DINGTALK_ELICIT_SURFACE,

  build(_host: ElicitCardHost, _turn: ElicitCardTurn, ask: ElicitCardAsk): ElicitCardDraft | null {
    const target = ask.form?.length === 1 ? ask.form[0]! : undefined
    if (ask.url || !target?.options.length) return null
    return dingTalkElicitText(ask.message, target)
  },

  // The handle is the send's process query key: the bot never learns the card's message id, and a quote brings the key back.
  async send(host: ElicitCardHost, turn: ElicitCardTurn, _ask: ElicitCardAsk, draft: ElicitCardDraft) {
    const { conn, channel } = host.turnState(turn) as DingTalkTurnState
    if (!conn) return undefined
    return await host.postCardSerialized(turn, () => conn.sendText(channel, draft as string))
  },

  // Only a quote of THIS card answers it; a quote naming no option gets the instruction again.
  claimReply(handle: ElicitCardHandle, card: ElicitCardTapTarget, reply: ElicitCardReply): ElicitCardTap | null {
    if (handle.ts === undefined || reply.replyTo !== handle.ts) return null
    const target = card.form.length === 1 ? card.form[0]! : undefined
    if (!target) return null
    const index = dingTalkElicitChoice(target, reply.text)
    if (index === null) {
      follow(handle, `Reply to the question with a number from 1 to ${target.options.length}.`)
      return { kind: 'pending' }
    }
    return { kind: 'submit', fields: { [elicitFormBlockId(0)]: elicitOptionToken(index) } }
  },

  settle(handle: ElicitCardHandle, card: ElicitCardSettlement): void {
    follow(handle, `${DINGTALK_ELICIT_MARK[card.mark]} ${clampTo(card.text, DINGTALK_ELICIT_DECISION_CAP)}`)
  }
}
