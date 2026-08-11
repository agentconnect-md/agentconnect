/**
 * The cluster provisioner: the control plane's writer for `AgentConnectOrg`
 * (docs/designs/agentconnect-org-operator.md §1). Stored settings are the
 * desired state; every write reconciles outward by applying the projected spec,
 * and every read of envelope health goes to the resource itself. Self-hosted
 * cluster mode and a hosted deployment run this same path — only the policy
 * inputs (the defaults below) differ.
 *
 * Nothing here reconciles on a timer: the operator is level-triggered and
 * re-reads the CR on its own resync, so the control plane only has to make the
 * spec true at the moment it changes.
 */
import type { OrgId } from '../domain/ids.js'
import type {
  ClusterExecutionDefaults,
  ClusterExecutionPatch,
  ClusterExecutionSettings,
  OrgClusterExecutionRepo,
  OrgRepo
} from '../persistence/ports.js'
import { DEFAULT_CREDENTIAL_SECRET_NAME } from './crd.js'
import type { AgentConnectOrgApi } from './org-api.js'
import {
  ABSENT_ENVELOPE,
  buildSpec,
  orgNamespace,
  orgResourceName,
  projectStatus,
  type ClusterEnvelopeStatus
} from './spec.js'

/** Deployment policy for an org's first enable; the stored row owns it after that. */
export interface ClusterExecutionPolicy {
  /** Install-time constant shared with the operator's `AC_ORG_NAMESPACE_PREFIX`. */
  namespacePrefix: string
  daemonImage: string
  runtimeImage: string
  daemonTier: string
  runtimeTiers: { name: string; warmReplicas: number }[]
}

export class ClusterExecutionService {
  constructor(
    private readonly repo: OrgClusterExecutionRepo,
    private readonly api: AgentConnectOrgApi,
    private readonly orgs: OrgRepo,
    private readonly policy: ClusterExecutionPolicy
  ) {}

  /** The control namespace this deployment provisions into — surfaced for operators. */
  get controlNamespace(): string {
    return this.api.namespace
  }

  /** Settings as configured, or the deployment defaults when the org never enabled. */
  async settings(orgId: OrgId): Promise<ClusterExecutionSettings> {
    return (await this.repo.get(orgId)) ?? this.unconfigured(orgId)
  }

  /**
   * Persist the patch, then make the cluster match: enabled ⇒ apply the spec,
   * disabled ⇒ delete the resource and let the operator's finalizer drain the
   * envelope. The database write lands first so a cluster that is briefly
   * unreachable leaves a retryable intent rather than a lost edit.
   */
  async configure(orgId: OrgId, patch: ClusterExecutionPatch): Promise<ClusterExecutionSettings> {
    const settings = await this.repo.upsert(orgId, this.defaults(orgId), patch)
    await this.reconcile(settings)
    return settings
  }

  /** Apply the org's current settings to the cluster; a no-op when never configured. */
  async reconcile(settings: ClusterExecutionSettings): Promise<void> {
    const name = orgResourceName(settings.targetNamespace)
    if (!settings.enabled) return this.api.delete(name)
    // `displayName` is display-only on the CR, so the slug (always present) is
    // enough and costs one indexed read instead of a whole org projection.
    const slug = await this.orgs.slugById(settings.orgId)
    await this.api.apply(name, buildSpec(settings, slug ?? undefined))
  }

  /** Live envelope status from the resource; absent ⇒ `present: false`. */
  async status(orgId: OrgId): Promise<ClusterEnvelopeStatus> {
    const settings = await this.repo.get(orgId)
    if (!settings) return ABSENT_ENVELOPE
    const resource = await this.api.get(orgResourceName(settings.targetNamespace))
    return resource ? projectStatus(resource.status) : ABSENT_ENVELOPE
  }

  private defaults(orgId: OrgId): ClusterExecutionDefaults {
    return {
      targetNamespace: orgNamespace(this.policy.namespacePrefix, orgId),
      daemonImage: this.policy.daemonImage,
      daemonTier: this.policy.daemonTier,
      credentialSecretName: DEFAULT_CREDENTIAL_SECRET_NAME,
      runtimeImage: this.policy.runtimeImage,
      runtimeTiers: this.policy.runtimeTiers,
      quota: { maxAgents: 0, cpu: '0', memory: '0', storage: '0' },
      egressPolicy: 'curated'
    }
  }

  /** What the console shows before the first write: the defaults, switched off. */
  private unconfigured(orgId: OrgId): ClusterExecutionSettings {
    const defaults = this.defaults(orgId)
    const epoch = new Date(0)
    return { orgId, enabled: false, suspend: false, ...defaults, createdAt: epoch, updatedAt: epoch }
  }
}
