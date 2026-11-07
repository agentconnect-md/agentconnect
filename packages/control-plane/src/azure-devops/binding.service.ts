// Repositories of a connected Azure DevOps organization (azure-devops-integration.md §5): the picker read, address resolution, the permission check, and binding on first use.
import type { AzureDevOpsRepoAddress } from '@agentconnect.md/protocol'
import { AzureDevOpsRepositoryClaimConflict } from '../persistence/errors.js'
import type {
  AzureDevOpsConnectionRecord,
  AzureDevOpsConnectionRepo,
  AzureDevOpsRepositoryBindingRecord,
  AzureDevOpsRepositoryBindingRepo,
  AzureDevOpsRepositoryFacts
} from '../persistence/ports.js'
import {
  evaluateRepositoryPermissions,
  listRepositories,
  type AzureDevOpsApiClient,
  type AzureDevOpsRepository
} from './api.js'
import { AzureDevOpsConnectDenied, type AzureDevOpsConnectionService } from './connection.service.js'

/** The refusal derivation and grants answer for a repository the identity cannot see or cannot push to (§5). */
export function grantAccessMessage(path: string, organization: string, write: boolean): string {
  return write
    ? `the application cannot push to ${path} — grant its service principal Contribute on this repository (the project's Contributors group) in ${organization}`
    : `the application cannot see ${path} — grant the application access to this repository in ${organization}`
}

export interface AzureDevOpsLocatedRepository {
  connection: AzureDevOpsConnectionRecord
  repository: AzureDevOpsRepository
}

export interface AzureDevOpsBindingServiceDeps {
  connections: Pick<AzureDevOpsConnectionRepo, 'get' | 'listForOrg'>
  bindings: AzureDevOpsRepositoryBindingRepo
  service: AzureDevOpsConnectionService
  api: AzureDevOpsApiClient
  /** A bound repository's path or clone URL changed (a rename): converge workspaces and grants, then re-project their agents. */
  onPathChanged?: (orgId: string, repoId: bigint, repoPath: string, cloneUrl: string) => Promise<void>
}

/** The facts a listed repository binds or refreshes with. */
function factsOf(
  connection: AzureDevOpsConnectionRecord,
  repository: AzureDevOpsRepository
): AzureDevOpsRepositoryFacts {
  return {
    repositoryId: repository.id,
    projectId: repository.projectId,
    organizationInstanceId: connection.organizationInstanceId,
    repoPath: `${connection.organization}/${repository.projectName}/${repository.name}`,
    cloneUrl: repository.cloneUrl,
    defaultBranch: repository.defaultBranch
  }
}

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/** Whether a listed repository is the one an address names: names compared case-insensitively, a project GUID accepted for the name. */
export function repositoryMatches(repository: AzureDevOpsRepository, address: AzureDevOpsRepoAddress): boolean {
  const projectMatches = same(repository.projectName, address.project) || same(repository.projectId, address.project)
  return projectMatches && (same(repository.name, address.repository) || same(repository.id, address.repository))
}

export class AzureDevOpsBindingService {
  constructor(private readonly deps: AzureDevOpsBindingServiceDeps) {}

  /** What the identity can see now; bindings of repositories that left the list degrade, ones that came back recover. */
  async visibleRepositories(connection: AzureDevOpsConnectionRecord): Promise<AzureDevOpsRepository[]> {
    const repositories = await this.deps.service.withApi(connection, (token) =>
      listRepositories(this.deps.api, token, connection.organization)
    )
    const visible = new Map(repositories.map((repo) => [repo.id, repo]))
    for (const binding of await this.deps.bindings.listForConnection(connection.orgId, connection.id)) {
      const repository = visible.get(binding.repositoryId)
      if (!repository) {
        if (binding.state === 'ready') {
          await this.deps.bindings.setState(binding.id, 'runtime_degraded', 'repository_unavailable')
        }
        continue
      }
      const facts = factsOf(connection, repository)
      // A renamed repository keeps its GUID: refresh the binding and converge what replicates its path.
      if (facts.repoPath !== binding.repoPath || facts.cloneUrl !== binding.cloneUrl) {
        await this.refresh(connection, facts)
      } else if (binding.stateReason === 'repository_unavailable') {
        await this.deps.bindings.setState(binding.id, 'ready', null)
      }
    }
    return repositories
  }

  /** The organization's connections to the address's Azure DevOps organization, oldest first. */
  async connectionsFor(orgId: string, organization: string): Promise<AzureDevOpsConnectionRecord[]> {
    return (await this.deps.connections.listForOrg(orgId)).filter((c) => same(c.organization, organization))
  }

  /** The first connection whose identity sees the address; null when none of them does. */
  async locate(
    connections: readonly AzureDevOpsConnectionRecord[],
    address: AzureDevOpsRepoAddress
  ): Promise<AzureDevOpsLocatedRepository | null> {
    for (const connection of connections) {
      const repository = (await this.visibleRepositories(connection)).find((repo) => repositoryMatches(repo, address))
      if (repository) return { connection, repository }
    }
    return null
  }

  /** One repository by GUID through one connection, as the grant route names it. */
  async byRepositoryId(
    orgId: string,
    connectionId: string,
    repositoryId: string
  ): Promise<AzureDevOpsLocatedRepository> {
    const connection = await this.deps.connections.get(orgId, connectionId)
    if (!connection) throw new AzureDevOpsConnectDenied('azure devops connection not found', 404, 'connection_missing')
    const repository = (await this.visibleRepositories(connection)).find((repo) => same(repo.id, repositoryId))
    if (!repository) {
      throw new AzureDevOpsConnectDenied(
        grantAccessMessage('that repository', connection.organization, false),
        409,
        'repository_not_visible'
      )
    }
    return { connection, repository }
  }

  /** §12 item 7: whether the identity holds GenericContribute on the repository. */
  async canContribute(located: AzureDevOpsLocatedRepository): Promise<boolean> {
    const { connection, repository } = located
    const permissions = await this.deps.service.withApi(connection, (token) =>
      evaluateRepositoryPermissions(this.deps.api, token, connection.organization, repository.projectId, repository.id)
    )
    return permissions.contribute
  }

  /** Binding on first use (§5): identity, claim, catalog row and binding in one transaction; an existing binding is refreshed. */
  async ensureBound(located: AzureDevOpsLocatedRepository): Promise<AzureDevOpsRepositoryBindingRecord> {
    return this.refresh(located.connection, factsOf(located.connection, located.repository))
  }

  private async refresh(
    connection: AzureDevOpsConnectionRecord,
    facts: AzureDevOpsRepositoryFacts
  ): Promise<AzureDevOpsRepositoryBindingRecord> {
    try {
      const { binding, pathChanged } = await this.deps.bindings.bind({
        orgId: connection.orgId,
        connectionId: connection.id,
        facts
      })
      if (pathChanged) await this.deps.onPathChanged?.(connection.orgId, binding.repoId, facts.repoPath, facts.cloneUrl)
      return binding
    } catch (e) {
      if (e instanceof AzureDevOpsRepositoryClaimConflict) {
        throw new AzureDevOpsConnectDenied(
          'repository is already claimed by another organization',
          409,
          'repository_claimed'
        )
      }
      // The connection was removed while this write was in flight.
      if (typeof e === 'object' && e !== null && 'code' in e && (e as { code: unknown }).code === 'P2003') {
        throw new AzureDevOpsConnectDenied('the Azure DevOps connection was removed', 409, 'connection_missing')
      }
      throw e
    }
  }
}
