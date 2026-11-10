// WeChat's turn output (wechat-integration.md §4.4): completed messages as plain text, recorded as sent.
import type { WorkspaceFileLinkResolver } from '../../messages/workspace-file-links.js'
import { CompleteMessageConverger, type CompleteMessageAction } from '../complete-message-converger.js'
import type { WeChatReplyPort } from './connection.js'

export type WeChatAction = CompleteMessageAction

// A sent message can be neither edited nor replaced, so only completed messages are posted (§4.4).
export class WeChatConverger extends CompleteMessageConverger {
  constructor(mode: string, resolveFileLink?: WorkspaceFileLinkResolver) {
    super(mode, {}, resolveFileLink)
  }
}

export interface WeChatTurnState {
  /** The connection this turn leased; absent for a headless turn, which records but never posts. */
  conn?: WeChatReplyPort
  channel: string
}

/** The core turn as this applier sees it; `Pending` satisfies it structurally. */
export interface WeChatTurn {
  plan: { transcriptChannel: string; statusThread: string; agentId: string; sessionKey: string }
  /** Set when core cuts the turn's output; the remaining parts of an answer then stay unsent. */
  outputSuppressed?: unknown
  entry?: { cancelledReason?: unknown }
}

export interface WeChatTurnHost {
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

export async function applyWeChatAction(
  host: WeChatTurnHost,
  turn: WeChatTurn,
  state: WeChatTurnState,
  action: { kind: string; text?: string; recordOnly?: boolean }
): Promise<void> {
  if (!action.text) return
  // A notice is chrome: sent as plain text and never recorded.
  if (action.kind === 'notice') {
    if (state.conn) await state.conn.sendText(state.channel, action.text)
    return
  }
  if (action.kind !== 'post') return
  const record = async (text: string): Promise<void> => {
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
  // `none` mode and a headless turn record the answer without sending it.
  if (action.recordOnly || !state.conn) {
    await record(action.text)
    return
  }
  // An unsent part is still recorded: the transcript keeps the whole answer (§4.4).
  const stopped = () => turn.outputSuppressed !== undefined || turn.entry?.cancelledReason !== undefined
  for (const part of await state.conn.sendText(state.channel, action.text, { stopped })) await record(part.text)
}
