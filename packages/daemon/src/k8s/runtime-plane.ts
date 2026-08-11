import { loadInClusterConfig } from './config.js'
import { K8sHttp } from './http.js'
import { K8sDriver } from './driver.js'
import { SandboxApi } from './sandbox-api.js'
import { clusterMetrics } from './cluster-metrics.js'
import { ShimListener, type ShimConnection } from '../shim/listener.js'
import { ShimSession } from '../shim/session.js'
import { ShimGitRunner } from '../shim/git-exec.js'
import type { SpawnRecord } from '../shim/binding.js'
import type { GitRunner } from '../workspace/git-runner.js'

const SILENT = { info: () => {}, warn: () => {} }

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
  /** A git runner for an agent whose workspace lives on its sandbox pod, or undefined when this
   *  daemon has no channel for it — the caller then keeps its local behaviour. */
  gitRunnerFor: (agentId: string, cwd?: string, abort?: AbortSignal) => GitRunner | undefined
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
  const sessions = new Map<string, ShimSession>()

  const listener = new ShimListener({
    verifier: { reviewToken: (token, audiences) => api.reviewToken(token, audiences) },
    spawnRecordForPod: (pod) => recordsByPod.get(pod.name),
    now: () => Date.now(),
    metrics: clusterMetrics,
    onConnection: (connection) => {
      driver.onChannelBound(connection)
      attachSession(connection)
    },
    onConnectionLost: (agentId, reason) => driver.onChannelLost(agentId, reason),
    log: options.log ?? SILENT
  })
  const driver = new K8sDriver({
    api,
    orgId: settings.orgId,
    warmPoolName: settings.warmPoolName,
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

  // A session per agent, re-attached on every rebind. The workspace seam reaches the sandbox
  // through this rather than through one socket, so a credential renewal does not break a git
  // operation that spans it.
  function attachSession(connection: ShimConnection): void {
    const agentId = connection.binding.agentId
    const existing = sessions.get(agentId)
    if (existing && existing.generation === connection.binding.generation) {
      existing.attach(connection)
      return
    }
    const session = new ShimSession(agentId, connection.binding.generation, {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout)
    })
    session.attach(connection)
    sessions.set(agentId, session)
  }

  return {
    driver,
    listener,
    gitRunnerFor: (agentId, cwd, abort) => {
      const session = sessions.get(agentId)
      // No channel means this agent has no sandbox to run git in. Returning undefined keeps the
      // caller on its local runner rather than failing the operation — which is what a
      // self-hosted agent beside a cluster-backed one needs anyway.
      if (!session?.isAttached()) return undefined
      return new ShimGitRunner(session, cwd, undefined, abort)
    },
    stop: async () => {
      await listener.stop()
    }
  }
}
