import { canView } from '../authorization/policy.js'
import { Prisma } from '../generated/prisma/client.js'
import type { OrgId } from '../domain/ids.js'
import type { ResourceVisibility } from './ports.js'
import { lockResourceWriteMemberships } from './resource-membership-lock.js'

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
): Promise<(held: readonly string[]) => void> {
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
  return (held) => {
    if (submitted.some((id) => !held.includes(id) && !visible.has(id))) throw new DecisionBindingDenied()
  }
}
