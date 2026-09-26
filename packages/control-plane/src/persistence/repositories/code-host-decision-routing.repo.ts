import {
  CODE_HOST_ROUTING_FAMILIES,
  CODE_HOST_ROUTING_PROVIDERS,
  DecisionBundleDefinition,
  SharedBotDecisionRouting,
  decisionChainIds,
  decisionRoutingAgentIds,
  isCodeHostRoutingScope,
  type CodeHostRoutingFamily,
  type CodeHostRoutingProvider
} from '@agentconnect.md/protocol'
import { AgentId, OrgId, type DaemonId } from '../../domain/ids.js'
import type { CodeHostDecisionRouting, Decision, Prisma } from '../../generated/prisma/client.js'
import type {
  CodeHostDecisionRoutingRecord,
  CodeHostDecisionRoutingRepo,
  CodeHostDecisionRoutingUsage,
  CodeHostRoutingScope
} from '../ports.js'
import { withAmbientTx, type PrismaLike } from '../prisma.js'
import { enterDecisionBindingFence } from '../decision-binding-fence.js'
import { bumpAgentConfigRevisions } from './organization-environment-fence.js'

type Tx = Prisma.TransactionClient

/** Whether a stored (provider, family) pair is a routable scope, narrowing both. */
const isScope = <R extends { provider: string; family: string | null }>(
  row: R
): row is R & { provider: CodeHostRoutingProvider; family: CodeHostRoutingFamily } =>
  isCodeHostRoutingScope(row.provider, row.family)

function definitionOf(d: Decision | null | undefined): DecisionBundleDefinition | null {
  if (!d) return null
  const parsed = DecisionBundleDefinition.safeParse({
    id: d.id,
    orgId: d.orgId,
    name: d.name,
    providerId: d.providerId,
    model: d.model,
    question: d.question
  })
  return parsed.success ? parsed.data : null
}

// A stored config that no longer parses keeps its row with a null config, so the scope holds rather than firing unrouted.
function toRecord(row: CodeHostDecisionRouting & { decision?: Decision | null }): CodeHostDecisionRoutingRecord | null {
  if (!isScope(row)) return null
  const config = SharedBotDecisionRouting.safeParse({
    enabled: row.enabled,
    decisionId: row.decisionId,
    rules: row.rules,
    otherwise: row.otherwise,
    ...(Array.isArray(row.steps) && row.steps.length ? { steps: row.steps } : {})
  })
  return {
    id: row.id,
    orgId: OrgId(row.orgId),
    provider: row.provider,
    repoId: row.repoId,
    repoFullName: row.repoFullName,
    family: row.family,
    enabled: row.enabled,
    decisionId: row.decisionId,
    config: config.success ? config.data : null,
    needsReview: row.needsReview,
    evaluationAgentId: row.evaluationAgentId ? AgentId(row.evaluationAgentId) : null,
    definition: definitionOf(row.decision),
    updatedAt: row.updatedAt
  }
}

const scopeWhere = (scope: CodeHostRoutingScope) => ({
  orgId_provider_repoId_family: {
    orgId: scope.orgId,
    provider: scope.provider,
    repoId: scope.repoId,
    family: scope.family
  }
})

async function routingRecord(
  db: PrismaLike,
  row: Parameters<typeof toRecord>[0]
): Promise<CodeHostDecisionRoutingRecord | null> {
  const record = toRecord(row)
  if (!record?.config?.steps?.length) return record
  const definitions = await db.decision.findMany({
    where: { orgId: row.orgId, id: { in: decisionChainIds(record.config) } }
  })
  return { ...record, definitions: definitions.flatMap((d) => definitionOf(d) ?? []) }
}

/** Bump the hosts of these scopes' routings: a member hook write changes what their AgentSpec.hookRoutings carries. */
export async function bumpCodeHostRoutingHosts(
  tx: Tx,
  orgId: string,
  scopes: ReadonlyArray<{
    kind: string | null | undefined
    repoId: bigint | null | undefined
    family: string | null | undefined
  }>
): Promise<void> {
  const keyed = scopes.filter(
    (s): s is { kind: CodeHostRoutingProvider; repoId: bigint; family: CodeHostRoutingFamily } =>
      typeof s.repoId === 'bigint' && isCodeHostRoutingScope(s.kind ?? '', s.family)
  )
  if (keyed.length === 0) return
  const hosts = await tx.codeHostDecisionRouting.findMany({
    where: {
      orgId,
      evaluationAgentId: { not: null },
      OR: keyed.map((s) => ({ provider: s.kind, repoId: s.repoId, family: s.family }))
    },
    select: { evaluationAgentId: true }
  })
  await bumpAgentConfigRevisions(
    tx,
    hosts.flatMap((h) => (h.evaluationAgentId ? [h.evaluationAgentId] : []))
  )
}

export class PgCodeHostDecisionRoutingRepo implements CodeHostDecisionRoutingRepo {
  constructor(private readonly db: PrismaLike) {}

  async get(scope: CodeHostRoutingScope): Promise<CodeHostDecisionRoutingRecord | null> {
    const row = await this.db.codeHostDecisionRouting.findUnique({
      where: scopeWhere(scope),
      include: { decision: true }
    })
    return row ? routingRecord(this.db, row) : null
  }

  async save(
    scope: CodeHostRoutingScope & { repoFullName: string },
    config: SharedBotDecisionRouting,
    actorUserId: string | null
  ): Promise<CodeHostDecisionRoutingRecord> {
    return withAmbientTx(this.db, async (tx) => {
      const authorize = await enterDecisionBindingFence(
        tx,
        scope.orgId,
        decisionChainIds(config),
        actorUserId ?? undefined
      )
      authorize([])
      const data = {
        repoFullName: scope.repoFullName,
        enabled: config.enabled,
        decisionId: config.decisionId,
        rules: config.rules as unknown as Prisma.InputJsonValue,
        otherwise: config.otherwise as unknown as Prisma.InputJsonValue,
        steps: (config.steps ?? []) as unknown as Prisma.InputJsonValue,
        needsReview: false,
        updatedByUserId: actorUserId
      }
      const saved = await tx.codeHostDecisionRouting.upsert({
        where: scopeWhere(scope),
        create: {
          orgId: scope.orgId,
          provider: scope.provider,
          repoId: scope.repoId,
          family: scope.family,
          ...data,
          createdByUserId: actorUserId
        },
        update: data,
        include: { decision: true }
      })
      if (saved.evaluationAgentId) await bumpAgentConfigRevisions(tx, [saved.evaluationAgentId])
      const record = await routingRecord(tx, saved)
      if (!record) throw new Error(`code-host routing ${saved.id} did not persist`)
      return record
    })
  }

  async delete(scope: CodeHostRoutingScope): Promise<CodeHostDecisionRoutingRecord | null> {
    return withAmbientTx(this.db, async (tx) => {
      const row = await tx.codeHostDecisionRouting.findUnique({ where: scopeWhere(scope), include: { decision: true } })
      if (!row) return null
      await tx.codeHostDecisionRouting.delete({ where: { id: row.id } })
      if (row.evaluationAgentId) await bumpAgentConfigRevisions(tx, [row.evaluationAgentId])
      return routingRecord(tx, row)
    })
  }

  async listForHost(agentId: AgentId): Promise<CodeHostDecisionRoutingRecord[]> {
    const rows = await this.db.codeHostDecisionRouting.findMany({
      where: { evaluationAgentId: agentId },
      include: { decision: true },
      orderBy: { id: 'asc' }
    })
    const records = await Promise.all(rows.map((row) => routingRecord(this.db, row)))
    return records.filter((record): record is CodeHostDecisionRoutingRecord => record !== null)
  }

  async setEvaluationAgent(id: string, expected: AgentId | null, next: AgentId | null): Promise<boolean> {
    if (expected === next) return true
    return withAmbientTx(this.db, async (tx) => {
      const moved = await tx.codeHostDecisionRouting.updateMany({
        where: { id, evaluationAgentId: expected },
        data: { evaluationAgentId: next }
      })
      if (moved.count === 0) return false
      // Both projections change: the old host drops the scope, the new one gains it.
      await bumpAgentConfigRevisions(
        tx,
        [expected, next].filter((a): a is AgentId => a !== null)
      )
      return true
    })
  }

  async touchHost(id: string): Promise<void> {
    await withAmbientTx(this.db, async (tx) => {
      const row = await tx.codeHostDecisionRouting.findUnique({ where: { id }, select: { evaluationAgentId: true } })
      if (row?.evaluationAgentId) await bumpAgentConfigRevisions(tx, [row.evaluationAgentId])
    })
  }

  async listScopesForDaemon(daemonId: DaemonId): Promise<CodeHostRoutingScope[]> {
    const hooks = (
      await this.db.hookDef.findMany({
        where: {
          kind: { in: [...CODE_HOST_ROUTING_PROVIDERS] },
          enabled: true,
          repoId: { not: null },
          family: { in: [...CODE_HOST_ROUTING_FAMILIES] },
          agent: { daemonId }
        },
        select: { orgId: true, kind: true, repoId: true, family: true },
        distinct: ['orgId', 'kind', 'repoId', 'family']
      })
    ).filter((h) => isCodeHostRoutingScope(h.kind, h.family))
    if (hooks.length === 0) return []
    const routed = await this.db.codeHostDecisionRouting.findMany({
      where: {
        OR: hooks.map((h) => ({ orgId: h.orgId, provider: h.kind, repoId: h.repoId!, family: h.family! }))
      },
      select: { orgId: true, provider: true, repoId: true, family: true }
    })
    return routed.flatMap((r) =>
      isScope(r) ? [{ orgId: OrgId(r.orgId), provider: r.provider, repoId: r.repoId, family: r.family }] : []
    )
  }

  async listUsages(orgId: OrgId, decisionIds?: readonly string[]): Promise<CodeHostDecisionRoutingUsage[]> {
    if (decisionIds?.length === 0) return []
    const stored = await this.db.codeHostDecisionRouting.findMany({
      where: { orgId },
      select: {
        id: true,
        decisionId: true,
        provider: true,
        repoId: true,
        repoFullName: true,
        family: true,
        rules: true,
        steps: true
      },
      orderBy: [{ repoFullName: 'asc' }, { family: 'asc' }]
    })
    const rows = stored.filter(isScope)
    if (rows.length === 0) return []
    const hooks = await this.db.hookDef.findMany({
      where: {
        orgId,
        enabled: true,
        agentId: { not: null },
        OR: rows.map((row) => ({ kind: row.provider, repoId: row.repoId, family: row.family }))
      },
      select: { agentId: true, kind: true, repoId: true, family: true }
    })
    return rows.flatMap((row) => {
      const rules = SharedBotDecisionRouting.shape.rules.safeParse(row.rules)
      const steps = SharedBotDecisionRouting.shape.steps.safeParse(row.steps)
      const chain = { decisionId: row.decisionId, ...(steps.success && steps.data ? { steps: steps.data } : {}) }
      const targets = rules.success ? decisionRoutingAgentIds({ rules: rules.data, steps: chain.steps }) : []
      const members = hooks
        .filter((h) => h.kind === row.provider && h.repoId === row.repoId && h.family === row.family)
        .flatMap((h) => (h.agentId ? [h.agentId] : []))
      return decisionChainIds(chain)
        .filter((id) => !decisionIds || decisionIds.includes(id))
        .map((id) => ({
          decisionId: id,
          rootDecisionId: row.decisionId,
          routingId: row.id,
          provider: row.provider,
          repoId: row.repoId,
          repoFullName: row.repoFullName,
          family: row.family,
          agentIds: [...new Set([...members, ...targets])].map(AgentId)
        }))
    })
  }
}
