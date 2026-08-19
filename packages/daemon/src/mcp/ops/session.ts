import { z } from 'zod'
import type { McpContentResult, SessionContext } from './context.js'
import { parseArgs, requiredString } from './args.js'

/** `setSessionTitle` arguments: whitespace is collapsed before the 80-character cap is applied. */
export const SET_SESSION_TITLE_ARGS = z.object({
  title: requiredString('title')
    .transform((title) => title.replace(/\s+/g, ' ').trim())
    .refine((title) => title.length > 0, 'missing required string argument: title')
    .refine((title) => [...title].length <= 80, 'session title must be at most 80 characters')
})

/** `viewSessionStatus` arguments: the child session id is the only model input. */
export const VIEW_SESSION_STATUS_ARGS = z.object({ sessionId: requiredString('sessionId') })

/** A trusted session-title update. Every coordinate comes from the registered
 *  session context; the model supplies only `title`. */
export interface SetSessionTitleReq {
  agentId: string
  platform: string
  integrationId?: string
  transportScope?: string
  isDm: boolean
  channel: string
  thread: string
  title: string
}

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

/** The session-lifecycle deps: name a session, and read the progress of one it started. */
export interface SessionOpsDeps {
  /** Persist and fan out a model-authored user-facing session title. */
  setSessionTitle: (req: SetSessionTitleReq) => Promise<void> | void
  /** Read the progress of a session the caller started (backs `viewSessionStatus`). The daemon
   *  fills the trusted caller identity from the session context and authorizes `sessionId`
   *  against the caller's own children, fail-closed. Returns null when the id is unknown or is
   *  not a child of the calling session — the tool surfaces both as the same error, so a caller
   *  cannot probe for the existence of sessions it may not read. Absent in the chat CLI / tests
   *  with no daemon ⇒ the tool reports that status is unavailable. */
  viewSessionStatus?: (req: SessionStatusReq) => Promise<SessionStatusResult | null>
}

// Session naming is daemon-local and platform-neutral. SECURITY: the model
// contributes only the title; all routing coordinates come from the trusted
// token-bound SessionContext.
export async function setSessionTitle(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: SessionOpsDeps
): Promise<unknown> {
  const { title } = parseArgs(SET_SESSION_TITLE_ARGS, args)
  await deps.setSessionTitle({
    agentId: ctx.agentId,
    platform: ctx.platform,
    ...(ctx.integrationId !== undefined ? { integrationId: ctx.integrationId } : {}),
    ...(ctx.transportScope !== undefined ? { transportScope: ctx.transportScope } : {}),
    isDm: ctx.isDm,
    channel: ctx.channel,
    thread: ctx.thread,
    title
  })
  // Empty native content avoids rendering a redundant tool-result body. The ACP
  // tool activity itself remains observable in the session transcript.
  const result: McpContentResult = { mcpContent: [] }
  return result
}

// Read the progress of a session THIS session started (session-concept §5.3, the read
// counterpart of a SessionTarget reply). SECURITY: the caller identity + coords come from the
// trusted session context; `sessionId` is the only tool input and the daemon authorizes it
// against the caller's own children — an agent cannot inspect an arbitrary session.
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
