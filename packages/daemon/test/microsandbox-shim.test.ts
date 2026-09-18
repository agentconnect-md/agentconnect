import { mkdtemp, rm } from 'node:fs/promises'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Backoff } from '@agentconnect.md/connection'
import { decode, encode } from 'cborg'
import type { Sandbox } from 'microsandbox'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startMicrosandboxShim, type MicrosandboxShim } from '../src/microsandbox/shim.js'
import { createRemoteRuntime } from '../src/remote/remote-runtime.js'
import { ShimClient } from '../src/shim/client.js'
import { resolveCommandInPath } from '../src/shim/path-resolve.js'
import { DEFAULT_SHIM_LISTEN_PORT } from '../src/shim/protocol.js'
import { ShimServer } from '../src/shim/server.js'
import { TunnelHost } from '../src/shim/tunnel-host.js'
import type { TunnelName } from '../src/shim/tunnel.js'

const silent = { info: () => {}, warn: () => {} }

interface Frame {
  flags: number
  body: Uint8Array
}

/** Frames one guest-agent stream yields, pushed by the fake guest and pulled by the code under test. */
class FrameQueue {
  private readonly frames: Array<Frame | undefined> = []
  private wake?: () => void

  push(type: string, payload: unknown, terminal = false): void {
    this.frames.push({ flags: terminal ? 1 : 0, body: encode({ v: 7, t: type, p: encode(payload) }) })
    this.wake?.()
  }

  end(): void {
    this.frames.push(undefined)
    this.wake?.()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Frame> {
    for (;;) {
      while (!this.frames.length) await new Promise<void>((resolve) => (this.wake = resolve))
      const frame = this.frames.shift()
      if (!frame) return
      yield frame
    }
  }
}

/** A VM as the shim starter sees it: only the guest agent's exec and TCP streams are faked, and the shim they start and reach is the real one. */
function fakeVm(guestSockets: Record<TunnelName, string>) {
  const execs: Array<{ cmd: string; args: string[]; env: string[]; user: string | null; stdin: string }> = []
  const cleanup: Array<() => void | Promise<void>> = []
  let shimStream: FrameQueue | undefined
  let shimServer: ShimServer | undefined
  let port: number | undefined

  async function startShim(token: string, stream: FrameQueue): Promise<void> {
    const server = new ShimServer()
    const tunnels = new TunnelHost({
      emit: (streamId, event) => client.emit(streamId, event),
      socketPathFor: (tunnel) => guestSockets[tunnel]
    })
    const client = new ShimClient({
      endpoint: 'accepted-daemon-channel',
      dial: () => server.nextTransport(),
      readToken: () => token,
      resolveCommand: resolveCommandInPath,
      podEnv: { PATH: process.env.PATH },
      completeEnv: true,
      handle: async (capability, payload) => {
        if (capability !== 'tunnel') throw new Error(`capability ${capability} is not served by this fake`)
        return tunnels.handle(payload)
      },
      workspaceRoot: '/workspace',
      features: ['cluster-skills-v1', 'cluster-skills-v2', 'cluster-skills-v3'],
      backoff: new Backoff({ baseMs: 5, jitter: () => 0 }),
      log: silent
    })
    shimServer = server
    port = await server.start(0, '127.0.0.1')
    void client.start().catch(() => undefined)
    cleanup.push(
      () => tunnels.close(),
      () => client.stop(),
      () => server.stop()
    )
    shimStream = stream
    stream.push('core.exec.stdout', { data: Buffer.from('ready\n') })
  }

  const sdk = {
    AgentClient: {
      async connectSandbox() {
        let stream: FrameQueue | undefined
        let exec: (typeof execs)[number] | undefined
        let socket: Socket | undefined
        return {
          close: async () => {
            socket?.destroy()
          },
          async stream(_flags: number, body: Uint8Array) {
            const message = decode(body) as { t: string; p: Uint8Array }
            const queue = (stream = new FrameQueue())
            if (message.t === 'core.tcp.connect') {
              expect(decode(message.p)).toEqual({ host: '127.0.0.1', port: DEFAULT_SHIM_LISTEN_PORT })
              const guest = (socket = connect(port!, '127.0.0.1'))
              guest.on('connect', () => queue.push('core.tcp.connected', {}))
              guest.on('data', (data) => queue.push('core.tcp.data', { data }))
              guest.on('close', () => {
                queue.push('core.tcp.closed', {})
                queue.end()
              })
              guest.on('error', () => {})
            } else {
              const request = decode(message.p) as { cmd: string; args: string[]; env: string[]; user: string | null }
              exec = { ...request, stdin: '' }
              execs.push(exec)
              queue.push('core.exec.started', { pid: execs.length })
            }
            return Object.assign(queue, { id: 1 })
          },
          async send(_id: number, _flags: number, body: Uint8Array) {
            const message = decode(body) as { t: string; p: Uint8Array }
            const payload = decode(message.p) as { data?: Uint8Array; signal?: number }
            if (message.t === 'core.tcp.data') socket!.write(payload.data!)
            else if (message.t === 'core.tcp.eof') socket!.end()
            else if (message.t === 'core.exec.signal') stream!.push('core.exec.exited', { code: 137 }, true)
            else if (payload.data!.length) exec!.stdin += Buffer.from(payload.data!).toString()
            else if (exec!.cmd === '/usr/bin/python3') {
              stream!.push('core.exec.stdout', { data: Buffer.from('/run/agentconnect-shim-fake\n') })
              stream!.push('core.exec.exited', { code: 0 }, true)
            } else await startShim(exec!.stdin, stream!)
          }
        }
      }
    }
  } as unknown as Parameters<typeof startMicrosandboxShim>[0]['sdk']
  const sandbox = {
    id: 'vm-1',
    name: 'vm-name',
    config: () => ({ env: [{ key: 'PATH', value: process.env.PATH ?? '' }], runtime: { user: 'agent' } })
  } as unknown as Sandbox
  return {
    sdk,
    sandbox,
    execs,
    /** What the guest's shim process writes to the stderr it shares with the runtime it starts. */
    stderr: (text: string) => shimStream!.push('core.exec.stderr', { data: Buffer.from(text) }),
    /** The shim process ends without being asked to. */
    crash: () => shimStream!.push('core.exec.exited', { code: 1 }, true),
    /** The shim hangs up the way its half-TTL credential renewal does, so the daemon dials again at once. */
    renew: () =>
      (shimServer as unknown as { active: { close: (code: number, reason: string) => void } }).active.close(
        1000,
        'rebinding'
      ),
    close: async () => {
      for (const step of cleanup.splice(0).reverse()) await step()
    }
  }
}

/** One of this daemon's own servers: it names itself in its reply, so a tunnel reaching the wrong one shows. */
async function daemonSocket(path: string, name: string): Promise<Server> {
  const server = createServer((socket) => socket.on('data', (data) => socket.write(`${name}:${data.toString()}`)))
  await new Promise<void>((resolve) => server.listen(path, resolve))
  return server
}

async function exchange(path: string, text: string): Promise<string> {
  const socket = connect(path)
  try {
    socket.write(text)
    return await new Promise<string>((resolve, reject) => {
      socket.once('data', (data) => resolve(data.toString()))
      socket.once('error', reject)
    })
  } finally {
    socket.destroy()
  }
}

const closers: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
})

async function fixture(options: { guestDir?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ms-shim-'))
  const guest = options.guestDir ?? join(root, 'guest')
  const sockets = { mcp: join(root, 'mcp.sock'), gitcred: join(root, 'gitcred.sock') }
  const servers = [await daemonSocket(sockets.mcp, 'mcp'), await daemonSocket(sockets.gitcred, 'gitcred')]
  const guestSockets = { mcp: join(guest, 'mcp.sock'), gitcred: join(guest, 'gitcred.sock') }
  const vm = fakeVm(guestSockets)
  const failed = vi.fn()
  const runtimeStderr = vi.fn()
  const debug = vi.fn()
  let shim: MicrosandboxShim | undefined
  closers.push(
    () => rm(root, { recursive: true, force: true }),
    ...servers.map((server) => () => void server.close()),
    () => vm.close(),
    () => shim?.stop()
  )
  const start = async () =>
    (shim = await startMicrosandboxShim({
      sdk: vm.sdk,
      sandbox: vm.sandbox,
      agentId: 'agent',
      subject: 'agent/session-example',
      workspaceRoot: '/workspace',
      generation: 7,
      sockets,
      runtimeStderr,
      failed,
      log: { trace: () => {}, debug, info: () => {}, warn: () => {}, error: () => {} },
      artifacts: async () => JSON.stringify({ 'index.js': Buffer.from('// shim bundle').toString('base64') })
    }))
  return { vm, start, guestSockets, failed, runtimeStderr, debug }
}

describe('microsandbox shim', () => {
  it('stages as root, starts as the runtime user, and binds with the runtime grants and nothing more', async () => {
    const { vm, start } = await fixture()
    const shim = await start()
    const [stage, run] = vm.execs
    expect(stage).toMatchObject({ cmd: '/usr/bin/python3', user: '0:0' })
    // The staging step hands the shim's runtime directory to the runtime user, or the shim could not bind a socket in it.
    expect(stage!.args.join(' ')).toContain("os.chmod('/run/agentconnect', 0o700)")
    expect(JSON.parse(stage!.stdin)).toMatchObject({ user: 'agent', files: { 'index.js': expect.any(String) } })
    expect(run).toMatchObject({ args: ['/run/agentconnect-shim-fake/index.js', '--identity-stdin'], user: 'agent' })
    expect(run!.env).toEqual(expect.arrayContaining(['AC_SHIM_WORKSPACE_ROOT=/workspace', 'AC_SHIM_PORT=8085']))
    expect(run!.stdin).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(shim.session.generation).toBe(7)
    const granted = (['acp', 'tunnel', 'read', 'skills', 'exec', 'materialize', 'automerge', 'probe'] as const).filter(
      (capability) => shim.session.hasCapability(capability)
    )
    expect(granted).toEqual(['acp', 'tunnel', 'read', 'skills'])
  })

  it('serves both helper endpoints in the guest, each reaching only its own daemon socket', async () => {
    const { start, guestSockets } = await fixture()
    await start()
    expect(await exchange(guestSockets.gitcred, 'get')).toBe('gitcred:get')
    expect(await exchange(guestSockets.mcp, 'tools/list')).toBe('mcp:tools/list')
  })

  it('refuses the VM when a helper endpoint cannot be served', async () => {
    // A path that is a file, not a directory: the guest's shim cannot create its socket directory under it.
    const { start } = await fixture({ guestDir: join(process.execPath, 'not-a-directory') })
    await expect(start()).rejects.toThrow(/ENOTDIR|EEXIST|not a directory/)
  })

  it('runs a runtime through the shim, carries a write larger than one frame, and ends it on stop', async () => {
    const { start } = await fixture()
    const shim = await start()
    const runtime = createRemoteRuntime({
      session: shim.session,
      request: { command: 'cat', args: [], env: { PATH: process.env.PATH ?? '' } },
      cwd: tmpdir(),
      log: silent
    })
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
    const { vm, start } = await fixture()
    const shim = await start()
    // A runtime that talks on its own clock, so some of its output is produced while no channel is bound.
    const script = `let n = 0; setInterval(() => process.stdout.write('tick ' + ++n + '\\n'), 5); process.stdin.on('data', (d) => process.stdout.write('echo ' + d))`
    const runtime = createRemoteRuntime({
      session: shim.session,
      request: { command: process.execPath, args: ['-e', script], env: { PATH: process.env.PATH ?? '' } },
      log: silent
    })
    const reader = runtime.fromAgent.getReader()
    let output = ''
    const until = async (pattern: RegExp): Promise<void> => {
      while (!pattern.test(output)) output += Buffer.from((await reader.read()).value!).toString()
    }
    await until(/tick 3\n/)
    const attached = new Promise<void>((resolve) => shim.session.onAttach(resolve))
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

  it('keeps the runtime stderr apart from the shim log it shares a stream with', async () => {
    const { vm, start, runtimeStderr, debug } = await fixture()
    await start()
    vm.stderr('[shim] bound as agent\nruntime: star')
    vm.stderr('ting\n[shim] serving tunnel mcp\n')
    await vi.waitFor(() => expect(runtimeStderr).toHaveBeenCalledExactlyOnceWith('runtime: starting\n'))
    expect(debug).toHaveBeenCalledWith('[shim] bound as agent')
    expect(debug).toHaveBeenCalledWith('[shim] serving tunnel mcp')
  })

  it('ends its session, and with it every runtime on it, when the shim process goes away', async () => {
    const { vm, start, failed } = await fixture()
    const shim = await start()
    const runtime = createRemoteRuntime({
      session: shim.session,
      request: { command: 'cat', args: [], env: { PATH: process.env.PATH ?? '' } },
      log: silent
    })
    const exited = vi.fn()
    runtime.onExit(exited)
    vm.crash()
    await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce())
    expect(exited).toHaveBeenCalledOnce()
    expect(shim.session.isAttached()).toBe(false)
  })
})
