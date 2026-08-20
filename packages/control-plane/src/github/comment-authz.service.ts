import type { RcGithubCommentAuthz } from '@agentconnect.md/protocol'
import { HookId } from '../domain/ids.js'
import type { GithubInstallationRepo, HookRecord, HookRepo } from '../persistence/ports.js'
import type { GithubRepoRole, GithubService } from './service.js'

export interface GithubCommentAuthzDeps {
  hooks: Pick<HookRepo, 'getManyUnscoped'>
  installations: Pick<GithubInstallationRepo, 'getByInstallationId'>
  github: Pick<GithubService, 'repoRefForCommentAuthz' | 'userRepoPermissionForCommentAuthz'>
  /** Test override; production stays below the relay's 5 second correlator. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 4_000

/** Repository roles that may fire an agent on a thread. Maintain arrives collapsed as `write`. */
const TRIGGER_ROLES = new Set<GithubRepoRole>(['admin', 'write', 'triage'])

/**
 * Resolve every relevant GitHub actor's current repository permission without trusting
 * webhook `author_association`. Every local metadata mismatch denies before a
 * GitHub request. Operational failures and the bounded overall timeout
 * propagate so the wire handler can distinguish them from a definitive denial.
 */
export class GithubCommentAuthzService {
  constructor(private readonly deps: GithubCommentAuthzDeps) {}

  async allowed(req: RcGithubCommentAuthz): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('GitHub comment authorization timed out')), this.timeoutMs)
    })
    try {
      // Promise.race installs fulfillment/rejection handlers on both inputs, so
      // a late failure from the abandoned lookup cannot become unhandled.
      return await Promise.race([this.resolve(req), timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  private get timeoutMs(): number {
    return this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  private async resolve(req: RcGithubCommentAuthz): Promise<boolean> {
    const fences = [
      {
        hookId: req.hookId,
        configRevision: req.configRevision,
        dispatchRevision: req.dispatchRevision
      },
      ...(req.siblingFences ?? [])
    ]
    if (new Set(fences.map((fence) => fence.hookId)).size !== fences.length) return false

    // GitHub machinery (org-scoped-data-layer.md §4): the fences arrive on a
    // durable run row, which already fixes the organization; the repo/fence
    // matching below is the authority.
    const hooks = await this.deps.hooks.getManyUnscoped(fences.map((fence) => HookId(fence.hookId)))
    const currentById = new Map<string, HookRecord>(hooks.map((hook) => [hook.id, hook]))
    const authorized = fences.map((fence) => {
      const hook = currentById.get(fence.hookId) ?? null
      return this.matchesAuthorizedHook(hook, req.repoId, fence) ? hook : null
    })
    const authorizedHooks = authorized.filter((hook): hook is HookRecord => hook !== null)
    if (authorizedHooks.length !== fences.length) return false
    const hook = authorizedHooks[0]
    if (!hook) return false
    if (authorizedHooks.some((candidate) => candidate.orgId !== hook.orgId)) return false

    const installation = await this.deps.installations.getByInstallationId(BigInt(req.installationId))
    if (
      !installation ||
      installation.revokedAt !== null ||
      installation.suspendedAt !== null ||
      installation.orgId !== hook.orgId
    ) {
      return false
    }

    if (!/^[^/\s]+\/[^/\s]+$/.test(req.repoFullName)) return false
    const [owner, repo] = req.repoFullName.split('/') as [string, string]

    // Resolve the supplied name through this exact installation, then pin it
    // back to the numeric hook identity. This permits legitimate renames while
    // rejecting a stale-name collision with a different repository.
    const resolved = await this.deps.github.repoRefForCommentAuthz(installation, owner, repo)
    if (!resolved || resolved.repoId !== hook.repoId) return false

    const actorLogins = [...new Set([req.senderLogin, req.subjectAuthorLogin].filter((login) => login !== undefined))]
    const permissions = await Promise.all(
      actorLogins.map((login) => this.deps.github.userRepoPermissionForCommentAuthz(installation, owner, repo, login))
    )
    // Triage is GitHub's role for a trusted non-committer: requesting a pull request review is one
    // of its listed permissions, so it authorizes a trigger even though it grants no push access.
    if (permissions.some((permission) => !TRIGGER_ROLES.has(permission))) return false

    // The GitHub calls above can take seconds. Re-read immediately before the
    // allow verdict so a concurrent disable, retarget, or reassignment cannot
    // authorize any fan-out sibling whose durable snapshot is no longer current.
    const refreshed = await this.deps.hooks.getManyUnscoped(fences.map((fence) => HookId(fence.hookId)))
    const refreshedById = new Map<string, HookRecord>(refreshed.map((candidate) => [candidate.id, candidate]))
    return fences.every((fence, index) => {
      const expected = authorizedHooks[index]
      return (
        expected !== undefined &&
        this.matchesAuthorizedHook(refreshedById.get(fence.hookId) ?? null, req.repoId, fence, {
          orgId: expected.orgId,
          agentId: expected.agentId
        })
      )
    })
  }

  private matchesAuthorizedHook(
    hook: HookRecord | null,
    repoId: string,
    fence: Pick<RcGithubCommentAuthz, 'hookId' | 'configRevision' | 'dispatchRevision'>,
    expected?: Pick<HookRecord, 'orgId' | 'agentId'>
  ): hook is HookRecord {
    return (
      hook !== null &&
      hook.enabled &&
      hook.kind === 'github' &&
      hook.agentId !== null &&
      hook.id === fence.hookId &&
      hook.repoId === BigInt(repoId) &&
      hook.configRevision === BigInt(fence.configRevision) &&
      hook.dispatchRevision === BigInt(fence.dispatchRevision) &&
      (expected === undefined || (hook.orgId === expected.orgId && hook.agentId === expected.agentId))
    )
  }
}
