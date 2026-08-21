import { K8sHttp, loadInClusterConfig } from '@agentconnect.md/k8s-client'
import { K8sDriver } from './driver.js'
import type { LaunchGenerations } from './launch-registry.js'
import { PROBE_GRANTS, RUNTIME_GRANTS, poolRuntimeImage } from './sandbox-identity.js'
import { SandboxApi } from './sandbox-api.js'
import { PROBE_CLAIM_EXPIRES_ANNOTATION, PROBE_CLAIM_LABEL, PROBE_CLAIM_TTL_MS, probeAgentId } from './probe-claim.js'
import { clusterMetrics } from '../metrics/cluster-metrics.js'
import { ShimDialer } from '../shim/dialer.js'
import { ShimAutoMergeClient } from '../shim/auto-merge-client.js'
import { ShimGitRunner } from '../shim/git-exec.js'
import { ShimFileSink } from '../shim/channels.js'
import { ChannelLossWatcher } from './channel-loss-watcher.js'
import { TunnelBinder } from './tunnel-binder.js'
import { ShimWorkspaceFiles } from '../shim/workspace-files-channel.js'
import { ShimMemoryFs } from '../shim/memory-fs-channel.js'
import { ShimWorkspaceFs } from '../shim/workspace-fs-channel.js'
import type { WorkspaceFiles } from '../workspace/workspace-files.js'
import type { WorkspacePlacement } from '../workspace/workspace-fs.js'
import type { MemoryFs } from '../memory/fs.js'
import { DEFAULT_SHIM_LISTEN_PORT, DEFAULT_SHIM_WORKSPACE_ROOT } from '../shim/protocol.js'
import type { TunnelName } from '../shim/tunnel.js'
import { K8sRuntimeTableSchema, type K8sRuntimeTable } from '../runtimes/k8s-runtimes.js'
import type { GitRunner } from '../workspace/git-runner.js'

const SILENT = { info: () => {}, warn: () => {} }

/** A probe drives every runtime through `initialize` plus a session, on a possibly cold pod. */
const PROBE_TIMEOUT_MS = 180_000

/**
 * Assembles the k8s execution plane: the shim dialer, the driver, and the seams that make an
 * agent's git run where its workspace actually is.
 *
 * It exists because every piece of this was built and tested separately and nothing put them
 * together — `--k8s` changed the daemon's BEHAVIOUR (no probing, declared runtimes, no host
 * sandbox) while `AcpHost` still fell back to `LocalDriver`, so runtimes kept running on the
 * daemon's own host and no Sandbox was ever created.
 */
export interface K8sRuntimePlaneOptions {
  /** Durable, install-shared allocator for launch generations — in production the daemon store,
   *  which every pool member shares, so an agent that moves between members keeps counting up. */
  generations: LaunchGenerations
  /** Per-agent tenant lookup: a pool member serves every org, so the agent names the tenant. */
  orgForAgent?: (agentId: string) => string | undefined
  /** Warm pool the claims reference. v1beta1 requires one; a cold pool is `replicas: 0`. */
  warmPoolName?: string
  /** Namespace shared by agent sandboxes, separate from the daemon pool namespace. */
  sandboxNamespace?: string
  /** Deployment-unique identity for this member, normally the Pod UID from the Downward API. */
  memberId?: string
  /** Port the sandbox shim listens on; the daemon combines it with the ready pod's IP. */
  shimPort?: number
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
  /** How long a pod that is up may go without a shim channel before the launch counts as lost.
   *  Injected so a test can cross the window in milliseconds rather than waiting out the default. */
  rebindGraceMs?: number
  /** Fired when an agent's shim channel binds — the moment its volume (and memory tree) becomes reachable. */
  onSandboxBound?: (agentId: string) => void
  log?: { info: (m: string) => void; warn: (m: string) => void; debug?: (m: string) => void }
}

export interface K8sPlaneSettings {
  warmPoolName: string
  sandboxNamespace: string
  memberId: string
  shimPort: number
}

/** Deployment-owned settings. Env rather than the config file: they describe where this pod sits
 *  in the cluster, which is the deployment's to state and not an operator preference. */
export const K8S_WARM_POOL_ENV = 'AC_K8S_WARM_POOL'
export const K8S_SANDBOX_NAMESPACE_ENV = 'AC_K8S_SANDBOX_NAMESPACE'
export const K8S_MEMBER_ID_ENV = 'AC_K8S_MEMBER_ID'
export const K8S_SHIM_PORT_ENV = 'AC_K8S_SHIM_PORT'
export const DEFAULT_SHIM_PORT = DEFAULT_SHIM_LISTEN_PORT

/** Explicit options win per FIELD, so a caller may name one and leave the rest to the env. */
export function resolveK8sPlaneSettings(options: Partial<K8sRuntimePlaneOptions> = {}): K8sPlaneSettings {
  const env = options.env ?? process.env
  const warmPoolName = options.warmPoolName ?? env[K8S_WARM_POOL_ENV]?.trim()
  if (!warmPoolName) throw new Error(`--k8s requires ${K8S_WARM_POOL_ENV}`)
  const sandboxNamespace = options.sandboxNamespace ?? env[K8S_SANDBOX_NAMESPACE_ENV]?.trim()
  if (!sandboxNamespace) throw new Error(`--k8s requires ${K8S_SANDBOX_NAMESPACE_ENV}`)
  const memberId = options.memberId ?? env[K8S_MEMBER_ID_ENV]?.trim()
  if (!memberId) throw new Error(`--k8s requires ${K8S_MEMBER_ID_ENV}`)
  const rawPort = options.shimPort ?? env[K8S_SHIM_PORT_ENV] ?? DEFAULT_SHIM_PORT
  const shimPort = Number(rawPort)
  if (!Number.isInteger(shimPort) || shimPort < 1 || shimPort > 65_535) {
    throw new Error(`${K8S_SHIM_PORT_ENV} is not a valid port: ${rawPort}`)
  }
  return { warmPoolName, sandboxNamespace, memberId, shimPort }
}

/** The env contract on its own, which is what a deployment has to satisfy. */
export function k8sPlaneSettings(env: NodeJS.ProcessEnv): K8sPlaneSettings {
  return resolveK8sPlaneSettings({ env })
}

/** Extra work for the held probe sandbox, given the identity that routes a launch into it and the
 *  cwd a session must use — the POD's mount, never a path on the daemon's disk. */
export type ProbeSandboxSweep = (table: K8sRuntimeTable, sandbox: { agentId: string; cwd: string }) => Promise<void>

export interface K8sRuntimePlane {
  driver: K8sDriver
  dialer: ShimDialer
  /** This member's stable identity — one half of the pool-wide probe election. */
  memberId: string
  /** The runtime image the pool's template pins: the same answer for every member at a given
   *  moment, and what the probe's published result is keyed on. */
  runtimeImage: () => Promise<string>
  /** Bring an agent's Sandbox up and bind its channel WITHOUT starting a runtime, so the
   *  workspace can be prepared on the pod's own volume before the runtime looks at it. */
  ensureChannel: (agentId: string) => Promise<void>
  /** Run `work` while holding the agent's Sandbox against the ordinary idle sweep. */
  withSandbox: <T>(agentId: string, work: () => Promise<T>) => Promise<T>
  /** Ask a sandbox which runtimes the image actually provides, and tear it down again. `sweep` runs
   *  while that same sandbox is still held and bound, which is what lets the credentialed model
   *  probe reuse this pod instead of claiming a second one. A caller that arrives while a probe is
   *  already in flight awaits ITS table and its own sweep is skipped — the pod is gone by then. */
  probeRuntimes: (sweep?: ProbeSandboxSweep) => Promise<K8sRuntimeTable>
  /** A git runner for an agent whose workspace lives on its sandbox pod, or undefined when this
   *  daemon has no channel for it — the caller then keeps its local behaviour. */
  gitRunnerFor: (agentId: string, cwd?: string, abort?: AbortSignal) => GitRunner | undefined
  /** The console's file operations for that same workspace, on the same condition. Separate from the
   *  git runner because they are separate capabilities (`read` vs `exec`) and a channel is not a
   *  blanket permission — not because the two ever disagree about which filesystem to use. */
  workspaceFilesFor: (agentId: string) => WorkspaceFiles | undefined
  /** Where the agent's WORKSPACE files live and which coordinates they are addressed in — the
   *  filesystem twin of `gitRunnerFor`, answering on the same condition. Undefined keeps the caller
   *  on this daemon's own disk, which is what a self-hosted agent beside a cluster one needs. */
  workspaceFsFor: (agentId: string) => WorkspacePlacement | undefined
  /** The pod's merge-when-ready channel, on the same condition — the watcher runs IN the sandbox so
   *  its armed set dies with the pod, which is the lifetime the console projects. */
  autoMergeFor: (agentId: string) => ShimAutoMergeClient | undefined
  /** The agent's managed memory tree on that same volume, on the same condition: one root beside
   *  the checkout (`<mount>/.agentconnect/memory`), so it follows the agent across members and
   *  survives a rollout, and is reachable exactly when the sandbox is. */
  memoryFsFor: (agentId: string) => MemoryFs | undefined
  /** Whether this agent's work runs in a pod right now — the SAME condition `gitRunnerFor`
   *  answers on. Callers that build paths for that work read it here rather than re-deriving it,
   *  so an environment can never describe one filesystem while the execution happens in another. */
  runsInSandbox: (agentId: string) => boolean
  /** Empty a directory on the agent's pod volume, reporting why not rather than throwing. The one
   *  destructive operation a cluster workspace needs — a partial clone — and it cannot be an
   *  `rmSync`, because the directory is on a filesystem the daemon cannot see. */
  clearPath: (agentId: string, root: string) => Promise<string | undefined>
  /** Where the agent's bound pod mounts its workspace, as its shim reported; undefined before a
   *  bind or from a legacy shim (callers fall back to DEFAULT_SHIM_WORKSPACE_ROOT). */
  workspaceRootFor: (agentId: string) => string | undefined
  /** Agents this daemon holds a Sandbox for, and since when — the idle sweep's candidates. Read from
   *  the driver, not inferred from live hosts: a launch outlives the host it was made for. */
  launchedAgents: () => Array<{ agentId: string; since: number }>
  /** Take over an agent's sandbox from the cluster (claim → Sandbox → mode) so this member can suspend it. */
  adoptAgent: (agentId: string) => Promise<void>
  /** No longer served here: launch, channel, tunnel and loss watch go; claim and volume stay. */
  releaseAgent: (agentId: string) => void
  /** Suspend a quiet agent's pod, keeping its Sandbox and workspace volume. `busy` means work
   *  still holds it and the caller should try again later; `absent` means there is nothing to
   *  suspend. Waking is not a separate call — the next launch's bind does it. */
  suspendIdle: (agentId: string) => Promise<'suspended' | 'busy' | 'absent'>
  /** Destroy an agent's sandbox for good: the claim goes, and its workspace volume with it. For
   *  agent REMOVAL only — the local path deletes the checkout at the same point. */
  discardAgent: (agentId: string) => Promise<void>
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
      return new SandboxApi(new K8sHttp(config), settings.sandboxNamespace)
    })()

  // Built before the dialer and the driver because both wire into them; their deps read the driver
  // lazily, which is what lets the three refer to each other without an ordering problem.
  const lossWatcher = new ChannelLossWatcher({
    sandboxReadiness: (agentId, opts) => driver.sandboxReadiness(agentId, opts),
    connectionsFor: (agentId) => dialer.connectionsFor(agentId),
    podUpTimeoutMs: () => driver.podUpTimeoutMs,
    onChannelLost: (agentId, reason) => driver.onChannelLost(agentId, reason),
    ...(options.rebindGraceMs === undefined ? {} : { rebindGraceMs: options.rebindGraceMs }),
    log: options.log ?? SILENT
  })
  const tunnels = new TunnelBinder({
    ...(options.tunnelsFor === undefined ? {} : { tunnelsFor: options.tunnelsFor }),
    ...(options.tunnelSocketPath === undefined ? {} : { tunnelSocketPath: options.tunnelSocketPath }),
    log: options.log ?? SILENT
  })

  const dialer = new ShimDialer({
    verifier: { reviewToken: (token, audiences) => api.reviewToken(token, audiences) },
    now: () => Date.now(),
    metrics: clusterMetrics,
    onConnection: (connection) => {
      // A rebind cancels any pending loss check: this IS the replacement it was waiting for.
      lossWatcher.cancel(connection.binding.agentId)
      driver.onChannelBound(connection)
      options.onSandboxBound?.(connection.binding.agentId)
    },
    // A closed socket is not a lost launch; renewals reconnect underneath the logical session.
    // `ShimSession.lose()` is terminal — reporting loss here killed the runtime on every
    // routine renewal, which is the exact failure ShimSession exists to prevent. Loss is reported
    // only if no replacement binds for the same launch within the grace window.
    onConnectionLost: (agentId, reason) => lossWatcher.schedule(agentId, reason),
    ...(options.credentialTtlMs === undefined ? {} : { credentialTtlMs: options.credentialTtlMs }),
    log: options.log ?? SILENT
  })
  // The one condition that means "this agent's work happens in a pod". Defined once because two
  // callers must agree on it: the git runner, and the credential pointers that git will read.
  const runsInSandbox = (agentId: string): boolean => driver.sessionFor(agentId)?.isAttached() === true

  const runtimeProbeAgentId = probeAgentId(settings.memberId)
  const driver = new K8sDriver({
    api,
    // The runtime probe is the member's own, not any org's, so it claims under `install`.
    orgForAgent: (agentId) => (agentId === runtimeProbeAgentId ? 'install' : options.orgForAgent?.(agentId)),
    warmPoolName: settings.warmPoolName,
    generations: options.generations,
    // The probe runs an ACP runtime through this same driver, whose `launch` binds a channel of its
    // own — without this it would bind that pod with the full agent grant set.
    grantsForAgent: (agentId) => (agentId === runtimeProbeAgentId ? PROBE_GRANTS : RUNTIME_GRANTS),
    claimMetadataForAgent: (agentId) =>
      agentId === runtimeProbeAgentId
        ? {
            labels: { [PROBE_CLAIM_LABEL]: 'true' },
            annotations: {
              [PROBE_CLAIM_EXPIRES_ANNOTATION]: new Date(Date.now() + PROBE_CLAIM_TTL_MS).toISOString()
            }
          }
        : undefined,
    onChannelReady: (agentId, session) => tunnels.ensure(agentId, session),
    connectChannel: (record, podIp, timeoutMs) =>
      dialer.connect(shimEndpoint(podIp, settings.shimPort), record, timeoutMs),
    revokeChannel: (agentId) => dialer.revokeAgent(agentId),
    metrics: clusterMetrics,
    ...(options.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: options.readyTimeoutMs }),
    log: options.log ?? SILENT
  })

  let probeInFlight: Promise<K8sRuntimeTable> | undefined

  function probeRuntimes(sweep?: ProbeSandboxSweep): Promise<K8sRuntimeTable> {
    if (probeInFlight) return probeInFlight
    probeInFlight = (async () => {
      // Reset this member's deterministic claim so a container restart cannot adopt its leaked probe.
      await driver.removeAgent(runtimeProbeAgentId)
      try {
        // Hold the Sandbox across the request so the ordinary idle sweep cannot suspend it.
        return await driver.withSandbox(runtimeProbeAgentId, async () => {
          await driver.ensureBoundChannel(runtimeProbeAgentId, undefined, PROBE_GRANTS)
          const session = driver.sessionFor(runtimeProbeAgentId)
          if (!session) throw new Error('probe sandbox bound no session')
          const raw = await session.request('probe', {}, { timeoutMs: PROBE_TIMEOUT_MS })
          const table = K8sRuntimeTableSchema.parse(raw)
          // Reported, never raised: the table is the half the member cannot serve without, and a
          // sweep that fails costs model detail, not the runtimes themselves.
          if (sweep) {
            const cwd = driver.workspaceRootFor(runtimeProbeAgentId) ?? DEFAULT_SHIM_WORKSPACE_ROOT
            await sweep(table, { agentId: runtimeProbeAgentId, cwd }).catch((err: unknown) => {
              options.log?.warn(`k8s: probe sandbox sweep failed: ${(err as Error).message}`)
            })
          }
          return table
        })
      } finally {
        // Best-effort: a claim left behind here expires and the orphan reconciler collects it.
        await driver.removeAgent(runtimeProbeAgentId).catch((err: unknown) => {
          options.log?.warn(`k8s: probe sandbox teardown failed: ${(err as Error).message}`)
        })
      }
    })().finally(() => {
      probeInFlight = undefined
    })
    return probeInFlight
  }

  function releaseAgent(agentId: string, reason = 'agent no longer served here'): void {
    // Close the pod's channel first: it may otherwise keep using a binding this member no longer honours.
    dialer.revokeAgent(agentId)
    // After the revoke, whose close schedules one: nobody here waits on a loss for an agent not served here.
    lossWatcher.cancel(agentId)
    tunnels.release(agentId, reason)
    driver.releaseAgent(agentId)
  }

  return {
    driver,
    dialer,
    memberId: settings.memberId,
    runtimeImage: () => poolRuntimeImage(api, settings.warmPoolName),
    ensureChannel: async (agentId) => {
      await driver.ensureBoundChannel(agentId)
    },
    withSandbox: (agentId, work) => driver.withSandbox(agentId, work),
    probeRuntimes,
    gitRunnerFor: (agentId, cwd, abort) => {
      // No channel means this agent has no sandbox to run git in. Returning undefined keeps the
      // caller on its local runner rather than failing the operation — which is what a
      // self-hosted agent beside a cluster-backed one needs anyway.
      if (!runsInSandbox(agentId)) return undefined
      return new ShimGitRunner(driver.sessionFor(agentId)!, cwd, undefined, abort)
    },
    workspaceFilesFor: (agentId) => {
      if (!runsInSandbox(agentId)) return undefined
      return new ShimWorkspaceFiles(driver.sessionFor(agentId)!)
    },
    workspaceFsFor: (agentId) => {
      if (!runsInSandbox(agentId)) return undefined
      const mount = driver.workspaceRootFor(agentId) ?? DEFAULT_SHIM_WORKSPACE_ROOT
      return { fs: new ShimWorkspaceFs(driver.sessionFor(agentId)!, mount), mount }
    },
    autoMergeFor: (agentId) => {
      if (!runsInSandbox(agentId)) return undefined
      return new ShimAutoMergeClient(driver.sessionFor(agentId)!)
    },
    memoryFsFor: (agentId) => {
      if (!runsInSandbox(agentId)) return undefined
      return new ShimMemoryFs(driver.sessionFor(agentId)!, sandboxMemoryRoot(driver.workspaceRootFor(agentId)))
    },
    runsInSandbox,
    clearPath: async (agentId, root) => {
      const session = driver.sessionFor(agentId)
      if (!session?.isAttached()) return `agent ${agentId} has no bound sandbox channel`
      return await new ShimFileSink(session).clear(root)
    },
    workspaceRootFor: (agentId) => driver.workspaceRootFor(agentId),
    launchedAgents: () => driver.launchedAgents(),
    suspendIdle: (agentId) => driver.suspendIfIdle(agentId),
    adoptAgent: async (agentId) => {
      await driver.adoptAgent(agentId)
    },
    releaseAgent,
    discardAgent: async (agentId) => {
      releaseAgent(agentId, 'agent removed')
      await driver.removeAgent(agentId)
    },
    stop: async () => {
      lossWatcher.cancelAll()
      tunnels.releaseAll('daemon is shutting down')
      dialer.stop()
    }
  }
}

/** The managed memory root on a sandbox volume: outside the user's checkout, on the same PVC. */
export function sandboxMemoryRoot(workspaceRoot: string | undefined): string {
  return `${(workspaceRoot ?? DEFAULT_SHIM_WORKSPACE_ROOT).replace(/\/+$/, '')}/.agentconnect/memory`
}

/** WebSocket URL for a Pod IP, including the brackets an IPv6 literal requires. */
export function shimEndpoint(podIp: string, port: number): string {
  const host = podIp.includes(':') && !podIp.startsWith('[') ? `[${podIp}]` : podIp
  return `ws://${host}:${port}`
}
