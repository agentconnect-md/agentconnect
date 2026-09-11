// Gitea structured mutation broker (gitea-integration.md §10.2): the allowlisted non-review effects an
// agent may ask the daemon to perform under the `gitea_effect` lease — create or edit a comment, read
// an issue or pull request with its comments and reviews, create or edit a pull request where the grant
// permits, read commit statuses. Each entry is an exact method and path template; no arbitrary path or
// body passes through. The clamp, the one-retry call, and the ledger are the provider-neutral broker's.
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
  requireDecimal,
  str,
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
  'comment.create': { method: 'POST', capability: 'comment', path: '/repos/:owner/:repo/issues/:index/comments' },
  'comment.update': { method: 'PATCH', capability: 'comment', path: '/repos/:owner/:repo/issues/comments/:commentId' },
  'pull.create': { method: 'POST', capability: 'write', path: '/repos/:owner/:repo/pulls' },
  'pull.update': { method: 'PATCH', capability: 'write', path: '/repos/:owner/:repo/pulls/:index' }
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
}

/** One resolved operation: its calls in order, and the projection of their answers onto bounded structured data. */
interface BrokerPlan {
  calls: PlannedCall[]
  shape: (results: unknown[]) => unknown
  /** Remember the created comment id so `updateComment` keeps the single-writer discipline. */
  recordsComment?: boolean
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
    for (const call of plan.calls) this.enforce(lease, GITEA_BROKER_ENDPOINTS[call.endpoint])
    const results: unknown[] = []
    for (const call of plan.calls) results.push(await this.call(target, call, lease))
    if (plan.recordsComment) this.authored.remember(target.sessionKey, idOf(record(results[0]).id))
    return plan.shape(results)
  }

  private enforce(lease: BrokerLease, endpoint: BrokerEndpoint): void {
    enforceCapability(lease, endpoint, 'Gitea repository')
  }

  private plan(target: CodeHostEffectTarget, op: CodeHostBrokerOperation): BrokerPlan {
    const { owner, repo } = giteaRepoSegments(target.repoPath ?? '')
    const at = { owner, repo }
    switch (op.kind) {
      case 'createComment':
        return {
          calls: [{ endpoint: 'comment.create', params: { ...at, index: String(op.iid) }, body: { body: op.body } }],
          shape: ([created]) => ({ comment: commentResult(created) }),
          recordsComment: true
        }
      case 'updateComment': {
        const commentId = requireDecimal(op.noteId, 'noteId')
        if (!this.authored.has(target.sessionKey, commentId)) {
          throw new Error('only a comment this session created through the broker can be updated')
        }
        return {
          calls: [{ endpoint: 'comment.update', params: { ...at, commentId }, body: { body: op.body } }],
          shape: ([updated]) => ({ comment: commentResult(updated) })
        }
      }
      case 'readDiscussions': {
        if (op.discussionId !== undefined) {
          // Gitea has no discussion objects: the id names one comment.
          return {
            calls: [
              { endpoint: 'comment.get', params: { ...at, commentId: requireDecimal(op.discussionId, 'discussionId') } }
            ],
            shape: ([comment]) => ({ comment: commentResult(comment) })
          }
        }
        const index = String(op.iid)
        const query = { limit: limited(op.limit) }
        if (op.subject === 'issue') {
          return {
            calls: [
              { endpoint: 'issue.get', params: { ...at, index } },
              { endpoint: 'comment.list', params: { ...at, index }, query }
            ],
            shape: ([issue, comments]) => ({ issue: issueResult(issue), comments: list(comments, commentResult) })
          }
        }
        return {
          calls: [
            { endpoint: 'pull.get', params: { ...at, index } },
            { endpoint: 'comment.list', params: { ...at, index }, query },
            { endpoint: 'review.list', params: { ...at, index }, query }
          ],
          shape: ([pull, comments, reviews]) => ({
            pullRequest: pullResult(pull),
            comments: list(comments, commentResult),
            reviews: list(reviews, reviewResult)
          })
        }
      }
      case 'replyDiscussion':
        throw new Error('Gitea comments are not threaded: post a new comment with createCodeHostComment instead')
      case 'createMergeRequest':
        return {
          calls: [
            {
              endpoint: 'pull.create',
              params: at,
              body: compact({
                head: branch(op.sourceBranch, 'sourceBranch'),
                base: branch(op.targetBranch, 'targetBranch'),
                title: draftTitle(op.title, op.draft),
                body: op.description
              })
            }
          ],
          shape: ([created]) => ({ pullRequest: pullResult(created) })
        }
      case 'updateMergeRequest':
        return {
          calls: [
            {
              endpoint: 'pull.update',
              params: { ...at, index: String(op.iid) },
              body: compact({
                ...(op.title !== undefined ? { title: draftTitle(op.title, op.draft) } : {}),
                body: op.description,
                base: op.targetBranch === undefined ? undefined : branch(op.targetBranch, 'targetBranch')
              })
            }
          ],
          shape: ([updated]) => ({ pullRequest: pullResult(updated) })
        }
      case 'inspectPipelines': {
        // Gitea's run state is a commit status (§10.4); the other scopes name pipeline objects it has none of.
        if (op.scope !== 'pipelines' || op.ref === undefined) {
          throw new Error('Gitea exposes commit statuses only: use scope "pipelines" with the ref to read them')
        }
        const status = op.status
        return {
          calls: [
            { endpoint: 'status.list', params: { ...at, ref: commitRef(op.ref) }, query: { limit: limited(op.limit) } }
          ],
          shape: ([statuses]) => ({
            statuses: list(statuses, statusResult).filter((entry) => status === undefined || entry.state === status)
          })
        }
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
        ...(call.body !== undefined ? { body: call.body } : {})
      }
    )
  }
}
