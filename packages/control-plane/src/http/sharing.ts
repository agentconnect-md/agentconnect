// Audience normalization for every Selected-sharing write (docs/designs/resource-visibility.md §5.8).
import type { UserRepo } from '../persistence/ports.js'

// Keep only current members, people and service accounts; each repository re-checks under membership locks.
export async function resolveShareSet(users: UserRepo, orgId: string, requested: string[]): Promise<string[]> {
  if (requested.length === 0) return []
  const [people, accounts] = await Promise.all([users.listMembers(orgId), users.listServiceAccounts(orgId)])
  return intersect(requested, [...people, ...accounts])
}

// People only, for a list of who approves, which a service account never does.
export async function resolvePeopleSet(users: UserRepo, orgId: string, requested: string[]): Promise<string[]> {
  if (requested.length === 0) return []
  return intersect(requested, await users.listMembers(orgId))
}

function intersect(requested: string[], pool: ReadonlyArray<{ userId: string }>): string[] {
  const members = new Set(pool.map((m) => m.userId))
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
