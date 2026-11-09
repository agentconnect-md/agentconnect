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
const KIT_PROJECT = '00000000-0000-4000-8000-000000000003'
const KIT = '00000000-0000-4000-8000-000000000014'
const KIT_LETTERS = '00000000-0000-4000-8000-000000000015'
// A held repository whose name is shaped like a GUID, and its own id.
const GUID_NAME = '00000000-0000-4000-8000-0000000000aa'
const GUID_NAMED = '00000000-0000-4000-8000-0000000000ab'

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
  },
  {
    repoId: '45',
    repoFullName: 'example-org/Kit/Kit',
    azureDevOps: { organization: ORG, projectId: KIT_PROJECT, repositoryId: KIT }
  },
  {
    repoId: '46',
    repoFullName: `example-org/Example Project/${GUID_NAME}`,
    azureDevOps: { organization: ORG, projectId: PROJECT, repositoryId: GUID_NAMED }
  },
  {
    repoId: '47',
    repoFullName: 'example-org/Kit/Kåω',
    azureDevOps: { organization: ORG, projectId: KIT_PROJECT, repositoryId: KIT_LETTERS }
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

function gitNotFound(identifier: string) {
  return {
    kind: 'deny',
    status: 404,
    reason: `TF401019: The Git repository with name or identifier ${identifier} does not exist or you do not have permissions for the operation you are attempting.`
  }
}

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

  it('resolves a name ignoring ASCII case after percent-decoding, a project by name or GUID, or the project-less form', () => {
    for (const target of [
      '/example-org/example%20project/_git/EXAMPLE%20REPO/info/refs',
      `/example-org/${PROJECT}/_git/Example%20Repo/info/refs`,
      `/Example-Org/${PROJECT.toUpperCase()}/_GIT/Example%20Repo/info/refs`,
      `/example-org/%45xample%20Project/%5Fgit/Example%20Repo/info/refs`
    ]) {
      expect(route('GET', target)).toMatchObject({ kind: 'repository', ...WORKSPACE })
    }
    // `{organization}/_git/{repository}` names the project like its repository.
    expect(route('GET', '/example-org/_git/Tools/info/refs')).toMatchObject({ repoId: '44' })
    expect(route('GET', '/example-org/KIT/_git/KIT/info/refs')).toMatchObject({ repoId: '45' })
    expect(route('GET', '/example-org/_git/Example%20Repo/info/refs')).toMatchObject({ kind: 'deny', status: 404 })
  })

  it('names the repository as Azure DevOps does: a `.git` suffix literally, and no sign folded onto an ASCII letter', () => {
    // Azure DevOps answers `Example Repo.git` as a repository of that name, which the agent does not hold.
    expect(route('GET', '/example-org/Example%20Project/_git/Example%20Repo.git/info/refs')).toEqual(
      gitNotFound('Example Repo.git')
    )
    // The Kelvin, Angstrom and Ohm signs lower-case to letters of the name but upper-case to themselves.
    for (const name of ['\u212A\u00E5\u03C9', 'k\u212B\u03C9', 'k\u00E5\u2126']) {
      expect(route('GET', `/example-org/Kit/_git/${encodeURIComponent(name)}/info/refs`)).toEqual(gitNotFound(name))
    }
    expect(route('GET', '/example-org/%E2%84%AAit/_git/Kit/info/refs')).toEqual(gitNotFound('Kit'))
    // The name's own letters still match in either case.
    expect(route('GET', `/example-org/KIT/_git/${encodeURIComponent('K\u00C5\u03A9')}/info/refs`)).toMatchObject({
      repoId: '47'
    })
  })

  it('reads a GUID-shaped repository segment as the id alone, and only below a project', () => {
    for (const target of [
      `/example-org/Example%20Project/_git/${REPO}/info/refs`,
      `/example-org/${PROJECT}/_git/${REPO.toUpperCase()}/info/refs`
    ]) {
      expect(route('GET', target)).toMatchObject({ kind: 'repository', ...WORKSPACE })
    }
    // Azure DevOps refuses a GUID without its project.
    expect(route('GET', `/example-org/_git/${REPO}/info/refs`)).toEqual(gitNotFound(REPO))
    // A held repository named like a GUID is not found by that name, only by its id.
    expect(route('GET', `/example-org/Example%20Project/_git/${GUID_NAME}/info/refs`)).toEqual(gitNotFound(GUID_NAME))
    expect(route('GET', `/example-org/Example%20Project/_git/${GUID_NAMED}/info/refs`)).toMatchObject({ repoId: '46' })
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

  it('reads the `vsts/info` the Azure CLI resolves a remote with, for a held repository only', () => {
    const read = { kind: 'repository', plane: 'api', ...WORKSPACE, readOnly: true }
    expect(route('GET', `${base}/vsts/info`)).toEqual(read)
    expect(route('HEAD', `${base}/vsts/info`)).toEqual(read)
    expect(route('GET', '/example-org/Example%20Project/_git/Hidden%20Repo/vsts/info')).toEqual(
      gitNotFound('Hidden Repo')
    )
    for (const target of [`${base}/vsts/info/x`, `${base}/VSTS/INFO`, `${base}/vsts`]) {
      expect(route('GET', target)).toMatchObject({ kind: 'deny', status: 403 })
    }
    expect(route('POST', `${base}/vsts/info`)).toMatchObject({ kind: 'deny', status: 403 })
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
    // A GUID-shaped identifier is an id alone, never a held repository's name.
    expect(route('GET', `/example-org/Example%20Project/_apis/git/repositories/${GUID_NAME}`)).toEqual(
      refused(GUID_NAME)
    )
    expect(route('GET', `/example-org/_apis/git/repositories/${GUID_NAMED}`)).toMatchObject({ repoId: '46' })
  })

  it('forwards a write only as a write, which needs a `write` grant, and refuses a write naming no repository', () => {
    const write = { kind: 'repository', plane: 'api', ...SECOND_REPO, readOnly: false, write: true }
    expect(route('POST', `/example-org/Example%20Project/_apis/git/repositories/${SECOND}/pullrequests`)).toEqual(write)
    expect(
      route('PATCH', '/example-org/Example%20Project/_apis/git/repositories/Second%20Repo/pullrequests/7')
    ).toMatchObject({ kind: 'lookup', via: SECOND_REPO, write: true })
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

describe('a write below a held repository', () => {
  const repo = `/example-org/Example%20Project/_apis/git/repositories/${SECOND}`
  const read = { kind: 'repository', plane: 'api', ...SECOND_REPO, readOnly: true }

  it('never changes the repository itself', () => {
    for (const method of ['PATCH', 'DELETE', 'PUT', 'POST']) {
      for (const target of [repo, `${repo}/`, `${repo}?api-version=7.1`]) {
        expect(route(method, target)).toMatchObject({
          kind: 'deny',
          status: 403,
          reason: expect.stringContaining('only pull requests, pushes, refs, commit statuses and annotated tags')
        })
      }
    }
    // Reading it stays as it was.
    expect(route('GET', repo)).toEqual(read)
  })

  it('reaches pull requests, pushes, refs, commit statuses and annotated tags alone', () => {
    const write = { kind: 'repository', plane: 'api', ...SECOND_REPO, readOnly: false, write: true }
    for (const [method, below] of [
      ['POST', 'pullrequests'],
      ['POST', 'pushes'],
      ['POST', 'refs'],
      ['PATCH', 'refs?filter=heads/main'],
      ['POST', `commits/${'1'.repeat(40)}/statuses`],
      ['POST', 'annotatedtags'],
      ['POST', 'PushES/']
    ]) {
      expect(route(method!, `${repo}/${below}`)).toEqual(write)
    }
    for (const below of [
      'forks',
      'importRequests',
      'items',
      'commits',
      `commits/${'1'.repeat(40)}`,
      `commits/${'1'.repeat(40)}/statuses/1`,
      'pushes/1',
      'refs/heads',
      'commitsbatch',
      'pullrequestquery'
    ]) {
      expect(route('POST', `${repo}/${below}`)).toMatchObject({ kind: 'deny', status: 403 })
      // A read there is forwarded as it always was.
      expect(route('GET', `${repo}/${below}`)).toEqual(read)
    }
  })
})

describe('a pull request below a held repository', () => {
  const apis = '/example-org/Example%20Project/_apis'
  const owner = (lookup: unknown) => (lookup as { owner: (answer: unknown) => unknown }).owner

  it('is looked up by its id first, whatever the method, and forwarded only when it is that repository’s', () => {
    for (const [method, below] of [
      ['GET', '7'],
      ['GET', '7/threads'],
      ['PATCH', '7'],
      ['POST', '7/threads/1/comments'],
      ['PUT', '7/reviewers/00000000-0000-4000-8000-0000000000c1'],
      ['DELETE', '7/labels/x']
    ]) {
      const lookup = route(method!, `${apis}/git/repositories/${SECOND}/pullRequests/${below}?api-version=7.2-preview`)
      expect(lookup).toMatchObject({
        kind: 'lookup',
        via: SECOND_REPO,
        // The proxy's own path and version: nothing of the client's query reaches the lookup.
        target: `${apis}/git/pullrequests/7?api-version=7.1`,
        hidden: PULL_REQUEST_NOT_FOUND
      })
      expect((lookup as { write?: true }).write).toBe(method === 'GET' ? undefined : true)
      expect(owner(lookup)({ repository: { id: SECOND.toUpperCase() } })).toEqual(SECOND_REPO)
      // Another held repository's pull request is not this one's.
      expect(owner(lookup)({ repository: { id: REPO } })).toBeUndefined()
      expect(owner(lookup)({ repository: { id: UNHELD } })).toBeUndefined()
    }
    // By name, on the organization's own host, the lookup addresses what the request does.
    expect(
      route('GET', '/DefaultCollection/Example%20Project/_apis/git/repositories/Second%20Repo/pullrequests/7', VS)
    ).toMatchObject({
      kind: 'lookup',
      target: '/DefaultCollection/Example%20Project/_apis/git/pullrequests/7?api-version=7.1'
    })
    // A keyword spelled in percent-escapes reads as Azure DevOps reads it, so it cannot skip the lookup.
    expect(route('GET', `${apis}/git/repositories/${SECOND}/%70ullrequests/7/threads`)).toMatchObject({
      kind: 'lookup',
      target: `${apis}/git/pullrequests/7?api-version=7.1`
    })
    expect(route('GET', `${apis}/git/repositories/${SECOND}/pullrequests/seven`)).toMatchObject({
      kind: 'deny',
      status: 400
    })
  })

  it('refuses a query naming another repository, however it is spelled', () => {
    const list = `${apis}/git/repositories/${SECOND}/pullrequests`
    for (const query of [
      `searchCriteria.repositoryId=${UNHELD}`,
      `searchCriteria.sourceRepositoryId=${REPO}`,
      `SEARCHCRITERIA.SOURCEREPOSITORYID=${UNHELD}`,
      `searchCriteria[repositoryId]=${UNHELD}`,
      `repositoryId=${UNHELD}`,
      `searchCriteria.repositoryId=${SECOND}&searchCriteria.repositoryId=${UNHELD}`
    ]) {
      expect(route('GET', `${list}?${query}`)).toMatchObject({ kind: 'deny', status: 403 })
    }
    const read = { kind: 'repository', plane: 'api', ...SECOND_REPO, readOnly: true }
    expect(
      route('GET', `${list}?searchCriteria.repositoryId=${SECOND.toUpperCase()}&searchCriteria.status=active`)
    ).toEqual(read)
    expect(route('GET', `${list}?searchCriteria.status=active`)).toEqual(read)
  })
})

describe('a method override', () => {
  it('refuses a request that would have Azure DevOps run another method than the one routed', () => {
    const target = `/example-org/_apis/git/repositories/${REPO}/items?path=/`
    for (const header of ['X-HTTP-Method-Override', 'x-http-method', 'X-Method-Override']) {
      const headers = new Headers({ [header]: 'DELETE' })
      expect(instanceRoute(DEV, 'GET', target, { ...CONTEXT, headers })).toMatchObject({
        kind: 'deny',
        status: 400,
        reason: expect.stringContaining(header.toLowerCase())
      })
    }
    const plain = new Headers({ accept: 'application/json' })
    expect(instanceRoute(DEV, 'GET', target, { ...CONTEXT, headers: plain })).toMatchObject({ kind: 'repository' })
    // GitLab and Gitea name no such header.
    const gitlab = proxyInstance({ provider: 'gitlab', baseUrl: 'https://gitlab.example.test' })!
    const overridden = new Headers({ 'X-HTTP-Method-Override': 'DELETE' })
    expect(
      instanceRoute(gitlab, 'GET', '/api/v4/projects/7', { repositories: [], headers: overridden })
    ).not.toMatchObject({ status: 400 })
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
    // One level deep alone.
    for (const target of [
      `/example-org/_apis/ResourceAreas/${UNHELD}/x`,
      '/example-org/_apis/ResourceAreas/',
      '/example-org/_apis/connectionData/x'
    ]) {
      expect(route('GET', target)).toMatchObject({ kind: 'deny', status: 403 })
    }
    expect(route('POST', '/example-org/_apis/connectionData')).toMatchObject({ kind: 'deny', status: 403 })
    expect(route('GET', '/example-org/Example%20Project/_apis/connectionData')).toMatchObject({ kind: 'deny' })
  })

  it('forwards an OPTIONS of the bare `_apis` as a read, and no other method there', () => {
    const read = { kind: 'repository', plane: 'api', ...WORKSPACE, readOnly: true }
    expect(route('OPTIONS', '/example-org/_apis')).toEqual(read)
    expect(route('OPTIONS', '/example-org/_apis/')).toEqual(read)
    expect(route('GET', '/example-org/_apis')).toMatchObject({ kind: 'deny', status: 403 })
    expect(route('POST', '/example-org/_apis')).toMatchObject({ kind: 'deny', status: 403 })
    expect(route('OPTIONS', '/example-org/Example%20Project/_apis')).toMatchObject({ kind: 'deny', status: 403 })
  })
})

describe('one pull request by id', () => {
  it('is looked up with a read lease, answered for the agent’s own repository, and as a missing id for any other', () => {
    for (const [target, lookupTarget] of [
      [
        '/example-org/Example%20Project/_apis/git/pullrequests/7?api-version=7.1&$expand=x',
        '/example-org/Example%20Project/_apis/git/pullrequests/7?api-version=7.1'
      ],
      ['/example-org/_apis/git/pullRequests/7', '/example-org/_apis/git/pullrequests/7?api-version=7.1']
    ]) {
      const lookup = route('GET', target!)
      expect(lookup).toMatchObject({
        kind: 'lookup',
        via: WORKSPACE,
        target: lookupTarget,
        hidden: PULL_REQUEST_NOT_FOUND
      })
      expect(lookup).not.toHaveProperty('write')
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
      '/DefaultCollection/Example%20Project/_git/Example%20Repo/info/refs?service=git-upload-pack',
      // Read as Azure DevOps reads it, after percent-decoding.
      '/%44efaultcollection/Example%20Project/_git/Example%20Repo/info/refs?service=git-upload-pack'
    ]) {
      expect(route('GET', target, VS)).toMatchObject({ kind: 'repository', plane: 'git', ...WORKSPACE })
    }
    expect(route('GET', `/_apis/git/repositories/${SECOND}`, VS)).toMatchObject({ ...SECOND_REPO, readOnly: true })
    expect(route('GET', '/_apis/connectionData', VS)).toMatchObject({ kind: 'repository', readOnly: true })
    expect(route('GET', '/_apis/git/repositories', VS)).toMatchObject({ kind: 'deny', status: 403 })
  })
})
