import type { ChoiceCardRow } from '../../store/choice-cards.js'
import { EDIT_CHOICE, type ChoiceCardSurface } from '../../cards/choice-cards.js'

export const CARD_ACTION_PREFIX = 'ac_card'
export const CARD_EDIT_ACTION = 'ac_card_edit'
export const CARD_TEXT_BLOCK = 'ac_card_text'

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** A card's Block Kit: its text, then buttons while open, else who decided it. */
export function choiceCardBlocks(card: ChoiceCardRow): unknown[] {
  const blocks: unknown[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: clip(`*${card.title}*${card.body ? `\n${card.body}` : ''}`, 3000) }
    }
  ]
  if (card.state === 'open') {
    if (card.editText !== null)
      blocks.push({
        type: 'input',
        block_id: CARD_TEXT_BLOCK,
        optional: true,
        label: { type: 'plain_text', text: 'Edit, then press Send edited' },
        element: { type: 'plain_text_input', action_id: 'text', multiline: true, initial_value: card.editText }
      })
    blocks.push({
      type: 'actions',
      block_id: `ac_card:${card.cardId}`,
      elements: [
        ...card.options.map((o, i) => ({
          type: 'button',
          action_id: `${CARD_ACTION_PREFIX}:${i}`,
          text: { type: 'plain_text', text: o.label },
          value: `${card.cardId}|${o.id}`
        })),
        ...(card.editText !== null
          ? [
              {
                type: 'button',
                action_id: CARD_EDIT_ACTION,
                text: { type: 'plain_text', text: 'Send edited' },
                value: card.cardId
              }
            ]
          : [])
      ]
    })
  } else {
    const chosen =
      card.choice === EDIT_CHOICE
        ? 'Send edited'
        : (card.options.find((o) => o.id === card.choice)?.label ?? card.choice)
    const decided = card.clickedBy ? `${chosen} — <@${card.clickedBy}>` : card.state
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: clip(decided ?? card.state, 300) }] })
    if (card.choice === EDIT_CHOICE && card.editedText)
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: clip(`> ${card.editedText.replace(/\n/g, '\n> ')}`, 3000) }
      })
  }
  if (card.label) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: clip(card.label, 300) }] })
  return blocks
}

interface SlackCardConn {
  postBlocks(channel: string, blocks: unknown[], text: string, threadTs?: string): Promise<string | undefined>
  updateBlocks(channel: string, ts: string, blocks: unknown[], text?: string): Promise<boolean>
}

export function slackChoiceCardSurface(conn: SlackCardConn): ChoiceCardSurface {
  return {
    post: (card) => conn.postBlocks(card.channel, choiceCardBlocks(card), card.title, card.thread),
    redraw: (card) => conn.updateBlocks(card.channel, card.ts, choiceCardBlocks(card), card.title)
  }
}

/** Decode a card button's `<cardId>|<optionId>` value. */
export function decodeCardValue(value: string): { cardId: string; choice: string } | undefined {
  const at = value.indexOf('|')
  return at > 0 ? { cardId: value.slice(0, at), choice: value.slice(at + 1) } : undefined
}
