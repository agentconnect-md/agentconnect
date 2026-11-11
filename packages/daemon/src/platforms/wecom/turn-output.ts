// WeCom's turn output: the whole answer streamed as Markdown, recorded once when the turn completes.
import type { SessionUpdate } from '@agentclientprotocol/sdk/unstable'
import { flattenUnsafeLinks, referenceBufferStart } from '../../messages/agent-links.js'
import { AgentMessageRun, WorkBoundary } from '../../messages/message-boundary.js'
import type { WorkspaceFileLinkResolver } from '../../messages/workspace-file-links.js'
import { isNoResponseBody, isNoResponsePrefix } from '../../session/no-response.js'
import type { WeComReplyPort } from './connection.js'
import { WeComRequestError, WeComTransportError } from './client.js'
import { WeComRateLimited } from './rate-limit.js'
import { WeComTurnStream } from './stream.js'

export type WeComAction =
  | { kind: 'wecom-stream'; text: string; attributed?: boolean; recordOnly?: boolean }
  | { kind: 'post'; text: string; attributed?: boolean; recordOnly?: boolean }
  | { kind: 'notice'; text: string }

// Every text block of the turn, completed ones and the current one, as one growing answer; message ids and work delimit blocks.
export class WeComConverger {
  private sourceText = ''
  private readonly messages = new AgentMessageRun()
  private readonly work = new WorkBoundary()
  private readonly completed: string[] = []
  private finalized = false

  constructor(
    private readonly mode: string,
    private readonly resolveFileLink?: WorkspaceFileLinkResolver
  ) {}

  onUpdate(update: SessionUpdate): WeComAction[] {
    if (this.finalized) return []
    if (this.work.opens(update)) {
      this.completeBlock()
      return this.preview()
    }
    if (update.sessionUpdate !== 'agent_message_chunk' || update.content.type !== 'text') return []
    if (this.messages.opens(update)) this.completeBlock()
    this.sourceText += update.content.text
    return this.preview()
  }

  private currentText(): string {
    if (!this.sourceText.trim() || isNoResponseBody(this.sourceText.trim())) return ''
    return flattenUnsafeLinks(this.sourceText, { resolveFileLink: this.resolveFileLink })
  }

  private completeBlock(): void {
    const text = this.currentText()
    if (text) this.completed.push(text)
    this.sourceText = ''
  }

  private preview(): WeComAction[] {
    if (this.mode === 'none') return []
    const snapshot = this.currentText()
    // A paragraph whose link definitions may still arrive is held back, so a local target is never shown before it resolves.
    const hold = referenceBufferStart(this.sourceText)
    const safe =
      hold === undefined
        ? snapshot
        : flattenUnsafeLinks(this.sourceText.slice(0, hold), { resolveFileLink: this.resolveFileLink })
    const current = isNoResponsePrefix(snapshot.trim()) || !snapshot.startsWith(safe) ? '' : safe
    const text = [...this.completed, ...(current.trim() ? [current] : [])].join('\n\n')
    return text ? [{ kind: 'wecom-stream', text }] : []
  }

  onFinal(_attribution?: unknown): WeComAction[] {
    if (this.finalized) return []
    this.finalized = true
    this.completeBlock()
    const text = this.completed.join('\n\n')
    return text ? [{ kind: 'post', text, ...(this.mode === 'none' ? { recordOnly: true } : {}) }] : []
  }

  flushTerminal(): WeComAction[] {
    return this.onFinal()
  }

  flushBuffered(): WeComAction[] {
    return []
  }

  hasBuffered(): boolean {
    return false
  }

  hasStreamingUpdate(): boolean {
    return false
  }
}

export interface WeComTurnState {
  /** The connection this turn leased; absent for a headless turn, which records but never sends. */
  conn?: WeComReplyPort
  channel: string
  /** The message that started the turn, whose callback the stream answers. */
  msgId: string
  stream?: WeComTurnStream
}

/** The core turn as this applier sees it; `Pending` satisfies it structurally. */
export interface WeComTurn {
  plan: { transcriptChannel: string; statusThread: string; agentId: string; sessionKey: string }
}

export interface WeComTurnHost {
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
  warn(message: string): void
}

/** What the conversation's record says when WeCom did not take a message; WeCom's own wording is kept. */
export function weComRefusalNotice(error: unknown): string {
  if (error instanceof WeComRateLimited)
    return '⚠️ WeCom did not deliver this reply: the conversation has used its 1,000 messages for this hour.'
  if (error instanceof WeComRequestError)
    return `⚠️ WeCom did not deliver this reply (errcode ${error.errcode}: ${error.errmsg}). WeCom lets a bot message a conversation only after someone there has messaged it.`
  if (error instanceof WeComTransportError && error.maybeDelivered)
    return '⚠️ WeCom did not confirm this reply; it may have been delivered.'
  return '⚠️ WeCom did not deliver this reply: the connection to WeCom was not available.'
}

export function weComStreamFor(
  host: WeComTurnHost,
  turn: WeComTurn,
  state: WeComTurnState
): WeComTurnStream | undefined {
  const conn = state.conn
  if (!conn) return undefined
  state.stream ??= new WeComTurnStream(conn, state.channel, conn.claimReply(state.msgId), {
    onRefused: (error) => {
      host.warn('wecom: a reply was not delivered; the session records why')
      void record(host, turn, weComRefusalNotice(error)).catch(() => undefined)
    }
  })
  return state.stream
}

async function record(host: WeComTurnHost, turn: WeComTurn, text: string): Promise<void> {
  if (!turn.plan.transcriptChannel || !turn.plan.statusThread) return
  await host.appendTranscript({
    channel: turn.plan.transcriptChannel,
    thread: turn.plan.statusThread,
    admission: { agentId: turn.plan.agentId, sessionKey: turn.plan.sessionKey },
    ts: host.monotonicTs(),
    sender: turn.plan.agentId,
    kind: 'text',
    text
  })
}

export async function applyWeComAction(
  host: WeComTurnHost,
  turn: WeComTurn,
  state: WeComTurnState,
  action: { kind: string; text?: string; recordOnly?: boolean }
): Promise<void> {
  if (!action.text) return
  // A notice is chrome: its own message, never recorded.
  if (action.kind === 'notice') {
    if (state.conn) await state.conn.sendMarkdown(state.channel, action.text)
    return
  }
  if (action.kind === 'wecom-stream') {
    if (!action.recordOnly) weComStreamFor(host, turn, state)?.update(action.text)
    return
  }
  if (action.kind !== 'post') return
  // The transcript keeps the whole answer even when WeCom refuses part of it.
  await record(host, turn, action.text)
  if (action.recordOnly) return
  await weComStreamFor(host, turn, state)?.finish(action.text)
}
