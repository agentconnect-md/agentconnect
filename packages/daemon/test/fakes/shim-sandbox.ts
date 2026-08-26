import type { Backoff, Clock } from '@agentconnect.md/connection'
import { ShimClient, type ShimClientDeps, type ShimTransport } from '../../src/shim/client.js'
import { ShimDialer, type ShimDialerDeps } from '../../src/shim/dialer.js'
import { ShimServer } from '../../src/shim/server.js'
import type { ShimFeature } from '../../src/shim/protocol.js'

/** The production shape a test drives: the daemon dials IN, and the pod runs a ShimServer. */
export interface ShimSandboxOptions {
  handle?: ShimClientDeps['handle']
  backoff?: Backoff
  clock?: Clock
  /** The pod's workspace mount as the shim reports it in its identity. */
  workspaceRoot?: string
  features?: ShimFeature[]
}

export interface ShimSandbox {
  /** Where the daemon dials — a real loopback port. */
  endpoint: string
  port: number
  server: ShimServer
  client: ShimClient
}

/**
 * Per-file fixtures for a real sandbox shim: a listening {@link ShimServer} with a
 * {@link ShimClient} attached to whatever daemon it accepts, plus the dialers under test.
 *
 * A factory rather than module state because this suite runs `isolate: false`, so a shared
 * registry would leak one file's servers into the next.
 */
export function shimFixtures(): {
  clients: ShimClient[]
  dialers: ShimDialer[]
  servers: ShimServer[]
  sandbox: (options?: ShimSandboxOptions) => Promise<ShimSandbox>
  dialer: (deps: ShimDialerDeps) => ShimDialer
  cleanup: () => Promise<void>
} {
  const clients: ShimClient[] = []
  const dialers: ShimDialer[] = []
  const servers: ShimServer[] = []

  async function sandbox(options: ShimSandboxOptions = {}): Promise<ShimSandbox> {
    const server = new ShimServer()
    servers.push(server)
    const port = await server.start(0, '127.0.0.1')
    const client = new ShimClient({
      endpoint: 'accepted-daemon-channel',
      dial: () => server.nextTransport() as Promise<ShimTransport>,
      readToken: () => 'projected-token',
      workspaceRoot: options.workspaceRoot ?? '/agent',
      ...(options.features ? { features: options.features } : {}),
      ...(options.handle ? { handle: options.handle } : {}),
      ...(options.backoff ? { backoff: options.backoff } : {}),
      ...(options.clock ? { clock: options.clock } : {}),
      log: { info: () => {}, warn: () => {} }
    })
    clients.push(client)
    void client.start().catch(() => undefined)
    return { endpoint: `ws://127.0.0.1:${port}`, port, server, client }
  }

  function dialer(deps: ShimDialerDeps): ShimDialer {
    const instance = new ShimDialer(deps)
    dialers.push(instance)
    return instance
  }

  async function cleanup(): Promise<void> {
    for (const client of clients.splice(0)) client.stop()
    for (const instance of dialers.splice(0)) instance.stop()
    await Promise.all(servers.splice(0).map((server) => server.stop()))
  }

  return { clients, dialers, servers, sandbox, dialer, cleanup }
}
