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
import { prepareRuntimeLaunch } from '../src/acp/runtime-launch.js'
import { CODEX_ACP_PERMISSION_PROFILE_CONFIG_ENV } from '../src/acp/codex-permission-profiles.js'

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

describe('Linux shared runtime login', () => {
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
    expect(launch.sandbox?.protectedCredentialRoots).toEqual([sharedDir])

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
    expect(launch.sandbox?.protectedCredentialRoots).toEqual([canonicalSecureDir])
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
    expect(launch.sandbox?.protectedCredentialRoots).toEqual(protectedRoots)
    const profileConfig = JSON.parse(launch.env[CODEX_ACP_PERMISSION_PROFILE_CONFIG_ENV]!) as {
      configOverrides: string[]
      modeProfiles: Record<string, string>
    }
    expect(profileConfig.modeProfiles.agent).toBe('agentconnect-protected-workspace')
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
