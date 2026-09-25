// PgAgentInstallationAuthorizationRepo — installation grants per agent (agent-multi-repo-authorization.md decision 10).
import type {
  AgentInstallationAuthorization,
  PrismaClient,
  RepoMaterialization as DbRepoMaterialization,
  User
} from '../../generated/prisma/client.js'
import { Prisma } from '../../generated/prisma/client.js'
import type { PrismaLike } from '../prisma.js'
import type {
  AgentInstallationAuthorizationRecord,
  AgentInstallationAuthorizationRepo,
  InstallationMaterialization,
  RepoAccess
} from '../ports.js'
import { AgentId } from '../../domain/ids.js'
import { bumpAgentConfigRevisions } from './organization-environment-fence.js'
import { RAISABLE_FROM } from './agent-repo-auth.repo.js'

const withCreator = { createdBy: true } as const

type Row = AgentInstallationAuthorization & { createdBy: User | null }

// The wire spells it `on-demand`, the Prisma member `on_demand`; a DB CHECK keeps `always` out of this table.
const toDbMaterialization = (m: InstallationMaterialization): DbRepoMaterialization =>
  m === 'on-demand' ? 'on_demand' : m
const fromDbMaterialization = (m: DbRepoMaterialization): InstallationMaterialization =>
  m === 'decision' ? 'decision' : 'on-demand'

function toRecord(r: Row): AgentInstallationAuthorizationRecord {
  return {
    id: r.id,
    agentId: AgentId(r.agentId),
    provider: 'github',
    installationId: r.installationId,
    accountLogin: r.accountLogin,
    access: r.access as RepoAccess,
    materialize: fromDbMaterialization(r.materialize),
    createdAt: r.createdAt,
    createdBy: r.createdBy
      ? { userId: r.createdBy.id, displayName: r.createdBy.displayName, email: r.createdBy.email }
      : null
  }
}

// Every field is projected onto AgentSpec.workspace.additionalInstallations, so every writer bumps the agent's revision in its transaction.
export class PgAgentInstallationAuthorizationRepo implements AgentInstallationAuthorizationRepo {
  constructor(private readonly db: PrismaLike) {}

  private transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    if ('$transaction' in this.db) return (this.db as PrismaClient).$transaction(fn)
    return fn(this.db as Prisma.TransactionClient)
  }

  async create(input: {
    agentId: AgentId
    installationId: bigint
    accountLogin: string
    access: RepoAccess
    materialize?: InstallationMaterialization
    createdByUserId?: string
  }): Promise<AgentInstallationAuthorizationRecord> {
    return this.transaction(async (tx) => {
      const row = await tx.agentInstallationAuthorization.create({
        data: {
          agentId: input.agentId,
          provider: 'github',
          installationId: input.installationId,
          accountLogin: input.accountLogin,
          access: input.access,
          materialize: toDbMaterialization(input.materialize ?? 'on-demand'),
          ...(input.createdByUserId ? { createdByUserId: input.createdByUserId } : {})
        },
        include: withCreator
      })
      await bumpAgentConfigRevisions(tx, [input.agentId])
      return toRecord(row)
    })
  }

  async get(id: string): Promise<AgentInstallationAuthorizationRecord | null> {
    const row = await this.db.agentInstallationAuthorization.findUnique({ where: { id }, include: withCreator })
    return row ? toRecord(row) : null
  }

  async listForAgent(agentId: AgentId): Promise<AgentInstallationAuthorizationRecord[]> {
    const rows = await this.db.agentInstallationAuthorization.findMany({
      where: { agentId },
      include: withCreator,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
    })
    return rows.map(toRecord)
  }

  async update(
    id: string,
    patch: { access?: RepoAccess; materialize?: InstallationMaterialization }
  ): Promise<AgentInstallationAuthorizationRecord | null> {
    return this.transaction(async (tx) => {
      const row = await tx.agentInstallationAuthorization.findUnique({ where: { id }, select: { agentId: true } })
      if (!row) return null
      // Raise-only at the write: the tier condition is re-read after a concurrent raise commits, so a stale request is a no-op.
      const raised =
        patch.access === undefined
          ? 0
          : (
              await tx.agentInstallationAuthorization.updateMany({
                where: { id, access: { in: RAISABLE_FROM[patch.access] } },
                data: { access: patch.access }
              })
            ).count
      const materialize = patch.materialize === undefined ? undefined : toDbMaterialization(patch.materialize)
      const moved =
        materialize === undefined
          ? 0
          : (
              await tx.agentInstallationAuthorization.updateMany({
                where: { id, materialize: { not: materialize } },
                data: { materialize }
              })
            ).count
      if (raised + moved > 0) await bumpAgentConfigRevisions(tx, [row.agentId])
      const current = await tx.agentInstallationAuthorization.findUnique({ where: { id }, include: withCreator })
      return current ? toRecord(current) : null
    })
  }

  async updateAccountLogin(id: string, accountLogin: string): Promise<void> {
    await this.write(id, { accountLogin })
  }

  async remove(id: string): Promise<boolean> {
    return this.transaction(async (tx) => {
      const row = await tx.agentInstallationAuthorization.findUnique({ where: { id }, select: { agentId: true } })
      // deleteMany (not delete) so a concurrently removed row is a count of 0, not a throw.
      const removed = await tx.agentInstallationAuthorization.deleteMany({ where: { id } })
      if (removed.count > 0 && row) await bumpAgentConfigRevisions(tx, [row.agentId])
      return removed.count > 0
    })
  }

  // An unchanged value writes nothing and keeps the revision; a changed one bumps it in the same transaction.
  private write(
    id: string,
    data: { access?: RepoAccess; materialize?: DbRepoMaterialization; accountLogin?: string }
  ): Promise<AgentInstallationAuthorizationRecord | null> {
    return this.transaction(async (tx) => {
      const row = await tx.agentInstallationAuthorization.findUnique({ where: { id }, include: withCreator })
      if (!row) return null
      const changed = (Object.keys(data) as Array<keyof typeof data>).some((key) => data[key] !== row[key])
      if (!changed) return toRecord(row)
      const updated = await tx.agentInstallationAuthorization.update({ where: { id }, data, include: withCreator })
      await bumpAgentConfigRevisions(tx, [row.agentId])
      return toRecord(updated)
    })
  }
}
