import { randomBytes } from 'node:crypto'
import { adjectives, animals, uniqueNamesGenerator } from 'unique-names-generator'

/** Namespace every session-worktree branch is created under; see {@link isSessionBranch}. */
export const SESSION_BRANCH_PREFIX = 'dev'

/** Used when the initiator has no usable label at all — a cron/agent-triggered
 * session, or a display name that sanitizes away to nothing. */
const ANONYMOUS_USER = 'agent'

const MAX_USER_SEGMENT = 24

/** One Git ref path component from an arbitrary platform display name. Unicode
 * letters and digits survive (a Feishu display name is routinely CJK, and a
 * branch named `agent` for every one of them defeats the point); everything
 * else — the space, dot, `~^:?*[\` and control characters Git rejects — becomes
 * a separator. */
function userSegment(raw: string | undefined): string {
  const slug = (raw ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, MAX_USER_SEGMENT)
    .replace(/-$/, '')
  return slug || ANONYMOUS_USER
}

/** The branch one session worktree checks out: `dev/<user>/<adjective>-<animal>`.
 * Two words rather than a hash because this name reaches humans — it is what a
 * reviewer reads on a pushed branch and what the agent types in `git` commands.
 * The pair is drawn fresh per call, so a caller that finds the name taken simply
 * asks again; `unique` ends the search, but 1202x355 combinations only make a collision
 * unlikely, never impossible. */
export function sessionBranchName(user: string | undefined, unique = false): string {
  const words = uniqueNamesGenerator({ dictionaries: [adjectives, animals], separator: '-', length: 2 })
  // The escape hatch for a repository that keeps colliding: random bytes end the search.
  const suffix = unique ? `-${randomBytes(3).toString('hex')}` : ''
  return `${SESSION_BRANCH_PREFIX}/${userSegment(user)}/${words}${suffix}`
}

/** The label {@link sessionBranchName} takes, from the session's initiator id and
 * this turn's sender. The initiator's cached display name wins: it is the person
 * who OPENED the session, so a thread does not change branch owner when someone
 * else speaks. Without one, this turn's sender stands in — the id alone may be a
 * routing identity rather than a person (a hook session is triggered by
 * `hook:<hookId>`, which would put the hook's UUID in the branch name). */
export function initiatorLabel(
  initiator: string,
  displayName: string | undefined,
  sender: { id?: string; name?: string } | undefined
): string {
  if (displayName) return displayName
  if (initiator === sender?.id) return sender.name ?? initiator
  return sender?.name ?? sender?.id ?? initiator
}

const WORDS = { adjective: new Set(adjectives), animal: new Set(animals) }

/** Whether this branch is one this daemon generated for a session worktree, and so may be
 * deleted with it. The namespace alone is NOT enough of a guard — `dev/<user>/<topic>` is a
 * convention humans use too, and an agent can leave a worktree checked out on a branch of
 * theirs — so the last component must be a pair this generator could have drawn: a word from
 * each dictionary, plus at most the collision suffix. `dev/yulong/gurnard` is then not ours. */
export function isSessionBranch(branch: string | undefined): boolean {
  const [namespace, user, generated, ...rest] = (branch ?? '').split('/')
  if (namespace !== SESSION_BRANCH_PREFIX || !user || !generated || rest.length > 0) return false
  const [adjective, animal, suffix, ...extra] = generated.split('-')
  if (extra.length > 0 || (suffix !== undefined && !/^[0-9a-f]{6}$/.test(suffix))) return false
  return WORDS.adjective.has(adjective ?? '') && WORDS.animal.has(animal ?? '')
}
