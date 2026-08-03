/**
 * The transaction-time admission fence shared by EVERY writer that can change an
 * agent's resolved configuration — the organization-environment writers AND
 * agent-local create/PATCH (organization-secrets-and-variables.md §5).
 *
 * `expectedVersion` is only an editor-conflict check. Correct admission needs the
 * organization and agent rows as transaction-time fences:
 *
 *   1. an ORGANIZATION-ENVIRONMENT writer locks the parent `Org` row FOR UPDATE.
 *      It changes the entry SET, so it must serialize with every other such writer
 *      and with agent CREATE — the org row is what makes "which agents does `all`
 *      enroll?" a stable question;
 *   2. lock the affected `Agent` rows FOR UPDATE in stable ID order;
 *   3. re-read local env/secret names, assigned organization metadata, and the
 *      candidate mutation while the locks are held;
 *   4. resolve each complete AgentSpec, enforce the cross-kind rule (§3.2), and
 *      measure it against the exact wire admission budget;
 *   5. persist the mutation and bump every affected agent's `configRevision` in
 *      the same transaction.
 *
 * An AGENT-LOCAL write joins this at step 2. Agent PATCH deliberately does NOT take
 * the org row: it affects exactly one agent and the admission budget is per-agent,
 * so the agent row already serializes it against both a competing PATCH and any
 * organization-environment writer (which locks the agent rows it affects) — and
 * taking the org row would serialize every agent edit in the organization for no
 * admission benefit. Agent CREATE is the exception and does take it, because a
 * not-yet-inserted row is invisible to a concurrent `all` enrollment scan.
 *
 * Without this fence, two writers touching different entries/bindings/agent-local
 * rows could each validate against an obsolete partial state and jointly exceed
 * `MAX_FRAME_BYTES` after both commit, leaving an unreconcilable agent.
 *
 * LOCK ORDER, one chain for every agent-config writer in the codebase:
 *
 *     skill-source name scopes → org row (create / entry writers) → agent rows
 *
 * Agent rows are always taken in ascending id. The name scopes come first because a
 * skill-source sharing write holds them and then takes `FOR KEY SHARE` on the same
 * org row; acquiring the org row ahead of them would put those two writers in a
 * cycle.
 */
import { MAX_FRAME_BYTES } from '@agentconnect.md/protocol'
import { Prisma } from '../../generated/prisma/client.js'
import type { PrismaLike } from '../prisma.js'
import {
  crossKindConflicts,
  planEffectiveKeys,
  type AssignedOrganizationEntry
} from '../../orchestrator/organizationEnvironment.js'

/** A transaction handle — every function here composes under someone else's tx. */
type Tx = Prisma.TransactionClient

/**
 * Headroom under the raw frame ceiling for the envelope, control extension, and
 * the rest of `agent/upsert` around the spec itself. The check is deliberately
 * conservative: rejecting a borderline write is recoverable, shipping an
 * unreconcilable agent is not.
 */
const SPEC_ENVELOPE_HEADROOM = 8 * 1024
export const MAX_RESOLVED_ENVIRONMENT_BYTES = MAX_FRAME_BYTES - SPEC_ENVELOPE_HEADROOM

/** Step 1. Serializes this writer with every other environment/agent-config writer. */
export async function lockOrgForConfigWrite(tx: Tx, orgId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT "id" FROM "org" WHERE "id" = ${orgId} FOR UPDATE`
  )
  return rows.length > 0
}

/**
 * Step 1, from the agent side: agent CREATE knows the org, but a caller that only
 * has an agent id needs the owning org row. Locks the ORG row (not the agent), so
 * it joins the same ordering.
 */
export async function lockOrgOfAgentForConfigWrite(tx: Tx, agentId: string): Promise<string | null> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT o."id" FROM "org" o JOIN "agent" a ON a."orgId" = o."id" WHERE a."id" = ${agentId} FOR UPDATE OF o`
  )
  return rows[0]?.id ?? null
}

/**
 * The owning org id with NO lock — for the agent PATCH path, which serializes on
 * the agent row instead (see `PgAgentRepo.updateInTx`). Keeping this separate from
 * {@link lockOrgOfAgentForConfigWrite} makes the "does this writer take the org
 * row?" decision explicit at every call site rather than implied by a boolean.
 */
export async function orgIdOfAgent(tx: Tx, agentId: string): Promise<string | null> {
  const row = await tx.agent.findUnique({ where: { id: agentId }, select: { orgId: true } })
  return row?.orgId ?? null
}

/** Step 2. Ascending id order, so two writers over overlapping sets cannot cycle. */
export async function lockAgentsForConfigWrite(tx: Tx, agentIds: readonly string[]): Promise<string[]> {
  if (agentIds.length === 0) return []
  const ordered = [...new Set(agentIds)].sort()
  const rows = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT "id" FROM "agent" WHERE "id" IN (${Prisma.join(ordered)}) ORDER BY "id" ASC FOR UPDATE`
  )
  return rows.map((row) => row.id)
}

/**
 * Step 5. ONE ordering domain per agent: this is the only way `configRevision`
 * advances, so an organization-derived change and an ordinary agent edit cannot
 * mint competing revisions.
 */
export async function bumpAgentConfigRevisions(tx: PrismaLike, agentIds: readonly string[]): Promise<void> {
  if (agentIds.length === 0) return
  await tx.agent.updateMany({
    where: { id: { in: [...new Set(agentIds)] } },
    data: { configRevision: { increment: 1 } }
  })
}

/** The per-agent inputs step 4 validates, read under the locks from steps 1–2. */
export interface AgentEnvironmentSnapshot {
  agentId: string
  /** The agent's own variables (`runtimeOverrides.env`). */
  variables: Record<string, string>
  /** The agent's own secret KEY names — values are irrelevant to admission. */
  secretKeys: string[]
  /** Organization entries assigned to this agent AFTER the candidate mutation. */
  organizationEntries: AssignedOrganizationEntry[]
  /** Byte sizes of the organization values, so admission needs no decryption of
   *  its own: the writer supplies the size it is about to persist. */
  organizationValueBytes: Map<string, number>
  /** Byte sizes of the agent's own secret values. */
  agentSecretBytes: Map<string, number>
}

export type AdmissionFailure =
  { outcome: 'cross_kind_conflict'; keys: string[] } | { outcome: 'too_large'; agentIds: string[] }

/**
 * Step 4 for a batch of agents. Two refusals, both before any persistence:
 *
 *  - an organization VARIABLE over an agent SECRET — the declassification the
 *    design forbids outright, in either write direction; and
 *  - a resolved environment that would not fit the wire admission budget.
 *
 * Returns null when every agent is admissible.
 */
export function checkEnvironmentAdmission(snapshots: readonly AgentEnvironmentSnapshot[]): AdmissionFailure | null {
  const conflicts = new Set<string>()
  const oversized: string[] = []
  for (const snapshot of snapshots) {
    for (const key of crossKindConflicts(snapshot.secretKeys, snapshot.organizationEntries)) conflicts.add(key)
    if (resolvedEnvironmentBytes(snapshot) > MAX_RESOLVED_ENVIRONMENT_BYTES) oversized.push(snapshot.agentId)
  }
  if (conflicts.size > 0) return { outcome: 'cross_kind_conflict', keys: [...conflicts].sort() }
  if (oversized.length > 0) return { outcome: 'too_large', agentIds: oversized.sort() }
  return null
}

/**
 * Thrown when the fence refuses an AGENT-LOCAL write (create/PATCH). The
 * organization-environment routes get a typed result object instead; agent
 * create/PATCH already funnel other in-transaction refusals through exceptions,
 * so this keeps that shape and aborts the transaction.
 */
export class OrganizationEnvironmentAdmissionError extends Error {
  constructor(readonly failure: AdmissionFailure) {
    super(
      failure.outcome === 'cross_kind_conflict'
        ? `an organization variable already provides ${failure.keys.join(', ')}; an agent secret cannot use the same name`
        : 'the resolved agent configuration exceeds the size the daemon protocol admits'
    )
    this.name = 'OrganizationEnvironmentAdmissionError'
  }
}

/** Throwing form of {@link checkEnvironmentAdmission} for the agent-local writers. */
export function assertEnvironmentAdmissible(snapshots: readonly AgentEnvironmentSnapshot[]): void {
  const failure = checkEnvironmentAdmission(snapshots)
  if (failure) throw new OrganizationEnvironmentAdmissionError(failure)
}

/**
 * Enroll one agent into every `all`-audience entry it is not already bound to
 * (design §3.4). Called from agent create AND later agent-configuration writes:
 * the actor is already authorized to edit this target, and the Console shows the
 * organization entries that will apply.
 *
 * Returns true when anything was added, so the caller knows the agent's resolved
 * configuration changed.
 */
export async function enrollAgentInAllAudienceEntries(
  tx: Tx,
  orgId: string,
  agentId: string,
  actorUserId?: string
): Promise<boolean> {
  const [entries, existing] = await Promise.all([
    tx.organizationEnvironmentEntry.findMany({ where: { orgId, audience: 'all' }, select: { id: true } }),
    tx.organizationEnvironmentAssignment.findMany({ where: { orgId, agentId }, select: { entryId: true } })
  ])
  const bound = new Set(existing.map((assignment) => assignment.entryId))
  const missing = entries.filter((entry) => !bound.has(entry.id))
  if (missing.length === 0) return false
  await tx.organizationEnvironmentAssignment.createMany({
    data: missing.map((entry) => ({
      orgId,
      entryId: entry.id,
      agentId,
      ...(actorUserId ? { authorizedByUserId: actorUserId } : {})
    })),
    // A concurrent `all` write holding the same org lock cannot interleave, but a
    // retry of this transaction is still harmless.
    skipDuplicates: true
  })
  return true
}

/**
 * The complete agent-local half of the fence, for ONE agent, called at the end of
 * `PgAgentRepo.create` / `PgAgentRepo.update` while their org row lock is held:
 * lock the agent row, enroll it into the current `all` set, then validate the
 * COMPLETE resolved configuration.
 *
 * Placing it in the repo (rather than only in `PgAgentConfigWriter`) means every
 * agent-row write goes through it — including the icon route and preset
 * provisioning, which call the repo directly.
 */
export async function fenceAgentLocalConfigWrite(
  tx: Tx,
  orgId: string,
  agentId: string,
  actorUserId?: string
): Promise<void> {
  await lockAgentsForConfigWrite(tx, [agentId])
  await enrollAgentInAllAudienceEntries(tx, orgId, agentId, actorUserId)
  assertEnvironmentAdmissible(await snapshotAgentEnvironments(tx, orgId, [agentId]))
}

/** Step 3: the committed per-agent inputs, read while the fence locks are held. */
export async function snapshotAgentEnvironments(
  tx: Tx,
  orgId: string,
  agentIds: readonly string[]
): Promise<AgentEnvironmentSnapshot[]> {
  if (agentIds.length === 0) return []
  const ids = [...new Set(agentIds)]
  const [agents, secretRows, assignments] = await Promise.all([
    tx.agent.findMany({ where: { id: { in: ids } }, select: { id: true, runtimeOverrides: true } }),
    // SIZES ONLY — this is an admission check, never a value read.
    tx.$queryRaw<Array<{ agentId: string; key: string; bytes: number }>>(
      Prisma.sql`SELECT "agentId", "key", octet_length("value")::int AS bytes FROM "agent_secret" WHERE "agentId" IN (${Prisma.join(ids)})`
    ),
    tx.organizationEnvironmentAssignment.findMany({
      where: { orgId, agentId: { in: ids } },
      select: {
        agentId: true,
        entry: {
          select: { id: true, key: true, kind: true, variableValue: true, secret: { select: { entryId: true } } }
        }
      }
    })
  ])

  const secretBytes = new Map<string, Map<string, number>>()
  for (const row of secretRows) {
    const perAgent = secretBytes.get(row.agentId) ?? new Map<string, number>()
    perAgent.set(row.key, row.bytes)
    secretBytes.set(row.agentId, perAgent)
  }

  // Value sizes for assigned organization secrets, keyed by entry id.
  const secretEntryIds = [
    ...new Set(
      assignments
        .filter((assignment) => assignment.entry.kind === 'secret' && assignment.entry.secret !== null)
        .map((assignment) => assignment.entry.id)
    )
  ]
  const orgSecretBytes = new Map<string, number>()
  if (secretEntryIds.length > 0) {
    const rows = await tx.$queryRaw<Array<{ entryId: string; bytes: number }>>(
      Prisma.sql`SELECT "entryId", octet_length("value")::int AS bytes FROM "organization_environment_secret" WHERE "entryId" IN (${Prisma.join(secretEntryIds)})`
    )
    for (const row of rows) orgSecretBytes.set(row.entryId, row.bytes)
  }

  const assignedByAgent = new Map<string, typeof assignments>()
  for (const assignment of assignments) {
    const list = assignedByAgent.get(assignment.agentId) ?? []
    list.push(assignment)
    assignedByAgent.set(assignment.agentId, list)
  }

  return agents.map((agent) => {
    const overrides = (agent.runtimeOverrides as { env?: Record<string, string> } | null) ?? {}
    const organizationValueBytes = new Map<string, number>()
    const organizationEntries: AssignedOrganizationEntry[] = []
    for (const assignment of assignedByAgent.get(agent.id) ?? []) {
      const entry = assignment.entry
      const kind = entry.kind as 'variable' | 'secret'
      organizationEntries.push({
        key: entry.key,
        kind,
        // A secret with no value row is INVALID: it tombstones its key instead of
        // reactivating a same-key agent fallback (§9).
        ...(kind === 'secret' && entry.secret === null ? { valid: false } : {})
      })
      organizationValueBytes.set(
        entry.key,
        kind === 'secret' ? (orgSecretBytes.get(entry.id) ?? 0) : Buffer.byteLength(entry.variableValue ?? '', 'utf8')
      )
    }
    return {
      agentId: agent.id,
      variables: overrides.env ?? {},
      secretKeys: [...(secretBytes.get(agent.id)?.keys() ?? [])],
      organizationEntries,
      organizationValueBytes,
      agentSecretBytes: secretBytes.get(agent.id) ?? new Map()
    }
  })
}

/**
 * Encoded size of the two resolved wire maps. Only the winning side of each key
 * counts — an overridden agent row is retained in the database but never shipped
 * — and a tombstoned key contributes nothing at all.
 */
function resolvedEnvironmentBytes(snapshot: AgentEnvironmentSnapshot): number {
  const plan = planEffectiveKeys(Object.keys(snapshot.variables), snapshot.secretKeys, snapshot.organizationEntries)
  let bytes = 0
  for (const effective of plan.keys) {
    const valueBytes =
      effective.source === 'organization'
        ? (snapshot.organizationValueBytes.get(effective.key) ?? 0)
        : effective.kind === 'secret'
          ? (snapshot.agentSecretBytes.get(effective.key) ?? 0)
          : Buffer.byteLength(snapshot.variables[effective.key] ?? '', 'utf8')
    // `"KEY":"VALUE",` in the JSON object the frame carries. JSON escaping can
    // expand a value further, which the fixed headroom above absorbs.
    bytes += Buffer.byteLength(effective.key, 'utf8') + valueBytes + 6
  }
  return bytes
}
