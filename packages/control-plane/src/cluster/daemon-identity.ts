/** Verifies projected Kubernetes identity as an org envelope or an install-wide cloud member. */
import { CLOUD_DAEMON_SA_NAME, CP_TOKEN_AUDIENCE, ENVELOPE_DAEMON_SA_NAME } from '@agentconnect.md/protocol'
import type { K8sHttp } from '@agentconnect.md/k8s-client'
import { DaemonId, OrgId } from '../domain/ids.js'
import type { ClusterDaemonIdentity, VerifiedClusterDaemon } from '../ports.js'
import type { DaemonRepo, OrgClusterExecutionRepo } from '../persistence/ports.js'
import type { OrgResourceApi } from './org-api.js'

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

/** The identity string an envelope daemon's record is bound to; exactly what TokenReview
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
    private readonly api: OrgResourceApi,
    private readonly cluster: Pick<OrgClusterExecutionRepo, 'getByResourceName'>,
    private readonly daemons: Pick<DaemonRepo, 'resolveClusterIdentity' | 'resolveCloudClusterIdentity'>,
    /** The install's org-namespace prefix — how a namespace names its CR. */
    private readonly namespacePrefix: string,
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
    if (subject.serviceAccount === ENVELOPE_DAEMON_SA_NAME) {
      const verified = await this.bind(subject.namespace, subject.serviceAccount)
      if (!verified) return null
      if (claim?.daemonId && claim.daemonId !== verified.daemonId) return null
      return verified
    }
    if (subject.serviceAccount === CLOUD_DAEMON_SA_NAME && subject.namespace === this.cloudNamespace) {
      const podUid = reviewedPodUid(status.user?.extra)
      if (!podUid) return null
      return this.bindCloud(subject.namespace, subject.serviceAccount, podUid, claim?.daemonId)
    }
    return null
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

  /** The org that owns a verified namespace, and the daemon record bound to that identity. */
  private async bind(namespace: string, serviceAccount: string): Promise<VerifiedClusterDaemon | null> {
    if (!namespace.startsWith(this.namespacePrefix)) return null
    const resourceName = namespace.slice(this.namespacePrefix.length)
    if (!resourceName) return null
    const settings = await this.cluster.getByResourceName(resourceName)
    // A disabled envelope is being torn down; its pod has no business registering.
    if (!settings?.enabled) return null
    // The authority is the operator's own publication, not the prefix arithmetic above:
    // that only names a candidate CR, and this is what proves the namespace is its.
    const published = (await this.api.get(resourceName))?.status?.namespace
    if (published !== namespace) return null
    const orgId = OrgId(settings.orgId)
    const daemon = await this.daemons.resolveClusterIdentity(orgId, clusterIdentityOf(namespace, serviceAccount), {
      // An envelope provisioned through the retired API-key path already has a daemon record;
      // the first token connect adopts it rather than stranding its placements beside a new one.
      ...(settings.legacyKeyDaemonId ? { adoptDaemonId: settings.legacyKeyDaemonId } : {})
    })
    if (!daemon) return null
    return { daemonId: DaemonId(daemon.id), scope: 'org', orgId }
  }
}
