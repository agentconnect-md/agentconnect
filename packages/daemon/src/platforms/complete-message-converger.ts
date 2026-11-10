// A converger for platforms that cannot edit a sent message: only completed messages are posted, never partial text.
import type { SessionUpdate } from '@agentclientprotocol/sdk/unstable'
import { GithubReplyCollector } from '../github/poster.js'
import { flattenUnsafeLinks } from '../messages/agent-links.js'
import { AgentMessageRun, WorkBoundary } from '../messages/message-boundary.js'
import type { WorkspaceFileLinkResolver } from '../messages/workspace-file-links.js'
import { isNoResponseBody } from '../session/no-response.js'

const PROGRESS_LIMIT = 2
const PROGRESS_SPACING_MS = 15_000

export type CompleteMessageAction =
  | { kind: 'post'; text: string; attributed?: boolean; recordOnly?: boolean; hint?: string }
  | { kind: 'notice'; text: string }

export class CompleteMessageConverger {
  private readonly collector = new GithubReplyCollector()
  private readonly messages = new AgentMessageRun()
  private readonly work = new WorkBoundary()
  private readonly published = new Set<string>()
  private text = ''
  private phase = ''
  private progressCount = 0
  private lastProgressAt = -Infinity
  private finalized = false
  private readonly hint?: string

  // `hint` rides the final message in the low, medium and high modes only.
  constructor(
    private readonly mode: string,
    opts: { hint?: string },
    private readonly resolveFileLink?: WorkspaceFileLinkResolver
  ) {
    if (opts.hint && ['low', 'medium', 'high'].includes(mode)) this.hint = opts.hint
  }

  onUpdate(update: SessionUpdate): CompleteMessageAction[] {
    if (this.finalized) return []
    const actions: CompleteMessageAction[] = []
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
      const phase = (update._meta as { codex?: { phase?: string } } | undefined)?.codex?.phase ?? ''
      if (this.messages.opens(update) || (phase && this.phase && phase !== this.phase))
        actions.push(...this.completeMessage())
      this.text += update.content.text
      if (phase) this.phase = phase
    } else if (this.work.opens(update)) actions.push(...this.completeMessage())
    this.collector.onUpdate(update)
    return actions
  }

  // An intermediate message is posted in medium and high modes only, bounded so a long turn spends few API calls.
  private completeMessage(): CompleteMessageAction[] {
    const text = flattenUnsafeLinks(this.text, { resolveFileLink: this.resolveFileLink })
    const phase = this.phase
    this.text = ''
    this.phase = ''
    if (
      !['medium', 'high'].includes(this.mode) ||
      phase === 'final_answer' ||
      !text.trim() ||
      isNoResponseBody(text.trim()) ||
      this.published.has(text) ||
      this.progressCount >= PROGRESS_LIMIT ||
      Date.now() - this.lastProgressAt < PROGRESS_SPACING_MS
    )
      return []
    this.progressCount++
    this.lastProgressAt = Date.now()
    this.published.add(text)
    return [{ kind: 'post', text, attributed: false }]
  }

  onFinal(_attribution?: unknown): CompleteMessageAction[] {
    return this.finish(true)
  }

  flushTerminal(): CompleteMessageAction[] {
    return this.finish(false)
  }

  private finish(withHint: boolean): CompleteMessageAction[] {
    if (this.finalized) return []
    this.finalized = true
    const text = this.collector.finalText(true, { resolveFileLink: this.resolveFileLink })
    if (!text || this.published.has(text)) return []
    if (this.mode === 'none') return [{ kind: 'post', text, attributed: false, recordOnly: true }]
    return [{ kind: 'post', text, attributed: false, ...(withHint && this.hint ? { hint: this.hint } : {}) }]
  }

  flushBuffered(): CompleteMessageAction[] {
    return []
  }

  hasBuffered(): boolean {
    return false
  }

  hasStreamingUpdate(): boolean {
    return false
  }
}
