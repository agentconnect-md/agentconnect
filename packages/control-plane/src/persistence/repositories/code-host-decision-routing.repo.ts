import {
  CODE_HOST_ROUTING_FAMILIES,
  DecisionBundleDefinition,
  SharedBotDecisionRouting,
  decisionRoutingAgentIds,
  type CodeHostRoutingFamily
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
import { bumpAgentConfigRevisions } from './organization-environment-fence.js'

type Tx = Prisma.TransactionClient

const isFamily = (family: string | null | undefined): family is CodeHostRoutingFamily =>
  (CODE_HOST_ROUTING_FAMILIES as readonly string[]).includes(family ?? '')

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
  if (!isFamily(row.family) || row.provider !== 'github') return null
  const config = SharedBotDecisionRouting.safeParse({
    enabled: row.enabled,
    decisionId: row.decisionId,
    rules: row.rules,
    otherwise: row.otherwise
  })
  return {
    id: row.id,
    orgId: OrgId(row.orgId),
    provider: 'github',
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
  orgId_provider_repoId_family: { orgId: scope.orgId, provider: 'github', repoId: scope.repoId, family: scope.family }
})

/** Bump the hosts of these scopes' routings: a member hook write changes what their AgentSpec.hookRoutings carries. */
export async function bumpCodeHostRoutingHosts(
  tx: Tx,
  orgId: string,
  scopes: ReadonlyArray<{ repoId: bigint | null | undefined; family: string | null | undefined }>
): Promise<void> {
  const keyed = scopes.filter(
    (s): s is { repoId: bigint; family: CodeHostRoutingFamily } => typeof s.repoId === 'bigint' && isFamily(s.family)
  )
  if (keyed.length === 0) return
  const hosts = await tx.codeHostDecisionRouting.findMany({
    where: {
      orgId,
      provider: 'github',
      evaluationAgentId: { not: null },
      OR: keyed.map((s) => ({ repoId: s.repoId, family: s.family }))
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
    return row ? toRecord(row) : null
  }

  async save(
    scope: CodeHostRoutingScope & { repoFullName: string },
    config: SharedBotDecisionRouting,
    actorUserId: string | null
  ): Promise<CodeHostDecisionRoutingRecord> {
    return withAmbientTx(this.db, async (tx) => {
      const data = {
        repoFullName: scope.repoFullName,
        enabled: config.enabled,
        decisionId: config.decisionId,
        rules: config.rules as unknown as Prisma.InputJsonValue,
        otherwise: config.otherwise as unknown as Prisma.InputJsonValue,
        needsReview: false,
        updatedByUserId: actorUserId
      }
      const saved = await tx.codeHostDecisionRouting.upsert({
        where: scopeWhere(scope),
        create: {
          orgId: scope.orgId,
          provider: 'github',
          repoId: scope.repoId,
          family: scope.family,
          ...data,
          createdByUserId: actorUserId
        },
        update: data,
        include: { decision: true }
      })
      if (saved.evaluationAgentId) await bumpAgentConfigRevisions(tx, [saved.evaluationAgentId])
      const record = toRecord(saved)
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
      return toRecord(row)
    })
  }

  async listForHost(agentId: AgentId): Promise<CodeHostDecisionRoutingRecord[]> {
    const rows = await this.db.codeHostDecisionRouting.findMany({
      where: { evaluationAgentId: agentId },
      include: { decision: true },
      orderBy: { id: 'asc' }
    })
    return rows.flatMap((row) => toRecord(row) ?? [])
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
    const hooks = await this.db.hookDef.findMany({
      where: {
        kind: 'github',
        enabled: true,
        repoId: { not: null },
        family: { in: [...CODE_HOST_ROUTING_FAMILIES] },
        agent: { daemonId }
      },
      select: { orgId: true, repoId: true, family: true },
      distinct: ['orgId', 'repoId', 'family']
    })
    if (hooks.length === 0) return []
    const routed = await this.db.codeHostDecisionRouting.findMany({
      where: { provider: 'github', OR: hooks.map((h) => ({ orgId: h.orgId, repoId: h.repoId!, family: h.family! })) },
      select: { orgId: true, repoId: true, family: true }
    })
    return routed.flatMap((r) =>
      isFamily(r.family) ? [{ orgId: OrgId(r.orgId), repoId: r.repoId, family: r.family }] : []
    )
  }

  async listUsages(orgId: OrgId, decisionIds?: readonly string[]): Promise<CodeHostDecisionRoutingUsage[]> {
    if (decisionIds?.length === 0) return []
    const rows = await this.db.codeHostDecisionRouting.findMany({
      where: { orgId, ...(decisionIds ? { decisionId: { in: [...decisionIds] } } : {}) },
      select: { id: true, decisionId: true, repoId: true, repoFullName: true, family: true, rules: true },
      orderBy: [{ repoFullName: 'asc' }, { family: 'asc' }]
    })
    if (rows.length === 0) return []
    const hooks = await this.db.hookDef.findMany({
      where: {
        orgId,
        kind: 'github',
        enabled: true,
        agentId: { not: null },
        OR: rows.map((row) => ({ repoId: row.repoId, family: row.family }))
      },
      select: { agentId: true, repoId: true, family: true }
    })
    return rows.flatMap((row) => {
      if (!isFamily(row.family)) return []
      const rules = SharedBotDecisionRouting.shape.rules.safeParse(row.rules)
      const targets = rules.success ? decisionRoutingAgentIds({ rules: rules.data }) : []
      const members = hooks
        .filter((h) => h.repoId === row.repoId && h.family === row.family)
        .flatMap((h) => (h.agentId ? [h.agentId] : []))
      return [
        {
          decisionId: row.decisionId,
          routingId: row.id,
          repoId: row.repoId,
          repoFullName: row.repoFullName,
          family: row.family,
          agentIds: [...new Set([...members, ...targets])].map(AgentId)
        }
      ]
    })
  }
}
