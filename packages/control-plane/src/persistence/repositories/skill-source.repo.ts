/**
 * PgSkillSourceRepo (docs/designs/shared-skills.md §4).
 *
 * The org-level registry of skills sources. Metadata-only: the CP stores just the
 * bounded public GitHub source and numeric repository identity (+ optional
 * ref/subDir/skill filter) and never fetches or holds skill content — the daemon
 * acquires and installs it from a local snapshot. Unlike the MCP provider
 * registry there is NO secret side-table and NO repository grant. A Shareable,
 * so the same visibility policy as agents/MCP applies.
 */
import type { Prisma, SkillSource } from '../../generated/prisma/client.js'
import { withAmbientTx, type PrismaLike } from '../prisma.js'
import type {
  SkillSourceRepo,
  SkillSourceRecord,
  CreateSkillSourceInput,
  UpdateSkillSourceInput,
  ResourceVisibility,
  ViewCtx
} from '../ports.js'
import { visibilityWhere } from '../../authorization/policy.js'
import { OrgId } from '../../domain/ids.js'
import { lockResourceWriteMemberships } from '../resource-membership-lock.js'
import { lockSkillSourceNameScope } from '../skill-source-lock.js'
import { parseSkillRef } from '../../orchestrator/skillSource.js'
import { bumpAgentsReferencingSkillSource } from './organization-environment-fence.js'

/**
 * True while any agent in the org still enables skills under `name`. Agents
 * store refs ("<source>/<skill>" / "<source>/*" / "<source>") in their
 * runtimeOverrides JSON bag — there is deliberately no FK — so this scan is the
 * reference check, and it is only meaningful inside a transaction that holds
 * the (orgId, name) advisory scope: agent enable-list writes take the same
 * scope, so a reference can neither appear nor vanish between this read and
 * the caller's write.
 */
async function skillSourceNameReferenced(tx: Prisma.TransactionClient, orgId: string, name: string): Promise<boolean> {
  const agents = await tx.agent.findMany({ where: { orgId }, select: { runtimeOverrides: true } })
  return agents.some((agent) => {
    const skills = (agent.runtimeOverrides as { skills?: string[] } | null)?.skills ?? []
    return skills.some((ref) => parseSkillRef(ref).source === name)
  })
}

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

  /**
   * Register a source under the name-capture guard: agents bind by NAME, so a
   * new source must not silently capture enable-refs agents already hold under
   * it. Returns null while any agent still references the name. The scan and
   * the insert share one transaction holding the (orgId, name) advisory scope,
   * so an agent enable-list write cannot land in between — across control-plane
   * instances, not just this process.
   */
  async create(input: CreateSkillSourceInput): Promise<SkillSourceRecord | null> {
    return withAmbientTx(this.db, async (tx) => {
      await lockSkillSourceNameScope(tx, input.orgId, input.name)
      if (await skillSourceNameReferenced(tx, input.orgId, input.name)) return null
      const memberships = await lockResourceWriteMemberships(tx, {
        orgId: input.orgId,
        visibility: input.visibility ?? 'org',
        actorUserId: input.createdByUserId,
        sharedWith: input.sharedWith
      })
      const s = await tx.skillSource.create({
        data: {
          orgId: input.orgId,
          name: input.name,
          source: input.source,
          ...(input.githubRepoId !== undefined ? { githubRepoId: input.githubRepoId } : {}),
          ...(input.ref !== undefined ? { ref: input.ref } : {}),
          ...(input.subDir !== undefined ? { subDir: input.subDir } : {}),
          ...(input.skills ? { skills: input.skills } : {}),
          ...(input.visibility ? { visibility: input.visibility } : {}),
          ...(memberships.sharedWith ? { sharedWith: memberships.sharedWith } : {}),
          ...(input.createdByUserId ? { createdByUserId: input.createdByUserId } : {})
        }
      })
      return toRecord(s)
    })
  }

  async get(orgId: OrgId, id: string): Promise<SkillSourceRecord | null> {
    // The org filter rides the unique lookup (extended where): a cross-org id
    // is indistinguishable from a missing row (org-scoped-data-layer.md §3).
    const s = await this.db.skillSource.findUnique({ where: { id, orgId } })
    return s ? toRecord(s) : null
  }

  // Same visibility filter as agents/MCP: org-visible OR explicitly selected
  // (undefined ⇒ unfiltered internal read). See visibilityWhere.
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
    orgId: OrgId,
    id: string,
    sharing: { visibility: ResourceVisibility; sharedWith: string[] },
    byUserId?: string
  ): Promise<SkillSourceRecord> {
    return withAmbientTx(this.db, async (tx) => {
      // Org fence on the opening read: a cross-org id throws the same P2025 as
      // a missing row, before the name scope or the membership lock is taken.
      const existing = await tx.skillSource.findUniqueOrThrow({
        where: { id, orgId },
        select: { orgId: true, name: true }
      })
      // Agent enable-list writes authorize against source visibility inside the
      // same (orgId, name) advisory scope (name is immutable, so the pre-lock
      // read of it is stable) — a sharing flip cannot land between their
      // visibility check and their commit.
      await lockSkillSourceNameScope(tx, existing.orgId, existing.name)
      const memberships = await lockResourceWriteMemberships(tx, {
        orgId: existing.orgId,
        visibility: sharing.visibility,
        actorUserId: byUserId,
        sharedWith: sharing.sharedWith
      })
      const s = await tx.skillSource.update({
        where: { id },
        data: { visibility: sharing.visibility, sharedWith: memberships.sharedWith ?? [] }
      })
      return toRecord(s)
    })
  }

  async update(orgId: OrgId, id: string, patch: UpdateSkillSourceInput): Promise<SkillSourceRecord> {
    return withAmbientTx(this.db, async (tx) => {
      // The name BEFORE the edit — agents bind by name, so a rename moves which
      // agents resolve through this row and both sets change what they receive.
      // Org-fenced on both statements: a cross-org id reads no `before` name and
      // throws the same P2025 as a missing row on the update.
      const before = await tx.skillSource.findUnique({ where: { id, orgId }, select: { name: true } })
      const s = await tx.skillSource.update({
        where: { id, orgId },
        data: {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.source !== undefined ? { source: patch.source } : {}),
          ...(patch.githubRepoId !== undefined ? { githubRepoId: patch.githubRepoId } : {}),
          ...(patch.ref !== undefined ? { ref: patch.ref } : {}),
          ...(patch.subDir !== undefined ? { subDir: patch.subDir } : {}),
          ...(patch.skills !== undefined ? { skills: patch.skills } : {})
        }
      })
      // `AgentSpec.skills` is RESOLVED from this row, so an edit here changes the
      // spec content of every agent that enables it. Without this bump those
      // agents keep their old `configRevision`, and the daemon refuses the new
      // content as an equal-revision/different-digest invariant violation —
      // permanently, on every reconnect (organization-secrets-and-variables.md §7).
      // Bumped in the SAME transaction as the edit, so no reader ever observes new
      // content at an old revision.
      for (const name of new Set([before?.name, s.name].filter((n): n is string => n !== undefined))) {
        await bumpAgentsReferencingSkillSource(tx, s.orgId, name)
      }
      return toRecord(s)
    })
  }

  /**
   * Delete under the referenced-guard: agents bind by NAME, so dropping a row
   * agents still enable would leave dangling selectors that silently re-bind to
   * any future same-name source. The scan and the drop share one transaction
   * holding the (orgId, name) advisory scope (same fence as create and agent
   * enable-list writes). 'referenced' ⇒ the caller answers 409; a row already
   * gone resolves to 'deleted' (the outcome is idempotent).
   */
  async delete(orgId: OrgId, id: string): Promise<'deleted' | 'referenced'> {
    return withAmbientTx(this.db, async (tx) => {
      // Org fence on the opening read, BEFORE the reference scan: a cross-org id
      // takes the same early exit as an unknown one, so it can never come back
      // as 'referenced' — an answer that would disclose the foreign org's agent
      // enable-lists (org-scoped-data-layer.md §3).
      const existing = await tx.skillSource.findUnique({
        where: { id, orgId },
        select: { orgId: true, name: true }
      })
      if (!existing) return 'deleted'
      await lockSkillSourceNameScope(tx, existing.orgId, existing.name)
      // Re-read after taking the scope: a concurrent delete may have won it.
      const row = await tx.skillSource.findUnique({ where: { id, orgId }, select: { id: true } })
      if (!row) return 'deleted'
      if (await skillSourceNameReferenced(tx, existing.orgId, existing.name)) return 'referenced'
      await tx.skillSource.delete({ where: { id, orgId } })
      return 'deleted'
    })
  }
}
