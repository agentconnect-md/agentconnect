// Mattermost elicitation card facet (§7.3): QQ/WeCom-style numbered text prompt answered by `<tag> <n>` or a bare number when alone in its thread.
import { randomBytes } from 'node:crypto'
import type { CreateElicitationRequest } from '@agentclientprotocol/sdk/unstable'
import { elicitFormBlockId, MATTERMOST_PLATFORM } from '@agentconnect.md/protocol'
import { elicitOptionToken, type ElicitKind, type ElicitSurface, type ElicitTarget } from '../../slack/render.js'
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
import {
  buildMattermostAttachmentActions,
  mattermostAttachmentProps,
  type MattermostActionCallbackConfig,
  type MattermostAttachmentButtonSpec
} from './action-button.js'
import {
  clampMattermostText,
  MATTERMOST_DM_THREAD,
  sanitizeMattermostCardText,
  sanitizeMattermostPlainText
} from './module.js'
import type { MattermostTurnState } from './turn-output.js'

export const MATTERMOST_ELICIT_MAX_OPTIONS = 20
export const MATTERMOST_ELICIT_QUESTION_CAP = 3_400
export const MATTERMOST_ELICIT_DECISION_CAP = 300
export const MATTERMOST_ELICIT_LABEL_CAP = 40

export const MATTERMOST_ELICIT_SURFACE: ElicitSurface = {
  kinds: new Set<ElicitKind>(['enum', 'boolean']),
  optionLimits: {
    enum: { maxOptions: MATTERMOST_ELICIT_MAX_OPTIONS }
  }
}

const MATTERMOST_ELICIT_MARK: Record<ElicitCardMark, string> = {
  answered: '✅',
  dismissed: '🚫',
  waiting: '⏳',
  blocked: '🔒'
}

/** Structural Mattermost port used by elicitation cards; satisfied by {@link MattermostConnection}. */
export interface MattermostElicitPort {
  workspaceId?(): string
  actionCallback?(agentId?: string): MattermostActionCallbackConfig | undefined
  createPost(
    channel: string,
    text: string,
    opts?: { rootId?: string; props?: Record<string, unknown> }
  ): Promise<{ id?: string }>
  patchPost?(postId: string, text: string, opts?: { props?: Record<string, unknown> }): Promise<unknown>
  noteQuestionTag?(channel: string, tag: string, thread?: string): void
  retireQuestionTag?(tag: string): void
}

export interface MattermostElicitDraft {
  readonly tag: string
  readonly text: string
  readonly requestId: string
  readonly target: ElicitTarget
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Generate a short per-question reply tag (e.g. `Q-8F2A1B0C`). */
export function mattermostQuestionTag(): string {
  return `Q-${randomBytes(4).toString('hex').toUpperCase()}`
}

/** Render the numbered Markdown question card with its `<tag> <n>` and bare-number instructions. */
export function mattermostElicitText(message: string, target: ElicitTarget, tag: string, isDm = false): string {
  const scope = isDm ? 'this conversation' : 'this thread'
  const safeQuestion = sanitizeMattermostCardText(clampMattermostText(message, MATTERMOST_ELICIT_QUESTION_CAP))
  return [
    `💬 ${safeQuestion}`,
    '',
    ...target.options.map((o, i) => `${i + 1}. ${sanitizeMattermostCardText(clampMattermostText(o.label, 200))}`),
    '',
    `Reply with \`${tag} <number>\` (or just \`<number>\` if this is the only open question in ${scope}).`
  ].join('\n')
}

function matchChoiceToken(target: ElicitTarget, token: string): number | null {
  const normalized = token.normalize('NFKC').trim().toLowerCase()
  if (!normalized) return null
  if (/^\d{1,2}$/.test(normalized)) {
    const n = Number(normalized)
    return n >= 1 && n <= target.options.length ? n - 1 : null
  }
  const idx = target.options.findIndex(
    (o) =>
      o.label.normalize('NFKC').toLowerCase() === normalized || o.value.normalize('NFKC').toLowerCase() === normalized
  )
  return idx >= 0 ? idx : null
}

/**
 * Parse a user's reply into a 0-based option index, accepting:
 * `<tag> <n>`, `@bot <tag> <n>`, `<n> <tag>`, bare `<n>`, or option label/value.
 */
export function mattermostElicitChoice(target: ElicitTarget, reply: string, expectedTag?: string): number | null {
  let text = reply.normalize('NFKC').trim()
  if (!text) return null
  // Strip one or more leading @username tokens (e.g. channel mention before tag or number).
  text = text.replace(/^(?:@[A-Za-z0-9._-]+[\s,:]*)+/i, '').trim()
  if (expectedTag) {
    const leadTag = new RegExp(`^${escapeRegExp(expectedTag)}(?:\\s*[:\\-]\\s*|\\s+|$)`, 'i')
    const trailTag = new RegExp(`(?:^|\\s+)${escapeRegExp(expectedTag)}$`, 'i')
    text = text.replace(leadTag, '').replace(trailTag, '').trim()
  } else {
    text = text
      .replace(/^Q-[0-9A-F]{8}(?:\s*[:\-]\s*|\s+|$)/i, '')
      .replace(/(?:^|\s+)Q-[0-9A-F]{8}$/i, '')
      .trim()
  }
  return matchChoiceToken(target, text)
}

function questionHeading(params: CreateElicitationRequest): string {
  const message = (params as { message?: unknown }).message
  const trimmed = typeof message === 'string' && message.trim() ? message.trim() : 'Question'
  return sanitizeMattermostCardText(clampMattermostText(trimmed, MATTERMOST_ELICIT_QUESTION_CAP))
}

interface PostedQuestionMeta {
  readonly postId: string
  readonly text: string
  readonly rootId?: string
  readonly hasActions?: boolean
}

const QUESTION_META_CAP = 500
const postedByConn = new WeakMap<object, Map<string, PostedQuestionMeta>>()
const postedByTag = new Map<string, PostedQuestionMeta>()

function rememberPostedQuestion(conn: object, tag: string, meta: PostedQuestionMeta): void {
  let perConn = postedByConn.get(conn)
  if (!perConn) {
    perConn = new Map()
    postedByConn.set(conn, perConn)
  }
  perConn.delete(tag)
  perConn.set(tag, meta)
  if (perConn.size > QUESTION_META_CAP) {
    const oldest = perConn.keys().next().value
    if (oldest !== undefined) perConn.delete(oldest)
  }
  postedByTag.delete(tag)
  postedByTag.set(tag, meta)
  while (postedByTag.size > QUESTION_META_CAP) {
    const oldest = postedByTag.keys().next().value
    if (oldest !== undefined) postedByTag.delete(oldest)
  }
}

function getPostedQuestion(handle: Pick<ElicitCardHandle, 'conn' | 'ts'>): PostedQuestionMeta | undefined {
  if (!handle.ts) return undefined
  const conn = handle.conn
  if (conn && typeof conn === 'object') {
    const fromConn = postedByConn.get(conn)?.get(handle.ts)
    if (fromConn) return fromConn
  }
  return postedByTag.get(handle.ts)
}

function forgetPostedQuestion(handle: Pick<ElicitCardHandle, 'conn' | 'ts'>): PostedQuestionMeta | undefined {
  if (!handle.ts) return undefined
  const meta = getPostedQuestion(handle)
  if (handle.conn && typeof handle.conn === 'object') {
    postedByConn.get(handle.conn)?.delete(handle.ts)
  }
  postedByTag.delete(handle.ts)
  return meta
}

function elicitPort(handle: Pick<ElicitCardHandle, 'conn'>): MattermostElicitPort | undefined {
  const port = handle.conn as MattermostElicitPort | undefined
  return port && typeof port.createPost === 'function' ? port : undefined
}

function elicitRootId(
  handle: Pick<ElicitCardHandle, 'conn' | 'thread' | 'ts'>,
  meta?: PostedQuestionMeta
): string | undefined {
  const stored = meta ?? getPostedQuestion(handle)
  if (stored) return stored.rootId
  return handle.thread && handle.thread !== MATTERMOST_DM_THREAD ? handle.thread : undefined
}

function resolveTurnAnchors(
  host: ElicitCardHost,
  turn: ElicitCardTurn
): { rootId: string | undefined; tagThread: string | undefined; isDm: boolean } {
  const state = host.turnState(turn) as Partial<MattermostTurnState> | undefined
  const isDm = turn.plan.thread === MATTERMOST_DM_THREAD
  const rootId = isDm ? state?.replyThread : turn.plan.thread
  const tagThread = isDm ? MATTERMOST_DM_THREAD : rootId
  return { rootId, tagThread, isDm }
}

function settledBody(
  params: CreateElicitationRequest,
  original: string | undefined,
  card: ElicitCardSettlement
): string {
  const statusLine = `${MATTERMOST_ELICIT_MARK[card.mark]} ${sanitizeMattermostCardText(clampMattermostText(card.text, MATTERMOST_ELICIT_DECISION_CAP))}`
  if (!original) return `${questionHeading(params)}\n\n${statusLine}`
  // Replace the numbered prompt instructions on settle so stale reply instructions vanish.
  const withoutInstruction = original.replace(/\n\nReply with `Q-[0-9A-F]{8}[\s\S]*$/i, '')
  return `${withoutInstruction}\n\n${statusLine}`
}

export const mattermostElicitCards: ElicitCardFacet = {
  platform: MATTERMOST_PLATFORM,
  reduction: MATTERMOST_ELICIT_SURFACE,

  build(host: ElicitCardHost, turn: ElicitCardTurn, ask: ElicitCardAsk): ElicitCardDraft | null {
    const target = ask.form?.length === 1 ? ask.form[0]! : undefined
    if (ask.url || !target?.options.length) return null
    const tag = mattermostQuestionTag()
    const isDm =
      turn.plan.thread === MATTERMOST_DM_THREAD ||
      (host.turnState(turn) as Partial<MattermostTurnState> | undefined)?.isDm === true
    return {
      tag,
      text: mattermostElicitText(ask.message, target, tag, isDm),
      requestId: ask.requestId,
      target
    } satisfies MattermostElicitDraft
  },

  async send(
    host: ElicitCardHost,
    turn: ElicitCardTurn,
    ask: ElicitCardAsk,
    draft: ElicitCardDraft
  ): Promise<string | undefined> {
    const state = host.turnState(turn) as Partial<MattermostTurnState> | undefined
    const built = draft as MattermostElicitDraft
    const { rootId, tagThread } = resolveTurnAnchors(host, turn)
    return await host.postCardSerialized(turn, async (conn) => {
      const port = (state?.conn ?? conn) as MattermostElicitPort | undefined
      if (!port || typeof port.createPost !== 'function') return undefined
      port.noteQuestionTag?.(turn.plan.channel, built.tag, tagThread)
      try {
        const requestId = ask.requestId || built.requestId
        const specs: MattermostAttachmentButtonSpec[] = turn.plan.integrationId
          ? [
              ...built.target.options.map((o, i) => ({
                id: `opt${i}`,
                name: clampMattermostText(
                  sanitizeMattermostPlainText(o.label) || `Option ${i + 1}`,
                  MATTERMOST_ELICIT_LABEL_CAP
                ),
                claims: {
                  agentId: turn.plan.agentId,
                  integrationId: turn.plan.integrationId!,
                  channelId: turn.plan.channel,
                  kind: 'elicit' as const,
                  requestId,
                  token: elicitOptionToken(i)
                }
              })),
              {
                id: 'dismiss',
                name: 'Dismiss',
                style: 'danger',
                claims: {
                  agentId: turn.plan.agentId,
                  integrationId: turn.plan.integrationId!,
                  channelId: turn.plan.channel,
                  kind: 'elicit' as const,
                  requestId,
                  token: null
                }
              }
            ]
          : []
        const actions =
          specs.length > 0
            ? buildMattermostAttachmentActions(port.actionCallback?.(turn.plan.agentId), specs)
            : undefined
        const props = actions
          ? mattermostAttachmentProps({
              text: '',
              fallback: clampMattermostText(sanitizeMattermostPlainText(ask.fallback || built.text), 300),
              actions
            })
          : undefined
        const postOpts = rootId || props ? { ...(rootId ? { rootId } : {}), ...(props ? { props } : {}) } : undefined
        const post = await port.createPost(turn.plan.channel, built.text, postOpts)
        if (!post?.id) {
          port.retireQuestionTag?.(built.tag)
          return undefined
        }
        rememberPostedQuestion(port, built.tag, {
          postId: post.id,
          text: built.text,
          ...(rootId ? { rootId } : {}),
          ...(props ? { hasActions: true } : {})
        })
        return built.tag
      } catch (err) {
        port.retireQuestionTag?.(built.tag)
        throw err
      }
    })
  },

  claimReply(handle: ElicitCardHandle, card: ElicitCardTapTarget, reply: ElicitCardReply): ElicitCardTap | null {
    if (handle.ts === undefined || reply.replyTo !== handle.ts) return null
    const target = card.form.length === 1 ? card.form[0]! : undefined
    if (!target) return null
    const index = mattermostElicitChoice(target, reply.text, handle.ts)
    if (index === null) {
      const port = elicitPort(handle)
      if (port) {
        const rootId = elicitRootId(handle)
        const hint = `Reply with \`${handle.ts} <number>\` from 1 to ${target.options.length}.`
        void port.createPost(handle.channel, hint, rootId ? { rootId } : undefined).catch(() => undefined)
      }
      return { kind: 'pending' }
    }
    return { kind: 'submit', fields: { [elicitFormBlockId(0)]: elicitOptionToken(index) } }
  },

  settle(handle: ElicitCardHandle, card: ElicitCardSettlement): void {
    const tag = handle.ts
    if (!tag) return
    const meta = forgetPostedQuestion(handle)
    const port = elicitPort(handle)
    port?.retireQuestionTag?.(tag)
    if (!port) return
    const rootId = elicitRootId(handle, meta)
    const settledText = `${MATTERMOST_ELICIT_MARK[card.mark]} ${sanitizeMattermostCardText(clampMattermostText(card.text, MATTERMOST_ELICIT_DECISION_CAP))}`
    if (meta?.postId && typeof port.patchPost === 'function') {
      const patchCall = meta.hasActions
        ? port.patchPost(meta.postId, settledBody(card.params, meta.text, card), { props: { attachments: [] } })
        : port.patchPost(meta.postId, settledBody(card.params, meta.text, card))
      void patchCall.catch(() => {
        void port.createPost(handle.channel, settledText, rootId ? { rootId } : undefined).catch(() => undefined)
      })
      return
    }
    if (card.mark === 'answered') return
    void port.createPost(handle.channel, settledText, rootId ? { rootId } : undefined).catch(() => undefined)
  },

  answerScope(handle: ElicitCardHandle): string | undefined {
    return elicitPort(handle)?.workspaceId?.()
  }
}
