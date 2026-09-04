import { describe, expect, it } from 'vitest'
import {
  chmodSync,
  existsSync,
  lstatSync,
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
import { effectiveRunInSandbox, prepareRuntimeLaunch, privateRuntimeHomeFor } from '../src/launch/prepare.js'
import { composeRuntimeLaunch, runtimeSandboxReadRoots } from '../src/launch/compose.js'
import { agentHostKey, hostKeyDirName, sessionHostKey } from '../src/acp/host-key.js'
import { sandboxTempDirFor, SANDBOX_TEMP_DIR_ENV } from '../src/acp/sandbox-temp.js'
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

/** One launch's env or write roots without the per-host temp directory, so two hosts stay comparable. */
function withoutTempDir(env: Record<string, string>): Record<string, string>
function withoutTempDir(roots: string[]): string[]
function withoutTempDir(value: Record<string, string> | string[]): Record<string, string> | string[] {
  if (Array.isArray(value)) return value.filter((path) => !/[\\/]t[\\/][0-9a-f]{8}$/.test(path))
  const rest = { ...value }
  for (const name of ['TMPDIR', 'CLAUDE_TMPDIR', 'CLAUDE_CODE_TMPDIR', SANDBOX_TEMP_DIR_ENV]) delete rest[name]
  return rest
}

function coveredBy(paths: string[], target: string): boolean {
  return paths.some((root) => {
    const rel = relative(root, target)
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  })
}

describe('prepareRuntimeLaunch', () => {
  // The grant only exists in the child's argv otherwise; a spawn log line reads it from here.
  it('reports the Git metadata it reopened, on every launch shape', () => {
    const { scopeDir, cwd, hostHome } = fixture()
    const base = {
      runtimeId: 'codex-acp',
      runtime: { command: 'npx', args: ['codex-acp'], env: [] },
      scopeDir,
      cwd,
      daemonRoot: dirname(scopeDir),
      credentialPlatform: 'linux' as const,
      hostEnv: { HOME: hostHome, PATH: '/usr/bin' }
    }
    // A scratch workspace has no `.git`: nothing to reopen, and the field says so rather than lying.
    expect(prepareRuntimeLaunch({ ...base, runInSandbox: false }).gitMetadataWriteRoots).toEqual([])

    const primaryGit = join(cwd, '.git')
    mkdirSync(primaryGit)
    expect(prepareRuntimeLaunch({ ...base, runInSandbox: false }).gitMetadataWriteRoots).toEqual([
      realpathSync(primaryGit)
    ])
    expect(
      prepareRuntimeLaunch({ ...base, runInSandbox: true, sandboxMechanism: 'bwrap' }).gitMetadataWriteRoots
    ).toEqual([realpathSync(primaryGit)])
  })

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

    expect(launch).toEqual({ env: { AGENT_VALUE: 'yes' }, inheritProcessEnv: true, gitMetadataWriteRoots: [] })
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

  it('reopens an operator write root below the hidden host HOME writable, but never HOME itself', () => {
    const { scopeDir, cwd, hostHome } = fixture()
    const store = join(hostHome, '.local', 'share', 'pnpm', 'store')
    mkdirSync(store, { recursive: true })
    const base = {
      runtimeId: 'dsh-acp',
      runtime: { command: process.execPath, args: [], env: [] } as RuntimeDef,
      scopeDir,
      cwd,
      runInSandbox: true,
      daemonRoot: dirname(scopeDir),
      sandboxMechanism: 'bwrap' as const,
      hostEnv: { HOME: hostHome, PATH: dirname(process.execPath) }
    }

    const launch = prepareRuntimeLaunch({ ...base, trustedOperatorWriteRoots: [store] })
    expect(launch.sandbox!.writable).toContain(realpathSync(store))
    expect(launch.sandbox!.allowReadRoots).toContain(realpathSync(store))
    // The host HOME stays hidden around it: only the store is reopened.
    expect(coveredBy(launch.sandbox!.denyReadRoots, realpathSync(hostHome))).toBe(true)

    // The same rule as every other exception: a root that IS a protected boundary reopens it wholesale.
    expect(() => prepareRuntimeLaunch({ ...base, trustedOperatorWriteRoots: [hostHome] })).toThrow(
      /security\.sandboxWriteRoots entry .* would reopen protected path/
    )
    expect(() => prepareRuntimeLaunch({ ...base, trustedOperatorWriteRoots: [dirname(scopeDir)] })).toThrow(
      /would reopen protected path/
    )
    // Without the declaration nothing below the host HOME is writable.
    expect(coveredBy(prepareRuntimeLaunch(base).sandbox!.writable, store)).toBe(false)
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

  /** A confined session's directory (§11) with a primary and a secondary clone, beside a primary checkout that also holds a `.git` — the grant must reach the former and never the latter. */
  function sessionCloneFixture(sessionKey = 'slack:C1:s1') {
    const { scopeDir, hostHome } = fixture()
    const primaryGit = join(scopeDir, 'workspace', '.git')
    mkdirSync(primaryGit, { recursive: true })
    const key = sessionHostKey('bot-a', sessionKey)
    const sessionDir = join(scopeDir, 'sessions', hostKeyDirName(key))
    const cloneGit = join(sessionDir, 'workspace', '.git')
    const secondaryGit = join(sessionDir, 'repos', 'acme', 'infra', '.git')
    mkdirSync(cloneGit, { recursive: true })
    mkdirSync(secondaryGit, { recursive: true })
    return {
      scopeDir,
      hostHome,
      key,
      sessionDir,
      cwd: join(sessionDir, 'workspace'),
      primaryGit,
      cloneGit,
      secondaryGit
    }
  }

  it('grants a confined session its own clones exactly, and never the primary checkout .git', () => {
    const { scopeDir, hostHome, key, sessionDir, cwd, primaryGit, cloneGit, secondaryGit } = sessionCloneFixture()

    const launch = prepareRuntimeLaunch({
      runtimeId: 'codex-acp',
      runtime: { command: 'npx', args: ['codex-acp'], env: [] },
      scopeDir,
      cwd,
      hostKey: key,
      runInSandbox: true,
      daemonRoot: dirname(scopeDir),
      sandboxMechanism: 'bwrap',
      credentialPlatform: 'linux',
      // What the daemon hands a session host: the session directory alone (workspace-manager.ts).
      trustedWorkspaceWriteRoots: [sessionDir],
      trustedPrimaryCheckout: join(scopeDir, 'workspace'),
      hostEnv: { HOME: hostHome, PATH: '/usr/bin' }
    })

    const clones = [realpathSync(cloneGit), realpathSync(secondaryGit)]
    expect([...launch.gitMetadataWriteRoots].sort()).toEqual([...clones].sort())
    const policy = JSON.parse(readFileSync(launch.sandbox!.settingsPath, 'utf8'))
    // Outer sandbox: the session directory is writable, the primary checkout is not.
    expect(coveredBy(policy.filesystem.allowWrite, realpathSync(sessionDir))).toBe(true)
    expect(coveredBy(policy.filesystem.allowWrite, realpathSync(primaryGit))).toBe(false)
    expect(coveredBy(policy.filesystem.allowWrite, realpathSync(join(scopeDir, 'workspace')))).toBe(false)
    for (const gitDir of clones) {
      expect(policy.filesystem.denyWrite).toContain(join(gitDir, 'hooks'))
      expect(policy.filesystem.denyWrite).toContain(join(gitDir, 'config'))
    }
    // Inner Codex profile: the exact per-clone entries, `read` on hooks/config, no worktrees subtree.
    const table = agentFilesystem(launch.env)
    for (const gitDir of clones) {
      expect(table).toContain(`"${gitDir}" = "write"`)
      expect(table).toContain(`"${join(gitDir, 'hooks')}" = "read"`)
      expect(table).toContain(`"${join(gitDir, 'config')}" = "read"`)
    }
    expect(table).not.toContain('worktrees')
    expect(table).not.toContain(realpathSync(primaryGit))
  })

  // §11: the session's HOME lives under its leaf, so runtime state, temp and package caches are the session's alone and go with it.
  it('gives a confined session its own HOME under its leaf, seeded like the agent one and pointed at by the env', () => {
    const { scopeDir, hostHome, key, sessionDir, cwd } = sessionCloneFixture()
    const hostCodex = join(hostHome, '.codex')
    mkdirSync(hostCodex, { recursive: true })
    writeFileSync(join(hostCodex, 'config.toml'), 'model = "seeded"\n')
    writeFileSync(join(hostCodex, 'auth.json'), '{"last_refresh":"2026-01-01T00:00:00Z"}\n')

    const launch = prepareRuntimeLaunch({
      runtimeId: 'codex-acp',
      runtime: { command: 'npx', args: ['codex-acp'], env: [] },
      scopeDir,
      cwd,
      hostKey: key,
      runInSandbox: true,
      daemonRoot: dirname(scopeDir),
      sandboxMechanism: 'bwrap',
      credentialPlatform: 'linux',
      trustedWorkspaceWriteRoots: [sessionDir],
      trustedPrimaryCheckout: join(scopeDir, 'workspace'),
      hostEnv: { HOME: hostHome, PATH: '/usr/bin' }
    })

    const home = join(realpathSync(sessionDir), 'home')
    const agentHome = join(realpathSync(scopeDir), 'home')
    expect(launch.runtimeHome).toBe(home)
    expect(launch.env.HOME).toBe(home)
    expect(launch.env.XDG_CONFIG_HOME).toBe(join(home, '.config'))
    expect(launch.env.XDG_CACHE_HOME).toBe(join(home, '.cache'))
    expect(launch.env.XDG_DATA_HOME).toBe(join(home, '.local', 'share'))
    expect(launch.env.XDG_STATE_HOME).toBe(join(home, '.local', 'state'))
    expect(launch.env.XDG_RUNTIME_DIR).toBe(join(home, '.run'))
    expect(launch.env.CODEX_HOME).toBe(join(home, '.codex'))
    // Seeded as the agent HOME is: config copied in, the credential linked to the shared host file, never copied.
    expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')).toBe('model = "seeded"\n')
    expect(lstatSync(join(home, '.codex', 'auth.json')).isSymbolicLink()).toBe(true)
    expect(realpathSync(join(home, '.codex', 'auth.json'))).toBe(realpathSync(join(hostCodex, 'auth.json')))
    // The agent's own HOME is not this session's: never created for it, and outside its boundary both ways.
    expect(existsSync(agentHome)).toBe(false)
    const policy = JSON.parse(readFileSync(launch.sandbox!.settingsPath, 'utf8'))
    expect(coveredBy(policy.filesystem.allowWrite, agentHome)).toBe(false)
    expect(coveredBy(policy.filesystem.allowRead, agentHome)).toBe(false)
    // What the provider requires of HOME — an exact write root — and the shared credential's own carve-back beside it.
    expect(launch.sandbox!.writable).toContain(home)
    expect(policy.filesystem.allowWrite).toContain(home)
    expect(policy.filesystem.allowWrite).toContain(realpathSync(join(hostCodex, 'auth.json')))
    // Runtime-native protected roots follow: the session .codex is what the inner tool sandbox is denied.
    expect(launch.sandbox!.protectedCredentialRoots).toContain(join(home, '.codex'))
    const profile = JSON.parse(launch.env[CODEX_ACP_PERMISSION_PROFILE_CONFIG_ENV]!) as { configOverrides: string[] }
    const tables = profile.configOverrides.filter((value) => value.includes('.filesystem='))
    expect(tables).toHaveLength(3)
    for (const table of tables) {
      expect(table).toContain(`"${join(home, '.codex')}" = "deny"`)
      expect(table).not.toContain(agentHome)
    }
    // The inner sandbox pins writes to the cwd, and HOME is its SIBLING: without this the package caches §11 puts here are unwritable.
    expect(agentFilesystem(launch.env)).toContain(`"${home}" = "write"`)
    // Only the inner restriction is lifted — the outer boundary already granted exactly this.
    expect(coveredBy(launch.sandbox!.writable, home)).toBe(true)
  })

  // The shared-login credential lives on the HOST and the session `.codex/auth.json` merely LINKS to it, so opening HOME wholesale would write through the link.
  it('denies the session .codex while its HOME is writable, and the host credential it links to', () => {
    const { scopeDir, hostHome, key, sessionDir, cwd } = sessionCloneFixture()
    const hostCodex = join(hostHome, '.codex')
    mkdirSync(hostCodex, { recursive: true })
    writeFileSync(join(hostCodex, 'auth.json'), '{"last_refresh":"2026-01-01T00:00:00Z"}\n')

    const launch = prepareRuntimeLaunch({
      runtimeId: 'codex-acp',
      runtime: { command: 'npx', args: ['codex-acp'], env: [] },
      scopeDir,
      cwd,
      hostKey: key,
      runInSandbox: true,
      daemonRoot: dirname(scopeDir),
      sandboxMechanism: 'bwrap',
      credentialPlatform: 'linux',
      trustedWorkspaceWriteRoots: [sessionDir],
      trustedPrimaryCheckout: join(scopeDir, 'workspace'),
      hostEnv: { HOME: hostHome, PATH: '/usr/bin' }
    })

    const home = join(realpathSync(sessionDir), 'home')
    const table = agentFilesystem(launch.env)
    expect(table).toContain(`"${home}" = "write"`)
    expect(table).toContain(`"${join(home, '.codex')}" = "deny"`)
    // The link target is the ACP parent's own write capability; the model's tools are denied it directly too.
    expect(table).toContain(`"${realpathSync(join(hostCodex, 'auth.json'))}" = "deny"`)
    expect(launch.sandbox!.protectedCredentialRoots).toContain(realpathSync(join(hostCodex, 'auth.json')))
  })

  // The worktree tier's HOME belongs to the AGENT, not one session: opening it would be a cross-session channel, which is what §11 removes.
  it('adds no inner HOME grant for a session on the worktree tier', () => {
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
      hostKey: sessionHostKey('bot-a', 'slack:C1:s1'),
      runInSandbox: true,
      daemonRoot: dirname(scopeDir),
      sandboxMechanism: 'bwrap',
      credentialPlatform: 'linux',
      trustedWorkspaceWriteRoots: [worktrees],
      trustedPrimaryCheckout: join(scopeDir, 'workspace'),
      hostEnv: { HOME: hostHome, PATH: '/usr/bin' }
    })

    expect(launch.env.HOME).toBe(join(scopeDir, 'home'))
    const agentHome = realpathSync(join(scopeDir, 'home'))
    const table = agentFilesystem(launch.env)
    expect(table).toContain(`"${join(agentHome, '.codex')}" = "deny"`)
    expect(table).not.toContain(`"${agentHome}" = "write"`)
  })

  it('follows the session HOME for the Claude config dir and private state roots', () => {
    const { scopeDir, hostHome, key, sessionDir, cwd } = sessionCloneFixture()
    writeFileSync(
      join(hostHome, '.claude.json'),
      JSON.stringify({
        additionalModelOptionsCache: [{ value: 'root-fable', label: 'Root Fable', description: 'test' }],
        mcpToken: 'do-not-copy-global-secret'
      })
    )

    const launch = prepareRuntimeLaunch({
      runtimeId: 'claude-acp',
      runtime: { command: 'npx', args: ['claude-agent-acp'], env: [] },
      scopeDir,
      cwd,
      hostKey: key,
      runInSandbox: true,
      daemonRoot: dirname(scopeDir),
      sandboxMechanism: 'bwrap',
      credentialPlatform: 'linux',
      trustedWorkspaceWriteRoots: [sessionDir],
      trustedPrimaryCheckout: join(scopeDir, 'workspace'),
      hostEnv: { HOME: hostHome, PATH: '/usr/bin' }
    })

    const home = join(realpathSync(sessionDir), 'home')
    expect(launch.env.HOME).toBe(home)
    expect(launch.env.CLAUDE_CONFIG_DIR).toBe(join(home, '.claude'))
    expect(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))).toEqual({
      additionalModelOptionsCache: [{ value: 'root-fable', label: 'Root Fable', description: 'test' }]
    })
    expect(launch.sandbox!.protectedCredentialRoots).toEqual(
      expect.arrayContaining([join(home, '.claude'), join(home, '.claude.json')])
    )
    expect(launch.sandbox!.protectedCredentialRoots.some((root) => root.startsWith(join(scopeDir, 'home')))).toBe(false)
    expect(existsSync(join(scopeDir, 'home'))).toBe(false)
  })

  // A dream or a model session runs on a session-keyed host with no session directory: it keeps the agent HOME, and the rest, exactly.
  it('keeps the agent HOME and policy for a session host that has no session directory', () => {
    const { scopeDir, cwd, hostHome } = fixture()
    const base = {
      runtimeId: 'codex-acp',
      runtime: { command: 'npx', args: ['codex-acp'], env: [] },
      scopeDir,
      cwd,
      runInSandbox: true,
      daemonRoot: dirname(scopeDir),
      sandboxMechanism: 'bwrap' as const,
      credentialPlatform: 'linux' as const,
      trustedPrimaryCheckout: join(scopeDir, 'workspace'),
      hostEnv: { HOME: hostHome, PATH: '/usr/bin' }
    }
    const shared = prepareRuntimeLaunch({ ...base, hostKey: agentHostKey('bot-a') })
    const dream = prepareRuntimeLaunch({ ...base, hostKey: sessionHostKey('bot-a', 'dream:d1') })

    expect(shared.env.HOME).toBe(join(scopeDir, 'home'))
    expect(dream.env.HOME).toBe(join(scopeDir, 'home'))
    // Its own temp directory is the ONE thing a session-keyed host does not share, by construction (#1763).
    expect(dream.env.TMPDIR).not.toBe(shared.env.TMPDIR)
    expect(withoutTempDir(dream.env)).toEqual(withoutTempDir(shared.env))
    expect(withoutTempDir(dream.sandbox!.writable)).toEqual(withoutTempDir(shared.sandbox!.writable))
    expect(readFileSync(dream.sandbox!.settingsPath, 'utf8').replaceAll(dream.env.TMPDIR!, '<temp>')).toBe(
      readFileSync(shared.sandbox!.settingsPath, 'utf8').replaceAll(shared.env.TMPDIR!, '<temp>')
    )
  })

  // The daemon redirects native memory under this HOME before the launch exists, so the two derivations must agree.
  it('names the same HOME for the native-memory redirect as the launch gives the host', () => {
    const { scopeDir, hostHome, key, sessionDir, cwd } = sessionCloneFixture()
    expect(privateRuntimeHomeFor(scopeDir, key)).toBe(join(realpathSync(sessionDir), 'home'))
    expect(privateRuntimeHomeFor(scopeDir, agentHostKey('bot-a'))).toBe(join(scopeDir, 'home'))
    expect(privateRuntimeHomeFor(scopeDir, sessionHostKey('bot-a', 'dream:d1'))).toBe(join(scopeDir, 'home'))
    expect(privateRuntimeHomeFor(scopeDir, undefined)).toBe(join(scopeDir, 'home'))
    const launch = prepareRuntimeLaunch({
      runtimeId: 'codex-acp',
      runtime: { command: 'npx', args: ['codex-acp'], env: [] },
      scopeDir,
      cwd,
      hostKey: key,
      runInSandbox: true,
      daemonRoot: dirname(scopeDir),
      sandboxMechanism: 'bwrap',
      credentialPlatform: 'linux',
      trustedWorkspaceWriteRoots: [sessionDir],
      trustedPrimaryCheckout: join(scopeDir, 'workspace'),
      hostEnv: { HOME: hostHome, PATH: '/usr/bin' }
    })
    expect(launch.env.HOME).toBe(privateRuntimeHomeFor(scopeDir, key))
  })

  // A session with NO directory of its own is on the worktree tier however it is addressed: the same policy for its host key, the agent's, and none at all.
  it('leaves the unconfined policy byte-identical for a session that has no directory of its own', () => {
    const { scopeDir, hostHome } = fixture()
    const primaryGit = join(scopeDir, 'workspace', '.git')
    const cwd = join(scopeDir, 'worktrees', 'session-1')
    mkdirSync(join(primaryGit, 'worktrees', 'session-1'), { recursive: true })
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(cwd, '.git'), `gitdir: ${join(primaryGit, 'worktrees', 'session-1')}\n`)
    const base = {
      runtimeId: 'codex-acp',
      runtime: { command: 'npx', args: ['codex-acp'], env: [] },
      scopeDir,
      cwd,
      runInSandbox: false,
      trustedPrimaryCheckout: join(scopeDir, 'workspace'),
      hostEnv: { HOME: hostHome, PATH: '/usr/bin' }
    }
    const key = sessionHostKey('bot-a', 'slack:C1:s1')
    const before = prepareRuntimeLaunch({ ...base, hostKey: key })

    // Another session's directory is not this one's record and must not reach into its policy.
    mkdirSync(join(scopeDir, 'sessions', hostKeyDirName(sessionHostKey('bot-a', 'slack:C1:s2')), 'workspace', '.git'), {
      recursive: true
    })

    expect(JSON.stringify(prepareRuntimeLaunch({ ...base, hostKey: key }))).toBe(JSON.stringify(before))
    expect(JSON.stringify(prepareRuntimeLaunch({ ...base, hostKey: agentHostKey('bot-a') }))).toBe(
      JSON.stringify(before)
    )
    expect(JSON.stringify(prepareRuntimeLaunch(base))).toBe(JSON.stringify(before))
    // ...and that unchanged policy is still the owner checkout's grant, worktrees subtree included.
    const owner = realpathSync(primaryGit)
    expect(agentFilesystem(before.env)).toContain(`"${owner}" = "write"`)
    expect(agentFilesystem(before.env)).toContain(`"${join(owner, 'worktrees', '**')}" = "write"`)
    expect(before.gitMetadataWriteRoots).toEqual([owner])
  })

  // The tier is the SESSION's, not the boundary's (§11): a confined session whose agent lost its sandbox still runs against its own clones, so an unconfined Codex can write the `.git` it actually stands in.
  it('opens a confined session its own clones, not the primary, when the sandbox is off', () => {
    const { scopeDir, hostHome, key, cwd, primaryGit, cloneGit, secondaryGit } = sessionCloneFixture()

    const launch = prepareRuntimeLaunch({
      runtimeId: 'codex-acp',
      runtime: { command: 'npx', args: ['codex-acp'], env: [] },
      scopeDir,
      cwd,
      hostKey: key,
      runInSandbox: false,
      trustedPrimaryCheckout: join(scopeDir, 'workspace'),
      hostEnv: { HOME: hostHome, PATH: '/usr/bin' }
    })

    expect(launch.gitMetadataWriteRoots).toEqual([realpathSync(cloneGit), realpathSync(secondaryGit)])
    expect(agentFilesystem(launch.env)).toContain(`"${realpathSync(cloneGit)}" = "write"`)
    expect(agentFilesystem(launch.env)).toContain(`"${realpathSync(secondaryGit)}" = "write"`)
    expect(agentFilesystem(launch.env)).toContain(`"${join(realpathSync(cloneGit), 'hooks')}" = "read"`)
    expect(agentFilesystem(launch.env)).not.toContain(realpathSync(primaryGit))
    // Exact entries, never an owner checkout's `worktrees/**`: a clone hangs no worktree off its `.git`.
    expect(agentFilesystem(launch.env)).not.toContain('worktrees/**')
  })

  // The agent's shared host is not a session's: a session directory another session owns must not reach into its worktree-tier policy.
  it('keeps the shared host sandbox policy identical when another session has its own directory', () => {
    const { scopeDir, hostHome } = fixture()
    const primaryGit = join(scopeDir, 'workspace', '.git')
    const worktrees = join(scopeDir, 'worktrees')
    const cwd = join(worktrees, 'session-1')
    mkdirSync(join(primaryGit, 'worktrees', 'session-1'), { recursive: true })
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(cwd, '.git'), `gitdir: ${join(primaryGit, 'worktrees', 'session-1')}\n`)
    const base = {
      runtimeId: 'codex-acp',
      runtime: { command: 'npx', args: ['codex-acp'], env: [] },
      scopeDir,
      cwd,
      hostKey: agentHostKey('bot-a'),
      runInSandbox: true,
      daemonRoot: dirname(scopeDir),
      sandboxMechanism: 'bwrap' as const,
      credentialPlatform: 'linux' as const,
      trustedWorkspaceWriteRoots: [worktrees, join(scopeDir, 'repos')],
      trustedPrimaryCheckout: join(scopeDir, 'workspace'),
      hostEnv: { HOME: hostHome, PATH: '/usr/bin' }
    }
    const first = prepareRuntimeLaunch(base)
    const policyBefore = readFileSync(first.sandbox!.settingsPath, 'utf8')
    const envBefore = JSON.stringify(first.env)

    const other = sessionHostKey('bot-a', 'slack:C1:s2')
    mkdirSync(join(scopeDir, 'sessions', hostKeyDirName(other), 'workspace', '.git'), { recursive: true })

    const second = prepareRuntimeLaunch(base)
    expect(readFileSync(second.sandbox!.settingsPath, 'utf8')).toBe(policyBefore)
    expect(JSON.stringify(second.env)).toBe(envBefore)
    expect(second.env.HOME).toBe(join(scopeDir, 'home'))
    expect(second.gitMetadataWriteRoots).toEqual([realpathSync(primaryGit)])
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
    expect(agentFilesystem(launch.env)).toContain(`"${join(owner, 'worktrees', '**')}" = "write"`)
    expect(agentFilesystem(launch.env)).toContain(`"${join(owner, 'hooks')}" = "read"`)
    expect(agentFilesystem(launch.env)).toContain(`"${join(owner, 'config')}" = "read"`)
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

  // #1763: SRT opens its multiplexer directly under TMPDIR, so a temp dir below a per-session private
  // HOME made that socket path a function of the session leaf too and blew past the AF_UNIX cap. It is
  // a short leaf of the agent dir now — inside the agent dir, so the policy carves it back like any other.
  it("puts the confined child's temp dir in the agent dir and carves exactly it back", () => {
    const { scopeDir, cwd, hostHome } = fixture()
    const hostKey = sessionHostKey('agent-1', 'slack:C0123456789:1730000000.123456')
    const launch = prepareRuntimeLaunch({
      runtimeId: 'claude-acp',
      runtime: { command: 'npx', args: ['claude-agent-acp'], env: [] },
      scopeDir,
      cwd,
      hostKey,
      runInSandbox: true,
      daemonRoot: dirname(scopeDir),
      sandboxMechanism: 'bwrap',
      hostEnv: { HOME: hostHome, PATH: '/usr/bin', TMPDIR: '/tmp' }
    })
    const tempDir = realpathSync(sandboxTempDirFor(scopeDir, hostKey))
    expect(launch.env.TMPDIR).toBe(tempDir)
    expect(launch.env.CLAUDE_TMPDIR).toBe(tempDir)
    expect(launch.env.CLAUDE_CODE_TMPDIR).toBe(tempDir)
    // The provider reads this one rather than recomputing the path from HOME.
    expect(launch.env[SANDBOX_TEMP_DIR_ENV]).toBe(tempDir)
    // Strictly inside the agent dir, which is what lets the boundary keep its rule unbroken.
    expect(coveredBy([realpathSync(scopeDir)], tempDir)).toBe(true)
    expect(tempDir).not.toBe(realpathSync(scopeDir))
    if (process.platform !== 'win32') expect(statSync(tempDir).mode & 0o7777).toBe(0o700)
    // An explicit SRT write root, which is what the provider requires of it.
    expect(launch.sandbox!.writable).toContain(tempDir)
    const settings = JSON.parse(readFileSync(launch.sandbox!.settingsPath, 'utf8'))
    expect(settings.filesystem.allowWrite).toContain(tempDir)
    expect(settings.filesystem.allowRead).toContain(tempDir)
    // The shared temp roots stay denied — nothing about this change reopens them.
    expect(coveredBy(settings.filesystem.denyRead, realpathSync('/tmp'))).toBe(true)
    expect(settings.filesystem.allowRead).not.toContain(realpathSync('/tmp'))
    // Every host of the agent gets its own, so one session's temp state is not another's.
    expect(sandboxTempDirFor(scopeDir, agentHostKey('agent-1'))).not.toBe(sandboxTempDirFor(scopeDir, hostKey))
  })

  // A probe and a model enumerator launch against a disposable scope dir, so their temp directory is
  // a child of the tree they already delete — nothing extra to release when the host stops.
  it("keeps a disposable host's temp dir inside the scope its caller throws away", () => {
    const scopeDir = mkdtempSync(join(tmpdir(), 'ac-probe-scope-'))
    const cwd = join(scopeDir, 'workspace')
    mkdirSync(cwd, { recursive: true })
    const launch = prepareRuntimeLaunch({
      runtimeId: 'claude-acp',
      runtime: { command: 'npx', args: ['claude-agent-acp'], env: [] },
      scopeDir,
      cwd,
      runInSandbox: true,
      isolateHome: true,
      daemonRoot: dirname(scopeDir),
      sandboxMechanism: 'bwrap',
      hostEnv: { HOME: scopeDir, PATH: '/usr/bin' }
    })
    expect(coveredBy([realpathSync(scopeDir)], launch.env.TMPDIR!)).toBe(true)
    rmSync(scopeDir, { recursive: true, force: true })
    expect(existsSync(launch.env.TMPDIR!)).toBe(false)
  })

  it('leaves an unconfined launch on the host temp dir', () => {
    const { scopeDir, cwd, hostHome } = fixture()
    const launch = prepareRuntimeLaunch({
      runtimeId: 'maki',
      scopeDir,
      cwd,
      runInSandbox: false,
      isolateHome: true,
      hostEnv: { HOME: hostHome, PATH: '/usr/bin', TMPDIR: '/tmp' }
    })
    expect(launch.env.TMPDIR).toBe('/tmp')
    expect(launch.env[SANDBOX_TEMP_DIR_ENV]).toBeUndefined()
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

      expect(sandboxAccess.hintExecutables.CLAUDE_CODE_EXECUTABLE).toBe(realpathSync(executable))
      expect(coveredBy(sandboxAccess.readRoots, join(bin, 'claude'))).toBe(true)
    } finally {
      rmSync(testRoot, { recursive: true, force: true })
    }
  })

  // Issue #1689: CODEX_PATH pointed the sandboxed adapter at a global npm install the HOME deny hid.
  it('keeps a Codex executable hint under the host HOME readable', () => {
    const testRoot = mkdtempSync(join(tmpdir(), 'ac-codex-launch-roots-'))
    const hostHome = join(testRoot, 'home')
    const bin = join(hostHome, '.npm-global', 'bin')
    const pkg = join(hostHome, '.npm-global', 'lib', 'node_modules', '@openai', 'codex')
    const executable = join(pkg, 'bin', 'codex.js')
    mkdirSync(bin, { recursive: true })
    mkdirSync(dirname(executable), { recursive: true })
    writeFileSync(join(pkg, 'package.json'), '{"name":"@openai/codex"}')
    writeFileSync(executable, '#!/usr/bin/env node\n')
    chmodSync(executable, 0o755)
    symlinkSync(executable, join(bin, 'codex'))

    try {
      const sandboxAccess = runtimeSandboxReadRoots(
        runtime(process.execPath, ['-y', '@agentconnect.md/codex-acp@agentconnect']),
        {
          HOME: hostHome,
          PATH: [bin, dirname(process.execPath)].join(delimiter)
        }
      )

      expect(sandboxAccess.hintExecutables.CODEX_PATH).toBe(realpathSync(executable))
      expect(coveredBy(sandboxAccess.readRoots, join(bin, 'codex'))).toBe(true)
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
