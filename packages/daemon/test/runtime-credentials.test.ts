import { afterEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { prepareRuntimeLaunch } from '../src/launch/prepare.js'
import { CODEX_ACP_PERMISSION_PROFILE_CONFIG_ENV } from '../src/acp/codex-permission-profiles.js'
import { discoverRuntimeCredentials } from '../src/runtimes/runtime-credential-discovery.js'
import { resolveQoderCredentialSources } from '../src/runtimes/runtime-credential-sources.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): { root: string; daemonRoot: string; hostHome: string; scopeDir: string; cwd: string } {
  const root = mkdtempSync(join(tmpdir(), 'ac-shared-login-'))
  roots.push(root)
  const daemonRoot = join(root, 'daemon')
  const hostHome = join(root, 'host')
  const scopeDir = join(daemonRoot, 'agents', 'agent-a')
  const cwd = join(scopeDir, 'workspace')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(hostHome)
  return { root, daemonRoot, hostHome, scopeDir, cwd }
}

function settings(path: string): { filesystem: { allowWrite: string[] } } {
  return JSON.parse(readFileSync(path, 'utf8')) as { filesystem: { allowWrite: string[] } }
}

describe('stored runtime credential discovery', () => {
  it('finds only stored OMP provider records in the configured database, including expired login', () => {
    const { hostHome } = fixture()
    const configDir = join(hostHome, 'custom-omp')
    mkdirSync(configDir)
    const sourcePath = join(configDir, 'agent.db')
    const db = new DatabaseSync(sourcePath)
    db.exec(`
      CREATE TABLE auth_credentials(provider TEXT, credential_type TEXT, data TEXT, disabled_cause TEXT);
      CREATE TABLE history(payload BLOB);
      INSERT INTO history VALUES (zeroblob(3145728));
      INSERT INTO auth_credentials VALUES
        ('anthropic', 'oauth', '{"access":"synthetic-expired","refresh":"synthetic-refresh","expires":1}', 'expired'),
        ('openai', 'api_key', '{"key":"synthetic-key"}', NULL),
        ('invalid', 'api_key', 'not-json', NULL),
        ('empty', 'api_key', '{"key":""}', NULL);
    `)
    db.close()
    expect(discoverRuntimeCredentials('omp', undefined, { HOME: hostHome })).toEqual({ paths: [], providers: [] })
    expect(discoverRuntimeCredentials('omp', undefined, { HOME: hostHome, PI_CODING_AGENT_DIR: configDir })).toEqual({
      paths: [sourcePath],
      providers: ['anthropic', 'openai']
    })
  })

  it('does not create login directories or mistake config files for credentials', () => {
    const { hostHome } = fixture()
    const env = { HOME: hostHome }
    for (const id of ['claude-acp', 'codex-acp', 'qoder-cli', 'qoder-cli-cn']) {
      expect(discoverRuntimeCredentials(id, undefined, env)).toEqual({ paths: [], providers: [] })
    }
    expect(existsSync(join(hostHome, '.claude'))).toBe(false)
    expect(existsSync(join(hostHome, '.codex'))).toBe(false)
    expect(existsSync(join(hostHome, '.qoder'))).toBe(false)
    mkdirSync(join(hostHome, '.claude'))
    writeFileSync(join(hostHome, '.claude', 'settings.json'), '{"theme":"dark"}')
    mkdirSync(join(hostHome, '.codex'))
    writeFileSync(join(hostHome, '.codex', 'auth.json'), '{"last_refresh":"2020-01-01"}')
    expect(discoverRuntimeCredentials('claude-acp', undefined, env).paths).toEqual([])
    expect(discoverRuntimeCredentials('codex-acp', undefined, env).paths).toEqual([])
  })

  it('uses the same Claude secure-storage selection as launch without excluding expired OAuth', () => {
    const { daemonRoot, hostHome, scopeDir, cwd } = fixture()
    const configDir = join(hostHome, '.claude')
    const settingsDir = join(configDir, 'settings-auth')
    const environmentDir = join(configDir, 'environment-auth')
    mkdirSync(settingsDir, { recursive: true })
    mkdirSync(environmentDir)
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify({ env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: settingsDir } })
    )
    const credentials = JSON.stringify({ claudeAiOauth: { accessToken: 'synthetic-expired', expiresAt: 1 } })
    writeFileSync(join(settingsDir, '.credentials.json'), credentials)
    writeFileSync(join(environmentDir, '.credentials.json'), credentials)
    expect(discoverRuntimeCredentials('claude-acp', undefined, { HOME: hostHome })).toEqual({
      paths: [join(settingsDir, '.credentials.json')],
      providers: ['anthropic']
    })
    const env = { HOME: hostHome, CLAUDE_SECURESTORAGE_CONFIG_DIR: environmentDir }
    expect(discoverRuntimeCredentials('claude-acp', undefined, env)).toEqual({
      paths: [join(environmentDir, '.credentials.json')],
      providers: ['anthropic']
    })
    const launch = prepareRuntimeLaunch({
      runtimeId: 'claude-acp',
      scopeDir,
      cwd,
      daemonRoot,
      runInSandbox: true,
      sandboxMechanism: 'bwrap',
      credentialPlatform: 'linux',
      hostEnv: env
    })
    expect(launch.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(realpathSync(environmentDir))
  })

  it('recognizes saved Claude API-key login only in the active global config', () => {
    const { hostHome } = fixture()
    const defaultConfig = join(hostHome, '.claude.json')
    writeFileSync(defaultConfig, '{"primaryApiKey":"synthetic-key"}')
    expect(discoverRuntimeCredentials('claude-acp', undefined, { HOME: hostHome })).toEqual({
      paths: [defaultConfig],
      providers: ['anthropic']
    })
    const configDir = join(hostHome, 'custom-claude')
    mkdirSync(configDir)
    const env = { HOME: hostHome, CLAUDE_CONFIG_DIR: configDir }
    expect(discoverRuntimeCredentials('claude-acp', undefined, env).paths).toEqual([])
    writeFileSync(join(configDir, '.claude.json'), '{"primaryApiKey":"synthetic-key"}')
    expect(discoverRuntimeCredentials('claude-acp', undefined, env).paths).toEqual([join(configDir, '.claude.json')])
    writeFileSync(join(configDir, '.config.json'), '{"additionalModelOptionsCache":[]}')
    expect(discoverRuntimeCredentials('claude-acp', undefined, env).paths).toEqual([])
    writeFileSync(join(configDir, '.config.json'), '{"primaryApiKey":"synthetic-key"}')
    expect(discoverRuntimeCredentials('claude-acp', undefined, env).paths).toEqual([join(configDir, '.config.json')])
  })

  it('recognizes Codex file login and respects CODEX_HOME without falling back to another login', () => {
    const { hostHome } = fixture()
    const defaultDir = join(hostHome, '.codex')
    mkdirSync(defaultDir)
    writeFileSync(join(defaultDir, 'auth.json'), '{"OPENAI_API_KEY":"synthetic-key"}')
    expect(discoverRuntimeCredentials('codex-acp', undefined, { HOME: hostHome })).toEqual({
      paths: [join(defaultDir, 'auth.json')],
      providers: ['openai']
    })
    const configDir = join(hostHome, 'custom-codex')
    mkdirSync(configDir)
    const env = { HOME: hostHome, CODEX_HOME: configDir }
    expect(discoverRuntimeCredentials('codex-acp', undefined, env).paths).toEqual([])
    writeFileSync(
      join(configDir, 'auth.json'),
      '{"tokens":{"refresh_token":"synthetic-expired"},"last_refresh":"2020-01-01"}'
    )
    expect(discoverRuntimeCredentials('custom-codex', { command: 'codex-acp', args: [], env: [] }, env)).toEqual({
      paths: [join(configDir, 'auth.json')],
      providers: ['openai']
    })
    writeFileSync(join(configDir, 'auth.json'), 'not-json')
    expect(discoverRuntimeCredentials('codex-acp', undefined, env).paths).toEqual([])
  })

  it.each(['qoder', 'qoder-cn'] as const)(
    'requires the configured %s user login rather than machine identity',
    (profile) => {
      const { hostHome } = fixture()
      const configDir = join(hostHome, 'custom-qoder')
      const env = { HOME: hostHome, [profile === 'qoder' ? 'QODER_CONFIG_DIR' : 'QODERCN_CONFIG_DIR']: configDir }
      const source = resolveQoderCredentialSources(profile, env)
      const id = profile === 'qoder' ? 'qoder-cli' : 'qoder-cli-cn'
      mkdirSync(source.credentialDir, { recursive: true })
      writeFileSync(join(source.credentialDir, 'machine_id'), 'synthetic-machine')
      expect(discoverRuntimeCredentials(id, undefined, env).paths).toEqual([])
      writeFileSync(source.credentialFile, 'synthetic-encrypted-login')
      expect(discoverRuntimeCredentials(id, undefined, env)).toEqual({
        paths: [source.credentialFile],
        providers: [profile]
      })
      writeFileSync(source.credentialFile, '')
      expect(discoverRuntimeCredentials(id, undefined, env).paths).toEqual([])
    }
  )
})

describe('Linux shared runtime login', () => {
  it('opens only the canonical Git metadata directory to the inner Codex agent', () => {
    const { daemonRoot, hostHome, scopeDir, cwd } = fixture()
    const gitDir = join(cwd, '.git')
    mkdirSync(gitDir)

    const launch = prepareRuntimeLaunch({
      runtimeId: 'codex-acp',
      scopeDir,
      cwd,
      daemonRoot,
      agentsRoot: join(daemonRoot, 'agents'),
      runInSandbox: true,
      sandboxMechanism: 'bwrap',
      credentialPlatform: 'linux',
      hostEnv: { HOME: hostHome, PATH: '/usr/bin' }
    })

    const profileConfig = JSON.parse(launch.env[CODEX_ACP_PERMISSION_PROFILE_CONFIG_ENV]!) as {
      configOverrides: string[]
    }
    const agentFilesystem = profileConfig.configOverrides.find((value) =>
      value.startsWith('permissions.agentconnect-protected-workspace.filesystem=')
    )
    const readOnlyFilesystem = profileConfig.configOverrides.find((value) =>
      value.startsWith('permissions.agentconnect-protected-read-only.filesystem=')
    )
    expect(agentFilesystem).toContain(`${JSON.stringify(realpathSync(gitDir))} = "write"`)
    expect(readOnlyFilesystem).not.toContain(realpathSync(gitDir))
    expect(profileConfig.configOverrides).toContain('features.unified_exec=false')
  })

  it('opens the Codex credential channel even when the outer sandbox is disabled', () => {
    const { scopeDir, cwd } = fixture()
    const launch = prepareRuntimeLaunch({
      runtimeId: 'codex-acp',
      scopeDir,
      cwd,
      runInSandbox: false,
      allowModelToolUnixSockets: true,
      explicitEnv: {
        CODEX_CONFIG: JSON.stringify({
          model: 'gpt-test',
          permissions: { attacker: { extends: ':workspace' } },
          features: { fast_mode: true }
        })
      }
    })

    const profileConfig = JSON.parse(launch.env[CODEX_ACP_PERMISSION_PROFILE_CONFIG_ENV]!) as {
      configOverrides: string[]
      modeProfiles: Record<string, string>
    }
    expect(launch.inheritProcessEnv).toBe(true)
    expect(launch.sandbox).toBeUndefined()
    expect(profileConfig.modeProfiles.agent).toBe('agentconnect-protected-workspace')
    expect(profileConfig.configOverrides).toContain('permissions.agentconnect-protected-workspace.network.enabled=true')
    expect(profileConfig.configOverrides).toContain('permissions.agentconnect-protected-read-only.network.enabled=true')
    expect(JSON.parse(launch.env.CODEX_CONFIG!)).toEqual({ model: 'gpt-test', features: { fast_mode: true } })
  })

  it('trusts the host Claude config directory by default without rewriting its settings', () => {
    const { daemonRoot, hostHome, scopeDir, cwd } = fixture()
    const hostClaude = join(hostHome, '.claude')
    const privateClaude = join(scopeDir, 'home', '.claude')
    mkdirSync(hostClaude)
    mkdirSync(privateClaude, { recursive: true })
    writeFileSync(join(hostClaude, 'settings.json'), '{"theme":"dark"}')
    writeFileSync(join(hostClaude, '.credentials.json'), '{"claudeAiOauth":{"expiresAt":1,"accessToken":"host-old"}}')
    writeFileSync(
      join(privateClaude, '.credentials.json'),
      '{"claudeAiOauth":{"expiresAt":2,"accessToken":"agent-new"}}'
    )

    const launch = prepareRuntimeLaunch({
      runtimeId: 'claude-acp',
      scopeDir,
      cwd,
      daemonRoot,
      agentsRoot: join(daemonRoot, 'agents'),
      runInSandbox: true,
      sandboxMechanism: 'bwrap',
      credentialPlatform: 'linux',
      hostEnv: { HOME: hostHome, PATH: '/usr/bin' }
    })

    const sharedDir = realpathSync(hostClaude)
    expect(launch.env.HOME).toBe(join(scopeDir, 'home'))
    expect(launch.env.CLAUDE_CONFIG_DIR).toBe(join(scopeDir, 'home', '.claude'))
    expect(launch.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(sharedDir)
    expect(JSON.parse(readFileSync(join(hostClaude, 'settings.json'), 'utf8'))).toEqual({ theme: 'dark' })
    expect(readFileSync(join(sharedDir, '.credentials.json'), 'utf8')).toContain('agent-new')
    expect(existsSync(join(privateClaude, '.credentials.json'))).toBe(false)
    expect(settings(launch.sandbox!.settingsPath).filesystem.allowWrite).toContain(sharedDir)
    expect(launch.toolSandbox?.protectedCredentialRoots).toEqual([sharedDir])

    writeFileSync(join(sharedDir, '.credentials.json'), '{"accessToken":"refreshed"}')
    const scopeB = join(daemonRoot, 'agents', 'agent-b')
    const cwdB = join(scopeB, 'workspace')
    mkdirSync(cwdB, { recursive: true })
    const second = prepareRuntimeLaunch({
      runtimeId: 'claude-acp',
      scopeDir: scopeB,
      cwd: cwdB,
      daemonRoot,
      agentsRoot: join(daemonRoot, 'agents'),
      runInSandbox: true,
      sandboxMechanism: 'bwrap',
      credentialPlatform: 'linux',
      hostEnv: { HOME: hostHome, PATH: '/usr/bin' }
    })
    expect(second.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(sharedDir)
    expect(readFileSync(join(sharedDir, '.credentials.json'), 'utf8')).toContain('refreshed')
  })

  it('follows a Claude settings secure-storage directory without moving the default credential', () => {
    const { daemonRoot, hostHome, scopeDir, cwd } = fixture()
    const hostClaude = join(hostHome, '.claude')
    const secureDir = join(hostClaude, 'agentconnect-auth')
    mkdirSync(secureDir, { recursive: true })
    writeFileSync(
      join(hostClaude, 'settings.json'),
      JSON.stringify({ theme: 'dark', env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: secureDir } })
    )
    writeFileSync(join(hostClaude, '.credentials.json'), '{"accessToken":"default-login"}')
    writeFileSync(join(secureDir, '.credentials.json'), '{"accessToken":"isolated-login"}')

    const launch = prepareRuntimeLaunch({
      runtimeId: 'claude-acp',
      scopeDir,
      cwd,
      daemonRoot,
      agentsRoot: join(daemonRoot, 'agents'),
      runInSandbox: true,
      sandboxMechanism: 'bwrap',
      credentialPlatform: 'linux',
      hostEnv: { HOME: hostHome, PATH: '/usr/bin' }
    })

    const canonicalSecureDir = realpathSync(secureDir)
    expect(launch.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(canonicalSecureDir)
    expect(JSON.parse(readFileSync(join(hostClaude, 'settings.json'), 'utf8'))).toEqual({
      theme: 'dark',
      env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: secureDir }
    })
    expect(readFileSync(join(hostClaude, '.credentials.json'), 'utf8')).toContain('default-login')
    expect(readFileSync(join(secureDir, '.credentials.json'), 'utf8')).toContain('isolated-login')
    expect(existsSync(join(scopeDir, 'home', '.claude', 'settings.json'))).toBe(false)
    expect(settings(launch.sandbox!.settingsPath).filesystem.allowWrite).toContain(canonicalSecureDir)
    expect(settings(launch.sandbox!.settingsPath).filesystem.allowWrite).not.toContain(realpathSync(hostClaude))
    expect(launch.toolSandbox?.protectedCredentialRoots).toEqual([canonicalSecureDir])
  })

  it('prefers the daemon environment secure-storage directory over Claude settings', () => {
    const { daemonRoot, hostHome, scopeDir, cwd } = fixture()
    const hostClaude = join(hostHome, '.claude')
    const settingsDir = join(hostClaude, 'settings-auth')
    const environmentDir = join(hostClaude, 'environment-auth')
    mkdirSync(settingsDir, { recursive: true })
    mkdirSync(environmentDir)
    writeFileSync(
      join(hostClaude, 'settings.json'),
      JSON.stringify({ env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: settingsDir } })
    )

    const launch = prepareRuntimeLaunch({
      runtimeId: 'claude-acp',
      scopeDir,
      cwd,
      daemonRoot,
      agentsRoot: join(daemonRoot, 'agents'),
      runInSandbox: true,
      sandboxMechanism: 'bwrap',
      credentialPlatform: 'linux',
      hostEnv: {
        HOME: hostHome,
        PATH: '/usr/bin',
        CLAUDE_SECURESTORAGE_CONFIG_DIR: environmentDir
      }
    })

    expect(launch.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(realpathSync(environmentDir))
  })

  it('refuses a secure-storage override that would reopen the entire host HOME', () => {
    const { daemonRoot, hostHome, scopeDir, cwd } = fixture()

    expect(() =>
      prepareRuntimeLaunch({
        runtimeId: 'claude-acp',
        scopeDir,
        cwd,
        daemonRoot,
        agentsRoot: join(daemonRoot, 'agents'),
        runInSandbox: true,
        sandboxMechanism: 'bwrap',
        credentialPlatform: 'linux',
        hostEnv: {
          HOME: hostHome,
          PATH: '/usr/bin',
          CLAUDE_SECURESTORAGE_CONFIG_DIR: hostHome
        }
      })
    ).toThrow(/would reopen protected path/)
  })

  it('links private Codex homes to the newest shared auth file and preserves the link across refresh', () => {
    const { daemonRoot, hostHome, scopeDir, cwd } = fixture()
    const hostCodex = join(hostHome, '.codex')
    const privateCodex = join(scopeDir, 'home', '.codex')
    mkdirSync(hostCodex)
    mkdirSync(privateCodex, { recursive: true })
    writeFileSync(join(hostCodex, 'auth.json'), '{"last_refresh":"2026-01-01T00:00:00Z","token":"old"}')
    writeFileSync(join(privateCodex, 'auth.json'), '{"last_refresh":"2026-02-01T00:00:00Z","token":"new"}')

    const launch = prepareRuntimeLaunch({
      runtimeId: 'codex-acp',
      scopeDir,
      cwd,
      daemonRoot,
      agentsRoot: join(daemonRoot, 'agents'),
      runInSandbox: true,
      sandboxMechanism: 'bwrap',
      allowModelToolUnixSockets: true,
      credentialPlatform: 'linux',
      explicitEnv: {
        [CODEX_ACP_PERMISSION_PROFILE_CONFIG_ENV]: '{"modeProfiles":{"agent":"attacker"}}',
        CODEX_CONFIG: JSON.stringify({
          model: 'gpt-test',
          default_permissions: 'attacker',
          permissions: { 'agentconnect-protected-workspace': { extends: ':workspace' } },
          'permissions.agentconnect-protected-full-access.filesystem': { ':root': 'write' },
          features: { fast_mode: true }
        })
      },
      hostEnv: { HOME: hostHome, PATH: '/usr/bin' }
    })

    const privateAuth = join(privateCodex, 'auth.json')
    const hostAuth = join(hostCodex, 'auth.json')
    expect(lstatSync(privateAuth).isSymbolicLink()).toBe(true)
    expect(realpathSync(privateAuth)).toBe(realpathSync(hostAuth))
    expect(readFileSync(hostAuth, 'utf8')).toContain('"new"')
    expect(settings(launch.sandbox!.settingsPath).filesystem.allowWrite).toContain(realpathSync(hostAuth))
    const protectedRoots = [realpathSync(hostAuth), realpathSync(privateCodex)]
    expect(launch.toolSandbox?.protectedCredentialRoots).toEqual(protectedRoots)
    const profileConfig = JSON.parse(launch.env[CODEX_ACP_PERMISSION_PROFILE_CONFIG_ENV]!) as {
      configOverrides: string[]
      modeProfiles: Record<string, string>
    }
    expect(profileConfig.modeProfiles.agent).toBe('agentconnect-protected-workspace')
    expect(launch.toolSandbox?.allowModelToolUnixSockets).toBe(true)
    expect(profileConfig.configOverrides).toContain('permissions.agentconnect-protected-workspace.network.enabled=true')
    expect(profileConfig.configOverrides).toContain('permissions.agentconnect-protected-read-only.network.enabled=true')
    expect(JSON.parse(launch.env.CODEX_CONFIG!)).toEqual({
      model: 'gpt-test',
      features: { fast_mode: true }
    })
    const filesystemOverrides = profileConfig.configOverrides.filter((value) => value.includes('filesystem='))
    expect(filesystemOverrides).toHaveLength(3)
    for (const root of protectedRoots) {
      expect(filesystemOverrides.every((value) => value.includes(`${JSON.stringify(root)} = "deny"`))).toBe(true)
    }

    writeFileSync(privateAuth, '{"last_refresh":"2026-03-01T00:00:00Z","token":"refreshed"}')
    expect(lstatSync(privateAuth).isSymbolicLink()).toBe(true)
    expect(readFileSync(hostAuth, 'utf8')).toContain('refreshed')
  })

  it('does not silently choose between divergent Codex credentials with the same refresh generation', () => {
    const { daemonRoot, hostHome, scopeDir, cwd } = fixture()
    const hostCodex = join(hostHome, '.codex')
    const privateCodex = join(scopeDir, 'home', '.codex')
    mkdirSync(hostCodex)
    mkdirSync(privateCodex, { recursive: true })
    writeFileSync(join(hostCodex, 'auth.json'), '{"last_refresh":"2026-01-01T00:00:00Z","token":"host"}')
    writeFileSync(join(privateCodex, 'auth.json'), '{"last_refresh":"2026-01-01T00:00:00Z","token":"agent"}')

    expect(() =>
      prepareRuntimeLaunch({
        runtimeId: 'codex-acp',
        scopeDir,
        cwd,
        daemonRoot,
        runInSandbox: true,
        sandboxMechanism: 'bwrap',
        credentialPlatform: 'linux',
        hostEnv: { HOME: hostHome, PATH: '/usr/bin' }
      })
    ).toThrow(/conflicting Codex credentials/)
    expect(lstatSync(join(privateCodex, 'auth.json')).isSymbolicLink()).toBe(false)
  })

  it.each([
    {
      runtimeId: 'qoder-cli',
      command: 'qodercli',
      configName: '.qoder',
      hostConfigName: '\u00e9-qoder',
      hostConfigNameValue: 'e\u0301-qoder',
      hostConfigNameEnv: 'QODER_CONFIG_DIR_NAME',
      privateConfigEnv: 'QODER_CONFIG_DIR'
    },
    {
      runtimeId: 'qoder-cli-cn',
      command: 'qoderclicn',
      configName: '.qoder-cn',
      hostConfigName: 'custom-qoder-cn',
      hostConfigNameValue: 'custom-qoder-cn',
      hostConfigNameEnv: 'QODERCN_CONFIG_DIR_NAME',
      privateConfigEnv: 'QODERCN_CONFIG_DIR'
    }
  ])(
    'shares refreshable $runtimeId auth while keeping the rest of HOME private',
    ({ runtimeId, command, configName, hostConfigName, hostConfigNameValue, hostConfigNameEnv, privateConfigEnv }) => {
      const { daemonRoot, hostHome, scopeDir, cwd } = fixture()
      const hostConfig = join(hostHome, hostConfigName)
      const sharedAuth = join(hostConfig, '.auth')
      mkdirSync(sharedAuth, { recursive: true })
      writeFileSync(join(hostConfig, 'settings.json'), '{"theme":"dark"}')
      writeFileSync(join(sharedAuth, 'machine_id'), 'host-machine')
      writeFileSync(join(sharedAuth, 'user'), 'host-login')

      const launch = prepareRuntimeLaunch({
        runtimeId,
        runtime: { command, args: ['--acp'], env: [] },
        scopeDir,
        cwd,
        daemonRoot,
        agentsRoot: join(daemonRoot, 'agents'),
        runInSandbox: true,
        sandboxMechanism: 'bwrap',
        credentialPlatform: 'linux',
        hostEnv: { HOME: hostHome, PATH: '/usr/bin', [hostConfigNameEnv]: hostConfigNameValue }
      })

      const privateAuth = join(scopeDir, 'home', configName, '.auth')
      expect(launch.env[privateConfigEnv]).toBe(join(scopeDir, 'home', configName))
      expect(lstatSync(privateAuth).isSymbolicLink()).toBe(true)
      expect(realpathSync(privateAuth)).toBe(realpathSync(sharedAuth))
      expect(readFileSync(join(scopeDir, 'home', configName, 'settings.json'), 'utf8')).toContain('dark')
      expect(settings(launch.sandbox!.settingsPath).filesystem.allowWrite).toContain(realpathSync(sharedAuth))

      writeFileSync(join(privateAuth, 'user'), 'refreshed-login')
      expect(readFileSync(join(sharedAuth, 'user'), 'utf8')).toBe('refreshed-login')
    }
  )

  it('migrates an existing private Qoder login when the host has none', () => {
    const { daemonRoot, hostHome, scopeDir, cwd } = fixture()
    const privateAuth = join(scopeDir, 'home', '.qoder', '.auth')
    mkdirSync(privateAuth, { recursive: true })
    writeFileSync(join(privateAuth, 'machine_id'), 'private-machine')
    writeFileSync(join(privateAuth, 'user'), 'private-login')

    prepareRuntimeLaunch({
      runtimeId: 'qoder-cli',
      runtime: { command: 'qodercli', args: ['--acp'], env: [] },
      scopeDir,
      cwd,
      daemonRoot,
      runInSandbox: true,
      sandboxMechanism: 'bwrap',
      credentialPlatform: 'linux',
      hostEnv: { HOME: hostHome, PATH: '/usr/bin' }
    })

    const sharedAuth = join(hostHome, '.qoder', '.auth')
    expect(lstatSync(privateAuth).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(sharedAuth, 'user'), 'utf8')).toBe('private-login')
    expect(readFileSync(join(sharedAuth, 'machine_id'), 'utf8')).toBe('private-machine')
  })

  it('refuses to replace a divergent host Qoder login with private credentials', () => {
    const { daemonRoot, hostHome, scopeDir, cwd } = fixture()
    const sharedAuth = join(hostHome, '.qoder', '.auth')
    const privateAuth = join(scopeDir, 'home', '.qoder', '.auth')
    mkdirSync(sharedAuth, { recursive: true })
    mkdirSync(privateAuth, { recursive: true })
    writeFileSync(join(sharedAuth, 'user'), 'host-login')
    writeFileSync(join(privateAuth, 'user'), 'private-login')

    expect(() =>
      prepareRuntimeLaunch({
        runtimeId: 'qoder-cli',
        runtime: { command: 'qodercli', args: ['--acp'], env: [] },
        scopeDir,
        cwd,
        daemonRoot,
        runInSandbox: true,
        sandboxMechanism: 'bwrap',
        credentialPlatform: 'linux',
        hostEnv: { HOME: hostHome, PATH: '/usr/bin' }
      })
    ).toThrow(/conflicting qoder credentials/)
    expect(lstatSync(privateAuth).isDirectory()).toBe(true)
  })
})
