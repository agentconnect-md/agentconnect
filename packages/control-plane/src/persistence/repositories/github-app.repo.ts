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
