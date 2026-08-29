/**
 * PgAgentRepoAuthorizationRepo — explicit repository grants per agent
 * (issue #457, agent-multi-repo-authorization.md; gitlab-com-integration.md §8.3).
 *
 * Metadata only (repo identity + access tier); no token material ever lands
 * here. Rows are hard-deleted on revoke — unlike installations there is no
 * provenance pointer into this table, and an already-minted token surviving
 * to its ≤1h expiry is the documented revocation window.
 *
 * `repoId` + `repoFullName` are projected onto `AgentSpec.workspace.additionalRepos`
 * (multi-repository-workspaces.md decision 2), so every writer that changes either
 * bumps the owning agent's `configRevision` in the SAME transaction. Without it the
 * daemon receives new spec content at the applied revision and refuses it as an
 * invariant violation — permanently, on every reconnect.
 */
import type { AgentRepoAuthorization, PrismaClient, User } from '../../generated/prisma/client.js'
import { Prisma } from '../../generated/prisma/client.js'
import type { PrismaLike } from '../prisma.js'
import type { CodeHostProvider } from '@agentconnect.md/protocol'
import type { AgentRepoAuthorizationRecord, AgentRepoAuthorizationRepo, RepoAccess } from '../ports.js'
import { AgentId } from '../../domain/ids.js'
import { PgHookRepo } from './hook.repo.js'
import { lockHookReviewAgentRepoScope } from '../review-projection-lock.js'
import { AgentWorkspaceRepoConflict } from '../errors.js'
import { bumpAgentConfigRevisions } from './organization-environment-fence.js'

const withCreator = { createdBy: true } as const

type Row = AgentRepoAuthorization & { createdBy: User | null }

function toRecord(r: Row): AgentRepoAuthorizationRecord {
  return {
    id: r.id,
    agentId: AgentId(r.agentId),
    provider: r.provider as CodeHostProvider,
    repoId: r.repoId,
    repoFullName: r.repoFullName,
    access: r.access as RepoAccess,
    createdAt: r.createdAt,
    createdBy: r.createdBy
      ? { userId: r.createdBy.id, displayName: r.createdBy.displayName, email: r.createdBy.email }
      : null
  }
}

export class PgAgentRepoAuthorizationRepo implements AgentRepoAuthorizationRepo {
  constructor(private readonly db: PrismaLike) {}

  private transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    if ('$transaction' in this.db) return (this.db as PrismaClient).$transaction(fn)
    return fn(this.db as Prisma.TransactionClient)
  }

  async create(input: {
    agentId: AgentId
    provider: CodeHostProvider
    repoId: bigint
    repoFullName: string
    access: RepoAccess
    createdByUserId?: string
  }): Promise<AgentRepoAuthorizationRecord> {
    return this.transaction(async (tx) => {
      // Linearize with lazy workspace-id repair. If create wins first, repair
      // deletes the now-redundant row; if repair wins, create observes the
      // numeric workspace identity and refuses to recreate it.
      await lockHookReviewAgentRepoScope(tx, input.agentId, input.repoId)
      const agent = await tx.agent.findUnique({
        where: { id: input.agentId },
        select: { workspaceRepoId: true, gitCredentialProvider: true }
      })
      // The hosts number repositories independently, so the workspace collides only
      // when the grant names ITS provider — `gitCredentialProvider` is that provider.
      if (agent?.workspaceRepoId === input.repoId && agent.gitCredentialProvider === input.provider) {
        throw new AgentWorkspaceRepoConflict(input.repoId)
      }
      const row = await tx.agentRepoAuthorization.create({
        data: {
          agentId: input.agentId,
          provider: input.provider,
          repoId: input.repoId,
          repoFullName: input.repoFullName,
          access: input.access,
          ...(input.createdByUserId ? { createdByUserId: input.createdByUserId } : {})
        },
        include: withCreator
      })
      await bumpAgentConfigRevisions(tx, [input.agentId])
      return toRecord(row)
    })
  }

  async get(id: string): Promise<AgentRepoAuthorizationRecord | null> {
    const row = await this.db.agentRepoAuthorization.findUnique({ where: { id }, include: withCreator })
    return row ? toRecord(row) : null
  }

  async listForAgent(agentId: AgentId): Promise<AgentRepoAuthorizationRecord[]> {
    const rows = await this.db.agentRepoAuthorization.findMany({
      where: { agentId },
      include: withCreator,
      orderBy: { createdAt: 'asc' }
    })
    return rows.map(toRecord)
  }

  async updateAccess(id: string, access: RepoAccess): Promise<AgentRepoAuthorizationRecord | null> {
    const updated = await this.db.agentRepoAuthorization.updateMany({ where: { id }, data: { access } })
    if (updated.count === 0) return null
    return this.get(id)
  }

  async updateFullName(id: string, repoFullName: string): Promise<void> {
    await this.transaction(async (tx) => {
      // updateMany (not update) so a concurrently-deleted row is a count of 0, not a throw.
      const changed = await tx.agentRepoAuthorization.updateMany({
        where: { id, repoFullName: { not: repoFullName } },
        data: { repoFullName }
      })
      if (changed.count === 0) return
      const row = await tx.agentRepoAuthorization.findUnique({ where: { id }, select: { agentId: true } })
      if (row) await bumpAgentConfigRevisions(tx, [row.agentId])
    })
  }

  async remove(id: string): Promise<void> {
    await this.transaction(async (tx) => {
      const row = await tx.agentRepoAuthorization.findUnique({ where: { id }, select: { agentId: true } })
      const removed = await tx.agentRepoAuthorization.deleteMany({ where: { id } })
      if (removed.count > 0 && row) await bumpAgentConfigRevisions(tx, [row.agentId])
    })
  }

  async removeWithReviewProjectionCleanup(
    id: string,
    agentId: AgentId,
    provider: CodeHostProvider,
    repoId: bigint,
    at: Date,
    desiredState: string
  ): Promise<void> {
    await this.transaction(async (tx) => {
      await lockHookReviewAgentRepoScope(tx, agentId, repoId)
      const agent = await tx.agent.findUnique({
        where: { id: agentId },
        select: { workspaceRepoId: true, gitCredentialProvider: true }
      })
      const workspaceIsThisRepo = agent?.workspaceRepoId === repoId && agent.gitCredentialProvider === provider
      // HookReviewProjection is the GitHub Checks ledger — GitLab publishes notes and
      // has no durable projection to retire, so only a github grant reaches it.
      //
      // A lazy workspace repair may have classified this legacy grant while
      // the delete request was in flight. Deleting the duplicate is harmless;
      // tombstoning would incorrectly revoke still-valid workspace Checks.
      if (provider === 'github' && !workspaceIsThisRepo) {
        // PgHookRepo re-enters the same xact advisory lock before its candidate
        // scan. PostgreSQL transaction advisory locks are re-entrant, keeping
        // the shared lock order without opening a no-row race.
        await new PgHookRepo(tx).tombstoneReviewProjectionsForAgentRepo(agentId, repoId, at, desiredState)
      }
      const removed = await tx.agentRepoAuthorization.deleteMany({ where: { id, agentId, provider, repoId } })
      if (removed.count > 0) await bumpAgentConfigRevisions(tx, [agentId])
    })
  }
}
