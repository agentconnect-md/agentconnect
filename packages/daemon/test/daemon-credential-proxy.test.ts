import { execFile, execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import type { AddressInfo, LookupFunction } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { generateCa } from '@anthropic-ai/sandbox-runtime'
import { createMitmCA } from '@anthropic-ai/sandbox-runtime/dist/sandbox/mitm-ca.js'
import { mintLeafCert } from '@anthropic-ai/sandbox-runtime/dist/sandbox/mitm-leaf.js'
import {
  GITCRED_PROVIDER_V2_FEATURE,
  type AgentSpec,
  type GitCredGrant,
  type GitCredRequest
} from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import { agentHostKey } from '../src/acp/host-key.js'
import { gitcredShimPath } from '../src/cp/gitcred-server.js'
import { CredentialProxy } from '../src/credential-proxy/proxy.js'
import { PROXY_TRUST_VARS } from '../src/credential-proxy/trust-bundle.js'
import { workspaceGitLocalEnv, writeRepoHelperConfig } from '../src/workspace/git-injection.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

// A host-strategy session of a real daemon with `features.credentialProxy`, as the daemon itself assembles and serves it.

const run = promisify(execFile)
const GITHUB_AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const GITLAB_AGENT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
// What the daemon's own helper answers, standing in for the real one, and what the fake control plane mints.
const HELPER_TOKEN = 'ghs_repo-helper-example'
const MINTED_GITHUB = 'ghs_minted-example'
const MINTED_GITLAB = 'glpat_minted-example'
const SHA = '1111111111111111111111111111111111111111'

const dirs: string[] = []
const daemons: Daemon[] = []
const closers: Array<() => Promise<void>> = []
const saved: Record<string, string | undefined> = {}
let machineHelperLog = ''
beforeAll(() => {
  // The session gitconfig includes $HOME/.gitconfig, and a proxy of the runner's own would keep the session direct.
  for (const name of ['HOME', 'HTTPS_PROXY', 'https_proxy']) saved[name] = process.env[name]
  delete process.env.HTTPS_PROXY
  delete process.env.https_proxy
  const home = shortDir()
  process.env.HOME = home
  // The machine's own credential helper, which records whatever git hands it.
  machineHelperLog = join(home, 'machine-helper.log')
  const helper = join(home, 'machine-helper.sh')
  writeFileSync(helper, `#!/bin/sh\necho "op=$1" >> '${machineHelperLog}'\ncat >> '${machineHelperLog}'\n`)
  chmodSync(helper, 0o755)
  writeFileSync(join(home, '.gitconfig'), `[credential]\n\thelper = !'${helper}'\n`)
})
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop().catch(() => undefined)
  for (const close of closers.splice(0)) await close()
})
afterAll(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  // Windows releases a stopped daemon's file handles a moment late, so removal retries there.
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

/** Short, so the daemon's sockets fit AF_UNIX on a host whose temp directory is long. */
function shortDir(): string {
  const dir = realpathSync(mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'acdp-')))
  dirs.push(dir)
  return dir
}

async function startDaemon(credentialProxy: boolean): Promise<{ d: any; root: string }> {
  const root = shortDir()
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: [] } },
      features: { credentialProxy }
    })
  )
  const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, probeRuntimes: async () => [] })
  daemons.push(daemon)
  await daemon.start()
  return { d: daemon as any, root }
}

const githubSpec = (): AgentSpec =>
  ({
    name: 'gh',
    runtime: 'claude',
    workspace: {
      mode: 'github',
      isolation: 'shared',
      gitRepo: 'https://github.com/example-org/example-repo',
      branch: 'main',
      gitCredential: 'github-app',
      additionalRepos: []
    }
  }) as unknown as AgentSpec

const gitlabSpec = (instance: string): AgentSpec =>
  ({
    name: 'gl',
    runtime: 'claude',
    gitlabHost: instance,
    workspace: {
      mode: 'gitlab',
      isolation: 'shared',
      gitRepo: `${instance}/group/project.git`,
      branch: 'main',
      projectId: '4455667',
      additionalRepos: []
    }
  }) as unknown as AgentSpec

/** Admit `spec` as the control plane would, and let its prefetch clone settle: with no control plane yet it fails before any network. */
async function admit(d: any, agentId: string, spec: AgentSpec): Promise<any> {
  expect(await d.cpConfigApply().applyAgentUpsert({ agentId, spec })).toEqual({ ok: true })
  const agent = d.agents.get(agentId)
  await d.enqueueAgentWorkspacePreparation(agent, async () => undefined)
  return agent
}

/** A control plane that mints every repository at `access`, echoing what a provider-qualified ask named. */
function fakeControlPlane(d: any, access: 'read' | 'write', gitlabHost?: string): GitCredRequest[] {
  const asked: GitCredRequest[] = []
  d.cpClient = {
    supportsServerFeature: (feature: string) => feature === GITCRED_PROVIDER_V2_FEATURE,
    requestGitCred: async (payload: GitCredRequest): Promise<GitCredGrant> => {
      asked.push(payload)
      const gitlab = payload.provider === 'gitlab'
      return {
        username: gitlab ? 'service-account' : 'x-access-token',
        token: gitlab ? MINTED_GITLAB : MINTED_GITHUB,
        ttlSec: 3600,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        repoFullName: payload.repoFullName ?? (gitlab ? 'group/project' : 'example-org/example-repo'),
        access: payload.requestedAccess === 'read' ? 'read' : access,
        ...(payload.provider !== undefined ? { provider: payload.provider } : {}),
        ...(payload.externalRepoId !== undefined ? { externalRepoId: payload.externalRepoId } : {}),
        ...(gitlab && gitlabHost !== undefined ? { host: gitlabHost } : {})
      }
    }
  }
  return asked
}

/** The env a host-strategy session of `agentId` is launched with, over the daemon's own environment as its child inherits it. */
function sessionEnv(d: any, agentId: string): { own: Record<string, string>; child: NodeJS.ProcessEnv } {
  const host = d.ensureHost(agentHostKey(agentId), d.cfg)
  expect(host.opts.inheritProcessEnv).toBe(true)
  const own = host.opts.env as Record<string, string>
  // No system config either, so the test never reaches a helper the machine running it has installed.
  return { own, child: { ...process.env, ...own, GIT_CONFIG_NOSYSTEM: '1' } }
}

/** Stand in for the daemon's real helper: whatever it answers is the real token. */
function stubRealHelper(root: string): void {
  const helper = gitcredShimPath(root)
  writeFileSync(
    helper,
    `#!/bin/sh\ntest "$2" = get || exit 0\necho username=x-access-token\necho password=${HELPER_TOKEN}\n`
  )
  chmodSync(helper, 0o755)
}

/** The agent's checkout as its clone leaves it: the repo-local helper the daemon pins after cloning. */
async function checkout(d: any, agent: any): Promise<string> {
  const path = agent.workspace.path as string
  await d.enqueueAgentWorkspacePreparation(agent, async () => {
    const local = { ...process.env, ...workspaceGitLocalEnv() }
    execFileSync('git', ['init', '-q', '-b', 'main', path], { env: local, stdio: 'pipe' })
    const identity = ['-c', 'user.name=example', '-c', 'user.email=example@example.test']
    execFileSync('git', [...identity, 'commit', '-q', '--allow-empty', '-m', 'init'], {
      cwd: path,
      env: local,
      stdio: 'pipe'
    })
    await writeRepoHelperConfig(d.workspaces.runnerFor(agent.id, path), agent.id, d.workspaces.managedScopeOf(agent))
  })
  return path
}

/** The password `git credential fill` hands for one URL in `cwd`, with `env`. */
function fill(cwd: string, env: NodeJS.ProcessEnv, host: string, path: string): string {
  const out = execFileSync('git', ['credential', 'fill'], {
    cwd,
    env,
    input: `protocol=https\nhost=${host}\npath=${path}\n\n`
  }).toString()
  return /^password=(.*)$/m.exec(out)?.[1] ?? ''
}

describe('a host session with the credential proxy on', () => {
  it('holds the placeholder, the loopback proxy and its trust bundle, and no token', async () => {
    const { d } = await startDaemon(true)
    expect(d.credentialProxy).toBeDefined()
    await admit(d, GITHUB_AGENT, githubSpec())
    const { own: env } = sessionEnv(d, GITHUB_AGENT)
    const placeholder = env.AC_CODEHOST_CREDENTIAL!
    expect(placeholder).toMatch(/^acph1_/)
    expect(env.GH_TOKEN).toBe(placeholder)
    const proxyUrl = new URL(env.HTTPS_PROXY!)
    expect(env.HTTPS_PROXY).toBe(d.credentialProxy.proxy.loopbackUrl())
    expect(proxyUrl.hostname).toBe('127.0.0.1')
    expect(proxyUrl.password).not.toBe('')
    expect(env.https_proxy).toBe(env.HTTPS_PROXY)
    expect(env.NO_PROXY!.split(',')).toEqual(expect.arrayContaining(['localhost', '127.0.0.1', '::1']))
    expect(env.no_proxy).toBe(env.NO_PROXY)
    expect(env.NODE_USE_ENV_PROXY).toBe('1')
    // The last command-scope pair empties the helpers for the proxy's own origin.
    const last = Number(env.GIT_CONFIG_COUNT) - 1
    expect([env[`GIT_CONFIG_KEY_${last}`], env[`GIT_CONFIG_VALUE_${last}`]]).toEqual([
      `credential.${proxyUrl.origin}.helper`,
      ''
    ])
    const bundle = env.SSL_CERT_FILE!
    for (const name of PROXY_TRUST_VARS) expect(env[name]).toBe(bundle)
    expect(readFileSync(bundle, 'utf8')).toContain(d.credentialProxy.ca.certPem.trim())
    expect(JSON.stringify(env)).not.toMatch(/ghs_|glpat/)
  })

  // POSIX only: the stand-in helper is a shell script.
  it.skipIf(process.platform === 'win32')(
    "hands git the placeholder in the agent's checkout, over the real helper its own config pins",
    async () => {
      const { d, root } = await startDaemon(true)
      stubRealHelper(root)
      const agent = await admit(d, GITHUB_AGENT, githubSpec())
      const cwd = await checkout(d, agent)
      const pinned = execFileSync('git', ['config', '--local', '--get-all', 'credential.https://github.com.helper'], {
        cwd,
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }
      })
      expect(pinned.toString()).toContain(gitcredShimPath(root))
      const { own, child } = sessionEnv(d, GITHUB_AGENT)
      expect(fill(cwd, child, 'github.com', 'example-org/example-repo.git')).toBe(own.AC_CODEHOST_CREDENTIAL)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'hands git the placeholder for a self-managed GitLab instance the spec names, and glab the same',
    async () => {
      const instance = 'https://gitlab.example.test:8443/gitlab'
      const { d, root } = await startDaemon(true)
      stubRealHelper(root)
      const agent = await admit(d, GITLAB_AGENT, gitlabSpec(instance))
      const cwd = await checkout(d, agent)
      const { own, child } = sessionEnv(d, GITLAB_AGENT)
      const placeholder = own.AC_CODEHOST_CREDENTIAL!
      expect(placeholder).toMatch(/^acph1_/)
      expect(own.GITLAB_TOKEN).toBe(placeholder)
      expect(own.GH_TOKEN).toBeUndefined()
      expect(own.HTTPS_PROXY).toBe(d.credentialProxy.proxy.loopbackUrl())
      expect(d.credentialProxy.proxy.domainsFor(GITLAB_AGENT)).toEqual(['gitlab.example.test'])
      expect(fill(cwd, child, 'gitlab.example.test:8443', 'gitlab/group/project.git')).toBe(placeholder)
      expect(JSON.stringify(own)).not.toMatch(/ghs_|glpat/)
    }
  )
})

describe('a host session with the credential proxy off', () => {
  it('keeps the helper path and no proxy', async () => {
    const { d, root } = await startDaemon(false)
    expect(d.credentialProxy).toBeUndefined()
    await admit(d, GITHUB_AGENT, githubSpec())
    const { own: env } = sessionEnv(d, GITHUB_AGENT)
    expect(env.AC_CODEHOST_CREDENTIAL).toBeUndefined()
    expect(env.HTTPS_PROXY).toBeUndefined()
    expect(env.https_proxy).toBeUndefined()
    expect(env.NODE_USE_ENV_PROXY).toBeUndefined()
    expect(env.GIT_CONFIG_COUNT).toBeUndefined()
    expect(readFileSync(env.GIT_CONFIG_GLOBAL!, 'utf8')).toContain(gitcredShimPath(root))
  })

  it.skipIf(process.platform === 'win32')('lets git in the checkout ask the real helper', async () => {
    const { d, root } = await startDaemon(false)
    stubRealHelper(root)
    const agent = await admit(d, GITHUB_AGENT, githubSpec())
    const cwd = await checkout(d, agent)
    const { child } = sessionEnv(d, GITHUB_AGENT)
    expect(fill(cwd, child, 'github.com', 'example-org/example-repo.git')).toBe(HELPER_TOKEN)
  })
})

/** Every code-host name resolves to the loopback upstream. */
const toLoopback: LookupFunction = (_host, options, callback) => {
  if (options.all)
    (callback as (e: null, a: { address: string; family: number }[]) => void)(null, [
      { address: '127.0.0.1', family: 4 }
    ])
  else callback(null, '127.0.0.1', 4)
}

interface Seen {
  url: string
  authorization?: string
}

/** An HTTPS code host for `hostname` behind `ca`: it asks for credentials as a git server does and serves one ref advertisement. */
async function fakeCodeHost(
  ca: { certPem: string; keyPem: string },
  hostname: string
): Promise<{ port: number; seen: Seen[] }> {
  const leaf = mintLeafCert(createMitmCA({ caCertPem: ca.certPem, caKeyPem: ca.keyPem }), hostname)
  const seen: Seen[] = []
  const pkt = (line: string) => `${(Buffer.byteLength(line) + 4).toString(16).padStart(4, '0')}${line}`
  const advertisement =
    `${pkt('# service=git-upload-pack\n')}0000` +
    `${pkt(`${SHA} HEAD\0symref=HEAD:refs/heads/main\n`)}${pkt(`${SHA} refs/heads/main\n`)}0000`
  const server: HttpsServer = createHttpsServer({ key: leaf.keyPem, cert: leaf.certPem }, (req, res) => {
    const url = req.url ?? ''
    seen.push({ url, ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) })
    if (!req.headers.authorization) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="example"' })
      return res.end()
    }
    if (url.endsWith('/info/refs?service=git-upload-pack')) {
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement', 'cache-control': 'no-cache' })
      return res.end(advertisement)
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return { port: (server.address() as AddressInfo).port, seen }
}

/** Restart the daemon's proxy on its own deps, with only its upstream leg pointed at the fake code host. */
async function routeUpstream(d: any, root: string, trustedCa: string): Promise<void> {
  const running = d.credentialProxy.proxy
  await running.stop()
  const proxy = new CredentialProxy({ ...running.deps, upstream: { lookupFor: () => toLoopback, trustedCa } })
  await proxy.start(join(root, 'run'))
  d.credentialProxy = { ...d.credentialProxy, proxy }
}

/** One HTTPS request from a Node child with `env`, as a session's tools make it: through its env proxy and trust. */
async function nodeRequest(
  env: NodeJS.ProcessEnv,
  url: string,
  authorization: string
): Promise<{ status: number; body: string }> {
  const script =
    'const [url, auth] = process.argv.slice(1); fetch(url, { headers: { authorization: auth } })' +
    '.then(async (r) => console.log(JSON.stringify({ status: r.status, body: await r.text() })))'
  const { stdout } = await run(process.execPath, ['-e', script, url, authorization], { env })
  return JSON.parse(stdout) as { status: number; body: string }
}

describe("the proxy's mint and its invalidate", () => {
  it.each([
    { provider: 'github', agentId: GITHUB_AGENT, spec: githubSpec },
    { provider: 'gitlab', agentId: GITLAB_AGENT, spec: () => gitlabSpec('https://gitlab.example.test/gitlab') }
  ])('drops exactly the $provider cache entry it minted, so the next request mints afresh', async (c) => {
    const { d } = await startDaemon(true)
    await admit(d, c.agentId, c.spec())
    const asked = fakeControlPlane(d, 'write', 'https://gitlab.example.test/gitlab')
    // Each control-plane mint is a token of its own, as a rotation would be.
    const request = d.cpClient.requestGitCred
    d.cpClient.requestGitCred = async (payload: GitCredRequest) => ({
      ...(await request(payload)),
      token: `token-${asked.length + 1}`
    })
    const ask = { provider: c.provider, plane: 'git', readOnly: false }
    const first = await d.credentialProxyMint(c.agentId, ask)
    expect((await d.credentialProxyMint(c.agentId, ask)).token).toBe(first.token)
    expect(asked).toHaveLength(1)
    first.invalidate()
    await new Promise((resolve) => setImmediate(resolve))
    const second = await d.credentialProxyMint(c.agentId, ask)
    expect(asked).toHaveLength(2)
    expect(second.token).not.toBe(first.token)
    // A late 401 for the old token leaves the fresh one in place.
    first.invalidate()
    await new Promise((resolve) => setImmediate(resolve))
    expect((await d.credentialProxyMint(c.agentId, ask)).token).toBe(second.token)
    expect(asked).toHaveLength(2)
  })
})

describe('a proxied host session end to end', () => {
  // POSIX only: the proxy's upstream leg and the placeholder helper are exercised as a POSIX session runs them.
  it.skipIf(process.platform === 'win32')(
    "reads GitHub with the minted token through the daemon's proxy, and refuses a push on a read grant",
    async () => {
      const upstreamCa = generateCa({ cn: 'example upstream CA' })
      const api = await fakeCodeHost(upstreamCa, 'api.github.com')
      const git = await fakeCodeHost(upstreamCa, 'github.com')
      const { d, root } = await startDaemon(true)
      await admit(d, GITHUB_AGENT, githubSpec())
      await routeUpstream(d, root, upstreamCa.certPem)
      const asked = fakeControlPlane(d, 'read')
      const { own, child } = sessionEnv(d, GITHUB_AGENT)
      const read = await nodeRequest(
        child,
        `https://api.github.com:${api.port}/repos/example-org/example-repo`,
        `token ${own.GH_TOKEN}`
      )
      expect(read.status).toBe(200)
      expect(api.seen).toEqual([{ url: '/repos/example-org/example-repo', authorization: `token ${MINTED_GITHUB}` }])
      const basic = `Basic ${Buffer.from(`x-access-token:${own.AC_CODEHOST_CREDENTIAL}`).toString('base64')}`
      const push = await nodeRequest(
        child,
        `https://github.com:${git.port}/example-org/example-repo.git/info/refs?service=git-receive-pack`,
        basic
      )
      expect(push.status).toBe(403)
      expect(push.body).toContain('pushing needs write access')
      expect(git.seen).toEqual([])
      expect(asked.map((ask) => ask.repoFullName)).toEqual(['example-org/example-repo', 'example-org/example-repo'])
    }
  )

  it.skipIf(process.platform === 'win32')(
    "runs git ls-remote on a self-managed GitLab through the daemon's proxy, and refuses a push on a read grant",
    async () => {
      const upstreamCa = generateCa({ cn: 'example private CA' })
      const gitlab = await fakeCodeHost(upstreamCa, 'gitlab.example.test')
      const instance = `https://gitlab.example.test:${gitlab.port}/gitlab`
      const { d, root } = await startDaemon(true)
      const agent = await admit(d, GITLAB_AGENT, gitlabSpec(instance))
      stubRealHelper(root)
      const cwd = await checkout(d, agent)
      await routeUpstream(d, root, upstreamCa.certPem)
      fakeControlPlane(d, 'read', instance)
      const { child } = sessionEnv(d, GITLAB_AGENT)
      const remote = `${instance}/group/project.git`
      const { stdout } = await run('git', ['ls-remote', remote], { cwd, env: child })
      expect(stdout).toContain(`${SHA}\trefs/heads/main`)
      const minted = `Basic ${Buffer.from(`service-account:${MINTED_GITLAB}`).toString('base64')}`
      expect(gitlab.seen.filter((entry) => entry.authorization)).toEqual([
        { url: '/gitlab/group/project.git/info/refs?service=git-upload-pack', authorization: minted }
      ])
      const pushed = await run('git', ['push', remote, 'HEAD:refs/heads/main'], { cwd, env: child }).then(
        () => undefined,
        (err: { stderr?: string }) => err.stderr ?? ''
      )
      expect(pushed).toContain('403')
      expect(gitlab.seen.filter((entry) => entry.url.includes('git-receive-pack') && entry.authorization)).toEqual([])
      expect(JSON.stringify(gitlab.seen)).not.toContain(HELPER_TOKEN)
      // The machine's own helper never kept the proxy's credential, nor any other.
      const kept = readFileSync(machineHelperLog, { encoding: 'utf8', flag: 'a+' })
      expect(kept).not.toContain(new URL(child.HTTPS_PROXY!).password)
      expect(kept).not.toContain('op=store')
    }
  )
})
