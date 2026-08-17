/**
 * Verifies the projected Kubernetes identity of an install-level usage reporter.
 *
 * Same mechanism as a pool member's (kubelet-projected token, audience
 * `CP_TOKEN_AUDIENCE`, verified by TokenReview) and deliberately NOT the same principal: the
 * discriminator is the ServiceAccount name, exactly as it already separates a pool member from
 * an envelope daemon. A reporter is not a daemon — it never registers, holds no duty, receives
 * no orchestration — so it resolves to no daemon record and gets no daemon capability. All it
 * may do is report usage.
 *
 * No Pod UID is required, which is the one place this differs from the pool member's check and
 * is worth saying plainly: a member needs one because replicas share a subject and each Pod is
 * its own fleet member, whereas reporter replicas are interchangeable writers of the same
 * install-wide telemetry. Pinning the Pod would buy nothing and would make a rollout look like
 * an unknown principal.
 */
import { USAGE_REPORTER_SA_NAME } from '@agentconnect.md/protocol'
import type { K8sHttp } from '@agentconnect.md/k8s-client'
import { reviewProjectedToken } from './daemon-identity.js'

export interface ClusterUsageReporterIdentity {
  /** True when the bearer is this install's usage reporter. */
  verify(token: string): Promise<boolean>
}

export class ClusterUsageReporterIdentityService implements ClusterUsageReporterIdentity {
  constructor(
    private readonly http: K8sHttp,
    /** Namespace the reporter runs in — the install's own. The same identity presented from
     *  anywhere else is refused, so "may report for every org" never follows from a pod merely
     *  holding the ServiceAccount name. */
    private readonly reporterNamespace: string
  ) {}

  async verify(token: string): Promise<boolean> {
    const subject = await reviewProjectedToken(this.http, token)
    if (!subject) return false
    return subject.serviceAccount === USAGE_REPORTER_SA_NAME && subject.namespace === this.reporterNamespace
  }
}
