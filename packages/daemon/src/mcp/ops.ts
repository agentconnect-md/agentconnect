import { z, type ZodType } from 'zod'
import { MEMORY_ACCESS_BLOCKED } from '../memory/tools.js'
import { allAttachmentReadTools, isAttachmentReadTool, sessionToolOwner } from '../platforms/read-ports.js'
import type { SessionContext, ToolHandler } from './ops/context.js'
import { listAgents, LIST_AGENTS_ARGS, type DirectoryDeps } from './ops/directory.js'
import {
  findKnowledge,
  FIND_KNOWLEDGE_ARGS,
  listKnowledge,
  LIST_KNOWLEDGE_ARGS,
  listOrgSkills,
  LIST_ORG_SKILLS_ARGS,
  type KnowledgeDeps
} from './ops/knowledge.js'
import {
  deleteMemory,
  DELETE_MEMORY_ARGS,
  getMemory,
  GET_MEMORY_ARGS,
  MEMORY_TOOL_ACCESS_MODES,
  readMemory,
  READ_MEMORY_ARGS,
  saveMemory,
  SAVE_MEMORY_ARGS,
  searchMemory,
  SEARCH_MEMORY_ARGS,
  updateMemory,
  UPDATE_MEMORY_ARGS,
  writeMemory,
  WRITE_MEMORY_ARGS,
  type MemoryOpsDeps
} from './ops/memory.js'
import { sendMessage, type MessagingDeps } from './ops/messaging.js'
import {
  addReaction,
  ADD_REACTION_ARGS,
  createCanvas,
  CREATE_CANVAS_ARGS,
  listBookmarks,
  LIST_BOOKMARKS_ARGS,
  addBookmark,
  ADD_BOOKMARK_ARGS,
  removeBookmark,
  REMOVE_BOOKMARK_ARGS,
  readList,
  READ_LIST_ARGS,
  addListItem,
  ADD_LIST_ITEM_ARGS,
  updateListItem,
  UPDATE_LIST_ITEM_ARGS,
  createConversation,
  CREATE_CONVERSATION_ARGS,
  getReactions,
  GET_REACTIONS_ARGS,
  readCanvas,
  READ_CANVAS_ARGS,
  scheduleMessage,
  SCHEDULE_MESSAGE_ARGS,
  searchPublicMessages,
  SEARCH_PUBLIC_MESSAGES_ARGS,
  updateCanvas,
  UPDATE_CANVAS_ARGS,
  type PlatformActionDeps
} from './ops/platform-actions.js'
import { shareFile, type ShareFileDeps } from './ops/share-file.js'
import {
  cancelOrchestration,
  getOrchestration,
  ORCHESTRATION_OWNER_ARGS,
  startOrchestration,
  START_ORCHESTRATION_ARGS,
  type OrchestrationDeps
} from './ops/orchestration.js'
import {
  replyGithubReviewThreads,
  REPLY_GITHUB_REVIEW_THREADS_ARGS,
  submitCodeReview,
  SUBMIT_CODE_REVIEW_ARGS,
  type GithubReviewDeps
} from './ops/github.js'
import {
  controlCodeHostPipeline,
  CONTROL_CODE_HOST_PIPELINE_ARGS,
  createCodeHostComment,
  CREATE_CODE_HOST_COMMENT_ARGS,
  createCodeHostMergeRequest,
  CREATE_CODE_HOST_MERGE_REQUEST_ARGS,
  inspectCodeHostPipelines,
  INSPECT_CODE_HOST_PIPELINES_ARGS,
  readCodeHostDiscussions,
  READ_CODE_HOST_DISCUSSIONS_ARGS,
  replyCodeHostDiscussion,
  REPLY_CODE_HOST_DISCUSSION_ARGS,
  updateCodeHostComment,
  UPDATE_CODE_HOST_COMMENT_ARGS,
  updateCodeHostMergeRequest,
  UPDATE_CODE_HOST_MERGE_REQUEST_ARGS,
  type CodeHostEffectDeps
} from './ops/code-host.js'
import {
  getCurrentChannel,
  getChannelHistory,
  GET_CHANNEL_HISTORY_ARGS,
  getThreadHistory,
  GET_THREAD_HISTORY_ARGS,
  getUserProfile,
  GET_USER_PROFILE_ARGS,
  listChannelMembers,
  LIST_CHANNEL_MEMBERS_ARGS,
  listChannels,
  LIST_CHANNELS_ARGS,
  listKnownUsers,
  LIST_KNOWN_USERS_ARGS,
  readAttachment,
  READ_ATTACHMENT_ARGS,
  type PlatformReadDeps
} from './ops/platform-reads.js'
import {
  setSessionTitle,
  SET_SESSION_TITLE_ARGS,
  viewSessionStatus,
  VIEW_SESSION_STATUS_ARGS,
  type SessionOpsDeps
} from './ops/session.js'

export type { McpContentResult, MessageGateway, SendIdentity, SessionContext } from './ops/context.js'
export type { ChannelAgentsRequest } from './ops/directory.js'
export type {
  ReplyGithubReviewThreadsReq,
  ReplyGithubReviewThreadsResult,
  SubmitGithubReviewReq
} from './ops/github.js'
export type { SubmitCodeReviewReq } from '../codehost/review-adapter.js'
export type { CodeHostEffectReq } from './ops/code-host.js'
export { SEND_MESSAGE_BRANCHES } from './ops/messaging.js'
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
    CodeHostEffectDeps,
    MemoryOpsDeps,
    ShareFileDeps,
    PlatformReadDeps,
    PlatformActionDeps {
  /** Fail-closed turn gate checked before every daemon bridge tool. Used to make
   *  pause/cancel/loop interrupts terminal even while the runtime is still unwinding. */
  canRun?: (ctx: SessionContext) => boolean | Promise<boolean>
  /** The live connection a platform's OWN session tools (`read-ports.ts` `sessionTools`) act
   *  through — ANY platform's, unlike `gatewayFor`, whose reply-surface registry deliberately
   *  omits a platform with no free-text surface (Linear). Absent ⇒ those tools cannot run. */
  sessionToolConnectionFor?: (integrationId: string) => unknown
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
  ['shareFile', shareFile],
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
  ['submitCodeReview', submitCodeReview],
  // A working alias so sessions already warm with the pre-promotion tool set keep resolving.
  ['submitGithubReview', submitCodeReview],
  ['replyGithubReviewThreads', replyGithubReviewThreads],
  ['createCodeHostComment', createCodeHostComment],
  ['updateCodeHostComment', updateCodeHostComment],
  ['readCodeHostDiscussions', readCodeHostDiscussions],
  ['replyCodeHostDiscussion', replyCodeHostDiscussion],
  ['createCodeHostMergeRequest', createCodeHostMergeRequest],
  ['updateCodeHostMergeRequest', updateCodeHostMergeRequest],
  ['inspectCodeHostPipelines', inspectCodeHostPipelines],
  ['controlCodeHostPipeline', controlCodeHostPipeline],
  ['listKnownUsers', listKnownUsers],
  ['listChannels', listChannels],
  ['listChannelMembers', listChannelMembers],
  ['getUserProfile', getUserProfile],
  ['getChannelHistory', getChannelHistory],
  ['getThreadHistory', getThreadHistory],
  ['addReaction', addReaction],
  ['getReactions', getReactions],
  ['listBookmarks', listBookmarks],
  ['addBookmark', addBookmark],
  ['removeBookmark', removeBookmark],
  ['readList', readList],
  ['addListItem', addListItem],
  ['updateListItem', updateListItem],
  ['createConversation', createConversation],
  ['scheduleMessage', scheduleMessage],
  ['searchPublicMessages', searchPublicMessages],
  ['createCanvas', createCanvas],
  ['readCanvas', readCanvas],
  ['updateCanvas', updateCanvas]
])

/**
 * Every dispatchable tool's ARGUMENT schema, by name — the runtime contract each handler
 * parses its input with. Advertised JSON Schemas (`mcp/tools.ts` and the per-platform
 * descriptors) carry the model-facing prose; `test/mcp-tool-args.test.ts` holds the two
 * sides to the same fields so neither can drift. `sendMessage` is a four-branch union and
 * lives in {@link SEND_MESSAGE_BRANCHES} instead.
 */
export const TOOL_ARG_SCHEMAS: Map<string, ZodType> = new Map<string, ZodType>([
  ['setSessionTitle', SET_SESSION_TITLE_ARGS],
  ['viewSessionStatus', VIEW_SESSION_STATUS_ARGS],
  ['readMemory', READ_MEMORY_ARGS],
  ['writeMemory', WRITE_MEMORY_ARGS],
  ['searchMemory', SEARCH_MEMORY_ARGS],
  ['saveMemory', SAVE_MEMORY_ARGS],
  ['getMemory', GET_MEMORY_ARGS],
  ['updateMemory', UPDATE_MEMORY_ARGS],
  ['deleteMemory', DELETE_MEMORY_ARGS],
  ['listAgents', LIST_AGENTS_ARGS],
  ['listChannelAgents', LIST_AGENTS_ARGS],
  ['findKnowledge', FIND_KNOWLEDGE_ARGS],
  ['listKnowledge', LIST_KNOWLEDGE_ARGS],
  ['listOrgSkills', LIST_ORG_SKILLS_ARGS],
  ['startOrchestration', START_ORCHESTRATION_ARGS],
  ['getOrchestration', ORCHESTRATION_OWNER_ARGS],
  ['cancelOrchestration', ORCHESTRATION_OWNER_ARGS],
  ['submitCodeReview', SUBMIT_CODE_REVIEW_ARGS],
  ['submitGithubReview', SUBMIT_CODE_REVIEW_ARGS],
  ['replyGithubReviewThreads', REPLY_GITHUB_REVIEW_THREADS_ARGS],
  ['createCodeHostComment', CREATE_CODE_HOST_COMMENT_ARGS],
  ['updateCodeHostComment', UPDATE_CODE_HOST_COMMENT_ARGS],
  ['readCodeHostDiscussions', READ_CODE_HOST_DISCUSSIONS_ARGS],
  ['replyCodeHostDiscussion', REPLY_CODE_HOST_DISCUSSION_ARGS],
  ['createCodeHostMergeRequest', CREATE_CODE_HOST_MERGE_REQUEST_ARGS],
  ['updateCodeHostMergeRequest', UPDATE_CODE_HOST_MERGE_REQUEST_ARGS],
  ['inspectCodeHostPipelines', INSPECT_CODE_HOST_PIPELINES_ARGS],
  ['controlCodeHostPipeline', CONTROL_CODE_HOST_PIPELINE_ARGS],
  ['listKnownUsers', LIST_KNOWN_USERS_ARGS],
  ['listChannels', LIST_CHANNELS_ARGS],
  ['listChannelMembers', LIST_CHANNEL_MEMBERS_ARGS],
  ['getUserProfile', GET_USER_PROFILE_ARGS],
  ['getChannelHistory', GET_CHANNEL_HISTORY_ARGS],
  ['getThreadHistory', GET_THREAD_HISTORY_ARGS],
  ['addReaction', ADD_REACTION_ARGS],
  ['getReactions', GET_REACTIONS_ARGS],
  ['listBookmarks', LIST_BOOKMARKS_ARGS],
  ['addBookmark', ADD_BOOKMARK_ARGS],
  ['removeBookmark', REMOVE_BOOKMARK_ARGS],
  ['readList', READ_LIST_ARGS],
  ['addListItem', ADD_LIST_ITEM_ARGS],
  ['updateListItem', UPDATE_LIST_ITEM_ARGS],
  ['createConversation', CREATE_CONVERSATION_ARGS],
  ['scheduleMessage', SCHEDULE_MESSAGE_ARGS],
  ['searchPublicMessages', SEARCH_PUBLIC_MESSAGES_ARGS],
  ['createCanvas', CREATE_CANVAS_ARGS],
  ['readCanvas', READ_CANVAS_ARGS],
  ['updateCanvas', UPDATE_CANVAS_ARGS],
  // The session's own conversation is read from trusted context alone — no arguments.
  ['getCurrentChannel', z.object({})],
  // One body serves every platform's credentialed attachment read, so one schema does too.
  ...allAttachmentReadTools().map((tool) => [tool.name, READ_ATTACHMENT_ARGS] as [string, ZodType])
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

  // A platform's own session tools (read-ports.ts `sessionTools`): injected only into a session
  // ON that platform, and refused at call time from anywhere else — they act through THIS
  // session's connection, so a session elsewhere has nothing they could reach.
  const owner = sessionToolOwner(name)
  if (owner?.sessionTools) {
    if (ctx.platform !== owner.platform) throw new Error(`${name} is only available in a ${owner.label} session`)
    // NOT `gatewayFor`: that registry is the reply surfaces, and a platform without one (Linear)
    // is absent from it by design — so it would answer undefined for exactly these tools.
    if (!deps.sessionToolConnectionFor) throw new Error(`${name} is not wired on this daemon`)
    const conn = ctx.integrationId ? deps.sessionToolConnectionFor(ctx.integrationId) : undefined
    if (!conn) throw new Error(`no live ${owner.label} connection for integration ${ctx.integrationId ?? '(none)'}`)
    return await owner.sessionTools.execute(name, ctx, args, conn)
  }

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
