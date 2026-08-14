import { afterEach, describe, expect, it, vi } from 'vitest'
import { Backoff, FakeClock } from '@agentconnect.md/connection'
import { startK8sRuntimePlane, k8sPlaneSettings, type K8sRuntimePlane } from '../src/k8s/runtime-plane.js'
import { ShimClient, type ShimTransport } from '../src/shim/client.js'
import { ShimServer } from '../src/shim/server.js'
import { K8sApiError } from '@agentconnect.md/k8s-client'
import type { Sandbox, SandboxClaim } from '../src/k8s/sandbox-api.js'

/**
 * The assembly itself, which is the thing that did not exist: every part of the k8s path was
 * built and tested separately while nothing put them together, so `--k8s` changed the daemon's
 * behaviour and still ran runtimes on its own host.
 *
 * A real daemon dialer reaches a real sandbox listener over a real socket here. What that catches — and unit
 * tests of the parts cannot — is the wiring being wrong end to end: a pod that binds but is
 * mapped to no launch, a driver that never learns its channel, or a workspace runner that stays
 * local because nothing registered it.
 */

const planes: K8sRuntimePlane[] = []
const clients: ShimClient[] = []
const servers: ShimServer[] = []
const serverByPort = new Map<number, ShimServer>()
const portByPlane = new WeakMap<K8sRuntimePlane, number>()

afterEach(async () => {
  for (const client of clients.splice(0)) client.stop()
  for (const plane of planes.splice(0)) await plane.stop()
  for (const server of servers.splice(0)) await server.stop()
  serverByPort.clear()
  delete process.env.AC_K8S_ORG_ID
  delete process.env.AC_K8S_WARM_POOL
  delete process.env.AC_K8S_SHIM_PORT
})

/** A sandbox watch that reports nothing and ends when the plane aborts it. */
async function* idleSandboxWatch(signal?: AbortSignal): AsyncGenerator<never> {
  await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }))
}

/** A Sandbox that binds, adopts a pool pod, and reports Ready. */
function fakeApi(options: { podName?: string; adopt?: boolean } = {}) {
  const podName = options.podName ?? 'pool-pod-9'
  const sandbox = {
    metadata: {
      name: 'sb-1',
      uid: 'sandbox-uid-1',
      ...(options.adopt === false ? {} : { annotations: { 'agents.x-k8s.io/pod-name': podName } })
    },
    spec: { operatingMode: 'Running' as const },
    status: { conditions: [{ type: 'Ready', status: 'True' }], podIPs: ['127.0.0.1'] }
  } satisfies Sandbox
  let claim: SandboxClaim | undefined
  return {
    podName,
    api: {
      ensureClaim: async (input: SandboxClaim & { metadata: { name: string } }) => {
        const created = claim === undefined
        claim = { ...input, status: { sandbox: { name: 'sb-1' } } }
        return { claim, created }
      },
      getClaim: async () => {
        if (!claim) throw new K8sApiError(404, 'NotFound', 'no claim')
        return claim
      },
      deleteClaim: async () => undefined,
      getSandbox: async () => sandbox,
      setOperatingMode: async () => sandbox,
      watchClaims: vi.fn(),
      // The plane follows Sandboxes for a rollout's drain requests; this one reports none.
      watchSandboxes: ({ signal }: { signal?: AbortSignal }) => idleSandboxWatch(signal),
      // The dialer verifies through this, so the handshake exercises the real path.
      reviewToken: async (token: string) =>
        token === 'projected-token'
          ? { authenticated: true, podName, podUid: 'pod-uid-1' }
          : { authenticated: false, error: 'not this pod' }
    }
  }
}

/** Start a plane whose Kubernetes surface is the fake above, on an ephemeral port. */
async function planeUnderTest(api: ReturnType<typeof fakeApi>): Promise<K8sRuntimePlane> {
  const server = new ShimServer()
  const port = await server.start(0, '127.0.0.1')
  servers.push(server)
  serverByPort.set(port, server)
  const plane = await startK8sRuntimePlane({
    orgId: 'org-1',
    warmPoolName: 'pool',
    shimPort: port,
    readyTimeoutMs: 15_000,
    api: api.api as never,
    log: { info: () => {}, warn: () => {}, debug: () => {} }
  })
  planes.push(plane)
  portByPlane.set(plane, port)
  return plane
}

/** A real passive shim client accepting the plane's dial, optionally serving capabilities. */
function shimAgainst(port: number, handlers: { probe?: unknown; workspaceRoot?: string } = {}): ShimClient {
  const server = serverByPort.get(port)
  if (!server) throw new Error(`no sandbox shim server on ${port}`)
  const client = new ShimClient({
    ...(handlers.probe === undefined
      ? {}
      : {
          handle: async (capability: string) => {
            // A function stands in for a generator that takes time, so a test can observe the
            // window where the request is in flight and the bind is already over.
            if (capability === 'probe')
              return typeof handlers.probe === 'function' ? await (handlers.probe as () => unknown)() : handlers.probe
            throw new Error(`unexpected capability ${capability}`)
          }
        }),
    ...(handlers.workspaceRoot === undefined ? {} : { workspaceRoot: handlers.workspaceRoot }),
    endpoint: 'accepted-daemon-channel',
    acceptDialIn: true,
    dial: () => server.nextTransport() as Promise<ShimTransport>,
    readToken: () => 'projected-token',
    clock: new FakeClock(),
    backoff: new Backoff({ jitter: () => 0 }),
    log: { info: () => {}, warn: () => {} }
  })
  clients.push(client)
  void client.start()
  return client
}

function shimPort(plane: K8sRuntimePlane): number {
  const port = portByPlane.get(plane)
  if (!port) throw new Error('plane has no shim port')
  return port
}

async function until(predicate: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return predicate()
}

describe('k8s plane settings', () => {
  it('requires a pool but permits an install-wide daemon without an org', () => {
    // The pool is deployment-owned, while an install-wide daemon resolves the tenant per agent.
    expect(() => k8sPlaneSettings({})).toThrow(/AC_K8S_WARM_POOL/)
    expect(k8sPlaneSettings({ AC_K8S_WARM_POOL: 'pool' })).toEqual({
      warmPoolName: 'pool',
      shimPort: 8085
    })
    expect(k8sPlaneSettings({ AC_K8S_ORG_ID: 'org-1', AC_K8S_WARM_POOL: 'pool' })).toEqual({
      orgId: 'org-1',
      warmPoolName: 'pool',
      shimPort: 8085
    })
    expect(() =>
      k8sPlaneSettings({ AC_K8S_ORG_ID: 'org-1', AC_K8S_WARM_POOL: 'pool', AC_K8S_SHIM_PORT: 'http' })
    ).toThrow(/not a valid port/)
    expect(() => k8sPlaneSettings({ AC_K8S_ORG_ID: 'org-1', AC_K8S_WARM_POOL: 'pool', AC_K8S_SHIM_PORT: '0' })).toThrow(
      /not a valid port/
    )
  })
})

describe('k8s runtime plane assembly', () => {
  it('probes a sandbox for the runtimes the image provides, then tears it down', async () => {
    // The whole point of dropping the ConfigMap: the only source that cannot drift from the image
    // is the running pod. A list compiled into the daemon, or copied into a ConfigMap, can be
    // wrong about the image and nothing notices — the daemon just advertises a version nobody can
    // run and looks healthy.
    const api = fakeApi()
    const deleted: string[] = []
    api.api.deleteClaim = async (name: string) => {
      deleted.push(name)
    }
    const plane = await planeUnderTest(api)
    const port = shimPort(plane)

    const probing = plane.probeRuntimes()
    let requested: () => void = () => {}
    const inFlight = new Promise<void>((resolve) => (requested = resolve))
    let answer: (table: unknown) => void = () => {}
    const generated = new Promise<unknown>((resolve) => (answer = resolve))
    shimAgainst(port, {
      probe: () => {
        requested()
        return generated
      }
    })
    await inFlight
    expect(plane.dialer.connectionsFor('ac-runtime-probe')[0]?.binding.grants ?? []).toEqual(['probe'])
    answer({ runtimes: [{ id: 'claude-acp', version: '0.66.0', acp: { protocolVersion: 1 } }] })
    const table = await probing
    expect(table.runtimes.map((entry) => `${entry.id}@${entry.version}`)).toEqual(['claude-acp@0.66.0'])
    // And the probe sandbox is gone: one leaked pod per daemon restart would be a slow leak that
    // nothing else cleans up.
    expect(deleted).toContain('agent-ac-runtime-probe')
  })

  it('holds the probe sandbox across the request, not just across the bind', async () => {
    // The probe can run for minutes while nothing else marks that sandbox as in use, and both
    // suspension paths read the lease to decide a pod is spare. Suspending mid-probe fails the
    // probe — and a daemon that failed its probe advertises no runtimes and does not retry.
    const api = fakeApi()
    const plane = await planeUnderTest(api)
    const port = shimPort(plane)

    const probing = plane.probeRuntimes()
    // A shim that has dialled in and is still generating its table. Waiting for the REQUEST rather
    // than for the connection is the whole point: during the bind the sandbox is held anyway, so
    // an assertion there would hold with or without the lease this test is about.
    let requested: () => void = () => {}
    const inFlight = new Promise<void>((resolve) => (requested = resolve))
    let answer: (table: unknown) => void = () => {}
    const generating = new Promise<unknown>((resolve) => (answer = resolve))
    shimAgainst(port, {
      probe: () => {
        requested()
        return generating
      }
    })
    await inFlight

    expect(await plane.suspendIdle('ac-runtime-probe')).toBe('busy')

    answer({ runtimes: [{ id: 'claude-acp', version: '0.66.0' }] })
    await probing
  })

  it('brings the sandbox up and binds without starting a runtime, for workspace preparation', async () => {
    // The workspace has to be prepared before the runtime starts, and for a cluster agent that
    // means cloning onto the pod's volume — so the channel must exist first. Preparing before the
    // sandbox existed would clone on the daemon's disk and hand the runtime an empty workspace.
    const api = fakeApi()
    const plane = await planeUnderTest(api)
    const port = shimPort(plane)
    const ensuring = plane.ensureChannel('agent-a')
    shimAgainst(port, { workspaceRoot: '/agent' })
    await ensuring
    // A channel, a session behind the workspace seam, and NO runtime started.
    expect(plane.dialer.connectionsFor('agent-a')).toHaveLength(1)
    expect(plane.gitRunnerFor('agent-a', '/agent')).toBeDefined()
    // The same condition, readable on its own: the credential pointers git will read are built
    // from this, so an answer that disagreed with the runner would describe the wrong filesystem.
    expect(plane.runsInSandbox('agent-a')).toBe(true)
    expect(plane.runsInSandbox('agent-b')).toBe(false)
    expect(plane.gitRunnerFor('agent-b', '/agent')).toBeUndefined()
    // The pod's reported mount arrived with the bind — the fact every pod path is built on.
    expect(plane.workspaceRootFor('agent-a')).toBe('/agent')
  })

  it('resolves a dialing pod back to its launch, through the ADOPTED pod name', async () => {
    // The whole mapping: a TokenReview yields a pod name, the record is keyed by the pod the
    // Sandbox named, and warm-pool adoption means that name is the pool's, not the sandbox's.
    const api = fakeApi()
    const plane = await planeUnderTest(api)
    const port = shimPort(plane)

    // Publishing happens inside launch(); drive it far enough to publish, then dial.
    const launching = plane.driver.launch({
      command: 'x',
      args: [],
      env: { AC_AGENT_ID: 'agent-a' },
      cwd: '/agent'
    } as never)
    shimAgainst(port)

    const connection = await Promise.race([
      launching.then(() => plane.dialer.connectionsFor('agent-a')[0]),
      new Promise((resolve) => setTimeout(() => resolve(undefined), 15_000))
    ])
    expect(connection).toBeDefined()
    expect(plane.dialer.connectionsFor('agent-a')[0]?.binding.podName).toBe(api.podName)
  })

  it('survives a shim reconnect: a closed socket is not a lost launch', async () => {
    // The shim closes at half the credential TTL and the daemon reconnects; `ShimSession.lose()` is
    // terminal — so reporting loss on every socket close killed the runtime on each routine
    // renewal, which is the exact failure ShimSession was built to prevent.
    const api = fakeApi()
    const plane = await planeUnderTest(api)
    const port = shimPort(plane)
    const launching = plane.driver.launch({
      command: 'x',
      args: [],
      env: { AC_AGENT_ID: 'agent-a' },
      cwd: '/agent'
    } as never)
    const first = shimAgainst(port)
    await launching
    expect(await until(() => plane.gitRunnerFor('agent-a') !== undefined)).toBe(true)

    // Drop the socket the way a renewal does, then let a replacement bind.
    first.stop()
    expect(await until(() => plane.dialer.connectionsFor('agent-a').length === 0)).toBe(true)
    shimAgainst(port)
    expect(await until(() => plane.dialer.connectionsFor('agent-a').length > 0)).toBe(true)
    // The seam still works, which it would not if the session had been closed on the drop.
    expect(await until(() => plane.gitRunnerFor('agent-a') !== undefined)).toBe(true)
  })

  it('hands the workspace seam a shim runner only for an agent with a bound channel', async () => {
    const api = fakeApi()
    const plane = await planeUnderTest(api)
    // Before any launch there is no channel, and the caller must stay on its local runner rather
    // than fail — a self-hosted agent beside a cluster-backed one depends on that.
    expect(plane.gitRunnerFor('agent-a')).toBeUndefined()

    const port = shimPort(plane)
    const launching = plane.driver.launch({
      command: 'x',
      args: [],
      env: { AC_AGENT_ID: 'agent-a' },
      cwd: '/agent'
    } as never)
    shimAgainst(port)
    await launching
    expect(await until(() => plane.gitRunnerFor('agent-a') !== undefined)).toBe(true)
  })

  it('deletes the claim when an agent is removed, and stops waiting on the channel it just dropped', async () => {
    const api = fakeApi()
    const deleted: string[] = []
    api.api.deleteClaim = async (name: string) => void deleted.push(name)
    const plane = await planeUnderTest(api)

    const port = shimPort(plane)
    const launching = plane.driver.launch({
      command: 'x',
      args: [],
      env: { AC_AGENT_ID: 'agent-a' },
      cwd: '/agent'
    } as never)
    shimAgainst(port)
    await launching

    await plane.discardAgent('agent-a')
    // The claim is the whole teardown: the Sandbox and its workspace volume go with it.
    expect(deleted).toEqual(['agent-agent-a'])
    // And the launch is forgotten, so nothing is left waiting on a channel for an agent that no
    // longer exists — a loss report for one would name work nobody is expecting.
    expect(plane.driver.currentLaunch('agent-a')).toBeUndefined()
    expect(plane.launchedAgents()).toEqual([])
  })
})
