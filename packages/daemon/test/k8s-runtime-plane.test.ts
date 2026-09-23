import { afterEach, describe, expect, it, vi } from 'vitest'
import { Backoff, FakeClock } from '@agentconnect.md/connection'
import {
  k8sPlaneSettings,
  startK8sRuntimePlane,
  type K8sRuntimePlane,
  sandboxMemoryRoot
} from '../src/k8s/runtime-plane.js'
import { PROBE_CLAIM_EXPIRES_ANNOTATION, PROBE_CLAIM_LABEL, probeAgentId } from '../src/k8s/probe-claim.js'
import {
  AC_LABEL_AGENT,
  AC_LABEL_SESSION,
  sandboxSubjectFor,
  sessionSandboxSubject
} from '../src/k8s/sandbox-identity.js'
import { wireWorkspacePlane, type PlaneLaunch } from '../src/execution/plane.js'
import type { ControlWire } from '../src/cp/control/context.js'
import { workspaceError } from '../src/cp/control/workspace.js'
import { createWorkspaceReader } from '../src/cp/workspace-reader.js'
import { createWorkspaceGit } from '../src/cp/workspace-git.js'
import { createAgentWaker, sessionPodOf } from '../src/cp/agent-wake.js'
import { createWorkspaceScope } from '../src/cp/workspace-scope.js'
import { AgentSchema } from '../src/agents/agent-schema.js'
import { WorkspaceManager } from '../src/workspace/workspace-manager.js'
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
    // Its workspace is on a pod's volume all the same: the placement never waits for the channel.
    expect(plane.workspacesOffDisk).toBe(true)

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
  let stamps = 0
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
      // A resume publishes a launch without admitting one, so it stamps the claim it resumes onto.
      stampClaim: async (name: string, annotations: Record<string, string>) => {
        const existing = claims.get(name)
        if (!existing) throw new K8sApiError(404, 'NotFound', 'no claim')
        const claim = {
          ...existing,
          metadata: {
            ...existing.metadata,
            annotations: { ...existing.metadata?.annotations, ...annotations },
            resourceVersion: `rv-${++stamps}`
          }
        }
        claims.set(name, claim)
        return { claim }
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
    // Memory is the agent pod's, so it is unreachable — never the session pod's by mistake.
    expect(plane.memoryFsFor('agent-a')).toBeUndefined()
    // Merge-when-ready asks each pod for itself: the session pod's channel answers, granted the capability, while the agent pod's has none.
    expect(plane.autoMergeSubjects('agent-a')).toEqual(['agent-a', session])
    expect(plane.boundSubjects('agent-a')).toEqual([session])
    expect(await plane.autoMergeAt('agent-a', true)).toBeUndefined()
    expect(await plane.autoMergeAt(session)).toBeDefined()
    expect(plane.dialer.connectionsFor(session)[0]?.binding.grants).toContain('automerge')

    // A path under the session directory is the session pod's; everything else is the agent pod's and
    // refuses rather than falling back onto the session pod.
    expect(plane.gitRunnerFor('agent-a', `/agent/sessions/${leaf}/workspace`)).toBeDefined()
    expect(plane.gitRunnerFor('agent-a', `/agent/sessions/${leaf}`)).toBeDefined()
    expect(plane.gitRunnerFor('agent-a', '/agent/checkout')).toBeUndefined()
    // Another session's directory is its own pod's, which is not bound: its runner refuses rather than being served by this one.
    await expect(
      plane.gitRunnerFor('agent-a', `/agent/sessions/${leaf}-other/workspace`)!.raw(['status'])
    ).rejects.toMatchObject({ name: 'WorkspaceViolationError', reason: 'sandbox-unavailable' })
    expect(plane.gitRunnerFor('agent-a')).toBeUndefined()
    const placement = plane.workspaceFsFor('agent-a')!
    expect(placement.mount).toBe('/agent')
    expect(await placement.fs.stat(`/agent/sessions/${leaf}/workspace`)).toBe('dir')
    expect(served.map((payload) => (payload as { rel: string }).rel)).toEqual([`sessions/${leaf}/workspace`])
    await expect(placement.fs.stat('/agent/checkout')).rejects.toMatchObject({ reason: 'sandbox-unavailable' })
    expect(await plane.clearPath('agent-a', '/agent/checkout')).toMatch(/no bound sandbox channel/)
    expect(plane.workspaceIncarnationFor?.(session)).toBe(
      cluster.claims.get(plane.driver.claimName(session))!.metadata!.uid
    )

    // Retirement deletes the claim and its pod, and the watcher in it with them: nothing is left to ask, or to bind.
    await plane.discardSession('agent-a', leaf)
    expect(plane.autoMergeSubjects('agent-a')).toEqual(['agent-a'])
    expect(await plane.autoMergeAt(session, true)).toBeUndefined()
  })

  it("refuses an unbound agent pod's paths with the typed reason the console wakes on, for files and git alike", async () => {
    // What an isolated session leaves once its agent pod may sleep: the session pod bound, the agent pod not.
    const cluster = fakeCluster()
    const plane = await planeUnderTest(cluster as never)
    const port = shimPort(plane)
    const T1 = sessionHostKey('agent-a', 'slack:C1:T1:agent-a')
    const leaf = hostKeyDirName(T1)
    const binding = plane.driver.ensureBoundChannel(sandboxSubjectFor(T1))
    shimAgainst(port, { workspaceRoot: '/agent', token: 'pod-1', handle: async () => ({ ok: true, value: 'dir' }) })
    await binding
    expect(plane.sandboxBound('agent-a')).toBe(false)
    // The message rides the wire to the Control Plane, so it names the pod and never the path.
    const refusal = {
      name: 'WorkspaceViolationError',
      reason: 'sandbox-unavailable',
      message: expect.not.stringContaining('/agent/checkout')
    }

    // The console's read of the primary checkout, through the reader and the wire mapping its request takes.
    const reader = createWorkspaceReader(
      new WorkspaceManager(),
      async () => ({ root: '/agent/checkout', scratch: false }),
      async (_agentId, write) => await write(),
      (agentId) => plane.workspaceFilesFor(agentId)
    )
    const listed = await reader.list({ agentId: 'agent-a', path: '', limit: 50 }).catch((err: unknown) => err)
    expect(listed).toMatchObject(refusal)
    await expect(reader.read({ agentId: 'agent-a', path: 'README.md', offset: 0, limit: 64 })).rejects.toMatchObject(
      refusal
    )
    const sendError = vi.fn()
    workspaceError({ sendError, log: { warn: vi.fn() } } as unknown as ControlWire, 'req-1', 'workspace/list', listed)
    expect(sendError).toHaveBeenCalledWith('req-1', 'BAD_PAYLOAD', expect.any(String), false, {
      reason: 'sandbox-unavailable'
    })
    // A read that resolves a session's secondary clone through the agent pod's marker refuses the same way.
    await expect(
      plane
        .workspaceFsFor('agent-a')!
        .fs.readFileBytes('/agent/repos/example-org/example-repo/.materialization.json', 1024)
    ).rejects.toMatchObject(refusal)

    // Git on the agent pod's paths refuses rather than running on this member's disk; the session's own path still runs.
    const workspaces = new WorkspaceManager()
    wireWorkspacePlane(workspaces, plane)
    expect(workspaces.runnerFor('agent-a', `/agent/sessions/${leaf}/workspace`)).toBeDefined()
    for (const cwd of ['/agent/checkout', undefined]) {
      let thrown: unknown
      try {
        workspaces.runnerFor('agent-a', cwd)
      } catch (err) {
        thrown = err
      }
      expect(thrown).toMatchObject({ name: 'WorkspaceViolationError', reason: 'sandbox-unavailable' })
    }
  })

  it('refuses a read and a git status of a sleeping session pod beside a bound agent pod, waking nothing', async () => {
    // A bound agent pod once carried every read into a sleeping session pod, so the Control Plane's pull-request capture woke old sessions one by one; only the session wake resumes one now.
    const cluster = fakeCluster()
    // Short, so a read that did try to resume would fail fast: the one listener the harness has is the agent pod's.
    const plane = await planeUnderTest(cluster as never, 250)
    const port = shimPort(plane)
    const T1 = sessionHostKey('agent-a', 'slack:C1:T1:agent-a')
    const leaf = hostKeyDirName(T1)
    const session = sandboxSubjectFor(T1)
    const sessionClaim = plane.driver.claimName(session)
    const sessionPath = `/agent/sessions/${leaf}/workspace`
    const served: string[] = []

    // The agent's own pod is up, as a console wake, a shared session or a conversion leaves it.
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
    const resume = vi.spyOn(plane.driver, 'resumeBoundChannel')
    served.length = 0
    const refusal = { name: 'WorkspaceViolationError', reason: 'sandbox-unavailable' }

    // Routed off the path, not the launch the sweep forgot, both file ports refuse as asleep and never fall back onto the agent pod, where that directory does not exist.
    await expect(
      plane.workspaceFilesFor('agent-a')!.list(sessionPath, { agentId: 'agent-a', path: '', limit: 50 })
    ).rejects.toMatchObject(refusal)
    const placement = plane.workspaceFsFor('agent-a')!
    await expect(placement.fs.stat(sessionPath)).rejects.toMatchObject(refusal)
    // The git status the capture sends refuses the same way, under the reason it rides the wire with.
    const workspaces = new WorkspaceManager()
    wireWorkspacePlane(workspaces, plane)
    const status = await createWorkspaceGit(workspaces, async () => sessionPath)
      .status('agent-a', 'outward-1')
      .catch((err: unknown) => err)
    expect(status).toMatchObject(refusal)
    const sendError = vi.fn()
    workspaceError(
      { sendError, log: { warn: vi.fn() } } as unknown as ControlWire,
      'req-1',
      'workspace/gitstatus',
      status
    )
    expect(sendError).toHaveBeenCalledWith('req-1', 'BAD_PAYLOAD', expect.any(String), false, {
      reason: 'sandbox-unavailable'
    })

    // Nothing was resumed, claimed or bound behind the refusals, and the agent pod was not asked in its place.
    expect(resume).not.toHaveBeenCalled()
    expect(plane.sandboxBound(session)).toBe(false)
    expect(plane.launched().map((launch) => launch.subject)).toEqual(['agent-a'])
    expect([...cluster.claims.keys()].sort()).toEqual(['agent-agent-a', sessionClaim].sort())
    expect(served).toEqual([])
    // The agent pod still answers for its own paths, on the same routed port.
    expect(await placement.fs.stat('/agent/checkout')).toBe('dir')
    expect(served).toEqual(['checkout'])
  })

  it('refuses a suspended session path rather than waking its pod with the agent pod down', async () => {
    // A read never resumes a session pod, whether or not the agent pod is bound; the session's own press is the waker's.
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
    const resume = vi.spyOn(plane.driver, 'resumeBoundChannel')

    // No pod of this agent is bound: the file port still routes, and the session's root refuses as asleep, the reason the console wakes on.
    expect(plane.runsInSandbox('agent-a')).toBe(false)
    expect(plane.workspaceFsFor('agent-a')).toBeUndefined()
    const asleep = { name: 'WorkspaceViolationError', reason: 'sandbox-unavailable' }
    await expect(
      plane.workspaceFilesFor('agent-a')!.list(sessionPath, { agentId: 'agent-a', path: '', limit: 50 })
    ).rejects.toMatchObject(asleep)
    // Git's runner refuses the same way when first used rather than being absent, so it can say removed too.
    await expect(plane.gitRunnerFor('agent-a', sessionPath)!.raw(['status'])).rejects.toMatchObject(asleep)
    expect(await plane.clearPath('agent-a', sessionPath)).toMatch(/no bound sandbox channel/)
    // And nothing was woken behind the refusal: the claim is untouched and no launch was recorded.
    expect(resume).not.toHaveBeenCalled()
    expect(plane.launched()).toEqual([])
    expect(cluster.claims.has(plane.driver.claimName(session))).toBe(true)
  })

  it('tells a removed session sandbox apart from a sleeping one on a read and in git, whether or not the agent pod is up', async () => {
    const cluster = fakeCluster()
    const plane = await planeUnderTest(cluster as never)
    const port = shimPort(plane)
    const T1 = sessionHostKey('agent-a', 'slack:C1:T1:agent-a')
    const session = sandboxSubjectFor(T1)
    const sessionPath = `/agent/sessions/${hostKeyDirName(T1)}/workspace`
    const reader = createWorkspaceReader(
      new WorkspaceManager(),
      async () => ({ root: sessionPath, scratch: false }),
      async (_agentId, write) => await write(),
      (agentId) => plane.workspaceFilesFor(agentId)
    )
    const list = () => reader.list({ agentId: 'agent-a', path: '', limit: 50 }).catch((err: unknown) => err)
    // The git status the dock's Git tab and the pull-request capture both send.
    const workspaces = new WorkspaceManager()
    wireWorkspacePlane(workspaces, plane)
    const status = () =>
      createWorkspaceGit(workspaces, async () => sessionPath)
        .status('agent-a', 'outward-1')
        .catch((err: unknown) => err)
    const resume = vi.spyOn(plane.driver, 'resumeBoundChannel')

    // Asleep with the agent pod down: the claim stands, so the read and git refuse as the console wakes on, and wake nothing.
    await plane.driver.ensureSandbox(session)
    expect(await plane.suspendIdle(session)).toBe('suspended')
    expect(plane.sandboxBound('agent-a')).toBe(false)
    expect(await list()).toMatchObject({ reason: 'sandbox-unavailable' })
    expect(await status()).toMatchObject({ name: 'WorkspaceViolationError', reason: 'sandbox-unavailable' })

    // A workspace replacement retires the claim, its volume with it, while the session row stays.
    cluster.claims.delete(plane.driver.claimName(session))
    const removed = {
      name: 'WorkspaceViolationError',
      reason: 'sandbox-removed',
      message: expect.not.stringContaining(sessionPath)
    }
    const refusal = await list()
    expect(refusal).toMatchObject(removed)
    // Git says so with the agent pod still down, asking the claim rather than refusing as asleep.
    const gitRefusal = await status()
    expect(gitRefusal).toMatchObject(removed)
    // Beside a bound agent pod too, whose runner asks when first used there.
    const agentBinding = plane.driver.ensureBoundChannel('agent-a')
    shimAgainst(port, { workspaceRoot: '/agent', token: 'pod-agent', handle: async () => ({ ok: true, value: 'dir' }) })
    await agentBinding
    expect(await list()).toMatchObject(removed)
    expect(await status()).toMatchObject(removed)

    // Both ride the wire under their own reason, never the asleep one the console would offer Start for.
    for (const [op, err] of [
      ['workspace/list', refusal],
      ['workspace/gitstatus', gitRefusal]
    ] as const) {
      const sendError = vi.fn()
      workspaceError({ sendError, log: { warn: vi.fn() } } as unknown as ControlWire, 'req-1', op, err)
      expect(sendError).toHaveBeenCalledWith('req-1', 'BAD_PAYLOAD', expect.any(String), false, {
        reason: 'sandbox-removed'
      })
    }
    // Nothing was resumed or created behind any refusal.
    expect(resume).not.toHaveBeenCalled()
    expect([...cluster.claims.keys()]).toEqual(['agent-agent-a'])
    expect(plane.launched().map((launch) => launch.subject)).toEqual(['agent-a'])
  })

  /** The session wake's plane half, wired as the daemon wires it, for one session pod. */
  function sessionWaker(plane: K8sRuntimePlane, session: string, warn: (message: string) => void = () => {}) {
    return createAgentWaker({
      sandbox: {
        isRunning: (subject) => plane.sandboxBound(subject),
        ensureChannel: (subject) => plane.ensureChannel(subject),
        sessionPod: async () => session,
        claimUidFor: (subject) => plane.claimUidFor(subject),
        resumeChannel: (subject, claimUid) => plane.resumeChannel(subject, claimUid)
      },
      knowsAgent: () => true,
      log: { warn }
    })
  }

  it('resumes a sleeping session pod through the session wake, never claiming or binding the agent pod', async () => {
    const cluster = fakeCluster()
    const plane = await planeUnderTest(cluster as never)
    const port = shimPort(plane)
    const T1 = sessionHostKey('agent-a', 'slack:C1:T1:agent-a')
    const session = sandboxSubjectFor(T1)
    const sessionPath = `/agent/sessions/${hostKeyDirName(T1)}/workspace`
    const handle = async () => ({ ok: true, value: 'dir' })

    // The session pod ran and was swept as idle; the agent pod was never up on this member.
    const binding = plane.driver.ensureBoundChannel(session)
    shimAgainst(port, { workspaceRoot: '/agent', token: 'pod-session', handle })
    await binding
    expect(await plane.suspendIdle(session)).toBe('suspended')
    expect(plane.sandboxBound(session)).toBe(false)

    // The resumed pod answers the member's next dial.
    shimAgainst(port, { workspaceRoot: '/agent', token: 'pod-session-resumed', handle })
    const claimUid = cluster.claims.get(plane.driver.claimName(session))!.metadata!.uid
    const resume = vi.spyOn(plane.driver, 'resumeBoundChannel')
    const waker = sessionWaker(plane, session)
    await expect(waker.wake({ agentId: 'agent-a', sessionId: 'outward-1' })).resolves.toEqual({
      agentId: 'agent-a',
      state: 'starting'
    })
    expect(await until(() => plane.sandboxBound(session))).toBe(true)
    await expect(waker.wake({ agentId: 'agent-a', sessionId: 'outward-1' })).resolves.toEqual({
      agentId: 'agent-a',
      state: 'running'
    })

    // One pod: the agent's was neither claimed nor bound, and the session's is resumed onto the claim it observed.
    expect(resume).toHaveBeenCalledTimes(1)
    expect(resume).toHaveBeenCalledWith(session, claimUid)
    expect(plane.sandboxBound('agent-a')).toBe(false)
    expect([...cluster.claims.keys()]).toEqual([plane.driver.claimName(session)])
    expect(cluster.claims.get(plane.driver.claimName(session))!.metadata!.uid).toBe(claimUid)
    expect(plane.launched().map((launch) => launch.subject)).toEqual([session])
    // And the page's read is now served from it.
    expect(await plane.workspaceFsFor('agent-a')!.fs.stat(sessionPath)).toBe('dir')
  })

  it("wakes a scratch agent's isolated session whose only roots are additional-repository clones, and says when its claim is gone", async () => {
    // A scratch primary has no Git root, so a pod located off it would be none at all; the session's clones are on its own pod (§11).
    const cluster = fakeCluster()
    const plane = await planeUnderTest(cluster as never)
    const port = shimPort(plane)
    const KEY = 'slack:C1:T1:agent-a'
    const session = sandboxSubjectFor(sessionHostKey('agent-a', KEY))
    const repo = 'example-org/example-repo'
    const agent = AgentSchema.parse({
      id: 'agent-a',
      name: 'agent-a',
      status: 'active',
      runtime: 'claude',
      workspace: {
        mode: 'from-scratch',
        path: '/home/agent/workspace',
        additionalRepos: [{ repoFullName: repo, repoId: '4242' }]
      },
      integrations: [],
      output: { mode: 'low' }
    })
    const workspaces = new WorkspaceManager()
    wireWorkspacePlane(workspaces, plane)
    const scope = createWorkspaceScope({
      workspaces,
      agentOf: (id) => (id === 'agent-a' ? agent : undefined),
      sessionOf: async (_id, sessionId) =>
        sessionId === 'outward-1'
          ? { key: KEY, workspaceIsolation: 'session' as const }
          : sessionId === 'outward-shared'
            ? { key: 'slack:C1:T2:agent-a', workspaceIsolation: 'shared' as const }
            : undefined,
      runtimeRootOf: (id) => plane.workspaceRootFor(id)
    })
    // A shared session's roots are the agent's checkout, so it names the agent's pod; an unknown one names none.
    await expect(sessionPodOf(scope, plane, 'agent-a', 'outward-shared')).resolves.toBe('agent-a')
    await expect(sessionPodOf(scope, plane, 'agent-a', 'outward-unknown')).resolves.toBeUndefined()
    // The premise: no primary root to route by, while the page's own scope reads a clone in the session's directory.
    await expect(scope.gitRoot('agent-a', 'outward-1')).resolves.toBeUndefined()
    expect((await scope.location('agent-a', 'outward-1', repo))?.root).toBe(
      `/agent/sessions/${hostKeyDirName(sessionHostKey('agent-a', KEY))}/repos/${repo}`
    )

    const handle = async () => ({ ok: true, value: 'dir' })
    const binding = plane.driver.ensureBoundChannel(session)
    shimAgainst(port, { workspaceRoot: '/agent', token: 'pod-session', handle })
    await binding
    expect(await plane.suspendIdle(session)).toBe('suspended')

    const waker = createAgentWaker({
      sandbox: {
        isRunning: (subject) => plane.sandboxBound(subject),
        ensureChannel: (subject) => plane.ensureChannel(subject),
        sessionPod: (id, sessionId) => sessionPodOf(scope, plane, id, sessionId),
        claimUidFor: (subject) => plane.claimUidFor(subject),
        resumeChannel: (subject, claimUid) => plane.resumeChannel(subject, claimUid)
      },
      knowsAgent: () => true,
      log: { warn: () => {} }
    })
    shimAgainst(port, { workspaceRoot: '/agent', token: 'pod-session-resumed', handle })
    await expect(waker.wake({ agentId: 'agent-a', sessionId: 'outward-1' })).resolves.toEqual({
      agentId: 'agent-a',
      state: 'starting'
    })
    expect(await until(() => plane.sandboxBound(session))).toBe(true)
    // The session's pod alone: the agent's was neither claimed nor bound.
    expect(plane.sandboxBound('agent-a')).toBe(false)
    expect([...cluster.claims.keys()]).toEqual([plane.driver.claimName(session)])

    // Retired while its row stays: the wake says so rather than creating a claim.
    expect(await plane.suspendIdle(session)).toBe('suspended')
    cluster.claims.delete(plane.driver.claimName(session))
    await expect(waker.wake({ agentId: 'agent-a', sessionId: 'outward-1' })).rejects.toMatchObject({
      reason: 'sandbox-removed'
    })
    expect([...cluster.claims.keys()]).toEqual([])
    expect(plane.launched()).toEqual([])
  })

  it('refuses a session wake whose claim was replaced after it was observed, binding and creating nothing', async () => {
    // The observation and the resume are two round trips: a conversion and a new message can swap the claim between them.
    const cluster = fakeCluster()
    const plane = await planeUnderTest(cluster as never)
    const port = shimPort(plane)
    const session = sandboxSubjectFor(sessionHostKey('agent-a', 'slack:C1:T1:agent-a'))
    const binding = plane.driver.ensureBoundChannel(session)
    shimAgainst(port, {
      workspaceRoot: '/agent',
      token: 'pod-session',
      handle: async () => ({ ok: true, value: 'dir' })
    })
    await binding
    expect(await plane.suspendIdle(session)).toBe('suspended')

    const sessionClaim = plane.driver.claimName(session)
    const read = cluster.api.getClaim
    let observed = 0
    cluster.api.getClaim = async (name: string) => {
      const claim = await read(name)
      if (name === sessionClaim && ++observed === 1) {
        cluster.claims.set(name, { ...claim, metadata: { ...claim.metadata, uid: 'claim-replacement' } })
      }
      return claim
    }

    const warn = vi.fn()
    await expect(
      sessionWaker(plane, session, warn).wake({ agentId: 'agent-a', sessionId: 'outward-1' })
    ).resolves.toEqual({
      agentId: 'agent-a',
      state: 'starting'
    })
    expect(await until(() => warn.mock.calls.length > 0)).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no longer holds claim'))
    // The replacement is left as it is: nothing resumed onto it, nothing bound, and no claim of the wake's own.
    expect(plane.sandboxBound(session)).toBe(false)
    expect(plane.launched()).toEqual([])
    expect([...cluster.claims.keys()]).toEqual([sessionClaim])
    expect(cluster.claims.get(sessionClaim)?.metadata?.uid).toBe('claim-replacement')
  })

  it('hands the driver a host key only for a confined session host, so every other host lands in the agent pod', async () => {
    const plane = await planeUnderTest(fakeApi())
    const hostKey = sessionHostKey('agent-a', 'slack:C1:T1:agent-a')
    const launch = (confined: boolean) => ({ hostKey, confined: () => confined }) as PlaneLaunch

    expect(plane.spawnFor(launch(true))).toStrictEqual({ driver: plane.driver, hostKey })
    // A dream or model-session host is session-keyed too, and must not claim a pod of its own.
    expect(plane.spawnFor(launch(false))).toStrictEqual({ driver: plane.driver })
  })

  it('retires every session claim of the agent but the leaf spared, whether or not this member launched it', async () => {
    const cluster = fakeCluster()
    const plane = await planeUnderTest(cluster as never)
    const claim = (agentId: string, leaf?: string) => {
      const name = plane.driver.claimName(leaf === undefined ? agentId : sessionSandboxSubject(agentId, leaf))
      const labels = { [AC_LABEL_AGENT]: agentId, ...(leaf === undefined ? {} : { [AC_LABEL_SESSION]: leaf }) }
      cluster.claims.set(name, { metadata: { name, labels } } as SandboxClaim)
      return name
    }
    const kept = [claim('agent-a'), claim('agent-a', 'session-spared'), claim('agent-b', 'session-other')]
    claim('agent-a', 'session-one')
    claim('agent-a', 'session-two')

    await plane.discardSessions('agent-a', 'session-spared')
    expect([...cluster.claims.keys()].sort()).toEqual([...kept].sort())
  })
})
