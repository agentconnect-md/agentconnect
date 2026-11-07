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
/** The version the proxy's own lookups ask for, whatever the request named. */
const LOOKUP_API_VERSION = '7.1'

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

const OTHER_ORGANIZATION = "this agent's Azure DevOps credential does not reach that organization"
const NOT_A_REPOSITORY = 'the path does not name one Azure DevOps repository'
const WRITE_NAMING_NO_REPOSITORY =
  "an Azure DevOps write that names no repository is not available with this agent's credential"
const REPOSITORY_LIST =
  "Azure DevOps repository lists are not available with this agent's credential; its repositories are named in its context"
const PULL_REQUEST_LIST =
  "pull-request lists that name no repository are not available with this agent's credential; list them under the repository (_apis/git/repositories/{repository}/pullrequests)"
const PULL_REQUEST_WRITE =
  'a pull request is changed under its repository (_apis/git/repositories/{repository}/pullrequests/{id})'
const NOT_AVAILABLE =
  "only Git and the REST API of the agent's own Azure DevOps repositories are available with this agent's credential"
const WRITE_NOT_AVAILABLE =
  "only pull requests, pushes, refs, commit statuses and annotated tags are written with this agent's credential"
const OTHER_REPOSITORY_QUERY =
  "a query naming another repository is not available with this agent's credential; name the repository in the path"
const NOT_A_PULL_REQUEST = 'the pull request id is not a number'

/** Names Azure DevOps treats as one: equal lower-cased and upper-cased alike, so a sign such as Kelvin's never folds onto an ASCII letter. */
function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase() && a.toUpperCase() === b.toUpperCase()
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

/** Whether a segment, read as Azure DevOps reads it after percent-decoding, is the keyword. */
function is(segment: string | undefined, keyword: string): boolean {
  const name = decodedName(segment)
  return name !== undefined && same(name, keyword)
}

/** A segment that decodes to one plain name, an empty one only last (a trailing slash): an encoded separator or dot segment names no single resource. */
function plainSegment(segment: string, last: boolean): boolean {
  return segment === '' ? last : decodedName(segment) !== undefined
}

/** The organization a request addresses, the segments that name it, and the path below: the first segment on dev.azure.com, the host's own name on `{organization}.visualstudio.com` (optionally under `DefaultCollection`). */
function organizationOf(
  instance: ProxyInstance,
  target: string
): { organization: string; prefix: string[]; rest: string[] } | undefined {
  const segments = requestPath(target).split('/').slice(1)
  const host = instance.hosts[0] ?? ''
  if (host === AZURE_DEVOPS_HOST) {
    const [first, ...rest] = segments
    const organization = decodedName(first)
    return organization !== undefined ? { organization, prefix: [first!], rest } : undefined
  }
  if (!host.endsWith(VISUALSTUDIO_SUFFIX)) return undefined
  const collection = is(segments[0], 'DefaultCollection') ? 1 : 0
  return {
    organization: host.slice(0, -VISUALSTUDIO_SUFFIX.length),
    prefix: segments.slice(0, collection),
    rest: segments.slice(collection)
  }
}

/** The held repository's project matches a project segment: a GUID-shaped one by the project's id alone, any other by name. */
function inProject(repository: ProxyRepository, project: string): boolean {
  if (GUID.test(project)) return same(repository.azureDevOps!.projectId, project)
  const name = azureDevOpsRepoName(repository.repoFullName)
  return name !== undefined && same(name.project, project)
}

/** A held repository by name, taken literally (a `.git` suffix is part of it): in the named project, or, with no project, in the project named like it. */
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

/** A held repository as a path segment names it: a GUID-shaped segment by id alone, never by name, as Azure DevOps reads it. */
function heldBySegment(held: readonly ProxyRepository[], project: string | undefined, identifier: string) {
  if (GUID.test(identifier)) return heldById(held, project, identifier)
  // Azure DevOps finds a repository by name only within a project, or in the project named like it on git's own path.
  return heldByName(held, project, identifier)
}

function ref(repository: ProxyRepository): RepositoryRef {
  return { repo: repository.repoFullName, repoId: repository.repoId }
}

/** `{repository}/(info/refs | git-upload-pack | git-receive-pack)`, the service spelled exactly as git sends it, or a read of the `vsts/info` the Azure CLI resolves a remote with; a GUID names the repository only below its project. */
function gitRoute(
  held: readonly ProxyRepository[],
  project: string | undefined,
  after: string[],
  method: string,
  target: string
): InstanceRoute {
  const repository = decodedName(after[0])
  const service = after.slice(1).join('/')
  const info = service === 'vsts/info' && READS.has(method.toUpperCase())
  if (!repository || !(info || GIT_SERVICES.has(service))) return deny(403, NOT_AVAILABLE)
  const found = GUID.test(repository) && project === undefined ? undefined : heldBySegment(held, project, repository)
  if (!found) return repositoryNotFound(repository, 'git')
  if (info) return { kind: 'repository', plane: 'api', ...ref(found), readOnly: true }
  const push = isGitPush(after.at(-1)!, target)
  return { kind: 'repository', plane: 'git', ...ref(found), push, readOnly: !push }
}

/** One pull request by id, any method: forwarded under `owner`'s repository only once the proxy's own GET shows the pull request is there, else answered as a missing id. */
function pullRequestLookup(
  via: ProxyRepository,
  apis: string,
  id: string,
  owner: (repositoryId: string) => ProxyRepository | undefined,
  write: boolean
): InstanceRoute {
  return {
    kind: 'lookup',
    via: ref(via),
    target: `${apis}/git/pullrequests/${id}?api-version=${LOOKUP_API_VERSION}`,
    owner: (answer) => {
      const repositoryId = (answer as { repository?: { id?: unknown } } | null)?.repository?.id
      const found = typeof repositoryId === 'string' ? owner(repositoryId) : undefined
      return found && ref(found)
    },
    hidden: PULL_REQUEST_NOT_FOUND,
    // A rejected credential answers 401 rather than a sign-in page.
    headers: { 'x-tfs-fedauthredirect': 'Suppress' },
    ...(write ? { write: true as const } : {})
  }
}

/** Whether a query names, in a repository criterion, a repository other than `found`, which Azure DevOps would answer about under its lease; read as loosely as its binder may. */
function namesOtherRepository(target: string, found: ProxyRepository): boolean {
  const at = target.indexOf('?')
  if (at < 0) return false
  for (const [key, value] of new URLSearchParams(target.slice(at + 1))) {
    const name = key.toUpperCase().replace(/\[([^\]]*)\]/g, '.$1')
    if (name.endsWith('REPOSITORYID') && !same(value, found.azureDevOps!.repositoryId)) return true
  }
  return false
}

/** The parts of a repository a `write` grant changes: its pull requests and everything under them, pushes, refs, commit statuses and annotated tags; never the repository itself. */
function writable(below: readonly string[]): boolean {
  if (is(below[0], 'pullrequests')) return true
  if (below.length === 1) return is(below[0], 'pushes') || is(below[0], 'refs') || is(below[0], 'annotatedtags')
  return below.length === 3 && is(below[0], 'commits') && is(below[2], 'statuses')
}

/** A request below one held repository: a read as it is, a pull request's only once it is shown to be that repository's, and a write only to the parts a `write` grant changes. */
function repositoryResource(
  found: ProxyRepository,
  below: string[],
  method: string,
  target: string,
  apis: string
): InstanceRoute {
  const read = READS.has(method.toUpperCase())
  if (namesOtherRepository(target, found)) return deny(403, OTHER_REPOSITORY_QUERY)
  // A trailing slash names the same resource.
  const parts = below.at(-1) === '' ? below.slice(0, -1) : below
  if (is(parts[0], 'pullrequests') && parts[1] !== undefined) {
    if (!PULL_REQUEST_ID.test(parts[1])) return deny(400, NOT_A_PULL_REQUEST)
    const repositoryId = found.azureDevOps!.repositoryId
    return pullRequestLookup(found, apis, parts[1], (id) => (same(id, repositoryId) ? found : undefined), !read)
  }
  if (read) return { kind: 'repository', plane: 'api', ...ref(found), readOnly: true }
  if (!writable(parts)) return deny(403, WRITE_NOT_AVAILABLE)
  return { kind: 'repository', plane: 'api', ...ref(found), readOnly: false, write: true }
}

/** The REST API below `_apis`: a held repository, the pull-request lookup, or the allowlist; nothing else. */
function apiRoute(
  held: readonly ProxyRepository[],
  project: string | undefined,
  after: string[],
  method: string,
  target: string,
  apis: string
): InstanceRoute {
  const read = READS.has(method.toUpperCase())
  if (is(after[0], 'git') && is(after[1], 'repositories')) {
    if (after[2] === undefined || after[2] === '') return deny(403, read ? REPOSITORY_LIST : WRITE_NAMING_NO_REPOSITORY)
    const identifier = decodedName(after[2])
    if (!identifier) return deny(400, NOT_A_REPOSITORY)
    // A name without a project is no repository Azure DevOps finds here.
    const found = GUID.test(identifier) || project !== undefined ? heldBySegment(held, project, identifier) : undefined
    if (!found) return repositoryNotFound(identifier, 'api')
    return repositoryResource(found, after.slice(3), method, target, apis)
  }
  if (is(after[0], 'git') && is(after[1], 'pullrequests')) {
    if (after[2] === undefined || after[2] === '')
      return deny(403, read ? PULL_REQUEST_LIST : WRITE_NAMING_NO_REPOSITORY)
    if (after.length > 3) return deny(403, NOT_AVAILABLE)
    if (method.toUpperCase() !== 'GET') return deny(403, PULL_REQUEST_WRITE)
    if (!PULL_REQUEST_ID.test(after[2])) return deny(400, NOT_A_PULL_REQUEST)
    return pullRequestLookup(held[0]!, apis, after[2], (id) => heldById(held, undefined, id), false)
  }
  // The lookups the Azure CLI makes before any command, one level deep, and its OPTIONS of the API's locations; none shows a repository.
  const allowlisted =
    (method.toUpperCase() === 'OPTIONS' && (after.length === 0 || (after.length === 1 && after[0] === ''))) ||
    (is(after[0], 'connectionData') && after.length === 1) ||
    (is(after[0], 'ResourceAreas') && (after.length === 1 || (after.length === 2 && after[1] !== '')))
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
  // Azure DevOps would run the method these name instead of the one the request was routed by.
  refusedHeaders: ['x-http-method-override', 'x-http-method', 'x-method-override'],
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
    const { organization, prefix, rest } = addressed
    const held = context.repositories.filter(
      (repository) => repository.azureDevOps !== undefined && same(repository.azureDevOps.organization, organization)
    )
    if (!AZURE_DEVOPS_ORGANIZATION.test(organization) || held.length === 0) return deny(403, OTHER_ORGANIZATION)
    // `[{project}/]_git/…` or `[{project}/]_apis/…`; the project is a name or its GUID.
    const at = is(rest[0], '_git') || is(rest[0], '_apis') ? 0 : is(rest[1], '_git') || is(rest[1], '_apis') ? 1 : -1
    if (at < 0) return deny(403, NOT_AVAILABLE)
    const project = at === 1 ? decodedName(rest[0]) : undefined
    if (at === 1 && project === undefined) return deny(400, NOT_A_REPOSITORY)
    const after = rest.slice(at + 1)
    if (is(rest[at], '_git')) return gitRoute(held, project, after, method, target)
    // The proxy's own lookups address the organization and project the request does.
    const apis = `/${[...prefix, ...rest.slice(0, at), '_apis'].join('/')}`
    return apiRoute(held, project, after, method, target, apis)
  }
}
