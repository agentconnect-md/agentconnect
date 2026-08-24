// `PullRequestViewService` — the console PR panel's read projection (webchat-side-panels.md §3.4, M5).
// Identity is Postgres's (the owning run names the repo/PR even when GitHub is down); live state is
// GitHub's, in ONE bounded GraphQL call — thread RESOLUTION exists only there, and one request instead
// of four is what keeps several polling sessions from exhausting an installation's rate limit.
// Nothing is persisted: thread bodies are user content (body-locality), and the short TTL cache below
// exists to absorb repeated opens of the same PR, not to become a store.
import { GithubApiError, githubGraphql, type FetchLike } from './api.js'
import type { InstallationTokenService } from './installation-token.service.js'
import type { Clock } from '../domain/clock.js'
import type { OrgId } from '../domain/ids.js'

// Reuse window: reopening the tab is free, a check flipping green still shows up; refresh bypasses it.
export const PR_VIEW_TTL_MS = 20_000

// Hard bound on retained entries — the cache holds thread bodies, so it must never grow into a store.
export const PR_VIEW_CACHE_MAX = 256

// Review threads per read; `threadsTruncated` says so rather than the list quietly ending.
const THREAD_LIMIT = 30

// Check contexts per read, over the head commit's rollup.
const CHECK_LIMIT = 50

// Latest-review rows per read — one per reviewer, not one per review event.
const REVIEW_LIMIT = 20

export type PrCheckState = 'success' | 'failure' | 'pending' | 'skipped' | 'neutral'

export interface PrCheck {
  name: string
  state: PrCheckState
  detail: string | null // GitHub's own word for it, kept verbatim
  startedAt: string | null
  completedAt: string | null
  url: string | null
}

export type PrReviewState = 'approved' | 'changes_requested' | 'commented' | 'dismissed' | 'pending'

export interface PrReview {
  author: string
  state: PrReviewState
  isBot: boolean // an agent reviewing as a GitHub App, not a person — the console's square-vs-circle split
}

export interface PrThread {
  location: string // `path:line`, or just the path when GitHub has no line (outdated/file-level)
  body: string
  author: string
  isOutdated: boolean
}

export interface PullRequestView {
  repoFullName: string
  pullNumber: number
  title: string
  /** The PR description as plain text; empty while degraded or when GitHub reported none. */
  body: string
  /** The head commit oid the projection was built from; null while degraded. The merge write pins it. */
  headOid: string | null
  // Null only while degraded with no Postgres knowledge; degraded 'closed' cannot distinguish merged.
  state: 'open' | 'closed' | 'merged' | null
  isDraft: boolean | null // null only while degraded and the owning run recorded no draft fact
  url: string
  headRef: string
  baseRef: string
  additions: number | null // null while degraded — Postgres holds no line counts to fall back on
  deletions: number | null
  reviewDecision: 'approved' | 'changes_requested' | 'review_required' | null // absent when GitHub formed none
  checks: PrCheck[]
  checksTruncated: boolean
  reviews: PrReview[]
  threads: PrThread[]
  unresolvedCount: number // unresolved threads on the carried page — a floor when `threadsTruncated`
  threadsTruncated: boolean
  // Degraded ⇒ identity is Postgres's, the live lists are empty, and the panel says why.
  degraded: boolean
  degradedReason: 'rate_limited' | 'denied' | 'unreachable' | null
  /** The agent's recorded review from the owning run — populated ONLY on a degraded answer. When
   *  GitHub answered, its review list is authoritative and already contains this review, so carrying
   *  a second copy would invite the panel to double-draw it; the precedence lives here, not in the UI. */
  agentReview: 'approved' | 'changes_requested' | 'commented' | null
}

const QUERY = `
query PanelPullRequest($owner:String!,$name:String!,$number:Int!,$threads:Int!,$checks:Int!,$reviews:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      number title bodyText state isDraft merged additions deletions url
      baseRefName headRefName headRefOid reviewDecision
      latestReviews(first:$reviews){nodes{state author{login __typename}}}
      commits(last:1){nodes{commit{statusCheckRollup{contexts(first:$checks){pageInfo{hasNextPage} nodes{
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
      bodyText: string
      state: 'OPEN' | 'CLOSED' | 'MERGED'
      isDraft: boolean
      merged: boolean
      additions: number
      deletions: number
      url: string
      baseRefName: string
      headRefName: string
      headRefOid: string | null
      reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
      latestReviews: { nodes: Array<{ state: string; author: { login: string; __typename: string } | null }> | null }
      commits: {
        nodes: Array<{
          commit: {
            statusCheckRollup: {
              contexts: { pageInfo: { hasNextPage: boolean } | null; nodes: Array<Record<string, unknown>> | null }
            } | null
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

// A CheckRun's conclusion/status, or a StatusContext's state, onto one vocabulary.
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

// Why GitHub did not answer, in the panel's vocabulary — the typed code decides, not the HTTP status.
function degradedReasonOf(err: unknown): PullRequestView['degradedReason'] {
  if (!(err instanceof GithubApiError)) return 'unreachable'
  if (err.code === 'RATE_LIMITED') return 'rate_limited'
  if (err.code === 'LEASE_DENIED') return 'denied'
  // A GitHub 5xx is GitHub being down, not the installation being revoked — 'denied' points the
  // operator at a nonexistent permission problem for the length of an outage.
  return err.status === 0 || err.status >= 500 ? 'unreachable' : 'denied'
}

/** The caller's run-specific facts, applied over the SHARED projection after the cache. Only a
 *  degraded view takes them: when GitHub answered, its own state/draft/reviews are authoritative and
 *  already include this agent's review. The cached object is never mutated. */
function overlay(view: PullRequestView, identity: PullRequestIdentity): PullRequestView {
  if (!view.degraded) return view
  return {
    ...view,
    state: identity.knownIsOpen === undefined ? view.state : identity.knownIsOpen ? 'open' : 'closed',
    isDraft: identity.knownIsDraft ?? view.isDraft,
    agentReview: identity.knownAgentReview ?? null
  }
}

// The durable half, resolved by the caller from the owning run (plus the subject's open/draft facts).
export interface PullRequestIdentity {
  orgId: OrgId
  installationId: bigint
  repoId: bigint
  repoFullName: string
  pullNumber: number
  knownIsOpen?: boolean // HookReviewSubject.isOpen — the degraded arm's state, never an invented default
  knownIsDraft?: boolean // HookRun.isDraft — same role
  // HookRun.reviewEvent, already normalized — the agent's OWN recorded review, for the degraded arm only.
  knownAgentReview?: 'approved' | 'changes_requested' | 'commented'
}

interface CacheEntry {
  at: number
  view: PullRequestView
}

export class PullRequestViewService {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly inFlight = new Map<string, Promise<PullRequestView>>()
  // The invalidation fence: bumped per key, snapshotted when a read starts, checked before it stores.
  // Without it a read that started BEFORE a write finishes after and repopulates the pre-write state,
  // absorbing the console's immediate verification read for a full TTL. Entries are permanent by
  // design — deleting one would reset it to 0 and re-admit exactly the stale read it fenced out.
  private readonly epochs = new Map<string, number>()

  private epochOf(key: string): number {
    return this.epochs.get(key) ?? 0
  }

  constructor(
    private readonly tokens: InstallationTokenService,
    private readonly clock: Clock,
    private readonly fetchImpl?: FetchLike,
    private readonly baseUrl?: string
  ) {}

  // Org+installation in the key: two orgs pointing at one repo/PR must never share cached thread
  // bodies or ride each other's token validation (the session-access snapshotKey rule).
  // repoFullName too: historical runs keep pre-rename names, the name drives the GraphQL query and the
  // cached URL, and rename repair does not rewrite them — so name variants must not share a projection.
  private keyOf(identity: PullRequestIdentity): string {
    return `${identity.orgId}#${identity.installationId}#${identity.repoFullName}#${identity.repoId}#${identity.pullNumber}`
  }

  // One PR's projection. `force` skips the TTL (the panel's refresh) but still shares an in-flight read.
  async view(identity: PullRequestIdentity, force = false): Promise<PullRequestView> {
    const key = this.keyOf(identity)
    const now = this.clock.now()
    const hit = this.cache.get(key)
    if (hit && now - hit.at >= PR_VIEW_TTL_MS) this.cache.delete(key)
    // Every return path overlays the CALLER's durable facts onto the shared cached projection: the
    // key is the PR while knownIsOpen/knownIsDraft/knownAgentReview belong to the caller's RUN, so a
    // cached degraded answer built for session A must not hand session B another run's recorded
    // review — the overlay is what keeps run-specific facts out of shared storage entirely.
    if (!force && hit && now - hit.at < PR_VIEW_TTL_MS) return overlay(hit.view, identity)

    const running = this.inFlight.get(key)
    if (running) return running.then((view) => overlay(view, identity))

    const startEpoch = this.epochOf(key)
    const read = this.read(identity)
      .then((view) => {
        // Degraded answers cache too: a rate-limited installation must not be hammered per panel mount.
        // Stored only when no invalidation crossed this read — a fenced-out answer is served to its own
        // awaiters (it was true when asked) but never becomes the cache's post-write truth.
        if (this.epochOf(key) === startEpoch) this.store(key, view)
        return view
      })
      .finally(() => {
        if (this.inFlight.get(key) === read) this.inFlight.delete(key)
      })
    this.inFlight.set(key, read)
    return read.then((view) => overlay(view, identity))
  }

  // Bounded insert: sweep expired entries, then evict oldest-inserted past the cap (20s TTL ⇒ LRU-ish).
  private store(key: string, view: PullRequestView): void {
    const at = this.clock.now()
    this.cache.delete(key)
    for (const [k, entry] of this.cache) if (at - entry.at >= PR_VIEW_TTL_MS) this.cache.delete(k)
    this.cache.set(key, { at, view })
    while (this.cache.size > PR_VIEW_CACHE_MAX) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
  }

  // Drop one PR's projections (every org) — for a caller that just changed the PR itself (M6).
  // Settled cache, in-flight joins AND late stores all go: the epoch bump is what keeps a read that
  // started before the write from finishing after it and reinstating the pre-write state.
  invalidate(repoId: bigint, pullNumber: number): void {
    const suffix = `#${repoId}#${pullNumber}`
    this.drop((key) => key.endsWith(suffix))
  }

  // Mirror of InstallationTokenService.invalidateInstallation: a suspended/revoked installation must
  // not keep serving its cached views — and the same epoch fence keeps its in-flight reads from repopulating.
  invalidateInstallation(installationId: bigint): void {
    const marker = `#${installationId}#`
    this.drop((key) => key.includes(marker))
  }

  private drop(matches: (key: string) => boolean): void {
    for (const key of new Set([...this.cache.keys(), ...this.inFlight.keys(), ...this.epochs.keys()])) {
      if (!matches(key)) continue
      this.epochs.set(key, this.epochOf(key) + 1)
      this.cache.delete(key)
      this.inFlight.delete(key)
    }
  }

  private async read(identity: PullRequestIdentity): Promise<PullRequestView> {
    const [owner, name] = identity.repoFullName.split('/')
    const base: PullRequestView = {
      repoFullName: identity.repoFullName,
      pullNumber: identity.pullNumber,
      title: '',
      body: '',
      headOid: null,
      // Null here, NOT the caller's known facts: this object is CACHED and the cache key is the PR,
      // not the run — two sessions on one PR have different runs, so any run-specific fact baked in
      // here would be served to the other session. The per-caller overlay in view() fills these.
      state: null,
      isDraft: null,
      url: `https://github.com/${identity.repoFullName}/pull/${identity.pullNumber}`,
      headRef: '',
      baseRef: '',
      additions: null,
      deletions: null,
      reviewDecision: null,
      checks: [],
      checksTruncated: false,
      reviews: [],
      threads: [],
      unresolvedCount: 0,
      threadsTruncated: false,
      degraded: false,
      degradedReason: null,
      agentReview: null
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
    // A PR the installation cannot see reads as denied, not as an empty PR — "0 checks" would be a claim.
    if (!pr) return { ...base, degraded: true, degradedReason: 'denied' }

    const rollup = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup
    const contexts = rollup?.contexts?.nodes ?? []
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

    // Resolved threads are dropped HERE — GraphQL cannot filter the connection by `isResolved`, so
    // the unresolved count is page-derived and is a floor whenever `threadsTruncated`.
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
      body: pr.bodyText ?? '',
      headOid: pr.headRefOid ?? null,
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
      checksTruncated: rollup?.contexts?.pageInfo?.hasNextPage ?? false,
      reviews,
      threads,
      unresolvedCount: unresolved.length,
      threadsTruncated: (pr.reviewThreads?.totalCount ?? 0) > THREAD_LIMIT
    }
  }

  /** Merge the PR (squash) now, with a token the CALLER minted under the agent's clamp. `expectedHeadOid`
   *  pins the merge to the head the operator was shown — GitHub refuses if the head moved, which the
   *  caller maps to a 409. The edge's merge-when-ready watcher pins the head it JUDGED instead, which is
   *  a different rule for a different act: arming allows the fix commit, one press must not. Idempotent on
   *  the fresh node read; the cached view is dropped either way so the next read shows the merged state. */
  async merge(
    target: { repoId: bigint; repoFullName: string; pullNumber: number },
    token: string,
    expectedHeadOid: string
  ): Promise<{ merged: boolean }> {
    const [owner, name] = target.repoFullName.split('/')
    if (!owner || !name) throw new GithubApiError('malformed repository name', 0, 'LEASE_DENIED', false)
    const opts = {
      auth: token,
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
      ...(this.baseUrl ? { baseUrl: this.baseUrl } : {})
    }
    const node = await githubGraphql<MergeNodeAnswer>(
      'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){id state merged}}}',
      { owner, name, number: target.pullNumber },
      opts
    )
    const pr = node.repository?.pullRequest
    if (!pr) throw new GithubApiError('pull request not visible to the installation', 200, 'LEASE_DENIED', false)
    try {
      if (pr.merged || pr.state === 'MERGED') return { merged: true }
      await githubGraphql(
        'mutation($id:ID!,$expectedHeadOid:GitObjectID!){mergePullRequest(input:{pullRequestId:$id,mergeMethod:SQUASH,expectedHeadOid:$expectedHeadOid}){clientMutationId}}',
        { id: pr.id, expectedHeadOid },
        { ...opts, strictErrors: true }
      )
      return { merged: true }
    } finally {
      this.invalidate(target.repoId, target.pullNumber)
    }
  }
}

interface MergeNodeAnswer {
  repository: { pullRequest: { id: string; state: string; merged: boolean } | null } | null
}
