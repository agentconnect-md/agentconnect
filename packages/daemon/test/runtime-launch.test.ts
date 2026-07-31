import { describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { prepareRuntimeLaunch } from '../src/acp/runtime-launch.js'
import { composeRuntimeLaunch } from '../src/runtimes/launch-policy.js'
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

describe('prepareRuntimeLaunch', () => {
  it('carries the daemon broker mask only on an enforced bwrap launch', () => {
    const testRoot = mkdtempSync(join(tmpdir(), 'ac-runtime-mask-'))
    const resolvedRoot = realpathSync(testRoot)
    const repoRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'))
    expect(resolvedRoot.startsWith(repoRoot + sep)).toBe(false)
    const scopeDir = join(testRoot, 'agent')
    const cwd = join(scopeDir, 'workspace')
    const maskedRoots = [join(testRoot, 'broker'), join(testRoot, 'webchat-hosts')]
    mkdirSync(cwd, { recursive: true })
    for (const maskedRoot of maskedRoots) mkdirSync(maskedRoot)
    try {
      const launch = prepareRuntimeLaunch({
        runtimeId: 'claude-acp',
        scopeDir,
        cwd,
        runInSandbox: true,
        sandboxMechanism: 'bwrap',
        maskedReadRoots: maskedRoots
      })
      expect(launch.sandbox?.maskedReadRoots).toEqual(maskedRoots)

      expect(() =>
        prepareRuntimeLaunch({
          runtimeId: 'claude-acp',
          scopeDir,
          cwd,
          runInSandbox: true,
          sandboxMechanism: 'sandbox-exec',
          maskedReadRoots: maskedRoots
        })
      ).toThrow(/mask.*bwrap/i)
    } finally {
      rmSync(testRoot, { recursive: true, force: true })
    }
  })

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
    const launch = prepareRuntimeLaunch({
      runtimeId: 'claude-acp',
      scopeDir,
      cwd,
      runInSandbox: true,
      sandboxMechanism: 'sandbox-exec',
      explicitEnv: { AGENT_VALUE: 'yes' },
      hostEnv: { HOME: hostHome, PATH: '/usr/bin' }
    })

    expect(launch.inheritProcessEnv).toBe(false)
    expect(launch.runtimeHome).toBe(join(scopeDir, 'home'))
    expect(launch.env.HOME).toBe(join(scopeDir, 'home'))
    expect(launch.env.AGENT_VALUE).toBe('yes')
    expect(launch.sandbox?.mechanism).toBe('sandbox-exec')
  })

  it('fails before creating a private HOME when sandboxing is required but unavailable', () => {
    const { scopeDir, cwd } = fixture()

    expect(() => prepareRuntimeLaunch({ runtimeId: 'claude-acp', scopeDir, cwd, runInSandbox: true })).toThrow(
      /no bwrap\/sandbox-exec/
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
