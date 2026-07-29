/**
 * Preset-agent provisioning seam (docs/designs/preset-agents.md §3, M0).
 *
 * `provisionPresetAgents` is THE org-creation seam: every path that mints an org
 * (`POST /orgs`, JIT personal orgs, the waitlist redeem, the no-auth default
 * tenant) calls it so the org is born with the `agentconnect` general preset —
 * unplaced, runtime deferred — plus its `preset_agent` state row, in the SAME
 * transaction as the org itself. The one-time backfill for pre-existing orgs
 * (`preset-agent-backfill.ts`) reuses the identical write.
 *
 * Idempotency lives in the `preset_agent` row, not in agent existence: a row —
 * `created` OR `skipped` — permanently stops re-provisioning, so a preset the
 * user deleted is never resurrected (creation has no later trigger).
 *
 * Ambient-transaction discipline (see `ensurePersonalOrg`): this may run inside
 * an interactive transaction (waitlist redeem), where ANY failed statement
 * poisons the whole tx — so the guard is a read, never a caught unique
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

export { RESERVED_AGENT_SLUGS }

/** The `agentconnect` general preset (§3.1) — fixed identity, not user-editable
 *  at provisioning time (the agent itself stays an ordinary, editable agent).
 *  This is the ONLY preset: the dedicated assistant was cancelled, and
 *  assistant/admin capabilities are planned to fold into THIS agent's webapp
 *  sessions instead (RESERVED_AGENT_SLUGS keeps the assistant names parked). */
export const GENERAL_PRESET = {
  name: 'agentconnect',
  displayName: 'AgentConnect',
  description:
    'A general-purpose development agent for this organization: code review, coding tasks, and everyday questions.',
  // Fixed brand identity (stable and recognizable — NOT the random default):
  // the AgentConnect diamond on the neutral dark plate, rendered by the console
  // and the icon-PNG endpoint via the special-cased 'agentconnect' glyph.
  icon: { kind: 'glyph', glyph: 'agentconnect', color: '#1a212b' } satisfies AgentIcon
} as const

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
  args: { orgId: string; createdByUserId?: string | null }
): Promise<void> {
  const agentId = AgentId(randomUUID())
  // Same creation core as POST /agents (PgAgentRepo composes under the ambient
  // tx via its PrismaLike constructor arg). Runtime stays UNSET — deferred exec
  // config; placement (M1/manual) chooses it. Everything else is the ordinary
  // agent default: org visibility, scratch workspace, status inactive.
  await new PgAgentRepo(db).create({
    id: agentId,
    orgId: OrgId(args.orgId),
    name: GENERAL_PRESET.name,
    displayName: GENERAL_PRESET.displayName,
    description: GENERAL_PRESET.description,
    icon: GENERAL_PRESET.icon,
    ...(args.createdByUserId ? { createdByUserId: args.createdByUserId } : {})
  })
  await db.presetAgent.create({
    data: { orgId: args.orgId, preset: 'general', agentId, status: 'created' }
  })
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
