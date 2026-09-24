// A VM as the shim starter sees it: only the guest agent's exec and TCP streams are faked, and the shim they start and reach is the real one.
import { connect, createServer, type Server, type Socket } from 'node:net'
import { Backoff } from '@agentconnect.md/connection'
import { decode, encode } from 'cborg'
import type { Sandbox } from 'microsandbox'
import { expect, vi } from 'vitest'
import type { EnvironmentDescriptor } from '../../src/execution/strategies.js'
import type { Logger } from '../../src/log.js'
import type { MicrosandboxManager } from '../../src/microsandbox/driver.js'
import { startGuestShim, type GuestShim } from '../../src/microsandbox/shim.js'
import { ShimClient } from '../../src/shim/client.js'
import { resolveCommandInPath } from '../../src/shim/path-resolve.js'
import { DEFAULT_SHIM_LISTEN_PORT } from '../../src/shim/protocol.js'
import { ShimServer } from '../../src/shim/server.js'
import { TunnelHost } from '../../src/shim/tunnel-host.js'
import type { TunnelName } from '../../src/shim/tunnel.js'

const silent = { info: () => {}, warn: () => {} }

/** The artifacts a test stages: a stand-in bundle, since the shim the fake starts is this process's own. */
export const FAKE_SHIM_ARTIFACTS = async () =>
  JSON.stringify({ 'index.js': Buffer.from('// shim bundle').toString('base64') })

interface Frame {
  flags: number
  body: Uint8Array
}

/** Frames one guest-agent stream yields, pushed by the fake guest and pulled by the code under test. */
class FrameQueue {
  private readonly frames: Array<Frame | undefined> = []
  private wake?: () => void

  push(type: string, payload: unknown, terminal = false): void {
    this.frames.push({ flags: terminal ? 1 : 0, body: encode({ v: 9, t: type, p: encode(payload) }) })
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
export function fakeVm(
  guestSockets: Record<TunnelName, string>,
  options: { serve?: (capability: string, payload: unknown) => Promise<unknown> } = {}
) {
  const execs: Array<{ cmd: string; args: string[]; env: string[]; user: string | null; stdin: string }> = []
  const cleanup: Array<() => void | Promise<void>> = []
  let shimStream: FrameQueue | undefined
  let shimClient: ShimClient | undefined
  let port: number | undefined
  let hold: { reached: () => void; released: Promise<void> } | undefined

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
        if (capability !== 'tunnel') {
          if (options.serve) return options.serve(capability, payload)
          throw new Error(`capability ${capability} is not served by this fake`)
        }
        const held = hold
        if (held && (payload as { op: string }).op === 'data') {
          hold = undefined
          held.reached()
          await held.released
        }
        return tunnels.handle(payload)
      },
      workspaceRoot: '/workspace',
      features: ['cluster-skills-v1', 'cluster-skills-v2', 'cluster-skills-v3'],
      backoff: new Backoff({ baseMs: 5, jitter: () => 0 }),
      log: silent
    })
    shimClient = client
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
  } as unknown as Parameters<typeof startGuestShim>[0]['sdk']
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
    /** The shim renews through its own half-TTL path: it drops its binding before hanging up, so nothing is sent into the closing socket. */
    renew: () => (shimClient as unknown as { channel?: { end?: (reason: 'renew') => void } }).channel?.end?.('renew'),
    /** Holds the next daemon-to-guest tunnel frame inside the guest until released, so a renewal can land while it is in flight. */
    holdNextTunnelFrame: () => {
      let release!: () => void
      const released = new Promise<void>((resolve) => (release = resolve))
      const reached = new Promise<void>((resolve) => (hold = { reached: resolve, released }))
      return { reached, release }
    },
    /** The binding the guest's shim holds, including the lifetime it renews against. */
    binding: () => shimClient?.binding(),
    close: async () => {
      for (const step of cleanup.splice(0).reverse()) await step()
    }
  }
}

/** One of this daemon's own servers: it names itself in its reply, so a tunnel reaching the wrong one shows. */
export async function daemonSocket(path: string, name: string): Promise<Server> {
  const server = createServer((socket) => socket.on('data', (data) => socket.write(`${name}:${data.toString()}`)))
  await new Promise<void>((resolve) => server.listen(path, resolve))
  return server
}

export async function exchange(path: string, text: string): Promise<string> {
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

/** The manager surface the launcher reaches for a local VM, over one fake VM whose shim is started by the real starter. */
export function fakeVmManager(input: {
  vm: ReturnType<typeof fakeVm>
  log?: Logger
  runtimeStderr?: (text: string) => void
  /** What `guestShim` reports as the shim's token, to stand in for a shim that presents another. */
  identity?: string
  runtimeEnv?: Record<string, string>
}) {
  let shim: GuestShim | undefined
  const released = vi.fn()
  const unquiet = vi.fn()
  const manager = {
    prepareEnvironment: vi.fn(async (environment: EnvironmentDescriptor) => {
      shim ??= await startGuestShim({
        sdk: input.vm.sdk,
        sandbox: input.vm.sandbox,
        workspaceRoot: environment.workspaceRoot,
        completeEnv: true,
        runtimeStderr: input.runtimeStderr ?? (() => {}),
        failed: () => {
          shim = undefined
        },
        ...(input.log ? { log: input.log } : {}),
        artifacts: FAKE_SHIM_ARTIFACTS
      })
    }),
    guestShim: () => shim && { ...shim, ...(input.identity ? { token: input.identity } : {}) },
    runtimeEnv: vi.fn(async () => input.runtimeEnv ?? { PATH: process.env.PATH ?? '' }),
    hold: vi.fn(() => () => released()),
    quiet: vi.fn(() => unquiet),
    stopFailedEnvironment: vi.fn(),
    sameEnvironment: vi.fn((a: EnvironmentDescriptor, b: EnvironmentDescriptor) => a.id === b.id)
  }
  return {
    manager: manager as typeof manager & MicrosandboxManager,
    /** Every hold given back. */
    released,
    /** Every quiet given back. */
    unquiet,
    stop: () => shim?.stop()
  }
}
