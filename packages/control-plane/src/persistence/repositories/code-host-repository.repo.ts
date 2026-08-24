/**
 * PgCodeHostRepositoryRepo — the provider-qualified repository catalog
 * (gitlab-com-integration.md §8.1).
 *
 * Metadata only: numeric identity plus mutable display hints, no credential or
 * content. Readers-first discipline: GitHub writers converge referenced repos
 * into this catalog while the legacy `repoId`/`repoFullName` columns remain the
 * read path; GitLab resources reference it from day one. Upserts are convergent
 * and idempotent — a lost write is repaired by the next reference.
 */
import type { CodeHostRepository, PrismaClient } from '../../generated/prisma/client.js'
import type { CodeHostRepositoryRecord, CodeHostRepositoryRepo } from '../ports.js'

function toRecord(r: CodeHostRepository): CodeHostRepositoryRecord {
  return {
    id: r.id,
    orgId: r.orgId,
    provider: r.provider,
    externalId: r.externalId,
    displayPath: r.displayPath,
    cloneUrl: r.cloneUrl,
    defaultBranch: r.defaultBranch
  }
}

export class PgCodeHostRepositoryRepo implements CodeHostRepositoryRepo {
  constructor(private readonly prisma: PrismaClient) {}

  async upsert(input: {
    orgId: string
    provider: string
    externalId: bigint
    displayPath: string
    cloneUrl?: string
    defaultBranch?: string
  }): Promise<CodeHostRepositoryRecord> {
    const hints = {
      displayPath: input.displayPath,
      ...(input.cloneUrl !== undefined ? { cloneUrl: input.cloneUrl } : {}),
      ...(input.defaultBranch !== undefined ? { defaultBranch: input.defaultBranch } : {})
    }
    const row = await this.prisma.codeHostRepository.upsert({
      where: {
        orgId_provider_externalId: {
          orgId: input.orgId,
          provider: input.provider,
          externalId: input.externalId
        }
      },
      create: {
        orgId: input.orgId,
        provider: input.provider,
        externalId: input.externalId,
        ...hints
      },
      update: hints
    })
    return toRecord(row)
  }

  async byExternalId(orgId: string, provider: string, externalId: bigint): Promise<CodeHostRepositoryRecord | null> {
    const row = await this.prisma.codeHostRepository.findUnique({
      where: { orgId_provider_externalId: { orgId, provider, externalId } }
    })
    return row ? toRecord(row) : null
  }

  async listForOrg(orgId: string): Promise<CodeHostRepositoryRecord[]> {
    const rows = await this.prisma.codeHostRepository.findMany({
      orderBy: { displayPath: 'asc' },
      where: { orgId }
    })
    return rows.map(toRecord)
  }
}
