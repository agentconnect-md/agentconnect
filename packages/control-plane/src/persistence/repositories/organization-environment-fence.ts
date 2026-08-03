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
 * Allowance for what this fence cannot measure from the rows it reads: the
 * `agent/upsert` envelope and control extension, the spec's scalar fields, and the
 * resolved `skills` / `managedSkills` entries (which the assembler expands from
 * other tables into more bytes than the ids and refs stored on the agent).
 *
 * 32 KiB rather than a token amount, because being wrong in this direction
 * persists a configuration the daemon codec can never accept, while being wrong in
 * the other direction only refuses a borderline write the operator can split.
 */
const SPEC_OVERHEAD_RESERVE = 32 * 1024
export const MAX_RESOLVED_ENVIRONMENT_BYTES = MAX_FRAME_BYTES - SPEC_OVERHEAD_RESERVE

/**
 * Exact JSON-encoded size of one string as it will appear in the frame, INCLUDING
 * its surrounding quotes and every escape.
 *
 * Escaping is the reason a raw byte length is not usable here: a value of 60 KiB
 * quotes doubles, and control characters expand six-fold as `\uXXXX`. Measuring the
 * raw length let four such values pass a 240 KiB counter while encoding to roughly
 * 480 KiB — past the 256 KiB codec ceiling.
 */
export function encodedValueBytes(value: string): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

/**
 * The SQL twin of {@link encodedValueBytes}, for a value the fence must size
 * WITHOUT reading it. `to_json(text)` produces the same escaped JSON string
 * Postgres-side, so only its length crosses the wire — no plaintext, no ciphertext.
 *
 * CAVEAT, deliberate: this measures the STORED representation. Under the default
 * identity cipher that is the plaintext, so the size is exact. Under an encrypting
 * provider it is the ciphertext's encoded size, which is an approximation — the
 * transaction cannot open a value without waiting on a cipher that may make network
 * calls, which is the one thing a transaction must never do. The reserve above
 * absorbs ordinary divergence.
 */
const ENCODED_LENGTH_SQL = 'octet_length(to_json("value")::text)'

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

/**
 * Bump every agent whose resolved spec DERIVES from a row outside the agent
 * table — a shared skill source, or a centrally-managed skill bundle.
 *
 * This is not an optimization; omitting it WEDGES the agent. `AgentSpec.skills`
 * and `AgentSpec.managedSkills` are resolved by the assembler from those tables,
 * so editing a skill source's `source`/`ref`/`subDir`, archiving a managed skill,
 * or accepting a new bundle revision changes the spec CONTENT while the agent row
 * — and therefore `configRevision` — stands still. The daemon then receives the
 * same revision with a different digest, which it correctly refuses as an
 * invariant violation, and every reconnect repeats that refusal until some
 * unrelated agent edit happens to move the revision.
 *
 * Agents bind a skill source by NAME (`"<source>/<skill>"` / `"<source>/*"`), so
 * the match is on the parsed ref rather than an id.
 */
export async function bumpAgentsReferencingSkillSource(tx: Tx, orgId: string, sourceName: string): Promise<string[]> {
  const agents = await tx.agent.findMany({ where: { orgId }, select: { id: true, runtimeOverrides: true } })
  const affected = agents
    .filter((agent) => {
      const skills = (agent.runtimeOverrides as { skills?: string[] } | null)?.skills ?? []
      return skills.some((ref) => skillRefSource(ref) === sourceName)
    })
    .map((agent) => agent.id)
  await bumpAgentConfigRevisions(tx, affected)
  return affected
}

/** The managed-skill twin: agents hold accepted bundle ids in a scalar array. */
export async function bumpAgentsReferencingManagedSkill(
  tx: Tx,
  orgId: string,
  managedSkillId: string
): Promise<string[]> {
  const agents = await tx.agent.findMany({
    where: { orgId, managedSkills: { has: managedSkillId } },
    select: { id: true }
  })
  const affected = agents.map((agent) => agent.id)
  await bumpAgentConfigRevisions(tx, affected)
  return affected
}

/**
 * The source half of a skill ref. Deliberately a local two-line parse rather than
 * an import from `orchestrator/skillSource.js`: this module sits in the
 * persistence layer, and the only thing it needs is the substring before the
 * first `/`.
 */
function skillRefSource(ref: string): string {
  const slash = ref.indexOf('/')
  return slash === -1 ? ref : ref.slice(0, slash)
}

/**
 * Encoded weight of the skill sources THIS agent enables — the rows its resolved
 * `AgentSpec.skills` entries are built from.
 *
 * Scoped to the agent's own enable-list on purpose. Charging every agent for the
 * whole organization registry would let unrelated source metadata accumulate until
 * no agent or environment write could pass admission at all.
 */
function enabledSkillSourceBytes(runtimeOverrides: unknown, sizesByName: Map<string, number>): number {
  const refs = (runtimeOverrides as { skills?: string[] } | null)?.skills ?? []
  let bytes = 0
  for (const name of new Set(refs.map(skillRefSource))) bytes += sizesByName.get(name) ?? 0
  return bytes
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
  /** JSON-ENCODED sizes of the organization values (quotes and escapes included),
   *  so admission never has to decrypt: the writer supplies the size it is about to
   *  persist, and stored values are measured Postgres-side. */
  organizationValueBytes: Map<string, number>
  /** JSON-encoded sizes of the agent's own secret values. */
  agentSecretBytes: Map<string, number>
  /**
   * Encoded weight of everything ELSE the agent contributes to its spec — the
   * `runtimeOverrides` bag, description, workspace strings, and the skill-source
   * rows its enable-list resolves through. Deliberately an over-count (the bag
   * includes `env`, which is also counted per-key), because over-counting only
   * refuses a borderline write while under-counting persists an undeliverable one.
   */
  otherSpecBytes: number
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
    if (resolvedSpecBytes(snapshot) > MAX_RESOLVED_ENVIRONMENT_BYTES) oversized.push(snapshot.agentId)
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
  const [agents, secretRows, otherSpecRows, skillSourceRows, assignments] = await Promise.all([
    tx.agent.findMany({ where: { id: { in: ids } }, select: { id: true, runtimeOverrides: true } }),
    // SIZES ONLY — this is an admission check, never a value read. `to_json`
    // computes the escaped JSON length Postgres-side, so escaping is measured
    // exactly while the value itself never crosses the wire.
    tx.$queryRaw<Array<{ agentId: string; key: string; bytes: number }>>(
      Prisma.sql`SELECT "agentId", "key", ${Prisma.raw(ENCODED_LENGTH_SQL)}::int AS bytes FROM "agent_secret" WHERE "agentId" IN (${Prisma.join(ids)})`
    ),
    // The NON-ENVIRONMENT projection of the agent row (see `otherSpecBytes`).
    // `- 'env'` is essential: the effective env members are counted individually by
    // `resolvedSpecBytes`, so leaving `env` in the bag here would count every local
    // variable TWICE and reject configurations the wire carries comfortably.
    // Secrets are separate rows and were never in the bag.
    tx.$queryRaw<Array<{ id: string; bytes: number }>>(
      Prisma.sql`
        SELECT a."id",
               ( coalesce(octet_length((a."runtimeOverrides" - 'env')::text), 0)
               + coalesce(octet_length(to_json(a."description")::text), 0)
               + coalesce(octet_length(to_json(a."name")::text), 0)
               + coalesce(octet_length(to_json(a."displayName")::text), 0)
               + coalesce(octet_length(to_json(a."gitRepo")::text), 0)
               + coalesce(octet_length(to_json(a."gitBranch")::text), 0)
               + coalesce(octet_length(to_json(a."agentDir")::text), 0)
               + coalesce(octet_length(array_to_string(a."managedSkills", ',')), 0)
               + coalesce(octet_length(array_to_string(a."allowedCallerAgentIds", ',')), 0)
               + coalesce(octet_length(array_to_string(a."allowedTargetAgentIds", ',')), 0)
               )::int AS bytes
        FROM "agent" a WHERE a."id" IN (${Prisma.join(ids)})`
    ),
    // Skill-source rows, sized per NAME so each agent is charged only for the
    // sources its own enable-list resolves through. Summing the whole organization
    // registry would let unrelated metadata growth block every agent and
    // environment write.
    tx.$queryRaw<Array<{ name: string; bytes: number }>>(
      Prisma.sql`SELECT "name", octet_length(to_json(s)::text)::int AS bytes FROM "skill_source" s WHERE "orgId" = ${orgId}`
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
      Prisma.sql`SELECT "entryId", ${Prisma.raw(ENCODED_LENGTH_SQL)}::int AS bytes FROM "organization_environment_secret" WHERE "entryId" IN (${Prisma.join(secretEntryIds)})`
    )
    for (const row of rows) orgSecretBytes.set(row.entryId, row.bytes)
  }

  const otherSpec = new Map(otherSpecRows.map((row) => [row.id, row.bytes]))
  const skillSourceSizes = new Map(skillSourceRows.map((row) => [row.name, row.bytes]))

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
        kind === 'secret' ? (orgSecretBytes.get(entry.id) ?? 0) : encodedValueBytes(entry.variableValue ?? '')
      )
    }
    return {
      agentId: agent.id,
      variables: overrides.env ?? {},
      secretKeys: [...(secretBytes.get(agent.id)?.keys() ?? [])],
      organizationEntries,
      organizationValueBytes,
      agentSecretBytes: secretBytes.get(agent.id) ?? new Map(),
      // The row's non-env projection, plus only the skill sources THIS agent
      // enables — the resolved `AgentSpec.skills` entries are built from them.
      otherSpecBytes: (otherSpec.get(agent.id) ?? 0) + enabledSkillSourceBytes(agent.runtimeOverrides, skillSourceSizes)
    }
  })
}

/**
 * Encoded size of the resolved spec: the two wire maps plus everything else the
 * agent contributes. Only the winning side of each key counts — an overridden agent
 * row is retained in the database but never shipped — and a tombstoned key
 * contributes nothing at all.
 *
 * Every value size here is already JSON-ENCODED (see {@link encodedValueBytes} and
 * `ENCODED_LENGTH_SQL}`), so escaping is measured rather than hoped for.
 */
function resolvedSpecBytes(snapshot: AgentEnvironmentSnapshot): number {
  const plan = planEffectiveKeys(Object.keys(snapshot.variables), snapshot.secretKeys, snapshot.organizationEntries)
  let bytes = snapshot.otherSpecBytes
  for (const effective of plan.keys) {
    const valueBytes =
      effective.source === 'organization'
        ? (snapshot.organizationValueBytes.get(effective.key) ?? 0)
        : effective.kind === 'secret'
          ? (snapshot.agentSecretBytes.get(effective.key) ?? 0)
          : encodedValueBytes(snapshot.variables[effective.key] ?? '')
    // One `"KEY":VALUE,` member: the encoded key, a colon, the encoded value (its
    // own quotes already included), and a separating comma.
    bytes += encodedValueBytes(effective.key) + 1 + valueBytes + 1
  }
  return bytes
}
