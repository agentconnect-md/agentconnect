import { existsSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { SpawnDriver } from '../src/acp/spawn-driver.js'
import type { RuntimeDef } from '../src/config/config-schema.js'
import type { EnvironmentDescriptor } from '../src/execution/strategies.js'
import { probeImageModels, VM_PROBE_ENVIRONMENT_ID } from '../src/microsandbox/model-probe.js'
import type { ProbeHostPolicy } from '../src/runtimes/runtime-prober.js'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never

function runtime(command: string, env: Record<string, string> = {}): RuntimeDef {
  return { command, args: [], env: Object.entries(env).map(([name, value]) => ({ name, value })) } as RuntimeDef
}

/** A daemon root, a probe directory under it, and a machine HOME that holds no sign-in. */
function fixture() {
  const daemonRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ac-vm-probe-')))
  const hostEnv = { HOME: join(daemonRoot, 'machine'), PATH: '/usr/bin' }
  mkdirSync(hostEnv.HOME)
  return { daemonRoot, root: join(daemonRoot, 'run', 'vm-probe'), hostEnv }
}

/** Every call the probe makes of the machine: the VM it starts and removes, and each runtime it opens through the VM's driver. */
function machine(models: Record<string, string[] | Error>) {
  const calls: string[] = []
  const launched: Array<{ id: string; env: Record<string, string>; cwd: string }> = []
  let started: EnvironmentDescriptor | undefined
  const driver = { launch: vi.fn() } as unknown as SpawnDriver
  return {
    calls,
    launched,
    started: () => started!,
    driver,
    options: {
      start: vi.fn(async (environment: EnvironmentDescriptor) => {
        started = environment
        calls.push(`start ${environment.id}`)
      }),
      driverFor: vi.fn(() => driver),
      discard: vi.fn(async (id: string) => void calls.push(`discard ${id}`)),
      hostFactory: vi.fn((through: SpawnDriver) => {
        expect(through).toBe(driver)
        return (_rt: RuntimeDef, id: string, cwd: string, policy: ProbeHostPolicy) => ({
          start: async () => {
            calls.push(`probe ${id}`)
            launched.push({ id, env: policy.env!, cwd })
            const answer = models[id]
            if (answer instanceof Error) throw answer
          },
          newSession: async () => 'probe-session',
          modelOptions: () => {
            const answer = models[id]
            return Array.isArray(answer) ? { current: answer[0], models: answer } : null
          },
          acpProtocolVersion: () => 1,
          stop: async () => {}
        })
      })
    }
  }
}

describe('the VM strategy’s model probe', () => {
  it('opens every image runtime in one VM, serially, each as its own local VM session would launch it', async () => {
    const { daemonRoot, root, hostEnv } = fixture()
    const vm = machine({ 'runtime-a': ['model-a1', 'model-a2'], 'runtime-b': ['model-b1'] })
    const reported: string[] = []
    const results = await probeImageModels({
      runtimes: { 'runtime-a': runtime('runtime-a-acp'), 'runtime-b': runtime('runtime-b-acp', { B_SETTING: 'on' }) },
      root,
      daemonRoot,
      sandboxEnv: { SHARED_SETTING: 'all' },
      hostEnv,
      log,
      onResult: (result) => reported.push(result.runtime),
      ...vm.options
    })
    expect(results.map(({ runtime, ok, models }) => ({ runtime, ok, models }))).toEqual([
      { runtime: 'runtime-a', ok: true, models: ['model-a1', 'model-a2'] },
      { runtime: 'runtime-b', ok: true, models: ['model-b1'] }
    ])
    expect(reported).toEqual(['runtime-a', 'runtime-b'])
    // What an earlier run left goes first; the VM boots before any runtime's budget starts, and goes after the last.
    expect(vm.calls).toEqual([
      `discard ${VM_PROBE_ENVIRONMENT_ID}`,
      `start ${VM_PROBE_ENVIRONMENT_ID}`,
      'probe runtime-a',
      'probe runtime-b',
      `discard ${VM_PROBE_ENVIRONMENT_ID}`
    ])
    // One VM: every runtime's own workspace and private HOME, and nothing of the machine's HOME.
    const environment = vm.started()
    const [a, b] = vm.launched
    for (const { cwd, env } of [a!, b!]) {
      expect(environment.mounts).toContainEqual({ source: cwd, target: cwd, mode: 'writable' })
      expect(environment.mounts).toContainEqual({ source: env.HOME, target: env.HOME, mode: 'writable' })
      expect(env.AC_AGENT_ID).toBe('probe')
      expect(env.SHARED_SETTING).toBe('all')
    }
    expect(a!.env.HOME).not.toBe(b!.env.HOME)
    expect(b!.env.B_SETTING).toBe('on')
    expect(a!.env.B_SETTING).toBeUndefined()
    expect(environment.mounts.some((mount) => mount.source === hostEnv.HOME)).toBe(false)
    expect(environment.hosted).toBeUndefined()
    expect(existsSync(root)).toBe(false)
  })

  it('binds each runtime’s credential behind its placeholder, and leaves out one that disagrees on a binding', async () => {
    const { daemonRoot, root, hostEnv } = fixture()
    const vm = machine({ 'dsh-acp': ['deepseek-chat'], 'dsh-other': ['deepseek-chat'], 'dsh-same': ['deepseek-chat'] })
    const results = await probeImageModels({
      runtimes: {
        'dsh-acp': runtime('dsh-acp', { DEEPSEEK_API_KEY: 'fixture-deepseek-key-one' }),
        'dsh-other': runtime('/opt/image/bin/dsh-acp', { DEEPSEEK_API_KEY: 'fixture-deepseek-key-two' }),
        'dsh-same': runtime('/opt/image/other/dsh-acp', { DEEPSEEK_API_KEY: 'fixture-deepseek-key-one' })
      },
      root,
      daemonRoot,
      hostEnv,
      log,
      ...vm.options
    })
    expect(results.find((result) => result.runtime === 'dsh-other')).toMatchObject({
      ok: false,
      error: 'another runtime binds a different credential under the same name'
    })
    expect(vm.launched.map(({ id }) => id)).toEqual(['dsh-acp', 'dsh-same'])
    // The guest sees a placeholder; the VM holds the value, once.
    expect(vm.launched[0]!.env.DEEPSEEK_API_KEY).toBe('msb-secret-DEEPSEEK_API_KEY')
    const secrets = vm.started().secrets ?? []
    expect(secrets.map(({ env, placeholder }) => ({ env, placeholder }))).toEqual([
      { env: 'DEEPSEEK_API_KEY', placeholder: 'msb-secret-DEEPSEEK_API_KEY' }
    ])
    expect(secrets[0]!.readValue()).toBe('fixture-deepseek-key-one')
  })

  it('reports a runtime that fails in the VM, and still probes the rest', async () => {
    const { daemonRoot, root, hostEnv } = fixture()
    const vm = machine({ 'runtime-a': new Error('adapter exited'), 'runtime-b': ['model-b1'] })
    const results = await probeImageModels({
      runtimes: { 'runtime-a': runtime('runtime-a-acp'), 'runtime-b': runtime('runtime-b-acp') },
      root,
      daemonRoot,
      hostEnv,
      log,
      ...vm.options
    })
    expect(results.map(({ runtime, ok }) => ({ runtime, ok }))).toEqual([
      { runtime: 'runtime-a', ok: false },
      { runtime: 'runtime-b', ok: true }
    ])
  })

  it('stops at a shutdown, leaving the VM to the manager’s own stop and the next probe', async () => {
    const { daemonRoot, root, hostEnv } = fixture()
    const vm = machine({ 'runtime-a': ['model-a1'], 'runtime-b': ['model-b1'] })
    const shutdown = new AbortController()
    const results = await probeImageModels({
      runtimes: { 'runtime-a': runtime('runtime-a-acp'), 'runtime-b': runtime('runtime-b-acp') },
      root,
      daemonRoot,
      hostEnv,
      log,
      signal: shutdown.signal,
      onResult: () => shutdown.abort(),
      ...vm.options
    })
    expect(results.map(({ runtime }) => runtime)).toEqual(['runtime-a'])
    expect(vm.calls).toEqual([
      `discard ${VM_PROBE_ENVIRONMENT_ID}`,
      `start ${VM_PROBE_ENVIRONMENT_ID}`,
      'probe runtime-a'
    ])
  })
})
