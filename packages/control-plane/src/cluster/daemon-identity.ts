/** Verifies a Pod's projected Kubernetes identity as an install-wide cloud daemon. */
import { CLOUD_DAEMON_SA_NAME, CP_TOKEN_AUDIENCE } from '@agentconnect.md/protocol'
import type { K8sHttp } from '@agentconnect.md/k8s-client'
import { DaemonId } from '../domain/ids.js'
import type { ClusterDaemonIdentity, VerifiedClusterDaemon } from '../ports.js'
import type { DaemonRepo } from '../persistence/ports.js'

/** What TokenReview answers, narrowed to the fields verification reads. */
interface TokenReviewResponse {
  status?: {
    authenticated?: boolean
    audiences?: string[]
    error?: string
    user?: { username?: string; extra?: Record<string, string[]> }
  }
}

/** The `system:serviceaccount:<namespace>:<name>` subject, or null for any other principal. */
export function parseServiceAccountSubject(username: string | undefined): {
  namespace: string
  serviceAccount: string
} | null {
  const parts = (username ?? '').split(':')
  if (parts.length !== 4 || parts[0] !== 'system' || parts[1] !== 'serviceaccount') return null
  const [, , namespace, serviceAccount] = parts
  if (!namespace || !serviceAccount) return null
  return { namespace, serviceAccount }
}

/** The identity string a daemon's record is bound to; exactly what TokenReview
 *  reported, so the binding is the API server's answer rather than a re-derivation of it. */
export function clusterIdentityOf(namespace: string, serviceAccount: string): string {
  return `system:serviceaccount:${namespace}:${serviceAccount}`
}

const POD_UID_EXTRA = 'authentication.kubernetes.io/pod-uid'

/** The Pod UID attested by TokenReview for a Pod-bound projected token. */
export function reviewedPodUid(extra: Record<string, string[]> | undefined): string | null {
  const values = extra?.[POD_UID_EXTRA]
  return values?.length === 1 && values[0] ? values[0] : null
}

export class ClusterDaemonIdentityService implements ClusterDaemonIdentity {
  constructor(
    private readonly http: K8sHttp,
    private readonly daemons: Pick<DaemonRepo, 'resolveCloudClusterIdentity'>,
    /** Namespace the install runs its cloud daemons in. A cloud identity from anywhere else
     *  is refused, so the claim-your-own-org rule stays confined to pods the install placed. */
    private readonly cloudNamespace: string
  ) {}

  async verify(token: string, claim?: { daemonId?: string }): Promise<VerifiedClusterDaemon | null> {
    const review = await this.http.json<TokenReviewResponse>({
      method: 'POST',
      path: '/apis/authentication.k8s.io/v1/tokenreviews',
      body: {
        apiVersion: 'authentication.k8s.io/v1',
        kind: 'TokenReview',
        spec: { token, audiences: [CP_TOKEN_AUDIENCE] }
      }
    })
    const status = review.status ?? {}
    if (status.authenticated !== true) return null
    // Asserted rather than inferred from `authenticated`: the API server echoes the
    // audiences the token is actually valid for, and only ours may authenticate here.
    if (!status.audiences?.includes(CP_TOKEN_AUDIENCE)) return null
    const subject = parseServiceAccountSubject(status.user?.username)
    if (!subject) return null
    if (subject.serviceAccount !== CLOUD_DAEMON_SA_NAME || subject.namespace !== this.cloudNamespace) return null
    const podUid = reviewedPodUid(status.user?.extra)
    if (!podUid) return null
    return this.bindCloud(subject.namespace, subject.serviceAccount, podUid, claim?.daemonId)
  }

  /** Resolve one cloud Pod to its org-less member row. */
  private async bindCloud(
    namespace: string,
    serviceAccount: string,
    podUid: string,
    claimedDaemonId?: string
  ): Promise<VerifiedClusterDaemon | null> {
    const identity = clusterIdentityOf(namespace, serviceAccount)
    const daemon = await this.daemons.resolveCloudClusterIdentity(identity, podUid)
    if (claimedDaemonId && claimedDaemonId !== daemon.id) return null
    return { daemonId: DaemonId(daemon.id), scope: 'install' }
  }
}
