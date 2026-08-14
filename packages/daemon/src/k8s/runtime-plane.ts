import { createHash } from 'node:crypto'
import { K8sHttp, loadInClusterConfig } from '@agentconnect.md/k8s-client'
import { K8sDriver, PROBE_GRANTS } from './driver.js'
import { SandboxApi } from './sandbox-api.js'
import { clusterMetrics } from './cluster-metrics.js'
import { ShimDialer } from '../shim/dialer.js'
import { ShimGitRunner } from '../shim/git-exec.js'
import { TunnelProxy } from '../shim/tunnel-proxy.js'
import { ShimFileSink } from '../shim/channels.js'
import { ShimWorkspaceFiles } from '../shim/workspace-files-channel.js'
import type { WorkspaceFiles } from '../workspace/workspace-files.js'
import { DEFAULT_SHIM_LISTEN_PORT } from '../shim/protocol.js'
import type { TunnelName } from '../shim/tunnel.js'
import type { ShimSession } from '../shim/session.js'
import { K8sRuntimeTableSchema, type K8sRuntimeTable } from '../runtimes/k8s-runtimes.js'
import type { GitRunner } from '../workspace/git-runner.js'

const SILENT = { info: () => {}, warn: () => {} }

/** Reserved prefix for member-scoped runtime probes; the Control Plane never assigns it. */
export const PROBE_AGENT_ID_PREFIX = 'ac-runtime-probe'
export const PROBE_CLAIM_LABEL = 'agentconnect.md/runtime-probe'
export const PROBE_CLAIM_EXPIRES_ANNOTATION = 'agentconnect.md/runtime-probe-expires-at'
/** A probe drives every runtime through `initialize` plus a session, on a possibly cold pod. */
const PROBE_TIMEOUT_MS = 180_000
/** Bounds an abandoned probe claim while leaving ample room for cold scheduling and the probe. */
export const PROBE_CLAIM_TTL_MS = 15 * 60_000
const PROBE_CLAIM_GC_INTERVAL_MS = 5 * 60_000

/** A deterministic, DNS-safe probe identity unique to one daemon member. */
export function probeAgentId(memberId: string): string {
  const memberHash = createHash('sha256').update(memberId).digest('hex').slice(0, 16)
  return `${PROBE_AGENT_ID_PREFIX}-${memberHash}`
}

/** Delete only expired probe claims; ordinary agent claims never match. */
export async function reapExpiredProbeClaims(
  api: Pick<SandboxApi, 'deleteClaim' | 'listClaims'>,
  now: number,
  log: { warn: (message: string) => void } = SILENT
): Promise<void> {
  const claims = await api.listClaims(`${PROBE_CLAIM_LABEL}=true`)
  await Promise.all(
    claims.map(async (claim) => {
      const name = claim.metadata?.name
      if (!name || claim.metadata?.labels?.[PROBE_CLAIM_LABEL] !== 'true') return
      const rawExpiry = claim.metadata?.annotations?.[PROBE_CLAIM_EXPIRES_ANNOTATION]
      const expiresAt = rawExpiry ? Date.parse(rawExpiry) : Number.NaN
      if (!Number.isFinite(expiresAt) || expiresAt > now) return
      await api.deleteClaim(name).catch((err: unknown) => {
        log.warn(`k8s: expired probe claim ${name} teardown failed: ${(err as Error).message}`)
      })
    })
  )
}

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
  /** Connection-scoped org for an envelope daemon; absent for an install-wide cloud daemon. */
  orgId?: string
  /** Per-agent tenant lookup used by an install-wide cloud daemon. */
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
  log?: { info: (m: string) => void; warn: (m: string) => void; debug?: (m: string) => void }
}

export interface K8sPlaneSettings {
  orgId?: string
  warmPoolName: string
  sandboxNamespace: string
  memberId: string
  shimPort: number
}

/** Deployment-owned settings. Env rather than the config file: they describe where this pod sits
 *  in the cluster, which is the deployment's to state and not an operator preference. */
export const K8S_ORG_ID_ENV = 'AC_K8S_ORG_ID'
export const K8S_WARM_POOL_ENV = 'AC_K8S_WARM_POOL'
export const K8S_SANDBOX_NAMESPACE_ENV = 'AC_K8S_SANDBOX_NAMESPACE'
export const K8S_MEMBER_ID_ENV = 'AC_K8S_MEMBER_ID'
export const K8S_SHIM_PORT_ENV = 'AC_K8S_SHIM_PORT'
export const DEFAULT_SHIM_PORT = DEFAULT_SHIM_LISTEN_PORT

/** Explicit options win per FIELD, so a caller may name one and leave the rest to the env. */
export function resolveK8sPlaneSettings(options: K8sRuntimePlaneOptions = {}): K8sPlaneSettings {
  const env = options.env ?? process.env
  const orgId = options.orgId ?? env[K8S_ORG_ID_ENV]?.trim()
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
  return { ...(orgId ? { orgId } : {}), warmPoolName, sandboxNamespace, memberId, shimPort }
}

/** The env contract on its own, which is what a deployment has to satisfy. */
export function k8sPlaneSettings(env: NodeJS.ProcessEnv): K8sPlaneSettings {
  return resolveK8sPlaneSettings({ env })
}

export interface K8sRuntimePlane {
  driver: K8sDriver
  dialer: ShimDialer
  /** Bring an agent's Sandbox up and bind its channel WITHOUT starting a runtime, so the
   *  workspace can be prepared on the pod's own volume before the runtime looks at it. */
  ensureChannel: (agentId: string) => Promise<void>
  /** Run `work` while holding the agent's Sandbox against the ordinary idle sweep. */
  withSandbox: <T>(agentId: string, work: () => Promise<T>) => Promise<T>
  /** Ask a sandbox which runtimes the image actually provides, and tear it down again. */
  probeRuntimes: () => Promise<K8sRuntimeTable>
  /** A git runner for an agent whose workspace lives on its sandbox pod, or undefined when this
   *  daemon has no channel for it — the caller then keeps its local behaviour. */
  gitRunnerFor: (agentId: string, cwd?: string, abort?: AbortSignal) => GitRunner | undefined
  /** The console's file operations for that same workspace, on the same condition. Separate from the
   *  git runner because they are separate capabilities (`read` vs `exec`) and a channel is not a
   *  blanket permission — not because the two ever disagree about which filesystem to use. */
  workspaceFilesFor: (agentId: string) => WorkspaceFiles | undefined
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
  /** Agents this daemon holds a Sandbox for — the candidate set for an idle sweep. Read from the
   *  driver rather than inferred from live hosts: a launch outlives the host it was made for. */
  launchedAgents: () => string[]
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

  const dialer = new ShimDialer({
    verifier: { reviewToken: (token, audiences) => api.reviewToken(token, audiences) },
    now: () => Date.now(),
    metrics: clusterMetrics,
    onConnection: (connection) => {
      // A rebind cancels any pending loss check: this IS the replacement it was waiting for.
      clearTimeout(lossTimers.get(connection.binding.agentId))
      lossTimers.delete(connection.binding.agentId)
      driver.onChannelBound(connection)
    },
    // A closed socket is not a lost launch; renewals reconnect underneath the logical session.
    // `ShimSession.lose()` is terminal — reporting loss here killed the runtime on every
    // routine renewal, which is the exact failure ShimSession exists to prevent. Loss is reported
    // only if no replacement binds for the same launch within the grace window.
    onConnectionLost: (agentId, reason) => scheduleLossCheck(agentId, reason),
    ...(options.credentialTtlMs === undefined ? {} : { credentialTtlMs: options.credentialTtlMs }),
    log: options.log ?? SILENT
  })
  // The one condition that means "this agent's work happens in a pod". Defined once because two
  // callers must agree on it: the git runner, and the credential pointers that git will read.
  const runsInSandbox = (agentId: string): boolean => driver.sessionFor(agentId)?.isAttached() === true

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

  const runtimeProbeAgentId = probeAgentId(settings.memberId)
  const driver = new K8sDriver({
    api,
    orgForAgent: (agentId) =>
      agentId === runtimeProbeAgentId
        ? (settings.orgId ?? 'install')
        : (options.orgForAgent?.(agentId) ?? settings.orgId),
    warmPoolName: settings.warmPoolName,
    claimMetadataForAgent: (agentId) =>
      agentId === runtimeProbeAgentId
        ? {
            labels: { [PROBE_CLAIM_LABEL]: 'true' },
            annotations: {
              [PROBE_CLAIM_EXPIRES_ANNOTATION]: new Date(Date.now() + PROBE_CLAIM_TTL_MS).toISOString()
            }
          }
        : undefined,
    onChannelReady: ensureTunnels,
    connectChannel: (record, podIp, timeoutMs) =>
      dialer.connect(shimEndpoint(podIp, settings.shimPort), record, timeoutMs),
    revokeChannel: (agentId) => dialer.revokeAgent(agentId),
    metrics: clusterMetrics,
    ...(options.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: options.readyTimeoutMs }),
    log: options.log ?? SILENT
  })

  // A renewal reconnects immediately, so a
  // replacement that has not arrived well inside the request deadline is a pod that is gone.
  const REBIND_GRACE_MS = 20_000
  const lossTimers = new Map<string, NodeJS.Timeout>()
  let stopped = false
  let probeGcTimer: NodeJS.Timeout | undefined
  let probeInFlight: Promise<K8sRuntimeTable> | undefined

  async function runProbeClaimGc(): Promise<void> {
    await reapExpiredProbeClaims(api, Date.now(), options.log ?? SILENT).catch((err: unknown) =>
      options.log?.warn(`k8s: probe claim sweep failed: ${(err as Error).message}`)
    )
    if (stopped) return
    probeGcTimer = setTimeout(() => void runProbeClaimGc(), PROBE_CLAIM_GC_INTERVAL_MS)
    probeGcTimer.unref?.()
  }

  void runProbeClaimGc()

  function scheduleLossCheck(agentId: string, reason: string): void {
    clearTimeout(lossTimers.get(agentId))
    lossTimers.set(
      agentId,
      setTimeout(() => {
        lossTimers.delete(agentId)
        if (dialer.connectionsFor(agentId).length > 0) return
        options.log?.warn(`k8s: no shim channel for agent ${agentId} after ${REBIND_GRACE_MS}ms — reporting loss`)
        driver.onChannelLost(agentId, reason)
      }, REBIND_GRACE_MS).unref?.() as NodeJS.Timeout
    )
  }

  function probeRuntimes(): Promise<K8sRuntimeTable> {
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
          return K8sRuntimeTableSchema.parse(raw)
        })
      } finally {
        await driver.removeAgent(runtimeProbeAgentId).catch((err: unknown) => {
          options.log?.warn(`k8s: probe sandbox teardown failed: ${(err as Error).message}`)
        })
      }
    })().finally(() => {
      probeInFlight = undefined
    })
    return probeInFlight
  }

  return {
    driver,
    dialer,
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
    runsInSandbox,
    clearPath: async (agentId, root) => {
      const session = driver.sessionFor(agentId)
      if (!session?.isAttached()) return `agent ${agentId} has no bound sandbox channel`
      return await new ShimFileSink(session).clear(root)
    },
    workspaceRootFor: (agentId) => driver.workspaceRootFor(agentId),
    launchedAgents: () => driver.launchedAgents(),
    suspendIdle: (agentId) => driver.suspendIfIdle(agentId),
    discardAgent: async (agentId) => {
      // Close and forget the pod's channel before the claim goes: the pod has its whole
      // termination grace to keep using a binding this daemon no longer means to honour.
      dialer.revokeAgent(agentId)
      // Ordered after the revoke, whose close schedules one: a loss check for an agent that no
      // longer exists would report a lost launch nobody is waiting for.
      clearTimeout(lossTimers.get(agentId))
      lossTimers.delete(agentId)
      proxies.get(agentId)?.proxy.stop('agent removed')
      proxies.delete(agentId)
      await driver.removeAgent(agentId)
    },
    stop: async () => {
      stopped = true
      if (probeGcTimer) clearTimeout(probeGcTimer)
      probeGcTimer = undefined
      for (const timer of lossTimers.values()) clearTimeout(timer)
      lossTimers.clear()
      for (const { proxy } of proxies.values()) proxy.stop('daemon is shutting down')
      proxies.clear()
      dialer.stop()
    }
  }
}

/** WebSocket URL for a Pod IP, including the brackets an IPv6 literal requires. */
export function shimEndpoint(podIp: string, port: number): string {
  const host = podIp.includes(':') && !podIp.startsWith('[') ? `[${podIp}]` : podIp
  return `ws://${host}:${port}`
}
