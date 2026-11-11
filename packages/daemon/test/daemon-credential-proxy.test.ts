import { execFile, execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { connect as netConnect, type AddressInfo, type LookupFunction } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { generateCa } from '@anthropic-ai/sandbox-runtime'
import { createMitmCA } from '@anthropic-ai/sandbox-runtime/dist/sandbox/mitm-ca.js'
import { mintLeafCert } from '@anthropic-ai/sandbox-runtime/dist/sandbox/mitm-leaf.js'
import {
  AZURE_DEVOPS_HOOKS_V1_FEATURE,
  AZURE_DEVOPS_V1_FEATURE,
  GITCRED_PROVIDER_V2_FEATURE,
  type AgentSpec,
  type GitCredGrant,
  type GitCredRequest
} from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import { agentHostKey, sessionKeyDirName } from '../src/acp/host-key.js'
import { secretsShimDir } from '../src/cp/secrets-shim.js'
import {
  AGENT_CHANNEL_AGENT_ENV,
  AGENT_CHANNEL_CAPABILITY_ENV,
  gitcredShimPath,
  agentChannelSocketPath,
  RUNTIME_NO_MINT_ERROR
} from '../src/cp/agent-channel-server.js'
import { agentChannelIpc } from '../src/agent-channel/ipc.js'
import { proxyOnlyRefusal } from '../src/cp/git-credential.js'
import { CLI_STATE_DIR } from '../src/credential-proxy/cli-env.js'
import { CredentialProxy } from '../src/credential-proxy/proxy.js'
import { PROXY_TRUST_VARS } from '../src/credential-proxy/trust-bundle.js'
import {
  checkoutHelper,
  cloneGitEnv,
  workspaceGitLocalEnv,
  writeRepoHelperConfig
} from '../src/workspace/git-injection.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

// A host-strategy session of a real daemon behind its credential proxy, as the daemon itself assembles and serves it.

const run = promisify(execFile)
const GITHUB_AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const GITLAB_AGENT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const AZURE_AGENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const GITEA_AGENT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
// What the daemon's own helper answers, standing in for the real one, and what the fake control plane mints.
// Where the daemon once wrote its gh and glab token wrappers, which no session's PATH names anymore.
const TOKEN_WRAPPER_DIR = (root: string) => join(root, 'run', 'bin')
const HELPER_TOKEN = 'ghs_repo-helper-example'
const MINTED_GITHUB = 'ghs_minted-example'
const MINTED_GITLAB = 'glpat_minted-example'
const MINTED_AZURE = 'azure-minted-example'
const MINTED_GITEA = 'gitea-minted-example'
// The identity an Azure DevOps connection signs in as, which its grants name as the user.
const AZURE_IDENTITY = '00000000-0000-4000-8000-0000000000a1'
const AZURE_REPO = 'https://dev.azure.com/example-org/Example%20Project/_git/Example%20Repo'
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
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (err) {
      // On Windows a child the daemon started can still hold the directory open; a leftover temp dir is not a test failure.
      if (process.platform !== 'win32') throw err
    }
  }
})

/** Short, so the daemon's sockets fit AF_UNIX on a host whose temp directory is long. */
function shortDir(): string {
  const dir = realpathSync(mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'acdp-')))
  dirs.push(dir)
  return dir
}

/** A daemon on a fresh root; `blockProxy` puts a file where the proxy keeps its key and CA, so it cannot start. */
async function startDaemon(blockProxy = false): Promise<{ d: any; root: string }> {
  const root = shortDir()
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: [] } }
    })
  )
  if (blockProxy) writeFileSync(join(root, 'credential-proxy'), 'not a directory')
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

const azureSpec = (): AgentSpec =>
  ({
    name: 'ado',
    runtime: 'claude',
    workspace: {
      mode: 'git',
      isolation: 'shared',
      gitRepo: AZURE_REPO,
      branch: 'main',
      credential: {
        provider: 'azure-devops',
        repoId: '42',
        connectionId: 'connection-1',
        azureDevOps: {
          organization: 'example-org',
          projectId: '00000000-0000-4000-8000-000000000001',
          repositoryId: '00000000-0000-4000-8000-000000000011'
        }
      },
      additionalRepos: []
    }
  }) as unknown as AgentSpec

const giteaSpec = (): AgentSpec =>
  ({
    name: 'gt',
    runtime: 'claude',
    workspace: {
      mode: 'git',
      isolation: 'shared',
      gitRepo: 'https://gitea.com/example-org/example-repo.git',
      branch: 'main',
      credential: { provider: 'gitea', repoId: '556677' },
      additionalRepos: [
        { provider: 'gitea', repoId: '889900', repoFullName: 'example-org/other-repo', access: 'write' }
      ]
    }
  }) as unknown as AgentSpec

/** Admit `spec` as the control plane would, and let its prefetch clone settle: with no control plane yet it fails before any network. */
async function admit(d: any, agentId: string, spec: AgentSpec): Promise<any> {
  expect(await d.cpConfigApply().applyAgentUpsert({ agentId, spec })).toEqual({ ok: true })
  const agent = d.agents.get(agentId)
  await d.enqueueAgentWorkspacePreparation(agent, async () => undefined)
  return agent
}

/** What the fake control plane mints on each provider, and the workspace repository a repo-less ask names. */
const MINTS: Record<string, { username: string; token: string; repo: string }> = {
  github: { username: 'x-access-token', token: MINTED_GITHUB, repo: 'example-org/example-repo' },
  gitlab: { username: 'service-account', token: MINTED_GITLAB, repo: 'group/project' },
  'azure-devops': { username: AZURE_IDENTITY, token: MINTED_AZURE, repo: 'example-org/Example Project/Example Repo' },
  gitea: { username: 'example-bot', token: MINTED_GITEA, repo: 'example-org/example-repo' }
}

/** A control plane that mints every repository at `access`, echoing what a provider-qualified ask named. */
function fakeControlPlane(d: any, access: 'read' | 'write', gitlabHost?: string): GitCredRequest[] {
  const asked: GitCredRequest[] = []
  d.cpClient = {
    supportsServerFeature: (feature: string) => feature === GITCRED_PROVIDER_V2_FEATURE,
    requestGitCred: async (payload: GitCredRequest): Promise<GitCredGrant> => {
      asked.push(payload)
      const gitlab = payload.provider === 'gitlab'
      const minted = MINTS[payload.provider ?? 'github']!
      return {
        username: minted.username,
        token: minted.token,
        ttlSec: 3600,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        repoFullName: payload.repoFullName ?? minted.repo,
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
    await writeRepoHelperConfig(d.workspaces.runnerFor(agent.id, path), d.workspaces.managedScopeOf(agent))
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
    const { d } = await startDaemon()
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
    "hands git the placeholder in the agent's checkout, whose own pin names no helper",
    async () => {
      const { d, root } = await startDaemon()
      stubRealHelper(root)
      const agent = await admit(d, GITHUB_AGENT, githubSpec())
      const cwd = await checkout(d, agent)
      const pinned = execFileSync('git', ['config', '--local', '--get-all', 'credential.https://github.com.helper'], {
        cwd,
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }
      })
      expect(pinned.toString()).toContain(checkoutHelper())
      expect(pinned.toString()).not.toContain(gitcredShimPath(root))
      const { own, child } = sessionEnv(d, GITHUB_AGENT)
      expect(fill(cwd, child, 'github.com', 'example-org/example-repo.git')).toBe(own.AC_CODEHOST_CREDENTIAL)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'hands git the placeholder for a self-managed GitLab instance the spec names, and glab the same',
    async () => {
      const instance = 'https://gitlab.example.test:8443/gitlab'
      const { d, root } = await startDaemon()
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
      // No glab wrapper to fetch a token: glab presents the placeholder itself, at the spec's instance.
      expect(own.GITLAB_HOST).toBe(instance)
      expect(own.PATH!.split(':')).not.toContain(TOKEN_WRAPPER_DIR(root))
      expect(own.PATH!.split(':')).toContain(secretsShimDir(root))
    }
  )

  // POSIX only: the stand-in helper is a shell script.
  it.skipIf(process.platform === 'win32')(
    'keeps every way to a real token out of the session, and leaves the daemon its own',
    async () => {
      const { d, root } = await startDaemon()
      stubRealHelper(root)
      const agent = await admit(d, GITHUB_AGENT, githubSpec())
      const cwd = await checkout(d, agent)
      const asked = fakeControlPlane(d, 'write')
      const { own, child } = sessionEnv(d, GITHUB_AGENT)
      // The checkout's own pin answers, so a child that drops every command-scope pair still presents the placeholder.
      const reset = { ...child, GIT_CONFIG_COUNT: '0' }
      expect(fill(cwd, reset, 'github.com', 'example-org/example-repo.git')).toBe(own.AC_CODEHOST_CREDENTIAL)
      // No gh wrapper; the secrets helper stays.
      const path = own.PATH!.split(':')
      expect(path).not.toContain(TOKEN_WRAPPER_DIR(root))
      expect(path).toContain(secretsShimDir(root))
      expect(readFileSync(join(secretsShimDir(root), 'agentconnect-secrets'), 'utf8')).toContain(' secrets')
      // The runtime's capability, as the session holds it, mints nothing on any plane and still reads secrets.
      const socket = agentChannelSocketPath(root)
      const presented = { agentId: own[AGENT_CHANNEL_AGENT_ENV], capability: own[AGENT_CHANNEL_CAPABILITY_ENV] }
      for (const plane of ['git', 'gh']) {
        expect(await agentChannelIpc(socket, { op: 'get', ...presented, plane })).toEqual({
          ok: false,
          error: RUNTIME_NO_MINT_ERROR,
          denied: 'agent'
        })
      }
      expect(await agentChannelIpc(socket, { op: 'secret', ...presented })).toEqual({ ok: true, secrets: [] })
      expect(asked).toEqual([])
      // The daemon's own git keeps minting with its own capability.
      const daemon = d.agentChannelServer.capabilityFor(GITHUB_AGENT, 'daemon')
      expect(daemon).not.toBe(presented.capability)
      expect(cloneGitEnv(GITHUB_AGENT)[AGENT_CHANNEL_CAPABILITY_ENV]).toBe(daemon)
      expect(await agentChannelIpc(socket, { op: 'get', agentId: GITHUB_AGENT, capability: daemon })).toMatchObject({
        ok: true,
        password: MINTED_GITHUB
      })
      expect(asked).toHaveLength(1)
    }
  )
})

describe('a host session on a daemon behind its own outbound proxy', () => {
  it('is proxied, its NO_PROXY keeping the daemon’s entries but the code host’s, and the proxy’s upstream goes via the parent', async () => {
    const names = ['HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy'] as const
    const before = Object.fromEntries(names.map((name) => [name, process.env[name]]))
    // Cleared before set: on Windows the environment is case-insensitive, so no_proxy and NO_PROXY are one variable.
    delete process.env.no_proxy
    process.env.HTTPS_PROXY = 'http://parent.example.test:3128'
    process.env.NO_PROXY = '.corp.example.test,gitlab.example.test'
    try {
      const { d } = await startDaemon()
      expect(d.credentialProxy.proxy.parentProxy?.httpsUrl?.host).toBe('parent.example.test:3128')
      await admit(d, GITLAB_AGENT, gitlabSpec('https://gitlab.example.test:8443/gitlab'))
      const { own } = sessionEnv(d, GITLAB_AGENT)
      expect(own.AC_CODEHOST_CREDENTIAL).toMatch(/^acph1_/)
      expect(own.HTTPS_PROXY).toBe(d.credentialProxy.proxy.loopbackUrl())
      expect(own.NO_PROXY!.split(',')).toEqual(['localhost', '127.0.0.1', '::1', '.corp.example.test'])
      expect(own.no_proxy).toBe(own.NO_PROXY)
      expect(JSON.stringify(own)).not.toMatch(/glpat/)
    } finally {
      for (const name of names) {
        if (before[name] === undefined) delete process.env[name]
        else process.env[name] = before[name]
      }
    }
  })
})

describe('a daemon whose credential proxy did not start', () => {
  // POSIX only: the stand-in helper is a shell script.
  it.skipIf(process.platform === 'win32')(
    'gives a session no code-host credential at all, and says why once',
    async () => {
      const { d, root } = await startDaemon(true)
      expect(d.credentialProxy).toBeUndefined()
      stubRealHelper(root)
      const agent = await admit(d, GITHUB_AGENT, githubSpec())
      const cwd = await checkout(d, agent)
      const warnings: string[] = []
      const warn = d.log.warn
      d.log = { ...d.log, warn: (message: string) => (warnings.push(message), warn(message)) }
      const { own, child } = sessionEnv(d, GITHUB_AGENT)
      expect(own.AC_CODEHOST_CREDENTIAL).toBeUndefined()
      expect(own.GH_TOKEN).toBeUndefined()
      expect(own.HTTPS_PROXY).toBeUndefined()
      expect(own.PATH!.split(':')).not.toContain(TOKEN_WRAPPER_DIR(root))
      expect(readFileSync(own.GIT_CONFIG_GLOBAL!, 'utf8')).not.toContain(gitcredShimPath(root))
      // Neither the session config nor the checkout's pin falls back to the real helper.
      expect(() =>
        fill(cwd, { ...child, GIT_TERMINAL_PROMPT: '0' }, 'github.com', 'example-org/example-repo.git')
      ).toThrow()
      fakeControlPlane(d, 'write')
      const presented = { agentId: own[AGENT_CHANNEL_AGENT_ENV], capability: own[AGENT_CHANNEL_CAPABILITY_ENV] }
      expect(await agentChannelIpc(agentChannelSocketPath(root), { op: 'get', ...presented })).toEqual({
        ok: false,
        error: RUNTIME_NO_MINT_ERROR,
        denied: 'agent'
      })
      expect(warnings.filter((message) => message.includes('has no code-host credential'))).toEqual([
        `credential proxy: a session of agent "${GITHUB_AGENT}" has no code-host credential: the credential proxy is not running`
      ])
    }
  )
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

/** Restart the daemon's proxy on its own deps, its upstream leg pointed at the fake code host: by name, or through `outbound` as the daemon's own proxy. */
async function routeUpstream(d: any, root: string, trustedCa: string, outbound?: string): Promise<void> {
  const running = d.credentialProxy.proxy
  await running.stop()
  // The proxy reads the daemon's outbound proxy from the environment as it is made.
  const names = ['HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy'] as const
  const before = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  for (const name of names) delete process.env[name]
  if (outbound) process.env.HTTPS_PROXY = outbound
  let proxy: CredentialProxy
  try {
    proxy = new CredentialProxy({ ...running.deps, upstream: { lookupFor: () => toLoopback, trustedCa } })
  } finally {
    for (const name of names) {
      if (before[name] === undefined) delete process.env[name]
      else process.env[name] = before[name]
    }
  }
  await proxy.start(join(root, 'run'))
  d.credentialProxy = { ...d.credentialProxy, proxy }
}

/** The daemon's outbound proxy, which reaches the fake code host at `port` for any name, as a corporate proxy resolves Azure DevOps's fixed host. */
async function outboundProxy(port: number): Promise<{ url: string; seen: string[] }> {
  const seen: string[] = []
  const tunnels = new Set<Duplex>()
  const server = createHttpServer()
  server.on('connect', (req, socket, head) => {
    seen.push(req.url ?? '')
    tunnels.add(socket)
    const out = netConnect(port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) out.write(head)
      out.pipe(socket)
      socket.pipe(out)
    })
    tunnels.add(out)
    out.on('error', () => socket.destroy())
    socket.on('error', () => out.destroy())
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  // First, so the fake code host's close finds no tunnel still holding a connection; a CONNECT tunnel is no HTTP connection.
  closers.unshift(async () => {
    for (const tunnel of tunnels) tunnel.destroy()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen }
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
    { provider: 'github', agentId: GITHUB_AGENT, spec: githubSpec, ask: {} },
    {
      provider: 'gitlab',
      agentId: GITLAB_AGENT,
      spec: () => gitlabSpec('https://gitlab.example.test/gitlab'),
      ask: { repo: 'group/project' }
    }
  ])('drops exactly the $provider cache entry it minted, so the next request mints afresh', async (c) => {
    const { d } = await startDaemon()
    await admit(d, c.agentId, c.spec())
    const asked = fakeControlPlane(d, 'write', 'https://gitlab.example.test/gitlab')
    // Each control-plane mint is a token of its own, as a rotation would be.
    const request = d.cpClient.requestGitCred
    d.cpClient.requestGitCred = async (payload: GitCredRequest) => ({
      ...(await request(payload)),
      token: `token-${asked.length + 1}`
    })
    const ask = { provider: c.provider, plane: 'git', readOnly: false, ...c.ask }
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

describe('a Gitea agent behind the credential proxy', () => {
  it('leases the repository a request names by path to the proxy alone, and nothing for one that names none', async () => {
    const { d } = await startDaemon()
    await admit(d, GITEA_AGENT, giteaSpec())
    const asked = fakeControlPlane(d, 'write')
    await expect(
      d.credentialProxyMint(GITEA_AGENT, { provider: 'gitea', plane: 'api', readOnly: true })
    ).rejects.toThrow(/not authorized for this agent/)
    const workspace = await d.credentialProxyMint(GITEA_AGENT, {
      provider: 'gitea',
      repo: 'example-org/example-repo',
      plane: 'api',
      readOnly: true
    })
    const named = await d.credentialProxyMint(GITEA_AGENT, {
      provider: 'gitea',
      repo: 'Example-Org/Other-Repo',
      plane: 'git',
      readOnly: false,
      push: true
    })
    expect([workspace.token, workspace.access, named.access]).toEqual([MINTED_GITEA, 'read', 'write'])
    expect(asked).toEqual([
      {
        agentId: GITEA_AGENT,
        reason: 'helper',
        provider: 'gitea',
        externalRepoId: '556677',
        consumer: 'proxy',
        requestedAccess: 'read'
      },
      {
        agentId: GITEA_AGENT,
        reason: 'helper',
        provider: 'gitea',
        externalRepoId: '889900',
        consumer: 'proxy',
        repoFullName: 'example-org/other-repo'
      }
    ])
    await expect(
      d.credentialProxyMint(GITEA_AGENT, {
        provider: 'gitea',
        repo: 'example-org/unlisted',
        plane: 'git',
        readOnly: false
      })
    ).rejects.toThrow(/example-org\/unlisted is not authorized for this agent/)
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
      const { d, root } = await startDaemon()
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
      const { d, root } = await startDaemon()
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

describe('an Azure DevOps agent behind the credential proxy', () => {
  // POSIX only: Git evaluates the session's shell credential helpers.
  it.skipIf(process.platform === 'win32')(
    'serves GitHub additional repositories beside an Azure workspace through the same runtime proxy',
    async () => {
      const { d } = await startDaemon()
      const spec = azureSpec()
      spec.workspace!.additionalRepos = [
        {
          provider: 'github',
          repoId: '43',
          repoFullName: 'example-org/additional-repo',
          materialize: 'on-demand'
        }
      ]
      const agent = await admit(d, AZURE_AGENT, spec)
      const cwd = await checkout(d, agent)
      const { own, child } = sessionEnv(d, AZURE_AGENT)
      const placeholder = own.AC_CODEHOST_CREDENTIAL!
      expect(placeholder).toMatch(/^acph1_/)
      expect(own.GH_TOKEN).toBe(placeholder)
      expect(own.AZURE_DEVOPS_EXT_PAT).toBe(placeholder)
      const gitEnv = { ...child, GIT_TERMINAL_PROMPT: '0' }
      expect(fill(cwd, gitEnv, 'github.com', 'example-org/additional-repo.git')).toBe(placeholder)
      expect(fill(cwd, gitEnv, 'dev.azure.com', 'example-org/Example Project/_git/Example Repo')).toBe(placeholder)
      expect(d.credentialProxy.proxy.tunnelRoutes(AZURE_AGENT)).toEqual([
        'dev.azure.com:443',
        'example-org.visualstudio.com:443',
        'github.com:443',
        'api.github.com:443',
        'uploads.github.com:443',
        'codeload.github.com:443'
      ])
    }
  )

  it('holds the placeholder for git and the Azure CLI, and the daemon advertises Azure DevOps', async () => {
    const { d } = await startDaemon()
    const extensions = shortDir()
    d.cfg.azureDevOps = { cliExtensionDir: extensions }
    const agent = await admit(d, AZURE_AGENT, azureSpec())
    expect(d.registrationFeatures()).toContain(AZURE_DEVOPS_V1_FEATURE)
    // Its hooks ride the same proxy, so the control plane and every relay hear both together (§11.9).
    expect(d.registrationFeatures()).toContain(AZURE_DEVOPS_HOOKS_V1_FEATURE)
    expect(d.azureDevOpsFeatures()).toEqual([AZURE_DEVOPS_V1_FEATURE, AZURE_DEVOPS_HOOKS_V1_FEATURE])
    const { own } = sessionEnv(d, AZURE_AGENT)
    const placeholder = own.AC_CODEHOST_CREDENTIAL!
    expect(placeholder).toMatch(/^acph1_/)
    expect(own.HTTPS_PROXY).toBe(d.credentialProxy.proxy.loopbackUrl())
    // The CLI presents the same placeholder, from an empty configuration of this host's own, with the operator's extensions.
    expect(own.AZURE_DEVOPS_EXT_PAT).toBe(placeholder)
    expect(own.AZURE_CONFIG_DIR!.startsWith(join(agent.dir, 'home', CLI_STATE_DIR))).toBe(true)
    expect(readdirSync(own.AZURE_CONFIG_DIR!)).toEqual([])
    expect(own.AZURE_EXTENSION_DIR).toBe(extensions)
    expect(own.AZURE_CORE_COLLECT_TELEMETRY).toBe('false')
    // Python's requests verifies with the merged bundle, as every other client does.
    expect(own.REQUESTS_CA_BUNDLE).toBe(own.SSL_CERT_FILE)
    expect(readFileSync(own.REQUESTS_CA_BUNDLE!, 'utf8')).toContain(d.credentialProxy.ca.certPem.trim())
    // Both of the organization's names are routed to the proxy and take the placeholder in the session's git.
    expect(d.credentialProxy.proxy.domainsFor(AZURE_AGENT)).toEqual(['dev.azure.com', 'example-org.visualstudio.com'])
    const config = readFileSync(own.GIT_CONFIG_GLOBAL!, 'utf8')
    expect(config).toContain('[credential "https://dev.azure.com"]')
    expect(config).toContain('[credential "https://example-org.visualstudio.com"]')
    expect(JSON.stringify(own)).not.toContain(MINTED_AZURE)
    // Pool members advertise the provider too; each operation and launch checks its bound environment's route.
    d.k8s = true
    expect(d.azureDevOpsFeatures()).toEqual([AZURE_DEVOPS_V1_FEATURE, AZURE_DEVOPS_HOOKS_V1_FEATURE])
    expect(() => d.assertProxyOnlyReach(agent, false)).not.toThrow()
    d.k8s = false
  })

  it('is refused a host before any preparation where the proxy did not start, which advertises no Azure DevOps', async () => {
    const { d } = await startDaemon(true)
    expect(d.credentialProxy).toBeUndefined()
    await admit(d, AZURE_AGENT, azureSpec())
    expect(d.registrationFeatures()).not.toContain(AZURE_DEVOPS_V1_FEATURE)
    expect(d.registrationFeatures()).not.toContain(AZURE_DEVOPS_HOOKS_V1_FEATURE)
    expect(d.azureDevOpsFeatures()).toEqual([])
    const refusal = /^azure_devops_requires_proxy: .* the credential proxy is not running on this daemon$/
    expect(() => d.ensureHost(agentHostKey(AZURE_AGENT), d.cfg)).toThrow(refusal)
    const prepared = vi.spyOn(d, 'prepareAgentWorkspace')
    await expect(d.ensureHostAsync(agentHostKey(AZURE_AGENT))).rejects.toThrow(refusal)
    expect(prepared).not.toHaveBeenCalled()
  })

  // POSIX only: srt confines nothing on Windows.
  it.skipIf(process.platform === 'win32')(
    "hands the daemon's own Git in a confined srt session the placeholder, and neither the real helper nor its capability",
    async () => {
      const { d } = await startDaemon()
      // After the startup sweep, which retires a session directory the store has no row for.
      await vi.waitFor(() => expect(d.sessionRetentionSweepInFlight).toBe(false))
      const agent = await admit(d, AZURE_AGENT, azureSpec())
      agent.execution = 'srt'
      const clone = join(agent.dir, 'sessions', sessionKeyDirName('example-session'), 'workspace')
      mkdirSync(clone, { recursive: true })
      const seen: { env?: Record<string, string> }[] = []
      d.localSrtExecutor = {
        withEnvironment: (_environment: unknown, work: (session: unknown) => Promise<unknown>) =>
          work({
            request: async (_capability: string, payload: { env?: Record<string, string> }) => {
              seen.push(payload)
              return { code: 0, stdout: '', stderr: '' }
            }
          })
      }
      const scope = d.workspaces.managedScopeOf(agent)
      const env = cloneGitEnv(AZURE_AGENT, AZURE_REPO, scope, clone)
      expect(env[AGENT_CHANNEL_CAPABILITY_ENV]).toBeDefined()
      await d.workspaces.runnerFor(AZURE_AGENT, clone).withEnv(env).raw(['ls-remote', AZURE_REPO])
      const sent = seen.at(-1)!.env!
      expect(sent.AC_CODEHOST_CREDENTIAL).toBe(d.credentialProxy.proxy.placeholderFor(AZURE_AGENT))
      expect(sent).not.toHaveProperty(AGENT_CHANNEL_CAPABILITY_ENV)
      const helpers = Object.entries(sent)
        .filter(([name, value]) => name.startsWith('GIT_CONFIG_KEY_') && value === `credential.${AZURE_REPO}.helper`)
        .map(([name]) => sent[name.replace('KEY', 'VALUE')])
      expect(helpers).toEqual(['', checkoutHelper()])
      // It crosses the proxy, so it trusts the proxy's authority.
      expect(sent.GIT_SSL_CAINFO).toBe(d.credentialProxy.ca.bundlePath)
    }
  )

  // POSIX only: the proxy's upstream leg and the placeholder helper are exercised as a POSIX session runs them.
  it.skipIf(process.platform === 'win32')(
    "runs git ls-remote through the daemon's proxy, and refuses a push on a read grant, an unauthorized repository and the runtime's own ask",
    async () => {
      const upstreamCa = generateCa({ cn: 'example upstream CA' })
      const azure = await fakeCodeHost(upstreamCa, 'dev.azure.com')
      const outbound = await outboundProxy(azure.port)
      const { d, root } = await startDaemon()
      const agent = await admit(d, AZURE_AGENT, azureSpec())
      stubRealHelper(root)
      const cwd = await checkout(d, agent)
      await routeUpstream(d, root, upstreamCa.certPem, outbound.url)
      const asked = fakeControlPlane(d, 'read')
      const { own, child } = sessionEnv(d, AZURE_AGENT)
      const { stdout } = await run('git', ['ls-remote', AZURE_REPO], { cwd, env: child })
      expect(stdout).toContain(`${SHA}\trefs/heads/main`)
      const minted = `Basic ${Buffer.from(`${AZURE_IDENTITY}:${MINTED_AZURE}`).toString('base64')}`
      expect(azure.seen.filter((entry) => entry.authorization)).toEqual([
        {
          url: '/example-org/Example%20Project/_git/Example%20Repo/info/refs?service=git-upload-pack',
          authorization: minted
        }
      ])
      // Azure DevOps's fixed host was reached through the daemon's own outbound proxy.
      expect(outbound.seen.length).toBeGreaterThan(0)
      expect(outbound.seen.every((target) => target === 'dev.azure.com:443')).toBe(true)
      const pushed = await run('git', ['push', AZURE_REPO, 'HEAD:refs/heads/main'], { cwd, env: child }).then(
        () => undefined,
        (err: { stderr?: string }) => err.stderr ?? ''
      )
      expect(pushed).toContain('403')
      expect(azure.seen.filter((entry) => entry.url.includes('git-receive-pack') && entry.authorization)).toEqual([])
      // A repository outside the authorizations is answered as missing, and never forwarded.
      const cli = `Basic ${Buffer.from(`:${own.AZURE_DEVOPS_EXT_PAT}`).toString('base64')}`
      const hidden = await nodeRequest(
        child,
        'https://dev.azure.com/example-org/Example%20Project/_apis/git/repositories/Hidden%20Repo?api-version=7.1',
        cli
      )
      expect(hidden.status).toBe(404)
      expect(hidden.body).toContain('TF401019')
      expect(azure.seen.some((entry) => entry.url.includes('Hidden'))).toBe(false)
      // Every lease was the proxy's: a read one for the fetch, the agent's tier for the push.
      const leases = asked.map(({ provider, externalRepoId, consumer, requestedAccess }) => ({
        provider,
        externalRepoId,
        consumer,
        requestedAccess
      }))
      expect(leases).toEqual([
        { provider: 'azure-devops', externalRepoId: '42', consumer: 'proxy', requestedAccess: 'read' },
        { provider: 'azure-devops', externalRepoId: '42', consumer: 'proxy' }
      ])
      // The runtime's capability, as the session holds it, is refused an Azure DevOps credential outright.
      const presented = { agentId: own[AGENT_CHANNEL_AGENT_ENV], capability: own[AGENT_CHANNEL_CAPABILITY_ENV] }
      const refusal = { ok: false, error: proxyOnlyRefusal('azure-devops'), denied: 'agent' }
      expect(await agentChannelIpc(agentChannelSocketPath(root), { op: 'get', ...presented })).toEqual(refusal)
      expect(
        await agentChannelIpc(agentChannelSocketPath(root), {
          op: 'get',
          ...presented,
          provider: 'azure-devops',
          repoFullName: 'example-org/example project/example repo'
        })
      ).toEqual(refusal)
      expect(asked).toHaveLength(2)
      expect(JSON.stringify(azure.seen)).not.toContain(HELPER_TOKEN)
      // The machine's own helper never kept the placeholder, nor any other credential.
      const kept = readFileSync(machineHelperLog, { encoding: 'utf8', flag: 'a+' })
      expect(kept).not.toContain(own.AC_CODEHOST_CREDENTIAL!)
      expect(kept).not.toContain('op=store')
    }
  )
})
