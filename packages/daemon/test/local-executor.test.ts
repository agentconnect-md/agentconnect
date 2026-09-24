import { mkdtemp, realpath, rm } from 'node:fs/promises'
import type { Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SpawnedRuntime } from '../src/acp/spawn-driver.js'
import { microsandboxLauncher } from '../src/execution/executor-vm.js'
import { LocalExecutor } from '../src/execution/local-executor.js'
import type { EnvironmentDescriptor } from '../src/execution/strategies.js'
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

async function fixture(runtimeEnv?: Record<string, string>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'local-executor-')))
  const sockets = { mcp: join(root, 'mcp.sock'), gitcred: join(root, 'gitcred.sock') }
  const servers: Server[] = [await daemonSocket(sockets.mcp, 'mcp'), await daemonSocket(sockets.gitcred, 'gitcred')]
  const vm = fakeVm({ mcp: join(root, 'guest', 'mcp.sock'), gitcred: join(root, 'guest', 'gitcred.sock') })
  const fake = fakeVmManager({ vm, ...(runtimeEnv ? { runtimeEnv } : {}) })
  let generation = 0
  const allocated = vi.fn(async (_subject: string) => ++generation)
  const local = new LocalExecutor({
    launcher: microsandboxLauncher({ manager: () => fake.manager }),
    generations: { nextSandboxGeneration: allocated },
    tunnelSocketPath: (tunnel) => sockets[tunnel],
    log: quiet
  })
  const environment: EnvironmentDescriptor = { id: 'agent/session-example', mounts: [], workspaceRoot: root }
  closers.push(
    () => rm(root, { recursive: true, force: true }),
    ...servers.map((server) => () => server.close()),
    () => vm.close(),
    () => fake.stop(),
    () => local.stop()
  )
  const launch = (request: { command: string; args: string[]; env?: Record<string, string> }, target = environment) =>
    local.driverFor(target).launch({ ...request, env: { AC_AGENT_ID: 'agent', ...request.env } })
  return { ...fake, vm, local, environment, allocated, launch, root }
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
