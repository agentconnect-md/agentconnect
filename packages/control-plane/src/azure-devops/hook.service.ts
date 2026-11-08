// Service hook subscriptions of Azure DevOps bindings (azure-devops-integration.md §11.1, §11.2): convergence, the keyed rotation with its barrier, promotion, and removal. NEVER log a key.
import { randomBytes } from 'node:crypto'
import type { AzureDevOpsDeliveryKind } from '@agentconnect.md/protocol'
import type { Clock } from '../domain/clock.js'
import type {
  AzureDevOpsConnectionRecord,
  AzureDevOpsConnectionRepo,
  AzureDevOpsHookKeys,
  AzureDevOpsHookReason,
  AzureDevOpsHookRepo,
  AzureDevOpsHookSubscriptionRecord,
  AzureDevOpsRepositoryBindingRecord,
  AzureDevOpsRepositoryBindingRepo,
  HookRecord
} from '../persistence/ports.js'
import { AzureDevOpsApiError, type AzureDevOpsApiClient } from './api.js'
import type { AzureDevOpsConnectionService } from './connection.service.js'
import { AzureDevOpsConnectDenied } from './connection.service.js'
import {
  createSubscription,
  deleteSubscription,
  evaluateServiceHookGrant,
  readSubscription,
  replaceSubscription,
  subscriptionBody,
  subscriptionDropping,
  subscriptionDrifted,
  type AzureDevOpsSubscriptionTarget
} from './hooks-api.js'

/** The relay's Azure DevOps endpoint (§11.3). */
export const AZURE_DEVOPS_HOOK_PATH = '/webhooks/azure-devops'
/** A promoted-away key verifies queued retries this long: Azure DevOps's retry schedule (§11.2). */
export const PREVIOUS_KEY_TTL_MS = 36 * 60 * 60 * 1000
/** The binding's subscription lease a convergence or rotation holds across its Azure DevOps writes. */
export const HOOK_LEASE_MS = 5 * 60 * 1000
/** A contended pass re-drives itself after this. */
const FOLLOW_UP_DELAY_MS = 30 * 1000

/** The refusal a hook save on a project without the grant gets (§11.1). */
export const TRIGGERS_NOT_ALLOWED_MESSAGE =
  'allow triggers on this project in Manage project access — the application needs View and Edit subscriptions there'

const PULL_REQUEST_UPDATE_KINDS: Readonly<Record<string, readonly AzureDevOpsDeliveryKind[]>> = {
  'merge_request:*': ['opened', 'revision', 'reviewers', 'state'],
  'merge_request:opened': ['opened'],
  'merge_request:synchronize': ['revision'],
  'merge_request:review_requested': ['reviewers'],
  'merge_request:reopened': ['state']
}

/** The delivery kinds the enabled azure-devops hooks on one repository need (§11.2); a pull-request watcher also takes merged and state for cleanup (§11.4). */
export function azureDevOpsDeliveryKinds(
  hooks: ReadonlyArray<Pick<HookRecord, 'enabled' | 'kind' | 'repoId' | 'events' | 'commentFamilies'>>,
  repoId: bigint
): Set<AzureDevOpsDeliveryKind> {
  const kinds = new Set<AzureDevOpsDeliveryKind>()
  for (const hook of hooks) {
    if (!hook.enabled || hook.kind !== 'azure-devops' || hook.repoId !== repoId) continue
    let pullRequests = false
    for (const pattern of hook.events) {
      if (pattern === 'push:*') kinds.add('push')
      for (const kind of PULL_REQUEST_UPDATE_KINDS[pattern] ?? []) {
        kinds.add(kind)
        pullRequests = true
      }
    }
    if (hook.commentFamilies.includes('merge_request')) {
      kinds.add('comment')
      pullRequests = true
    }
    // Completion and abandonment arrive as state updates; "merge attempted" fires on every merge check, opening included.
    if (pullRequests) kinds.add('state')
  }
  return kinds
}

/** The one binding a repository's subscriptions live on: the oldest, so two connections never both subscribe. */
export function hookBindingOf<B extends Pick<AzureDevOpsRepositoryBindingRecord, 'createdAt'>>(
  bindings: readonly B[]
): B | undefined {
  return [...bindings].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0]
}

export interface AzureDevOpsHookServiceDeps {
  connections: Pick<AzureDevOpsConnectionRepo, 'get'>
  bindings: Pick<
    AzureDevOpsRepositoryBindingRepo,
    'get' | 'listForRepo' | 'listForRepoUnscoped' | 'listForConnection' | 'remove'
  >
  hooks: AzureDevOpsHookRepo
  service: Pick<AzureDevOpsConnectionService, 'withApi' | 'accessToken'>
  api: AzureDevOpsApiClient
  clock: Clock
  /** The deployment's public relay origin; absent ⇒ no subscription can be written. */
  publicRelayUrl?: string
  /** The enabled azure-devops hooks of the organization, for the repository's delivery kinds. */
  listHooks: (
    orgId: string
  ) => Promise<ReadonlyArray<Pick<HookRecord, 'enabled' | 'kind' | 'repoId' | 'events' | 'commentFamilies'>>>
  /** Recompile the repository's rules; AWAITED before a subscription can send a key the relay does not hold yet. */
  onChanged?: (orgId: string, repoId: bigint) => Promise<void> | void
  log?: { warn(obj: object, msg: string): void }
}

export type AzureDevOpsConvergeOutcome =
  | { state: 'converged'; subscriptions: number; hookReason: AzureDevOpsHookReason | null }
  | { state: 'busy' }
  | { state: 'failed'; hookReason: AzureDevOpsHookReason | null; retryable: boolean }

export interface AzureDevOpsRotationOutcome {
  /** A rotation is under way: the next key is sealed and the relays accept it. */
  rotated: boolean
  /** Subscriptions recorded as switched to the next key, of all recorded. */
  switched: number
  total: number
  reason: string | null
}

type TriggerGate = { ok: true } | { ok: false; status: 409 | 429 | 502; message: string }

function hex32(): string {
  return randomBytes(32).toString('hex')
}

export class AzureDevOpsHookService {
  /** One convergence per repository in this process, keyed `<org>:<repo>`. */
  private readonly runs = new Map<string, { done: Promise<void>; again: boolean }>()
  private readonly followUps = new Set<string>()

  constructor(private readonly deps: AzureDevOpsHookServiceDeps) {}

  private relayUrl(): string | undefined {
    return this.deps.publicRelayUrl
      ? `${this.deps.publicRelayUrl.replace(/\/+$/, '')}${AZURE_DEVOPS_HOOK_PATH}`
      : undefined
  }

  private async changed(orgId: string, repoId: bigint): Promise<void> {
    try {
      await this.deps.onChanged?.(orgId, repoId)
    } catch (err) {
      this.deps.log?.warn({ err, repoId: repoId.toString() }, 'azure devops: hook rule fan-out failed')
    }
  }

  /** A binding's recorded subscriptions, for the card. */
  subscriptionsOf(bindingId: string): Promise<AzureDevOpsHookSubscriptionRecord[]> {
    return this.deps.hooks.subscriptions(bindingId)
  }

  /** The repository's one hooked binding in the organization. */
  async hookBinding(orgId: string, repoId: bigint): Promise<AzureDevOpsRepositoryBindingRecord | undefined> {
    return hookBindingOf(await this.deps.bindings.listForRepo(orgId, repoId))
  }

  /** §11.1: refuse a hook save on a project where the application cannot manage subscriptions. */
  async triggersAllowed(orgId: string, repoId: bigint): Promise<TriggerGate> {
    const binding = await this.hookBinding(orgId, repoId)
    if (!binding)
      return {
        ok: false,
        status: 409,
        message: 'the repository is not bound through an Azure DevOps connection in this organization'
      }
    const connection = await this.deps.connections.get(orgId, binding.connectionId)
    if (!connection) return { ok: false, status: 409, message: 'the Azure DevOps connection is gone' }
    try {
      const granted = await this.deps.service.withApi(connection, (token) =>
        evaluateServiceHookGrant(this.deps.api, token, connection.organization, binding.projectId)
      )
      return granted ? { ok: true } : { ok: false, status: 409, message: TRIGGERS_NOT_ALLOWED_MESSAGE }
    } catch (e) {
      if (e instanceof AzureDevOpsConnectDenied) return { ok: false, status: 409, message: e.message }
      if (e instanceof AzureDevOpsApiError) {
        if (e.code === 'SECRET_REJECTED' || e.code === 'ACCESS_REVOKED') {
          return { ok: false, status: 409, message: `azure devops: ${e.message}` }
        }
        return { ok: false, status: e.code === 'RATE_LIMITED' ? 429 : 502, message: `azure devops: ${e.message}` }
      }
      throw e
    }
  }

  /** `convergeManagedRepository` (§11.2): every binding of the repository, the hooked one to the union of its hooks' kinds, the others to none. */
  async convergeRepository(orgId: string, repoId: bigint): Promise<void> {
    // One pass per repository in this process: a late caller joins the run and asks for a trailing pass.
    const key = `${orgId}:${repoId}`
    const running = this.runs.get(key)
    if (running) {
      running.again = true
      await running.done
      return
    }
    const entry = { again: false, done: Promise.resolve() }
    this.runs.set(key, entry)
    entry.done = (async () => {
      try {
        do {
          entry.again = false
          const bindings = await this.deps.bindings.listForRepo(orgId, repoId)
          const hooked = hookBindingOf(bindings)
          for (const binding of bindings) await this.convergeOnce(orgId, binding.id, binding === hooked)
        } while (entry.again)
      } finally {
        this.runs.delete(key)
      }
    })()
    await entry.done
  }

  /** Every hooked binding of a connection again, after Allow triggers was granted. */
  async convergeConnection(orgId: string, connectionId: string): Promise<void> {
    for (const binding of await this.deps.bindings.listForConnection(orgId, connectionId)) {
      await this.convergeRepository(orgId, binding.repoId)
    }
  }

  /** The background sweep: bindings with subscriptions or an owed pass, read back for drift, status and expired keys. */
  async sweep(limit = 100): Promise<void> {
    for (const binding of await this.deps.hooks.listHooked(limit)) {
      await this.convergeRepository(binding.orgId, binding.repoId)
    }
  }

  /** One pass under the binding's lease; a contended pass is owed, never dropped. */
  async convergeOnce(orgId: string, bindingId: string, hooked = true): Promise<AzureDevOpsConvergeOutcome> {
    const binding = await this.deps.bindings.get(orgId, bindingId)
    if (!binding) return { state: 'converged', subscriptions: 0, hookReason: null }
    const owner = randomBytes(9).toString('base64url')
    const now = this.deps.clock.now()
    if (!(await this.deps.hooks.acquireLease(binding.id, owner, new Date(now + HOOK_LEASE_MS), new Date(now)))) {
      await this.owe(binding)
      return { state: 'busy' }
    }
    try {
      const desired = hooked
        ? azureDevOpsDeliveryKinds(await this.deps.listHooks(orgId), binding.repoId)
        : new Set<AzureDevOpsDeliveryKind>()
      return await this.converge(binding, desired)
    } catch (e) {
      return this.failed(binding, e)
    } finally {
      await this.deps.hooks.releaseLease(binding.id, owner).catch(() => {})
    }
  }

  private async owe(binding: AzureDevOpsRepositoryBindingRecord): Promise<void> {
    await this.deps.hooks.markConvergeOwed(binding.id, new Date(this.deps.clock.now())).catch(() => {})
    if (this.followUps.has(binding.id)) return
    this.followUps.add(binding.id)
    this.deps.clock.setTimeout(() => {
      this.followUps.delete(binding.id)
      void this.convergeRepository(binding.orgId, binding.repoId).catch((err) =>
        this.deps.log?.warn({ err, bindingId: binding.id }, 'azure devops: hook convergence follow-up failed')
      )
    }, FOLLOW_UP_DELAY_MS)
  }

  private async failed(binding: AzureDevOpsRepositoryBindingRecord, e: unknown): Promise<AzureDevOpsConvergeOutcome> {
    const retryable = e instanceof AzureDevOpsApiError ? e.retryable : !(e instanceof AzureDevOpsConnectDenied)
    // A 403 on a subscription write is the grant of §11.1 gone.
    const hookReason: AzureDevOpsHookReason =
      e instanceof AzureDevOpsApiError && e.code === 'FORBIDDEN' ? 'triggers_not_allowed' : 'subscriptions_failed'
    this.deps.log?.warn(
      { bindingId: binding.id, code: e instanceof AzureDevOpsApiError ? e.code : undefined, hookReason },
      'azure devops: hook convergence failed'
    )
    await this.deps.hooks.setHookState(binding.id, { hookReason }).catch(() => {})
    if (retryable) await this.owe(binding)
    else await this.deps.hooks.markConvergeOwed(binding.id, null).catch(() => {})
    await this.changed(binding.orgId, binding.repoId)
    return { state: 'failed', hookReason, retryable }
  }

  private target(
    binding: AzureDevOpsRepositoryBindingRecord,
    url: string,
    password: string
  ): AzureDevOpsSubscriptionTarget {
    return { projectId: binding.projectId, repositoryId: binding.repositoryId, url, password }
  }

  private async converge(
    binding: AzureDevOpsRepositoryBindingRecord,
    desired: ReadonlySet<AzureDevOpsDeliveryKind>
  ): Promise<AzureDevOpsConvergeOutcome> {
    const { api } = this.deps
    const orgId = binding.orgId
    const recorded = await this.deps.hooks.subscriptions(binding.id)
    const connection = await this.deps.connections.get(orgId, binding.connectionId)
    if (!connection) return { state: 'converged', subscriptions: recorded.length, hookReason: binding.hookReason }
    if (desired.size === 0) return this.unsubscribeAll(binding, connection, recorded)
    const url = this.relayUrl()
    if (!url) return this.settle(binding, 'relay_url_unconfigured', recorded.length)
    // §11.1: without the grant nothing can be written, and a subscription disabled for it is not re-enabled.
    const granted = await this.deps.service.withApi(connection, (token) =>
      evaluateServiceHookGrant(api, token, connection.organization, binding.projectId)
    )
    if (!granted) return this.settle(binding, 'triggers_not_allowed', recorded.length)
    let keys = await this.deps.hooks.keys(orgId, binding.id)
    if (!keys) {
      keys = await this.deps.hooks.ensureKeys(orgId, binding.id, hex32())
      // The relays hold a key before any subscription can send it.
      await this.changed(orgId, binding.repoId)
    }
    const write = writeKeyOf(keys)
    let unverified = false
    let remaining = 0
    await this.deps.service.withApi(connection, async (token) => {
      const present = new Set<AzureDevOpsDeliveryKind>()
      for (const record of recorded) {
        if (!desired.has(record.kind) || present.has(record.kind)) {
          await deleteSubscription(api, token, connection.organization, record.subscriptionId)
          await this.deps.hooks.removeSubscription(record.id)
          continue
        }
        const stored = await readSubscription(api, token, connection.organization, record.subscriptionId)
        if (!stored) {
          // Removed in Azure DevOps: forgotten here and recreated below.
          await this.deps.hooks.removeSubscription(record.id)
          continue
        }
        present.add(record.kind)
        const target = this.target(binding, url, write.password)
        const dropping = subscriptionDropping(stored.status)
        // Drift is rewritten whole, the real key included, before the status is touched (§11.2).
        if (subscriptionDrifted(stored, record.kind, target) || dropping || keyBehind(record, keys)) {
          await replaceSubscription(
            api,
            token,
            connection.organization,
            record.subscriptionId,
            subscriptionBody(record.kind, target)
          )
          await this.deps.hooks.updateSubscription(record.id, { status: 'enabled', keyGeneration: write.generation })
          if (dropping) unverified = true
        } else if (stored.status !== record.status) {
          await this.deps.hooks.updateSubscription(record.id, { status: stored.status })
        }
      }
      for (const kind of desired) {
        if (present.has(kind)) continue
        // A subscription created mid-rotation takes the next key and counts as switched (§11.2).
        const created = await createSubscription(
          api,
          token,
          connection.organization,
          subscriptionBody(kind, this.target(binding, url, write.password))
        )
        await this.deps.hooks.recordSubscription({
          bindingId: binding.id,
          subscriptionId: created.id,
          kind,
          status: created.status,
          keyGeneration: write.generation
        })
        present.add(kind)
        unverified = true
      }
      remaining = present.size
    })
    if (keys.previousExpiresAt !== null && keys.previousExpiresAt.getTime() <= this.deps.clock.now()) {
      await this.deps.hooks.dropExpiredPrevious(orgId, binding.id, new Date(this.deps.clock.now()))
    }
    const stillUnverified =
      unverified || binding.lastVerifiedDeliveryAt === null || binding.hookReason === 'webhook_unverified'
    return this.settle(binding, stillUnverified ? 'webhook_unverified' : null, remaining)
  }

  /** Record the pass's verdict, clear the owed pass, and recompile the rules. */
  private async settle(
    binding: AzureDevOpsRepositoryBindingRecord,
    hookReason: AzureDevOpsHookReason | null,
    subscriptions: number
  ): Promise<AzureDevOpsConvergeOutcome> {
    await this.deps.hooks.setHookState(binding.id, { hookReason })
    await this.deps.hooks.markConvergeOwed(binding.id, null)
    await this.changed(binding.orgId, binding.repoId)
    return { state: 'converged', subscriptions, hookReason }
  }

  /** The last hook went away: every recorded subscription goes, and the keys with them; the binding stays for its workspaces and grants. */
  private async unsubscribeAll(
    binding: AzureDevOpsRepositoryBindingRecord,
    connection: AzureDevOpsConnectionRecord,
    recorded: readonly AzureDevOpsHookSubscriptionRecord[]
  ): Promise<AzureDevOpsConvergeOutcome> {
    if (recorded.length > 0) {
      await this.deps.service.withApi(connection, async (token) => {
        for (const record of recorded) {
          await deleteSubscription(this.deps.api, token, connection.organization, record.subscriptionId)
          await this.deps.hooks.removeSubscription(record.id)
        }
      })
    }
    await this.deps.hooks.deleteKeys(binding.orgId, binding.id)
    await this.deps.hooks.setHookState(binding.id, { hookReason: null, lastVerifiedDeliveryAt: null })
    await this.deps.hooks.markConvergeOwed(binding.id, null)
    await this.changed(binding.orgId, binding.repoId)
    return { state: 'converged', subscriptions: 0, hookReason: null }
  }

  /** §11.2 rotation: seal the next key, let the relays accept it, then PUT each recorded subscription, recording each acknowledgement. */
  async rotate(orgId: string, bindingId: string): Promise<AzureDevOpsRotationOutcome> {
    const binding = await this.deps.bindings.get(orgId, bindingId)
    if (!binding) return { rotated: false, switched: 0, total: 0, reason: 'binding_missing' }
    const owner = randomBytes(9).toString('base64url')
    const now = this.deps.clock.now()
    if (!(await this.deps.hooks.acquireLease(binding.id, owner, new Date(now + HOOK_LEASE_MS), new Date(now)))) {
      return { rotated: false, switched: 0, total: 0, reason: 'convergence_in_progress' }
    }
    let total = 0
    let switched = 0
    let started = false
    try {
      const recorded = await this.deps.hooks.subscriptions(binding.id)
      total = recorded.length
      const current = await this.deps.hooks.keys(orgId, binding.id)
      if (!current || recorded.length === 0) return { rotated: false, switched: 0, total, reason: 'no_subscriptions' }
      const url = this.relayUrl()
      if (!url) return { rotated: false, switched: 0, total, reason: 'relay_url_unconfigured' }
      const connection = await this.deps.connections.get(orgId, binding.connectionId)
      if (!connection) return { rotated: false, switched: 0, total, reason: 'connection_missing' }
      const keys = await this.deps.hooks.beginRotation(orgId, binding.id, hex32())
      started = true
      // Step 1: both keys reach the relays before any subscription is switched.
      await this.changed(orgId, binding.repoId)
      const write = writeKeyOf(keys)
      await this.deps.service.withApi(connection, async (token) => {
        for (const record of recorded) {
          if (record.keyGeneration >= write.generation) {
            switched += 1
            continue
          }
          try {
            await replaceSubscription(
              this.deps.api,
              token,
              connection.organization,
              record.subscriptionId,
              subscriptionBody(record.kind, this.target(binding, url, write.password))
            )
          } catch (e) {
            if (!(e instanceof AzureDevOpsApiError) || e.code !== 'NOT_FOUND') throw e
            // Gone in Azure DevOps: forgotten, and the convergence recreates it under the next key.
            await this.deps.hooks.removeSubscription(record.id)
            total -= 1
            await this.owe(binding)
            continue
          }
          // Step 2's durable record: this subscription is never switched again under another secret.
          await this.deps.hooks.updateSubscription(record.id, { status: 'enabled', keyGeneration: write.generation })
          switched += 1
        }
      })
      return { rotated: true, switched, total, reason: null }
    } catch (e) {
      const reason = e instanceof AzureDevOpsApiError ? `azure_devops_${e.code.toLowerCase()}` : 'rotation_failed'
      this.deps.log?.warn({ bindingId: binding.id, reason }, 'azure devops: hook key rotation cut short')
      // The sweep resumes from the per-subscription records.
      if (started) await this.owe(binding)
      return { rotated: started, switched, total, reason }
    } finally {
      await this.deps.hooks.releaseLease(binding.id, owner).catch(() => {})
    }
  }

  /** The relay verified a delivery (§11.3): the binding is verified, and a delivery under the next key promotes it once every subscription switched. */
  async observeDelivery(input: {
    repoId: bigint
    at: Date
    verifiedWith?: 'current' | 'next' | 'previous'
  }): Promise<void> {
    for (const binding of await this.deps.bindings.listForRepoUnscoped(input.repoId)) {
      const keys = await this.deps.hooks.keys(binding.orgId, binding.id)
      if (!keys) continue
      if (binding.lastVerifiedDeliveryAt === null || binding.lastVerifiedDeliveryAt.getTime() < input.at.getTime()) {
        await this.deps.hooks.setHookState(binding.id, {
          lastVerifiedDeliveryAt: input.at,
          ...(binding.hookReason === 'webhook_unverified' ? { hookReason: null } : {})
        })
      }
      if (input.verifiedWith !== 'next' || keys.next === null) continue
      // Step 3: a delivery under the next key before the barrier promotes nothing.
      const promoted = await this.deps.hooks.promoteIfSwitched(
        binding.orgId,
        binding.id,
        new Date(this.deps.clock.now() + PREVIOUS_KEY_TTL_MS)
      )
      if (promoted) await this.changed(binding.orgId, binding.repoId)
    }
  }

  /** Remove a binding (§5); once removed, its subscriptions are deleted as far as Azure DevOps lets us, and an orphan retires on its own. */
  async removeBinding(orgId: string, bindingId: string): Promise<'removed' | 'referenced' | 'missing'> {
    const binding = await this.deps.bindings.get(orgId, bindingId)
    if (!binding) return 'missing'
    const doomed = await this.snapshot(orgId, [binding])
    const outcome = await this.deps.bindings.remove(orgId, bindingId)
    if (outcome === 'removed') await this.deleteSnapshot(doomed)
    return outcome
  }

  /** Disconnect a connection through `remove`, then delete the subscriptions its bindings recorded. */
  async disconnect(
    orgId: string,
    connectionId: string,
    remove: () => Promise<'removed' | 'referenced' | 'missing'>
  ): Promise<'removed' | 'referenced' | 'missing'> {
    const doomed = await this.snapshot(orgId, await this.deps.bindings.listForConnection(orgId, connectionId))
    const outcome = await remove()
    if (outcome === 'removed') await this.deleteSnapshot(doomed)
    return outcome
  }

  /** What a removal must delete afterwards: the subscriptions, the organization, and a token taken while the connection still exists. */
  private async snapshot(
    orgId: string,
    bindings: readonly AzureDevOpsRepositoryBindingRecord[]
  ): Promise<
    Array<{ binding: AzureDevOpsRepositoryBindingRecord; organization: string; token: string | null; ids: string[] }>
  > {
    const out = []
    for (const binding of bindings) {
      const ids = (await this.deps.hooks.subscriptions(binding.id)).map((record) => record.subscriptionId)
      if (ids.length === 0) {
        out.push({ binding, organization: '', token: null, ids })
        continue
      }
      const connection = await this.deps.connections.get(orgId, binding.connectionId)
      let token: string | null = null
      if (connection)
        token = await this.deps.service.accessToken(connection).then(
          (t) => t.token,
          () => null
        )
      out.push({ binding, organization: connection?.organization ?? '', token, ids })
    }
    return out
  }

  private async deleteSnapshot(
    doomed: ReadonlyArray<{
      binding: AzureDevOpsRepositoryBindingRecord
      organization: string
      token: string | null
      ids: string[]
    }>
  ): Promise<void> {
    for (const { binding, organization, token, ids } of doomed) {
      if (token !== null) {
        for (const id of ids) {
          await deleteSubscription(this.deps.api, token, organization, id).catch((err) =>
            this.deps.log?.warn({ err, bindingId: binding.id }, 'azure devops: subscription left behind on removal')
          )
        }
      }
      await this.changed(binding.orgId, binding.repoId)
    }
  }
}

/** The key a write carries now, and its generation: the next one while a rotation is under way. */
function writeKeyOf(keys: AzureDevOpsHookKeys): { password: string; generation: bigint } {
  return keys.next !== null
    ? { password: keys.next, generation: keys.generation + 1n }
    : { password: keys.current, generation: keys.generation }
}

/** A subscription not yet carrying the key it should: behind a rotation, or left on an older one. */
function keyBehind(record: AzureDevOpsHookSubscriptionRecord, keys: AzureDevOpsHookKeys): boolean {
  return keys.next !== null ? record.keyGeneration < keys.generation + 1n : record.keyGeneration !== keys.generation
}
