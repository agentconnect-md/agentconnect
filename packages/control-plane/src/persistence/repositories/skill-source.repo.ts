/**
 * PgSkillSourceRepo (docs/designs/shared-skills.md §4).
 *
 * The org-level registry of skills sources. Metadata-only: the CP stores just the
 * source string (+ optional ref/subDir/skill filter) and never fetches or holds
 * skill content — the daemon installs enabled skills via `npx skills`. Unlike the
 * MCP provider registry there is NO secret side-table and NO grant: skills carry
 * no upstream credential, and private-repo reads reuse the daemon's GitHub App
 * token path. A Shareable, so the same visibility policy as agents/MCP applies.
 */
import type { SkillSource } from '../../generated/prisma/client.js'
import type { PrismaLike } from '../prisma.js'
import type {
  SkillSourceRepo,
  SkillSourceRecord,
  CreateSkillSourceInput,
  UpdateSkillSourceInput,
  ResourceVisibility,
  ViewCtx
} from '../ports.js'
import { visibilityWhere } from '../ports.js'
import { OrgId } from '../../domain/ids.js'

function toRecord(s: SkillSource): SkillSourceRecord {
  return {
    id: s.id,
    orgId: OrgId(s.orgId),
    name: s.name,
    source: s.source,
    githubRepoId: s.githubRepoId,
    ref: s.ref,
    subDir: s.subDir,
    skills: s.skills,
    visibility: s.visibility as ResourceVisibility,
    sharedWith: s.sharedWith,
    createdByUserId: s.createdByUserId,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt
  }
}

export class PgSkillSourceRepo implements SkillSourceRepo {
  constructor(private readonly db: PrismaLike) {}

  async create(input: CreateSkillSourceInput): Promise<SkillSourceRecord> {
    const s = await this.db.skillSource.create({
      data: {
        orgId: input.orgId,
        name: input.name,
        source: input.source,
        ...(input.githubRepoId !== undefined ? { githubRepoId: input.githubRepoId } : {}),
        ...(input.ref !== undefined ? { ref: input.ref } : {}),
        ...(input.subDir !== undefined ? { subDir: input.subDir } : {}),
        ...(input.skills ? { skills: input.skills } : {}),
        ...(input.visibility ? { visibility: input.visibility } : {}),
        ...(input.sharedWith ? { sharedWith: input.sharedWith } : {}),
        ...(input.createdByUserId ? { createdByUserId: input.createdByUserId } : {})
      }
    })
    return toRecord(s)
  }

  async get(id: string): Promise<SkillSourceRecord | null> {
    const s = await this.db.skillSource.findUnique({ where: { id } })
    return s ? toRecord(s) : null
  }

  // Same visibility filter as agents/MCP: org-visible OR mine OR shared with me
  // (owners/undefined ⇒ unfiltered). See visibilityWhere.
  async listForOrg(orgId: OrgId, viewer?: ViewCtx): Promise<SkillSourceRecord[]> {
    const rows = await this.db.skillSource.findMany({
      where: { orgId, ...visibilityWhere(viewer) },
      orderBy: { createdAt: 'asc' }
    })
    return rows.map(toRecord)
  }

  async getByName(orgId: OrgId, name: string): Promise<SkillSourceRecord | null> {
    const s = await this.db.skillSource.findUnique({ where: { orgId_name: { orgId, name } } })
    return s ? toRecord(s) : null
  }

  async setSharing(
    id: string,
    sharing: { visibility: ResourceVisibility; sharedWith: string[] }
  ): Promise<SkillSourceRecord> {
    const s = await this.db.skillSource.update({
      where: { id },
      data: { visibility: sharing.visibility, sharedWith: sharing.sharedWith }
    })
    return toRecord(s)
  }

  async update(id: string, patch: UpdateSkillSourceInput): Promise<SkillSourceRecord> {
    const s = await this.db.skillSource.update({
      where: { id },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.source !== undefined ? { source: patch.source } : {}),
        ...(patch.githubRepoId !== undefined ? { githubRepoId: patch.githubRepoId } : {}),
        ...(patch.ref !== undefined ? { ref: patch.ref } : {}),
        ...(patch.subDir !== undefined ? { subDir: patch.subDir } : {}),
        ...(patch.skills !== undefined ? { skills: patch.skills } : {})
      }
    })
    return toRecord(s)
  }

  async delete(id: string): Promise<void> {
    await this.db.skillSource.delete({ where: { id } })
  }
}
