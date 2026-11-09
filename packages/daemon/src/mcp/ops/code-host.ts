// The code-host effect tools (gitlab-com-integration.md §14.2, gitea-integration.md §10.2): each host names its own tools, and a call carries that host to its broker.
import { z, type ZodType } from 'zod'
import type { CodeHostProvider } from '@agentconnect.md/protocol'
import { obj, type ObjectToolSchema, type ToolDescriptor } from '../../tool-schema/descriptor.js'
import type { SessionContext } from './context.js'
import {
  optionalBoolean,
  optionalBoundedInt,
  optionalEnum,
  optionalPositiveInt,
  optionalString,
  parseArgs,
  requiredEnum,
  requiredPositiveInt,
  requiredString
} from './args.js'
import {
  BROKER_PIPELINE_STATUSES,
  MAX_NAMED,
  type BrokerMergeMethod,
  type BrokerSubject,
  type CodeHostBrokerOperation
} from '../../codehost/broker.js'

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

export function readDiscussionsArgs(subjects: SubjectValues) {
  return z.object({
    subject: requiredEnum('subject', subjects),
    iid,
    discussionId: optionalString('discussionId'),
    limit: optionalBoundedInt('limit', 1, 20)
  })
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
  gitea: '`owner/repo`',
  'azure-devops': '`organization/project/repository`'
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

/** How one host words its grouped tools; the shape and the rules are shared. */
export interface HostWords {
  provider: CodeHostProvider
  /** The tool-name prefix, which selects the host: `github`, `gitlab`, `gitea`. */
  prefix: string
  host: string
  /** `pull request` or `merge request`, and its subject value. */
  changeRequest: string
  changeSubject: 'pull_request' | 'merge_request'
  /** What the host calls a repository: `repository` or `project`. */
  repo: string
  /** Draft state is carried by the title, so a draft change also needs `title`. */
  draftInTitle: boolean
  mergeMethods: readonly [BrokerMergeMethod, ...BrokerMergeMethod[]]
  /** Comments thread, so the comment tool also replies in a discussion. */
  threads: boolean
  /** How this host's merge lands, when that differs from merging at once. */
  mergeNote?: string
  /** False where the host's issues live outside the repository: no issue tool, and comments on change requests only. */
  issues?: false
  /** Change-request fields the host does not take, left out of the schema and refused as stray. */
  omits?: readonly ('assignees' | 'reviewers')[]
}

function optionalNames(key: string) {
  const message = `argument ${key} must be an array of at most ${MAX_NAMED} strings`
  return z
    .array(z.string(message).min(1, message), message)
    .max(MAX_NAMED, message)
    .nullish()
    .transform((value) => value ?? undefined)
}

function pascal(words: string): string {
  return words.replace(/(?:^|\s)(\w)/g, (_, c: string) => c.toUpperCase())
}

/** Refuse a field the action does not take and a required one it lacks, so a mistaken call never half-applies. */
function checkFields(
  action: string,
  args: Record<string, unknown>,
  takes: readonly string[],
  needs: readonly string[]
) {
  const stray = Object.keys(args).filter((key) => key !== 'action' && args[key] !== undefined && !takes.includes(key))
  if (stray.length > 0) throw new Error(`action ${action} does not take ${stray.join(', ')}`)
  const missing = needs.filter((key) => args[key] === undefined)
  if (missing.length > 0) throw new Error(`action ${action} requires ${missing.join(', ')}`)
}

/** The given fields only, so an operation never carries a key the call left out. */
function defined<T extends Record<string, unknown>>(fields: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>
  }
}

function needsOneOf(action: string, args: Record<string, unknown>, keys: readonly string[]) {
  if (keys.every((key) => args[key] === undefined))
    throw new Error(`action ${action} needs at least one of ${keys.join(', ')}`)
}

const CHANGE_REQUEST_ACTIONS = ['create', 'update', 'merge', 'close', 'reopen'] as const
const ISSUE_ACTIONS = ['create', 'update', 'close', 'reopen'] as const

const PEOPLE = {
  labels: { type: 'array', items: { type: 'string' }, description: 'create: the labels to set.' },
  assignees: { type: 'array', items: { type: 'string' }, description: 'create: the assignees, by username.' }
}

// An update adds or removes labels and assignees, as the hosts' CLIs do, so it never clobbers ones it did not read.
const CHANGES = ['addLabels', 'removeLabels', 'addAssignees', 'removeAssignees'] as const
const CHANGE_ARGS = {
  addLabels: optionalNames('addLabels'),
  removeLabels: optionalNames('removeLabels'),
  addAssignees: optionalNames('addAssignees'),
  removeAssignees: optionalNames('removeAssignees')
}
const names = (description: string) => ({ type: 'array', items: { type: 'string' }, description })
const CHANGE_PROPS = {
  addLabels: names('update: labels to add.'),
  removeLabels: names('update: labels to remove.'),
  addAssignees: names('update: assignees to add, by username.'),
  removeAssignees: names('update: assignees to remove, by username.')
}

/** The change-request tool: open, edit, merge, close, or reopen one pull or merge request. */
export function changeRequestTool(words: HostWords): CodeHostEffectTool {
  const noun = words.changeRequest
  const full = z.object({
    action: requiredEnum('action', CHANGE_REQUEST_ACTIONS),
    iid: optionalPositiveInt('iid'),
    sourceBranch: optionalString('sourceBranch'),
    targetBranch: optionalString('targetBranch'),
    title: optionalString('title'),
    description: optionalString('description'),
    draft: optionalBoolean('draft'),
    labels: optionalNames('labels'),
    assignees: optionalNames('assignees'),
    ...CHANGE_ARGS,
    reviewers: optionalNames('reviewers'),
    mergeMethod: optionalEnum('mergeMethod', words.mergeMethods),
    sha: optionalString('sha')
  })
  const name = `${words.prefix}${pascal(noun)}`
  const omitted = new Set<string>(words.omits ?? [])
  if (omitted.has('assignees')) ['addAssignees', 'removeAssignees'].forEach((key) => omitted.add(key))
  // An omitted field leaves the validator too, which then refuses it by name instead of dropping it.
  const mask: Partial<Record<'assignees' | 'addAssignees' | 'removeAssignees' | 'reviewers', true>> =
    Object.fromEntries([...omitted].map((key) => [key, true]))
  const args = (omitted.size > 0 ? full.omit(mask).strict() : full) as typeof full
  const takes = (keys: string[]) => keys.filter((key) => !omitted.has(key))
  const editable = takes(['title', 'description', 'targetBranch', 'draft', ...CHANGES, 'reviewers'])
  const advertised = <T extends Record<string, unknown>>(props: T) =>
    Object.fromEntries(Object.entries(props).filter(([key]) => !omitted.has(key)))
  const guidance =
    words.issues === false
      ? `On ${words.host}, open, edit and merge ${noun}s and comment on them with \`${name}\` and \`${words.prefix}Comment\`.`
      : `On ${words.host}, open, edit and merge ${noun}s, file issues, and comment with \`${name}\`, \`${words.prefix}Issue\` and \`${words.prefix}Comment\`.`
  return codeHostEffectTool({
    provider: words.provider,
    readOnly: false,
    args,
    guidance,
    operation: (parsed): CodeHostBrokerOperation => {
      const { action, ...fields } = parsed
      const all = parsed as Record<string, unknown>
      switch (action) {
        case 'create':
          checkFields(
            action,
            all,
            takes([
              'sourceBranch',
              'targetBranch',
              'title',
              'description',
              'draft',
              'labels',
              'assignees',
              'reviewers'
            ]),
            ['sourceBranch', 'targetBranch', 'title']
          )
          return {
            kind: 'createMergeRequest',
            ...defined(fields),
            sourceBranch: fields.sourceBranch!,
            targetBranch: fields.targetBranch!,
            title: fields.title!
          }
        case 'update':
          checkFields(action, all, ['iid', ...editable], ['iid'])
          needsOneOf(action, all, editable)
          if (words.draftInTitle && fields.draft !== undefined && fields.title === undefined)
            throw new Error(`argument draft also requires title, because draft state is carried by the ${noun} title`)
          return { kind: 'updateMergeRequest', ...defined(fields), iid: fields.iid! }
        case 'merge':
          checkFields(action, all, ['iid', 'mergeMethod', 'sha'], ['iid'])
          return {
            kind: 'mergeMergeRequest',
            iid: fields.iid!,
            ...(fields.mergeMethod !== undefined ? { method: fields.mergeMethod } : {}),
            ...(fields.sha !== undefined ? { sha: fields.sha } : {})
          }
        case 'close':
        case 'reopen':
          checkFields(action, all, ['iid'], ['iid'])
          return {
            kind: 'setState',
            subject: 'merge_request',
            iid: fields.iid!,
            state: action === 'close' ? 'closed' : 'open'
          }
      }
    },
    descriptor: {
      name,
      description:
        `Open, edit, merge, close, or reopen a ${words.host} ${noun} in this session’s ${words.repo}. ` +
        `\`create\` opens one from an already-pushed branch; \`update\` changes only the fields given. ` +
        'Each action takes only its own fields. Requires write authority.',
      inputSchema: obj(
        {
          action: { type: 'string', enum: [...CHANGE_REQUEST_ACTIONS] },
          iid: { type: 'integer', minimum: 1, description: `Every action but create: the ${noun} number.` },
          sourceBranch: { type: 'string', minLength: 1, description: 'create: the branch holding the changes.' },
          targetBranch: { type: 'string', minLength: 1, description: 'create/update: the branch to merge into.' },
          title: { type: 'string', minLength: 1, description: 'create/update: the title.' },
          description: { type: 'string', description: 'create/update: the body in Markdown.' },
          draft: {
            type: 'boolean',
            description: words.draftInTitle
              ? 'create/update: draft state, carried by the title (an update also needs `title`).'
              : 'create/update: open as a draft, or convert to (true) or from (false) one.'
          },
          ...advertised({
            ...PEOPLE,
            ...CHANGE_PROPS,
            reviewers: {
              type: 'array',
              items: { type: 'string' },
              description: 'create/update: usernames to request a review from.'
            }
          }),
          mergeMethod: {
            type: 'string',
            enum: [...words.mergeMethods],
            description: `merge: how it lands.${words.mergeNote ? ` ${words.mergeNote}` : ''}`
          },
          sha: { type: 'string', description: 'merge: refuse unless the head is still this commit.' }
        },
        ['action']
      )
    }
  })
}

/** The issue tool: file, edit, close, or reopen one issue. */
export function issueTool(words: HostWords): CodeHostEffectTool {
  const args = z.object({
    action: requiredEnum('action', ISSUE_ACTIONS),
    iid: optionalPositiveInt('iid'),
    title: optionalString('title'),
    description: optionalString('description'),
    labels: optionalNames('labels'),
    assignees: optionalNames('assignees'),
    ...CHANGE_ARGS
  })
  const editable = ['title', 'description', ...CHANGES]
  return codeHostEffectTool({
    provider: words.provider,
    readOnly: false,
    args,
    operation: (parsed): CodeHostBrokerOperation => {
      const { action, ...fields } = parsed
      const all = parsed as Record<string, unknown>
      switch (action) {
        case 'create':
          checkFields(action, all, ['title', 'description', 'labels', 'assignees'], ['title'])
          return { kind: 'createIssue', ...defined(fields), title: fields.title! }
        case 'update':
          checkFields(action, all, ['iid', ...editable], ['iid'])
          needsOneOf(action, all, editable)
          return { kind: 'updateIssue', ...defined(fields), iid: fields.iid! }
        case 'close':
        case 'reopen':
          checkFields(action, all, ['iid'], ['iid'])
          return { kind: 'setState', subject: 'issue', iid: fields.iid!, state: action === 'close' ? 'closed' : 'open' }
      }
    },
    descriptor: {
      name: `${words.prefix}Issue`,
      description:
        `File, edit, close, or reopen a ${words.host} issue in this session’s ${words.repo}. \`update\` changes only ` +
        'the fields given. Each action takes only its own fields. Requires write authority.',
      inputSchema: obj(
        {
          action: { type: 'string', enum: [...ISSUE_ACTIONS] },
          iid: { type: 'integer', minimum: 1, description: 'Every action but create: the issue number.' },
          title: { type: 'string', minLength: 1, description: 'create/update: the title.' },
          description: { type: 'string', description: 'create/update: the body in Markdown.' },
          ...PEOPLE,
          ...CHANGE_PROPS
        },
        ['action']
      )
    }
  })
}

/** The comment tool: post or rewrite a comment, and reply in a discussion where the host threads. */
export function commentTool(words: HostWords): CodeHostEffectTool {
  const subjects: readonly [string, ...string[]] =
    words.issues === false ? [words.changeSubject] : ['issue', words.changeSubject]
  const actions = words.threads ? (['create', 'update', 'reply'] as const) : (['create', 'update'] as const)
  // Only a threading host's schema carries discussionId, so the validator matches the advertised fields.
  const args = z.object({
    action: requiredEnum('action', actions),
    subject: requiredEnum('subject', subjects),
    iid,
    body: requiredString('body'),
    commentId: optionalDecimalId('commentId'),
    ...(words.threads ? { discussionId: optionalString('discussionId') } : {})
  })
  const name = `${words.prefix}Comment`
  const on = words.issues === false ? words.changeRequest : `issue or ${words.changeRequest}`
  return codeHostEffectTool({
    provider: words.provider,
    readOnly: false,
    args,
    operation: (parsed): CodeHostBrokerOperation => {
      const all = parsed as Record<string, unknown>
      const { action, subject, commentId, discussionId, ...rest } = parsed as typeof parsed & { discussionId?: string }
      const base = { subject: brokerSubject(subject), ...rest }
      switch (action) {
        case 'create':
          checkFields(action, all, ['subject', 'iid', 'body'], [])
          return { kind: 'createComment', ...base }
        case 'update':
          checkFields(action, all, ['subject', 'iid', 'body', 'commentId'], ['commentId'])
          return { kind: 'updateComment', ...base, noteId: commentId! }
        case 'reply':
          checkFields(action, all, ['subject', 'iid', 'body', 'discussionId'], ['discussionId'])
          return { kind: 'replyDiscussion', ...base, discussionId: discussionId! }
      }
    },
    descriptor: {
      name,
      description:
        `Comment on a ${words.host} ${on} in this session’s ${words.repo}` +
        (words.threads ? ', or reply in a discussion thread. ' : '. ') +
        '`update` rewrites only a comment this session posted with this tool. Requires comment authority.',
      inputSchema: obj(
        {
          action: { type: 'string', enum: [...actions] },
          subject: { type: 'string', enum: [...subjects] },
          iid: { type: 'integer', minimum: 1, description: `The ${on} number.` },
          body: { type: 'string', minLength: 1, description: 'The complete Markdown body.' },
          commentId: {
            type: 'string',
            pattern: '^[1-9][0-9]*$',
            description: `update: the comment id an earlier ${name} call returned.`
          },
          ...(words.threads
            ? { discussionId: { type: 'string', description: 'reply: the thread id to answer in.' } }
            : {})
        },
        ['action', 'subject', 'iid', 'body']
      )
    }
  })
}
