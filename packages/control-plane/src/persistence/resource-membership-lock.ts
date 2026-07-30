/**
 * Serialize ownership-bearing resource writes with organization-member removal.
 *
 * A resource create or sharing write holds `FOR SHARE` on every membership that
 * makes the write valid (actor, initial owner, and requested share targets).
 * Member removal takes `FOR UPDATE` on the departing and recipient memberships
 * before scanning the resource tables. The conflicting row locks make either
 * commit order safe:
 *
 * - resource write first: removal waits, then transfers/prunes the committed row;
 * - removal first: the write wakes, rechecks the membership, and fails or drops
 *   the departed ID before it can persist stale authority.
 */
import { Prisma } from '../generated/prisma/client.js'
import { OrgMembershipMissing } from './errors.js'

export interface ResourceMembershipWrite {
  orgId: string
  /** Human principal performing the write. Absent for trusted internal writes. */
  actorUserId?: string
  /** Initial owner on create. Absent for system-owned/legacy-compatible rows. */
  ownerUserId?: string
  /** Requested share vector; undefined means this write does not set sharing. */
  sharedWith?: readonly string[]
}

export interface LockedResourceMemberships {
  /** Current-member intersection, de-duplicated while preserving request order. */
  sharedWith?: string[]
}

export async function lockResourceWriteMemberships(
  tx: Prisma.TransactionClient,
  input: ResourceMembershipWrite
): Promise<LockedResourceMemberships> {
  // Parent before child: org deletion holds this row FOR UPDATE before cascading
  // memberships. Taking KEY SHARE first prevents a resource create from holding
  // a membership lock while waiting on the parent FK, which would invert that
  // order and deadlock the delete.
  const org = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "org"
    WHERE "id" = ${input.orgId}
    FOR KEY SHARE
  `)
  if (org.length === 0) throw new OrgMembershipMissing()

  const required = [input.actorUserId, input.ownerUserId].filter((id): id is string => id !== undefined)
  const ids = [...new Set([...required, ...(input.sharedWith ?? [])])].sort()

  const rows =
    ids.length === 0
      ? []
      : await tx.$queryRaw<Array<{ userId: string }>>(Prisma.sql`
          SELECT "userId"
          FROM "membership"
          WHERE "orgId" = ${input.orgId}
            AND "userId" IN (${Prisma.join(ids)})
          ORDER BY "userId"
          FOR SHARE
        `)
  const current = new Set(rows.map((row) => row.userId))

  if (required.some((id) => !current.has(id))) throw new OrgMembershipMissing()
  if (input.sharedWith === undefined) return {}

  const seen = new Set<string>()
  return {
    sharedWith: input.sharedWith.filter((id) => {
      if (!current.has(id) || seen.has(id)) return false
      seen.add(id)
      return true
    })
  }
}
