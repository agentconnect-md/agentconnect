/**
 * GitLab project provisioning saga + external cleanup (gitlab-com-integration.md
 * §10.2, §7.2–§7.4, §11.1, §19.4).
 *
 * Desired-state convergence, resumable at every step: refresh the project by
 * numeric id, find-or-create the deterministically marked Project Service
 * Account under the ROOT group, ensure Developer membership, create or recover
 * the three purpose-separated PATs with an explicit 90-day expiry, and — when
 * at least one enabled GitLab hook wants events — install and test the managed
 * webhook with a fresh whsec signing key.
 *
 * Fail-closed rules carried from the design:
 * - a returned PAT is sealed only after its identity, scopes, active flag, and
 *   EXACT requested expiry validate; anything else is revoked by id at once and
 *   the step fails (§7.3);
 * - external names carry the stable binding marker; foreign accounts, tokens,
 *   and webhooks are never adopted by name alone — webhook ownership needs BOTH
 *   the stored id and the marker URL (§10.3);
 * - cleanup that cannot be completed leaves `cleanup_pending` and RETAINS the
 *   deployment-global claim; elapsed time never releases it (§10.2, §19.4).
 *
 * NEVER log token material or upstream token responses.
 */
import { randomBytes } from 'node:crypto'
import { OrgId } from '../domain/ids.js'
import type { SecretCipher } from '../secrets/cipher.js'
import { orgScope } from '../secrets/scope.js'
import type { Clock } from '../domain/clock.js'
import type {
  CodeHostRepositoryRepo,
  GitlabCredentialPurpose,
  GitlabProjectBindingRecord,
  GitlabProjectBindingRepo,
  GitlabProjectCredentialRepo,
  GitlabProjectCredentialSecretStore,
  GitlabWebhookSecretStore
} from '../persistence/ports.js'
import {
  GitlabApiError,
  gitlabCreateServiceAccount,
  gitlabCreateServiceAccountToken,
  gitlabCreateWebhook,
  gitlabDeleteServiceAccount,
  gitlabDeleteWebhook,
  gitlabEnsureDeveloperMember,
  gitlabFindServiceAccount,
  gitlabProject,
  gitlabListServiceAccountTokens,
  gitlabListWebhooks,
  gitlabRevokeServiceAccountToken,
  gitlabRootNamespace,
  gitlabServiceAccountUsername,
  gitlabTestWebhook,
  gitlabUpdateWebhook,
  type FetchLike,
  type GitlabProjectWithNamespace,
  type GitlabWebhookEvents
} from './api.js'
import type { GitlabOauthService } from './oauth.service.js'

/** The exclusive provisioning lease a run holds across its provider writes. */
export const PROVISION_LEASE_MS = 10 * 60 * 1000

/** §7.3 v1 policy: every PAT is created with exactly this lifetime. */
export const PAT_LIFETIME_DAYS = 90

const PURPOSE_SCOPES: Record<GitlabCredentialPurpose, string[]> = {
  read: ['read_api', 'read_repository'],
  git_write: ['write_repository'],
  effect: ['api']
}

/** §10.2: the claim fence was lost mid-run (cleanup or takeover won). */
export class GitlabClaimFenceLost extends Error {
  constructor() {
    super('the deployment-global project claim fence was lost')
    this.name = 'GitlabClaimFenceLost'
  }
}

/** §7.3: the provider returned a token outside the requested policy. */
export class GitlabTokenPolicyViolation extends Error {
  constructor(readonly purpose: GitlabCredentialPurpose) {
    super(`gitlab returned an out-of-policy ${purpose} token`)
    this.name = 'GitlabTokenPolicyViolation'
  }
}

export type ProvisionOutcome =
  | { state: 'ready' }
  | { state: 'admin_degraded' | 'runtime_degraded'; reason: string }
  // A live peer owns the claim (provisioning or cleanup in progress): nothing
  // was written and no binding state was overwritten; the caller observes.
  | { state: 'busy'; reason: string }

export interface GitlabProvisionerDeps {
  oauth: GitlabOauthService
  bindings: GitlabProjectBindingRepo
  credentials: GitlabProjectCredentialRepo
  credentialSecrets: GitlabProjectCredentialSecretStore
  webhookSecrets: GitlabWebhookSecretStore
  catalog: CodeHostRepositoryRepo
  cipher: SecretCipher
  clock: Clock
  /** Public relay origin the managed webhook URL derives from; absent ⇒ the
   *  webhook step reports a configuration reason instead of guessing. */
  publicRelayUrl?: string
  /** The enabled-hook event union for a project; null ⇒ no webhook wanted (§10.3). */
  desiredWebhookEvents: (orgId: string, projectId: bigint) => Promise<GitlabWebhookEvents | null>
  fetchImpl?: FetchLike
  log?: { warn(obj: object, msg: string): void }
}

function expiresAtDate(nowMs: number): string {
  return new Date(nowMs + PAT_LIFETIME_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

function patName(projectId: bigint, purpose: GitlabCredentialPurpose): string {
  return `${gitlabServiceAccountUsername(projectId)}-${purpose.replace('_', '-')}`
}

export class GitlabProvisioner {
  constructor(private readonly deps: GitlabProvisionerDeps) {}

  /** Converge one binding to ready; persists the outcome state on the binding. */
  async provision(orgId: string, bindingId: string): Promise<ProvisionOutcome> {
    const binding = await this.deps.bindings.get(orgId, bindingId)
    if (!binding) return { state: 'admin_degraded', reason: 'binding_missing' }
    if (!binding.installerConnectionId) {
      return this.degrade(orgId, bindingId, 'admin_degraded', 'no_admin_connection')
    }
    // The run's exclusive lease identity (§10.2): CAS-acquired before any
    // provider write; a live foreign lease refuses, so runs never overlap.
    const owner = randomBytes(9).toString('base64url')
    const nowMs = this.deps.clock.now()
    if (
      !(await this.deps.bindings.markProviderMutationStarted(
        orgId,
        bindingId,
        binding.projectId,
        owner,
        new Date(nowMs + PROVISION_LEASE_MS),
        new Date(nowMs)
      ))
    ) {
      // Held by a live peer, or the claim is gone/detached/in-cleanup: no
      // provider writes, and no state overwrite of whatever is in progress.
      return { state: 'busy', reason: 'provisioning_or_cleanup_in_progress' }
    }
    try {
      const token = await this.deps.oauth.withAccessToken(orgId, binding.installerConnectionId)
      const outcome = await this.converge(orgId, binding, token, owner)
      if (outcome.state === 'ready') {
        await this.deps.bindings.update(orgId, bindingId, { state: 'ready', stateReason: null })
      } else if (outcome.state !== 'busy') {
        await this.deps.bindings.update(orgId, bindingId, { state: outcome.state, stateReason: outcome.reason })
      }
      return outcome
    } catch (e) {
      const reason =
        e instanceof GitlabClaimFenceLost
          ? 'claim_fence_lost'
          : e instanceof GitlabTokenPolicyViolation
            ? 'out_of_policy_token'
            : e instanceof GitlabApiError
              ? `gitlab_${e.status || 'unreachable'}`
              : 'admin_unavailable'
      this.deps.log?.warn({ bindingId, reason }, 'gitlab provisioning failed')
      return this.degrade(orgId, bindingId, 'admin_degraded', reason)
    } finally {
      // Release THIS run's lease whatever happened: every external resource is
      // deterministically marked, so the next run reconciles it.
      await this.deps.bindings.endProviderMutation(orgId, bindingId, binding.projectId, owner).catch(() => {})
    }
  }

  private async degrade(
    orgId: string,
    bindingId: string,
    state: 'admin_degraded' | 'runtime_degraded',
    reason: string
  ): Promise<ProvisionOutcome> {
    await this.deps.bindings.update(orgId, bindingId, { state, stateReason: reason })
    return { state, reason }
  }

  private renewLease(orgId: string, binding: GitlabProjectBindingRecord, owner: string): Promise<boolean> {
    // Atomic owner-matched extension: liveness check and renewal are one write,
    // with fresh validity covering the provider request that follows.
    return this.deps.bindings.renewProviderLease(
      orgId,
      binding.id,
      binding.projectId,
      owner,
      new Date(this.deps.clock.now() + PROVISION_LEASE_MS)
    )
  }

  private async converge(
    orgId: string,
    binding: GitlabProjectBindingRecord,
    token: string,
    owner: string
  ): Promise<ProvisionOutcome> {
    const { fetchImpl } = this.deps
    // 1. Refresh the mutable facts by numeric id (rename-proof, §10.2 step 1).
    const project = (await gitlabProject(token, binding.projectId, fetchImpl)) as GitlabProjectWithNamespace | null
    if (!project) return { state: 'admin_degraded', reason: 'project_not_accessible' }
    await this.deps.bindings.update(orgId, binding.id, {
      projectPath: project.path_with_namespace,
      defaultBranch: project.default_branch ?? null
    })
    await this.deps.catalog.upsert({
      orgId,
      provider: 'gitlab',
      externalId: binding.projectId,
      displayPath: project.path_with_namespace,
      ...(project.http_url_to_repo ? { cloneUrl: project.http_url_to_repo } : {}),
      ...(project.default_branch ? { defaultBranch: project.default_branch } : {})
    })
    if (!project.namespace) return { state: 'admin_degraded', reason: 'project_namespace_unknown' }
    const root = await gitlabRootNamespace(token, project.namespace, fetchImpl)
    // Service accounts hang off a top-level GROUP; a personal namespace has none (§5).
    if (root.kind !== 'group') return { state: 'admin_degraded', reason: 'personal_namespace_unsupported' }

    // 2–3. Find-or-create the marked service account; ensure Developer membership.
    const username = gitlabServiceAccountUsername(binding.projectId)
    let account = await gitlabFindServiceAccount(token, root.id, username, fetchImpl)
    if (!account) {
      // §10.2 per-step atomic renewal: the run must still own the lease.
      if (!(await this.renewLease(orgId, binding, owner))) {
        return { state: 'admin_degraded', reason: 'claim_fence_lost' }
      }
      try {
        account = await gitlabCreateServiceAccount(
          token,
          root.id,
          { username, name: `AgentConnect (${project.path_with_namespace})` },
          fetchImpl
        )
      } catch (e) {
        // Ambiguous create (§10.2): list by the deterministic marker before failing.
        account = await gitlabFindServiceAccount(token, root.id, username, fetchImpl)
        if (!account) {
          if (e instanceof GitlabApiError && e.status === 403) {
            // Owner identity verification or the Free quota — a human prerequisite (§5).
            return { state: 'admin_degraded', reason: 'service_account_create_forbidden' }
          }
          throw e
        }
      }
    }
    const accountUserId = BigInt(account.id)
    await gitlabEnsureDeveloperMember(token, binding.projectId, accountUserId, fetchImpl)
    await this.deps.bindings.update(orgId, binding.id, {
      serviceAccountUserId: accountUserId,
      serviceAccountUsername: account.username
    })

    // 4–5. The three purpose-separated PATs, each with the explicit finite expiry.
    for (const purpose of ['read', 'git_write', 'effect'] as const) {
      const existing = await this.deps.credentials.get(binding.id, purpose)
      const stillValid =
        existing &&
        existing.providerExpiresAt.getTime() > this.deps.clock.now() &&
        (await this.deps.credentialSecrets.get(orgId, existing.id)) !== null
      if (stillValid) continue
      await this.mintCredential(orgId, binding, token, root.id, accountUserId, purpose, owner)
    }

    // 6–7. The managed webhook, only when an enabled hook wants events (§10.3).
    const events = await this.deps.desiredWebhookEvents(orgId, binding.projectId)
    if (events) {
      const outcome = await this.convergeWebhook(orgId, binding, token, events, owner)
      if (outcome) return outcome
    }
    return { state: 'ready' }
  }

  private async mintCredential(
    orgId: string,
    binding: GitlabProjectBindingRecord,
    token: string,
    groupId: number,
    serviceAccountUserId: bigint,
    purpose: GitlabCredentialPurpose,
    owner: string
  ): Promise<void> {
    const scopes = PURPOSE_SCOPES[purpose]
    const expiresAt = expiresAtDate(this.deps.clock.now())
    // §10.2 per-step atomic renewal under the lease.
    if (!(await this.renewLease(orgId, binding, owner))) throw new GitlabClaimFenceLost()
    // Ambiguous-create recovery (§10.2): a marked token we did not record has a
    // lost plaintext — revoke it before minting, sparing the recorded one
    // (rotation's create-before-revoke overlap shares the name deliberately).
    const recorded = await this.deps.credentials.get(binding.id, purpose)
    const name = patName(binding.projectId, purpose)
    const strays = (
      await gitlabListServiceAccountTokens(token, groupId, serviceAccountUserId, this.deps.fetchImpl)
    ).filter((t) => t.name === name && t.active !== false && t.revoked !== true)
    for (const stray of strays) {
      if (recorded && BigInt(stray.id) === recorded.externalTokenId) continue
      await gitlabRevokeServiceAccountToken(
        token,
        groupId,
        serviceAccountUserId,
        BigInt(stray.id),
        this.deps.fetchImpl
      ).catch(() =>
        this.deps.log?.warn({ bindingId: binding.id, purpose }, 'gitlab stray token revocation is unconfirmed')
      )
    }
    // Renew again right before the create: the stray sweep above may have
    // spent a chunk of the lease on sequential provider calls.
    if (!(await this.renewLease(orgId, binding, owner))) throw new GitlabClaimFenceLost()
    const grant = await gitlabCreateServiceAccountToken(
      token,
      groupId,
      serviceAccountUserId,
      { name: patName(binding.projectId, purpose), scopes, expiresAt },
      this.deps.fetchImpl
    )
    // §7.3 validation before sealing: identity, scopes, active, EXACT expiry.
    const valid =
      typeof grant.token === 'string' &&
      grant.token.length > 0 &&
      grant.active !== false &&
      grant.revoked !== true &&
      grant.expires_at === expiresAt &&
      (grant.user_id === undefined || BigInt(grant.user_id) === serviceAccountUserId) &&
      scopes.every((scope) => grant.scopes?.includes(scope)) &&
      grant.scopes?.length === scopes.length
    if (!valid) {
      // Out-of-policy token: revoke by id immediately and fail closed. An
      // id-less response is recorded as restricted cleanup debt.
      if (typeof grant.id === 'number') {
        await gitlabRevokeServiceAccountToken(
          token,
          groupId,
          serviceAccountUserId,
          BigInt(grant.id),
          this.deps.fetchImpl
        ).catch(() => {
          this.deps.log?.warn(
            { bindingId: binding.id, purpose, tokenId: grant.id },
            'gitlab out-of-policy token revocation is unconfirmed (restricted cleanup debt)'
          )
        })
      } else {
        this.deps.log?.warn({ bindingId: binding.id, purpose }, 'gitlab returned an out-of-policy token without an id')
      }
      throw new GitlabTokenPolicyViolation(purpose)
    }
    // Seal first; metadata, sealed value, and the epoch fence commit atomically.
    await this.deps.credentials.commitRotation({
      bindingId: binding.id,
      purpose,
      externalTokenId: BigInt(grant.id),
      scopes,
      providerExpiresAt: new Date(`${expiresAt}T00:00:00.000Z`),
      sealedToken: await this.deps.cipher.seal(grant.token!, orgScope(OrgId(orgId)))
    })
  }

  private async convergeWebhook(
    orgId: string,
    binding: GitlabProjectBindingRecord,
    token: string,
    events: GitlabWebhookEvents,
    owner: string
  ): Promise<ProvisionOutcome | null> {
    if (!this.deps.publicRelayUrl) {
      return { state: 'admin_degraded', reason: 'relay_url_unconfigured' }
    }
    // §10.2 per-step atomic renewal before the webhook create/update: the lease
    // is extended so it cannot expire while the provider request is in flight.
    if (!(await this.renewLease(orgId, binding, owner))) {
      return { state: 'admin_degraded', reason: 'claim_fence_lost' }
    }
    const url = `${this.deps.publicRelayUrl.replace(/\/$/, '')}/webhooks/gitlab`
    const signingToken = `whsec_${randomBytes(32).toString('base64')}`
    // Seal the signing intent BEFORE any provider call: a crash after the
    // create still leaves us the key the created hook carries.
    await this.deps.webhookSecrets.put(orgId, binding.id, signingToken)
    let fresh = binding.webhookId === null
    let webhookId: bigint
    if (fresh) {
      // Crash-left create reconciliation: an existing hook at OUR exact managed
      // URL for this project is ours (the URL is this deployment's endpoint) —
      // re-key it in place instead of creating a duplicate. A merely similar
      // URL never matches (§10.3).
      const existing = (await gitlabListWebhooks(token, binding.projectId, this.deps.fetchImpl)).find(
        (hook) => hook.url === url
      )
      if (existing) {
        webhookId = BigInt(existing.id)
        await gitlabUpdateWebhook(
          token,
          binding.projectId,
          webhookId,
          { url, signingToken, events },
          this.deps.fetchImpl
        )
        fresh = false
      } else {
        const created = await gitlabCreateWebhook(
          token,
          binding.projectId,
          { url, signingToken, events },
          this.deps.fetchImpl
        )
        webhookId = BigInt(created.id)
      }
    } else {
      // Ownership = stored id + marker URL (§10.3); never adopt by URL alone.
      webhookId = binding.webhookId!
      await gitlabUpdateWebhook(token, binding.projectId, webhookId, { url, signingToken, events }, this.deps.fetchImpl)
    }
    await this.deps.bindings.update(orgId, binding.id, {
      webhookId,
      desiredEventsHash: JSON.stringify(events)
    })
    if (fresh) {
      await gitlabTestWebhook(token, binding.projectId, webhookId, 'push_events', this.deps.fetchImpl).catch((e) => {
        this.deps.log?.warn(
          { bindingId: binding.id, status: e instanceof GitlabApiError ? e.status : undefined },
          'gitlab webhook test delivery failed'
        )
      })
    }
    return null
  }

  /**
   * §7.4 rotation: create the replacement BEFORE revoking the old PAT — GitLab's
   * rotate-in-place invalidates immediately, so the overlap lives on our side.
   * The replacement rides the same validation + atomic commit as first mint,
   * under the same exclusive run lease as provision (§10.2) — a live peer
   * refuses and the next sweep retries. Only after commit is the previous
   * provider token revoked (best-effort: it carries a finite expiry anyway).
   */
  async rotateDueCredentials(horizonMs: number): Promise<void> {
    const due = await this.deps.credentials.listExpiring(new Date(this.deps.clock.now() + horizonMs))
    const failedBindings = new Set<string>()
    for (const { credential, orgId } of due) {
      if (failedBindings.has(credential.bindingId)) continue
      const binding = await this.deps.bindings.get(orgId, credential.bindingId)
      if (!binding || binding.state === 'cleanup_pending') continue
      if (!binding.installerConnectionId) {
        failedBindings.add(binding.id)
        await this.degrade(orgId, binding.id, 'admin_degraded', 'rotation_admin_unavailable')
        continue
      }
      const owner = randomBytes(9).toString('base64url')
      const nowMs = this.deps.clock.now()
      const acquired = await this.deps.bindings.markProviderMutationStarted(
        orgId,
        binding.id,
        binding.projectId,
        owner,
        new Date(nowMs + PROVISION_LEASE_MS),
        new Date(nowMs)
      )
      if (!acquired) continue
      try {
        const token = await this.deps.oauth.withAccessToken(orgId, binding.installerConnectionId)
        const project = (await gitlabProject(
          token,
          binding.projectId,
          this.deps.fetchImpl
        )) as GitlabProjectWithNamespace | null
        if (!project?.namespace || binding.serviceAccountUserId === null) {
          failedBindings.add(binding.id)
          await this.degrade(orgId, binding.id, 'admin_degraded', 'rotation_identity_missing')
          continue
        }
        const root = await gitlabRootNamespace(token, project.namespace, this.deps.fetchImpl)
        const previousTokenId = credential.externalTokenId
        const serviceAccountUserId = binding.serviceAccountUserId
        await this.mintCredential(orgId, binding, token, root.id, serviceAccountUserId, credential.purpose, owner)
        await gitlabRevokeServiceAccountToken(
          token,
          root.id,
          serviceAccountUserId,
          previousTokenId,
          this.deps.fetchImpl
        ).catch(() => {
          this.deps.log?.warn(
            { bindingId: binding.id, purpose: credential.purpose },
            'gitlab rotation could not revoke the previous token (it still expires on schedule)'
          )
        })
      } catch (e) {
        // The Console warns while administration is unavailable; runtime keeps
        // working until the existing credential expires (§7.4).
        failedBindings.add(binding.id)
        const reason =
          e instanceof GitlabClaimFenceLost
            ? 'claim_fence_lost'
            : e instanceof GitlabTokenPolicyViolation
              ? 'out_of_policy_token'
              : e instanceof GitlabApiError
                ? `rotation_gitlab_${e.status || 'unreachable'}`
                : 'rotation_admin_unavailable'
        this.deps.log?.warn({ bindingId: binding.id, reason }, 'gitlab credential rotation failed')
        await this.degrade(orgId, binding.id, 'admin_degraded', reason)
      } finally {
        await this.deps.bindings.endProviderMutation(orgId, binding.id, binding.projectId, owner).catch(() => {})
      }
    }
  }

  /**
   * §19.4 disconnect: local authority off first (epoch bump), then external
   * cleanup — webhook, PAT revocations, service account. Complete cleanup
   * removes the binding and releases the deployment-global claim; anything
   * ambiguous keeps `cleanup_pending` and RETAINS the claim.
   */
  async disconnect(orgId: string, bindingId: string): Promise<{ removed: boolean; reason?: string }> {
    const binding = await this.deps.bindings.get(orgId, bindingId)
    if (!binding) return { removed: false, reason: 'binding_missing' }
    // Mutual exclusion with provision/repair (§10.2): cleanup may not begin
    // while a LIVE provisioning lease is held — the caller retries later.
    if (
      !(await this.deps.bindings.beginCleanup(orgId, bindingId, binding.projectId, new Date(this.deps.clock.now())))
    ) {
      return { removed: false, reason: 'provisioning_in_progress' }
    }
    await this.deps.bindings.bumpCredentialEpoch(orgId, bindingId)
    if (!binding.installerConnectionId) {
      await this.deps.bindings.update(orgId, bindingId, {
        state: 'cleanup_pending',
        stateReason: 'no_admin_connection'
      })
      return { removed: false, reason: 'no_admin_connection' }
    }
    try {
      const token = await this.deps.oauth.withAccessToken(orgId, binding.installerConnectionId)
      if (binding.webhookId !== null) {
        await gitlabDeleteWebhook(token, binding.projectId, binding.webhookId, this.deps.fetchImpl).catch(swallow404)
      } else if (this.deps.publicRelayUrl) {
        // A crash-left create may exist without a recorded id: our exact managed
        // URL identifies it (the URL is this deployment's endpoint), so cleanup
        // retires it rather than orphaning it.
        const url = `${this.deps.publicRelayUrl.replace(/\/$/, '')}/webhooks/gitlab`
        for (const hook of await gitlabListWebhooks(token, binding.projectId, this.deps.fetchImpl)) {
          if (hook.url === url) {
            await gitlabDeleteWebhook(token, binding.projectId, BigInt(hook.id), this.deps.fetchImpl).catch(swallow404)
          }
        }
      }
      const credentials = await this.deps.credentials.listForBinding(bindingId)
      // Local ids are NOT proof of external absence: a crash between the
      // service-account create and its id write leaves both empty while the
      // marked account exists. Cleanup therefore always resolves the root group
      // and reconciles the deterministic marker before the claim may release.
      const project = (await gitlabProject(
        token,
        binding.projectId,
        this.deps.fetchImpl
      )) as GitlabProjectWithNamespace | null
      if (!project?.namespace) {
        throw new GitlabApiError('project namespace unavailable for cleanup', 0, 'INTERNAL', true)
      }
      const root = await gitlabRootNamespace(token, project.namespace, this.deps.fetchImpl)
      if (root.kind === 'group') {
        const username = gitlabServiceAccountUsername(binding.projectId)
        const marked = await gitlabFindServiceAccount(token, root.id, username, this.deps.fetchImpl)
        // The UNION of the recorded id and the marker result: a stale recorded
        // account and a crash-left marked replacement can be two distinct
        // accounts, and both must be gone before the claim may release.
        const candidates = new Set<bigint>()
        if (binding.serviceAccountUserId !== null) candidates.add(binding.serviceAccountUserId)
        if (marked) candidates.add(BigInt(marked.id))
        for (const accountUserId of candidates) {
          // Recorded tokens are revoked individually (belt); deleting the
          // account then invalidates anything a crash left unrecorded.
          for (const credential of credentials) {
            await gitlabRevokeServiceAccountToken(
              token,
              root.id,
              accountUserId,
              credential.externalTokenId,
              this.deps.fetchImpl
            ).catch(swallow404)
          }
          await gitlabDeleteServiceAccount(token, root.id, accountUserId, this.deps.fetchImpl).catch(swallow404)
        }
        // Release only on positive evidence: the deterministic marker is absent.
        if (await gitlabFindServiceAccount(token, root.id, username, this.deps.fetchImpl)) {
          throw new GitlabApiError('marked service account still present after cleanup', 0, 'INTERNAL', true)
        }
      } else if (binding.serviceAccountUserId !== null || credentials.length > 0) {
        // Provider facts exist but their group is unreachable: never release.
        throw new GitlabApiError('root group unavailable for cleanup', 0, 'INTERNAL', false)
      }
    } catch (e) {
      const reason = e instanceof GitlabApiError ? `gitlab_${e.status || 'unreachable'}` : 'cleanup_failed'
      await this.deps.bindings.update(orgId, bindingId, { state: 'cleanup_pending', stateReason: reason })
      return { removed: false, reason }
    }
    // Verified-complete external cleanup: the local rows and the claim go together.
    await this.deps.bindings.removeWithClaim(orgId, bindingId, binding.projectId)
    return { removed: true }
  }
}

/** A definitively absent external resource IS cleaned up; anything else rethrows. */
function swallow404(e: unknown): void {
  if (e instanceof GitlabApiError && e.code === 'NOT_FOUND') return
  throw e
}

/** The sealed webhook signing key is relay material; this module never returns it. */
export type { GitlabWebhookEvents }
export const GITLAB_WEBHOOK_PATH = '/webhooks/gitlab'
/** Test-facing alias for the deterministic marker (kept beside its consumer). */
export { gitlabServiceAccountUsername as gitlabServiceAccountUsernameForTests }
