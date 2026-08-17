/** Verifies a projected Kubernetes identity for a non-daemon in-cluster workload. */
import type { K8sHttp } from '@agentconnect.md/k8s-client'
import type { ClusterWorkloadIdentity, VerifiedClusterWorkload } from '../ports.js'
import { reviewProjectedToken } from './projected-token.js'

/**
 * The daemon verifier's sibling: same TokenReview core, no daemon binding. A daemon's
 * token resolves to a member ROW it may then act as; a workload token resolves to
 * nothing but "yes, this is that ServiceAccount's pod" — which is all an ingress
 * endpoint needs, and all it should be able to obtain.
 */
export class ClusterWorkloadIdentityService implements ClusterWorkloadIdentity {
  constructor(
    private readonly http: K8sHttp,
    /** The control plane's own namespace — the only one an install-level workload may
     *  present from, matching the pool member rule. */
    private readonly namespace: string
  ) {}

  async verify(token: string, serviceAccount: string): Promise<VerifiedClusterWorkload | null> {
    const reviewed = await reviewProjectedToken(this.http, token, { namespace: this.namespace, serviceAccount })
    return reviewed ? { podUid: reviewed.podUid } : null
  }
}
