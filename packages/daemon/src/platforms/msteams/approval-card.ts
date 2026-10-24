// Teams' approval-card facet (teams-integration.md §4.4): an Adaptive Card whose buttons the relay forwards, replaced in place once settled.
import { MSTEAMS_CARD_NOTE_MAX, MSTEAMS_PLATFORM, type WireMsTeamsCardAction } from '@agentconnect.md/protocol'
import type {
  ApprovalCardAsk,
  ApprovalCardContext,
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
import { clampTo, permToolLabel, type SubsessionNoticeOutcome } from '../../slack/render.js'
import {
  adaptiveCard,
  buttonRows,
  dataString,
  executeButton,
  MSTEAMS_APPROVAL_VERB,
  openUrlRow,
  plainText,
  type AdaptiveElement
} from './card.js'
import type { MsTeamsCardPort } from './connection.js'
import type { MsTeamsTurnState } from './turn-output.js'

/** Our own cap, as Google Chat's: Teams publishes no per-card button count, so a longer list goes to the console. */
export const MSTEAMS_APPROVAL_MAX_OPTIONS = 25

const MSTEAMS_DECISION_CAP = 300

/** A card not yet sent: its JSON and the notification line beside it. */
export interface MsTeamsCardDraft {
  card: Record<string, unknown>
  summary?: string
}

function intro(asker: SubsessionAsker): AdaptiveElement[] {
  const who = subsessionAskerText(asker.agentName, asker.title, clampTo)
  return [
    ...plainText(`${who} is asking for permission. ${subsessionWaitText(asker.waitHours)}`),
    openUrlRow('Open the task', asker.sessionUrl)
  ]
}

function contextIntro(context: ApprovalCardContext): AdaptiveElement[] {
  const requester = context.requesterName ? ` for ${clampTo(context.requesterName, 60)}` : ''
  return [
    ...plainText(`${clampTo(context.agentName, 60)} is waiting on an approval${requester}.`),
    openUrlRow('Open session', context.sessionUrl)
  ]
}

function optionStyle(kind: string): 'positive' | 'destructive' | undefined {
  if (kind === 'allow_once' || kind === 'allow_always') return 'positive'
  if (kind === 'reject_once' || kind === 'reject_always') return 'destructive'
  return undefined
}

/** The live card: the request, then one button per option carrying the request and the option's position. Pure. */
export function buildMsTeamsApprovalCard(ask: ApprovalCardAsk): Record<string, unknown> {
  const buttons = ask.params.options.map((o, i) => {
    const style = optionStyle(o.kind)
    return executeButton(
      o.name,
      MSTEAMS_APPROVAL_VERB,
      { approval: ask.requestId, option: String(i) },
      style ? { style } : {}
    )
  })
  return adaptiveCard([
    ...(ask.subsession ? intro(ask.subsession) : []),
    ...(ask.context ? contextIntro(ask.context) : []),
    ...plainText(`🔒 Permission requested — ${permToolLabel(ask.params)}`, { bold: true }),
    ...buttonRows(buttons)
  ])
}

/** A forwarded click on a permission card: its request and option position; null for any other click. Pure. */
export function parseMsTeamsApprovalClick(action: WireMsTeamsCardAction): { requestId: string; option: number } | null {
  if (action.verb !== MSTEAMS_APPROVAL_VERB) return null
  const requestId = dataString(action.data, 'approval')
  const option = dataString(action.data, 'option')
  if (!requestId || !option || !/^\d{1,2}$/.test(option)) return null
  return { requestId, option: Number(option) }
}

/** Post a card into the turn's conversation, serialized on its apply chain; the activity ID, or undefined with nowhere to post. */
export async function sendMsTeamsCard(
  host: ElicitCardHost,
  turn: ElicitCardTurn,
  draft: MsTeamsCardDraft
): Promise<string | undefined> {
  // The card anchors as the turn's own posts do: the raw conversation ID, so a channel's card lands in its thread.
  const state = host.turnState(turn) as MsTeamsTurnState | undefined
  const conn = state?.conn as Partial<MsTeamsCardPort> | undefined
  const target = state?.target
  if (!conn?.postCard || !target) return undefined
  const post = conn.postCard.bind(conn)
  return await host.postCardSerialized(turn, async () => await post(target, draft.card, draft.summary))
}

/** Replace a posted card in place; best effort, no outcome depends on it. */
export function replaceMsTeamsCard(
  handle: { conn: unknown; channel: string; thread?: string; ts?: string },
  card: Record<string, unknown>
): void {
  if (handle.ts === undefined) return
  const port = handle.conn as Partial<MsTeamsCardPort> | undefined
  const at = { channel: handle.channel, ...(handle.thread ? { thread: handle.thread } : {}) }
  void port?.replaceCard?.(handle.ts, card, at).catch(() => {})
}

export const msTeamsApprovalCards: ApprovalCardFacet = {
  platform: MSTEAMS_PLATFORM,
  maxOptions: MSTEAMS_APPROVAL_MAX_OPTIONS,
  // No tellPrivately: core hands a refusal back, and the relay shows it to the clicker alone as the click's note.
  privateTextLimit: MSTEAMS_CARD_NOTE_MAX,

  build(ask: ApprovalCardAsk): ApprovalCardDraft | null {
    const options = ask.params.options
    if (!options.length || options.length > MSTEAMS_APPROVAL_MAX_OPTIONS) return null
    return {
      card: buildMsTeamsApprovalCard(ask),
      summary: clampTo(`Permission requested: ${permToolLabel(ask.params)}`, 300)
    } satisfies MsTeamsCardDraft
  },

  settled(settled: ApprovalCardSettlement): ApprovalCardDraft {
    const decision = `${approvalMark(settled.allowed)} ${clampTo(settled.text, MSTEAMS_DECISION_CAP)}`
    const card = adaptiveCard([
      ...(settled.subsession ? intro(settled.subsession) : []),
      ...(settled.context ? contextIntro(settled.context) : []),
      ...plainText(`🔒 Permission — ${permToolLabel(settled.params)}`, { bold: true }),
      ...plainText(decision)
    ])
    return { card } satisfies MsTeamsCardDraft
  },

  notice(asker: SubsessionAsker): ApprovalCardDraft {
    const who = subsessionAskerText(asker.agentName, asker.title, clampTo)
    const text = `🔒 ${who} is waiting for permission. Ask an Agent editor to allow it from the Agent or Session page. ${subsessionWaitText(asker.waitHours)}`
    return {
      card: adaptiveCard([...plainText(text), openUrlRow('Open the task', asker.sessionUrl)]),
      summary: `${clampTo(asker.agentName, 60)} is waiting for permission`
    } satisfies MsTeamsCardDraft
  },

  noticeSettled(view: SubsessionNoticeView, outcome: SubsessionNoticeOutcome): ApprovalCardDraft {
    const line = subsessionSettledText(subsessionAskerText(view.agentName, view.title, clampTo), outcome, (s) =>
      clampTo(s, 60)
    )
    const body = [...plainText(line), ...(view.sessionUrl ? [openUrlRow('Open the task', view.sessionUrl)] : [])]
    return { card: adaptiveCard(body) } satisfies MsTeamsCardDraft
  },

  orphaned(row: ApprovalCardOrphan): ApprovalCardDraft {
    const by = row.resolvedByName ? ` by ${clampTo(row.resolvedByName, 60)}` : ''
    const card = adaptiveCard([
      ...plainText(`🔒 Permission — ${clampTo(row.command, 150)}`, { bold: true }),
      ...plainText(`${orphanMark(row.status)} ${row.status}${by}`)
    ])
    return { card } satisfies MsTeamsCardDraft
  },

  async send(host: ElicitCardHost, turn: ElicitCardTurn, draft: ApprovalCardDraft): Promise<string | undefined> {
    return await sendMsTeamsCard(host, turn, draft as MsTeamsCardDraft)
  },

  async post(conn: unknown, place: ApprovalCardPlace, draft: ApprovalCardDraft): Promise<string | undefined> {
    const d = draft as MsTeamsCardDraft
    const port = conn as Partial<MsTeamsCardPort> | undefined
    const target = port?.targetFor?.(place.channel, place.thread)
    if (!port?.postCard || !target) return undefined
    return await port.postCard(target, d.card, d.summary)
  },

  rewrite(handle: ApprovalCardHandle, draft: ApprovalCardDraft): void {
    replaceMsTeamsCard(handle, (draft as MsTeamsCardDraft).card)
  }
}
