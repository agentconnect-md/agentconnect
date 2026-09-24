import { canView } from '../authorization/policy.js'
import { Prisma } from '../generated/prisma/client.js'
import type { OrgId } from '../domain/ids.js'
import type { ResourceVisibility } from './ports.js'
import { lockResourceWriteMemberships } from './resource-membership-lock.js'
import {
  DecisionQuestion,
  decisionChainIds,
  type DecisionChainStep,
  decisionModelSelectionIssues,
  modelSelectionDecisionIds,
  type AgentModelSelection
} from '@agentconnect.md/protocol'

export class ModelSelectionInvalid extends Error {}

export async function validateModelSelection(
  tx: Prisma.TransactionClient,
  orgId: OrgId,
  selection: AgentModelSelection | null | undefined,
  fallbackModel: string | null | undefined
): Promise<void> {
  if (!selection) return
  if (!fallbackModel) throw new ModelSelectionInvalid('Choose a default model before enabling model selection.')
  const ids = modelSelectionDecisionIds(selection)
  const rows = await tx.decision.findMany({ where: { orgId, id: { in: ids } } })
  if (rows.length !== ids.length) throw new DecisionBindingDenied()
  const questions = new Map(rows.map((row) => [row.id, DecisionQuestion.parse(row.question)]))
  const issues = decisionModelSelectionIssues(questions.get(selection.decisionId)!, selection, questions)
  if (issues.length) throw new ModelSelectionInvalid(issues[0]!.message)
}

export class DecisionBindingDenied extends Error {
  constructor() {
    super('cannot add a Decision that is missing or not visible to you')
  }
}

export { DecisionInUse } from './errors.js'

// Lock membership and submitted Decisions before the agent row; retained bindings keep their original authorization.
export async function enterDecisionBindingFence(
  tx: Prisma.TransactionClient,
  orgId: OrgId,
  submitted: readonly string[] | null | undefined,
  actorUserId: string | undefined
): Promise<(held: readonly string[], requested?: readonly string[]) => void> {
  if (!submitted?.length) return () => {}
  if (!actorUserId) throw new DecisionBindingDenied()
  await lockResourceWriteMemberships(tx, { orgId, visibility: 'org', actorUserId })
  const member = await tx.membership.findUnique({ where: { orgId_userId: { orgId, userId: actorUserId } } })
  if (!member || member.role === 'viewer') throw new DecisionBindingDenied()
  const rows = await tx.$queryRaw<Array<{ id: string; visibility: ResourceVisibility; sharedWith: string[] }>>(
    Prisma.sql`SELECT "id", "visibility", "sharedWith" FROM "decision"
      WHERE "orgId" = ${orgId} AND "id" IN (${Prisma.join([...new Set(submitted)].map((id) => Prisma.sql`${id}::uuid`))})
      ORDER BY "id" FOR SHARE`
  )
  const visible = new Set(
    rows.filter((row) => canView(row, { userId: actorUserId, role: member.role })).map((row) => row.id)
  )
  return (held, requested = submitted) => {
    if (requested.some((id) => !held.includes(id) && !visible.has(id))) throw new DecisionBindingDenied()
  }
}

// Nested references have no foreign key; share the deletion fence with root references.
export async function lockDecisionChain(
  tx: Prisma.TransactionClient,
  orgId: string,
  chain: DecisionChainStep & { steps?: readonly DecisionChainStep[] }
): Promise<void> {
  const ids = decisionChainIds(chain)
  const rows = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT "id" FROM "decision" WHERE "orgId" = ${orgId} AND "id" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY "id" FOR KEY SHARE`
  )
  if (rows.length !== ids.length) throw new DecisionBindingDenied()
}
