import { mkdtempSync, rmSync } from 'node:fs'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import type { AddressInfo, LookupFunction, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect as tlsConnect, createSecureContext } from 'node:tls'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { generateCa } from '@anthropic-ai/sandbox-runtime'
import { createMitmCA } from '@anthropic-ai/sandbox-runtime/dist/sandbox/mitm-ca.js'
import { mintLeafCert } from '@anthropic-ai/sandbox-runtime/dist/sandbox/mitm-leaf.js'
import { loadProxyCa } from '../src/credential-proxy/ca.js'
import { loadPlaceholderKey, openPlaceholder, sealPlaceholder } from '../src/credential-proxy/placeholder.js'
import {
  providerKeyPlaceholders,
  underSlotPrefix,
  type ProviderSlot,
  type ResolvedProviderKey
} from '../src/credential-proxy/provider-route.js'
import { CredentialProxy, deniedAddress, deniedSelfManagedAddress } from '../src/credential-proxy/proxy.js'
import { GITHUB_MANAGED_HOST } from '../src/gitcred/managed-hosts.js'

// Provider API key placeholders through the credential proxy: the slot's real key goes back in the header the client used.

const AGENT = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const quiet = { info: () => {}, warn: () => {} }
const HTTPS = { scheme: 'https' as const }

const toLoopback: LookupFunction = (_host, options, callback) => {
  if (options.all)
    (callback as (e: null, a: { address: string; family: number }[]) => void)(null, [
      { address: '127.0.0.1', family: 4 }
    ])
  else callback(null, '127.0.0.1', 4)
}

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function slotsAt(port: number): ProviderSlot[] {
  return [
    { id: 'org:anthropic', provider: 'anthropic', host: 'api.anthropic.com', port, saas: true },
    { id: 'org:openai', provider: 'openai', host: 'api.openai.com', port, saas: true },
    { id: 'org:azure', provider: 'azure-openai', host: 'llm.example.test', port, pathPrefix: 'openai', saas: false },
    { id: 'org:gemini', provider: 'gemini', host: 'llm.example.test', port, pathPrefix: '/gemini/', saas: false },
    { id: 'org:rotating', provider: 'anthropic', host: 'rotate.example.test', port, saas: false }
  ]
}

// The fake upstream's pause before its first SSE event.
const FIRST_EVENT_DELAY_MS = 50

const KEYS: Record<string, ResolvedProviderKey> = {
  'org:anthropic': { key: 'sk-ant-real' },
  'org:openai': { key: 'sk-openai-real', headers: { 'openai-organization': 'org-example' } },
  'org:azure': { key: 'azure-real' },
  'org:gemini': { key: 'gemini-real' }
}

function proxyWith(
  dir: string,
  options: {
    port?: number
    resolve?: (agentId: string, slotId: string) => Promise<ResolvedProviderKey>
    upstream?: { lookupFor: () => LookupFunction; trustedCa: string }
  } = {}
) {
  const ca = loadProxyCa(join(dir, 'ca'))
  const resolve = vi.fn(
    options.resolve ??
      (async (_agentId: string, slotId: string) => {
        const key = KEYS[slotId]
        if (!key) throw new Error(`no key for ${slotId}`)
        return key
      })
  )
  const proxy = new CredentialProxy({
    key: loadPlaceholderKey(join(dir, 'proxy.key')),
    ca,
    mint: async () => ({ username: 'x-access-token', token: 'ghs_minted', access: 'write' as const }),
    workspaceRepo: () => undefined,
    instancesOf: (agentId) => (agentId === AGENT ? [GITHUB_MANAGED_HOST] : []),
    runningAgents: () => [AGENT, OTHER],
    knownAgent: () => true,
    providerSlotsOf: (agentId) => (agentId === AGENT || agentId === OTHER ? slotsAt(options.port ?? 443) : []),
    resolveProviderSlot: resolve,
    log: quiet,
    ...(options.upstream ? { upstream: options.upstream } : {})
  })
  return { proxy, ca, resolve }
}

describe('a provider placeholder', () => {
  it('seals its kind and slot, and is refused at the other kind’s host before anything else', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-provider-'))
    dirs.push(dir)
    const { proxy, resolve } = proxyWith(dir)
    const provider = proxy.providerPlaceholderFor(AGENT, 'org:anthropic')!
    expect(proxy.providerPlaceholderFor(AGENT, 'org:missing')).toBeUndefined()
    const codehost = proxy.placeholderFor(AGENT)
    const key = loadPlaceholderKey(join(dir, 'proxy.key'))
    expect(openPlaceholder(key, provider)).toEqual({
      agentId: AGENT,
      hosts: ['api.anthropic.com'],
      kind: 'provider',
      slot: 'org:anthropic'
    })
    expect(openPlaceholder(key, codehost)).toMatchObject({ kind: 'codehost' })
    expect(() => sealPlaceholder(key, { agentId: AGENT, hosts: [], kind: 'provider' })).toThrow()
    const toProvider = new Request('https://api.anthropic.com/v1/messages', { headers: { 'x-api-key': codehost } })
    expect(await proxy.decide(toProvider, HTTPS)).toMatchObject({ action: 'deny', status: 403 })
    const toCodeHost = new Request('https://api.github.com/repos/o/r', {
      headers: { authorization: `token ${provider}` }
    })
    expect(await proxy.decide(toCodeHost, HTTPS)).toMatchObject({ action: 'deny', status: 403 })
    const bearerToCodeHost = new Request('https://api.github.com/user', {
      headers: { authorization: `Bearer ${provider}` }
    })
    expect(await proxy.decide(bearerToCodeHost, HTTPS)).toMatchObject({ action: 'deny', status: 403 })
    // Sealed for one slot, it is not another slot's key on the same agent.
    const elsewhere = new Request('https://api.openai.com/v1/chat/completions', {
      headers: { authorization: `Bearer ${provider}` }
    })
    expect(await proxy.decide(elsewhere, HTTPS)).toMatchObject({ action: 'deny', status: 403 })
    expect(resolve).not.toHaveBeenCalled()
  })

  it('swaps an x-goog-api-key, refuses a non-Bearer Authorization or an unresolvable key, and leaves unrelated hosts alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-provider-'))
    dirs.push(dir)
    const { proxy } = proxyWith(dir)
    const gemini = proxy.providerPlaceholderFor(AGENT, 'org:gemini')!
    const goog = new Request('https://llm.example.test/gemini/v1beta/models', { headers: { 'x-goog-api-key': gemini } })
    expect(await proxy.decide(goog, { ...HTTPS, requestTarget: '/gemini/v1beta/models' })).toMatchObject({
      action: 'allow',
      setHeaders: [['x-goog-api-key', 'gemini-real']]
    })
    const openai = proxy.providerPlaceholderFor(AGENT, 'org:openai')!
    const basic = new Request('https://api.openai.com/v1/models', { headers: { authorization: `token ${openai}` } })
    expect(await proxy.decide(basic, HTTPS)).toMatchObject({ action: 'deny', status: 400 })
    const rotating = proxy.providerPlaceholderFor(AGENT, 'org:rotating')!
    const unresolved = new Request('https://rotate.example.test/v1/messages', { headers: { 'x-api-key': rotating } })
    expect(await proxy.decide(unresolved, HTTPS)).toMatchObject({ action: 'deny', status: 403 })
    const unrelated = new Request('https://registry.npmjs.org/x', { headers: { 'x-api-key': openai } })
    expect(await proxy.decide(unrelated, HTTPS)).toEqual({ action: 'allow' })
  })

  it('resolves afresh when a slot is replaced at another endpoint, never sending the old endpoint’s key there', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-provider-'))
    dirs.push(dir)
    let slot: ProviderSlot = {
      id: 'org:custom',
      provider: 'anthropic',
      host: 'old.example.test',
      port: 443,
      saas: false
    }
    const resolve = vi.fn(async () =>
      slot.host === 'old.example.test'
        ? { key: 'old-real', headers: { 'x-workspace': 'old' } }
        : { key: 'new-real', headers: { 'x-workspace': 'new' } }
    )
    const proxy = new CredentialProxy({
      key: loadPlaceholderKey(join(dir, 'proxy.key')),
      ca: loadProxyCa(join(dir, 'ca')),
      mint: async () => ({ username: 'x-access-token', token: 'ghs_minted', access: 'write' as const }),
      workspaceRepo: () => undefined,
      instancesOf: () => [],
      runningAgents: () => [AGENT],
      knownAgent: () => true,
      providerSlotsOf: () => [slot],
      resolveProviderSlot: resolve,
      log: quiet
    })
    const before = proxy.providerPlaceholderFor(AGENT, 'org:custom')!
    const toOld = new Request('https://old.example.test/v1/messages', { headers: { 'x-api-key': before } })
    expect(await proxy.decide(toOld, HTTPS)).toMatchObject({
      setHeaders: [
        ['x-api-key', 'old-real'],
        ['x-workspace', 'old']
      ]
    })
    slot = { ...slot, host: 'new.example.test' }
    const after = proxy.providerPlaceholderFor(AGENT, 'org:custom')!
    const toNew = new Request('https://new.example.test/v1/messages', { headers: { 'x-api-key': after } })
    expect(await proxy.decide(toNew, HTTPS)).toMatchObject({
      setHeaders: [
        ['x-api-key', 'new-real'],
        ['x-workspace', 'new']
      ]
    })
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('reads the headers a provider client sends its key in, and the slot’s prefix', () => {
    const headers = new Headers({ authorization: 'Bearer acph1_a.b', 'api-key': 'acph1_c.d', 'x-api-key': 'sk-own' })
    expect(providerKeyPlaceholders(headers)).toEqual([
      { header: 'authorization', value: 'acph1_a.b', scheme: 'bearer' },
      { header: 'api-key', value: 'acph1_c.d' }
    ])
    const slot: ProviderSlot = {
      id: 's',
      provider: 'p',
      host: 'h.example.test',
      port: 443,
      pathPrefix: 'openai',
      saas: false
    }
    expect(underSlotPrefix(slot, '/openai/deployments/x?api-version=1')).toBe(true)
    expect(underSlotPrefix(slot, '/openai')).toBe(true)
    expect(underSlotPrefix(slot, '/openaix/v1')).toBe(false)
    expect(underSlotPrefix({ ...slot, pathPrefix: undefined }, '/anything')).toBe(true)
  })

  it('guards a SaaS origin’s name against all private space and an operator’s endpoint only against loopback', () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-provider-'))
    dirs.push(dir)
    const { proxy } = proxyWith(dir)
    const deniedFor = (proxy as unknown as { deniedFor: (host: string) => unknown }).deniedFor.bind(proxy)
    expect(deniedFor('api.anthropic.com')).toBe(deniedAddress)
    expect(deniedFor('llm.example.test')).toBe(deniedSelfManagedAddress)
    expect(deniedFor('registry.npmjs.org')).toBeUndefined()
    expect(proxy.domainsFor(AGENT)).toEqual(
      expect.arrayContaining(['github.com', 'api.anthropic.com', 'api.openai.com', 'llm.example.test'])
    )
    // A codehost tunnel stays a code-host matter; the slots ride the provider tunnel.
    expect(proxy.tunnelRoutes(OTHER)).toEqual([])
    expect(proxy.providerTunnelRoutes(OTHER)).toEqual([
      'api.anthropic.com:443',
      'api.openai.com:443',
      'llm.example.test:443',
      'rotate.example.test:443'
    ])
  })
})

interface Seen {
  host?: string
  url?: string
  headers: IncomingHttpHeaders
}

type Dial = { host: string; port: number; proxyAuth?: string } | { socketPath: string }

interface Reply {
  status: number
  body: string
}

/** One request through the proxy's CONNECT to `authority`, the response read as it arrives. */
function through(
  dial: Dial,
  authority: string,
  caPem: string,
  request: { method?: string; path: string; headers?: Record<string, string> },
  onData?: (body: string) => void
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const proxyHeaders = 'proxyAuth' in dial && dial.proxyAuth ? { 'proxy-authorization': dial.proxyAuth } : {}
    const connect = httpRequest({ ...dial, method: 'CONNECT', path: authority, headers: proxyHeaders })
    connect.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        return resolve({ status: res.statusCode ?? 0, body: '' })
      }
      const [hostname = '', port = '443'] = authority.split(':')
      const tls = tlsConnect({ socket, servername: hostname, ca: caPem })
      const req = httpRequest(
        {
          createConnection: () => tls as unknown as Socket,
          host: hostname,
          port: Number(port),
          method: request.method ?? 'GET',
          path: request.path,
          headers: { ...request.headers, connection: 'close' }
        },
        (response) => {
          let body = ''
          response.setEncoding('utf8')
          response.on('data', (chunk: string) => {
            body += chunk
            onData?.(body)
          })
          response.on('end', () => resolve({ status: response.statusCode ?? 0, body }))
          response.on('error', reject)
        }
      )
      req.on('error', reject)
      req.end()
    })
    connect.on('error', reject)
    connect.end()
  })
}

/** A request sent to the proxy in cleartext, in absolute form. */
function plain(dial: Dial, url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ ...dial, method: 'GET', path: url, headers: { host: new URL(url).host, ...headers } })
    req.on('response', (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end()
  })
}

describe('provider keys through the proxy end to end', () => {
  let upstream: HttpsServer
  let port = 0
  let upstreamCaPem = ''
  const seen: Seen[] = []
  let releaseStream: () => void = () => {}
  let streamEnded = false

  beforeAll(async () => {
    const generated = generateCa({ cn: 'example upstream CA' })
    upstreamCaPem = generated.certPem
    const mitm = createMitmCA({ caCertPem: generated.certPem, caKeyPem: generated.keyPem })
    const contexts = new Map<string, ReturnType<typeof createSecureContext>>()
    const contextFor = (name: string) => {
      if (!contexts.has(name)) {
        const leaf = mintLeafCert(mitm, name)
        contexts.set(name, createSecureContext({ key: leaf.keyPem, cert: leaf.certPem }))
      }
      return contexts.get(name)!
    }
    upstream = createHttpsServer({ SNICallback: (name, callback) => callback(null, contextFor(name)) }, (req, res) => {
      seen.push({
        ...(req.headers.host ? { host: req.headers.host } : {}),
        ...(req.url ? { url: req.url } : {}),
        headers: req.headers
      })
      if (req.url?.endsWith('/stream')) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        setTimeout(() => {
          res.write('event: one\ndata: {"n":1}\n\n')
          const released = new Promise<void>((resolve) => {
            releaseStream = resolve
            setTimeout(resolve, 5000)
          })
          void released.then(() => {
            streamEnded = true
            res.end('event: two\ndata: {"n":2}\n\n')
          })
        }, FIRST_EVENT_DELAY_MS)
        return
      }
      if (req.headers['x-api-key'] === 'sk-revoked') {
        res.statusCode = 401
        res.end('{"error":"invalid key"}')
        return
      }
      res.setHeader('content-type', 'application/json')
      res.end('{"ok":true}')
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    port = (upstream.address() as AddressInfo).port
  })
  afterAll(async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  })

  async function started(resolve?: (agentId: string, slotId: string) => Promise<ResolvedProviderKey>) {
    // Short, so each agent's socket fits AF_UNIX on a host whose temp directory is long.
    const dir = mkdtempSync('/tmp/acpp-')
    dirs.push(dir)
    const built = proxyWith(dir, {
      port,
      ...(resolve ? { resolve } : {}),
      upstream: { lookupFor: () => toLoopback, trustedCa: upstreamCaPem }
    })
    await built.proxy.start(join(dir, 'run'))
    return { ...built, socketPath: built.proxy.socketFor(AGENT) }
  }

  it.skipIf(process.platform === 'win32')(
    'puts the real key back in x-api-key, Bearer and api-key, with the slot’s extra headers',
    async () => {
      const { proxy, ca, socketPath } = await started()
      try {
        const dial = { socketPath }
        seen.length = 0
        const anthropic = proxy.providerPlaceholderFor(AGENT, 'org:anthropic')!
        const openai = proxy.providerPlaceholderFor(AGENT, 'org:openai')!
        const azure = proxy.providerPlaceholderFor(AGENT, 'org:azure')!
        const replies = [
          await through(dial, `api.anthropic.com:${port}`, ca.certPem, {
            method: 'POST',
            path: '/v1/messages',
            headers: { 'x-api-key': anthropic, 'anthropic-version': '2023-06-01' }
          }),
          await through(dial, `api.openai.com:${port}`, ca.certPem, {
            path: '/v1/models',
            headers: { authorization: `Bearer ${openai}` }
          }),
          await through(dial, `llm.example.test:${port}`, ca.certPem, {
            path: '/openai/deployments/d/chat/completions?api-version=2024-10-21',
            headers: { 'api-key': azure }
          }),
          // A key the agent brought itself passes untouched.
          await through(dial, `api.anthropic.com:${port}`, ca.certPem, {
            path: '/v1/models',
            headers: { 'x-api-key': 'sk-own' }
          }),
          // Beside the slot's prefix the placeholder is dropped, never exchanged.
          await through(dial, `llm.example.test:${port}`, ca.certPem, {
            path: '/other/v1/models',
            headers: { 'api-key': azure }
          })
        ]
        expect(replies.map((reply) => reply.status)).toEqual([200, 200, 200, 200, 200])
        expect(seen[0]!.headers['x-api-key']).toBe('sk-ant-real')
        expect(seen[0]!.headers['anthropic-version']).toBe('2023-06-01')
        expect(seen[1]!.headers.authorization).toBe('Bearer sk-openai-real')
        expect(seen[1]!.headers['openai-organization']).toBe('org-example')
        expect(seen[2]!.headers['api-key']).toBe('azure-real')
        expect(seen[2]!.url).toBe('/openai/deployments/d/chat/completions?api-version=2024-10-21')
        expect(seen[3]!.headers['x-api-key']).toBe('sk-own')
        expect(seen[4]!.url).toBe('/other/v1/models')
        expect(seen[4]!.headers['api-key']).toBeUndefined()
      } finally {
        await proxy.stop()
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'streams server-sent events: the first event arrives before the upstream finishes',
    async () => {
      const { proxy, ca, socketPath } = await started()
      try {
        streamEnded = false
        let endedAtFirstEvent: boolean | undefined
        const reply = await through(
          { socketPath },
          `api.anthropic.com:${port}`,
          ca.certPem,
          {
            method: 'POST',
            path: '/v1/messages/stream',
            headers: { 'x-api-key': proxy.providerPlaceholderFor(AGENT, 'org:anthropic')! }
          },
          (body) => {
            if (endedAtFirstEvent === undefined && body.includes('event: one')) {
              endedAtFirstEvent = streamEnded
              releaseStream()
            }
          }
        )
        expect(reply.status).toBe(200)
        expect(endedAtFirstEvent).toBe(false)
        expect(reply.body).toContain('event: two')
      } finally {
        await proxy.stop()
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'refuses across kinds, in cleartext and over another agent’s socket',
    async () => {
      const { proxy, ca, socketPath, resolve } = await started()
      try {
        seen.length = 0
        const anthropic = proxy.providerPlaceholderFor(AGENT, 'org:anthropic')!
        const codehost = proxy.placeholderFor(AGENT)
        const codehostAtProvider = await through({ socketPath }, `api.anthropic.com:${port}`, ca.certPem, {
          path: '/v1/models',
          headers: { 'x-api-key': codehost }
        })
        const providerAtCodeHost = await through({ socketPath }, `api.github.com:${port}`, ca.certPem, {
          path: '/repos/o/r',
          headers: { authorization: `token ${anthropic}` }
        })
        const cleartext = await plain({ socketPath }, `http://api.anthropic.com:${port}/v1/models`, {
          'x-api-key': anthropic
        })
        const otherSocket = await through(
          { socketPath: proxy.socketFor(OTHER) },
          `api.anthropic.com:${port}`,
          ca.certPem,
          {
            path: '/v1/models',
            headers: { 'x-api-key': anthropic }
          }
        )
        expect([codehostAtProvider.status, providerAtCodeHost.status, cleartext, otherSocket.status]).toEqual([
          403, 403, 403, 403
        ])
        expect(seen).toHaveLength(0)
        expect(resolve).not.toHaveBeenCalled()
      } finally {
        await proxy.stop()
      }
    }
  )

  it.skipIf(process.platform === 'win32')('resolves the key afresh after the upstream answers 401', async () => {
    const keys = ['sk-revoked', 'sk-fresh']
    const { proxy, ca, socketPath, resolve } = await started(async (_agentId, slotId) => {
      if (slotId !== 'org:rotating') throw new Error(`no key for ${slotId}`)
      return { key: keys.shift() ?? 'sk-fresh' }
    })
    try {
      seen.length = 0
      const placeholder = proxy.providerPlaceholderFor(AGENT, 'org:rotating')!
      const send = () =>
        through({ socketPath }, `rotate.example.test:${port}`, ca.certPem, {
          path: '/v1/messages',
          headers: { 'x-api-key': placeholder }
        })
      const statuses = [(await send()).status, (await send()).status, (await send()).status]
      expect(statuses).toEqual([401, 200, 200])
      expect(seen.map((entry) => entry.headers['x-api-key'])).toEqual(['sk-revoked', 'sk-fresh', 'sk-fresh'])
      // Cached once it works: the third request reused the second's key.
      expect(resolve).toHaveBeenCalledTimes(2)
    } finally {
      await proxy.stop()
    }
  })
})
