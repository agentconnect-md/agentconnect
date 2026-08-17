/** Verifies a Pod's projected Kubernetes identity as an install-wide pool member. */
import { CLOUD_DAEMON_SA_NAME } from '@agentconnect.md/protocol'
import type { K8sHttp } from '@agentconnect.md/k8s-client'
import { DaemonId } from '../domain/ids.js'
import type { ClusterDaemonIdentity, VerifiedClusterDaemon } from '../ports.js'
import type { DaemonRepo } from '../persistence/ports.js'
import { reviewProjectedToken } from './projected-token.js'

/** The identity string a daemon's record is bound to; exactly what TokenReview
 *  reported, so the binding is the API server's answer rather than a re-derivation of it. */
export function clusterIdentityOf(namespace: string, serviceAccount: string): string {
  return `system:serviceaccount:${namespace}:${serviceAccount}`
}

export class ClusterDaemonIdentityService implements ClusterDaemonIdentity {
  constructor(
    private readonly http: K8sHttp,
    private readonly daemons: Pick<DaemonRepo, 'resolvePoolClusterIdentity'>,
    /** Namespace the daemon pool runs in — the control plane's own. A pool identity from anywhere
     *  else is refused, so the claim-your-own-org rule stays confined to pods the install placed. */
    private readonly poolNamespace: string
  ) {}

  async verify(token: string, claim?: { daemonId?: string }): Promise<VerifiedClusterDaemon | null> {
    const reviewed = await reviewProjectedToken(this.http, token, {
      namespace: this.poolNamespace,
      serviceAccount: CLOUD_DAEMON_SA_NAME
    })
    if (!reviewed) return null
    return this.bindPoolMember(reviewed.namespace, reviewed.serviceAccount, reviewed.podUid, claim?.daemonId)
  }

  /** Resolve one pool member Pod to its org-less member row. */
  private async bindPoolMember(
    namespace: string,
    serviceAccount: string,
    podUid: string,
    claimedDaemonId?: string
  ): Promise<VerifiedClusterDaemon | null> {
    const identity = clusterIdentityOf(namespace, serviceAccount)
    const daemon = await this.daemons.resolvePoolClusterIdentity(identity, podUid)
    if (claimedDaemonId && claimedDaemonId !== daemon.id) return null
    return { daemonId: DaemonId(daemon.id), scope: 'install' }
  }
}
