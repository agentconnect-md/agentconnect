import { z } from 'zod'
import type { SessionContext } from './context.js'
import { parseArgs, requiredString } from './args.js'

/** `viewSessionStatus` arguments: the child session id is the only model input. */
export const VIEW_SESSION_STATUS_ARGS = z.object({ sessionId: requiredString('sessionId') })

/**
 * A trusted request to read the status of a session the caller STARTED. Everything except
 * `sessionId` comes from the trusted {@link SessionContext}; the caller coords let the daemon
 * recompute the caller's own session and verify that `sessionId` really is one of its children
 * (the mirror image of `ReplyToSessionReq`'s origin-only rule — a parent may read down
 * its own lineage, a child may reply up it, and nobody may reach sideways).
 */
export interface SessionStatusReq {
  /** Trusted caller identity (== `ctx.agentId`). Never a tool input. */
  callerAgentId: string
  /** Trusted source platform / caller session coords (== the caller's {@link SessionContext}). */
  platform: string
  callerChannel: string
  callerThread: string
  /** Trusted physical-bot scope of the caller's session, when it has one. Part of the caller's
   *  logical session key, so it must travel for the lineage lookup to find the right row. */
  callerTransportScope?: string
  /** The ONLY untrusted field: the child session's id, as handed back by `sendMessage`. */
  sessionId: string
}

/** A child session's coarse progress, collapsed from the §7.3 lifecycle state plus the last
 *  completed turn's outcome. `in-progress` covers "queued but not started yet" too. */
export interface SessionStatusResult {
  /** Echo of the requested id, so a polling caller can match up concurrent children. */
  sessionId: string
  /** The agent that owns the child session. */
  agentId: string
  status: 'in-progress' | 'failed' | 'done'
  /** The underlying lifecycle state, for a caller that wants the detail: one of the §7.3
   *  states, or 'starting' when the wake was admitted but the session has not opened yet. */
  state: 'starting' | 'idle' | 'prompting' | 'cancelling' | 'resuming' | 'closed'
  /** Delivery state of the optional child -> parent report requested by `needsReply`. */
  reply: {
    requested: boolean
    state: 'not-requested' | 'awaiting' | 'queued-for-parent' | 'not-sent' | 'failed' | 'unknown'
  }
  /** Machine-readable instruction chosen from the live execution + reply state. */
  nextAction: 'none' | 'wait' | 'finish-turn-and-wait' | 'report-failure' | 'report-missing-reply'
  /** Short, state-specific model guidance. Kept in the result instead of the always-loaded schema. */
  message: string
  /** Epoch ms of the last state change; absent while the session is still 'starting'. */
  updatedAt?: number
}

/** The session-lifecycle deps: read the progress of a session this one started. */
export interface SessionOpsDeps {
  /** Read the progress of a session the caller started (backs `viewSessionStatus`). The daemon
   *  fills the trusted caller identity from the session context and authorizes `sessionId`
   *  against the caller's own children, fail-closed. Returns null when the id is unknown or is
   *  not a child of the calling session — the tool surfaces both as the same error, so a caller
   *  cannot probe for the existence of sessions it may not read. Absent in the chat CLI / tests
   *  with no daemon ⇒ the tool reports that status is unavailable. */
  viewSessionStatus?: (req: SessionStatusReq) => Promise<SessionStatusResult | null>
}

export async function viewSessionStatus(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: SessionOpsDeps
): Promise<unknown> {
  const { sessionId } = parseArgs(VIEW_SESSION_STATUS_ARGS, args)
  if (!deps.viewSessionStatus) throw new Error('session status is unavailable on this daemon')
  const status = await deps.viewSessionStatus({
    callerAgentId: ctx.agentId,
    platform: ctx.platform,
    callerChannel: ctx.channel,
    callerThread: ctx.thread,
    ...(ctx.transportScope !== undefined ? { callerTransportScope: ctx.transportScope } : {}),
    sessionId
  })
  // Unknown and not-yours are deliberately ONE message: distinguishing them would let a
  // caller probe for sessions it is not allowed to read.
  if (!status) {
    throw new Error(
      `viewSessionStatus: ${sessionId} is not a session started by this session. You can only check sessions you ` +
        'opened yourself — use the `childSessionId` returned by the `sendMessage` call that started it.'
    )
  }
  return status
}
