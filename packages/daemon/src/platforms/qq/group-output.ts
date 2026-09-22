import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { GithubReplyCollector } from '../../github/poster.js'
import { flattenUnsafeLinks } from '../../messages/agent-links.js'
import { AgentMessageRun } from '../../messages/message-boundary.js'
import { isNoResponseBody } from '../../session/no-response.js'
import type { WorkspaceFileLinkResolver } from '../../messages/workspace-file-links.js'
import type { QQAction } from './turn-output.js'
import { QQProgressMaxBytes, QQTextBoundaries } from './text.js'

// Group progress consists of completed public messages, never partial text or private thoughts.
export class QQGroupOutput {
  private readonly collector = new GithubReplyCollector()
  private readonly messages = new AgentMessageRun()
  private text = ''
  private phase = ''
  private progressCount = 0
  private lastProgressAt = -Infinity
  private readonly published = new Set<string>()
  private finalized = false

  constructor(
    private readonly mode: string,
    private readonly resolveFileLink?: WorkspaceFileLinkResolver
  ) {}

  onUpdate(update: SessionUpdate): QQAction[] {
    if (this.finalized) return []
    const actions: QQAction[] = []
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
      const phase = (update._meta as { codex?: { phase?: string } } | undefined)?.codex?.phase ?? ''
      if (this.messages.opens(update) || (phase && this.phase && phase !== this.phase))
        actions.push(...this.completeMessage())
      this.text += update.content.text
      if (phase) this.phase = phase
    } else if (QQTextBoundaries.has(update.sessionUpdate)) actions.push(...this.completeMessage())
    this.collector.onUpdate(update)
    return actions
  }

  private completeMessage(): QQAction[] {
    const text = flattenUnsafeLinks(this.text, { resolveFileLink: this.resolveFileLink })
    const phase = this.phase
    this.text = ''
    this.phase = ''
    if (
      !['medium', 'high'].includes(this.mode) ||
      phase === 'final_answer' ||
      !text.trim() ||
      isNoResponseBody(text.trim()) ||
      Buffer.byteLength(text) > QQProgressMaxBytes ||
      this.published.has(text) ||
      this.progressCount >= 2 ||
      Date.now() - this.lastProgressAt < 15_000
    )
      return []
    this.progressCount++
    this.lastProgressAt = Date.now()
    this.published.add(text)
    return [{ kind: 'qq-progress', text, attributed: false }]
  }

  onFinal(): QQAction[] {
    if (this.finalized) return []
    this.finalized = true
    const text = this.collector.finalText(true, { resolveFileLink: this.resolveFileLink })
    return text
      ? [{ kind: 'post', text, attributed: false, ...(this.mode === 'none' ? { recordOnly: true } : {}) }]
      : []
  }
}
