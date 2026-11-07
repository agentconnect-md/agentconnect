// The credential proxy in front of a fake Azure DevOps (azure-devops-integration.md §6.2, §6.3, §6.5): both of the organization's names, reached through the daemon's outbound proxy, every rule applied before anything is forwarded.
import { mkdtempSync, rmSync } from 'node:fs'
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingMessage,
  type Server as HttpServer
} from 'node:http'
import { createServer as createHttpsServer, request as httpsRequest, type Server as HttpsServer } from 'node:https'
import { connect as netConnect, type AddressInfo, type LookupFunction } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { connect as tlsConnect, createSecureContext } from 'node:tls'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { generateCa } from '@anthropic-ai/sandbox-runtime'
import { createMitmCA } from '@anthropic-ai/sandbox-runtime/dist/sandbox/mitm-ca.js'
import { mintLeafCert } from '@anthropic-ai/sandbox-runtime/dist/sandbox/mitm-leaf.js'
import { PULL_REQUEST_NOT_FOUND } from '../src/azure-devops/proxy-route.js'
import { loadProxyCa } from '../src/credential-proxy/ca.js'
import { proxyHosts, type ProxyRepository } from '../src/credential-proxy/instance-route.js'
import { loadPlaceholderKey, openPlaceholder } from '../src/credential-proxy/placeholder.js'
import { CredentialProxy, type MintAsk, type MintedCredential } from '../src/credential-proxy/proxy.js'
import { AZURE_DEVOPS_MANAGED_HOST } from '../src/gitcred/managed-hosts.js'

const AGENT = '11111111-1111-4111-8111-111111111111'
const IDENTITY = '00000000-0000-4000-8000-0000000000a1'
const PROJECT = '00000000-0000-4000-8000-000000000001'
const REPO = '00000000-0000-4000-8000-000000000011'
const SECOND = '00000000-0000-4000-8000-000000000012'
const UNHELD = '00000000-0000-4000-8000-000000000099'
const AREA = '00000000-0000-4000-8000-0000000000b1'
const PROXY_ENV = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy'] as const

const REPOSITORIES: ProxyRepository[] = [
  {
    repoId: '42',
    repoFullName: 'example-org/Example Project/Example Repo',
    workspace: true,
    azureDevOps: { organization: 'example-org', projectId: PROJECT, repositoryId: REPO }
  },
  {
    repoId: '43',
    repoFullName: 'example-org/Example Project/Second Repo',
    azureDevOps: { organization: 'example-org', projectId: PROJECT, repositoryId: SECOND }
  }
]
/** The agent's tier per repository: it writes the workspace and reads the second. */
const GRANTS: Record<string, 'read' | 'write'> = { '42': 'write', '43': 'read' }

const dirs: string[] = []
const servers: (HttpServer | HttpsServer)[] = []
const tunnels = new Set<Duplex>()
const saved: Partial<Record<(typeof PROXY_ENV)[number], string>> = {}
const upstreamSeen: { host: string; method: string; url: string; authorization?: string; accept?: string }[] = []
const parentSeen: string[] = []
const minted: MintAsk[] = []
let upstreamCa = ''
let hiddenExists = true
let refsRejections = 0
let pullRequestRejections = 0
let mintFails = false
let generation = 1
let proxy: CredentialProxy
let proxyCaPem = ''
let placeholder = ''
let placeholderKey: Buffer

/** The fake Azure DevOps: a repository named Hidden Repo exists or not as the test says; pull requests 6, 7 and 8 belong to the workspace, the second and an unheld repository, and 10 to 16 answer as their lookups' cases need. */
function azureDevOps(req: IncomingMessage, res: import('node:http').ServerResponse): void {
  const url = req.url ?? ''
  upstreamSeen.push({
    host: req.headers.host ?? '',
    method: req.method ?? '',
    url,
    ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
    ...(req.headers.accept ? { accept: req.headers.accept } : {})
  })
  const json = (status: number, value: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
    res.end(JSON.stringify(value))
  }
  req.resume()
  if (url.includes('Hidden%20Repo') || url.includes(UNHELD)) {
    if (hiddenExists) return json(200, { id: UNHELD, name: 'Hidden Repo' })
    return json(404, { message: 'TF401019' })
  }
  if (url.includes('/_git/')) {
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement' })
    res.end('001e# service=git-upload-pack\n0000')
    return
  }
  const pullRequest = /\/_apis\/git\/pullrequests\/(\d+)/i.exec(url)
  if (pullRequest) {
    const id = Number(pullRequest[1])
    if (id === 6) return json(200, { pullRequestId: 6, repository: { id: REPO, name: 'Example Repo' } })
    if (id === 7) return json(200, { pullRequestId: 7, repository: { id: SECOND, name: 'Second Repo' } })
    if (id === 8) return json(200, { pullRequestId: 8, repository: { id: UNHELD, name: 'Hidden Repo' } })
    // Refusals other than a missing id, which must not tell a pull request of another repository apart.
    if (id === 10) return json(400, { message: 'TF400898: An Internal Error Occurred.' })
    if (id === 11) return json(403, { message: 'TF401027: You need the Git GenericRead permission.' })
    if (id === 12) {
      res.writeHead(200, { 'content-type': 'text/html' })
      return void res.end('<html>sign in</html>')
    }
    if (id === 13) return json(200, { pullRequestId: 13, repository: { id: SECOND }, padding: 'x'.repeat(1 << 20) })
    if (id === 14 && pullRequestRejections > 0) {
      pullRequestRejections -= 1
      return json(401, { message: 'TF400813' })
    }
    if (id === 14) return json(200, { pullRequestId: 14, repository: { id: SECOND, name: 'Second Repo' } })
    if (id === 15) return json(429, { message: 'slow down' }, { 'retry-after': '30' })
    if (id === 16) return json(500, { message: 'TF400898' })
    return json(404, JSON.parse(PULL_REQUEST_NOT_FOUND.reason))
  }
  if (url.includes(`/repositories/${REPO}/commits`)) return json(429, { message: 'slow down' }, { 'retry-after': '30' })
  if (url.includes(`/repositories/${REPO}/refs`) && refsRejections > 0) {
    refsRejections -= 1
    return json(401, { message: 'TF400813' })
  }
  json(req.method === 'POST' ? 201 : 200, { ok: true })
}

/** Names never resolve here: the daemon's outbound proxy resolves what it carries. */
const refuseLookup: LookupFunction = (host, _options, callback) =>
  callback(new Error(`${host} was resolved by the daemon`), '', 0)

beforeAll(async () => {
  for (const name of PROXY_ENV) {
    saved[name] = process.env[name]
    delete process.env[name]
  }
  const ca = generateCa({ cn: 'example upstream CA' })
  upstreamCa = ca.certPem
  const mitm = createMitmCA({ caCertPem: ca.certPem, caKeyPem: ca.keyPem })
  const contexts = new Map(
    ['dev.azure.com', 'example-org.visualstudio.com'].map((name) => {
      const leaf = mintLeafCert(mitm, name)
      return [name, { key: leaf.keyPem, cert: leaf.certPem }] as const
    })
  )
  const upstream = createHttpsServer(
    {
      ...contexts.get('dev.azure.com')!,
      SNICallback: (name, done) => done(null, createSecureContext(contexts.get(name) ?? contexts.get('dev.azure.com')!))
    },
    azureDevOps
  )
  servers.push(upstream)
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamPort = (upstream.address() as AddressInfo).port
  // Every name the parent carries answers at the fake, as a corporate proxy resolves it upstream.
  const parent = createHttpServer()
  parent.on('connect', (req, socket, head) => {
    parentSeen.push(req.url ?? '')
    tunnels.add(socket)
    const out = netConnect(upstreamPort, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) out.write(head)
      out.pipe(socket)
      socket.pipe(out)
    })
    tunnels.add(out)
    out.on('error', () => socket.destroy())
    socket.on('error', () => out.destroy())
  })
  servers.push(parent)
  await new Promise<void>((resolve) => parent.listen(0, '127.0.0.1', resolve))
  process.env.HTTPS_PROXY = `http://127.0.0.1:${(parent.address() as AddressInfo).port}`

  const dir = mkdtempSync(join(tmpdir(), 'acp-azure-'))
  dirs.push(dir)
  const ca2 = loadProxyCa(join(dir, 'ca'))
  proxyCaPem = ca2.certPem
  const mint = async (_agentId: string, ask: MintAsk): Promise<MintedCredential> => {
    if (mintFails) throw new Error('the control plane is not connected')
    minted.push(ask)
    const token = `azure-token-${generation}`
    return {
      username: IDENTITY,
      token,
      // A read lease says read; otherwise the agent's tier on the repository.
      access: ask.readOnly ? 'read' : (GRANTS[ask.repoId ?? ''] ?? 'read'),
      invalidate: () => {
        if (token === `azure-token-${generation}`) generation += 1
      }
    }
  }
  placeholderKey = loadPlaceholderKey(join(dir, 'proxy.key'))
  proxy = new CredentialProxy({
    key: placeholderKey,
    ca: ca2,
    mint,
    workspaceRepo: () => undefined,
    instancesOf: () => proxyHosts(AZURE_DEVOPS_MANAGED_HOST, () => REPOSITORIES),
    repositoriesOf: (_agentId, provider) => (provider === 'azure-devops' ? REPOSITORIES : []),
    runningAgents: () => [AGENT],
    knownAgent: () => true,
    log: { info: () => {}, warn: () => {} },
    upstream: { lookupFor: () => refuseLookup, trustedCa: [upstreamCa] }
  })
  await proxy.start(join(dir, 'run'))
  placeholder = proxy.placeholderFor(AGENT)
})

afterEach(() => {
  upstreamSeen.splice(0)
  parentSeen.splice(0)
  minted.splice(0)
  hiddenExists = true
  refsRejections = 0
  pullRequestRejections = 0
  mintFails = false
  generation = 1
})

afterAll(async () => {
  await proxy?.stop()
  for (const name of PROXY_ENV) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
  // A CONNECT tunnel is no HTTP connection, so closing the parent's connections leaves its tunnels open.
  for (const tunnel of tunnels) tunnel.destroy()
  for (const server of servers) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

interface Answer {
  status: number
  headers: Record<string, string | string[] | undefined>
  /** The head as sent, Date aside, which is the one line two answers a second apart may differ in. */
  head: string[]
  body: string
}

/** One request through the proxy's loopback listener to `host`, as an Azure DevOps client sends it, with `extra` headers. */
function send(
  host: string,
  method: string,
  path: string,
  authorization: string,
  body?: string,
  extra: Record<string, string> = {}
): Promise<Answer> {
  const url = new URL(proxy.loopbackUrl()!)
  const proxyAuth = `Basic ${Buffer.from(`${url.username}:${url.password}`).toString('base64')}`
  return new Promise((resolve, reject) => {
    const connect = httpRequest({
      host: url.hostname,
      port: Number(url.port),
      method: 'CONNECT',
      path: `${host}:443`,
      headers: { 'proxy-authorization': proxyAuth }
    })
    connect.on('connect', (res, socket) => {
      if (res.statusCode !== 200) return reject(new Error(`CONNECT answered ${res.statusCode}`))
      const tls = tlsConnect({ socket, servername: host, ca: proxyCaPem })
      const req = httpsRequest(
        {
          createConnection: () => tls,
          method,
          path,
          headers: {
            host,
            authorization,
            connection: 'close',
            ...extra,
            ...(body !== undefined
              ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
              : {})
          }
        },
        (out) => {
          const chunks: Buffer[] = []
          out.on('data', (chunk: Buffer) => chunks.push(chunk))
          out.on('end', () => {
            const head: string[] = []
            for (let i = 0; i < out.rawHeaders.length; i += 2) {
              if (out.rawHeaders[i]!.toLowerCase() !== 'date')
                head.push(`${out.rawHeaders[i]}: ${out.rawHeaders[i + 1]}`)
            }
            resolve({
              status: out.statusCode ?? 0,
              // Two answers a second apart differ only in Date, so it stays out of comparisons.
              headers: Object.fromEntries(Object.entries(out.headers).filter(([name]) => name !== 'date')),
              head: [`${out.statusCode} ${out.statusMessage}`, ...head],
              body: Buffer.concat(chunks).toString('utf8')
            })
          })
          out.on('error', reject)
        }
      )
      req.on('error', reject)
      req.end(body)
    })
    connect.on('error', reject)
    connect.end()
  })
}

const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`
/** git's helper answers with the placeholder; the Azure CLI sends it as a password with no user. */
const GIT = () => basic('agentconnect', placeholder)
const CLI = () => basic('', placeholder)
const DEV = 'dev.azure.com'
const UPSTREAM_AUTH = (generationOf = 1) => basic(IDENTITY, `azure-token-${generationOf}`)
const PROJECT_PATH = '/example-org/Example%20Project'

describe('the organization’s two names', () => {
  it('are sealed into the placeholder and routed to the proxy, by srt and by an executor’s tunnel alike', () => {
    expect(openPlaceholder(placeholderKey, placeholder)?.hosts).toEqual([
      'dev.azure.com',
      'example-org.visualstudio.com'
    ])
    expect(proxy.domainsFor(AGENT)).toEqual(['dev.azure.com', 'example-org.visualstudio.com'])
    expect(proxy.tunnelRoutes(AGENT)).toEqual(['dev.azure.com:443', 'example-org.visualstudio.com:443'])
  })
})

describe('git through the proxy', () => {
  it('fetches and pushes an authorized repository, and refuses a push below write before anything is forwarded', async () => {
    const repo = `${PROJECT_PATH}/_git/Example%20Repo`
    expect((await send(DEV, 'GET', `${repo}/info/refs?service=git-upload-pack`, GIT())).status).toBe(200)
    expect((await send(DEV, 'POST', `${repo}/git-receive-pack`, GIT(), '0000')).status).toBe(200)
    expect(upstreamSeen).toEqual([
      expect.objectContaining({ host: DEV, method: 'GET', authorization: UPSTREAM_AUTH() }),
      expect.objectContaining({ host: DEV, method: 'POST', authorization: UPSTREAM_AUTH() })
    ])
    // A fetch asks a read lease, a push the agent's tier.
    expect(minted.map((ask) => [ask.repoId, ask.readOnly, ask.push === true])).toEqual([
      ['42', true, false],
      ['42', false, true]
    ])
    const refused = await send(
      DEV,
      'GET',
      `/example-org/${PROJECT}/_git/Second%20Repo/info/refs?service=git-receive-pack`,
      GIT()
    )
    expect(refused.status).toBe(403)
    expect(refused.body.trim()).toBe(
      'this agent has read access to example-org/Example Project/Second Repo; pushing needs write access'
    )
    expect(upstreamSeen).toHaveLength(2)
  })
})

describe('a repository outside the authorizations', () => {
  it('is refused before forwarding, with Azure DevOps’s own not-found answer whether or not it exists', async () => {
    const rest = `${PROJECT_PATH}/_apis/git/repositories/Hidden%20Repo?api-version=7.1`
    const git = `${PROJECT_PATH}/_git/Hidden%20Repo/info/refs?service=git-upload-pack`
    const existing = { rest: await send(DEV, 'GET', rest, CLI()), git: await send(DEV, 'GET', git, GIT()) }
    hiddenExists = false
    const missing = { rest: await send(DEV, 'GET', rest, CLI()), git: await send(DEV, 'GET', git, GIT()) }
    expect(existing).toEqual(missing)
    expect(existing.rest.status).toBe(404)
    expect(existing.rest.body).toBe(
      `{"$id":"1","innerException":null,"message":"TF401019: The Git repository with name or identifier Hidden Repo does not exist or you do not have permissions for the operation you are attempting.","typeName":"Microsoft.TeamFoundation.Git.Server.GitRepositoryNotFoundException, Microsoft.TeamFoundation.Git.Server","typeKey":"GitRepositoryNotFoundException","errorCode":0,"eventId":3000}\n`
    )
    expect(existing.git.status).toBe(404)
    expect(existing.git.body).toBe(
      'TF401019: The Git repository with name or identifier Hidden Repo does not exist or you do not have permissions for the operation you are attempting.\n'
    )
    // By GUID too, which names the identifier the client sent.
    const byId = await send(DEV, 'GET', `/example-org/_apis/git/repositories/${UNHELD}`, CLI())
    expect(byId.status).toBe(404)
    expect(JSON.parse(byId.body).message).toContain(`identifier ${UNHELD} does not exist`)
    expect(upstreamSeen).toEqual([])
  })
})

describe('lists and other organizations', () => {
  it('refuses the repository, project and pull-request lists and another organization without forwarding', async () => {
    for (const path of [
      '/example-org/_apis/git/repositories?api-version=7.1',
      `${PROJECT_PATH}/_apis/git/repositories`,
      '/example-org/_apis/projects?api-version=7.1',
      `${PROJECT_PATH}/_apis/git/pullrequests?searchCriteria.status=active`,
      '/example-org/_apis/git/pullrequests',
      '/other-org/_apis/connectionData',
      '/other-org/Example%20Project/_git/Example%20Repo/info/refs?service=git-upload-pack'
    ]) {
      expect((await send(DEV, 'GET', path, CLI())).status).toBe(403)
    }
    expect(upstreamSeen).toEqual([])
    expect(minted).toEqual([])
  })

  it('forwards connectionData and resource-area lookups as reads, as Basic with the identity whatever scheme came in', async () => {
    expect((await send(DEV, 'GET', '/example-org/_apis/connectionData', CLI())).status).toBe(200)
    const areas = await send(DEV, 'GET', `/example-org/_apis/ResourceAreas/${AREA}`, `Bearer ${placeholder}`)
    expect(areas.status).toBe(200)
    expect(upstreamSeen.map((entry) => entry.authorization)).toEqual([UPSTREAM_AUTH(), UPSTREAM_AUTH()])
    expect(minted.every((ask) => ask.readOnly && ask.repoId === '42')).toBe(true)
  })
})

describe('one pull request by id', () => {
  it('is answered for the agent’s own repository, and another repository’s exactly like a missing id', async () => {
    const pull = (id: number) => `${PROJECT_PATH}/_apis/git/pullrequests/${id}?api-version=7.1`
    const own = await send(DEV, 'GET', pull(7), CLI())
    expect(own.status).toBe(200)
    expect(JSON.parse(own.body)).toMatchObject({ pullRequestId: 7, repository: { id: SECOND } })
    // The proxy's own lookup and then the request itself, the latter under the pull request's repository.
    expect(upstreamSeen.map((entry) => [entry.method, entry.url, entry.authorization])).toEqual([
      ['GET', pull(7), UPSTREAM_AUTH()],
      ['GET', pull(7), UPSTREAM_AUTH()]
    ])
    expect(minted.at(-1)).toMatchObject({ repoId: '43', readOnly: true })
    upstreamSeen.splice(0)
    const other = await send(DEV, 'GET', pull(8), CLI())
    const missing = await send(DEV, 'GET', pull(9), CLI())
    expect(other).toEqual(missing)
    expect(other.status).toBe(404)
    expect(other.body).toBe(`${PULL_REQUEST_NOT_FOUND.reason}\n`)
    // Each was only looked up; neither answer left the proxy as Azure DevOps sent it.
    expect(upstreamSeen.map((entry) => entry.url)).toEqual([pull(8), pull(9)])
    // The lookup took the daemon's own route out.
    expect(parentSeen.every((target) => target === 'dev.azure.com:443')).toBe(true)
  })

  it('refuses any method but GET on it', async () => {
    const answer = await send(DEV, 'PATCH', `${PROJECT_PATH}/_apis/git/pullrequests/7`, CLI(), '{"status":"completed"}')
    expect(answer.status).toBe(403)
    expect(upstreamSeen).toEqual([])
  })
})

describe('API writes', () => {
  it('forwards a pull-request write at write, and refuses it at read or naming no repository', async () => {
    const created = await send(
      DEV,
      'POST',
      `${PROJECT_PATH}/_apis/git/repositories/${REPO}/pullrequests?api-version=7.1`,
      CLI(),
      '{"sourceRefName":"refs/heads/topic","targetRefName":"refs/heads/main"}'
    )
    expect(created.status).toBe(201)
    const refused = await send(
      DEV,
      'PATCH',
      `${PROJECT_PATH}/_apis/git/repositories/Second%20Repo/pullrequests/7?api-version=7.1`,
      CLI(),
      '{"status":"completed"}'
    )
    expect(refused.status).toBe(403)
    expect(refused.body.trim()).toBe(
      'this agent has read access to example-org/Example Project/Second Repo; writing needs write access'
    )
    const unnamed = await send(DEV, 'POST', `${PROJECT_PATH}/_apis/git/repositories`, CLI(), '{"name":"New Repo"}')
    expect(unnamed.status).toBe(403)
    // `write` never administers the repository itself.
    const deleted = await send(DEV, 'DELETE', `${PROJECT_PATH}/_apis/git/repositories/${REPO}?api-version=7.1`, CLI())
    expect(deleted.status).toBe(403)
    expect(upstreamSeen.map((entry) => [entry.method, entry.url])).toEqual([
      ['POST', `${PROJECT_PATH}/_apis/git/repositories/${REPO}/pullrequests?api-version=7.1`],
      // The pull request was looked up first; the write itself never left.
      ['GET', `${PROJECT_PATH}/_apis/git/pullrequests/7?api-version=7.1`]
    ])
  })

  it('refuses a method override before anything is forwarded', async () => {
    for (const header of ['X-HTTP-Method-Override', 'X-HTTP-Method', 'X-Method-Override']) {
      const answer = await send(
        DEV,
        'GET',
        `${PROJECT_PATH}/_apis/git/repositories/${REPO}?api-version=7.1`,
        CLI(),
        undefined,
        { [header]: 'DELETE' }
      )
      expect(answer.status).toBe(400)
    }
    expect(upstreamSeen).toEqual([])
    expect(minted).toEqual([])
  })
})

describe('one pull request below a held repository', () => {
  const lookup = (id: number) => `${PROJECT_PATH}/_apis/git/pullrequests/${id}?api-version=7.1`
  const threads = (repository: string, id: number) =>
    `${PROJECT_PATH}/_apis/git/repositories/${repository}/pullrequests/${id}/threads?api-version=7.1`

  it('is forwarded only once the lookup shows it is that repository’s, and otherwise answered as a missing id', async () => {
    expect((await send(DEV, 'GET', threads(SECOND, 7), CLI())).status).toBe(200)
    expect(upstreamSeen.map((entry) => [entry.method, entry.url])).toEqual([
      ['GET', lookup(7)],
      ['GET', threads(SECOND, 7)]
    ])
    upstreamSeen.splice(0)
    // An unheld repository's pull request, and a held one's under another held repository, read like a missing id.
    const unheld = await send(DEV, 'GET', threads(SECOND, 8), CLI())
    const elsewhere = await send(DEV, 'GET', threads(REPO, 7), CLI())
    const missing = await send(DEV, 'GET', threads(SECOND, 9), CLI())
    expect(unheld).toEqual(missing)
    expect(elsewhere).toEqual(missing)
    expect(missing.status).toBe(404)
    expect(missing.body).toBe(`${PULL_REQUEST_NOT_FOUND.reason}\n`)
    expect(upstreamSeen.map((entry) => entry.url)).toEqual([lookup(8), lookup(7), lookup(9)])
  })

  it('looks a write up the same way, and then needs `write` on that repository', async () => {
    const pull = `${PROJECT_PATH}/_apis/git/repositories/${REPO}/pullrequests/6?api-version=7.1`
    expect((await send(DEV, 'PATCH', pull, CLI(), '{"status":"completed"}')).status).toBe(200)
    expect(upstreamSeen.map((entry) => [entry.method, entry.url])).toEqual([
      ['GET', lookup(6)],
      ['PATCH', pull]
    ])
    expect(minted.at(-1)).toMatchObject({ repoId: '42', readOnly: false, write: true })
    upstreamSeen.splice(0)
    // Another held repository's pull request is not written under this one.
    const other = await send(DEV, 'PATCH', threads(REPO, 7), CLI(), '{}')
    expect(other.status).toBe(404)
    expect(upstreamSeen.map((entry) => entry.url)).toEqual([lookup(7)])
  })
})

describe('the ownership lookup', () => {
  const pull = (id: number) => `${PROJECT_PATH}/_apis/git/pullrequests/${id}?api-version=7.1`

  it('asks its own target with a JSON accept, whatever the request carried', async () => {
    const asked = `${PROJECT_PATH}/_apis/git/pullrequests/7?api-version=5.0&$expand=all`
    const answer = await send(DEV, 'GET', asked, CLI(), undefined, { accept: 'text/html' })
    expect(answer.status).toBe(200)
    expect(upstreamSeen).toEqual([
      expect.objectContaining({ url: pull(7), accept: 'application/json' }),
      // The request itself then goes as the client sent it.
      expect.objectContaining({ url: asked, accept: 'text/html' })
    ])
  })

  it('answers every refusal but 401 and 429, an unreadable answer and an oversized one as a missing id', async () => {
    const missing = await send(DEV, 'GET', pull(9), CLI())
    for (const id of [10, 11, 12, 13]) expect(await send(DEV, 'GET', pull(id), CLI())).toEqual(missing)
    // Only the lookups reached Azure DevOps.
    expect(upstreamSeen.map((entry) => entry.url)).toEqual([9, 10, 11, 12, 13].map(pull))
  })

  it('retries a 401 once with a fresh token, refuses a 429 naming Retry-After, and a 5xx as unreachable', async () => {
    pullRequestRejections = 1
    const before = generation
    expect((await send(DEV, 'GET', pull(14), CLI())).status).toBe(200)
    expect(upstreamSeen.map((entry) => entry.authorization)).toEqual([
      UPSTREAM_AUTH(before),
      UPSTREAM_AUTH(before + 1),
      UPSTREAM_AUTH(before + 1)
    ])
    const limited = await send(DEV, 'GET', pull(15), CLI())
    expect(limited.status).toBe(429)
    expect(limited.body).toContain('Retry-After: 30')
    expect((await send(DEV, 'GET', pull(16), CLI())).status).toBe(502)
  })

  it('names no repository when its own credential cannot be had', async () => {
    mintFails = true
    for (const target of [pull(7), `${PROJECT_PATH}/_apis/git/repositories/${SECOND}/pullrequests/8`]) {
      const answer = await send(DEV, 'GET', target, CLI())
      expect(answer.status).toBe(403)
      expect(answer.body).not.toMatch(/Example Repo|Second Repo|example-org\//)
    }
    expect(upstreamSeen).toEqual([])
  })
})

describe('the organization’s visualstudio.com name', () => {
  it('is routed the same way, the organization read from the host', async () => {
    const host = 'example-org.visualstudio.com'
    const fetch = await send(
      host,
      'GET',
      '/Example%20Project/_git/Example%20Repo/info/refs?service=git-upload-pack',
      GIT()
    )
    expect(fetch.status).toBe(200)
    const hidden = await send(
      host,
      'GET',
      '/DefaultCollection/Example%20Project/_apis/git/repositories/Hidden%20Repo',
      CLI()
    )
    expect(hidden.status).toBe(404)
    expect(upstreamSeen).toEqual([expect.objectContaining({ host, authorization: UPSTREAM_AUTH() })])
  })
})

describe('the upstream’s own refusals', () => {
  it('passes a 429 and its Retry-After through untouched', async () => {
    const answer = await send(DEV, 'GET', `${PROJECT_PATH}/_apis/git/repositories/${REPO}/commits`, CLI())
    expect(answer.status).toBe(429)
    expect(answer.headers['retry-after']).toBe('30')
  })

  it('drops a token the upstream rejects with 401, so the next request carries a fresh one', async () => {
    refsRejections = 1
    const path = `${PROJECT_PATH}/_apis/git/repositories/${REPO}/refs`
    const before = generation
    expect((await send(DEV, 'GET', path, CLI())).status).toBe(401)
    expect((await send(DEV, 'GET', path, CLI())).status).toBe(200)
    expect(upstreamSeen.map((entry) => entry.authorization)).toEqual([UPSTREAM_AUTH(before), UPSTREAM_AUTH(before + 1)])
  })
})
