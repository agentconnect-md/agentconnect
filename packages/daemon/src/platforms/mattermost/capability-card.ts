// Mattermost's capability-card facet (§4.4.1): Markdown card with link + signed Decline button (and C-XXXXXXXX / `1` / `decline` text fallback).
import { randomBytes } from 'node:crypto'
import { MATTERMOST_PLATFORM } from '@agentconnect.md/protocol'
import { capabilityClick } from '../capability-click.js'
import {
  capabilitySettledText,
  type CapabilityCardDraft,
  type CapabilityCardFacet,
  type CapabilityCardHandle,
  type CapabilityCardModel,
  type CapabilityCardOutcome,
  type CapabilityCardPlace
} from '../capability-card.js'
import type { ElicitCardHost, ElicitCardTurn } from '../elicit-card.js'
import {
  buildMattermostAttachmentActions,
  mattermostAttachmentProps,
  type MattermostActionCallbackConfig,
  type MattermostAttachment
} from './action-button.js'
import {
  clampMattermostText,
  MATTERMOST_DM_THREAD,
  safeMattermostCardLink,
  sanitizeMattermostCardText,
  sanitizeMattermostPlainText
} from './module.js'
import type { MattermostTurnState } from './turn-output.js'

/** Structural Mattermost port used by capability cards; satisfied by {@link MattermostConnection}. */
export interface MattermostCapabilityPort {
  workspaceId?(): string
  actionCallback?(agentId?: string, integrationId?: string): MattermostActionCallbackConfig | undefined
  createPost(
    channel: string,
    text: string,
    opts?: { rootId?: string; props?: Record<string, unknown> }
  ): Promise<{ id?: string }>
  patchPost?(postId: string, text: string, opts?: { props?: Record<string, unknown> }): Promise<unknown>
  postEphemeral?(channel: string, userId: string, text: string, rootId?: string): Promise<void>
  openDirectMessage?(user: string): Promise<string>
  getChannelInfo?(channel: string): Promise<{ isIm: boolean; user?: string }>
  getUserProfile?(userId: string): Promise<{ name?: string; realName?: string; isBot?: boolean }>
  noteQuestionTag?(channel: string, tag: string, thread?: string, replyToValue?: string): void
  retireQuestionTag?(tag: string): void
}

interface TrackedCapabilityCard {
  readonly tag?: string
  readonly tagThread?: string
  readonly rootId?: string
  readonly hasActions: boolean
}

const TRACKED_CARD_CAP = 500
const trackedByConn = new WeakMap<object, Map<string, TrackedCapabilityCard>>()
const trackedByPostId = new Map<string, TrackedCapabilityCard>()

function rememberTracked(conn: object, postId: string, meta: TrackedCapabilityCard): void {
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
    if (oldest !== undefined) trackedByPostId.delete(oldest)
  }
}

function getTracked(conn: unknown, postId: string): TrackedCapabilityCard | undefined {
  if (conn && typeof conn === 'object') {
    const fromConn = trackedByConn.get(conn)?.get(postId)
    if (fromConn) return fromConn
  }
  return trackedByPostId.get(postId)
}

function forgetTracked(conn: unknown, postId: string): TrackedCapabilityCard | undefined {
  const meta = getTracked(conn, postId)
  if (conn && typeof conn === 'object') trackedByConn.get(conn)?.delete(postId)
  trackedByPostId.delete(postId)
  return meta
}

function md(raw: string): string {
  return sanitizeMattermostCardText(raw)
}

export interface MattermostCapabilityRendered {
  readonly text: string
  readonly props?: { attachments: [MattermostAttachment] }
  readonly clearAttachments?: boolean
  readonly retireTag?: boolean
}

export interface MattermostCapabilityDraft {
  render(ctx: { conn: unknown; channel: string; tag?: string }): MattermostCapabilityRendered
}

/** Generate a short capability-card reply tag (`C-<8 uppercase hex>`). */
export function mattermostCapabilityTag(): string {
  return `C-${randomBytes(4).toString('hex').toUpperCase()}`
}

/** Whether a reply declines a Mattermost capability card (`C-XXXXXXXX decline`, `decline`, or `1`). Pure. */
export function mattermostCapabilityDeclineReply(text: string): boolean {
  let clean = text.normalize('NFKC').trim()
  if (!clean) return false
  clean = clean.replace(/^(?:@[A-Za-z0-9._-]+[\s,:]*)+/i, '').trim()
  clean = clean
    .replace(/^C-[0-9A-F]{8}(?:\s*[:\-]\s*|\s+|$)/i, '')
    .replace(/(?:^|\s+)C-[0-9A-F]{8}$/i, '')
    .trim()
  return clean === '1' || clean.toLowerCase() === 'decline'
}

function resolveTurnAnchors(
  host: ElicitCardHost,
  turn: ElicitCardTurn
): { rootId: string | undefined; tagThread: string | undefined } {
  const state = host.turnState(turn) as Partial<MattermostTurnState> | undefined
  const isDm = turn.plan.thread === MATTERMOST_DM_THREAD || state?.isDm === true
  const rootId = isDm
    ? state?.replyThread
    : turn.plan.thread && turn.plan.thread !== MATTERMOST_DM_THREAD
      ? turn.plan.thread
      : undefined
  const tagThread = isDm ? MATTERMOST_DM_THREAD : rootId
  return { rootId, tagThread }
}

function capabilityPort(conn: unknown): MattermostCapabilityPort | undefined {
  const port = conn as Partial<MattermostCapabilityPort> | undefined
  return port && typeof port.createPost === 'function' ? (port as MattermostCapabilityPort) : undefined
}

export const mattermostCapabilityCards: CapabilityCardFacet = {
  platform: MATTERMOST_PLATFORM,
  declineControl: 'button',
  directMessages: true,
  claimReply: mattermostCapabilityDeclineReply,

  build(model: CapabilityCardModel): CapabilityCardDraft {
    const baseLines = [
      `🔐 **${md(model.agentName)}** is asking for: **${md(model.summary)}**`,
      md(model.reason),
      ...(model.context ? [md(model.context)] : []),
      safeMattermostCardLink('Open the request', model.link)
    ]
    const fallback = clampMattermostText(
      sanitizeMattermostPlainText(`${model.agentName} is asking for: ${model.summary}`),
      300
    )

    return {
      render: ({ conn, channel, tag }) => {
        const port = conn as Partial<MattermostCapabilityPort> | undefined
        const actions = buildMattermostAttachmentActions(
          port?.actionCallback?.(model.via.agentId, model.via.integrationId),
          [
            {
              id: 'decline',
              name: 'Decline',
              style: 'danger',
              claims: {
                agentId: model.via.agentId,
                integrationId: model.via.integrationId,
                channelId: channel,
                kind: 'capability',
                requestId: model.requestId,
                cardId: model.cardId,
                generation: model.generation
              }
            }
          ]
        )
        if (actions) {
          return {
            text: baseLines.join('\n\n'),
            props: mattermostAttachmentProps({ text: '', fallback, actions })
          }
        }
        const replyLine = tag
          ? `Reply with \`${tag} decline\` (or \`1\`) to decline.`
          : 'Reply with `decline` (or `1`) to decline.'
        return {
          text: [...baseLines, replyLine].join('\n\n')
        }
      }
    } satisfies MattermostCapabilityDraft
  },

  settled(model: CapabilityCardModel, outcome: CapabilityCardOutcome): CapabilityCardDraft {
    const text = `${md(capabilitySettledText(model.summary, outcome))}\n\n${safeMattermostCardLink('View the request', model.link)}`
    return {
      render: () => ({ text, clearAttachments: true, retireTag: true })
    } satisfies MattermostCapabilityDraft
  },

  async send(host: ElicitCardHost, turn: ElicitCardTurn, draft: CapabilityCardDraft): Promise<string | undefined> {
    const state = host.turnState(turn) as Partial<MattermostTurnState> | undefined
    const { rootId, tagThread } = resolveTurnAnchors(host, turn)
    const d = draft as MattermostCapabilityDraft
    return await host.postCardSerialized(turn, async (conn) => {
      const port = capabilityPort(state?.conn ?? conn)
      if (!port) return undefined
      const tag = mattermostCapabilityTag()
      const rendered = d.render({ conn: port, channel: turn.plan.channel, tag })
      const post = await port.createPost(turn.plan.channel, rendered.text, {
        ...(rootId ? { rootId } : {}),
        ...(rendered.props ? { props: rendered.props } : {})
      })
      if (!post?.id) return undefined
      if (!rendered.props) port.noteQuestionTag?.(turn.plan.channel, tag, tagThread, post.id)
      rememberTracked(port, post.id, {
        ...(rendered.props ? {} : { tag }),
        ...(tagThread ? { tagThread } : {}),
        ...(rootId ? { rootId } : {}),
        hasActions: Boolean(rendered.props)
      })
      return post.id
    })
  },

  async post(conn: unknown, place: CapabilityCardPlace, draft: CapabilityCardDraft): Promise<string | undefined> {
    const port = capabilityPort(conn)
    if (!port) return undefined
    const rootId = place.thread && place.thread !== MATTERMOST_DM_THREAD ? place.thread : undefined
    const tagThread = place.thread
    const tag = mattermostCapabilityTag()
    const rendered = (draft as MattermostCapabilityDraft).render({ conn: port, channel: place.channel, tag })
    const post = await port.createPost(place.channel, rendered.text, {
      ...(rootId ? { rootId } : {}),
      ...(rendered.props ? { props: rendered.props } : {})
    })
    if (!post?.id) return undefined
    if (!rendered.props) port.noteQuestionTag?.(place.channel, tag, tagThread, post.id)
    rememberTracked(port, post.id, {
      ...(rendered.props ? {} : { tag }),
      ...(tagThread ? { tagThread } : {}),
      ...(rootId ? { rootId } : {}),
      hasActions: Boolean(rendered.props)
    })
    return post.id
  },

  async rewrite(
    handle: CapabilityCardHandle,
    draft: CapabilityCardDraft
  ): Promise<'edited' | 'followed-up' | 'failed'> {
    const port = capabilityPort(handle.conn)
    if (!port) return 'failed'
    const existing = getTracked(handle.conn, handle.ts)
    const rendered = (draft as MattermostCapabilityDraft).render({
      conn: handle.conn,
      channel: handle.channel,
      ...(existing?.tag ? { tag: existing.tag } : {})
    })
    if (rendered.retireTag) {
      const removed = forgetTracked(handle.conn, handle.ts)
      if (removed?.tag) port.retireQuestionTag?.(removed.tag)
    }
    const patchOpts = rendered.clearAttachments
      ? { props: { attachments: [] } }
      : rendered.props
        ? { props: rendered.props }
        : existing?.hasActions
          ? { props: { attachments: [] } }
          : undefined
    if (typeof port.patchPost === 'function') {
      const edited = await port.patchPost(handle.ts, rendered.text, patchOpts).then(
        () => true,
        () => false
      )
      if (edited) return 'edited'
    }
    const rootId =
      existing?.rootId ?? (handle.thread && handle.thread !== MATTERMOST_DM_THREAD ? handle.thread : undefined)
    const posted = await port
      .createPost(handle.channel, rendered.text, {
        ...(rootId ? { rootId } : {}),
        ...(rendered.props ? { props: rendered.props } : {})
      })
      .then(
        (res) => res?.id,
        () => undefined
      )
    return posted ? 'followed-up' : 'failed'
  },

  async tellPrivately(handle: Omit<CapabilityCardHandle, 'ts'>, userId: string, text: string): Promise<void> {
    const click = capabilityClick(handle.conn, userId)
    if (click) {
      click.reply(text)
      return
    }
    const port = handle.conn as Partial<MattermostCapabilityPort> | undefined
    const rootId = handle.thread && handle.thread !== MATTERMOST_DM_THREAD ? handle.thread : undefined
    await port?.postEphemeral?.(handle.channel, userId, text, rootId).catch(() => undefined)
  },

  async openDirectMessage(conn: unknown, userId: string): Promise<string> {
    const port = conn as Partial<MattermostCapabilityPort> | undefined
    if (!port?.openDirectMessage) throw new Error('mattermost: connection cannot open a direct message')
    return await port.openDirectMessage(userId)
  },

  async isPerson(conn: unknown, userId: string): Promise<boolean> {
    const click = capabilityClick(conn, userId)
    if (click?.isBot !== undefined) return !click.isBot
    const port = conn as Partial<MattermostCapabilityPort> | undefined
    if (port?.getUserProfile) {
      const profile = await port.getUserProfile(userId).catch(() => undefined)
      if (profile?.isBot !== undefined) return !profile.isBot
    }
    return false
  },

  async directMessageWith(conn: unknown, channel: string): Promise<string | null> {
    const port = conn as Partial<MattermostCapabilityPort> | undefined
    if (!port?.getChannelInfo) throw new Error('mattermost: connection cannot read channel info')
    const info = await port.getChannelInfo(channel)
    if (!info.isIm) return null
    if (!info.user) throw new Error('mattermost: direct message named no counterparty')
    return info.user
  },

  async nameOf(conn: unknown, userId: string): Promise<string | undefined> {
    const click = capabilityClick(conn, userId)
    if (click?.name) return click.name
    const port = conn as Partial<MattermostCapabilityPort> | undefined
    const profile = await port?.getUserProfile?.(userId).catch(() => undefined)
    return profile?.realName ?? profile?.name
  }
}
