// `SessionPullRequestLinkService` — the PR panel's SECOND identity source (webchat-side-panels.md
// §3.4, §12.6): the pull request for the session worktree's OWN head branch, for a session that no
// pull-request hook run owns — a PR the agent opened mid-conversation, or an issue-dispatched run
// whose work ended up in one. Identity only: the projection, its cache and its degraded arm all stay
// `PullRequestViewService`'s, so a resolved link joins the same read path a run-linked PR takes.
// Failure to establish identity is an ABSENCE, never a degraded view — the degraded arm needs a PR to
// name, and here there is none — so every unreachable, denied or rate-limited answer reads `null` and
// is cached as a miss rather than re-asked on the next panel mount.
// Two checkouts can answer: a session's own worktree, whose branch IS that session's work, and — for a
// shared-workspace agent, which has no per-session worktree — the agent's primary tree, but only for
// the session currently using it. That second arm is what keeps the tab from being permanently empty
// on a shared workspace without handing an old session the newest one's pull request.
import { githubRequest, type FetchLike } from './api.js'
import type { GithubService } from './service.js'
import type { InstallationTokenService } from './installation-token.service.js'
import type { AgentRecord, SessionMetaRecord } from '../persistence/ports.js'
import type { Clock } from '../domain/clock.js'

// One daemon git read plus one REST list per resolution, so the TTL exists to absorb the panel's own
// mounts and its 404 retry ladder. Shorter for a miss: a PR the agent just opened must not stay
// invisible for a minute, and the console's `refresh` bypasses both.
export const SESSION_PR_LINK_TTL_MS = 60_000
export const SESSION_PR_LINK_MISS_TTL_MS = 15_000

// Hard bound on retained entries — a link is small, but this cache must not grow with session count.
export const SESSION_PR_LINK_CACHE_MAX = 512

// Pull requests read per lookup. GitHub's `head` filter already narrows to one branch, so this is the
// bound on a branch's own history of reopened/closed PRs, not on the repository's.
const HEAD_PULL_LIMIT = 20

/** Which checkout's branch a link resolved through. `shared` is the agent's PRIMARY tree, which every
 *  session on a shared-workspace agent works in — the same checkout the Files and Git tabs already
 *  show for such a session, so the PR is real but is not exclusively this session's work. */
export type SessionPullRequestLinkScope = 'session' | 'shared'

/** The durable half of a branch-resolved PR — the same facts a hook run would have carried. */
export interface SessionPullRequestLink {
  repoId: bigint
  repoFullName: string
  installationId: bigint
  pullNumber: number
  /** The head branch this resolved through, so the panel can say what it matched on. */
  branch: string
  /** Whose checkout that branch was read from, so the panel can say that too. */
  scope: SessionPullRequestLinkScope
  /** true ⇒ the branch has more than one OPEN pull request and this is the first of them. */
  ambiguous: boolean
}

/** One `GET /repos/{owner}/{repo}/pulls` row, narrowed to what the choice below needs. */
export interface HeadPull {
  number: number
  state?: string
  head?: { ref?: string } | null
}

/**
 * Which pull request a head branch means. Open beats closed, because an open PR is the one a reader
 * can still act on; among several open ones the LOWEST number wins — the first one opened for this
 * branch is the canonical review, and a later duplicate must not displace it — and the caller is told
 * the set was ambiguous rather than left to believe the pick was unique. With none open, the HIGHEST
 * number wins instead: the newest closed/merged attempt is the one that describes this branch's fate,
 * and a pile of superseded ones is not an ambiguity anybody can act on.
 */
export function chooseHeadPull(
  pulls: readonly HeadPull[],
  branch: string
): { pullNumber: number; ambiguous: boolean } | null {
  // `head.ref` is re-checked rather than trusted from the query: a filter that silently failed to
  // narrow would otherwise hand this session the repository's newest unrelated PR.
  const mine = pulls.filter(
    (pull) =>
      Number.isSafeInteger(pull.number) && pull.number > 0 && (pull.head?.ref === undefined || pull.head.ref === branch)
  )
  const open = mine.filter((pull) => pull.state === 'open').map((pull) => pull.number)
  if (open.length > 0) return { pullNumber: Math.min(...open), ambiguous: open.length > 1 }
  if (mine.length === 0) return null
  return { pullNumber: Math.max(...mine.map((pull) => pull.number)), ambiguous: false }
}

export interface SessionPullRequestLinkDeps {
  clock: Clock
  github: GithubService
  tokens: InstallationTokenService
  /** The serving daemon's read of the checkout named by `scope`, reduced to its branch. `null` for
   *  everything the caller cannot read a branch from: no daemon serving the agent, a daemon too old to
   *  serve session worktrees, a non-repo workspace, a detached HEAD, or a failed read. */
  readSessionBranch: (
    agent: AgentRecord,
    session: SessionMetaRecord,
    scope: SessionPullRequestLinkScope
  ) => Promise<string | null>
  /** The agent's most recently active session. Only the SHARED arm asks: one checkout has one branch,
   *  and that branch describes the session using it now — not the ones that ran in it last week. */
  latestSessionIdOfAgent: (agent: AgentRecord) => Promise<string | null>
  fetchImpl?: FetchLike
  baseUrl?: string
  log?: { warn?: (obj: unknown, msg: string) => void }
}

interface CacheEntry {
  at: number
  link: SessionPullRequestLink | null
}

export class SessionPullRequestLinkService {
  private readonly cache = new Map<string, CacheEntry>()
  // Concurrent probes for ONE session share the read, like `PullRequestViewService`'s: a resolution is
  // a daemon round trip plus a GitHub list, and two panels (or a read racing the auto-merge write) must
  // not each spend both.
  private readonly inFlight = new Map<string, Promise<SessionPullRequestLink | null>>()

  constructor(private readonly deps: SessionPullRequestLinkDeps) {}

  /** The PR this session's branch has, or null when there is none to name. `force` is the panel's own
   *  refresh: it re-reads the branch and re-asks GitHub, which is the only way a just-opened PR
   *  appears before the miss TTL expires. */
  async resolve(agent: AgentRecord, session: SessionMetaRecord, force = false): Promise<SessionPullRequestLink | null> {
    // Org in the key beside the session id: the id is a UUID, but this cache holds repo identity and
    // must never be reachable from another org's read even under a collision.
    const key = `${session.orgId}#${session.id}`
    const now = this.deps.clock.now()
    const hit = this.cache.get(key)
    if (hit) {
      const ttl = hit.link ? SESSION_PR_LINK_TTL_MS : SESSION_PR_LINK_MISS_TTL_MS
      if (!force && now - hit.at < ttl) return hit.link
      this.cache.delete(key)
    }
    // A forced read JOINS an in-flight one rather than starting a second: the reader pressing refresh
    // twice, or two panels mounting at once, is one resolution either way.
    const running = this.inFlight.get(key)
    if (running) return running
    const read = this.read(agent, session)
      .then((link) => {
        this.store(key, link)
        return link
      })
      .finally(() => {
        if (this.inFlight.get(key) === read) this.inFlight.delete(key)
      })
    this.inFlight.set(key, read)
    return read
  }

  private store(key: string, link: SessionPullRequestLink | null): void {
    const at = this.deps.clock.now()
    this.cache.delete(key)
    for (const [k, entry] of this.cache) {
      if (at - entry.at >= (entry.link ? SESSION_PR_LINK_TTL_MS : SESSION_PR_LINK_MISS_TTL_MS)) this.cache.delete(k)
    }
    this.cache.set(key, { at, link })
    while (this.cache.size > SESSION_PR_LINK_CACHE_MAX) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
  }

  private async read(agent: AgentRecord, session: SessionMetaRecord): Promise<SessionPullRequestLink | null> {
    // A purged session's worktree is gone with its content, so there is nothing to read.
    if (session.contentPurgedAt) return null
    // Which checkout to ask about. A session worktree has a branch of its OWN; a shared-workspace
    // session works in the agent's primary tree — which is exactly the checkout the Files and Git tabs
    // beside this one already show it, so refusing to read it here left the tab permanently empty for
    // every shared-workspace agent rather than protecting anything. It is read, and the link says
    // which checkout answered so the panel can say the PR is not exclusively this session's.
    const scope: SessionPullRequestLinkScope = session.workspaceIsolation === 'session' ? 'session' : 'shared'
    // A shared tree has ONE branch, which moves with whatever the agent is doing now — so it speaks
    // for the session using it and for no other. An older session would otherwise be handed the
    // NEWEST session's pull request, checks and threads, which is worse than an empty tab: the branch
    // that carried its own work is long gone from that checkout and nothing here can find it.
    if (scope === 'shared' && (await this.deps.latestSessionIdOfAgent(agent)) !== session.id) return null
    // The branch first, deliberately: no branch ⇒ no GitHub call at all, which keeps the sessions
    // that can never resolve a PR (scratch workspaces, offline daemons) off the installation's quota.
    const branch = await this.deps.readSessionBranch(agent, session, scope)
    if (!branch) return null
    const repo = await this.deps.github.resolveWorkspaceRepo(agent)
    if (!repo) return null
    const [owner, name] = repo.repoFullName.split('/')
    if (!owner || !name) return null
    try {
      const cred = await this.deps.tokens.mintPullRequestRead(repo.installationId, repo.repoFullName, repo.repoId)
      // `state=all` because a merged PR is the answer for a finished session, and the panel draws that
      // state. `head=<owner>:<branch>` only matches a head in the BASE repository's own namespace —
      // a fork-pushed branch resolves nothing here, which reads as the absence it is.
      const pulls = await githubRequest<HeadPull[]>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls?state=all&per_page=${HEAD_PULL_LIMIT}&head=${encodeURIComponent(`${owner}:${branch}`)}`,
        {
          auth: cred.token,
          ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
          ...(this.deps.baseUrl ? { baseUrl: this.deps.baseUrl } : {})
        }
      )
      const chosen = chooseHeadPull(Array.isArray(pulls) ? pulls : [], branch)
      if (!chosen) return null
      return {
        repoId: repo.repoId,
        repoFullName: repo.repoFullName,
        installationId: repo.installationId,
        pullNumber: chosen.pullNumber,
        branch,
        scope,
        ambiguous: chosen.ambiguous
      }
    } catch (err) {
      this.deps.log?.warn?.({ err, sessionId: session.id }, 'session-pr-link: head-branch lookup failed')
      return null
    }
  }
}
