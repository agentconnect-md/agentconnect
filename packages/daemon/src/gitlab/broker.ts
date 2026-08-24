// GitLab structured mutation broker (gitlab-com-integration.md §14.2): the allowlisted
// non-review effects an agent may ask the daemon to perform under an effect lease.
// The token never enters the agent environment and the project is never model input.
import type { GitCredGrant } from '@agentconnect.md/protocol'

/** §13.1 authorization levels, ordered — an operation's class is checked against the CLAMPED grant. */
export type BrokerCapability = GitCredGrant['access']

const CAPABILITY_RANK: Record<BrokerCapability, number> = { read: 0, comment: 1, write: 2 }

/** One allowlisted endpoint: an exact method, an exact path template, and the capability it costs. */
export interface BrokerEndpoint {
  method: 'GET' | 'POST' | 'PUT'
  capability: BrokerCapability
  path: string
}

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
export type BrokerSubject = 'issue' | 'merge_request'
const SUBJECT_SEGMENT: Record<BrokerSubject, string> = { issue: 'issues', merge_request: 'merge_requests' }

/** Bounded pipeline states the inspect operation may filter on. */
export const BROKER_PIPELINE_STATUSES = [
  'created',
  'waiting_for_resource',
  'preparing',
  'pending',
  'running',
  'success',
  'failed',
  'canceled',
  'skipped',
  'manual',
  'scheduled'
] as const

/** The §14.2 operation set, exactly. Every member resolves to one allowlisted endpoint. */
export type GitlabBrokerOperation =
  | { kind: 'createComment'; subject: BrokerSubject; iid: number; body: string }
  | { kind: 'updateComment'; subject: BrokerSubject; iid: number; noteId: string; body: string }
  | { kind: 'readDiscussions'; subject: BrokerSubject; iid: number; discussionId?: string; limit?: number }
  | { kind: 'replyDiscussion'; subject: BrokerSubject; iid: number; discussionId: string; body: string }
  | {
      kind: 'createMergeRequest'
      sourceBranch: string
      targetBranch: string
      title: string
      description?: string
      draft?: boolean
    }
  | {
      kind: 'updateMergeRequest'
      iid: number
      title?: string
      description?: string
      targetBranch?: string
      draft?: boolean
    }
  | {
      kind: 'inspectPipelines'
      scope: 'pipelines' | 'pipeline' | 'pipeline_jobs' | 'job'
      pipelineId?: string
      jobId?: string
      ref?: string
      status?: (typeof BROKER_PIPELINE_STATUSES)[number]
      limit?: number
    }
  | {
      kind: 'controlPipeline'
      action: 'retry_pipeline' | 'cancel_pipeline' | 'retry_job' | 'cancel_job'
      pipelineId?: string
      jobId?: string
    }

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

export interface GitlabBrokerLease {
  token: string
  /** The clamp the CP echoed in the grant; every operation is refused above it. */
  access: BrokerCapability
}

export interface GitlabBrokerDeps {
  /** Action-time effect lease (purpose `gitlab_effect`); refuses when the CP lacks the feature. */
  lease: (target: GitlabBrokerTarget) => Promise<GitlabBrokerLease>
  /** Drop a cached lease GitLab just rejected (401/403) so the single retry re-mints. */
  invalidateLease?: (target: GitlabBrokerTarget, token: string) => void
  baseUrl?: string
  fetchImpl?: typeof fetch
}

/** Bounds on what one broker answer may carry back into the model's context. */
const MAX_NOTE_BODY_CHARS = 4000
const MAX_DISCUSSION_NOTES = 50
const MAX_LIST_ITEMS = 20
const MAX_ERROR_CHARS = 200
/** Ledger bounds: a long-lived daemon must not accumulate note ids for every session it ever ran. */
const MAX_LEDGER_SESSIONS = 500
const MAX_LEDGER_NOTES = 200

const DECIMAL_ID = /^[1-9]\d*$/
/** GitLab discussion ids are hex digests. */
const DISCUSSION_ID = /^[0-9a-f]{6,64}$/
/** A conservative branch shape — enough for real refs, never a traversal or a query injection. */
const BRANCH_NAME = /^[\w.\-/]{1,255}$/

/** GitLab ids exceed the safe-integer range; quote them before parsing, as the poster does. */
export function parseGitlabJson(raw: string): unknown {
  return JSON.parse(raw.replace(/"((?:[a-z][a-z0-9_]*_)?id)"\s*:\s*(\d{15,})/g, '"$1":"$2"'))
}

/** A big-int-safe id as a decimal string; undefined when the value is not one. */
function idOf(value: unknown): string | undefined {
  if (typeof value === 'string' && DECIMAL_ID.test(value)) return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  return undefined
}

function str(value: unknown, max = 500): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : undefined
}

function int(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

/** Drop undefined members so a bounded result never carries empty keys into the model's context. */
function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>
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

function requireDecimal(value: string, label: string): string {
  if (!DECIMAL_ID.test(value)) throw new Error(`${label} must be a positive decimal id`)
  return value
}

function limited(limit: number | undefined): string {
  return String(Math.min(Math.max(limit ?? MAX_LIST_ITEMS, 1), MAX_LIST_ITEMS))
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
  /** Note ids this broker authored, by session key — `updateComment` may touch nothing else. */
  private readonly authored = new Map<string, Set<string>>()

  constructor(private readonly deps: GitlabBrokerDeps) {}

  async execute(target: GitlabBrokerTarget, op: GitlabBrokerOperation): Promise<unknown> {
    const plan = this.plan(target, op)
    const endpoint = GITLAB_BROKER_ENDPOINTS[plan.endpoint]
    const lease = await this.deps.lease(target)
    this.enforce(lease, endpoint)
    const parsed = await this.call(target, plan, endpoint, lease)
    if (plan.recordsNote) this.remember(target.sessionKey, idOf(record(parsed).id))
    return plan.shape(parsed)
  }

  /** §13.1: the clamp the CP echoed decides, not the tool the model happened to call. */
  private enforce(lease: GitlabBrokerLease, endpoint: BrokerEndpoint): void {
    if (CAPABILITY_RANK[lease.access] >= CAPABILITY_RANK[endpoint.capability]) return
    throw new Error(
      `this operation needs ${endpoint.capability} authority on the GitLab project, but the current authorization grants ${lease.access}`
    )
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
        if (!this.authored.get(target.sessionKey)?.has(noteId)) {
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
  private async call(
    target: GitlabBrokerTarget,
    plan: BrokerPlan,
    endpoint: BrokerEndpoint,
    lease: GitlabBrokerLease
  ): Promise<unknown> {
    const doFetch = this.deps.fetchImpl ?? fetch
    const search = new URLSearchParams(plan.query ?? {}).toString()
    const path = renderPath(endpoint.path, plan.params)
    const url = `${this.deps.baseUrl ?? 'https://gitlab.com/api/v4'}${path}${search ? `?${search}` : ''}`
    let current = lease
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const res = await doFetch(url, {
        method: endpoint.method,
        headers: {
          'private-token': current.token,
          ...(plan.body !== undefined ? { 'content-type': 'application/json' } : {})
        },
        ...(plan.body !== undefined ? { body: JSON.stringify(plan.body) } : {})
      })
      if (res.ok) {
        const raw = await res.text()
        try {
          return parseGitlabJson(raw)
        } catch {
          throw new Error(`GitLab returned an unreadable ${endpoint.method} response`)
        }
      }
      const authRejected = res.status === 401 || res.status === 403
      const detail = await failureDetail(res)
      if (attempt === 1 || !authRejected || !this.deps.invalidateLease) {
        throw new Error(`GitLab ${endpoint.method} failed with ${res.status}${detail}`)
      }
      this.deps.invalidateLease(target, current.token)
      current = await this.deps.lease(target)
      this.enforce(current, endpoint)
    }
    throw new Error(`GitLab ${endpoint.method} failed`)
  }

  private remember(sessionKey: string, noteId: string | undefined): void {
    if (!noteId) return
    let notes = this.authored.get(sessionKey)
    if (!notes) {
      if (this.authored.size >= MAX_LEDGER_SESSIONS) {
        const oldest = this.authored.keys().next().value
        if (oldest !== undefined) this.authored.delete(oldest)
      }
      notes = new Set<string>()
      this.authored.set(sessionKey, notes)
    }
    if (notes.size >= MAX_LEDGER_NOTES) {
      const oldest = notes.values().next().value
      if (oldest !== undefined) notes.delete(oldest)
    }
    notes.add(noteId)
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

function branch(value: string, label: string): string {
  if (!BRANCH_NAME.test(value)) throw new Error(`${label} must be a branch name`)
  return value
}

function requireArg(value: string | undefined, label: string, scope: string): string {
  if (value === undefined) throw new Error(`${label} is required for ${scope}`)
  return requireDecimal(value, label)
}

/** Fill an allowlisted template; an unresolved placeholder is a bug, never a passthrough path. */
function renderPath(template: string, params: Record<string, string>): string {
  return template
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) return segment
      const value = params[segment.slice(1)]
      if (value === undefined) throw new Error(`broker path parameter ${segment.slice(1)} is missing`)
      return encodeURIComponent(value)
    })
    .join('/')
}

/** A bounded, single-line hint from GitLab's error body — never the request or the token. */
async function failureDetail(res: Response): Promise<string> {
  try {
    const raw = await res.text()
    const parsed = JSON.parse(raw) as { message?: unknown; error?: unknown }
    const message = typeof parsed.message === 'string' ? parsed.message : parsed.error
    if (typeof message !== 'string' || !message.trim()) return ''
    return `: ${message.replace(/\s+/g, ' ').slice(0, MAX_ERROR_CHARS)}`
  } catch {
    return ''
  }
}
