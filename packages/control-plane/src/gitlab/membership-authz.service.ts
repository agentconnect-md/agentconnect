import type { RcCodeHostMembershipAuthz } from '@agentconnect.md/protocol'
import type { Clock } from '../domain/clock.js'
import { HookId } from '../domain/ids.js'
import type {
  GitlabAgentAccountRepo,
  GitlabProjectBindingRepo,
  GitlabProjectCredentialRepo,
  GitlabProjectCredentialSecretStore,
  HookRecord,
  HookRepo
} from '../persistence/ports.js'
import { GITLAB_ACCESS_DEVELOPER, gitlabEffectiveMembership, membershipSatisfies, type GitlabApiClient } from './api.js'

export interface GitlabMembershipAuthzDeps {
  hooks: Pick<HookRepo, 'getManyUnscoped'>
  bindings: Pick<GitlabProjectBindingRepo, 'byProject'>
  accounts: Pick<GitlabAgentAccountRepo, 'listForBinding'>
  credentials: Pick<GitlabProjectCredentialRepo, 'get'>
  credentialSecrets: Pick<GitlabProjectCredentialSecretStore, 'get'>
  clock: Clock
  api: GitlabApiClient
  /** Test override; production stays below the relay's 5 second correlator. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 4_000

/**
 * The GitLab arm of `rc/codehost-membership-authz` (gitlab-com-integration.md
 * §12.2): re-resolve every relevant actor's live effective membership with the
 * binding's read PAT — never webhook-carried relationship labels. Local
 * metadata mismatches deny before any GitLab request; operational failures and
 * the bounded overall timeout propagate so the wire handler can distinguish
 * them from a definitive denial.
 */
export class GitlabMembershipAuthzService {
  constructor(private readonly deps: GitlabMembershipAuthzDeps) {}

  async allowed(req: RcCodeHostMembershipAuthz): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('GitLab membership authorization timed out')), this.timeoutMs)
    })
    try {
      // Promise.race installs handlers on both inputs, so a late failure from
      // the abandoned lookup cannot become unhandled.
      return await Promise.race([this.resolve(req), timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  private get timeoutMs(): number {
    return this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  private async resolve(req: RcCodeHostMembershipAuthz): Promise<boolean> {
    // Provider fail-per-value (§17.2): this service answers only for gitlab.
    if (req.provider !== 'gitlab') return false
    const projectId = BigInt(req.repoExternalId)
    const fences = [
      { hookId: req.hookId, configRevision: req.configRevision, dispatchRevision: req.dispatchRevision },
      ...(req.siblingFences ?? [])
    ]
    if (new Set(fences.map((fence) => fence.hookId)).size !== fences.length) return false

    const hooks = await this.deps.hooks.getManyUnscoped(fences.map((fence) => HookId(fence.hookId)))
    const currentById = new Map<string, HookRecord>(hooks.map((hook) => [hook.id, hook]))
    const authorized = fences.map((fence) => {
      const hook = currentById.get(fence.hookId) ?? null
      return this.matchesAuthorizedHook(hook, projectId, fence) ? hook : null
    })
    const authorizedHooks = authorized.filter((hook): hook is HookRecord => hook !== null)
    if (authorizedHooks.length !== fences.length) return false
    const first = authorizedHooks[0]
    if (!first) return false
    if (authorizedHooks.some((candidate) => candidate.orgId !== first.orgId)) return false

    // The compiled rule's backing binding must still be live and still own the
    // project; cleanup or a missing service account invalidates the rule.
    const binding = await this.deps.bindings.byProject(first.orgId, projectId)
    if (!binding || binding.state === 'cleanup_pending' || binding.state === 'provisioning') return false
    const accounts = await this.deps.accounts.listForBinding(binding.id)
    const bound = new Set(
      accounts
        .map((account) => account.serviceAccountUserId)
        .filter((userId): userId is bigint => userId !== null)
        .map((userId) => userId.toString())
    )
    if (bound.size === 0) return false

    // Loop/self-summon guard (§12.1 belt): every bound agent account holds a
    // project role, but no managed identity may ever authorize a trigger.
    const actorIds = [
      ...new Set([req.actorExternalId, ...(req.subjectAuthorExternalId ? [req.subjectAuthorExternalId] : [])])
    ].map((id) => BigInt(id))
    if (actorIds.some((id) => bound.has(id.toString()))) return false

    // The read PAT of the hook agent's own account: the live membership answer
    // does not depend on WHICH managed account asks, only that one can.
    const hookAccount = accounts.find((account) => account.agentId === first.agentId) ?? accounts[0]
    if (!hookAccount) return false
    const credential = await this.deps.credentials.get(hookAccount.id, 'read')
    if (!credential) return false
    const token = await this.deps.credentialSecrets.get(binding.orgId, credential.id)
    if (!token) return false

    const nowMs = this.deps.clock.now()
    const memberships = await Promise.all(
      actorIds.map((id) => gitlabEffectiveMembership(token, projectId, id, this.deps.api))
    )
    if (memberships.some((membership) => !membershipSatisfies(membership, GITLAB_ACCESS_DEVELOPER, nowMs))) {
      return false
    }

    // The GitLab calls above can take seconds. Re-read immediately before the
    // allow verdict so a concurrent disable, retarget, or reassignment cannot
    // authorize any fan-out sibling whose durable snapshot is no longer current.
    const refreshed = await this.deps.hooks.getManyUnscoped(fences.map((fence) => HookId(fence.hookId)))
    const refreshedById = new Map<string, HookRecord>(refreshed.map((candidate) => [candidate.id, candidate]))
    return fences.every((fence, index) => {
      const expected = authorizedHooks[index]
      return (
        expected !== undefined &&
        this.matchesAuthorizedHook(refreshedById.get(fence.hookId) ?? null, projectId, fence, {
          orgId: expected.orgId,
          agentId: expected.agentId
        })
      )
    })
  }

  private matchesAuthorizedHook(
    hook: HookRecord | null,
    projectId: bigint,
    fence: Pick<RcCodeHostMembershipAuthz, 'hookId' | 'configRevision' | 'dispatchRevision'>,
    expected?: Pick<HookRecord, 'orgId' | 'agentId'>
  ): hook is HookRecord {
    return (
      hook !== null &&
      hook.enabled &&
      hook.kind === 'gitlab' &&
      hook.agentId !== null &&
      hook.id === fence.hookId &&
      hook.repoId === projectId &&
      hook.configRevision === BigInt(fence.configRevision) &&
      hook.dispatchRevision === BigInt(fence.dispatchRevision) &&
      (expected === undefined || (hook.orgId === expected.orgId && hook.agentId === expected.agentId))
    )
  }
}
