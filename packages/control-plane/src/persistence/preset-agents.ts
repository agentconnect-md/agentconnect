/**
 * Preset-agent provisioning seam (docs/designs/preset-agents.md §3, M0).
 *
 * `provisionPresetAgents` is THE org-creation seam: every path that mints an org
 * (`POST /orgs`, the no-auth default tenant) calls it so the org is born with the
 * `agentconnect` general preset —
 * unplaced, runtime deferred, or placed on the daemon pool when this install runs
 * one (`pool`, §3.2) — plus its `preset_agent` state row, in the SAME transaction
 * as the org itself. The one-time backfill for pre-existing orgs
 * (`preset-agent-backfill.ts`) reuses the identical write, without the pool
 * placement: it runs against orgs of unknown age, which already chose where they
 * run, and a pool birth is a decision only a brand-new org has not made yet.
 *
 * Idempotency lives in the `preset_agent` row, not in agent existence: a row —
 * `created` OR `skipped` — permanently stops re-provisioning, so a preset the
 * user deleted is never resurrected (creation has no later trigger).
 *
 * Ambient-transaction discipline: this may run inside an interactive transaction
 * (the backfill, the default-tenant seed), where ANY failed statement poisons the
 * whole tx — so the guard is a read, never a caught unique
 * violation. A new org cannot collide (it has no agents and no preset rows);
 * the backfill pre-checks collisions itself and writes `skipped`.
 *
 * Validation parity (§3.2): the agent row is written through `PgAgentRepo.create`
 * — the same core `POST /agents` commits through (advisory lock ordering, icon
 * default, timestamp discipline) — never a raw `tx.agent.create`. The preset's
 * constants are pinned to the route's slug grammar by unit test.
 */
import { randomUUID } from 'node:crypto'
import type { AgentIcon } from '@agentconnect.md/protocol'
import type { PrismaLike } from './prisma.js'
import type { PresetAgentKind, PresetAgentRecord, PresetAgentStore } from './ports.js'
import { AgentId, OrgId } from '../domain/ids.js'
import { RESERVED_AGENT_SLUGS } from '../domain/reserved-agent-slugs.js'
import { PgAgentRepo } from './repositories/agent.repo.js'
import { PgSkillSourceRepo } from './repositories/skill-source.repo.js'

export { RESERVED_AGENT_SLUGS }

/** The `agentconnect` general preset (§3.1) — fixed identity, not user-editable
 *  at provisioning time (the agent itself stays an ordinary, editable agent).
 *  This is the ONLY preset: the dedicated assistant was cancelled, and
 *  assistant/admin capabilities are planned to fold into THIS agent's webapp
 *  sessions instead (RESERVED_AGENT_SLUGS reserves exactly this slug). */
export const GENERAL_PRESET = {
  name: 'agentconnect',
  displayName: 'AgentConnect',
  description:
    'A general-purpose development agent for this organization: code review, coding tasks, and everyday questions.',
  // Fixed brand identity (stable and recognizable — NOT the random default):
  // the native AgentConnect diamond, rendered plateless by the console and the
  // icon-PNG endpoint via the special-cased 'agentconnect' glyph. The `color` is
  // inert for this glyph (renderers ignore it); it exists only because the wire
  // schema requires one — keep it the neutral dark plate.
  icon: { kind: 'glyph', glyph: 'agentconnect', color: '#1a212b' } satisfies AgentIcon
} as const

/** @deprecated Built-in system skills are daemon-bundled and served by `readSkill` (skill-over-mcp.md §7.1); kept for the §7.2 cleanup and its rollback. */
export const PRESET_SKILL_SOURCE = {
  name: 'agentconnect',
  source: 'agentconnect-md/agentconnect-skill',
  // Rename-proof numeric identity of agentconnect-md/agentconnect-skill.
  githubRepoId: 1322557433n,
  // A subdir source must carry a ref (the skill-sources route invariant).
  ref: 'main',
  subDir: 'skills',
  // Empty ⇒ every skill the directory exposes (20261008000000 widened older orgs to this).
  skills: [] as readonly string[]
} as const

/** @deprecated The retired preset enable-list (the whole source); new presets carry no skills (skill-over-mcp.md §7.1). */
export const PRESET_AGENT_SKILLS: readonly string[] = [`${PRESET_SKILL_SOURCE.name}/*`]

/**
 * Exec config the preset is born with when the install runs a daemon pool (§3.2).
 * A pool is an ordinary deployment shape, not a hosted-only one — any install that
 * runs pool members gets this. Absent/null ⇒ the preset is born unplaced with its
 * runtime deferred, the shape every pool-less install keeps.
 */
export interface PresetPoolPlacement {
  /** Runtime id the pool image ships and holds credentials for (e.g. `claude-acp`). */
  runtime: string
  /** Model pinned on the agent; absent ⇒ the runtime's own default model. */
  model?: string
}

/** The install-wide pool when this install actually RUNS one: the org-less member
 *  set with at least one member. The set ROW exists everywhere (the migration
 *  mints it), so emptiness rather than absence is what tells a pool-less
 *  deployment from a pool-backed one — and membership stays honest because a
 *  retired member loses it inside `PoolMemberReaper`'s window. */
async function livePoolSetId(db: PrismaLike): Promise<string | null> {
  const row = await db.memberSet.findFirst({ where: { orgId: null, members: { some: {} } }, select: { id: true } })
  return row?.id ?? null
}

/** Read one org's provisioning state for a preset — false ⇒ never provisioned. */
export async function presetAgentRowExists(db: PrismaLike, orgId: string, preset: PresetAgentKind): Promise<boolean> {
  const row = await db.presetAgent.findUnique({ where: { orgId_preset: { orgId, preset } }, select: { orgId: true } })
  return row !== null
}

/**
 * Write the general preset agent + its `preset_agent` row for one org, composing
 * under the caller's (possibly ambient) transaction. The caller guarantees the
 * org has no `preset_agent` row for `general` yet — true by construction for a
 * brand-new org, pre-checked by the backfill.
 *
 * `createdByUserId` — the user whose action created the org (the initial owner);
 * omit for the backfill and the no-auth default tenant (a system write carries
 * no personal creator).
 */
export async function provisionPresetAgents(
  db: PrismaLike,
  args: { orgId: string; createdByUserId?: string | null; pool?: PresetPoolPlacement | null }
): Promise<void> {
  const agentId = AgentId(randomUUID())
  // Pool birth (§3.2): with a pool on this install the preset is placed on it NOW
  // rather than waiting for a machine that may never arrive, so a brand-new org has
  // a working agent on its first screen. The exec config comes with the placement —
  // the pool image is one shared runtime set, so which runtime is signed in there is
  // a deployment decision, not a per-org one. No pool ⇒ unplaced, runtime deferred.
  const setId = args.pool ? await livePoolSetId(db) : null
  const pool = setId && args.pool ? { setId, ...args.pool } : null
  // Same creation core as POST /agents (PgAgentRepo composes under the ambient
  // tx via its PrismaLike constructor arg). Everything the placement does not
  // decide is the ordinary agent default: org visibility, scratch workspace.
  await new PgAgentRepo(db).create({
    id: agentId,
    orgId: OrgId(args.orgId),
    name: GENERAL_PRESET.name,
    displayName: GENERAL_PRESET.displayName,
    description: GENERAL_PRESET.description,
    icon: GENERAL_PRESET.icon,
    chatActions: 'approve',
    ...(pool
      ? {
          placementKind: 'set' as const,
          setId: pool.setId,
          runtime: pool.runtime,
          ...(pool.model ? { model: pool.model } : {}),
          // The pool keeps agent memory in the Control Plane (memory-evolution.md §3.2.1), resolved at birth as on create.
          memory: { provider: 'managed' as const, home: 'control-plane' as const }
        }
      : {}),
    ...(args.createdByUserId ? { createdByUserId: args.createdByUserId } : {})
  })
  await db.presetAgent.create({
    data: {
      orgId: args.orgId,
      preset: 'general',
      agentId,
      status: 'created',
      // Born placed ⇒ born settled: the one-shot auto-placement must never move
      // what the org already runs on, nor fight a user who unplaces it later.
      ...(pool ? { placementSettledAt: new Date() } : {})
    }
  })
}

/** @deprecated Provisioning no longer calls this; kept for rolling back the preset-source cleanup (skill-over-mcp.md §7.2, §8.3). */
export async function providePresetSkillSource(db: PrismaLike, orgId: string): Promise<string[]> {
  const repo = new PgSkillSourceRepo(db)
  if (await repo.getByName(OrgId(orgId), PRESET_SKILL_SOURCE.name)) return []
  const created = await repo.create({
    orgId: OrgId(orgId),
    name: PRESET_SKILL_SOURCE.name,
    source: PRESET_SKILL_SOURCE.source,
    githubRepoId: PRESET_SKILL_SOURCE.githubRepoId,
    ref: PRESET_SKILL_SOURCE.ref,
    subDir: PRESET_SKILL_SOURCE.subDir,
    skills: [...PRESET_SKILL_SOURCE.skills]
  })
  // null ⇒ some agent already enables refs under the name; leave those bindings alone.
  return created ? [...PRESET_AGENT_SKILLS] : []
}

/** Record a permanently-skipped preset (backfill slug collision / org opt-out). */
export async function markPresetSkipped(db: PrismaLike, orgId: string, preset: PresetAgentKind): Promise<void> {
  await db.presetAgent.create({ data: { orgId, preset, status: 'skipped' } })
}

/**
 * Idempotent, collision-aware provisioning for an org that may ALREADY have a
 * `preset_agent` row or a user agent squatting the reserved slug — the shape the
 * backfill and the no-auth default tenant need (both run against orgs of unknown
 * age, repeatedly, at every boot).
 *
 * `null` ⇒ nothing to do (a row already settles this org), `true` ⇒ recorded a
 * permanent `skipped` (slug collision: never rename a user's agent, §3.3),
 * `false` ⇒ provisioned. The caller supplies the transaction: all three outcomes
 * must commit atomically with whatever else that caller is writing.
 *
 * Deliberately provisions UNPLACED, with no pool birth: both callers run against
 * orgs of unknown age that have already chosen where they run.
 */
export async function ensurePresetAgentsProvisioned(
  tx: PrismaLike,
  orgId: string,
  createdByUserId?: string | null
): Promise<boolean | null> {
  const existing = await tx.presetAgent.findUnique({
    where: { orgId_preset: { orgId, preset: 'general' } },
    select: { orgId: true }
  })
  if (existing) return null
  const collision = await tx.agent.findUnique({
    where: { orgId_name: { orgId, name: GENERAL_PRESET.name } },
    select: { id: true }
  })
  if (collision) {
    await markPresetSkipped(tx, orgId, 'general')
    return true
  }
  await provisionPresetAgents(tx, { orgId, ...(createdByUserId ? { createdByUserId } : {}) })
  return false
}

function toRecord(r: {
  orgId: string
  preset: string
  agentId: string | null
  status: string
  placementSettledAt: Date | null
  createdAt: Date
}): PresetAgentRecord {
  return {
    orgId: OrgId(r.orgId),
    preset: r.preset as PresetAgentKind,
    agentId: r.agentId ? AgentId(r.agentId) : null,
    status: r.status as PresetAgentRecord['status'],
    placementSettledAt: r.placementSettledAt,
    createdAt: r.createdAt
  }
}

/** Read port for routes (default Slack bind target; later, the checklist). */
export class PgPresetAgentStore implements PresetAgentStore {
  constructor(private readonly db: PrismaLike) {}

  async get(orgId: OrgId, preset: PresetAgentKind): Promise<PresetAgentRecord | null> {
    const row = await this.db.presetAgent.findUnique({ where: { orgId_preset: { orgId, preset } } })
    return row ? toRecord(row) : null
  }
}
