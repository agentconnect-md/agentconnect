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
 * Thrown by `BotRepo.setShareable(false)` when the row-locked recount still sees
 * more than one ACTIVE install — disabling sharing then would orphan the others'
 * routes. The recount runs under the same bot-row lock `IntegrationRepo.
 * addBotMembership` takes, so a concurrent admission and a disable serialize:
 * whichever commits second observes the first (no stale-snapshot bypass).
 */
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
 * Restricted visibility requires a durable owner. Ownerless org-visible rows
 * remain editable, but cannot be made restricted until an explicit,
 * provenance-aware ownership workflow assigns one.
 */
export class ResourceOwnerMissing extends Error {
  readonly code = 'RESOURCE_OWNER_MISSING' as const

  constructor() {
    super('ownerless resource cannot be restricted')
    this.name = 'ResourceOwnerMissing'
  }
}
