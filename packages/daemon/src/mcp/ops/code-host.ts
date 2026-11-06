// The code-host effect tools (gitlab-com-integration.md §14.2, gitea-integration.md §10.2): each host names its own tools, and a call carries that host to its broker.
import { z, type ZodType } from 'zod'
import type { CodeHostProvider } from '@agentconnect.md/protocol'
import type { ObjectToolSchema, ToolDescriptor } from '../../tool-schema/descriptor.js'
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
import { BROKER_PIPELINE_STATUSES, type BrokerSubject, type CodeHostBrokerOperation } from '../../codehost/broker.js'

const INSPECT_SCOPES = ['pipelines', 'pipeline', 'pipeline_jobs', 'job'] as const
const PIPELINE_ACTIONS = ['retry_pipeline', 'cancel_pipeline', 'retry_job', 'cancel_job'] as const

/** A decimal external id (note, pipeline, job) — the only shape an allowlisted path accepts. */
export function requiredDecimalId(key: string) {
  return requiredString(key).regex(/^[1-9]\d*$/, `argument ${key} must be a positive decimal string`)
}

export function optionalDecimalId(key: string) {
  return requiredDecimalId(key)
    .nullish()
    .transform((value) => value ?? undefined)
}

/** The subject values one host's tools accept: `issue` plus that host's word for a change request. */
export type SubjectValues = readonly ['issue', 'merge_request'] | readonly ['issue', 'pull_request']

/** A host's change-request word mapped onto the broker's one subject vocabulary. */
export function brokerSubject(value: string): BrokerSubject {
  return value === 'issue' ? 'issue' : 'merge_request'
}

const iid = requiredPositiveInt('iid')

export function commentArgs(subjects: SubjectValues) {
  return z.object({ subject: requiredEnum('subject', subjects), iid, body: requiredString('body') })
}

export function updateCommentArgs(subjects: SubjectValues) {
  return z.object({
    subject: requiredEnum('subject', subjects),
    iid,
    noteId: requiredDecimalId('noteId'),
    body: requiredString('body')
  })
}

export function readDiscussionsArgs(subjects: SubjectValues) {
  return z.object({
    subject: requiredEnum('subject', subjects),
    iid,
    discussionId: optionalString('discussionId'),
    limit: optionalBoundedInt('limit', 1, 20)
  })
}

export function replyDiscussionArgs(subjects: SubjectValues) {
  return z.object({
    subject: requiredEnum('subject', subjects),
    iid,
    discussionId: requiredString('discussionId'),
    body: requiredString('body')
  })
}

export const CREATE_CHANGE_REQUEST_ARGS = z.object({
  sourceBranch: requiredString('sourceBranch'),
  targetBranch: requiredString('targetBranch'),
  title: requiredString('title'),
  description: optionalString('description'),
  draft: optionalBoolean('draft')
})

export const UPDATE_CHANGE_REQUEST_ARGS = z.object({
  iid,
  title: optionalString('title'),
  description: optionalString('description'),
  targetBranch: optionalString('targetBranch'),
  draft: optionalBoolean('draft')
})

/** An update naming at least one field; `noun` is the host's word, since draft state rides on the title. */
export function updateChangeRequestOperation(
  parsed: z.infer<typeof UPDATE_CHANGE_REQUEST_ARGS>,
  noun: string
): CodeHostBrokerOperation {
  if (parsed.draft !== undefined && parsed.title === undefined) {
    throw new Error(`argument draft also requires title, because draft state is carried by the ${noun} title`)
  }
  if (parsed.title === undefined && parsed.description === undefined && parsed.targetBranch === undefined) {
    throw new Error('supply at least one of title, description, or targetBranch')
  }
  return { kind: 'updateMergeRequest', ...parsed }
}

export const INSPECT_PIPELINES_ARGS = z.object({
  scope: requiredEnum('scope', INSPECT_SCOPES),
  pipelineId: optionalDecimalId('pipelineId'),
  jobId: optionalDecimalId('jobId'),
  ref: optionalString('ref'),
  status: optionalEnum('status', BROKER_PIPELINE_STATUSES),
  limit: optionalBoundedInt('limit', 1, 20)
})

export const CONTROL_PIPELINE_ARGS = z.object({
  action: requiredEnum('action', PIPELINE_ACTIONS),
  pipelineId: optionalDecimalId('pipelineId'),
  jobId: optionalDecimalId('jobId')
})

/** One host's model-facing tool for one broker operation. */
export interface CodeHostEffectTool {
  provider: CodeHostProvider
  /** Reads only, so a follow-up check keeps it (assistant-mode.md §5.12). */
  readOnly: boolean
  descriptor: ToolDescriptor
  args: ZodType
  operation: (args: Record<string, unknown>) => CodeHostBrokerOperation
  /** One line of session guidance, given whenever this tool is offered. */
  guidance?: string
}

// How each host spells a repository the model may name beside the session's own.
const REPOSITORY_FORM: Record<CodeHostProvider, string> = {
  github: '`owner/repo`',
  gitlab: 'its full project path (`group/subgroup/project`)',
  gitea: '`owner/repo`'
}

/** Every tool's optional `repository`: another repository the agent is authorized for, or the session's own when omitted. */
function withRepositoryProperty(descriptor: ToolDescriptor, provider: CodeHostProvider): ToolDescriptor {
  if ('oneOf' in descriptor.inputSchema) return descriptor
  const schema = descriptor.inputSchema as ObjectToolSchema
  const repository = {
    type: 'string',
    minLength: 1,
    description:
      `Another repository to act on, as ${REPOSITORY_FORM[provider]}, that this agent is authorized for. ` +
      'Omit it to act on this session’s repository.'
  }
  return { ...descriptor, inputSchema: { ...schema, properties: { ...schema.properties, repository } } }
}

/** Declare a host's tool with its argument schema and the operation its parsed arguments make; every tool also takes `repository`. */
export function codeHostEffectTool<S extends z.ZodObject>(spec: {
  provider: CodeHostProvider
  readOnly: boolean
  descriptor: ToolDescriptor
  args: S
  operation: (args: z.infer<S>) => CodeHostBrokerOperation
  guidance?: string
}): CodeHostEffectTool {
  return {
    ...spec,
    descriptor: withRepositoryProperty(spec.descriptor, spec.provider),
    args: spec.args.extend({ repository: optionalString('repository') }),
    operation: (parsed) => {
      const { repository: _repository, ...args } = parsed
      return spec.operation(args as z.infer<S>)
    }
  }
}

/** One brokered effect with its caller identity filled from the trusted MCP SessionContext. */
export interface CodeHostEffectReq {
  /** The host the tool names; the daemon acts only on a repository of this host. */
  provider: CodeHostProvider
  agentId: string
  platform: string
  channel: string
  thread: string
  transportScope?: string
  /** The repository the model named; absent means the session's own. Resolved only against the agent's authorizations. */
  repository?: string
  operation: CodeHostBrokerOperation
}

/** The broker seam. Optional: an ordinary daemon carries the descriptors but fails closed. */
export interface CodeHostEffectDeps {
  /** Resolve the trusted repository, mint the action-time effect lease, and run one allowlisted call. */
  codeHostEffect?: (req: CodeHostEffectReq) => Promise<unknown>
}

/** Run one host's tool: parse its arguments, then hand the daemon its operation and its host. */
export function runCodeHostEffectTool(
  tool: CodeHostEffectTool,
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: CodeHostEffectDeps
): Promise<unknown> {
  const parsed = parseArgs(tool.args, args) as Record<string, unknown>
  const operation = tool.operation(parsed)
  if (!deps.codeHostEffect) throw new Error('code-host effects are unavailable on this daemon')
  const repository = typeof parsed.repository === 'string' ? parsed.repository : undefined
  return deps.codeHostEffect({
    provider: tool.provider,
    agentId: ctx.agentId,
    platform: ctx.platform,
    channel: ctx.channel,
    thread: ctx.thread,
    ...(ctx.transportScope !== undefined ? { transportScope: ctx.transportScope } : {}),
    ...(repository !== undefined ? { repository } : {}),
    operation
  })
}
