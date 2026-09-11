/**
 * Gitea repository provisioning saga + external cleanup (gitea-integration.md §6, §7, §4.4).
 *
 * The GitLab saga with the account and membership steps removed: refresh the repository by numeric
 * id, re-check the bot's `admin`, install or reconcile the managed webhook against provider truth,
 * read its stored events back by subset, fire a test delivery and wait for the relay to observe it.
 *
 * Fail-closed rules carried from the design: the webhook is owned by the stored id or the exact
 * managed URL, never adopted by a similar one; cleanup that cannot complete leaves `cleanup_pending`
 * and RETAINS the deployment-global claim; a definite token rejection degrades every binding of the
 * connection (§4.3); a bot demoted below `admin` keeps serving but repair is suspended (§4.4).
 *
 * NEVER log the token or the signing keys.
 */
import { randomBytes } from 'node:crypto'
import type { Clock } from '../domain/clock.js'
import type {
  CodeHostRepositoryRepo,
  GiteaConnectionRepo,
  GiteaRepositoryBindingRecord,
  GiteaRepositoryBindingRepo,
  GiteaWebhookSecretStore
} from '../persistence/ports.js'
import {
  GiteaApiError,
  giteaCreateWebhook,
  giteaDeleteWebhook,
  giteaListWebhooks,
  giteaPageSize,
  giteaRepositoryById,
  giteaTestWebhook,
  giteaUpdateWebhook,
  giteaVersion,
  giteaWebhook,
  isGiteaAuthRejection,
  splitGiteaRepoPath,
  type GiteaApiClient,
  type GiteaRepository,
  type GiteaWebhook
} from './api.js'
import {
  ADMIN_LOST_REASON,
  afterDeliveryVerified,
  readyOutcome,
  TOKEN_REJECTED_REASON,
  WEBHOOK_EVENTS_UNSUPPORTED_REASON
} from './binding-state.js'
import { GiteaConnectDenied } from './connection.service.js'
import { giteaWebhookEventsHash, giteaWebhookEventsMissing } from './webhook-events.js'
import { GITEA_VERSION_UNSUPPORTED_REASON, parseGiteaVersion } from './version.js'

/** The exclusive provisioning lease a run holds across its provider writes. */
export const PROVISION_LEASE_MS = 10 * 60 * 1000
/** The managed webhook's endpoint on the relay (§7). */
export const GITEA_WEBHOOK_PATH = '/webhooks/gitea'
/** How long a fresh install waits for the relay to report the test delivery (§6 step 4). */
export const DEFAULT_TEST_DELIVERY_WAIT_MS = 5_000
const TEST_DELIVERY_POLL_MS = 250

/** The claim fence was lost mid-run (cleanup or takeover won). */
export class GiteaClaimFenceLost extends Error {
  constructor() {
    super('the deployment-global repository claim fence was lost')
    this.name = 'GiteaClaimFenceLost'
  }
}

type RotationOutcome = { rotated: boolean; promoted?: boolean; reason?: string }
type RotationSuccessor = { token: string; successorId: bigint }

export type ProvisionOutcome =
  | { state: 'ready'; reason: string | null }
  | { state: 'admin_degraded' | 'runtime_degraded'; reason: string; retryable?: boolean }
  /** A live peer owns the claim: nothing was written and no binding state was overwritten. */
  | { state: 'busy'; reason: string }

/** The token source and the rejection sink — the connection service, narrowed. */
export interface GiteaTokenSource {
  withToken(orgId: string, connectionId: string): Promise<string>
  onAuthRejected(orgId: string, connectionId: string): Promise<void>
}

export interface ConvergeRepositoryOpts {
  /** Contention retries before giving up on this pass; a request-inline caller passes a small number. */
  attempts?: number
  /** False ⇒ this IS the follow-up; it does not schedule another. */
  followUp?: boolean
}

interface ConvergeRun {
  done: Promise<void>
  again: boolean
}

/** Background convergence outwaits a full 10-minute peer lease plus slack. */
const BACKGROUND_CONVERGE_ATTEMPTS = 92
/** A contended pass re-drives itself after this, so nothing needs a second Repair. */
const FOLLOW_UP_DELAY_MS = 30 * 1000

export interface GiteaProvisionerDeps {
  connections: Pick<GiteaConnectionRepo, 'get' | 'update'>
  tokens: GiteaTokenSource
  bindings: GiteaRepositoryBindingRepo
  webhookSecrets: GiteaWebhookSecretStore
  catalog: CodeHostRepositoryRepo
  clock: Clock
  /** Public relay origin the managed webhook URL derives from; absent ⇒ the webhook step reports a configuration reason. */
  publicRelayUrl?: string
  /** The enabled-hook subscription union for a repository; null ⇒ no webhook wanted (§7). */
  desiredWebhookEvents: (orgId: string, repoId: bigint) => Promise<readonly string[] | null>
  /** AWAITED under the lease: converge dependent workspace clone URLs to the freshly read facts. */
  syncWorkspacePaths?: (orgId: string, repoId: bigint, repoPath: string, cloneUrl?: string) => Promise<void>
  /** Recompile the repository's rules. AWAITED before a test delivery: the relay verifies only what it holds a key for. */
  onConverged?: (orgId: string, repoId: bigint) => Promise<void> | void
  api: GiteaApiClient
  testDeliveryWaitMs?: number
  log?: { warn(obj: object, msg: string): void }
}

export class GiteaProvisioner {
  /** One convergence per repository at a time, keyed `<org>:<repo>`; late callers join it and ask for a trailing pass. */
  private readonly convergeRuns = new Map<string, ConvergeRun>()
  private readonly pendingFollowUps = new Set<string>()

  constructor(private readonly deps: GiteaProvisionerDeps) {}

  /** Converge one binding to ready; persists the outcome state on the binding. */
  async provision(orgId: string, bindingId: string, opts: { followUp?: boolean } = {}): Promise<ProvisionOutcome> {
    const followUp = opts.followUp !== false
    const binding = await this.deps.bindings.get(orgId, bindingId)
    if (!binding) return { state: 'admin_degraded', reason: 'binding_missing' }
    const connection = await this.deps.connections.get(orgId, binding.connectionId)
    if (!connection) return this.degrade(orgId, bindingId, 'admin_degraded', 'no_connection')
    // A rejected token is a settled verdict (§4.3): no provider call until a replacement lands.
    if (connection.state === 'token_rejected') {
      return this.degrade(orgId, bindingId, 'runtime_degraded', TOKEN_REJECTED_REASON)
    }
    const owner = randomBytes(9).toString('base64url')
    const nowMs = this.deps.clock.now()
    if (
      !(await this.deps.bindings.markProviderMutationStarted(
        orgId,
        bindingId,
        binding.repoId,
        owner,
        new Date(nowMs + PROVISION_LEASE_MS),
        new Date(nowMs)
      ))
    ) {
      if (followUp) await this.scheduleFollowUp(orgId, bindingId, binding.repoId)
      return { state: 'busy', reason: 'provisioning_or_cleanup_in_progress' }
    }
    try {
      const token = await this.deps.tokens.withToken(orgId, binding.connectionId)
      return await this.convergeAndPersist(orgId, binding, token, owner, followUp)
    } catch (e) {
      return this.failed(orgId, binding, e)
    } finally {
      await this.deps.bindings.endProviderMutation(orgId, bindingId, binding.repoId, owner).catch(() => {})
    }
  }

  /** Does this process still owe convergence work in the organization? */
  hasPendingWork(orgId: string): boolean {
    const mine = (key: string): boolean => key.startsWith(`${orgId}:`)
    return [...this.convergeRuns.keys()].some(mine) || [...this.pendingFollowUps].some(mine)
  }

  private async scheduleFollowUp(orgId: string, bindingId: string, repoId: bigint): Promise<void> {
    // AWAITED: the durable obligation is what lets a restart still find the work.
    await this.deps.bindings
      .markConvergeOwed(orgId, bindingId, new Date(this.deps.clock.now()))
      .catch((err) => this.deps.log?.warn({ err, bindingId }, 'gitea converge obligation not recorded'))
    const key = `${orgId}:${repoId}`
    if (this.pendingFollowUps.has(key)) return
    this.pendingFollowUps.add(key)
    this.deps.clock.setTimeout(() => {
      this.pendingFollowUps.delete(key)
      void (async () => {
        const owed = await this.deps.bindings.byRepo(orgId, repoId)
        if (!owed || owed.convergeOwedAt === null) return
        await this.convergeRepository(orgId, repoId, { followUp: false })
      })().catch((err) => this.deps.log?.warn({ err, repoId: repoId.toString() }, 'gitea converge follow-up failed'))
    }, FOLLOW_UP_DELAY_MS)
  }

  /** Converge a repository after a write changed what consumes it; a contended pass is outwaited, never dropped. */
  async convergeRepository(orgId: string, repoId: bigint, opts: ConvergeRepositoryOpts = {}): Promise<void> {
    const key = `${orgId}:${repoId}`
    const running = this.convergeRuns.get(key)
    if (running) {
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
          await this.convergeRepositoryOnce(orgId, repoId, opts)
        } while (entry.again)
      } finally {
        this.convergeRuns.delete(key)
      }
    })()
    await entry.done
  }

  /** Re-drive the bindings a contended pass still owes — the half that survives a restart. */
  async sweepOwedConvergences(quietMs: number, limit = 50): Promise<void> {
    const before = new Date(this.deps.clock.now() - quietMs)
    for (const binding of await this.deps.bindings.listConvergeOwed(before, limit)) {
      await this.convergeRepository(binding.orgId, binding.repoId, { followUp: false })
    }
  }

  private async convergeRepositoryOnce(orgId: string, repoId: bigint, opts: ConvergeRepositoryOpts): Promise<void> {
    const binding = await this.deps.bindings.byRepo(orgId, repoId)
    if (!binding) return
    const attempts = opts.attempts ?? BACKGROUND_CONVERGE_ATTEMPTS
    let outcome = await this.provision(orgId, binding.id, { followUp: false })
    for (let attempt = 0; contended(outcome) && attempt < attempts; attempt++) {
      const delayMs = Math.min(8_000, 1_000 * 2 ** attempt)
      await new Promise<void>((resolve) => this.deps.clock.setTimeout(() => resolve(), delayMs))
      outcome = await this.provision(orgId, binding.id, { followUp: false })
    }
    if (!contended(outcome)) return
    this.deps.log?.warn({ repoId: repoId.toString() }, 'gitea converge still contended — retrying later')
    if (opts.followUp !== false) await this.scheduleFollowUp(orgId, binding.id, repoId)
  }

  /** Converge under an already-held lease and persist the outcome on the binding. */
  private async convergeAndPersist(
    orgId: string,
    binding: GiteaRepositoryBindingRecord,
    token: string,
    owner: string,
    followUp = true
  ): Promise<ProvisionOutcome> {
    try {
      const outcome = await this.converge(orgId, binding, token, owner)
      const settled = !contended(outcome) && binding.convergeOwedAt !== null ? { convergeOwedAt: null } : {}
      if (outcome.state === 'ready') {
        await this.deps.bindings.update(orgId, binding.id, { state: 'ready', stateReason: outcome.reason, ...settled })
      } else if (outcome.state !== 'busy' && !contended(outcome)) {
        await this.deps.bindings.update(orgId, binding.id, {
          state: outcome.state,
          stateReason: outcome.reason,
          ...settled
        })
      }
      if (contended(outcome) && followUp) await this.scheduleFollowUp(orgId, binding.id, binding.repoId)
      await this.rebroadcast(orgId, binding.repoId)
      return outcome
    } catch (e) {
      return this.failed(orgId, binding, e)
    }
  }

  /** Map a thrown failure to the binding's verdict; a token rejection also degrades its siblings (§4.3). */
  private async failed(orgId: string, binding: GiteaRepositoryBindingRecord, e: unknown): Promise<ProvisionOutcome> {
    if (isGiteaAuthRejection(e)) {
      await this.deps.tokens.onAuthRejected(orgId, binding.connectionId)
      return this.degrade(orgId, binding.id, 'runtime_degraded', TOKEN_REJECTED_REASON)
    }
    // The connection is already waiting for a replacement: the binding reads the same verdict.
    if (e instanceof GiteaConnectDenied && e.code === TOKEN_REJECTED_REASON) {
      return this.degrade(orgId, binding.id, 'runtime_degraded', TOKEN_REJECTED_REASON)
    }
    const reason =
      e instanceof GiteaClaimFenceLost
        ? 'claim_fence_lost'
        : e instanceof GiteaConnectDenied
          ? e.code
          : e instanceof GiteaApiError
            ? e.code === 'FORBIDDEN'
              ? ADMIN_LOST_REASON
              : `gitea_${e.status || 'unreachable'}`
            : 'admin_unavailable'
    this.deps.log?.warn({ bindingId: binding.id, reason }, 'gitea provisioning failed')
    return this.degrade(orgId, binding.id, 'admin_degraded', reason)
  }

  private async degrade(
    orgId: string,
    bindingId: string,
    state: 'admin_degraded' | 'runtime_degraded',
    reason: string
  ): Promise<ProvisionOutcome> {
    // A settled verdict asking for human repair owes no automatic convergence any more.
    await this.deps.bindings.update(orgId, bindingId, { state, stateReason: reason, convergeOwedAt: null })
    return { state, reason }
  }

  private renewLease(orgId: string, binding: GiteaRepositoryBindingRecord, owner: string): Promise<boolean> {
    return this.deps.bindings.renewProviderLease(
      orgId,
      binding.id,
      binding.repoId,
      owner,
      new Date(this.deps.clock.now() + PROVISION_LEASE_MS)
    )
  }

  private async rebroadcast(orgId: string, repoId: bigint): Promise<void> {
    try {
      await this.deps.onConverged?.(orgId, repoId)
    } catch (err) {
      this.deps.log?.warn({ err, repoId: repoId.toString() }, 'gitea converge fan-out failed')
    }
  }

  private managedUrl(): string | undefined {
    return this.deps.publicRelayUrl ? `${this.deps.publicRelayUrl.replace(/\/$/, '')}${GITEA_WEBHOOK_PATH}` : undefined
  }

  /** §6 step 2: the repository's mutable facts, keyed by its numeric id, onto every durable replica. */
  private async syncRepositoryFacts(
    orgId: string,
    bindingId: string,
    repoId: bigint,
    repo: GiteaRepository
  ): Promise<void> {
    await this.deps.bindings.update(orgId, bindingId, {
      repoPath: repo.full_name,
      cloneUrl: repo.clone_url ?? null,
      defaultBranch: repo.default_branch ?? null
    })
    await this.deps.catalog.upsert({
      orgId,
      provider: 'gitea',
      externalId: repoId,
      displayPath: repo.full_name,
      ...(repo.clone_url ? { cloneUrl: repo.clone_url } : {}),
      ...(repo.default_branch ? { defaultBranch: repo.default_branch } : {})
    })
    await this.deps.syncWorkspacePaths?.(orgId, repoId, repo.full_name, repo.clone_url)
  }

  private async converge(
    orgId: string,
    binding: GiteaRepositoryBindingRecord,
    token: string,
    owner: string
  ): Promise<ProvisionOutcome> {
    const { api } = this.deps
    // 0. The §3 floor, re-read unauthenticated and recorded on the connection; below it, nothing is provisioned.
    const version = parseGiteaVersion(await giteaVersion(api))
    await this.deps.connections.update(orgId, binding.connectionId, { instanceVersion: version.raw })
    if (!version.supported) return { state: 'admin_degraded', reason: GITEA_VERSION_UNSUPPORTED_REASON }
    // 1. Refresh the mutable facts by numeric id (rename-proof, §6 step 2).
    const repo = await giteaRepositoryById(token, binding.repoId, api)
    if (!repo) return { state: 'admin_degraded', reason: 'repository_not_accessible' }
    await this.syncRepositoryFacts(orgId, binding.id, binding.repoId, repo)
    const path = splitGiteaRepoPath(repo.full_name)
    if (!path) return { state: 'admin_degraded', reason: 'repository_path_unreadable' }
    // 2. §4.4: a bot demoted below `admin` keeps serving, but every webhook write is suspended.
    if (repo.permissions?.admin !== true) return { state: 'admin_degraded', reason: ADMIN_LOST_REASON }
    const pageSize = await giteaPageSize(api)
    // 3. The managed webhook, converged against PROVIDER truth to the union current at run end.
    let applied: string | null = null
    let verified = binding.lastVerifiedDeliveryAt !== null
    for (let pass = 0; pass < 3; pass++) {
      const events = await this.deps.desiredWebhookEvents(orgId, binding.repoId)
      const want = events ? giteaWebhookEventsHash(events) : 'none'
      if (applied === want) break
      let fresh = (await this.deps.bindings.get(orgId, binding.id)) ?? binding
      if (!(await this.renewLease(orgId, fresh, owner))) return { state: 'admin_degraded', reason: 'claim_fence_lost' }
      const hooks = await giteaListWebhooks(token, path.owner, path.repo, api, pageSize)
      const present = (id: bigint | null): boolean => id !== null && hooks.some((hook) => BigInt(hook.id) === id)
      // Local ids are never proof: one gone at the provider is forgotten before anything is written to it.
      if (fresh.nextWebhookId !== null && !present(fresh.nextWebhookId)) {
        // The rotation successor is gone: the rotation is abandoned and the old key stays current.
        const keys = await this.deps.webhookSecrets.get(orgId, binding.id)
        if (keys?.next) await this.deps.webhookSecrets.put(orgId, binding.id, { current: keys.current, next: null })
        fresh = (await this.deps.bindings.update(orgId, binding.id, { nextWebhookId: null })) ?? fresh
      }
      if (fresh.webhookId !== null && !present(fresh.webhookId)) {
        if (fresh.nextWebhookId !== null) {
          // The old webhook went while its successor lives: the successor is simply promoted.
          await this.promoteKeys(fresh)
          fresh = (await this.deps.bindings.get(orgId, binding.id)) ?? fresh
        } else {
          fresh =
            (await this.deps.bindings.update(orgId, binding.id, {
              webhookId: null,
              desiredEventsHash: null,
              lastVerifiedDeliveryAt: null
            })) ?? fresh
        }
      }
      if (events) {
        const outcome = await this.convergeWebhook(orgId, fresh, token, path, events, owner, hooks)
        if ('degraded' in outcome) return outcome.degraded
        verified = outcome.verified
      } else {
        // No enabled hook wants ingress: every managed webhook — both recorded ids AND any crash-left hook at our exact URL — goes.
        const url = this.managedUrl()
        for (const hook of hooks) {
          const id = BigInt(hook.id)
          const ours =
            id === fresh.webhookId || id === fresh.nextWebhookId || (url !== undefined && hook.config?.url === url)
          if (!ours) continue
          await giteaDeleteWebhook(token, path.owner, path.repo, id, api).catch(swallow404)
        }
        await this.deps.webhookSecrets.delete(orgId, binding.id)
        await this.deps.bindings.update(orgId, binding.id, {
          webhookId: null,
          nextWebhookId: null,
          desiredEventsHash: null,
          lastVerifiedDeliveryAt: null
        })
        // Nothing to verify without a webhook, so the warning has nothing to say.
        verified = true
      }
      applied = want
    }
    return { state: 'ready', reason: readyOutcome(verified).stateReason }
  }

  /** Install or reconcile the managed webhook (§7); a fresh one is tested and must be seen by the relay. */
  private async convergeWebhook(
    orgId: string,
    binding: GiteaRepositoryBindingRecord,
    token: string,
    path: { owner: string; repo: string },
    events: readonly string[],
    owner: string,
    hooks: readonly GiteaWebhook[]
  ): Promise<{ degraded: ProvisionOutcome } | { verified: boolean }> {
    const url = this.managedUrl()
    if (!url) return { degraded: { state: 'admin_degraded', reason: 'relay_url_unconfigured' } }
    if (!(await this.renewLease(orgId, binding, owner))) {
      return { degraded: { state: 'admin_degraded', reason: 'claim_fence_lost' } }
    }
    const { api } = this.deps
    // The signing key is STABLE across converges — compiled rules carry it inline. Sealed BEFORE any provider call.
    let keys = await this.deps.webhookSecrets.get(orgId, binding.id)
    if (!keys) {
      keys = { current: randomBytes(32).toString('hex'), next: null }
      await this.deps.webhookSecrets.put(orgId, binding.id, keys)
    }
    // Mid-rotation the successor is the live webhook; the old one waits inactive until a verified delivery retires it (§7).
    const live = binding.nextWebhookId ?? binding.webhookId
    const fresh = live === null
    // A hook at OUR exact URL that no column records (a lost create answer) can never verify and cannot be re-keyed: retire it.
    for (const stray of hooks) {
      const id = BigInt(stray.id)
      if (stray.config?.url !== url || id === binding.webhookId || id === binding.nextWebhookId) continue
      await giteaDeleteWebhook(token, path.owner, path.repo, id, api).catch(swallow404)
    }
    let webhookId: bigint
    let stored: GiteaWebhook
    if (live === null) {
      stored = await giteaCreateWebhook(token, path.owner, path.repo, { url, secret: keys.current, events }, api)
      webhookId = BigInt(stored.id)
      // Recorded the moment the create answers, before the read-back can fail: an unbind then deletes it by id.
      await this.deps.bindings.update(orgId, binding.id, { webhookId, lastVerifiedDeliveryAt: null })
    } else {
      webhookId = live
      stored = await giteaUpdateWebhook(token, path.owner, path.repo, webhookId, { url, events, active: true }, api)
    }
    // §7: Gitea answers 201 for a name it does not know and drops it, so the stored events are read back by subset.
    const readBack = (await giteaWebhook(token, path.owner, path.repo, webhookId, api)) ?? stored
    const missing = giteaWebhookEventsMissing(events, readBack.events ?? [])
    if (missing.length > 0) {
      this.deps.log?.warn({ bindingId: binding.id, missing }, 'gitea stored fewer webhook events than asked')
      await this.deps.bindings.update(orgId, binding.id, { desiredEventsHash: null })
      return { degraded: { state: 'admin_degraded', reason: WEBHOOK_EVENTS_UNSUPPORTED_REASON } }
    }
    await this.deps.bindings.update(orgId, binding.id, { desiredEventsHash: giteaWebhookEventsHash(events) })
    if (!fresh) return { verified: binding.lastVerifiedDeliveryAt !== null }
    // §6 step 4: the relay can only verify a delivery under a rule it holds, so the rules go out first.
    await this.rebroadcast(orgId, binding.repoId)
    const firedAt = new Date(this.deps.clock.now())
    try {
      await giteaTestWebhook(token, path.owner, path.repo, webhookId, api)
    } catch (e) {
      this.deps.log?.warn(
        { bindingId: binding.id, status: e instanceof GiteaApiError ? e.status : undefined },
        'gitea webhook test delivery failed'
      )
      return { verified: false }
    }
    return { verified: await this.awaitTestDelivery(orgId, binding.id, firedAt) }
  }

  /** Poll for the relay's observation of the test delivery within the bounded wait. */
  private async awaitTestDelivery(orgId: string, bindingId: string, firedAt: Date): Promise<boolean> {
    const deadline = this.deps.clock.now() + (this.deps.testDeliveryWaitMs ?? DEFAULT_TEST_DELIVERY_WAIT_MS)
    for (;;) {
      const current = await this.deps.bindings.get(orgId, bindingId)
      const seen = current?.lastVerifiedDeliveryAt
      if (seen && seen.getTime() >= firedAt.getTime()) return true
      if (this.deps.clock.now() >= deadline) return false
      await new Promise<void>((resolve) => this.deps.clock.setTimeout(() => resolve(), TEST_DELIVERY_POLL_MS))
    }
  }

  /** §7 rotation: an edit cannot re-key a webhook, so a successor under the next key replaces it once a delivery verifies under that key. */
  async rotateWebhookSecret(orgId: string, bindingId: string): Promise<RotationOutcome> {
    const binding = await this.deps.bindings.get(orgId, bindingId)
    if (!binding) return { rotated: false, reason: 'binding_missing' }
    if (binding.state === 'cleanup_pending' || binding.webhookId === null) {
      return { rotated: false, reason: 'no_managed_webhook' }
    }
    const path = splitGiteaRepoPath(binding.repoPath)
    if (!path) return { rotated: false, reason: 'repository_path_unreadable' }
    const url = this.managedUrl()
    if (!url) return { rotated: false, reason: 'relay_url_unconfigured' }
    const successor = await this.installSuccessor(orgId, binding, path, url)
    if (!('token' in successor)) return successor
    // Fired with the lease released: the relay's observation promotes under that same lease.
    try {
      await giteaTestWebhook(successor.token, path.owner, path.repo, successor.successorId, this.deps.api)
    } catch (e) {
      return this.rotationFailed(orgId, binding, e)
    }
    return { rotated: true, promoted: await this.awaitPromotion(orgId, bindingId) }
  }

  /** Under the binding lease: seal the next key, create the successor webhook, distribute both keys, deactivate the old webhook. */
  private async installSuccessor(
    orgId: string,
    binding: GiteaRepositoryBindingRecord,
    path: { owner: string; repo: string },
    url: string
  ): Promise<RotationSuccessor | RotationOutcome> {
    const owner = randomBytes(9).toString('base64url')
    const nowMs = this.deps.clock.now()
    if (
      !(await this.deps.bindings.markProviderMutationStarted(
        orgId,
        binding.id,
        binding.repoId,
        owner,
        new Date(nowMs + PROVISION_LEASE_MS),
        new Date(nowMs)
      ))
    ) {
      return { rotated: false, reason: 'provisioning_or_cleanup_in_progress' }
    }
    const { api } = this.deps
    try {
      const token = await this.deps.tokens.withToken(orgId, binding.connectionId)
      const keys = await this.deps.webhookSecrets.get(orgId, binding.id)
      if (!keys) return { rotated: false, reason: 'signing_key_missing' }
      const events = await this.deps.desiredWebhookEvents(orgId, binding.repoId)
      if (!events) return { rotated: false, reason: 'no_managed_webhook' }
      let successorId = binding.nextWebhookId
      let stored = successorId === null ? null : await giteaWebhook(token, path.owner, path.repo, successorId, api)
      if (successorId !== null && stored !== null) {
        // A recorded successor (a rotation cut short) is adopted under its sealed `next` key and re-converged to the union.
        stored = await giteaUpdateWebhook(token, path.owner, path.repo, successorId, { url, events, active: true }, api)
      } else {
        const next = randomBytes(32).toString('hex')
        await this.deps.webhookSecrets.put(orgId, binding.id, { current: keys.current, next })
        stored = await giteaCreateWebhook(token, path.owner, path.repo, { url, secret: next, events }, api)
        successorId = BigInt(stored.id)
        // Recorded the moment the create answers, before any call that can fail: a retry adopts it, an unbind deletes it.
        await this.deps.bindings.update(orgId, binding.id, { nextWebhookId: successorId })
      }
      const readBack = (await giteaWebhook(token, path.owner, path.repo, successorId, api)) ?? stored
      if (giteaWebhookEventsMissing(events, readBack.events ?? []).length > 0) {
        // A successor that lost subscriptions must not replace a working webhook: undo, forgetting it only once it is gone.
        await giteaDeleteWebhook(token, path.owner, path.repo, successorId, api).catch(swallow404)
        await this.deps.webhookSecrets.put(orgId, binding.id, { current: keys.current, next: null })
        await this.deps.bindings.update(orgId, binding.id, { nextWebhookId: null })
        return { rotated: false, reason: WEBHOOK_EVENTS_UNSUPPORTED_REASON }
      }
      // Both keys reach the relays before anything is delivered under the successor.
      await this.rebroadcast(orgId, binding.repoId)
      // From here on only the successor receives live events; the old webhook's in-flight deliveries still verify.
      if (binding.webhookId !== null) {
        await giteaUpdateWebhook(
          token,
          path.owner,
          path.repo,
          binding.webhookId,
          { url, events, active: false },
          api
        ).catch(swallow404)
      }
      return { token, successorId }
    } catch (e) {
      return this.rotationFailed(orgId, binding, e)
    } finally {
      await this.deps.bindings.endProviderMutation(orgId, binding.id, binding.repoId, owner).catch(() => {})
    }
  }

  /** A rotation failure leaves whatever overlap exists standing; the next attempt resumes from the recorded successor. */
  private async rotationFailed(
    orgId: string,
    binding: GiteaRepositoryBindingRecord,
    e: unknown
  ): Promise<RotationOutcome> {
    if (isGiteaAuthRejection(e)) {
      await this.deps.tokens.onAuthRejected(orgId, binding.connectionId)
      return { rotated: false, reason: TOKEN_REJECTED_REASON }
    }
    const reason = e instanceof GiteaApiError ? `gitea_${e.status || 'unreachable'}` : 'rotation_failed'
    this.deps.log?.warn({ bindingId: binding.id, reason }, 'gitea webhook secret rotation failed')
    return { rotated: false, reason }
  }

  /** Poll for the successor's promotion within the bounded wait; false leaves the overlap standing. */
  private async awaitPromotion(orgId: string, bindingId: string): Promise<boolean> {
    const deadline = this.deps.clock.now() + (this.deps.testDeliveryWaitMs ?? DEFAULT_TEST_DELIVERY_WAIT_MS)
    for (;;) {
      const current = await this.deps.bindings.get(orgId, bindingId)
      if (!current || current.nextWebhookId === null) return true
      if (this.deps.clock.now() >= deadline) return false
      await new Promise<void>((resolve) => this.deps.clock.setTimeout(() => resolve(), TEST_DELIVERY_POLL_MS))
    }
  }

  /** The relay observed one verified delivery (§6 step 4, §7): mark the binding verified, clear the warning, promote a successor it verified under. */
  async observeDelivery(input: {
    repoId: bigint
    at: Date
    verifiedWith?: 'current' | 'next'
  }): Promise<GiteaRepositoryBindingRecord | null> {
    const binding = await this.deps.bindings.markDeliveryVerified(input.repoId, input.at)
    if (!binding) return null
    const next = afterDeliveryVerified(binding.state, binding.stateReason)
    if (next.stateReason !== binding.stateReason) {
      await this.deps.bindings.update(binding.orgId, binding.id, { stateReason: next.stateReason })
    }
    if (input.verifiedWith === 'next') await this.promoteSuccessor(binding)
    return (await this.deps.bindings.get(binding.orgId, binding.id)) ?? binding
  }

  /** Retire the old webhook and promote the successor under the binding lease; a busy lease defers to the next delivery. */
  private async promoteSuccessor(binding: GiteaRepositoryBindingRecord): Promise<void> {
    if (binding.nextWebhookId === null) return
    const path = splitGiteaRepoPath(binding.repoPath)
    if (!path) return
    const owner = randomBytes(9).toString('base64url')
    const nowMs = this.deps.clock.now()
    if (
      !(await this.deps.bindings.markProviderMutationStarted(
        binding.orgId,
        binding.id,
        binding.repoId,
        owner,
        new Date(nowMs + PROVISION_LEASE_MS),
        new Date(nowMs)
      ))
    ) {
      return
    }
    try {
      const token = await this.deps.tokens.withToken(binding.orgId, binding.connectionId)
      if (binding.webhookId !== null) {
        await giteaDeleteWebhook(token, path.owner, path.repo, binding.webhookId, this.deps.api).catch(swallow404)
      }
      await this.promoteKeys(binding)
    } catch (e) {
      // The overlap stands; the next delivery verified under the successor retries the retirement.
      if (isGiteaAuthRejection(e)) await this.deps.tokens.onAuthRejected(binding.orgId, binding.connectionId)
      this.deps.log?.warn({ bindingId: binding.id }, 'gitea webhook successor promotion deferred')
    } finally {
      await this.deps.bindings.endProviderMutation(binding.orgId, binding.id, binding.repoId, owner).catch(() => {})
    }
  }

  /** The local half of a promotion: the successor becomes THE webhook and its key the current one. */
  private async promoteKeys(binding: GiteaRepositoryBindingRecord): Promise<void> {
    const keys = await this.deps.webhookSecrets.get(binding.orgId, binding.id)
    if (keys?.next) await this.deps.webhookSecrets.put(binding.orgId, binding.id, { current: keys.next, next: null })
    await this.deps.bindings.update(binding.orgId, binding.id, {
      webhookId: binding.nextWebhookId,
      nextWebhookId: null
    })
    await this.rebroadcast(binding.orgId, binding.repoId)
  }

  /** §6 unbind: authority off first, then every managed webhook (recorded ids, then the managed URL), then the rows and the claim; a rejected token parks it. */
  async disconnect(orgId: string, bindingId: string): Promise<{ removed: boolean; reason?: string }> {
    const binding = await this.deps.bindings.get(orgId, bindingId)
    if (!binding) return { removed: false, reason: 'binding_missing' }
    if (!(await this.deps.bindings.beginCleanup(orgId, bindingId, binding.repoId, new Date(this.deps.clock.now())))) {
      return { removed: false, reason: 'provisioning_in_progress' }
    }
    // The binding just left the servable states: pull its compiled rules off the relay pool now.
    await this.rebroadcast(orgId, binding.repoId)
    const path = splitGiteaRepoPath(binding.repoPath)
    // A webhook the path cannot address cannot be deleted: park rather than release the claim over it.
    if (!path && (binding.webhookId !== null || binding.nextWebhookId !== null)) {
      await this.deps.bindings.update(orgId, bindingId, {
        state: 'cleanup_pending',
        stateReason: 'repository_path_unreadable'
      })
      return { removed: false, reason: 'repository_path_unreadable' }
    }
    try {
      const token = await this.deps.tokens.withToken(orgId, binding.connectionId)
      if (path) {
        const { api } = this.deps
        for (const id of [binding.webhookId, binding.nextWebhookId]) {
          if (id !== null) await giteaDeleteWebhook(token, path.owner, path.repo, id, api).catch(swallow404)
        }
        // Then every hook at OUR exact URL: a create whose answer was lost is recorded nowhere but there.
        const url = this.managedUrl()
        if (url) {
          const pageSize = await giteaPageSize(api)
          for (const hook of await giteaListWebhooks(token, path.owner, path.repo, api, pageSize)) {
            if (hook.config?.url === url) {
              await giteaDeleteWebhook(token, path.owner, path.repo, BigInt(hook.id), api).catch(swallow404)
            }
          }
        }
      }
    } catch (e) {
      let reason: string
      if (isGiteaAuthRejection(e)) {
        await this.deps.tokens.onAuthRejected(orgId, binding.connectionId)
        reason = TOKEN_REJECTED_REASON
      } else if (e instanceof GiteaApiError) {
        reason = e.code === 'FORBIDDEN' ? ADMIN_LOST_REASON : `gitea_${e.status || 'unreachable'}`
      } else {
        reason = e instanceof GiteaConnectDenied ? e.code : 'cleanup_failed'
      }
      await this.deps.bindings.update(orgId, bindingId, { state: 'cleanup_pending', stateReason: reason })
      return { removed: false, reason }
    }
    // Verified-complete external cleanup: the sealed keys, the local rows and the claim go together.
    await this.deps.webhookSecrets.delete(orgId, bindingId)
    await this.deps.bindings.removeWithClaim(orgId, bindingId, binding.repoId)
    return { removed: true }
  }
}

/** Someone else holds the claim fence this run needs. */
function contended(outcome: ProvisionOutcome): boolean {
  if (outcome.state === 'busy') return true
  return outcome.state !== 'ready' && outcome.retryable === true
}

/** A definitively absent external resource IS cleaned up; anything else rethrows. */
function swallow404(e: unknown): void {
  if (e instanceof GiteaApiError && e.code === 'NOT_FOUND') return
  throw e
}
