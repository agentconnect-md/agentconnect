import { mkdtemp, rm } from 'node:fs/promises'
import { connect, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { microsandboxLauncher } from '../src/execution/executor-vm.js'
import { LocalExecutor } from '../src/execution/local-executor.js'
import type { EnvironmentDescriptor } from '../src/execution/strategies.js'
import { startGuestShim } from '../src/microsandbox/shim.js'
import { daemonSocket, exchange, FAKE_SHIM_ARTIFACTS, fakeVm, fakeVmManager } from './fixtures/microsandbox-vm.js'

const closers: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
})

/** A guest client that stays connected, so what its stream goes through across a renewal shows. */
function guestClient(path: string) {
  const socket = connect(path)
  let received = ''
  let closed = false
  socket.on('data', (data) => (received += data.toString()))
  socket.on('close', () => (closed = true))
  socket.on('error', () => {})
  closers.push(() => void socket.destroy())
  return { write: (text: string) => socket.write(text), received: () => received, closed: () => closed }
}

/** A local VM as this daemon drives it (session-executors.md §11 step 4): the real launcher over one fake VM, bound by the in-process entry. */
async function fixture(options: { guestDir?: string; identity?: string; channelTimeoutMs?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ms-shim-'))
  const guest = options.guestDir ?? join(root, 'guest')
  const sockets = { mcp: join(root, 'mcp.sock'), gitcred: join(root, 'gitcred.sock') }
  const servers: Server[] = [await daemonSocket(sockets.mcp, 'mcp'), await daemonSocket(sockets.gitcred, 'gitcred')]
  const guestSockets = { mcp: join(guest, 'mcp.sock'), gitcred: join(guest, 'gitcred.sock') }
  const vm = fakeVm(guestSockets)
  const runtimeStderr = vi.fn()
  const debug = vi.fn()
  const warn = vi.fn()
  const log = { trace: () => {}, debug, info: () => {}, warn, error: () => {} }
  const { manager, stop } = fakeVmManager({
    vm,
    log,
    runtimeStderr,
    ...(options.identity ? { identity: options.identity } : {})
  })
  let generation = 6
  const allocated: string[] = []
  const local = new LocalExecutor({
    launcher: microsandboxLauncher({ manager: () => manager }),
    generations: {
      nextSandboxGeneration: async (subject) => {
        allocated.push(subject)
        return ++generation
      }
    },
    tunnelSocketPath: (tunnel) => sockets[tunnel],
    log,
    ...(options.channelTimeoutMs ? { channelTimeoutMs: options.channelTimeoutMs } : {})
  })
  const environment: EnvironmentDescriptor = { id: 'agent/session-example', mounts: [], workspaceRoot: root }
  closers.push(
    () => rm(root, { recursive: true, force: true }),
    ...servers.map((server) => () => void server.close()),
    () => vm.close(),
    () => stop(),
    () => local.stop()
  )
  const bind = () => local.withEnvironment(environment, async (session) => session)
  return { vm, local, manager, environment, bind, allocated, guestSockets, runtimeStderr, debug, warn }
}

describe('a VM shim, as the manager starts it', () => {
  it('stages as root, starts as the runtime user with the complete-env claim, and takes its identity on stdin', async () => {
    const { vm, bind } = await fixture()
    await bind()
    const [stage, run] = vm.execs
    expect(stage).toMatchObject({ cmd: '/usr/bin/python3', user: '0:0' })
    // The staging step hands the shim's runtime directory to the runtime user, or the shim could not bind a socket in it.
    expect(stage!.args.join(' ')).toContain("os.chmod('/run/agentconnect', 0o700)")
    expect(JSON.parse(stage!.stdin)).toMatchObject({ user: 'agent', files: { 'index.js': expect.any(String) } })
    expect(run).toMatchObject({ args: ['/run/agentconnect-shim-fake/index.js', '--identity-stdin'], user: 'agent' })
    // The complete environment is this starter's own claim; arriving on stdin no longer implies it.
    expect(run!.env).toEqual(expect.arrayContaining(['AC_SHIM_PORT=8085', 'AC_SHIM_COMPLETE_ENV=1']))
    expect(run!.stdin).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  // A hosted session's shim (session-executors.md §6): its holder is on another machine, and nothing here binds it.
  it('starts a hosted shim unbound, without the complete-env claim, with the seed in one variable of its own', async () => {
    const vm = fakeVm({ mcp: '/nonexistent/mcp.sock', gitcred: '/nonexistent/gitcred.sock' })
    closers.push(() => vm.close())
    const guest = await startGuestShim({
      sdk: vm.sdk,
      sandbox: vm.sandbox,
      workspaceRoot: '/workspace',
      completeEnv: false,
      seedEnv: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/home/op/.claude', AC_SHIM_WORKSPACE_ROOT: '/elsewhere' },
      runtimeStderr: () => {},
      artifacts: FAKE_SHIM_ARTIFACTS
    })
    closers.push(() => guest.stop())
    const run = vm.execs[1]!
    const seed = { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/home/op/.claude', AC_SHIM_WORKSPACE_ROOT: '/elsewhere' }
    // The runner fills the seed in beneath a holder's env; as one JSON value it can name none of the shim's own variables.
    expect(run.env).toEqual(
      expect.arrayContaining(['AC_SHIM_WORKSPACE_ROOT=/workspace', `AC_SHIM_SEED_ENV=${JSON.stringify(seed)}`])
    )
    expect(run.env).not.toContain('AC_SHIM_WORKSPACE_ROOT=/elsewhere')
    expect(run.env).not.toContain('CLAUDE_SECURESTORAGE_CONFIG_DIR=/home/op/.claude')
    expect(run.env.filter((entry) => entry.startsWith('AC_SHIM_COMPLETE_ENV'))).toEqual([])
    // What the executor's pipe connects to: agentd's TCP stream to the shim's guest port, which the fake asserts.
    const socket = await guest.connect()
    closers.push(() => void socket.destroy())
    expect(socket.destroyed).toBe(false)
  })

  it('keeps the runtime stderr apart from the shim log it shares a stream with', async () => {
    const { vm, bind, runtimeStderr, debug } = await fixture()
    await bind()
    vm.stderr('[shim] bound as agent\nruntime: star')
    vm.stderr('ting\n[shim] serving tunnel mcp\n')
    await vi.waitFor(() => expect(runtimeStderr).toHaveBeenCalledExactlyOnceWith('runtime: starting\n'))
    expect(debug).toHaveBeenCalledWith('[shim] bound as agent')
    expect(debug).toHaveBeenCalledWith('[shim] serving tunnel mcp')
  })
})

describe('a local VM bound in process (session-executors.md §11 step 4)', () => {
  it("binds at this daemon's own generation with the runtime grants and nothing more", async () => {
    const { bind, allocated, environment } = await fixture()
    const session = await bind()
    // The store's allocator, keyed by the environment id every existing binding already uses: nothing is migrated.
    expect(allocated).toEqual([environment.id])
    expect(session.generation).toBe(7)
    const granted = (['acp', 'materialize', 'tunnel', 'read', 'skills', 'exec', 'automerge', 'probe'] as const).filter(
      (capability) => session.hasCapability(capability)
    )
    expect(granted).toEqual(['acp', 'materialize', 'tunnel', 'read', 'skills', 'exec'])
  })

  it('refuses a shim that presents another identity than the one its VM was started with', async () => {
    const { bind } = await fixture({ identity: 'another-token-entirely-of-the-same-length-xx', channelTimeoutMs: 500 })
    await expect(bind()).rejects.toThrow(/no shim channel bound/)
  })

  it('serves both helper endpoints in the guest, each reaching only its own daemon socket', async () => {
    const { bind, guestSockets } = await fixture()
    await bind()
    expect(await exchange(guestSockets.gitcred, 'get')).toBe('gitcred:get')
    expect(await exchange(guestSockets.mcp, 'tools/list')).toBe('mcp:tools/list')
  })

  it('binds a VM whose helper endpoint cannot be served, and names the tunnel it lacks', async () => {
    // A path that is a file, not a directory: the guest's shim cannot create its socket directory under it.
    const { bind, warn } = await fixture({ guestDir: join(process.execPath, 'not-a-directory') })
    const session = await bind()
    expect(session.isAttached()).toBe(true)
    // The binder's rule for every executor: a missing tunnel degrades one feature rather than refusing the agent.
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/has no (gitcred|mcp) tunnel/))
  })

  it('runs a runtime through the shim in the workspace, carries a write larger than one frame, and ends it on stop', async () => {
    const { local, environment } = await fixture()
    const runtime = await local
      .driverFor(environment)
      .launch({ command: 'cat', args: [], env: { AC_AGENT_ID: 'agent', PATH: process.env.PATH ?? '' } })
    const exited = vi.fn()
    runtime.onExit(exited)
    // A prompt with an inline image: one ND-JSON line, several frames.
    const prompt = Buffer.alloc(700 * 1024, 'a')
    const reader = runtime.fromAgent.getReader()
    const echoed = (async () => {
      let bytes = 0
      while (bytes < prompt.length) bytes += (await reader.read()).value!.byteLength
      return bytes
    })()
    await runtime.toAgent.getWriter().write(prompt)
    expect(await echoed).toBe(prompt.length)
    await runtime.stop(2_000)
    expect(exited).toHaveBeenCalledOnce()
  })

  it('loses no runtime output and no write across a channel renewal', async () => {
    const { vm, local, environment } = await fixture()
    // A runtime that talks on its own clock, so some of its output is produced while no channel is bound.
    const script = `let n = 0; setInterval(() => process.stdout.write('tick ' + ++n + '\\n'), 5); process.stdin.on('data', (d) => process.stdout.write('echo ' + d))`
    const runtime = await local
      .driverFor(environment)
      .launch({ command: process.execPath, args: ['-e', script], env: { AC_AGENT_ID: 'agent', PATH: '' } })
    const session = local.sessionFor(environment.id)!
    const reader = runtime.fromAgent.getReader()
    let output = ''
    const until = async (pattern: RegExp): Promise<void> => {
      while (!pattern.test(output)) output += Buffer.from((await reader.read()).value!).toString()
    }
    await until(/tick 3\n/)
    const attached = new Promise<void>((resolve) => session.onAttach(resolve))
    vm.renew()
    // Written into the gap: the renewal fails this write, and the numbered re-send applies it exactly once.
    await runtime.toAgent.getWriter().write(Buffer.from('mid-renewal\n'))
    await attached
    await until(/echo mid-renewal\n/)
    const last = Number(/tick (\d+)\n(?!.*tick)/s.exec(output)![1])
    await until(new RegExp(`tick ${last + 3}\\n`))
    const ticks = [...output.matchAll(/tick (\d+)\n/g)].map((match) => Number(match[1]))
    expect(ticks).toEqual(ticks.map((_, index) => index + 1))
    expect(output.match(/echo mid-renewal\n/g)).toHaveLength(1)
    await runtime.stop(2_000)
  })

  it('ends a tunnel stream whose daemon-to-guest frame is in flight across a renewal, and keeps an idle one', async () => {
    const { vm, bind, guestSockets } = await fixture()
    const session = await bind()
    const idle = guestClient(guestSockets.mcp)
    idle.write('initialize')
    await vi.waitFor(() => expect(idle.received()).toBe('mcp:initialize'))
    const busy = guestClient(guestSockets.mcp)
    const held = vm.holdNextTunnelFrame()
    busy.write('tools/call')
    // The daemon's reply is inside the guest's shim, not yet written to the client, when the shim hangs up to renew.
    await held.reached
    const attached = new Promise<void>((resolve) => session.onAttach(resolve))
    vm.renew()
    await attached
    await vi.waitFor(() => expect(busy.closed()).toBe(true))
    held.release()
    expect(busy.received()).toBe('')
    idle.write('tools/list')
    await vi.waitFor(() => expect(idle.received()).toBe('mcp:initializemcp:tools/list'))
    expect(idle.closed()).toBe(false)
  })

  it('binds the VM for a day, so its shim does not renew the channel every few minutes', async () => {
    const { vm, bind } = await fixture()
    await bind()
    // The shim renews at half this, and each renewal ends any tunnel stream with a frame in flight.
    expect(vm.binding()?.expiresInSeconds).toBeGreaterThan(23 * 60 * 60)
    expect(vm.binding()?.expiresInSeconds).toBeLessThanOrEqual(24 * 60 * 60)
  })

  it('ends its session, and with it every runtime on it, when the shim process goes away; the next use binds anew', async () => {
    const { vm, local, environment, bind, allocated } = await fixture()
    const runtime = await local
      .driverFor(environment)
      .launch({ command: 'cat', args: [], env: { AC_AGENT_ID: 'agent', PATH: process.env.PATH ?? '' } })
    const exited = vi.fn()
    runtime.onExit(exited)
    const session = local.sessionFor(environment.id)!
    vm.crash()
    await vi.waitFor(() => expect(exited).toHaveBeenCalledOnce())
    expect(session.isAttached()).toBe(false)
    expect(local.sessionFor(environment.id)).toBeUndefined()
    // A new launch of the same environment, at the next generation its store allocates.
    const next = await bind()
    expect(next).not.toBe(session)
    expect(next.generation).toBe(8)
    expect(allocated).toEqual([environment.id, environment.id])
  })
})
