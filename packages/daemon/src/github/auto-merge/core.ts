/**
 * The merge-when-ready loop itself — one GitHub read, one readiness verdict, one squash merge.
 *
 * A LEAF module on purpose: node builtins and `fetch`, nothing else. It is bundled into the
 * in-sandbox `auto-merge.js` entry (its own graph, everything inlined) as well as compiled into
 * the daemon, and an import that reached the CP client or the credential cache from here would
 * copy that graph into the half-trusted runtime image. Same reason `gitcred/gh-token-client.ts`
 * keeps its distance.
 *
 * Why this exists at all instead of GitHub's `enablePullRequestAutoMerge`: that mutation refuses
 * every pull request whose `mergeStateStatus` is not BLOCKED — "clean status" when the checks
 * passed, "unstable status" while they run on a repository with no REQUIRED checks — so on most
 * repositories it can never be armed. The readiness rule below is the one operators actually
 * mean, and it is evaluated against the CURRENT head on every tick: merge-when-ready has to
 * allow the fix commit that turns the checks green.
 */

/** What a tick needs to decide, and nothing more. */
export interface PrSnapshot {
  prId: string
  headOid: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  isDraft: boolean
  /** GitHub's own mergeability verdict; `UNKNOWN` means it is still computing one. */
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
  checks: PrCheck[]
}

export interface PrCheck {
  name: string
  /** `pending` covers queued/in-progress and a status context with no conclusion yet. */
  outcome: 'success' | 'failure' | 'pending'
}

/** Either "merge it" or the one line that says why not — the answer the console draws. */
export type Readiness = { ready: true } | { ready: false; waitingOn: string }

const MAX_NAMED_CHECKS = 3

/**
 * The readiness rule: open, not a draft, no conflicts, no red or running check, and nobody
 * asking for changes.
 *
 * `REVIEW_REQUIRED` is NOT a blocker and that is deliberate: the operator ticking this box on
 * their own agent's pull request IS the approval, and on a repository with no required reviewers
 * GitHub reports `REVIEW_REQUIRED` forever, which would make the box a control that never fires.
 * `CHANGES_REQUESTED` blocks, because someone actively said no.
 *
 * `UNKNOWN` mergeability waits rather than merging: GitHub computes it asynchronously, and
 * treating "not computed yet" as "no conflicts" is how a merge-when-ready lands a broken tree.
 */
export function readiness(pr: PrSnapshot): Readiness {
  // Both terminal states are answered by `tick` before it gets here, so these two arms are for a
  // DIRECT caller (and for the tests that pin the rule) rather than for the loop.
  if (pr.state === 'MERGED') return { ready: false, waitingOn: 'already merged' }
  if (pr.state === 'CLOSED') return { ready: false, waitingOn: 'the pull request is closed' }
  if (pr.isDraft) return { ready: false, waitingOn: 'the pull request is a draft' }
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return { ready: false, waitingOn: 'changes requested' }
  if (pr.mergeable === 'CONFLICTING') return { ready: false, waitingOn: 'conflicts with the base branch' }
  if (pr.mergeable === 'UNKNOWN') return { ready: false, waitingOn: 'GitHub is still computing mergeability' }
  const failed = pr.checks.filter((check) => check.outcome === 'failure')
  if (failed.length > 0) return { ready: false, waitingOn: `failing checks: ${names(failed)}` }
  const pending = pr.checks.filter((check) => check.outcome === 'pending')
  if (pending.length > 0) return { ready: false, waitingOn: `checks running: ${names(pending)}` }
  return { ready: true }
}

function names(checks: PrCheck[]): string {
  const head = checks.slice(0, MAX_NAMED_CHECKS).map((check) => check.name || 'unnamed')
  return checks.length > head.length ? `${head.join(', ')} +${checks.length - head.length}` : head.join(', ')
}

const SNAPSHOT_QUERY = `
query AutoMerge($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      id headRefOid state isDraft mergeable reviewDecision
      commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{
        __typename
        ... on CheckRun{name conclusion status}
        ... on StatusContext{context state}
      }}}}}}
    }
  }
}`

const MERGE_MUTATION =
  'mutation($id:ID!,$oid:GitObjectID!){mergePullRequest(input:{pullRequestId:$id,mergeMethod:SQUASH,expectedHeadOid:$oid}){clientMutationId}}'

/** Raised when GitHub answered but refused — as opposed to never being reached. Both keep the
 *  watcher armed; only the wording the console shows differs. */
export class AutoMergeGithubError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AutoMergeGithubError'
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface GithubAccess {
  token: () => Promise<string>
  fetchImpl?: FetchLike
  /** GitHub GraphQL endpoint; overridden only by tests and GHES. */
  endpoint?: string
}

/** One GraphQL round trip. GraphQL reports refusals inside a 200, so `errors` decides here. */
async function graphql<T>(access: GithubAccess, query: string, variables: Record<string, unknown>): Promise<T> {
  return send(access, await access.token(), query, variables)
}

/** The round trip with the token ALREADY in hand. Split out so a caller that must not await anything
 *  between its last abort check and the request can acquire the token first — see `squashMerge`. */
async function send<T>(
  access: GithubAccess,
  token: string,
  query: string,
  variables: Record<string, unknown>
): Promise<T> {
  const fetchImpl = access.fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init))
  const res = await fetchImpl(access.endpoint ?? 'https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'agentconnect-auto-merge'
    },
    body: JSON.stringify({ query, variables })
  })
  if (!res.ok) throw new AutoMergeGithubError(`github answered ${res.status}`)
  const body = (await res.json()) as { data?: T | null; errors?: Array<{ message?: string }> }
  if (body.errors?.length) {
    throw new AutoMergeGithubError(body.errors.map((e) => e.message ?? 'unknown').join('; '))
  }
  if (!body.data) throw new AutoMergeGithubError('github returned no data')
  return body.data
}

interface SnapshotAnswer {
  repository: {
    pullRequest: {
      id: string
      headRefOid: string | null
      state: 'OPEN' | 'CLOSED' | 'MERGED'
      isDraft: boolean
      mergeable: string
      reviewDecision: string | null
      commits: {
        nodes: Array<{
          commit: { statusCheckRollup: { contexts: { nodes: Array<Record<string, unknown>> | null } } | null }
        }> | null
      }
    } | null
  } | null
}

export async function fetchSnapshot(access: GithubAccess, repoFullName: string, prNumber: number): Promise<PrSnapshot> {
  const [owner, name] = repoFullName.split('/')
  if (!owner || !name) throw new AutoMergeGithubError(`malformed repository name ${repoFullName}`)
  const answer = await graphql<SnapshotAnswer>(access, SNAPSHOT_QUERY, { owner, name, number: prNumber })
  const pr = answer.repository?.pullRequest
  if (!pr) throw new AutoMergeGithubError('pull request not visible to this token')
  const contexts = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? []
  return {
    prId: pr.id,
    headOid: pr.headRefOid ?? '',
    state: pr.state,
    isDraft: pr.isDraft,
    mergeable: pr.mergeable === 'MERGEABLE' || pr.mergeable === 'CONFLICTING' ? pr.mergeable : 'UNKNOWN',
    reviewDecision:
      pr.reviewDecision === 'APPROVED' || pr.reviewDecision === 'CHANGES_REQUESTED'
        ? pr.reviewDecision
        : pr.reviewDecision === 'REVIEW_REQUIRED'
          ? 'REVIEW_REQUIRED'
          : null,
    checks: contexts.map(toCheck)
  }
}

/** A rollup context is a CheckRun or a StatusContext, and the two spell their outcome differently. */
function toCheck(node: Record<string, unknown>): PrCheck {
  if (node.__typename === 'StatusContext') {
    const state = String(node.state ?? '')
    return {
      name: String(node.context ?? ''),
      outcome: state === 'SUCCESS' ? 'success' : state === 'PENDING' || state === '' ? 'pending' : 'failure'
    }
  }
  const conclusion = String(node.conclusion ?? '')
  const status = String(node.status ?? '')
  // A skipped or neutral run is not a failure, and a cancelled one is: it never reported success.
  const outcome: PrCheck['outcome'] =
    status !== 'COMPLETED' || conclusion === ''
      ? 'pending'
      : conclusion === 'SUCCESS' || conclusion === 'SKIPPED' || conclusion === 'NEUTRAL'
        ? 'success'
        : 'failure'
  return { name: String(node.name ?? ''), outcome }
}

/**
 * Squash-merge, pinned to the head the readiness verdict was formed against — never to a head
 * the operator saw in the panel minutes ago. A commit landing mid-tick refuses here and the
 * next tick judges the new head on its own merits, which is the whole point of "when ready".
 *
 * The token is fetched BEFORE the last abort check, not inside the request: fetching it is itself an
 * await (a pod reads it over the gitcred tunnel), and a disarm landing in that window would otherwise
 * be invisible — the check would have passed already and the POST would go out regardless. Answers
 * `false` when the fence closed instead, so nothing was sent.
 */
export async function squashMerge(access: GithubAccess, pr: PrSnapshot, aborted?: () => boolean): Promise<boolean> {
  const token = await access.token()
  // Nothing may be awaited between here and the request; `send` takes the token already resolved.
  if (aborted?.()) return false
  await send(access, token, MERGE_MUTATION, { id: pr.prId, oid: pr.headOid })
  return true
}

/** What one tick did, for the caller to project as `waitingOn` / `lastError` / `merged`. */
export type TickOutcome =
  | { kind: 'merged' }
  /** Terminal for a reason that is not a merge: the pull request was CLOSED. The intent expired with
   *  it, and a watcher left polling would merge it if the branch were ever reopened. */
  | { kind: 'closed' }
  /** The fence below closed while this tick was in flight, so the merge was never attempted. */
  | { kind: 'aborted' }
  | { kind: 'waiting'; waitingOn: string }
  | { kind: 'error'; error: string }

export interface TickOptions {
  /**
   * Checked synchronously in the instant before the merge mutation is sent, with the token already
   * resolved so nothing can be awaited in between.
   *
   * A tick awaits a snapshot and a token before it decides anything, and a disarm arriving inside
   * that window used to be invisible to it: the continuation went on to squash-merge a pull request
   * whose box the operator had already unticked and been told was off. Because the last check is
   * synchronous and immediately precedes the only mutation here, a caller that flips this predicate
   * knows that once it has, no merge can still BEGIN — which is what lets `disarm` answer honestly.
   */
  aborted?: () => boolean
}

/** One poll: read, judge, and merge if the verdict says so. Never throws — a tick's failure is
 *  DATA the watcher keeps armed through, because the usual cure is the next commit. */
export async function tick(
  access: GithubAccess,
  repoFullName: string,
  prNumber: number,
  opts: TickOptions = {}
): Promise<TickOutcome> {
  try {
    if (opts.aborted?.()) return { kind: 'aborted' }
    const pr = await fetchSnapshot(access, repoFullName, prNumber)
    if (pr.state === 'MERGED') return { kind: 'merged' }
    // Closed without merging ends the watch. Keeping it armed would leave a poll running for the life
    // of the pod and, worse, merge the pull request if it were ever reopened.
    if (pr.state === 'CLOSED') return { kind: 'closed' }
    const verdict = readiness(pr)
    if (!verdict.ready) return { kind: 'waiting', waitingOn: verdict.waitingOn }
    // Everything above is a read; below is the irreversible act. The gate is checked here to avoid
    // fetching a token at all for a watch already disarmed, and again inside `squashMerge` with the
    // token in hand — that second one is the check no further await can slip behind.
    if (opts.aborted?.()) return { kind: 'aborted' }
    if (!(await squashMerge(access, pr, opts.aborted))) return { kind: 'aborted' }
    return { kind: 'merged' }
  } catch (err) {
    return { kind: 'error', error: err instanceof Error ? err.message : String(err) }
  }
}

/** Default poll cadence. One pull request per armed box and a handful of boxes at a time, so a
 *  minute is well inside GitHub's budget while still merging promptly after the last check. */
export const AUTO_MERGE_POLL_MS = 30_000
