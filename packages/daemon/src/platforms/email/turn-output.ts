// Email's turn output (email-integration.md §6.1): one mail when the turn ends, no progress and no edit; a failed send fails the delivery, not the turn.
import type { SessionUpdate } from '@agentclientprotocol/sdk/unstable'
import { emailParticipants } from '@agentconnect.md/message'
import { EMAIL_PLATFORM, type WireEmailAdapterExt, type WireEmailCall } from '@agentconnect.md/protocol'
import { turnState, type DaemonRenderAction, type Pending } from '../../daemon/turn-types.js'
import { GithubReplyCollector } from '../../github/poster.js'
import type { NormalizedMessage } from '../../messages/normalized.js'
import type { WorkspaceFileLinkResolver } from '../../messages/workspace-file-links.js'
import type { EmailMessages } from '../../store/email-messages.js'
import type { TurnOutputContext, TurnOutputSurface } from '../turn-output.js'
import type { EmailConnection, EmailSendResult, EmailStoredSent } from './connection.js'
import { isOutsider, type EmailMembers } from './members.js'
import { emailCopyable, emailExtOf, emailMayCopyOutsider } from './module.js'
import { isEmailStartedThread } from './threading.js'
import { emailFromName, emailReplyBodies, emailReplyReferences, emailReplySubject } from './render.js'

export { emailFromName } from './render.js'

export type EmailAction =
  // The turn's one answer, or its failure; `recordOnly` keeps it in the session without sending (mode `none`).
  | { kind: 'post'; text: string; recordOnly?: boolean; attributed?: boolean }
  // A core notice (an approval waiting in the Console): kept in the session, never mailed.
  | { kind: 'notice'; text: string }

/** Collects the whole turn and selects its final answer at the end; nothing is published before it. */
export class EmailConverger {
  private readonly collector = new GithubReplyCollector()
  private finalized = false

  constructor(
    private readonly mode: string,
    private readonly resolveFileLink?: WorkspaceFileLinkResolver
  ) {}

  onUpdate(update: SessionUpdate): EmailAction[] {
    if (!this.finalized) this.collector.onUpdate(update)
    return []
  }

  hasBuffered(): boolean {
    return false
  }

  flushBuffered(): EmailAction[] {
    return []
  }

  /** A turn that fails sends its failure, which core posts after this, so a partial answer is not mailed beside it. */
  flushTerminal(): EmailAction[] {
    return []
  }

  onFinal(_attribution?: unknown): EmailAction[] {
    if (this.finalized) return []
    this.finalized = true
    // The no-response marker and an empty turn select nothing, so no mail goes out.
    const text = this.collector
      .finalText(true, { ...(this.resolveFileLink ? { resolveFileLink: this.resolveFileLink } : {}) })
      ?.trim()
    if (!text) return []
    return [{ kind: 'post', text, attributed: false, ...(this.mode === 'none' ? { recordOnly: true } : {}) }]
  }
}

/** The core turn, as the applier sees it; `Pending` satisfies it structurally. */
export interface EmailTurn {
  plan: { transcriptChannel: string; statusThread: string; agentId: string; sessionKey: string }
}

export interface EmailTurnHost<TTurn> {
  recordReplySegment(turn: TTurn, text: string): Promise<void>
  appendTranscript(row: {
    channel: string
    thread: string
    admission: { agentId: string; sessionKey: string }
    ts: string
    sender: string
    kind: 'text'
    text: string
  }): Promise<void>
  monotonicTs(): string
  members(): EmailMembers
  store(): { emailMessages: EmailMessages }
  /** The agent's name, shown beside its address in a reply's `From`. */
  agentName(agentId: string): string | undefined
  now(): number
  warn(message: string): void
}

/** The per-turn state: the leased connection, the message the turn answers, and whether its one mail went. */
export interface EmailTurnState {
  conn?: EmailConnection
  message: NormalizedMessage
  sent?: boolean
}

/** Who a reply goes to (§6.1): the sender, and in a group every other address the member question allows, asked in one batch; `outside` when it reaches someone outside the organization. */
export async function emailReplyAudience(
  members: EmailMembers,
  agentId: string,
  answered: WireEmailAdapterExt,
  agentAddress: string,
  group: boolean,
  wrote: () => Promise<ReadonlySet<string>>,
  /** In a thread the agent started, whom the started mail went to (§6.1). */
  started?: ReadonlySet<string>
): Promise<{
  participants: string[]
  to: string[]
  cc: string[]
  leftOff: string[]
  unchecked: boolean
  outside: boolean
}> {
  const participants = emailParticipants(answered, agentAddress)
  const sender = answered.from.address
  const others = participants.slice(1)
  const base = { participants, to: [sender] }
  // A reply to the sender alone never asks: how the sender was admitted says whether they are outside.
  const admittedOutside = answered.outsider === true
  if (!group || others.length === 0) return { ...base, cc: [], leftOff: [], unchecked: false, outside: admittedOutside }
  const verdicts = await members.judge(agentId, participants)
  const senderOutside = admittedOutside || (verdicts ? isOutsider(verdicts.get(sender)) : false)
  // The Control Plane could not be asked: the reply goes to the sender alone, and the session says so.
  if (!verdicts) return { ...base, cc: [], leftOff: others, unchecked: true, outside: senderOutside }
  const senders = others.some((address) => emailMayCopyOutsider(verdicts.get(address), started !== undefined))
    ? await wrote()
    : new Set<string>()
  const cc = others.filter((address) => emailCopyable(verdicts.get(address), address, senders, started))
  return {
    ...base,
    cc,
    leftOff: others.filter((address) => !cc.includes(address)),
    unchecked: false,
    outside: senderOutside || cc.some((address) => isOutsider(verdicts.get(address)))
  }
}

/** The session's note on a reply that was not delivered, or went to fewer people than the thread holds; undefined when there is nothing to say. */
export function emailDeliveryNote(
  result: EmailSendResult,
  audience: { to: string[]; leftOff: string[]; unchecked: boolean }
): string | undefined {
  const lines: string[] = []
  if (result.outcome === 'unsent') lines.push(`⚠️ This reply was not sent by mail: ${result.reason}.`)
  if (result.outcome === 'unknown') lines.push(`⚠️ This reply may not have been delivered by mail: ${result.reason}.`)
  if (result.outcome !== 'unsent' && audience.unchecked)
    lines.push(
      `This reply went to ${audience.to.join(', ')} only: whether the others on the thread may receive it could not be checked (${audience.leftOff.join(', ')}).`
    )
  return lines.length ? lines.join('\n') : undefined
}

/** Send the turn's one mail, then keep the answer, its index row and any delivery note in the session. */
export async function deliverEmailReply<TTurn extends EmailTurn>(
  host: EmailTurnHost<TTurn>,
  turn: TTurn,
  state: EmailTurnState,
  text: string
): Promise<void> {
  const conn = state.conn!
  const { agentId } = turn.plan
  const channel = state.message.channel
  const thread = state.message.thread ?? turn.plan.statusThread
  const answered = emailExtOf(state.message) ?? (await conn.latestReceived(channel, thread))
  let result: EmailSendResult
  let audience = { participants: [] as string[], to: [] as string[], cc: [] as string[], leftOff: [] as string[] }
  let unchecked = false
  if (!answered) result = { outcome: 'unsent', reason: 'there is no received mail in this thread to reply to' }
  else if (!answered.ticket) result = { outcome: 'unsent', reason: 'the mail it answers carries no reply ticket' }
  else {
    const started = isEmailStartedThread(thread) ? await conn.startedThread(thread) : undefined
    const resolved = await emailReplyAudience(
      host.members(),
      agentId,
      answered,
      conn.address,
      channel.startsWith('group:'),
      () => conn.threadSenders(channel, thread),
      started ? new Set(started.recipients) : undefined
    )
    audience = resolved
    unchecked = resolved.unchecked
    const bodies = emailReplyBodies(text)
    const fromName = emailFromName(host.agentName(agentId))
    const call: WireEmailCall = {
      op: 'send',
      ticket: answered.ticket,
      audience: resolved.participants,
      to: resolved.to,
      cc: resolved.cc,
      ...(fromName ? { fromName } : {}),
      subject: emailReplySubject(answered.subject),
      inReplyTo: answered.messageId,
      references: emailReplyReferences(answered),
      text: bodies.text,
      html: bodies.html,
      // A reply into an outside sender's thread spends the outside budget, not members' replies (§6.4).
      ...(resolved.outside ? { outside: true } : {})
    }
    result = await conn.send(call)
  }
  const ts = host.monotonicTs()
  const admission = { agentId, sessionKey: turn.plan.sessionKey }
  await host.appendTranscript({
    channel: turn.plan.transcriptChannel,
    thread: turn.plan.statusThread,
    admission,
    ts,
    sender: agentId,
    kind: 'text',
    text
  })
  const name = emailFromName(host.agentName(agentId))
  const sent: EmailStoredSent = {
    from: { address: conn.address, ...(name ? { name } : {}) },
    to: audience.to.map((address) => ({ address })),
    cc: audience.cc.map((address) => ({ address })),
    subject: answered ? emailReplySubject(answered.subject) : ''
  }
  await host
    .store()
    .emailMessages.record({
      address: conn.address,
      ...(result.outcome === 'sent' && result.messageId ? { messageId: result.messageId } : {}),
      thread,
      conversation: channel,
      direction: 'sent',
      mail: JSON.stringify(sent),
      ts,
      outcome: result.outcome,
      ...(result.outcome !== 'sent' ? { reason: result.reason } : {}),
      createdAt: host.now()
    })
    .catch((err: unknown) => host.warn(`email: the sent mail was not indexed (${(err as Error).message})`))
  if (result.outcome !== 'sent') host.warn(`email: delivery ${result.outcome} (${result.reason})`)
  const note = emailDeliveryNote(result, { to: audience.to, leftOff: audience.leftOff, unchecked })
  if (note)
    await host.appendTranscript({
      channel: turn.plan.transcriptChannel,
      thread: turn.plan.statusThread,
      admission,
      ts: host.monotonicTs(),
      sender: agentId,
      kind: 'text',
      text: note
    })
}

export async function applyEmailAction<TTurn extends EmailTurn>(
  host: EmailTurnHost<TTurn>,
  turn: TTurn,
  state: EmailTurnState,
  action: { kind: string; text?: string; recordOnly?: boolean }
): Promise<void> {
  if (!action.text) return
  // Only the turn's one answer is mailed: a notice, a mode that posts nothing, or a second post is kept in the session.
  if (action.kind !== 'post' || action.recordOnly || !state.conn || state.sent) {
    await host.recordReplySegment(turn, action.text)
    return
  }
  state.sent = true
  await deliverEmailReply(host, turn, state, action.text)
}

/** Email's turn-output surface; no acknowledgement, cards or files, since a mail is one message sent at the end. */
export function createEmailTurnOutput(
  host: EmailTurnHost<Pending>
): TurnOutputSurface<Pending, DaemonRenderAction, EmailConverger, NormalizedMessage> {
  return {
    platform: EMAIL_PLATFORM,
    createConverger: (ctx) => new EmailConverger(ctx.mode, ctx.resolveFileLink),
    initialTurnState: (ctx: TurnOutputContext<NormalizedMessage>): EmailTurnState => {
      const conn = ctx.egress && !ctx.message.headless ? (ctx.egress as EmailConnection) : undefined
      return { message: ctx.message, ...(conn ? { conn } : {}) }
    },
    apply: (turn, action) => applyEmailAction(host, turn, turnState<EmailTurnState>(turn), action as EmailAction)
  }
}
