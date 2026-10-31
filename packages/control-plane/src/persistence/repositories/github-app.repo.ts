// Agents' dedicated GitHub Apps: metadata rows plus the org-sealed private key (§Dedicated Apps).
import type { GithubApp, Prisma, PrismaClient } from '../../generated/prisma/client.js'
import type { PrismaLike } from '../prisma.js'
import type { GithubAppRecord, GithubAppRepo, GithubAppSecretStore } from '../ports.js'
import { OrgId } from '../../domain/ids.js'
import type { SecretCipher } from '../../secrets/cipher.js'
import { orgScope } from '../../secrets/scope.js'

const withAgent = { agent: { select: { id: true } } } as const

function toRecord(r: GithubApp & { agent: { id: string } | null }): GithubAppRecord {
  return {
    id: r.id,
    orgId: OrgId(r.orgId),
    agentId: r.agent?.id ?? null,
    appId: r.appId,
    slug: r.slug,
    clientId: r.clientId,
    botUserId: r.botUserId,
    retiredAt: r.retiredAt,
    createdAt: r.createdAt
  }
}

class AgentNotBindable extends Error {}

export class PgGithubAppRepo implements GithubAppRepo {
  constructor(private readonly prisma: PrismaLike) {}

  private transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    if ('$transaction' in this.prisma) return (this.prisma as PrismaClient).$transaction(fn)
    return fn(this.prisma as Prisma.TransactionClient)
  }

  async createForAgent(input: {
    id: string
    orgId: OrgId
    agentId: string
    appId: bigint
    slug: string
    clientId: string | null
    botUserId: bigint | null
  }): Promise<GithubAppRecord | null> {
    const { agentId, ...data } = input
    try {
      return await this.transaction(async (tx) => {
        await tx.githubApp.create({ data })
        // Compare-and-set on the agent row: an agent that is gone or already owns an App rolls the create back.
        const bound = await tx.agent.updateMany({
          where: { id: agentId, orgId: input.orgId, githubAppId: null },
          data: { githubAppId: input.id }
        })
        if (bound.count === 0) throw new AgentNotBindable()
        return toRecord(await tx.githubApp.findUniqueOrThrow({ where: { id: input.id }, include: withAgent }))
      })
    } catch (e) {
      if (e instanceof AgentNotBindable) return null
      throw e
    }
  }

  async get(orgId: OrgId, id: string): Promise<GithubAppRecord | null> {
    const row = await this.prisma.githubApp.findUnique({ where: { id, orgId }, include: withAgent })
    return row ? toRecord(row) : null
  }

  async getUnscoped(id: string): Promise<GithubAppRecord | null> {
    const row = await this.prisma.githubApp.findUnique({ where: { id }, include: withAgent })
    return row ? toRecord(row) : null
  }

  async getForAgent(orgId: OrgId, agentId: string): Promise<GithubAppRecord | null> {
    const row = await this.prisma.githubApp.findFirst({ where: { orgId, agent: { id: agentId } }, include: withAgent })
    return row ? toRecord(row) : null
  }

  async listForOrg(orgId: OrgId): Promise<GithubAppRecord[]> {
    const rows = await this.prisma.githubApp.findMany({
      where: { orgId },
      include: withAgent,
      orderBy: { slug: 'asc' }
    })
    return rows.map(toRecord)
  }

  async retire(orgId: OrgId, id: string, at: Date): Promise<boolean> {
    return this.transaction(async (tx) => {
      const res = await tx.githubApp.updateMany({ where: { id, orgId, retiredAt: null }, data: { retiredAt: at } })
      if (res.count === 0) return false
      await tx.agent.updateMany({ where: { orgId, githubAppId: id }, data: { githubAppId: null } })
      return true
    })
  }

  async reapRetired(
    before: Date,
    limit: number
  ): Promise<Array<{ id: string; orgId: OrgId; installationIds: bigint[] }>> {
    return this.transaction(async (tx) => {
      // Only a tombstone settled at failure can never be written again: the org-delete settle test, row for row.
      const rows = await tx.$queryRaw<Array<{ id: string; orgId: string }>>`
        SELECT a."id", a."orgId" FROM "github_app" a
        WHERE a."retiredAt" < ${before}
          AND NOT EXISTS (
            SELECT 1 FROM "hook_review_projection" p
            JOIN "github_installation" i ON i."installationId" = p."lastResolvedInstallationId"
            WHERE i."githubAppId" = a."id"
              AND NOT (
                p."tombstonedAt" IS NOT NULL
                AND p."writeMarker" IS NULL AND p."writePhase" IS NULL AND p."writeStartedAt" IS NULL
                AND p."pendingIntent" IS NULL AND p."leaseOwner" IS NULL AND p."leaseUntil" IS NULL
                AND p."nextAttemptAt" IS NULL
                AND p."desiredState" = 'failure'
                AND (
                  p."observedState" = 'failure'
                  OR (
                    p."observedState" = 'action_required'
                    AND p."subjectSyncGeneration" = p."generation"
                    AND p."subjectSyncErrorCode" IN (
                      'pr_association_incomplete', 'no_current_pull_request', 'stale_head', 'shared_head_multiple_prs'
                    )
                    AND p."lastErrorCode" = p."subjectSyncErrorCode"
                  )
                )
              ))
        ORDER BY a."retiredAt"
        LIMIT ${limit}
        FOR UPDATE OF a SKIP LOCKED`
      if (rows.length === 0) return []
      const ids = rows.map((row) => row.id)
      const installations = await tx.githubInstallation.findMany({
        where: { githubAppId: { in: ids } },
        select: { installationId: true, githubAppId: true }
      })
      await tx.githubApp.deleteMany({ where: { id: { in: ids } } })
      return rows.map((row) => ({
        id: row.id,
        orgId: OrgId(row.orgId),
        installationIds: installations.filter((i) => i.githubAppId === row.id).map((i) => i.installationId)
      }))
    })
  }

  async delete(orgId: OrgId, id: string): Promise<boolean> {
    const res = await this.prisma.githubApp.deleteMany({ where: { id, orgId } })
    return res.count > 0
  }
}

export class PgGithubAppSecretStore implements GithubAppSecretStore {
  constructor(
    private readonly prisma: PrismaLike,
    private readonly cipher: SecretCipher
  ) {}

  async put(orgId: OrgId, githubAppId: string, privateKeyB64: string): Promise<void> {
    if ((await this.prisma.githubApp.count({ where: { id: githubAppId, orgId } })) === 0) {
      throw new Error('github app secret write outside its organization')
    }
    const sealed = await this.cipher.seal(privateKeyB64, orgScope(orgId))
    await this.prisma.githubAppSecret.upsert({
      where: { githubAppId },
      create: { githubAppId, privateKey: sealed },
      update: { privateKey: sealed }
    })
  }

  async get(orgId: OrgId, githubAppId: string): Promise<string | null> {
    const row = await this.prisma.githubAppSecret.findFirst({ where: { githubAppId, app: { orgId } } })
    return row ? this.cipher.open(row.privateKey, orgScope(orgId)) : null
  }
}
