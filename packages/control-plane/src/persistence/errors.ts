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
