import { describe, expect, it } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { prepareRuntimeLaunch } from '../src/acp/runtime-launch.js'
import { composeRuntimeLaunch, runtimeSandboxReadRoots } from '../src/runtimes/launch-policy.js'
import { runtimeMemoryCapabilities } from '../src/agents/runtime-memory.js'
import { MemoryProviderUnavailableError } from '../src/agents/memory-provider.js'
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
    mkdirSync(customClaudeConfig)
    const launch = prepareRuntimeLaunch({
      runtimeId: 'claude-acp',
      scopeDir,
      cwd,
      runInSandbox: true,
      daemonRoot: dirname(scopeDir),
      sandboxMechanism: 'bwrap',
      explicitEnv: { AGENT_VALUE: 'yes' },
      hostEnv: { HOME: hostHome, CLAUDE_CONFIG_DIR: customClaudeConfig, PATH: '/usr/bin' }
    })

    expect(launch.inheritProcessEnv).toBe(false)
    expect(launch.runtimeHome).toBe(join(scopeDir, 'home'))
    expect(launch.env.HOME).toBe(join(scopeDir, 'home'))
    expect(launch.env.AGENT_VALUE).toBe('yes')
    expect(launch.sandbox?.mechanism).toBe('bwrap')
    expect(existsSync(launch.sandbox!.settingsPath)).toBe(true)
    const settings = JSON.parse(readFileSync(launch.sandbox!.settingsPath, 'utf8'))
    const canonicalHostHome = realpathSync(hostHome)
    expect(coveredBy(settings.filesystem.denyRead, canonicalHostHome)).toBe(true)
    expect(coveredBy(settings.filesystem.denyRead, realpathSync(customClaudeConfig))).toBe(true)
    expect(coveredBy(settings.filesystem.denyRead, realpathSync(dirname(scopeDir)))).toBe(true)
    expect(settings.filesystem.allowRead).toEqual(
      expect.arrayContaining([realpathSync(cwd), realpathSync(join(scopeDir, 'home'))])
    )
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
    expect(readFileSync(join(composed.launch.env.HERMES_HOME, 'config.yaml'), 'utf8')).toContain(
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
