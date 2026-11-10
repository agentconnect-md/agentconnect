// Slack's Fill card facet (computer-form-fill-and-vault.md §6): a link to the console form, rewritten once it settles.
import type { SlackConnection } from '../../slack/connection.js'
import { fillSettledText, type FillCardFacet, type FillCardHandle, type FillCardModel } from '../fill-card.js'
import type { ElicitCardHost, ElicitCardTurn } from '../elicit-card.js'
import { slackAgentIdentityOptions } from './turn-output.js'

const BUTTON_URL_MAX = 3000
const REASON_MAX = 200

interface SlackFillDraft {
  blocks: unknown[]
  fallback: string
}

type FillCardConnection = Pick<SlackConnection, 'postBlocks' | 'updateBlocks'>
const conn = (c: unknown): FillCardConnection => c as FillCardConnection

const clamp = (text: string, max: number): string => {
  const t = text.trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}
const escapeMrkdwn = (raw: string): string => raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** A pending card: no field and no input here; the form opens in the console for the person who asked. */
export function buildFillCard(model: FillCardModel): unknown[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:key: *${escapeMrkdwn(clamp(model.agentName, 80))} needs you to fill a form* on \`${escapeMrkdwn(clamp(model.origin, 200))}\` (${model.fieldCount} field${model.fieldCount === 1 ? '' : 's'}, ${escapeMrkdwn(clamp(model.computerName, 80))}).`,
        verbatim: true
      }
    },
    ...(model.reason?.trim()
      ? [{ type: 'context', elements: [{ type: 'plain_text', text: clamp(model.reason, REASON_MAX), emoji: false }] }]
      : []),
    {
      type: 'context',
      elements: [
        {
          type: 'plain_text',
          text: 'Enter the values in AgentConnect, never in this chat. The agent does not see them.',
          emoji: false
        }
      ]
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: 'agentconnect_fill_open',
          text: { type: 'plain_text', text: 'Fill in AgentConnect', emoji: true },
          style: 'primary',
          url: model.link.slice(0, BUTTON_URL_MAX)
        }
      ]
    }
  ]
}

export const slackFillCards: FillCardFacet = {
  platform: 'slack',

  build(model: FillCardModel): SlackFillDraft {
    return { blocks: buildFillCard(model), fallback: `${model.agentName} needs you to fill a form on ${model.origin}` }
  },

  settled(model, outcome): SlackFillDraft {
    const text = fillSettledText(model, outcome)
    return {
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: escapeMrkdwn(text), verbatim: true } }],
      fallback: text
    }
  },

  async send(host: ElicitCardHost, turn: ElicitCardTurn, draft: unknown): Promise<string | undefined> {
    const d = draft as SlackFillDraft
    const options = { ...(slackAgentIdentityOptions(turn.plan) ?? {}), chrome: true }
    return await host.postCardSerialized(turn, (c) =>
      conn(c).postBlocks(turn.plan.channel, d.blocks, d.fallback, turn.plan.thread, options)
    )
  },

  async rewrite(handle: FillCardHandle, draft: unknown): Promise<boolean> {
    const d = draft as SlackFillDraft
    return await conn(handle.conn)
      .updateBlocks(handle.channel, handle.ts, d.blocks, d.fallback, true)
      .catch(() => false)
  }
}
