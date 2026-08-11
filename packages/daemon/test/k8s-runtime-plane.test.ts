import { afterEach, describe, expect, it, vi } from 'vitest'
import { Backoff, ClientTransport, FakeClock } from '@agentconnect.md/connection'
import { startK8sRuntimePlane, k8sPlaneSettings, type K8sRuntimePlane } from '../src/k8s/runtime-plane.js'
import { ShimClient, type ShimTransport } from '../src/shim/client.js'
import { K8sApiError } from '@agentconnect.md/k8s-client'
import type { Sandbox, SandboxClaim } from '../src/k8s/sandbox-api.js'

/**
 * The assembly itself, which is the thing that did not exist: every part of the k8s path was
 * built and tested separately while nothing put them together, so `--k8s` changed the daemon's
 * behaviour and still ran runtimes on its own host.
 *
 * A real shim client dials a real listener over a real socket here. What that catches — and unit
 * tests of the parts cannot — is the wiring being wrong end to end: a pod that binds but is
 * mapped to no launch, a driver that never learns its channel, or a workspace runner that stays
 * local because nothing registered it.
 */

const planes: K8sRuntimePlane[] = []
const clients: ShimClient[] = []

afterEach(async () => {
  for (const client of clients.splice(0)) client.stop()
  for (const plane of planes.splice(0)) await plane.stop()
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
    status: { conditions: [{ type: 'Ready', status: 'True' }] }
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
      // The listener verifies through this, so the handshake exercises the real path.
      reviewToken: async (token: string) =>
        token === 'projected-token'
          ? { authenticated: true, podName, podUid: 'pod-uid-1' }
          : { authenticated: false, error: 'not this pod' }
    }
  }
}

/** Start a plane whose Kubernetes surface is the fake above, on an ephemeral port. */
async function planeUnderTest(api: ReturnType<typeof fakeApi>): Promise<K8sRuntimePlane> {
  const plane = await startK8sRuntimePlane({
    orgId: 'org-1',
    warmPoolName: 'pool',
    shimPort: 0,
    shimHost: '127.0.0.1',
    readyTimeoutMs: 15_000,
    api: api.api as never,
    log: { info: () => {}, warn: () => {}, debug: () => {} }
  })
  planes.push(plane)
  return plane
}

/** A real shim client dialling the plane's endpoint, optionally serving capabilities. */
function shimAgainst(port: number, handlers: { probe?: unknown; workspaceRoot?: string } = {}): ShimClient {
  const client = new ShimClient({
    ...(handlers.probe === undefined
      ? {}
      : {
          handle: async (capability: string) => {
            if (capability === 'probe') return handlers.probe
            throw new Error(`unexpected capability ${capability}`)
          }
        }),
    ...(handlers.workspaceRoot === undefined ? {} : { workspaceRoot: handlers.workspaceRoot }),
    endpoint: `ws://127.0.0.1:${port}`,
    dial: (url, opts) =>
      ClientTransport.dial(url, { subprotocol: opts.subprotocol, path: opts.path }) as Promise<ShimTransport>,
    readToken: () => 'projected-token',
    clock: new FakeClock(),
    backoff: new Backoff({ jitter: () => 0 }),
    log: { info: () => {}, warn: () => {} }
  })
  clients.push(client)
  void client.start()
  return client
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
  it('refuses to start without an org or a pool rather than guessing one', () => {
    // A guessed org labels another tenant's claims; a guessed pool yields sandboxes that never
    // bind, with nothing in the logs explaining why.
    expect(() => k8sPlaneSettings({})).toThrow(/AC_K8S_ORG_ID/)
    expect(() => k8sPlaneSettings({ AC_K8S_ORG_ID: 'org-1' })).toThrow(/AC_K8S_WARM_POOL/)
    expect(k8sPlaneSettings({ AC_K8S_ORG_ID: 'org-1', AC_K8S_WARM_POOL: 'pool' })).toEqual({
      orgId: 'org-1',
      warmPoolName: 'pool',
      shimPort: 8085
    })
    expect(() =>
      k8sPlaneSettings({ AC_K8S_ORG_ID: 'org-1', AC_K8S_WARM_POOL: 'pool', AC_K8S_SHIM_PORT: 'http' })
    ).toThrow(/not a valid port/)
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
    const port = plane.listener.listeningPort()!

    // A shim that answers `probe` the way the image's generator does.
    const probing = plane.probeRuntimes()
    shimAgainst(port, {
      probe: { runtimes: [{ id: 'claude-acp', version: '0.66.0', acp: { protocolVersion: 1 } }] }
    })
    const table = await probing
    expect(table.runtimes.map((entry) => `${entry.id}@${entry.version}`)).toEqual(['claude-acp@0.66.0'])
    // The probe sandbox runs no runtime and touches no workspace, so it gets ONE channel. Granting
    // it the runtime set would hand a throwaway pod exec, materialize and tunnel for no reason.
    expect(plane.listener.connectionsFor('ac-runtime-probe')[0]?.binding.grants ?? []).toEqual(['probe'])
    // And the probe sandbox is gone: one leaked pod per daemon restart would be a slow leak that
    // nothing else cleans up.
    expect(deleted).toContain('agent-ac-runtime-probe')
  })

  it('brings the sandbox up and binds without starting a runtime, for workspace preparation', async () => {
    // The workspace has to be prepared before the runtime starts, and for a cluster agent that
    // means cloning onto the pod's volume — so the channel must exist first. Preparing before the
    // sandbox existed would clone on the daemon's disk and hand the runtime an empty workspace.
    const api = fakeApi()
    const plane = await planeUnderTest(api)
    const port = plane.listener.listeningPort()!
    const ensuring = plane.ensureChannel('agent-a')
    shimAgainst(port, { workspaceRoot: '/agent' })
    await ensuring
    // A channel, a session behind the workspace seam, and NO runtime started.
    expect(plane.listener.connectionsFor('agent-a')).toHaveLength(1)
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
    const port = plane.listener.listeningPort()!

    // Publishing happens inside launch(); drive it far enough to publish, then dial.
    const launching = plane.driver.launch({
      command: 'x',
      args: [],
      env: { AC_AGENT_ID: 'agent-a' },
      cwd: '/agent'
    } as never)
    shimAgainst(port)

    const connection = await Promise.race([
      launching.then(() => plane.listener.connectionsFor('agent-a')[0]),
      new Promise((resolve) => setTimeout(() => resolve(undefined), 15_000))
    ])
    expect(connection).toBeDefined()
    expect(plane.listener.connectionsFor('agent-a')[0]?.binding.podName).toBe(api.podName)
  })

  it('survives a shim reconnect: a closed socket is not a lost launch', async () => {
    // The shim closes and re-dials at half the credential TTL, and `ShimSession.lose()` is
    // terminal — so reporting loss on every socket close killed the runtime on each routine
    // renewal, which is the exact failure ShimSession was built to prevent.
    const api = fakeApi()
    const plane = await planeUnderTest(api)
    const port = plane.listener.listeningPort()!
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
    expect(await until(() => plane.listener.connectionsFor('agent-a').length === 0)).toBe(true)
    shimAgainst(port)
    expect(await until(() => plane.listener.connectionsFor('agent-a').length > 0)).toBe(true)
    // The seam still works, which it would not if the session had been closed on the drop.
    expect(await until(() => plane.gitRunnerFor('agent-a') !== undefined)).toBe(true)
  })

  it('hands the workspace seam a shim runner only for an agent with a bound channel', async () => {
    const api = fakeApi()
    const plane = await planeUnderTest(api)
    // Before any launch there is no channel, and the caller must stay on its local runner rather
    // than fail — a self-hosted agent beside a cluster-backed one depends on that.
    expect(plane.gitRunnerFor('agent-a')).toBeUndefined()

    const port = plane.listener.listeningPort()!
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
})
