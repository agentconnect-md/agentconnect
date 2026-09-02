import { describe, expect, it } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { effectiveRunInSandbox, prepareRuntimeLaunch } from '../src/launch/prepare.js'
import { composeRuntimeLaunch, runtimeSandboxReadRoots } from '../src/launch/compose.js'
import { CODEX_ACP_PERMISSION_PROFILE_CONFIG_ENV } from '../src/acp/codex-permission-profiles.js'
import { runtimeMemoryCapabilities } from '../src/memory/runtime/capabilities.js'
import { MemoryProviderUnavailableError } from '../src/memory/provider.js'
import type { RuntimeDef } from '../src/config/config-schema.js'

function fixture(): { scopeDir: string; cwd: string; hostHome: string } {
  const root = mkdtempSync(join(tmpdir(), 'ac-runtime-launch-'))
  const scopeDir = join(root, 'agent')
  const cwd = join(scopeDir, 'workspace')
  const hostHome = join(root, 'host-home')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(hostHome)
  return { scopeDir, cwd, hostHome }
}

/** The inner Codex agent profile's filesystem table, which is also its exec sandbox's writable set. */
function agentFilesystem(env: Record<string, string>): string {
  const profile = JSON.parse(env[CODEX_ACP_PERMISSION_PROFILE_CONFIG_ENV]!) as { configOverrides: string[] }
  return profile.configOverrides.find((value) =>
    value.startsWith('permissions.agentconnect-protected-workspace.filesystem=')
  )!
}

function coveredBy(paths: string[], target: string): boolean {
  return paths.some((root) => {
    const rel = relative(root, target)
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  })
}

describe('prepareRuntimeLaunch', () => {
  it('inherits the daemon environment and creates no private HOME when the effective sandbox is off', () => {
    const { scopeDir, cwd, hostHome } = fixture()
    const launch = prepareRuntimeLaunch({
      runtimeId: 'claude-acp',
      runtime: { command: 'npx', args: ['claude-agent-acp'], env: [] },
      scopeDir,
      cwd,
      runInSandbox: false,
      explicitEnv: { AGENT_VALUE: 'yes' },
      hostEnv: { HOME: hostHome, PATH: '/usr/bin' }
    })

    expect(launch).toEqual({ env: { AGENT_VALUE: 'yes' }, inheritProcessEnv: true })
    expect(existsSync(join(scopeDir, 'home'))).toBe(false)
  })

  it('uses a private HOME only for an effective sandboxed launch', () => {
    const { scopeDir, cwd, hostHome } = fixture()
    const customClaudeConfig = join(dirname(hostHome), 'host-claude-config')
    const identityTokenFile = join(hostHome, 'identity.jwt')
    const awsWebIdentityTokenFile = join(hostHome, 'aws-web-identity.jwt')
    mkdirSync(customClaudeConfig)
    writeFileSync(
      join(customClaudeConfig, 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_API_KEY: 'seeded-settings-secret' } })
    )
    writeFileSync(
      join(customClaudeConfig, '.claude.json'),
      JSON.stringify({
        additionalModelOptionsCache: [{ value: 'custom-fable', label: 'Custom Fable', description: 'test' }],
        source: 'do-not-copy-custom-config-dir'
      })
    )
    writeFileSync(
      join(hostHome, '.claude.json'),
      JSON.stringify({
        additionalModelOptionsCache: [{ value: 'root-fable', label: 'Root Fable', description: 'test' }],
        mcpToken: 'do-not-copy-global-secret'
      })
    )
    writeFileSync(identityTokenFile, 'trusted-parent-identity-token')
    writeFileSync(awsWebIdentityTokenFile, 'trusted-parent-aws-token')
    const launch = prepareRuntimeLaunch({
      runtimeId: 'claude-acp',
      runtime: { command: 'npx', args: ['claude-agent-acp'], env: [] },
      scopeDir,
      cwd,
      runInSandbox: true,
      daemonRoot: dirname(scopeDir),
      sandboxMechanism: 'bwrap',
      credentialPlatform: 'linux',
      explicitEnv: {
        AGENT_VALUE: 'yes',
        ANTHROPIC_IDENTITY_TOKEN_FILE: identityTokenFile,
        AWS_WEB_IDENTITY_TOKEN_FILE: awsWebIdentityTokenFile,
        SSH_AUTH_SOCK: '/run/user/1000/ssh-agent.sock',
        DOCKER_HOST: 'unix:///run/docker.sock',
        BUILDKIT_HOST: 'tcp://builder.example.test:1234'
      },
      hostEnv: {
        HOME: hostHome,
        CLAUDE_CONFIG_DIR: customClaudeConfig,
        PATH: '/usr/bin',
        XDG_RUNTIME_DIR: '/run/user/1000',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus'
      }
    })

    expect(launch.inheritProcessEnv).toBe(false)
    expect(launch.runtimeHome).toBe(join(scopeDir, 'home'))
    expect(launch.env.HOME).toBe(join(scopeDir, 'home'))
    expect(launch.env.AGENT_VALUE).toBe('yes')
    expect(launch.env.XDG_RUNTIME_DIR).toBe(realpathSync(join(scopeDir, 'home', '.run')))
    expect(statSync(launch.env.XDG_RUNTIME_DIR!).mode & 0o777).toBe(0o700)
    expect(launch.env.SSH_AUTH_SOCK).toBeUndefined()
    expect(launch.env.DBUS_SESSION_BUS_ADDRESS).toBeUndefined()
    expect(launch.env.DOCKER_HOST).toBeUndefined()
    expect(launch.env.BUILDKIT_HOST).toBe('tcp://builder.example.test:1234')
    expect(launch.sandbox?.mechanism).toBe('bwrap')
    expect(statSync(join(cwd, '.claude')).isDirectory()).toBe(true)
    expect(existsSync(join(cwd, '.claude', 'settings.json'))).toBe(false)
    expect(existsSync(launch.sandbox!.settingsPath)).toBe(true)
    const settings = JSON.parse(readFileSync(launch.sandbox!.settingsPath, 'utf8'))
    const canonicalHostHome = realpathSync(hostHome)
    const canonicalIdentityToken = realpathSync(identityTokenFile)
    const canonicalAwsWebIdentityToken = realpathSync(awsWebIdentityTokenFile)
    const privateClaudeConfig = realpathSync(join(scopeDir, 'home', '.claude'))
    const privateClaudeGlobal = realpathSync(join(scopeDir, 'home', '.claude.json'))
    expect(existsSync(join(privateClaudeConfig, 'settings.json'))).toBe(false)
    expect(JSON.parse(readFileSync(join(privateClaudeConfig, '.claude.json'), 'utf8'))).toEqual({
      additionalModelOptionsCache: [{ value: 'custom-fable', label: 'Custom Fable', description: 'test' }]
    })
    expect(JSON.parse(readFileSync(privateClaudeGlobal, 'utf8'))).toEqual({
      additionalModelOptionsCache: [{ value: 'root-fable', label: 'Root Fable', description: 'test' }]
    })
    expect(launch.env.ANTHROPIC_IDENTITY_TOKEN_FILE).toBe(canonicalIdentityToken)
    expect(launch.env.AWS_WEB_IDENTITY_TOKEN_FILE).toBe(canonicalAwsWebIdentityToken)
    expect(coveredBy(settings.filesystem.denyRead, canonicalHostHome)).toBe(true)
    expect(coveredBy(settings.filesystem.denyRead, '/run')).toBe(true)
    expect(coveredBy(settings.filesystem.denyRead, realpathSync(customClaudeConfig))).toBe(true)
    expect(coveredBy(settings.filesystem.denyRead, realpathSync(dirname(scopeDir)))).toBe(true)
    expect(settings.filesystem.allowRead).toEqual(
      expect.arrayContaining([
        realpathSync(cwd),
        realpathSync(join(scopeDir, 'home')),
        canonicalIdentityToken,
        canonicalAwsWebIdentityToken
      ])
    )
    expect(launch.sandbox?.protectedCredentialRoots).toEqual(
      expect.arrayContaining([
        canonicalIdentityToken,
        canonicalAwsWebIdentityToken,
        privateClaudeConfig,
        privateClaudeGlobal
      ])
    )
  })

  it('drops host Anthropic profile auth instead of deriving outer exceptions from its JSON', () => {
    const { scopeDir, cwd, hostHome } = fixture()
    const profileRoot = join(hostHome, 'anthropic-profiles')
    const profileConfigDir = join(profileRoot, 'configs')
    mkdirSync(profileConfigDir, { recursive: true })
    writeFileSync(
      join(profileConfigDir, 'corp.json'),
      JSON.stringify({ authentication: { type: 'user_oauth', credentials_path: '/etc/agentconnect-oauth.json' } })
    )

    const launch = prepareRuntimeLaunch({
      runtimeId: 'claude-acp',
      runtime: { command: 'npx', args: ['claude-agent-acp'], env: [] },
      scopeDir,
      cwd,
      runInSandbox: true,
      daemonRoot: dirname(scopeDir),
      sandboxMechanism: 'bwrap',
      explicitEnv: {
        ANTHROPIC_CONFIG_DIR: profileRoot,
        ANTHROPIC_PROFILE: 'corp',
        CLAUDE_MODEL_CONFIG: JSON.stringify({
          modelOverrides: { sonnet: 'bedrock/sonnet' },
          availableModels: ['sonnet'],
          ignored: 'not an adapter model setting'
        })
      },
      hostEnv: { HOME: hostHome, PATH: '/usr/bin' }
    })

    const disabledProfileRoot = realpathSync(
      join(scopeDir, '.agentconnect', 'runtime-policy', 'claude-profile-disabled')
    )
    expect(launch.env.ANTHROPIC_CONFIG_DIR).toBe(disabledProfileRoot)
    expect(launch.env.ANTHROPIC_PROFILE).toBeUndefined()
    expect(launch.sandbox?.claudeProtectedSettings).toEqual({
      modelOverrides: { sonnet: 'bedrock/sonnet' },
      availableModels: ['sonnet'],
      env: {
        ANTHROPIC_CONFIG_DIR: disabledProfileRoot,
        ANTHROPIC_PROFILE: 'agentconnect-disabled'
      }
    })
    expect(readdirSync(disabledProfileRoot)).toEqual([])
    expect(coveredBy(launch.sandbox!.allowReadRoots, disabledProfileRoot)).toBe(true)
    expect(launch.sandbox?.writable).not.toContain(disabledProfileRoot)
    expect(launch.sandbox?.allowReadRoots).not.toContain(realpathSync(profileRoot))
    expect(launch.sandbox?.writable).not.toContain('/etc')
    expect(launch.sandbox?.protectedCredentialRoots).not.toContain('/etc')
  })

  it('never trusts an Anthropic profile planted in the private runtime HOME', () => {
    const { scopeDir, cwd, hostHome } = fixture()
    const privateProfileDir = join(scopeDir, 'home', '.config', 'anthropic', 'configs')
    mkdirSync(privateProfileDir, { recursive: true })
    writeFileSync(join(dirname(privateProfileDir), 'active_config'), 'default')
    writeFileSync(
      join(privateProfileDir, 'default.json'),
      JSON.stringify({ authentication: { credentials_path: '/etc/agentconnect-oauth.json' } })
    )

    const launch = prepareRuntimeLaunch({
      runtimeId: 'claude-acp',
      runtime: { command: 'npx', args: ['claude-agent-acp'], env: [] },
      scopeDir,
      cwd,
      runInSandbox: true,
      daemonRoot: dirname(scopeDir),
      sandboxMechanism: 'bwrap',
      hostEnv: { HOME: hostHome, PATH: '/usr/bin' }
    })

    const discoveredProfileRoot = launch.env.ANTHROPIC_CONFIG_DIR ?? join(launch.env.XDG_CONFIG_HOME!, 'anthropic')
    expect(discoveredProfileRoot).toBe(
      realpathSync(join(scopeDir, '.agentconnect', 'runtime-policy', 'claude-profile-disabled'))
    )
    expect(launch.sandbox?.claudeProtectedSettings?.env).toEqual({
      ANTHROPIC_CONFIG_DIR: discoveredProfileRoot,
      ANTHROPIC_PROFILE: 'agentconnect-disabled'
    })
    expect(readdirSync(discoveredProfileRoot)).toEqual([])
    expect(discoveredProfileRoot).not.toBe(join(scopeDir, 'home', '.config', 'anthropic'))
    expect(launch.sandbox?.writable).not.toContain('/etc')
    expect(launch.sandbox?.allowReadRoots).not.toContain('/etc/agentconnect-oauth.json')
    expect(launch.sandbox?.protectedCredentialRoots).not.toContain('/etc')
  })

  it('resolves version-manager PATH links before hiding the host HOME', () => {
    const { scopeDir, cwd, hostHome } = fixture()
    const versionBin = join(hostHome, '.nvm', 'versions', 'node', 'v24', 'bin')
    const current = join(hostHome, '.nvm', 'current')
    mkdirSync(versionBin, { recursive: true })
    symlinkSync(join(hostHome, '.nvm', 'versions', 'node', 'v24'), current)

    const launch = prepareRuntimeLaunch({
      runtimeId: 'maki',
      scopeDir,
      cwd,
      runInSandbox: true,
      daemonRoot: dirname(scopeDir),
      sandboxMechanism: 'bwrap',
      hostEnv: { HOME: hostHome, PATH: `${join(current, 'bin')}${delimiter}/usr/bin` }
    })

    expect(launch.env.PATH?.split(delimiter)[0]).toBe(realpathSync(versionBin))
  })

  it('reopens only reviewed runtime code below a denied root and rejects a broad exception', () => {
    const { scopeDir, cwd, hostHome } = fixture()
    const trustedCode = join(hostHome, '.local', 'lib', 'reviewed-runtime')
    mkdirSync(trustedCode, { recursive: true })
    const base = {
      runtimeId: 'maki',
      scopeDir,
      cwd,
      runInSandbox: true,
      daemonRoot: dirname(scopeDir),
      sandboxMechanism: 'bwrap' as const,
      hostEnv: { HOME: hostHome, PATH: '/usr/bin' }
    }

    const launch = prepareRuntimeLaunch({ ...base, trustedRuntimeReadRoots: [trustedCode] })
    const policy = JSON.parse(readFileSync(launch.sandbox!.settingsPath, 'utf8'))
    expect(policy.filesystem.allowRead).toContain(realpathSync(trustedCode))
    expect(() => prepareRuntimeLaunch({ ...base, trustedRuntimeReadRoots: [hostHome] })).toThrow(
      /would reopen protected path/
    )
  })

  // A probe HOME is disposable, so npx would resolve and link its whole install tree
  // every sweep (~210s for a large harness) unless the host package cache survives.
  // Writable, because npm writes tarballs, its index and the _npx tree there.
  it('pins the host package cache for a probe launch and carves it back writable', () => {
    const { scopeDir, cwd, hostHome } = fixture()
    const base = {
      runtimeId: 'dsh-acp',
      runtime: { command: 'npx', args: ['-y', '-p', 'pkg', 'bin'], env: [] } as RuntimeDef,
      scopeDir,
      cwd,
      runInSandbox: true,
      daemonRoot: dirname(scopeDir),
      sandboxMechanism: 'bwrap' as const,
      hostEnv: { HOME: hostHome, PATH: '/usr/bin' }
    }

    const probe = prepareRuntimeLaunch({ ...base, hostPackageCache: true })
    expect(probe.env.npm_config_cache).toBe(join(hostHome, '.npm'))
    expect(coveredBy(probe.sandbox!.writable, realpathSync(join(hostHome, '.npm')))).toBe(true)

    // An agent launch keeps the private cache: its model-driven tool use must not be
    // able to write the install trees other runtimes launch from.
    const agent = prepareRuntimeLaunch(base)
    expect(agent.env.npm_config_cache).toBeUndefined()
    expect(coveredBy(agent.sandbox!.writable, join(hostHome, '.npm'))).toBe(false)
  })

  // multi-repository-workspaces.md decision 8: the secondary roots live under the agent dir, which
  // the boundary denies wholesale — without this carve-back a sandboxed runtime cannot see them.
  it('carves back the secondary-roots parent and every existing secondary .git for Codex', () => {
    const { scopeDir, cwd, hostHome } = fixture()
    const worktrees = join(scopeDir, 'worktrees')
    const repos = join(scopeDir, 'repos')
    const secondaryGit = join(repos, 'acme', 'infra', 'checkout', '.git')
    mkdirSync(secondaryGit, { recursive: true })
    mkdirSync(join(cwd, '.git'), { recursive: true })

    const launch = prepareRuntimeLaunch({
      runtimeId: 'codex-acp',
      runtime: { command: 'npx', args: ['codex-acp'], env: [] },
      scopeDir,
      cwd,
      runInSandbox: true,
      daemonRoot: dirname(scopeDir),
      sandboxMechanism: 'bwrap',
      credentialPlatform: 'linux',
      trustedWorkspaceWriteRoots: [worktrees, repos],
      hostEnv: { HOME: hostHome, PATH: '/usr/bin' }
    })

    const policy = JSON.parse(readFileSync(launch.sandbox!.settingsPath, 'utf8'))
    expect(coveredBy(policy.filesystem.allowWrite, realpathSync(repos))).toBe(true)
    expect(coveredBy(policy.filesystem.allowRead, realpathSync(secondaryGit))).toBe(true)
    // Codex's :workspace profile protects `.git`; both the primary's and each secondary's are
    // reopened, and only because they sit inside a writable root.
    const profile = JSON.parse(launch.env[CODEX_ACP_PERMISSION_PROFILE_CONFIG_ENV]!) as { configOverrides: string[] }
    const writes = profile.configOverrides.filter((value) => value.includes('filesystem='))
    expect(writes.some((value) => value.includes(`"${realpathSync(secondaryGit)}" = "write"`))).toBe(true)
    expect(writes.some((value) => value.includes(`"${realpathSync(join(cwd, '.git'))}" = "write"`))).toBe(true)
  })

  // An isolated session's `.git` is a link FILE, so the checkout that owns its index, refs, and
  // objects sits outside the cwd — and outside every other carve-back, which left a confined
  // runtime unable to run any Git write in its own worktree.
  it('carves back the owner checkout .git for a session worktree cwd, hooks and config excepted', () => {
    const { scopeDir, hostHome } = fixture()
    const primaryGit = join(scopeDir, 'workspace', '.git')
    const worktrees = join(scopeDir, 'worktrees')
    const cwd = join(worktrees, 'session-1')
    mkdirSync(join(primaryGit, 'worktrees', 'session-1'), { recursive: true })
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(cwd, '.git'), `gitdir: ${join(primaryGit, 'worktrees', 'session-1')}\n`)

    const launch = prepareRuntimeLaunch({
      runtimeId: 'codex-acp',
      runtime: { command: 'npx', args: ['codex-acp'], env: [] },
      scopeDir,
      cwd,
      runInSandbox: true,
      daemonRoot: dirname(scopeDir),
      sandboxMechanism: 'bwrap',
      credentialPlatform: 'linux',
      trustedWorkspaceWriteRoots: [worktrees, join(scopeDir, 'repos')],
      hostEnv: { HOME: hostHome, PATH: '/usr/bin' }
    })

    const policy = JSON.parse(readFileSync(launch.sandbox!.settingsPath, 'utf8'))
    expect(coveredBy(policy.filesystem.allowWrite, realpathSync(primaryGit))).toBe(true)
    // The working tree beside it stays outside the boundary: isolation is the point of the worktree.
    expect(coveredBy(policy.filesystem.allowWrite, realpathSync(join(scopeDir, 'workspace')))).toBe(false)
    // SRT's own mandatory protection is derived from the cwd, which holds no `.git` DIRECTORY here.
    expect(policy.filesystem.denyWrite).toContain(join(realpathSync(primaryGit), 'hooks'))
    expect(policy.filesystem.denyWrite).toContain(join(realpathSync(primaryGit), 'config'))
    const profile = JSON.parse(launch.env[CODEX_ACP_PERMISSION_PROFILE_CONFIG_ENV]!) as { configOverrides: string[] }
    const writes = profile.configOverrides.filter((value) => value.includes('filesystem='))
    expect(writes.some((value) => value.includes(`"${realpathSync(primaryGit)}" = "write"`))).toBe(true)
  })

  // A locally authored agent may keep a checkout path the default layout does not name, and its
  // session worktrees still hang off THAT checkout — so the daemon names it rather than assuming.
  it('follows the daemon-supplied primary checkout rather than the default layout path', () => {
    const { scopeDir, hostHome } = fixture()
    const primaryGit = join(scopeDir, 'legacy-checkout', '.git')
    const worktrees = join(scopeDir, 'worktrees')
    const cwd = join(worktrees, 'session-1')
    mkdirSync(primaryGit, { recursive: true })
    mkdirSync(cwd, { recursive: true })

    const launch = prepareRuntimeLaunch({
      runtimeId: 'codex-acp',
      runtime: { command: 'npx', args: ['codex-acp'], env: [] },
      scopeDir,
      cwd,
      runInSandbox: true,
      daemonRoot: dirname(scopeDir),
      sandboxMechanism: 'bwrap',
      credentialPlatform: 'linux',
      trustedWorkspaceWriteRoots: [worktrees],
      trustedPrimaryCheckout: join(scopeDir, 'legacy-checkout'),
      hostEnv: { HOME: hostHome, PATH: '/usr/bin' }
    })

    const policy = JSON.parse(readFileSync(launch.sandbox!.settingsPath, 'utf8'))
    expect(coveredBy(policy.filesystem.allowWrite, realpathSync(primaryGit))).toBe(true)
    expect(policy.filesystem.denyWrite).toContain(join(realpathSync(primaryGit), 'hooks'))
  })

  it('refuses a primary checkout outside the agent root instead of carving it back', () => {
    const { scopeDir, cwd, hostHome } = fixture()
    expect(() =>
      prepareRuntimeLaunch({
        runtimeId: 'codex-acp',
        runtime: { command: 'npx', args: ['codex-acp'], env: [] },
        scopeDir,
        cwd,
        runInSandbox: true,
        daemonRoot: dirname(scopeDir),
        sandboxMechanism: 'bwrap',
        credentialPlatform: 'linux',
        trustedPrimaryCheckout: dirname(scopeDir),
        hostEnv: { HOME: hostHome, PATH: '/usr/bin' }
      })
    ).toThrow(/trusted primary checkout .* is outside the agent root/)
  })

  // Unsandboxed, Codex's own profile is the whole boundary and it confines exec to the SESSION cwd.
  it('opens the owner checkout .git to an unsandboxed Codex launch, hooks and config excepted', () => {
    const { scopeDir, hostHome } = fixture()
    const primaryGit = join(scopeDir, 'workspace', '.git')
    const cwd = join(scopeDir, 'worktrees', 'session-1')
    mkdirSync(join(primaryGit, 'worktrees', 'session-1'), { recursive: true })
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(cwd, '.git'), `gitdir: ${join(primaryGit, 'worktrees', 'session-1')}\n`)

    // No credential channel: the carve-back is owed to every unsandboxed Codex launch, not only a wired one.
    const launch = prepareRuntimeLaunch({
      runtimeId: 'codex-acp',
      runtime: { command: 'npx', args: ['codex-acp'], env: [] },
      scopeDir,
      cwd,
      runInSandbox: false,
      hostEnv: { HOME: hostHome, PATH: '/usr/bin' }
    })

    expect(launch.sandbox).toBeUndefined()
    const owner = realpathSync(primaryGit)
    expect(agentFilesystem(launch.env)).toContain(`"${owner}" = "write"`)
    expect(agentFilesystem(launch.env)).toContain(`"${join(owner, 'hooks')}" = "deny"`)
    expect(agentFilesystem(launch.env)).toContain(`"${join(owner, 'config')}" = "deny"`)
  })

  it('follows the daemon-named checkout and every secondary root when the sandbox is off', () => {
    const { scopeDir, cwd, hostHome } = fixture()
    const legacyGit = join(scopeDir, 'legacy-checkout', '.git')
    const secondaryGit = join(scopeDir, 'repos', 'acme', 'infra', 'checkout', '.git')
    mkdirSync(legacyGit, { recursive: true })
    mkdirSync(secondaryGit, { recursive: true })
    mkdirSync(join(cwd, '.git'), { recursive: true })

    const launch = prepareRuntimeLaunch({
      runtimeId: 'codex-acp',
      runtime: { command: 'npx', args: ['codex-acp'], env: [] },
      scopeDir,
      cwd,
      runInSandbox: false,
      trustedPrimaryCheckout: join(scopeDir, 'legacy-checkout'),
      hostEnv: { HOME: hostHome, PATH: '/usr/bin' }
    })

    const table = agentFilesystem(launch.env)
    expect(table).toContain(`"${realpathSync(legacyGit)}" = "write"`)
    expect(table).toContain(`"${realpathSync(secondaryGit)}" = "write"`)
    // The default-layout `.git` beside it was never the agent's checkout, so it stays protected.
    expect(table).not.toContain(realpathSync(join(cwd, '.git')))
  })

  it('leaves a checkout outside the agent root protected rather than opening it unconfined', () => {
    const { scopeDir, cwd, hostHome } = fixture()
    const outsideGit = join(dirname(scopeDir), 'elsewhere', '.git')
    mkdirSync(outsideGit, { recursive: true })

    const launch = prepareRuntimeLaunch({
      runtimeId: 'codex-acp',
      runtime: { command: 'npx', args: ['codex-acp'], env: [] },
      scopeDir,
      cwd,
      runInSandbox: false,
      allowModelToolUnixSockets: true,
      trustedPrimaryCheckout: join(dirname(scopeDir), 'elsewhere'),
      hostEnv: { HOME: hostHome, PATH: '/usr/bin' }
    })

    const profile = JSON.parse(launch.env[CODEX_ACP_PERMISSION_PROFILE_CONFIG_ENV]!) as { configOverrides: string[] }
    expect(profile.configOverrides.join('\n')).not.toContain(realpathSync(outsideGit))
  })

  // The gate widened to "is Codex", so pin that a launch with nothing to carve back still gets no profile.
  it('adds no Codex profile unsandboxed without Git metadata or the credential channel', () => {
    const { scopeDir, cwd, hostHome } = fixture()
    const launch = prepareRuntimeLaunch({
      runtimeId: 'codex-acp',
      runtime: { command: 'npx', args: ['codex-acp'], env: [] },
      scopeDir,
      cwd,
      runInSandbox: false,
      hostEnv: { HOME: hostHome, PATH: '/usr/bin' }
    })

    expect(launch.env[CODEX_ACP_PERMISSION_PROFILE_CONFIG_ENV]).toBeUndefined()
  })

  it('rejects root-level protected paths instead of generating an ineffective policy', () => {
    const { scopeDir, cwd, hostHome } = fixture()
    expect(() =>
      prepareRuntimeLaunch({
        runtimeId: 'maki',
        scopeDir,
        cwd,
        runInSandbox: true,
        daemonRoot: '/',
        sandboxMechanism: 'bwrap',
        hostEnv: { HOME: hostHome, PATH: '/usr/bin' }
      })
    ).toThrow(/unsafe AgentConnect daemon root/)
  })

  it('fails before creating a private HOME when sandboxing is required but unavailable', () => {
    const { scopeDir, cwd } = fixture()

    expect(() => prepareRuntimeLaunch({ runtimeId: 'claude-acp', scopeDir, cwd, runInSandbox: true })).toThrow(
      /no supported Linux SRT\/bwrap/
    )
    expect(existsSync(join(scopeDir, 'home'))).toBe(false)
  })

  it('refuses to sandbox an externalExecution runtime instead of confining a bridge it cannot contain', () => {
    const { scopeDir, cwd } = fixture()

    expect(() =>
      prepareRuntimeLaunch({
        runtimeId: 'openclaw',
        runtime: { command: 'openclaw', args: ['acp'], env: [], externalExecution: true },
        scopeDir,
        cwd,
        runInSandbox: true,
        daemonRoot: '/srv/agentconnect',
        sandboxMechanism: 'bwrap'
      })
    ).toThrow(/external machine-local service/)
    expect(existsSync(join(scopeDir, 'home'))).toBe(false)
  })

  it('downgrades an optional sandbox request for an externalExecution runtime but keeps requireSandbox loud', () => {
    const external: RuntimeDef = { command: 'openclaw', args: ['acp'], env: [], externalExecution: true }
    const ordinary: RuntimeDef = { command: 'hermes', args: ['acp'], env: [] }
    expect(effectiveRunInSandbox(false, true, 'bwrap', external)).toBe(false)
    expect(effectiveRunInSandbox(false, true, 'bwrap', ordinary)).toBe(true)
    // requireSandbox stays true so the launch above throws instead of silently unconfining.
    expect(effectiveRunInSandbox(true, false, 'bwrap', external)).toBe(true)
  })

  it('can isolate HOME for a disposable probe without enabling an OS sandbox', () => {
    const { scopeDir, cwd, hostHome } = fixture()
    const launch = prepareRuntimeLaunch({
      runtimeId: 'maki',
      scopeDir,
      cwd,
      runInSandbox: false,
      isolateHome: true,
      explicitEnv: { AGENT_VALUE: 'yes' },
      hostEnv: { HOME: hostHome, PATH: '/usr/bin' }
    })

    expect(launch.inheritProcessEnv).toBe(false)
    expect(launch.runtimeHome).toBe(join(scopeDir, 'home'))
    expect(launch.env.HOME).toBe(join(scopeDir, 'home'))
    expect(launch.sandbox).toBeUndefined()
  })
})

const runtime = (command: string, args: string[] = ['acp']): RuntimeDef => ({ command, args, env: [] })

describe('composeRuntimeLaunch', () => {
  it('pins Anthropic profile discovery away from the actual sandboxed child HOME', () => {
    const { scopeDir, cwd, hostHome } = fixture()
    const composed = composeRuntimeLaunch({
      runtimeId: 'claude-acp',
      runtime: {
        command: process.execPath,
        args: ['claude-agent-acp'],
        env: [
          { name: 'ANTHROPIC_CONFIG_DIR', value: '/etc/anthropic' },
          { name: 'ANTHROPIC_PROFILE', value: 'corp' },
          { name: 'SAFE_VALUE', value: 'kept' }
        ]
      },
      provider: 'managed',
      scopeDir,
      cwd,
      runInSandbox: true,
      daemonRoot: dirname(scopeDir),
      sandboxMechanism: 'bwrap',
      hostEnv: { HOME: hostHome, PATH: dirname(process.execPath) }
    })
    const childEnv = {
      ...Object.fromEntries(composed.runtime.env.map(({ name, value }) => [name, value])),
      ...composed.launch.env
    }

    expect(composed.launch.inheritProcessEnv).toBe(false)
    const disabledProfileRoot = realpathSync(
      join(scopeDir, '.agentconnect', 'runtime-policy', 'claude-profile-disabled')
    )
    expect(childEnv.ANTHROPIC_CONFIG_DIR).toBe(disabledProfileRoot)
    expect(childEnv.ANTHROPIC_PROFILE).toBeUndefined()
    expect(composed.launch.sandbox?.claudeProtectedSettings?.env).toEqual({
      ANTHROPIC_CONFIG_DIR: disabledProfileRoot,
      ANTHROPIC_PROFILE: 'agentconnect-disabled'
    })
    expect(readdirSync(disabledProfileRoot)).toEqual([])
    expect(childEnv.SAFE_VALUE).toBe('kept')
  })

  it('keeps a Claude launcher symlink under the host HOME readable', () => {
    const testRoot = mkdtempSync(join(tmpdir(), 'ac-claude-launch-roots-'))
    const hostHome = join(testRoot, 'home')
    const bin = join(hostHome, '.local', 'bin')
    const versions = join(hostHome, '.local', 'share', 'claude', 'versions')
    const executable = join(versions, '2.1.220')
    mkdirSync(bin, { recursive: true })
    mkdirSync(versions, { recursive: true })
    writeFileSync(executable, '#!/bin/sh\n')
    chmodSync(executable, 0o755)
    symlinkSync(executable, join(bin, 'claude'))

    try {
      const sandboxAccess = runtimeSandboxReadRoots(runtime(process.execPath, ['claude-acp']), {
        HOME: hostHome,
        PATH: `${bin}${delimiter}${dirname(process.execPath)}`
      })

      expect(sandboxAccess.claudeExecutable).toBe(realpathSync(executable))
      expect(coveredBy(sandboxAccess.readRoots, join(bin, 'claude'))).toBe(true)
    } finally {
      rmSync(testRoot, { recursive: true, force: true })
    }
  })

  it('declares the reviewed memory capability matrix including managed-only Maki', () => {
    expect(runtimeMemoryCapabilities(runtime('hermes'), 'hermes-agent')).toEqual({
      managed: true,
      none: true,
      native: false
    })
    expect(runtimeMemoryCapabilities(runtime('interpreter'), 'open-interpreter')).toEqual({
      managed: true,
      none: true,
      native: false
    })
    expect(runtimeMemoryCapabilities(runtime('kiro-cli'), 'kiro-cli')).toEqual({
      managed: true,
      none: true,
      native: false
    })
    expect(runtimeMemoryCapabilities(runtime('zeroclaw'), 'zeroclaw')).toEqual({
      managed: true,
      none: true,
      native: false
    })
    expect(runtimeMemoryCapabilities(runtime('omp'), 'omp')).toEqual({
      managed: true,
      none: true,
      native: false
    })
    expect(runtimeMemoryCapabilities(runtime('maki'), 'maki')).toEqual({
      managed: true,
      none: false,
      native: false
    })
  })

  it('forces Hermes into a private sanitized home even without OS sandboxing', () => {
    const { scopeDir, cwd, hostHome } = fixture()
    const hostHermes = join(hostHome, '.hermes')
    mkdirSync(hostHermes, { recursive: true })
    writeFileSync(
      join(hostHermes, 'config.yaml'),
      'model: claude-test\nmemory:\n  memory_enabled: true\n  user_profile_enabled: true\n  provider: qdrant\n'
    )

    const composed = composeRuntimeLaunch({
      runtimeId: 'hermes-agent',
      runtime: runtime('hermes'),
      provider: 'managed',
      scopeDir,
      cwd,
      explicitEnv: { HERMES_HOME: '/tmp/escape' },
      hostEnv: { HOME: hostHome, PATH: '/usr/bin' },
      runInSandbox: false
    })

    const privateHermes = join(scopeDir, 'home', '.hermes')
    expect(composed.launch.env.HERMES_HOME).toBe(privateHermes)
    expect(composed.launch.inheritProcessEnv).toBe(false)
    expect(parseYaml(readFileSync(join(privateHermes, 'config.yaml'), 'utf8'))).toEqual({
      model: 'claude-test',
      memory: { memory_enabled: false, user_profile_enabled: false, provider: '' }
    })
    expect(statSync(join(privateHermes, 'config.yaml')).mode & 0o777).toBe(0o600)
  })

  it('applies the Hermes policy to the legacy id even through an opaque wrapper', () => {
    const { scopeDir, cwd, hostHome } = fixture()
    const hostHermes = join(hostHome, '.hermes')
    mkdirSync(hostHermes, { recursive: true })
    writeFileSync(join(hostHermes, 'config.yaml'), 'memory:\n  memory_enabled: true\n')

    const composed = composeRuntimeLaunch({
      runtimeId: 'hermes',
      runtime: runtime('custom-wrapper', ['serve-acp']),
      provider: 'managed',
      scopeDir,
      cwd,
      hostEnv: { HOME: hostHome, PATH: '/usr/bin' },
      runInSandbox: false
    })

    expect(runtimeMemoryCapabilities(runtime('custom-wrapper', ['serve-acp']), 'hermes').none).toBe(true)
    expect(composed.launch.env.HERMES_HOME).toBe(join(scopeDir, 'home', '.hermes'))
    expect(readFileSync(join(composed.launch.env.HERMES_HOME!, 'config.yaml'), 'utf8')).toContain(
      'memory_enabled: false'
    )
  })

  it('appends the Open Interpreter memory override without dropping existing args', () => {
    const { scopeDir, cwd } = fixture()
    const composed = composeRuntimeLaunch({
      runtimeId: 'open-interpreter',
      runtime: runtime('interpreter', ['acp', '--model', 'test']),
      provider: 'none',
      scopeDir,
      cwd,
      runInSandbox: false
    })

    expect(composed.runtime.args).toEqual(['acp', '--model', 'test', '--disable', 'memories'])
  })

  it('writes a private OMP memory-off overlay and appends it last', () => {
    const { scopeDir, cwd } = fixture()
    const composed = composeRuntimeLaunch({
      runtimeId: 'omp',
      runtime: runtime('omp', ['acp', '--config', '/operator/config.yml']),
      provider: 'managed',
      scopeDir,
      cwd,
      runInSandbox: false
    })

    const overlay = composed.runtime.args.at(-1)
    expect(composed.runtime.args.slice(-2)).toEqual(['--config', overlay])
    expect(overlay).toBe(join(scopeDir, '.agentconnect', 'runtime-policy', 'omp-memory-off.yml'))
    expect(parseYaml(readFileSync(overlay!, 'utf8'))).toEqual({ memory: { backend: 'off' } })
    expect(statSync(overlay!).mode & 0o777).toBe(0o600)
  })

  it.each([
    ['kiro-cli', 'kiro-cli'],
    ['zeroclaw', 'zeroclaw']
  ])('accepts the reviewed no-op policy for %s', (runtimeId, command) => {
    const { scopeDir, cwd } = fixture()
    expect(() =>
      composeRuntimeLaunch({
        runtimeId,
        runtime: runtime(command),
        provider: 'none',
        scopeDir,
        cwd,
        runInSandbox: false
      })
    ).not.toThrow()
  })

  it('keeps Maki managed but fails closed for none', () => {
    const { scopeDir, cwd } = fixture()
    const managed = composeRuntimeLaunch({
      runtimeId: 'maki',
      runtime: runtime('maki'),
      provider: 'managed',
      scopeDir,
      cwd,
      runInSandbox: false
    })
    expect(managed.runtime).toEqual(runtime('maki'))
    expect(() =>
      composeRuntimeLaunch({
        runtimeId: 'maki',
        runtime: runtime('maki'),
        provider: 'none',
        scopeDir,
        cwd,
        runInSandbox: false
      })
    ).toThrow(MemoryProviderUnavailableError)

    expect(() =>
      composeRuntimeLaunch({
        runtimeId: 'maki',
        runtime: runtime('omp'),
        provider: 'none',
        scopeDir,
        cwd,
        runInSandbox: false
      })
    ).toThrow(MemoryProviderUnavailableError)
  })
})
