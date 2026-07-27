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
 *    ⇒ GITHUB_IDENTITY_REQUIRED, never a silent allow;
 *  - authorization is asserted at pick/create time; the daemon keeps running
 *    on installation tokens (creator drift is the tracked re-attest follow-up).
 */
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
}

// Narrow structural deps (the composition root passes LogtoIdentityService /
// GithubService / PgUserRepo; tests pass plain objects).
interface UserAuthzDeps {
  identity: { githubLoginFor(sub: string): Promise<string | null> }
  github: {
    getRepoMeta(ins: GithubInstallationRecord, owner: string, repo: string): Promise<{ private: boolean } | null>
    userRepoPermission(
      ins: GithubInstallationRecord,
      owner: string,
      repo: string,
      username: string
    ): Promise<RepoPermission>
    userRepoPermissions(
      ins: GithubInstallationRecord,
      repos: Array<{ nodeId: string; fullName: string }>,
      username: string
    ): Promise<ReadonlyMap<string, RepoPermission>>
  }
  users: { getOidcSubject(userId: string): Promise<string | null> }
  clock: Clock
}

const ACCESS_TTL_MS = 5 * 60_000

export class GithubUserAuthzService {
  /** (installation, repo, login) → effective permission; the one cacheable unit
   *  shared by the preflight, the create gate AND the list filter. */
  private readonly perms = new Map<string, { value: RepoPermission; expiresAt: number }>()
  private readonly permsInFlight = new Map<string, Promise<RepoPermission>>()
  /** (installation, repo) → meta (or null = out of grant), same TTL. */
  private readonly metas = new Map<string, { value: { private: boolean } | null; expiresAt: number }>()
  private readonly metasInFlight = new Map<string, Promise<{ private: boolean } | null>>()

  constructor(private readonly deps: UserAuthzDeps) {}

  /** The caller's GitHub login, or a GITHUB_IDENTITY_REQUIRED denial — the
   *  shared first leg of every check. */
  private async loginOf(userId: string): Promise<string> {
    const sub = await this.deps.users.getOidcSubject(userId)
    if (!sub) {
      throw new UserAuthzDeniedError(
        'account has no OIDC identity to assert GitHub access with',
        'GITHUB_IDENTITY_REQUIRED'
      )
    }
    const login = await this.deps.identity.githubLoginFor(sub)
    if (!login) {
      throw new UserAuthzDeniedError(
        'no GitHub identity on this account — sign in with GitHub to verify repo access',
        'GITHUB_IDENTITY_REQUIRED'
      )
    }
    return login
  }

  private permissionKey(login: string, ins: GithubInstallationRecord, owner: string, repo: string): string {
    return `${ins.installationId}:${owner.toLowerCase()}/${repo.toLowerCase()}:${login.toLowerCase()}`
  }

  /** Cached + deduped effective permission of `login` on one repo. */
  private permissionOf(
    login: string,
    ins: GithubInstallationRecord,
    owner: string,
    repo: string
  ): Promise<RepoPermission> {
    const key = this.permissionKey(login, ins, owner, repo)
    const cached = this.perms.get(key)
    if (cached && cached.expiresAt > this.deps.clock.now()) return Promise.resolve(cached.value)
    let pending = this.permsInFlight.get(key)
    if (!pending) {
      pending = this.deps.github
        .userRepoPermission(ins, owner, repo, login)
        .then((value) => {
          this.perms.set(key, { value, expiresAt: this.deps.clock.now() + ACCESS_TTL_MS })
          return value
        })
        .finally(() => this.permsInFlight.delete(key))
      this.permsInFlight.set(key, pending)
    }
    return pending
  }

  /** Cached + per-repository deduped batch lookup for picker pages. An exact
   * access check racing the batch joins the same promise instead of issuing its
   * own REST request. */
  private permissionsOf(
    login: string,
    ins: GithubInstallationRecord,
    repos: Array<{ nodeId: string; fullName: string; owner: string; repo: string }>
  ): Promise<RepoPermission[]> {
    const results = new Array<Promise<RepoPermission>>(repos.length)
    const fresh: Array<{
      index: number
      key: string
      nodeId: string
      fullName: string
    }> = []

    for (const [index, repo] of repos.entries()) {
      const key = this.permissionKey(login, ins, repo.owner, repo.repo)
      const cached = this.perms.get(key)
      if (cached && cached.expiresAt > this.deps.clock.now()) {
        results[index] = Promise.resolve(cached.value)
        continue
      }
      const pending = this.permsInFlight.get(key)
      if (pending) {
        results[index] = pending
        continue
      }
      fresh.push({ index, key, nodeId: repo.nodeId, fullName: repo.fullName })
    }

    if (fresh.length > 0) {
      const batch = this.deps.github.userRepoPermissions(
        ins,
        fresh.map(({ nodeId, fullName }) => ({ nodeId, fullName })),
        login
      )
      for (const repo of fresh) {
        const pending = batch
          .then((permissions) => {
            const value = permissions.get(repo.nodeId) ?? 'none'
            this.perms.set(repo.key, { value, expiresAt: this.deps.clock.now() + ACCESS_TTL_MS })
            return value
          })
          .finally(() => {
            if (this.permsInFlight.get(repo.key) === pending) this.permsInFlight.delete(repo.key)
          })
        this.permsInFlight.set(repo.key, pending)
        results[repo.index] = pending
      }
    }

    return Promise.all(results)
  }

  /** Cached + deduped repo meta (privacy flag; null = out of grant). */
  private metaOf(ins: GithubInstallationRecord, owner: string, repo: string): Promise<{ private: boolean } | null> {
    const key = `${ins.installationId}:${owner}/${repo}`
    const cached = this.metas.get(key)
    if (cached && cached.expiresAt > this.deps.clock.now()) return Promise.resolve(cached.value)
    let pending = this.metasInFlight.get(key)
    if (!pending) {
      pending = this.deps.github
        .getRepoMeta(ins, owner, repo)
        .then((value) => {
          this.metas.set(key, { value, expiresAt: this.deps.clock.now() + ACCESS_TTL_MS })
          return value
        })
        .finally(() => this.metasInFlight.delete(key))
      this.metasInFlight.set(key, pending)
    }
    return pending
  }

  /**
   * The caller's effective access to `owner/repo`, for the picker's
   * permission preflight. Throws UserAuthzDeniedError(GITHUB_IDENTITY_REQUIRED)
   * when the account carries no GitHub identity; upstream failures bubble.
   * The repo is assumed already resolved inside `ins` (callers 404 first).
   */
  async accessFor(userId: string, ins: GithubInstallationRecord, owner: string, repo: string): Promise<UserRepoAccess> {
    const login = await this.loginOf(userId)
    const meta = await this.metaOf(ins, owner, repo)
    // Out-of-grant repo: callers normally 404 before asking; report no access.
    const repoPrivate = meta?.private ?? true
    const permission = meta ? await this.permissionOf(login, ins, owner, repo) : 'none'
    return {
      permission,
      repoPrivate,
      canRead: permission !== 'none' || !repoPrivate,
      canWrite: permission === 'admin' || permission === 'write'
    }
  }

  /**
   * List filter for the picker: keep public repos and private repos the caller
   * can read on GitHub — so no-access repo NAMES never render in the console.
   * Private repos are probed with the same cached permission unit as the gates
   * (bounded GraphQL batches; the result shares the same per-repo cache as
   * exact create/preflight gates). Throws
   * GITHUB_IDENTITY_REQUIRED like every other check — never a silent allow.
   */
  async filterReposForUser<T extends { nodeId: string; fullName: string; private: boolean }>(
    userId: string,
    ins: GithubInstallationRecord,
    repos: T[]
  ): Promise<T[]> {
    const login = await this.loginOf(userId)
    const privateRepos = repos.flatMap((candidate) => {
      if (!candidate.private) return []
      const [owner, repo] = candidate.fullName.split('/')
      return owner && repo ? [{ nodeId: candidate.nodeId, fullName: candidate.fullName, owner, repo }] : []
    })
    const permissions = await this.permissionsOf(login, ins, privateRepos)
    const readable = new Set(
      privateRepos.flatMap((repo, index) => (permissions[index] === 'none' ? [] : [repo.nodeId]))
    )
    return repos.filter((repo) => !repo.private || readable.has(repo.nodeId))
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
