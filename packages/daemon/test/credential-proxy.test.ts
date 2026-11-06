import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
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
import { loadProxyCa, proxyTrustEnv } from '../src/credential-proxy/ca.js'
import { graphqlOperationTypes } from '../src/credential-proxy/graphql-operation.js'
import { githubRoute, graphqlRepository } from '../src/credential-proxy/github-route.js'
import {
  loadPlaceholderKey,
  looksLikePlaceholder,
  openPlaceholder,
  sealPlaceholder
} from '../src/credential-proxy/placeholder.js'
import { CredentialProxy, deniedAddress, presentedCredential } from '../src/credential-proxy/proxy.js'

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
    expect(statSync(join(dir, 'k', 'proxy.key')).mode & 0o777).toBe(0o600)
    expect(loadPlaceholderKey(join(dir, 'k', 'proxy.key')).equals(key)).toBe(true)
    const sealed = sealPlaceholder(key, { agentId: AGENT, hosts: ['api.github.com'] })
    expect(looksLikePlaceholder(sealed)).toBe(true)
    expect(openPlaceholder(key, sealed)).toEqual({ agentId: AGENT, hosts: ['api.github.com'] })
    expect(openPlaceholder(Buffer.alloc(32, 7), sealed)).toBeUndefined()
    const [prefixAndBody, tag] = sealed.split('.')
    const forged = Buffer.from(JSON.stringify({ a: 'other', h: ['api.github.com'] })).toString('base64url')
    expect(openPlaceholder(key, `acph1_${forged}.${tag}`)).toBeUndefined()
    expect(openPlaceholder(key, `${prefixAndBody}.${tag}x`)).toBeUndefined()
    expect(openPlaceholder(key, 'ghp_example')).toBeUndefined()
  })
})

describe('the proxy CA', () => {
  it('keeps every key out of the trust directory a sandbox may read', () => {
    const dir = join(scratch(), 'credential-proxy')
    const ca = loadProxyCa(dir)
    loadPlaceholderKey(join(dir, 'placeholder.key'))
    expect(readdirSync(ca.trustDir).sort()).toEqual(['ca.crt', 'trust.pem'])
    expect(ca.bundlePath.startsWith(ca.trustDir)).toBe(true)
    expect(ca.keyPath.startsWith(ca.trustDir)).toBe(false)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(ca.keyPath).mode & 0o777).toBe(0o600)
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
      readOnly: false
    })
    expect(githubRoute('github.com', 'POST', '/o/r/git-receive-pack')).toMatchObject({ repo: 'o/r', plane: 'git' })
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

function proxyFor(overrides: { mint?: ReturnType<typeof vi.fn>; known?: boolean; workspace?: string } = {}) {
  const dir = scratch()
  const key = loadPlaceholderKey(join(dir, 'proxy.key'))
  const mint = overrides.mint ?? vi.fn(async () => 'ghs_minted')
  const proxy = new CredentialProxy({
    key,
    ca: loadProxyCa(join(dir, 'ca')),
    mint: mint as never,
    workspaceRepo: () => overrides.workspace,
    knownAgent: () => overrides.known ?? true,
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
    expect(mint).toHaveBeenCalledWith(AGENT, 'o/r', 'git', false)
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
    expect(mint).toHaveBeenLastCalledWith(AGENT, 'o/r', 'gh', true)
    await proxy.decide(graphql({ query: '{ viewer { login } }' }), HTTPS)
    expect(mint).toHaveBeenLastCalledWith(AGENT, 'o/ws', 'gh', true)
    const mutation = await proxy.decide(
      graphql({ query: 'mutation { mergePullRequest(input:{}) { clientMutationId } }' }),
      HTTPS
    )
    expect(mutation).toMatchObject({ action: 'deny', status: 403 })
    expect((mutation as { reason: string }).reason).toContain('githubPullRequest')
    expect(await proxy.decide(graphql([{ query: '{ a }' }]), HTTPS)).toMatchObject({ action: 'deny', status: 400 })
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

  it('terminates a CONNECT to the code host and forwards the minted token, over loopback and the Unix socket', async () => {
    const dir = scratch()
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
      mint: async () => 'ghs_minted',
      workspaceRepo: () => undefined,
      knownAgent: () => true,
      log: { info: () => {}, warn: () => {} },
      upstream: { lookupFor: () => toLoopback, trustedCa: upstreamCaPem }
    })
    const socketPath = join(dir, 'run', 'p.sock')
    await proxy.start(socketPath)
    try {
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
      expect(proxyTrustEnv(ca).SSL_CERT_FILE).toBe(ca.bundlePath)
      // The loopback listener is no open proxy: a CONNECT without its credential is refused.
      expect(await connectStatus({ host: url.hostname, port: Number(url.port) }, upstreamPort)).toBe(407)
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
