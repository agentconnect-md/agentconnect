// The Azure DevOps route descriptor (azure-devops-integration.md §6.2, §6.3): deny-by-default, every repository resolved among the agent's own.
import { describe, expect, it } from 'vitest'
import { PULL_REQUEST_NOT_FOUND } from '../src/azure-devops/proxy-route.js'
import {
  instanceRoute,
  proxyHosts,
  proxyInstance,
  routeDescriptor,
  type ProxyInstance,
  type ProxyRepository
} from '../src/credential-proxy/instance-route.js'
import { AZURE_DEVOPS_MANAGED_HOST } from '../src/gitcred/managed-hosts.js'

const ORG = 'example-org'
const PROJECT = '00000000-0000-4000-8000-000000000001'
const TOOLS_PROJECT = '00000000-0000-4000-8000-000000000002'
const REPO = '00000000-0000-4000-8000-000000000011'
const SECOND = '00000000-0000-4000-8000-000000000012'
const TOOLS = '00000000-0000-4000-8000-000000000013'
const UNHELD = '00000000-0000-4000-8000-000000000099'

const REPOSITORIES: ProxyRepository[] = [
  {
    repoId: '42',
    repoFullName: 'example-org/Example Project/Example Repo',
    workspace: true,
    azureDevOps: { organization: ORG, projectId: PROJECT, repositoryId: REPO }
  },
  {
    repoId: '43',
    repoFullName: 'example-org/Example Project/Second Repo',
    azureDevOps: { organization: ORG, projectId: PROJECT, repositoryId: SECOND }
  },
  {
    repoId: '44',
    repoFullName: 'example-org/Tools/Tools',
    azureDevOps: { organization: ORG, projectId: TOOLS_PROJECT, repositoryId: TOOLS }
  }
]
const CONTEXT = { repositories: REPOSITORIES }
const [DEV, VS] = proxyHosts(AZURE_DEVOPS_MANAGED_HOST, () => REPOSITORIES).map((host) => proxyInstance(host)!) as [
  ProxyInstance,
  ProxyInstance
]

const WORKSPACE = { repo: 'example-org/Example Project/Example Repo', repoId: '42' }
const SECOND_REPO = { repo: 'example-org/Example Project/Second Repo', repoId: '43' }

const route = (method: string, target: string, instance: ProxyInstance = DEV) =>
  instanceRoute(instance, method, target, CONTEXT)

function notFound(identifier: string) {
  return JSON.stringify({
    $id: '1',
    innerException: null,
    message: `TF401019: The Git repository with name or identifier ${identifier} does not exist or you do not have permissions for the operation you are attempting.`,
    typeName: 'Microsoft.TeamFoundation.Git.Server.GitRepositoryNotFoundException, Microsoft.TeamFoundation.Git.Server',
    typeKey: 'GitRepositoryNotFoundException',
    errorCode: 0,
    eventId: 3000
  })
}

describe('the instances an Azure DevOps organization contributes', () => {
  it('serves dev.azure.com under the organization’s prefix and its own visualstudio.com name, both SaaS', () => {
    expect(proxyHosts(AZURE_DEVOPS_MANAGED_HOST, () => REPOSITORIES)).toEqual([
      { provider: 'azure-devops', baseUrl: 'https://dev.azure.com/example-org' },
      { provider: 'azure-devops', baseUrl: 'https://example-org.visualstudio.com' }
    ])
    expect(DEV).toEqual({ provider: 'azure-devops', hosts: ['dev.azure.com'], pathPrefix: 'example-org', saas: true })
    expect(VS).toEqual({
      provider: 'azure-devops',
      hosts: ['example-org.visualstudio.com'],
      pathPrefix: '',
      saas: true
    })
    // A repository without its routing reaches no instance, so nothing is served on a guess.
    expect(proxyHosts(AZURE_DEVOPS_MANAGED_HOST, () => [{ repoId: '42', repoFullName: 'example-org/P/R' }])).toEqual([])
    expect(routeDescriptor('azure-devops')).toMatchObject({ saas: true, basicAuthorization: true })
    // A provider without the member serves its managed host as it is, never reading the repositories.
    const gitlab = { provider: 'gitlab', baseUrl: 'https://gitlab.example.test' }
    expect(
      proxyHosts(gitlab, () => {
        throw new Error('read')
      })
    ).toEqual([gitlab])
  })
})

describe('git on an authorized repository', () => {
  const base = '/example-org/Example%20Project/_git/Example%20Repo'

  it('fetches with a read lease and pushes at the agent’s tier', () => {
    const fetch = { kind: 'repository', plane: 'git', ...WORKSPACE, push: false, readOnly: true }
    const push = { ...fetch, push: true, readOnly: false }
    expect(route('GET', `${base}/info/refs?service=git-upload-pack`)).toEqual(fetch)
    expect(route('POST', `${base}/git-upload-pack`)).toEqual(fetch)
    expect(route('GET', `${base}/info/refs?service=git-receive-pack`)).toEqual(push)
    expect(route('POST', `${base}/git-receive-pack`)).toEqual(push)
  })

  it('resolves a name case-insensitively, after percent-decoding, with `.git`, a project GUID, or the project-less form', () => {
    for (const target of [
      '/example-org/example%20project/_git/EXAMPLE%20REPO.git/info/refs',
      `/example-org/${PROJECT}/_git/Example%20Repo/info/refs`,
      `/Example-Org/${PROJECT.toUpperCase()}/_GIT/Example%20Repo/info/refs`
    ]) {
      expect(route('GET', target)).toMatchObject({ kind: 'repository', ...WORKSPACE })
    }
    // `{organization}/_git/{repository}` names the project like its repository.
    expect(route('GET', '/example-org/_git/Tools/info/refs')).toMatchObject({ repoId: '44' })
    expect(route('GET', '/example-org/_git/Example%20Repo/info/refs')).toMatchObject({ kind: 'deny', status: 404 })
  })

  it('answers a repository outside the authorizations as Azure DevOps answers one that does not exist', () => {
    expect(route('GET', '/example-org/Example%20Project/_git/Hidden%20Repo/info/refs?service=git-upload-pack')).toEqual(
      {
        kind: 'deny',
        status: 404,
        reason:
          'TF401019: The Git repository with name or identifier Hidden Repo does not exist or you do not have permissions for the operation you are attempting.'
      }
    )
    // A held name in another project is another repository.
    expect(route('POST', `/example-org/${TOOLS_PROJECT}/_git/Example%20Repo/git-receive-pack`)).toMatchObject({
      kind: 'deny',
      status: 404
    })
  })

  it('refuses anything but git’s own services, so no spelling of a push reads as a fetch', () => {
    for (const target of [
      `${base}/GIT-RECEIVE-PACK`,
      `${base}/INFO/REFS`,
      `${base}/info/lfs/objects/batch`,
      base,
      `${base}/pullrequest/7`
    ]) {
      expect(route('POST', target)).toMatchObject({ kind: 'deny', status: 403 })
    }
  })
})

describe('the REST API naming a repository', () => {
  it('resolves a GUID with or without a project, and a name within its project', () => {
    const read = { kind: 'repository', plane: 'api', ...WORKSPACE, readOnly: true }
    expect(route('GET', `/example-org/_apis/git/repositories/${REPO}?api-version=7.1`)).toEqual(read)
    expect(route('GET', `/example-org/Example%20Project/_apis/git/repositories/${REPO}/commits`)).toEqual(read)
    expect(route('GET', `/example-org/${PROJECT}/_apis/git/repositories/${REPO.toUpperCase()}/refs`)).toEqual(read)
    expect(route('GET', '/example-org/Example%20Project/_apis/git/repositories/Second%20Repo/items?path=/')).toEqual({
      kind: 'repository',
      plane: 'api',
      ...SECOND_REPO,
      readOnly: true
    })
  })

  it('answers what the agent does not hold as Azure DevOps answers a repository that does not exist', () => {
    const refused = (identifier: string) => ({ kind: 'deny', status: 404, reason: notFound(identifier) })
    expect(route('GET', `/example-org/_apis/git/repositories/${UNHELD}`)).toEqual(refused(UNHELD))
    expect(route('GET', '/example-org/Example%20Project/_apis/git/repositories/Hidden%20Repo')).toEqual(
      refused('Hidden Repo')
    )
    // Azure DevOps finds a name only within a project; a held GUID under another project is not it.
    expect(route('GET', '/example-org/_apis/git/repositories/Example%20Repo')).toEqual(refused('Example Repo'))
    expect(route('GET', `/example-org/Tools/_apis/git/repositories/${REPO}`)).toEqual(refused(REPO))
  })

  it('forwards a write only as a write, which needs a `write` grant, and refuses a write naming no repository', () => {
    const write = { kind: 'repository', plane: 'api', ...SECOND_REPO, readOnly: false, write: true }
    expect(route('POST', `/example-org/Example%20Project/_apis/git/repositories/${SECOND}/pullrequests`)).toEqual(write)
    expect(
      route('PATCH', '/example-org/Example%20Project/_apis/git/repositories/Second%20Repo/pullrequests/7')
    ).toEqual(write)
    expect(route('POST', '/example-org/Example%20Project/_apis/git/repositories')).toMatchObject({
      kind: 'deny',
      status: 403,
      reason: expect.stringContaining('names no repository')
    })
    expect(route('POST', '/example-org/Example%20Project/_apis/wit/workitems/$Task')).toMatchObject({
      kind: 'deny',
      status: 403,
      reason: expect.stringContaining('names no repository')
    })
  })
})

describe('everything else is refused', () => {
  it('refuses the repository, project and pull-request lists at organization and project scope', () => {
    for (const target of [
      '/example-org/_apis/git/repositories',
      '/example-org/_apis/git/repositories/',
      '/example-org/Example%20Project/_apis/git/repositories?api-version=7.1',
      '/example-org/_apis/projects',
      '/example-org/_apis/projects/Example%20Project',
      '/example-org/Example%20Project/_apis/git/pullrequests?searchCriteria.status=active',
      '/example-org/_apis/git/pullrequests',
      '/example-org/_apis/search/codesearchresults',
      '/example-org/Example%20Project',
      '/example-org'
    ]) {
      expect(route('GET', target)).toMatchObject({ kind: 'deny', status: 403 })
    }
  })

  it('refuses another organization and a path that names no single repository', () => {
    expect(route('GET', '/other-org/_apis/connectionData')).toMatchObject({ kind: 'deny', status: 403 })
    expect(route('GET', '/other-org/Example%20Project/_git/Example%20Repo/info/refs')).toMatchObject({
      kind: 'deny',
      status: 403
    })
    const other = proxyInstance({ provider: 'azure-devops', baseUrl: 'https://other-org.visualstudio.com' })!
    expect(route('GET', '/Example%20Project/_git/Example%20Repo/info/refs', other)).toMatchObject({
      kind: 'deny',
      status: 403
    })
    expect(route('GET', '/example-org/Example%2FProject/_git/Example%20Repo/info/refs')).toMatchObject({
      kind: 'deny',
      status: 400
    })
    expect(route('GET', '/example-org/%E0%A4%A/_apis/git/repositories/x')).toMatchObject({ kind: 'deny', status: 400 })
    // Below a held repository too: an encoded separator or an empty segment is never forwarded on its credential.
    for (const target of [
      `/example-org/_apis/git/repositories/${REPO}/..%2F..%2Frepositories%2F${UNHELD}`,
      `/example-org/_apis/git/repositories/${REPO}/items%5C..`,
      `/example-org/_apis/git/repositories/${REPO}//refs`
    ]) {
      expect(route('GET', target)).toMatchObject({ kind: 'deny', status: 400 })
    }
  })
})

describe('the organization-wide reads the Azure CLI makes', () => {
  it('forwards connectionData and resource-area lookups as reads under any held repository, and nothing else at that scope', () => {
    const read = { kind: 'repository', plane: 'api', ...WORKSPACE, readOnly: true }
    expect(route('GET', '/example-org/_apis/connectionData')).toEqual(read)
    expect(route('GET', '/example-org/_apis/ResourceAreas')).toEqual(read)
    expect(route('GET', `/example-org/_apis/resourceAreas/${UNHELD}`)).toEqual(read)
    expect(route('POST', '/example-org/_apis/connectionData')).toMatchObject({ kind: 'deny', status: 403 })
    expect(route('GET', '/example-org/Example%20Project/_apis/connectionData')).toMatchObject({ kind: 'deny' })
  })
})

describe('one pull request by id', () => {
  it('is looked up with a read lease, answered for the agent’s own repository, and as a missing id for any other', () => {
    for (const target of [
      '/example-org/Example%20Project/_apis/git/pullrequests/7?api-version=7.1',
      '/example-org/_apis/git/pullRequests/7'
    ]) {
      const lookup = route('GET', target)
      expect(lookup).toMatchObject({ kind: 'lookup', via: WORKSPACE, hidden: PULL_REQUEST_NOT_FOUND })
      const owner = (lookup as { owner: (answer: unknown) => unknown }).owner
      expect(owner({ pullRequestId: 7, repository: { id: SECOND.toUpperCase() } })).toEqual(SECOND_REPO)
      expect(owner({ pullRequestId: 7, repository: { id: UNHELD } })).toBeUndefined()
      expect(owner({ pullRequestId: 7 })).toBeUndefined()
      expect(owner(null)).toBeUndefined()
    }
    expect(JSON.parse(PULL_REQUEST_NOT_FOUND.reason)).toEqual({
      $id: '1',
      innerException: null,
      message: 'TF401180: The requested pull request was not found.',
      typeName:
        'Microsoft.TeamFoundation.Git.Server.GitPullRequestNotFoundException, Microsoft.TeamFoundation.Git.Server',
      typeKey: 'GitPullRequestNotFoundException',
      errorCode: 0,
      eventId: 3000
    })
    expect(PULL_REQUEST_NOT_FOUND.status).toBe(404)
  })

  it('answers only GET that way, and refuses any other method or a malformed id', () => {
    for (const method of ['PATCH', 'POST', 'DELETE', 'HEAD']) {
      expect(route(method, '/example-org/Example%20Project/_apis/git/pullrequests/7')).toMatchObject({
        kind: 'deny',
        status: 403
      })
    }
    expect(route('GET', '/example-org/_apis/git/pullrequests/seven')).toMatchObject({ kind: 'deny', status: 400 })
    expect(route('GET', '/example-org/_apis/git/pullrequests/7/threads')).toMatchObject({ kind: 'deny', status: 403 })
  })
})

describe('the organization’s visualstudio.com name', () => {
  it('routes as dev.azure.com does, with the organization in the host and an optional DefaultCollection', () => {
    for (const target of [
      '/Example%20Project/_git/Example%20Repo/info/refs?service=git-upload-pack',
      '/DefaultCollection/Example%20Project/_git/Example%20Repo/info/refs?service=git-upload-pack'
    ]) {
      expect(route('GET', target, VS)).toMatchObject({ kind: 'repository', plane: 'git', ...WORKSPACE })
    }
    expect(route('GET', `/_apis/git/repositories/${SECOND}`, VS)).toMatchObject({ ...SECOND_REPO, readOnly: true })
    expect(route('GET', '/_apis/connectionData', VS)).toMatchObject({ kind: 'repository', readOnly: true })
    expect(route('GET', '/_apis/git/repositories', VS)).toMatchObject({ kind: 'deny', status: 403 })
  })
})
