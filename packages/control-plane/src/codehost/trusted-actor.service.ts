/**
 * `CodeHostTrustedActorService` — the per-repository "Trusted users" list
 * (webhook-triggers-and-github-events.md, "Trusted users").
 *
 * A maintainer types a login; this resolves it through the repository's own credential
 * to the host's NUMERIC user id and stores both. The gates match the id alone — a login is
 * a display hint that can be renamed away and re-registered by someone else, exactly the
 * repoId/repoFullName rule. Each provider arm exists only where that host is configured.
 */
import { isCodeHostHookKind, type CodeHostProvider } from '@agentconnect.md/protocol'
import type {
  CodeHostTrustedActorRecord,
  CodeHostTrustedActorRepo,
  GiteaConnectionRepo,
  GiteaRepositoryBindingRepo,
  GithubInstallationRepo,
  GitlabAgentAccountRepo,
  GitlabProjectBindingRepo,
  GitlabProjectCredentialRepo,
  GitlabProjectCredentialSecretStore,
  HookRecord
} from '../persistence/ports.js'
import type { GithubService } from '../github/service.js'
import { gitlabUserByUsername, type GitlabApiClient } from '../gitlab/api.js'
import { giteaUser, type GiteaApiClient } from '../gitea/api.js'
import type { GiteaTokenSource } from '../gitea/provisioner.js'

export interface CodeHostTrustedActorServiceDeps {
  trustedActors: CodeHostTrustedActorRepo
  github?: {
    installations: Pick<GithubInstallationRepo, 'liveByOrgAndAccount'>
    service: Pick<GithubService, 'userByLogin'>
  }
  gitlab?: {
    bindings: Pick<GitlabProjectBindingRepo, 'byProject'>
    accounts: Pick<GitlabAgentAccountRepo, 'listForBinding'>
    credentials: Pick<GitlabProjectCredentialRepo, 'get'>
    credentialSecrets: Pick<GitlabProjectCredentialSecretStore, 'get'>
    api: GitlabApiClient
  }
  gitea?: {
    bindings: Pick<GiteaRepositoryBindingRepo, 'byRepo'>
    connections: Pick<GiteaConnectionRepo, 'get'>
    tokens: GiteaTokenSource
    api: GiteaApiClient
  }
}

/** The repository the list belongs to, read off a code-host hook row; a webhook hook has none. */
export interface TrustedActorRepoRef {
  provider: CodeHostProvider
  repoExternalId: bigint
}

/** No credential this deployment holds can resolve a user on that repository right now. */
export class TrustedActorResolutionUnavailable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TrustedActorResolutionUnavailable'
  }
}

export interface ResolvedActor {
  id: bigint
  login: string
}

export function trustedActorRepoOf(hook: Pick<HookRecord, 'kind' | 'repoId'>): TrustedActorRepoRef | null {
  if (!isCodeHostHookKind(hook.kind) || hook.repoId === null) return null
  return { provider: hook.kind, repoExternalId: hook.repoId }
}

export class CodeHostTrustedActorService {
  constructor(private readonly deps: CodeHostTrustedActorServiceDeps) {}

  list(hook: HookRecord, repo: TrustedActorRepoRef): Promise<CodeHostTrustedActorRecord[]> {
    return this.deps.trustedActors.listForRepo(hook.orgId, repo.provider, repo.repoExternalId)
  }

  /** Resolve the typed login on the hook's own host, then store the id it names. Null ⇒ no such user. */
  async add(
    hook: HookRecord,
    repo: TrustedActorRepoRef,
    login: string,
    addedByUserId: string | undefined
  ): Promise<CodeHostTrustedActorRecord | null> {
    const actor = await this.resolve(hook, repo, login)
    if (!actor) return null
    return this.deps.trustedActors.add({
      orgId: hook.orgId,
      provider: repo.provider,
      repoExternalId: repo.repoExternalId,
      actorExternalId: actor.id,
      actorLogin: actor.login,
      ...(addedByUserId !== undefined ? { addedByUserId } : {})
    })
  }

  remove(hook: HookRecord, id: string): Promise<boolean> {
    return this.deps.trustedActors.remove(hook.orgId, id)
  }

  private resolve(hook: HookRecord, repo: TrustedActorRepoRef, login: string): Promise<ResolvedActor | null> {
    const resolvers: { readonly [P in CodeHostProvider]: () => Promise<ResolvedActor | null> } = {
      github: () => this.resolveGithub(hook, login),
      gitlab: () => this.resolveGitlab(hook, repo.repoExternalId, login),
      gitea: () => this.resolveGitea(hook, repo.repoExternalId, login)
    }
    return resolvers[repo.provider]()
  }

  /** `GET /users/{login}` through the org installation covering the repository owner. */
  private async resolveGithub(hook: HookRecord, login: string): Promise<ResolvedActor | null> {
    const github = this.deps.github
    const owner = hook.repoFullName?.split('/')[0]
    if (!github || !owner) throw new TrustedActorResolutionUnavailable('GitHub is not configured on this deployment')
    const installation = await github.installations.liveByOrgAndAccount(hook.orgId, owner)
    if (!installation || installation.suspendedAt) {
      throw new TrustedActorResolutionUnavailable('no live GitHub App installation covers this repository')
    }
    return github.service.userByLogin(installation, login)
  }

  /** `GET /users?username=` with the read PAT of the hook agent's own project account. */
  private async resolveGitlab(hook: HookRecord, projectId: bigint, login: string): Promise<ResolvedActor | null> {
    const gitlab = this.deps.gitlab
    if (!gitlab) throw new TrustedActorResolutionUnavailable('GitLab is not configured on this deployment')
    const binding = await gitlab.bindings.byProject(hook.orgId, projectId)
    if (!binding || binding.state === 'cleanup_pending' || binding.state === 'provisioning') {
      throw new TrustedActorResolutionUnavailable('this project has no live GitLab binding')
    }
    const accounts = await gitlab.accounts.listForBinding(binding.id)
    const account = accounts.find((candidate) => candidate.agentId === hook.agentId) ?? accounts[0]
    const credential = account ? await gitlab.credentials.get(account.id, 'read') : null
    const token = credential ? await gitlab.credentialSecrets.get(hook.orgId, credential.id) : null
    if (!token) throw new TrustedActorResolutionUnavailable('this project has no usable GitLab credential yet')
    const user = await gitlabUserByUsername(token, login, gitlab.api)
    return user ? { id: BigInt(user.id), login: user.username } : null
  }

  /** `GET /users/{login}` with the connection token; the same call the gate re-resolves identity with. */
  private async resolveGitea(hook: HookRecord, repoId: bigint, login: string): Promise<ResolvedActor | null> {
    const gitea = this.deps.gitea
    if (!gitea) throw new TrustedActorResolutionUnavailable('Gitea is not configured on this deployment')
    const binding = await gitea.bindings.byRepo(hook.orgId, repoId)
    if (!binding) throw new TrustedActorResolutionUnavailable('this repository has no Gitea binding')
    const connection = await gitea.connections.get(hook.orgId, binding.connectionId)
    if (!connection || connection.state !== 'connected') {
      throw new TrustedActorResolutionUnavailable('the Gitea connection behind this repository is not connected')
    }
    const token = await gitea.tokens.withToken(hook.orgId, binding.connectionId)
    const user = await giteaUser(token, login, gitea.api)
    return user ? { id: BigInt(user.id), login: user.login } : null
  }
}
