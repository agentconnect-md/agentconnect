/**
 * Verifying an in-cluster daemon's Kubernetes identity
 * (docs/designs/agentconnect-org-operator.md, "Daemon identity").
 *
 * The daemon presents the audience-scoped ServiceAccount token the kubelet projects into
 * its pod; this reviews it against the cluster that issued it and maps the reviewed subject
 * back to an org. Three things must hold, and the token is refused unless all three do:
 * the audience is {@link CP_TOKEN_AUDIENCE}, the ServiceAccount is
 * {@link ENVELOPE_DAEMON_SA_NAME}, and the subject's namespace is the one the operator
 * published on that org's `status.namespace`. The audience is the real gate — a sandbox's
 * token carries the shim audience and is refused here — and the rest keep a token from a
 * neighbouring pod or a neighbouring org from standing in for the daemon.
 *
 * The daemon record is resolved-or-provisioned from the verified identity, the same
 * just-in-time shape `UserRepo` runs for an OIDC subject: an envelope has exactly one
 * daemon, so cluster + namespace + ServiceAccount designates exactly one record.
 */
import { CP_TOKEN_AUDIENCE, ENVELOPE_DAEMON_SA_NAME } from '@agentconnect.md/protocol'
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
    user?: { username?: string }
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

/** The identity string a daemon record is bound to; exactly what TokenReview reported, so
 *  the binding is the API server's answer rather than a re-derivation of it. */
export function clusterIdentityOf(namespace: string, serviceAccount: string): string {
  return `system:serviceaccount:${namespace}:${serviceAccount}`
}

export class ClusterDaemonIdentityService implements ClusterDaemonIdentity {
  constructor(
    private readonly http: K8sHttp,
    private readonly api: OrgResourceApi,
    private readonly cluster: Pick<OrgClusterExecutionRepo, 'getByResourceName'>,
    private readonly daemons: Pick<DaemonRepo, 'resolveClusterIdentity'>,
    /** The install's org-namespace prefix — how a namespace names its CR. */
    private readonly namespacePrefix: string
  ) {}

  async verify(token: string): Promise<VerifiedClusterDaemon | null> {
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
    if (!subject || subject.serviceAccount !== ENVELOPE_DAEMON_SA_NAME) return null
    return this.bind(subject.namespace, subject.serviceAccount)
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
    return { daemonId: DaemonId(daemon.id), orgId }
  }
}
