// GitLab's half of the code-host effect broker (gitlab-com-integration.md §14.2): its allowlist and per-operation programs.
import {
  AuthoredCommentLedger,
  BrokerHttpError,
  bool,
  branch,
  brokerCall,
  changeLists,
  compact,
  enforceCapability,
  idOf,
  int,
  labelNames,
  limited,
  MAX_LIST_ITEMS,
  MAX_NAMED,
  MAX_NOTE_BODY_CHARS,
  record,
  renderPath,
  requireArg,
  requireDecimal,
  str,
  usernames,
  type BrokerChanges,
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
  'user.lookup': { method: 'GET', capability: 'read', path: '/users' },
  'mergeRequest.get': { method: 'GET', capability: 'read', path: '/projects/:project/merge_requests/:iid' },
  'mergeRequest.create': { method: 'POST', capability: 'write', path: '/projects/:project/merge_requests' },
  'mergeRequest.update': { method: 'PUT', capability: 'write', path: '/projects/:project/merge_requests/:iid' },
  'mergeRequest.merge': { method: 'PUT', capability: 'write', path: '/projects/:project/merge_requests/:iid/merge' },
  'mergeRequest.rebase': { method: 'PUT', capability: 'write', path: '/projects/:project/merge_requests/:iid/rebase' },
  'issue.get': { method: 'GET', capability: 'read', path: '/projects/:project/issues/:iid' },
  'issue.create': { method: 'POST', capability: 'write', path: '/projects/:project/issues' },
  'issue.update': { method: 'PUT', capability: 'write', path: '/projects/:project/issues/:iid' },
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
  /** Logical session key — with the project, it scopes the single-writer ledger for `updateComment`. */
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
  /** The wait between rebase polls and merge retries; injectable so tests do not sleep. */
  delay?: (ms: number) => Promise<void>
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

function issueResult(raw: unknown): Record<string, unknown> {
  const issue = record(raw)
  const labels = Array.isArray(issue.labels) ? issue.labels.slice(0, MAX_NAMED) : undefined
  return compact({
    id: idOf(issue.id),
    iid: int(issue.iid),
    title: str(issue.title, 500),
    state: str(issue.state, 40),
    labels: labels?.map((label) => str(label, 255)).filter((label) => label !== undefined),
    webUrl: str(issue.web_url, 500),
    createdAt: str(issue.created_at, 40),
    updatedAt: str(issue.updated_at, 40)
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

/** One allowlisted request: the endpoint, its rendered path params, and the bounded payload. */
interface BrokerStep {
  endpoint: BrokerEndpointId
  params: Record<string, string>
  query?: Record<string, string>
  body?: Record<string, unknown>
}

/** A single-request operation, with the projection of GitLab's answer onto bounded structured data. */
interface BrokerPlan extends BrokerStep {
  shape: (parsed: unknown) => unknown
}

type BrokerCaller = (step: BrokerStep) => Promise<unknown>

/** An operation's whole request sequence; every endpoint it may call is declared, so the clamp is checked up front. */
interface BrokerProgram {
  endpoints: readonly BrokerEndpointId[]
  run: (call: BrokerCaller) => Promise<unknown>
}

/** The program of a single-request operation; `after` sees GitLab's answer before it is shaped. */
function single(plan: BrokerPlan, after?: (parsed: unknown) => void): BrokerProgram {
  const { shape, ...step } = plan
  return {
    endpoints: [step.endpoint],
    run: async (call) => {
      const parsed = await call(step)
      after?.(parsed)
      return shape(parsed)
    }
  }
}

/** A user id as GitLab's integer arrays take it; an id past the safe range stays a decimal string. */
type GitlabUserId = number | string

function userId(id: string): GitlabUserId {
  const value = Number(id)
  return Number.isSafeInteger(value) ? value : id
}

/** Labels as GitLab takes them: one comma-joined string. */
function labelList(labels: readonly string[] | undefined): string | undefined {
  return labels === undefined ? undefined : labelNames(labels).join(',')
}

/** A non-empty label list as GitLab's `add_labels` / `remove_labels` take it. */
function labelDelta(labels: readonly string[]): string | undefined {
  return labels.length > 0 ? labels.join(',') : undefined
}

/** Resolve each distinct username with one exact lookup; a name GitLab does not know refuses the operation. */
async function resolveUsers(call: BrokerCaller, names: readonly string[]): Promise<Map<string, GitlabUserId>> {
  const ids = new Map<string, GitlabUserId>()
  for (const name of new Set(names)) {
    const found = await call({ endpoint: 'user.lookup', params: {}, query: { username: name } })
    // GitLab usernames are unique case-insensitively, so only that equality counts as the named user.
    const match = (Array.isArray(found) ? found : [])
      .map(record)
      .find((user) => typeof user.username === 'string' && user.username.toLowerCase() === name.toLowerCase())
    const id = idOf(match?.id)
    if (id === undefined) throw new Error(`GitLab has no user named ${name}`)
    ids.set(name, userId(id))
  }
  return ids
}

/** The ids of a subject's current assignees or reviewers, less any whose username is named for removal. */
function currentIds(people: unknown, without: readonly string[] = []): GitlabUserId[] {
  const drop = new Set(without.map((name) => name.toLowerCase()))
  return (Array.isArray(people) ? people : [])
    .map(record)
    .filter((person) => typeof person.username !== 'string' || !drop.has(person.username.toLowerCase()))
    .map((person) => idOf(person.id))
    .filter((id) => id !== undefined)
    .map(userId)
}

function uniqueIds(ids: readonly GitlabUserId[]): GitlabUserId[] {
  return ids.filter((id, index) => ids.findIndex((other) => String(other) === String(id)) === index)
}

/** The people a write names: initial assignees on a create, assignee changes on an update, and reviewers to request. */
interface PeopleNames {
  assignees?: string[]
  addAssignees?: string[]
  removeAssignees?: string[]
  reviewers?: string[]
}

/** A write that names people: look each one up, read the subject when its current people matter, then send the one write. */
function peopleWrite(plan: BrokerPlan, people: PeopleNames, current?: BrokerStep): BrokerProgram {
  const add = people.addAssignees ?? []
  const remove = people.removeAssignees ?? []
  const reviewers = people.reviewers ?? []
  const changesAssignees = add.length > 0 || remove.length > 0
  const names = [...(people.assignees ?? []), ...add, ...reviewers]
  const readsCurrent = current !== undefined && (changesAssignees || reviewers.length > 0)
  const { shape, ...write } = plan
  return {
    endpoints: [
      ...(names.length > 0 ? (['user.lookup'] as const) : []),
      ...(readsCurrent ? [current.endpoint] : []),
      write.endpoint
    ],
    run: async (call) => {
      const users = await resolveUsers(call, names)
      const ids = (list: readonly string[]) => list.map((name) => users.get(name)!)
      const subject = readsCurrent ? record(await call(current)) : {}
      const assigneeIds =
        people.assignees !== undefined
          ? ids(people.assignees)
          : changesAssignees
            ? uniqueIds([...currentIds(subject.assignees, remove), ...ids(add)])
            : undefined
      const reviewerIds =
        reviewers.length > 0 ? uniqueIds([...currentIds(subject.reviewers), ...ids(reviewers)]) : undefined
      const body = { ...write.body, ...compact({ assignee_ids: assigneeIds, reviewer_ids: reviewerIds }) }
      return shape(await call({ ...write, body }))
    }
  }
}

/** An update's label deltas, validated, with the assignee changes left for the people lookup. */
function updateChanges(op: BrokerChanges): { labels: Record<string, unknown>; people: PeopleNames } {
  const lists = changeLists(op)
  return {
    labels: compact({ add_labels: labelDelta(lists.addLabels), remove_labels: labelDelta(lists.removeLabels) }),
    people: { addAssignees: lists.addAssignees, removeAssignees: lists.removeAssignees }
  }
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

/** A full commit id, SHA-1 or SHA-256. */
const COMMIT_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i

/** The lease one execution holds; a re-mint after an auth rejection replaces it for the steps that follow. */
interface LeaseHolder {
  lease: GitlabBrokerLease
}

export class GitlabBroker {
  private readonly authored = new AuthoredCommentLedger()

  constructor(private readonly deps: GitlabBrokerDeps) {}

  async execute(target: GitlabBrokerTarget, op: GitlabBrokerOperation): Promise<unknown> {
    const program = this.program(target, op)
    const holder: LeaseHolder = { lease: await this.deps.lease(target) }
    this.enforceAll(holder.lease, program)
    return program.run((step) => {
      if (!program.endpoints.includes(step.endpoint))
        throw new Error(`broker endpoint ${step.endpoint} was not declared by this operation`)
      return this.call(target, step, program, holder)
    })
  }

  /** Every endpoint the operation may use, the final write included, before its first request. */
  private enforceAll(lease: GitlabBrokerLease, program: BrokerProgram): void {
    for (const endpoint of program.endpoints)
      enforceCapability(lease, GITLAB_BROKER_ENDPOINTS[endpoint], 'GitLab project')
  }

  private remember(target: GitlabBrokerTarget): (parsed: unknown) => void {
    return (parsed) =>
      this.authored.remember({ sessionKey: target.sessionKey, repo: target.projectId }, idOf(record(parsed).id))
  }

  private program(target: GitlabBrokerTarget, op: GitlabBrokerOperation): BrokerProgram {
    const project = requireDecimal(target.projectId, 'project id')
    switch (op.kind) {
      case 'readMergeRequestDescription':
        return single({
          endpoint: 'mergeRequest.get',
          params: { project, iid: String(op.iid) },
          shape: (parsed) => record(parsed).description ?? ''
        })
      case 'createComment':
        return single(
          {
            endpoint: 'comment.create',
            params: { project, subject: SUBJECT_SEGMENT[op.subject], iid: String(op.iid) },
            body: { body: op.body },
            shape: (parsed) => ({ note: noteResult(parsed) })
          },
          this.remember(target)
        )
      case 'updateComment': {
        const noteId = requireDecimal(op.noteId, 'noteId')
        if (!this.authored.has({ sessionKey: target.sessionKey, repo: target.projectId }, noteId)) {
          throw new Error('only a comment this session created through the broker can be updated')
        }
        return single({
          endpoint: 'comment.update',
          params: { project, subject: SUBJECT_SEGMENT[op.subject], iid: String(op.iid), noteId },
          body: { body: op.body },
          shape: (parsed) => ({ note: noteResult(parsed) })
        })
      }
      case 'readDiscussions': {
        const base = { project, subject: SUBJECT_SEGMENT[op.subject], iid: String(op.iid) }
        if (op.discussionId === undefined) {
          return single({
            endpoint: 'discussion.list',
            params: base,
            query: { per_page: limited(op.limit) },
            shape: (parsed) => ({
              discussions: (Array.isArray(parsed) ? parsed.slice(0, MAX_LIST_ITEMS) : []).map(discussionResult)
            })
          })
        }
        return single({
          endpoint: 'discussion.get',
          params: { ...base, discussionId: discussionId(op.discussionId) },
          shape: (parsed) => ({ discussion: discussionResult(parsed) })
        })
      }
      case 'replyDiscussion':
        return single(
          {
            endpoint: 'discussion.reply',
            params: {
              project,
              subject: SUBJECT_SEGMENT[op.subject],
              iid: String(op.iid),
              discussionId: discussionId(op.discussionId)
            },
            body: { body: op.body },
            shape: (parsed) => ({ note: noteResult(parsed) })
          },
          this.remember(target)
        )
      case 'createMergeRequest':
        return peopleWrite(
          {
            endpoint: 'mergeRequest.create',
            params: { project },
            body: compact({
              source_branch: branch(op.sourceBranch, 'sourceBranch'),
              target_branch: branch(op.targetBranch, 'targetBranch'),
              title: draftTitle(op.title, op.draft),
              description: op.description,
              labels: labelList(op.labels)
            }),
            shape: (parsed) => ({ mergeRequest: mergeRequestResult(parsed) })
          },
          initialPeople(op)
        )
      case 'updateMergeRequest': {
        const params = { project, iid: String(op.iid) }
        const changes = updateChanges(op)
        return peopleWrite(
          {
            endpoint: 'mergeRequest.update',
            params,
            body: compact({
              ...(op.title !== undefined ? { title: draftTitle(op.title, op.draft) } : {}),
              description: op.description,
              target_branch: op.targetBranch === undefined ? undefined : branch(op.targetBranch, 'targetBranch'),
              ...changes.labels
            }),
            shape: (parsed) => ({ mergeRequest: mergeRequestResult(parsed) })
          },
          { ...changes.people, reviewers: usernames(op.reviewers ?? [], 'reviewers') },
          { endpoint: 'mergeRequest.get', params }
        )
      }
      case 'mergeMergeRequest':
        return mergeProgram(project, op, this.deps.delay ?? sleep)
      case 'setState':
        return single(planSetState(project, op))
      case 'createIssue':
        return peopleWrite(
          {
            endpoint: 'issue.create',
            params: { project },
            body: compact({ title: op.title, description: op.description, labels: labelList(op.labels) }),
            shape: (parsed) => ({ issue: issueResult(parsed) })
          },
          initialPeople(op)
        )
      case 'updateIssue': {
        const params = { project, iid: String(op.iid) }
        const changes = updateChanges(op)
        return peopleWrite(
          {
            endpoint: 'issue.update',
            params,
            body: compact({ title: op.title, description: op.description, ...changes.labels }),
            shape: (parsed) => ({ issue: issueResult(parsed) })
          },
          changes.people,
          { endpoint: 'issue.get', params }
        )
      }
      case 'inspectPipelines':
        return single(planInspect(project, op))
      case 'controlPipeline':
        return single(planControl(project, op))
    }
  }

  /** Issue one allowlisted request; retry once, and only after a definite auth rejection. */
  private call(
    target: GitlabBrokerTarget,
    step: BrokerStep,
    program: BrokerProgram,
    holder: LeaseHolder
  ): Promise<unknown> {
    const endpoint = GITLAB_BROKER_ENDPOINTS[step.endpoint]
    const search = new URLSearchParams(step.query ?? {}).toString()
    const path = renderPath(endpoint.path, step.params)
    return brokerCall(
      {
        headers: (token) => ({ 'private-token': token }),
        lease: async () => (holder.lease = await this.deps.lease(target)),
        ...(this.deps.invalidateLease
          ? { invalidateLease: (token: string) => this.deps.invalidateLease!(target, token) }
          : {}),
        enforce: (fresh) => this.enforceAll(fresh, program),
        host: 'GitLab',
        ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {})
      },
      holder.lease,
      {
        method: endpoint.method,
        url: `${this.deps.apiBaseUrl(target)}${path}${search ? `?${search}` : ''}`,
        ...(step.body !== undefined ? { body: step.body } : {})
      }
    )
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** A create's initial people, validated before any lease or request. */
function initialPeople(op: { assignees?: string[]; reviewers?: string[] }): PeopleNames {
  return {
    ...(op.assignees !== undefined ? { assignees: usernames(op.assignees, 'assignees') } : {}),
    ...(op.reviewers !== undefined ? { reviewers: usernames(op.reviewers, 'reviewers') } : {})
  }
}

/** Rebase progress is polled this many times, this far apart, before the merge gives up. */
const REBASE_POLLS = 30
const REBASE_POLL_MS = 1000
/** Right after a rebase GitLab can briefly answer the merge with 406; it is retried this many times, this far apart. */
const MERGE_ATTEMPTS = 3
const MERGE_RETRY_MS = 6000

/** The status of the merge request's latest pipeline, when it has one. */
function pipelineStatus(mr: Record<string, unknown>): string | undefined {
  return str(record(mr.head_pipeline).status, 40) ?? str(record(mr.pipeline).status, 40)
}

/** Whether the answer says the merge request merged now or will merge when its pipeline passes. */
function mergeOutcome(raw: unknown): string | undefined {
  const mr = record(raw)
  if (mr.state === 'merged') return 'merged'
  if (mr.merge_when_pipeline_succeeds === true || mr.auto_merge === true) return 'merges_when_pipeline_succeeds'
  return undefined
}

/** Merge as `glab mr merge` does: refuse a failed pipeline, rebase first when asked, and auto-merge behind a pipeline. */
function mergeProgram(
  project: string,
  op: Extract<GitlabBrokerOperation, { kind: 'mergeMergeRequest' }>,
  delay: (ms: number) => Promise<void>
): BrokerProgram {
  const rebase = op.method === 'rebase'
  if (op.sha !== undefined && !COMMIT_SHA.test(op.sha)) throw new Error('sha must be a full commit id')
  if (rebase && op.sha !== undefined)
    throw new Error('sha cannot be combined with rebase, because the rebase replaces the head')
  const params = { project, iid: String(op.iid) }
  return {
    endpoints: ['mergeRequest.get', ...(rebase ? (['mergeRequest.rebase'] as const) : []), 'mergeRequest.merge'],
    run: async (call) => {
      const before = record(await call({ endpoint: 'mergeRequest.get', params }))
      const status = pipelineStatus(before)
      if (status === 'failed' || status === 'canceled')
        throw new Error(`the merge request's pipeline is ${status}; fix or rerun it before merging`)
      let after: Record<string, unknown> = {}
      if (rebase) {
        await call({ endpoint: 'mergeRequest.rebase', params })
        after = await pollRebase(call, params, delay)
      }
      const autoMerge = status !== undefined || pipelineStatus(after) !== undefined
      const body = compact({
        squash: op.method === 'squash' ? true : undefined,
        sha: op.sha,
        auto_merge: autoMerge ? true : undefined
      })
      const parsed = await mergeWithRetry(call, { endpoint: 'mergeRequest.merge', params, body }, rebase, delay)
      return compact({ mergeRequest: mergeRequestResult(parsed), outcome: mergeOutcome(parsed) })
    }
  }
}

/** Poll until GitLab finishes the rebase; a recorded merge error refuses the merge. */
async function pollRebase(
  call: BrokerCaller,
  params: Record<string, string>,
  delay: (ms: number) => Promise<void>
): Promise<Record<string, unknown>> {
  for (let poll = 0; poll < REBASE_POLLS; poll += 1) {
    if (poll > 0) await delay(REBASE_POLL_MS)
    const mr = record(
      await call({ endpoint: 'mergeRequest.get', params, query: { include_rebase_in_progress: 'true' } })
    )
    if (mr.rebase_in_progress === true) continue
    const error = str(mr.merge_error, 200)
    if (error !== undefined) throw new Error(`GitLab could not rebase the merge request: ${error.replace(/\s+/g, ' ')}`)
    return mr
  }
  throw new Error('GitLab is still rebasing the merge request; merge it again shortly')
}

/** Send the merge; after a rebase, retry a 406 a bounded number of times. */
async function mergeWithRetry(
  call: BrokerCaller,
  step: BrokerStep,
  rebased: boolean,
  delay: (ms: number) => Promise<void>
): Promise<unknown> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call(step)
    } catch (error) {
      const notYet = error instanceof BrokerHttpError && error.status === 406
      if (!rebased || !notYet || attempt >= MERGE_ATTEMPTS) throw error
      await delay(MERGE_RETRY_MS)
    }
  }
}

function planSetState(project: string, op: Extract<GitlabBrokerOperation, { kind: 'setState' }>): BrokerPlan {
  const params = { project, iid: String(op.iid) }
  const body = { state_event: op.state === 'closed' ? 'close' : 'reopen' }
  if (op.subject === 'issue')
    return { endpoint: 'issue.update', params, body, shape: (parsed) => ({ issue: issueResult(parsed) }) }
  return {
    endpoint: 'mergeRequest.update',
    params,
    body,
    shape: (parsed) => ({ mergeRequest: mergeRequestResult(parsed) })
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
