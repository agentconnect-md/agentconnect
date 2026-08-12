/**
 * The cluster provisioner: the control plane's writer for `AgentConnectOrg`
 * (docs/designs/agentconnect-org-operator.md §1). Stored settings are the
 * desired state; every write reconciles outward by applying the projected spec,
 * and every read of envelope health goes to the resource itself. Self-hosted
 * cluster mode and a hosted deployment run this same path — only the policy
 * inputs (the defaults below) differ.
 *
 * It writes exactly ONE object per org and delivers nothing else: an in-cluster
 * daemon authenticates with the token the kubelet projects into its pod, so
 * there is no key to mint, publish, roll out or revoke here.
 *
 * Nothing here re-applies the spec on a timer: the operator is level-triggered
 * and re-reads the CR on its own resync, so the control plane only has to make
 * the spec true at the moment it changes. The periodic work it does own is
 * cleanup it may still owe after a request returned — see the drain below.
 */
import { randomUUID } from 'node:crypto'
import { OrgId } from '../domain/ids.js'
import type { Clock } from '../domain/clock.js'
import type {
  ClusterExecutionDefaults,
  ClusterExecutionPatch,
  ClusterExecutionSettings,
  DaemonRepo,
  OrgClusterExecutionRepo,
  OrgRepo
} from '../persistence/ports.js'
import type { OrgResourceApi } from './org-api.js'
import { ABSENT_ENVELOPE, buildSpec, orgResourceName, projectStatus, type ClusterEnvelopeStatus } from './spec.js'

/** Bounded re-apply passes; each concurrent writer runs its own, so this only
 *  has to outlast a burst, not an unbounded stream of edits. */
const CONVERGE_ATTEMPTS = 5

/** Tombstones retired per drain pass; a backlog is rare and drains over passes. */
const TEARDOWN_BATCH = 50

/** How long one caller may own an envelope transition before it is taken over.
 *  Generous against a slow API server, short enough that a crashed process does
 *  not lock an operator out of switching the envelope on or off for long. */
const TRANSITION_LEASE_MS = 2 * 60 * 1000

/** Deployment policy for an org's first enable; the stored row owns it after that. */
export interface ClusterExecutionPolicy {
  /** Install-time constant shared with the operator's `AC_ORG_NAMESPACE_PREFIX`. */
  namespacePrefix: string
  daemonImage: string
  runtimeImage: string
  daemonTier: string
  runtimeTiers: { name: string; warmReplicas: number }[]
  /** This control plane's own daemon WebSocket URL, written onto every envelope's CR —
   *  the address the daemon pod dials, in plain text because a URL is not a secret. */
  controlPlaneUrl: string
}

/** Raised when another caller already owns the org's envelope transition. */
export class ClusterTransitionInProgressError extends Error {
  constructor() {
    super('an envelope transition is already in progress for this organization')
    this.name = 'ClusterTransitionInProgressError'
  }
}

export class ClusterExecutionService {
  constructor(
    private readonly repo: OrgClusterExecutionRepo,
    private readonly api: OrgResourceApi,
    /** Only the slug is read — the CR's `displayName` is display-only. */
    private readonly orgs: Pick<OrgRepo, 'slugById'>,
    private readonly policy: ClusterExecutionPolicy,
    /** Names the envelope's own daemon; see {@link ClusterExecutionService.envelopeDaemonIds}. */
    private readonly daemons: Pick<DaemonRepo, 'clusterBoundIds'>,
    /** Drives the transition lease; the same seam every other timed CP path uses. */
    private readonly clock: Clock
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
    // Enabling and disabling both take the exclusive claim: they create and
    // destroy the envelope, and the teardown drain acts on the same row.
    if (patch.enabled === false) return this.disable(orgId, patch)
    if (patch.enabled === true) return this.enable(orgId, patch)
    await this.repo.upsert(orgId, this.defaults(orgId), patch)
    return this.converge(orgId)
  }

  /**
   * Make an organization's envelope exist, idempotently: the provisioning path
   * for an org that was never configured, and the self-heal for one whose CR
   * went missing. Called when an organization is created and again whenever the
   * console opens its Daemons page, so an org that predates this deployment —
   * or one minted outside `POST /orgs` (a JIT personal org, a waitlist redeem) —
   * converges on its first visit rather than needing an owner to find a toggle.
   *
   * It never overrides a decision: only an org with NO settings row is switched
   * on, so an owner who deliberately disabled cluster execution keeps a row that
   * reads disabled and nothing here resurrects it. An org that IS enabled gets
   * its spec re-applied, which creates the CR when it is gone.
   *
   * Returning is the whole completion signal, and can be, because the CR is the
   * only thing this delivers: a pass either applies it or throws. Nothing is
   * owed afterwards — the envelope's daemon presents its own projected token
   * when the pod comes up, with no second interaction for the caller to come
   * back and finish.
   */
  async ensureProvisioned(orgId: OrgId): Promise<ClusterExecutionSettings> {
    const existing = await this.repo.get(orgId)
    // A row that reads disabled is a decision, not a gap: an owner switched this
    // org off (or is tearing it down), and re-applying would undo that.
    if (existing && !existing.enabled) return existing
    // No row at all ⇒ never configured, so provisioning is the deployment's
    // default rather than a reversal of anyone's choice.
    return existing ? this.converge(orgId) : this.enable(orgId, { enabled: true })
  }

  /**
   * Switching cluster execution on. It takes the same claim the teardown drain
   * does, and holds it while it cancels a previous disable's tombstone AND
   * applies the resource — otherwise a drain that had already listed that
   * tombstone could delete the resource this call just created, leaving an
   * `enabled: true` row with no envelope and nothing to notice.
   */
  private async enable(orgId: OrgId, patch: ClusterExecutionPatch): Promise<ClusterExecutionSettings> {
    // The claim comes FIRST, before `enabled` moves: a row flipped outside the
    // claim is a state change a concurrent disable or drain never saw.
    // `beginTransition` needs a row to claim, so an org that has never
    // configured anything gets a disabled defaults row and is enabled under the
    // claim. Insert-only: two first-enable calls both see no row, and the one
    // that loses must leave the winner's row exactly as the winner claimed it.
    await this.repo.createIfAbsent(orgId, this.defaults(orgId))
    const token = randomUUID()
    const claimed = await this.repo.beginTransition(orgId, token, new Date(this.clock.now()), TRANSITION_LEASE_MS)
    if (!claimed) {
      // No row at all ⇒ the organization was deleted under this request; there
      // is nothing to own and nothing to apply.
      if (!(await this.repo.get(orgId))) return this.unconfigured(orgId)
      throw new ClusterTransitionInProgressError()
    }
    try {
      await this.repo.upsert(orgId, this.defaults(orgId), patch)
      await this.repo.clearPendingTeardown(orgId)
      return await this.converge(orgId)
    } finally {
      await this.repo.endTransition(orgId, token)
    }
  }

  /**
   * Switching cluster execution off. Everything durable happens FIRST and in one
   * transaction — the row is flipped and the resource is recorded for teardown —
   * so a cluster that refuses the delete leaves state that converges through
   * maintenance rather than an `enabled: false` row beside a live envelope.
   *
   * The daemon row itself stays: removing one unplaces agents and repoints
   * collaboration routes, which is the Daemons page's job and not this one's.
   */
  private async disable(orgId: OrgId, patch: ClusterExecutionPatch): Promise<ClusterExecutionSettings> {
    // The row must not be written before the claim is held: an upsert that flips
    // `enabled` while an enable owns the transition would leave a disabled row
    // beside a resource that enable is still applying. `disableAndRecordTeardown`
    // is what flips it, under the claim, so ownership and the state change are one step.
    const token = randomUUID()
    const claimed = await this.repo.beginTransition(orgId, token, new Date(this.clock.now()), TRANSITION_LEASE_MS)
    if (!claimed) {
      if (!(await this.repo.get(orgId))) return this.unconfigured(orgId)
      throw new ClusterTransitionInProgressError()
    }
    try {
      const { enabled: _dropped, ...rest } = patch
      if (Object.keys(rest).length > 0) await this.repo.upsert(orgId, this.defaults(orgId), rest)
      await this.repo.disableAndRecordTeardown(orgId, token)
      // Directly, not through the drain: this call already owns the claim the
      // drain would try to take.
      await this.deleteEnvelopeResource(orgId, claimed.resourceName)
    } finally {
      await this.repo.endTransition(orgId, token)
    }
    return this.settings(orgId)
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
        await this.api.delete(current.resourceName)
        return this.unconfigured(orgId)
      }
      if (after.specRevision === current.specRevision) return current
      current = after
    }
    return current
  }

  /** Apply one snapshot of the org's settings to the cluster. */
  async reconcile(settings: ClusterExecutionSettings): Promise<void> {
    const name = settings.resourceName
    if (!settings.enabled) return this.api.delete(name)
    // `displayName` is display-only on the CR, so the slug (always present) is
    // enough and costs one indexed read instead of a whole org projection.
    const slug = await this.orgs.slugById(settings.orgId)
    await this.api.apply(name, buildSpec(settings, this.policy.controlPlaneUrl, slug ?? undefined))
  }

  /**
   * Delete the resources of organizations that are already gone, then drop
   * their tombstones. The tombstone is written inside the org's delete
   * transaction because the cascade removes the only record of the envelope's
   * `resourceName` — after that, nothing else could name the namespace, daemon,
   * and sandboxes the operator is still keeping alive.
   *
   * Best-effort per row and safe to run at any time: a resource that is already
   * gone reads as deleted, and a row whose delete fails simply stays for the
   * next pass. Returns how many envelopes it retired.
   */
  async drainTeardowns(limit = TEARDOWN_BATCH): Promise<number> {
    const pending = await this.repo.listPendingTeardowns(limit)
    let retired = 0
    for (const entry of pending) {
      const retiredOne = await this.retireEnvelope(OrgId(entry.orgId), entry.resourceName)
      if (retiredOne) retired += 1
    }
    return retired
  }

  /**
   * Delete one org's resource under the same exclusive claim every other
   * transition takes. The claim is the fence against the listing going stale: a
   * re-enable holds it while it clears the tombstone and applies the CR, so a
   * drain that listed the entry beforehand cannot delete the resource the
   * re-enable just created. An org whose row is gone (deleted) has no claim to
   * take and no re-enable to race, so it is deleted directly.
   */
  private async retireEnvelope(orgId: OrgId, resourceName: string): Promise<boolean> {
    const row = await this.repo.get(orgId)
    let token: string | undefined
    if (row) {
      token = randomUUID()
      const claimed = await this.repo.beginTransition(orgId, token, new Date(this.clock.now()), TRANSITION_LEASE_MS)
      if (!claimed) return false // someone owns this org right now; next pass
      // Re-read under the claim: a re-enable that finished before we got here
      // already cleared the tombstone, and this entry is stale.
      if (claimed.enabled) {
        await this.repo.endTransition(orgId, token)
        return false
      }
    }
    try {
      return await this.deleteEnvelopeResource(orgId, resourceName)
    } finally {
      if (token) await this.repo.endTransition(orgId, token)
    }
  }

  /**
   * Delete the resource and drop its tombstone. The caller owns the claim — but
   * a claim cannot fence a request already in flight, so the delete carries the
   * read object's `uid`/`resourceVersion`: a re-enable that applied a new
   * generation in the meantime makes the API server reject it rather than
   * removing what the re-enable just created.
   */
  private async deleteEnvelopeResource(orgId: OrgId, name: string): Promise<boolean> {
    try {
      const existing = await this.api.get(name)
      if (existing) {
        await this.api.delete(name, {
          ...(existing.metadata?.uid ? { uid: existing.metadata.uid } : {}),
          ...(existing.metadata?.resourceVersion ? { resourceVersion: existing.metadata.resourceVersion } : {})
        })
      }
    } catch {
      return false // still owed; the maintenance loop retries
    }
    await this.repo.clearPendingTeardown(orgId)
    return true
  }

  /**
   * The daemon records this organization's envelope owns — the ones the control
   * plane provisioned itself, which no Daemons page could be asked to detach and
   * which therefore must not make an organization undeletable.
   *
   * The authority is the identity binding: a daemon that authenticated with a
   * projected token carries one, and a human-attached machine never does. An
   * envelope provisioned under the retired key path has no binding until its pod
   * reconnects and adopts its record, so that record is named here too — the
   * same pointer the token path adopts, read for the same reason.
   */
  async envelopeDaemonIds(orgId: OrgId): Promise<string[]> {
    const bound = await this.daemons.clusterBoundIds(orgId)
    const legacy = (await this.repo.get(orgId))?.legacyKeyDaemonId
    return legacy && !bound.includes(legacy) ? [...bound, legacy] : bound
  }

  /** Live envelope status from the resource; absent ⇒ `present: false`. */
  async status(orgId: OrgId): Promise<ClusterEnvelopeStatus> {
    const settings = await this.repo.get(orgId)
    if (!settings) return ABSENT_ENVELOPE
    const resource = await this.api.get(settings.resourceName)
    return resource ? projectStatus(resource.status) : ABSENT_ENVELOPE
  }

  private defaults(orgId: OrgId): ClusterExecutionDefaults {
    return {
      resourceName: orgResourceName(this.policy.namespacePrefix, orgId),
      daemonImage: this.policy.daemonImage,
      daemonTier: this.policy.daemonTier,
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
    return {
      orgId,
      enabled: false,
      specRevision: 0,
      suspend: false,
      ...defaults,
      createdAt: epoch,
      updatedAt: epoch
    }
  }
}
