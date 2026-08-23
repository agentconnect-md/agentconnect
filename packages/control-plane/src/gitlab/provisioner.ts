/**
 * GitLab project provisioning saga + external cleanup (gitlab-com-integration.md
 * §10.2, §11.1, §19.4).
 *
 * Desired-state convergence, resumable at every step: refresh the project by
 * numeric id, converge every consuming agent's own service account and project
 * membership through the account service (§7.2), and — when at least one enabled
 * GitLab hook wants events — install and test the managed webhook with a fresh
 * whsec signing key.
 *
 * Fail-closed rules carried from the design:
 * - external names carry a deterministic marker; foreign accounts, tokens, and
 *   webhooks are never adopted by name alone — webhook ownership needs BOTH the
 *   stored id and the marker URL (§10.3);
 * - cleanup that cannot be completed leaves `cleanup_pending` and RETAINS the
 *   deployment-global claim; elapsed time never releases it (§10.2, §19.4).
 *
 * NEVER log token material or upstream token responses.
 */
import { randomBytes } from 'node:crypto'
import type { Clock } from '../domain/clock.js'
import type {
  CodeHostRepositoryRepo,
  GitlabAccountConsumer,
  GitlabProjectBindingRecord,
  GitlabProjectBindingRepo,
  GitlabWebhookSecretStore
} from '../persistence/ports.js'
import {
  GITLAB_ACCESS_MAINTAINER,
  GitlabApiError,
  gitlabCreateWebhook,
  gitlabDeleteWebhook,
  gitlabEffectiveMembership,
  gitlabProject,
  gitlabListWebhooks,
  gitlabRootNamespace,
  gitlabTestWebhook,
  gitlabUpdateWebhook,
  membershipSatisfies,
  type FetchLike,
  type GitlabProjectWithNamespace,
  type GitlabWebhookEvents
} from './api.js'
import {
  DELETION_PENDING_REASON,
  GitlabCleanupUnverified,
  GitlabTokenPolicyViolation,
  type GitlabAccountService
} from './account.service.js'
import type { GitlabOauthService } from './oauth.service.js'

/** The exclusive provisioning lease a run holds across its provider writes. */
export const PROVISION_LEASE_MS = 10 * 60 * 1000

/** §10.2: the claim fence was lost mid-run (cleanup or takeover won). */
export class GitlabClaimFenceLost extends Error {
  constructor() {
    super('the deployment-global project claim fence was lost')
    this.name = 'GitlabClaimFenceLost'
  }
}

export type ProvisionOutcome =
  | { state: 'ready' }
  // `retryable` marks a loser that resolves on its own — a contended account
  // lease or a lost generation fence (§7.2) — so a writer comes back for it.
  | { state: 'admin_degraded' | 'runtime_degraded'; reason: string; retryable?: boolean }
  // A live peer owns the claim (provisioning or cleanup in progress): nothing
  // was written and no binding state was overwritten; the caller observes.
  | { state: 'busy'; reason: string }

/** One agent's identity provisioned ahead of a write that will act as it, and
 *  that write's own result. The reason is the account's own repair category
 *  (`service_account_quota`, …); nothing was committed when it is present. */
export type AgentAccountOutcome<T> = { ok: true; result: T } | { ok: false; reason: string; retryable: boolean }

/** How a joined convergence run is shared, and whether it owes a trailing pass. */
interface ConvergeRun {
  done: Promise<void>
  again: boolean
}

export interface ConvergeProjectOpts {
  /** Contention retries before giving up on this pass; a request-inline caller
   *  passes a small number rather than blocking for the background bound. */
  attempts?: number
  /** False ⇒ this IS the follow-up; it does not schedule another. */
  followUp?: boolean
}

/** Background convergence outwaits a full 10-minute peer lease plus slack. */
const BACKGROUND_CONVERGE_ATTEMPTS = 92
/** A contended pass re-drives itself after this, so nothing needs a second Repair. */
const FOLLOW_UP_DELAY_MS = 30 * 1000

/** Inline in a request: retry a contended attempt on a short bound, then report. */
const AGENT_ACCOUNT_ATTEMPTS = 5

/** §9.4 takeover result; every refusal leaves the binding exactly as it was.
 *  The binding row carries the convergence outcome, so the caller re-reads it. */
export type GitlabTransferOutcome =
  { outcome: 'transferred' } | { outcome: 'binding_missing' } | { outcome: 'busy' } | { outcome: 'not_maintainer' }

export interface GitlabProvisionerDeps {
  oauth: GitlabOauthService
  bindings: GitlabProjectBindingRepo
  /** §7.2 identity: per-agent accounts, their PATs, and their memberships. */
  accounts: GitlabAccountService
  webhookSecrets: GitlabWebhookSecretStore
  catalog: CodeHostRepositoryRepo
  clock: Clock
  /** Public relay origin the managed webhook URL derives from; absent ⇒ the
   *  webhook step reports a configuration reason instead of guessing. */
  publicRelayUrl?: string
  /** The enabled-hook event union for a project; null ⇒ no webhook wanted (§10.3). */
  desiredWebhookEvents: (orgId: string, projectId: bigint) => Promise<GitlabWebhookEvents | null>
  /** AWAITED mid-run under the lease: converge dependent workspace clone URLs
   *  to the freshly read canonical path (agents keyed by this project id). */
  syncWorkspacePaths?: (orgId: string, projectId: bigint, projectPath: string) => Promise<void>
  /** Fired after any run that may have changed binding/webhook facts — the
   *  container rebroadcasts the project's compiled hook rules (assign or
   *  remove) so relays never keep a rule built from stale facts. */
  onConverged?: (orgId: string, projectId: bigint) => void
  fetchImpl?: FetchLike
  log?: { warn(obj: object, msg: string): void }
}

export class GitlabProvisioner {
  /** One convergence per project at a time, keyed `<org>:<project>`; late
   *  callers join it and ask for a trailing pass instead of racing its leases. */
  private readonly convergeRuns = new Map<string, ConvergeRun>()
  /** Projects whose contended pass has a follow-up armed. Together with the runs
   *  above this is "work this process still owes", which the console asks for so
   *  it keeps watching until the binding really has settled. */
  private readonly pendingFollowUps = new Set<string>()

  constructor(private readonly deps: GitlabProvisionerDeps) {}

  /** Converge one binding to ready; persists the outcome state on the binding. */
  async provision(orgId: string, bindingId: string, opts: { followUp?: boolean } = {}): Promise<ProvisionOutcome> {
    // A caller with its own retry loop owns coming back; every other one — a
    // create, a takeover, a single repair — leaves a contended pass owing it.
    const followUp = opts.followUp !== false
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
      if (followUp) this.scheduleFollowUp(orgId, binding.projectId)
      return { state: 'busy', reason: 'provisioning_or_cleanup_in_progress' }
    }
    try {
      const token = await this.deps.oauth.withAccessToken(orgId, binding.installerConnectionId)
      return await this.convergeAndPersist(orgId, binding, token, owner, followUp)
    } catch (e) {
      // Only the administration-token acquisition reaches here; convergence maps its own failures.
      return this.failed(orgId, bindingId, e)
    } finally {
      // Release THIS run's lease whatever happened: every external resource is
      // deterministically marked, so the next run reconciles it.
      await this.deps.bindings.endProviderMutation(orgId, bindingId, binding.projectId, owner).catch(() => {})
    }
  }

  /**
   * Converge a project after a write that changed who consumes it — a gitlab
   * hook or a gitlab workspace. Both move the §7.2 account and membership set,
   * and a hook write may also move the webhook event union.
   *
   * A contended outcome — a peer holding the §10.2 binding lease, or, inside the
   * run, an account lease or generation fence a §7.2 loser must come back for —
   * is outwaited rather than dropped: exponential backoff capped at 8s, ~92
   * attempts, which outlasts a full 10-minute lease plus slack while
   * back-to-back writes converge in seconds.
   */
  /** Does this process still owe convergence work in the organization? */
  hasPendingWork(orgId: string): boolean {
    const mine = (key: string): boolean => key.startsWith(`${orgId}:`)
    return [...this.convergeRuns.keys()].some(mine) || [...this.pendingFollowUps].some(mine)
  }

  /** Arm one follow-up for a contended pass; a project already owing one keeps it. */
  private scheduleFollowUp(orgId: string, projectId: bigint): void {
    const key = `${orgId}:${projectId}`
    if (this.pendingFollowUps.has(key)) return
    this.pendingFollowUps.add(key)
    this.deps.clock.setTimeout(() => {
      this.pendingFollowUps.delete(key)
      void this.convergeProject(orgId, projectId, { followUp: false }).catch((err) =>
        this.deps.log?.warn({ err, projectId: projectId.toString() }, 'gitlab converge follow-up failed')
      )
    }, FOLLOW_UP_DELAY_MS)
  }

  async convergeProject(orgId: string, projectId: bigint, opts: ConvergeProjectOpts = {}): Promise<void> {
    const key = `${orgId}:${projectId}`
    const running = this.convergeRuns.get(key)
    if (running) {
      // Someone is already converging this project. Join them rather than race
      // for the same leases — but ask for one more pass, because their reads may
      // predate whatever this caller just wrote.
      running.again = true
      await running.done
      return
    }
    const entry: ConvergeRun = { again: false, done: Promise.resolve() }
    this.convergeRuns.set(key, entry)
    entry.done = (async () => {
      try {
        do {
          entry.again = false
          await this.convergeProjectOnce(orgId, projectId, opts)
        } while (entry.again)
      } finally {
        this.convergeRuns.delete(key)
      }
    })()
    await entry.done
  }

  private async convergeProjectOnce(orgId: string, projectId: bigint, opts: ConvergeProjectOpts): Promise<void> {
    const binding = await this.deps.bindings.byProject(orgId, projectId)
    if (!binding) return
    const attempts = opts.attempts ?? BACKGROUND_CONVERGE_ATTEMPTS
    // This loop owns the retrying, so no attempt arms a follow-up of its own.
    let outcome = await this.provision(orgId, binding.id, { followUp: false })
    for (let attempt = 0; contended(outcome) && attempt < attempts; attempt++) {
      const delayMs = Math.min(8_000, 1_000 * 2 ** attempt)
      await new Promise<void>((resolve) => this.deps.clock.setTimeout(() => resolve(), delayMs))
      outcome = await this.provision(orgId, binding.id, { followUp: false })
    }
    if (!contended(outcome)) return
    // Still contended: the binding keeps its previous state, so nothing settles
    // as degraded on account of a race. A follow-up re-drives it so it heals
    // without anyone pressing Repair again.
    this.deps.log?.warn({ projectId: projectId.toString() }, 'gitlab converge still contended — retrying later')
    if (opts.followUp !== false) this.scheduleFollowUp(orgId, projectId)
  }

  /**
   * Provision ONE agent's identity on a project ahead of the write that will act
   * as that agent (§7.2). A workspace edit activates through the daemon, and
   * activation mints credentials from the agent's own account: without this the
   * activation is refused, the edit rolls back, and the post-write convergence
   * that would have created the account never runs — the agent never became a
   * consumer, so nothing else has a reason to create it either.
   *
   * Runs under the SAME binding lease as a full converge, so the two cannot
   * interleave, and the account mutation lease plus the generation fence stay
   * where `ensureForConsumer` puts them. `commit` — the write that makes the
   * agent a consumer — runs while that lease is still HELD, because a membership
   * whose authorization row is not visible yet is exactly what a concurrent
   * convergence would unbind and retire. Inline in a request, so a contended
   * attempt is retried on a short bound and then reported, never outwaited for
   * the minutes `convergeProject` can afford. A throw from `commit` propagates.
   */
  async provisionAgentAccount<T>(
    orgId: string,
    projectId: bigint,
    consumer: GitlabAccountConsumer,
    commit: (live: { projectPath: string }) => Promise<T>
  ): Promise<AgentAccountOutcome<T>> {
    let outcome = await this.agentAccountAttempt(orgId, projectId, consumer, commit)
    for (let attempt = 0; !outcome.ok && outcome.retryable && attempt < AGENT_ACCOUNT_ATTEMPTS; attempt++) {
      const delayMs = Math.min(1_000, 200 * 2 ** attempt)
      await new Promise<void>((resolve) => this.deps.clock.setTimeout(() => resolve(), delayMs))
      outcome = await this.agentAccountAttempt(orgId, projectId, consumer, commit)
    }
    return outcome
  }

  /**
   * §10.2 step 1: the project's mutable facts, keyed by its immutable numeric id,
   * converged onto every durable replica — the binding, the catalog, and every
   * projected path (workspace clone URLs and authorization display paths).
   *
   * AWAITED under the caller's lease: those paths are hints keyed by the numeric
   * id, and a fire-and-forget refresh can be skipped by a crash or reordered by an
   * overlapping callback. Runs never overlap, so converging here is both durable
   * and ordered; the daemon fan-out stays best-effort on the container side.
   */
  private async syncProjectFacts(
    orgId: string,
    bindingId: string,
    projectId: bigint,
    project: GitlabProjectWithNamespace
  ): Promise<void> {
    await this.deps.bindings.update(orgId, bindingId, {
      projectPath: project.path_with_namespace,
      defaultBranch: project.default_branch ?? null
    })
    await this.deps.catalog.upsert({
      orgId,
      provider: 'gitlab',
      externalId: projectId,
      displayPath: project.path_with_namespace,
      ...(project.http_url_to_repo ? { cloneUrl: project.http_url_to_repo } : {}),
      ...(project.default_branch ? { defaultBranch: project.default_branch } : {})
    })
    await this.deps.syncWorkspacePaths?.(orgId, projectId, project.path_with_namespace)
  }

  private async agentAccountAttempt<T>(
    orgId: string,
    projectId: bigint,
    consumer: GitlabAccountConsumer,
    commit: (live: { projectPath: string }) => Promise<T>
  ): Promise<AgentAccountOutcome<T>> {
    const binding = await this.deps.bindings.byProject(orgId, projectId)
    if (!binding || binding.state === 'cleanup_pending') {
      return { ok: false, reason: 'binding_unavailable', retryable: false }
    }
    if (!binding.installerConnectionId) return { ok: false, reason: 'no_admin_connection', retryable: false }
    const owner = randomBytes(9).toString('base64url')
    const nowMs = this.deps.clock.now()
    if (
      !(await this.deps.bindings.markProviderMutationStarted(
        orgId,
        binding.id,
        binding.projectId,
        owner,
        new Date(nowMs + PROVISION_LEASE_MS),
        new Date(nowMs)
      ))
    ) {
      return { ok: false, reason: 'provisioning_or_cleanup_in_progress', retryable: true }
    }
    // Set once the run knows where it is working, so a failure can undo exactly
    // what it speculatively created.
    let scope: { orgId: string; bindingId: string; projectId: bigint; rootGroupId: bigint; token: string } | undefined
    // The provider's own current answer, handed to `commit` so the row it writes
    // carries the live path rather than the caller's pre-lease capture.
    let livePath = binding.projectPath
    try {
      let ensured: { ok: true } | { ok: false; reason: string; retryable: boolean }
      try {
        const token = await this.deps.oauth.withAccessToken(orgId, binding.installerConnectionId)
        const project = (await gitlabProject(
          token,
          binding.projectId,
          this.deps.fetchImpl
        )) as GitlabProjectWithNamespace | null
        if (!project?.namespace) return { ok: false, reason: 'project_not_accessible', retryable: false }
        // The path this read answers with is the CURRENT one; a caller committing a
        // path it captured before the lease would persist a rename's losing side.
        // Converging the replicas here first means the binding, the catalog, the
        // projected paths, and the row `commit` writes all agree on one answer.
        await this.syncProjectFacts(orgId, binding.id, binding.projectId, project)
        livePath = project.path_with_namespace
        const root = await gitlabRootNamespace(token, project.namespace, this.deps.fetchImpl)
        // Service accounts hang off a top-level GROUP; a personal namespace has none (§5).
        if (root.kind !== 'group') return { ok: false, reason: 'personal_namespace_unsupported', retryable: false }
        scope = {
          orgId,
          bindingId: binding.id,
          projectId: binding.projectId,
          rootGroupId: BigInt(root.id),
          token
        }
        ensured = await this.deps.accounts.ensureForConsumer(
          { ...scope, rootGroupId: root.id, installerConnectionId: binding.installerConnectionId },
          consumer
        )
      } catch (e) {
        // Only the provisioning half maps its failures; `commit` owns its own.
        const reason = e instanceof GitlabApiError ? `gitlab_${e.status || 'unreachable'}` : 'admin_unavailable'
        this.deps.log?.warn({ bindingId: binding.id, reason }, 'gitlab agent account provisioning failed')
        if (scope) await this.deps.accounts.rollbackSpeculativeBind(scope, consumer.agentId)
        return { ok: false, reason, retryable: e instanceof GitlabApiError && e.retryable }
      }
      if (!ensured.ok) {
        // A retryable loser did not create anything of its own — the account it
        // lost to belongs to a live peer, so only a final failure rolls back.
        if (!ensured.retryable && scope) await this.deps.accounts.rollbackSpeculativeBind(scope, consumer.agentId)
        return ensured
      }
      // STILL under the binding lease: the authorization row and the membership
      // become visible to convergence together, never one without the other.
      try {
        const result = await commit({ projectPath: livePath })
        // The commit just made a new account and membership visible — and, after a
        // rename, a new path. Compiled rules bake the project's bound
        // service-account ids into their §12.1 veto set, and push events are
        // relay-trusted once past it, so a rule left compiled from the old set
        // would let this bot's own pushes trigger its siblings' hooks.
        this.deps.onConverged?.(orgId, binding.projectId)
        // The commit just made a new account and membership visible — and, after a
        // rename, a new path. Compiled rules bake the project's bound
        // service-account ids into their §12.1 veto set, and push events are
        // relay-trusted once past it, so a rule left compiled from the old set
        // would let this bot's own pushes trigger its siblings' hooks.
        return { ok: true, result }
      } catch (e) {
        // The write never landed, so the bind it was for must not outlive it.
        if (scope) await this.deps.accounts.rollbackSpeculativeBind(scope, consumer.agentId)
        throw e
      }
    } finally {
      await this.deps.bindings.endProviderMutation(orgId, binding.id, binding.projectId, owner).catch(() => {})
    }
  }

  /**
   * §9.4 takeover: another current Maintainer or Owner becomes the administering
   * account of a binding whose own administration is stuck. It proves the
   * caller's CURRENT membership with the CALLER's own token before any write.
   *
   * A binding still in provisioning/ready/degraded is then re-converged under the
   * new authority, so the takeover is an admin mutation and runs under the SAME
   * exclusive lease as provision. A `cleanup_pending` one is only reassigned so
   * its interrupted removal can finish (§19.4) — it writes nothing at the
   * provider, holds no provisioning lease, and is never re-provisioned.
   */
  async transfer(
    orgId: string,
    bindingId: string,
    connection: { id: string; gitlabUserId: bigint }
  ): Promise<GitlabTransferOutcome> {
    const binding = await this.deps.bindings.get(orgId, bindingId)
    if (!binding) return { outcome: 'binding_missing' }
    const reprovision = binding.state !== 'cleanup_pending'
    const owner = randomBytes(9).toString('base64url')
    const nowMs = this.deps.clock.now()
    if (
      reprovision &&
      !(await this.deps.bindings.markProviderMutationStarted(
        orgId,
        bindingId,
        binding.projectId,
        owner,
        new Date(nowMs + PROVISION_LEASE_MS),
        new Date(nowMs)
      ))
    ) {
      return { outcome: 'busy' }
    }
    try {
      // Read-only prelude through the CALLER's own connection: an auth or upstream
      // failure here reaches the caller and degrades nothing, because nothing moved.
      const token = await this.deps.oauth.withAccessToken(orgId, connection.id)
      const membership = await gitlabEffectiveMembership(
        token,
        binding.projectId,
        connection.gitlabUserId,
        this.deps.fetchImpl
      )
      if (!membershipSatisfies(membership, GITLAB_ACCESS_MAINTAINER, this.deps.clock.now())) {
        return { outcome: 'not_maintainer' }
      }
      // §10.2 per-step atomic renewal: the fence must still be ours before the first write.
      if (reprovision && !(await this.renewLease(orgId, binding, owner))) return { outcome: 'busy' }
      const moved = await this.deps.bindings.update(orgId, bindingId, { installerConnectionId: connection.id })
      if (!moved) return { outcome: 'binding_missing' }
      if (reprovision) await this.convergeAndPersist(orgId, moved, token, owner)
      return { outcome: 'transferred' }
    } finally {
      if (reprovision) {
        await this.deps.bindings.endProviderMutation(orgId, bindingId, binding.projectId, owner).catch(() => {})
      }
    }
  }

  /** Converge under an already-held lease and persist the outcome on the binding. */
  private async convergeAndPersist(
    orgId: string,
    binding: GitlabProjectBindingRecord,
    token: string,
    owner: string,
    followUp = true
  ): Promise<ProvisionOutcome> {
    try {
      const outcome = await this.converge(orgId, binding, token, owner)
      if (outcome.state === 'ready') {
        await this.deps.bindings.update(orgId, binding.id, { state: 'ready', stateReason: null })
      } else if (outcome.state !== 'busy' && !contended(outcome)) {
        // A contended outcome is a lost fence, not a verdict on this binding:
        // persisting it would turn "someone else is converging right now" into a
        // sticky degraded state that only a racing repair could ever clear.
        await this.deps.bindings.update(orgId, binding.id, { state: outcome.state, stateReason: outcome.reason })
      }
      // Nothing was written for a contended pass, so something must come back
      // for it: a create, a takeover, or a single repair has no loop of its own.
      if (contended(outcome) && followUp) this.scheduleFollowUp(orgId, binding.projectId)
      this.deps.onConverged?.(orgId, binding.projectId)
      return outcome
    } catch (e) {
      return this.failed(orgId, binding.id, e)
    }
  }

  private failed(orgId: string, bindingId: string, e: unknown): Promise<ProvisionOutcome> {
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
    await this.syncProjectFacts(orgId, binding.id, binding.projectId, project)
    if (!project.namespace) return { state: 'admin_degraded', reason: 'project_namespace_unknown' }
    const root = await gitlabRootNamespace(token, project.namespace, fetchImpl)
    // Service accounts hang off a top-level GROUP; a personal namespace has none (§5).
    if (root.kind !== 'group') return { state: 'admin_degraded', reason: 'personal_namespace_unsupported' }

    // 2–5. Every consuming agent's own account, its PATs, and its membership at
    // the role its authorization derives; each under the ACCOUNT's lease (§7.2).
    if (!(await this.renewLease(orgId, binding, owner))) {
      return { state: 'admin_degraded', reason: 'claim_fence_lost' }
    }
    const accounts = await this.deps.accounts.convergeForBinding({
      orgId,
      bindingId: binding.id,
      projectId: binding.projectId,
      rootGroupId: root.id,
      installerConnectionId: binding.installerConnectionId!,
      token
    })

    // 6–7. The managed webhook, converged against PROVIDER truth to the union
    // CURRENT at run end. Each pass re-lists the project's webhooks first: a
    // crash between a provider delete and the local clear, or a provider-side
    // deletion, leaves a recorded id that no longer exists — local columns are
    // never proof. Re-checked until stable because a hook write landing mid-run
    // finds this run's lease live and its own kick backs off.
    let applied: string | null = null
    for (let pass = 0; pass < 3; pass++) {
      const events = await this.deps.desiredWebhookEvents(orgId, binding.projectId)
      const want = events ? JSON.stringify(events) : 'none'
      if (applied === want) break
      const fresh = (await this.deps.bindings.get(orgId, binding.id)) ?? binding
      if (!(await this.renewLease(orgId, fresh, owner))) {
        return { state: 'admin_degraded', reason: 'claim_fence_lost' }
      }
      const hooks = await gitlabListWebhooks(token, binding.projectId, this.deps.fetchImpl)
      const recordedExists = fresh.webhookId !== null && hooks.some((hook) => BigInt(hook.id) === fresh.webhookId)
      if (!recordedExists && fresh.webhookId !== null) {
        // The recorded webhook is gone at the provider: forget it so the
        // converge below re-adopts by exact URL or creates, never PUTs a 404 id.
        await this.deps.bindings.update(orgId, binding.id, { webhookId: null, desiredEventsHash: null })
      }
      if (events) {
        const effective = recordedExists ? fresh : { ...fresh, webhookId: null }
        const outcome = await this.convergeWebhook(orgId, effective, token, events, owner)
        if (outcome) return outcome
      } else {
        // §11.1's inverse: no enabled hook wants ingress any more, so the managed
        // webhook — the recorded id AND any crash-left hook at our exact managed
        // URL — and its sealed key go. A 404 counts as already-clean.
        const url = this.deps.publicRelayUrl
          ? `${this.deps.publicRelayUrl.replace(/\/$/, '')}/webhooks/gitlab`
          : undefined
        for (const hook of hooks) {
          const ours =
            (recordedExists && BigInt(hook.id) === fresh.webhookId) || (url !== undefined && hook.url === url)
          if (!ours) continue
          await gitlabDeleteWebhook(token, binding.projectId, BigInt(hook.id), this.deps.fetchImpl).catch(swallow404)
        }
        await this.deps.webhookSecrets.delete(orgId, binding.id)
        await this.deps.bindings.update(orgId, binding.id, { webhookId: null, desiredEventsHash: null })
      }
      applied = want
    }
    // An account the run could not converge is an ADMIN repair: the accounts
    // that did converge keep serving, and the failing agent simply has no
    // usable identity until the reason named here is fixed (§7.2).
    if (accounts.reason) {
      return { state: 'admin_degraded', reason: accounts.reason, ...(accounts.retryable ? { retryable: true } : {}) }
    }
    return { state: 'ready' }
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
    // The signing key is STABLE across converges — compiled rules carry it
    // inline, so a fresh key per run would strand every live rule until a
    // rebroadcast. Generate only when absent, sealing the intent BEFORE any
    // provider call: a crash after the create still leaves us the created
    // hook's key.
    let signingToken = await this.deps.webhookSecrets.get(orgId, binding.id)
    if (!signingToken) {
      signingToken = `whsec_${randomBytes(32).toString('base64')}`
      await this.deps.webhookSecrets.put(orgId, binding.id, signingToken)
    }
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
    // The binding just left the servable states — pull the project's compiled
    // rules off the relay pool now, not when cleanup eventually completes.
    this.deps.onConverged?.(orgId, binding.projectId)
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
      // §19.4: this project's memberships go, but PATs are per account, not per
      // membership — an account still serving another bound project in its root
      // keeps them. Only an account left with nothing bound retires.
      // Release only on positive evidence: no managed membership survives here,
      // and every emptied account is provably gone from its root.
      const unbound = await this.deps.accounts.unbindBinding(orgId, bindingId, binding.projectId, token)
      if (unbound !== 'retired') {
        // A pending deletion is in flight, not refused: the retirement sweep
        // closes it out and this removal finishes on the next attempt.
        throw new GitlabCleanupUnverified(
          unbound === 'deletion_pending' ? DELETION_PENDING_REASON : 'account_cleanup_incomplete'
        )
      }
    } catch (e) {
      const reason =
        e instanceof GitlabCleanupUnverified
          ? e.reason
          : e instanceof GitlabApiError
            ? `gitlab_${e.status || 'unreachable'}`
            : 'cleanup_failed'
      await this.deps.bindings.update(orgId, bindingId, { state: 'cleanup_pending', stateReason: reason })
      return { removed: false, reason }
    }
    // Verified-complete external cleanup: the local rows and the claim go together.
    await this.deps.bindings.removeWithClaim(orgId, bindingId, binding.projectId)
    return { removed: true }
  }
}

/** Someone else holds a fence this run needs: the binding lease, or — inside the
 *  run — an account lease or generation the §7.2 loser must come back for. */
function contended(outcome: ProvisionOutcome): boolean {
  if (outcome.state === 'busy') return true
  return outcome.state !== 'ready' && outcome.retryable === true
}

/** A definitively absent external resource IS cleaned up; anything else rethrows. */
function swallow404(e: unknown): void {
  if (e instanceof GitlabApiError && e.code === 'NOT_FOUND') return
  throw e
}

/** The sealed webhook signing key is relay material; this module never returns it. */
export type { GitlabWebhookEvents }
export const GITLAB_WEBHOOK_PATH = '/webhooks/gitlab'
