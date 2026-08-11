import { loadInClusterConfig } from './config.js'
import { K8sHttp } from './http.js'
import { K8sDriver, PROBE_GRANTS } from './driver.js'
import { SandboxApi } from './sandbox-api.js'
import { clusterMetrics } from './cluster-metrics.js'
import { ShimListener } from '../shim/listener.js'
import { ShimGitRunner } from '../shim/git-exec.js'
import { TunnelProxy } from '../shim/tunnel-proxy.js'
import type { TunnelName } from '../shim/tunnel.js'
import type { ShimSession } from '../shim/session.js'
import type { SpawnRecord } from '../shim/binding.js'
import { K8sRuntimeTableSchema, type K8sRuntimeTable } from '../runtimes/k8s-runtimes.js'
import type { GitRunner } from '../workspace/git-runner.js'

const SILENT = { info: () => {}, warn: () => {} }

/** Reserved agent id for the runtime probe. Not a real agent, and never assigned one: its claim is
 *  `agent-<this>`, so the name must not collide with an id the Control Plane could hand out. */
export const PROBE_AGENT_ID = 'ac-runtime-probe'
/** A probe drives every runtime through `initialize` plus a session, on a possibly cold pod. */
const PROBE_TIMEOUT_MS = 180_000

/**
 * Assembles the k8s execution plane: the shim endpoint, the driver, and the seams that make an
 * agent's git run where its workspace actually is.
 *
 * It exists because every piece of this was built and tested separately and nothing put them
 * together — `--k8s` changed the daemon's BEHAVIOUR (no probing, declared runtimes, no host
 * sandbox) while `AcpHost` still fell back to `LocalDriver`, so runtimes kept running on the
 * daemon's own host and no Sandbox was ever created.
 */
export interface K8sRuntimePlaneOptions {
  /** Org the claims are labelled with; one daemon serves one org in the managed cluster.
   *  Resolved from the deployment's env when omitted. */
  orgId?: string
  /** Warm pool the claims reference. v1beta1 requires one; a cold pool is `replicas: 0`. */
  warmPoolName?: string
  /** Port the shim dials back on. The pod learns it from the template's AC_SHIM_ENDPOINT, so
   *  this side only has to listen — the daemon never dials into a sandbox. */
  shimPort?: number
  shimHost?: string
  /** Environment the deployment settings come from; `process.env` unless a test names another. */
  env?: NodeJS.ProcessEnv
  readyTimeoutMs?: number
  /** Kubernetes surface. Built from the pod's own in-cluster config when omitted; supplied by
   *  tests so the assembly can be exercised without a cluster. */
  api?: SandboxApi
  /**
   * Which daemon-side sockets an agent's sandbox needs a tunnel to, and where each one lives.
   *
   * Both halves are the DAEMON's to answer: only it knows that this agent authenticates git
   * through a GitHub App, and only it knows the path its own server listens on. The plane holds
   * the mechanism and no policy — omit either and no tunnel is opened.
   */
  tunnelsFor?: (agentId: string) => TunnelName[]
  tunnelSocketPath?: (tunnel: TunnelName) => string | undefined
  /** Lifetime of an issued session credential. The shim renews at half of it, so a test that has
   *  to cross a renewal shortens it rather than waiting out the default. */
  credentialTtlMs?: number
  log?: { info: (m: string) => void; warn: (m: string) => void; debug?: (m: string) => void }
}

export interface K8sPlaneSettings {
  orgId: string
  warmPoolName: string
  shimPort: number
  shimHost?: string
}

/** Deployment-owned settings. Env rather than the config file: they describe where this pod sits
 *  in the cluster, which is the deployment's to state and not an operator preference. */
export const K8S_ORG_ID_ENV = 'AC_K8S_ORG_ID'
export const K8S_WARM_POOL_ENV = 'AC_K8S_WARM_POOL'
export const K8S_SHIM_PORT_ENV = 'AC_K8S_SHIM_PORT'
export const K8S_SHIM_HOST_ENV = 'AC_K8S_SHIM_HOST'
export const DEFAULT_SHIM_PORT = 8085

/** Explicit options win per FIELD, so a caller may name one and leave the rest to the env. */
export function resolveK8sPlaneSettings(options: K8sRuntimePlaneOptions = {}): K8sPlaneSettings {
  const env = options.env ?? process.env
  const orgId = options.orgId ?? env[K8S_ORG_ID_ENV]?.trim()
  const warmPoolName = options.warmPoolName ?? env[K8S_WARM_POOL_ENV]?.trim()
  // Refused rather than defaulted: a guessed org labels another tenant's claims, and a guessed
  // pool yields sandboxes that never bind with nothing in the logs saying why.
  if (!orgId) throw new Error(`--k8s requires ${K8S_ORG_ID_ENV}`)
  if (!warmPoolName) throw new Error(`--k8s requires ${K8S_WARM_POOL_ENV}`)
  const rawPort = options.shimPort ?? env[K8S_SHIM_PORT_ENV] ?? DEFAULT_SHIM_PORT
  const shimPort = Number(rawPort)
  if (!Number.isInteger(shimPort) || shimPort < 0 || shimPort > 65_535) {
    throw new Error(`${K8S_SHIM_PORT_ENV} is not a valid port: ${rawPort}`)
  }
  const shimHost = options.shimHost ?? env[K8S_SHIM_HOST_ENV]?.trim()
  return { orgId, warmPoolName, shimPort, ...(shimHost ? { shimHost } : {}) }
}

/** The env contract on its own, which is what a deployment has to satisfy. */
export function k8sPlaneSettings(env: NodeJS.ProcessEnv): K8sPlaneSettings {
  return resolveK8sPlaneSettings({ env })
}

export interface K8sRuntimePlane {
  driver: K8sDriver
  listener: ShimListener
  /** Bring an agent's Sandbox up and bind its channel WITHOUT starting a runtime, so the
   *  workspace can be prepared on the pod's own volume before the runtime looks at it. */
  ensureChannel: (agentId: string) => Promise<void>
  /** Ask a sandbox which runtimes the image actually provides, and tear it down again. */
  probeRuntimes: () => Promise<K8sRuntimeTable>
  /** A git runner for an agent whose workspace lives on its sandbox pod, or undefined when this
   *  daemon has no channel for it — the caller then keeps its local behaviour. */
  gitRunnerFor: (agentId: string, cwd?: string, abort?: AbortSignal) => GitRunner | undefined
  /** Where the agent's bound pod mounts its workspace, as its shim reported; undefined before a
   *  bind or from a legacy shim (callers fall back to DEFAULT_SHIM_WORKSPACE_ROOT). */
  workspaceRootFor: (agentId: string) => string | undefined
  stop: () => Promise<void>
}

/**
 * Build and start the plane. Throws if the process is not in a pod: `--k8s` outside a cluster is a
 * misconfiguration to report at boot, not something to degrade into running runtimes locally —
 * that degradation is precisely the shape that would put agent code on the daemon's host.
 */
export async function startK8sRuntimePlane(options: K8sRuntimePlaneOptions): Promise<K8sRuntimePlane> {
  // Resolved HERE rather than by the caller, so the whole env contract lives in one place and a
  // caller that overrides this factory (a test) does not have to satisfy it.
  const settings = resolveK8sPlaneSettings(options)
  const api =
    options.api ??
    (() => {
      const config = loadInClusterConfig()
      return new SandboxApi(new K8sHttp(config), config.namespace)
    })()

  // Records keyed by the pod they authorize. A TokenReview yields a pod name and uid and nothing
  // else, so this map is the whole of how a dialing pod is resolved back to its launch.
  const recordsByPod = new Map<string, SpawnRecord>()

  const listener = new ShimListener({
    verifier: { reviewToken: (token, audiences) => api.reviewToken(token, audiences) },
    spawnRecordForPod: (pod) => recordsByPod.get(pod.name),
    now: () => Date.now(),
    metrics: clusterMetrics,
    onConnection: (connection) => {
      // A rebind cancels any pending loss check: this IS the replacement it was waiting for.
      clearTimeout(lossTimers.get(connection.binding.agentId))
      lossTimers.delete(connection.binding.agentId)
      driver.onChannelBound(connection)
    },
    // A closed socket is NOT a lost launch. The shim closes and re-dials at half the credential
    // TTL, and `ShimSession.lose()` is terminal — reporting loss here killed the runtime on every
    // routine renewal, which is the exact failure ShimSession exists to prevent. Loss is reported
    // only if no replacement binds for the same launch within the grace window.
    onConnectionLost: (agentId, reason) => scheduleLossCheck(agentId, reason),
    ...(options.credentialTtlMs === undefined ? {} : { credentialTtlMs: options.credentialTtlMs }),
    log: options.log ?? SILENT
  })
  // One proxy per agent, replaced when a NEW launch binds: its streams belong to a pod, and a
  // proxy kept across incarnations would answer connections for a sandbox that no longer exists.
  const proxies = new Map<string, { generation: number; proxy: TunnelProxy }>()

  async function ensureTunnels(agentId: string, session: ShimSession): Promise<void> {
    const wanted = options.tunnelsFor?.(agentId) ?? []
    const socketPathFor = options.tunnelSocketPath
    if (wanted.length === 0 || !socketPathFor) return
    const existing = proxies.get(agentId)
    // Stopped counts as gone: a proxy whose session was lost can never serve again, and reusing
    // one would leave the sandbox with a socket whose daemon end refuses every connection.
    if (existing && (existing.generation !== session.generation || existing.proxy.isStopped())) {
      existing.proxy.stop(`superseded by generation ${session.generation}`)
      proxies.delete(agentId)
    }
    let entry = proxies.get(agentId)
    if (!entry) {
      entry = {
        generation: session.generation,
        proxy: new TunnelProxy({ session, socketPathFor, log: options.log ?? SILENT })
      }
      proxies.set(agentId, entry)
    }
    // Sequential rather than concurrent: this is on the launch path, the list has two members at
    // most, and one failing tunnel must not lose the report of the other.
    for (const tunnel of wanted) {
      await entry.proxy.ensure(tunnel).catch((err: unknown) => {
        options.log?.warn(`k8s: agent ${agentId} has no ${tunnel} tunnel — ${(err as Error).message}`)
      })
    }
  }

  const driver = new K8sDriver({
    api,
    orgId: settings.orgId,
    warmPoolName: settings.warmPoolName,
    onChannelReady: ensureTunnels,
    awaitChannel: (agentId, generation, timeoutMs) => listener.awaitConnection(agentId, generation, timeoutMs),
    publishSpawnRecord: (record) => {
      // Keyed by pod, and the previous pod's entry is dropped: leaving it would let a terminating
      // pod keep binding against a launch that has moved on.
      for (const [podName, existing] of recordsByPod) {
        if (existing.agentId === record.agentId && podName !== record.podName) recordsByPod.delete(podName)
      }
      recordsByPod.set(record.podName, record)
    },
    metrics: clusterMetrics,
    ...(options.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: options.readyTimeoutMs }),
    log: options.log ?? SILENT
  })

  // Started only once the driver exists: `onConnection` reaches into it, and a pod that dialled
  // in between would hit an uninitialized binding.
  await listener.start(settings.shimPort, settings.shimHost ?? '0.0.0.0')

  // A renewal re-dials immediately (the client resets its backoff for a planned rebind), so a
  // replacement that has not arrived well inside the request deadline is a pod that is gone.
  const REBIND_GRACE_MS = 20_000
  const lossTimers = new Map<string, NodeJS.Timeout>()

  function scheduleLossCheck(agentId: string, reason: string): void {
    clearTimeout(lossTimers.get(agentId))
    lossTimers.set(
      agentId,
      setTimeout(() => {
        lossTimers.delete(agentId)
        if (listener.connectionsFor(agentId).length > 0) return
        options.log?.warn(`k8s: no shim channel for agent ${agentId} after ${REBIND_GRACE_MS}ms — reporting loss`)
        driver.onChannelLost(agentId, reason)
      }, REBIND_GRACE_MS).unref?.() as NodeJS.Timeout
    )
  }

  return {
    driver,
    listener,
    ensureChannel: async (agentId) => {
      await driver.ensureBoundChannel(agentId)
    },
    probeRuntimes: async () => {
      // A sandbox of its own, under a reserved id, so a probe never adopts or disturbs an
      // agent's instance — and is torn down afterwards rather than left holding a pod.
      try {
        await driver.ensureBoundChannel(PROBE_AGENT_ID, undefined, PROBE_GRANTS)
        const session = driver.sessionFor(PROBE_AGENT_ID)
        if (!session) throw new Error('probe sandbox bound no session')
        const raw = await session.request('probe', {}, { timeoutMs: PROBE_TIMEOUT_MS })
        return K8sRuntimeTableSchema.parse(raw)
      } finally {
        await driver.removeAgent(PROBE_AGENT_ID).catch((err: unknown) => {
          // A leaked probe sandbox costs a pod and a volume, so say so loudly rather than
          // letting it accumulate one per daemon restart.
          options.log?.warn(`k8s: probe sandbox teardown failed: ${(err as Error).message}`)
        })
      }
    },
    gitRunnerFor: (agentId, cwd, abort) => {
      const session = driver.sessionFor(agentId)
      // No channel means this agent has no sandbox to run git in. Returning undefined keeps the
      // caller on its local runner rather than failing the operation — which is what a
      // self-hosted agent beside a cluster-backed one needs anyway.
      if (!session?.isAttached()) return undefined
      return new ShimGitRunner(session, cwd, undefined, abort)
    },
    workspaceRootFor: (agentId) => driver.workspaceRootFor(agentId),
    stop: async () => {
      for (const timer of lossTimers.values()) clearTimeout(timer)
      lossTimers.clear()
      for (const { proxy } of proxies.values()) proxy.stop('daemon is shutting down')
      proxies.clear()
      await listener.stop()
    }
  }
}
