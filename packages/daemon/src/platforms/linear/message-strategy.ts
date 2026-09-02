/**
 * Linear's **message strategy** (linear-integration.md §8): the delivered `im` message plus
 * the round-tripped `adapterExt.linear` bag become one dispatch prompt and one standing block.
 *
 * The trust split is the whole point. The header is DAEMON-authored and states the actionable
 * identity (issue, delegator, URL); the member's instruction is `text` verbatim, because a
 * workspace member is the same trust class as a Slack user; everything else — the issue body
 * Linear hands us as `promptContext`, and the comments before the mention — is quoted context
 * inside the shared untrusted fence, since an issue can carry customer intake or a forwarded
 * email nobody in the workspace wrote.
 *
 * What is session-stable — the issue and team coordinates the tool family takes, and the
 * convention of working inside an issue — rides `standingContext`, read once on the
 * system-prompt channel and never a transcript row; the per-turn prompt carries only what the
 * member said this time. Mutable issue state (workflow state, assignee, labels) is deliberately
 * absent: a snapshot goes stale within the session, and `getIssue` answers it live.
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
  // The issue's team — the channel coordinate itself (§4.5), and the `channelName` this side
  // renders. Read tolerantly: an older relay omits it, and the label degrades to the id.
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

/** One Linear team — the channel (§4.5) — as the bag and the connection's read port name it. */
export interface LinearTeamRef {
  id: string
  key?: string
  name?: string
}

/** The connected workspace: all that is left to label the issue-less channel (§4.5). */
export interface LinearWorkspaceRef {
  workspaceName?: string
  workspaceId(): string
}

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

/** Cap on a short §8 context-block value (name, key, label, state) — the block is paid every turn. */
const FACT_MAX_CHARS = 80

/** Flatten a provider string to one capped, fence-inert line so attacker-authored framing can
 *  neither shape the daemon's own lines nor open a new line or an untrusted fence on them. */
export function sanitizeTitle(raw: string, maxChars = TITLE_MAX_CHARS): string {
  const flat = neutralizeDelimiters(raw.replace(/\s+/g, ' ').trim())
  return flat.length > maxChars ? `${flat.slice(0, maxChars - 1)}…` : flat
}

/** The bag on a delivered message, or undefined when it is absent or malformed (fail closed). */
export function readLinearExt(msg: Pick<NormalizedMessage, 'adapterExt'>): LinearAdapterExt | undefined {
  const bag = msg.adapterExt?.['linear']
  if (bag === undefined) return undefined
  const parsed = LinearAdapterExtSchema.safeParse(bag)
  return parsed.success ? parsed.data : undefined
}

/** What a Linear label joins the workspace and the team with — names, in the console's own
 *  composite-label separator. Mirrored by the CP, which writes the same row, and by the web
 *  module, which takes the label apart again. */
const LINEAR_LABEL_SEPARATOR = ' / '

/**
 * §4.5 session `channelName`: the issue's TEAM, named the way its members say it —
 * `<Workspace name> / <Team name>`. The team KEY is an identifier, not a label, so it never
 * leads here; it reaches the agent on the §8 context block instead.
 *
 * Read from the BAG, never re-derived: the relay already keys `channel` on the team id, so this
 * side only labels a coordinate it is handed. Degrades one name at a time — no workspace name
 * leaves the team's own, an unnamed team falls back to its key and then to its id — and, for the
 * issue-less channel alone, which has no team, to the connected workspace's own label.
 */
export function linearChannelName(team: LinearTeamRef | undefined, workspace?: LinearWorkspaceRef): string {
  const space = workspace?.workspaceName ? sanitizeTitle(workspace.workspaceName) : ''
  if (!team) return workspace ? space || workspace.workspaceId() : ''
  // A team the workspace named neither way degrades to its bare id — prefixing an id with the
  // workspace would dress an identifier up as a label rather than replace it.
  const label = short(team.name) || short(team.key)
  if (!label) return team.id
  return space ? `${space}${LINEAR_LABEL_SEPARATOR}${label}` : label
}

/**
 * §4.5: the session Linear opened carries no issue — `app:mentionable` also covers documents
 * and other editor surfaces. v1 answers such a surface once and starts no turn. Read off the
 * ABSENCE of issue metadata in the bag: the channel is the team (or, here, the workspace), so
 * the coordinates no longer say anything about which surface the session was opened on.
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
  const subject = ext.issueIdentifier ? sanitizeTitle(ext.issueIdentifier, FACT_MAX_CHARS) : ext.agentSessionId
  const title = ext.issueTitle ? sanitizeTitle(ext.issueTitle) : ''
  const head = `Linear ${subject}${title ? ` "${title}"` : ''} — delegated by ${actorLabel(msg)}`
  return msg.threadUrl ? `${head}\n${msg.threadUrl}` : head
}

/** The working convention the standing block closes with — the tool names are the model's entry points. */
const LINEAR_WORKING_CONVENTION =
  'Working here: the issue is the record — put the plan and the outcome into its description or a comment ' +
  '(`updateIssue` / `createIssueComment`); name the branch and the PR after the identifier so Linear links ' +
  'them; if the ticket is empty or ambiguous, ask in your response before working; the team’s workflow ' +
  'state NAMES are what `updateIssue` takes for `state` (`listIssueStatuses`); read the current state, ' +
  'assignee and labels with `getIssue` rather than assuming them.'

/** `- Key: value`, or nothing at all — the block omits an absent fact instead of printing a dash. */
function fact(key: string, value: string): string {
  return value ? `- ${key}: ${value}` : ''
}

/** One sanitized short value, or '' when the bag did not carry it. */
function short(raw: string | undefined): string {
  return raw ? sanitizeTitle(raw, FACT_MAX_CHARS) : ''
}

/**
 * The daemon-authored §8 standing block: the session-stable coordinates the Linear tool family
 * takes (issue identifier, UUID, title, URL; team key, name, id), then the working convention.
 * Built from the bag alone — the session is one issue for its whole life, so nothing here needs
 * a provider read. Daemon-authored means every provider string is flattened and capped first.
 */
export function buildLinearStandingContext(msg: Pick<NormalizedMessage, 'threadUrl'>, ext: LinearAdapterExt): string {
  const identifier = short(ext.issueIdentifier)
  const title = sanitizeTitle(ext.issueTitle ?? '')
  const head = [identifier, ext.issueId ? `(id ${short(ext.issueId)})` : ''].filter(Boolean).join(' ')
  const issue = [head, title ? `"${title}"` : '', msg.threadUrl ? sanitizeTitle(msg.threadUrl) : '']
    .filter(Boolean)
    .join(' — ')
  // Name first, as the channel label does — the key and the id are the machine coordinates the
  // tool family takes, so they trail in parentheses instead of prefixing what a member would say.
  const teamKey = short(ext.team?.key)
  const teamHead = short(ext.team?.name) || teamKey
  const teamMeta = [
    teamKey && teamHead !== teamKey ? `key ${teamKey}` : '',
    ext.team?.id ? `id ${short(ext.team.id)}` : ''
  ].filter(Boolean)
  const team = teamHead ? [teamHead, teamMeta.length ? `(${teamMeta.join(', ')})` : ''].filter(Boolean).join(' ') : ''
  const facts = [fact('Issue', issue), fact('Team', team)].filter(Boolean)
  return ['# Linear', ...facts, '', LINEAR_WORKING_CONVENTION].join('\n')
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
 * instruction (verbatim — a workspace member instructs), then workspace-admin guidance, and only
 * then the fenced context nobody in the workspace need have written. The coordinates and the
 * working convention are NOT here — they are standing (`buildLinearStandingContext`).
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
 * Rewrite one delivered Linear message into the turn's prompt and standing block, in place.
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
  msg.standingContext = buildLinearStandingContext(msg, ext)
  msg.source = 'user'
  msg.trigger = 'mention'
  msg.isDm = false
  msg.headless = false
  return ext
}
