/**
 * The Gitea arm of `rc/codehost-membership-authz` (gitea-integration.md §8): re-resolve every
 * relevant actor's CURRENT repository permission with the connection token — never a
 * webhook-carried relationship label. Gitea looks up by username, so the delivered login is first
 * re-resolved to its numeric id and a mismatch refused; the lookup itself needs the bot's `admin`,
 * so an `admin_degraded` binding fails closed. Local metadata mismatches deny before any Gitea
 * request; operational failures and the bounded timeout propagate so the wire handler can tell
 * them from a definitive denial.
 */
import type { RcCodeHostMembershipAuthz } from '@agentconnect.md/protocol'
import { HookId } from '../domain/ids.js'
import type { GiteaConnectionRepo, GiteaRepositoryBindingRepo, HookRecord, HookRepo } from '../persistence/ports.js'
import {
  giteaCollaboratorPermission,
  giteaPermissionAdmits,
  giteaUser,
  isGiteaAuthRejection,
  splitGiteaRepoPath,
  type GiteaApiClient
} from './api.js'
import { authorizesMembership } from './binding-state.js'
import type { GiteaTokenSource } from './provisioner.js'

export interface GiteaMembershipAuthzDeps {
  hooks: Pick<HookRepo, 'getManyUnscoped'>
  bindings: Pick<GiteaRepositoryBindingRepo, 'byRepo'>
  connections: Pick<GiteaConnectionRepo, 'get'>
  tokens: GiteaTokenSource
  api: GiteaApiClient
  /** Test override; production stays below the relay's 5 second correlator. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 4_000

interface Actor {
  id: bigint
  username: string | undefined
}

export class GiteaMembershipAuthzService {
  constructor(private readonly deps: GiteaMembershipAuthzDeps) {}

  async allowed(req: RcCodeHostMembershipAuthz): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Gitea membership authorization timed out')), this.timeoutMs)
    })
    try {
      return await Promise.race([this.resolve(req), timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  private get timeoutMs(): number {
    return this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  private async resolve(req: RcCodeHostMembershipAuthz): Promise<boolean> {
    // Provider fail-per-value: this service answers only for gitea.
    if (req.provider !== 'gitea') return false
    const repoId = BigInt(req.repoExternalId)
    const fences = [
      { hookId: req.hookId, configRevision: req.configRevision, dispatchRevision: req.dispatchRevision },
      ...(req.siblingFences ?? [])
    ]
    if (new Set(fences.map((fence) => fence.hookId)).size !== fences.length) return false

    const hooks = await this.deps.hooks.getManyUnscoped(fences.map((fence) => HookId(fence.hookId)))
    const currentById = new Map<string, HookRecord>(hooks.map((hook) => [hook.id, hook]))
    const authorized = fences.map((fence) => {
      const hook = currentById.get(fence.hookId) ?? null
      return this.matchesAuthorizedHook(hook, repoId, fence) ? hook : null
    })
    const authorizedHooks = authorized.filter((hook): hook is HookRecord => hook !== null)
    if (authorizedHooks.length !== fences.length) return false
    const first = authorizedHooks[0]
    if (!first) return false
    if (authorizedHooks.some((candidate) => candidate.orgId !== first.orgId)) return false

    // The rule's backing binding must be fully converged: the lookup needs the bot's admin (§4.4).
    const binding = await this.deps.bindings.byRepo(first.orgId, repoId)
    if (!binding || !authorizesMembership(binding.state)) return false
    const connection = await this.deps.connections.get(binding.orgId, binding.connectionId)
    if (!connection || connection.state !== 'connected') return false
    const path = splitGiteaRepoPath(binding.repoPath)
    if (!path) return false

    // Loop guard (§8): the bot itself never authorizes a trigger, as the subject author or the actor.
    const actors: Actor[] = [{ id: BigInt(req.actorExternalId), username: req.actorUsername }]
    if (req.subjectAuthorExternalId !== undefined) {
      actors.push({ id: BigInt(req.subjectAuthorExternalId), username: req.subjectAuthorUsername })
    }
    if (actors.some((actor) => actor.id === connection.botUserId)) return false
    // Gitea's lookup is by username: a delivery that carries none cannot be authorized.
    if (actors.some((actor) => actor.username === undefined)) return false

    let token: string
    try {
      token = await this.deps.tokens.withToken(binding.orgId, binding.connectionId)
    } catch {
      return false
    }
    try {
      for (const actor of actors) {
        if (!(await this.actorAdmitted(token, path, actor))) return false
      }
    } catch (e) {
      // A rejected token is the connection's verdict (§4.3), and this delivery's denial.
      if (isGiteaAuthRejection(e)) {
        await this.deps.tokens.onAuthRejected(binding.orgId, binding.connectionId)
        return false
      }
      throw e
    }

    // Re-read immediately before the allow verdict so a concurrent disable or retarget cannot
    // authorize a sibling whose durable snapshot is no longer current.
    const refreshed = await this.deps.hooks.getManyUnscoped(fences.map((fence) => HookId(fence.hookId)))
    const refreshedById = new Map<string, HookRecord>(refreshed.map((candidate) => [candidate.id, candidate]))
    return fences.every((fence, index) => {
      const expected = authorizedHooks[index]
      return (
        expected !== undefined &&
        this.matchesAuthorizedHook(refreshedById.get(fence.hookId) ?? null, repoId, fence, {
          orgId: expected.orgId,
          agentId: expected.agentId
        })
      )
    })
  }

  /** §8: the login re-resolved to its id must match the delivered id, then the permission must admit. */
  private async actorAdmitted(token: string, path: { owner: string; repo: string }, actor: Actor): Promise<boolean> {
    const user = await giteaUser(token, actor.username!, this.deps.api)
    if (!user || BigInt(user.id) !== actor.id) return false
    let permission
    try {
      permission = await giteaCollaboratorPermission(token, path.owner, path.repo, actor.username!, this.deps.api)
    } catch (e) {
      if (isGiteaAuthRejection(e)) throw e
      // A 403 is the bot's own `admin` gone (§4.4); a 404 is a vanished user. Both fail closed.
      return false
    }
    if (permission.user?.id !== undefined && BigInt(permission.user.id) !== actor.id) return false
    return giteaPermissionAdmits(permission.permission)
  }

  private matchesAuthorizedHook(
    hook: HookRecord | null,
    repoId: bigint,
    fence: Pick<RcCodeHostMembershipAuthz, 'hookId' | 'configRevision' | 'dispatchRevision'>,
    expected?: Pick<HookRecord, 'orgId' | 'agentId'>
  ): hook is HookRecord {
    return (
      hook !== null &&
      hook.enabled &&
      hook.kind === 'gitea' &&
      hook.agentId !== null &&
      hook.id === fence.hookId &&
      hook.repoId === repoId &&
      hook.configRevision === BigInt(fence.configRevision) &&
      hook.dispatchRevision === BigInt(fence.dispatchRevision) &&
      (expected === undefined || (hook.orgId === expected.orgId && hook.agentId === expected.agentId))
    )
  }
}
