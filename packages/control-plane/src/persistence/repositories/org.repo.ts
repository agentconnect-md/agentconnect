/**
 * PgOrgRepo — the org read/write surface behind the console picker + Settings
 * (design §3.2). Personal orgs are created by `PgUserRepo.provisionOidcUser` at
 * signup; this repo covers everything after: listing the caller's orgs, creating
 * additional ones, and owner-gated settings updates.
 */
import type { PrismaLike } from '../prisma.js'
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js'
import type { AgentCallPolicy, OrgRepo, OrgRecord, OrgMemberRole, OrgTelemetryRow } from '../ports.js'
import type { AgentIcon } from '@agentconnect.md/protocol'
import { OrgId } from '../../domain/ids.js'
import { PgHookRepo } from './hook.repo.js'
import { parseAgentIcon, randomGlyphIcon } from '../../agents/agent-icon.js'
import { provisionPresetAgents, type PresetPoolPlacement } from '../preset-agents.js'
import { OrgCreationLimitReached } from '../errors.js'

/** The session-start windows the org gauges report beside the lifetime total. */
const SESSION_WINDOW_30D_MS = 30 * 24 * 60 * 60 * 1000
const SESSION_WINDOW_24H_MS = 24 * 60 * 60 * 1000

export class PgOrgRepo implements OrgRepo {
  constructor(
    private readonly db: PrismaLike,
    /** Provision preset agents with each created org (preset-agents.md §3.2);
     *  deploy-time opt-out via PRESET_AGENTS_ENABLED. */
    private readonly presetAgents = true,
    /** Exec config the preset is born with on a pool-backed install
     *  (preset-agents.md §3.2); null ⇒ born unplaced. Rides PRESET_AGENT_POOL_RUNTIME/_MODEL. */
    private readonly presetPool: PresetPoolPlacement | null = null,
    /** The transit target this deployment would seal THIS org's secrets under,
     *  pinned onto the shred tombstone at delete time so a later mount/prefix
     *  change cannot silently redirect the destroy
     *  (docs/designs/per-org-secret-encryption.md §6). */
    private readonly shredTarget: (orgId: string) => { mount: string; keyName: string } = (orgId) => ({
      mount: 'transit',
      keyName: orgId
    })
  ) {}

  private transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    if ('$transaction' in this.db) return (this.db as PrismaClient).$transaction(fn)
    return fn(this.db as Prisma.TransactionClient)
  }

  async listForUser(userId: string): Promise<OrgRecord[]> {
    const rows = await this.db.membership.findMany({
      where: { userId },
      // Provisioned-but-never-connected daemons (an abandoned wizard mint) don't count —
      // daemonCount feeds the console's "this org is set up" onboarding signal.
      include: {
        org: {
          include: { _count: { select: { members: true, daemons: { where: { status: { not: 'provisioned' } } } } } }
        }
      },
      orderBy: [
        { lastSelectedAt: { sort: 'desc', nulls: 'last' } },
        { id: 'asc' } // cuids are time-sortable ⇒ insertion order when no choice exists
      ]
    })
    return rows.map((m) => ({
      id: m.org.id,
      name: m.org.name,
      slug: m.org.slug,
      icon: parseAgentIcon(m.org.icon),
      defaultAgentVisibility: m.org.defaultAgentVisibility as AgentCallPolicy,
      onboardingCompleted: m.org.onboardingCompleted,
      gettingStartedStep: m.org.gettingStartedStep,
      role: m.role as OrgMemberRole,
      memberCount: m.org._count.members,
      daemonCount: m.org._count.daemons,
      createdAt: m.org.createdAt,
      updatedAt: m.org.updatedAt
    }))
  }

  async selectForUser(orgId: string, userId: string, selectedAt: Date): Promise<void> {
    await this.db.membership.update({
      where: { orgId_userId: { orgId, userId } },
      data: { lastSelectedAt: selectedAt }
    })
  }

  async create(input: {
    name: string | null
    slug: string
    ownerUserId: string
    maxOrgsPerUser?: number
  }): Promise<OrgRecord> {
    // New orgs get a random glyph+color by default (mirrors agents), so the console
    // always has a real avatar to show before any upload.
    const icon = randomGlyphIcon()
    // One transaction: org + owner membership + the preset agent (org-creation
    // seam, preset-agents.md §3.2) commit or roll back together — an org is never
    // observable without its preset row.
    const org = await this.transaction(async (tx) => {
      if (input.maxOrgsPerUser !== undefined) {
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "app_user" WHERE "id" = ${input.ownerUserId} FOR UPDATE`)
        const created = await tx.org.count({ where: { createdByUserId: input.ownerUserId } })
        if (created >= input.maxOrgsPerUser) throw new OrgCreationLimitReached(input.maxOrgsPerUser)
      }
      const created = await tx.org.create({
        data: {
          name: input.name,
          slug: input.slug,
          icon: icon as Prisma.InputJsonValue,
          createdByUserId: input.ownerUserId
        }
      })
      await tx.membership.create({ data: { orgId: created.id, userId: input.ownerUserId, role: 'owner' } })
      if (this.presetAgents) {
        await provisionPresetAgents(tx, {
          orgId: created.id,
          createdByUserId: input.ownerUserId,
          pool: this.presetPool
        })
      }
      return created
    })
    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      icon: parseAgentIcon(org.icon),
      defaultAgentVisibility: org.defaultAgentVisibility as AgentCallPolicy,
      onboardingCompleted: org.onboardingCompleted,
      gettingStartedStep: org.gettingStartedStep,
      role: 'owner',
      memberCount: 1,
      daemonCount: 0,
      createdAt: org.createdAt,
      updatedAt: org.updatedAt
    }
  }

  async update(
    orgId: string,
    patch: {
      name?: string | null
      slug?: string
      icon?: AgentIcon | null
      defaultAgentVisibility?: AgentCallPolicy
      onboardingCompleted?: boolean
      gettingStartedStep?: number
    }
  ): Promise<{ id: string; name: string | null; slug: string }> {
    // Monotonic at the DB boundary: the step records cross-device tutorial progress, and
    // a stale tab that still sees an older position must never move the shared row
    // backward — one guarded statement, so concurrent writes can only ratchet forward.
    if (patch.gettingStartedStep !== undefined) {
      await this.db.org.updateMany({
        where: { id: orgId, gettingStartedStep: { lt: patch.gettingStartedStep } },
        data: { gettingStartedStep: patch.gettingStartedStep }
      })
    }
    const data = {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.slug !== undefined ? { slug: patch.slug } : {}),
      ...(patch.icon !== undefined
        ? { icon: patch.icon === null ? Prisma.JsonNull : (patch.icon as Prisma.InputJsonValue) }
        : {}),
      ...(patch.defaultAgentVisibility !== undefined ? { defaultAgentVisibility: patch.defaultAgentVisibility } : {}),
      ...(patch.onboardingCompleted !== undefined ? { onboardingCompleted: patch.onboardingCompleted } : {})
    }
    const org =
      Object.keys(data).length > 0
        ? await this.db.org.update({ where: { id: orgId }, data })
        : await this.db.org.findUniqueOrThrow({ where: { id: orgId }, select: { id: true, name: true, slug: true } })
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

  async defaultAgentVisibility(orgId: string): Promise<AgentCallPolicy | null> {
    const org = await this.db.org.findUnique({ where: { id: orgId }, select: { defaultAgentVisibility: true } })
    return (org?.defaultAgentVisibility as AgentCallPolicy | undefined) ?? null
  }

  async slugById(orgId: string): Promise<string | null> {
    const org = await this.db.org.findUnique({ where: { id: orgId }, select: { slug: true } })
    return org?.slug ?? null
  }

  async orgTelemetry(now: Date): Promise<OrgTelemetryRow[]> {
    const since30d = new Date(now.getTime() - SESSION_WINDOW_30D_MS)
    const since24h = new Date(now.getTime() - SESSION_WINDOW_24H_MS)
    // Each table is aggregated ONCE and joined, never read per org: a correlated subquery here
    // would re-scan `session_meta` for every org, turning one cheap pass into N.
    return this.db.$queryRaw<OrgTelemetryRow[]>(Prisma.sql`
      WITH d AS (
        SELECT "orgId", count(*)::int AS n FROM "daemon" WHERE "orgId" IS NOT NULL GROUP BY "orgId"
      ),
      a AS (
        SELECT "orgId", count(*)::int AS n FROM "agent" GROUP BY "orgId"
      ),
      s AS (
        SELECT "orgId",
               count(*)::int AS total,
               count(*) FILTER (WHERE "startedAt" >= ${since30d})::int AS d30,
               count(*) FILTER (WHERE "startedAt" >= ${since24h})::int AS d24
        FROM "session_meta" GROUP BY "orgId"
      )
      -- Driven from "org" so an org holding nothing still reports its zeros.
      SELECT o.id AS "orgId",
             o.slug AS "slug",
             COALESCE(d.n, 0)::int AS "daemons",
             COALESCE(a.n, 0)::int AS "agents",
             COALESCE(s.total, 0)::int AS "sessionsTotal",
             COALESCE(s.d30, 0)::int AS "sessions30d",
             COALESCE(s.d24, 0)::int AS "sessions24h"
      FROM "org" o
      LEFT JOIN d ON d."orgId" = o.id
      LEFT JOIN a ON a."orgId" = o.id
      LEFT JOIN s ON s."orgId" = o.id
      ORDER BY o.id
    `)
  }

  async delete(orgId: string): ReturnType<OrgRepo['delete']> {
    // R2a HookRun/projection rows intentionally have no owner FK so ordinary
    // HookDef/Agent deletion can finish GitHub cleanup. Organization deletion
    // therefore needs an explicit durable barrier instead of a raw cascade.
    return new PgHookRepo(this.db).deleteOrgWithReviewProjectionCleanup(
      OrgId(orgId),
      new Date(),
      this.shredTarget(orgId)
    )
  }
}
