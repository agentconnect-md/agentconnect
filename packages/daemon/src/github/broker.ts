// GitHub's structured broker (github-app-git-credentials.md, Daemon-Mediated Agent Access): pull requests, issues, and the comments on them.
import {
  AuthoredCommentLedger,
  BrokerHttpError,
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
  MAX_NAMED,
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
import { GITHUB_API_BASE, githubApiHeaders } from './rest.js'

/** THE allowlist: every call renders one of these templates; draft state moves only through GraphQL. */
export const GITHUB_BROKER_ENDPOINTS = {
  'pull.get': { method: 'GET', capability: 'read', path: '/repos/:owner/:repo/pulls/:number' },
  'pull.create': { method: 'POST', capability: 'write', path: '/repos/:owner/:repo/pulls' },
  'pull.update': { method: 'PATCH', capability: 'write', path: '/repos/:owner/:repo/pulls/:number' },
  'pull.merge': { method: 'PUT', capability: 'write', path: '/repos/:owner/:repo/pulls/:number/merge' },
  'reviewers.request': {
    method: 'POST',
    capability: 'write',
    path: '/repos/:owner/:repo/pulls/:number/requested_reviewers'
  },
  'draft.set': { method: 'POST', capability: 'write', path: '/graphql' },
  // A pull request is an issue too, so its labels, assignees and comments move through the issue endpoints.
  'issue.get': { method: 'GET', capability: 'read', path: '/repos/:owner/:repo/issues/:number' },
  'issue.create': { method: 'POST', capability: 'write', path: '/repos/:owner/:repo/issues' },
  'issue.update': { method: 'PATCH', capability: 'write', path: '/repos/:owner/:repo/issues/:number' },
  'labels.add': { method: 'POST', capability: 'write', path: '/repos/:owner/:repo/issues/:number/labels' },
  'label.remove': { method: 'DELETE', capability: 'write', path: '/repos/:owner/:repo/issues/:number/labels/:name' },
  'assignees.add': { method: 'POST', capability: 'write', path: '/repos/:owner/:repo/issues/:number/assignees' },
  'assignees.remove': { method: 'DELETE', capability: 'write', path: '/repos/:owner/:repo/issues/:number/assignees' },
  'comment.create': { method: 'POST', capability: 'comment', path: '/repos/:owner/:repo/issues/:number/comments' },
  'comment.update': { method: 'PATCH', capability: 'comment', path: '/repos/:owner/:repo/issues/comments/:commentId' }
} as const satisfies Record<string, BrokerEndpoint>

type EndpointId = keyof typeof GITHUB_BROKER_ENDPOINTS

const TO_DRAFT =
  'mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { isDraft } } }'
const TO_READY =
  'mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }'

/** A commit sha the merge must match: hex only, never free text in the body. */
const COMMIT_SHA = /^[0-9a-f]{7,64}$/i

/** GitHub echoes a grant's contents level, so a comment-tier grant reads `read`; for a comment, the token's own issue and pull-request scopes decide. */
function enforceGithub(lease: BrokerLease, endpoint: BrokerEndpoint): void {
  const clamp =
    endpoint.capability === 'comment' && lease.access === 'read' ? { ...lease, access: 'comment' as const } : lease
  enforceCapability(clamp, endpoint, 'GitHub repository')
}

/** A read-tier token GitHub refuses a comment with gets the same answer the clamp gives elsewhere. */
async function commentScoped(request: Promise<unknown>): Promise<unknown> {
  try {
    return await request
  } catch (error) {
    if (error instanceof BrokerHttpError && error.status === 403)
      throw new Error(
        'this operation needs comment authority on the GitHub repository, but the current authorization grants read'
      )
    throw error
  }
}

export interface GithubBrokerDeps {
  /** The pull-request token for this target's repository, at the tier the agent's authorization earns. */
  lease: (target: CodeHostEffectTarget) => Promise<BrokerLease>
  /** Drop a cached token GitHub just rejected (401/403) so the single retry re-mints. */
  invalidateLease?: (target: CodeHostEffectTarget, token: string) => void
  baseUrl?: string
  fetchImpl?: typeof fetch
}

/** At most MAX_NAMED names from a list of labels (`name`) or users (`login`); undefined when the host sent no list. */
function names(value: unknown, key: 'name' | 'login'): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value
    .slice(0, MAX_NAMED)
    .map((entry) => str(record(entry)[key], 100))
    .filter((name) => name !== undefined)
}

/** The bounded view of a pull request the model reads back. */
function pullResult(raw: unknown): Record<string, unknown> {
  const pull = record(raw)
  return compact({
    number: int(pull.number),
    title: str(pull.title),
    state: str(pull.state, 50),
    draft: bool(pull.draft),
    htmlUrl: str(pull.html_url),
    sourceBranch: str(record(pull.head).ref),
    targetBranch: str(record(pull.base).ref),
    labels: names(pull.labels, 'name'),
    assignees: names(pull.assignees, 'login'),
    reviewers: names(pull.requested_reviewers, 'login')
  })
}

/** The bounded view of an issue the model reads back. */
function issueResult(raw: unknown): Record<string, unknown> {
  const issue = record(raw)
  return compact({
    number: int(issue.number),
    title: str(issue.title),
    state: str(issue.state, 50),
    htmlUrl: str(issue.html_url),
    labels: names(issue.labels, 'name')
  })
}

function commentResult(raw: unknown): Record<string, unknown> {
  const comment = record(raw)
  return compact({
    id: idOf(comment.id),
    body: str(comment.body, MAX_NOTE_BODY_CHARS),
    author: str(record(comment.user).login, 100),
    htmlUrl: str(comment.html_url),
    createdAt: str(comment.created_at, 40),
    updatedAt: str(comment.updated_at, 40)
  })
}

/** Copy only the lists a later answer actually carried, so an empty answer never erases what is known. */
function overlay(pull: Record<string, unknown>, answer: unknown, keys: readonly string[]): Record<string, unknown> {
  const fresh = record(answer)
  return { ...pull, ...Object.fromEntries(keys.filter((key) => Array.isArray(fresh[key])).map((k) => [k, fresh[k]])) }
}

/** A pull request or issue number for a path segment. */
function numberOf(iid: number): string {
  return requireDecimal(String(iid), 'iid')
}

/** The validated initial labels and assignees a create sets through the issue PATCH; empty when neither is named. */
function initialPeople(op: { labels?: string[]; assignees?: string[] }): Record<string, unknown> {
  return compact({
    labels: op.labels === undefined ? undefined : labelNames(op.labels),
    assignees: op.assignees === undefined ? undefined : usernames(op.assignees, 'assignees')
  })
}

function reviewersOf(op: { reviewers?: string[] }): string[] | undefined {
  return op.reviewers === undefined ? undefined : usernames(op.reviewers, 'reviewers')
}

/** A label for a DELETE path segment: a dot-only name would resolve to the labels collection and remove every label. */
function labelSegment(name: string): string {
  if (/^\.+$/.test(name)) throw new Error(`cannot remove a label named ${JSON.stringify(name)}`)
  return name
}

/** The endpoints an update's label and assignee changes, then its reviewer requests, will use. */
function changeEndpoints(changes: Required<BrokerChanges>, reviewers: string[] | undefined): EndpointId[] {
  const uses: [boolean, EndpointId][] = [
    [changes.addLabels.length > 0, 'labels.add'],
    [changes.removeLabels.length > 0, 'label.remove'],
    [changes.addAssignees.length > 0, 'assignees.add'],
    [changes.removeAssignees.length > 0, 'assignees.remove'],
    [reviewers !== undefined, 'reviewers.request']
  ]
  return uses.filter(([used]) => used).map(([, id]) => id)
}

export class GithubBroker implements CodeHostEffectBroker {
  private readonly authored = new AuthoredCommentLedger()

  constructor(private readonly deps: GithubBrokerDeps) {}

  async execute(target: CodeHostEffectTarget, op: CodeHostBrokerOperation): Promise<unknown> {
    const [owner, repo, ...rest] = (target.repoPath ?? '').split('/')
    if (!owner || !repo || rest.length > 0) throw new Error('this session has no GitHub repository to act on')
    const at = { owner, repo }
    const ledger = { sessionKey: target.sessionKey, repo: target.repoId }
    switch (op.kind) {
      case 'readMergeRequestDescription': {
        const lease = await this.lease(target, 'pull.get')
        return record(await this.call(target, lease, 'pull.get', { ...at, number: numberOf(op.iid) })).body ?? ''
      }
      case 'createComment': {
        const params = { ...at, number: numberOf(op.iid) }
        const lease = await this.lease(target, 'comment.create')
        const created = await commentScoped(this.call(target, lease, 'comment.create', params, { body: op.body }))
        this.authored.remember(ledger, idOf(record(created).id))
        return { comment: commentResult(created) }
      }
      case 'updateComment': {
        const commentId = requireDecimal(op.noteId, 'noteId')
        if (!this.authored.has(ledger, commentId)) {
          throw new Error('only a comment this session created through the broker can be updated')
        }
        const lease = await this.lease(target, 'comment.update')
        const updated = await commentScoped(
          this.call(target, lease, 'comment.update', { ...at, commentId }, { body: op.body })
        )
        return { comment: commentResult(updated) }
      }
      case 'createMergeRequest': {
        const people = initialPeople(op)
        const reviewers = reviewersOf(op)
        const lease = await this.lease(
          target,
          'pull.create',
          ...(Object.keys(people).length > 0 ? (['issue.update'] as const) : []),
          ...(reviewers !== undefined ? (['reviewers.request'] as const) : [])
        )
        const created = record(
          await this.call(target, lease, 'pull.create', at, {
            ...compact({
              title: op.title,
              head: branch(op.sourceBranch, 'sourceBranch'),
              base: branch(op.targetBranch, 'targetBranch'),
              body: op.description
            }),
            ...(op.draft ? { draft: true } : {})
          })
        )
        if (Object.keys(people).length === 0 && reviewers === undefined) return { pullRequest: pullResult(created) }
        const number = idOf(created.number)
        if (!number) throw new Error('GitHub returned a pull request without a number')
        const params = { ...at, number }
        let pull = created
        if (Object.keys(people).length > 0) {
          const answer = await this.call(target, lease, 'issue.update', params, people)
          pull = overlay(pull, answer, ['labels', 'assignees'])
        }
        pull = await this.requestReviewers(target, lease, pull, params, reviewers)
        return { pullRequest: pullResult(pull) }
      }
      case 'updateMergeRequest': {
        const params = { ...at, number: numberOf(op.iid) }
        const fields = compact({
          title: op.title,
          body: op.description,
          base: op.targetBranch === undefined ? undefined : branch(op.targetBranch, 'targetBranch')
        })
        const changes = changeLists(op)
        changes.removeLabels.forEach(labelSegment)
        const reviewers = reviewersOf(op)
        const edits = Object.keys(fields).length > 0
        const lease = await this.lease(
          target,
          edits ? 'pull.update' : 'pull.get',
          ...(op.draft !== undefined ? (['draft.set'] as const) : []),
          ...changeEndpoints(changes, reviewers)
        )
        let pull = record(
          edits
            ? await this.call(target, lease, 'pull.update', params, fields)
            : await this.call(target, lease, 'pull.get', params)
        )
        if (op.draft !== undefined && bool(pull.draft) !== op.draft) {
          const id = str(pull.node_id)
          if (!id) throw new Error('GitHub returned a pull request without a node id')
          const answer = record(
            await this.call(
              target,
              lease,
              'draft.set',
              {},
              { query: op.draft ? TO_DRAFT : TO_READY, variables: { id } }
            )
          )
          if (Array.isArray(answer.errors) && answer.errors.length > 0) {
            const message = str(record(answer.errors[0]).message, 200) ?? 'unknown error'
            throw new Error(`GitHub could not change the draft state: ${message}`)
          }
          pull = { ...pull, draft: op.draft }
        }
        pull = await this.applyChanges(target, lease, pull, params, changes)
        pull = await this.requestReviewers(target, lease, pull, params, reviewers)
        return { pullRequest: pullResult(pull) }
      }
      case 'mergeMergeRequest': {
        const params = { ...at, number: numberOf(op.iid) }
        if (op.method !== undefined && !BROKER_MERGE_METHODS.includes(op.method)) {
          throw new Error(`method must be one of ${BROKER_MERGE_METHODS.join(', ')}`)
        }
        if (op.sha !== undefined && !COMMIT_SHA.test(op.sha)) throw new Error('sha must be a commit sha')
        const lease = await this.lease(target, 'pull.merge')
        const answer = record(
          await this.call(target, lease, 'pull.merge', params, compact({ merge_method: op.method, sha: op.sha }))
        )
        // A 2xx is the merge: GitHub answers an unmergeable pull request with 405 or 409.
        return compact({ merged: bool(answer.merged) ?? true, sha: str(answer.sha, 64), message: str(answer.message) })
      }
      case 'setState': {
        const params = { ...at, number: numberOf(op.iid) }
        const state = op.state === 'closed' ? 'closed' : 'open'
        if (op.subject === 'merge_request') {
          const lease = await this.lease(target, 'pull.update')
          return { pullRequest: pullResult(await this.call(target, lease, 'pull.update', params, { state })) }
        }
        const lease = await this.lease(target, 'issue.update')
        return { issue: issueResult(await this.call(target, lease, 'issue.update', params, { state })) }
      }
      case 'createIssue': {
        const body = { ...compact({ title: op.title, body: op.description }), ...initialPeople(op) }
        const lease = await this.lease(target, 'issue.create')
        return { issue: issueResult(await this.call(target, lease, 'issue.create', at, body)) }
      }
      case 'updateIssue': {
        const params = { ...at, number: numberOf(op.iid) }
        const fields = compact({ title: op.title, body: op.description })
        const changes = changeLists(op)
        changes.removeLabels.forEach(labelSegment)
        const changeUses = changeEndpoints(changes, undefined)
        const edits = Object.keys(fields).length > 0
        if (!edits && changeUses.length === 0) throw new Error('updateIssue names nothing to change')
        const lease = await this.lease(target, edits ? 'issue.update' : 'issue.get', ...changeUses)
        const issue = record(
          edits
            ? await this.call(target, lease, 'issue.update', params, fields)
            : await this.call(target, lease, 'issue.get', params)
        )
        return { issue: issueResult(await this.applyChanges(target, lease, issue, params, changes)) }
      }
      default:
        throw new Error(`GitHub ${op.kind} is not available through this broker`)
    }
  }

  /** Add and remove labels and assignees on an issue or pull request, folding each answer's lists into the subject. */
  private async applyChanges(
    target: CodeHostEffectTarget,
    lease: BrokerLease,
    subject: Record<string, unknown>,
    params: Record<string, string>,
    changes: Required<BrokerChanges>
  ): Promise<Record<string, unknown>> {
    let current = subject
    // The label endpoints answer with the issue's whole label list.
    const labelsFrom = (answer: unknown) => (Array.isArray(answer) ? { ...current, labels: answer } : current)
    if (changes.addLabels.length > 0) {
      current = labelsFrom(await this.call(target, lease, 'labels.add', params, { labels: changes.addLabels }))
    }
    for (const name of changes.removeLabels) {
      // A label that is not on the issue answers 404, which is already the asked-for state.
      const answer = await this.call(
        target,
        lease,
        'label.remove',
        { ...params, name: labelSegment(name) },
        undefined,
        {
          missingOk: true
        }
      )
      current = labelsFrom(answer)
    }
    if (changes.addAssignees.length > 0) {
      const answer = await this.call(target, lease, 'assignees.add', params, { assignees: changes.addAssignees })
      current = overlay(current, answer, ['assignees'])
    }
    if (changes.removeAssignees.length > 0) {
      const answer = await this.call(target, lease, 'assignees.remove', params, { assignees: changes.removeAssignees })
      current = overlay(current, answer, ['assignees'])
    }
    return current
  }

  /** Request reviewers on a pull request, folding the requested list into it. */
  private async requestReviewers(
    target: CodeHostEffectTarget,
    lease: BrokerLease,
    pull: Record<string, unknown>,
    params: Record<string, string>,
    reviewers: string[] | undefined
  ): Promise<Record<string, unknown>> {
    if (reviewers === undefined) return pull
    const answer = await this.call(target, lease, 'reviewers.request', params, { reviewers })
    return overlay(pull, answer, ['requested_reviewers'])
  }

  /** Mint the lease and check every endpoint the operation will use before its first request, so a refusal never half-applies. */
  private async lease(target: CodeHostEffectTarget, ...endpoints: EndpointId[]): Promise<BrokerLease> {
    const lease = await this.deps.lease(target)
    for (const endpoint of endpoints) enforceGithub(lease, GITHUB_BROKER_ENDPOINTS[endpoint])
    return lease
  }

  /** Issue one allowlisted request; retry once, and only after a definite auth rejection. */
  private call(
    target: CodeHostEffectTarget,
    lease: BrokerLease,
    id: EndpointId,
    params: Record<string, string>,
    body?: Record<string, unknown>,
    options: { missingOk?: boolean } = {}
  ): Promise<unknown> {
    const endpoint = GITHUB_BROKER_ENDPOINTS[id]
    return brokerCall(
      {
        headers: (token) => githubApiHeaders({ accept: 'application/vnd.github+json', token }),
        lease: () => this.deps.lease(target),
        ...(this.deps.invalidateLease
          ? { invalidateLease: (token: string) => this.deps.invalidateLease!(target, token) }
          : {}),
        enforce: (fresh) => enforceGithub(fresh, endpoint),
        host: 'GitHub',
        ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {})
      },
      lease,
      {
        method: endpoint.method,
        url: `${this.deps.baseUrl ?? GITHUB_API_BASE}${renderPath(endpoint.path, params)}`,
        ...(body !== undefined ? { body } : {}),
        ...(options.missingOk ? { missingOk: true } : {})
      }
    )
  }
}
