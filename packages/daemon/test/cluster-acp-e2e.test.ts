import { afterEach, describe, expect, it, vi } from 'vitest'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Backoff, FakeClock } from '@agentconnect.md/connection'
import { AcpHost } from '../src/acp/acp-host.js'
import { K8sDriver } from '../src/k8s/driver.js'
import type { ShimConnection } from '../src/shim/connection.js'
import { ShimClient, type ShimTransport } from '../src/shim/client.js'
import { ShimDialer } from '../src/shim/dialer.js'
import { ShimServer } from '../src/shim/server.js'
import { K8sApiError } from '@agentconnect.md/k8s-client'
import { GuardedResumeRejectedError, type Sandbox, type SandboxClaim } from '../src/k8s/sandbox-api.js'
import type { SpawnRecord } from '../src/shim/binding.js'
import { fakeGenerations } from './fake-generations.js'
import { waitBudget } from './wait-support.js'

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

const servers: ShimServer[] = []
const dialers: ShimDialer[] = []
const clients: ShimClient[] = []

afterEach(async () => {
  for (const client of clients.splice(0)) client.stop()
  for (const dialer of dialers.splice(0)) dialer.stop()
  await Promise.all(servers.splice(0).map((instance) => instance.stop()))
})

/** Minimal SandboxApi: one claim, one always-ready Sandbox, mode held in memory. */
function fakeApi() {
  const state = {
    mode: 'Suspended' as 'Running' | 'Suspended',
    sandbox: {
      metadata: {
        name: 'sb-1',
        uid: 'sandbox-uid-1',
        annotations: { 'agents.x-k8s.io/pod-name': 'runtime-1' }
      },
      spec: {
        operatingMode: 'Suspended' as 'Running' | 'Suspended',
        podTemplate: { spec: { containers: [{ name: 'runtime', image: 'runtime:1' }] } }
      },
      status: { conditions: [{ type: 'Ready', status: 'True' }], podIPs: ['127.0.0.1'] }
    } as Sandbox,
    claim: undefined as SandboxClaim | undefined
  }
  return {
    state,
    api: {
      ensureClaim: async (claim: SandboxClaim & { metadata: { name: string } }) => {
        state.claim = { ...claim, status: { sandbox: { name: 'sb-1' } } }
        return { claim: state.claim, created: true }
      },
      getClaim: async () => {
        if (!state.claim) throw new K8sApiError(404, 'NotFound', 'no claim')
        return state.claim
      },
      deleteClaim: async () => {
        state.claim = undefined
      },
      getSandbox: async () => state.sandbox,
      getWarmPool: async () => ({ spec: { sandboxTemplateRef: { name: 'runtime-template' } } }),
      getSandboxTemplate: async () => ({
        spec: { podTemplate: { spec: { containers: [{ name: 'runtime', image: 'runtime:1' }] } } }
      }),
      resumeWithRuntimeImage: async (
        _name: string,
        image: { containerIndex: number; observedName: string; observedImage: string; targetImage: string }
      ) => {
        const current = state.sandbox.spec?.podTemplate?.spec?.containers?.[image.containerIndex]
        if (
          state.mode !== 'Suspended' ||
          current?.name !== image.observedName ||
          current.image !== image.observedImage
        ) {
          throw new GuardedResumeRejectedError('sb-1', new K8sApiError(422, 'Invalid', 'guard rejected'))
        }
        state.mode = 'Running'
        state.sandbox = {
          ...state.sandbox,
          spec: {
            ...state.sandbox.spec,
            operatingMode: 'Running',
            podTemplate: {
              ...state.sandbox.spec?.podTemplate,
              spec: {
                containers: (state.sandbox.spec?.podTemplate?.spec?.containers ?? []).map((container, index) =>
                  index === image.containerIndex ? { ...container, image: image.targetImage } : container
                )
              }
            }
          }
        }
        return state.sandbox
      },
      setOperatingMode: async (_name: string, desired: 'Running' | 'Suspended') => {
        state.mode = desired
        state.sandbox = { ...state.sandbox, spec: { ...state.sandbox.spec, operatingMode: desired } }
        return state.sandbox
      },
      watchClaims: vi.fn(),
      reviewToken: vi.fn()
    }
  }
}

/** Wire a real sandbox listener, daemon dialer, and driver. */
async function clusterUnderTest(options: { credentialTtlMs?: number } = {}): Promise<{
  driver: K8sDriver
  api: ReturnType<typeof fakeApi>
  connections: ShimConnection[]
  shimClock: FakeClock
  bindCount: () => number
}> {
  const api = fakeApi()
  const connections: ShimConnection[] = []
  const shimClock = new FakeClock()
  let binds = 0
  const server = new ShimServer()
  servers.push(server)
  const port = await server.start(0, '127.0.0.1')
  const dialer = new ShimDialer({
    verifier: { reviewToken: async () => ({ authenticated: true, podName: 'runtime-1', podUid: 'pod-uid-1' }) },
    now: () => Date.now(),
    ...(options.credentialTtlMs !== undefined ? { credentialTtlMs: options.credentialTtlMs } : {}),
    onConnection: (connection) => {
      if (!connections.includes(connection)) {
        connections.push(connection)
        binds += 1
      }
      driver.onChannelBound(connection)
    },
    log: { info: () => (binds += 0), warn: () => {} }
  })
  dialers.push(dialer)

  const client = new ShimClient({
    endpoint: 'accepted-daemon-channel',
    dial: () => server.nextTransport() as Promise<ShimTransport>,
    readToken: () => 'projected-token',
    clock: shimClock,
    backoff: new Backoff({ jitter: () => 0 }),
    log: { info: () => {}, warn: () => {} }
  })
  clients.push(client)
  void client.start()

  const driver = new K8sDriver({
    api: api.api as never,
    orgForAgent: () => 'org-1',
    warmPoolName: 'pool',
    generations: fakeGenerations(),
    connectChannel: (record: SpawnRecord, _podIp, timeoutMs) =>
      dialer.connect(`ws://127.0.0.1:${port}`, record, timeoutMs),
    revokeChannel: (agentId) => dialer.revokeAgent(agentId),
    readyTimeoutMs: 15_000,
    log: { info: () => {}, warn: () => {}, debug: () => {} }
  })
  return { driver, api, connections, shimClock, bindCount: () => binds }
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
    await vi.waitFor(() => expect(terminal).toBe(1), waitBudget(10_000))
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
    await vi.waitFor(() => expect(bindCount()).toBeGreaterThan(bindsBefore), waitBudget(15_000))

    // Same runtime, same ACP session, after the channel underneath was replaced.
    expect(await host.prompt(sessionId, [{ type: 'text', text: 'after' }])).toMatchObject({ stopReason: 'end_turn' })
    await host.stop(2_000)
  }, 60_000)
})
