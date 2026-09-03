import { afterEach, describe, expect, it, vi } from 'vitest'
import { Backoff, FakeClock } from '@agentconnect.md/connection'
import {
  k8sPlaneSettings,
  startK8sRuntimePlane,
  type K8sRuntimePlane,
  sandboxMemoryRoot
} from '../src/k8s/runtime-plane.js'
import { PROBE_CLAIM_EXPIRES_ANNOTATION, PROBE_CLAIM_LABEL, probeAgentId } from '../src/k8s/probe-claim.js'
import { sandboxSubjectFor } from '../src/k8s/sandbox-identity.js'
import { hostKeyDirName, sessionHostKey } from '../src/acp/host-key.js'
import { ShimClient, type ShimTransport } from '../src/shim/client.js'
import { ShimServer } from '../src/shim/server.js'
import { K8sApiError } from '@agentconnect.md/k8s-client'
import type { Sandbox, SandboxClaim } from '../src/k8s/sandbox-api.js'
import { fakeGenerations } from './fake-generations.js'

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
  delete process.env.AC_K8S_SANDBOX_NAMESPACE
  delete process.env.AC_K8S_MEMBER_ID
  delete process.env.AC_K8S_SHIM_PORT
})

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
      deleteClaim: async (_name: string): Promise<void> => {},
      listClaims: async () => [],
      getSandbox: async () => sandbox,
      setOperatingMode: async () => sandbox,
      watchClaims: vi.fn(),
      // The dialer verifies through this, so the handshake exercises the real path.
      reviewToken: async (token: string) =>
        token === 'projected-token'
          ? { authenticated: true, podName, podUid: 'pod-uid-1' }
          : { authenticated: false, error: 'not this pod' }
    }
  }
}

/** Start a plane whose Kubernetes surface is the fake above, on an ephemeral port. */
async function planeUnderTest(api: ReturnType<typeof fakeApi>, readyTimeoutMs = 15_000): Promise<K8sRuntimePlane> {
  const server = new ShimServer()
  const port = await server.start(0, '127.0.0.1')
  servers.push(server)
  serverByPort.set(port, server)
  const plane = await startK8sRuntimePlane({
    orgForAgent: () => 'org-1',
    warmPoolName: 'pool',
    generations: fakeGenerations(),
    sandboxNamespace: 'agent-sandboxes',
    memberId: 'member-a',
    shimPort: port,
    readyTimeoutMs,
    api: api.api as never,
    log: { info: () => {}, warn: () => {}, debug: () => {} }
  })
  planes.push(plane)
  portByPlane.set(plane, port)
  return plane
}

/** A real passive shim client accepting the plane's dial, optionally serving capabilities. */
function shimAgainst(
  port: number,
  handlers: {
    probe?: unknown
    workspaceRoot?: string
    /** The projected identity this pod presents; the fake review maps it to a pod. */
    token?: string
    handle?: (capability: string, payload: unknown) => Promise<unknown>
  } = {}
): ShimClient {
  const server = serverByPort.get(port)
  if (!server) throw new Error(`no sandbox shim server on ${port}`)
  const client = new ShimClient({
    ...(handlers.handle ? { handle: handlers.handle } : {}),
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
    dial: () => server.nextTransport() as Promise<ShimTransport>,
    readToken: () => handlers.token ?? 'projected-token',
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
  it('requires the shared sandbox namespace and member identity, and names no org at all', () => {
    // The pool is deployment-owned, while an install-wide daemon resolves the tenant per agent.
    expect(() => k8sPlaneSettings({})).toThrow(/AC_K8S_WARM_POOL/)
    expect(() => k8sPlaneSettings({ AC_K8S_WARM_POOL: 'pool' })).toThrow(/AC_K8S_SANDBOX_NAMESPACE/)
    expect(() => k8sPlaneSettings({ AC_K8S_WARM_POOL: 'pool', AC_K8S_SANDBOX_NAMESPACE: 'agent-sandboxes' })).toThrow(
      /AC_K8S_MEMBER_ID/
    )
    const base = {
      AC_K8S_WARM_POOL: 'pool',
      AC_K8S_SANDBOX_NAMESPACE: 'agent-sandboxes',
      AC_K8S_MEMBER_ID: 'member-a'
    }
    expect(k8sPlaneSettings(base)).toEqual({
      warmPoolName: 'pool',
      sandboxNamespace: 'agent-sandboxes',
      memberId: 'member-a',
      shimPort: 8085
    })
    expect(() => k8sPlaneSettings({ ...base, AC_K8S_SHIM_PORT: 'http' })).toThrow(/not a valid port/)
    expect(() => k8sPlaneSettings({ ...base, AC_K8S_SHIM_PORT: '0' })).toThrow(/not a valid port/)
  })

  it('derives a distinct DNS-safe probe identity for each member', () => {
    expect(probeAgentId('member-a')).toMatch(/^ac-runtime-probe-[a-f0-9]{16}$/)
    expect(probeAgentId('member-a')).not.toBe(probeAgentId('member-b'))
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
    const ensured: SandboxClaim[] = []
    api.api.deleteClaim = async (name: string) => {
      deleted.push(name)
    }
    const ensureClaim = api.api.ensureClaim
    api.api.ensureClaim = async (claim) => {
      ensured.push(claim)
      return ensureClaim(claim)
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
    // `probe` asks the image what it provides; `acp` runs those runtimes to read the models they
    // advertise. Nothing else: no workspace, no tunnel, no materialized secret.
    expect(plane.dialer.connectionsFor(probeAgentId('member-a'))[0]?.binding.grants ?? []).toEqual(['probe', 'acp'])
    answer({ runtimes: [{ id: 'claude-acp', version: '0.66.0', acp: { protocolVersion: 1 } }] })
    const table = await probing
    expect(table.runtimes.map((entry) => `${entry.id}@${entry.version}`)).toEqual(['claude-acp@0.66.0'])
    // The probe's own marker beside the labels every claim carries on its metadata.
    expect(ensured[0]?.metadata?.labels).toEqual({
      [PROBE_CLAIM_LABEL]: 'true',
      'agentconnect.md/org': 'install',
      'agentconnect.md/agent': probeAgentId('member-a')
    })
    expect(Date.parse(ensured[0]?.metadata?.annotations?.[PROBE_CLAIM_EXPIRES_ANNOTATION] ?? '')).toBeGreaterThan(
      Date.now()
    )
    // And the probe sandbox is gone: one leaked pod per daemon restart would be a slow leak that
    // nothing else cleans up.
    expect(deleted).toContain(`agent-${probeAgentId('member-a')}`)
  })

  it('holds the probe sandbox across the request, not just across the bind', async () => {
    // The probe can run for minutes while nothing else marks that sandbox as in use, and both
    // suspension paths read the lease to decide a pod is spare. Suspending mid-probe fails the
    // probe — and a daemon that failed its probe advertises no runtimes and does not retry.
    const api = fakeApi()
    const plane = await planeUnderTest(api)
    const port = shimPort(plane)

    const probing = plane.probeRuntimes()
    expect(plane.probeRuntimes()).toBe(probing)
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

    expect(await plane.suspendIdle(probeAgentId('member-a'))).toBe('busy')

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
    // The managed memory tree rides the same bind: one root beside the checkout on the volume, and
    // no port at all for an agent without a channel — its resolver refuses rather than falling back.
    expect(plane.memoryFsFor('agent-a')?.root).toBe('/agent/.agentconnect/memory')
    expect(plane.memoryFsFor('agent-b')).toBeUndefined()
    expect(sandboxMemoryRoot(undefined)).toBe('/agent/.agentconnect/memory')
    expect(sandboxMemoryRoot('/mnt/vol/')).toBe('/mnt/vol/.agentconnect/memory')
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
    expect(plane.launched()).toEqual([])
  })
})

/** A cluster with one Sandbox per claim, every pod reachable at the test's one shim listener; a token names its pod. */
function fakeCluster() {
  const podName = 'pool-pod-9'
  const claims = new Map<string, SandboxClaim>()
  const sandboxes = new Map<string, Sandbox>()
  let minted = 0
  return {
    podName,
    claims,
    api: {
      ensureClaim: async (input: SandboxClaim & { metadata: { name: string } }) => {
        const existing = claims.get(input.metadata.name)
        if (existing) return { claim: existing, created: false }
        const name = `sb-${++minted}`
        sandboxes.set(name, {
          metadata: { name, uid: `sandbox-uid-${minted}`, annotations: { 'agents.x-k8s.io/pod-name': podName } },
          spec: { operatingMode: 'Running' as const },
          status: { conditions: [{ type: 'Ready', status: 'True' }], podIPs: ['127.0.0.1'] }
        })
        const claim = {
          ...input,
          metadata: { ...input.metadata, uid: `claim-${minted}` },
          status: { sandbox: { name } }
        }
        claims.set(input.metadata.name, claim)
        return { claim, created: true }
      },
      getClaim: async (name: string) => {
        const claim = claims.get(name)
        if (!claim) throw new K8sApiError(404, 'NotFound', 'no claim')
        return claim
      },
      deleteClaim: async (name: string): Promise<void> => void claims.delete(name),
      listClaims: async () => [...claims.values()],
      getSandbox: async (name: string) => {
        const sandbox = sandboxes.get(name)
        if (!sandbox) throw new K8sApiError(404, 'NotFound', 'no sandbox')
        return sandbox
      },
      setOperatingMode: async (name: string) => sandboxes.get(name)!,
      watchClaims: vi.fn(),
      // Every pod presents a token naming ITSELF, so two pods bound at once stay two identities.
      reviewToken: async (token: string) =>
        token.startsWith('pod-')
          ? { authenticated: true, podName, podUid: token }
          : { authenticated: false, error: 'not this pod' }
    }
  }
}

describe('one pod per session on the plane (git-workspace-model §11)', () => {
  it('binds a session host to its own pod and routes only the session directory to it', async () => {
    const cluster = fakeCluster()
    const plane = await planeUnderTest(cluster as never)
    const port = shimPort(plane)
    const T1 = sessionHostKey('agent-a', 'slack:C1:T1:agent-a')
    const leaf = hostKeyDirName(T1)
    const session = sandboxSubjectFor(T1)
    const served: unknown[] = []

    // The session pod alone is up: the test listener stands in for ONE pod, and the agent's is left down.
    const binding = plane.driver.ensureBoundChannel(session)
    shimAgainst(port, {
      workspaceRoot: '/agent',
      token: 'pod-1',
      handle: async (capability, payload) => {
        served.push(payload)
        if (capability === 'read') return { ok: true, value: 'dir' }
        throw new Error(`unexpected capability ${capability}`)
      }
    })
    await binding
    expect(plane.launched().map((launch) => launch.subject)).toEqual([session])
    expect([...cluster.claims.keys()]).toEqual([plane.driver.claimName(session)])
    expect(plane.dialer.connectionsFor(session)[0]?.binding).toMatchObject({ agentId: 'agent-a', subject: session })

    // The layout is session-layout.ts's in the session pod's coordinates.
    expect(plane.sessionDirFor('agent-a', leaf)).toBe(`/agent/sessions/${leaf}`)
    // The agent's work runs in a pod (its session's) while the agent pod itself is not bound.
    expect(plane.runsInSandbox('agent-a')).toBe(true)
    expect(plane.sandboxBound(session)).toBe(true)
    expect(plane.sandboxBound('agent-a')).toBe(false)
    // Memory and merge-when-ready are the agent pod's, so they are unreachable — never the session pod's by mistake.
    expect(plane.memoryFsFor('agent-a')).toBeUndefined()
    expect(plane.autoMergeFor('agent-a')).toBeUndefined()

    // A path under the session directory is the session pod's; everything else is the agent pod's and
    // refuses rather than falling back onto the session pod.
    expect(plane.gitRunnerFor('agent-a', `/agent/sessions/${leaf}/workspace`)).toBeDefined()
    expect(plane.gitRunnerFor('agent-a', `/agent/sessions/${leaf}`)).toBeDefined()
    expect(plane.gitRunnerFor('agent-a', '/agent/checkout')).toBeUndefined()
    expect(plane.gitRunnerFor('agent-a', `/agent/sessions/${leaf}-other/workspace`)).toBeUndefined()
    expect(plane.gitRunnerFor('agent-a')).toBeUndefined()
    const placement = plane.workspaceFsFor('agent-a')!
    expect(placement.mount).toBe('/agent')
    expect(await placement.fs.stat(`/agent/sessions/${leaf}/workspace`)).toBe('dir')
    expect(served.map((payload) => (payload as { rel: string }).rel)).toEqual([`sessions/${leaf}/workspace`])
    await expect(placement.fs.stat('/agent/checkout')).rejects.toThrow(
      /agent-a that owns \/agent\/checkout has no bound channel/
    )
    expect(await plane.clearPath('agent-a', '/agent/checkout')).toMatch(/no bound sandbox channel/)
    expect(plane.workspaceIncarnationFor?.(session)).toBe(
      cluster.claims.get(plane.driver.claimName(session))!.metadata!.uid
    )
  })

  it('routes a read of a suspended session directory to that session pod, waking it, not to the agent pod', async () => {
    // `suspendIfIdle` forgets the launch while the claim and its volume survive on purpose, so the
    // live-launch registry cannot be what tells a path its pod. The console's `agent/wake` binds the
    // AGENT subject; a session workspace routed off that registry would be read on the agent pod,
    // where the directory does not exist — and reported as an empty workspace rather than a refusal.
    const cluster = fakeCluster()
    // Short, because what this asserts about the woken pod is that the read waited for IT: the one
    // listener the harness has is the agent's, so the session pod's channel never arrives.
    const plane = await planeUnderTest(cluster as never, 250)
    const port = shimPort(plane)
    const T1 = sessionHostKey('agent-a', 'slack:C1:T1:agent-a')
    const leaf = hostKeyDirName(T1)
    const session = sandboxSubjectFor(T1)
    const sessionPath = `/agent/sessions/${leaf}/workspace`
    const served: string[] = []

    // The agent's own pod is up — the console's wake is agent-scoped, so this is the press a read has.
    const agentBinding = plane.driver.ensureBoundChannel('agent-a')
    shimAgainst(port, {
      workspaceRoot: '/agent',
      token: 'pod-agent',
      handle: async (capability, payload) => {
        served.push((payload as { rel: string }).rel)
        if (capability === 'read') return { ok: true, value: 'dir' }
        throw new Error(`unexpected capability ${capability}`)
      }
    })
    await agentBinding

    // The session pod was claimed and then swept as idle: its claim stands, its launch is forgotten.
    await plane.driver.ensureSandbox(session)
    expect(await plane.suspendIdle(session)).toBe('suspended')
    expect(plane.launched().map((launch) => launch.subject)).toEqual(['agent-a'])
    expect(cluster.claims.has(plane.driver.claimName(session))).toBe(true)
    served.length = 0

    // The read names the session's directory, so it waits for the SESSION pod's channel and refuses
    // when none arrives — it is never answered by the agent pod, which is the whole bug.
    const placement = plane.workspaceFsFor('agent-a')!
    await expect(placement.fs.stat(sessionPath)).rejects.toThrow(`no shim channel bound for ${session} in time`)
    expect(served).toEqual([])
    // Waking it is a resume of the claim the cluster already holds, never a new one.
    expect([...cluster.claims.keys()].sort()).toEqual(['agent-agent-a', plane.driver.claimName(session)].sort())
    // The agent pod still answers for its own paths, on the same routed port.
    expect(await placement.fs.stat('/agent/checkout')).toBe('dir')
    expect(served).toEqual(['checkout'])
    // And the git runner for a sleeping session directory is deferred rather than withheld, so the
    // caller does not silently fall back to a local runner for a path that lives on a pod.
    expect(plane.gitRunnerFor('agent-a', sessionPath)).toBeDefined()
    expect(plane.gitRunnerFor('agent-a', '/agent/checkout')).toBeDefined()
  })

  it('refuses a suspended session path rather than waking its pod with the agent pod down', async () => {
    // The console's wake is agent-scoped, so a bound agent pod IS the press that admits a session pod.
    // With nothing bound there is no press, and a read must refuse instead of claiming a pod of its own.
    const cluster = fakeCluster()
    const plane = await planeUnderTest(cluster as never)
    const port = shimPort(plane)
    const T1 = sessionHostKey('agent-a', 'slack:C1:T1:agent-a')
    const leaf = hostKeyDirName(T1)
    const session = sandboxSubjectFor(T1)
    const sessionPath = `/agent/sessions/${leaf}/workspace`

    const binding = plane.driver.ensureBoundChannel(session)
    shimAgainst(port, {
      workspaceRoot: '/agent',
      token: 'pod-session',
      handle: async () => ({ ok: true, value: 'dir' })
    })
    await binding
    expect(await plane.suspendIdle(session)).toBe('suspended')

    // No pod of this agent is bound, so the workspace seams hand the caller nothing at all.
    expect(plane.runsInSandbox('agent-a')).toBe(false)
    expect(plane.workspaceFsFor('agent-a')).toBeUndefined()
    expect(plane.workspaceFilesFor('agent-a')).toBeUndefined()
    expect(plane.gitRunnerFor('agent-a', sessionPath)).toBeUndefined()
    expect(await plane.clearPath('agent-a', sessionPath)).toMatch(/no bound sandbox channel/)
    // And nothing was woken behind the refusal: the claim is untouched and no launch was recorded.
    expect(plane.launched()).toEqual([])
    expect(cluster.claims.has(plane.driver.claimName(session))).toBe(true)
  })
})
