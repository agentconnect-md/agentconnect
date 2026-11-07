import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createHttpServer, request as httpRequest, type Server as HttpServer } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { connect as netConnect, type AddressInfo, type LookupFunction } from 'node:net'
import { join } from 'node:path'
import { connect as tlsConnect } from 'node:tls'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { generateCa } from '@anthropic-ai/sandbox-runtime'
import { createMitmCA } from '@anthropic-ai/sandbox-runtime/dist/sandbox/mitm-ca.js'
import { mintLeafCert } from '@anthropic-ai/sandbox-runtime/dist/sandbox/mitm-leaf.js'
import { loadProxyCa } from '../src/credential-proxy/ca.js'
import { loadPlaceholderKey } from '../src/credential-proxy/placeholder.js'
import { CredentialProxy } from '../src/credential-proxy/proxy.js'
import type { ManagedCredentialHost } from '../src/gitcred/managed-hosts.js'

// The daemon behind its own outbound proxy: the credential proxy's upstream leg goes through that parent, NO_PROXY hosts go direct.

const AGENT = '11111111-1111-4111-8111-111111111111'
const PROXY_ENV = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy'] as const
const MINTED = { username: 'service-account', token: 'glpat_minted', access: 'write' as const }

const dirs: string[] = []
const saved: Partial<Record<(typeof PROXY_ENV)[number], string>> = {}
const servers: (HttpServer | HttpsServer)[] = []
let upstreamCa = ''
let viaParentPort = 0
let directPort = 0
let parentPort = 0
const upstreamSeen: { host: string; authorization?: string }[] = []
const parentSeen: { target: string; auth?: string }[] = []

/** An HTTPS upstream answering as `name`, recording what reached it. */
async function upstream(name: string, ca: ReturnType<typeof generateCa>): Promise<number> {
  const leaf = mintLeafCert(createMitmCA({ caCertPem: ca.certPem, caKeyPem: ca.keyPem }), name)
  const server = createHttpsServer({ key: leaf.keyPem, cert: leaf.certPem }, (req, res) => {
    upstreamSeen.push({
      host: name,
      ...(req.headers.authorization ? { authorization: req.headers.authorization } : {})
    })
    res.end('ok')
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

beforeAll(async () => {
  for (const name of PROXY_ENV) {
    saved[name] = process.env[name]
    delete process.env[name]
  }
  const ca = generateCa({ cn: 'example upstream CA' })
  upstreamCa = ca.certPem
  viaParentPort = await upstream('gitlab.example.test', ca)
  directPort = await upstream('direct.example.test', ca)
  // The parent resolves every name itself: here, each to the upstream it answers as, and only with its Basic credential.
  const parent = createHttpServer()
  parent.on('connect', (req, socket, head) => {
    const target = req.url ?? ''
    const auth = req.headers['proxy-authorization']
    parentSeen.push({ target, ...(auth ? { auth } : {}) })
    if (auth !== `Basic ${Buffer.from('proxy-user:proxy-pass').toString('base64')}`) {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n')
      return
    }
    const port = target.startsWith('direct.example.test:') ? directPort : viaParentPort
    const out = netConnect(port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) out.write(head)
      out.pipe(socket)
      socket.pipe(out)
    })
    out.on('error', () => socket.destroy())
    socket.on('error', () => out.destroy())
  })
  servers.push(parent)
  await new Promise<void>((resolve) => parent.listen(0, '127.0.0.1', resolve))
  parentPort = (parent.address() as AddressInfo).port
})
afterEach(() => {
  upstreamSeen.splice(0)
  parentSeen.splice(0)
})
afterAll(async () => {
  for (const name of PROXY_ENV) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
  for (const server of servers) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** Only a NO_PROXY host is resolved here, and it answers on loopback; a name through the parent never reaches this. */
const directLookup: LookupFunction = (host, options, callback) => {
  if (host !== 'direct.example.test') return callback(new Error(`${host} was resolved by the daemon`), '', 0)
  if (options.all)
    (callback as (e: null, a: { address: string; family: number }[]) => void)(null, [
      { address: '127.0.0.1', family: 4 }
    ])
  else callback(null, '127.0.0.1', 4)
}

async function startProxy(instances: ManagedCredentialHost[]): Promise<{ proxy: CredentialProxy; caPem: string }> {
  // Short, so each agent's socket fits AF_UNIX on a host whose temp directory is long.
  const dir = mkdtempSync('/tmp/acpp-')
  dirs.push(dir)
  const ca = loadProxyCa(join(dir, 'ca'))
  const proxy = new CredentialProxy({
    key: loadPlaceholderKey(join(dir, 'proxy.key')),
    ca,
    mint: async () => MINTED,
    workspaceRepo: () => undefined,
    instancesOf: () => instances,
    runningAgents: () => [AGENT],
    knownAgent: () => true,
    log: { info: () => {}, warn: () => {} },
    upstream: { lookupFor: () => directLookup, trustedCa: [upstreamCa] }
  })
  await proxy.start(join(dir, 'run'))
  return { proxy, caPem: ca.certPem }
}

type Dial = { host: string; port: number; proxyAuth: string } | { socketPath: string }

function loopbackDial(proxy: CredentialProxy): Dial {
  const url = new URL(proxy.loopbackUrl()!)
  return {
    host: url.hostname,
    port: Number(url.port),
    proxyAuth: `Basic ${Buffer.from(`${url.username}:${url.password}`).toString('base64')}`
  }
}

/** One GET through the proxy's CONNECT to `authority`, verifying `servername` with `caPem`; its status code. */
function get(
  dial: Dial,
  authority: string,
  servername: string,
  caPem: string,
  authorization?: string
): Promise<number> {
  return new Promise((resolve, reject) => {
    const headers = 'proxyAuth' in dial ? { 'proxy-authorization': dial.proxyAuth } : {}
    const req = httpRequest({ ...dial, method: 'CONNECT', path: authority, headers })
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        return resolve(res.statusCode ?? 0)
      }
      const tls = tlsConnect({ socket, servername, ca: caPem }, () => {
        const lines = [
          'GET /gitlab/group/project.git/info/refs?service=git-upload-pack HTTP/1.1',
          `Host: ${authority}`,
          ...(authorization ? [`Authorization: ${authorization}`] : []),
          'Connection: close'
        ]
        tls.write(`${lines.join('\r\n')}\r\n\r\n`)
      })
      let raw = ''
      tls.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')))
      tls.on('end', () => resolve(Number(raw.split(' ')[1])))
      tls.on('error', reject)
    })
    req.on('response', (res) => resolve(res.statusCode ?? 0))
    req.on('error', reject)
    req.end()
  })
}

const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`

// srt's per-agent route is a Unix socket, which Windows never runs.
describe.skipIf(process.platform === 'win32')('the credential proxy behind the daemon’s outbound proxy', () => {
  it('sends a code host’s minted request through the parent, over loopback and srt’s socket, with the parent’s credential', async () => {
    process.env.HTTPS_PROXY = `http://proxy-user:proxy-pass@127.0.0.1:${parentPort}`
    process.env.NO_PROXY = 'direct.example.test'
    const authority = `gitlab.example.test:${viaParentPort}`
    const { proxy, caPem } = await startProxy([{ provider: 'gitlab', baseUrl: `https://${authority}/gitlab` }])
    try {
      const placeholder = basic('x-access-token', proxy.placeholderFor(AGENT))
      expect(await get(loopbackDial(proxy), authority, 'gitlab.example.test', caPem, placeholder)).toBe(200)
      expect(
        await get({ socketPath: proxy.socketFor(AGENT) }, authority, 'gitlab.example.test', caPem, placeholder)
      ).toBe(200)
      expect(upstreamSeen).toEqual([
        { host: 'gitlab.example.test', authorization: basic('service-account', 'glpat_minted') },
        { host: 'gitlab.example.test', authorization: basic('service-account', 'glpat_minted') }
      ])
      expect(parentSeen.map((entry) => entry.target)).toContain(authority)
      expect(parentSeen.every((entry) => entry.auth === basic('proxy-user', 'proxy-pass'))).toBe(true)
    } finally {
      await proxy.stop()
    }
  })

  it('tunnels a host it does not intercept through the parent too', async () => {
    process.env.HTTPS_PROXY = `http://proxy-user:proxy-pass@127.0.0.1:${parentPort}`
    process.env.NO_PROXY = 'direct.example.test'
    const { proxy } = await startProxy([])
    try {
      // The session's own TLS end to end: the parent hands this name to the upstream answering as gitlab.example.test.
      const authority = `other.example.test:${viaParentPort}`
      expect(await get(loopbackDial(proxy), authority, 'gitlab.example.test', upstreamCa)).toBe(200)
      expect(parentSeen.map((entry) => entry.target)).toEqual([authority])
      expect(upstreamSeen).toEqual([{ host: 'gitlab.example.test' }])
    } finally {
      await proxy.stop()
    }
  })

  it('dials a NO_PROXY code host directly, resolved and guarded here', async () => {
    process.env.HTTPS_PROXY = `http://proxy-user:proxy-pass@127.0.0.1:${parentPort}`
    process.env.NO_PROXY = '.example.invalid,direct.example.test'
    const authority = `direct.example.test:${directPort}`
    const { proxy, caPem } = await startProxy([{ provider: 'gitlab', baseUrl: `https://${authority}/gitlab` }])
    try {
      const placeholder = basic('x-access-token', proxy.placeholderFor(AGENT))
      expect(await get(loopbackDial(proxy), authority, 'direct.example.test', caPem, placeholder)).toBe(200)
      expect(upstreamSeen).toEqual([
        { host: 'direct.example.test', authorization: basic('service-account', 'glpat_minted') }
      ])
      expect(parentSeen).toEqual([])
      // The session keeps the daemon's other entries, but none that would send this code host around the proxy.
      expect(proxy.sessionNoProxy(AGENT, process.env.NO_PROXY).split(',')).toEqual([
        'localhost',
        '127.0.0.1',
        '::1',
        '.example.invalid'
      ])
    } finally {
      await proxy.stop()
    }
  })

  it('refuses a code host named by a loopback literal, which no lookup would see', async () => {
    process.env.HTTPS_PROXY = `http://proxy-user:proxy-pass@127.0.0.1:${parentPort}`
    const authority = `127.0.0.1:${viaParentPort}`
    const { proxy, caPem } = await startProxy([{ provider: 'gitlab', baseUrl: `https://${authority}/gitlab` }])
    try {
      const placeholder = basic('x-access-token', proxy.placeholderFor(AGENT))
      expect(await get(loopbackDial(proxy), authority, 'gitlab.example.test', caPem, placeholder)).toBe(403)
      expect(await get(loopbackDial(proxy), `127.1:${viaParentPort}`, 'gitlab.example.test', caPem, placeholder)).toBe(
        403
      )
      expect(upstreamSeen).toEqual([])
      expect(parentSeen).toEqual([])
    } finally {
      await proxy.stop()
    }
  })
})
