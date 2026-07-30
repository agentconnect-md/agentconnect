/**
 * `http/sharing.ts` — shared helper for the `/{agents,daemons,crons}/:id/sharing`
 * write endpoints (docs/designs/resource-visibility.md §5.8).
 */
import type { UserRepo } from '../persistence/ports.js'

/**
 * Intersect a requested `sharedWith` set with the org's CURRENT members, de-duped
 * and order-preserving. Non-members (stale ids after a member left, foreign ids, a
 * picker race) are silently dropped. This is the early HTTP normalization; each
 * resource repository repeats the intersection while holding membership row locks
 * in the write transaction, so a member cannot leave between this read and commit.
 * The design also leans on org-scope 404ing non-members for read correctness. An
 * empty request clears the set.
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
