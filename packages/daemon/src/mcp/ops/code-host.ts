// The provider-neutral code-host effect tools (gitlab-com-integration.md §14.2), GitLab-backed today.
// Every handler validates bounded arguments and hands the daemon a discriminated operation; the
// target project and the effect token stay daemon-private.
import { z } from 'zod'
import type { SessionContext } from './context.js'
import {
  optionalBoolean,
  optionalBoundedInt,
  optionalEnum,
  optionalString,
  parseArgs,
  requiredEnum,
  requiredPositiveInt,
  requiredString
} from './args.js'
import { BROKER_PIPELINE_STATUSES, type GitlabBrokerOperation } from '../../gitlab/broker.js'

const SUBJECTS = ['issue', 'merge_request'] as const
const INSPECT_SCOPES = ['pipelines', 'pipeline', 'pipeline_jobs', 'job'] as const
const PIPELINE_ACTIONS = ['retry_pipeline', 'cancel_pipeline', 'retry_job', 'cancel_job'] as const

/** A decimal external id (note, pipeline, job) — the only shape an allowlisted path accepts. */
function requiredDecimalId(key: string) {
  return requiredString(key).regex(/^[1-9]\d*$/, `argument ${key} must be a positive decimal string`)
}

function optionalDecimalId(key: string) {
  return requiredDecimalId(key)
    .nullish()
    .transform((value) => value ?? undefined)
}

const subject = requiredEnum('subject', SUBJECTS)
const iid = requiredPositiveInt('iid')

export const CREATE_CODE_HOST_COMMENT_ARGS = z.object({ subject, iid, body: requiredString('body') })

export const UPDATE_CODE_HOST_COMMENT_ARGS = z.object({
  subject,
  iid,
  noteId: requiredDecimalId('noteId'),
  body: requiredString('body')
})

export const READ_CODE_HOST_DISCUSSIONS_ARGS = z.object({
  subject,
  iid,
  discussionId: optionalString('discussionId'),
  limit: optionalBoundedInt('limit', 1, 20)
})

export const REPLY_CODE_HOST_DISCUSSION_ARGS = z.object({
  subject,
  iid,
  discussionId: requiredString('discussionId'),
  body: requiredString('body')
})

export const CREATE_CODE_HOST_MERGE_REQUEST_ARGS = z.object({
  sourceBranch: requiredString('sourceBranch'),
  targetBranch: requiredString('targetBranch'),
  title: requiredString('title'),
  description: optionalString('description'),
  draft: optionalBoolean('draft')
})

export const UPDATE_CODE_HOST_MERGE_REQUEST_ARGS = z.object({
  iid,
  title: optionalString('title'),
  description: optionalString('description'),
  targetBranch: optionalString('targetBranch'),
  draft: optionalBoolean('draft')
})

export const INSPECT_CODE_HOST_PIPELINES_ARGS = z.object({
  scope: requiredEnum('scope', INSPECT_SCOPES),
  pipelineId: optionalDecimalId('pipelineId'),
  jobId: optionalDecimalId('jobId'),
  ref: optionalString('ref'),
  status: optionalEnum('status', BROKER_PIPELINE_STATUSES),
  limit: optionalBoundedInt('limit', 1, 20)
})

export const CONTROL_CODE_HOST_PIPELINE_ARGS = z.object({
  action: requiredEnum('action', PIPELINE_ACTIONS),
  pipelineId: optionalDecimalId('pipelineId'),
  jobId: optionalDecimalId('jobId')
})

/** One brokered effect with its caller identity filled from the trusted MCP SessionContext. */
export interface CodeHostEffectReq {
  agentId: string
  platform: string
  channel: string
  thread: string
  transportScope?: string
  operation: GitlabBrokerOperation
}

/** The broker seam. Optional: an ordinary daemon carries the descriptors but fails closed. */
export interface CodeHostEffectDeps {
  /** Resolve the trusted project, mint the action-time effect lease, and run one allowlisted call. */
  codeHostEffect?: (req: CodeHostEffectReq) => Promise<unknown>
}

function run(ctx: SessionContext, deps: CodeHostEffectDeps, operation: GitlabBrokerOperation): Promise<unknown> {
  if (!deps.codeHostEffect) throw new Error('code-host effects are unavailable on this daemon')
  return deps.codeHostEffect({
    agentId: ctx.agentId,
    platform: ctx.platform,
    channel: ctx.channel,
    thread: ctx.thread,
    ...(ctx.transportScope !== undefined ? { transportScope: ctx.transportScope } : {}),
    operation
  })
}

export function createCodeHostComment(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: CodeHostEffectDeps
): Promise<unknown> {
  return run(ctx, deps, { kind: 'createComment', ...parseArgs(CREATE_CODE_HOST_COMMENT_ARGS, args) })
}

export function updateCodeHostComment(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: CodeHostEffectDeps
): Promise<unknown> {
  return run(ctx, deps, { kind: 'updateComment', ...parseArgs(UPDATE_CODE_HOST_COMMENT_ARGS, args) })
}

export function readCodeHostDiscussions(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: CodeHostEffectDeps
): Promise<unknown> {
  return run(ctx, deps, { kind: 'readDiscussions', ...parseArgs(READ_CODE_HOST_DISCUSSIONS_ARGS, args) })
}

export function replyCodeHostDiscussion(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: CodeHostEffectDeps
): Promise<unknown> {
  return run(ctx, deps, { kind: 'replyDiscussion', ...parseArgs(REPLY_CODE_HOST_DISCUSSION_ARGS, args) })
}

export function createCodeHostMergeRequest(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: CodeHostEffectDeps
): Promise<unknown> {
  return run(ctx, deps, { kind: 'createMergeRequest', ...parseArgs(CREATE_CODE_HOST_MERGE_REQUEST_ARGS, args) })
}

export function updateCodeHostMergeRequest(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: CodeHostEffectDeps
): Promise<unknown> {
  const parsed = parseArgs(UPDATE_CODE_HOST_MERGE_REQUEST_ARGS, args)
  // Draft state is carried by the title on GitLab, so it can only move together with one.
  if (parsed.draft !== undefined && parsed.title === undefined) {
    throw new Error('argument draft also requires title, because draft state is carried by the merge-request title')
  }
  if (parsed.title === undefined && parsed.description === undefined && parsed.targetBranch === undefined) {
    throw new Error('supply at least one of title, description, or targetBranch')
  }
  return run(ctx, deps, { kind: 'updateMergeRequest', ...parsed })
}

export function inspectCodeHostPipelines(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: CodeHostEffectDeps
): Promise<unknown> {
  return run(ctx, deps, { kind: 'inspectPipelines', ...parseArgs(INSPECT_CODE_HOST_PIPELINES_ARGS, args) })
}

export function controlCodeHostPipeline(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: CodeHostEffectDeps
): Promise<unknown> {
  return run(ctx, deps, { kind: 'controlPipeline', ...parseArgs(CONTROL_CODE_HOST_PIPELINE_ARGS, args) })
}
