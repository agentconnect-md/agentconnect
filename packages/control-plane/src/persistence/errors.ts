/**
 * Persistence-layer errors (design §3.14).
 *
 * Repositories translate Postgres constraint violations into these typed,
 * transport-free errors so services (C3) can react without knowing about Prisma
 * or Postgres error codes.
 */

/**
 * Thrown by `AssignmentRepo.assign` when the partial-unique index
 * (`assignment_session_active_uq`, §3.7) rejects a second active owner for a
 * sessionKey — the storage-level guard that at most one daemon serves a session.
 */
export class OwnerConflict extends Error {
  readonly code = 'OWNER_CONFLICT' as const
  constructor(
    readonly platform: string,
    readonly channel: string,
    readonly thread: string | undefined
  ) {
    super(`session already has an active owner: ${platform}:${channel}:${thread ?? '-'}`)
    this.name = 'OwnerConflict'
  }
}

/** Postgres unique-violation SQLSTATE. */
export const PG_UNIQUE_VIOLATION = '23505'

/**
 * Thrown by `enrollDaemonInSet` when the membership row would break the set's tenancy invariant
 * (docs/designs/daemon-groups.md §2): an org-less set accepts only org-less daemons, an org set
 * only that org's daemons. Enforced where the row is written, because it is what lets the read
 * path be one membership lookup with no tenancy branch.
 */
export class MemberSetTenancyMismatch extends Error {
  readonly code = 'MEMBER_SET_TENANCY_MISMATCH' as const
  constructor(
    readonly setId: string,
    readonly daemonId: string
  ) {
    super(`daemon ${daemonId} does not belong to the tenancy of member set ${setId}`)
    this.name = 'MemberSetTenancyMismatch'
  }
}

/**
 * Thrown by `deleteForOrg` when the set still has members or `set`-placed agents. Dropping it
 * would unplace those agents by cascade (`Agent.setId` is SetNull), so the set is emptied
 * deliberately or not at all.
 */
export class MemberSetInUse extends Error {
  readonly code = 'MEMBER_SET_IN_USE' as const
  constructor(readonly setId: string) {
    super(`member set ${setId} still has members or placed agents`)
    this.name = 'MemberSetInUse'
  }
}

/**
 * Thrown by `enrollOperator` when the daemon still has agents pinned directly to it. A set member
 * serves only what it holds a lease for, so those agents would be placed and unservable the moment
 * the membership row landed (docs/designs/daemon-groups.md §3) — they are re-placed onto the set
 * first. Taken under the per-daemon fence, so it cannot race a concurrent placement.
 */
export class DaemonHasPlacedAgents extends Error {
  readonly code = 'DAEMON_HAS_PLACED_AGENTS' as const
  constructor(
    readonly daemonId: string,
    readonly placed: number
  ) {
    super(`daemon ${daemonId} still has ${placed} directly placed agent(s)`)
    this.name = 'DaemonHasPlacedAgents'
  }
}

/**
 * Thrown by `enrollOperator` when the daemon is already in a DIFFERENT set. A daemon is in at most
 * one, and the insert is idempotent, so without this check the losing half of two concurrent
 * enrolments would silently no-op and still answer 200 — naming a set the daemon never joined.
 * Moving a daemon between sets is a two-phase transition (§3), never this path.
 */
export class DaemonAlreadyInSet extends Error {
  readonly code = 'DAEMON_ALREADY_IN_SET' as const
  constructor(
    readonly daemonId: string,
    readonly setId: string
  ) {
    super(`daemon ${daemonId} is already a member of member set ${setId}`)
    this.name = 'DaemonAlreadyInSet'
  }
}

/**
 * Thrown by `withdraw` when the daemon still holds a live duty lease. Committing the withdrawal
 * then would let a successor claim work the leaver may still be running — the split the ledger
 * exists to prevent (§3). A lapsed lease is not this: it is strictly later than the member's own
 * self-fence, so by then it has provably stopped serving.
 */
export class DaemonHoldsDuty extends Error {
  readonly code = 'DAEMON_HOLDS_DUTY' as const
  constructor(
    readonly daemonId: string,
    readonly held: number
  ) {
    super(`daemon ${daemonId} still holds ${held} live duty group(s)`)
    this.name = 'DaemonHoldsDuty'
  }
}

/**
 * Thrown by the placement writers when a `daemon` placement names a machine that is in a member
 * set (docs/designs/daemon-groups.md §3). A set member serves only what it holds a lease for, so
 * an agent pinned to one would be unservable — the agent belongs on the set instead.
 */
export class DaemonPlacementInSet extends Error {
  readonly code = 'DAEMON_PLACEMENT_IN_SET' as const
  constructor(
    readonly agentId: string,
    readonly daemonId: string
  ) {
    super(`agent ${agentId} may not be pinned to daemon ${daemonId}, which is a member set member`)
    this.name = 'DaemonPlacementInSet'
  }
}

/**
 * Thrown by the placement writers when a `set` placement names a set the agent may not reference
 * (docs/designs/daemon-groups.md §2, third write-time invariant): only the org-less set or a set
 * of the agent's own org. Without it, `mayHold`'s single rule would let org X's members claim an
 * org Y agent that had been pointed at X's set.
 */
export class AgentSetPlacementDenied extends Error {
  readonly code = 'AGENT_SET_PLACEMENT_DENIED' as const
  constructor(
    readonly agentId: string,
    readonly setId: string
  ) {
    super(`agent ${agentId} may not be placed on member set ${setId}`)
    this.name = 'AgentSetPlacementDenied'
  }
}

/**
 * Thrown by org-fenced agent mutations (docs/designs/org-scoped-data-layer.md
 * §3) when the addressed row does not exist in the caller's organization — a
 * cross-org id is deliberately indistinguishable from a missing row. Routes
 * pre-check with the org-fenced `get`, so reaching this mid-request means a
 * delete race (previously Prisma's P2025) or a bypassed pre-check.
 */
export class AgentMissing extends Error {
  readonly code = 'AGENT_MISSING' as const
  constructor(readonly agentId: string) {
    super(`agent ${agentId} not found in this organization`)
    this.name = 'AgentMissing'
  }
}

/**
 * Thrown by org-fenced bot mutations whose fence sits on a row-lock read rather
 * than on the write's own `where` (docs/designs/org-scoped-data-layer.md §3) —
 * today `BotRepo.setShareable`, where refusing BEFORE the install recount is
 * what keeps a foreign bot's occupancy from leaking as a `BotStillShared` 409.
 * A cross-org id is deliberately indistinguishable from a missing row.
 */
export class BotMissing extends Error {
  readonly code = 'BOT_MISSING' as const
  constructor(readonly botId: string) {
    super(`bot ${botId} not found in this organization`)
    this.name = 'BotMissing'
  }
}

/**
 * Thrown by `BotRepo.setShareable(false)` when the row-locked recount still sees
 * more than one ACTIVE install — disabling sharing then would orphan the others'
 * routes. The recount runs under the same bot-row lock `IntegrationRepo.
 * addBotMembership` takes, so a concurrent admission and a disable serialize:
 * whichever commits second observes the first (no stale-snapshot bypass).
 */
/** A Bot with this external app identity already exists on this platform (the D6
 *  `(platform, externalAppId, externalTenantId)` fence, the generic successor of
 *  `workspace_taken`). Mapped to 409 at the route. */
export class BotExternalIdentityTaken extends Error {
  readonly code = 'BOT_EXTERNAL_IDENTITY_TAKEN' as const
  constructor(readonly platform: string) {
    super(`a bot for this ${platform} app identity already exists`)
    this.name = 'BotExternalIdentityTaken'
  }
}

/** A workspace already connected to a DIFFERENT organization refuses a second
 *  claim (ingress-tenant-fence.md §5): one app installed into one workspace by
 *  two orgs would share its inbound-verification secret AND its tenant, which
 *  the relay's delivery-time fence cannot tell apart — admission is the only
 *  place to stop it. Mapped to 409 at the HTTP edge; the platform supplies the
 *  copy, and it never names the holding organization. */
export class BotWorkspaceClaimed extends Error {
  readonly code = 'BOT_WORKSPACE_CLAIMED' as const
  constructor(message: string) {
    super(message)
    this.name = 'BotWorkspaceClaimed'
  }
}

export class BotStillShared extends Error {
  readonly code = 'BOT_STILL_SHARED' as const
  constructor(readonly activeInstalls: number) {
    super(`bot is shared by ${activeInstalls} agents — uninstall the others before disabling sharing`)
    this.name = 'BotStillShared'
  }
}

/** A GitHub installation is already claimed by another AgentConnect org.
 * Claims are immutable: sync/callback/doorbell updates may refresh facts but
 * can never move the installation across tenants. */
export class GithubInstallationClaimConflict extends Error {
  readonly code = 'GITHUB_INSTALLATION_CLAIM_CONFLICT' as const
  constructor(
    readonly installationId: bigint,
    readonly claimedOrgId: string,
    readonly requestedOrgId: string
  ) {
    super(`github installation ${installationId} is already claimed by another organization`)
    this.name = 'GithubInstallationClaimConflict'
  }
}

/** The deployment-global project claim (gitlab-com-integration.md §8.1/§10.2):
 * one managing organization per numeric GitLab project. A uniqueness loser may
 * not begin any provider mutation. */
export class GitlabProjectClaimConflict extends Error {
  readonly code = 'GITLAB_PROJECT_CLAIM_CONFLICT' as const
  constructor(readonly projectId: bigint) {
    super(`gitlab project ${projectId} is already claimed by another organization`)
    this.name = 'GitlabProjectClaimConflict'
  }
}

/** The host axis moved under an in-flight GitLab write (§24.1): the persisted
 * document now names another instance, so this operation's credentials and
 * host-relative ids must not be committed against it. */
export class GitlabAxisRetargeted extends Error {
  readonly code = 'gitlab_base_url_changed' as const
  constructor(
    readonly operationBaseUrl: string,
    readonly persistedBaseUrl: string
  ) {
    super(`the gitlab instance changed to ${persistedBaseUrl} while this ${operationBaseUrl} operation was in flight`)
    this.name = 'GitlabAxisRetargeted'
  }
}

/** The OAuth callback lost the race with a membership removal (§9.4): the
 * starting user is no longer a member, so no connection may be (re)created. */
export class GitlabMembershipGone extends Error {
  readonly code = 'GITLAB_MEMBERSHIP_GONE' as const
  constructor(orgless?: string) {
    super(orgless ?? 'the starting user is no longer a member of the organization')
    this.name = 'GitlabMembershipGone'
  }
}

/** A numeric repository is already the agent's implicit workspace authority,
 * so persisting a second "additional repository" grant would be redundant and
 * could later make grant deletion look like a real authority revocation. */
export class AgentWorkspaceRepoConflict extends Error {
  readonly code = 'AGENT_WORKSPACE_REPO_CONFLICT' as const
  constructor(readonly repoId: bigint) {
    super(`repository ${repoId} is already the agent workspace repository`)
    this.name = 'AgentWorkspaceRepoConflict'
  }
}

/** Removing write authority for a workspace repository would invalidate an
 * enabled GitHub integration that performs reviews or reports Checks. The
 * workspace change and hook writes share the same advisory scope lock, so this
 * remains a durable invariant under concurrent edits rather than a UI-only
 * preflight. */
export const AGENT_WORKSPACE_INTEGRATION_CONFLICT_MESSAGE =
  'This workspace change conflicts with an enabled GitHub integration that reviews pull requests or reports Checks for the current repository. Keep that repository with read & write access or turn those actions off.'

export class AgentWorkspaceIntegrationConflict extends Error {
  readonly code = 'AGENT_WORKSPACE_INTEGRATION_CONFLICT' as const
  constructor(readonly repoId: bigint) {
    super(AGENT_WORKSPACE_INTEGRATION_CONFLICT_MESSAGE)
    this.name = 'AgentWorkspaceIntegrationConflict'
  }
}

/**
 * An agent write touching an external-memory binding lost the fail-fast race
 * for its connection's advisory mutation scope (persistence/memory-connection-lock.ts):
 * a connection/grant mutation or a conflicting agent write holds it. HTTP maps
 * this to 409 so the operator retries against settled state — the same
 * semantics the process-local ExclusiveMutationGate used to provide.
 */
export class MemoryConnectionBusy extends Error {
  readonly code = 'MEMORY_CONNECTION_BUSY' as const

  constructor() {
    super('external memory connection is being updated')
    this.name = 'MemoryConnectionBusy'
  }
}

/**
 * The transaction-time existence check behind an agent's external-memory bind
 * found no such connection in the agent's organization. The route-level
 * validation answers the friendly 400 first; this closes the residual window
 * where a connection DELETE commits between that validation and the agent
 * write's own transaction.
 */
export class MemoryConnectionMissing extends Error {
  readonly code = 'MEMORY_CONNECTION_MISSING' as const

  constructor() {
    super('external memory connection not found in this organization')
    this.name = 'MemoryConnectionMissing'
  }
}

/**
 * Thrown by org-fenced hook mutations whose fence sits on a transaction-time row
 * read rather than on the write's own `where` (docs/designs/org-scoped-data-layer.md
 * §3) — `HookRepo.upsert` (whose update branch would otherwise rewrite a foreign
 * row's `orgId`) and `HookRepo.remove`, which must refuse before it tombstones
 * the hook's durable review projections. A cross-org id is deliberately
 * indistinguishable from a missing row.
 */
export class HookMissing extends Error {
  readonly code = 'HOOK_MISSING' as const
  constructor(readonly hookId: string) {
    super(`hook ${hookId} not found in this organization`)
    this.name = 'HookMissing'
  }
}

/**
 * Thrown by the org-fenced `CronRepo.upsert` when the client-minted `cronId`
 * already names a row in ANOTHER organization (docs/designs/org-scoped-data-layer.md
 * §3). Unlike the other fences this one refuses a TAKEOVER rather than a leak:
 * the PUT is a create-or-edit, so without it the update branch would rewrite a
 * foreign row — `orgId` included. Surfaces as the same 404 as an unknown id.
 */
export class CronMissing extends Error {
  readonly code = 'CRON_MISSING' as const
  constructor(readonly cronId: string) {
    super(`cron ${cronId} not found in this organization`)
    this.name = 'CronMissing'
  }
}

/**
 * A membership-dependent transaction reached persistence after one of its
 * required organization memberships disappeared. HTTP maps this to the same
 * not-found shape as the org-scope guard; non-HTTP callers can match the code.
 */
export class OrgMembershipMissing extends Error {
  readonly code = 'ORG_MEMBERSHIP_MISSING' as const

  constructor() {
    super('required organization membership no longer exists')
    this.name = 'OrgMembershipMissing'
  }
}

/**
 * An owner transition would leave an organization without any owner. The
 * repository checks this under the organization transition lock, before the
 * role update or membership deletion commits.
 */
export class OrgOwnerRequired extends Error {
  readonly code = 'ORG_OWNER_REQUIRED' as const

  constructor() {
    super('an organization needs at least one owner')
    this.name = 'OrgOwnerRequired'
  }
}

/** A non-admin account reached the org creation quota; the message states the ceiling, never who is exempt. */
export class OrgCreationLimitReached extends Error {
  readonly code = 'ORG_CREATION_LIMIT_REACHED' as const

  constructor(readonly limit: number) {
    super(
      limit === 0
        ? "organization creation isn't available for this account"
        : `this account has reached its limit of ${limit} organization${limit === 1 ? '' : 's'}`
    )
    this.name = 'OrgCreationLimitReached'
  }
}

/** Selected visibility must never commit without a current organization member
 * in its explicit audience. */
export class ResourceAudienceEmpty extends Error {
  readonly code = 'RESOURCE_AUDIENCE_EMPTY' as const

  constructor() {
    super('Selected access requires at least one current organization member')
    this.name = 'ResourceAudienceEmpty'
  }
}
