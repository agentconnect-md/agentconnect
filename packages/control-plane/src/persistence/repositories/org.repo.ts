/**
 * PgOrgRepo — the org read/write surface behind the console picker + Settings
 * (design §3.2). Personal orgs are created by `PgUserRepo.provisionOidcUser` at
 * signup; this repo covers everything after: listing the caller's orgs, creating
 * additional ones, and owner-gated rename/re-slug.
 */
import type { PrismaLike } from '../prisma.js'
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js'
import type { OrgRepo, OrgRecord, OrgMemberRole } from '../ports.js'
import type { AgentIcon } from '@agentconnect.md/protocol'
import { OrgId } from '../../domain/ids.js'
import { PgHookRepo } from './hook.repo.js'
import { parseAgentIcon, randomGlyphIcon } from '../../agents/agent-icon.js'
import { provisionPresetAgents } from '../preset-agents.js'

export class PgOrgRepo implements OrgRepo {
  constructor(
    private readonly db: PrismaLike,
    /** Provision preset agents with each created org (preset-agents.md §3.2);
     *  deploy-time opt-out via PRESET_AGENTS_ENABLED. */
    private readonly presetAgents = true
  ) {}

  private transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    if ('$transaction' in this.db) return (this.db as PrismaClient).$transaction(fn)
    return fn(this.db as Prisma.TransactionClient)
  }

  async listForUser(userId: string): Promise<OrgRecord[]> {
    const rows = await this.db.membership.findMany({
      where: { userId },
      include: { org: { include: { _count: { select: { members: true } } } } },
      orderBy: { id: 'asc' } // cuids are time-sortable ⇒ insertion order (personal org first)
    })
    return rows.map((m) => ({
      id: m.org.id,
      name: m.org.name,
      slug: m.org.slug,
      icon: parseAgentIcon(m.org.icon),
      role: m.role as OrgMemberRole,
      memberCount: m.org._count.members,
      createdAt: m.org.createdAt,
      updatedAt: m.org.updatedAt
    }))
  }

  async create(input: { name: string | null; slug: string; ownerUserId: string }): Promise<OrgRecord> {
    // New orgs get a random glyph+color by default (mirrors agents), so the console
    // always has a real avatar to show before any upload.
    const icon = randomGlyphIcon()
    // One transaction: org + owner membership + the preset agent (org-creation
    // seam, preset-agents.md §3.2) commit or roll back together — an org is never
    // observable without its preset row.
    const org = await this.transaction(async (tx) => {
      const created = await tx.org.create({
        data: { name: input.name, slug: input.slug, icon: icon as Prisma.InputJsonValue }
      })
      await tx.membership.create({ data: { orgId: created.id, userId: input.ownerUserId, role: 'owner' } })
      if (this.presetAgents) {
        await provisionPresetAgents(tx, { orgId: created.id, createdByUserId: input.ownerUserId })
      }
      return created
    })
    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      icon: parseAgentIcon(org.icon),
      role: 'owner',
      memberCount: 1,
      createdAt: org.createdAt,
      updatedAt: org.updatedAt
    }
  }

  async update(
    orgId: string,
    patch: { name?: string | null; slug?: string; icon?: AgentIcon | null }
  ): Promise<{ id: string; name: string | null; slug: string }> {
    const org = await this.db.org.update({
      where: { id: orgId },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.slug !== undefined ? { slug: patch.slug } : {}),
        ...(patch.icon !== undefined
          ? { icon: patch.icon === null ? Prisma.JsonNull : (patch.icon as Prisma.InputJsonValue) }
          : {})
      }
    })
    return { id: org.id, name: org.name, slug: org.slug }
  }

  async setIcon(orgId: string, icon: AgentIcon | null): Promise<{ id: string; updatedAt: Date }> {
    const org = await this.db.org.update({
      where: { id: orgId },
      data: { icon: icon === null ? Prisma.JsonNull : (icon as Prisma.InputJsonValue) }
    })
    return { id: org.id, updatedAt: org.updatedAt }
  }

  async iconById(orgId: string): Promise<{ icon: AgentIcon | null; updatedAt: Date } | null> {
    const org = await this.db.org.findUnique({ where: { id: orgId }, select: { icon: true, updatedAt: true } })
    return org ? { icon: parseAgentIcon(org.icon), updatedAt: org.updatedAt } : null
  }

  async roleOf(orgId: string, userId: string): Promise<OrgMemberRole | null> {
    const m = await this.db.membership.findUnique({ where: { orgId_userId: { orgId, userId } } })
    return m ? (m.role as OrgMemberRole) : null
  }

  async slugById(orgId: string): Promise<string | null> {
    const org = await this.db.org.findUnique({ where: { id: orgId }, select: { slug: true } })
    return org?.slug ?? null
  }

  async delete(orgId: string): ReturnType<OrgRepo['delete']> {
    // R2a HookRun/projection rows intentionally have no owner FK so ordinary
    // HookDef/Agent deletion can finish GitHub cleanup. Organization deletion
    // therefore needs an explicit durable barrier instead of a raw cascade.
    return new PgHookRepo(this.db).deleteOrgWithReviewProjectionCleanup(OrgId(orgId), new Date())
  }
}
