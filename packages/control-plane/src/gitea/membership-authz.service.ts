// The Gitea arm of `rc/codehost-membership-authz` (gitea-integration.md §8): the actor's CURRENT permission through the connection token, never a delivered label; the login is re-resolved to its id first and the bot's `admin` carries the lookup, so `admin_degraded` fails closed.
import type { RcCodeHostMembershipAuthz } from '@agentconnect.md/protocol'
import { HookId } from '../domain/ids.js'
import type {
  CodeHostTrustedActorRepo,
  GiteaConnectionRepo,
  GiteaRepositoryBindingRepo,
  HookRecord,
  HookRepo
} from '../persistence/ports.js'
import {
  giteaCollaboratorPermission,
  giteaListRepositoryTeams,
  giteaPermissionAdmits,
  giteaTeam,
  giteaTeamMember,
  giteaTeamUnitAdmits,
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
  /** The repository's "Trusted users": a maintainer's vouch admits an actor below the write bar. */
  trustedActors: Pick<CodeHostTrustedActorRepo, 'actorIdsForRepo'>
  api: GiteaApiClient
  /** Where the team fallback names a bot that cannot read the teams; a plain denial stays silent. */
  log?: { warn(obj: object, msg: string): void }
  /** Test override; production stays below the relay's 5 second correlator. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 4_000
/** The structured reason logged when every qualifying team is unreadable through the bot — its standing, not the user's. */
export const TEAM_LOOKUP_UNAVAILABLE_REASON = 'team_lookup_unavailable'

interface Actor {
  id: bigint
  username: string | undefined
}

interface RepoPath {
  owner: string
  repo: string
}

/** `unreadable` is the bot's problem (a team it cannot see), `absent` the actor's; only `member` admits. */
type TeamVerdict = 'member' | 'absent' | 'unreadable'

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
    const trusted = await this.deps.trustedActors.actorIdsForRepo(first.orgId, 'gitea', repoId)
    try {
      for (const actor of actors) {
        if (!(await this.actorAdmitted(token, path, actor, trusted, repoId))) return false
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

  // §8: the re-resolved id must match the delivered one, then the permission, the "Trusted users" list, or a team admits; a failed identity check is rescued by neither.
  private async actorAdmitted(
    token: string,
    path: RepoPath,
    actor: Actor,
    trusted: ReadonlySet<string>,
    repoId: bigint
  ): Promise<boolean> {
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
    if (giteaPermissionAdmits(permission.permission) || trusted.has(actor.id.toString())) return true
    return this.teamAdmits(token, path, actor, repoId)
  }

  // Gitea ≥ 1.24 stores a General Access team as flat `read` whatever its units grant (go-gitea/gitea#34128), so a below-bar answer asks the teams whose `repo.code` reaches write.
  private async teamAdmits(token: string, path: RepoPath, actor: Actor, repoId: bigint): Promise<boolean> {
    let candidates
    try {
      const teams = await giteaListRepositoryTeams(token, path.owner, path.repo, this.deps.api)
      candidates = teams.filter((team) => giteaTeamUnitAdmits(team.units_map, team.permission))
    } catch (e) {
      if (isGiteaAuthRejection(e)) throw e
      this.warnUnavailable(repoId, 0, e)
      return false
    }
    if (candidates.length === 0) return false
    const verdicts = await Promise.all(candidates.map((team) => this.teamVerdict(token, team.id, actor)))
    if (verdicts.includes('member')) return true
    // Every qualifying team unreadable is the bot's standing, not the user's: name it so an operator can tell the two apart.
    if (verdicts.every((verdict) => verdict === 'unreadable')) this.warnUnavailable(repoId, candidates.length)
    return false
  }

  // The team read first: its 200 makes a members 404 a definitive "not a member" rather than a team the bot cannot see.
  private async teamVerdict(token: string, teamId: number, actor: Actor): Promise<TeamVerdict> {
    try {
      if ((await giteaTeam(token, teamId, this.deps.api)) === null) return 'unreadable'
      const member = await giteaTeamMember(token, teamId, actor.username!, this.deps.api)
      return member !== null && BigInt(member.id) === actor.id ? 'member' : 'absent'
    } catch (e) {
      if (isGiteaAuthRejection(e)) throw e
      return 'unreadable'
    }
  }

  private warnUnavailable(repoId: bigint, teams: number, err?: unknown): void {
    this.deps.log?.warn(
      {
        repoId: repoId.toString(),
        teams,
        reason: TEAM_LOOKUP_UNAVAILABLE_REASON,
        ...(err !== undefined ? { err } : {})
      },
      'gitea membership authz: no qualifying team is readable through the connection bot — add it to the organization Owners team'
    )
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
