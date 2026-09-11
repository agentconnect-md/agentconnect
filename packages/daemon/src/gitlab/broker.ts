// GitLab structured mutation broker (gitlab-com-integration.md §14.2): the allowlisted
// non-review effects an agent may ask the daemon to perform under an effect lease.
// The operation vocabulary, the clamp, the one-retry call, and the comment ledger are the
// provider-neutral broker's (codehost/broker.ts); this module owns GitLab's allowlist and plans.
import {
  AuthoredCommentLedger,
  bool,
  branch,
  brokerCall,
  compact,
  enforceCapability,
  idOf,
  int,
  limited,
  MAX_LIST_ITEMS,
  MAX_NOTE_BODY_CHARS,
  record,
  renderPath,
  requireArg,
  requireDecimal,
  str,
  type BrokerEndpoint,
  type BrokerLease,
  type BrokerSubject,
  type CodeHostBrokerOperation
} from '../codehost/broker.js'
import { parseCodeHostJson } from '../codehost/json.js'

export { BROKER_PIPELINE_STATUSES } from '../codehost/broker.js'
export type { BrokerCapability, BrokerEndpoint, BrokerSubject } from '../codehost/broker.js'

/** THE allowlist: every call renders one of these templates — no arbitrary path, GraphQL, or raw body. */
export const GITLAB_BROKER_ENDPOINTS = {
  'comment.create': { method: 'POST', capability: 'comment', path: '/projects/:project/:subject/:iid/notes' },
  'comment.update': { method: 'PUT', capability: 'comment', path: '/projects/:project/:subject/:iid/notes/:noteId' },
  'discussion.list': { method: 'GET', capability: 'read', path: '/projects/:project/:subject/:iid/discussions' },
  'discussion.get': {
    method: 'GET',
    capability: 'read',
    path: '/projects/:project/:subject/:iid/discussions/:discussionId'
  },
  'discussion.reply': {
    method: 'POST',
    capability: 'comment',
    path: '/projects/:project/:subject/:iid/discussions/:discussionId/notes'
  },
  'mergeRequest.create': { method: 'POST', capability: 'write', path: '/projects/:project/merge_requests' },
  'mergeRequest.update': { method: 'PUT', capability: 'write', path: '/projects/:project/merge_requests/:iid' },
  'pipeline.list': { method: 'GET', capability: 'read', path: '/projects/:project/pipelines' },
  'pipeline.get': { method: 'GET', capability: 'read', path: '/projects/:project/pipelines/:pipelineId' },
  'pipeline.jobs': { method: 'GET', capability: 'read', path: '/projects/:project/pipelines/:pipelineId/jobs' },
  'job.get': { method: 'GET', capability: 'read', path: '/projects/:project/jobs/:jobId' },
  'pipeline.retry': { method: 'POST', capability: 'write', path: '/projects/:project/pipelines/:pipelineId/retry' },
  'pipeline.cancel': { method: 'POST', capability: 'write', path: '/projects/:project/pipelines/:pipelineId/cancel' },
  'job.retry': { method: 'POST', capability: 'write', path: '/projects/:project/jobs/:jobId/retry' },
  'job.cancel': { method: 'POST', capability: 'write', path: '/projects/:project/jobs/:jobId/cancel' }
} as const satisfies Record<string, BrokerEndpoint>

export type BrokerEndpointId = keyof typeof GITLAB_BROKER_ENDPOINTS

/** The product subject vocabulary the tools speak, mapped to its GitLab path segment. */
const SUBJECT_SEGMENT: Record<BrokerSubject, string> = { issue: 'issues', merge_request: 'merge_requests' }

/** The §14.2 operation set is provider-neutral; the name survives for this module's consumers. */
export type GitlabBrokerOperation = CodeHostBrokerOperation

/** The trusted target: agent, project, and hook are daemon-held coordinates, never tool arguments. */
export interface GitlabBrokerTarget {
  agentId: string
  /** Numeric project id (decimal string) — the hook's trusted metadata or the agent's workspace project. */
  projectId: string
  /** Present when a hook-dispatched turn authorizes the lease (§13.1). */
  hookId?: string
  /** Logical session key — the single-writer ledger for `updateComment` is scoped to it. */
  sessionKey: string
}

export type GitlabBrokerLease = BrokerLease

export interface GitlabBrokerDeps {
  /** Action-time effect lease (purpose `gitlab_effect`); refuses when the CP lacks the feature. */
  lease: (target: GitlabBrokerTarget) => Promise<GitlabBrokerLease>
  /** Drop a cached lease GitLab just rejected (401/403) so the single retry re-mints. */
  invalidateLease?: (target: GitlabBrokerTarget, token: string) => void
  /** The instance's `/api/v4` root for THIS target's agent, resolved per turn (§24.4). */
  apiBaseUrl: (target: GitlabBrokerTarget) => string
  fetchImpl?: typeof fetch
}

const MAX_DISCUSSION_NOTES = 50

/** GitLab discussion ids are hex digests. */
const DISCUSSION_ID = /^[0-9a-f]{6,64}$/

/** GitLab ids exceed the safe-integer range; quote them before parsing, as the poster does. */
export function parseGitlabJson(raw: string): unknown {
  return parseCodeHostJson(raw)
}

function noteResult(raw: unknown): Record<string, unknown> {
  const note = record(raw)
  return compact({
    id: idOf(note.id),
    body: str(note.body, MAX_NOTE_BODY_CHARS),
    author: str(record(note.author).username, 100),
    system: bool(note.system),
    resolved: bool(note.resolved),
    createdAt: str(note.created_at, 40),
    updatedAt: str(note.updated_at, 40)
  })
}

function discussionResult(raw: unknown): Record<string, unknown> {
  const discussion = record(raw)
  const notes = Array.isArray(discussion.notes) ? discussion.notes.slice(0, MAX_DISCUSSION_NOTES) : []
  return compact({
    id: str(discussion.id, 64),
    individualNote: bool(discussion.individual_note),
    notes: notes.map(noteResult)
  })
}

function mergeRequestResult(raw: unknown): Record<string, unknown> {
  const mr = record(raw)
  return compact({
    id: idOf(mr.id),
    iid: int(mr.iid),
    projectId: idOf(mr.project_id),
    title: str(mr.title, 500),
    state: str(mr.state, 40),
    draft: bool(mr.draft) ?? bool(mr.work_in_progress),
    sourceBranch: str(mr.source_branch, 255),
    targetBranch: str(mr.target_branch, 255),
    webUrl: str(mr.web_url, 500),
    createdAt: str(mr.created_at, 40),
    updatedAt: str(mr.updated_at, 40)
  })
}

function pipelineResult(raw: unknown): Record<string, unknown> {
  const pipeline = record(raw)
  return compact({
    id: idOf(pipeline.id),
    iid: int(pipeline.iid),
    projectId: idOf(pipeline.project_id),
    status: str(pipeline.status, 40),
    source: str(pipeline.source, 40),
    ref: str(pipeline.ref, 255),
    sha: str(pipeline.sha, 64),
    webUrl: str(pipeline.web_url, 500),
    createdAt: str(pipeline.created_at, 40),
    updatedAt: str(pipeline.updated_at, 40)
  })
}

function jobResult(raw: unknown): Record<string, unknown> {
  const job = record(raw)
  return compact({
    id: idOf(job.id),
    name: str(job.name, 255),
    stage: str(job.stage, 255),
    status: str(job.status, 40),
    ref: str(job.ref, 255),
    allowFailure: bool(job.allow_failure),
    pipelineId: idOf(record(job.pipeline).id),
    webUrl: str(job.web_url, 500),
    createdAt: str(job.created_at, 40),
    startedAt: str(job.started_at, 40),
    finishedAt: str(job.finished_at, 40)
  })
}

/** One resolved call: the allowlisted endpoint, its rendered path params, and the bounded payload. */
interface BrokerPlan {
  endpoint: BrokerEndpointId
  params: Record<string, string>
  query?: Record<string, string>
  body?: Record<string, unknown>
  /** Project the GitLab response onto bounded structured data. */
  shape: (parsed: unknown) => unknown
  /** Remember the created note id so `updateComment` keeps the single-writer discipline. */
  recordsNote?: boolean
}

/** Every draft marker GitLab recognizes, case-insensitively: `Draft:`, `[Draft]`, `(Draft)` and the legacy WIP forms. */
const DRAFT_MARKER = /^\s*(?:\[\s*(?:draft|wip)\s*\]|\(\s*(?:draft|wip)\s*\)|(?:draft|wip)\s*:)\s*/i

/** Draft state is a title prefix in GitLab, so the bounded `draft` flag normalizes the title both ways. */
function draftTitle(title: string, draft: boolean | undefined): string {
  if (draft === undefined) return title
  let bare = title
  while (DRAFT_MARKER.test(bare)) bare = bare.replace(DRAFT_MARKER, '')
  return (draft ? `Draft: ${bare.trim()}` : bare).trim()
}

export class GitlabBroker {
  private readonly authored = new AuthoredCommentLedger()

  constructor(private readonly deps: GitlabBrokerDeps) {}

  async execute(target: GitlabBrokerTarget, op: GitlabBrokerOperation): Promise<unknown> {
    const plan = this.plan(target, op)
    const endpoint = GITLAB_BROKER_ENDPOINTS[plan.endpoint]
    const lease = await this.deps.lease(target)
    this.enforce(lease, endpoint)
    const parsed = await this.call(target, plan, endpoint, lease)
    if (plan.recordsNote) this.authored.remember(target.sessionKey, idOf(record(parsed).id))
    return plan.shape(parsed)
  }

  private enforce(lease: GitlabBrokerLease, endpoint: BrokerEndpoint): void {
    enforceCapability(lease, endpoint, 'GitLab project')
  }

  private plan(target: GitlabBrokerTarget, op: GitlabBrokerOperation): BrokerPlan {
    const project = requireDecimal(target.projectId, 'project id')
    switch (op.kind) {
      case 'createComment':
        return {
          endpoint: 'comment.create',
          params: { project, subject: SUBJECT_SEGMENT[op.subject], iid: String(op.iid) },
          body: { body: op.body },
          shape: (parsed) => ({ note: noteResult(parsed) }),
          recordsNote: true
        }
      case 'updateComment': {
        const noteId = requireDecimal(op.noteId, 'noteId')
        if (!this.authored.has(target.sessionKey, noteId)) {
          throw new Error('only a comment this session created through the broker can be updated')
        }
        return {
          endpoint: 'comment.update',
          params: { project, subject: SUBJECT_SEGMENT[op.subject], iid: String(op.iid), noteId },
          body: { body: op.body },
          shape: (parsed) => ({ note: noteResult(parsed) })
        }
      }
      case 'readDiscussions': {
        const base = { project, subject: SUBJECT_SEGMENT[op.subject], iid: String(op.iid) }
        if (op.discussionId === undefined) {
          return {
            endpoint: 'discussion.list',
            params: base,
            query: { per_page: limited(op.limit) },
            shape: (parsed) => ({
              discussions: (Array.isArray(parsed) ? parsed.slice(0, MAX_LIST_ITEMS) : []).map(discussionResult)
            })
          }
        }
        return {
          endpoint: 'discussion.get',
          params: { ...base, discussionId: discussionId(op.discussionId) },
          shape: (parsed) => ({ discussion: discussionResult(parsed) })
        }
      }
      case 'replyDiscussion':
        return {
          endpoint: 'discussion.reply',
          params: {
            project,
            subject: SUBJECT_SEGMENT[op.subject],
            iid: String(op.iid),
            discussionId: discussionId(op.discussionId)
          },
          body: { body: op.body },
          shape: (parsed) => ({ note: noteResult(parsed) }),
          recordsNote: true
        }
      case 'createMergeRequest':
        return {
          endpoint: 'mergeRequest.create',
          params: { project },
          body: compact({
            source_branch: branch(op.sourceBranch, 'sourceBranch'),
            target_branch: branch(op.targetBranch, 'targetBranch'),
            title: draftTitle(op.title, op.draft),
            description: op.description
          }),
          shape: (parsed) => ({ mergeRequest: mergeRequestResult(parsed) })
        }
      case 'updateMergeRequest':
        return {
          endpoint: 'mergeRequest.update',
          params: { project, iid: String(op.iid) },
          body: compact({
            ...(op.title !== undefined ? { title: draftTitle(op.title, op.draft) } : {}),
            description: op.description,
            target_branch: op.targetBranch === undefined ? undefined : branch(op.targetBranch, 'targetBranch')
          }),
          shape: (parsed) => ({ mergeRequest: mergeRequestResult(parsed) })
        }
      case 'inspectPipelines':
        return planInspect(project, op)
      case 'controlPipeline':
        return planControl(project, op)
    }
  }

  /** Issue the allowlisted request; retry once, and only after a definite auth rejection. */
  private call(
    target: GitlabBrokerTarget,
    plan: BrokerPlan,
    endpoint: BrokerEndpoint,
    lease: GitlabBrokerLease
  ): Promise<unknown> {
    const search = new URLSearchParams(plan.query ?? {}).toString()
    const path = renderPath(endpoint.path, plan.params)
    return brokerCall(
      {
        headers: (token) => ({ 'private-token': token }),
        lease: () => this.deps.lease(target),
        ...(this.deps.invalidateLease
          ? { invalidateLease: (token: string) => this.deps.invalidateLease!(target, token) }
          : {}),
        enforce: (fresh) => this.enforce(fresh, endpoint),
        host: 'GitLab',
        ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {})
      },
      lease,
      {
        method: endpoint.method,
        url: `${this.deps.apiBaseUrl(target)}${path}${search ? `?${search}` : ''}`,
        ...(plan.body !== undefined ? { body: plan.body } : {})
      }
    )
  }
}

function planInspect(project: string, op: Extract<GitlabBrokerOperation, { kind: 'inspectPipelines' }>): BrokerPlan {
  if (op.scope === 'pipelines') {
    return {
      endpoint: 'pipeline.list',
      params: { project },
      query: {
        per_page: limited(op.limit),
        ...(op.ref !== undefined ? { ref: branch(op.ref, 'ref') } : {}),
        ...(op.status !== undefined ? { status: op.status } : {})
      },
      shape: (parsed) => ({
        pipelines: (Array.isArray(parsed) ? parsed.slice(0, MAX_LIST_ITEMS) : []).map(pipelineResult)
      })
    }
  }
  if (op.scope === 'job') {
    return {
      endpoint: 'job.get',
      params: { project, jobId: requireArg(op.jobId, 'jobId', op.scope) },
      shape: (parsed) => ({ job: jobResult(parsed) })
    }
  }
  const pipelineId = requireArg(op.pipelineId, 'pipelineId', op.scope)
  if (op.scope === 'pipeline') {
    return {
      endpoint: 'pipeline.get',
      params: { project, pipelineId },
      shape: (parsed) => ({ pipeline: pipelineResult(parsed) })
    }
  }
  return {
    endpoint: 'pipeline.jobs',
    params: { project, pipelineId },
    query: { per_page: limited(op.limit) },
    shape: (parsed) => ({ jobs: (Array.isArray(parsed) ? parsed.slice(0, MAX_LIST_ITEMS) : []).map(jobResult) })
  }
}

function planControl(project: string, op: Extract<GitlabBrokerOperation, { kind: 'controlPipeline' }>): BrokerPlan {
  if (op.action === 'retry_job' || op.action === 'cancel_job') {
    return {
      endpoint: op.action === 'retry_job' ? 'job.retry' : 'job.cancel',
      params: { project, jobId: requireArg(op.jobId, 'jobId', op.action) },
      shape: (parsed) => ({ job: jobResult(parsed) })
    }
  }
  return {
    endpoint: op.action === 'retry_pipeline' ? 'pipeline.retry' : 'pipeline.cancel',
    params: { project, pipelineId: requireArg(op.pipelineId, 'pipelineId', op.action) },
    shape: (parsed) => ({ pipeline: pipelineResult(parsed) })
  }
}

function discussionId(value: string): string {
  if (!DISCUSSION_ID.test(value)) throw new Error('discussionId must be a GitLab discussion id')
  return value
}
