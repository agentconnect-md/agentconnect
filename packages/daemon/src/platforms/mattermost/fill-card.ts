// Mattermost's Fill card facet (computer-form-fill-and-vault.md §6): Markdown link to the console form, rewritten once settled.
import { MATTERMOST_PLATFORM } from '@agentconnect.md/protocol'
import type { ElicitCardHost, ElicitCardTurn } from '../elicit-card.js'
import { fillSettledText, type FillCardFacet, type FillCardHandle, type FillCardModel } from '../fill-card.js'
import {
  clampMattermostText,
  MATTERMOST_DM_THREAD,
  safeMattermostCardLink,
  sanitizeMattermostCardText
} from './module.js'
import type { MattermostTurnState } from './turn-output.js'

const REASON_MAX = 200

/** Structural Mattermost port used by Fill cards; satisfied by {@link MattermostConnection}. */
export interface MattermostFillPort {
  createPost(
    channel: string,
    text: string,
    opts?: { rootId?: string; props?: Record<string, unknown> }
  ): Promise<{ id?: string }>
  patchPost?(postId: string, text: string, opts?: { props?: Record<string, unknown> }): Promise<unknown>
}

export interface MattermostFillDraft {
  readonly text: string
}

function md(raw: string): string {
  return sanitizeMattermostCardText(raw)
}

function mdInlineCode(raw: string): string {
  return `\`${sanitizeMattermostCardText(raw).replace(/`/g, 'ˋ').replace(/\s+/g, ' ').trim()}\``
}

function resolvePostRootId(turn: ElicitCardTurn, state: Partial<MattermostTurnState> | undefined): string | undefined {
  const isDm = turn.plan.thread === MATTERMOST_DM_THREAD || state?.isDm === true
  if (isDm) return state?.replyThread
  return turn.plan.thread && turn.plan.thread !== MATTERMOST_DM_THREAD ? turn.plan.thread : undefined
}

export function buildMattermostFillCard(model: FillCardModel): string {
  const fields = `${model.fieldCount} field${model.fieldCount === 1 ? '' : 's'}`
  const lines = [
    `🔑 **${md(clampMattermostText(model.agentName, 80))} needs you to fill a form** on ${mdInlineCode(clampMattermostText(model.origin, 200))} (${fields}, ${md(clampMattermostText(model.computerName, 80))}).`,
    ...(model.reason?.trim() ? [md(clampMattermostText(model.reason, REASON_MAX))] : []),
    'Enter the values in AgentConnect, never in this chat. The agent does not see them.',
    safeMattermostCardLink('Fill in AgentConnect', model.link)
  ]
  return lines.join('\n\n')
}

export const mattermostFillCards: FillCardFacet = {
  platform: MATTERMOST_PLATFORM,

  build(model: FillCardModel): MattermostFillDraft {
    return { text: buildMattermostFillCard(model) }
  },

  settled(model, outcome): MattermostFillDraft {
    return { text: md(fillSettledText(model, outcome)) }
  },

  async send(host: ElicitCardHost, turn: ElicitCardTurn, draft: unknown): Promise<string | undefined> {
    const state = host.turnState(turn) as Partial<MattermostTurnState> | undefined
    const rootId = resolvePostRootId(turn, state)
    const d = draft as MattermostFillDraft
    return await host.postCardSerialized(turn, async (conn) => {
      const port = (state?.conn ?? conn) as Partial<MattermostFillPort> | undefined
      if (!port?.createPost) return undefined
      const post = await port.createPost(turn.plan.channel, d.text, rootId ? { rootId } : undefined)
      return post?.id
    })
  },

  async rewrite(handle: FillCardHandle, draft: unknown): Promise<boolean> {
    const port = handle.conn as Partial<MattermostFillPort> | undefined
    if (!port?.patchPost) return false
    const d = draft as MattermostFillDraft
    return await port.patchPost(handle.ts, d.text).then(
      () => true,
      () => false
    )
  }
}
