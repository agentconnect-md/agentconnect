/**
 * GithubService — the façade the HTTP routes and the WS gitcred handler share
 * (docs/designs/github-app-git-credentials.md §CP Side).
 *
 * Owns install-state minting/consumption, setup-callback verification (App-JWT
 * ownership check — never trust a callback's installation_id), org-scoped
 * installation refresh (mark-revoked, never delete), the repo/branch picker
 * proxies, create-time repo validation, and the gitcred mint resolution
 * (agent → repo owner → LIVE installation → scoped token).
 */
import { gitRepoLabel, type GitCommitIdentity, type GitCredCapability } from '@agentconnect.md/protocol'
import { LRUCache } from 'lru-cache'
import { cacheOptions } from '../cache.js'
import type { Clock } from '../domain/clock.js'
import type { OrgId } from '../domain/ids.js'
import type {
  GithubInstallationFacts,
  GithubInstallationRecord,
  GithubInstallationRepo,
  GithubInstallStateStore,
  AgentRecord,
  AgentRepo,
  AgentRepoAuthorizationRepo,
  RepoAccess
} from '../persistence/ports.js'
import { githubRequest, githubRequestPage, mintAppJwt, GithubApiError, type FetchLike, type GithubPage } from './api.js'
import { githubAppBotIdentity, type GithubAppConfig } from './config.js'
import {
  InstallationTokenService,
  type CapabilityLevels,
  type GitAccess,
  type MintedGitCred
} from './installation-token.service.js'
import { deriveInstallStateKey, mintInstallState, verifyInstallState } from './install-state.js'
import { TokenBucket } from './rate-limit.js'

/** As GitHub returns an installation object (App-JWT surface). */
interface GhInstallation {
  id: number
  account: { login: string; type: string } | null
  repository_selection: string
  suspended_at: string | null
  /** Canonical GitHub page for reviewing this installation. */
  html_url?: string
  /** Effective permissions on THIS installation (may lag App registration). */
  permissions?: Record<string, string>
}

interface GhRepo {
  id: number | string
  full_name: string
  private: boolean
  default_branch: string
  description: string | null
  pushed_at?: string | null
  updated_at?: string | null
}

interface GhRepoPage {
  repos: GhRepo[]
  totalCount: number
}

interface GhUser {
  id: number
  login: string
  type: string
}

/** A user's repository role: GitHub's legacy permission levels plus the built-in triage role,
 *  which the legacy field hides under `read`. Maintain already arrives collapsed as `write`. */
export type GithubRepoRole = 'admin' | 'write' | 'triage' | 'read' | 'none'

/** One entry of `GET /app/hook/deliveries` (summary — no payload body). */
export interface GhHookDelivery {
  /** Delivery id as a STRING: real values are 19 digits — past
   *  Number.MAX_SAFE_INTEGER, where JSON.parse silently rounds and a redeliver
   *  call 404s on the mangled id (`bigIdsAsStrings` keeps it exact). */
  id: string
  guid: string // stable across redeliveries of the same event — the HookRun deliveryKey
  delivered_at: string
  event: string
  action: string | null
  repository_id: number | null
  installation_id: number | null
}

/** A delivery listing plus how honest it is about its own reach. */
export interface GhHookDeliveryPage {
  /** Newest first, across every page walked. */
  deliveries: GhHookDelivery[]
  /** The walk stopped on its page budget with a cursor left — the caller has
   *  NOT seen everything back to `deliveredSince`, and must not claim it did. */
  truncated: boolean
}

export interface GithubServiceDeps {
  cfg: GithubAppConfig
  clock: Clock
  installations: GithubInstallationRepo
  installState: GithubInstallStateStore
  /** Explicit additional-repo grants (issue #457) — the mint gate for any
   *  `gitcred/request` naming a non-workspace repo. Absent (older test
   *  harnesses) ⇒ non-workspace requests are denied. */
  repoAuths?: AgentRepoAuthorizationRepo
  /** Optional lazy repair of the workspace's rename-proof numeric repo id. */
  agents?: Pick<AgentRepo, 'setWorkspaceRepoId'>
  onInstallationFactsChanged?: (installationId: bigint, orgId: OrgId) => void | Promise<void>
  pepper: string
  fetchImpl?: FetchLike
  baseUrl?: string
  log?: { warn: (message: string) => void }
}

/** GitHub's `outdated=true` result is stable enough to cache briefly across the
 * console's installation pickers. Settings can still force a fresh read after a
 * user explicitly presses Sync. */
const OUTDATED_INSTALLATIONS_CACHE_MS = 30_000
const REPO_PAGE_CACHE_MS = 5 * 60_000
const MAX_REPO_PAGE_CACHE_ENTRIES = 1_000
/** Delivery-list pages one sweep may walk — the firehose bound, not the window. */
const MAX_DELIVERY_PAGES = 10

type RepoPageLookup = { ins: GithubInstallationRecord; page: number; perPage: number }

/** Capability-level clamp per RepoAccess tier (agent-multi-repo-authorization.md
 *  decision 3). Only capabilities the daemon asked for are actually minted. */
const REPO_ACCESS_LEVELS: Record<RepoAccess, CapabilityLevels> = {
  read: { contents: 'read', issues: 'read', pull_requests: 'read' },
  comment: { contents: 'read', issues: 'write', pull_requests: 'write' },
  write: { contents: 'write', issues: 'write', pull_requests: 'write', actions: 'write' }
}

/** Thrown by gitcred resolution; `code` maps 1:1 onto the wire ErrorCode. */
export class GitCredDeniedError extends Error {
  constructor(
    message: string,
    readonly code: 'SCOPE_DENIED' | 'LEASE_DENIED' | 'RATE_LIMITED' | 'INTERNAL',
    readonly retryable: boolean
  ) {
    super(message)
    this.name = 'GitCredDeniedError'
  }
}

function toFacts(ins: GhInstallation): GithubInstallationFacts {
  return {
    installationId: BigInt(ins.id),
    accountLogin: ins.account?.login ?? '',
    accountType: ins.account?.type ?? 'User',
    repositorySelection: ins.repository_selection,
    suspendedAt: ins.suspended_at ? new Date(ins.suspended_at) : null,
    permissions: ins.permissions ?? {}
  }
}

export interface ResolvedAgentRepoAuthorization {
  kind: 'workspace' | 'additional'
  repoId: bigint
  repoFullName: string
  access: RepoAccess
  installation: GithubInstallationRecord
}

type NamedAgentRepoAuthorization = Omit<ResolvedAgentRepoAuthorization, 'repoId'> & {
  /** Modern workspace and additional-repo rows are rename-proof numeric ids.
   * Only legacy workspaces that have not acquired workspaceRepoId remain
   * name-scoped for rolling compatibility. */
  repoId?: bigint
}

export class GithubService {
  readonly slug: string
  readonly tokens: InstallationTokenService
  private gitCommitIdentityPromise?: Promise<GitCommitIdentity | undefined>
  private readonly stateKey: Buffer
  /** Mint-path abuse bound (shared-App blast radius): per daemon AND per org. */
  private readonly mintBucket: TokenBucket
  private outdatedInstallationsCache:
    { expiresAt: number; settingsUrlsByInstallationId: ReadonlyMap<string, string> } | undefined
  /** One picker page. `fetch` hands concurrent callers of one key the same
   *  promise; the generation fence lives in `listRepos`, since it is about which
   *  roster a page belongs to rather than how long the page stays fresh. */
  private readonly repoPages: LRUCache<string, GhRepoPage, RepoPageLookup>
  private readonly repoRosterGeneration = new Map<string, number>()

  constructor(private readonly deps: GithubServiceDeps) {
    this.slug = deps.cfg.slug
    this.tokens = new InstallationTokenService(deps.cfg, deps.clock, deps.fetchImpl, deps.baseUrl)
    this.repoPages = new LRUCache({
      ...cacheOptions(deps.clock, MAX_REPO_PAGE_CACHE_ENTRIES),
      ttl: REPO_PAGE_CACHE_MS,
      fetchMethod: async (_key, _stale, { context }) => {
        const token = await this.tokens.metadataToken(context.ins.installationId)
        const res = await githubRequest<{ total_count: number; repositories: GhRepo[] }>(
          `/installation/repositories?per_page=${context.perPage}&page=${context.page}`,
          { auth: token, fetchImpl: deps.fetchImpl, baseUrl: deps.baseUrl, bigIdsAsStrings: true }
        )
        return { repos: res.repositories, totalCount: res.total_count }
      }
    })
    this.stateKey = deriveInstallStateKey(deps.pepper)
    // 10 burst / 0.2 per sec (~12/min sustained) per key — far above any honest
    // daemon (mints are cached 45+ min per repo), far below GitHub's budget.
    this.mintBucket = new TokenBucket(10, 0.2, deps.clock)
  }

  /** Resolve once per CP process. A failed lookup disables attribution rather
   * than emitting an address GitHub may not associate with the App bot. */
  getGitCommitIdentity(): Promise<GitCommitIdentity | undefined> {
    return (this.gitCommitIdentityPromise ??= this.resolveGitCommitIdentity())
  }

  invalidateInstallationTokens(installationId: bigint): void {
    this.tokens.invalidateInstallation(installationId)
  }

  /** Installation/repository webhooks and explicit Sync calls invalidate every
   * cached page. A generation fence prevents an older in-flight page from
   * repopulating the cache after invalidation. */
  invalidateRepositoryRoster(installationId: bigint): void {
    const prefix = `${installationId}:`
    this.repoRosterGeneration.set(prefix, (this.repoRosterGeneration.get(prefix) ?? 0) + 1)
    for (const key of [...this.repoPages.keys()]) {
      if (key.startsWith(prefix)) this.repoPages.delete(key)
    }
  }

  // ── install flow ──────────────────────────────────────────────────────────

  /** One-shot, org-bound install deep link (`GET …/github/app`). */
  async installUrl(orgId: OrgId): Promise<string> {
    const minted = mintInstallState(this.stateKey, orgId, this.deps.clock)
    await this.deps.installState.put(minted.nonce, orgId, minted.expiresAt)
    return `https://github.com/apps/${this.slug}/installations/new?state=${encodeURIComponent(minted.state)}`
  }

  /**
   * Setup-callback claim: verify the signed state (one-shot nonce), then verify
   * the installation actually belongs to OUR App via an App-JWT read — GitHub's
   * own guidance is to never trust the callback's `installation_id`.
   * Returns null when the state is invalid/replayed. The caller must ask the
   * user to restart the org-bound install; Sync never guesses claim ownership.
   */
  async claimFromCallback(state: string, installationId: number): Promise<GithubInstallationRecord | null> {
    const parsed = verifyInstallState(this.stateKey, state, this.deps.clock)
    if (!parsed) return null
    if (!(await this.deps.installState.consume(parsed.nonce))) return null // replay / unknown
    const ins = await this.appRequest<GhInstallation>(`/app/installations/${installationId}`)
    this.outdatedInstallationsCache = undefined
    const row = await this.deps.installations.upsertFromGithub(OrgIdOf(parsed.orgId), toFacts(ins))
    this.tokens.invalidateInstallation(row.installationId)
    this.invalidateRepositoryRoster(row.installationId)
    await this.deps.onInstallationFactsChanged?.(row.installationId, row.orgId)
    return row
  }

  /** Refresh every durable claim belonging to the calling org.
   *
   * GitHub's App installation roster is deployment-global, not tenant-scoped.
   * Sync therefore pulls only ids already bound to this org; it never discovers
   * or claims an unknown installation. Missing ids are marked revoked, never
   * deleted, because agents retain provenance pointers.
   */
  async sync(orgId: OrgId): Promise<GithubInstallationRecord[]> {
    this.outdatedInstallationsCache = undefined
    const claims = await this.deps.installations.listClaimsForOrg(orgId)
    for (const claim of claims) await this.refreshClaimedInstallation(claim)
    return this.deps.installations.listForOrg(orgId)
  }

  /**
   * Remove one installation from GitHub. GitHub may already have removed it
   * (a concurrent request or an installation webhook won the race); 404/410
   * therefore mean the requested end state has already been reached.
   *
   * The caller owns the durable local revoke because the remote delete must
   * land first — a failed GitHub call must never make a still-live installation
   * disappear from AgentConnect's roster.
   */
  async uninstallInstallation(installationId: bigint): Promise<void> {
    try {
      await this.appRequest<void>(`/app/installations/${installationId}`, 'DELETE')
    } catch (e) {
      if (!(e instanceof GithubApiError) || (e.status !== 404 && e.status !== 410)) throw e
    }
    this.outdatedInstallationsCache = undefined
    this.invalidateRepositoryRoster(installationId)
  }

  /**
   * Live permission-health probe. GitHub keeps installations on their old
   * permission set until an account owner approves the App's newer request;
   * `GET /app/installations?outdated=true` is the authoritative list of those
   * installations. The map value is GitHub's own settings URL, used by the
   * console's "Update permissions" link.
   */
  async outdatedInstallations(force = false): Promise<ReadonlyMap<string, string>> {
    const now = this.deps.clock.now()
    if (!force && this.outdatedInstallationsCache && this.outdatedInstallationsCache.expiresAt > now) {
      return this.outdatedInstallationsCache.settingsUrlsByInstallationId
    }

    const settingsUrlsByInstallationId = new Map<string, string>()
    for (let page = 1; page <= 10; page++) {
      const batch = await this.appRequest<GhInstallation[]>(
        `/app/installations?outdated=true&per_page=100&page=${page}`
      )
      for (const ins of batch) {
        if (ins.html_url) settingsUrlsByInstallationId.set(String(ins.id), ins.html_url)
        else settingsUrlsByInstallationId.set(String(ins.id), '')
      }
      if (batch.length < 100) break
    }

    this.outdatedInstallationsCache = {
      expiresAt: now + OUTDATED_INSTALLATIONS_CACHE_MS,
      settingsUrlsByInstallationId
    }
    return settingsUrlsByInstallationId
  }

  // ── picker proxies ────────────────────────────────────────────────────────

  async listRepos(ins: GithubInstallationRecord, page: number, perPage: number): Promise<GhRepoPage> {
    const prefix = `${ins.installationId}:`
    const generation = this.repoRosterGeneration.get(prefix) ?? 0
    const key = `${prefix}${generation}:${page}:${perPage}`
    const value = await this.repoPages.fetch(key, { context: { ins, page, perPage } })
    // A roster invalidation that lands while this page was in flight bumped the
    // generation, so the answer describes a roster nobody will ask for again.
    // The key already makes it unreachable; dropping it keeps it from occupying
    // the cache until eviction.
    if ((this.repoRosterGeneration.get(prefix) ?? 0) !== generation) this.repoPages.delete(key)
    if (!value) throw new Error('github repository page lookup produced no result')
    return value
  }

  /** Resolve a rename-proof repository id to its current canonical name. The
   * installation metadata token proves the repository is still in the App's
   * grant; a genuine miss is a durable deny, while provider failures bubble. */
  async repoRefById(
    ins: GithubInstallationRecord,
    repoId: bigint
  ): Promise<{ repoId: bigint; fullName: string; private: boolean; defaultBranch: string } | null> {
    const token = await this.tokens.metadataToken(ins.installationId)
    try {
      const repo = await githubRequest<GhRepo>(`/repositories/${repoId}`, {
        auth: token,
        fetchImpl: this.deps.fetchImpl,
        baseUrl: this.deps.baseUrl,
        bigIdsAsStrings: true
      })
      if (BigInt(repo.id) !== repoId) return null
      return {
        repoId,
        fullName: repo.full_name,
        private: repo.private,
        defaultBranch: repo.default_branch
      }
    } catch (err) {
      if (err instanceof GithubApiError && (err.status === 404 || err.status === 422)) return null
      throw err
    }
  }

  /** Branch names for the picker — needs contents:read (metadata-only 403s). */
  async listBranches(ins: GithubInstallationRecord, owner: string, repo: string): Promise<string[]> {
    const cred = await this.tokens.mint(ins.installationId, `${owner}/${repo}`, 'read')
    const branches = await githubRequest<Array<{ name: string }>>(`/repos/${owner}/${repo}/branches?per_page=100`, {
      auth: cred.token,
      fetchImpl: this.deps.fetchImpl,
      baseUrl: this.deps.baseUrl
    })
    return branches.map((b) => b.name)
  }

  /**
   * Best-effort scan of a skills source repo (docs/designs/shared-skills.md §3/§7):
   * tag names for the ref picker + the `SKILL.md` manifest so the console can offer
   * a per-skill checklist. Skill discovery mirrors the pinned CLI's layout probe:
   * the first matching layout wins (`skills/<skill>/SKILL.md`, then top-level
   * `<skill>/SKILL.md`, then `.claude/skills/<skill>/SKILL.md`, then a root
   * `SKILL.md`). Names come from the skill directory; frontmatter is NOT read here
   * (best-effort — the daemon's bundled exact CLI is the authority). Needs contents:read.
   */
  async scanSkillSource(
    ins: GithubInstallationRecord,
    owner: string,
    repo: string,
    ref?: string,
    subDir?: string
  ): Promise<{ tags: string[]; skills: Array<{ name: string; dirPath: string }> }> {
    const cred = await this.tokens.mint(ins.installationId, `${owner}/${repo}`, 'read')
    const auth = { auth: cred.token, fetchImpl: this.deps.fetchImpl, baseUrl: this.deps.baseUrl }
    const tags = await githubRequest<Array<{ name: string }>>(`/repos/${owner}/${repo}/tags?per_page=100`, auth)
      .then((rows) => rows.map((t) => t.name))
      .catch(() => [])
    const tree = await githubRequest<{ tree: Array<{ path: string; type: string }> }>(
      `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref ?? 'HEAD')}?recursive=1`,
      auth
    ).catch(() => ({ tree: [] as Array<{ path: string; type: string }> }))
    let skillPaths = tree.tree.filter((e) => e.type === 'blob' && e.path.endsWith('SKILL.md')).map((e) => e.path)
    // Scope discovery to the source's subdirectory (the same scope `composeSource`
    // installs from) so a `packages/foo` source reports ITS skills, not the repo
    // root's. Layout detection then runs relative to the subdir.
    const prefix = subDir?.replace(/^\/+|\/+$/g, '')
    if (prefix) {
      skillPaths = skillPaths.filter((p) => p.startsWith(`${prefix}/`)).map((p) => p.slice(prefix.length + 1))
    }
    return { tags, skills: pickSkillLayout(skillPaths) }
  }

  /** Create-time check: can this installation reach `owner/repo` at all?
   *  (Covers both `all` and `selected` grants: an out-of-grant repo reads 404.) */
  async installationCoversRepo(ins: GithubInstallationRecord, owner: string, repo: string): Promise<boolean> {
    return (await this.getRepoMeta(ins, owner, repo)) !== null
  }

  /** Repo metadata through the installation's metadata token; null when the
   *  installation can't see the repo (out of grant / gone — both read 404). */
  async getRepoMeta(
    ins: GithubInstallationRecord,
    owner: string,
    repo: string
  ): Promise<{ private: boolean; defaultBranch: string } | null> {
    const ref = await this.repoRefFor(ins, owner, repo)
    return ref ? { private: ref.private, defaultBranch: ref.defaultBranch } : null
  }

  /**
   * Hook-create-time repo reference: the NUMERIC repo id (the relay's
   * rename-immune match key, webhook-triggers decision 6) plus the canonical
   * full name as GitHub cases it. Resolving through the installation's own
   * metadata token IS the attribution proof — an out-of-grant repo reads 404
   * (null), same as `getRepoMeta`.
   */
  async repoRefFor(
    ins: GithubInstallationRecord,
    owner: string,
    repo: string
  ): Promise<{ repoId: bigint; fullName: string; private: boolean; defaultBranch: string } | null> {
    return this.repoRefForWithPolicy(ins, owner, repo, 'legacy')
  }

  /** Authorization-specific repository lookup. Only a genuine missing or
   * invalid subject is a definitive miss; credential/config failures must
   * remain operational errors for the caller to report as retryable. */
  async repoRefForCommentAuthz(
    ins: GithubInstallationRecord,
    owner: string,
    repo: string
  ): Promise<{ repoId: bigint; fullName: string; private: boolean; defaultBranch: string } | null> {
    return this.repoRefForWithPolicy(ins, owner, repo, 'comment-authz')
  }

  private async repoRefForWithPolicy(
    ins: GithubInstallationRecord,
    owner: string,
    repo: string,
    policy: 'legacy' | 'comment-authz'
  ): Promise<{ repoId: bigint; fullName: string; private: boolean; defaultBranch: string } | null> {
    const token = await this.tokens.metadataToken(ins.installationId)
    try {
      const meta = await githubRequest<{ id: number; full_name: string; private: boolean; default_branch: string }>(
        `/repos/${owner}/${repo}`,
        {
          auth: token,
          fetchImpl: this.deps.fetchImpl,
          baseUrl: this.deps.baseUrl
        }
      )
      return {
        repoId: BigInt(meta.id),
        fullName: meta.full_name,
        private: meta.private,
        defaultBranch: meta.default_branch
      }
    } catch (e) {
      if (
        e instanceof GithubApiError &&
        (policy === 'comment-authz' ? e.status === 404 || e.status === 422 : !e.retryable)
      ) {
        return null
      }
      throw e
    }
  }

  /**
   * The App's recent webhook deliveries, newest first (P2.5 redelivery
   * reconciliation). Follows the Link cursor until `deliveredSince` is reached
   * — one page is a few minutes of traffic on a busy App, far less than the
   * reconciler's look-back window — and stops at `maxPages` so a firehose
   * bounds the sweep instead of the sweep bounding itself. The caller sees how
   * far back the result actually reaches and reports the shortfall.
   */
  async listHookDeliveries(
    opts: { perPage?: number; maxPages?: number; deliveredSince?: Date } = {}
  ): Promise<GhHookDeliveryPage> {
    const floorMs = opts.deliveredSince?.getTime()
    const deliveries: GhHookDelivery[] = []
    // bigIdsAsStrings: delivery ids overflow Number.MAX_SAFE_INTEGER — see GhHookDelivery.id.
    let path = `/app/hook/deliveries?per_page=${opts.perPage ?? 100}`
    for (let page = 0; page < (opts.maxPages ?? MAX_DELIVERY_PAGES); page++) {
      const rep: GithubPage<GhHookDelivery[]> = await this.appRequestPage<GhHookDelivery[]>(path, true)
      deliveries.push(...rep.data)
      const oldest = rep.data[rep.data.length - 1]
      // No cursor left, or this page already reaches past the floor: complete.
      if (!rep.nextPath || !oldest) return { deliveries, truncated: false }
      if (floorMs !== undefined && Date.parse(oldest.delivered_at) <= floorMs) return { deliveries, truncated: false }
      path = rep.nextPath
    }
    return { deliveries, truncated: true }
  }

  /** Ask GitHub to redeliver one delivery (202; lands on the relay pool again —
   *  every downstream step is idempotent on the delivery GUID). */
  async redeliverHookDelivery(deliveryId: string): Promise<void> {
    // The id is server-provided, but it rides a URL path — keep the guard cheap and absolute.
    if (!/^\d+$/.test(deliveryId)) throw new GithubApiError(`bad delivery id: ${deliveryId}`, 0, 'INTERNAL', false)
    await this.appRequest<unknown>(`/app/hook/deliveries/${deliveryId}/attempts`, 'POST')
  }

  /**
   * Doorbell source-of-truth pull (webhook-triggers decision 11): the poke only
   * says WHICH installation changed; this read decides WHAT is true now.
   * null ⇒ GitHub says the installation is gone (404/410) — mark revoked.
   */
  async pullInstallation(installationId: bigint): Promise<GithubInstallationFacts | null> {
    try {
      const ins = await this.appRequest<GhInstallation>(`/app/installations/${installationId}`)
      this.outdatedInstallationsCache = undefined
      return toFacts(ins)
    } catch (e) {
      if (e instanceof GithubApiError && (e.status === 404 || e.status === 410)) {
        this.outdatedInstallationsCache = undefined
        return null
      }
      throw e
    }
  }

  /**
   * Reconcile one already-claimed installation from GitHub's App-JWT source of
   * truth. This is the mint/write-denial fallback for permission changes that
   * race or lose their webhook doorbell; an unknown id is never auto-claimed.
   */
  async refreshInstallationFacts(installationId: bigint): Promise<GithubInstallationRecord | null> {
    const claimed = await this.deps.installations.getByInstallationId(installationId)
    if (!claimed) return null
    return this.refreshClaimedInstallation(claimed)
  }

  private async refreshClaimedInstallation(
    claimed: GithubInstallationRecord
  ): Promise<GithubInstallationRecord | null> {
    const { installationId, orgId } = claimed
    const facts = await this.pullInstallation(installationId)
    let refreshed: GithubInstallationRecord | null = null
    if (facts) {
      refreshed = await this.deps.installations.upsertFromGithub(orgId, facts)
    } else {
      await this.deps.installations.markRevokedByInstallationId(installationId)
    }
    this.tokens.invalidateInstallation(installationId)
    this.invalidateRepositoryRoster(installationId)
    await this.deps.onInstallationFactsChanged?.(installationId, orgId)
    return refreshed
  }

  /** A GitHub user's effective permission on `owner/repo` (team/org-derived included), asked with
   *  the installation's own Metadata:read token (open question #7's identity-assertion leg).
   *  gitAccess wants GitHub's legacy granularity, where triage is not repository write. */
  async userRepoPermission(
    ins: GithubInstallationRecord,
    owner: string,
    repo: string,
    username: string
  ): Promise<'admin' | 'write' | 'read' | 'none'> {
    const role = await this.userRepoPermissionWithPolicy(ins, owner, repo, username, 'legacy')
    return role === 'triage' ? 'read' : role
  }

  /** Authorization-specific permission lookup with the same strict error
   * policy as {@link repoRefForCommentAuthz}. */
  async userRepoPermissionForCommentAuthz(
    ins: GithubInstallationRecord,
    owner: string,
    repo: string,
    username: string
  ): Promise<GithubRepoRole> {
    return this.userRepoPermissionWithPolicy(ins, owner, repo, username, 'comment-authz')
  }

  private async userRepoPermissionWithPolicy(
    ins: GithubInstallationRecord,
    owner: string,
    repo: string,
    username: string,
    policy: 'legacy' | 'comment-authz'
  ): Promise<GithubRepoRole> {
    const token = await this.tokens.metadataToken(ins.installationId)
    try {
      const res = await githubRequest<{ permission?: string; role_name?: string }>(
        `/repos/${owner}/${repo}/collaborators/${encodeURIComponent(username)}/permission`,
        { auth: token, fetchImpl: this.deps.fetchImpl, baseUrl: this.deps.baseUrl }
      )
      // The legacy `permission` field collapses maintain→write and triage→read; the built-in
      // triage role is only visible in `role_name`, and a custom role never matches it exactly.
      if (res.role_name === 'triage') return 'triage'
      const p = res.permission
      return p === 'admin' || p === 'write' || p === 'read' ? p : 'none'
    } catch (e) {
      if (
        e instanceof GithubApiError &&
        (policy === 'comment-authz' ? e.status === 404 || e.status === 422 : !e.retryable)
      ) {
        return 'none'
      }
      throw e
    }
  }

  // ── gitcred mint resolution (WS handler; DATA-PLANE — viewer-free reads) ──

  /**
   * agent → repo owner → live installation → repo-scoped token. Installation
   * resolution goes by ACCOUNT LOGIN against live rows (the agent's stored
   * `installationId` is provenance only) — an uninstall→reinstall self-heals.
   * `capabilities` (P2.5 write-back) widen the scope set; the repo tier clamps each
   * one (read workspace ⇒ read-only issues/PR scopes and no Actions;
   * write workspace ⇒ Actions write).
   *
   * `requestedRepo` (issue #457): absent / equal to an App-backed workspace repo
   * ⇒ the workspace path above, byte-identical. Any OTHER repo must be covered
   * by an AgentRepoAuthorization row — including every repo used from a scratch
   * workspace. Rows match by full name (fast path) or, after a rename, by
   * NUMERIC repo id through the owner's installation. Each repo resolves its own
   * installation, so grants span installations naturally; the row's access tier
   * drives the per-capability clamp. No row ⇒ SCOPE_DENIED — the daemon treats a
   * repo-keyed denial as a short-TTL negative, not the agent-terminal kind.
   *
   * `requestedAccess` is the v2 access FLOOR (gitlab-com-integration.md §17.1): a caller may ask for
   * LESS than the tier, never more. Absent ⇒ the tier itself, which is what every GitHub caller asks
   * for today, so the pre-v2 request shape resolves exactly as it did before.
   */
  async mintForAgent(
    agent: AgentRecord,
    bucketKeys: string[],
    capabilities?: readonly GitCredCapability[],
    requestedRepo?: string,
    requestedAccess?: GitAccess
  ): Promise<MintedGitCred> {
    const workspace = agent.workspace
    let label: string | undefined
    if (workspace.mode === 'github') {
      if (workspace.installationId === undefined) {
        throw new GitCredDeniedError('agent workspace is not github-app mode', 'SCOPE_DENIED', false)
      }
      label = gitRepoLabel(workspace.gitRepo)
    } else if (requestedRepo === undefined) {
      throw new GitCredDeniedError('scratch workspace has no default github repository', 'SCOPE_DENIED', false)
    }
    for (const key of bucketKeys) {
      if (!this.mintBucket.take(key)) {
        throw new GitCredDeniedError('gitcred mint rate exceeded — backing off', 'RATE_LIMITED', true)
      }
    }
    const requested = requestedRepo ?? label
    if (!requested) {
      throw new GitCredDeniedError('agent has no default github repository', 'SCOPE_DENIED', false)
    }
    const resolved = await this.resolveAgentRepoAuthorizationByName(agent, requested)
    const tier = REPO_ACCESS_LEVELS[resolved.access]
    const wanted = capabilities ?? (['contents'] as const)
    const levels: CapabilityLevels = {}
    for (const cap of new Set(wanted)) {
      const level = tier[cap]
      if (level) levels[cap] = requestedAccess === 'read' ? 'read' : level
    }
    try {
      return await this.tokens.mintLevels(
        resolved.installation.installationId,
        resolved.repoFullName,
        levels,
        resolved.repoId
      )
    } catch (e) {
      if (e instanceof GithubApiError) throw new GitCredDeniedError(e.message, e.code, e.retryable)
      throw e
    }
  }

  /**
   * A COMMENT-only token for the daemon-owned GithubPoster. The caller must
   * first prove that this agent has an enabled GitHub hook for the repo. This
   * token never enters the agent environment, so its issues/PR write scopes are
   * deliberately independent of the workspace contents `gitAccess`: a read-
   * only workspace can still publish the hook's promised final reply without
   * gaining code write access.
   *
   * `repoId` comes from the authorized hook and keeps the token scope stable
   * across repository renames; legacy hooks without it fall back to name scope.
   * `forceRefresh` is set only after GitHub rejects a cached grant.
   */
  async mintForHookReply(
    agent: AgentRecord,
    repoFullName: string,
    repoId: bigint | undefined,
    bucketKeys: string[],
    forceRefresh = false
  ): Promise<MintedGitCred> {
    const [owner, repo] = repoFullName.split('/')
    if (!owner || !repo) {
      throw new GitCredDeniedError(`not an owner/repo reference (${repoFullName})`, 'SCOPE_DENIED', false)
    }
    for (const key of bucketKeys) {
      if (!this.mintBucket.take(key)) {
        throw new GitCredDeniedError('gitcred mint rate exceeded — backing off', 'RATE_LIMITED', true)
      }
    }
    const ins = await this.deps.installations.liveByOrgAndAccount(agent.orgId, owner)
    if (!ins || ins.orgId !== agent.orgId) {
      throw new GitCredDeniedError(`no live github installation covers ${owner}`, 'LEASE_DENIED', false)
    }
    if (ins.suspendedAt) {
      throw new GitCredDeniedError('github installation is suspended', 'LEASE_DENIED', false)
    }
    try {
      return await this.tokens.mintLevels(
        ins.installationId,
        repoFullName,
        { issues: 'write', pull_requests: 'write' },
        repoId,
        forceRefresh
      )
    } catch (e) {
      if (e instanceof GithubApiError) throw new GitCredDeniedError(e.message, e.code, e.retryable)
      throw e
    }
  }

  /**
   * Shared repo-id-first authorization resolver for gitcred, formal reviews,
   * and CP-owned Checks. A repo name is only an endpoint/display hint: the
   * numeric GitHub id must match either the workspace id or an explicit grant.
   */
  async resolveAgentRepoAuthorization(
    agent: AgentRecord,
    repoId: bigint,
    repoFullName: string
  ): Promise<ResolvedAgentRepoAuthorization> {
    const [owner, repo] = repoFullName.split('/')
    if (!owner || !repo) throw new GitCredDeniedError('invalid github repository name', 'SCOPE_DENIED', false)
    const installation = await this.deps.installations.liveByOrgAndAccount(agent.orgId, owner)
    if (!installation || installation.orgId !== agent.orgId) {
      throw new GitCredDeniedError(`no live github installation covers ${owner}`, 'LEASE_DENIED', false)
    }
    if (installation.suspendedAt) {
      throw new GitCredDeniedError('github installation is suspended', 'LEASE_DENIED', false)
    }
    const ref = await this.repoRefFor(installation, owner, repo)
    if (!ref || ref.repoId !== repoId) {
      throw new GitCredDeniedError(
        `${repoFullName} no longer resolves to the authorized repository`,
        'SCOPE_DENIED',
        false
      )
    }

    const workspace = agent.workspace
    if (workspace.mode === 'github' && workspace.installationId !== undefined) {
      let workspaceRepoId = agent.workspaceRepoId
      if (workspaceRepoId === undefined) {
        const workspaceLabel = gitRepoLabel(workspace.gitRepo)
        const [workspaceOwner, workspaceRepo] = workspaceLabel.split('/')
        if (workspaceOwner && workspaceRepo) {
          const workspaceInstallation = await this.deps.installations.liveByOrgAndAccount(agent.orgId, workspaceOwner)
          if (workspaceInstallation && !workspaceInstallation.suspendedAt) {
            const workspaceRef = await this.repoRefFor(workspaceInstallation, workspaceOwner, workspaceRepo)
            workspaceRepoId = workspaceRef?.repoId
            if (workspaceRepoId !== undefined) {
              const persisted = await this.deps.agents?.setWorkspaceRepoId(agent.id, workspaceRepoId)
              if (persisted === false) {
                throw new GitCredDeniedError(
                  'workspace repository identity changed concurrently',
                  'SCOPE_DENIED',
                  false
                )
              }
            }
          }
        }
      }
      if (workspaceRepoId === repoId) {
        return {
          kind: 'workspace',
          repoId,
          repoFullName: ref.fullName,
          access: workspace.gitAccess ?? 'write',
          installation
        }
      }
    }

    // Grants are provider-qualified: a GitLab project sharing this numeric id is a different repository.
    const auth = (await this.deps.repoAuths?.listForAgent(agent.id))?.find(
      (row) => row.provider === 'github' && row.repoId === repoId
    )
    if (!auth) {
      throw new GitCredDeniedError(
        `${repoFullName} is not authorized for this agent — add it under the agent's Repositories settings`,
        'SCOPE_DENIED',
        false
      )
    }
    if (auth.repoFullName !== ref.fullName) {
      await this.deps.repoAuths?.updateFullName(auth.id, ref.fullName).catch(() => {})
    }
    return { kind: 'additional', repoId, repoFullName: ref.fullName, access: auth.access, installation }
  }

  /** Action-time review capability: COMMENT accepts additional comment/write;
   * REQUEST_CHANGES/APPROVE and every workspace review require write. */
  async validateReviewForAgent(
    agent: AgentRecord,
    repoId: bigint,
    repoFullName: string,
    event: 'COMMENT' | 'REQUEST_CHANGES' | 'APPROVE'
  ): Promise<ResolvedAgentRepoAuthorization> {
    const resolved = await this.resolveAgentRepoAuthorization(agent, repoId, repoFullName)
    const allowed =
      resolved.access === 'write' ||
      (resolved.kind === 'additional' && resolved.access === 'comment' && event === 'COMMENT')
    if (!allowed) {
      throw new GitCredDeniedError(`repository authorization does not allow ${event}`, 'SCOPE_DENIED', false)
    }
    // Persisted installation-effective permissions are the authority. A
    // legacy empty snapshot is unknown and must fail closed until Sync or an
    // installation doorbell refreshes it.
    if (resolved.installation.permissions?.pull_requests !== 'write') {
      throw new GitCredDeniedError('GitHub installation has not accepted pull_requests:write', 'LEASE_DENIED', false)
    }
    return resolved
  }

  async mintReviewForAgent(
    agent: AgentRecord,
    repoId: bigint,
    repoFullName: string,
    event: 'COMMENT' | 'REQUEST_CHANGES' | 'APPROVE'
  ): Promise<MintedGitCred & { installationId: bigint }> {
    const resolved = await this.validateReviewForAgent(agent, repoId, repoFullName, event)
    try {
      const cred = await this.tokens.mintLevels(
        resolved.installation.installationId,
        resolved.repoFullName,
        { pull_requests: 'write' },
        resolved.repoId
      )
      return { ...cred, installationId: resolved.installation.installationId }
    } catch (e) {
      if (e instanceof GithubApiError) throw new GitCredDeniedError(e.message, e.code, e.retryable)
      throw e
    }
  }

  /**
   * The repo + live installation behind an agent's PRIMARY workspace checkout, for a reader that has
   * only a repo NAME and no hook run to take identity from (webchat-side-panels.md §12.6). Absence is
   * DATA here — a scratch workspace, a revoked or suspended installation and a repo out of the grant
   * set all read `null` rather than throwing, because the caller's answer to any of them is the same
   * "no pull request to name". The numeric id is the agent's captured one where it has one, and is
   * repaired through the installation's metadata token where it does not.
   */
  async resolveWorkspaceRepo(
    agent: AgentRecord
  ): Promise<{ repoId: bigint; repoFullName: string; installationId: bigint } | null> {
    const workspace = agent.workspace
    if (workspace.mode !== 'github' || workspace.installationId === undefined) return null
    const label = gitRepoLabel(workspace.gitRepo)
    const [owner, repo] = label.split('/')
    if (!owner || !repo) return null
    // By ACCOUNT LOGIN against live rows, like every other mint path: the stored installationId is
    // provenance only, so an uninstall→reinstall self-heals here too.
    const installation = await this.deps.installations.liveByOrgAndAccount(agent.orgId, owner)
    if (!installation || installation.orgId !== agent.orgId || installation.suspendedAt) return null
    if (agent.workspaceRepoId !== undefined) {
      return { repoId: agent.workspaceRepoId, repoFullName: label, installationId: installation.installationId }
    }
    try {
      const ref = await this.repoRefFor(installation, owner, repo)
      if (!ref) return null
      // Best-effort repair, exactly as resolveAgentRepoAuthorization does it: a losing race just
      // means the next read resolves the id again, which is cheaper than failing this one.
      await this.deps.agents?.setWorkspaceRepoId(agent.id, ref.repoId).catch(() => {})
      return { repoId: ref.repoId, repoFullName: ref.fullName, installationId: installation.installationId }
    } catch {
      return null
    }
  }

  /** Whether the console may arm auto-merge for this agent's PR — the GET projection's per-caller
   *  capability flag, Postgres-only (no GitHub call): a read/comment tier renders a disabled control. */
  async canArmAutoMerge(agent: AgentRecord, repoId: bigint, repoFullName: string): Promise<boolean> {
    try {
      const resolved = await this.resolveAgentRepoAuthorization(agent, repoId, repoFullName)
      return resolved.access === 'write' && resolved.installation.permissions?.pull_requests === 'write'
    } catch {
      return false
    }
  }

  /** Auto-merge arm/disarm capability: arming merges code, so nothing below write tier qualifies —
   *  the additional-repo comment tier that may COMMENT-review is deliberately excluded here. */
  async mintAutoMergeForAgent(
    agent: AgentRecord,
    repoId: bigint,
    repoFullName: string
  ): Promise<MintedGitCred & { installationId: bigint }> {
    const resolved = await this.resolveAgentRepoAuthorization(agent, repoId, repoFullName)
    if (resolved.access !== 'write') {
      throw new GitCredDeniedError('repository authorization does not allow auto-merge', 'SCOPE_DENIED', false)
    }
    if (resolved.installation.permissions?.pull_requests !== 'write') {
      throw new GitCredDeniedError('GitHub installation has not accepted pull_requests:write', 'LEASE_DENIED', false)
    }
    try {
      // contents rides along because GitHub performs the eventual merge under this app's grant.
      const cred = await this.tokens.mintLevels(
        resolved.installation.installationId,
        resolved.repoFullName,
        { pull_requests: 'write', contents: 'write' },
        resolved.repoId
      )
      return { ...cred, installationId: resolved.installation.installationId }
    } catch (e) {
      if (e instanceof GithubApiError) throw new GitCredDeniedError(e.message, e.code, e.retryable)
      throw e
    }
  }

  /** CP-only reporter capability. Reporting always requires write-level agent
   * authorization plus exact checks:write and pull_requests:read-or-write
   * installation facts. The latter gates the live commit -> PR barrier. */
  async mintChecksForAgent(
    agent: AgentRecord,
    repoId: bigint,
    repoFullName: string
  ): Promise<{ cred: MintedGitCred; resolved: ResolvedAgentRepoAuthorization }> {
    let resolved = await this.resolveAgentRepoAuthorization(agent, repoId, repoFullName)
    if (resolved.access !== 'write') {
      throw new GitCredDeniedError('informational Checks require write repository authorization', 'SCOPE_DENIED', false)
    }
    if (!hasChecksReporterPermissions(resolved.installation)) {
      const refreshed = await this.refreshInstallationFacts(resolved.installation.installationId)
      if (!refreshed || refreshed.suspendedAt || refreshed.revokedAt || !hasChecksReporterPermissions(refreshed)) {
        throw new GitCredDeniedError(
          'GitHub installation has not accepted checks:write and pull_requests:read',
          'LEASE_DENIED',
          false
        )
      }
      resolved = { ...resolved, installation: refreshed }
    }
    const minted = await this.mintChecksWithFactsRetry(resolved.installation, resolved.repoFullName, resolved.repoId)
    resolved = { ...resolved, installation: minted.installation }
    return { cred: minted.cred, resolved }
  }

  /** Cleanup-only Checks capability for a tombstoned projection after its
   * Agent or per-repository authorization has been deleted. The durable
   * projection supplies org + numeric repo identity; this method still
   * re-resolves the live installation and repo id and never trusts last-known
   * installation provenance. */
  async mintChecksForProjectionCleanup(
    orgId: OrgId,
    repoId: bigint,
    repoFullName: string
  ): Promise<{
    cred: MintedGitCred
    repoId: bigint
    repoFullName: string
    installation: GithubInstallationRecord
  }> {
    const [owner, repo] = repoFullName.split('/')
    if (!owner || !repo) throw new GitCredDeniedError('invalid github repository name', 'SCOPE_DENIED', false)
    let installation = await this.deps.installations.liveByOrgAndAccount(orgId, owner)
    if (!installation || installation.suspendedAt) {
      throw new GitCredDeniedError(`no live github installation covers ${owner}`, 'LEASE_DENIED', false)
    }
    const ref = await this.repoRefFor(installation, owner, repo)
    if (!ref || ref.repoId !== repoId) {
      throw new GitCredDeniedError('tombstoned projection repository identity changed', 'SCOPE_DENIED', false)
    }
    if (!hasChecksReporterPermissions(installation)) {
      const refreshed = await this.refreshInstallationFacts(installation.installationId)
      if (!refreshed || refreshed.suspendedAt || refreshed.revokedAt || !hasChecksReporterPermissions(refreshed)) {
        throw new GitCredDeniedError(
          'GitHub installation has not accepted checks:write and pull_requests:read',
          'LEASE_DENIED',
          false
        )
      }
      installation = refreshed
    }
    const minted = await this.mintChecksWithFactsRetry(installation, ref.fullName, repoId)
    return { cred: minted.cred, repoId, repoFullName: ref.fullName, installation: minted.installation }
  }

  private async resolveAgentRepoAuthorizationByName(
    agent: AgentRecord,
    repoFullName: string
  ): Promise<NamedAgentRepoAuthorization> {
    const [owner, repo] = repoFullName.split('/')
    if (!owner || !repo) throw new GitCredDeniedError('invalid github repository name', 'SCOPE_DENIED', false)

    const workspace = agent.workspace
    let workspaceLabel: string | undefined
    let workspaceOwner: string | undefined
    if (workspace.mode === 'github') {
      if (workspace.installationId === undefined) {
        throw new GitCredDeniedError('agent workspace is not github-app mode', 'SCOPE_DENIED', false)
      }
      workspaceLabel = gitRepoLabel(workspace.gitRepo)
      workspaceOwner = workspaceLabel.split('/')[0]
      if (workspaceLabel.toLowerCase() === repoFullName.toLowerCase()) {
        const installation = await this.deps.installations.liveByOrgAndAccount(agent.orgId, workspaceOwner!)
        if (!installation || installation.suspendedAt) {
          throw new GitCredDeniedError(`no live github installation covers ${workspaceOwner}`, 'LEASE_DENIED', false)
        }
        return {
          kind: 'workspace',
          ...(agent.workspaceRepoId !== undefined ? { repoId: agent.workspaceRepoId } : {}),
          repoFullName: workspaceLabel,
          access: workspace.gitAccess ?? 'write',
          installation
        }
      }
    }

    const grants = ((await this.deps.repoAuths?.listForAgent(agent.id)) ?? []).filter(
      (row) => row.provider === 'github'
    )
    const exact = grants.find((row) => row.repoFullName.toLowerCase() === repoFullName.toLowerCase())
    // Never probe an unrelated owner merely because the daemon named it. A
    // same-owner grant is enough to justify the slow rename lookup below.
    const renameCandidates = grants.filter(
      (row) => row.repoFullName.split('/')[0]?.toLowerCase() === owner.toLowerCase()
    )
    const workspaceRenameCandidate =
      agent.workspaceRepoId !== undefined && workspaceOwner?.toLowerCase() === owner.toLowerCase()
    if (!exact && renameCandidates.length === 0 && !workspaceRenameCandidate) {
      throw new GitCredDeniedError(`${repoFullName} is not authorized for this agent`, 'SCOPE_DENIED', false)
    }

    const installation = await this.deps.installations.liveByOrgAndAccount(agent.orgId, owner)
    if (!installation || installation.suspendedAt) {
      throw new GitCredDeniedError(`no live github installation covers ${owner}`, 'LEASE_DENIED', false)
    }
    if (exact) {
      return {
        kind: 'additional',
        repoId: exact.repoId,
        repoFullName,
        access: exact.access,
        installation
      }
    }

    const ref = await this.repoRefFor(installation, owner, repo)
    if (!ref) throw new GitCredDeniedError(`${repoFullName} is not covered by the installation`, 'SCOPE_DENIED', false)
    if (workspace.mode === 'github' && workspaceRenameCandidate && ref.repoId === agent.workspaceRepoId) {
      return {
        kind: 'workspace',
        repoId: agent.workspaceRepoId,
        repoFullName,
        access: workspace.gitAccess ?? 'write',
        installation
      }
    }
    const renamed = renameCandidates.find((row) => row.repoId === ref.repoId)
    if (!renamed) {
      throw new GitCredDeniedError(`${repoFullName} is not authorized for this agent`, 'SCOPE_DENIED', false)
    }
    if (renamed.repoFullName !== ref.fullName) {
      await this.deps.repoAuths?.updateFullName(renamed.id, ref.fullName).catch(() => {})
    }
    return {
      kind: 'additional',
      repoId: renamed.repoId,
      repoFullName,
      access: renamed.access,
      installation
    }
  }

  private async mintChecksWithFactsRetry(
    installation: GithubInstallationRecord,
    repoFullName: string,
    repoId: bigint
  ): Promise<{ cred: MintedGitCred; installation: GithubInstallationRecord }> {
    try {
      const cred = await this.tokens.mintChecks(installation.installationId, repoFullName, repoId)
      return { cred, installation }
    } catch (error) {
      if (!(error instanceof GithubApiError)) throw error
      if (!isInstallationFactsDenial(error)) {
        throw new GitCredDeniedError(error.message, error.code, error.retryable)
      }

      this.tokens.invalidateInstallation(installation.installationId)
      let refreshed: GithubInstallationRecord | null
      try {
        refreshed = await this.refreshInstallationFacts(installation.installationId)
      } catch {
        // The facts GET itself was unavailable. A durable reporter retry may
        // safely retry token minting because GitHub returned a definite denial.
        throw new GitCredDeniedError(error.message, error.code, true)
      }
      if (!refreshed || refreshed.suspendedAt || refreshed.revokedAt || !hasChecksReporterPermissions(refreshed)) {
        throw new GitCredDeniedError(
          'GitHub installation has not accepted checks:write and pull_requests:read',
          'LEASE_DENIED',
          false
        )
      }
      try {
        const cred = await this.tokens.mintChecks(refreshed.installationId, repoFullName, repoId)
        return { cred, installation: refreshed }
      } catch (retryError) {
        if (retryError instanceof GithubApiError) {
          throw new GitCredDeniedError(retryError.message, retryError.code, retryError.retryable)
        }
        throw retryError
      }
    }
  }

  private async appRequest<T>(
    path: string,
    method: 'GET' | 'POST' | 'DELETE' = 'GET',
    bigIdsAsStrings = false
  ): Promise<T> {
    return (await this.appRequestPage<T>(path, bigIdsAsStrings, method)).data
  }

  /** {@link appRequest} keeping the `rel="next"` cursor (paginated list reads). */
  private async appRequestPage<T>(
    path: string,
    bigIdsAsStrings = false,
    method: 'GET' | 'POST' | 'DELETE' = 'GET'
  ): Promise<GithubPage<T>> {
    const jwt = await mintAppJwt(this.deps.cfg)
    return githubRequestPage<T>(path, {
      method,
      auth: jwt,
      fetchImpl: this.deps.fetchImpl,
      baseUrl: this.deps.baseUrl,
      bigIdsAsStrings
    })
  }

  private async resolveGitCommitIdentity(): Promise<GitCommitIdentity | undefined> {
    const login = `${this.slug}[bot]`
    try {
      // Public endpoint: no App JWT or installation token is needed, and the
      // process-level promise above keeps this to one request per CP instance.
      const user = await githubRequest<GhUser>(`/users/${encodeURIComponent(login)}`, {
        auth: null,
        fetchImpl: this.deps.fetchImpl,
        baseUrl: this.deps.baseUrl
      })
      if (
        !Number.isSafeInteger(user.id) ||
        user.id <= 0 ||
        user.type !== 'Bot' ||
        user.login.toLowerCase() !== login.toLowerCase()
      ) {
        throw new Error(`unexpected GitHub user response for ${login}`)
      }
      return githubAppBotIdentity(this.slug, user.id)
    } catch (error) {
      this.deps.log?.warn(
        `github: bot identity lookup failed; commit attribution disabled (${error instanceof Error ? error.message : String(error)})`
      )
      return undefined
    }
  }
}

// Local alias — OrgId values arrive as plain strings out of the signed state.
function OrgIdOf(s: string): OrgId {
  return s as OrgId
}

function isInstallationFactsDenial(error: GithubApiError): boolean {
  return error.status === 401 || error.status === 403 || error.status === 422
}

function hasChecksReporterPermissions(installation: GithubInstallationRecord): boolean {
  const pullRequests = installation.permissions?.pull_requests
  return installation.permissions?.checks === 'write' && (pullRequests === 'read' || pullRequests === 'write')
}

/**
 * Pick the skills from a list of SKILL.md blob paths using the pinned CLI's
 * layout precedence (shared-skills.md §3): the first layout that matches wins.
 *   1. skills/<skill>/SKILL.md   2. <skill>/SKILL.md (top-level dir)
 *   3. .claude/skills/<skill>/SKILL.md   4. a single root SKILL.md
 * Skill name = the immediate parent directory (or the repo for a root SKILL.md).
 */
export function pickSkillLayout(paths: string[]): Array<{ name: string; dirPath: string }> {
  const under = (prefix: string) =>
    paths
      .filter((p) => p.startsWith(prefix) && p.slice(prefix.length).split('/').length === 2)
      .map((p) => {
        const rest = p.slice(prefix.length)
        const name = rest.slice(0, rest.indexOf('/'))
        return { name, dirPath: `${prefix}${name}` }
      })

  const inSkillsDir = under('skills/')
  if (inSkillsDir.length) return inSkillsDir

  const topLevel = paths
    .filter((p) => p.split('/').length === 2 && p.endsWith('/SKILL.md') && !p.startsWith('.'))
    .map((p) => {
      const name = p.slice(0, p.indexOf('/'))
      return { name, dirPath: name }
    })
  if (topLevel.length) return topLevel

  const claude = under('.claude/skills/')
  if (claude.length) return claude

  if (paths.includes('SKILL.md')) return [{ name: 'SKILL.md', dirPath: '.' }]
  return []
}
