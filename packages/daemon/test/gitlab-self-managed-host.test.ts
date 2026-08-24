/**
 * Self-managed GitLab, daemon side (gitlab-com-integration.md §24.4/§24.5): the injected
 * host→provider table that replaced the two-literal classifier, the prefix stripping a relative URL
 * root forces, the grant host echo, the `glab` target resolver, and the spec-admission origin
 * refusal. GitLab.com is the default value of the axis, so every case here also pins that nothing
 * changes for a deployment that names no host.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import {
  DEFAULT_WORKSPACE_GIT_ALLOWED_ORIGINS,
  GITLAB_DEFAULT_BASE_URL,
  type AgentSpec,
  type GitCredGrant
} from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import { WorkspaceManager } from '../src/workspace/workspace-manager.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import {
  decodeManagedHostTable,
  encodeManagedHostTable,
  GITCRED_HOSTS_ENV,
  gitlabManagedHost,
  managedHostTableFor,
  matchManagedHost,
  stripHostPathPrefix
} from '../src/gitcred/managed-hosts.js'
import { runGitCredential } from '../src/gitcred/helper.js'
import { GITCRED_CAPABILITY_ENV } from '../src/gitcred/env.js'
import { GitCredentialCache, GitCredUnavailableError } from '../src/cp/git-credential.js'
import { normalizeProjectArg, resolveGlabTargetProject } from '../src/cp/glab-target.js'
import {
  gitCredentialEnv,
  initGitInjection,
  managedCredentialScope,
  originOnManagedHost,
  sessionGitConfig,
  daemonGitCredentialTarget
} from '../src/workspace/git-injection.js'
import {
  adoptDeploymentCodeHost,
  configureWorkspaceGitOrigins,
  unauthorizedWorkspaceGitOrigin
} from '../src/workspace/git-origin-policy.js'

// A prefixed, non-default-port install: the shape a relative URL root produces, and the one every
// bare-hostname classifier gets wrong.
const INSTANCE = 'https://gitlab.example.test:8443/gitlab'
const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

describe('the injected host→provider table (§24.4)', () => {
  it('round-trips, and an absent table means the default axis value: GitHub plus GitLab.com', () => {
    const table = managedHostTableFor(INSTANCE)
    expect(encodeManagedHostTable(table)).toBe(`github=https://github.com gitlab=${INSTANCE}`)
    expect(decodeManagedHostTable(encodeManagedHostTable(table))).toEqual(table)
    expect(decodeManagedHostTable(undefined)).toEqual([
      { provider: 'github', baseUrl: 'https://github.com' },
      { provider: 'gitlab', baseUrl: GITLAB_DEFAULT_BASE_URL }
    ])
    expect(gitlabManagedHost().baseUrl).toBe(GITLAB_DEFAULT_BASE_URL)
    expect(gitlabManagedHost(`${INSTANCE}/`).baseUrl).toBe(INSTANCE)
  })

  it('classifies GitHub, GitLab.com, and a prefixed non-default-port instance', () => {
    const table = managedHostTableFor(INSTANCE)
    expect(matchManagedHost(table, { protocol: 'https', host: 'github.com', path: 'acme/infra.git' })).toEqual({
      entry: { provider: 'github', baseUrl: 'https://github.com' },
      path: 'acme/infra.git'
    })
    expect(
      matchManagedHost(table, { protocol: 'https', host: 'gitlab.example.test:8443', path: 'gitlab/group/proj.git' })
    ).toEqual({ entry: { provider: 'gitlab', baseUrl: INSTANCE }, path: 'group/proj.git' })
    // The same host WITHOUT the port is a different address and is not ours.
    expect(
      matchManagedHost(table, { protocol: 'https', host: 'gitlab.example.test', path: 'gitlab/group/proj.git' })
    ).toBeUndefined()
    // GitLab.com stays classified when the axis is unset.
    expect(
      matchManagedHost(managedHostTableFor(), { protocol: 'https', host: 'gitlab.com', path: 'group/sub/proj.git' })
    ).toEqual({ entry: { provider: 'gitlab', baseUrl: GITLAB_DEFAULT_BASE_URL }, path: 'group/sub/proj.git' })
  })

  it('refuses a near-miss host and an unknown one — the comparison is exact, never a substring', () => {
    const table = managedHostTableFor(INSTANCE)
    for (const host of [
      'gitlab.example.test:8443.evil.test', // managed host as a PREFIX of the asked one
      'evil.gitlab.example.test:8443', // managed host as a SUFFIX of the asked one
      'notgitlab.example.test:8443',
      'code.example.test'
    ]) {
      expect(matchManagedHost(table, { protocol: 'https', host, path: 'gitlab/group/proj.git' })).toBeUndefined()
    }
    // Right host, wrong transport, and right host under a NEIGHBOURING path root: neither is ours.
    expect(
      matchManagedHost(table, { protocol: 'ssh', host: 'gitlab.example.test:8443', path: 'gitlab/group/proj.git' })
    ).toBeUndefined()
    expect(
      matchManagedHost(table, { protocol: 'https', host: 'gitlab.example.test:8443', path: 'gitlab-staging/g/p.git' })
    ).toBeUndefined()
  })

  it('strips a path prefix only on an exact segment boundary', () => {
    expect(stripHostPathPrefix('gitlab/group/proj.git', 'gitlab')).toBe('group/proj.git')
    expect(stripHostPathPrefix('/gitlab/group/proj.git', 'gitlab')).toBe('group/proj.git')
    expect(stripHostPathPrefix('gitlab', 'gitlab')).toBe('')
    expect(stripHostPathPrefix('gitlabextra/group/proj.git', 'gitlab')).toBeUndefined()
    expect(stripHostPathPrefix('group/proj.git', '')).toBe('group/proj.git')
  })

  it('is checked against a clone URL, never sniffed from one', () => {
    const scope = managedCredentialScope('gitlab', INSTANCE)
    expect(originOnManagedHost('https://gitlab.example.test:8443/gitlab/group/proj.git', scope.host)).toBe(true)
    expect(originOnManagedHost('https://gitlab.example.test:8443/other/group/proj.git', scope.host)).toBe(false)
    expect(originOnManagedHost('https://gitlab.com/group/proj.git', scope.host)).toBe(false)
    // …and GitLab.com keeps trusting exactly GitLab.com when the axis is unset.
    expect(originOnManagedHost('https://gitlab.com/group/proj.git', managedCredentialScope('gitlab').host)).toBe(true)
  })

  it('gives an ANONYMOUS gitlab remote the provider whose `.git` rule it needs, checked not sniffed', () => {
    const workspaces = new WorkspaceManager()
    const anonymous = (gitRepo: string, gitlabHost?: string) =>
      ({
        id: AGENT,
        workspace: { mode: 'git-repo', gitRepo, gitBranch: 'main', path: '/tmp/ws', additionalRepos: [] },
        ...(gitlabHost !== undefined ? { gitlabHost } : {})
      }) as unknown as Parameters<WorkspaceManager['remoteProviderOf']>[0]
    // A public GitLab.com clone has no credential provider on the spec, and still needs the suffix
    // rule: GitLab 301s the suffix-less probe and daemon git refuses redirects.
    const repo = 'https://gitlab.com/example-group/example-project'
    expect(workspaces.remoteProviderOf(anonymous(repo), repo)).toBe('gitlab')
    expect(workspaces.gitRepoOf(anonymous(repo))).toBe(`${repo}.git`)
    // Another host is nobody's provider, so nothing is appended.
    const other = 'https://github.com/acme/infra'
    expect(workspaces.remoteProviderOf(anonymous(other), other)).toBeUndefined()
    expect(workspaces.gitRepoOf(anonymous(other))).toBe(other)
  })
})

describe('the credential helper on a prefixed instance (§24.4)', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'ac-selfmanaged-'))
  initGitInjection({
    targetFor: () => daemonGitCredentialTarget({ shimPath: join(runDir, 'helper.sh'), runDir }),
    preWarm: async () => undefined,
    capabilityFor: () => 'cap-test'
  })

  /** A one-shot gitcred socket that records the request and answers a fixed grant. */
  async function socket(reply: Record<string, unknown>): Promise<{
    path: string
    requests: Record<string, unknown>[]
    close: () => void
  }> {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-gitcred-sock-')), 's')
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
      // The helper reports a refusal by SETTING exitCode; git reads that as a failed helper.
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

  const table = encodeManagedHostTable(managedHostTableFor(INSTANCE))

  it('routes a prefixed request to the gitlab provider on the project path minus the prefix', async () => {
    const server = await socket({ ok: true, username: 'agent-sa', password: 'glpat-x', repoFullName: 'group/proj' })
    try {
      const { stdout } = await helper(
        'protocol=https\nhost=gitlab.example.test:8443\npath=gitlab/group/sub/proj.git\n',
        server.path,
        table
      )
      expect(server.requests).toEqual([
        {
          op: 'get',
          agentId: AGENT,
          capability: 'cap-test',
          repoFullName: 'group/sub/proj',
          provider: 'gitlab'
        }
      ])
      expect(stdout).toBe('username=agent-sa\npassword=glpat-x\n')
    } finally {
      server.close()
    }
  })

  it('stays silent for a near-miss host, so git can try its own helpers', async () => {
    const server = await socket({ ok: true, username: 'agent-sa', password: 'glpat-x' })
    try {
      const { stdout, stderr } = await helper(
        'protocol=https\nhost=evil.gitlab.example.test:8443\npath=gitlab/group/proj.git\n',
        server.path,
        table
      )
      expect(server.requests).toEqual([])
      expect(stdout).toBe('')
      expect(stderr).toBe('')
    } finally {
      server.close()
    }
  })

  it('keeps GitHub unqualified and full-depth GitLab.com routing when the axis is unset', async () => {
    const server = await socket({ ok: true, username: 'x-access-token', password: 'ghs_x' })
    try {
      await helper('protocol=https\nhost=github.com\npath=acme/infra.git\n', server.path, undefined)
      expect(server.requests[0]).toEqual({
        op: 'get',
        agentId: AGENT,
        capability: 'cap-test',
        repoFullName: 'acme/infra'
      })
      await helper('protocol=https\nhost=gitlab.com\npath=group/sub/proj.git\n', server.path, undefined)
      expect(server.requests[1]).toEqual({
        op: 'get',
        agentId: AGENT,
        capability: 'cap-test',
        repoFullName: 'group/sub/proj',
        provider: 'gitlab'
      })
    } finally {
      server.close()
    }
  })

  it('pins the git-config block and the injected table to the resolved instance', () => {
    const target = daemonGitCredentialTarget({ shimPath: join(runDir, 'helper.sh'), runDir })
    const scope = managedCredentialScope('gitlab', INSTANCE)
    const config = sessionGitConfig(AGENT, undefined, target, scope)
    expect(config.content).toContain(`[credential "${INSTANCE}"]`)
    expect(config.content).toContain('useHttpPath = true')
    expect(config.env[GITCRED_HOSTS_ENV]).toBe(table)
    // A github workspace on the same deployment still carries the instance in its table: an
    // additional-repository authorization is a GitLab consumer that is not the workspace.
    expect(gitCredentialEnv(AGENT, target, managedCredentialScope('github', INSTANCE))[GITCRED_HOSTS_ENV]).toBe(table)
  })

  // §24.4: the session config pins the instance for a REPO-BEARING consumer — a gitlab workspace or
  // an authorized gitlab additional repository. A hook-only host does not, because a hook holds no
  // repository authorization and pinning would only cut the agent's ambient credentials.
  describe('the second credential block for a repo-bearing consumer', () => {
    const workspaces = new WorkspaceManager()
    const target = daemonGitCredentialTarget({ shimPath: join(runDir, 'helper.sh'), runDir })
    const agentWith = (workspace: Record<string, unknown>) =>
      ({
        id: AGENT,
        gitlabHost: INSTANCE,
        workspace: { gitBranch: 'main', path: '/tmp/ws', additionalRepos: [], ...workspace }
      }) as unknown as Parameters<WorkspaceManager['managedScopeOf']>[0]
    const githubWorkspace = { mode: 'git-repo', gitRepo: 'https://github.com/acme/infra', gitCredential: 'github-app' }
    const gitlabRepoRow = { repoFullName: 'example-group/example-project', repoId: '4455667', provider: 'gitlab' }
    const configFor = (workspace: Record<string, unknown>) =>
      sessionGitConfig(AGENT, undefined, target, workspaces.managedScopeOf(agentWith(workspace))).content

    it('pins both hosts for a github workspace holding a gitlab additional-repository grant', () => {
      const content = configFor({ ...githubWorkspace, additionalRepos: [gitlabRepoRow] })
      expect(content).toContain('[credential "https://github.com"]')
      expect(content).toContain(`[credential "${INSTANCE}"]`)
      // Both blocks reset the accumulated helper list and keep the path the helper routes on.
      expect(content.match(/\thelper = $/gm)).toHaveLength(2)
      expect(content.match(/\tuseHttpPath = true/g)).toHaveLength(2)
    })

    it('pins a scratch workspace the same way — the grant, not the workspace, is what bears the repo', () => {
      const content = configFor({ mode: 'from-scratch', gitCredential: 'github-app', additionalRepos: [gitlabRepoRow] })
      expect(content).toContain(`[credential "${INSTANCE}"]`)
      expect(workspaces.gitlabRepoBearing(agentWith({ mode: 'from-scratch', additionalRepos: [gitlabRepoRow] }))).toBe(
        true
      )
    })

    it('leaves a HOOK-ONLY agent unpinned, so its ambient gitlab credentials still answer', () => {
      const content = configFor(githubWorkspace)
      expect(content).toContain('[credential "https://github.com"]')
      expect(content).not.toContain(INSTANCE)
      expect(workspaces.gitlabRepoBearing(agentWith(githubWorkspace))).toBe(false)
      // A github additional repository is not a gitlab consumer either.
      const githubRow = { repoFullName: 'acme/other', repoId: '77', provider: 'github' }
      expect(workspaces.gitlabRepoBearing(agentWith({ ...githubWorkspace, additionalRepos: [githubRow] }))).toBe(false)
    })

    it('still pins exactly one block for a gitlab workspace — the instance is already its own host', () => {
      const content = configFor({ mode: 'git-repo', gitRepo: `${INSTANCE}/g/p.git`, gitCredential: 'gitlab' })
      expect(content.match(/\[credential /g)).toHaveLength(1)
      expect(content).toContain(`[credential "${INSTANCE}"]`)
    })
  })

  it('serves an authorized additional repository on the instance, and DECLINES an unauthorized one', async () => {
    // The block above is what makes git ask at all; the injected table is what routes the ask.
    const authorized = await socket({
      ok: true,
      username: 'agent-sa',
      password: 'glpat-x',
      repoFullName: 'example-group/example-project'
    })
    try {
      const served = await helper(
        'protocol=https\nhost=gitlab.example.test:8443\npath=gitlab/example-group/example-project.git\n',
        authorized.path,
        table
      )
      expect(served.stdout).toBe('username=agent-sa\npassword=glpat-x\n')
      expect(served.exitCode).toBe(0)
      expect(authorized.requests[0]).toMatchObject({
        provider: 'gitlab',
        repoFullName: 'example-group/example-project'
      })
    } finally {
      authorized.close()
    }
    // The new failure mode the second block introduces: our helper now OWNS this host's credential
    // path, so an unauthorized project on it fails closed instead of falling through to ambient auth.
    const refused = await socket({ ok: false, error: 'repository is not authorized for this agent' })
    try {
      const denied = await helper(
        'protocol=https\nhost=gitlab.example.test:8443\npath=gitlab/example-group/not-authorized.git\n',
        refused.path,
        table
      )
      expect(denied.stdout).toBe('')
      expect(denied.exitCode).toBe(1)
      expect(denied.stderr).toContain('no git credentials')
      expect(denied.stderr).toContain('example-group/not-authorized')
    } finally {
      refused.close()
    }
  })

  rmSync(runDir, { recursive: true, force: true })
})

describe('the grant host echo (§24.4)', () => {
  function cache(grant: Partial<GitCredGrant>, gitlabHost?: string) {
    return new GitCredentialCache({
      request: async () =>
        ({
          username: 'agent-sa',
          token: 'glpat-x',
          ttlSec: 3600,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          repoFullName: 'group/proj',
          access: 'write',
          provider: 'gitlab',
          externalRepoId: '4455667',
          ...grant
        }) as GitCredGrant,
      log: { warn: () => undefined },
      providerV2Supported: () => true,
      gitlabHostFor: () => gitlabHost
    })
  }

  const ask = (instance: GitCredentialCache) =>
    instance.get(AGENT, 'clone', { provider: 'gitlab', externalRepoId: '4455667' })

  it('accepts the instance the spec names, prefix and port included', async () => {
    await expect(ask(cache({ host: INSTANCE }, INSTANCE))).resolves.toMatchObject({ token: 'glpat-x' })
  })

  it('refuses a grant echoing another instance', async () => {
    await expect(ask(cache({ host: 'https://gitlab.other.test' }, INSTANCE))).rejects.toThrow(
      /gitlab instance https:\/\/gitlab\.other\.test for an agent bound to https:\/\/gitlab\.example\.test:8443\/gitlab/
    )
    await expect(ask(cache({ host: 'https://gitlab.other.test' }, INSTANCE))).rejects.toBeInstanceOf(
      GitCredUnavailableError
    )
  })

  it('reads an absent host on either side as GitLab.com', async () => {
    // Neither side names one: today's GitLab.com wire, byte-identical.
    await expect(ask(cache({}))).resolves.toMatchObject({ token: 'glpat-x' })
    // Absent echo against a self-managed spec is a GitLab.com credential — refused.
    await expect(ask(cache({}, INSTANCE))).rejects.toThrow(/gitlab instance https:\/\/gitlab\.com/)
    // …and an echoed GitLab.com against an unset axis is the same host, so it passes.
    await expect(ask(cache({ host: GITLAB_DEFAULT_BASE_URL }))).resolves.toMatchObject({ token: 'glpat-x' })
  })
})

describe('glab target resolution against the configured instance (§13.3, §24.4)', () => {
  const none = () => undefined

  it('strips the instance prefix from every candidate form', () => {
    expect(normalizeProjectArg('https://gitlab.example.test:8443/gitlab/group/sub/proj.git', INSTANCE)).toEqual({
      project: 'group/sub/proj'
    })
    expect(normalizeProjectArg('gitlab.example.test/gitlab/group/proj', INSTANCE)).toEqual({ project: 'group/proj' })
    // A bare path is already relative to the instance root.
    expect(normalizeProjectArg('group/proj', INSTANCE)).toEqual({ project: 'group/proj' })
    // A neighbouring path root on the same host names no project of this instance.
    expect(normalizeProjectArg('https://gitlab.example.test:8443/other/group/proj.git', INSTANCE)).toEqual({})
  })

  it('defers only on a genuine mismatch, and honours the export the shim makes', () => {
    expect(
      resolveGlabTargetProject([], { GITLAB_HOST: INSTANCE }, () => `${INSTANCE}/group/proj.git`, INSTANCE)
    ).toEqual({ project: 'group/proj' })
    // glab also accepts a scheme-less host; the same instance is still the same instance.
    expect(resolveGlabTargetProject([], { GITLAB_HOST: 'gitlab.example.test:8443/gitlab' }, none, INSTANCE)).toEqual({})
    expect(resolveGlabTargetProject([], { GITLAB_HOST: 'gitlab.com' }, none, INSTANCE)).toEqual({ defer: true })
    expect(resolveGlabTargetProject(['mr', 'view', '-R', 'gitlab.com/g/p'], {}, none, INSTANCE)).toEqual({
      defer: true
    })
    // Unset axis: GitLab.com is the expected instance and nothing defers.
    expect(resolveGlabTargetProject([], {}, () => 'https://gitlab.com/g/p.git')).toEqual({ project: 'g/p' })
  })
})

describe('spec-admission origin refusal (§24.4)', () => {
  afterAll(() => {
    configureWorkspaceGitOrigins([...DEFAULT_WORKSPACE_GIT_ALLOWED_ORIGINS])
    adoptDeploymentCodeHost('https://adoption-parked.example.test')
  })

  it('names the origin the operator policy excludes, and admits a permitted one', () => {
    // Park adoption on a host no case names: this one is about the operator list on its own.
    adoptDeploymentCodeHost('https://adoption-parked.example.test')
    configureWorkspaceGitOrigins(['https://github.com', 'https://gitlab.com'])
    expect(unauthorizedWorkspaceGitOrigin('https://gitlab.example.test:8443/gitlab/group/proj.git')).toBe(
      'https://gitlab.example.test:8443'
    )
    expect(unauthorizedWorkspaceGitOrigin('https://gitlab.com/group/proj.git')).toBeUndefined()
    // The managed feature never widens the list; the operator adding the origin is what admits it.
    configureWorkspaceGitOrigins(['https://github.com', 'https://gitlab.example.test:8443'])
    expect(unauthorizedWorkspaceGitOrigin('https://gitlab.example.test:8443/gitlab/group/proj.git')).toBeUndefined()
    expect(unauthorizedWorkspaceGitOrigin('https://gitlab.com/group/proj.git')).toBe('https://gitlab.com')
  })

  /** A daemon whose only interesting configuration is the operator's origin policy. */
  async function daemonWithOrigins(origins: string[]): Promise<{ daemon: Daemon; root: string }> {
    const root = mkdtempSync(join(tmpdir(), 'ac-gl-admission-'))
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

  const gitlabSpec = () =>
    ({
      name: 'gl',
      gitlabHost: INSTANCE,
      workspace: {
        mode: 'gitlab',
        isolation: 'shared',
        gitRepo: `${INSTANCE}/example-group/example-project.git`,
        branch: 'main',
        projectId: '4455667',
        additionalRepos: []
      }
    }) as unknown as AgentSpec

  // The instance is the deployment's own configuration, and this daemon already trusts it to decide
  // where an agent's git credential may go — so admission adopts it rather than asking an operator
  // to restate an address the control plane just sent.
  it('admits the deployment instance with nothing configured for it', async () => {
    const { daemon, root } = await daemonWithOrigins(['https://github.com', 'https://gitlab.com'])
    try {
      const ack = await (daemon as any).cpConfigApply().applyAgentUpsert({ agentId: AGENT, spec: gitlabSpec() })
      expect(ack).toEqual({ ok: true })
      expect((daemon as any).agents.get(AGENT).gitlabHost).toBe(INSTANCE)
    } finally {
      await daemon.stop()
      rmSync(root, { recursive: true, force: true })
    }
  })

  // The bot's case: the instance rides `gitlabHost`, not the primary workspace mode.
  it('adopts from a non-gitlab workspace that still names the instance', async () => {
    const { daemon, root } = await daemonWithOrigins(['https://github.com', 'https://gitlab.com'])
    try {
      const spec = {
        name: 'gh-with-gitlab-grant',
        gitlabHost: INSTANCE,
        workspace: { mode: 'scratch', isolation: 'shared', additionalRepos: [] }
      } as unknown as AgentSpec
      const ack = await (daemon as any).cpConfigApply().applyAgentUpsert({ agentId: AGENT, spec })
      expect(ack).toEqual({ ok: true })
      expect(unauthorizedWorkspaceGitOrigin(`${INSTANCE}/example-group/example-project.git`)).toBeUndefined()
    } finally {
      await daemon.stop()
      rmSync(root, { recursive: true, force: true })
    }
  })

  // What admission still refuses: a repository somewhere the deployment never named.
  it('refuses a repository off the deployment instance, and names that origin on the ack', async () => {
    const { daemon, root } = await daemonWithOrigins(['https://github.com', 'https://gitlab.com'])
    try {
      const spec = gitlabSpec() as unknown as { workspace: { gitRepo: string } }
      spec.workspace.gitRepo = 'https://elsewhere.example.test/group/proj.git'
      const ack = await (daemon as any).cpConfigApply().applyAgentUpsert({ agentId: AGENT, spec })
      expect(ack.ok).toBe(false)
      expect(ack.reason).toContain('https://elsewhere.example.test')
      expect((daemon as any).agents.has(AGENT)).toBe(false)
    } finally {
      await daemon.stop()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('admits the same spec once the operator permits the origin, and resolves the clone target on it', async () => {
    const { daemon, root } = await daemonWithOrigins(['https://github.com', 'https://gitlab.example.test:8443'])
    try {
      const ack = await (daemon as any).cpConfigApply().applyAgentUpsert({ agentId: AGENT, spec: gitlabSpec() })
      expect(ack).toEqual({ ok: true })
      const agent = (daemon as any).agents.get(AGENT)
      expect(agent.gitlabHost).toBe(INSTANCE)
      const workspaces = new WorkspaceManager()
      expect(workspaces.managedScopeOf(agent).host.baseUrl).toBe(INSTANCE)
      expect(workspaces.gitRepoOf(agent)).toBe(`${INSTANCE}/example-group/example-project.git`)
    } finally {
      await daemon.stop()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
