/**
 * Linear's **message strategy** (linear-integration.md §8): the delivered `im` message plus
 * the round-tripped `adapterExt.linear` bag become one dispatch prompt.
 *
 * The trust split is the whole point. The header is DAEMON-authored and states the actionable
 * identity (issue, title, actor, URL); the member's instruction is `text` verbatim, because a
 * workspace member is the same trust class as a Slack user; everything else — the issue body
 * Linear hands us as `promptContext`, and the comments before the mention — is quoted context
 * inside the shared untrusted fence, since an issue can carry customer intake or a forwarded
 * email nobody in the workspace wrote.
 *
 * Pure by construction: no clock, no store, no connection. The composition lines in
 * `daemon.ts` decide when to run it; this module only decides what the turn reads.
 */
import { z } from 'zod'
import {
  neutralizeDelimiters,
  UNTRUSTED_CONTENT_BEGIN_LINEAR,
  UNTRUSTED_CONTENT_END
} from '../../messages/hook-message.js'
import type { NormalizedMessage } from '../../messages/normalized.js'

/** One earlier comment the relay budgeted into the bag. Only the fields it forwards exist. */
const LinearPreviousComment = z.object({
  id: z.string().optional(),
  body: z.string().optional(),
  userId: z.string().optional(),
  createdAt: z.string().optional()
})

/** §6.4 adapter-extension bag, as the relay's linear plugin mints it. Read tolerantly: an
 *  older relay may omit any optional field, and none of them is load-bearing for the turn. */
export const LinearAdapterExtSchema = z.object({
  agentSessionId: z.string().min(1),
  event: z.enum(['created', 'prompted']).optional(),
  // The issue's team — the channel coordinate itself (§4.5). Read tolerantly here; the
  // coordinates, `channelName` and the §8 header adopt it in their own change.
  team: z.object({ id: z.string(), key: z.string().optional(), name: z.string().optional() }).optional(),
  issueId: z.string().optional(),
  issueIdentifier: z.string().optional(),
  issueTitle: z.string().optional(),
  promptContext: z.string().optional(),
  guidance: z.string().optional(),
  previousComments: z.array(LinearPreviousComment).optional(),
  truncated: z.boolean().optional()
})
export type LinearAdapterExt = z.infer<typeof LinearAdapterExtSchema>

/** The stop payload the relay puts on `platform_action` (§6.3). */
export const LinearStopActionSchema = z.object({
  kind: z.literal('stop'),
  agentSessionId: z.string().min(1)
})
export type LinearStopAction = z.infer<typeof LinearStopActionSchema>

/** §4.5 v1 copy for a session Linear opened on a surface this build cannot serve. */
export const LINEAR_UNSUPPORTED_SURFACE_BODY = 'Mention me on an issue — this surface is not supported yet.'
/** §5.1 stop row: a `response` settles the Linear session instead of leaving it active. */
export const LINEAR_STOP_RESPONSE_BODY = 'Stopped — reply here to continue.'
/** Appended inside the fence when the relay's context budget cut something (§8). */
export const LINEAR_TRUNCATION_NOTE = '(context truncated)'

/** Cap on the `error` activity a failed turn settles with — a runtime can narrate a very long
 *  terminal error, and the feed row is chrome, not the transcript (which keeps it in full). */
export const MAX_FAILURE_BODY = 2000

/** §5.1's failure row: the reason, bounded, as the settling `error` body. */
export function linearFailureBody(reason: string): string {
  const text = reason.trim() || 'the turn failed'
  return text.length > MAX_FAILURE_BODY ? `${text.slice(0, MAX_FAILURE_BODY)}…` : text
}

/**
 * The durable receipt id for one delivered Linear event.
 *
 * Deliberately NOT the ordinary durable-inbox id: core deletes that row the moment the turn
 * reaches a terminal state, because it is a replay queue for work in flight. Linear's
 * redelivery ladder is 1 min / 1 h / 6 h, so every redelivery that matters arrives AFTER the
 * row is gone — without a record that outlives the turn, a redelivery re-acks an append-only
 * feed and re-runs the turn. This namespace is that record, and it can never collide with the
 * dispatch row it outlives.
 */
export function linearDeliveryReceiptId(deliveryId: string): string {
  return `linear-served\u001f${deliveryId}`
}

/** Header/ack cap on the attacker-authored title — the relay flattens it too, and neither
 *  side may assume the other did (the daemon renders it on its own TRUSTED line). */
const TITLE_MAX_CHARS = 200

/** Flatten a title to one short line so attacker-authored framing cannot shape the header. */
export function sanitizeTitle(raw: string): string {
  const flat = raw.replace(/\s+/g, ' ').trim()
  return flat.length > TITLE_MAX_CHARS ? `${flat.slice(0, TITLE_MAX_CHARS - 1)}…` : flat
}

/** The bag on a delivered message, or undefined when it is absent or malformed (fail closed). */
export function readLinearExt(msg: Pick<NormalizedMessage, 'adapterExt'>): LinearAdapterExt | undefined {
  const bag = msg.adapterExt?.['linear']
  if (bag === undefined) return undefined
  const parsed = LinearAdapterExtSchema.safeParse(bag)
  return parsed.success ? parsed.data : undefined
}

/** §4.5 session `channelName`: the connected WORKSPACE, since the workspace is the channel.
 *  Degrades to the organization id — a session labelled by its tenant beats one labelled
 *  `undefined`, and the issue rides `threadUrl` plus the §8 header either way. */
export function linearChannelName(conn: { workspaceName?: string; workspaceId(): string }): string {
  const name = conn.workspaceName ? sanitizeTitle(conn.workspaceName) : ''
  return name || conn.workspaceId()
}

/**
 * §4.5: the session Linear opened carries no issue — `app:mentionable` also covers documents
 * and other editor surfaces. v1 answers such a surface once and starts no turn. Read off the
 * ABSENCE of issue metadata in the bag: the channel is the workspace now, so the coordinates
 * no longer say anything about which surface the session was opened on.
 */
export function isLinearIssuelessSurface(ext: LinearAdapterExt): boolean {
  return ext.issueIdentifier === undefined && ext.issueTitle === undefined
}

/** The actor as the trusted header names them: the provider's display name when the event
 *  carried one, else the bare id with the platform prefix stripped. Never fabricated. */
function actorLabel(msg: Pick<NormalizedMessage, 'sender'>): string {
  const name = msg.sender.name?.replace(/\s+/g, ' ').trim()
  if (name) return sanitizeTitle(name)
  const id = msg.sender.id.startsWith('linear:') ? msg.sender.id.slice('linear:'.length) : msg.sender.id
  return id || 'unknown'
}

/** The daemon-authored header: what this turn is about, who asked, and where it lives. */
function trustedHeader(msg: Pick<NormalizedMessage, 'sender' | 'threadUrl'>, ext: LinearAdapterExt): string {
  const subject = ext.issueIdentifier?.trim() ?? ext.agentSessionId
  const title = ext.issueTitle ? sanitizeTitle(ext.issueTitle) : ''
  const head = `Linear ${subject}${title ? ` "${title}"` : ''} — delegated by ${actorLabel(msg)}`
  return msg.threadUrl ? `${head}\n${msg.threadUrl}` : head
}

type LinearPreviousComment = z.infer<typeof LinearPreviousComment>

/** One quoted comment line. The author is an id, not a name: the relay forwards no profile. */
function renderComment(comment: LinearPreviousComment): string {
  const body = comment.body?.trim()
  if (!body) return ''
  const who = comment.userId ? `linear:${comment.userId}` : 'unknown'
  const when = comment.createdAt ? ` at ${comment.createdAt}` : ''
  return `${who}${when}:\n${body}`
}

/** Everything the workspace did NOT author for this turn — fenced, never instructions. */
function quotedContext(ext: LinearAdapterExt): string {
  const blocks: string[] = []
  const context = ext.promptContext?.trim()
  if (context) blocks.push(context)
  for (const comment of ext.previousComments ?? []) {
    const rendered = renderComment(comment)
    if (rendered) blocks.push(rendered)
  }
  if (blocks.length === 0 && !ext.truncated) return ''
  const body = neutralizeDelimiters(blocks.join('\n\n'))
  return [
    UNTRUSTED_CONTENT_BEGIN_LINEAR,
    ...(body ? [body] : []),
    UNTRUSTED_CONTENT_END,
    ...(ext.truncated ? [LINEAR_TRUNCATION_NOTE] : [])
  ].join('\n')
}

/**
 * §8 prompt assembly. Order is the trust order: the daemon's own header, then the member's
 * instruction (verbatim — a workspace member instructs), then workspace-admin guidance, and
 * only then the fenced context nobody in the workspace need have written.
 */
export function buildLinearPromptText(
  msg: Pick<NormalizedMessage, 'sender' | 'text' | 'threadUrl'>,
  ext: LinearAdapterExt
): string {
  const sections = [trustedHeader(msg, ext)]
  const instruction = msg.text.trim()
  if (instruction) sections.push(instruction)
  const guidance = ext.guidance?.trim()
  if (guidance) sections.push(`Workspace guidance (authored by a Linear workspace admin):\n${guidance}`)
  const context = quotedContext(ext)
  if (context) sections.push(context)
  return sections.join('\n\n')
}

/**
 * The ≤10 s pre-spawn acknowledgement (§10.1) — the ONE activity posted outside the converger.
 * It opens with the acting agent's name because every agent posts through the one deployment
 * app, so content is the only place identity can appear (§5).
 */
export function linearAckBody(agentName: string, ext: LinearAdapterExt, opts: { queued?: boolean } = {}): string {
  const subject = ext.issueIdentifier?.trim() ?? ext.agentSessionId
  const name = sanitizeTitle(agentName) || 'agent'
  return opts.queued ? `**${name}** · queued behind the current task` : `**${name}** · reading ${subject} …`
}

/**
 * Rewrite one delivered Linear message into the turn's prompt, in place.
 *
 * The relay already sets `source`/`trigger`/`isDm`; they are restated here because §8 names
 * them and this is the seat that owns the turn's shape — a delivery that lost one of them
 * upstream must still dispatch as an explicitly-addressed, non-DM user turn with a live
 * reply surface (`headless: false`).
 */
export function applyLinearMessageStrategy(msg: NormalizedMessage): LinearAdapterExt | undefined {
  const ext = readLinearExt(msg)
  if (!ext) return undefined
  msg.text = buildLinearPromptText(msg, ext)
  msg.source = 'user'
  msg.trigger = 'mention'
  msg.isDm = false
  msg.headless = false
  return ext
}
