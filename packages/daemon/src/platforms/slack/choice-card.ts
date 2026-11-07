// Slack's choice-card facet (choice-cards.md): Block Kit buttons, redrawn with `chat.update`, refusals as ephemerals.
import type { SlackConnection } from '../../slack/connection.js'
import { EDIT_CHOICE, type ChoiceCardFacet, type ChoiceCardModel } from '../choice-card.js'

export const CARD_ACTION_PREFIX = 'ac_card'
export const CARD_EDIT_ACTION = 'ac_card_edit'
export const CARD_TEXT_BLOCK = 'ac_card_text'

type ChoiceCardConnection = Pick<SlackConnection, 'postBlocks' | 'updateBlocks' | 'postEphemeral' | 'sendOnly'>

const conn = (c: unknown): ChoiceCardConnection => c as ChoiceCardConnection
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** A card's Block Kit: its text, then buttons while open, else who pressed what. */
export function choiceCardBlocks(card: ChoiceCardModel): unknown[] {
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
    const pressed = card.clickedBy ? `${chosen} — <@${card.clickedBy}>` : card.state
    const decided = card.state === 'deciding' ? `${pressed} (starting…)` : pressed
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: clip(decided, 300) }] })
    if (card.choice === EDIT_CHOICE && card.editedText)
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: clip(`> ${card.editedText.replace(/\n/g, '\n> ')}`, 3000) }
      })
  }
  if (card.label) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: clip(card.label, 300) }] })
  return blocks
}

/** Decode a card button's `<cardId>|<optionId>` value. */
export function decodeCardValue(value: string): { cardId: string; choice: string } | undefined {
  const at = value.indexOf('|')
  return at > 0 ? { cardId: value.slice(0, at), choice: value.slice(at + 1) } : undefined
}

export const slackChoiceCards: ChoiceCardFacet = {
  platform: 'slack',
  // shortcut: the relay forwards no `ac_card` action yet, so an HTTP-mode (send-only) app declines until it does.
  serves: (c) => !conn(c).sendOnly,
  post: (c, card) => conn(c).postBlocks(card.channel, choiceCardBlocks(card), card.title, card.thread),
  redraw: (c, card) => conn(c).updateBlocks(card.channel, card.ts, choiceCardBlocks(card), card.title),
  async tellPrivately(c, place, userId, text) {
    await conn(c).postEphemeral(place.channel, userId, text, place.thread)
  }
}
