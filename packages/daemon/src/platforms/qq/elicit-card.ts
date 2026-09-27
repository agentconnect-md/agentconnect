// QQ's elicitation-card facet: a numbered text card answered by quoting it, since bot buttons need separate platform approval.
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
import { elicitFormBlockId } from '@agentconnect.md/protocol'
import {
  clampTo,
  elicitOptionToken,
  type ElicitKind,
  type ElicitSurface,
  type ElicitTarget
} from '../../slack/render.js'
import type { QQConnection } from './connection.js'
import { QQTextMaxBytes } from './text.js'
import type { QQTurnState } from './turn-output.js'

// Twelve options of 75 CJK characters still fit one QQ message beside the question.
const QQ_ELICIT_MAX_OPTIONS = 12

const QQ_ELICIT_DECISION_CAP = 300

const QQ_ELICIT_MARK: Record<ElicitCardMark, string> = {
  answered: '✅',
  dismissed: '🚫',
  waiting: '⏳',
  blocked: '🔒'
}

// Only the kinds one numbered reply answers whole; typed and multi-field asks keep the decline notice.
export const QQ_ELICIT_SURFACE: ElicitSurface = {
  kinds: new Set<ElicitKind>(['enum', 'boolean']),
  optionLimits: {
    enum: { maxOptions: QQ_ELICIT_MAX_OPTIONS }
  }
}

// A group only delivers messages that mention the bot, so the instruction says so there.
export function qqElicitInstruction(channel: string): string {
  return channel.startsWith('group:')
    ? 'Reply to this message with a number, mentioning the bot.'
    : 'Reply to this message with a number.'
}

// Clamp by UTF-8 bytes, the unit QQ's message limit counts.
function clampBytes(text: string, max: number): string {
  if (Buffer.byteLength(text) <= max) return text
  let out = ''
  for (const character of text) {
    if (Buffer.byteLength(out + character) > max - 3) break
    out += character
  }
  return `${out}…`
}

export function qqElicitText(message: string, target: ElicitTarget, channel: string): string | null {
  const tail = ['', ...target.options.map((o, i) => `${i + 1}. ${o.label}`), '', qqElicitInstruction(channel)].join(
    '\n'
  )
  const budget = QQTextMaxBytes - Buffer.byteLength(tail) - Buffer.byteLength('💬 ')
  if (budget < 64) return null
  return `💬 ${clampBytes(message, budget)}${tail}`
}

// The option a reply names: its 1-based number or its own label/value, compared after NFKC so full-width digits count.
export function qqElicitChoice(target: ElicitTarget, text: string): number | null {
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

function followCard(handle: ElicitCardHandle, text: string): void {
  if (handle.ts === undefined) return
  const conn = handle.conn as Partial<Pick<QQConnection, 'followCard'>> | undefined
  void conn?.followCard?.(handle.channel, handle.ts, text).catch(() => {})
}

export const qqElicitCards: ElicitCardFacet = {
  platform: 'qq',
  reduction: QQ_ELICIT_SURFACE,

  build(_host: ElicitCardHost, turn: ElicitCardTurn, ask: ElicitCardAsk): ElicitCardDraft | null {
    const target = ask.form?.length === 1 ? ask.form[0]! : undefined
    if (ask.url || !target?.options.length) return null
    return qqElicitText(ask.message, target, turn.plan.channel)
  },

  async send(host: ElicitCardHost, turn: ElicitCardTurn, _ask: ElicitCardAsk, draft: ElicitCardDraft) {
    const state = host.turnState(turn) as QQTurnState
    const { conn, replyId, channel } = state
    if (!conn?.sendCard || !replyId) return undefined
    return await host.postCardSerialized(turn, () => conn.sendCard!(channel, replyId, draft as string))
  },

  // Only a quote of THIS card answers it; anything else in the quote gets the instruction again.
  claimReply(handle: ElicitCardHandle, card: ElicitCardTapTarget, reply: ElicitCardReply): ElicitCardTap | null {
    if (handle.ts === undefined || reply.replyTo !== handle.ts) return null
    const target = card.form.length === 1 ? card.form[0]! : undefined
    if (!target) return null
    const index = qqElicitChoice(target, reply.text)
    if (index === null) {
      followCard(handle, `Reply with a number from 1 to ${target.options.length}.`)
      return { kind: 'pending' }
    }
    return { kind: 'submit', fields: { [elicitFormBlockId(0)]: elicitOptionToken(index) } }
  },

  settle(handle: ElicitCardHandle, card: ElicitCardSettlement): void {
    followCard(handle, `${QQ_ELICIT_MARK[card.mark]} ${clampTo(card.text, QQ_ELICIT_DECISION_CAP)}`)
  }
}
