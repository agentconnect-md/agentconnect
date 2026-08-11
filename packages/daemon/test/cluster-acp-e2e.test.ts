import { afterEach, describe, expect, it, vi } from 'vitest'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Backoff, ClientTransport, FakeClock } from '@agentconnect.md/connection'
import { AcpHost } from '../src/acp/acp-host.js'
import { K8sDriver } from '../src/k8s/driver.js'
import { ShimListener, type ShimConnection } from '../src/shim/listener.js'
import { ShimClient, type ShimTransport } from '../src/shim/client.js'
import { K8sApiError } from '@agentconnect.md/k8s-client'
import type { Sandbox, SandboxClaim } from '../src/k8s/sandbox-api.js'
import type { SpawnRecord } from '../src/shim/binding.js'

/**
 * A complete ACP turn through the cluster path: driver → listener → shim → runtime → back.
 *
 * This test exists because the first version of the driver did not work at all. It sent the
 * ACP stream through the one-request/one-response channel, so stdout and exit had no path
 * home and `AcpHost.start()` would have hung forever — and every unit test passed, because
 * they all checked the parts I had a model for (claim shape, generations, drain, retries)
 * and never ran a turn. A driver that cannot carry a turn is not a driver.
 */

const here = dirname(fileURLToPath(import.meta.url))
const fakeAgent = join(here, 'fixtures', 'fake-acp-agent.mjs')

const listeners: ShimListener[] = []
const clients: ShimClient[] = []
const intervals: NodeJS.Timeout[] = []

afterEach(async () => {
  for (const timer of intervals.splice(0)) clearInterval(timer)
  for (const client of clients.splice(0)) client.stop()
  await Promise.all(listeners.splice(0).map((instance) => instance.stop()))
})

/** Minimal SandboxApi: one claim, one always-ready Sandbox, mode held in memory. */
function fakeApi() {
  const state = {
    mode: 'Suspended' as 'Running' | 'Suspended',
    sandbox: {
      metadata: { name: 'sb-1', uid: 'sandbox-uid-1' },
      spec: { operatingMode: 'Suspended' as 'Running' | 'Suspended' },
      status: { conditions: [{ type: 'Ready', status: 'True' }] }
    } as Sandbox,
    claim: undefined as SandboxClaim | undefined
  }
  return {
    state,
    api: {
      ensureClaim: async (claim: SandboxClaim & { metadata: { name: string } }) => {
        state.claim = { ...claim, status: { sandbox: { name: 'sb-1' } } }
        return state.claim
      },
      getClaim: async () => {
        if (!state.claim) throw new K8sApiError(404, 'NotFound', 'no claim')
        return state.claim
      },
      deleteClaim: async () => {
        state.claim = undefined
      },
      getSandbox: async () => state.sandbox,
      setOperatingMode: async (_name: string, desired: 'Running' | 'Suspended') => {
        state.mode = desired
        state.sandbox = { ...state.sandbox, spec: { operatingMode: desired } }
        return state.sandbox
      },
      watchClaims: vi.fn(),
      watchSandboxes: vi.fn(),
      reviewToken: vi.fn()
    }
  }
}

/** Wire a real listener, a real shim client, and a driver that connects them. */
async function clusterUnderTest(options: { credentialTtlMs?: number } = {}): Promise<{
  driver: K8sDriver
  api: ReturnType<typeof fakeApi>
  connections: ShimConnection[]
  shimClock: FakeClock
  listener: ShimListener
  bindCount: () => number
}> {
  const api = fakeApi()
  let record: SpawnRecord | undefined
  const connections: ShimConnection[] = []
  const shimClock = new FakeClock()
  let binds = 0
  const listener = new ShimListener({
    verifier: { reviewToken: async () => ({ authenticated: true, podName: 'runtime-1', podUid: 'pod-uid-1' }) },
    spawnRecordForPod: () => record,
    now: () => Date.now(),
    ...(options.credentialTtlMs !== undefined ? { credentialTtlMs: options.credentialTtlMs } : {}),
    log: { info: () => (binds += 0), warn: () => {} }
  })
  listeners.push(listener)
  const port = await listener.start(0, '127.0.0.1')

  const driver = new K8sDriver({
    api: api.api as never,
    orgId: 'org-1',
    warmPoolName: 'pool',
    publishSpawnRecord: (published) => {
      record = published
      // The shim can only dial once a record exists, so start it here — the same ordering the
      // real driver depends on.
      const client = new ShimClient({
        endpoint: `ws://127.0.0.1:${port}`,
        dial: (url, opts) =>
          ClientTransport.dial(url, { subprotocol: opts.subprotocol, path: opts.path }) as Promise<ShimTransport>,
        readToken: () => 'projected-token',
        clock: shimClock,
        backoff: new Backoff({ jitter: () => 0 }),
        log: { info: () => {}, warn: () => {} }
      })
      clients.push(client)
      void client.start()
    },
    awaitChannel: async (agentId, generation, timeoutMs) => {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const match = listener
          .connectionsFor(agentId)
          .find((connection) => connection.binding.generation === generation)
        if (match && !connections.includes(match)) {
          connections.push(match)
          binds += 1
          return match
        }
        if (match) return match
        if (Date.now() > deadline) throw new Error('no channel bound in time')
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    },
    readyTimeoutMs: 15_000,
    log: { info: () => {}, warn: () => {}, debug: () => {} }
  })
  // Whoever owns the listener re-attaches a rebound channel; the daemon does this in
  // production, and the test stands in for it.
  const watchBinds = setInterval(() => {
    for (const connection of listener.connectionsFor('agent-a')) {
      if (connections.includes(connection)) continue
      connections.push(connection)
      binds += 1
      driver.onChannelBound(connection)
    }
  }, 20)
  intervals.push(watchBinds)
  return { driver, api, connections, shimClock, listener, bindCount: () => binds }
}

describe('a full ACP turn over the cluster driver', () => {
  it('starts the runtime in the sandbox, prompts it, and streams the reply back', async () => {
    const { driver, api } = await clusterUnderTest()
    const updates: string[] = []
    const host = new AcpHost(
      { command: process.execPath, args: [fakeAgent], env: [] },
      {
        driver,
        onUpdate: (_sessionId, update) => {
          if (
            update.sessionUpdate === 'agent_message_chunk' &&
            (update as { content?: { type?: string; text?: string } }).content?.type === 'text'
          ) {
            updates.push((update as unknown as { content: { text: string } }).content.text)
          }
        },
        env: { AC_AGENT_ID: 'agent-a' }
      }
    )

    await host.start()
    // The sandbox was suspended: resuming it is what let the runtime start at all.
    expect(api.state.mode).toBe('Running')

    const sessionId = await host.newSession('/tmp')
    const result = await host.prompt(sessionId, [{ type: 'text', text: 'hello' }])
    expect(result.stopReason).toBe('end_turn')
    // The reply came from a process the SHIM started, relayed as events over the channel.
    expect(updates).toContain('echo:hello')
    await host.stop(2_000)
  }, 60_000)

  it('reports terminal exit to AcpHost when the channel is lost, instead of hanging', async () => {
    const { driver } = await clusterUnderTest()
    let terminal = 0
    const host = new AcpHost(
      { command: process.execPath, args: [fakeAgent], env: [] },
      { driver, onUpdate: () => {}, onTerminal: () => terminal++, env: { AC_AGENT_ID: 'agent-a' } }
    )
    await host.start()
    // A lost channel is a dead runtime; without this the host waits on a stream that can
    // never produce another byte.
    driver.onChannelLost('agent-a', 'sandbox evicted')
    await vi.waitFor(() => expect(terminal).toBe(1), { timeout: 10_000 })
  }, 60_000)

  it('keeps the SAME runtime working across a real credential renewal', async () => {
    // The defect this covers: the shim's event sink captured the socket that handled `open`,
    // so after the renewal at half TTL every byte of stdout went into a closed WebSocket.
    // The previous version of this test performed one prompt and never renewed, so it could
    // not have caught that — the case it was named for never occurred in it.
    const { driver, shimClock, bindCount } = await clusterUnderTest({ credentialTtlMs: 600_000 })
    const host = new AcpHost(
      { command: process.execPath, args: [fakeAgent], env: [] },
      { driver, onUpdate: () => {}, env: { AC_AGENT_ID: 'agent-a' } }
    )
    await host.start()
    const sessionId = await host.newSession('/tmp')
    expect(await host.prompt(sessionId, [{ type: 'text', text: 'before' }])).toMatchObject({ stopReason: 'end_turn' })

    const bindsBefore = bindCount()
    // Half the advertised lifetime: the shim closes its socket and dials a replacement.
    shimClock.advance(300_000)
    await vi.waitFor(() => expect(bindCount()).toBeGreaterThan(bindsBefore), { timeout: 15_000 })

    // Same runtime, same ACP session, after the channel underneath was replaced.
    expect(await host.prompt(sessionId, [{ type: 'text', text: 'after' }])).toMatchObject({ stopReason: 'end_turn' })
    await host.stop(2_000)
  }, 60_000)
})
