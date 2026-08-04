/**
 * `PgOrganizationEnvironmentRepo` — metadata + binding CRUD for the organization
 * environment registry (organization-secrets-and-variables.md §5).
 *
 * Two hard disciplines, both structural rather than by convention:
 *
 *  - SECRET VALUES: this repo NEVER selects `organization_environment_secret`.
 *    Metadata reads learn only whether a value row exists, and every value passes
 *    through {@link PgOrganizationEnvironmentSecretStore} (the single cipher
 *    seam). A caller hands this repo an ALREADY-SEALED string, so the transaction
 *    never waits on a cipher that may make network calls; sealing that finishes
 *    before a losing transaction is simply discarded and never logged.
 *
 *  - ADMISSION: every writer runs the design §5 fence from
 *    `organization-environment-fence.ts` (org row → agent rows → re-read →
 *    validate → persist + bump `configRevision`), so concurrent entry, binding,
 *    and agent-local writes serialize before final validation.
 *
 * AUTHORIZATION is not softened by ownership. `all` is an automatic-ENROLLMENT
 * policy: it binds exactly the agents the ACTOR may edit, resolved inside the
 * transaction. Being an organization owner never creates the first binding to
 * another member's unshared restricted agent, and a point request naming an
 * invisible, non-editable, or foreign agent returns the not-found-shaped result.
 */
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js'
import type { PrismaLike } from '../prisma.js'
import { withTx } from '../prisma.js'
import type {
  AssignedOrganizationMetadata,
  CreateOrganizationEnvironmentEntryInput,
  OrganizationEnvironmentActor,
  OrganizationEnvironmentEntryRecord,
  OrganizationEnvironmentRepo,
  OrganizationEnvironmentResolver,
  OrganizationEnvironmentSecretStore,
  OrganizationEnvironmentWriteResult,
  UpdateOrganizationEnvironmentEntryInput,
  ViewCtx
} from '../ports.js'
import type { AgentId, OrgId } from '../../domain/ids.js'
import type { SecretCipher } from '../../secrets/cipher.js'
import {
  emptyOrganizationEnvironmentValues,
  type AssignedOrganizationEntry,
  type OrganizationEnvironmentAudience,
  type OrganizationEnvironmentKind,
  type OrganizationEnvironmentValues
} from '../../orchestrator/organizationEnvironment.js'
import {
  bumpAgentConfigRevisions,
  checkEnvironmentAdmission,
  encodedValueBytes,
  lockAgentsForConfigWrite,
  lockOrgForConfigWrite,
  snapshotAgentEnvironments
} from './organization-environment-fence.js'

type Tx = Prisma.TransactionClient

/** The metadata select — deliberately without the secret relation's `value`. */
const entrySelect = {
  id: true,
  orgId: true,
  key: true,
  kind: true,
  variableValue: true,
  audience: true,
  version: true,
  createdByUserId: true,
  lastModifiedByUserId: true,
  createdAt: true,
  updatedAt: true,
  // Existence only. Selecting `entryId` (the primary key) proves the value row is
  // there without the query ever mentioning `value`.
  secret: { select: { entryId: true } },
  assignments: { select: { agentId: true }, orderBy: { agentId: 'asc' } }
} as const satisfies Prisma.OrganizationEnvironmentEntrySelect

type EntryRow = Prisma.OrganizationEnvironmentEntryGetPayload<{ select: typeof entrySelect }>

function toRecord(row: EntryRow): OrganizationEnvironmentEntryRecord {
  return {
    id: row.id,
    orgId: row.orgId as OrgId,
    key: row.key,
    kind: row.kind as OrganizationEnvironmentKind,
    variableValue: row.variableValue,
    secretConfigured: row.secret !== null,
    audience: row.audience as OrganizationEnvironmentAudience,
    version: row.version,
    agentIds: row.assignments.map((assignment) => assignment.agentId),
    createdByUserId: row.createdByUserId,
    lastModifiedByUserId: row.lastModifiedByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

/** Runtime overrides bag shape — only the piece this repo needs. */
interface RuntimeOverridesEnv {
  env?: Record<string, string>
}

/**
 * The `resource.edit` projection, evaluated in SQL so `all` enrollment and the
 * selected-agent picker share ONE policy with `authorization/policy.ts`. A viewer
 * role may edit nothing; every other role may edit exactly what it can see.
 * `viewer: undefined` is the internal/unfiltered form.
 */
function editableAgentWhere(orgId: string, viewer: ViewCtx | undefined): Prisma.AgentWhereInput {
  if (!viewer) return { orgId }
  if (viewer.role === 'viewer') return { orgId, id: { in: [] } }
  return {
    orgId,
    OR: [{ visibility: 'org' }, { ownerUserId: viewer.userId }, { sharedWith: { has: viewer.userId } }]
  }
}

export class PgOrganizationEnvironmentRepo implements OrganizationEnvironmentRepo {
  constructor(
    // The full client: this is a transaction OWNER, not a repo that composes
    // under someone else's transaction.
    private readonly prisma: PrismaClient
  ) {}

  async list(orgId: OrgId): Promise<OrganizationEnvironmentEntryRecord[]> {
    const rows = await this.prisma.organizationEnvironmentEntry.findMany({
      where: { orgId },
      select: entrySelect,
      orderBy: { key: 'asc' }
    })
    return rows.map(toRecord)
  }

  async get(orgId: OrgId, entryId: string): Promise<OrganizationEnvironmentEntryRecord | null> {
    const row = await this.prisma.organizationEnvironmentEntry.findFirst({
      where: { id: entryId, orgId },
      select: entrySelect
    })
    return row ? toRecord(row) : null
  }

  async create(
    orgId: OrgId,
    input: CreateOrganizationEnvironmentEntryInput,
    actor: OrganizationEnvironmentActor
  ): Promise<OrganizationEnvironmentWriteResult> {
    return withTx(this.prisma, async (tx) => {
      if (!(await lockOrgForConfigWrite(tx, orgId))) return { outcome: 'not_found' }
      if (await tx.organizationEnvironmentEntry.findFirst({ where: { orgId, key: input.key }, select: { id: true } })) {
        return { outcome: 'duplicate_key' }
      }

      // `all` binds every agent the ACTOR may edit — never a restricted agent it
      // cannot see. `selected` binds exactly the requested ids, each of which must
      // pass the same edit projection.
      const targets =
        input.audience === 'all'
          ? await this.editableAgentIds(tx, orgId, actor.viewer, input.excludeAgentIds)
          : await this.authorizeTargets(tx, orgId, input.agentIds ?? [], actor.viewer)
      if (targets === null) return { outcome: 'agent_not_found' }

      // JSON-encoded, not raw: escaping is what the frame actually carries.
      const valueBytes = encodedValueBytes(
        input.kind === 'secret' ? (input.sealedSecret ?? '') : (input.variableValue ?? '')
      )
      const candidate: AssignedOrganizationEntry = { key: input.key, kind: input.kind }
      const admission = await this.admit(tx, orgId, targets, {
        add: new Map(targets.map((agentId) => [agentId, [{ entry: candidate, valueBytes }]]))
      })
      if (admission) return admission

      const created = await tx.organizationEnvironmentEntry.create({
        data: {
          orgId,
          key: input.key,
          kind: input.kind,
          variableValue: input.kind === 'variable' ? (input.variableValue ?? '') : null,
          audience: input.audience,
          ...(actor.actorUserId ? { createdByUserId: actor.actorUserId, lastModifiedByUserId: actor.actorUserId } : {}),
          ...(input.kind === 'secret' && input.sealedSecret !== undefined
            ? { secret: { create: { value: input.sealedSecret } } }
            : {})
        },
        select: { id: true }
      })
      // Assignments are written as plain scalars, NOT as a nested relation create:
      // both of their foreign keys are composite on `orgId`, so a nested create
      // cannot state it explicitly (Prisma would have to infer the same column from
      // two relations at once).
      await this.createAssignments(tx, orgId, created.id, targets, actor.actorUserId)
      await bumpAgentConfigRevisions(tx, targets)
      const row = await tx.organizationEnvironmentEntry.findUniqueOrThrow({
        where: { id: created.id },
        select: entrySelect
      })
      return { outcome: 'ok', entry: toRecord(row), affectedAgentIds: targets }
    })
  }

  async update(
    orgId: OrgId,
    entryId: string,
    expectedVersion: number,
    input: UpdateOrganizationEnvironmentEntryInput,
    actor: OrganizationEnvironmentActor
  ): Promise<OrganizationEnvironmentWriteResult> {
    return withTx(this.prisma, async (tx) => {
      if (!(await lockOrgForConfigWrite(tx, orgId))) return { outcome: 'not_found' }
      const existing = await tx.organizationEnvironmentEntry.findFirst({
        where: { id: entryId, orgId },
        select: entrySelect
      })
      if (!existing) return { outcome: 'not_found' }
      if (existing.version !== expectedVersion) return { outcome: 'version_conflict' }

      const current = existing.assignments.map((assignment) => assignment.agentId)
      // Switching to `all` materializes every newly authorized binding and KEEPS
      // prior delegated ones. Switching to `selected` only stops future automatic
      // enrollment — it never silently revokes a binding to a private agent this
      // actor cannot see.
      const enrolled =
        input.audience === 'all'
          ? await this.editableAgentIds(tx, orgId, actor.viewer, input.excludeAgentIds)
          : ([] as string[])
      const added = enrolled.filter((agentId) => !current.includes(agentId))
      const bound = [...current, ...added]

      // A value replacement re-validates every currently bound agent: the new
      // value may be larger than the one it replaces.
      const replacing = input.sealedSecret !== undefined || input.variableValue !== undefined
      const kind = existing.kind as OrganizationEnvironmentKind
      // When the value is OMITTED (an audience-only retarget, or the Console's
      // "Replace value" left blank), the entry still carries its stored value — so
      // admission must count THAT, not zero. Counting zero would let a
      // `selected`→`all` switch enroll agents whose resolved environment the
      // existing value pushes past the frame budget.
      const nextValueBytes = replacing
        ? encodedValueBytes((kind === 'secret' ? input.sealedSecret : input.variableValue) ?? '')
        : await this.currentValueBytes(tx, existing.id, kind, existing.variableValue)
      const revalidate = replacing ? bound : added
      const candidate: AssignedOrganizationEntry = { key: existing.key, kind }
      const admission = await this.admit(tx, orgId, revalidate, {
        add: new Map(added.map((agentId) => [agentId, [{ entry: candidate, valueBytes: nextValueBytes }]])),
        ...(replacing ? { resize: new Map([[existing.key, nextValueBytes]]) } : {})
      })
      if (admission) return admission

      const row = await tx.organizationEnvironmentEntry.update({
        where: { id: entryId },
        data: {
          version: { increment: 1 },
          ...(actor.actorUserId ? { lastModifiedByUserId: actor.actorUserId } : {}),
          ...(input.audience !== undefined ? { audience: input.audience } : {}),
          // `key` and `kind` are immutable: renaming or converting is an explicit
          // delete-and-create (§3.1), so neither appears here by construction.
          ...(kind === 'variable' && input.variableValue !== undefined ? { variableValue: input.variableValue } : {}),
          ...(kind === 'secret' && input.sealedSecret !== undefined
            ? {
                secret: {
                  upsert: { create: { value: input.sealedSecret }, update: { value: input.sealedSecret } }
                }
              }
            : {})
        },
        select: { id: true }
      })
      // Scalar assignment writes — see the note in `create` on why these cannot be
      // a nested relation create.
      await this.createAssignments(tx, orgId, row.id, added, actor.actorUserId)
      // A rotation changes what every BOUND agent must receive, not only the newly
      // enrolled ones.
      const affected = replacing ? bound : added
      await bumpAgentConfigRevisions(tx, affected)
      const refreshed = await tx.organizationEnvironmentEntry.findUniqueOrThrow({
        where: { id: row.id },
        select: entrySelect
      })
      return { outcome: 'ok', entry: toRecord(refreshed), affectedAgentIds: affected }
    })
  }

  async delete(
    orgId: OrgId,
    entryId: string
  ): Promise<{ outcome: 'ok'; affectedAgentIds: string[] } | { outcome: 'not_found' }> {
    return withTx(this.prisma, async (tx) => {
      if (!(await lockOrgForConfigWrite(tx, orgId))) return { outcome: 'not_found' }
      const existing = await tx.organizationEnvironmentEntry.findFirst({
        where: { id: entryId, orgId },
        select: { id: true, assignments: { select: { agentId: true } } }
      })
      if (!existing) return { outcome: 'not_found' }
      const affected = existing.assignments.map((assignment) => assignment.agentId)
      await lockAgentsForConfigWrite(tx, affected)
      // Removal can only SHRINK a resolved spec, so no admission check is needed.
      // The assignment and secret rows cascade.
      await tx.organizationEnvironmentEntry.delete({ where: { id: entryId } })
      await bumpAgentConfigRevisions(tx, affected)
      return { outcome: 'ok', affectedAgentIds: affected }
    })
  }

  async bind(
    orgId: OrgId,
    entryId: string,
    agentId: AgentId,
    actor: OrganizationEnvironmentActor
  ): Promise<OrganizationEnvironmentWriteResult> {
    return withTx(this.prisma, async (tx) => {
      if (!(await lockOrgForConfigWrite(tx, orgId))) return { outcome: 'not_found' }
      const existing = await tx.organizationEnvironmentEntry.findFirst({
        where: { id: entryId, orgId },
        select: entrySelect
      })
      if (!existing) return { outcome: 'not_found' }
      // Per-agent add/remove is only meaningful while the entry is not auto-enrolling.
      if (existing.audience !== 'selected') return { outcome: 'not_selected' }
      const authorized = await this.authorizeTargets(tx, orgId, [agentId], actor.viewer)
      if (authorized === null) return { outcome: 'agent_not_found' }
      if (existing.assignments.some((assignment) => assignment.agentId === agentId)) {
        // Idempotent: already bound, nothing changed and nothing to fan out.
        return { outcome: 'ok', entry: toRecord(existing), affectedAgentIds: [] }
      }

      const kind = existing.kind as OrganizationEnvironmentKind
      const valueBytes = await this.currentValueBytes(tx, existing.id, kind, existing.variableValue)
      const admission = await this.admit(tx, orgId, [agentId], {
        add: new Map([[agentId, [{ entry: { key: existing.key, kind }, valueBytes }]]])
      })
      if (admission) return admission

      await tx.organizationEnvironmentAssignment.create({
        data: {
          orgId,
          entryId,
          agentId,
          ...(actor.actorUserId ? { authorizedByUserId: actor.actorUserId } : {})
        }
      })
      await bumpAgentConfigRevisions(tx, [agentId])
      const row = await tx.organizationEnvironmentEntry.findUniqueOrThrow({
        where: { id: entryId },
        select: entrySelect
      })
      return { outcome: 'ok', entry: toRecord(row), affectedAgentIds: [agentId] }
    })
  }

  async unbind(
    orgId: OrgId,
    entryId: string,
    agentId: AgentId,
    actor: OrganizationEnvironmentActor
  ): Promise<OrganizationEnvironmentWriteResult> {
    return withTx(this.prisma, async (tx) => {
      if (!(await lockOrgForConfigWrite(tx, orgId))) return { outcome: 'not_found' }
      const existing = await tx.organizationEnvironmentEntry.findFirst({
        where: { id: entryId, orgId },
        select: entrySelect
      })
      if (!existing) return { outcome: 'not_found' }
      if (existing.audience !== 'selected') return { outcome: 'not_selected' }
      // Removing a binding is still a targeted change to that agent's runtime
      // configuration, so it takes the same `resource.edit` decision as adding one.
      const authorized = await this.authorizeTargets(tx, orgId, [agentId], actor.viewer)
      if (authorized === null) return { outcome: 'agent_not_found' }
      await lockAgentsForConfigWrite(tx, [agentId])
      const removed = await tx.organizationEnvironmentAssignment.deleteMany({ where: { entryId, agentId } })
      if (removed.count > 0) await bumpAgentConfigRevisions(tx, [agentId])
      const row = await tx.organizationEnvironmentEntry.findUniqueOrThrow({
        where: { id: entryId },
        select: entrySelect
      })
      // Unbinding restores any same-key agent-local row as effective, which is a
      // configuration change the owning daemon must receive.
      return { outcome: 'ok', entry: toRecord(row), affectedAgentIds: removed.count > 0 ? [agentId] : [] }
    })
  }

  /**
   * Write binding rows as plain scalars. Both of an assignment's foreign keys are
   * composite on `orgId`, so a nested relation create from the entry side cannot
   * state that column explicitly — and the composite FKs are exactly what make a
   * cross-organization binding impossible, so they stay.
   *
   * `skipDuplicates` keeps this idempotent under a transaction retry; a concurrent
   * writer cannot interleave because it would need the same org row lock.
   */
  private async createAssignments(
    tx: Tx,
    orgId: string,
    entryId: string,
    agentIds: readonly string[],
    actorUserId?: string
  ): Promise<void> {
    if (agentIds.length === 0) return
    await tx.organizationEnvironmentAssignment.createMany({
      data: agentIds.map((agentId) => ({
        orgId,
        entryId,
        agentId,
        ...(actorUserId ? { authorizedByUserId: actorUserId } : {})
      })),
      skipDuplicates: true
    })
  }

  /** Every agent id in the org the actor may edit, ascending, minus `exclude`
   *  (the HTTP edge's daemon-compatibility skip for `all` enrollment). */
  private async editableAgentIds(
    tx: Tx,
    orgId: string,
    viewer: ViewCtx | undefined,
    exclude?: readonly string[]
  ): Promise<string[]> {
    const rows = await tx.agent.findMany({
      // AND, not a spread: `editableAgentWhere` may itself constrain `id` (the
      // viewer projection), and a spread `id` key would replace that clause.
      where: {
        AND: [
          editableAgentWhere(orgId, viewer),
          ...(exclude && exclude.length > 0 ? [{ id: { notIn: [...exclude] } }] : [])
        ]
      },
      select: { id: true },
      orderBy: { id: 'asc' }
    })
    return rows.map((row) => row.id)
  }

  /**
   * Authorize explicitly requested targets. Returns null when ANY of them is
   * invisible, non-editable, foreign, or absent — the caller maps that to the
   * existing not-found-shaped response so a request can never be used to probe
   * for another member's restricted agent.
   */
  private async authorizeTargets(
    tx: Tx,
    orgId: string,
    agentIds: readonly string[],
    viewer: ViewCtx | undefined
  ): Promise<string[] | null> {
    const wanted = [...new Set(agentIds)].sort()
    if (wanted.length === 0) return []
    const rows = await tx.agent.findMany({
      where: { ...editableAgentWhere(orgId, viewer), id: { in: wanted } },
      select: { id: true }
    })
    return rows.length === wanted.length ? wanted : null
  }

  /** Byte size of the value already stored, without ever returning it. */
  private async currentValueBytes(
    tx: Tx,
    entryId: string,
    kind: OrganizationEnvironmentKind,
    variableValue: string | null
  ): Promise<number> {
    if (kind === 'variable') return encodedValueBytes(variableValue ?? '')
    // JSON-encoded length computed Postgres-side, so the stored secret is sized
    // without ever being returned (see ENCODED_LENGTH_SQL in the fence module).
    const rows = await tx.$queryRaw<Array<{ bytes: number }>>(
      Prisma.sql`SELECT octet_length(to_json("value")::text)::int AS bytes FROM "organization_environment_secret" WHERE "entryId" = ${entryId}::uuid`
    )
    return rows[0]?.bytes ?? 0
  }

  /**
   * Steps 2–4 of the fence for a candidate mutation: lock the affected agents,
   * re-read their local names and currently-assigned entries under those locks,
   * apply the candidate delta, and validate.
   *
   * `add` are entries this mutation newly assigns to an agent; `resize` gives the
   * new byte size of an already-assigned key whose value is being replaced.
   */
  private async admit(
    tx: Tx,
    orgId: string,
    agentIds: readonly string[],
    delta: {
      add?: Map<string, Array<{ entry: AssignedOrganizationEntry; valueBytes: number }>>
      resize?: Map<string, number>
    }
  ): Promise<{ outcome: 'too_large'; agentIds: string[] } | { outcome: 'cross_kind_conflict'; keys: string[] } | null> {
    if (agentIds.length === 0) return null
    const locked = await lockAgentsForConfigWrite(tx, agentIds)
    if (locked.length === 0) return null
    const snapshots = await snapshotAgentEnvironments(tx, orgId, locked)
    for (const snapshot of snapshots) {
      for (const addition of delta.add?.get(snapshot.agentId) ?? []) {
        snapshot.organizationEntries.push(addition.entry)
        snapshot.organizationValueBytes.set(addition.entry.key, addition.valueBytes)
      }
      for (const [key, bytes] of delta.resize ?? []) {
        if (snapshot.organizationValueBytes.has(key)) snapshot.organizationValueBytes.set(key, bytes)
      }
    }
    return checkEnvironmentAdmission(snapshots)
  }
}

/**
 * The ONLY value-reading seam for organization secrets. Mirrors
 * {@link PgAgentSecretStore}: seal before the transaction, open only on the
 * wire-projection path, and never join the value table into a metadata read.
 */
export class PgOrganizationEnvironmentSecretStore implements OrganizationEnvironmentSecretStore {
  constructor(
    private readonly db: PrismaLike,
    private readonly cipher: SecretCipher
  ) {}

  seal(value: string): Promise<string> {
    return this.cipher.seal(value)
  }

  async values(entryIds: readonly string[]): Promise<Map<string, string>> {
    if (entryIds.length === 0) return new Map()
    const rows = await this.db.organizationEnvironmentSecret.findMany({
      where: { entryId: { in: [...new Set(entryIds)] } },
      select: { entryId: true, value: true }
    })
    const out = new Map<string, string>()
    for (const row of rows) out.set(row.entryId, await this.cipher.open(row.value))
    return out
  }
}

/**
 * `PgOrganizationEnvironmentResolver` — the internal effective-config read (§5).
 *
 * Distinct from the metadata read by construction: it resolves assignments and
 * opens ONLY the secrets needed for the requested agent or batch. `metadataForAgents`
 * is the human-DTO twin and performs no decryption at all.
 */
export class PgOrganizationEnvironmentResolver implements OrganizationEnvironmentResolver {
  constructor(
    private readonly db: PrismaLike,
    private readonly secrets: OrganizationEnvironmentSecretStore
  ) {}

  async forAgent(orgId: OrgId, agentId: AgentId): Promise<OrganizationEnvironmentValues> {
    return (await this.forAgents(orgId, [agentId])).get(agentId) ?? emptyOrganizationEnvironmentValues()
  }

  async forAgents(orgId: OrgId, agentIds: readonly AgentId[]): Promise<Map<string, OrganizationEnvironmentValues>> {
    const out = new Map<string, OrganizationEnvironmentValues>()
    if (agentIds.length === 0) return out
    const assignments = await this.assignmentsOf(orgId, agentIds)
    for (const agentId of agentIds) out.set(agentId, emptyOrganizationEnvironmentValues())

    // One batched value read for every assigned secret across the whole set.
    const secretEntryIds = assignments
      .filter((assignment) => assignment.entry.kind === 'secret')
      .map((assignment) => assignment.entry.id)
    const values = await this.secrets.values([...new Set(secretEntryIds)])

    for (const assignment of assignments) {
      const resolved = out.get(assignment.agentId)
      if (!resolved) continue
      const entry = assignment.entry
      if (entry.kind === 'variable') {
        resolved.variables.set(entry.key, entry.variableValue ?? '')
        continue
      }
      const value = values.get(entry.id)
      // Missing material is an INVALID entry, never an absent one: the key is
      // tombstoned so it cannot silently fall back to a same-key agent secret (§9).
      if (value === undefined) resolved.invalidKeys.add(entry.key)
      else resolved.secrets.set(entry.key, value)
    }
    return out
  }

  async metadataForAgents(
    orgId: OrgId,
    agentIds: readonly AgentId[]
  ): Promise<Map<string, AssignedOrganizationMetadata>> {
    const out = new Map<string, AssignedOrganizationMetadata>()
    if (agentIds.length === 0) return out
    for (const agentId of agentIds) out.set(agentId, { variables: [], secretKeys: [] })
    for (const assignment of await this.assignmentsOf(orgId, agentIds)) {
      const metadata = out.get(assignment.agentId)
      if (!metadata) continue
      if (assignment.entry.kind === 'variable') {
        metadata.variables.push({ key: assignment.entry.key, value: assignment.entry.variableValue ?? '' })
      } else {
        metadata.secretKeys.push(assignment.entry.key)
      }
    }
    for (const metadata of out.values()) {
      metadata.variables.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      metadata.secretKeys.sort()
    }
    return out
  }

  private assignmentsOf(orgId: OrgId, agentIds: readonly AgentId[]) {
    return this.db.organizationEnvironmentAssignment.findMany({
      where: { orgId, agentId: { in: [...agentIds] } },
      select: {
        agentId: true,
        entry: { select: { id: true, key: true, kind: true, variableValue: true } }
      },
      // Stable resolution when two entries somehow name one key: the org keyspace
      // is unique, so this only fixes an ordering, never a policy.
      orderBy: [{ agentId: 'asc' }, { entryId: 'asc' }]
    })
  }
}
