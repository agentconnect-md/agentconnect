// Real Git pack transfer through a shim's codehost listener and the daemon's Azure credential proxy.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as httpServer, type Server as HttpServer } from 'node:http'
import { createServer as httpsServer, type Server as HttpsServer } from 'node:https'
import { connect, type AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { createSecureContext } from 'node:tls'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateCa } from '@anthropic-ai/sandbox-runtime'
import { createMitmCA } from '@anthropic-ai/sandbox-runtime/dist/sandbox/mitm-ca.js'
import { mintLeafCert } from '@anthropic-ai/sandbox-runtime/dist/sandbox/mitm-leaf.js'
import { AGENT_CHANNEL_CAPABILITY_ENV } from '../src/agent-channel/env.js'
import { loadProxyCa } from '../src/credential-proxy/ca.js'
import { proxyHosts, type ProxyRepository } from '../src/credential-proxy/instance-route.js'
import { loadPlaceholderKey } from '../src/credential-proxy/placeholder.js'
import { CredentialProxy } from '../src/credential-proxy/proxy.js'
import { AZURE_DEVOPS_MANAGED_HOST, GITHUB_MANAGED_HOST } from '../src/gitcred/managed-hosts.js'
import { codehostProxyUrl } from '../src/remote/codehost-spawn.js'
import type { ShimRequester } from '../src/shim/channels.js'
import { createExecHandler } from '../src/shim/exec-handler.js'
import { ShimGitRunner } from '../src/shim/git-exec.js'
import type { ShimEvent } from '../src/shim/protocol.js'
import { TunnelHost } from '../src/shim/tunnel-host.js'
import { TunnelProxy } from '../src/shim/tunnel-proxy.js'
import {
  cloneGitEnv,
  initGitInjection,
  managedCredentialScope,
  proxiedDaemonGitEnv,
  workspaceGitEnvBase,
  workspaceGitRemoteTarget
} from '../src/workspace/git-injection.js'

const AGENT = '11111111-1111-4111-8111-111111111111'
const TOKEN = 'example-upstream-token'
const REMOTE = 'https://dev.azure.com/example-org/project/_git/repository'
const READ_REMOTE = 'https://dev.azure.com/another-org/project/_git/repository'
const PROXY_ENV = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy'] as const
const IDENTITY = {
  GIT_AUTHOR_NAME: 'Example',
  GIT_AUTHOR_EMAIL: 'agent@example.test',
  GIT_COMMITTER_NAME: 'Example',
  GIT_COMMITTER_EMAIL: 'agent@example.test'
}
const REPOSITORIES: ProxyRepository[] = ['example-org', 'another-org'].map((organization, index) => ({
  repoId: String(42 + index),
  repoFullName: `${organization}/project/repository`,
  azureDevOps: {
    organization,
    projectId: '00000000-0000-4000-8000-000000000001',
    repositoryId: `00000000-0000-4000-8000-00000000001${index}`
  }
}))
const HOSTS = [GITHUB_MANAGED_HOST, ...proxyHosts(AZURE_DEVOPS_MANAGED_HOST, () => REPOSITORIES)]
const quiet = { info: () => {}, warn: () => {} }

describe.skipIf(process.platform === 'win32')('Azure daemon Git through an execution environment', () => {
  let root: string
  let upstream: HttpsServer
  let parent: HttpServer
  let storage: HttpsServer
  let proxy: CredentialProxy
  let host: TunnelHost
  let tunnel: TunnelProxy
  let proxyUrl: string
  let trustBundle: string
  let bundleUrl: string
  let bundleReads = 0
  const sockets = new Set<Duplex>()
  const children = new Set<ChildProcess>()
  const seen: { url: string; authorization: string | undefined }[] = []
  const connected: string[] = []
  const saved: Partial<Record<(typeof PROXY_ENV)[number], string>> = {}
  const scope = managedCredentialScope('github', undefined, false, {}, true)

  function local(cwd: string, args: string[]): string {
    return execFileSync('git', args, {
      cwd,
      env: { ...process.env, ...IDENTITY, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
  }

  beforeAll(async () => {
    root = realpathSync(mkdtempSync('/tmp/ac-azgit-'))
    for (const name of PROXY_ENV) {
      saved[name] = process.env[name]
      delete process.env[name]
    }
    const bare = join(root, 'repository.git')
    local(root, ['init', '--bare', '--initial-branch=main', bare])
    local(bare, ['config', 'http.receivepack', 'true'])
    const seed = join(root, 'seed')
    mkdirSync(seed)
    local(seed, ['init', '--initial-branch=main'])
    writeFileSync(join(seed, 'README.md'), 'initial content\n')
    local(seed, ['add', 'README.md'])
    local(seed, ['commit', '-m', 'initial'])
    local(seed, ['push', bare, 'main'])
    local(seed, ['bundle', 'create', join(root, 'snapshot.bundle'), '--all'])

    const upstreamCa = generateCa({ cn: 'example upstream authority' })
    const signer = createMitmCA({ caCertPem: upstreamCa.certPem, caKeyPem: upstreamCa.keyPem })
    const leaves = new Map(
      ['dev.azure.com', 'example-org.visualstudio.com', 'localhost'].map((name) => [name, mintLeafCert(signer, name)])
    )
    const leaf = leaves.get('dev.azure.com')!
    const backend = join(local(root, ['--exec-path']), 'git-http-backend')
    upstream = httpsServer(
      {
        key: leaf.keyPem,
        cert: leaf.certPem,
        SNICallback: (name, done) => {
          const cert = leaves.get(name) ?? leaf
          done(null, createSecureContext({ key: cert.keyPem, cert: cert.certPem }))
        }
      },
      (req, res) => {
        seen.push({ url: req.url ?? '', authorization: req.headers.authorization })
        if (req.headers.authorization !== `Basic ${Buffer.from(`identity:${TOKEN}`).toString('base64')}`) {
          res.writeHead(401, { 'www-authenticate': 'Basic realm="example"' }).end()
          return
        }
        const url = new URL(req.url ?? '/', 'https://dev.azure.com')
        const service = /\/_git\/repository(\/.*)$/.exec(url.pathname)?.[1]
        if (!service) {
          res.writeHead(404).end()
          return
        }
        const child = spawn(backend, {
          env: {
            PATH: process.env.PATH ?? '',
            GIT_PROJECT_ROOT: root,
            GIT_HTTP_EXPORT_ALL: '1',
            REMOTE_USER: 'identity',
            REQUEST_METHOD: req.method ?? 'GET',
            PATH_INFO: `/repository.git${service}`,
            QUERY_STRING: url.search.slice(1),
            CONTENT_TYPE: req.headers['content-type'] ?? '',
            CONTENT_LENGTH: req.headers['content-length'] ?? '',
            HTTP_GIT_PROTOCOL: String(req.headers['git-protocol'] ?? '')
          },
          stdio: ['pipe', 'pipe', 'pipe']
        })
        children.add(child)
        req.pipe(child.stdin)
        let pending = Buffer.alloc(0)
        let headers = false
        child.stdout.on('data', (chunk: Buffer) => {
          if (headers) return void res.write(chunk)
          pending = Buffer.concat([pending, chunk])
          const end = pending.indexOf('\r\n\r\n')
          if (end < 0) return
          headers = true
          for (const line of pending.subarray(0, end).toString().split('\r\n')) {
            const colon = line.indexOf(':')
            if (colon > 0) res.setHeader(line.slice(0, colon), line.slice(colon + 1).trim())
          }
          res.write(pending.subarray(end + 4))
        })
        child.on('close', () => {
          children.delete(child)
          res.end()
        })
        child.on('error', () => res.destroy())
      }
    )
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    parent = httpServer()
    parent.on('connect', (req, socket, head) => {
      connected.push(req.url ?? '')
      const out = connect((upstream.address() as AddressInfo).port, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) out.write(head)
        out.pipe(socket)
        socket.pipe(out)
      })
      for (const active of [socket, out]) {
        sockets.add(active)
        active.on('close', () => sockets.delete(active))
      }
      socket.on('error', () => out.destroy())
      out.on('error', () => socket.destroy())
    })
    await new Promise<void>((resolve) => parent.listen(0, '127.0.0.1', resolve))
    process.env.HTTPS_PROXY = `http://127.0.0.1:${(parent.address() as AddressInfo).port}`
    const ca = loadProxyCa(join(root, 'ca'))
    proxy = new CredentialProxy({
      key: loadPlaceholderKey(join(root, 'proxy.key')),
      ca,
      mint: async (_agentId, ask) => ({
        username: 'identity',
        token: TOKEN,
        access: ask.repoId === '42' ? 'write' : 'read'
      }),
      workspaceRepo: () => 'example-org/example-repo',
      instancesOf: () => HOSTS,
      repositoriesOf: (_agentId, provider) => (provider === 'azure-devops' ? REPOSITORIES : []),
      runningAgents: () => [AGENT],
      knownAgent: (agentId) => agentId === AGENT,
      log: quiet,
      upstream: { trustedCa: [upstreamCa.certPem] }
    })
    await proxy.start(join(root, 'run'))
    const events = new Set<(event: ShimEvent) => void>()
    host = new TunnelHost({
      emit: (streamId, event) => events.forEach((listener) => listener({ type: 'shim/event', streamId, event })),
      socketPathFor: (name) => join(root, 'shim', `${name}.sock`)
    })
    tunnel = new TunnelProxy({
      session: {
        agentId: AGENT,
        request: async (_capability, payload) => host.handle(JSON.parse(JSON.stringify(payload))),
        onEvent: (listener) => void events.add(listener),
        offEvent: (listener) => void events.delete(listener),
        onAttach: () => {},
        offAttach: () => {},
        onLost: () => {}
      },
      socketPathFor: () => proxy.tunnelSocketFor(AGENT),
      listenOptions: () => ({ routes: proxy.tunnelRoutes(AGENT), ca: ca.certPem }),
      log: quiet
    })
    await tunnel.ensure('codehost')
    const listener = tunnel.listeningAt('codehost')!.proxy!
    proxyUrl = codehostProxyUrl(listener)
    trustBundle = listener.trustBundle
    writeFileSync(trustBundle, readFileSync(trustBundle, 'utf8') + upstreamCa.certPem)
    const storageCert = leaves.get('localhost')!
    storage = httpsServer({ key: storageCert.keyPem, cert: storageCert.certPem }, (_req, res) => {
      bundleReads += 1
      res.end(readFileSync(join(root, 'snapshot.bundle')))
    })
    await new Promise<void>((resolve) => storage.listen(0, '127.0.0.1', resolve))
    bundleUrl = `https://localhost:${(storage.address() as AddressInfo).port}/snapshot.bundle`
    initGitInjection({
      targetFor: () => ({ kind: 'sandbox', helper: '/unavailable-real-token-helper', configDir: join(root, 'config') }),
      capabilityFor: () => 'example-daemon-mint-capability',
      preWarm: async () => undefined
    })
  })

  afterAll(async () => {
    tunnel?.stop('test complete')
    await host?.close()
    await proxy?.stop()
    for (const child of children) child.kill('SIGKILL')
    for (const socket of sockets) socket.destroy()
    for (const server of [storage, parent, upstream]) {
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    for (const name of PROXY_ENV) {
      if (saved[name] === undefined) delete process.env[name]
      else process.env[name] = saved[name]
    }
    if (root) rmSync(root, { recursive: true, force: true })
  })

  function runner(cwd: string, env: Record<string, string>, bundle = trustBundle) {
    const mapped = proxiedDaemonGitEnv(env, HOSTS, { proxyUrl, trustBundle: bundle }, proxy.placeholderFor(AGENT))
    expect(mapped).not.toHaveProperty(AGENT_CHANNEL_CAPABILITY_ENV)
    expect(JSON.stringify(mapped)).not.toContain(TOKEN)
    expect(JSON.stringify(mapped)).not.toContain('/unavailable-real-token-helper')
    const handler = createExecHandler({ workspaceRoot: root })
    const request: ShimRequester['request'] = (capability, payload, opts) => handler(capability, payload, opts?.abort)
    return new ShimGitRunner({ request }, cwd, mapped)
  }

  it('rejects untrusted TLS even when the input disables verification', async () => {
    const untrusted = loadProxyCa(join(root, 'untrusted-ca')).bundlePath
    const before = seen.length
    const env = { ...workspaceGitEnvBase(REMOTE), ...cloneGitEnv(AGENT, REMOTE, scope), GIT_SSL_NO_VERIFY: 'false' }
    await expect(runner(root, env, untrusted).raw(['ls-remote', REMOTE])).rejects.toThrow(/certificate/i)
    await expect(runner(root, env, untrusted).raw(['ls-remote', bundleUrl])).rejects.toThrow(/certificate/i)
    expect(seen).toHaveLength(before)
    expect(bundleReads).toBe(0)
  })

  it('clones from a bundle directly, then fetches and pushes packs through the authenticated tunnel', async () => {
    const checkout = join(root, 'checkout')
    const cloneEnv = {
      ...workspaceGitEnvBase(REMOTE),
      ...cloneGitEnv(AGENT, REMOTE, scope),
      HTTPS_PROXY: 'http://unused.example.test:3128',
      NO_PROXY: '*'
    }
    await runner(root, cloneEnv).clone(REMOTE, checkout, [`--bundle-uri=${bundleUrl}`])
    expect(bundleReads).toBe(1)
    expect(readFileSync(join(checkout, 'README.md'), 'utf8')).toBe('initial content\n')
    const seed = join(root, 'seed')
    writeFileSync(join(seed, 'new.txt'), 'fetched content\n')
    local(seed, ['add', 'new.txt'])
    local(seed, ['commit', '-m', 'advance'])
    local(seed, ['push', join(root, 'repository.git'), 'main'])
    const target = workspaceGitRemoteTarget('https://dev.azure.com/Example-Org/project/_git/repository', AGENT, scope)
    const remoteEnv = { ...workspaceGitEnvBase(REMOTE), ...target.env }
    await runner(checkout, remoteEnv).raw(['fetch', target.remote, 'main'])
    expect(local(checkout, ['show', 'FETCH_HEAD:new.txt'])).toBe('fetched content')
    await runner(checkout, remoteEnv).raw(['push', target.remote, 'HEAD:refs/heads/agent-change'])
    expect(local(join(root, 'repository.git'), ['rev-parse', 'agent-change'])).toBe(
      local(checkout, ['rev-parse', 'HEAD'])
    )
    expect(seen.some((request) => request.url.endsWith('/git-receive-pack'))).toBe(true)
    expect(connected.every((authority) => authority === 'dev.azure.com:443')).toBe(true)
    const authenticated = seen.filter((request) => request.authorization !== undefined)
    expect(authenticated.length).toBeGreaterThan(0)
    expect(
      authenticated.every(
        (request) => request.authorization === `Basic ${Buffer.from(`identity:${TOKEN}`).toString('base64')}`
      )
    ).toBe(true)
  })

  it('reads both organizations and a supported alias, without authenticating forbidden Git operations', async () => {
    const alias = 'https://example-org.visualstudio.com/project/_git/repository'
    for (const remote of [READ_REMOTE, alias]) {
      const refs = await runner(root, { ...workspaceGitEnvBase(remote), ...cloneGitEnv(AGENT, remote, scope) }).raw([
        'ls-remote',
        remote
      ])
      expect(refs).toContain('refs/heads/main')
    }
    const before = seen.length
    const target = workspaceGitRemoteTarget(READ_REMOTE, AGENT, scope)
    await expect(
      runner(join(root, 'checkout'), { ...workspaceGitEnvBase(READ_REMOTE), ...target.env }).raw([
        'push',
        target.remote,
        'HEAD:refs/heads/forbidden'
      ])
    ).rejects.toThrow()
    const unheld = 'https://dev.azure.com/example-org/project/_git/unheld'
    await expect(
      runner(root, { ...workspaceGitEnvBase(unheld), ...cloneGitEnv(AGENT, unheld, scope) }).raw(['ls-remote', unheld])
    ).rejects.toThrow()
    // Git's anonymous discovery may reach the upstream 401 challenge; the proxy never forwards an authenticated denial.
    expect(seen.slice(before).filter((request) => request.authorization !== undefined)).toEqual([])
    expect(() => local(join(root, 'repository.git'), ['show-ref', '--verify', 'refs/heads/forbidden'])).toThrow()
  })
})
