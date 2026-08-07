/**
 * GithubUserAuthzService — per-user repo authorization for github-app
 * workspaces (docs/designs/github-app-git-credentials.md open question #7,
 * identity-assertion route: zero OAuth leg, zero stored user tokens).
 *
 * The question it answers: "may THIS console user bind THIS repo into an
 * agent?" — decided by the user's own effective GitHub permission, asserted
 * server-side:
 *
 *   local user → oidcSubject → (Logto Mgmt API) GitHub login
 *              → (installation metadata token) collaborator permission
 *
 * Assembled only when GitHub repo grants AND LOGTO_MGMT_* AND real OIDC
 * auth are all configured — absent, callers keep today's org-level model
 * (installation coverage is the only gate). Every failure fails CLOSED: this
 * is an authorization gate, availability never widens it.
 *
 * Semantics (design open question #7):
 *  - need=read  ⇒ any effective permission, or the repo is public;
 *  - need=write ⇒ effective write/admin (GitHub collapses maintain→write) —
 *    public repos do NOT satisfy write;
 *  - no GitHub identity on the account (Google sign-in, deleted at provider)
 *    ⇒ public read remains available, while private/read-write checks return
 *    GITHUB_IDENTITY_REQUIRED;
 *  - authorization is asserted at pick/create time; the daemon keeps running
 *    on installation tokens (creator drift is the tracked re-attest follow-up).
 */
import { LRUCache } from 'lru-cache'
import { cacheOptions } from '../cache.js'
import type { Clock } from '../domain/clock.js'
import type { GithubInstallationRecord } from '../persistence/ports.js'

export type RepoPermission = 'admin' | 'write' | 'read' | 'none'

export type UserAuthzDenialCode = 'GITHUB_IDENTITY_REQUIRED' | 'USER_NO_ACCESS'

/** Denied by policy (as opposed to upstream failure — those bubble as
 *  GithubApiError / LogtoApiError and map to 502/429). */
export class UserAuthzDeniedError extends Error {
  constructor(
    message: string,
    readonly code: UserAuthzDenialCode
  ) {
    super(message)
    this.name = 'UserAuthzDeniedError'
  }
}

export interface UserRepoAccess {
  /** The user's effective permission as GitHub reports it. */
  permission: RepoPermission
  repoPrivate: boolean
  canRead: boolean
  canWrite: boolean
  /** No linked GitHub identity was available. Public read is still valid, but
   *  every identity-dependent capability must keep failing closed. */
  identityRequired: boolean
}

// Narrow structural deps (the composition root passes LogtoIdentityService /
// GithubService / PgUserRepo; tests pass plain objects).
interface UserAuthzDeps {
  identity: { githubLoginFor(sub: string, maxAgeMs?: number): Promise<string | null> }
  github: {
    getRepoMeta(ins: GithubInstallationRecord, owner: string, repo: string): Promise<{ private: boolean } | null>
    userRepoPermission(
      ins: GithubInstallationRecord,
      owner: string,
      repo: string,
      username: string
    ): Promise<RepoPermission>
  }
  users: { getOidcSubject(userId: string): Promise<string | null> }
  clock: Clock
}

const ACCESS_TTL_MS = 5 * 60_000
/** Parallel verified REST permission probes per list-filter call. */
const FILTER_CONCURRENCY = 8
/**
 * Both caches below are keyed per (installation, repo, login), so their natural
 * size is repositories × console users — bounded in principle, unbounded in the
 * only sense that matters to a long-lived process. They previously had no cap at
 * all and grew for the lifetime of the pod.
 */
const MAX_CACHE_ENTRIES = 10_000

/** `metaOf`'s answer. Wrapped because `null` (out of the installation's grant)
 *  is a real answer worth caching, and a cache cannot store a nullish value. */
type RepoMeta = { meta: { private: boolean } | null }

type PermissionLookup = { ins: GithubInstallationRecord; owner: string; repo: string; login: string }
type MetaLookup = { ins: GithubInstallationRecord; owner: string; repo: string }

export class GithubUserAuthzService {
  /** (installation, repo, login) → effective permission; the one cacheable unit
   *  shared by the preflight, the create gate AND the list filter. `fetch` hands
   *  concurrent callers of one key the same promise. */
  private readonly perms: LRUCache<string, RepoPermission, PermissionLookup>
  /** (installation, repo) → meta (or null = out of grant), same TTL. */
  private readonly metas: LRUCache<string, RepoMeta, MetaLookup>

  constructor(private readonly deps: UserAuthzDeps) {
    this.perms = new LRUCache({
      ...cacheOptions(deps.clock, MAX_CACHE_ENTRIES),
      ttl: ACCESS_TTL_MS,
      fetchMethod: (_key, _stale, { context }) =>
        this.deps.github.userRepoPermission(context.ins, context.owner, context.repo, context.login)
    })
    this.metas = new LRUCache({
      ...cacheOptions(deps.clock, MAX_CACHE_ENTRIES),
      ttl: ACCESS_TTL_MS,
      fetchMethod: async (_key, _stale, { context }) => ({
        meta: await this.deps.github.getRepoMeta(context.ins, context.owner, context.repo)
      })
    })
  }

  /** The caller's GitHub login, or a GITHUB_IDENTITY_REQUIRED denial — the
   *  shared first leg of every check. */
  private async loginOf(userId: string, maxCacheAgeMs?: number): Promise<string> {
    const sub = await this.deps.users.getOidcSubject(userId)
    if (!sub) {
      throw new UserAuthzDeniedError(
        'account has no OIDC identity to assert GitHub access with',
        'GITHUB_IDENTITY_REQUIRED'
      )
    }
    const login = await this.deps.identity.githubLoginFor(sub, maxCacheAgeMs)
    if (!login) {
      throw new UserAuthzDeniedError(
        'no GitHub identity on this account — link GitHub to verify repository access',
        'GITHUB_IDENTITY_REQUIRED'
      )
    }
    return login
  }

  private permissionKey(login: string, ins: GithubInstallationRecord, owner: string, repo: string): string {
    return `${ins.installationId}:${owner.toLowerCase()}/${repo.toLowerCase()}:${login.toLowerCase()}`
  }

  /** Cached + deduped effective permission of `login` on one repo. */
  private async permissionOf(
    login: string,
    ins: GithubInstallationRecord,
    owner: string,
    repo: string,
    maxCacheAgeMs?: number
  ): Promise<RepoPermission> {
    const key = this.permissionKey(login, ins, owner, repo)
    // `maxCacheAgeMs` caps reuse BELOW the cache's own lease: a caller sitting on
    // a live authorization gate can demand evidence younger than the picker's
    // five minutes (0 = always re-ask). A missing entry reports a full-TTL age,
    // which forces the fetch it was going to do anyway.
    const age = ACCESS_TTL_MS - this.perms.getRemainingTTL(key)
    const permission = await this.perms.fetch(key, {
      ...(maxCacheAgeMs !== undefined && age >= maxCacheAgeMs ? { forceRefresh: true } : {}),
      context: { ins, owner, repo, login }
    })
    // Only reachable if the entry is dropped mid-flight. This service fails
    // CLOSED, and `none` is how it spells that.
    return permission ?? 'none'
  }

  /** Resolve only the user's effective permission. Callers that already
   * verified repository metadata can cap or bypass this service's picker cache
   * instead of extending a shorter authorization lease. */
  async permissionForUser(
    userId: string,
    ins: GithubInstallationRecord,
    owner: string,
    repo: string,
    options: { maxCacheAgeMs?: number } = {}
  ): Promise<RepoPermission> {
    const login = await this.loginOf(userId, options.maxCacheAgeMs)
    return this.permissionOf(login, ins, owner, repo, options.maxCacheAgeMs)
  }

  /** Cached + deduped repo meta (privacy flag; null = out of grant). */
  private async metaOf(
    ins: GithubInstallationRecord,
    owner: string,
    repo: string
  ): Promise<{ private: boolean } | null> {
    const observed = await this.metas.fetch(`${ins.installationId}:${owner}/${repo}`, {
      context: { ins, owner, repo }
    })
    // Only reachable if the entry is dropped mid-flight. Out-of-grant is the
    // fail-closed reading: callers treat it as private with no access.
    return observed?.meta ?? null
  }

  /**
   * The caller's effective access to `owner/repo`, for the picker's
   * permission preflight. Throws UserAuthzDeniedError(GITHUB_IDENTITY_REQUIRED)
   * when the account carries no GitHub identity; upstream failures bubble.
   * The repo is assumed already resolved inside `ins` (callers 404 first).
   */
  async accessFor(userId: string, ins: GithubInstallationRecord, owner: string, repo: string): Promise<UserRepoAccess> {
    const meta = await this.metaOf(ins, owner, repo)
    // Out-of-grant repo: callers normally 404 before asking; report no access.
    const repoPrivate = meta?.private ?? true
    let login: string
    try {
      login = await this.loginOf(userId)
    } catch (error) {
      // Public repository metadata is itself enough to authorize a read. Do
      // not turn the absence of an unrelated personal identity into a denial,
      // but retain the fact so write remains identity-gated below.
      if (error instanceof UserAuthzDeniedError && error.code === 'GITHUB_IDENTITY_REQUIRED' && meta && !repoPrivate) {
        return { permission: 'none', repoPrivate, canRead: true, canWrite: false, identityRequired: true }
      }
      throw error
    }
    const permission = meta ? await this.permissionOf(login, ins, owner, repo) : 'none'
    return {
      permission,
      repoPrivate,
      canRead: permission !== 'none' || !repoPrivate,
      canWrite: permission === 'admin' || permission === 'write',
      identityRequired: false
    }
  }

  /**
   * List filter for the picker: keep public repos and private repos the caller
   * can read on GitHub — so no-access repo NAMES never render in the console.
   * Private repos are probed with the same cached permission unit as the gates
   * using the verified REST endpoint with bounded concurrency. Without a
   * linked identity the public subset is returned and the result explicitly
   * says that private repositories were hidden.
   */
  async filterReposForUser<T extends { fullName: string; private: boolean }>(
    userId: string,
    ins: GithubInstallationRecord,
    repos: T[]
  ): Promise<{ repos: T[]; privateReposHidden: boolean }> {
    if (!repos.some((repo) => repo.private)) return { repos, privateReposHidden: false }

    let login: string
    try {
      login = await this.loginOf(userId)
    } catch (error) {
      if (error instanceof UserAuthzDeniedError && error.code === 'GITHUB_IDENTITY_REQUIRED') {
        return { repos: repos.filter((repo) => !repo.private), privateReposHidden: true }
      }
      throw error
    }
    const results = new Array<boolean>(repos.length).fill(false)
    let next = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next++
        if (index >= repos.length) return
        const candidate = repos[index]!
        if (!candidate.private) {
          results[index] = true
          continue
        }
        const [owner, repo] = candidate.fullName.split('/')
        if (!owner || !repo) continue
        results[index] = (await this.permissionOf(login, ins, owner, repo)) !== 'none'
      }
    }
    await Promise.all(Array.from({ length: Math.min(FILTER_CONCURRENCY, repos.length) }, worker))
    return { repos: repos.filter((_, index) => results[index]), privateReposHidden: false }
  }

  /** The enforcement form: resolve access and throw USER_NO_ACCESS below `need`. */
  async assertAccess(
    userId: string,
    ins: GithubInstallationRecord,
    owner: string,
    repo: string,
    need: 'read' | 'write'
  ): Promise<UserRepoAccess> {
    const access = await this.accessFor(userId, ins, owner, repo)
    const ok = need === 'write' ? access.canWrite : access.canRead
    if (!ok) {
      if (access.identityRequired) {
        throw new UserAuthzDeniedError(
          'no GitHub identity on this account — link GitHub to verify repository write access',
          'GITHUB_IDENTITY_REQUIRED'
        )
      }
      throw new UserAuthzDeniedError(
        need === 'write'
          ? `you do not have write access to ${owner}/${repo} on GitHub (effective: ${access.permission})`
          : `you do not have access to ${owner}/${repo} on GitHub`,
        'USER_NO_ACCESS'
      )
    }
    return access
  }
}
