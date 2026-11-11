import { createHmac } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import type { AddressInfo, LookupFunction } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect as tlsConnect } from 'node:tls'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { generateCa } from '@anthropic-ai/sandbox-runtime'
import { createMitmCA } from '@anthropic-ai/sandbox-runtime/dist/sandbox/mitm-ca.js'
import { mintLeafCert } from '@anthropic-ai/sandbox-runtime/dist/sandbox/mitm-leaf.js'
import { loadProxyCa, operatorAuthorities, proxyTrustEnv, upstreamAuthorities } from '../src/credential-proxy/ca.js'
import { graphqlOperationTypes } from '../src/credential-proxy/graphql-operation.js'
import { githubRoute, graphqlRepository } from '../src/credential-proxy/github-route.js'
import {
  hostKey,
  instanceHost,
  instanceHostnames,
  instanceRoute,
  proxyInstance,
  type ProxyRepository
} from '../src/credential-proxy/instance-route.js'
import {
  loadPlaceholderKey,
  looksLikePlaceholder,
  openPlaceholder,
  sealPlaceholder
} from '../src/credential-proxy/placeholder.js'
import {
  CredentialProxy,
  deniedAddress,
  deniedSelfManagedAddress,
  presentedCredential
} from '../src/credential-proxy/proxy.js'
import { GITHUB_MANAGED_HOST, type ManagedCredentialHost } from '../src/gitcred/managed-hosts.js'

const AGENT = '11111111-1111-4111-8111-111111111111'
const dirs: string[] = []
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'acp-proxy-'))
  dirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe('the placeholder', () => {
  it('opens only what this key sealed, and keeps its agent and hosts', () => {
    const dir = scratch()
    const key = loadPlaceholderKey(join(dir, 'k', 'proxy.key'))
    // POSIX modes only: Windows reports every file as 0666.
    if (process.platform !== 'win32') expect(statSync(join(dir, 'k', 'proxy.key')).mode & 0o777).toBe(0o600)
    expect(loadPlaceholderKey(join(dir, 'k', 'proxy.key')).equals(key)).toBe(true)
    const sealed = sealPlaceholder(key, { agentId: AGENT, hosts: ['api.github.com'] })
    expect(looksLikePlaceholder(sealed)).toBe(true)
    expect(openPlaceholder(key, sealed)).toEqual({ agentId: AGENT, hosts: ['api.github.com'], kind: 'codehost' })
    expect(openPlaceholder(Buffer.alloc(32, 7), sealed)).toBeUndefined()
    const [prefixAndBody, tag] = sealed.split('.')
    const forged = Buffer.from(JSON.stringify({ a: 'other', h: ['api.github.com'] })).toString('base64url')
    expect(openPlaceholder(key, `acph1_${forged}.${tag}`)).toBeUndefined()
    expect(openPlaceholder(key, `${prefixAndBody}.${tag}x`)).toBeUndefined()
    expect(openPlaceholder(key, 'ghp_example')).toBeUndefined()
  })

  it('reads one sealed before kinds existed as a code host’s, and refuses an unknown kind or a provider one without its slot', () => {
    const key = loadPlaceholderKey(join(scratch(), 'proxy.key'))
    expect(openPlaceholder(key, legacySealed(key, { a: AGENT, h: ['github.com'] }))).toEqual({
      agentId: AGENT,
      hosts: ['github.com'],
      kind: 'codehost'
    })
    expect(openPlaceholder(key, legacySealed(key, { a: AGENT, h: [], k: 'other' }))).toBeUndefined()
    expect(openPlaceholder(key, legacySealed(key, { a: AGENT, h: [], k: 'provider' }))).toBeUndefined()
  })
})

/** A placeholder sealed by hand, as a daemon before the kind claim sealed one. */
function legacySealed(key: Buffer, claims: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `acph1_${body}.${createHmac('sha256', key).update(`acph1_${body}`).digest('base64url')}`
}

describe('the proxy CA', () => {
  it('keeps every key out of the trust directory a sandbox may read', () => {
    const dir = join(scratch(), 'credential-proxy')
    const ca = loadProxyCa(dir)
    loadPlaceholderKey(join(dir, 'placeholder.key'))
    expect(readdirSync(ca.trustDir).sort()).toEqual(['ca.crt', 'trust.pem'])
    expect(ca.bundlePath.startsWith(ca.trustDir)).toBe(true)
    expect(ca.keyPath.startsWith(ca.trustDir)).toBe(false)
    if (process.platform !== 'win32') {
      expect(statSync(dir).mode & 0o777).toBe(0o700)
      expect(statSync(ca.keyPath).mode & 0o777).toBe(0o600)
    }
  })
})

describe('GraphQL operation types', () => {
  it.each([
    ['{ viewer { login } }', ['query']],
    ['query Q($o: String!) { repository(owner: $o) { id } }', ['query']],
    ['mutation M { addComment(input: {}) { clientMutationId } }', ['mutation']],
    ['query A { a } mutation B { b }', ['query', 'mutation']],
    ['fragment F on R { id } query { ...F }', ['query']],
    ['query { a(s: "mutation { x }") }', ['query']],
    ['query { a(s: """ } mutation { """) }', ['query']],
    ['# mutation { x }\n{ a }', ['query']],
    ['query Q($i: In = {mutation: 1}) { a }', ['query']],
    ['subscription { s }', ['subscription']]
  ])('reads %s', (document, expected) => {
    expect(graphqlOperationTypes(document)).toEqual(expected)
  })

  it.each(['{ a', 'query { a } }', 'query { a(s: "open) }', 'query', ''])('refuses %j as unreadable', (document) => {
    const types = graphqlOperationTypes(document)
    expect(types === undefined || types.length === 0).toBe(true)
  })
})

describe('routing a GitHub request', () => {
  it('names the repository a git or REST path carries', () => {
    expect(githubRoute('github.com', 'GET', '/o/r.git/info/refs?service=git-upload-pack')).toEqual({
      kind: 'repository',
      repo: 'o/r',
      plane: 'git',
      readOnly: false,
      push: false
    })
    expect(githubRoute('github.com', 'POST', '/o/r/git-receive-pack')).toMatchObject({
      repo: 'o/r',
      plane: 'git',
      push: true
    })
    expect(githubRoute('api.github.com', 'PATCH', '/repos/o/r/issues/1')).toMatchObject({ repo: 'o/r', plane: 'gh' })
    expect(githubRoute('codeload.github.com', 'GET', '/o/r/tar.gz/main')).toMatchObject({ readOnly: true })
  })

  it('reads with the workspace, refuses a write outside a repository, and sends GraphQL to its body', () => {
    expect(githubRoute('api.github.com', 'GET', '/user')).toEqual({ kind: 'workspace' })
    expect(githubRoute('api.github.com', 'POST', '/user/repos')).toMatchObject({ kind: 'deny', status: 403 })
    expect(githubRoute('api.github.com', 'POST', '/graphql')).toEqual({ kind: 'graphql' })
    expect(githubRoute('github.com', 'GET', '/o/r/pulls')).toEqual({ kind: 'anonymous' })
    expect(githubRoute('api.github.com', 'GET', '/repos/../x')).toMatchObject({ kind: 'deny' })
    expect(graphqlRepository({ owner: 'o', name: 'r' })).toBe('o/r')
    expect(graphqlRepository({ owner: 'o', repo: 'r' })).toBe('o/r')
    expect(graphqlRepository({ owner: 'o' })).toBeUndefined()
  })
})

describe('the credential an Authorization header presents', () => {
  it('reads Basic, Bearer and token forms', () => {
    const basic = `Basic ${Buffer.from('x-access-token:acph1_x.y').toString('base64')}`
    expect(presentedCredential(basic)).toEqual({ scheme: 'basic', value: 'acph1_x.y' })
    expect(presentedCredential('Bearer acph1_x.y')).toEqual({ scheme: 'bearer', value: 'acph1_x.y' })
    expect(presentedCredential('token acph1_x.y')).toEqual({ scheme: 'token', value: 'acph1_x.y' })
    expect(presentedCredential(null)).toBeUndefined()
  })
})

describe('a code-host name never resolves into denied space', () => {
  it.each([
    ['127.0.0.1', true],
    ['169.254.169.254', true],
    ['10.1.2.3', true],
    ['172.20.0.1', true],
    ['192.168.1.1', true],
    ['::1', true],
    ['::ffff:127.0.0.1', true],
    ['fd00::1', true],
    ['140.82.112.3', false],
    ['2606:50c0:8000::153', false]
  ])('%s denied: %s', (address, denied) => {
    expect(deniedAddress(address)).toBe(denied)
  })
})

const MINTED = { username: 'x-access-token', token: 'ghs_minted', access: 'write' as const }

function proxyFor(
  overrides: {
    mint?: ReturnType<typeof vi.fn>
    known?: boolean
    workspace?: string
    instances?: Record<string, ManagedCredentialHost[]>
    repositoriesOf?: (agentId: string, provider: string) => readonly ProxyRepository[]
  } = {}
) {
  const dir = scratch()
  const key = loadPlaceholderKey(join(dir, 'proxy.key'))
  const mint = overrides.mint ?? vi.fn(async () => MINTED)
  const instances = overrides.instances ?? { [AGENT]: [GITHUB_MANAGED_HOST] }
  const proxy = new CredentialProxy({
    key,
    ca: loadProxyCa(join(dir, 'ca')),
    mint: mint as never,
    workspaceRepo: () => overrides.workspace,
    instancesOf: (agentId) => instances[agentId] ?? [],
    runningAgents: () => Object.keys(instances),
    knownAgent: () => overrides.known ?? true,
    ...(overrides.repositoriesOf ? { repositoriesOf: overrides.repositoriesOf } : {}),
    log: { info: () => {}, warn: () => {} }
  })
  return { proxy, mint, key, placeholder: proxy.placeholderFor(AGENT) }
}

const HTTPS = { scheme: 'https' as const }

describe('the decision for one request', () => {
  it('leaves other hosts, unauthenticated requests and a credential the agent brought untouched', async () => {
    const { proxy, mint } = proxyFor()
    expect(await proxy.decide(new Request('https://registry.npmjs.org/x'), HTTPS)).toEqual({ action: 'allow' })
    expect(await proxy.decide(new Request('https://api.github.com/user'), HTTPS)).toEqual({ action: 'allow' })
    const own = new Request('https://api.github.com/user', { headers: { authorization: 'token ghp_own' } })
    expect(await proxy.decide(own, HTTPS)).toEqual({ action: 'allow' })
    expect(mint).not.toHaveBeenCalled()
  })

  it('refuses a forged placeholder, one for another host, one over plain HTTP, and one of an unknown agent', async () => {
    const { proxy, key, placeholder } = proxyFor()
    const forged = new Request('https://api.github.com/repos/o/r', { headers: { authorization: 'token acph1_x.y' } })
    expect(await proxy.decide(forged, HTTPS)).toMatchObject({ action: 'deny', status: 403 })
    const narrow = sealPlaceholder(key, { agentId: AGENT, hosts: ['github.com'] })
    const elsewhere = new Request('https://api.github.com/repos/o/r', { headers: { authorization: `token ${narrow}` } })
    expect(await proxy.decide(elsewhere, HTTPS)).toMatchObject({ action: 'deny' })
    const plain = new Request('http://api.github.com/repos/o/r', { headers: { authorization: `token ${placeholder}` } })
    expect(await proxy.decide(plain, { scheme: 'http' })).toMatchObject({ action: 'deny' })
    const gone = proxyFor({ known: false })
    const stale = new Request('https://api.github.com/repos/o/r', {
      headers: { authorization: `token ${gone.placeholder}` }
    })
    expect(await gone.proxy.decide(stale, HTTPS)).toMatchObject({ action: 'deny' })
  })

  it('exchanges the placeholder for the repository token, keeping git’s Basic form', async () => {
    const { proxy, mint, placeholder } = proxyFor()
    const basic = `Basic ${Buffer.from(`x-access-token:${placeholder}`).toString('base64')}`
    const git = new Request('https://github.com/o/r.git/git-upload-pack', {
      method: 'POST',
      headers: { authorization: basic }
    })
    const decision = await proxy.decide(git, { ...HTTPS, requestTarget: '/o/r.git/git-upload-pack' })
    expect(mint).toHaveBeenCalledWith(AGENT, { provider: 'github', repo: 'o/r', plane: 'git', readOnly: false })
    expect(decision).toEqual({
      action: 'allow',
      setHeaders: [['authorization', `Basic ${Buffer.from('x-access-token:ghs_minted').toString('base64')}`]]
    })
    const rest = new Request('https://api.github.com/repos/o/r/pulls', {
      headers: { authorization: `Bearer ${placeholder}` }
    })
    expect(await proxy.decide(rest, HTTPS)).toEqual({
      action: 'allow',
      setHeaders: [['authorization', 'Bearer ghs_minted']]
    })
  })

  it('still exchanges a placeholder sealed before kinds existed', async () => {
    const { proxy, mint, key } = proxyFor()
    const legacy = legacySealed(key, { a: AGENT, h: ['api.github.com'] })
    const rest = new Request('https://api.github.com/repos/o/r/pulls', {
      headers: { authorization: `token ${legacy}` }
    })
    expect(await proxy.decide(rest, HTTPS)).toEqual({
      action: 'allow',
      setHeaders: [['authorization', 'token ghs_minted']]
    })
    expect(mint).toHaveBeenCalledTimes(1)
  })

  it('lets a GraphQL query read the repository its variables name, and refuses a mutation', async () => {
    const { proxy, mint, placeholder } = proxyFor({ workspace: 'o/ws' })
    const graphql = (body: unknown) =>
      new Request('https://api.github.com/graphql', {
        method: 'POST',
        headers: { authorization: `token ${placeholder}`, 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
    await proxy.decide(
      graphql({
        query: 'query($owner:String!,$name:String!){repository(owner:$owner,name:$name){id}}',
        variables: { owner: 'o', name: 'r' }
      }),
      HTTPS
    )
    expect(mint).toHaveBeenLastCalledWith(AGENT, { provider: 'github', repo: 'o/r', plane: 'api', readOnly: true })
    await proxy.decide(graphql({ query: '{ viewer { login } }' }), HTTPS)
    expect(mint).toHaveBeenLastCalledWith(AGENT, { provider: 'github', repo: 'o/ws', plane: 'api', readOnly: true })
    const mutation = await proxy.decide(
      graphql({ query: 'mutation { mergePullRequest(input:{}) { clientMutationId } }' }),
      HTTPS
    )
    expect(mutation).toMatchObject({ action: 'deny', status: 403 })
    expect((mutation as { reason: string }).reason).toContain('githubPullRequest')
    expect(await proxy.decide(graphql([{ query: '{ a }' }]), HTTPS)).toMatchObject({ action: 'deny', status: 400 })
  })

  it('refuses a placeholder of another agent over an agent’s own route', async () => {
    const { proxy, mint, placeholder } = proxyFor({
      instances: { [AGENT]: [GITHUB_MANAGED_HOST], 'someone-else': [GITHUB_MANAGED_HOST] }
    })
    const request = () =>
      new Request('https://api.github.com/repos/o/r', { headers: { authorization: `token ${placeholder}` } })
    expect(await proxy.decide(request(), HTTPS, 'someone-else')).toMatchObject({
      action: 'deny',
      status: 403,
      reason: 'the agent credential belongs to another agent'
    })
    expect(mint).not.toHaveBeenCalled()
    expect(await proxy.decide(request(), HTTPS, AGENT)).toMatchObject({ action: 'allow' })
  })

  it('drops the minted token on the upstream’s 401 and keeps it on a 403', async () => {
    const invalidate = vi.fn()
    const { proxy, placeholder } = proxyFor({ mint: vi.fn(async () => ({ ...MINTED, invalidate })) })
    const request = new Request('https://api.github.com/repos/o/r', {
      headers: { authorization: `token ${placeholder}` }
    })
    const decision = await proxy.decide(request, HTTPS)
    expect(decision).toMatchObject({ action: 'allow', setHeaders: [['authorization', 'token ghs_minted']] })
    const onResponse = (decision as { onResponse: (status: number, headers: object) => void }).onResponse
    onResponse(403, {})
    onResponse(200, {})
    expect(invalidate).not.toHaveBeenCalled()
    onResponse(401, {})
    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  it('refuses when the agent is not authorized for the repository', async () => {
    const mint = vi.fn(async () => {
      throw new Error('SCOPE_DENIED')
    })
    const { proxy, placeholder } = proxyFor({ mint })
    const request = new Request('https://api.github.com/repos/o/other', {
      headers: { authorization: `token ${placeholder}` }
    })
    expect(await proxy.decide(request, HTTPS)).toMatchObject({
      action: 'deny',
      status: 403,
      reason: 'this agent is not authorized for o/other'
    })
  })
})

describe('the proxy end to end', () => {
  let upstream: HttpsServer
  let upstreamPort = 0
  let upstreamCaPem = ''
  const seen: (string | undefined)[] = []

  beforeAll(async () => {
    const generated = generateCa({ cn: 'example upstream CA' })
    upstreamCaPem = generated.certPem
    const leaf = mintLeafCert(
      createMitmCA({ caCertPem: generated.certPem, caKeyPem: generated.keyPem }),
      'api.github.com'
    )
    upstream = createHttpsServer({ key: leaf.keyPem, cert: leaf.certPem }, (req, res) => {
      seen.push(req.headers.authorization)
      res.setHeader('content-type', 'application/json')
      res.end('{"ok":true}')
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    upstreamPort = (upstream.address() as AddressInfo).port
  })
  afterAll(async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  })

  // The Unix socket is srt's route, which Windows never runs.
  it.skipIf(process.platform === 'win32')(
    'terminates a CONNECT to the code host and forwards the minted token, over loopback and the Unix socket',
    async () => {
      // Short, so each agent's socket fits AF_UNIX on a host whose temp directory is long.
      const dir = mkdtempSync('/tmp/acpx-')
      dirs.push(dir)
      const toLoopback: LookupFunction = (_host, options, callback) => {
        if (options.all)
          (callback as (e: null, a: { address: string; family: number }[]) => void)(null, [
            { address: '127.0.0.1', family: 4 }
          ])
        else callback(null, '127.0.0.1', 4)
      }
      const ca = loadProxyCa(join(dir, 'ca'))
      const proxy = new CredentialProxy({
        key: loadPlaceholderKey(join(dir, 'proxy.key')),
        ca,
        mint: async () => MINTED,
        workspaceRepo: () => undefined,
        instancesOf: () => [GITHUB_MANAGED_HOST],
        runningAgents: () => [AGENT],
        knownAgent: () => true,
        log: { info: () => {}, warn: () => {} },
        upstream: { lookupFor: () => toLoopback, trustedCa: upstreamCaPem }
      })
      await proxy.start(join(dir, 'run'))
      try {
        const socketPath = proxy.socketFor(AGENT)
        expect(proxy.socketFor(AGENT)).toBe(socketPath)
        // Bound inside listen(): the path is usable the moment it is handed out.
        expect(existsSync(socketPath)).toBe(true)
        const placeholder = proxy.placeholderFor(AGENT)
        const url = new URL(proxy.loopbackUrl()!)
        const proxyAuth = `Basic ${Buffer.from(`${url.username}:${url.password}`).toString('base64')}`
        const viaLoopback = await getThrough(
          { host: url.hostname, port: Number(url.port), proxyAuth },
          upstreamPort,
          placeholder,
          ca.certPem
        )
        const viaSocket = await getThrough({ socketPath }, upstreamPort, placeholder, ca.certPem)
        expect(viaLoopback).toBe(200)
        expect(viaSocket).toBe(200)
        expect(seen).toEqual(['token ghs_minted', 'token ghs_minted'])
        // Another agent's socket honors only its own agent's placeholder.
        const other = proxy.socketFor('22222222-2222-4222-8222-222222222222')
        expect(other).not.toBe(socketPath)
        expect(await getThrough({ socketPath: other }, upstreamPort, placeholder, ca.certPem)).toBe(403)
        expect(seen).toHaveLength(2)
        // A removed agent's route goes with it.
        proxy.release('22222222-2222-4222-8222-222222222222')
        expect(existsSync(other)).toBe(false)
        expect(proxy.socketFor('22222222-2222-4222-8222-222222222222')).toBe(other)
        expect(proxyTrustEnv(ca).SSL_CERT_FILE).toBe(ca.bundlePath)
        // The loopback listener is no open proxy: a CONNECT without its credential is refused.
        expect(await connectStatus({ host: url.hostname, port: Number(url.port) }, upstreamPort)).toBe(407)
      } finally {
        await proxy.stop()
      }
    }
  )
})

describe('a code-host token the upstream rejects', () => {
  let upstream: HttpsServer
  let upstreamPort = 0
  let upstreamCaPem = ''
  const seen: (string | undefined)[] = []
  const statuses = [401, 200, 403, 200]

  beforeAll(async () => {
    const generated = generateCa({ cn: 'example upstream CA' })
    upstreamCaPem = generated.certPem
    const leaf = mintLeafCert(
      createMitmCA({ caCertPem: generated.certPem, caKeyPem: generated.keyPem }),
      'api.github.com'
    )
    upstream = createHttpsServer({ key: leaf.keyPem, cert: leaf.certPem }, (req, res) => {
      seen.push(req.headers.authorization)
      res.statusCode = statuses[seen.length - 1] ?? 200
      res.end()
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    upstreamPort = (upstream.address() as AddressInfo).port
  })
  afterAll(async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  })

  it('is minted afresh after a 401, and kept after a 403', async () => {
    const dir = scratch()
    const toLoopback: LookupFunction = (_host, options, callback) => {
      if (options.all)
        (callback as (e: null, a: { address: string; family: number }[]) => void)(null, [
          { address: '127.0.0.1', family: 4 }
        ])
      else callback(null, '127.0.0.1', 4)
    }
    // A cache in miniature: a token is served until its own invalidate drops it.
    let minted = 0
    let cached: string | undefined
    const mint = vi.fn(async () => {
      cached ??= `ghs_minted${++minted}`
      const token = cached
      return {
        ...MINTED,
        token,
        invalidate: () => {
          if (cached === token) cached = undefined
        }
      }
    })
    const ca = loadProxyCa(join(dir, 'ca'))
    const proxy = new CredentialProxy({
      key: loadPlaceholderKey(join(dir, 'proxy.key')),
      ca,
      mint,
      workspaceRepo: () => undefined,
      instancesOf: () => [GITHUB_MANAGED_HOST],
      runningAgents: () => [AGENT],
      knownAgent: () => true,
      log: { info: () => {}, warn: () => {} },
      upstream: { lookupFor: () => toLoopback, trustedCa: upstreamCaPem }
    })
    await proxy.start(join(dir, 'run'))
    try {
      const url = new URL(proxy.loopbackUrl()!)
      const dial = {
        host: url.hostname,
        port: Number(url.port),
        proxyAuth: `Basic ${Buffer.from(`${url.username}:${url.password}`).toString('base64')}`
      }
      const placeholder = proxy.placeholderFor(AGENT)
      const got: number[] = []
      for (let i = 0; i < statuses.length; i++) got.push(await getThrough(dial, upstreamPort, placeholder, ca.certPem))
      expect(got).toEqual(statuses)
      expect(seen).toEqual(['token ghs_minted1', 'token ghs_minted2', 'token ghs_minted2', 'token ghs_minted2'])
      expect(minted).toBe(2)
    } finally {
      await proxy.stop()
    }
  })
})

type Dial = { host: string; port: number; proxyAuth?: string } | { socketPath: string }

function connectStatus(dial: Dial, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ ...dial, method: 'CONNECT', path: `api.github.com:${port}` })
    req.on('connect', (res, socket) => {
      socket.destroy()
      resolve(res.statusCode ?? 0)
    })
    req.on('response', (res) => resolve(res.statusCode ?? 0))
    req.on('error', reject)
    req.end()
  })
}

function getThrough(dial: Dial, port: number, placeholder: string, caPem: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const headers = 'proxyAuth' in dial && dial.proxyAuth ? { 'proxy-authorization': dial.proxyAuth } : {}
    const req = httpRequest({ ...dial, method: 'CONNECT', path: `api.github.com:${port}`, headers })
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) return resolve(res.statusCode ?? 0)
      const tls = tlsConnect({ socket, servername: 'api.github.com', ca: caPem }, () => {
        tls.write(
          `GET /repos/o/r HTTP/1.1\r\nHost: api.github.com:${port}\r\nAuthorization: token ${placeholder}\r\nConnection: close\r\n\r\n`
        )
      })
      let raw = ''
      tls.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')))
      tls.on('end', () => resolve(Number(raw.split(' ')[1])))
      tls.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

const GITLAB: ManagedCredentialHost = { provider: 'gitlab', baseUrl: 'https://gitlab.example.test:8443/gitlab' }
const GITEA: ManagedCredentialHost = { provider: 'gitea', baseUrl: 'https://gitea.example.test/forge' }

describe('a self-managed instance as the proxy matches it', () => {
  it('keeps the port that is not HTTPS’s own and the path prefix, and matches GitHub on any port', () => {
    expect(proxyInstance(GITLAB)).toEqual({
      provider: 'gitlab',
      hosts: ['gitlab.example.test:8443'],
      pathPrefix: 'gitlab'
    })
    expect(proxyInstance({ provider: 'gitea', baseUrl: 'https://gitea.example.test:443' })?.hosts).toEqual([
      'gitea.example.test'
    ])
    expect(proxyInstance({ provider: 'gitlab', baseUrl: 'http://gitlab.example.test' })).toBeUndefined()
    const gitlab = proxyInstance(GITLAB)!
    expect(instanceHost(gitlab, 'gitlab.example.test', 8443)).toBe('gitlab.example.test:8443')
    expect(instanceHost(gitlab, 'gitlab.example.test', 443)).toBeUndefined()
    expect(instanceHostnames(gitlab)).toEqual(['gitlab.example.test'])
    expect(instanceHost(proxyInstance(GITHUB_MANAGED_HOST)!, 'api.github.com', 8443)).toBe('api.github.com')
    expect(hostKey('gitea.example.test', 443)).toBe('gitea.example.test')
  })
})

describe('routing a GitLab or Gitea request', () => {
  const gitlab = proxyInstance(GITLAB)!
  const gitea = proxyInstance(GITEA)!

  it('reads a GitLab project of any depth from a git path under the prefix', () => {
    expect(instanceRoute(gitlab, 'GET', '/gitlab/Group/sub/project.git/info/refs?service=git-upload-pack')).toEqual({
      kind: 'repository',
      plane: 'git',
      repo: 'group/sub/project',
      push: false
    })
    expect(instanceRoute(gitlab, 'POST', '/gitlab/group/a/b/c/project/git-receive-pack')).toMatchObject({
      repo: 'group/a/b/c/project',
      plane: 'git',
      push: true
    })
    expect(instanceRoute(gitlab, 'POST', '/gitlab/project/git-upload-pack')).toMatchObject({ kind: 'deny' })
    expect(instanceRoute(gitlab, 'GET', '/gitlab/group/../x/info/refs')).toMatchObject({ kind: 'deny' })
    expect(instanceRoute(gitlab, 'GET', '/gitlab/group/-/x/info/refs')).toMatchObject({ kind: 'deny' })
    // Outside the prefix, or a web page, needs no credential.
    expect(instanceRoute(gitlab, 'GET', '/other/group/project.git/info/refs')).toEqual({ kind: 'anonymous' })
    expect(instanceRoute(gitlab, 'GET', '/gitlabx/group/project.git/info/refs')).toEqual({ kind: 'anonymous' })
    expect(instanceRoute(gitlab, 'GET', '/gitlab/group/project/-/merge_requests')).toEqual({ kind: 'anonymous' })
  })

  it('reads GitLab API projects by id or encoded path, and refuses every API write naming the tools', () => {
    expect(instanceRoute(gitlab, 'GET', '/gitlab/api/v4/projects/group%2Fsub%2Fproject/merge_requests')).toEqual({
      kind: 'repository',
      plane: 'api',
      repo: 'group/sub/project'
    })
    expect(instanceRoute(gitlab, 'GET', '/gitlab/api/v4/projects/42/issues')).toEqual({
      kind: 'repository',
      plane: 'api',
      repoId: '42'
    })
    // A read naming no project takes the workspace project's read lease, and is refused without one.
    const context = { repositories: [{ repoId: '42', repoFullName: 'group/sub/project', workspace: true as const }] }
    for (const target of ['/gitlab/api/v4/user', '/gitlab/api/v4/projects', '/gitlab/api/v4/merge_requests']) {
      expect(instanceRoute(gitlab, 'GET', target, context)).toEqual({ kind: 'repository', plane: 'api', repoId: '42' })
      expect(instanceRoute(gitlab, 'GET', target)).toMatchObject({ kind: 'deny', status: 403 })
    }
    expect(instanceRoute(gitlab, 'GET', '/gitlab/api/v4/projects/group%2F..%2Fx')).toMatchObject({ kind: 'deny' })
    expect(instanceRoute(gitlab, 'GET', '/gitlab/api/v4/projects/project')).toMatchObject({ kind: 'deny' })
    expect(instanceRoute(gitlab, 'GET', '/gitlab/api/v3/user')).toMatchObject({ kind: 'deny', status: 400 })
    for (const target of [
      '/gitlab/api/v4/projects/42/merge_requests',
      '/gitlab/api/v4/user/keys',
      '/gitlab/api/graphql'
    ]) {
      const route = instanceRoute(gitlab, 'POST', target)
      expect(route).toMatchObject({ kind: 'deny' })
      if (target.includes('/v4/')) expect((route as { reason: string }).reason).toContain('gitlabMergeRequest')
    }
  })

  it('reads a Gitea repository as owner and name only, and refuses an API write naming the tools', () => {
    expect(instanceRoute(gitea, 'GET', '/forge/owner/repo.git/info/refs?service=git-upload-pack')).toEqual({
      kind: 'repository',
      plane: 'git',
      repo: 'owner/repo',
      push: false
    })
    expect(instanceRoute(gitea, 'POST', '/forge/group/sub/repo/git-upload-pack')).toMatchObject({ kind: 'deny' })
    expect(instanceRoute(gitea, 'GET', '/forge/api/v1/repos/Owner/Repo/pulls')).toEqual({
      kind: 'repository',
      plane: 'api',
      repo: 'owner/repo'
    })
    expect(instanceRoute(gitea, 'GET', '/forge/api/v1/repos/owner/..')).toMatchObject({ kind: 'deny' })
    const write = instanceRoute(gitea, 'PATCH', '/forge/api/v1/repos/owner/repo/issues/1')
    expect(write).toMatchObject({ kind: 'deny', status: 403 })
    expect((write as { reason: string }).reason).toContain('giteaPullRequest')
  })
})

describe('a Gitea read that names no repository', () => {
  const gitea = proxyInstance(GITEA)!
  const context = {
    repositories: [
      { repoId: '556677', repoFullName: 'Example-Org/Example-Repo', workspace: true as const },
      { repoId: '889900', repoFullName: 'example-org/other-repo' }
    ]
  }
  const route = (target: string, method = 'GET') => instanceRoute(gitea, method, target, context)

  it('is refused rather than borrowing the bot token, but for the version and the bot’s own profile', () => {
    for (const target of [
      '/forge/api/v1/user/repos',
      '/forge/api/v1/orgs/example-org/repos',
      '/forge/api/v1/repositories/42',
      '/forge/api/v1/notifications',
      '/forge/api/v1/repos/search?q=x',
      '/forge/api/v1/users/someone'
    ]) {
      expect(route(target)).toMatchObject({ kind: 'deny', status: 403 })
    }
    expect((route('/forge/api/v1/user/repos') as { reason: string }).reason).toContain('/api/v1/repos/{owner}/{repo}')
    expect(route('/forge/api/v1/version')).toEqual({ kind: 'anonymous' })
    expect(route('/forge/api/v1/user')).toEqual({ kind: 'repository', plane: 'api', repo: 'example-org/example-repo' })
    // Without a Gitea workspace there is no lease to read the profile with.
    expect(instanceRoute(gitea, 'GET', '/forge/api/v1/user')).toMatchObject({ kind: 'deny', status: 403 })
  })

  it('refuses the repository settings only an administrator reads, at every tier', () => {
    for (const rest of [
      'hooks',
      'hooks/1',
      'keys',
      'push_mirrors',
      'actions/secrets',
      'Actions/Variables',
      'actions/runners'
    ]) {
      expect(route(`/forge/api/v1/repos/example-org/example-repo/${rest}`)).toMatchObject({ kind: 'deny', status: 403 })
    }
    // Forgejo collapses repeated slashes before routing, so a doubled or dot segment never slips a setting past the check.
    for (const rest of [
      '/hooks',
      'actions//runners/registration-token',
      './hooks',
      'x/../hooks',
      '%68ooks',
      'actions/%2Fsecrets',
      'contents/a//b'
    ]) {
      expect(route(`/forge/api/v1/repos/example-org/example-repo/${rest}`)).toMatchObject({ kind: 'deny' })
    }
    expect(route('/forge/api/v1/repos/example-org/example-repo/contents/docs/read%20me.md')).toMatchObject({
      kind: 'repository'
    })
    expect(route('/forge/api/v1/repos/example-org/example-repo/actions/tasks')).toEqual({
      kind: 'repository',
      plane: 'api',
      repo: 'example-org/example-repo'
    })
  })
})

describe('a git push through the proxy', () => {
  const at = (host: string, port: number) => ({ ...HTTPS, target: { host, port } })
  // Each host's smart-HTTP base for one repository, and where the decision is made.
  const hosts = [
    { provider: 'github', base: 'https://github.com/o/r.git', info: at('github.com', 443) },
    {
      provider: 'gitlab',
      base: 'https://gitlab.example.test:8443/gitlab/group/project.git',
      info: at('gitlab.example.test', 8443)
    },
    { provider: 'gitea', base: 'https://gitea.example.test/forge/owner/repo.git', info: at('gitea.example.test', 443) }
  ] as const
  const setup = (access: 'read' | 'comment' | 'write') => {
    const mint = vi.fn(async () => ({ username: 'x-access-token', token: 'tok_minted', access }))
    return proxyFor({ mint, instances: { [AGENT]: [GITHUB_MANAGED_HOST, GITLAB, GITEA] } })
  }
  const git = (placeholder: string, url: string, method = 'GET') =>
    new Request(url, {
      method,
      headers: { authorization: `Basic ${Buffer.from(`x-access-token:${placeholder}`).toString('base64')}` }
    })

  it('classifies receive-pack and its ref advertisement as a push, and upload-pack as a fetch', () => {
    const gitea = proxyInstance(GITEA)!
    const push = (method: string, target: string) => (instanceRoute(gitea, method, target) as { push?: boolean }).push
    expect(push('POST', '/forge/owner/repo.git/git-receive-pack')).toBe(true)
    expect(push('GET', '/forge/owner/repo.git/info/refs?service=git-receive-pack')).toBe(true)
    expect(push('GET', '/forge/owner/repo.git/info/refs?service=git-upload-pack&service=git-receive-pack')).toBe(true)
    expect(push('GET', '/forge/owner/repo.git/info/refs?service=git%2Dreceive-pack')).toBe(true)
    expect(push('POST', '/forge/owner/repo.git/git-upload-pack')).toBe(false)
    expect(push('GET', '/forge/owner/repo.git/info/refs?service=git-upload-pack')).toBe(false)
    expect(push('GET', '/forge/owner/repo.git/info/refs')).toBe(false)
    expect(githubRoute('github.com', 'GET', '/o/r/info/refs?service=git-receive-pack')).toMatchObject({ push: true })
  })

  describe.each(hosts)('on $provider', ({ provider, base, info }) => {
    it.each(['read', 'comment'] as const)('refuses both receive-pack requests on a %s grant', async (access) => {
      const { proxy, mint, placeholder } = setup(access)
      for (const [method, url] of [
        ['GET', `${base}/info/refs?service=git-receive-pack`],
        ['POST', `${base}/git-receive-pack`]
      ] as const) {
        const decision = await proxy.decide(git(placeholder, url, method), info)
        expect(decision).toMatchObject({ action: 'deny', status: 403 })
        expect(decision).not.toHaveProperty('setHeaders')
        expect((decision as { reason: string }).reason).toMatch(
          new RegExp(`^this agent has ${access} access to .+; pushing needs write access$`)
        )
        expect(mint).toHaveBeenLastCalledWith(AGENT, expect.objectContaining({ provider, plane: 'git', push: true }))
      }
    })

    it.each(['read', 'comment'] as const)('still fetches on a %s grant', async (access) => {
      const { proxy, mint, placeholder } = setup(access)
      for (const [method, url] of [
        ['GET', `${base}/info/refs?service=git-upload-pack`],
        ['POST', `${base}/git-upload-pack`]
      ] as const) {
        expect(await proxy.decide(git(placeholder, url, method), info)).toMatchObject({ action: 'allow' })
        expect(mint).toHaveBeenLastCalledWith(AGENT, expect.not.objectContaining({ push: true }))
      }
    })

    it('pushes on a write grant', async () => {
      const { proxy, placeholder } = setup('write')
      for (const [method, url] of [
        ['GET', `${base}/info/refs?service=git-receive-pack`],
        ['POST', `${base}/git-receive-pack`]
      ] as const) {
        expect(await proxy.decide(git(placeholder, url, method), info)).toEqual({
          action: 'allow',
          setHeaders: [['authorization', `Basic ${Buffer.from('x-access-token:tok_minted').toString('base64')}`]]
        })
      }
    })
  })
})

describe('a self-managed instance’s name', () => {
  it.each([
    ['127.0.0.1', true],
    ['::ffff:127.0.0.1', true],
    ['169.254.169.254', true],
    ['0.0.0.0', true],
    ['::1', true],
    ['fe80::1', true],
    ['10.1.2.3', false],
    ['172.20.0.1', false],
    ['192.168.1.1', false],
    ['fd00::1', false],
    ['203.0.113.7', false]
  ])('may resolve to %s: %s denied', (address, denied) => {
    expect(deniedSelfManagedAddress(address)).toBe(denied)
  })
})

describe('the decision on a self-managed instance', () => {
  const OTHER = '22222222-2222-4222-8222-222222222222'
  const minted = { username: 'service-account', token: 'glpat_minted', access: 'write' as const }
  const setup = () =>
    proxyFor({
      mint: vi.fn(async () => minted),
      instances: { [AGENT]: [GITHUB_MANAGED_HOST, GITLAB, GITEA], [OTHER]: [GITHUB_MANAGED_HOST] },
      repositoriesOf: (_agentId, provider) =>
        provider === 'gitlab' ? [{ repoId: '7', repoFullName: 'group/sub/project', workspace: true }] : []
    })
  const at = (port: number) => ({ ...HTTPS, target: { host: 'gitlab.example.test', port } })

  it('seals the agent’s own hosts into its placeholder', () => {
    const { proxy, key, placeholder } = setup()
    expect(openPlaceholder(key, placeholder)?.hosts).toEqual([
      'github.com',
      'api.github.com',
      'uploads.github.com',
      'codeload.github.com',
      'gitlab.example.test:8443',
      'gitea.example.test'
    ])
    expect(proxy.domainsFor(AGENT)).toContain('gitlab.example.test')
    expect(proxy.domainsFor(OTHER)).not.toContain('gitlab.example.test')
  })

  it('writes git’s credential as Basic with the grant’s user, and the API’s as the client sent it', async () => {
    const { proxy, mint, placeholder } = setup()
    const basic = `Basic ${Buffer.from(`x-access-token:${placeholder}`).toString('base64')}`
    const git = new Request('https://gitlab.example.test:8443/gitlab/group/sub/project.git/info/refs', {
      headers: { authorization: basic }
    })
    expect(await proxy.decide(git, at(8443))).toEqual({
      action: 'allow',
      setHeaders: [['authorization', `Basic ${Buffer.from('service-account:glpat_minted').toString('base64')}`]]
    })
    expect(mint).toHaveBeenLastCalledWith(AGENT, {
      provider: 'gitlab',
      repo: 'group/sub/project',
      plane: 'git',
      readOnly: false
    })
    const glab = new Request('https://gitlab.example.test:8443/gitlab/api/v4/projects/42', {
      headers: { 'private-token': placeholder }
    })
    expect(await proxy.decide(glab, at(8443))).toEqual({
      action: 'allow',
      setHeaders: [['private-token', 'glpat_minted']]
    })
    expect(mint).toHaveBeenLastCalledWith(AGENT, { provider: 'gitlab', repoId: '42', plane: 'api', readOnly: true })
    const bearer = new Request('https://gitlab.example.test:8443/gitlab/api/v4/user', {
      headers: { authorization: `Bearer ${placeholder}` }
    })
    expect(await proxy.decide(bearer, at(8443))).toEqual({
      action: 'allow',
      setHeaders: [['authorization', 'Bearer glpat_minted']]
    })
    expect(mint).toHaveBeenLastCalledWith(AGENT, { provider: 'gitlab', repoId: '7', plane: 'api', readOnly: true })
    const gitea = new Request('https://gitea.example.test/forge/api/v1/repos/owner/repo', {
      headers: { authorization: `token ${placeholder}` }
    })
    expect(await proxy.decide(gitea, HTTPS)).toEqual({
      action: 'allow',
      setHeaders: [['authorization', 'token glpat_minted']]
    })
    expect(mint).toHaveBeenLastCalledWith(AGENT, {
      provider: 'gitea',
      repo: 'owner/repo',
      plane: 'api',
      readOnly: true
    })
  })

  it('refuses an API write, another port, another agent’s instance, and plain HTTP; strips the placeholder outside the prefix', async () => {
    const { proxy, mint, key, placeholder } = setup()
    const write = new Request('https://gitlab.example.test:8443/gitlab/api/v4/projects/42/merge_requests', {
      method: 'POST',
      headers: { 'private-token': placeholder }
    })
    expect(await proxy.decide(write, at(8443))).toMatchObject({ action: 'deny', status: 403 })
    const elsewhere = new Request('https://gitlab.example.test/gitlab/api/v4/user', {
      headers: { 'private-token': placeholder }
    })
    expect(await proxy.decide(elsewhere, at(443))).toMatchObject({ action: 'deny', status: 403 })
    const theirs = sealPlaceholder(key, { agentId: OTHER, hosts: ['gitlab.example.test:8443'] })
    const borrowed = new Request('https://gitlab.example.test:8443/gitlab/api/v4/user', {
      headers: { 'private-token': theirs }
    })
    expect(await proxy.decide(borrowed, at(8443))).toMatchObject({ action: 'deny', status: 403 })
    const plain = new Request('http://gitlab.example.test/gitlab/api/v4/user', {
      headers: { 'private-token': placeholder }
    })
    expect(
      await proxy.decide(plain, { scheme: 'http', target: { host: 'gitlab.example.test', port: 80 } })
    ).toMatchObject({ action: 'deny' })
    const outside = new Request('https://gitlab.example.test:8443/other/api/v4/user', {
      headers: { authorization: `Bearer ${placeholder}`, 'private-token': placeholder }
    })
    expect(await proxy.decide(outside, at(8443))).toEqual({
      action: 'allow',
      removeHeaders: ['authorization', 'private-token']
    })
    expect(mint).not.toHaveBeenCalled()
  })
})

describe('the authorities a code host is verified with', () => {
  it('adds the operator’s bundle to the system roots, upstream and in the runtime’s bundle', () => {
    const dir = scratch()
    const operator = generateCa({ cn: 'example operator CA' }).certPem.trim()
    const bundle = join(dir, 'operator.pem')
    writeFileSync(bundle, `${operator}\n`)
    expect(operatorAuthorities({ SSL_CERT_FILE: bundle })).toEqual([operator])
    expect(operatorAuthorities({ SSL_CERT_FILE: join(dir, 'missing.pem') })).toEqual([])
    const upstream = upstreamAuthorities({ GIT_SSL_CAINFO: bundle })
    expect(upstream).toContain(operator)
    expect(upstream.length).toBeGreaterThan(1)
    vi.stubEnv('SSL_CERT_FILE', bundle)
    try {
      const ca = loadProxyCa(join(dir, 'ca'))
      const trust = readFileSync(ca.bundlePath, 'utf8')
      expect(trust).toContain(operator)
      expect(trust).toContain(ca.certPem.trim())
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('the proxy end to end on a self-managed GitLab', () => {
  // The Unix socket is srt's route, which Windows never runs.
  it.skipIf(process.platform === 'win32')(
    'exchanges git’s and glab’s placeholder for the project’s credential at a prefixed instance on its own port',
    async () => {
      const generated = generateCa({ cn: 'example private CA' })
      const leaf = mintLeafCert(
        createMitmCA({ caCertPem: generated.certPem, caKeyPem: generated.keyPem }),
        'gitlab.example.test'
      )
      const seen: { url?: string; authorization?: string; privateToken?: string }[] = []
      const upstream = createHttpsServer({ key: leaf.keyPem, cert: leaf.certPem }, (req, res) => {
        seen.push({
          ...(req.url ? { url: req.url } : {}),
          ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
          ...(typeof req.headers['private-token'] === 'string' ? { privateToken: req.headers['private-token'] } : {})
        })
        res.end('ok')
      })
      await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
      const port = (upstream.address() as AddressInfo).port
      const dir = mkdtempSync('/tmp/acpx-')
      dirs.push(dir)
      const toLoopback: LookupFunction = (_host, options, callback) => {
        if (options.all)
          (callback as (e: null, a: { address: string; family: number }[]) => void)(null, [
            { address: '127.0.0.1', family: 4 }
          ])
        else callback(null, '127.0.0.1', 4)
      }
      const ca = loadProxyCa(join(dir, 'ca'))
      const instance: ManagedCredentialHost = {
        provider: 'gitlab',
        baseUrl: `https://gitlab.example.test:${port}/gitlab`
      }
      const mint = vi.fn(async () => ({ username: 'service-account', token: 'glpat_minted', access: 'write' as const }))
      const proxy = new CredentialProxy({
        key: loadPlaceholderKey(join(dir, 'proxy.key')),
        ca,
        mint,
        workspaceRepo: () => undefined,
        instancesOf: () => [instance],
        runningAgents: () => [AGENT],
        knownAgent: () => true,
        log: { info: () => {}, warn: () => {} },
        // The operator's private authority, as a self-managed instance is often signed.
        upstream: { lookupFor: () => toLoopback, trustedCa: [generated.certPem] }
      })
      await proxy.start(join(dir, 'run'))
      try {
        const socketPath = proxy.socketFor(AGENT)
        const placeholder = proxy.placeholderFor(AGENT)
        const host = `gitlab.example.test:${port}`
        const basic = `Basic ${Buffer.from(`x-access-token:${placeholder}`).toString('base64')}`
        const git = await exchange({ socketPath }, host, ca.certPem, [
          'GET /gitlab/group/sub/project.git/info/refs?service=git-upload-pack HTTP/1.1',
          `Authorization: ${basic}`
        ])
        const api = await exchange({ socketPath }, host, ca.certPem, [
          'GET /gitlab/api/v4/projects/group%2Fsub%2Fproject/merge_requests HTTP/1.1',
          `PRIVATE-TOKEN: ${placeholder}`
        ])
        const write = await exchange({ socketPath }, host, ca.certPem, [
          'POST /gitlab/api/v4/projects/group%2Fsub%2Fproject/merge_requests HTTP/1.1',
          `PRIVATE-TOKEN: ${placeholder}`,
          'Content-Length: 0'
        ])
        expect([git, api, write]).toEqual([200, 200, 403])
        expect(seen).toEqual([
          {
            url: '/gitlab/group/sub/project.git/info/refs?service=git-upload-pack',
            authorization: `Basic ${Buffer.from('service-account:glpat_minted').toString('base64')}`
          },
          { url: '/gitlab/api/v4/projects/group%2Fsub%2Fproject/merge_requests', privateToken: 'glpat_minted' }
        ])
        expect(mint).toHaveBeenCalledTimes(2)
      } finally {
        await proxy.stop()
        await new Promise<void>((resolve) => upstream.close(() => resolve()))
      }
    }
  )
})

/** One request through the proxy's CONNECT to `host`, its status line's code. */
function exchange(dial: Dial, host: string, caPem: string, lines: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ ...dial, method: 'CONNECT', path: host })
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) return resolve(res.statusCode ?? 0)
      const servername = host.replace(/:\d+$/, '')
      const tls = tlsConnect({ socket, servername, ca: caPem }, () => {
        const [first, ...headers] = lines
        tls.write(`${[first, `Host: ${host}`, ...headers, 'Connection: close'].join('\r\n')}\r\n\r\n`)
      })
      let raw = ''
      tls.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')))
      tls.on('end', () => resolve(Number(raw.split(' ')[1])))
      tls.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}
