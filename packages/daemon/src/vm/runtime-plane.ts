import { ShimDialer } from '../shim/dialer.js'
import { ShimAutoMergeClient } from '../shim/auto-merge-client.js'
import { ShimGitRunner } from '../shim/git-exec.js'
import { ShimFileSink } from '../shim/channels.js'
import { ClusterSkillClient } from '../shim/skill-client.js'
import { ShimWorkspaceFiles } from '../shim/workspace-files-channel.js'
import { ShimMemoryFs, sandboxMemoryRoot } from '../shim/memory-fs-channel.js'
import { ShimWorkspaceFs } from '../shim/workspace-fs-channel.js'
import { DEFAULT_SHIM_LISTEN_PORT, DEFAULT_SHIM_WORKSPACE_ROOT } from '../shim/protocol.js'
import { PROBE_GRANTS, RUNTIME_GRANTS } from '../shim/grants.js'
import type { TunnelName } from '../shim/tunnel.js'
import { TunnelBinder } from '../shim/tunnel-binder.js'

import { K8sRuntimeTableSchema, type K8sRuntimeTable } from '../runtimes/k8s-runtimes.js'
import type { ProbeSandboxSweep, RuntimePlane } from '../runtime-plane/contract.js'
import { VmDriver } from './driver.js'
import { VmDiskLayout } from './disks.js'
import { VmBootRegistry } from './identity.js'
import { VmAdmission, resolveVmBudget, type VmBudgetOptions } from './admission.js'
import type { VmmProcessDeps } from './vmm-process.js'
import type { Clock } from '@agentconnect.md/connection'

const SILENT = { info: () => {}, warn: () => {} }
const PROBE_TIMEOUT_MS = 180_000
/** The identity a probe boot runs under; never an agent, so it is never served a workspace. */
const PROBE_AGENT_ID = 'ac-vm-runtime-probe'

export interface VmRuntimePlaneOptions {
  disks: VmDiskLayout
  vmm: VmmProcessDeps
  /** Durable per-agent launch counter, shared with the store so a restart never reuses one. */
  nextGeneration: (agentId: string) => Promise<number>
  /** This daemon's identity, for parity with the pool's probe election. */
  memberId: string
  /** Identifies the guest image these VMs boot, so a probe result can be keyed on it. */
  guestImage: () => Promise<string>
  tunnelsFor?: (agentId: string) => TunnelName[]
  tunnelSocketPath?: (tunnel: TunnelName) => string | undefined
  shimPort?: number
  bindTimeoutMs?: number
  /** Host-wide ceilings on how many guests may run at once. */
  budget?: VmBudgetOptions
  clock?: Clock
  log?: { info: (m: string) => void; warn: (m: string) => void; debug?: (m: string) => void }
}

/**
 * Assembles the VM execution plane: the same shim dialer, session and remote runtime the cluster
 * path uses, over a guest this daemon booted itself rather than a pod it claimed.
 *
 * Everything below the bind is shared on purpose. What differs is only what has to: identity is a
 * per-boot secret instead of a projected ServiceAccount token, and there is no claim, warm pool or
 * API server to reconcile against, because the sandbox is a process this daemon owns outright.
 */
export async function startVmRuntimePlane(options: VmRuntimePlaneOptions): Promise<RuntimePlane> {
  const log = options.log ?? SILENT
  const identities = new VmBootRegistry()
  const admission = new VmAdmission(resolveVmBudget(options.budget))
  log.info(
    `vm: admitting at most ${admission.budget.maxConcurrentVms} guests ` +
      `(${admission.budget.cpuPerVm} vCPU each, ${admission.budget.maxTotalVcpus} total on ${admission.budget.hostCores} cores)`
  )
  const tunnels = new TunnelBinder({
    ...(options.tunnelsFor ? { tunnelsFor: options.tunnelsFor } : {}),
    ...(options.tunnelSocketPath ? { tunnelSocketPath: options.tunnelSocketPath } : {}),
    log
  })

  const dialer = new ShimDialer({
    verifier: identities,
    log,
    onConnection: (connection) => driver.onChannelBound(connection),
    onConnectionLost: (agentId, reason) => driver.onChannelLost(agentId, reason)
  })

  const driver = new VmDriver({
    dialer,
    identities,
    nextGeneration: options.nextGeneration,
    place: async (agentId, vmName, secret) => options.disks.place(agentId, vmName, secret),
    unplace: async (agentId, vmName) => options.disks.unplace(agentId, vmName),
    admission,
    vmm: options.vmm,
    // The probe boot asks an image what it ships and must not thereby receive an agent's workspace
    // and tunnel authority; an agent's channel must not be able to ask for a probe either.
    grantsForAgent: (agentId) => (agentId === PROBE_AGENT_ID ? PROBE_GRANTS : RUNTIME_GRANTS),
    shimPort: options.shimPort ?? DEFAULT_SHIM_LISTEN_PORT,
    ...(options.bindTimeoutMs === undefined ? {} : { bindTimeoutMs: options.bindTimeoutMs }),
    ...(options.clock ? { clock: options.clock } : {}),
    log
  })

  const runsInSandbox = (agentId: string): boolean => driver.runsInSandbox(agentId)
  const sessionOf = (agentId: string) => driver.sessionFor(agentId)!
  const mountOf = (agentId: string): string => driver.workspaceRootFor(agentId) ?? DEFAULT_SHIM_WORKSPACE_ROOT

  // Bind the tunnels the agent needs as soon as its channel is up: gitcred and the MCP bridge are
  // reached from inside the guest, and a runtime that starts before them retries a dead socket.
  const bindTunnels = async (agentId: string): Promise<void> => {
    const session = driver.sessionFor(agentId)
    if (!session) return
    await tunnels.ensure(agentId, session).catch((err: unknown) => {
      log.warn(`vm: could not open tunnels for agent "${agentId}": ${(err as Error).message}`)
    })
  }

  let probeInFlight: Promise<K8sRuntimeTable> | undefined

  /** Boot one throwaway guest, ask its image what runtimes it ships, and tear it down again. */
  function probeRuntimes(sweep?: ProbeSandboxSweep): Promise<K8sRuntimeTable> {
    if (probeInFlight) return probeInFlight
    probeInFlight = (async () => {
      try {
        await driver.ensureChannel(PROBE_AGENT_ID)
        const session = driver.sessionFor(PROBE_AGENT_ID)
        if (!session) throw new Error('probe guest bound no session')
        const table = K8sRuntimeTableSchema.parse(await session.request('probe', {}, { timeoutMs: PROBE_TIMEOUT_MS }))
        // Reported, never raised: a failed sweep costs model detail, not the runtimes themselves.
        if (sweep) {
          await sweep(table, { agentId: PROBE_AGENT_ID, cwd: mountOf(PROBE_AGENT_ID) }).catch((err: unknown) => {
            log.warn(`vm: probe sweep failed: ${(err as Error).message}`)
          })
        }
        return table
      } finally {
        // Through releaseAgent, not the driver directly: the dial is supervised and reconnects on
        // its own, so a teardown that does not revoke it retries a guest that is gone forever.
        try {
          releaseAgent(PROBE_AGENT_ID, 'probe complete')
        } catch (err) {
          log.warn(`vm: probe guest teardown failed: ${(err as Error).message}`)
        }
        // The probe is not an agent, so nothing of it should survive its own boot.
        options.disks.discard(PROBE_AGENT_ID)
      }
    })().finally(() => {
      probeInFlight = undefined
    })
    return probeInFlight
  }

  const releaseAgent = (agentId: string, reason = 'agent no longer served here'): void => {
    dialer.revokeAgent(agentId)
    tunnels.release(agentId, reason)
    void driver.releaseAgent(agentId)
  }

  return {
    driver,
    memberId: options.memberId,
    runtimeImage: options.guestImage,
    ensureChannel: async (agentId) => {
      await driver.ensureChannel(agentId)
      await bindTunnels(agentId)
    },
    // There is no idle sweep racing a hold here: a guest is suspended only by an explicit call,
    // so holding one for the duration of `work` is what already happens.
    withSandbox: async (agentId, work) => {
      await driver.ensureChannel(agentId)
      await bindTunnels(agentId)
      // Held for the duration: workspace preparation runs here, and a sweep that suspended the
      // guest halfway through would leave a half-cloned checkout on the data disk.
      driver.retain(agentId)
      try {
        return await work()
      } finally {
        driver.releaseHold(agentId)
      }
    },
    probeRuntimes,
    gitRunnerFor: (agentId, cwd, abort) =>
      runsInSandbox(agentId) ? new ShimGitRunner(sessionOf(agentId), cwd, undefined, abort) : undefined,
    workspaceFilesFor: (agentId) => (runsInSandbox(agentId) ? new ShimWorkspaceFiles(sessionOf(agentId)) : undefined),
    workspaceFsFor: (agentId) => {
      if (!runsInSandbox(agentId)) return undefined
      const mount = mountOf(agentId)
      return { fs: new ShimWorkspaceFs(sessionOf(agentId), mount), mount }
    },
    autoMergeFor: (agentId) => (runsInSandbox(agentId) ? new ShimAutoMergeClient(sessionOf(agentId)) : undefined),
    memoryFsFor: (agentId) =>
      runsInSandbox(agentId)
        ? new ShimMemoryFs(sessionOf(agentId), sandboxMemoryRoot(driver.workspaceRootFor(agentId)))
        : undefined,
    runsInSandbox,
    clearPath: async (agentId, root) => {
      const session = driver.sessionFor(agentId)
      if (!session?.isAttached()) return `agent ${agentId} has no bound guest channel`
      return await new ShimFileSink(session).clear(root)
    },
    workspaceRootFor: (agentId) => driver.workspaceRootFor(agentId),
    skillClientFor: (agentId) =>
      runsInSandbox(agentId) && driver.sessionFor(agentId)?.hasCapability('skills')
        ? new ClusterSkillClient(sessionOf(agentId))
        : undefined,
    // The boot name, which changes on every boot: the workspace on the data disk survives, but the
    // guest holding it does not, and callers use this to notice they are looking at a new one.
    workspaceIncarnationFor: (agentId) => driver.currentLaunch(agentId)?.vmName,
    shimGenerationFor: (agentId) => driver.currentLaunch(agentId)?.generation,
    launchedAgents: () => driver.launchedAgents(),
    // A guest is a process this daemon owns: there is nothing to take over from, and a launch this
    // process does not hold is one that died with the daemon that held it.
    adoptAgent: async () => {},
    releaseAgent,
    suspendIdle: (agentId) => driver.suspend(agentId),
    discardAgent: async (agentId) => {
      releaseAgent(agentId, 'agent removed')
      options.disks.discard(agentId)
    },
    describeResidue: (agentId) => `vm state directory "${options.disks.agentRoot(agentId)}"`,
    stop: async () => {
      tunnels.releaseAll('daemon is shutting down')
      // Every guest is asked to stop before any is waited on: sequential teardown of a dozen
      // guests takes minutes, because each spends seconds in its own shutdown.
      await driver.stop()
      dialer.stop()
      identities.revokeAll()
    }
  }
}
