import { LogtoApiError, type MicrosoftIdentity } from '../github/logto-identity.js'
import type { AzureDevOpsConnectionRecord, RepoAccess, RepoGrantStaleReason } from '../persistence/ports.js'
import {
  AzureDevOpsApiError,
  GIT_REPOSITORIES_NAMESPACE,
  GENERIC_CONTRIBUTE,
  GENERIC_READ,
  readMicrosoftIdentity,
  type AzureDevOpsApiClient,
  type AzureDevOpsMicrosoftIdentity
} from './api.js'
import { AzureDevOpsConnectDenied, type AzureDevOpsConnectionService } from './connection.service.js'
import {
  PROJECT_NAMESPACE,
  readEffectivePermissionBits,
  readProjectVisibility,
  readUserAccessLevel,
  userLicenseAllowsRepositories,
  type AzureDevOpsUserAccessLevel
} from './user-access-api.js'

interface UserAuthzDeps {
  api: AzureDevOpsApiClient
  service: Pick<AzureDevOpsConnectionService, 'withApi'>
  microsoftIdentityFor(userId: string): Promise<MicrosoftIdentity | null>
  microsoftTenantIdentityFor(
    userId: string,
    linked: MicrosoftIdentity,
    tenantId: string
  ): Promise<MicrosoftIdentity | null>
}

interface RepositoryRef {
  id: string
  projectId: string
}
interface LocatedRepository {
  connection: AzureDevOpsConnectionRecord
  repository: RepositoryRef
}
interface UserRepoAccess {
  read: boolean
  write: boolean
}
type ProjectAccess = { visible: boolean; visibility: 'private' | 'public' }

const NO_ACCESS: UserRepoAccess = { read: false, write: false }

export class AzureDevOpsUserAuthzService {
  constructor(private readonly deps: UserAuthzDeps) {}

  async assertAccess(
    userId: string | undefined,
    located: LocatedRepository,
    access: RepoAccess
  ): Promise<UserRepoAccess> {
    const result = await this.withUser(userId, located.connection, (read) => read(located.repository))
    if (!result.read || (access === 'write' && !result.write)) {
      throw new AzureDevOpsConnectDenied(
        `your Microsoft account does not have ${access === 'write' ? 'write' : 'read'} access to this Azure DevOps repository`,
        403,
        'AZURE_DEVOPS_USER_NO_ACCESS'
      )
    }
    return result
  }

  // A provider failure remains an error; only a confirmed refusal suspends existing authority.
  async attestAccess(
    userId: string | null,
    located: LocatedRepository,
    access: RepoAccess
  ): Promise<RepoGrantStaleReason | null> {
    if (!userId) return 'attester_removed'
    try {
      await this.assertAccess(userId, located, access)
      return null
    } catch (error) {
      if (error instanceof AzureDevOpsConnectDenied) {
        if (error.code === 'MICROSOFT_IDENTITY_REQUIRED') return 'identity_unlinked'
        if (error.code === 'AZURE_DEVOPS_USER_NO_ACCESS') return 'access_lost'
      }
      throw error
    }
  }

  async filterRepositories<T extends RepositoryRef>(
    userId: string | undefined,
    connection: AzureDevOpsConnectionRecord,
    repositories: readonly T[]
  ): Promise<T[]> {
    if (repositories.length === 0) return []
    return this.withUser(userId, connection, async (read) => {
      const visible: T[] = []
      for (let offset = 0; offset < repositories.length; offset += 4) {
        const batch = repositories.slice(offset, offset + 4)
        const results = await Promise.all(batch.map(read))
        visible.push(...batch.filter((_, index) => results[index]!.read))
      }
      return visible
    })
  }

  // All evidence is scoped to this operation; a picker result never authorizes a later mutation.
  private async withUser<T>(
    userId: string | undefined,
    connection: AzureDevOpsConnectionRecord,
    use: (read: (repo: RepositoryRef) => Promise<UserRepoAccess>) => Promise<T>
  ): Promise<T> {
    const missingIdentity = () =>
      new AzureDevOpsConnectDenied(
        'Azure DevOps repository access requires configured Microsoft account linking and a linked Microsoft account',
        403,
        'MICROSOFT_IDENTITY_REQUIRED'
      )
    if (!userId) throw missingIdentity()
    try {
      const linked = await this.deps.microsoftIdentityFor(userId)
      if (!linked) throw missingIdentity()
      return await this.deps.service.withApi(connection, async (token) => {
        const lookup = (person: MicrosoftIdentity) =>
          readMicrosoftIdentity(this.deps.api, token, {
            organization: connection.organization,
            tenantId: connection.tenantId,
            ...person
          })
        const direct = await lookup(linked)
        const tenantIdentity = direct
          ? linked
          : await this.deps.microsoftTenantIdentityFor(userId, linked, connection.tenantId)
        const identity = direct ?? (tenantIdentity ? await lookup(tenantIdentity) : null)
        if (!identity || !tenantIdentity) {
          throw new AzureDevOpsConnectDenied(
            'your linked Microsoft account could not be verified in this Azure DevOps organization',
            403,
            'AZURE_DEVOPS_USER_NO_ACCESS'
          )
        }
        const level = await readUserAccessLevel(
          this.deps.api,
          token,
          connection.organization,
          connection.tenantId,
          tenantIdentity,
          identity
        )
        const projects = new Map<string, Promise<ProjectAccess>>()
        return use((repo) => this.readRepository(token, connection, repo, identity, level, projects))
      })
    } catch (error) {
      if (!(error instanceof LogtoApiError)) throw error
      throw new AzureDevOpsApiError(
        'could not verify your linked Microsoft account — try again',
        502,
        'UNAVAILABLE',
        true
      )
    }
  }

  private async readRepository(
    token: string,
    connection: AzureDevOpsConnectionRecord,
    repo: RepositoryRef,
    identity: AzureDevOpsMicrosoftIdentity,
    level: AzureDevOpsUserAccessLevel | null,
    projects: Map<string, Promise<ProjectAccess>>
  ): Promise<UserRepoAccess> {
    if (!level) return NO_ACCESS
    const { api } = this.deps
    const { organization } = connection
    try {
      let project = projects.get(repo.projectId)
      if (!project) {
        project = Promise.all([
          readProjectVisibility(api, token, organization, repo.projectId),
          readEffectivePermissionBits(
            api,
            token,
            organization,
            PROJECT_NAMESPACE,
            `$PROJECT:vstfs:///Classification/TeamProject/${repo.projectId}`,
            identity.descriptor
          )
        ]).then(([visibility, bits]) => ({ visibility, visible: (bits & 1) !== 0 }))
        projects.set(repo.projectId, project)
      }
      const { visible, visibility } = await project
      if (!visible || !userLicenseAllowsRepositories(level, visibility)) return NO_ACCESS
      const bits = await readEffectivePermissionBits(
        api,
        token,
        organization,
        GIT_REPOSITORIES_NAMESPACE,
        `repoV2/${repo.projectId}/${repo.id}`,
        identity.descriptor
      )
      const read = (bits & GENERIC_READ) !== 0
      return { read, write: read && (bits & GENERIC_CONTRIBUTE) !== 0 }
    } catch (error) {
      if (error instanceof AzureDevOpsApiError && ['FORBIDDEN', 'NOT_FOUND'].includes(error.code)) return NO_ACCESS
      throw error
    }
  }
}
