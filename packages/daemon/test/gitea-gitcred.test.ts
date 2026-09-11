/**
 * Gitea credentials, daemon side (gitea-integration.md §4.2, §9): the managed-host entry off the
 * spec, the `owner/repo` grammar measured from a path-prefixed instance root, the grant echo the
 * consumer verifies field by field, the credential blocks injection pins, the id-keyed placement of
 * an additional repository, and the spec-admission origin refusal. gitea.com is the default value of
 * the axis, so every case also pins that nothing changes for a deployment that names no host.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import {
  DEFAULT_WORKSPACE_GIT_ALLOWED_ORIGINS,
  GITEA_DEFAULT_BASE_URL,
  GITEA_V1_FEATURE,
  type AgentSpec,
  type GitCredGrant
} from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import { WorkspaceManager } from '../src/workspace/workspace-manager.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import {
  encodeManagedHostTable,
  giteaManagedHost,
  GITCRED_HOSTS_ENV,
  managedHostTableFor,
  matchManagedHost
} from '../src/gitcred/managed-hosts.js'
import { runGitCredential } from '../src/gitcred/helper.js'
import { credentialRepoPathParser } from '../src/gitcred/repo-path.js'
import { GITCRED_CAPABILITY_ENV } from '../src/gitcred/env.js'
import { GitCredentialCache, GitCredUnavailableError, type GitCredentialCacheDeps } from '../src/cp/git-credential.js'
import { giteaCredentials } from '../src/gitea/credentials.js'
import { codeHostCredentials, credentialProviderOf, managedHostTable } from '../src/codehost/credentials.js'
import {
  canonicalWorkspaceGitUrl,
  daemonGitCredentialTarget,
  gitCredentialEnv,
  initGitInjection,
  managedCredentialScope,
  sessionGitConfig
} from '../src/workspace/git-injection.js'
import { configureWorkspaceGitOrigins, unauthorizedWorkspaceGitOrigin } from '../src/workspace/git-origin-policy.js'

// A prefixed, non-default-port install: the shape a relative URL root produces.
const INSTANCE = 'https://gitea.example.test:8443/gitea'
const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const HOOK = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const REPO_ID = '556677'

describe('the managed-host entry and the helper grammar (§9)', () => {
  it('resolves the instance off the spec, defaulting to gitea.com, prefix preserved', () => {
    expect(giteaCredentials.managedHost({})).toEqual({ provider: 'gitea', baseUrl: GITEA_DEFAULT_BASE_URL })
    expect(giteaCredentials.managedHost({ giteaHost: `${INSTANCE}/` })).toEqual({
      provider: 'gitea',
      baseUrl: INSTANCE
    })
    expect(managedHostTable({ giteaHost: INSTANCE }).find((entry) => entry.provider === 'gitea')?.baseUrl).toBe(
      INSTANCE
    )
    expect(credentialProviderOf('gitea')).toBe('gitea')
    expect(codeHostCredentials('gitea')?.liveCredentialPurposes).toEqual(['gitea_hook_reply', 'gitea_effect'])
  })

  it('parses owner/repo from the path git sends under useHttpPath, prefix stripped on a segment boundary', () => {
    const table = managedHostTableFor(undefined, INSTANCE)
    const match = matchManagedHost(table, {
      protocol: 'https',
      host: 'gitea.example.test:8443',
      path: 'gitea/example-org/example-repo.git/info/lfs'
    })
    expect(match?.entry.provider).toBe('gitea')
    expect(match?.path).toBe('example-org/example-repo.git/info/lfs')
    const parse = credentialRepoPathParser('gitea')!
    expect(parse(match!.path!)).toBe('example-org/example-repo')
    expect(parse('/Example-Org/Example-Repo')).toBe('example-org/example-repo')
    expect(parse('just-a-name')).toBeUndefined()
    // A neighbouring path root on the same host is not this instance.
    expect(
      matchManagedHost(table, { protocol: 'https', host: 'gitea.example.test:8443', path: 'giteaX/o/r.git' })
    ).toBeUndefined()
  })

  it('keeps a Gitea remote byte-identical: the suffix-less address is served without a redirect', () => {
    expect(canonicalWorkspaceGitUrl('https://gitea.com/example-org/example-repo', 'gitea')).toBe(
      'https://gitea.com/example-org/example-repo'
    )
    expect(canonicalWorkspaceGitUrl(`${INSTANCE}/example-org/example-repo.git`, 'gitea')).toBe(
      `${INSTANCE}/example-org/example-repo.git`
    )
  })
})

describe('the credential helper on a prefixed instance (§9)', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'ac-gitea-helper-'))
  initGitInjection({
    targetFor: () => daemonGitCredentialTarget({ shimPath: join(runDir, 'helper.sh'), runDir }),
    preWarm: async () => undefined,
    capabilityFor: () => 'cap-test'
  })
  afterAll(() => rmSync(runDir, { recursive: true, force: true }))

  /** A one-shot gitcred socket that records the request and answers a fixed grant. */
  async function socket(reply: Record<string, unknown>): Promise<{
    path: string
    requests: Record<string, unknown>[]
    close: () => void
  }> {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-gitea-sock-')), 's')
    const requests: Record<string, unknown>[] = []
    const server = createServer((conn) => {
      let buf = ''
      conn.on('data', (chunk) => {
        buf += chunk.toString('utf8')
        const nl = buf.indexOf('\n')
        if (nl === -1) return
        requests.push(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>)
        conn.end(JSON.stringify(reply) + '\n')
      })
    })
    await new Promise<void>((resolve) => server.listen(path, resolve))
    return { path, requests, close: () => server.close() }
  }

  /** Run the real helper against `stdin`, with the table injected exactly as the daemon writes it. */
  async function helper(
    stdin: string,
    socketPath: string,
    table: string | undefined
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const input = new PassThrough()
    input.end(stdin)
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin')!
    Object.defineProperty(process, 'stdin', { value: input, configurable: true })
    const out: string[] = []
    const err: string[] = []
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out.push(String(chunk))
      return true
    })
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      err.push(String(chunk))
      return true
    })
    const previous = process.env[GITCRED_HOSTS_ENV]
    const previousCapability = process.env[GITCRED_CAPABILITY_ENV]
    if (table === undefined) delete process.env[GITCRED_HOSTS_ENV]
    else process.env[GITCRED_HOSTS_ENV] = table
    process.env[GITCRED_CAPABILITY_ENV] = 'cap-test'
    let exitCode = 0
    try {
      await runGitCredential('get', AGENT, socketPath)
      exitCode = typeof process.exitCode === 'number' ? process.exitCode : 0
    } finally {
      Object.defineProperty(process, 'stdin', stdinDescriptor)
      stdout.mockRestore()
      stderr.mockRestore()
      if (previous === undefined) delete process.env[GITCRED_HOSTS_ENV]
      else process.env[GITCRED_HOSTS_ENV] = previous
      if (previousCapability === undefined) delete process.env[GITCRED_CAPABILITY_ENV]
      else process.env[GITCRED_CAPABILITY_ENV] = previousCapability
      process.exitCode = 0
    }
    return { stdout: out.join(''), stderr: err.join(''), exitCode }
  }

  const table = encodeManagedHostTable(managedHostTableFor(undefined, INSTANCE))

  it('routes a prefixed request to the gitea provider on the repository path minus the prefix', async () => {
    const server = await socket({
      ok: true,
      username: 'example-bot',
      password: 'gitea-token',
      repoFullName: 'example-org/example-repo'
    })
    try {
      const { stdout } = await helper(
        'protocol=https\nhost=gitea.example.test:8443\npath=gitea/example-org/example-repo.git\n',
        server.path,
        table
      )
      expect(server.requests).toEqual([
        {
          op: 'get',
          agentId: AGENT,
          capability: 'cap-test',
          repoFullName: 'example-org/example-repo',
          provider: 'gitea'
        }
      ])
      // The token is the HTTPS password with the bot username — never in argv, a remote URL, or the env.
      expect(stdout).toBe('username=example-bot\npassword=gitea-token\n')
    } finally {
      server.close()
    }
  })

  it('routes gitea.com when the axis is unset, and stays silent for a near-miss host', async () => {
    const server = await socket({ ok: true, username: 'example-bot', password: 'gitea-token' })
    try {
      await helper('protocol=https\nhost=gitea.com\npath=example-org/example-repo\n', server.path, undefined)
      expect(server.requests).toEqual([
        {
          op: 'get',
          agentId: AGENT,
          capability: 'cap-test',
          repoFullName: 'example-org/example-repo',
          provider: 'gitea'
        }
      ])
      const near = await helper(
        'protocol=https\nhost=evil.gitea.example.test:8443\npath=gitea/example-org/example-repo.git\n',
        server.path,
        table
      )
      expect(server.requests).toHaveLength(1)
      expect(near.stdout).toBe('')
      expect(near.stderr).toBe('')
    } finally {
      server.close()
    }
  })

  it('pins the git-config block and the injected table to the resolved instance', () => {
    const target = daemonGitCredentialTarget({ shimPath: join(runDir, 'helper.sh'), runDir })
    const scope = managedCredentialScope('gitea', undefined, false, { host: INSTANCE })
    expect(scope).toEqual({ host: giteaManagedHost(INSTANCE), giteaHost: INSTANCE, giteaRepoBearing: true })
    const config = sessionGitConfig(AGENT, undefined, target, scope)
    // Inherited helpers are reset for the Gitea origin before the daemon helper is installed with useHttpPath.
    expect(config.content).toContain(`[credential "${INSTANCE}"]\n\thelper = \n\thelper = !'`)
    expect(config.content).toContain('useHttpPath = true')
    expect(config.content).not.toContain('github.com')
    expect(config.env[GITCRED_HOSTS_ENV]).toBe(table)
    // A github workspace on the same deployment still carries the instance in its table.
    expect(
      gitCredentialEnv(AGENT, target, managedCredentialScope('github', undefined, false, { host: INSTANCE }))[
        GITCRED_HOSTS_ENV
      ]
    ).toBe(table)
  })

  describe('the second credential block for a repo-bearing consumer', () => {
    const workspaces = new WorkspaceManager()
    const target = daemonGitCredentialTarget({ shimPath: join(runDir, 'helper.sh'), runDir })
    const agentWith = (workspace: Record<string, unknown>) =>
      ({
        id: AGENT,
        giteaHost: INSTANCE,
        workspace: { gitBranch: 'main', path: '/tmp/ws', additionalRepos: [], ...workspace }
      }) as unknown as Parameters<WorkspaceManager['managedScopeOf']>[0]
    const githubWorkspace = { mode: 'git-repo', gitRepo: 'https://github.com/acme/infra', gitCredential: 'github-app' }
    const giteaRepoRow = { repoFullName: 'example-org/example-repo', repoId: REPO_ID, provider: 'gitea' }
    const configFor = (workspace: Record<string, unknown>) =>
      sessionGitConfig(AGENT, undefined, target, workspaces.managedScopeOf(agentWith(workspace))).content

    it('pins both hosts for a github workspace holding a gitea additional-repository grant', () => {
      const content = configFor({ ...githubWorkspace, additionalRepos: [giteaRepoRow] })
      expect(content).toContain('[credential "https://github.com"]')
      expect(content).toContain(`[credential "${INSTANCE}"]`)
      expect(content.match(/\thelper = $/gm)).toHaveLength(2)
      expect(content.match(/\tuseHttpPath = true/g)).toHaveLength(2)
      expect(workspaces.repoBearing(agentWith({ ...githubWorkspace, additionalRepos: [giteaRepoRow] }), 'gitea')).toBe(
        true
      )
    })

    it('leaves a HOOK-ONLY agent unpinned, so its ambient gitea credentials still answer', () => {
      const content = configFor(githubWorkspace)
      expect(content).toContain('[credential "https://github.com"]')
      expect(content).not.toContain(INSTANCE)
      expect(workspaces.repoBearing(agentWith(githubWorkspace), 'gitea')).toBe(false)
    })

    it('pins exactly one block for a gitea workspace, and places its grants under _gitea/<id>', () => {
      const content = configFor({
        mode: 'git-repo',
        gitRepo: `${INSTANCE}/example-org/example-repo`,
        gitCredential: 'gitea'
      })
      expect(content.match(/\[credential /g)).toHaveLength(1)
      expect(content).toContain(`[credential "${INSTANCE}"]`)
      expect(giteaCredentials.placeSecondaryRoot(giteaRepoRow)).toEqual({
        provider: 'gitea',
        repoFullName: 'example-org/example-repo',
        subtreeName: `_gitea/${REPO_ID}`
      })
      // A row whose text is not two plain segments, or whose id is not numeric, is not placeable.
      expect(giteaCredentials.placeSecondaryRoot({ repoFullName: 'a/b/c', repoId: REPO_ID })).toBeUndefined()
      expect(giteaCredentials.placeSecondaryRoot({ repoFullName: 'a/b', repoId: 'x' })).toBeUndefined()
      expect(giteaCredentials.secondaryCloneUrl('example-org/example-repo', { giteaHost: INSTANCE })).toBe(
        `${INSTANCE}/example-org/example-repo`
      )
      expect(giteaCredentials.workspaceRepoId({ giteaRepoId: REPO_ID })).toBe(REPO_ID)
    })
  })
})

describe('the grant echo (§9)', () => {
  function cache(grant: Partial<GitCredGrant>, opts: { giteaHost?: string; gitea?: boolean } = {}) {
    const request = vi.fn(
      async (_payload: Parameters<GitCredentialCacheDeps['request']>[0]) =>
        ({
          username: 'example-bot',
          token: 'gitea-token',
          ttlSec: 3600,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          repoFullName: 'example-org/example-repo',
          access: 'write',
          provider: 'gitea',
          externalRepoId: REPO_ID,
          credentialEpoch: '2',
          ...grant
        }) as GitCredGrant
    )
    const instance = new GitCredentialCache({
      request,
      log: { warn: () => undefined },
      providerV2Supported: () => true,
      giteaSupported: () => opts.gitea !== false,
      giteaHostFor: () => opts.giteaHost
    })
    return { instance, request }
  }

  const ask = (instance: GitCredentialCache) =>
    instance.get(AGENT, 'clone', { provider: 'gitea', externalRepoId: REPO_ID })

  it('accepts the instance the spec names and keeps every echoed field', async () => {
    await expect(ask(cache({ host: INSTANCE }, { giteaHost: INSTANCE }).instance)).resolves.toMatchObject({
      username: 'example-bot',
      token: 'gitea-token',
      repoFullName: 'example-org/example-repo',
      access: 'write',
      credentialEpoch: '2'
    })
  })

  it('refuses a grant echoing another instance, provider, or repository', async () => {
    await expect(ask(cache({ host: 'https://gitea.other.test' }, { giteaHost: INSTANCE }).instance)).rejects.toThrow(
      /gitea instance https:\/\/gitea\.other\.test for an agent bound to https:\/\/gitea\.example\.test:8443\/gitea/
    )
    await expect(ask(cache({ provider: 'gitlab' }).instance)).rejects.toThrow(/provider gitlab for a gitea request/)
    await expect(ask(cache({ externalRepoId: '999' }).instance)).rejects.toThrow(/project 999 for project 556677/)
  })

  it('reads an absent host on either side as gitea.com', async () => {
    await expect(ask(cache({}).instance)).resolves.toMatchObject({ token: 'gitea-token' })
    await expect(ask(cache({}, { giteaHost: INSTANCE }).instance)).rejects.toThrow(
      /gitea instance https:\/\/gitea\.com/
    )
    await expect(ask(cache({ host: GITEA_DEFAULT_BASE_URL }).instance)).resolves.toMatchObject({ token: 'gitea-token' })
  })

  it('names the gitea purposes only once the control plane advertises gitea-v1, each lease in its own keyspace', async () => {
    const gated = cache({}, { gitea: false })
    await expect(gated.instance.getGiteaPostToken(AGENT, REPO_ID, HOOK)).rejects.toBeInstanceOf(GitCredUnavailableError)
    await expect(gated.instance.getGiteaEffectToken(AGENT, REPO_ID)).rejects.toThrow(/does not support Gitea leases/)
    expect(gated.request).not.toHaveBeenCalled()

    const { instance, request } = cache({ access: 'comment' })
    const post = await instance.getGiteaPostToken(AGENT, REPO_ID, HOOK)
    const effect = await instance.getGiteaEffectToken(AGENT, REPO_ID, HOOK)
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      provider: 'gitea',
      externalRepoId: REPO_ID,
      purpose: 'gitea_hook_reply',
      hookId: HOOK
    })
    expect(request.mock.calls[1]?.[0]).toMatchObject({ purpose: 'gitea_effect', hookId: HOOK })
    expect(effect.access).toBe('comment')
    // Invalidating one lease leaves the other cached.
    instance.invalidateGiteaEffect(AGENT, REPO_ID, effect.token)
    await instance.getGiteaEffectToken(AGENT, REPO_ID, HOOK)
    expect(request).toHaveBeenCalledTimes(3)
    expect(request.mock.calls[2]?.[0]).toMatchObject({ forceRefresh: true })
    expect(await instance.getGiteaPostToken(AGENT, REPO_ID, HOOK)).toBe(post)
    expect(request).toHaveBeenCalledTimes(3)
    // A refused lease is never cached as durable: the next turn asks again (§14.1 twin).
    const refused = new GitCredentialCache({
      request: vi.fn(async () => {
        throw Object.assign(new Error('hook disabled'), { code: 'SCOPE_DENIED' })
      }),
      log: { warn: () => undefined },
      providerV2Supported: () => true,
      giteaSupported: () => true
    })
    await expect(refused.getGiteaPostToken(AGENT, REPO_ID, HOOK)).rejects.toMatchObject({ terminal: false })
  })
})

/** A daemon whose only interesting configuration is the operator's origin policy. */
async function daemonWithOrigins(origins: string[]): Promise<{ daemon: Daemon; root: string }> {
  const root = mkdtempSync(join(tmpdir(), 'ac-gitea-admission-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: [] } },
      security: { workspaceGitAllowedOrigins: origins }
    })
  )
  const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root })
  await daemon.start()
  return { daemon, root }
}

describe('spec-admission origin refusal (§12)', () => {
  afterAll(() => configureWorkspaceGitOrigins([...DEFAULT_WORKSPACE_GIT_ALLOWED_ORIGINS]))

  const giteaSpec = (gitRepo: string, giteaHost?: string) =>
    ({
      name: 'gt',
      ...(giteaHost !== undefined ? { giteaHost } : {}),
      workspace: {
        mode: 'git',
        isolation: 'shared',
        gitRepo,
        branch: 'main',
        credential: { provider: 'gitea', repoId: REPO_ID },
        additionalRepos: []
      }
    }) as unknown as AgentSpec

  it('admits a gitea credential on the deployment instance, and refuses one off it by name', async () => {
    const { daemon, root } = await daemonWithOrigins(['https://github.com'])
    try {
      const apply = (daemon as any).cpConfigApply()
      const admitted = await apply.applyAgentUpsert({
        agentId: AGENT,
        spec: giteaSpec(`${INSTANCE}/example-org/example-repo.git`, INSTANCE)
      })
      expect(admitted).toEqual({ ok: true })
      const agent = (daemon as any).agents.get(AGENT)
      expect(agent.giteaHost).toBe(INSTANCE)
      expect(agent.workspace).toMatchObject({ gitCredential: 'gitea', giteaRepoId: REPO_ID })
      expect((daemon as any).workspaces.gitRepoOf(agent)).toBe(`${INSTANCE}/example-org/example-repo.git`)
      expect((daemon as any).managedWorkspaceRepo(AGENT)).toEqual({
        provider: 'gitea',
        repoId: REPO_ID,
        repoPath: 'example-org/example-repo'
      })
      // The instance is only ever adopted from the spec: an off-instance origin names itself on the ack.
      const refused = await apply.applyAgentUpsert({
        agentId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        spec: giteaSpec('https://gitea.other.test/o/r.git', INSTANCE)
      })
      expect(refused).toMatchObject({ ok: false, reason: expect.stringContaining('https://gitea.other.test') })
      expect(unauthorizedWorkspaceGitOrigin('https://gitea.com/o/r.git')).toBe('https://gitea.com')
      expect(unauthorizedWorkspaceGitOrigin('https://gitea.com/o/r.git', GITEA_DEFAULT_BASE_URL)).toBeUndefined()
    } finally {
      await daemon.stop()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('clears a stale gitea axis when the next spec names none', async () => {
    const { daemon, root } = await daemonWithOrigins([...DEFAULT_WORKSPACE_GIT_ALLOWED_ORIGINS])
    try {
      const apply = (daemon as any).cpConfigApply()
      await apply.applyAgentUpsert({ agentId: AGENT, spec: giteaSpec(`${INSTANCE}/o/r.git`, INSTANCE) })
      await apply.applyAgentUpsert({ agentId: AGENT, spec: giteaSpec('https://gitea.com/o/r.git') })
      const agent = (daemon as any).agents.get(AGENT)
      expect(agent.giteaHost).toBeUndefined()
      expect((daemon as any).workspaces.managedScopeOf(agent).host.baseUrl).toBe(GITEA_DEFAULT_BASE_URL)
    } finally {
      await daemon.stop()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('feature negotiation (§11)', () => {
  it('advertises gitea-v1 to the control plane — the one bit placement, spec projection, and dispatch gate on', async () => {
    expect(GITEA_V1_FEATURE).toBe('gitea-v1')
    const { daemon, root } = await daemonWithOrigins([...DEFAULT_WORKSPACE_GIT_ALLOWED_ORIGINS])
    try {
      const features = (daemon as unknown as { registrationFeatures(): string[] }).registrationFeatures()
      expect(features).toContain(GITEA_V1_FEATURE)
    } finally {
      await daemon.stop()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
