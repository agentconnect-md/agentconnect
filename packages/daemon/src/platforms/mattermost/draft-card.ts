// Mattermost's assistant-mode draft card surface (§5.5, §5.10): Markdown + signed Approve/Discard buttons (or pure-WS `D-XXXXXXXX` numbered replies), cleared once settled.
import { randomBytes } from 'node:crypto'
import type { DraftCard, DraftCardPort } from '../../assistant/drafts.js'
import {
  buildMattermostAttachmentActions,
  mattermostAttachmentProps,
  type MattermostActionCallbackConfig,
  type MattermostAttachment
} from './action-button.js'
import type { MattermostCardReplyEntry } from './connection.js'
import {
  clampMattermostText,
  MATTERMOST_DM_THREAD,
  safeMattermostCardUrl,
  sanitizeMattermostCardText,
  sanitizeMattermostPlainText
} from './module.js'

const DRAFT_CARD_TEXT_CAP = 10_000
const TRACKED_CARD_CAP = 500

interface TrackedDraftCard {
  /** Numbered cards keep their tag until settlement. Button cards keep their original attachment. */
  readonly tag: string | null
}

const trackedByConn = new WeakMap<object, Map<string, TrackedDraftCard>>()
const trackedByPostId = new Map<string, TrackedDraftCard>()

function rememberTrackedDraft(conn: object, postId: string, meta: TrackedDraftCard): void {
  let perConn = trackedByConn.get(conn)
  if (!perConn) {
    perConn = new Map()
    trackedByConn.set(conn, perConn)
  }
  perConn.delete(postId)
  perConn.set(postId, meta)
  if (perConn.size > TRACKED_CARD_CAP) {
    const oldest = perConn.keys().next().value
    if (oldest !== undefined) perConn.delete(oldest)
  }
  trackedByPostId.delete(postId)
  trackedByPostId.set(postId, meta)
  while (trackedByPostId.size > TRACKED_CARD_CAP) {
    const oldest = trackedByPostId.keys().next().value
    if (oldest === undefined) break
    trackedByPostId.delete(oldest)
  }
}

function getTrackedDraft(conn: unknown, postId: string): TrackedDraftCard | undefined {
  if (conn && typeof conn === 'object') {
    const fromConn = trackedByConn.get(conn)?.get(postId)
    if (fromConn) return fromConn
  }
  return trackedByPostId.get(postId)
}

function forgetTrackedDraft(conn: unknown, postId: string): TrackedDraftCard | undefined {
  const meta = getTrackedDraft(conn, postId)
  if (conn && typeof conn === 'object') trackedByConn.get(conn)?.delete(postId)
  trackedByPostId.delete(postId)
  return meta
}

/** Generate a short draft-card reply tag (`D-<8 uppercase hex>`). */
export function mattermostDraftTag(): string {
  return `D-${randomBytes(4).toString('hex').toUpperCase()}`
}

/** Structural Mattermost port used by assistant draft cards; satisfied by {@link MattermostConnection}. */
export interface MattermostDraftPort {
  workspaceId(): string
  actionCallback?(agentId?: string, integrationId?: string): MattermostActionCallbackConfig | undefined
  openDirectMessage(user: string): Promise<string>
  isFullMember(user: string): Promise<boolean>
  getChannelInfo(channel: string): Promise<{ isIm?: boolean; user?: string }>
  getUserProfile(user: string): Promise<{ name?: string; realName?: string; isBot?: boolean }>
  createPost(
    channel: string,
    text: string,
    opts?: { rootId?: string; props?: Record<string, unknown> }
  ): Promise<{ id?: string }>
  patchPost(postId: string, text: string, opts?: { props?: Record<string, unknown> }): Promise<unknown>
  noteCardReply?(entry: MattermostCardReplyEntry): void
  retireCardReply?(tag: string): void
}

function md(raw: string): string {
  return sanitizeMattermostCardText(raw)
}

function draftPlace(view: DraftCard['view']): string {
  const { target } = view
  const on = ` on ${md(view.platformName)}`
  const name = target.name ? md(clampMattermostText(target.name, 80)) : undefined
  if (target.isDm) {
    return name ? `a direct message to **${name}**${on}` : `a direct message${on}`
  }
  return `**${name ?? md(target.channel)}**${on}`
}

function formatScheduledNextCheck(nextCheck: number | null): string | null {
  if (nextCheck === null) return null
  const iso = new Date(nextCheck).toISOString()
  return iso.slice(0, 16).replace('T', ' ') + ' UTC'
}

function renderDraftHeaderAndBody(card: DraftCard): string {
  const { view } = card
  const agent = md(clampMattermostText(view.agentName, 80))
  const lines: string[] = []

  if (view.kind === 'task') {
    lines.push(`**${agent}** is asking for your approval to run a proposed task in ${draftPlace(view)}.`)
    if (view.proposal) {
      lines.push(`**Proposal:** ${md(clampMattermostText(view.proposal.sentence, 500))}`)
      if (view.proposal.why) lines.push(`_Why:_ ${md(clampMattermostText(view.proposal.why, 500))}`)
      const fu = view.proposal.followUp
      if (fu) {
        const parts = [`**Follow-up:** ${md(clampMattermostText(fu.title, 200))}`]
        if (fu.doneWhen) parts.push(`Done when: ${md(clampMattermostText(fu.doneWhen, 300))}`)
        const when = formatScheduledNextCheck(fu.nextCheck)
        if (when) parts.push(`Next check: ${when}`)
        if (fu.watch) parts.push(`Watch: ${md(clampMattermostText(fu.watch, 200))}`)
        lines.push(parts.join(' · '))
      }
    }
  } else {
    lines.push(`**${agent}** prepared a reply for ${draftPlace(view)} and is waiting for your approval to post it.`)
  }

  const body = md(clampMattermostText(view.text, DRAFT_CARD_TEXT_CAP))
  if (body) lines.push(body)

  if ('draftId' in card && card.notice) {
    lines.push(`⚠️ ${md(clampMattermostText(card.notice, 500))}`)
  }
  const safeSessionUrl = safeMattermostCardUrl(view.sessionUrl)
  if (safeSessionUrl) {
    lines.push(`[Open session](${safeSessionUrl})`)
  }
  if ('outcome' in card) {
    lines.push(md(clampMattermostText(card.outcome, 300)))
  }
  return lines.join('\n\n')
}

function renderDraftFallbackText(card: Extract<DraftCard, { draftId: string }>, tag: string): string {
  const second = card.view.kind === 'task' ? 'Deny' : 'Discard'
  return [
    renderDraftHeaderAndBody(card),
    `1. Approve\n2. ${second}`,
    `_Reply \`${tag} 1\` or \`${tag} 2\` (or reply \`1\` / \`2\` in this thread)._`
  ].join('\n\n')
}

function buildPendingProps(
  callback: MattermostActionCallbackConfig | undefined,
  integrationId: string,
  channel: string,
  card: Extract<DraftCard, { draftId: string }>
): { attachments: [MattermostAttachment] } | undefined {
  const task = card.view.kind === 'task'
  const actions = buildMattermostAttachmentActions(callback, [
    {
      id: 'approve',
      name: 'Approve',
      style: 'good',
      claims: {
        agentId: card.agentId,
        integrationId,
        channelId: channel,
        kind: 'draft',
        requestId: card.draftId,
        token: 'approve'
      }
    },
    {
      id: 'discard',
      name: task ? 'Deny' : 'Discard',
      style: 'danger',
      claims: {
        agentId: card.agentId,
        integrationId,
        channelId: channel,
        kind: 'draft',
        requestId: card.draftId,
        token: 'discard'
      }
    }
  ])
  if (!actions) return undefined
  return mattermostAttachmentProps({
    text: '',
    fallback: clampMattermostText(
      sanitizeMattermostPlainText(
        task
          ? `${card.view.agentName} is asking for your approval to run a proposal`
          : `${card.view.agentName} is waiting for your approval to post`
      ),
      300
    ),
    actions
  })
}

export function mattermostDraftCardPort(conn: MattermostDraftPort, integrationId: string): DraftCardPort {
  return {
    openDirectMessage: (user) => conn.openDirectMessage(user),
    isFullMember: (user) => conn.isFullMember(user),
    scope: () => conn.workspaceId() || undefined,
    isPerson: async (user) => (await conn.getUserProfile(user).catch(() => undefined))?.isBot === false,
    nameOf: async (user) => {
      const profile = await conn.getUserProfile(user)
      return profile.realName?.trim() || profile.name?.trim() || undefined
    },
    directMessageWith: async (channel) => {
      const info = await conn.getChannelInfo(channel)
      if (!info.isIm) return null
      if (!info.user) throw new Error('Mattermost named no person for this direct message')
      return info.user
    },
    postCard: async (channel, card, thread) => {
      if (!('draftId' in card)) return undefined
      const rootId = thread && thread !== MATTERMOST_DM_THREAD ? thread : undefined
      const callback = conn.actionCallback?.(card.agentId, integrationId)
      if (callback) {
        const props = buildPendingProps(callback, integrationId, channel, card)
        if (!props) return undefined
        const post = await conn.createPost(channel, renderDraftHeaderAndBody(card), {
          ...(rootId ? { rootId } : {}),
          props
        })
        if (post?.id) rememberTrackedDraft(conn, post.id, { tag: null })
        return post?.id
      }
      const tag = mattermostDraftTag()
      const post = await conn.createPost(channel, renderDraftFallbackText(card, tag), rootId ? { rootId } : undefined)
      if (!post?.id) return undefined
      rememberTrackedDraft(conn, post.id, { tag })
      conn.noteCardReply?.({
        tag,
        channel,
        ...(thread ? { thread } : {}),
        postId: post.id,
        agentId: card.agentId,
        integrationId,
        kind: 'draft',
        draftId: card.draftId
      })
      return post.id
    },
    updateCard: async (channel, ts, card) => {
      if ('outcome' in card) {
        const tracked = forgetTrackedDraft(conn, ts)
        if (tracked?.tag) conn.retireCardReply?.(tracked.tag)
        return await conn.patchPost(ts, renderDraftHeaderAndBody(card), { props: { attachments: [] } }).then(
          () => true,
          () => false
        )
      }
      const tracked = getTrackedDraft(conn, ts)
      if (tracked) {
        const text = tracked.tag ? renderDraftFallbackText(card, tracked.tag) : renderDraftHeaderAndBody(card)
        return await conn.patchPost(ts, text).then(
          () => true,
          () => false
        )
      }
      const callback = conn.actionCallback?.(card.agentId, integrationId)
      if (callback) {
        const props = buildPendingProps(callback, integrationId, channel, card) ?? { attachments: [] }
        return await conn.patchPost(ts, renderDraftHeaderAndBody(card), { props }).then(
          () => true,
          () => false
        )
      }
      const tag = mattermostDraftTag()
      rememberTrackedDraft(conn, ts, { tag })
      conn.noteCardReply?.({
        tag,
        channel,
        postId: ts,
        agentId: card.agentId,
        integrationId,
        kind: 'draft',
        draftId: card.draftId
      })
      return await conn.patchPost(ts, renderDraftFallbackText(card, tag), { props: { attachments: [] } }).then(
        () => true,
        () => false
      )
    }
  }
}
