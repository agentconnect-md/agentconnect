// DingTalk's turn output (dingtalk-integration.md §4.2): completed messages as Markdown posts, each part recorded by its process query key.
import type { WorkspaceFileLinkResolver } from '../../messages/workspace-file-links.js'
import { CompleteMessageConverger, type CompleteMessageAction } from '../complete-message-converger.js'
import type { DingTalkReplyPort } from './connection.js'
import type { DingTalkQuotaNotice } from './quota.js'

/** The line on a group turn's last message; replying to a group message mentions its sender, which a group needs (§4.1). */
export const DINGTALK_CONTINUE_HINT = '↩️ To continue this topic, please reply to this message.'

export type DingTalkAction = CompleteMessageAction

// Posts only completed public messages, never partial text: a plain message cannot be edited (§4.2).
export class DingTalkConverger extends CompleteMessageConverger {
  constructor(mode: string, opts: { continueHint: boolean }, resolveFileLink?: WorkspaceFileLinkResolver) {
    super(mode, opts.continueHint ? { hint: DINGTALK_CONTINUE_HINT } : {}, resolveFileLink)
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
