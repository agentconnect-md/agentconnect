// Gitea structured mutation broker (gitea-integration.md §10.2): allowlisted non-review effects under the `gitea_effect` lease, never an arbitrary path or body.
import {
  AuthoredCommentLedger,
  bool,
  branch,
  BROKER_MERGE_METHODS,
  brokerCall,
  changeLists,
  compact,
  enforceCapability,
  idOf,
  int,
  labelNames,
  limited,
  MAX_LIST_ITEMS,
  MAX_NOTE_BODY_CHARS,
  record,
  renderPath,
  requireDecimal,
  str,
  usernames,
  type BrokerChanges,
  type BrokerEndpoint,
  type BrokerLease,
  type CodeHostBrokerOperation,
  type CodeHostEffectBroker,
  type CodeHostEffectTarget
} from '../codehost/broker.js'
import { giteaRepoSegments } from './api.js'

/** THE allowlist: every call renders one of these templates. Issues and pull requests share one index space and one comments path. */
export const GITEA_BROKER_ENDPOINTS = {
  'issue.get': { method: 'GET', capability: 'read', path: '/repos/:owner/:repo/issues/:index' },
  'pull.get': { method: 'GET', capability: 'read', path: '/repos/:owner/:repo/pulls/:index' },
  'comment.list': { method: 'GET', capability: 'read', path: '/repos/:owner/:repo/issues/:index/comments' },
  'comment.get': { method: 'GET', capability: 'read', path: '/repos/:owner/:repo/issues/comments/:commentId' },
  'review.list': { method: 'GET', capability: 'read', path: '/repos/:owner/:repo/pulls/:index/reviews' },
  'status.list': { method: 'GET', capability: 'read', path: '/repos/:owner/:repo/commits/:ref/statuses' },
  'label.list': { method: 'GET', capability: 'read', path: '/repos/:owner/:repo/labels' },
  // An organization's labels apply to its repositories too; a user-owned repository's owner answers 404.
  'org.label.list': { method: 'GET', capability: 'read', path: '/orgs/:owner/labels' },
  'comment.create': { method: 'POST', capability: 'comment', path: '/repos/:owner/:repo/issues/:index/comments' },
  'comment.update': { method: 'PATCH', capability: 'comment', path: '/repos/:owner/:repo/issues/comments/:commentId' },
  'pull.create': { method: 'POST', capability: 'write', path: '/repos/:owner/:repo/pulls' },
  'pull.update': { method: 'PATCH', capability: 'write', path: '/repos/:owner/:repo/pulls/:index' },
  'pull.merge': { method: 'POST', capability: 'write', path: '/repos/:owner/:repo/pulls/:index/merge' },
  'pull.reviewers.request': {
    method: 'POST',
    capability: 'write',
    path: '/repos/:owner/:repo/pulls/:index/requested_reviewers'
  },
  'issue.create': { method: 'POST', capability: 'write', path: '/repos/:owner/:repo/issues' },
  'issue.update': { method: 'PATCH', capability: 'write', path: '/repos/:owner/:repo/issues/:index' },
  'issue.labels.add': { method: 'POST', capability: 'write', path: '/repos/:owner/:repo/issues/:index/labels' },
  'issue.label.remove': { method: 'DELETE', capability: 'write', path: '/repos/:owner/:repo/issues/:index/labels/:id' }
} as const satisfies Record<string, BrokerEndpoint>

export type GiteaBrokerEndpointId = keyof typeof GITEA_BROKER_ENDPOINTS

export interface GiteaBrokerDeps {
  /** Action-time effect lease (purpose `gitea_effect`); refuses when the CP lacks the feature. */
  lease: (target: CodeHostEffectTarget) => Promise<BrokerLease>
  /** Drop a cached lease Gitea just rejected (401/403) so the single retry re-mints. */
  invalidateLease?: (target: CodeHostEffectTarget, token: string) => void
  /** The instance's `/api/v1` root for THIS target's agent, resolved per turn (§11). */
  apiBaseUrl: (target: CodeHostEffectTarget) => string
  fetchImpl?: typeof fetch
}

const MAX_LABELS = 20

function userLogin(raw: unknown): string | undefined {
  return str(record(raw).login, 100)
}

function commentResult(raw: unknown): Record<string, unknown> {
  const comment = record(raw)
  return compact({
    id: idOf(comment.id),
    body: str(comment.body, MAX_NOTE_BODY_CHARS),
    author: userLogin(comment.user),
    htmlUrl: str(comment.html_url, 500),
    createdAt: str(comment.created_at, 40),
    updatedAt: str(comment.updated_at, 40)
  })
}

function subjectFields(subject: Record<string, unknown>): Record<string, unknown> {
  const labels = Array.isArray(subject.labels) ? subject.labels.slice(0, MAX_LABELS) : []
  return {
    id: idOf(subject.id),
    number: int(subject.number),
    title: str(subject.title, 500),
    state: str(subject.state, 40),
    author: userLogin(subject.user),
    labels: labels.map((label) => str(record(label).name, 100)).filter((name) => name !== undefined),
    htmlUrl: str(subject.html_url, 500),
    createdAt: str(subject.created_at, 40),
    updatedAt: str(subject.updated_at, 40)
  }
}

function issueResult(raw: unknown): Record<string, unknown> {
  return compact(subjectFields(record(raw)))
}

function pullResult(raw: unknown): Record<string, unknown> {
  const pull = record(raw)
  return compact({
    ...subjectFields(pull),
    draft: bool(pull.draft),
    merged: bool(pull.merged),
    mergeable: bool(pull.mergeable),
    head: str(record(pull.head).ref, 255),
    headSha: str(record(pull.head).sha, 64),
    base: str(record(pull.base).ref, 255)
  })
}

function reviewResult(raw: unknown): Record<string, unknown> {
  const review = record(raw)
  return compact({
    id: idOf(review.id),
    state: str(review.state, 40),
    body: str(review.body, MAX_NOTE_BODY_CHARS),
    author: userLogin(review.user),
    commitId: str(review.commit_id, 64),
    commentsCount: int(review.comments_count),
    htmlUrl: str(review.html_url, 500),
    submittedAt: str(review.submitted_at, 40)
  })
}

function statusResult(raw: unknown): Record<string, unknown> {
  const status = record(raw)
  return compact({
    id: idOf(status.id),
    state: str(status.status, 40),
    context: str(status.context, 255),
    description: str(status.description, 500),
    targetUrl: str(status.target_url, 500),
    createdAt: str(status.created_at, 40)
  })
}

function list(parsed: unknown, shape: (raw: unknown) => Record<string, unknown>): Record<string, unknown>[] {
  return (Array.isArray(parsed) ? parsed.slice(0, MAX_LIST_ITEMS) : []).map(shape)
}

/** One allowlisted call of a plan: the endpoint, its rendered path params, and the bounded payload. */
interface PlannedCall {
  endpoint: GiteaBrokerEndpointId
  params: Record<string, string>
  query?: Record<string, string>
  body?: Record<string, unknown>
  missingOk?: boolean
}

/** Issues one call of a running plan. */
type Caller = (call: PlannedCall) => Promise<unknown>

/** One resolved operation: every endpoint it may use, clamp-checked before its first request, and the run issuing them. */
interface BrokerPlan {
  uses: GiteaBrokerEndpointId[]
  run: (call: Caller) => Promise<unknown>
}

/** A plan whose calls do not depend on earlier answers, projected onto bounded structured data. */
function fixed(calls: PlannedCall[], shape: (results: unknown[]) => unknown): BrokerPlan {
  return {
    uses: calls.map((call) => call.endpoint),
    run: async (call) => {
      const results: unknown[] = []
      for (const planned of calls) results.push(await call(planned))
      return shape(results)
    }
  }
}

function using(...ids: (GiteaBrokerEndpointId | false)[]): GiteaBrokerEndpointId[] {
  return ids.filter((id): id is GiteaBrokerEndpointId => id !== false)
}

interface RepoParams {
  owner: string
  repo: string
}

const LABEL_PAGE = 50
const MAX_LABEL_PAGES = 5

function optionalLabels(values: string[] | undefined): string[] | undefined {
  return values === undefined ? undefined : labelNames(values)
}

/** Only a non-empty label set needs the name-to-id lookup, over the repository's labels and then its organization's. */
function lookup(labels: string[] | undefined): GiteaBrokerEndpointId[] {
  return labels !== undefined && labels.length > 0 ? ['label.list', 'org.label.list'] : []
}

/** Page one label list into `byName` until every name is found; true when the list ran out before the page cap. */
async function pageLabels(
  call: Caller,
  planned: Omit<PlannedCall, 'query'>,
  names: string[],
  byName: Map<string, number>
): Promise<boolean> {
  for (let page = 1; page <= MAX_LABEL_PAGES && !names.every((name) => byName.has(name)); page += 1) {
    const listed = await call({ ...planned, query: { limit: String(LABEL_PAGE), page: String(page) } })
    const entries = Array.isArray(listed) ? listed : []
    for (const entry of entries) {
      const name = str(record(entry).name, 255)
      const id = int(record(entry).id)
      if (name !== undefined && id !== undefined && id > 0 && !byName.has(name)) byName.set(name, id)
    }
    if (entries.length < LABEL_PAGE) return true
  }
  return names.every((name) => byName.has(name))
}

interface FoundLabels {
  byName: Map<string, number>
  /** False when the page cap, not the lists' end, stopped the search. */
  complete: boolean
}

/** Gitea writes labels by id: page the repository's labels, then its organization's, until every name is found. */
async function findLabels(call: Caller, at: RepoParams, names: string[]): Promise<FoundLabels> {
  const byName = new Map<string, number>()
  let complete = await pageLabels(call, { endpoint: 'label.list', params: { ...at } }, names, byName)
  if (!names.every((name) => byName.has(name))) {
    const org = { endpoint: 'org.label.list' as const, params: { owner: at.owner }, missingOk: true }
    complete = (await pageLabels(call, org, names, byName)) && complete
  }
  return { byName, complete }
}

/** Refuse, before any write, a name neither the repository nor its organization has. */
function refuseMissing(names: string[], found: FoundLabels): void {
  const missing = names.filter((name) => !found.byName.has(name))
  if (missing.length === 0) return
  const scope = found.complete ? '' : ` among its first ${LABEL_PAGE * MAX_LABEL_PAGES} labels`
  const named = missing.map((name) => JSON.stringify(name)).join(', ')
  throw new Error(`the Gitea repository and its organization have no label named ${named}${scope}`)
}

function idsOf(names: string[], found: FoundLabels): number[] {
  return [...new Set(names.flatMap((name) => found.byName.get(name) ?? []))]
}

async function labelIds(call: Caller, at: RepoParams, names: string[] | undefined): Promise<number[] | undefined> {
  if (names === undefined || names.length === 0) return names && []
  const found = await findLabels(call, at, names)
  refuseMissing(names, found)
  return idsOf(names, found)
}

/** The usernames assigned on an issue or pull request as Gitea answered it. */
function assigneeLogins(raw: unknown): string[] {
  const assignees = record(raw).assignees
  return (Array.isArray(assignees) ? assignees : []).flatMap((user) => userLogin(user) ?? [])
}

/** One update of an issue or pull request; both share the issue label paths, and each has its own edit and read. */
interface ChangeUpdate {
  at: RepoParams
  index: string
  changes: Required<BrokerChanges>
  fields: Record<string, unknown>
  edit: 'issue.update' | 'pull.update'
  read: 'issue.get' | 'pull.get'
  reviewers: string[]
  shape: (raw: unknown) => unknown
}

/** Label and assignee changes as adds and removes; Gitea's edit only replaces assignees, so they are read, merged, and sent whole. */
function changeUpdate(update: ChangeUpdate): BrokerPlan {
  const { at, changes, fields, reviewers } = update
  const params = { ...at, index: update.index }
  const labelNamesUsed = [...changes.addLabels, ...changes.removeLabels]
  const assigning = changes.addAssignees.length > 0 || changes.removeAssignees.length > 0
  // The edit carries the fields and the merged assignees; label changes go first so its answer shows them.
  const edits = Object.keys(fields).length > 0 || assigning
  if (!edits && labelNamesUsed.length === 0 && reviewers.length === 0) throw new Error('nothing to update')
  return {
    uses: using(
      ...lookup(labelNamesUsed),
      assigning && update.read,
      changes.addLabels.length > 0 && 'issue.labels.add',
      changes.removeLabels.length > 0 && 'issue.label.remove',
      edits && update.edit,
      reviewers.length > 0 && 'pull.reviewers.request',
      !edits && update.read
    ),
    run: async (call) => {
      const found = labelNamesUsed.length > 0 ? await findLabels(call, at, labelNamesUsed) : undefined
      let removeIds: number[] = []
      if (found) {
        refuseMissing(changes.addLabels, found)
        // A removal name no label has is already absent, unless the page cap hid it.
        if (!found.complete) refuseMissing(changes.removeLabels, found)
        removeIds = idsOf(changes.removeLabels, found)
      }
      const current = assigning ? assigneeLogins(await call({ endpoint: update.read, params })) : []
      const assignees = [...new Set([...current, ...changes.addAssignees])].filter(
        (login) => !changes.removeAssignees.includes(login)
      )
      if (found && changes.addLabels.length > 0) {
        await call({ endpoint: 'issue.labels.add', params, body: { labels: idsOf(changes.addLabels, found) } })
      }
      for (const id of removeIds) {
        await call({ endpoint: 'issue.label.remove', params: { ...params, id: String(id) }, missingOk: true })
      }
      const edited = edits
        ? await call({ endpoint: update.edit, params, body: { ...fields, ...(assigning ? { assignees } : {}) } })
        : undefined
      await requestReviewers(call, at, update.index, reviewers)
      return update.shape(edits ? edited : await call({ endpoint: update.read, params }))
    }
  }
}

/** Gitea requests reviews on a pull request that already exists; requesting adds, never replaces. */
async function requestReviewers(call: Caller, at: RepoParams, index: string, reviewers: string[]): Promise<void> {
  if (reviewers.length === 0) return
  await call({ endpoint: 'pull.reviewers.request', params: { ...at, index }, body: { reviewers } })
}

/** A full commit sha for the merge's head fence; a short one would only read as a stale head. */
function headSha(value: string): string {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value)) throw new Error('sha must be a full commit sha')
  return value
}

/** Gitea's work-in-progress prefixes, plus the draft forms a person may have typed, case-insensitively. */
const DRAFT_MARKER = /^\s*(?:\[\s*(?:draft|wip)\s*\]|\(\s*(?:draft|wip)\s*\)|(?:draft|wip)\s*:)\s*/i

/** Draft state is a `WIP:` title prefix on Gitea, so the bounded `draft` flag normalizes the title both ways. */
function draftTitle(title: string, draft: boolean | undefined): string {
  if (draft === undefined) return title
  let bare = title
  while (DRAFT_MARKER.test(bare)) bare = bare.replace(DRAFT_MARKER, '')
  return (draft ? `WIP: ${bare.trim()}` : bare).trim()
}

/** A commit ref for the statuses path: a branch name or a hex sha, never a traversal. */
function commitRef(value: string): string {
  return /^[0-9a-f]{7,64}$/i.test(value) ? value : branch(value, 'ref')
}

export class GiteaBroker implements CodeHostEffectBroker {
  private readonly authored = new AuthoredCommentLedger()

  constructor(private readonly deps: GiteaBrokerDeps) {}

  async execute(target: CodeHostEffectTarget, op: CodeHostBrokerOperation): Promise<unknown> {
    const plan = this.plan(target, op)
    const lease = await this.deps.lease(target)
    for (const id of plan.uses) this.enforce(lease, GITEA_BROKER_ENDPOINTS[id])
    return plan.run(async (call) => {
      if (!plan.uses.includes(call.endpoint)) throw new Error(`broker plan used undeclared endpoint ${call.endpoint}`)
      return this.call(target, call, lease)
    })
  }

  private enforce(lease: BrokerLease, endpoint: BrokerEndpoint): void {
    enforceCapability(lease, endpoint, 'Gitea repository')
  }

  private plan(target: CodeHostEffectTarget, op: CodeHostBrokerOperation): BrokerPlan {
    const { owner, repo } = giteaRepoSegments(target.repoPath ?? '')
    const at: RepoParams = { owner, repo }
    switch (op.kind) {
      case 'readMergeRequestDescription': {
        return {
          uses: ['pull.get'],
          run: async (call) =>
            record(await call({ endpoint: 'pull.get', params: { ...at, index: String(op.iid) } })).body ?? ''
        }
      }
      case 'createComment': {
        const scope = { sessionKey: target.sessionKey, repo: target.repoId }
        return {
          uses: ['comment.create'],
          run: async (call) => {
            const created = await call({
              endpoint: 'comment.create',
              params: { ...at, index: String(op.iid) },
              body: { body: op.body }
            })
            // The single-writer ledger: `updateComment` may touch only what this session created.
            this.authored.remember(scope, idOf(record(created).id))
            return { comment: commentResult(created) }
          }
        }
      }
      case 'updateComment': {
        const commentId = requireDecimal(op.noteId, 'noteId')
        if (!this.authored.has({ sessionKey: target.sessionKey, repo: target.repoId }, commentId)) {
          throw new Error('only a comment this session created through the broker can be updated')
        }
        return fixed(
          [{ endpoint: 'comment.update', params: { ...at, commentId }, body: { body: op.body } }],
          ([updated]) => ({
            comment: commentResult(updated)
          })
        )
      }
      case 'readDiscussions': {
        if (op.discussionId !== undefined) {
          // Gitea has no discussion objects: the id names one comment.
          return fixed(
            [
              { endpoint: 'comment.get', params: { ...at, commentId: requireDecimal(op.discussionId, 'discussionId') } }
            ],
            ([comment]) => ({ comment: commentResult(comment) })
          )
        }
        const index = String(op.iid)
        const query = { limit: limited(op.limit) }
        if (op.subject === 'issue') {
          return fixed(
            [
              { endpoint: 'issue.get', params: { ...at, index } },
              { endpoint: 'comment.list', params: { ...at, index }, query }
            ],
            ([issue, comments]) => ({ issue: issueResult(issue), comments: list(comments, commentResult) })
          )
        }
        return fixed(
          [
            { endpoint: 'pull.get', params: { ...at, index } },
            { endpoint: 'comment.list', params: { ...at, index }, query },
            { endpoint: 'review.list', params: { ...at, index }, query }
          ],
          ([pull, comments, reviews]) => ({
            pullRequest: pullResult(pull),
            comments: list(comments, commentResult),
            reviews: list(reviews, reviewResult)
          })
        )
      }
      case 'replyDiscussion':
        throw new Error('Gitea comments are not threaded: post a new comment with giteaComment instead')
      case 'createMergeRequest': {
        const labels = optionalLabels(op.labels)
        const reviewers = usernames(op.reviewers ?? [], 'reviewers')
        const fields = compact({
          head: branch(op.sourceBranch, 'sourceBranch'),
          base: branch(op.targetBranch, 'targetBranch'),
          title: draftTitle(op.title, op.draft),
          body: op.description,
          assignees: op.assignees === undefined ? undefined : usernames(op.assignees, 'assignees')
        })
        return {
          uses: using(...lookup(labels), 'pull.create', reviewers.length > 0 && 'pull.reviewers.request'),
          run: async (call) => {
            const ids = await labelIds(call, at, labels)
            const created = await call({
              endpoint: 'pull.create',
              params: { ...at },
              body: compact({ ...fields, labels: ids })
            })
            if (reviewers.length > 0) {
              const index = int(record(created).number)
              if (index === undefined)
                throw new Error('Gitea created the pull request but returned no number to request reviews on')
              await requestReviewers(call, at, String(index), reviewers)
            }
            return { pullRequest: pullResult(created) }
          }
        }
      }
      case 'updateMergeRequest':
        return changeUpdate({
          at,
          index: String(op.iid),
          changes: changeLists(op),
          fields: compact({
            ...(op.title !== undefined ? { title: draftTitle(op.title, op.draft) } : {}),
            body: op.description,
            base: op.targetBranch === undefined ? undefined : branch(op.targetBranch, 'targetBranch')
          }),
          edit: 'pull.update',
          read: 'pull.get',
          reviewers: usernames(op.reviewers ?? [], 'reviewers'),
          shape: (pull) => ({ pullRequest: pullResult(pull) })
        })
      case 'mergeMergeRequest': {
        if (op.method !== undefined && !BROKER_MERGE_METHODS.includes(op.method)) {
          throw new Error(`method must be one of ${BROKER_MERGE_METHODS.join(', ')}`)
        }
        const params = { ...at, index: String(op.iid) }
        const body = compact({
          Do: op.method ?? 'merge',
          head_commit_id: op.sha === undefined ? undefined : headSha(op.sha)
        })
        // Gitea answers a merge with an empty body, so the merged pull request is read back.
        return fixed(
          [
            { endpoint: 'pull.merge', params, body },
            { endpoint: 'pull.get', params }
          ],
          ([, merged]) => ({ pullRequest: pullResult(merged) })
        )
      }
      case 'setState': {
        if (op.state !== 'open' && op.state !== 'closed') throw new Error('state must be open or closed')
        const params = { ...at, index: String(op.iid) }
        if (op.subject === 'issue') {
          return fixed([{ endpoint: 'issue.update', params, body: { state: op.state } }], ([issue]) => ({
            issue: issueResult(issue)
          }))
        }
        return fixed([{ endpoint: 'pull.update', params, body: { state: op.state } }], ([pull]) => ({
          pullRequest: pullResult(pull)
        }))
      }
      case 'createIssue': {
        const labels = optionalLabels(op.labels)
        const fields = compact({
          title: op.title,
          body: op.description,
          assignees: op.assignees === undefined ? undefined : usernames(op.assignees, 'assignees')
        })
        return {
          uses: using(...lookup(labels), 'issue.create'),
          run: async (call) => {
            const ids = await labelIds(call, at, labels)
            const created = await call({
              endpoint: 'issue.create',
              params: { ...at },
              body: compact({ ...fields, labels: ids })
            })
            return { issue: issueResult(created) }
          }
        }
      }
      case 'updateIssue':
        return changeUpdate({
          at,
          index: String(op.iid),
          changes: changeLists(op),
          fields: compact({ title: op.title, body: op.description }),
          edit: 'issue.update',
          read: 'issue.get',
          reviewers: [],
          shape: (issue) => ({ issue: issueResult(issue) })
        })
      case 'inspectPipelines': {
        // Gitea's run state is a commit status (§10.4); the other scopes name pipeline objects it has none of.
        if (op.scope !== 'pipelines' || op.ref === undefined) {
          throw new Error('Gitea exposes commit statuses only: use scope "pipelines" with the ref to read them')
        }
        const status = op.status
        return fixed(
          [{ endpoint: 'status.list', params: { ...at, ref: commitRef(op.ref) }, query: { limit: limited(op.limit) } }],
          ([statuses]) => ({
            statuses: list(statuses, statusResult).filter((entry) => status === undefined || entry.state === status)
          })
        )
      }
      case 'controlPipeline':
        throw new Error('Gitea commit statuses cannot be retried or cancelled through this broker')
    }
  }

  /** Issue one allowlisted request; retry once, and only after a definite auth rejection. */
  private call(target: CodeHostEffectTarget, call: PlannedCall, lease: BrokerLease): Promise<unknown> {
    const endpoint = GITEA_BROKER_ENDPOINTS[call.endpoint]
    const search = new URLSearchParams(call.query ?? {}).toString()
    const path = renderPath(endpoint.path, call.params)
    return brokerCall(
      {
        headers: (token) => ({ authorization: `token ${token}`, accept: 'application/json' }),
        lease: () => this.deps.lease(target),
        ...(this.deps.invalidateLease
          ? { invalidateLease: (token: string) => this.deps.invalidateLease!(target, token) }
          : {}),
        enforce: (fresh) => this.enforce(fresh, endpoint),
        host: 'Gitea',
        ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {})
      },
      lease,
      {
        method: endpoint.method,
        url: `${this.deps.apiBaseUrl(target)}${path}${search ? `?${search}` : ''}`,
        ...(call.body !== undefined ? { body: call.body } : {}),
        ...(call.missingOk ? { missingOk: true } : {})
      }
    )
  }
}
