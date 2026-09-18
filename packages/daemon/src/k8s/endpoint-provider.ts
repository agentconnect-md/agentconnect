import type { ShimEndpointProvider } from '../remote/shim-endpoint.js'
import type { Launch } from '../remote/launch-registry.js'
import type { SandboxLease } from './sandbox-lease.js'

/** A launch whose shim lives in a Sandbox pod: the object to hold and wake, and the claim it was bound through. */
export interface SandboxLaunch extends Launch {
  sandboxName: string
  claimUid: string
}

export interface SandboxEndpointProviderDeps {
  lease: SandboxLease
  /** Wait for the launch's Sandbox to report Ready and name its pod. */
  awaitReady: (sandboxName: string) => Promise<{ podName: string; podIp: string }>
}

/** The Kubernetes endpoint: resume the Sandbox, wait for its pod, and expect that pod's identity at its IP. */
export function sandboxEndpointProvider(deps: SandboxEndpointProviderDeps): ShimEndpointProvider<SandboxLaunch> {
  return {
    retain: (launch) => deps.lease.retain(launch.sandboxName),
    release: (launch) => deps.lease.release(launch.sandboxName),
    async resolve(launch, timer) {
      // Resume before waiting because suspension deleted the pod and readiness cannot arrive first.
      const modeBeforeWake = await deps.lease.queueMode(launch.sandboxName, 'Running')
      // A cached launch returns from ensureSandbox before any sandbox read, so this is where the common `launch → suspend → launch` resume learns what it is instead of reporting `warm`.
      if (modeBeforeWake) timer?.observedPath(modeBeforeWake === 'Suspended' ? 'resume' : 'warm')
      timer?.mark('mode_running')
      const pod = await deps.awaitReady(launch.sandboxName)
      timer?.mark('pod_ready')
      return { address: pod.podIp, peer: { podName: pod.podName } }
    }
  }
}
