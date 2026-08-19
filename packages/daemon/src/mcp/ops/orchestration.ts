import { z } from 'zod'
import type { SessionContext } from './context.js'
import { optionalNumber, optionalString, parseArgs, requiredString } from './args.js'

const SUBTASKS_ERROR = 'missing required argument: subtasks (non-empty array)'

/** `startOrchestration` arguments: the subtasks plus the optional deadline and reply marker. */
export const START_ORCHESTRATION_ARGS = z.object({
  subtasks: z
    .array(
      z.object(
        { toAgentId: requiredString('toAgentId'), text: requiredString('text') },
        {
          error: (issue) =>
            issue.code === 'invalid_type' ? `subtasks[${String(issue.path?.[0])}] must be an object` : undefined
        }
      ),
      SUBTASKS_ERROR
    )
    .min(1, SUBTASKS_ERROR),
  deadlineMs: optionalNumber('deadlineMs'),
  replyTarget: optionalString('replyTarget')
})

/** The owner-checked read/cancel arguments shared by `getOrchestration` and `cancelOrchestration`. */
export const ORCHESTRATION_OWNER_ARGS = z.object({ orchestrationId: requiredString('orchestrationId') })

/** One subtask of a {@link StartOrchestrationReq}: an instruction for one worker. */
export interface OrchestrationSubtaskInput {
  toAgentId: string
  text: string
}

/**
 * A trusted request to start an orchestration (§3.4/§6.8), assembled by the daemon from
 * the caller's session context — the main identity + session coords come from the trusted
 * {@link SessionContext}, NEVER from tool input. Tool input contributes only the subtasks,
 * the optional deadline, and the opaque replyTarget.
 */
export interface StartOrchestrationReq {
  /** Trusted main agentId (== `ctx.agentId`). */
  mainAgentId: string
  /** Trusted source platform / coords (== the caller's SessionContext). */
  platform: string
  channel: string
  thread: string
  integrationId?: string
  transportScope?: string
  subtasks: OrchestrationSubtaskInput[]
  deadlineMs?: number
  replyTarget?: string
}

export interface StartOrchestrationResult {
  orchestrationId: string
  delivered: string[]
  failed: { correlationId: string; reason: string }[]
}

/** A trusted owner-checked read/cancel of an orchestration (§3.5a). The owning main
 *  identity + session coords come from the trusted {@link SessionContext}. */
export interface OrchestrationOwnerReq {
  mainAgentId: string
  platform: string
  channel: string
  thread: string
  transportScope?: string
  orchestrationId: string
}

/** The main-agent orchestration deps: start one, then read or cancel it as its owner. */
export interface OrchestrationDeps {
  /** Start an orchestration (§3.4/§6.8): record-first, then deliver each subtask, then
   *  schedule the deadline. The daemon fills the trusted main identity + coords from the
   *  session context. Returns null when the caller is not allowed to orchestrate (never today). */
  startOrchestration: (req: StartOrchestrationReq) => Promise<StartOrchestrationResult>
  /** Read one orchestration, owner-checked (only the owning main+session). Returns null
   *  when the id is unknown or the caller is not the owner. */
  getOrchestration: (req: OrchestrationOwnerReq) => Promise<unknown | null>
  /** Cancel one orchestration, owner-checked. Returns false when unknown / not the owner. */
  cancelOrchestration: (req: OrchestrationOwnerReq) => Promise<boolean>
}

// Main-agent orchestration (§3.4/§6.8), daemon→daemon-local — handled before the
// platform-gateway gate like messageAgent (a memory-only main can still orchestrate).
// SECURITY: the main identity (mainAgentId) + session coords come from the trusted
// session context, NEVER from tool input; only the subtasks / deadline / replyTarget
// come from args. The daemon owns record-first persistence, per-subtask atomic
// delivered|failed via the messageAgent path, and the one-shot deadline.
//
// RETIRED SURFACE: these three names are no longer injected into any agent's tool set
// (`RETIRED_ORCHESTRATION_TOOLS` in tools.ts) because the send half duplicated
// `sendMessage`. The dispatch stays so a session already warm with the old descriptors,
// and any still-open orchestration record, keep resolving. Do not re-advertise these
// without resolving the overlap with `sendMessage` + `viewSessionStatus` first.
export async function startOrchestration(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: OrchestrationDeps
): Promise<unknown> {
  const { subtasks, deadlineMs, replyTarget } = parseArgs(START_ORCHESTRATION_ARGS, args)
  return await deps.startOrchestration({
    mainAgentId: ctx.agentId,
    platform: ctx.platform,
    channel: ctx.channel,
    thread: ctx.thread,
    ...(ctx.integrationId !== undefined ? { integrationId: ctx.integrationId } : {}),
    ...(ctx.transportScope !== undefined ? { transportScope: ctx.transportScope } : {}),
    subtasks,
    ...(deadlineMs !== undefined ? { deadlineMs } : {}),
    ...(replyTarget !== undefined ? { replyTarget } : {})
  })
}

/** The owner-checked request both the read and the cancel form build from trusted coords. */
function ownerReq(ctx: SessionContext, args: Record<string, unknown>): OrchestrationOwnerReq {
  return {
    mainAgentId: ctx.agentId,
    platform: ctx.platform,
    channel: ctx.channel,
    thread: ctx.thread,
    ...(ctx.transportScope !== undefined ? { transportScope: ctx.transportScope } : {}),
    orchestrationId: parseArgs(ORCHESTRATION_OWNER_ARGS, args).orchestrationId
  }
}

export async function getOrchestration(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: OrchestrationDeps
): Promise<unknown> {
  const req = ownerReq(ctx, args)
  const rec = await deps.getOrchestration(req)
  if (rec === null) throw new Error(`no orchestration ${req.orchestrationId} owned by this session`)
  return rec
}

export async function cancelOrchestration(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: OrchestrationDeps
): Promise<unknown> {
  const req = ownerReq(ctx, args)
  const cancelled = await deps.cancelOrchestration(req)
  if (!cancelled) throw new Error(`no orchestration ${req.orchestrationId} owned by this session`)
  return { orchestrationId: req.orchestrationId, cancelled: true }
}
