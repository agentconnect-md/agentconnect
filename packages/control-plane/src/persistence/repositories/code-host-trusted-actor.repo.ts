/**
 * PgCodeHostTrustedActorRepo — the per-repository "Trusted users" list
 * (webhook-triggers-and-github-events.md).
 *
 * Metadata only: a numeric user id, its display login, and who added it. The gate reads
 * the id set; the login is never matched, so a rename on the host changes nothing here.
 */
import type { CodeHostProvider } from '@agentconnect.md/protocol'
import type { CodeHostTrustedActor, PrismaClient } from '../../generated/prisma/client.js'
import { OrgId } from '../../domain/ids.js'
import type { CodeHostTrustedActorRecord, CodeHostTrustedActorRepo } from '../ports.js'

function toRecord(r: CodeHostTrustedActor): CodeHostTrustedActorRecord {
  return {
    id: r.id,
    orgId: OrgId(r.orgId),
    provider: r.provider as CodeHostProvider,
    repoExternalId: r.repoExternalId,
    actorExternalId: r.actorExternalId,
    actorLogin: r.actorLogin,
    addedByUserId: r.addedByUserId,
    createdAt: r.createdAt
  }
}

export class PgCodeHostTrustedActorRepo implements CodeHostTrustedActorRepo {
  constructor(private readonly prisma: PrismaClient) {}

  async listForRepo(orgId: OrgId, provider: CodeHostProvider, repoExternalId: bigint) {
    const rows = await this.prisma.codeHostTrustedActor.findMany({
      where: { orgId, provider, repoExternalId },
      orderBy: { createdAt: 'asc' }
    })
    return rows.map(toRecord)
  }

  async actorIdsForRepo(orgId: OrgId, provider: CodeHostProvider, repoExternalId: bigint): Promise<Set<string>> {
    const rows = await this.prisma.codeHostTrustedActor.findMany({
      where: { orgId, provider, repoExternalId },
      select: { actorExternalId: true }
    })
    return new Set(rows.map((row) => row.actorExternalId.toString()))
  }

  async add(input: {
    orgId: OrgId
    provider: CodeHostProvider
    repoExternalId: bigint
    actorExternalId: bigint
    actorLogin: string
    addedByUserId?: string
  }): Promise<CodeHostTrustedActorRecord> {
    const row = await this.prisma.codeHostTrustedActor.upsert({
      where: {
        orgId_provider_repoExternalId_actorExternalId: {
          orgId: input.orgId,
          provider: input.provider,
          repoExternalId: input.repoExternalId,
          actorExternalId: input.actorExternalId
        }
      },
      create: {
        orgId: input.orgId,
        provider: input.provider,
        repoExternalId: input.repoExternalId,
        actorExternalId: input.actorExternalId,
        actorLogin: input.actorLogin,
        ...(input.addedByUserId !== undefined ? { addedByUserId: input.addedByUserId } : {})
      },
      // A re-add is the one way a display login refreshes; who vouched first stays.
      update: { actorLogin: input.actorLogin }
    })
    return toRecord(row)
  }

  async remove(orgId: OrgId, id: string): Promise<boolean> {
    const result = await this.prisma.codeHostTrustedActor.deleteMany({ where: { id, orgId } })
    return result.count > 0
  }
}
