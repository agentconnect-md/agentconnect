/**
 * The cluster provisioner: the control plane's writer for `AgentConnectOrg`
 * (docs/designs/agentconnect-org-operator.md §1). Stored settings are the
 * desired state; every write reconciles outward by applying the projected spec,
 * and every read of envelope health goes to the resource itself. Self-hosted
 * cluster mode and a hosted deployment run this same path — only the policy
 * inputs (the defaults below) differ.
 *
 * Nothing here re-applies the spec on a timer: the operator is level-triggered
 * and re-reads the CR on its own resync, so the control plane only has to make
 * the spec true at the moment it changes. The periodic work it does own is
 * cleanup it may still owe after a request returned — see the drains below.
 */
import { randomUUID } from 'node:crypto'
import { DaemonId, OrgId } from '../domain/ids.js'
import type { Clock } from '../domain/clock.js'
import { buildDaemonConfigJson } from './credential.js'
import { NamespaceNotReadyError, StaleCredentialWriteError, type OrgSecretApi } from './secret-api.js'
import type {
  ClusterExecutionDefaults,
  ClusterExecutionPatch,
  ClusterExecutionSettings,
  OrgClusterExecutionRepo,
  OrgRepo
} from '../persistence/ports.js'
import { DEFAULT_CREDENTIAL_SECRET_NAME } from './crd.js'
import type { OrgResourceApi } from './org-api.js'
import { ABSENT_ENVELOPE, buildSpec, orgResourceName, projectStatus, type ClusterEnvelopeStatus } from './spec.js'

/** Bounded re-apply passes; each concurrent writer runs its own, so this only
 *  has to outlast a burst, not an unbounded stream of edits. */
const CONVERGE_ATTEMPTS = 5

/** Tombstones retired per drain pass; a backlog is rare and drains over passes. */
const TEARDOWN_BATCH = 50

/** Owed revocations attempted per drain pass. */
const REVOCATION_BATCH = 50

/** Owed credential rollouts re-applied per drain pass. */
const ROLLOUT_BATCH = 50

/** How long one caller may own a credential transition before it is taken over.
 *  Generous against a slow API server, short enough that a crashed process does
 *  not lock an operator out of rotating for long. */
const ROTATION_LEASE_MS = 2 * 60 * 1000

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

/**
 * The outcome of one `ensureProvisioned` pass. `settled: false` means the
 * envelope still owes work this pass could not do — the operator has not
 * published the namespace yet, or a peer owns the credential transition — and
 * the caller is expected to ask again. It is a separate field because no
 * settings value carries that meaning: `credentialRevision` is populated
 * throughout a staged-key recovery, so reading it as completion would settle an
 * org whose rotation never finished.
 */
export interface EnsuredEnvelope {
  settings: ClusterExecutionSettings
  settled: boolean
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

/** Raised when the org has no ENABLED envelope to attach a credential to. */
export class ClusterNotEnabledError extends Error {
  constructor() {
    super('cluster execution is not enabled for this organization')
    this.name = 'ClusterNotEnabledError'
  }
}

/** Raised when another caller already owns the org's credential transition. */
export class ClusterRotationInProgressError extends Error {
  constructor() {
    super('a credential rotation is already in progress for this organization')
    this.name = 'ClusterRotationInProgressError'
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
    private readonly keys: ClusterKeyAuthority,
    /** Drives the rotation lease; the same seam every other timed CP path uses. */
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
    // Disabling destroys the envelope, so it takes the same exclusive claim a
    // rotation does: otherwise a rotation already in flight could publish and
    // commit a key moments after the credential was supposed to be retired.
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
   * its spec re-applied (which creates the CR when it is gone) and, once the
   * operator has published the envelope namespace, a credential — issued, or
   * REISSUED when the cluster no longer holds one.
   *
   * Best-effort by construction: the caller is a page load or an org create, so
   * a namespace that is not ready yet or a peer already rotating is the ordinary
   * "not this pass" answer and leaves the work to the next visit.
   *
   * Which is why `settled` is answered EXPLICITLY rather than left for a caller
   * to infer from the settings. No field on the row carries that meaning: a
   * `credentialRevision` is present all through a staged-key recovery, and a
   * console that read it as completion would cache the org and never come back
   * after the peer released its claim — breaking the next-visit convergence this
   * whole path rests on. `settled: false` means something is still owed and the
   * caller is expected to ask again.
   */
  async ensureProvisioned(orgId: OrgId, actorUserId?: string): Promise<EnsuredEnvelope> {
    const existing = await this.repo.get(orgId)
    // A row that reads disabled is a decision, not a gap: an owner switched this
    // org off (or is tearing it down), and re-applying would undo that. Nothing
    // is owed on a decision, so it is settled.
    if (existing && !existing.enabled) return { settings: existing, settled: true }
    // No row at all ⇒ never configured, so provisioning is the deployment's
    // default rather than a reversal of anyone's choice.
    const settings = existing ? await this.converge(orgId) : await this.enable(orgId, { enabled: true })
    if (!settings.enabled) return { settings, settled: true }
    if (await this.credentialPublished(settings)) return { settings, settled: true }
    try {
      await this.issueCredential(orgId, actorUserId)
    } catch (error) {
      // The namespace the operator has not created yet, and a peer that owns the
      // transition, are both "come back later" — everything else is a real fault.
      if (!(error instanceof NamespaceNotReadyError) && !(error instanceof ClusterRotationInProgressError)) throw error
      return { settings, settled: false }
    }
    return { settings: await this.settings(orgId), settled: true }
  }

  /**
   * Is this org's credential BOTH settled in the database and present in the
   * cluster? Two different half-states hide behind a stored revision, and only
   * the pair of checks below tells them apart from a finished credential.
   *
   * The row alone is not proof the Secret exists: deleting a CR hands the
   * envelope to the operator's finalizer, which removes the namespace and the
   * Secret inside it, so a pass that recreated the CR and then trusted the
   * revision would leave the new daemon pod blocked forever on a Secret nobody
   * was ever going to write. A namespace that has not been published or created
   * yet reads as absent too, and the issue that follows answers
   * `NamespaceNotReady` — the ordinary "come back later", not a re-key.
   *
   * And a Secret is not proof the row is settled: a publish whose response was
   * lost still landed, so `issueCredential` deliberately leaves that key STAGED
   * and its predecessor live rather than revoking a credential the pod may be
   * holding. Recovery is a successor claim that publishes, commits, and retires
   * both — and nothing here runs on a timer, so a pass that called that state
   * complete would strand it forever: the key the Secret carries uncommitted,
   * the one the row names never retired. A staged key therefore reads as
   * incomplete whatever the cluster says. (A committed revision whose CR apply
   * is still owed is a different case, already drained by the maintenance loop —
   * and this pass has re-applied it through `converge` on the way here.)
   */
  private async credentialPublished(settings: ClusterExecutionSettings): Promise<boolean> {
    if (!settings.credentialRevision || settings.credentialStagedApiKeyId) return false
    const namespace = (await this.api.get(settings.resourceName))?.status?.namespace
    if (!namespace) return false
    return (await this.secrets.publishedSeq(namespace, settings.credentialSecretName)) > 0
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
    // `beginCredentialRotation` needs a row to claim, so an org that has never
    // configured anything gets a disabled defaults row and is enabled under the
    // claim. Insert-only: two first-enable calls both see no row, and the one
    // that loses must leave the winner's row exactly as the winner claimed it.
    await this.repo.createIfAbsent(orgId, this.defaults(orgId))
    const token = randomUUID()
    const claimed = await this.repo.beginCredentialRotation(orgId, token, new Date(this.clock.now()), ROTATION_LEASE_MS)
    if (!claimed) {
      // No row at all ⇒ the organization was deleted under this request; there
      // is nothing to own and nothing to apply.
      if (!(await this.repo.get(orgId))) return this.unconfigured(orgId)
      throw new ClusterRotationInProgressError()
    }
    try {
      await this.repo.upsert(orgId, this.defaults(orgId), patch)
      await this.repo.clearPendingTeardown(orgId)
      return await this.converge(orgId)
    } finally {
      await this.repo.endCredentialRotation(orgId, token)
    }
  }

  /**
   * Switching cluster execution off. Everything durable happens FIRST and in one
   * transaction — the credential is dropped, both its keys are queued for
   * revocation, and the resource is recorded for teardown — so a cluster that
   * refuses the delete leaves state that converges through maintenance rather
   * than a `enabled: false` row beside a live pod holding a live key.
   *
   * The daemon row itself stays: removing one unplaces agents and repoints
   * collaboration routes, which is the Daemons page's job and not this one's.
   */
  private async disable(orgId: OrgId, patch: ClusterExecutionPatch): Promise<ClusterExecutionSettings> {
    // The row must not be written before the claim is held: an upsert that flips
    // `enabled` while an issuer owns the transition would leave a disabled row
    // whose credential was never retired. `retireCredential` is what flips it,
    // under the claim, so ownership and the state change are one step.
    const token = randomUUID()
    const claimed = await this.repo.beginCredentialRotation(orgId, token, new Date(this.clock.now()), ROTATION_LEASE_MS)
    if (!claimed) {
      if (!(await this.repo.get(orgId))) return this.unconfigured(orgId)
      throw new ClusterRotationInProgressError()
    }
    try {
      const { enabled: _dropped, ...rest } = patch
      if (Object.keys(rest).length > 0) await this.repo.upsert(orgId, this.defaults(orgId), rest)
      await this.repo.retireCredential(orgId, token, 'cluster execution disabled')
      // Directly, not through the drain: this call already owns the claim the
      // drain would try to take.
      await this.deleteEnvelopeResource(orgId, claimed.resourceName)
      await this.drainKeyRevocations()
    } finally {
      await this.repo.endCredentialRotation(orgId, token)
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
    await this.api.apply(name, buildSpec(settings, slug ?? undefined))
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
      const claimed = await this.repo.beginCredentialRotation(
        orgId,
        token,
        new Date(this.clock.now()),
        ROTATION_LEASE_MS
      )
      if (!claimed) return false // someone owns this org right now; next pass
      // Re-read under the claim: a re-enable that finished before we got here
      // already cleared the tombstone, and this entry is stale.
      if (claimed.enabled) {
        await this.repo.endCredentialRotation(orgId, token)
        return false
      }
    }
    try {
      return await this.deleteEnvelopeResource(orgId, resourceName)
    } finally {
      if (token) await this.repo.endCredentialRotation(orgId, token)
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
   * Issue — or rotate — the org's daemon credential. The control plane is the
   * key authority for the whole envelope: it mints the key, publishes it as the
   * Secret the CRD names, and bumps `credentialRevision` so the operator
   * projects a new pod-template annotation and forces a Recreate. The operator
   * itself has no Secret verbs anywhere and never sees any of this.
   *
   * Daemon keys never expire, so the shape of this method is dictated by its
   * failure points rather than its happy path:
   *
   * - **One owner.** A fencing token claims the transition and EVERY subsequent
   *   write is conditional on it, so a holder whose lease expired cannot commit
   *   behind its successor or unlock it.
   * - **Staged before published.** The minted key is recorded before the Secret
   *   is written, so any failure or crash after that point leaves a durable
   *   handle the next claimer picks up.
   * - **Named before revocable.** A key that MAY be in the Secret is queued
   *   held: durably named, but not revocable until a higher-sequence publish has
   *   landed and asked for its rollout. Only a key that definitely never reached
   *   the cluster is revoked on the spot.
   * - **Committed atomically.** Promoting the staged key and queueing the one it
   *   supersedes happen in one transaction; separately, a stop in between would
   *   overwrite the only handle to the predecessor.
   * - **Secret before revision.** A failed publish leaves the running pod on its
   *   old, still-valid key rather than rolling it onto one that never existed.
   * - **Revoked last.** The predecessor dies only after the rollout is asked for.
   *
   * The daemon identity is created once and reused, so a rotation does not
   * orphan the org's sessions, agents, and history under a new daemon row.
   */
  async issueCredential(orgId: OrgId, actorUserId?: string): Promise<ClusterCredentialView> {
    // A disabled envelope has no resource and is being torn down; publishing a
    // fresh Secret into its dying namespace would silently undo the retirement
    // that disabling just performed.
    const current = await this.repo.get(orgId)
    if (!current?.enabled) throw new ClusterNotEnabledError()

    const token = randomUUID()
    const settings = await this.repo.beginCredentialRotation(
      orgId,
      token,
      new Date(this.clock.now()),
      ROTATION_LEASE_MS
    )
    if (!settings) throw new ClusterRotationInProgressError()
    try {
      // Read BEFORE minting: the namespace is the operator's to derive and publish,
      // so a pass that cannot learn it yet must not leave a key behind either.
      const namespace = await this.envelopeNamespace(settings)
      const previousApiKeyId = settings.credentialApiKeyId
      const minted = await this.mintFor(orgId, token, settings.credentialDaemonId, actorUserId)

      // Durable before the publish: from here on the key is recoverable by
      // whoever next claims the transition, whatever happens to this process.
      // Nothing has reached the cluster yet, so a key this pass can no longer
      // own is definitely not in the Secret and is revocable immediately.
      if (!(await this.repo.stageCredentialKey(orgId, token, minted.apiKeyId))) {
        throw await this.lostClaim(orgId, minted.apiKeyId, false)
      }
      try {
        await this.secrets.publishCredential(
          namespace,
          settings.credentialSecretName,
          settings.credentialRotationSeq,
          buildDaemonConfigJson({
            controlPlaneUrl: this.policy.controlPlaneUrl,
            apiKey: minted.token,
            daemonId: minted.daemonId
          })
        )
      } catch (error) {
        const landed = await this.publishLanded(namespace, settings, error)
        if (!landed) {
          // Definitely not published: clear the staged slot when this pass still
          // owns it, and queue the key either way — if the claim was taken over
          // the slot is the successor's, but the key is still this pass's to
          // retire. Enqueueing is idempotent, so adoption cannot double-queue it.
          await this.repo.abandonStagedCredential(orgId, token, 'cluster credential never published')
          await this.repo.enqueueKeyRevocation(orgId, minted.apiKeyId, 'cluster credential never published')
          await this.drainKeyRevocations()
        }
        // A newer rotation already published — this pass lost cluster-side, the
        // same verdict the database fence would have given it.
        if (error instanceof StaleCredentialWriteError) throw new ClusterRotationInProgressError()
        // Ambiguous or confirmed-published: the key stays staged and un-revoked,
        // because the pod may be holding it. The next claim adopts it, and by
        // then a higher-sequence publish has replaced it in the Secret.
        throw error
      }

      // The api-key id is already a unique, opaque, traceable handle for exactly
      // this credential — which is what `credentialRevision` is defined to be.
      const committed = await this.repo.commitCredential(
        orgId,
        token,
        { daemonId: minted.daemonId, apiKeyId: minted.apiKeyId, revision: minted.apiKeyId },
        'cluster credential rotated'
      )
      // The publish above succeeded, so this key IS in the Secret right now: name
      // it, but leave it to the successor's commit to release.
      if (!committed) throw await this.lostClaim(orgId, minted.apiKeyId, true)
      // Only now has the rollout actually been ASKED for: the CR carries the new
      // `credentialRevision`. A converge that throws leaves the obligation
      // recorded and every superseded key held, so the pod keeps a working
      // credential and the maintenance loop finishes the apply.
      await this.converge(orgId)
      await this.repo.completeCredentialRollout(orgId, token)
      await this.drainKeyRevocations()

      return {
        daemonId: minted.daemonId,
        secretName: settings.credentialSecretName,
        revision: minted.apiKeyId,
        rotated: previousApiKeyId !== undefined
      }
    } finally {
      await this.repo.endCredentialRotation(orgId, token)
    }
  }

  /**
   * Did the publish that threw actually commit? A write whose response was lost
   * to a dropped connection still lands, and revoking that key would leave the
   * daemon pod mounting a dead credential. Only a rejection this module raised
   * itself is unambiguous; anything else is settled by re-reading the Secret,
   * and a read that fails too is treated as "may have landed" — the safe answer,
   * since the cost of keeping a key alive one rotation longer is far lower than
   * the cost of killing a live one.
   */
  private async publishLanded(namespace: string, settings: ClusterExecutionSettings, error: unknown): Promise<boolean> {
    if (error instanceof NamespaceNotReadyError || error instanceof StaleCredentialWriteError) return false
    try {
      const published = await this.secrets.publishedSeq(namespace, settings.credentialSecretName)
      return published >= settings.credentialRotationSeq
    } catch {
      return true
    }
  }

  /** The lease expired and someone else owns the transition. The key this pass
   *  minted is no longer anyone's credential, so hand it to the revocation queue
   *  under the successor's ownership rather than dropping it on the floor —
   *  HELD when it may already be published, since the successor's commit is what
   *  proves a higher-sequence Secret has replaced it. */
  private async lostClaim(orgId: OrgId, apiKeyId: string, published: boolean): Promise<Error> {
    await this.repo.enqueueKeyRevocation(orgId, apiKeyId, 'cluster credential rotation superseded', published)
    await this.drainKeyRevocations() // settles whatever is eligible; held keys are not
    return new ClusterRotationInProgressError()
  }

  /**
   * A key for the org's daemon, creating that daemon on the first issue. The
   * new identity is recorded BEFORE anything can fail: a retry after a failed
   * publication must re-key the same daemon, not provision another one.
   */
  private async mintFor(
    orgId: OrgId,
    token: string,
    existingDaemonId: string | undefined,
    actorUserId?: string
  ): Promise<{ daemonId: string; apiKeyId: string; token: string }> {
    const by = actorUserId ? { createdByUserId: actorUserId } : {}
    if (existingDaemonId) {
      const key = await this.keys.mintForDaemon(orgId, DaemonId(existingDaemonId), by)
      return { daemonId: existingDaemonId, ...key }
    }
    const provisioned = await this.keys.provisionDaemon({ orgId, ...by })
    await this.repo.stageCredentialDaemon(orgId, token, provisioned.daemonId)
    return provisioned
  }

  /**
   * Finish the applies a committed credential is still owed. A commit is durable
   * intent; the pod only rolls onto the new key once the CR carries the new
   * `credentialRevision`, so a request that died between the two leaves both the
   * obligation and the keys it superseded — held, and therefore still working.
   * This is the retry: re-apply, then release, under the same per-org claim
   * every other transition takes. Returns how many rollouts it completed.
   */
  async drainCredentialRollouts(limit = ROLLOUT_BATCH): Promise<number> {
    let completed = 0
    for (const orgId of await this.repo.listPendingCredentialRollouts(limit)) {
      if (await this.completeRollout(OrgId(orgId))) completed += 1
    }
    return completed
  }

  /** One owed rollout, or false when it is still owed after this pass. */
  private async completeRollout(orgId: OrgId): Promise<boolean> {
    const token = randomUUID()
    const claimed = await this.repo.beginCredentialRotation(orgId, token, new Date(this.clock.now()), ROTATION_LEASE_MS)
    if (!claimed) return false // a live transition owns this org; next pass
    try {
      // Through the convergence fence, not a bare apply: a settings write needs
      // no credential claim, so one can land while this apply is in flight and
      // this pass would otherwise revert the CR to the spec it captured. The
      // credential fields only move under the claim this pass holds, so the row
      // a peer supersedes it with still carries the revision being rolled out.
      await this.converge(orgId)
      await this.repo.completeCredentialRollout(orgId, token)
      return true
    } catch {
      return false // still owed; the cluster is unreachable or refusing
    } finally {
      await this.repo.endCredentialRotation(orgId, token)
    }
  }

  /**
   * Revoke every key the provisioner still owes, dropping each intent only once
   * its key is actually revoked. Errors are swallowed per key so one unreachable
   * row cannot hold up the rest; the intent survives for the next pass.
   */
  async drainKeyRevocations(limit = REVOCATION_BATCH): Promise<number> {
    const pending = await this.repo.listPendingKeyRevocations(limit)
    let revoked = 0
    for (const entry of pending) {
      try {
        await this.keys.revoke(entry.apiKeyId, entry.reason)
      } catch {
        continue // still owed; the maintenance loop retries
      }
      await this.repo.clearKeyRevocation(entry.apiKeyId)
      revoked += 1
    }
    return revoked
  }

  /**
   * The envelope namespace, read off the CR the operator publishes it on. The
   * control plane never derives it: the operator owns `<prefix><CR name>`, and
   * `status.namespace` appears only once the namespace has actually been created
   * and claim-validated. Absent ⇒ there is nothing to publish a Secret into yet.
   */
  private async envelopeNamespace(settings: ClusterExecutionSettings): Promise<string> {
    const namespace = (await this.api.get(settings.resourceName))?.status?.namespace
    if (!namespace) throw NamespaceNotReadyError.unpublished(settings.resourceName)
    return namespace
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
    return {
      orgId,
      enabled: false,
      specRevision: 0,
      credentialRotationSeq: 0,
      suspend: false,
      ...defaults,
      createdAt: epoch,
      updatedAt: epoch
    }
  }
}
