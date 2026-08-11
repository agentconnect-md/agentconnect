import type { AgentConnectOrg } from '../crd/types.js'
import type { ReconcileContext } from './context.js'

// Each step owes its implementer the contract in its comment; bodies are
// deliberately TODO stubs — the ordering and the seam are the skeleton.

/** Create-or-adopt spec.targetNamespace: claim by label, reject a label-mismatched existing namespace as Degraded. */
export async function ensureNamespace(ctx: ReconcileContext, org: AgentConnectOrg): Promise<void> {
  // TODO(operator): create the namespace with the claim + PSS labels, or adopt when labels match; Degraded on mismatch.
  void ctx
  void org
}

/** Daemon SA plus runtime SA (automountServiceAccountToken: false, zero role bindings). */
export async function ensureServiceAccounts(ctx: ReconcileContext, org: AgentConnectOrg): Promise<void> {
  // TODO(operator): stamp the two ServiceAccounts; the runtime SA exists only to be named by the pod template.
  void ctx
  void org
}

/** Namespaced Role/RoleBinding for the daemon SA: SandboxClaim CRUD + operatingMode patch, no Secret API. */
export async function ensureRoleAndBinding(ctx: ReconcileContext, org: AgentConnectOrg): Promise<void> {
  // TODO(operator): render the Role from the fixed verb set; never grant Secret verbs here.
  void ctx
  void org
}

/** Per-org ClusterRoleBinding of the daemon SA to the install's tokenreview ClusterRole. */
export async function ensureTokenReviewClusterRoleBinding(ctx: ReconcileContext, org: AgentConnectOrg): Promise<void> {
  // TODO(operator): cluster-scoped object — no namespace ownerReference; the CR finalizer must delete it explicitly.
  void ctx
  void org
}

/** Two-layer NetworkPolicies: sandbox egress (proxy + git only) and daemon egress (CP/relay/platforms + apiserver + DNS). */
export async function ensureNetworkPolicies(ctx: ReconcileContext, org: AgentConnectOrg): Promise<void> {
  // TODO(operator): render both layers; the apiserver egress rule is CNI-dependent (see the design doc).
  void ctx
  void org
}

/** ResourceQuota/LimitRange from spec.quota; zero values mean unlimited. */
export async function ensureQuotaAndLimitRange(ctx: ReconcileContext, org: AgentConnectOrg): Promise<void> {
  // TODO(operator): translate spec.quota; omit objects entirely when everything is unlimited.
  void ctx
  void org
}

/** Stamp per-org SandboxTemplate + one SandboxWarmPool per runtime tier from the cluster master templates. */
export async function ensureSandboxTemplates(ctx: ReconcileContext, org: AgentConnectOrg): Promise<void> {
  // TODO(operator): copy the masters into the org namespace; warmReplicas comes from spec.runtime.tiers.
  void ctx
  void org
}

/** The daemon's ReadWriteOncePod PVC (transcripts + state). */
export async function ensureDaemonPvc(ctx: ReconcileContext, org: AgentConnectOrg): Promise<void> {
  // TODO(operator): RWOP is load-bearing — the Recreate strategy assumes no double-attach.
  void ctx
  void org
}

/** Daemon Deployment: strategy Recreate, required (non-optional) credential Secret volume, credentialRevision annotation. */
export async function ensureDaemonDeployment(ctx: ReconcileContext, org: AgentConnectOrg): Promise<void> {
  // TODO(operator): kubelet gates startup on the Secret mount; the operator itself never reads Secrets.
  void ctx
  void org
}

/** Daemon Service for relay ingress and shim dial-in. */
export async function ensureDaemonService(ctx: ReconcileContext, org: AgentConnectOrg): Promise<void> {
  // TODO(operator): plain ClusterIP service selecting the daemon pod.
  void ctx
  void org
}

/** The full envelope inventory in its policy-before-workload order (see the operator design doc). */
export async function reconcileEnvelope(ctx: ReconcileContext, org: AgentConnectOrg): Promise<void> {
  await ensureNamespace(ctx, org)
  await ensureServiceAccounts(ctx, org)
  await ensureRoleAndBinding(ctx, org)
  await ensureTokenReviewClusterRoleBinding(ctx, org)
  await ensureNetworkPolicies(ctx, org)
  await ensureQuotaAndLimitRange(ctx, org)
  await ensureSandboxTemplates(ctx, org)
  await ensureDaemonPvc(ctx, org)
  await ensureDaemonDeployment(ctx, org)
  await ensureDaemonService(ctx, org)
}
