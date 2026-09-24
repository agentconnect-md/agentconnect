import type { ShimEndpointProvider } from '../remote/shim-endpoint.js'
import type { Launch } from '../remote/launch-registry.js'
import type { SandboxLease } from './sandbox-lease.js'
import { K8sApiError } from '@agentconnect.md/k8s-client'

/** A launch whose shim lives in a Sandbox pod: the object to hold and wake, and the claim it was bound through. */
export interface SandboxLaunch extends Launch {
  sandboxName: string
  claimUid: string
}

export interface SandboxEndpointProviderDeps {
  lease: SandboxLease
  /** Wait for the launch's Sandbox to report Ready and name its pod. */
  awaitReady: (sandboxName: string) => Promise<{ podName: string; podIp: string }>
  onNotFound: (launch: SandboxLaunch) => Promise<void>
}

/** The Kubernetes endpoint: resume the Sandbox, wait for its pod, and expect that pod's identity at its IP. */
export function sandboxEndpointProvider(deps: SandboxEndpointProviderDeps): ShimEndpointProvider<SandboxLaunch> {
  return {
    retain: (launch) => deps.lease.retain(launch),
    release: (launch) => deps.lease.release(launch),
    async resolve(launch, timer) {
      // Resume before waiting because suspension deleted the pod and readiness cannot arrive first.
      const modeBeforeWake = await deps.lease.queueMode(launch, 'Running').catch(async (err: unknown) => {
        if (err instanceof K8sApiError && err.isNotFound) await deps.onNotFound(launch)
        throw err
      })
      // The mode before wake distinguishes a resumed launch from a warm one.
      if (modeBeforeWake) timer?.observedPath(modeBeforeWake === 'Suspended' ? 'resume' : 'warm')
      timer?.mark('mode_running')
      const pod = await deps.awaitReady(launch.sandboxName)
      timer?.mark('pod_ready')
      return { address: pod.podIp, peer: { name: pod.podName, proof: 'pod' } }
    }
  }
}
