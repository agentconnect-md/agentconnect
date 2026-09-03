import { K8sHttp, loadInClusterConfig } from '@agentconnect.md/k8s-client'
import { K8sDriver } from './driver.js'
import type { LaunchGenerations } from './launch-registry.js'
import {
  PROBE_GRANTS,
  RUNTIME_GRANTS,
  agentSandboxSubject,
  poolRuntimeImage,
  sandboxSubjectAgentId,
  sandboxSubjectForPath,
  sandboxSubjectSessionLeaf,
  sessionSandboxSubject,
  type SandboxSubject
} from './sandbox-identity.js'
import { SandboxApi } from './sandbox-api.js'
import { PROBE_CLAIM_EXPIRES_ANNOTATION, PROBE_CLAIM_LABEL, PROBE_CLAIM_TTL_MS, probeAgentId } from './probe-claim.js'
import { clusterMetrics } from '../metrics/cluster-metrics.js'
import { ShimDialer } from '../shim/dialer.js'
import { spawnSubject } from '../shim/binding.js'
import { ShimAutoMergeClient } from '../shim/auto-merge-client.js'
import { ShimGitRunner } from '../shim/git-exec.js'
import { ShimFileSink } from '../shim/channels.js'
import type { ShimSession } from '../shim/session.js'
import { ClusterSkillClient } from '../shim/skill-client.js'
import { ChannelLossWatcher } from './channel-loss-watcher.js'
import { TunnelBinder } from './tunnel-binder.js'
import { ShimWorkspaceFiles } from '../shim/workspace-files-channel.js'
import { ShimMemoryFs } from '../shim/memory-fs-channel.js'
import { ShimWorkspaceFs } from '../shim/workspace-fs-channel.js'
import type { WorkspaceFiles } from '../workspace/workspace-files.js'
import type { WorkspaceFs, WorkspacePlacement } from '../workspace/workspace-fs.js'
import { sessionDirIn } from '../workspace/session-layout.js'
import type { MemoryFs } from '../memory/fs.js'
import { DEFAULT_SHIM_LISTEN_PORT, DEFAULT_SHIM_WORKSPACE_ROOT } from '../shim/protocol.js'
import { resolveOrphanReconcilerSettings, stampRefreshMsFor } from './orphan-reconciler.js'
import type { TunnelName } from '../shim/tunnel.js'
import { K8sRuntimeTableSchema, type K8sRuntimeTable } from '../runtimes/k8s-runtimes.js'
import type { GitRunner } from '../workspace/git-runner.js'
import { deferredGitRunner } from '../workspace/git-runner.js'

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
 *
 * A pod is claimed per SUBJECT (sandbox-identity.ts): the agent's own, or one confined session's
 * (git-workspace-model §11). Agent-keyed seams below route each path to the pod that owns it — a
 * session pod owns `<mount>/sessions/<leaf>`, the agent pod everything else.
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
  /** How often held claims are re-stamped as in use; omit to derive it from the sweep's own grace, 0 to run no timer. */
  stampRefreshMs?: number
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
  /** Bring a subject's Sandbox up and bind its channel WITHOUT starting a runtime, so the
   *  workspace can be prepared on the pod's own volume before the runtime looks at it. */
  ensureChannel: (subject: string) => Promise<void>
  /** Run `work` while holding the subject's Sandbox against the ordinary idle sweep. */
  withSandbox: <T>(subject: string, work: () => Promise<T>) => Promise<T>
  /** Ask a sandbox which runtimes the image actually provides, and tear it down again. `sweep` runs
   *  while that same sandbox is still held and bound, which is what lets the credentialed model
   *  probe reuse this pod instead of claiming a second one. A caller that arrives while a probe is
   *  already in flight awaits ITS table and its own sweep is skipped — the pod is gone by then. */
  probeRuntimes: (sweep?: ProbeSandboxSweep) => Promise<K8sRuntimeTable>
  /** A git runner for an agent's workspace path, on the pod that owns it, or undefined when this
   *  daemon has no channel to that pod — the caller then keeps its local behaviour. A session pod that
   *  is asleep is brought up on first use while the agent's own pod is bound (see `sessionForPath`). */
  gitRunnerFor: (agentId: string, cwd?: string, abort?: AbortSignal) => GitRunner | undefined
  /** The console's file operations for the agent's workspaces, each root on the pod that owns it. Separate
   *  from the git runner because they are separate capabilities (`read` vs `exec`) and a channel is not a
   *  blanket permission — not because the two ever disagree about which filesystem to use. */
  workspaceFilesFor: (agentId: string) => WorkspaceFiles | undefined
  /** Where the agent's WORKSPACE files live and which coordinates they are addressed in — the
   *  filesystem twin of `gitRunnerFor`, answering while any pod of the agent is bound and routing
   *  each path to its pod. Undefined keeps the caller on this daemon's own disk, which is what a
   *  self-hosted agent beside a cluster one needs. */
  workspaceFsFor: (agentId: string) => WorkspacePlacement | undefined
  /** The agent pod's merge-when-ready channel — the watcher runs IN that pod so its armed set dies
   *  with it, which is the lifetime the console projects. */
  autoMergeFor: (agentId: string) => ShimAutoMergeClient | undefined
  /** The agent's managed memory tree on its OWN pod's volume: one root beside the checkout
   *  (`<mount>/.agentconnect/memory`), so it follows the agent across members and survives a
   *  rollout, and is reachable exactly when that pod is. */
  memoryFsFor: (agentId: string) => MemoryFs | undefined
  /** Whether this agent's work runs in a pod right now — ANY of its pods, the SAME condition
   *  `gitRunnerFor` answers on. Callers that build paths for that work read it here rather than
   *  re-deriving it, so an environment can never describe one filesystem while the execution
   *  happens in another. */
  runsInSandbox: (agentId: string) => boolean
  /** The pod that owns a workspace path (§11) — the routing every read uses, exposed so a caller can hold and judge the same pod. */
  subjectForPath: (agentId: string, path?: string) => SandboxSubject
  /** Whether one subject's pod is bound right now — the agent's own for the agent id. */
  sandboxBound: (subject: string) => boolean
  /** Hold a pod that is ALREADY bound against the idle sweep, or undefined when it is asleep — the non-claiming, non-waking half of `withSandbox`, for a read that may never resurrect a pod. */
  holdIfBound: (subject: string) => (() => void) | undefined
  /** Empty a directory on the pod volume that owns it, reporting why not rather than throwing. The one
   *  destructive operation a cluster workspace needs — a partial clone — and it cannot be an
   *  `rmSync`, because the directory is on a filesystem the daemon cannot see. */
  clearPath: (agentId: string, root: string) => Promise<string | undefined>
  /** Where a subject's bound pod mounts its workspace, as its shim reported; undefined before a
   *  bind or from a legacy shim (callers fall back to DEFAULT_SHIM_WORKSPACE_ROOT). */
  workspaceRootFor: (subject: string) => string | undefined
  /** The session directory of one confined session, in the coordinates of ITS pod (§11). */
  sessionDirFor: (agentId: string, leaf: string) => string
  skillClientFor?: (subject: string) => ClusterSkillClient | undefined
  workspaceIncarnationFor?: (subject: string) => string | undefined
  shimGenerationFor?: (subject: string) => number | undefined
  /** Subjects this daemon holds a Sandbox for, and since when — the idle sweep's candidates. Read from
   *  the driver, not inferred from live hosts: a launch outlives the host it was made for. */
  launched: () => Array<{ subject: SandboxSubject; agentId: string; since: number }>
  /** Take over an agent's pods from the cluster (claim → Sandbox → mode) so this member can suspend them. */
  adoptAgent: (agentId: string) => Promise<void>
  /** No longer served here: launches, channels, tunnels and loss watches of every pod of the agent go; claims and volumes stay. */
  releaseAgent: (agentId: string) => void
  /** Suspend a quiet subject's pod, keeping its Sandbox and workspace volume. `busy` means work
   *  still holds it and the caller should try again later; `absent` means there is nothing to
   *  suspend. Waking is not a separate call — the next launch's bind does it. */
  suspendIdle: (subject: string) => Promise<'suspended' | 'busy' | 'absent'>
  /** Destroy every sandbox of an agent for good: the claims go, and their workspace volumes with them. For
   *  agent REMOVAL only — the local path deletes the checkout at the same point. */
  discardAgent: (agentId: string) => Promise<void>
  /** Destroy one confined session's sandbox: its claim goes, and the session's clones and HOME with it (§11 retirement). */
  discardSession: (agentId: string, leaf: string) => Promise<void>
  /** Whether the cluster holds a claim for a subject at all, read without waking anything. */
  hasSandbox: (subject: string) => Promise<boolean>
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
    sandboxReadiness: (subject, opts) => driver.sandboxReadiness(subject, opts),
    connectionsFor: (subject) => dialer.connectionsFor(subject),
    podUpTimeoutMs: () => driver.podUpTimeoutMs,
    onChannelLost: (subject, reason) => driver.onChannelLost(subject, reason),
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
      lossWatcher.cancel(spawnSubject(connection.binding))
      driver.onChannelBound(connection)
      options.onSandboxBound?.(connection.binding.agentId)
    },
    // A closed socket is not a lost launch; renewals reconnect underneath the logical session.
    // `ShimSession.lose()` is terminal — reporting loss here killed the runtime on every
    // routine renewal, which is the exact failure ShimSession exists to prevent. Loss is reported
    // only if no replacement binds for the same launch within the grace window.
    onConnectionLost: (subject, reason) => lossWatcher.schedule(subject, reason),
    ...(options.credentialTtlMs === undefined ? {} : { credentialTtlMs: options.credentialTtlMs }),
    log: options.log ?? SILENT
  })
  /** The bound session of one subject's pod, or undefined while that pod is down or unbound. */
  const boundSession = (subject: string): ShimSession | undefined => {
    const session = driver.sessionFor(subject)
    return session?.isAttached() ? session : undefined
  }
  const mountOf = (subject: string): string => driver.workspaceRootFor(subject) ?? DEFAULT_SHIM_WORKSPACE_ROOT
  const sessionDirFor = (agentId: string, leaf: string): string =>
    sessionDirIn(mountOf(sessionSandboxSubject(agentId, leaf)), leaf)
  // The pod a path lives on, read off the path (git-workspace-model §11): a suspended session pod is still addressable, its launch forgotten or not.
  const subjectForPath = (agentId: string, path: string | undefined): SandboxSubject =>
    sandboxSubjectForPath(agentId, path, mountOf(agentSandboxSubject(agentId)))
  /** Every pod of the agent that is bound right now: its own first, then its sessions'. */
  const boundSubjectsOf = (agentId: string): SandboxSubject[] =>
    [agentSandboxSubject(agentId), ...driver.sessionSubjectsOf(agentId)].filter((subject) => boundSession(subject))
  // The one condition that means "this agent's work happens in a pod" — ANY of its pods. Defined once
  // because two callers must agree on it: the git runner, and the credential pointers that git will read.
  const runsInSandbox = (agentId: string): boolean => boundSubjectsOf(agentId).length > 0
  // The claim a sleeping session pod may be resumed on, or undefined when it may not be woken: only beside a bound agent pod, since the console's wake is agent-scoped and that is the press a read has, and only onto a claim the cluster already holds — whose UID travels to the resume as its fence.
  const wakeableSessionClaim = async (subject: SandboxSubject): Promise<string | undefined> => {
    if (sandboxSubjectSessionLeaf(subject) === undefined) return undefined
    if (!boundSession(agentSandboxSubject(sandboxSubjectAgentId(subject)))) return undefined
    return await driver.claimUidFor(subject)
  }
  /** The session that owns `path`, resuming a sleeping session pod beside a bound agent pod, or the reason none does. */
  const sessionForPath = async (agentId: string, path: string): Promise<ShimSession> => {
    const subject = subjectForPath(agentId, path)
    let session = boundSession(subject)
    if (!session) {
      // Resume-only, fenced on the claim just observed: the two reads are not atomic, so a retirement landing between them refuses rather than creating a fresh claim and an empty volume.
      const claimUid = await wakeableSessionClaim(subject)
      if (claimUid !== undefined) {
        await driver.resumeBoundChannel(subject, claimUid)
        session = boundSession(subject)
      }
    }
    if (!session) throw new Error(`sandbox ${subject} that owns ${path} has no bound channel`)
    return session
  }

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
    onChannelReady: (subject, session) => tunnels.ensure(subject, session),
    connectChannel: (record, podIp, timeoutMs) =>
      dialer.connect(shimEndpoint(podIp, settings.shimPort), record, timeoutMs),
    revokeChannel: (subject) => dialer.revoke(subject),
    metrics: clusterMetrics,
    ...(options.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: options.readyTimeoutMs }),
    log: options.log ?? SILENT
  })

  let probeInFlight: Promise<K8sRuntimeTable> | undefined

  function probeRuntimes(sweep?: ProbeSandboxSweep): Promise<K8sRuntimeTable> {
    if (probeInFlight) return probeInFlight
    const probeSubject = agentSandboxSubject(runtimeProbeAgentId)
    probeInFlight = (async () => {
      // Reset this member's deterministic claim so a container restart cannot adopt its leaked probe.
      await driver.removeSandbox(probeSubject)
      try {
        // Hold the Sandbox across the request so the ordinary idle sweep cannot suspend it.
        return await driver.withSandbox(probeSubject, async () => {
          await driver.ensureBoundChannel(probeSubject, undefined, PROBE_GRANTS)
          const session = driver.sessionFor(probeSubject)
          if (!session) throw new Error('probe sandbox bound no session')
          const raw = await session.request('probe', {}, { timeoutMs: PROBE_TIMEOUT_MS })
          const table = K8sRuntimeTableSchema.parse(raw)
          // Reported, never raised: the table is the half the member cannot serve without, and a
          // sweep that fails costs model detail, not the runtimes themselves.
          if (sweep) {
            const cwd = mountOf(probeSubject)
            await sweep(table, { agentId: runtimeProbeAgentId, cwd }).catch((err: unknown) => {
              options.log?.warn(`k8s: probe sandbox sweep failed: ${(err as Error).message}`)
            })
          }
          return table
        })
      } finally {
        // Best-effort: a claim left behind here expires and the orphan reconciler collects it.
        await driver.removeSandbox(probeSubject).catch((err: unknown) => {
          options.log?.warn(`k8s: probe sandbox teardown failed: ${(err as Error).message}`)
        })
      }
    })().finally(() => {
      probeInFlight = undefined
    })
    return probeInFlight
  }

  function releaseSubject(subject: string, reason: string): void {
    // Close the pod's channel first: it may otherwise keep using a binding this member no longer honours.
    dialer.revoke(subject)
    // After the revoke, whose close schedules one: nobody here waits on a loss for a pod not served here.
    lossWatcher.cancel(subject)
    tunnels.release(subject, reason)
    driver.release(subject)
  }

  function releaseAgent(agentId: string, reason = 'agent no longer served here'): void {
    for (const subject of driver.sessionSubjectsOf(agentId)) releaseSubject(subject, reason)
    releaseSubject(agentSandboxSubject(agentId), reason)
  }

  // A claim this member is USING must not look like a leak to the orphan sweep, and a launch served from
  // the registry never touches the API — so the stamp is refreshed on a tick derived from the SAME grace
  // the sweep reads, never a constant of its own: an install that shortens the grace would otherwise let a
  // held claim age past it between two ticks. Unref'd — bookkeeping never holds a process up.
  const stampRefreshMs = options.stampRefreshMs ?? stampRefreshMsFor(resolveOrphanReconcilerSettings().graceMs)
  const stampRefresh =
    stampRefreshMs > 0
      ? setInterval(() => {
          void driver.refreshAdmissionStamps().catch((err: unknown) => {
            options.log?.warn(`k8s: refreshing the sandbox admission stamps failed: ${(err as Error).message}`)
          })
        }, stampRefreshMs)
      : undefined
  stampRefresh?.unref?.()

  return {
    driver,
    dialer,
    memberId: settings.memberId,
    runtimeImage: () => poolRuntimeImage(api, settings.warmPoolName),
    ensureChannel: async (subject) => {
      await driver.ensureBoundChannel(subject as SandboxSubject)
    },
    withSandbox: (subject, work) => driver.withSandbox(subject as SandboxSubject, work),
    probeRuntimes,
    gitRunnerFor: (agentId, cwd, abort) => {
      // No channel means this path has no bound sandbox to run git in. Returning undefined keeps the
      // caller on its local runner rather than failing the operation — which is what a
      // self-hosted agent beside a cluster-backed one needs anyway.
      const subject = subjectForPath(agentId, cwd)
      const session = boundSession(subject)
      if (session) return new ShimGitRunner(session, cwd, undefined, abort)
      // A session directory whose pod is asleep, beside a bound agent pod: the runner brings it up on first use.
      if (
        cwd === undefined ||
        sandboxSubjectSessionLeaf(subject) === undefined ||
        !boundSession(agentSandboxSubject(agentId))
      ) {
        return undefined
      }
      return deferredGitRunner(async () => new ShimGitRunner(await sessionForPath(agentId, cwd), cwd, undefined, abort))
    },
    workspaceFilesFor: (agentId) => {
      if (!runsInSandbox(agentId)) return undefined
      return new RoutedWorkspaceFiles(async (root) => new ShimWorkspaceFiles(await sessionForPath(agentId, root)))
    },
    workspaceFsFor: (agentId) => {
      // Paths are composed on the mount the agent's own pod reported; a session pod's is asked for its own paths.
      const [first] = boundSubjectsOf(agentId)
      if (first === undefined) return undefined
      const mount = mountOf(first)
      const fs = new RoutedWorkspaceFs(async (path) => {
        const subject = subjectForPath(agentId, path)
        return new ShimWorkspaceFs(await sessionForPath(agentId, path), mountOf(subject))
      })
      return { fs, mount }
    },
    autoMergeFor: (agentId) => {
      const session = boundSession(agentSandboxSubject(agentId))
      return session ? new ShimAutoMergeClient(session) : undefined
    },
    memoryFsFor: (agentId) => {
      const subject = agentSandboxSubject(agentId)
      const session = boundSession(subject)
      return session ? new ShimMemoryFs(session, sandboxMemoryRoot(driver.workspaceRootFor(subject))) : undefined
    },
    runsInSandbox,
    subjectForPath,
    sandboxBound: (subject) => boundSession(subject) !== undefined,
    // Bound-then-retain in one synchronous step, as the sweep's own gate reads it: a caller that checked and then awaited would have its pod suspended underneath it.
    holdIfBound: (subject) => (boundSession(subject) ? driver.retainLaunched(subject) : undefined),
    clearPath: async (agentId, root) => {
      const session = await sessionForPath(agentId, root).catch(() => undefined)
      if (!session) return `agent ${agentId} has no bound sandbox channel for ${root}`
      return await new ShimFileSink(session).clear(root)
    },
    workspaceRootFor: (subject) => driver.workspaceRootFor(subject),
    sessionDirFor,
    skillClientFor: (subject) => {
      const session = boundSession(subject)
      if (!session?.hasCapability('skills')) return undefined
      return new ClusterSkillClient(session, session.hasCapability('skills-wide'))
    },
    workspaceIncarnationFor: (subject) => driver.currentLaunch(subject)?.claimUid,
    shimGenerationFor: (subject) => driver.currentLaunch(subject)?.generation,
    launched: () => driver.launched(),
    suspendIdle: (subject) => driver.suspendIfIdle(subject),
    adoptAgent: async (agentId) => {
      await driver.adopt(agentSandboxSubject(agentId))
      // Its session pods too, so a Running one left by a departed member has a holder to suspend it.
      const adopted = await driver.adoptSessions(agentId).catch((err: unknown) => {
        options.log?.warn(`k8s: could not list the session sandboxes of agent ${agentId}: ${(err as Error).message}`)
        return []
      })
      if (adopted.length > 0)
        options.log?.info(`cluster: agent ${agentId} taken over with ${adopted.length} session pod(s)`)
    },
    releaseAgent,
    discardAgent: async (agentId) => {
      releaseAgent(agentId, 'agent removed')
      await driver.removeAgentSandboxes(agentId)
    },
    discardSession: async (agentId, leaf) => {
      const subject = sessionSandboxSubject(agentId, leaf)
      releaseSubject(subject, 'session retired')
      await driver.removeSandbox(subject)
    },
    hasSandbox: (subject) => driver.hasClaim(subject as SandboxSubject),
    stop: async () => {
      if (stampRefresh) clearInterval(stampRefresh)
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

// A `WorkspaceFs` over several pods: every operation names a path, and the path names the pod (§11); `rename` must stay within one.
export class RoutedWorkspaceFs implements WorkspaceFs {
  constructor(private readonly route: (path: string) => Promise<WorkspaceFs>) {}

  async stat(path: string): ReturnType<WorkspaceFs['stat']> {
    return await (await this.route(path)).stat(path)
  }

  async readdir(path: string): Promise<string[]> {
    return await (await this.route(path)).readdir(path)
  }

  async mkdir(path: string, mode?: number): Promise<void> {
    return await (await this.route(path)).mkdir(path, mode)
  }

  async readFile(path: string): Promise<string | undefined> {
    return await (await this.route(path)).readFile(path)
  }

  async readFileBytes(path: string, maxBytes: number): ReturnType<WorkspaceFs['readFileBytes']> {
    return await (await this.route(path)).readFileBytes(path, maxBytes)
  }

  async writeFile(path: string, content: string, options?: { mode?: number }): Promise<void> {
    return await (await this.route(path)).writeFile(path, content, options)
  }

  async rename(from: string, to: string): Promise<void> {
    return await (await this.route(from)).rename(from, to)
  }

  async rmdir(path: string): Promise<boolean> {
    return await (await this.route(path)).rmdir(path)
  }

  async rmTree(path: string): Promise<void> {
    return await (await this.route(path)).rmTree(path)
  }
}

// The console's file port over several pods: each call names its root, and the root names the pod (§11).
export class RoutedWorkspaceFiles implements WorkspaceFiles {
  constructor(private readonly route: (root: string) => Promise<WorkspaceFiles>) {}

  async list(root: string, req: Parameters<WorkspaceFiles['list']>[1]): ReturnType<WorkspaceFiles['list']> {
    return await (await this.route(root)).list(root, req)
  }

  async read(root: string, req: Parameters<WorkspaceFiles['read']>[1]): ReturnType<WorkspaceFiles['read']> {
    return await (await this.route(root)).read(root, req)
  }

  async write(
    root: string,
    scratch: boolean,
    req: Parameters<WorkspaceFiles['write']>[2]
  ): ReturnType<WorkspaceFiles['write']> {
    return await (await this.route(root)).write(root, scratch, req)
  }

  async delete(
    root: string,
    scratch: boolean,
    req: Parameters<WorkspaceFiles['delete']>[2]
  ): ReturnType<WorkspaceFiles['delete']> {
    return await (await this.route(root)).delete(root, scratch, req)
  }
}
