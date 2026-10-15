// Discord's approval-card facet (§7.3): a message of buttons carrying an option's position, posted where a thread is a channel of its own.
import type {
  ApprovalCardAsk,
  ApprovalCardDraft,
  ApprovalCardFacet,
  ApprovalCardHandle,
  ApprovalCardOrphan,
  ApprovalCardPlace,
  ApprovalCardSettlement,
  SubsessionAsker,
  SubsessionNoticeView
} from '../approval-card.js'
import {
  approvalMark,
  orphanMark,
  subsessionAskerText,
  subsessionSettledText,
  subsessionWaitText
} from '../approval-card.js'
import type { ElicitCardHost, ElicitCardTurn } from '../elicit-card.js'
import type { DiscordConnection } from '../../discord/connection.js'
import { DISCORD_MESSAGE_LIMIT, type DiscordButton, type DiscordComponents } from '../../discord/render.js'
import { defuseNoticeText } from '../../permissions/elicit-notice.js'
import { clampTo, permToolLabel, type SubsessionNoticeOutcome } from '../../slack/render.js'
import { DISCORD_BUTTON_LABEL_CAP, DISCORD_CUSTOM_ID_CAP, DISCORD_ELICIT_MAX_BUTTONS } from './elicit-card.js'

/** Five rows of five buttons: the elicitation card's options plus the Dismiss slot a permission card does not need. */
export const DISCORD_APPROVAL_MAX_OPTIONS = DISCORD_ELICIT_MAX_BUTTONS + 1

/** How much of a settlement's words the card echoes; a Discord message holds 2000 characters. */
const DISCORD_APPROVAL_DECISION_CAP = 300

/** One option button's `custom_id`: the request and the option's position. Pure. */
export function discordApprovalId(requestId: string, option: number): string {
  return `ac_pm:${requestId}:${option}`
}

/** A clicked permission button: its request and option position; null for ids this scheme did not mint. Pure. */
export function parseDiscordApproval(id: string): { requestId: string; option: number } | null {
  const m = /^ac_pm:([0-9a-fA-F-]{1,64}):(\d{1,2})$/.exec(id)
  return m ? { requestId: m[1] as string, option: Number(m[2]) } : null
}

/** A Discord card or notice: markdown text, and the buttons under it where it has any (none drops them on a rewrite). */
interface DiscordApprovalDraft {
  text: string
  components?: DiscordComponents
}

/** Agent- and runtime-authored words, with Discord's link syntax defused. */
const md = (text: string, cap: number): string => defuseNoticeText(clampTo(text, cap), 'markdown')

/** Allow green, reject red, anything else grey. */
const styleOf = (kind: string): DiscordButton['style'] =>
  kind === 'allow_once' || kind === 'allow_always' ? 3 : kind === 'reject_once' || kind === 'reject_always' ? 4 : 2

function intro(asker: SubsessionAsker): string {
  return `${subsessionAskerText(asker.agentName, asker.title, md)} is asking for permission. ${subsessionWaitText(asker.waitHours)}\n[Open the task](${asker.sessionUrl})\n\n`
}

const fit = (text: string): string => clampTo(text, DISCORD_MESSAGE_LIMIT)

export const discordApprovalCards: ApprovalCardFacet = {
  platform: 'discord',
  maxOptions: DISCORD_APPROVAL_MAX_OPTIONS,

  build(ask: ApprovalCardAsk): ApprovalCardDraft | null {
    const options = ask.params.options
    if (!options.length || options.length > DISCORD_APPROVAL_MAX_OPTIONS) return null
    if (discordApprovalId(ask.requestId, options.length - 1).length > DISCORD_CUSTOM_ID_CAP) return null
    const buttons: DiscordButton[] = options.map((o, i) => ({
      type: 2,
      style: styleOf(o.kind),
      label: clampTo(o.name, DISCORD_BUTTON_LABEL_CAP),
      custom_id: discordApprovalId(ask.requestId, i)
    }))
    const components: DiscordComponents = []
    for (let i = 0; i < buttons.length; i += 5) components.push({ type: 1, components: buttons.slice(i, i + 5) })
    const head = ask.subsession ? intro(ask.subsession) : ''
    const text = fit(`${head}🔒 **Permission requested** — ${md(permToolLabel(ask.params), 200)}`)
    return { text, components } satisfies DiscordApprovalDraft
  },

  settled(card: ApprovalCardSettlement): ApprovalCardDraft {
    const head = card.subsession ? intro(card.subsession) : ''
    const decision = `${approvalMark(card.allowed)} ${md(card.text, DISCORD_APPROVAL_DECISION_CAP)}`
    return {
      text: fit(`${head}🔒 **Permission** — ${md(permToolLabel(card.params), 200)}\n${decision}`),
      components: []
    } satisfies DiscordApprovalDraft
  },

  notice(asker: SubsessionAsker): ApprovalCardDraft {
    const who = subsessionAskerText(asker.agentName, asker.title, md)
    return {
      text: fit(
        `🔒 ${who} is waiting for permission. Ask an Agent editor to allow it from the Agent or Session page. ${subsessionWaitText(asker.waitHours)}\n[Open the task](${asker.sessionUrl})`
      )
    } satisfies DiscordApprovalDraft
  },

  noticeSettled(view: SubsessionNoticeView, outcome: SubsessionNoticeOutcome): ApprovalCardDraft {
    const line = subsessionSettledText(subsessionAskerText(view.agentName, view.title, md), outcome, (s) => md(s, 60))
    const link = view.sessionUrl ? `\n[Open the task](${view.sessionUrl})` : ''
    return { text: fit(`${line}${link}`) } satisfies DiscordApprovalDraft
  },

  orphaned(row: ApprovalCardOrphan): ApprovalCardDraft {
    const by = row.resolvedByName ? ` by ${md(row.resolvedByName, 60)}` : ''
    return {
      text: fit(`🔒 **Permission** — ${md(row.command, 150)}\n${orphanMark(row.status)} ${row.status}${by}`),
      components: []
    } satisfies DiscordApprovalDraft
  },

  /** A Discord thread is a channel of its own, so a card in one lands, and is edited, there. */
  cardChannel(place: ApprovalCardPlace): string {
    return place.thread || place.channel
  },

  async send(host: ElicitCardHost, turn: ElicitCardTurn, draft: ApprovalCardDraft): Promise<string | undefined> {
    const d = draft as DiscordApprovalDraft
    const channel = turn.plan.thread || turn.plan.channel
    return await host.postCardSerialized(turn, (conn) =>
      (conn as DiscordConnection).postChrome(channel, d.text, d.components ? { keyboard: d.components } : {})
    )
  },

  async post(conn: unknown, place: ApprovalCardPlace, draft: ApprovalCardDraft): Promise<string | undefined> {
    const d = draft as DiscordApprovalDraft
    return await (conn as DiscordConnection).postChrome(
      place.thread || place.channel,
      d.text,
      d.components ? { keyboard: d.components } : {}
    )
  },

  rewrite(handle: ApprovalCardHandle, draft: ApprovalCardDraft): void {
    if (handle.ts === undefined) return
    const d = draft as DiscordApprovalDraft
    void (handle.conn as DiscordConnection)
      .updateMessage(handle.channel, handle.ts, d.text, d.components ? { keyboard: d.components } : {})
      .catch(() => {})
  }
}
