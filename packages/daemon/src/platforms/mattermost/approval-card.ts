// Mattermost's approval-card facet (§7.3): Markdown prompt + signed interactive attachment buttons forwarded by Relay (or pure-WS `A-XXXXXXXX` numbered replies), patched in place when settled.
import { randomBytes } from 'node:crypto'
import { MATTERMOST_CARD_NOTE_MAX, MATTERMOST_PLATFORM } from '@agentconnect.md/protocol'
import { permToolLabel, type SubsessionNoticeOutcome } from '../../slack/render.js'
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
  subsessionWaitText,
  TURN_NOTICE_TEXT,
  turnNoticeSettledText
} from '../approval-card.js'
import type { ElicitCardHost, ElicitCardTurn } from '../elicit-card.js'
import {
  buildMattermostAttachmentActions,
  mattermostAttachmentProps,
  type MattermostActionCallbackConfig,
  type MattermostAttachment,
  type MattermostAttachmentButtonSpec
} from './action-button.js'
import type { MattermostCardReplyEntry } from './connection.js'
import {
  clampMattermostText,
  MATTERMOST_DM_THREAD,
  safeMattermostCardLink,
  safeMattermostCardUrl,
  sanitizeMattermostCardText,
  sanitizeMattermostPlainText
} from './module.js'
import { MATTERMOST_DEFAULT_POST_SIZE, type MattermostTurnState } from './turn-output.js'

export const MATTERMOST_APPROVAL_MAX_OPTIONS = 25
export const MATTERMOST_BUTTON_LABEL_CAP = 40

const MATTERMOST_LABEL_CAP = 75
const MATTERMOST_DECISION_CAP = 300
const TRACKED_CARD_CAP = 500

const trackedByConn = new WeakMap<object, Map<string, string>>()
const trackedByPostId = new Map<string, string>()

function rememberTrackedTag(conn: object, postId: string, tag: string): void {
  let perConn = trackedByConn.get(conn)
  if (!perConn) {
    perConn = new Map()
    trackedByConn.set(conn, perConn)
  }
  perConn.delete(postId)
  perConn.set(postId, tag)
  if (perConn.size > TRACKED_CARD_CAP) {
    const oldest = perConn.keys().next().value
    if (oldest !== undefined) perConn.delete(oldest)
  }
  trackedByPostId.delete(postId)
  trackedByPostId.set(postId, tag)
  while (trackedByPostId.size > TRACKED_CARD_CAP) {
    const oldest = trackedByPostId.keys().next().value
    if (oldest === undefined) break
    trackedByPostId.delete(oldest)
  }
}

function forgetTrackedTag(conn: unknown, postId: string): string | undefined {
  let tag: string | undefined
  if (conn && typeof conn === 'object') {
    const perConn = trackedByConn.get(conn)
    tag = perConn?.get(postId)
    perConn?.delete(postId)
  }
  const fromGlobal = trackedByPostId.get(postId)
  trackedByPostId.delete(postId)
  return tag ?? fromGlobal
}

/** Generate a short approval-card reply tag (`A-<8 uppercase hex>`). */
export function mattermostApprovalTag(): string {
  return `A-${randomBytes(4).toString('hex').toUpperCase()}`
}

/** Structural Mattermost port used by approval cards; satisfied by {@link MattermostConnection}. */
export interface MattermostApprovalPort {
  readonly maxPostSize?: number
  workspaceId?(): string
  actionCallback?(agentId?: string): MattermostActionCallbackConfig | undefined
  createPost(
    channel: string,
    text: string,
    opts?: { rootId?: string; props?: Record<string, unknown> }
  ): Promise<{ id?: string }>
  patchPost?(postId: string, text: string, opts?: { props?: Record<string, unknown> }): Promise<unknown>
  getUserProfile?(userId: string): Promise<{ name?: string; realName?: string }>
  noteCardReply?(entry: MattermostCardReplyEntry): void
  retireCardReply?(tag: string): void
}

export interface MattermostApprovalRendered {
  readonly text: string
  readonly props?: { attachments: [MattermostAttachment] }
  readonly clearAttachments?: boolean
  readonly retireTag?: boolean
  readonly tag?: string
  readonly resolvedAgentId?: string
  readonly resolvedIntegrationId?: string
  readonly requestId?: string
  readonly optionCount?: number
}

export interface MattermostApprovalDraft {
  render(ctx: {
    conn: unknown
    channel: string
    agentId?: string
    integrationId?: string
  }): MattermostApprovalRendered | null
}

function md(raw: string): string {
  return sanitizeMattermostCardText(raw)
}

function formatPermLabel(raw: string): string {
  const safe = md(raw.replace(/\s+/g, ' ').trim())
  let longest = 0
  let cur = 0
  for (let i = 0; i < safe.length; i++) {
    if (safe.charCodeAt(i) === 96) {
      cur++
      if (cur > longest) longest = cur
    } else {
      cur = 0
    }
  }
  if (longest === 0) return `\`${safe}\``
  const fence = '`'.repeat(longest + 1)
  return `${fence} ${safe} ${fence}`
}

function intro(asker: SubsessionAsker): string {
  const who = md(subsessionAskerText(asker.agentName, asker.title, clampMattermostText))
  const wait = md(subsessionWaitText(asker.waitHours))
  return `${who} is asking for permission. ${wait}\n${safeMattermostCardLink('Open the task', asker.sessionUrl)}`
}

function contextIntro(context: ApprovalCardContext): string {
  const requester = context.requesterName ? ` for ${md(clampMattermostText(context.requesterName, 60))}` : ''
  return `${md(clampMattermostText(context.agentName, 60))} is waiting on an approval${requester}.\n${safeMattermostCardLink('Open session', context.sessionUrl)}`
}

function optionStyle(kind: string): 'good' | 'default' | 'danger' | undefined {
  if (kind === 'allow_once') return 'good'
  if (kind === 'allow_always') return 'default'
  if (kind === 'reject_once' || kind === 'reject_always') return 'danger'
  return undefined
}

function resolvePostRootId(turn: ElicitCardTurn, state: Partial<MattermostTurnState> | undefined): string | undefined {
  const isDm = turn.plan.thread === MATTERMOST_DM_THREAD || state?.isDm === true
  if (isDm) return state?.replyThread
  return turn.plan.thread && turn.plan.thread !== MATTERMOST_DM_THREAD ? turn.plan.thread : undefined
}

function registerApprovalReply(
  port: Partial<MattermostApprovalPort>,
  postId: string,
  channel: string,
  thread: string | undefined,
  rendered: MattermostApprovalRendered
): void {
  if (
    !rendered.tag ||
    !rendered.resolvedAgentId ||
    !rendered.resolvedIntegrationId ||
    !rendered.requestId ||
    rendered.optionCount === undefined
  ) {
    return
  }
  rememberTrackedTag(port, postId, rendered.tag)
  port.noteCardReply?.({
    tag: rendered.tag,
    channel,
    ...(thread ? { thread } : {}),
    postId,
    agentId: rendered.resolvedAgentId,
    integrationId: rendered.resolvedIntegrationId,
    kind: 'approval',
    requestId: rendered.requestId,
    optionCount: rendered.optionCount
  })
}

export const mattermostApprovalCards: ApprovalCardFacet = {
  platform: MATTERMOST_PLATFORM,
  maxOptions: MATTERMOST_APPROVAL_MAX_OPTIONS,
  // No tellPrivately: unauthorized clicks return a refusal string so Relay answers with HTTP 200 `{ ephemeral_text }` and pure-WS posts via `postEphemeral`.
  privateTextLimit: MATTERMOST_CARD_NOTE_MAX,

  canApproveInChat(conn: unknown): boolean {
    return Boolean((conn as Partial<MattermostApprovalPort> | undefined)?.createPost)
  },

  build(ask: ApprovalCardAsk, conn?: unknown): ApprovalCardDraft | null {
    const options = ask.params.options
    if (!options.length || options.length > MATTERMOST_APPROVAL_MAX_OPTIONS) return null
    const port = conn as Partial<MattermostApprovalPort> | undefined
    if (!port?.createPost) return null

    const body = [
      ...(ask.subsession ? [intro(ask.subsession)] : []),
      ...(ask.context ? [contextIntro(ask.context)] : []),
      `🔒 **Permission requested** — ${formatPermLabel(permToolLabel(ask.params))}`
    ].join('\n\n')
    const fallback = clampMattermostText(
      sanitizeMattermostPlainText(`Permission requested: ${permToolLabel(ask.params)}`),
      300
    )
    const hasLongOption = options.some((o) => o.name.length > MATTERMOST_BUTTON_LABEL_CAP)
    const attachmentText = hasLongOption
      ? options.map((o, i) => `${i + 1}. ${md(clampMattermostText(o.name, 200))}`).join('\n')
      : ''
    const wsOptionLines = options
      .map((o, i) => `${i + 1}. ${md(clampMattermostText(o.name, MATTERMOST_LABEL_CAP))}`)
      .join('\n')
    const buildLimit = Math.max(1, port.maxPostSize ?? MATTERMOST_DEFAULT_POST_SIZE)
    const initialCallback = port.actionCallback?.(ask.via?.agentId)
    if (initialCallback) {
      const totalLen = body.length + (attachmentText ? attachmentText.length + 2 : 0)
      if (totalLen > buildLimit || body.length > buildLimit || attachmentText.length > buildLimit) return null
    } else {
      const sampleText = `${body}\n\n${wsOptionLines}\n\n_Reply \`A-00000000 <number>\` (or reply \`<number>\` in this thread) to decide._`
      if (sampleText.length > buildLimit) return null
    }

    return {
      render: ({ conn: renderConn, channel, agentId, integrationId }) => {
        const renderPort = renderConn as Partial<MattermostApprovalPort> | undefined
        const maxPostSize = Math.max(1, renderPort?.maxPostSize ?? port.maxPostSize ?? MATTERMOST_DEFAULT_POST_SIZE)
        const resolvedAgentId = ask.via?.agentId ?? agentId
        const resolvedIntegrationId = ask.via?.integrationId ?? integrationId
        const callback = renderPort?.actionCallback?.(resolvedAgentId)
        if (callback) {
          if (!resolvedAgentId || !resolvedIntegrationId) return null
          const totalLen = body.length + (attachmentText ? attachmentText.length + 2 : 0)
          if (totalLen > maxPostSize || body.length > maxPostSize || attachmentText.length > maxPostSize) {
            return null
          }
          const specs: MattermostAttachmentButtonSpec[] = options.map((o, i) => {
            const style = optionStyle(o.kind)
            const buttonText = sanitizeMattermostPlainText(hasLongOption ? `${i + 1}. ${o.name}` : o.name)
            return {
              id: `opt${i}`,
              name: clampMattermostText(buttonText || `Option ${i + 1}`, MATTERMOST_BUTTON_LABEL_CAP),
              ...(style ? { style } : {}),
              claims: {
                agentId: resolvedAgentId,
                integrationId: resolvedIntegrationId,
                channelId: channel,
                kind: 'approval',
                requestId: ask.requestId,
                option: i
              }
            }
          })
          const actions = buildMattermostAttachmentActions(callback, specs)
          if (!actions) return null
          return {
            text: body,
            props: mattermostAttachmentProps({ text: attachmentText, fallback, actions })
          }
        }
        const tag = mattermostApprovalTag()
        const instruction = `_Reply \`${tag} <number>\` (or reply \`<number>\` in this thread) to decide._`
        const text = `${body}\n\n${wsOptionLines}\n\n${instruction}`
        if (text.length > maxPostSize) return null
        return {
          text,
          tag,
          ...(resolvedAgentId ? { resolvedAgentId } : {}),
          ...(resolvedIntegrationId ? { resolvedIntegrationId } : {}),
          requestId: ask.requestId,
          optionCount: options.length
        }
      }
    } satisfies MattermostApprovalDraft
  },

  settled(settled: ApprovalCardSettlement): ApprovalCardDraft {
    const decision = `${approvalMark(settled.allowed)} ${md(clampMattermostText(settled.text, MATTERMOST_DECISION_CAP))}`
    const text = [
      ...(settled.subsession ? [intro(settled.subsession)] : []),
      ...(settled.context ? [contextIntro(settled.context)] : []),
      `🔒 **Permission** — ${formatPermLabel(permToolLabel(settled.params))}\n${decision}`
    ].join('\n\n')
    return {
      render: () => ({ text, clearAttachments: true, retireTag: true })
    } satisfies MattermostApprovalDraft
  },

  notice(asker: SubsessionAsker): ApprovalCardDraft {
    const who = md(subsessionAskerText(asker.agentName, asker.title, clampMattermostText))
    const wait = md(subsessionWaitText(asker.waitHours))
    const link = safeMattermostCardLink('Open the task', asker.sessionUrl)
    const text = `🔒 ${who} is waiting for permission. Ask an Agent editor to allow it from the Agent or Session page. ${wait}\n\n${link}`
    return {
      render: () => ({ text })
    } satisfies MattermostApprovalDraft
  },

  noticeSettled(view: SubsessionNoticeView, outcome: SubsessionNoticeOutcome): ApprovalCardDraft {
    const line = md(
      subsessionSettledText(subsessionAskerText(view.agentName, view.title, clampMattermostText), outcome, (s) =>
        clampMattermostText(s, 60)
      )
    )
    const safeUrl = view.sessionUrl ? safeMattermostCardUrl(view.sessionUrl) : undefined
    const text = safeUrl ? `${line}\n\n[Open the task](${safeUrl})` : line
    return {
      render: () => ({ text, clearAttachments: true, retireTag: true })
    } satisfies MattermostApprovalDraft
  },

  turnNotice(): ApprovalCardDraft {
    return {
      render: () => ({ text: TURN_NOTICE_TEXT })
    } satisfies MattermostApprovalDraft
  },

  turnNoticeSettled(outcome: SubsessionNoticeOutcome): ApprovalCardDraft {
    const text = md(turnNoticeSettledText(outcome, (s) => clampMattermostText(s, 60)))
    return {
      render: () => ({ text, clearAttachments: true, retireTag: true })
    } satisfies MattermostApprovalDraft
  },

  orphaned(row: ApprovalCardOrphan): ApprovalCardDraft {
    const by = row.resolvedByName ? ` by ${md(clampMattermostText(row.resolvedByName, 60))}` : ''
    const text = `🔒 Permission — ${md(clampMattermostText(row.command, 150))}\n${orphanMark(row.status)} ${md(row.status)}${by}`
    return {
      render: () => ({ text, clearAttachments: true, retireTag: true })
    } satisfies MattermostApprovalDraft
  },

  async send(host: ElicitCardHost, turn: ElicitCardTurn, draft: ApprovalCardDraft): Promise<string | undefined> {
    const state = host.turnState(turn) as Partial<MattermostTurnState> | undefined
    const isDm = turn.plan.thread === MATTERMOST_DM_THREAD || state?.isDm === true
    const rootId = resolvePostRootId(turn, state)
    const tagThread = isDm ? MATTERMOST_DM_THREAD : rootId
    const d = draft as MattermostApprovalDraft
    return await host.postCardSerialized(turn, async (conn) => {
      const port = (state?.conn ?? conn) as Partial<MattermostApprovalPort> | undefined
      if (!port?.createPost) return undefined
      const rendered = d.render({
        conn: port,
        channel: turn.plan.channel,
        agentId: turn.plan.agentId,
        integrationId: turn.plan.integrationId
      })
      if (!rendered) return undefined
      const post = await port.createPost(turn.plan.channel, rendered.text, {
        ...(rootId ? { rootId } : {}),
        ...(rendered.props ? { props: rendered.props } : {})
      })
      if (!post?.id) return undefined
      registerApprovalReply(port, post.id, turn.plan.channel, tagThread, rendered)
      return post.id
    })
  },

  async post(
    conn: unknown,
    place: ApprovalCardPlace,
    draft: ApprovalCardDraft,
    turn: ElicitCardTurn
  ): Promise<string | undefined> {
    const port = conn as Partial<MattermostApprovalPort> | undefined
    if (!port?.createPost) return undefined
    const rootId = place.thread && place.thread !== MATTERMOST_DM_THREAD ? place.thread : undefined
    const tagThread = place.thread
    const rendered = (draft as MattermostApprovalDraft).render({
      conn: port,
      channel: place.channel,
      agentId: turn.plan.agentId,
      integrationId: turn.plan.integrationId
    })
    if (!rendered) return undefined
    const post = await port.createPost(place.channel, rendered.text, {
      ...(rootId ? { rootId } : {}),
      ...(rendered.props ? { props: rendered.props } : {})
    })
    if (!post?.id) return undefined
    registerApprovalReply(port, post.id, place.channel, tagThread, rendered)
    return post.id
  },

  rewrite(handle: ApprovalCardHandle, draft: ApprovalCardDraft): void {
    if (handle.ts === undefined) return
    const port = handle.conn as Partial<MattermostApprovalPort> | undefined
    if (!port) return
    const rendered = (draft as MattermostApprovalDraft).render({
      conn: port,
      channel: handle.channel
    })
    if (!rendered) return
    if (rendered.retireTag || rendered.clearAttachments) {
      const tag = forgetTrackedTag(handle.conn, handle.ts)
      if (tag) port.retireCardReply?.(tag)
    }
    if (!port.patchPost) return
    const props = rendered.clearAttachments ? { attachments: [] } : rendered.props
    void port.patchPost(handle.ts, rendered.text, props ? { props } : undefined).catch(() => {})
  },

  answerScope(handle: ApprovalCardHandle): string | undefined {
    return (handle.conn as Partial<MattermostApprovalPort> | undefined)?.workspaceId?.()
  },

  async nameOf(handle: ApprovalCardHandle, userId: string): Promise<string | undefined> {
    const port = handle.conn as Partial<MattermostApprovalPort> | undefined
    const profile = await port?.getUserProfile?.(userId).catch(() => undefined)
    return profile?.realName ?? profile?.name
  }
}
