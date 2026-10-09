import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { flattenUnsafeLinks, referenceBufferStart } from '../../messages/agent-links.js'
import { AgentMessageRun, WorkBoundary } from '../../messages/message-boundary.js'
import { isNoResponseBody, isNoResponsePrefix } from '../../session/no-response.js'
import type { ImageUploader } from '../../mcp/ops/context.js'
import type { WorkspaceFileLinkResolver } from '../../messages/workspace-file-links.js'
import type { NormalizedMessage } from '../../messages/normalized.js'

export interface WeixinReplyPort {
  sendText(channel: string, text: string): Promise<{ messageId: string }>
}

export type WeixinAction = { kind: 'post'; text: string; attributed: boolean; recordOnly?: boolean }

// WeChat can neither edit nor stream a message: text accumulates until a work or
// message boundary, then each completed block posts as its own WeChat message.
export class WeixinConverger {
  private sourceText = ''
  private readonly messages = new AgentMessageRun()
  private readonly work = new WorkBoundary()
  private finalized = false
  constructor(
    private readonly mode: string,
    private readonly resolveFileLink?: WorkspaceFileLinkResolver
  ) {}
  onUpdate(update: SessionUpdate): WeixinAction[] {
    if (this.finalized) return []
    if (this.work.opens(update) || this.messages.opens(update)) return this.flushBlock()
    if (update.sessionUpdate !== 'agent_message_chunk' || update.content.type !== 'text') return []
    this.sourceText += update.content.text
    return []
  }
  private currentText(): string {
    if (!this.sourceText.trim() || isNoResponseBody(this.sourceText.trim())) return ''
    return flattenUnsafeLinks(this.sourceText, { resolveFileLink: this.resolveFileLink })
  }
  private flushBlock(): WeixinAction[] {
    const text = this.currentText()
    this.sourceText = ''
    return text && this.mode !== 'none' ? [{ kind: 'post', text, attributed: false }] : []
  }
  onFinal(_attribution?: unknown): WeixinAction[] {
    if (this.finalized) return []
    this.finalized = true
    const text = this.currentText()
    this.sourceText = ''
    return text
      ? [{ kind: 'post', text, attributed: false, ...(this.mode === 'none' ? { recordOnly: true } : {}) }]
      : []
  }
  flushTerminal(): WeixinAction[] {
    return this.onFinal()
  }
  flushBuffered(): WeixinAction[] {
    return []
  }
  hasBuffered(): boolean {
    return this.sourceText.trim().length > 0
  }
  hasStreamingUpdate(): boolean {
    return false
  }
}

export interface WeixinTurnState {
  conn?: WeixinReplyPort
  channel: string
}

export function WeixinPeerChannel(message: NormalizedMessage): string {
  return message.channel
}

export async function applyWeixinAction(
  state: WeixinTurnState,
  action: { kind: string; text?: string; recordOnly?: boolean },
  record: (text: string) => Promise<void>
): Promise<void> {
  if (action.kind !== 'post' || !action.text) return
  await record(action.text)
  if (!action.recordOnly && state.conn) await state.conn.sendText(state.channel, action.text)
}
