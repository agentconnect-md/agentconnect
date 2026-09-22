import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { GithubReplyCollector } from '../../github/poster.js'
import { flattenUnsafeLinks, referenceBufferStart } from '../../messages/agent-links.js'
import { AgentMessageRun } from '../../messages/message-boundary.js'
import { isNoResponsePrefix } from '../../session/no-response.js'
import { QQPrivateStream } from './private-stream.js'
import type { QQReplyPort } from './sender.js'
import { QQGroupOutput } from './group-output.js'
import type { WorkspaceFileLinkResolver } from '../../messages/workspace-file-links.js'
import type { TurnAdmissionStatus, TurnOutputContext } from '../turn-output.js'
import { QQReplyId } from './connection.js'
import type { NormalizedMessage } from '../../messages/normalized.js'
import type { ImageUploader } from '../../mcp/ops/context.js'
import { QQStreamText, QQTextBoundaries } from './text.js'

export async function QQAcknowledgeAdmission(
  ctx: TurnOutputContext<NormalizedMessage>,
  status: TurnAdmissionStatus,
  signal: AbortSignal
): Promise<void> {
  if (ctx.isDm || ctx.mode === 'none' || ctx.message.headless || ctx.message.source !== 'user') return
  const replyId = QQReplyId(ctx.message)
  const conn = ctx.egress as QQReplyPort | undefined
  if (!replyId || !conn?.sendAcknowledgement) return
  const text = {
    processing: '👀',
    queued: '⏳',
    steered: '📝'
  }[status]
  await conn.sendAcknowledgement(ctx.message.channel, replyId, text, signal)
}

export function QQAnswerDelivery(ctx: TurnOutputContext<NormalizedMessage>): 'staged' | 'live' {
  return ctx.mode !== 'none' && !ctx.message.headless && (ctx.isDm || ['medium', 'high'].includes(ctx.mode))
    ? 'live'
    : 'staged'
}

export type QQAction = {
  kind: 'post' | 'qq-stream' | 'qq-progress'
  text: string
  attributed: boolean
  recordOnly?: boolean
}

// ACP text is user-facing even without Codex phase metadata; completed blocks keep their visible prefix.
export class QQConverger {
  private collector = new GithubReplyCollector()
  private sourceText = ''
  private readonly messages = new AgentMessageRun()
  private readonly completed: string[] = []
  private finalized = false
  private readonly group?: QQGroupOutput
  constructor(
    private readonly mode: string,
    private readonly resolveFileLink?: WorkspaceFileLinkResolver,
    delivery: 'stream' | 'group' = 'stream'
  ) {
    if (delivery === 'group') this.group = new QQGroupOutput(mode, resolveFileLink)
  }
  onUpdate(update: SessionUpdate): QQAction[] {
    if (this.finalized) return []
    if (this.group) return this.group.onUpdate(update)
    if (this.mode === 'none') {
      this.collector.onUpdate(update)
      return []
    }
    if (QQTextBoundaries.has(update.sessionUpdate)) {
      this.completeBlock()
      return this.preview()
    }
    if (update.sessionUpdate !== 'agent_message_chunk' || update.content.type !== 'text') return []
    if (this.messages.opens(update)) this.completeBlock()
    this.sourceText += update.content.text
    this.collector.onUpdate(update)
    return this.preview()
  }
  private completeBlock(): void {
    const text = this.collector.finalText(true, { resolveFileLink: this.resolveFileLink })
    if (text) this.completed.push(QQStreamText(text, true))
    this.collector = new GithubReplyCollector()
    this.sourceText = ''
  }
  private preview(): QQAction[] {
    const snapshot = this.collector.finalText(true, { resolveFileLink: this.resolveFileLink }) ?? ''
    // Inspect raw references before rewriting; late definitions must not rewrite an already sent prefix.
    const hold = referenceBufferStart(this.sourceText)
    const safe =
      hold === undefined
        ? snapshot
        : flattenUnsafeLinks(this.sourceText.slice(0, hold), { resolveFileLink: this.resolveFileLink })
    const current = isNoResponsePrefix(snapshot.trim()) || !snapshot.startsWith(safe) ? '' : QQStreamText(safe)
    const text = [...this.completed, ...(current ? [current] : [])].join('\n\n')
    return text ? [{ kind: 'qq-stream', text, attributed: false }] : []
  }
  onFinal(_attribution?: unknown): QQAction[] {
    if (this.finalized) return []
    this.finalized = true
    if (this.group) return this.group.onFinal()
    this.completeBlock()
    const text = this.completed.join('\n\n')
    return text
      ? [{ kind: 'post', text, attributed: false, ...(this.mode === 'none' ? { recordOnly: true } : {}) }]
      : []
  }
  flushTerminal(): QQAction[] {
    return this.onFinal()
  }
  flushBuffered(): QQAction[] {
    return []
  }
  hasBuffered(): boolean {
    return false
  }
  hasStreamingUpdate(): boolean {
    return false
  }
}

export interface QQTurnState {
  conn?: QQReplyPort
  stream?: QQPrivateStream
  channel: string
  replyId?: string
  outputAbort?: AbortController
  lastProgress?: string
}

export function QQImageUploader(state: QQTurnState): ImageUploader | undefined {
  const { conn, replyId, channel, outputAbort } = state
  if (!conn?.sendImage || !replyId) return undefined
  return (file, caption) => conn.sendImage!(channel, replyId, file, caption, outputAbort?.signal)
}

export async function applyQQAction(
  state: QQTurnState,
  action: { kind: string; text?: string; recordOnly?: boolean },
  record: (text: string) => Promise<void>
): Promise<void> {
  if (!action.text) return
  if (action.kind === 'qq-progress') {
    if (!action.recordOnly && state.conn?.sendProgress && state.replyId) {
      const sent = await state.conn.sendProgress(state.channel, state.replyId, action.text, state.outputAbort?.signal)
      if (sent) {
        state.lastProgress = action.text
        await record(action.text)
      }
    }
    return
  }
  if (action.kind !== 'post' && action.kind !== 'qq-stream') return
  if (action.kind === 'qq-stream') {
    if (!action.recordOnly && state.conn && state.replyId) {
      state.stream ??= new QQPrivateStream(state.conn, state.channel, state.replyId)
      state.stream.update(action.text)
    }
    return
  }
  if (!action.recordOnly && action.text === state.lastProgress) return
  await record(action.text)
  if (!action.recordOnly && state.conn && state.replyId) {
    if (state.stream) await state.stream.finish(action.text)
    else await state.conn.sendText(state.channel, state.replyId, action.text)
  }
}
