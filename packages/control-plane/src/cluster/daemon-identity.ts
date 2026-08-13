/**
 * Verifying an in-cluster daemon's Kubernetes identity
 * (docs/designs/agentconnect-org-operator.md, "Daemon identity").
 *
 * The daemon presents the audience-scoped ServiceAccount token the kubelet projects into
 * its pod; this reviews it against the cluster that issued it and maps the reviewed subject
 * back to an org. The audience is the gate both shapes share — a sandbox's token carries the
 * shim audience and is refused here — and the ServiceAccount name then says which shape it is:
 *
 *  - {@link ENVELOPE_DAEMON_SA_NAME}: an ENVELOPE daemon, one org's own pod. Its namespace
 *    must be the one the operator published on that org's `status.namespace`, and that
 *    namespace IS the org — a claim to serve another one is refused.
 *  - {@link CLOUD_DAEMON_SA_NAME} in the install's cloud-daemon namespace: a CLOUD daemon,
 *    which serves EVERY org and whose identity therefore names none. The org comes from the
 *    connection's own claim, which is safe here and only here: this ServiceAccount is an
 *    install-level principal, so "which org" is a routing choice rather than a privilege.
 *
 * The daemon record is resolved-or-provisioned from the verified identity, the same
 * just-in-time shape `UserRepo` runs for an OIDC subject: an envelope has exactly one
 * daemon, so cluster + namespace + ServiceAccount designates exactly one record, and a
 * cloud daemon gets one record per org it serves.
 */
import { CLOUD_DAEMON_SA_NAME, CP_TOKEN_AUDIENCE, ENVELOPE_DAEMON_SA_NAME } from '@agentconnect.md/protocol'
import type { K8sHttp } from '@agentconnect.md/k8s-client'
import { DaemonId, OrgId } from '../domain/ids.js'
import type { ClusterDaemonIdentity, VerifiedClusterDaemon } from '../ports.js'
import type { DaemonRepo, OrgClusterExecutionRepo, OrgRepo } from '../persistence/ports.js'
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

/** The identity string an envelope daemon's record is bound to; exactly what TokenReview
 *  reported, so the binding is the API server's answer rather than a re-derivation of it. */
export function clusterIdentityOf(namespace: string, serviceAccount: string): string {
  return `system:serviceaccount:${namespace}:${serviceAccount}`
}

/** The identity string ONE org's record of a cloud daemon is bound to. `Daemon.clusterIdentity`
 *  is globally unique, so a principal serving many orgs needs one row — and so one distinct
 *  identity string — per org; qualifying the reported subject with the org is what gives it
 *  that while keeping the two halves readable. It also makes crossing tenants structurally
 *  impossible: org A's connection cannot name a string that resolves to org B's row. */
export function cloudIdentityOf(namespace: string, serviceAccount: string, orgId: string): string {
  return `${clusterIdentityOf(namespace, serviceAccount)}/org/${orgId}`
}

export class ClusterDaemonIdentityService implements ClusterDaemonIdentity {
  constructor(
    private readonly http: K8sHttp,
    private readonly api: OrgResourceApi,
    private readonly cluster: Pick<OrgClusterExecutionRepo, 'getByResourceName'>,
    private readonly daemons: Pick<DaemonRepo, 'resolveClusterIdentity' | 'findClusterIdentity'>,
    /** The install's org-namespace prefix — how a namespace names its CR. */
    private readonly namespacePrefix: string,
    /** Existence of the org a cloud daemon's connection claims; the cloud path only. */
    private readonly orgs: Pick<OrgRepo, 'slugById'>,
    /** Namespace the install runs its cloud daemons in. A cloud identity from anywhere else
     *  is refused, so the claim-your-own-org rule stays confined to pods the install placed. */
    private readonly cloudNamespace: string
  ) {}

  async verify(token: string, claim?: { orgId?: string; daemonId?: string }): Promise<VerifiedClusterDaemon | null> {
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
      // An envelope daemon's namespace already decided its org, so a claim may only agree.
      if (!verified) return null
      if (claim?.orgId && claim.orgId !== verified.orgId) return null
      if (claim?.daemonId && claim.daemonId !== verified.daemonId) return null
      return verified
    }
    if (subject.serviceAccount === CLOUD_DAEMON_SA_NAME && subject.namespace === this.cloudNamespace) {
      return this.bindCloud(subject.namespace, subject.serviceAccount, claim)
    }
    return null
  }

  /**
   * A cloud daemon's record FOR THE ORG THIS CONNECTION IS FOR. Two callers name that org
   * differently and neither may guess: the CP socket states it outright (`auth.orgId`, the
   * only place a new org's record can be created), and the relay hop instead forwards the
   * daemonId the daemon claimed, which is resolved back to its org and then required to be a
   * record this very identity owns. A claimed id belonging to a key-bound daemon, to an
   * envelope, or to another principal's record matches nothing and is refused.
   */
  private async bindCloud(
    namespace: string,
    serviceAccount: string,
    claim?: { orgId?: string; daemonId?: string }
  ): Promise<VerifiedClusterDaemon | null> {
    let orgId = claim?.orgId
    if (!orgId && claim?.daemonId) {
      const bound = await this.daemons.findClusterIdentity(DaemonId(claim.daemonId))
      if (!bound) return null
      if (bound.clusterIdentity !== cloudIdentityOf(namespace, serviceAccount, bound.orgId)) return null
      orgId = bound.orgId
    }
    if (!orgId) return null
    // Existence only: a cloud daemon serves every org, including those with no cluster
    // envelope of their own, so there is no per-org enablement to consult here.
    if (!(await this.orgs.slugById(orgId))) return null
    const daemon = await this.daemons.resolveClusterIdentity(
      OrgId(orgId),
      cloudIdentityOf(namespace, serviceAccount, orgId)
    )
    if (!daemon) return null
    if (claim?.daemonId && claim.daemonId !== daemon.id) return null
    return { daemonId: DaemonId(daemon.id), orgId: OrgId(orgId) }
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
