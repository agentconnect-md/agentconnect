/**
 * GitCredentialCache — daemon-side memory for CP-minted git credentials
 * (docs/designs/github-app-git-credentials.md §Daemon Side;
 * docs/designs/agent-multi-repo-authorization.md §Daemon for the
 * per-repo keying, issue #457).
 *
 * Tokens live ONLY here (and transiently on helper stdout pipes): never disk,
 * never argv, never a log line. Expiry is tracked on the MONOTONIC clock as
 * `receivedAt + ttlSec` — a skewed wall clock must never resurrect a dead
 * token (`expiresAt` in the grant is observability only).
 *
 * Keying: `(agentId, plane, repo?)` — the git plane ('contents' capability)
 * and the gh plane (contents+issues+pull_requests, plus actions when the CP
 * advertises support) are distinct tokens with
 * separate lifecycles, and every non-workspace repo is its own token (single
 * repo scope). `repo` absent ⇒ the agent's workspace repo, the pre-#457 keys.
 *
 * Threshold nesting: entries are handed out only while >10min remain (the CP
 * serves grants with ≥15min, so a fresh grant always clears this). Per-key
 * in-flight coalescing (the `cloneInFlight` pattern) keeps a cold cache from
 * fanning N concurrent helper/pull/prefetch calls into N WS REQs.
 *
 * Denial semantics split (multi-repo design §Security Boundary): an AGENT-level
 * SCOPE_DENIED (workspace request) is terminal — stop asking until the spec
 * replicates. A REPO-level SCOPE_DENIED (request that named a repo) is a
 * 60s NEGATIVE CACHE only: the operator authorizing the repo in the console
 * must take effect on the next gh/git call within a minute, without a spec
 * push or daemon restart.
 *
 * Degradation: outside READY the fetch fails fast (see CpClient.requestGitCred)
 * and an UNEXPIRED cached token keeps serving — CP downtime only breaks remote
 * git once the hour runs out.
 */
import type { GitCredCapability, GitCredGrant } from '@agentconnect.md/protocol'

/** Hand out only while more than this remains (nests under the CP's 15min floor). */
const HANDOUT_MIN_MS = 10 * 60 * 1000

/** Repo-level denials are retried after this — the console-authorization lag. */
const REPO_DENIAL_TTL_MS = 60 * 1000

/** Daemon-owned GitLab writers: project-keyed, re-resolved live per call, so a refusal is never durable. */
const GITLAB_EFFECT_PURPOSES = new Set(['gitlab_hook_reply', 'gitlab_effect'])

/** The baseline scope set behind `GH_TOKEN` (P2.5 write-back): git contents plus the
 *  issue/PR scopes `gh issue comment` / `gh pr comment` need. The CP clamps
 *  every capability — the workspace repo to the agent's gitAccess, an
 *  additional repo to its authorization tier (comment ⇒ contents:read +
 *  issues/PR:write). */
const GH_TOKEN_CAPABILITIES: readonly GitCredCapability[] = ['contents', 'issues', 'pull_requests']

/** The credential plane: 'git' = contents-only (the credential helper), 'gh' =
 *  the widened GH_TOKEN set. Distinct capability sets are distinct tokens. */
export type CredPlane = 'git' | 'gh' | 'glab'
type CachePlane = CredPlane | 'gh-actions'

/** Cache key — NUL-joined so no owner/repo string can collide across fields
 *  (the GH_KEY precedent). GitHub is the EMPTY provider segment whether the request went out
 *  v1-shaped or github-qualified: one logical credential must stay one entry across a CP up- or
 *  downgrade, and the request shape is a wire negotiation, not part of the credential's identity. */
const keyOf = (agentId: string, plane: CachePlane, repo?: string, provider?: 'gitlab'): string =>
  `${plane}\u0000${agentId}\u0000${repo?.toLowerCase() ?? ''}\u0000${provider ?? ''}`

/** Cache key for a repo-targeted COMMENT token (the GithubPoster's — issues/PR
 *  only, no contents requested; its capability set differs from both planes so
 *  it gets its own keyspace). One per (agent, repo). */
const POST_KEY = (agentId: string, repo: string): string => `post\u0000${agentId}\u0000${repo.toLowerCase()}`

/** Cache key for the gitlab note poster's effect token (§14.1) — its own keyspace. */
const GITLAB_POST_KEY = (agentId: string, projectId: string): string => `postglab\u0000${agentId}\u0000${projectId}`

/** Cache key for the structured broker's effect lease (§14.2) — a third keyspace, per (agent, project). */
const GITLAB_EFFECT_KEY = (agentId: string, projectId: string): string => `fxglab\u0000${agentId}\u0000${projectId}`

export class GitCredUnavailableError extends Error {
  constructor(
    message: string,
    /** Terminal (agent-level SCOPE_DENIED): stop asking for this agent until config changes. */
    readonly terminal: boolean
  ) {
    super(message)
    this.name = 'GitCredUnavailableError'
  }
}

interface Entry {
  username: string
  token: string
  repoFullName: string
  /** §13.1 authorization level as the CP echoed it — 'comment' rides an effect lease only. */
  access: GitCredGrant['access']
  /** The purge fence the CP minted this grant under; absent when the CP echoed none. */
  credentialEpoch?: string
  /** Monotonic deadline (ms on the injected monotonic clock). */
  expiresAtMono: number
}

export interface GitCredentialCacheDeps {
  /** D→C `gitcred/request` — throws WireError-shaped errors (`code`, `retryable`). */
  request: (payload: {
    agentId: string
    reason?: 'clone' | 'fetch' | 'pull' | 'push' | 'helper'
    capabilities?: GitCredCapability[]
    repoFullName?: string
    purpose?: 'github_hook_reply' | 'gitlab_hook_reply' | 'gitlab_effect'
    hookId?: string
    forceRefresh?: boolean
    provider?: 'github' | 'gitlab'
    externalRepoId?: string
    requestedAccess?: 'read' | 'write'
  }) => Promise<GitCredGrant>
  log: { warn: (msg: string) => void }
  /** Rolling-upgrade gate: old CPs reject the new enum value, so request Actions
   *  only after register/ok advertises support. The cache key changes with this
   *  value so reconnecting to an upgraded CP mints a fresh widened grant. */
  actionsSupported?: () => boolean
  /** §17.1 negotiation: a provider may be named only after register/ok carries
   *  gitcred-provider-v2 — an older CP would strip the field and answer a
   *  GitHub workspace grant for the wrong provider. */
  providerV2Supported?: () => boolean
  /** §17.3 negotiation: GitHub requests carry `provider: 'github'` only after the CP advertises
   *  gitcred-github-v2 — an older CP strips the field and answers an unqualified grant, which the
   *  echo check below would then have to refuse. Never part of the cache key (see keyOf). */
  githubV2Supported?: () => boolean
  /** §17.3 negotiation: `purpose: 'gitlab_effect'` is a NEW ENUM VALUE, so naming it to an
   *  older CP is frame-fatal rather than silently stripped — ask only after gitlab-effect-v1. */
  gitlabEffectSupported?: () => boolean
  /** Monotonic ms; injectable for tests. */
  monoNow?: () => number
}

export class GitCredentialCache {
  private readonly entries = new Map<string, Entry>()
  private readonly inflight = new Map<string, Promise<Entry>>()
  /** Poster keys whose next successful CP mint must bypass the CP token cache
   *  after GitHub rejected the previous grant with 401/403. */
  private readonly refreshPosts = new Set<string>()
  /** Workspace keys the CP told us to stop asking for (agent-level
   *  SCOPE_DENIED — moved/mode-off). Per KEY, so a gh-plane denial never
   *  silences the git plane. */
  private readonly denied = new Set<string>()
  /** Repo-keyed denials → monotonic retry-after deadline (60s negative cache). */
  private readonly deniedRepos = new Map<string, number>()
  private readonly monoNow: () => number

  constructor(private readonly deps: GitCredentialCacheDeps) {
    this.monoNow = deps.monoNow ?? (() => performance.now())
  }

  /**
   * A live credential for one of the agent's authorized repos — cached,
   * coalesced, or freshly pulled. `repo` ("owner/repo") absent ⇒ the workspace
   * repo (the pre-#457 behavior, byte-identical on the wire). `plane` picks the
   * capability set: 'git' (contents, the credential helper) or 'gh' (the
   * widened GH_TOKEN set for the gh wrapper).
   */
  async get(
    agentId: string,
    reason: 'clone' | 'fetch' | 'pull' | 'push' | 'helper',
    opts: {
      plane?: CredPlane
      repo?: string
      provider?: 'gitlab'
      externalRepoId?: string
      requestedAccess?: 'read' | 'write'
    } = {}
  ): Promise<Entry> {
    const plane = opts.plane ?? 'git'
    if (opts.provider === 'gitlab' && this.deps.providerV2Supported?.() !== true) {
      throw new GitCredUnavailableError(
        'the control plane is too old for gitlab credentials (gitcred-provider-v2 not advertised)',
        false
      )
    }
    const withActions = plane === 'gh' && this.deps.actionsSupported?.() === true
    const cachePlane = withActions ? 'gh-actions' : plane
    return this.getKeyed(keyOf(agentId, cachePlane, opts.repo, opts.provider), agentId, {
      agentId,
      reason,
      ...(plane === 'gh' && opts.provider === undefined
        ? { capabilities: [...GH_TOKEN_CAPABILITIES, ...(withActions ? (['actions'] as const) : [])] }
        : {}),
      ...(opts.repo !== undefined ? { repoFullName: opts.repo } : {}),
      ...(opts.provider !== undefined ? { provider: opts.provider } : this.githubProvider()),
      ...(opts.externalRepoId !== undefined ? { externalRepoId: opts.externalRepoId } : {}),
      ...(opts.requestedAccess !== undefined ? { requestedAccess: opts.requestedAccess } : {})
    })
  }

  /**
   * The GithubPoster's comment token (P3 outbound): scoped to `repo`, requesting
   * issues/pull_requests only (no contents — the token can talk on threads,
   * not read code). `purpose` keeps this daemon-owned writer distinct from an
   * agent's general git/gh credentials: the CP admits it only when this agent
   * has an enabled GitHub hook for the repo. Same cache/coalesce/degradation
   * discipline as {@link get}; the token never enters the agent environment.
   */
  async getPostToken(agentId: string, repo: string, hookId: string): Promise<Entry> {
    const key = POST_KEY(agentId, repo)
    const forceRefresh = this.refreshPosts.has(key)
    const entry = await this.getKeyed(key, agentId, {
      agentId,
      reason: 'helper',
      capabilities: ['issues', 'pull_requests'],
      repoFullName: repo,
      purpose: 'github_hook_reply',
      hookId,
      ...this.githubProvider(),
      ...(forceRefresh ? { forceRefresh: true } : {})
    })
    if (forceRefresh) this.refreshPosts.delete(key)
    return entry
  }

  /** The GitlabPoster's note token (§14.1): the binding's effect PAT, gated CP-side by the enabled gitlab hook. */
  async getGitlabPostToken(agentId: string, projectId: string, hookId: string): Promise<Entry> {
    if (this.deps.providerV2Supported?.() !== true) {
      throw new GitCredUnavailableError(
        'the control plane is too old for gitlab credentials (gitcred-provider-v2 not advertised)',
        false
      )
    }
    const key = GITLAB_POST_KEY(agentId, projectId)
    const forceRefresh = this.refreshPosts.has(key)
    const entry = await this.getKeyed(key, agentId, {
      agentId,
      reason: 'helper',
      provider: 'gitlab',
      externalRepoId: projectId,
      purpose: 'gitlab_hook_reply',
      hookId,
      ...(forceRefresh ? { forceRefresh: true } : {})
    })
    if (forceRefresh) this.refreshPosts.delete(key)
    return entry
  }

  /** The structured broker's effect lease (§14.2): the never-agent-visible effect PAT, authorized by the
   *  agent's GitLab workspace binding or the NAMED enabled hook, carrying the §13.1 clamp it enforces. */
  async getGitlabEffectToken(agentId: string, projectId: string, hookId?: string): Promise<Entry> {
    if (this.deps.providerV2Supported?.() !== true) {
      throw new GitCredUnavailableError(
        'the control plane is too old for gitlab credentials (gitcred-provider-v2 not advertised)',
        false
      )
    }
    if (this.deps.gitlabEffectSupported?.() !== true) {
      throw new GitCredUnavailableError('the control plane does not support GitLab effect leases yet', false)
    }
    const key = GITLAB_EFFECT_KEY(agentId, projectId)
    const forceRefresh = this.refreshPosts.has(key)
    const entry = await this.getKeyed(key, agentId, {
      agentId,
      reason: 'helper',
      provider: 'gitlab',
      externalRepoId: projectId,
      purpose: 'gitlab_effect',
      ...(hookId !== undefined ? { hookId } : {}),
      ...(forceRefresh ? { forceRefresh: true } : {})
    })
    if (forceRefresh) this.refreshPosts.delete(key)
    return entry
  }

  /** Drop the cached gitlab note token after GitLab rejects it. */
  invalidateGitlabPost(agentId: string, projectId: string, presentedToken?: string): void {
    this.dropCached(GITLAB_POST_KEY(agentId, projectId), presentedToken)
  }

  /** Drop the cached broker effect lease after GitLab rejects it, so the single retry re-mints. */
  invalidateGitlabEffect(agentId: string, projectId: string, presentedToken?: string): void {
    this.dropCached(GITLAB_EFFECT_KEY(agentId, projectId), presentedToken)
  }

  /** Evict one daemon-owned writer's cached token and force its next mint past the CP cache. */
  private dropCached(key: string, presentedToken?: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    if (presentedToken !== undefined && entry.token !== presentedToken) return
    this.entries.delete(key)
    this.refreshPosts.add(key)
  }

  /** Drop the cached GithubPoster token after GitHub rejects it. Matching the
   *  presented token avoids deleting a newer grant that won a concurrent race. */
  invalidatePost(agentId: string, repo: string, presentedToken?: string): void {
    this.dropCached(POST_KEY(agentId, repo), presentedToken)
  }

  /** The provider field a GitHub request may name: present once the CP advertises it, absent before. */
  private githubProvider(): { provider?: 'github' } {
    return this.deps.githubV2Supported?.() === true ? { provider: 'github' } : {}
  }

  private async getKeyed(
    key: string,
    agentId: string,
    payload: Parameters<GitCredentialCacheDeps['request']>[0]
  ): Promise<Entry> {
    if (this.denied.has(key)) {
      throw new GitCredUnavailableError('control plane denied git credentials for this agent', true)
    }
    const retryAfter = this.deniedRepos.get(key)
    if (retryAfter !== undefined) {
      if (retryAfter > this.monoNow()) {
        throw new GitCredUnavailableError(
          `${payload.repoFullName ?? 'repo'} is not authorized for this agent — authorize it under the agent's Repositories settings`,
          false
        )
      }
      this.deniedRepos.delete(key)
    }
    const cached = this.entries.get(key)
    if (cached && cached.expiresAtMono - this.monoNow() > HANDOUT_MIN_MS) return cached

    let pending = this.inflight.get(key)
    if (!pending) {
      pending = this.fetch(key, payload).finally(() => this.inflight.delete(key))
      this.inflight.set(key, pending)
    }
    try {
      return await pending
    } catch (e) {
      // CP unreachable / transient: an UNEXPIRED cached token still serves.
      // A DENIAL is authoritative, not transient — fetch() deletes the entry on
      // SCOPE_DENIED, so the identity check (`=== cached`) fails and we do NOT
      // resurrect the token the denial just purged (a revoked repo must break on
      // the discovering call, not one call later).
      if (cached && this.entries.get(key) === cached && cached.expiresAtMono > this.monoNow()) {
        this.deps.log.warn(`gitcred: refresh failed for agent ${agentId} — serving cached token`)
        return cached
      }
      throw e
    }
  }

  /**
   * Invalidate on rejection. Git calls the helper's `erase` with the failing
   * credential when the remote refuses it (GitHub revokes instantly on
   * uninstall/suspend) — matching on the presented password keeps a racing
   * fresh grant from being wiped by a stale erase. `repo` routes the erase to
   * the same key the `get` used; absent ⇒ the workspace git-plane entry.
   */
  invalidate(
    agentId: string,
    presentedPassword?: string,
    opts: { plane?: CredPlane; repo?: string; provider?: 'gitlab' } = {}
  ): void {
    const plane = opts.plane ?? 'git'
    const cachePlane = plane === 'gh' && this.deps.actionsSupported?.() === true ? 'gh-actions' : plane
    const key = keyOf(agentId, cachePlane, opts.repo, opts.provider)
    const entry = this.entries.get(key)
    if (!entry) return
    if (presentedPassword !== undefined && entry.token !== presentedPassword) return
    this.entries.delete(key)
  }

  /** agent/remove: drop the orphaned bearer tokens with the agent dir. */
  remove(agentId: string): void {
    const marker = `\u0000${agentId}\u0000`
    for (const key of [...this.entries.keys()]) if (key.includes(marker)) this.entries.delete(key)
    for (const key of [...this.deniedRepos.keys()]) if (key.includes(marker)) this.deniedRepos.delete(key)
    for (const key of [...this.denied]) if (key.includes(marker)) this.denied.delete(key)
    for (const key of [...this.refreshPosts]) if (key.includes(marker)) this.refreshPosts.delete(key)
  }

  private async fetch(key: string, payload: Parameters<GitCredentialCacheDeps['request']>[0]): Promise<Entry> {
    let grant: GitCredGrant
    try {
      grant = await this.deps.request(payload)
    } catch (e) {
      const code = (e as { code?: string }).code
      if (code === 'SCOPE_DENIED') {
        // §14.1/§14.2: these leases are re-resolved live and hook/binding lifecycle changes never
        // replicate an agent spec, so a refusal is never durable — the next turn asks the CP again.
        if (payload.purpose !== undefined && GITLAB_EFFECT_PURPOSES.has(payload.purpose)) {
          this.entries.delete(key)
          throw new GitCredUnavailableError((e as Error).message, false)
        }
        if (payload.repoFullName !== undefined) {
          // Repo-keyed: negative-cache and retry in a minute — the operator may
          // be authorizing the repo in the console right now.
          this.deniedRepos.set(key, this.monoNow() + REPO_DENIAL_TTL_MS)
          this.entries.delete(key)
          throw new GitCredUnavailableError((e as Error).message, false)
        }
        // Workspace-keyed terminal: the agent moved daemons or left github-app
        // mode. Stop asking on THIS key until the CP replicates a new spec
        // (which clears it).
        this.denied.add(key)
        this.entries.delete(key)
        throw new GitCredUnavailableError((e as Error).message, true)
      }
      // 19.3: LEASE_DENIED is an authoritative refusal of new effects, not an outage — evict so no revoked token keeps serving.
      if (code === 'LEASE_DENIED') this.entries.delete(key)
      throw new GitCredUnavailableError((e as Error).message, false)
    }
    // Old-CP mismatch guard (multi-repo design §Protocol Changes): a CP that predates
    // `repoFullName` strips the field and answers with the WORKSPACE grant —
    // serving that under a repo key would hand the wrong repo's token to gh/git.
    // A NEW CP ECHOES the requested name back verbatim (even after a GitHub
    // canonical rename — it mints by numeric id but reports what we asked), so
    // this only ever fires on the genuine old-CP case, never on a rename.
    if (payload.repoFullName !== undefined && grant.repoFullName.toLowerCase() !== payload.repoFullName.toLowerCase()) {
      throw new GitCredUnavailableError(
        `control plane is too old for per-repo credentials (asked ${payload.repoFullName}, got ${grant.repoFullName})`,
        false
      )
    }
    // v2 echo verification (§17.1/§17.3): a stripped provider means the CP answered unqualified —
    // an older peer, or one that never saw our provider. Never serve that for a request that named one.
    if (payload.provider !== undefined && grant.provider !== payload.provider) {
      throw new GitCredUnavailableError(
        `control plane answered provider ${grant.provider ?? 'github (unqualified)'} for a ${payload.provider} request`,
        false
      )
    }
    // …and a mismatched numeric identity is a wrong-project credential: local
    // replica and CP record disagree — fail, never serve.
    if (payload.externalRepoId !== undefined && grant.externalRepoId !== payload.externalRepoId) {
      throw new GitCredUnavailableError(
        `control plane answered project ${grant.externalRepoId ?? 'unknown'} for project ${payload.externalRepoId}`,
        false
      )
    }
    const entry: Entry = {
      username: grant.username,
      token: grant.token,
      repoFullName: grant.repoFullName,
      access: grant.access,
      ...(grant.credentialEpoch !== undefined ? { credentialEpoch: grant.credentialEpoch } : {}),
      expiresAtMono: this.monoNow() + grant.ttlSec * 1000
    }
    this.entries.set(key, entry)
    return entry
  }

  /** A replicated spec change may re-enable a previously denied agent. */
  clearDenied(agentId: string): void {
    const marker = `\u0000${agentId}\u0000`
    for (const key of [...this.denied]) if (key.includes(marker)) this.denied.delete(key)
    for (const key of [...this.deniedRepos.keys()]) if (key.includes(marker)) this.deniedRepos.delete(key)
  }
}
