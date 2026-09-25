import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { HostShim, HostShimInput } from '../src/execution/host-shim.js'
import { localSrtRootName, localSrtRuntimeRoot, srtLauncher, SrtWorkspaceFs } from '../src/execution/srt-local.js'
import type { EnvironmentDescriptor } from '../src/execution/strategies.js'
import { confinedSessionDirOf } from '../src/workspace/session-layout.js'
import { localWorkspaceFs, type WorkspaceFs } from '../src/workspace/workspace-fs.js'

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
  const launcher = srtLauncher(
    DAEMON,
    { agentsRoot: join('/srv', 'agents'), readRoots: () => ['/usr/local/lib/node'], now: () => clock },
    async (input) => {
      inputs.push(input)
      let exit!: () => void
      const exited = new Promise<{ code: number | null; signal: null }>(
        (resolve) => (exit = () => resolve({ code: 0, signal: null }))
      )
      const leaf = input.runtimeRootName ?? `hosted-${inputs.length}`
      const shim: HostShim = {
        socketPath: join(DAEMON, 'hs', leaf, 'shim.sock'),
        runtimeRoot: join(DAEMON, 'hs', leaf),
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
  )
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

  // A running boundary serves any request it already grants — the session's Git while its runtime is up — and nothing more.
  it('serves a request the running environment already grants, and treats one that mounts anything more as another', () => {
    const { launcher } = stubbed()
    const same = launcher.sameEnvironment!
    const host = environment({
      mounts: [
        { source: SESSION, target: SESSION, mode: 'writable' },
        { source: '/srv/data', target: '/srv/data', mode: 'readonly' }
      ]
    })
    expect(same(host, environment({ mounts: [...host.mounts].reverse() }))).toBe(true)
    // Git needs the session directory alone, which the policy grants whatever the mounts name.
    expect(same(host, environment({ mounts: [] }))).toBe(true)
    // A writable grant serves a read request, never the other way round.
    expect(same(host, environment({ mounts: [{ source: SESSION, target: SESSION, mode: 'readonly' }] }))).toBe(true)
    expect(same(environment({ mounts: [] }), host)).toBe(false)
    expect(same(host, environment({ mounts: [{ source: '/srv/data', target: '/srv/data', mode: 'writable' }] }))).toBe(
      false
    )
    expect(same(host, environment({ id: 'agent-1/session-76543210fedcba9876543210' }))).toBe(false)
    // A mount grants its whole tree, and still only in its own mode.
    const inside = (path: string, mode: 'writable' | 'readonly') =>
      environment({ mounts: [{ source: path, target: path, mode }] })
    expect(same(host, inside(join(SESSION, 'workspace'), 'writable'))).toBe(true)
    expect(same(host, inside('/srv/data/sub', 'readonly'))).toBe(true)
    expect(same(host, inside('/srv/data/sub', 'writable'))).toBe(false)
    expect(same(host, inside('/srv/elsewhere', 'readonly'))).toBe(false)
    // A boundary anchored at one start serves no request that names another.
    expect(same(host, environment({ cwd: SESSION }))).toBe(true)
    expect(same(host, environment({ cwd: join(SESSION, 'workspace') }))).toBe(false)
  })

  it('starts a hosted environment on a random root with its holder seed, outside the local lifecycle', async () => {
    const { launcher, inputs, stops } = stubbed()
    const hosted = await launcher.start({
      environment: { ...environment(), id: 'executor/session-0123456789abcdef01234567', hosted: { env: { A: 'b' } } },
      log: quiet
    })
    expect(inputs[0]).toMatchObject({ seedEnv: { A: 'b' } })
    expect(inputs[0]!.runtimeRootName).toBeUndefined()
    expect(inputs[0]!.completeEnv).toBeUndefined()
    // The pipe proves a hosted peer, so no token is compared in process.
    expect(hosted.local).toBeUndefined()
    await launcher.stopAll()
    expect(stops).toEqual([])
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

describe("a confined session's files", () => {
  // A path strictly inside the session directory crosses its shim; the directory itself, which the shim runs in, and all else stay here.
  it('routes a path inside the session directory to its shim, and the directory itself, a path outside and a move across the edge to this disk', async () => {
    const shimmed: string[] = []
    const renames: string[] = []
    const shimFs: WorkspaceFs = Object.assign(Object.create(localWorkspaceFs) as WorkspaceFs, {
      stat: async (path: string) => (shimmed.push(path), 'dir' as const),
      rename: async (from: string) => void renames.push(from)
    })
    const fs = new SrtWorkspaceFs(
      (path) => (path.startsWith(SESSION) ? environment() : undefined),
      () => shimFs
    )
    await fs.stat(join(SESSION, 'workspace', 'a.txt'))
    expect(shimmed).toEqual([join(SESSION, 'workspace', 'a.txt')])
    // Real paths on this disk are checked here, not over the shim.
    await fs.stat(SESSION)
    await fs.stat(join(DAEMON, 'agents', 'a', 'canonical'))
    expect(shimmed).toHaveLength(1)
    await fs.rename(join(SESSION, 'workspace.clone-x'), join(SESSION, 'workspace'))
    expect(renames).toEqual([join(SESSION, 'workspace.clone-x')])
  })

  it('finds the confined session directory a path is in, and nothing for a path outside one', async () => {
    const agentRoot = await mkdtemp(join(tmpdir(), 'ac-srt-local-'))
    try {
      const session = join(agentRoot, 'sessions', 'session-0123456789abcdef01234567')
      await mkdir(join(session, 'workspace'), { recursive: true })
      expect(confinedSessionDirOf(agentRoot, join(session, 'workspace', 'a.txt'))).toBe(session)
      expect(confinedSessionDirOf(agentRoot, session)).toBe(session)
      expect(confinedSessionDirOf(agentRoot, join(agentRoot, 'sessions'))).toBeUndefined()
      expect(
        confinedSessionDirOf(agentRoot, join(agentRoot, 'sessions', 'session-76543210fedcba9876543210'))
      ).toBeUndefined()
      expect(confinedSessionDirOf(agentRoot, join(agentRoot, 'sessions', 'not-a-session', 'x'))).toBeUndefined()
      expect(confinedSessionDirOf(agentRoot, join(tmpdir(), 'elsewhere'))).toBeUndefined()
    } finally {
      await rm(agentRoot, { recursive: true, force: true })
    }
  })
})
