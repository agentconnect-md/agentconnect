import { MEMORY_ACCESS_BLOCKED } from '../memory/tools.js'
import { isAttachmentReadTool } from '../platforms/read-ports.js'
import type { SessionContext, ToolHandler } from './ops/context.js'
import { listAgents, type DirectoryDeps } from './ops/directory.js'
import { findKnowledge, listKnowledge, listOrgSkills, type KnowledgeDeps } from './ops/knowledge.js'
import {
  deleteMemory,
  getMemory,
  MEMORY_TOOL_ACCESS_MODES,
  readMemory,
  saveMemory,
  searchMemory,
  updateMemory,
  writeMemory,
  type MemoryOpsDeps
} from './ops/memory.js'
import { sendMessage, type MessagingDeps } from './ops/messaging.js'
import {
  cancelOrchestration,
  getOrchestration,
  startOrchestration,
  type OrchestrationDeps
} from './ops/orchestration.js'
import { replyGithubReviewThreads, submitGithubReview, type GithubReviewDeps } from './ops/github.js'
import {
  getCurrentChannel,
  getUserProfile,
  listChannelMembers,
  listChannels,
  listKnownUsers,
  readAttachment,
  type PlatformReadDeps
} from './ops/platform-reads.js'
import { setSessionTitle, viewSessionStatus, type SessionOpsDeps } from './ops/session.js'

export type { McpContentResult, MessageGateway, SendIdentity, SessionContext } from './ops/context.js'
export type { ChannelAgentsRequest } from './ops/directory.js'
export type {
  ReplyGithubReviewThreadsReq,
  ReplyGithubReviewThreadsResult,
  SubmitGithubReviewReq
} from './ops/github.js'
export type { MessageAgentReq, MessageAgentResult, ReplyToSessionReq, ReplyToSessionResult } from './ops/messaging.js'
export type {
  OrchestrationOwnerReq,
  OrchestrationSubtaskInput,
  StartOrchestrationReq,
  StartOrchestrationResult
} from './ops/orchestration.js'
export type { SessionStatusReq, SessionStatusResult, SetSessionTitleReq } from './ops/session.js'

/**
 * Everything the daemon bridge tools need, composed from the per-domain deps each
 * handler group declares (`src/mcp/ops/*`). One flat object still satisfies it, so the
 * daemon wires it as a single literal; the grouping is what lets a handler take only
 * the slice it uses.
 */
export interface OpsDeps
  extends
    SessionOpsDeps,
    MessagingDeps,
    DirectoryDeps,
    KnowledgeDeps,
    OrchestrationDeps,
    GithubReviewDeps,
    MemoryOpsDeps,
    PlatformReadDeps {
  /** Fail-closed turn gate checked before every daemon bridge tool. Used to make
   *  pause/cancel/loop interrupts terminal even while the runtime is still unwinding. */
  canRun?: (ctx: SessionContext) => boolean | Promise<boolean>
  /** Collaboration Arena §6: resolve + execute an evaluation-registry tool.
   *  Returns undefined when `name` is not an evaluation tool. Visibility and
   *  role-aware authorization live behind this seam (the daemon guarantees
   *  authentic caller identity; the game decides whether the action is legal). */
  evaluationTool?: (
    ctx: SessionContext,
    name: string,
    args: Record<string, unknown>
  ) => Promise<{ result: unknown } | undefined>
}

/**
 * The daemon-local tools that do NOT need the session's own platform gateway, by name.
 * Every entry is universal in the sense that matters here: it either talks to the CP, to
 * the daemon itself, or resolves its own target gateway from the trusted session snapshot.
 */
const HANDLERS: Map<string, ToolHandler<OpsDeps>> = new Map<string, ToolHandler<OpsDeps>>([
  ['setSessionTitle', setSessionTitle],
  ['viewSessionStatus', viewSessionStatus],
  ['readMemory', readMemory],
  ['writeMemory', writeMemory],
  ['searchMemory', searchMemory],
  ['saveMemory', saveMemory],
  ['getMemory', getMemory],
  ['updateMemory', updateMemory],
  ['deleteMemory', deleteMemory],
  ['listAgents', listAgents],
  // A working alias so sessions already warm with the old tool set keep resolving.
  ['listChannelAgents', listAgents],
  ['findKnowledge', findKnowledge],
  ['listKnowledge', listKnowledge],
  ['listOrgSkills', listOrgSkills],
  ['sendMessage', sendMessage],
  ['startOrchestration', startOrchestration],
  ['getOrchestration', getOrchestration],
  ['cancelOrchestration', cancelOrchestration],
  ['submitGithubReview', submitGithubReview],
  ['replyGithubReviewThreads', replyGithubReviewThreads],
  ['listKnownUsers', listKnownUsers],
  ['listChannels', listChannels],
  ['listChannelMembers', listChannelMembers],
  ['getUserProfile', getUserProfile]
])

/**
 * Execute one tool call inside the daemon and return a plain result object (the
 * bridge wraps it into an MCP `CallToolResult`). Throws on bad input or a
 * missing connection — the caller turns that into an MCP `isError` result.
 */
export async function executeTool(
  ctx: SessionContext,
  name: string,
  args: Record<string, unknown>,
  deps: OpsDeps
): Promise<unknown> {
  if (deps.canRun && !(await deps.canRun(ctx))) throw new Error('this agent turn has been stopped')
  // Collaboration Arena evaluation tools (collaboration-arena.md §6): game-owned
  // structured actions merged into the session tool set at composition time.
  // Name collisions with product tools are rejected at daemon startup, so this
  // dispatch can never shadow a product tool. The handler receives the trusted
  // token-bound SessionContext — never tool-input-supplied identity.
  if (deps.evaluationTool) {
    const handled = await deps.evaluationTool(ctx, name, args)
    if (handled !== undefined) return handled.result
  }
  // Session-isolation gate for the memory tools (#653), checked at CALL time so a
  // mid-session policy change takes effect immediately.
  const memoryMode = MEMORY_TOOL_ACCESS_MODES[name]
  if (memoryMode !== undefined && (await deps.memoryAccessAllowed?.(ctx, memoryMode)) === false) {
    throw new Error(MEMORY_ACCESS_BLOCKED)
  }
  const handler = HANDLERS.get(name)
  if (handler) return await handler(ctx, args, deps)

  // Past this point are the session-bound read tools — they need the session's message
  // gateway (bound to the integration that triggered this session). A memory-only
  // session has no `integrationId` and never carries these tools, so this only fires
  // if a read tool is called without a live connection.
  const gw = ctx.integrationId ? deps.gatewayFor(ctx.integrationId) : undefined
  if (!gw) throw new Error(`no live platform connection for integration ${ctx.integrationId ?? '(none)'}`)

  if (isAttachmentReadTool(name)) return await readAttachment(args, deps, gw)
  if (name === 'getCurrentChannel') return await getCurrentChannel(ctx, gw)
  throw new Error(`unknown tool: ${name}`)
}
