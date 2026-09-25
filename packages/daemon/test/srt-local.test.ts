import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { HostShim, HostShimInput } from '../src/execution/host-shim.js'
import { localSrtLauncher, localSrtRootName, localSrtRuntimeRoot } from '../src/execution/srt-local.js'
import type { EnvironmentDescriptor } from '../src/execution/strategies.js'

// session-executors.md §11: a confined srt session runs in its session directory's SRT-wrapped shim, bound in process.
const quiet = { trace() {}, debug() {}, info() {}, warn() {}, error() {} }
const DAEMON = join('/d')
const SESSION = join(DAEMON, 'agents', 'a', 'sessions', 'session-0123456789abcdef01234567')
const environment = (over: Partial<EnvironmentDescriptor> = {}): EnvironmentDescriptor => ({
  id: 'agent-1/session-0123456789abcdef01234567',
  workspaceRoot: SESSION,
  mounts: [{ source: SESSION, target: SESSION, mode: 'writable' }],
  ...over
})

/** The launcher over a stubbed shim start: what each start was asked for, and a shim that stops when told. */
function stubbed() {
  const inputs: HostShimInput[] = []
  const stops: string[] = []
  let clock = 1_000
  const launcher = localSrtLauncher({
    daemonRoot: DAEMON,
    agentsRoot: join('/srv', 'agents'),
    readRoots: () => ['/usr/local/lib/node'],
    now: () => clock,
    start: async (input) => {
      inputs.push(input)
      let exit!: () => void
      const exited = new Promise<{ code: number | null; signal: null }>(
        (resolve) => (exit = () => resolve({ code: 0, signal: null }))
      )
      const shim: HostShim = {
        socketPath: join(DAEMON, 'hs', input.runtimeRootName!, 'shim.sock'),
        runtimeRoot: join(DAEMON, 'hs', input.runtimeRootName!),
        helperRoot: '/opt/example/dist',
        workspaceRoot: input.workspaceRoot,
        token: `token-${inputs.length}`,
        missingHelpers: [],
        exited,
        quiet: () => () => {},
        stop: async () => {
          stops.push(input.workspaceRoot)
          exit()
          await exited
        }
      }
      return shim
    }
  })
  return { launcher, inputs, stops, advance: (ms: number) => (clock += ms) }
}

describe('the local srt launcher', () => {
  it("starts one SRT-wrapped shim per environment at its fixed runtime root, with this daemon's complete env", async () => {
    const { launcher, inputs } = stubbed()
    const started = await launcher.start({ environment: environment(), log: quiet })
    expect(inputs).toHaveLength(1)
    expect(inputs[0]).toMatchObject({
      daemonRoot: DAEMON,
      workspaceRoot: SESSION,
      runtimeRootName: localSrtRootName('agent-1/session-0123456789abcdef01234567'),
      completeEnv: true
    })
    expect(inputs[0]!.boundary).toBeDefined()
    // Its launch named the shim's sockets before it started, so the root is the one a launch derives from the id.
    expect(started.runtimeRoot).toBe(localSrtRuntimeRoot(DAEMON, 'agent-1/session-0123456789abcdef01234567'))
    // Bound in process: the dial compares the shim's token, and the launch env is complete on its own.
    expect(started.local).toMatchObject({ identity: 'token-1', runtimeEnv: {} })
    expect(localSrtRootName('agent-1/session-0123456789abcdef01234567')).toMatch(/^[a-f0-9]{12}$/)
  })

  it('treats a descriptor that mounts anything else as another environment', () => {
    const { launcher } = stubbed()
    const same = launcher.sameEnvironment!
    expect(same(environment(), environment())).toBe(true)
    const reordered = environment({
      mounts: [
        { source: '/srv/data', target: '/srv/data', mode: 'readonly' },
        { source: SESSION, target: SESSION, mode: 'writable' }
      ]
    })
    expect(same(reordered, environment({ mounts: [...reordered.mounts].reverse() }))).toBe(true)
    expect(same(environment(), reordered)).toBe(false)
    expect(same(environment(), environment({ id: 'agent-1/session-76543210fedcba9876543210' }))).toBe(false)
  })

  it('stops an idle environment only once nothing holds it and nothing used it since the cutoff', async () => {
    const { launcher, stops, advance } = stubbed()
    await launcher.start({ environment: environment(), log: quiet })
    const release = launcher.hold!(environment())
    advance(60_000)
    await launcher.suspendIdle(10_000_000)
    expect(stops).toEqual([])
    release()
    // Released now: used just now, so a cutoff before this moment keeps it.
    await launcher.suspendIdle(1_000)
    expect(stops).toEqual([])
    advance(60_000)
    await launcher.suspendIdle(10_000_000)
    expect(stops).toEqual([SESSION])
  })

  it("stops the environment its host left unless something still holds it, and a replaced workspace's others", async () => {
    const { launcher, stops } = stubbed()
    const other = environment({
      id: 'agent-1/session-76543210fedcba9876543210',
      workspaceRoot: join(DAEMON, 'agents', 'a', 'sessions', 'session-76543210fedcba9876543210')
    })
    await launcher.start({ environment: environment(), log: quiet })
    await launcher.start({ environment: other, log: quiet })
    const release = launcher.hold!(environment())
    expect(await launcher.stopUnlessBusy(environment().id)).toBe(false)
    release()
    expect(await launcher.stopUnlessBusy(environment().id)).toBe(true)
    expect(stops).toEqual([SESSION])
    // Nothing running is nothing to stop.
    expect(await launcher.stopUnlessBusy(environment().id)).toBe(true)
    await launcher.stopMatching((id) => id !== environment().id)
    expect(stops).toEqual([SESSION, other.workspaceRoot])
  })

  // The in-process entry holds a launch before it starts it, so a session's first runtime is held from before its shim exists.
  it('counts a hold taken before the shim starts, so neither the idle sweep nor its host stop ends a running first runtime', async () => {
    const { launcher, stops, advance } = stubbed()
    const release = launcher.hold!(environment())
    await launcher.start({ environment: environment(), log: quiet })
    advance(60_000)
    await launcher.suspendIdle(10_000_000)
    expect(await launcher.stopUnlessBusy(environment().id)).toBe(false)
    expect(stops).toEqual([])
    release()
    expect(await launcher.stopUnlessBusy(environment().id)).toBe(true)
    expect(stops).toEqual([SESSION])
  })

  // A changed descriptor is another environment on the same fixed root, which the entry starts once nothing holds the old launch.
  it('stops the shim it started before under an id it starts again, which still owns the fixed root', async () => {
    const { launcher, inputs, stops } = stubbed()
    await launcher.start({ environment: environment(), log: quiet })
    const changed = environment({
      mounts: [...environment().mounts, { source: '/srv/data', target: '/srv/data', mode: 'readonly' }]
    })
    const started = await launcher.start({ environment: changed, log: quiet })
    expect(stops).toEqual([SESSION])
    expect(inputs.map((input) => input.runtimeRootName)).toEqual([
      localSrtRootName(environment().id),
      localSrtRootName(environment().id)
    ])
    expect(started.local?.identity).toBe('token-2')
  })
})
