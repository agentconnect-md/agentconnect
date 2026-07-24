/**
 * `http/sharing.ts` — shared helper for the `/{agents,daemons,crons}/:id/sharing`
 * write endpoints (docs/designs/resource-visibility.md §5.8).
 */
import type { UserRepo } from '../persistence/ports.js'

/**
 * Intersect a requested `sharedWith` set with the org's CURRENT members, de-duped
 * and order-preserving. Non-members (stale ids after a member left, foreign ids, a
 * picker race) are silently dropped so the stored set is always clean and can never
 * grant a non-member — the design leans on org-scope 404ing non-members for read
 * correctness, and this keeps the array itself tidy without relying solely on the
 * member-removal prune. An empty request clears the set.
 */
export async function resolveShareSet(users: UserRepo, orgId: string, requested: string[]): Promise<string[]> {
  if (requested.length === 0) return []
  const members = new Set((await users.listMembers(orgId)).map((m) => m.userId))
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of requested) {
    if (members.has(id) && !seen.has(id)) {
      seen.add(id)
      out.push(id)
    }
  }
  return out
}
