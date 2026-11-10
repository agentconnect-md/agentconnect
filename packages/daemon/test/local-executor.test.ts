import { mkdtemp, realpath, rm } from 'node:fs/promises'
import type { Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SpawnedRuntime } from '../src/acp/spawn-driver.js'
import { microsandboxLauncher } from '../src/execution/executor-vm.js'
import { LocalExecutor } from '../src/execution/local-executor.js'
import type { EnvironmentDescriptor, StrategyLauncher } from '../src/execution/strategies.js'
import { RemoteShimDriver } from '../src/remote/shim-driver.js'
import { daemonSocket, fakeVm, fakeVmManager } from './fixtures/microsandbox-vm.js'

// The in-process executor entry (session-executors.md §11 step 4): a local VM launched, held and bound as any executor's shim is.

const quiet = { trace() {}, debug() {}, info() {}, warn() {}, error() {} }
const REPORTER = `process.stdout.write(JSON.stringify({ cwd: process.cwd(), env: process.env }) + '\\n'); process.stdin.resume()`

const closers: Array<() => unknown> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of closers.splice(0).reverse()) await close()
})

async function fixture(runtimeEnv?: Record<string, string>, servesAgent?: (agentId: string) => boolean) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'local-executor-')))
  const sockets = { mcp: join(root, 'mcp.sock'), agent: join(root, 'agent.sock') }
  const servers: Server[] = [await daemonSocket(sockets.mcp, 'mcp'), await daemonSocket(sockets.agent, 'agent')]
  const environment: EnvironmentDescriptor = { id: 'agent/session-example', mounts: [], workspaceRoot: root }
  const instances = new Map<string, { vm: ReturnType<typeof fakeVm>; fake: ReturnType<typeof fakeVmManager> }>()
  let incarnation = 0
  closers.push(() => rm(root, { recursive: true, force: true }), ...servers.map((server) => () => server.close()))
  const instanceFor = (id: string) => {
    let instance = instances.get(id)
    if (!instance) {
      const guest = join(root, `guest-${++incarnation}`)
      const vm = fakeVm({ mcp: join(guest, 'mcp.sock'), agent: join(guest, 'agent.sock') })
      const fake = fakeVmManager({ vm, ...(runtimeEnv ? { runtimeEnv } : {}) })
      instance = { vm, fake }
      instances.set(id, instance)
      closers.push(
        () => vm.close(),
        () => fake.stop()
      )
    }
    return instance
  }
  const { vm, fake } = instanceFor(environment.id)
  const stopped = vi.fn(async (id: string, instance: ReturnType<typeof instanceFor>) => {
    await instance.fake.stop()
    await instance.vm.close()
    if (instances.get(id) === instance) instances.delete(id)
  })
  const start = vi.fn<StrategyLauncher['start']>(async (input) => {
    const instance = instanceFor(input.environment.id)
    const running = await microsandboxLauncher({ manager: () => instance.fake.manager }).start(input)
    return { ...running, stop: () => stopped(input.environment.id, instance) }
  })
  const launcher: StrategyLauncher = {
    start,
    hold: (environment) => instanceFor(environment.id).fake.manager.hold(environment),
    sameEnvironment: (a, b) => instanceFor(a.id).fake.manager.sameEnvironment(a, b)
  }
  let generation = 0
  const allocated = vi.fn(async (_subject: string) => ++generation)
  const local = new LocalExecutor({
    launcher,
    generations: { nextSandboxGeneration: allocated },
    ...(servesAgent ? { servesAgent } : {}),
    tunnelSocketPath: (tunnel) => (tunnel === 'agent' || tunnel === 'mcp' ? sockets[tunnel] : undefined),
    log: quiet
  })
  closers.push(() => local.stop())
  const launch = (request: { command: string; args: string[]; env?: Record<string, string> }, target = environment) =>
    local.driverFor(target).launch({ ...request, env: { AC_AGENT_ID: 'agent', ...request.env } })
  return { ...fake, vm, local, environment, allocated, launch, root, start, stopped, instanceFor }
}

async function firstLine(runtime: SpawnedRuntime): Promise<{ cwd: string; env: Record<string, string> }> {
  const reader = runtime.fromAgent.getReader()
  let text = ''
  while (!text.includes('\n')) text += Buffer.from((await reader.read()).value!).toString()
  reader.releaseLock()
  return JSON.parse(text.slice(0, text.indexOf('\n'))) as { cwd: string; env: Record<string, string> }
}

describe('a local session through the in-process executor entry', () => {
  it('starts and runs with no control plane: its launcher is called in process and its store allocates the generation', async () => {
    // Nothing here can reach a control plane: the entry is given a launcher, an allocator and this daemon's sockets.
    const { launch, allocated, manager, environment } = await fixture()
    const runtime = await launch({ command: 'cat', args: [], env: { PATH: process.env.PATH ?? '' } })
    await runtime.toAgent.getWriter().write(Buffer.from('hello\n'))
    const reader = runtime.fromAgent.getReader()
    expect(Buffer.from((await reader.read()).value!).toString()).toBe('hello\n')
    reader.releaseLock()
    expect(manager.prepareEnvironment).toHaveBeenCalledWith(environment)
    expect(allocated).toHaveBeenCalledExactlyOnceWith(environment.id)
    await runtime.stop(2_000)
  })

  it("starts a runtime in its workspace root, on the image's environment beneath the launch's", async () => {
    const { launch, root } = await fixture({ PATH: process.env.PATH ?? '', IMAGE_ONLY: 'image', SHARED: 'image' })
    const runtime = await launch({ command: process.execPath, args: ['-e', REPORTER], env: { SHARED: 'launch' } })
    const reported = await firstLine(runtime)
    expect(reported.cwd).toBe(root)
    expect(reported.env).toMatchObject({ IMAGE_ONLY: 'image', SHARED: 'launch', AC_AGENT_ID: 'agent' })
    await runtime.stop(2_000)
  })

  it('holds the environment while a runtime runs or an operation works in it, and gives every hold back', async () => {
    const { local, launch, manager, released, environment } = await fixture()
    const runtime = await launch({ command: 'cat', args: [], env: { PATH: process.env.PATH ?? '' } })
    // The runtime's own hold stays until it exits; the bind's was given back when the bind finished.
    expect(manager.hold.mock.calls.length - released.mock.calls.length).toBe(1)
    await local.withEnvironment(environment, async () => {
      expect(manager.hold.mock.calls.length - released.mock.calls.length).toBeGreaterThanOrEqual(2)
    })
    expect(manager.hold.mock.calls.length - released.mock.calls.length).toBe(1)
    await runtime.stop(2_000)
    expect(manager.hold.mock.calls.length).toBe(released.mock.calls.length)
  })

  it('records one launch for concurrent first uses of an environment', async () => {
    const { local, allocated, environment } = await fixture()
    const [first, second] = await Promise.all([
      local.withEnvironment(environment, async (session) => session),
      local.withEnvironment(environment, async (session) => session)
    ])
    expect(first).toBe(second)
    expect(allocated).toHaveBeenCalledOnce()
  })

  it('releases a canceled preparation without a runtime, keeps another agent held, and permits fresh admission', async () => {
    let served = true
    const { local, environment, manager, released, stopped, instanceFor } = await fixture(
      undefined,
      (agentId) => agentId !== 'agent' || served
    )
    const before = await local.withEnvironment(environment, async (session) => session)
    const driver = local.driverFor(environment)
    await expect(
      local.withEnvironment(environment, async () => {
        throw new Error('preparation canceled')
      })
    ).rejects.toThrow('preparation canceled')
    const unrelated = { ...environment, id: 'other/session-example' }
    let finish!: () => void
    const held = new Promise<void>((resolve) => (finish = resolve))
    closers.push(finish)
    let entered!: () => void
    const working = new Promise<void>((resolve) => (entered = resolve))
    const operation = local.withEnvironment(unrelated, async (session) => {
      entered()
      await held
      return session
    })
    await working
    const other = instanceFor(unrelated.id).fake
    served = false
    const stopping = local.releaseAgent('agent')
    expect(local.sessionFor(environment.id)).toBeUndefined()
    expect(before.isAttached()).toBe(false)
    expect(local.sessionFor(unrelated.id)?.isAttached()).toBe(true)
    await stopping
    expect(stopped.mock.calls.map(([id]) => id)).toEqual([environment.id])
    expect(manager.hold.mock.calls.length).toBe(released.mock.calls.length)
    await expect(driver.launch({ command: 'cat', args: [], env: { AC_AGENT_ID: 'agent' } })).rejects.toThrow(
      'left this member'
    )
    served = true
    const after = await local.withEnvironment(environment, async (session) => session)
    expect(after.generation).toBeGreaterThan(before.generation)
    expect(other.manager.hold.mock.calls.length - other.released.mock.calls.length).toBe(1)
    expect(local.sessionFor(unrelated.id)?.isAttached()).toBe(true)
    finish()
    await operation
  })

  it('fences both the pending generation allocation and callers waiting behind it', async () => {
    const { local, environment, allocated, start } = await fixture()
    let allocate!: () => void
    const allocation = new Promise<void>((resolve) => (allocate = resolve))
    closers.push(allocate)
    const nextGeneration = allocated.getMockImplementation()!
    allocated.mockImplementationOnce(async (subject) => {
      await allocation
      return nextGeneration(subject)
    })
    const work = vi.fn(async () => undefined)
    const first = local.withEnvironment(environment, work)
    const second = local.withEnvironment(environment, work)
    const rejected = Promise.all([
      expect(first).rejects.toThrow('left this member'),
      expect(second).rejects.toThrow('left this member')
    ])
    const stopping = local.releaseAgent('agent')
    allocate()
    await stopping
    await rejected
    expect(start).not.toHaveBeenCalled()
    expect(work).not.toHaveBeenCalled()
    expect(local.sessionFor(environment.id)).toBeUndefined()
    await local.withEnvironment(environment, async () => undefined)
    expect(allocated).toHaveBeenCalledTimes(2)
    expect(start).toHaveBeenCalledOnce()
  })

  it('stops an in-flight start before a fresh acquisition can use the same environment', async () => {
    const { local, environment, start, stopped, manager, released } = await fixture()
    let finishStart!: () => void
    const starting = new Promise<void>((resolve) => (finishStart = resolve))
    closers.push(finishStart)
    let reached!: () => void
    const ready = new Promise<void>((resolve) => (reached = resolve))
    const startEnvironment = start.getMockImplementation()!
    start.mockImplementationOnce(async (input) => {
      const running = await startEnvironment(input)
      reached()
      await starting
      return running
    })
    const work = vi.fn(async () => undefined)
    const preparation = local.withEnvironment(environment, work)
    const rejected = expect(preparation).rejects.toThrow('no longer launched')
    await ready
    const stopping = local.releaseAgent('agent')
    const fresh = local.withEnvironment(environment, async (session) => session)
    expect(start).toHaveBeenCalledOnce()
    expect(manager.hold.mock.calls.length).toBe(released.mock.calls.length)
    finishStart()
    await stopping
    await rejected
    const session = await fresh
    expect(stopped).toHaveBeenCalledOnce()
    expect(start).toHaveBeenCalledTimes(2)
    expect(work).not.toHaveBeenCalled()
    expect(session.isAttached()).toBe(true)
  })

  it('starts a new launch for a changed environment nothing holds, and refuses one while something does', async () => {
    const { local, launch, allocated, environment, manager } = await fixture()
    manager.sameEnvironment.mockImplementation((a, b) => a.mounts.length === b.mounts.length)
    const before = await local.withEnvironment(environment, async (session) => session)
    const changed = { ...environment, mounts: [{ source: '/store', target: '/store', mode: 'writable' as const }] }
    const after = await local.withEnvironment(changed, async (session) => session)
    expect(after).not.toBe(before)
    expect(before.isAttached()).toBe(false)
    expect(allocated).toHaveBeenCalledTimes(2)
    const runtime = await launch({ command: 'cat', args: [], env: { PATH: process.env.PATH ?? '' } }, changed)
    await expect(local.withEnvironment(environment, async () => undefined)).rejects.toThrow(
      'configuration changed while active'
    )
    await runtime.stop(2_000)
  })

  // Git before a session's first runtime starts its environment narrower than that runtime's launch, which must not fail on it.
  it('starts a changed environment once the operations holding the old one end, rather than refusing it', async () => {
    const { local, launch, allocated, environment, manager } = await fixture()
    manager.sameEnvironment.mockImplementation((a, b) => a.mounts.length === b.mounts.length)
    let finish!: () => void
    const working = new Promise<void>((resolve) => (finish = resolve))
    const operation = local.withEnvironment(environment, async (session) => {
      await working
      return session
    })
    await vi.waitFor(() => expect(allocated).toHaveBeenCalledOnce())
    const changed = { ...environment, mounts: [{ source: '/store', target: '/store', mode: 'writable' as const }] }
    let launched = false
    const started = launch({ command: 'cat', args: [], env: { PATH: process.env.PATH ?? '' } }, changed).then(
      (runtime) => {
        launched = true
        return runtime
      }
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(launched).toBe(false)
    finish()
    const before = await operation
    const runtime = await started
    expect(before.isAttached()).toBe(false)
    expect(allocated).toHaveBeenCalledTimes(2)
    await runtime.stop(2_000)
  })

  it("drops a quiet launch's stderr until its runtime exits, and leaves every other launch's alone", async () => {
    const { local, environment, manager, unquiet } = await fixture()
    const env = { AC_AGENT_ID: 'agent', PATH: process.env.PATH ?? '' }
    const loud = await local.driverFor(environment).launch({ command: 'cat', args: [], env })
    expect(manager.quiet).not.toHaveBeenCalled()
    const probe = await local
      .driverFor(environment)
      .launch({ command: 'cat', args: [], env, suppressChildStderr: true })
    expect(manager.quiet).toHaveBeenCalledExactlyOnceWith(environment.id)
    expect(unquiet).not.toHaveBeenCalled()
    await probe.stop(2_000)
    expect(unquiet).toHaveBeenCalledOnce()
    await loud.stop(2_000)
    expect(unquiet).toHaveBeenCalledOnce()
  })

  it('fences the environment when a runtime stop is not confirmed by its exit', async () => {
    const { launch, manager, environment } = await fixture()
    // A runtime the shim never reports ended: its stop returns, and no exit follows.
    vi.spyOn(RemoteShimDriver.prototype, 'launch').mockResolvedValue({
      toAgent: new WritableStream(),
      fromAgent: new ReadableStream(),
      onExit: () => {},
      stop: async () => {}
    })
    const runtime = await launch({ command: 'cat', args: [] })
    await runtime.stop(1)
    expect(manager.stopFailedEnvironment).toHaveBeenCalledExactlyOnceWith(environment.id)
  })

  it('finishes the operations in flight at shutdown and refuses new ones', async () => {
    const { local, environment } = await fixture()
    let finish!: () => void
    const running = local.withEnvironment(
      environment,
      () => new Promise<string>((resolve) => (finish = () => resolve('done')))
    )
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    const stopped = vi.fn()
    const stopping = local.stop().then(stopped)
    await Promise.resolve()
    expect(stopped).not.toHaveBeenCalled()
    await expect(local.withEnvironment(environment, async () => undefined)).rejects.toThrow('shutting down')
    finish()
    await expect(running).resolves.toBe('done')
    await stopping
    expect(stopped).toHaveBeenCalledOnce()
  })
})
