// The Azure DevOps arm of `rc/codehost-membership-authz` (azure-devops-integration.md §11.4): the actor's groups and the repository's access-control chain, read live, stricter than Azure DevOps's own rule and never looser.
import type { RcCodeHostMembershipAuthz } from '@agentconnect.md/protocol'
import type { Clock } from '../domain/clock.js'
import { HookId } from '../domain/ids.js'
import type {
  AzureDevOpsConnectionRepo,
  AzureDevOpsRepositoryBindingRecord,
  AzureDevOpsRepositoryBindingRepo,
  HookRecord,
  HookRepo
} from '../persistence/ports.js'
import { AzureDevOpsApiError, type AzureDevOpsApiClient } from './api.js'
import type { AzureDevOpsConnectionService } from './connection.service.js'
import { hookBindingOf } from './hook.service.js'
import {
  GENERIC_CONTRIBUTE_BIT,
  readGitAccessControlList,
  readIdentityMemberships,
  type AzureDevOpsAccessControlList
} from './hooks-api.js'

/** A repository's list chain is cached this long per binding (§11.4). */
export const ACL_CACHE_MS = 60_000
const DEFAULT_TIMEOUT_MS = 4_000

export interface AzureDevOpsMembershipAuthzDeps {
  hooks: Pick<HookRepo, 'getManyUnscoped'>
  bindings: Pick<AzureDevOpsRepositoryBindingRepo, 'listForRepo'>
  connections: Pick<AzureDevOpsConnectionRepo, 'get'>
  service: Pick<AzureDevOpsConnectionService, 'withApi'>
  api: AzureDevOpsApiClient
  clock: Pick<Clock, 'now'>
  log?: { warn(obj: object, msg: string): void }
  /** Test override; production stays below the relay's 5 second correlator. */
  timeoutMs?: number
}

const GIT_NAMESPACE_ROOT = 'repoV2'

/** The tokens read for one repository, nearest first: repository, project, then the namespace root. */
export function gitTokenChain(projectId: string, repositoryId: string): string[] {
  return [`repoV2/${projectId}/${repositoryId}`, `repoV2/${projectId}`, GIT_NAMESPACE_ROOT]
}

/** The lists that apply, nearest first, up to the first that does not inherit or leaves inheritance out; a level with no list inherits. */
export function effectiveLists(chain: readonly AzureDevOpsAccessControlList[]): AzureDevOpsAccessControlList[] {
  const applied: AzureDevOpsAccessControlList[] = []
  for (const list of chain) {
    if (!list.exists) continue
    applied.push(list)
    if (list.inheritPermissions !== true) break
  }
  return applied
}

/** Admit when an entry for the actor or one of its groups allows GenericContribute and none denies it (§11.4). */
export function contributeAdmits(
  lists: readonly AzureDevOpsAccessControlList[],
  descriptors: readonly string[]
): boolean {
  const mine = new Set(descriptors.map((descriptor) => descriptor.toLowerCase()))
  let allowed = false
  for (const list of lists) {
    for (const [descriptor, ace] of list.aces) {
      if (!mine.has(descriptor)) continue
      if ((ace.deny & GENERIC_CONTRIBUTE_BIT) !== 0) return false
      if ((ace.allow & GENERIC_CONTRIBUTE_BIT) !== 0) allowed = true
    }
  }
  return allowed
}

export class AzureDevOpsMembershipAuthzService {
  /** Binding → its applied lists and when they were read. */
  private readonly cache = new Map<string, { at: number; lists: AzureDevOpsAccessControlList[] }>()

  constructor(private readonly deps: AzureDevOpsMembershipAuthzDeps) {}

  async allowed(req: RcCodeHostMembershipAuthz): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error('Azure DevOps membership authorization timed out')),
        this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
      )
    })
    try {
      return await Promise.race([this.resolve(req), timeout])
    } catch (err) {
      this.deps.log?.warn({ err, hookId: req.hookId }, 'azure devops membership authz failed closed')
      return false
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  private async resolve(req: RcCodeHostMembershipAuthz): Promise<boolean> {
    // Provider fail-per-value: this arm answers only for an Azure DevOps actor named by identity id.
    if (req.provider !== 'azure-devops' || req.actorIdentityId === undefined || req.actorExternalId !== undefined)
      return false
    // The update kinds' second actor has no Azure DevOps form; a request naming one is refused.
    if (req.subjectAuthorExternalId !== undefined || req.subjectAuthorUsername !== undefined) return false
    const repoId = BigInt(req.repoExternalId)
    const fences = [
      { hookId: req.hookId, configRevision: req.configRevision, dispatchRevision: req.dispatchRevision },
      ...(req.siblingFences ?? [])
    ]
    if (new Set(fences.map((fence) => fence.hookId)).size !== fences.length) return false
    const read = async () => {
      const hooks = await this.deps.hooks.getManyUnscoped(fences.map((fence) => HookId(fence.hookId)))
      const byId = new Map<string, HookRecord>(hooks.map((hook) => [hook.id, hook]))
      return fences.map((fence) => byId.get(fence.hookId) ?? null)
    }
    const authorized = await read()
    if (!authorized.every((hook, i) => matches(hook, repoId, fences[i]!))) return false
    const first = authorized[0]!
    if (authorized.some((hook) => hook!.orgId !== first.orgId)) return false

    if (!(await this.actorAdmitted(first.orgId, repoId, req.actorIdentityId))) return false

    // Re-read before the verdict, so a concurrent disable or retarget authorizes nothing.
    const refreshed = await read()
    return refreshed.every(
      (hook, i) =>
        matches(hook, repoId, fences[i]!) &&
        hook!.orgId === authorized[i]!.orgId &&
        hook!.agentId === authorized[i]!.agentId
    )
  }

  /** §11.4 steps 1-3 for one actor on the repository's hooked binding. */
  async actorAdmitted(orgId: string, repoId: bigint, actorIdentityId: string): Promise<boolean> {
    const binding = hookBindingOf(await this.deps.bindings.listForRepo(orgId, repoId))
    if (!binding || binding.state !== 'ready') return false
    const connection = await this.deps.connections.get(orgId, binding.connectionId)
    if (!connection || connection.state !== 'connected') return false
    // Loop guard: the connection's own identity never authorizes a trigger.
    if (actorIdentityId.toLowerCase() === connection.identityId.toLowerCase()) return false
    return this.deps.service.withApi(connection, async (token) => {
      const identity = await readIdentityMemberships(this.deps.api, token, connection.organization, actorIdentityId)
      if (!identity) return false
      const lists = await this.lists(binding, token, connection.organization)
      return contributeAdmits(lists, [identity.descriptor, ...identity.memberOf])
    })
  }

  private async lists(
    binding: AzureDevOpsRepositoryBindingRecord,
    token: string,
    organization: string
  ): Promise<AzureDevOpsAccessControlList[]> {
    const now = this.deps.clock.now()
    const cached = this.cache.get(binding.id)
    if (cached && now - cached.at < ACL_CACHE_MS) return cached.lists
    const chain: AzureDevOpsAccessControlList[] = []
    for (const securityToken of gitTokenChain(binding.projectId, binding.repositoryId)) {
      const list = await readGitAccessControlList(this.deps.api, token, organization, securityToken).catch(
        (err: unknown) => {
          // A project-scoped connection may not read the organization-wide list; that level then adds nothing (§11.4).
          if (securityToken === GIT_NAMESPACE_ROOT && err instanceof AzureDevOpsApiError && err.code === 'FORBIDDEN')
            return null
          throw err
        }
      )
      if (!list) break
      chain.push(list)
      // Nothing beyond a boundary counts, so it is not read.
      if (list.exists && list.inheritPermissions !== true) break
    }
    const lists = effectiveLists(chain)
    this.cache.set(binding.id, { at: now, lists })
    return lists
  }
}

function matches(
  hook: HookRecord | null,
  repoId: bigint,
  fence: Pick<RcCodeHostMembershipAuthz, 'hookId' | 'configRevision' | 'dispatchRevision'>
): boolean {
  return (
    hook !== null &&
    hook.enabled &&
    hook.kind === 'azure-devops' &&
    hook.agentId !== null &&
    hook.id === fence.hookId &&
    hook.repoId === repoId &&
    hook.configRevision === BigInt(fence.configRevision) &&
    hook.dispatchRevision === BigInt(fence.dispatchRevision)
  )
}
