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
import { DaemonId, type OrgId } from '../domain/ids.js'
import { buildDaemonConfigJson } from './credential.js'
import type { OrgSecretApi } from './secret-api.js'
import type {
  ClusterExecutionDefaults,
  ClusterExecutionPatch,
  ClusterExecutionSettings,
  OrgClusterExecutionRepo,
  OrgRepo
} from '../persistence/ports.js'
import { DEFAULT_CREDENTIAL_SECRET_NAME } from './crd.js'
import type { OrgResourceApi } from './org-api.js'
import {
  ABSENT_ENVELOPE,
  buildSpec,
  orgNamespace,
  orgResourceName,
  projectStatus,
  type ClusterEnvelopeStatus
} from './spec.js'

/** Bounded re-apply passes; each concurrent writer runs its own, so this only
 *  has to outlast a burst, not an unbounded stream of edits. */
const CONVERGE_ATTEMPTS = 5

/** Tombstones retired per drain pass; a backlog is rare and drains over passes. */
const TEARDOWN_BATCH = 50

/** Deployment policy for an org's first enable; the stored row owns it after that. */
export interface ClusterExecutionPolicy {
  /** Install-time constant shared with the operator's `AC_ORG_NAMESPACE_PREFIX`. */
  namespacePrefix: string
  daemonImage: string
  runtimeImage: string
  daemonTier: string
  runtimeTiers: { name: string; warmReplicas: number }[]
  /** The daemon WebSocket URL written into every envelope's `config.json`. */
  controlPlaneUrl: string
}

/** What a caller learns about a credential — never the key itself. */
export interface ClusterCredentialView {
  daemonId: string
  secretName: string
  revision: string
  /** True when this call replaced an earlier credential (and revoked its key). */
  rotated: boolean
}

/** The `ApiKeyAdmin` slice the key authority uses. */
export interface ClusterKeyAuthority {
  provisionDaemon(opts: { orgId: string; createdByUserId?: string }): Promise<{
    daemonId: string
    apiKeyId: string
    token: string
  }>
  mintForDaemon(
    orgId: OrgId,
    daemonId: DaemonId,
    opts?: { createdByUserId?: string }
  ): Promise<{ apiKeyId: string; token: string }>
  revoke(apiKeyId: string, reason: string): Promise<unknown>
}

/** Raised when the envelope has no settings row to attach a credential to. */
export class ClusterNotEnabledError extends Error {
  constructor() {
    super('cluster execution is not enabled for this organization')
    this.name = 'ClusterNotEnabledError'
  }
}

export class ClusterExecutionService {
  constructor(
    private readonly repo: OrgClusterExecutionRepo,
    private readonly api: OrgResourceApi,
    /** Only the slug is read — the CR's `displayName` is display-only. */
    private readonly orgs: Pick<OrgRepo, 'slugById'>,
    private readonly policy: ClusterExecutionPolicy,
    private readonly secrets: OrgSecretApi,
    private readonly keys: ClusterKeyAuthority
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
   * Persist the patch, then make the cluster match the LATEST durable row:
   * enabled ⇒ apply the spec, disabled ⇒ delete the resource and let the
   * operator's finalizer drain the envelope. The database write lands first so
   * a cluster that is briefly unreachable leaves a retryable intent rather than
   * a lost edit; the returned settings are the ones actually applied, which
   * under concurrency may include a peer's newer edit.
   */
  async configure(orgId: OrgId, patch: ClusterExecutionPatch): Promise<ClusterExecutionSettings> {
    await this.repo.upsert(orgId, this.defaults(orgId), patch)
    const settings = await this.converge(orgId)
    // Switching cluster execution off deletes the envelope, so the credential it
    // published stops being a credential and becomes a live key with nothing
    // watching it. Retire it here rather than leave it valid indefinitely; the
    // daemon row stays, since removing one is the Daemons page's job (it unplaces
    // agents and repoints collaboration routes) and this is not that.
    if (patch.enabled === false && settings.credentialApiKeyId) {
      await this.repo.setCredential(orgId, null)
      await this.keys.revoke(settings.credentialApiKeyId, 'cluster execution disabled')
      return this.settings(orgId)
    }
    return settings
  }

  /**
   * Apply the current row, then confirm it is still current — the fence against
   * two concurrent writers reverting each other. Without it, A-upsert →
   * B-upsert → B-apply → A-apply leaves the row at B and the resource
   * permanently at A: the operator reconciles the CR, not the row, and nothing
   * here re-reads on a timer, so that divergence would never heal.
   *
   * Every writer runs this loop, so a request that gives up at the attempt
   * ceiling is one whose value was superseded — and the writer that superseded
   * it is itself converging on the newer row.
   */
  private async converge(orgId: OrgId): Promise<ClusterExecutionSettings> {
    let current = await this.repo.get(orgId)
    if (!current) return this.unconfigured(orgId) // the org was deleted under us
    for (let attempt = 0; attempt < CONVERGE_ATTEMPTS; attempt += 1) {
      await this.reconcile(current)
      const after = await this.repo.get(orgId)
      // The row vanished between apply and re-read: the organization was deleted
      // mid-flight, so this request has just created a resource whose owner no
      // longer exists — and the deletion's tombstone was written before it. Undo
      // it here rather than leave the operator holding an ownerless envelope.
      if (!after) {
        await this.api.delete(orgResourceName(current.targetNamespace))
        return this.unconfigured(orgId)
      }
      if (after.specRevision === current.specRevision) return current
      current = after
    }
    return current
  }

  /** Apply one snapshot of the org's settings to the cluster. */
  async reconcile(settings: ClusterExecutionSettings): Promise<void> {
    const name = orgResourceName(settings.targetNamespace)
    if (!settings.enabled) return this.api.delete(name)
    // `displayName` is display-only on the CR, so the slug (always present) is
    // enough and costs one indexed read instead of a whole org projection.
    const slug = await this.orgs.slugById(settings.orgId)
    await this.api.apply(name, buildSpec(settings, slug ?? undefined))
  }

  /**
   * Delete the resources of organizations that are already gone, then drop
   * their tombstones. The tombstone is written inside the org's delete
   * transaction because the cascade removes the only record of the immutable
   * `targetNamespace` — after that, nothing else could name the namespace,
   * daemon, and sandboxes the operator is still keeping alive.
   *
   * Best-effort per row and safe to run at any time: a resource that is already
   * gone reads as deleted, and a row whose delete fails simply stays for the
   * next pass. Returns how many envelopes it retired.
   */
  async drainTeardowns(limit = TEARDOWN_BATCH): Promise<number> {
    const pending = await this.repo.listPendingTeardowns(limit)
    let retired = 0
    for (const entry of pending) {
      await this.api.delete(orgResourceName(entry.targetNamespace))
      await this.repo.clearPendingTeardown(entry.orgId)
      retired += 1
    }
    return retired
  }

  /**
   * Issue — or rotate — the org's daemon credential. The control plane is the
   * key authority for the whole envelope: it mints the key, publishes it as the
   * Secret the CRD names, and bumps `credentialRevision` so the operator
   * projects a new pod-template annotation and forces a Recreate. The operator
   * itself has no Secret verbs anywhere and never sees any of this.
   *
   * Order matters and is deliberate. The Secret is written BEFORE the revision
   * bump, so a failure leaves the running pod on its old, still-valid key rather
   * than rolling it onto a credential that was never published. The previous key
   * is revoked LAST, after the rollout has been asked for, so the window where
   * no valid key exists is empty.
   *
   * The daemon identity is created once and reused, so a rotation does not
   * orphan the org's sessions, agents, and history under a new daemon row.
   */
  async issueCredential(orgId: OrgId, actorUserId?: string): Promise<ClusterCredentialView> {
    const settings = await this.repo.get(orgId)
    if (!settings) throw new ClusterNotEnabledError()

    const previousApiKeyId = settings.credentialApiKeyId
    const minted = settings.credentialDaemonId
      ? {
          daemonId: settings.credentialDaemonId,
          ...(await this.keys.mintForDaemon(orgId, DaemonId(settings.credentialDaemonId), {
            ...(actorUserId ? { createdByUserId: actorUserId } : {})
          }))
        }
      : await this.keys.provisionDaemon({ orgId, ...(actorUserId ? { createdByUserId: actorUserId } : {}) })

    await this.secrets.applyCredential(
      settings.targetNamespace,
      settings.credentialSecretName,
      buildDaemonConfigJson({
        controlPlaneUrl: this.policy.controlPlaneUrl,
        apiKey: minted.token,
        daemonId: minted.daemonId
      })
    )

    // The api-key id is already a unique, opaque, traceable handle for exactly
    // this credential — which is what `credentialRevision` is defined to be.
    await this.repo.setCredential(orgId, {
      daemonId: minted.daemonId,
      apiKeyId: minted.apiKeyId,
      revision: minted.apiKeyId
    })
    await this.converge(orgId)

    if (previousApiKeyId) await this.keys.revoke(previousApiKeyId, 'cluster credential rotated')
    return {
      daemonId: minted.daemonId,
      secretName: settings.credentialSecretName,
      revision: minted.apiKeyId,
      rotated: previousApiKeyId !== undefined
    }
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
    return { orgId, enabled: false, specRevision: 0, suspend: false, ...defaults, createdAt: epoch, updatedAt: epoch }
  }
}
