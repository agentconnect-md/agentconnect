// DingTalk's turn output (dingtalk-integration.md §4.2): completed messages as Markdown posts, each part recorded by its process query key.
import type { SessionUpdate } from '@agentclientprotocol/sdk/unstable'
import { GithubReplyCollector } from '../../github/poster.js'
import { flattenUnsafeLinks } from '../../messages/agent-links.js'
import { AgentMessageRun, WorkBoundary } from '../../messages/message-boundary.js'
import type { WorkspaceFileLinkResolver } from '../../messages/workspace-file-links.js'
import { isNoResponseBody } from '../../session/no-response.js'
import type { DingTalkReplyPort } from './connection.js'
import type { DingTalkQuotaNotice } from './quota.js'

/** The line on a group turn's last message; replying to a group message mentions its sender, which a group needs (§4.1). */
export const DINGTALK_CONTINUE_HINT = '↩️ To continue this topic, please reply to this message.'

const PROGRESS_LIMIT = 2
const PROGRESS_SPACING_MS = 15_000

export type DingTalkAction =
  | { kind: 'post'; text: string; attributed?: boolean; recordOnly?: boolean; hint?: string }
  | { kind: 'notice'; text: string }

// Posts only completed public messages, never partial text: a plain message cannot be edited (§4.2).
export class DingTalkConverger {
  private readonly collector = new GithubReplyCollector()
  private readonly messages = new AgentMessageRun()
  private readonly work = new WorkBoundary()
  private readonly published = new Set<string>()
  private text = ''
  private phase = ''
  private progressCount = 0
  private lastProgressAt = -Infinity
  private finalized = false
  private readonly hint: boolean

  constructor(
    private readonly mode: string,
    opts: { continueHint: boolean },
    private readonly resolveFileLink?: WorkspaceFileLinkResolver
  ) {
    this.hint = opts.continueHint && ['low', 'medium', 'high'].includes(mode)
  }

  onUpdate(update: SessionUpdate): DingTalkAction[] {
    if (this.finalized) return []
    const actions: DingTalkAction[] = []
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

  // An intermediate message is posted in medium and high modes only, bounded so a long turn spends few API calls (§4.4).
  private completeMessage(): DingTalkAction[] {
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

  onFinal(_attribution?: unknown): DingTalkAction[] {
    return this.finish(true)
  }

  flushTerminal(): DingTalkAction[] {
    return this.finish(false)
  }

  private finish(withHint: boolean): DingTalkAction[] {
    if (this.finalized) return []
    this.finalized = true
    const text = this.collector.finalText(true, { resolveFileLink: this.resolveFileLink })
    if (!text || this.published.has(text)) return []
    if (this.mode === 'none') return [{ kind: 'post', text, attributed: false, recordOnly: true }]
    return [
      { kind: 'post', text, attributed: false, ...(withHint && this.hint ? { hint: DINGTALK_CONTINUE_HINT } : {}) }
    ]
  }

  flushBuffered(): DingTalkAction[] {
    return []
  }

  hasBuffered(): boolean {
    return false
  }

  hasStreamingUpdate(): boolean {
    return false
  }
}

export interface DingTalkTurnState {
  /** The connection this turn leased; absent for a headless turn, which records but never posts. */
  conn?: DingTalkReplyPort
  channel: string
  /** The turn's one quota notice (§4.4). */
  quota?: DingTalkQuotaNotice
}

/** The core turn as this applier sees it; `Pending` satisfies it structurally. */
export interface DingTalkTurn {
  plan: { transcriptChannel: string; statusThread: string; agentId: string; sessionKey: string }
}

export interface DingTalkTurnHost {
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
}

export async function applyDingTalkAction(
  host: DingTalkTurnHost,
  turn: DingTalkTurn,
  state: DingTalkTurnState,
  action: { kind: string; text?: string; recordOnly?: boolean; hint?: string }
): Promise<void> {
  if (!action.text) return
  // A notice is chrome: posted as plain text and never recorded.
  if (action.kind === 'notice') {
    if (state.conn) await state.conn.sendText(state.channel, action.text)
    return
  }
  if (action.kind !== 'post') return
  const record = async (text: string, ts: string): Promise<void> => {
    if (!turn.plan.transcriptChannel || !turn.plan.statusThread) return
    await host.appendTranscript({
      channel: turn.plan.transcriptChannel,
      thread: turn.plan.statusThread,
      admission: { agentId: turn.plan.agentId, sessionKey: turn.plan.sessionKey },
      ts,
      sender: turn.plan.agentId,
      kind: 'text',
      text
    })
  }
  if (action.recordOnly || !state.conn) {
    await record(action.text, host.monotonicTs())
    return
  }
  // Each part is recorded under its process query key, which a quote of it brings back (§4.1).
  const parts = await state.conn.sendMarkdown(state.channel, action.text, action.hint ? { suffix: action.hint } : {})
  for (const part of parts) await record(part.text, part.processQueryKey ?? host.monotonicTs())
  const refused = parts.find((part) => part.error !== undefined)
  if (refused) await state.quota?.note(refused.error)
}
