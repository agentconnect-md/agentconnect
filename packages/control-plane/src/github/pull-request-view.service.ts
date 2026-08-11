/**
 * `PullRequestViewService` — the console PR panel's read projection
 * (webchat-side-panels.md §3.4, M5).
 *
 * Two sources, deliberately split by what is durable and what is live:
 *
 * - IDENTITY comes from Postgres. The run that owns the session already carries the repo, the PR
 *   number and the head/base shas, and the review broker's own association pass keeps them
 *   current. So a rate-limited or denied GitHub call still leaves a panel that names its PR
 *   instead of an empty tab.
 * - STATE comes from GitHub, in ONE GraphQL call. Four REST calls (pull, reviews, check-runs,
 *   comments) would answer most of it, but review-thread RESOLUTION exists only in GraphQL — and
 *   spending one request instead of four is what keeps a panel that several open sessions poll
 *   from being the thing that exhausts an installation's rate limit.
 *
 * Nothing here is persisted. Review-thread bodies are user content and fall under body-locality
 * exactly as a transcript does; the short in-memory TTL below exists to absorb repeated opens of
 * the same PR, not to become a store.
 */
import { GithubApiError, githubGraphql, type FetchLike } from './api.js'
import type { InstallationTokenService } from './installation-token.service.js'
import type { Clock } from '../clock.js'

/** How long one PR's projection is reused. Long enough that reopening the tab or switching between
 *  sessions on the same PR costs nothing, short enough that a check flipping to green shows up
 *  without a manual refresh. The panel's own refresh action bypasses it. */
export const PR_VIEW_TTL_MS = 20_000

/** Review threads per read. A reviewer who left more than this has made the panel the wrong tool;
 *  `threadsTruncated` says so rather than the list quietly ending. */
const THREAD_LIMIT = 30

/** Check contexts per read, over the head commit's rollup. */
const CHECK_LIMIT = 50

/** Latest-review rows per read — one per reviewer, not one per review event. */
const REVIEW_LIMIT = 20

export type PrCheckState = 'success' | 'failure' | 'pending' | 'skipped' | 'neutral'

export interface PrCheck {
  name: string
  state: PrCheckState
  /** GitHub's own word for it, kept verbatim so the panel never has to invent one. */
  detail: string | null
  startedAt: string | null
  completedAt: string | null
  url: string | null
}

export type PrReviewState = 'approved' | 'changes_requested' | 'commented' | 'dismissed' | 'pending'

export interface PrReview {
  author: string
  state: PrReviewState
  /** True when the review came from an agent acting as a GitHub App rather than a person — the
   *  identity split the design draws as square-vs-circle. */
  isBot: boolean
}

export interface PrThread {
  /** `path:line`, or just the path when GitHub has no line (an outdated or file-level thread). */
  location: string
  body: string
  author: string
  isOutdated: boolean
}

export interface PullRequestView {
  repoFullName: string
  pullNumber: number
  title: string
  /** `open` | `closed` | `merged` — merged is reported separately by GitHub and folded in here. */
  state: 'open' | 'closed' | 'merged'
  isDraft: boolean
  url: string
  headRef: string
  baseRef: string
  additions: number
  deletions: number
  /** GitHub's aggregate review decision, absent when it has formed none. */
  reviewDecision: 'approved' | 'changes_requested' | 'review_required' | null
  checks: PrCheck[]
  checksTruncated: boolean
  reviews: PrReview[]
  threads: PrThread[]
  /** Unresolved threads GitHub counted, which can exceed the rows carried. */
  unresolvedCount: number
  threadsTruncated: boolean
  /** True when identity is from Postgres but GitHub could not be reached or refused. Everything
   *  after `baseRef` is then empty, and the panel says why rather than drawing "no checks". */
  degraded: boolean
  degradedReason: 'rate_limited' | 'denied' | 'unreachable' | null
}

const QUERY = `
query PanelPullRequest($owner:String!,$name:String!,$number:Int!,$threads:Int!,$checks:Int!,$reviews:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      number title state isDraft merged additions deletions url
      baseRefName headRefName reviewDecision
      latestReviews(first:$reviews){nodes{state author{login __typename}}}
      commits(last:1){nodes{commit{statusCheckRollup{contexts(first:$checks){nodes{
        __typename
        ... on CheckRun{name conclusion status startedAt completedAt detailsUrl}
        ... on StatusContext{context state targetUrl createdAt}
      }}}}}}
      reviewThreads(first:$threads){
        totalCount
        nodes{isResolved isOutdated path line comments(first:1){nodes{body author{login}}}}
      }
    }
  }
}`

interface GqlAnswer {
  repository: {
    pullRequest: {
      number: number
      title: string
      state: 'OPEN' | 'CLOSED' | 'MERGED'
      isDraft: boolean
      merged: boolean
      additions: number
      deletions: number
      url: string
      baseRefName: string
      headRefName: string
      reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
      latestReviews: { nodes: Array<{ state: string; author: { login: string; __typename: string } | null }> | null }
      commits: {
        nodes: Array<{
          commit: {
            statusCheckRollup: { contexts: { nodes: Array<Record<string, unknown>> | null } } | null
          }
        }> | null
      }
      reviewThreads: {
        totalCount: number
        nodes: Array<{
          isResolved: boolean
          isOutdated: boolean
          path: string | null
          line: number | null
          comments: { nodes: Array<{ body: string; author: { login: string } | null }> | null }
        }> | null
      }
    } | null
  } | null
}

/** A CheckRun's conclusion/status, or a StatusContext's state, onto one vocabulary. GitHub spells
 *  the same outcome three ways depending on which kind of check reported it. */
function checkState(raw: Record<string, unknown>): PrCheckState {
  const word = String(raw['conclusion'] ?? raw['state'] ?? raw['status'] ?? '').toUpperCase()
  if (word === 'SUCCESS') return 'success'
  if (word === 'FAILURE' || word === 'TIMED_OUT' || word === 'STARTUP_FAILURE' || word === 'ERROR') return 'failure'
  if (word === 'CANCELLED' || word === 'SKIPPED') return 'skipped'
  if (word === 'NEUTRAL' || word === 'ACTION_REQUIRED' || word === 'STALE') return 'neutral'
  return 'pending'
}

function reviewState(raw: string): PrReviewState {
  const word = raw.toUpperCase()
  if (word === 'APPROVED') return 'approved'
  if (word === 'CHANGES_REQUESTED') return 'changes_requested'
  if (word === 'DISMISSED') return 'dismissed'
  if (word === 'COMMENTED') return 'commented'
  return 'pending'
}

/** Why GitHub did not answer, in the panel's vocabulary. A GraphQL denial arrives as a 200 with
 *  `errors`, which is why the code rather than the status decides. */
function degradedReasonOf(err: unknown): PullRequestView['degradedReason'] {
  if (!(err instanceof GithubApiError)) return 'unreachable'
  if (err.code === 'RATE_LIMITED') return 'rate_limited'
  if (err.code === 'LEASE_DENIED') return 'denied'
  return err.status === 0 ? 'unreachable' : 'denied'
}

/** The durable half — what the caller has already resolved from the owning run. */
export interface PullRequestIdentity {
  installationId: bigint
  repoId: bigint
  repoFullName: string
  pullNumber: number
}

interface CacheEntry {
  at: number
  view: PullRequestView
}

export class PullRequestViewService {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly inFlight = new Map<string, Promise<PullRequestView>>()

  constructor(
    private readonly tokens: InstallationTokenService,
    private readonly clock: Clock,
    private readonly fetchImpl?: FetchLike,
    private readonly baseUrl?: string
  ) {}

  /** One PR's projection. `force` skips the TTL (the panel's refresh action) but still shares an
   *  in-flight read, so a double press is one request. */
  async view(identity: PullRequestIdentity, force = false): Promise<PullRequestView> {
    const key = `${identity.repoId}#${identity.pullNumber}`
    const now = this.clock.now().getTime()
    if (!force) {
      const hit = this.cache.get(key)
      if (hit && now - hit.at < PR_VIEW_TTL_MS) return hit.view
    }
    const running = this.inFlight.get(key)
    if (running) return running

    const read = this.read(identity)
      .then((view) => {
        // A degraded answer is cached too, and for the same reason a good one is: a rate-limited
        // installation must not be hammered once per panel mount.
        this.cache.set(key, { at: this.clock.now().getTime(), view })
        return view
      })
      .finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, read)
    return read
  }

  /** Drop one PR's cached projection — for a caller that just changed the PR itself (M6). */
  invalidate(repoId: bigint, pullNumber: number): void {
    this.cache.delete(`${repoId}#${pullNumber}`)
  }

  private async read(identity: PullRequestIdentity): Promise<PullRequestView> {
    const [owner, name] = identity.repoFullName.split('/')
    const base: PullRequestView = {
      repoFullName: identity.repoFullName,
      pullNumber: identity.pullNumber,
      title: '',
      state: 'open',
      isDraft: false,
      url: `https://github.com/${identity.repoFullName}/pull/${identity.pullNumber}`,
      headRef: '',
      baseRef: '',
      additions: 0,
      deletions: 0,
      reviewDecision: null,
      checks: [],
      checksTruncated: false,
      reviews: [],
      threads: [],
      unresolvedCount: 0,
      threadsTruncated: false,
      degraded: false,
      degradedReason: null
    }
    if (!owner || !name) return { ...base, degraded: true, degradedReason: 'denied' }

    let answer: GqlAnswer
    try {
      const cred = await this.tokens.mintPullRequestRead(
        identity.installationId,
        identity.repoFullName,
        identity.repoId
      )
      answer = await githubGraphql<GqlAnswer>(
        QUERY,
        {
          owner,
          name,
          number: identity.pullNumber,
          threads: THREAD_LIMIT,
          checks: CHECK_LIMIT,
          reviews: REVIEW_LIMIT
        },
        {
          auth: cred.token,
          ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
          ...(this.baseUrl ? { baseUrl: this.baseUrl } : {})
        }
      )
    } catch (err) {
      return { ...base, degraded: true, degradedReason: degradedReasonOf(err) }
    }

    const pr = answer.repository?.pullRequest
    // A PR the installation can see but that no longer exists reads as denied rather than as an
    // empty PR: "0 checks on #764" would be a claim, and we have not got one.
    if (!pr) return { ...base, degraded: true, degradedReason: 'denied' }

    const contexts = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? []
    const checks: PrCheck[] = contexts.map((raw) => ({
      name: String(raw['name'] ?? raw['context'] ?? 'check'),
      state: checkState(raw),
      detail: raw['conclusion'] ? String(raw['conclusion']) : raw['state'] ? String(raw['state']) : null,
      startedAt: raw['startedAt'] ? String(raw['startedAt']) : raw['createdAt'] ? String(raw['createdAt']) : null,
      completedAt: raw['completedAt'] ? String(raw['completedAt']) : null,
      url: raw['detailsUrl'] ? String(raw['detailsUrl']) : raw['targetUrl'] ? String(raw['targetUrl']) : null
    }))

    const reviews: PrReview[] = (pr.latestReviews?.nodes ?? [])
      .filter((node) => node.author !== null)
      .map((node) => ({
        author: node.author?.login ?? '',
        state: reviewState(node.state),
        isBot: node.author?.__typename === 'Bot'
      }))

    // Resolved threads are dropped HERE rather than in the query, because GraphQL cannot filter a
    // connection by `isResolved` — so `totalCount` counts every thread and the unresolved count
    // has to be derived from the page. That makes it a floor when the page is truncated, which is
    // what `threadsTruncated` tells the panel.
    const unresolved = (pr.reviewThreads?.nodes ?? []).filter((node) => !node.isResolved)
    const threads: PrThread[] = unresolved.map((node) => {
      const comment = node.comments?.nodes?.[0]
      return {
        location: node.path ? (node.line ? `${node.path}:${node.line}` : node.path) : 'this pull request',
        body: comment?.body ?? '',
        author: comment?.author?.login ?? '',
        isOutdated: node.isOutdated
      }
    })

    return {
      ...base,
      title: pr.title,
      state: pr.merged ? 'merged' : pr.state === 'CLOSED' ? 'closed' : 'open',
      isDraft: pr.isDraft,
      url: pr.url || base.url,
      headRef: pr.headRefName,
      baseRef: pr.baseRefName,
      additions: pr.additions,
      deletions: pr.deletions,
      reviewDecision:
        pr.reviewDecision === 'APPROVED'
          ? 'approved'
          : pr.reviewDecision === 'CHANGES_REQUESTED'
            ? 'changes_requested'
            : pr.reviewDecision === 'REVIEW_REQUIRED'
              ? 'review_required'
              : null,
      checks,
      checksTruncated: contexts.length >= CHECK_LIMIT,
      reviews,
      threads,
      unresolvedCount: unresolved.length,
      threadsTruncated: (pr.reviewThreads?.totalCount ?? 0) > THREAD_LIMIT
    }
  }
}
