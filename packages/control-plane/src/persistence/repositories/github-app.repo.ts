/**
 * PgGithubAppRepo + PgGithubAppSecretStore — organization-registered GitHub
 * Apps (docs/designs/github-app-git-credentials.md §Dedicated Apps).
 *
 * The App row is metadata; the private key is sealed under the org scope and
 * read only by the token signer. Deleting an App cascades to its installations
 * and detaches its agents (they fall back to the deployment App).
 */
import type { GithubApp } from '../../generated/prisma/client.js'
import type { PrismaLike } from '../prisma.js'
import type { GithubAppRecord, GithubAppRepo, GithubAppSecretStore } from '../ports.js'
import { OrgId } from '../../domain/ids.js'
import type { SecretCipher } from '../../secrets/cipher.js'
import { orgScope } from '../../secrets/scope.js'

function toRecord(r: GithubApp): GithubAppRecord {
  return {
    id: r.id,
    orgId: OrgId(r.orgId),
    appId: r.appId,
    slug: r.slug,
    clientId: r.clientId,
    botUserId: r.botUserId,
    createdAt: r.createdAt
  }
}

export class PgGithubAppRepo implements GithubAppRepo {
  constructor(private readonly prisma: PrismaLike) {}

  async create(input: {
    orgId: OrgId
    appId: bigint
    slug: string
    clientId: string | null
    botUserId: bigint | null
  }): Promise<GithubAppRecord> {
    const row = await this.prisma.githubApp.create({ data: input })
    return toRecord(row)
  }

  async get(orgId: OrgId, id: string): Promise<GithubAppRecord | null> {
    const row = await this.prisma.githubApp.findUnique({ where: { id, orgId } })
    return row ? toRecord(row) : null
  }

  async getUnscoped(id: string): Promise<GithubAppRecord | null> {
    const row = await this.prisma.githubApp.findUnique({ where: { id } })
    return row ? toRecord(row) : null
  }

  async listForOrg(orgId: OrgId): Promise<GithubAppRecord[]> {
    const rows = await this.prisma.githubApp.findMany({ where: { orgId }, orderBy: { slug: 'asc' } })
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
