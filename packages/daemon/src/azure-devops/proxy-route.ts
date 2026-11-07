// Azure DevOps's routes in the credential proxy (azure-devops-integration.md §6.2, §6.3): the token is organization-wide, so every request is denied unless it names one of the agent's own repositories or is on a short allowlist.
import { AZURE_DEVOPS_HOST } from '@agentconnect.md/protocol'
import { AZURE_DEVOPS_ORGANIZATION, azureDevOpsName } from '../gitcred/repo-path.js'
import {
  isGitPush,
  READS,
  requestPath,
  type InstanceRoute,
  type ProxyInstance,
  type ProxyRepository,
  type ProxyRouteDescriptor,
  type RepositoryRef
} from '../credential-proxy/route-descriptor.js'
import { azureDevOpsRepoName } from './credentials.js'

const VISUALSTUDIO_SUFFIX = '.visualstudio.com'
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PULL_REQUEST_ID = /^[1-9]\d{0,9}$/
const GIT_SERVICES = new Set(['info/refs', 'git-upload-pack', 'git-receive-pack'])

/** A JSON error body in Azure DevOps's own shape. */
function vssError(message: string, typeKey: string): string {
  return JSON.stringify({
    $id: '1',
    innerException: null,
    message,
    typeName: `Microsoft.TeamFoundation.Git.Server.${typeKey}, Microsoft.TeamFoundation.Git.Server`,
    typeKey,
    errorCode: 0,
    eventId: 3000
  })
}

/** Azure DevOps's own answer for a repository it does not show (§12): git's plain text, REST's JSON; never asked upstream, so it is the same whether the repository exists or not. */
function repositoryNotFound(identifier: string, plane: 'git' | 'api'): InstanceRoute {
  const message = `TF401019: The Git repository with name or identifier ${identifier} does not exist or you do not have permissions for the operation you are attempting.`
  return {
    kind: 'deny',
    status: 404,
    reason: plane === 'git' ? message : vssError(message, 'GitRepositoryNotFoundException')
  }
}

/** Azure DevOps's own answer for a pull request id it does not show, which another repository's pull request gets too. */
export const PULL_REQUEST_NOT_FOUND = {
  status: 404,
  reason: vssError('TF401180: The requested pull request was not found.', 'GitPullRequestNotFoundException')
}

function deny(status: number, reason: string): InstanceRoute {
  return { kind: 'deny', status, reason }
}

const OTHER_ORGANIZATION = 'this agent’s Azure DevOps credential does not reach that organization'
const NOT_A_REPOSITORY = 'the path does not name one Azure DevOps repository'
const WRITE_NAMING_NO_REPOSITORY =
  'an Azure DevOps write that names no repository is not available with this agent’s credential'
const REPOSITORY_LIST =
  'Azure DevOps repository lists are not available with this agent’s credential; its repositories are named in its context'
const PULL_REQUEST_LIST =
  'pull-request lists that name no repository are not available with this agent’s credential; list them under the repository (_apis/git/repositories/{repository}/pullrequests)'
const PULL_REQUEST_WRITE =
  'a pull request is changed under its repository (_apis/git/repositories/{repository}/pullrequests/{id})'
const NOT_AVAILABLE =
  'only Git and the REST API of the agent’s own Azure DevOps repositories are available with this agent’s credential'

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/** One path segment percent-decoded as a name; undefined when it does not decode to one. */
function decodedName(segment: string | undefined): string | undefined {
  if (segment === undefined) return undefined
  try {
    return azureDevOpsName(decodeURIComponent(segment))
  } catch {
    return undefined
  }
}

/** A segment that decodes to one plain name, an empty one only last (a trailing slash): an encoded separator or dot segment names no single resource. */
function plainSegment(segment: string, last: boolean): boolean {
  return segment === '' ? last : decodedName(segment) !== undefined
}

/** The organization a request addresses and the path below it: the first segment on dev.azure.com, the host's own name on `{organization}.visualstudio.com` (optionally under `DefaultCollection`). */
function organizationOf(instance: ProxyInstance, target: string): { organization: string; rest: string[] } | undefined {
  const segments = requestPath(target).split('/').slice(1)
  const host = instance.hosts[0] ?? ''
  if (host === AZURE_DEVOPS_HOST) {
    const [first, ...rest] = segments
    const organization = decodedName(first)
    return organization !== undefined ? { organization, rest } : undefined
  }
  if (!host.endsWith(VISUALSTUDIO_SUFFIX)) return undefined
  const rest = segments[0]?.toLowerCase() === 'defaultcollection' ? segments.slice(1) : segments
  return { organization: host.slice(0, -VISUALSTUDIO_SUFFIX.length), rest }
}

/** The held repository's project matches a project segment by name or GUID. */
function inProject(repository: ProxyRepository, project: string): boolean {
  const name = azureDevOpsRepoName(repository.repoFullName)
  return (name !== undefined && same(name.project, project)) || same(repository.azureDevOps!.projectId, project)
}

/** A held repository by name: in the named project, or, with no project, in the project named like it. */
function heldByName(held: readonly ProxyRepository[], project: string | undefined, repository: string) {
  return held.find((candidate) => {
    const name = azureDevOpsRepoName(candidate.repoFullName)
    if (!name || !same(name.repository, repository)) return false
    return project === undefined ? same(name.project, repository) : inProject(candidate, project)
  })
}

/** A held repository by its GUID, in the named project when there is one. */
function heldById(held: readonly ProxyRepository[], project: string | undefined, id: string) {
  return held.find(
    (candidate) =>
      same(candidate.azureDevOps!.repositoryId, id) && (project === undefined || inProject(candidate, project))
  )
}

function ref(repository: ProxyRepository): RepositoryRef {
  return { repo: repository.repoFullName, repoId: repository.repoId }
}

/** `{repository}[.git]/(info/refs | git-upload-pack | git-receive-pack)`, the service spelled exactly as git sends it. */
function gitRoute(
  held: readonly ProxyRepository[],
  project: string | undefined,
  after: string[],
  target: string
): InstanceRoute {
  const repository = decodedName(after[0])?.replace(/\.git$/i, '')
  if (!repository || !GIT_SERVICES.has(after.slice(1).join('/'))) return deny(403, NOT_AVAILABLE)
  const found = heldByName(held, project, repository)
  if (!found) return repositoryNotFound(repository, 'git')
  const push = isGitPush(after.at(-1)!, target)
  return { kind: 'repository', plane: 'git', ...ref(found), push, readOnly: !push }
}

/** The REST API below `_apis`: a held repository, the pull-request lookup, or the allowlist; nothing else. */
function apiRoute(
  held: readonly ProxyRepository[],
  project: string | undefined,
  after: string[],
  method: string
): InstanceRoute {
  const lower = after.map((segment) => segment.toLowerCase())
  const read = READS.has(method.toUpperCase())
  if (lower[0] === 'git' && lower[1] === 'repositories') {
    if (after[2] === undefined || after[2] === '') return deny(403, read ? REPOSITORY_LIST : WRITE_NAMING_NO_REPOSITORY)
    const identifier = decodedName(after[2])
    if (!identifier) return deny(400, NOT_A_REPOSITORY)
    // Azure DevOps itself finds a repository by name only within a project.
    const found = GUID.test(identifier)
      ? heldById(held, project, identifier)
      : project !== undefined
        ? heldByName(held, project, identifier)
        : undefined
    if (!found) return repositoryNotFound(identifier, 'api')
    return {
      kind: 'repository',
      plane: 'api',
      ...ref(found),
      readOnly: read,
      ...(read ? {} : { write: true as const })
    }
  }
  if (lower[0] === 'git' && lower[1] === 'pullrequests') {
    if (after[2] === undefined || after[2] === '')
      return deny(403, read ? PULL_REQUEST_LIST : WRITE_NAMING_NO_REPOSITORY)
    if (after.length > 3) return deny(403, NOT_AVAILABLE)
    if (method.toUpperCase() !== 'GET') return deny(403, PULL_REQUEST_WRITE)
    if (!PULL_REQUEST_ID.test(after[2])) return deny(400, 'the pull request id is not a number')
    return {
      kind: 'lookup',
      via: ref(held[0]!),
      owner: (answer) => {
        const id = (answer as { repository?: { id?: unknown } } | null)?.repository?.id
        const found = typeof id === 'string' ? heldById(held, undefined, id) : undefined
        return found && ref(found)
      },
      hidden: PULL_REQUEST_NOT_FOUND,
      // A rejected credential answers 401 rather than a sign-in page.
      headers: { 'x-tfs-fedauthredirect': 'Suppress' }
    }
  }
  // The lookups the Azure CLI makes before any command; they show nothing repository-specific.
  const allowlisted = (lower[0] === 'connectiondata' && after.length === 1) || lower[0] === 'resourceareas'
  if (project === undefined && allowlisted) {
    if (!read) return deny(403, WRITE_NAMING_NO_REPOSITORY)
    return { kind: 'repository', plane: 'api', ...ref(held[0]!), readOnly: true }
  }
  return deny(403, read ? NOT_AVAILABLE : WRITE_NAMING_NO_REPOSITORY)
}

export const azureDevOpsProxyRoute: ProxyRouteDescriptor = {
  provider: 'azure-devops',
  saas: true,
  // The Azure CLI sends its placeholder as a Basic password and git through its helper; the token is the identity's either way.
  basicAuthorization: true,
  // One connection's organization on two names: a path prefix on dev.azure.com and a host of its own.
  proxyHosts: (_host, repositories) => {
    const organizations = new Set(
      repositories.flatMap((r) => (r.azureDevOps ? [r.azureDevOps.organization.toLowerCase()] : []))
    )
    return [...organizations].flatMap((organization) => [
      { provider: 'azure-devops', baseUrl: `https://${AZURE_DEVOPS_HOST}/${organization}` },
      { provider: 'azure-devops', baseUrl: `https://${organization}${VISUALSTUDIO_SUFFIX}` }
    ])
  },
  route: (instance, method, target, context) => {
    const addressed = organizationOf(instance, target)
    if (!addressed?.rest.every((segment, i, all) => plainSegment(segment, i === all.length - 1))) {
      return deny(400, NOT_A_REPOSITORY)
    }
    const { organization, rest } = addressed
    const held = context.repositories.filter(
      (repository) => repository.azureDevOps !== undefined && same(repository.azureDevOps.organization, organization)
    )
    if (!AZURE_DEVOPS_ORGANIZATION.test(organization) || held.length === 0) return deny(403, OTHER_ORGANIZATION)
    const lower = rest.map((segment) => segment.toLowerCase())
    // `[{project}/]_git/…` or `[{project}/]_apis/…`; the project is a name or its GUID.
    const at = lower[0] === '_git' || lower[0] === '_apis' ? 0 : lower[1] === '_git' || lower[1] === '_apis' ? 1 : -1
    if (at < 0) return deny(403, NOT_AVAILABLE)
    const project = at === 1 ? decodedName(rest[0]) : undefined
    if (at === 1 && project === undefined) return deny(400, NOT_A_REPOSITORY)
    const after = rest.slice(at + 1)
    return lower[at] === '_git' ? gitRoute(held, project, after, target) : apiRoute(held, project, after, method)
  }
}
