import { randomBytes } from 'node:crypto'
import { adjectives, animals, uniqueNamesGenerator } from 'unique-names-generator'

/** Namespace every session branch is created under (AgentConnect as a numeronym): Git refuses `x/…` wherever a branch `x` exists, locally or on the remote, so it must be a name no project gives a branch. */
export const SESSION_BRANCH_PREFIX = 'a10t'

/** The namespace session branches were drawn in before `a10t` — one any repository with a `dev` branch refuses — still recognized so retention can delete them. */
const LEGACY_SESSION_BRANCH_PREFIX = 'dev'

/** Used when the initiator has no usable label at all — a cron/agent-triggered
 * session, or a display name that sanitizes away to nothing. */
const ANONYMOUS_USER = 'agent'

const MAX_USER_SEGMENT = 24

// A sign-in address is what webchat carries when the user set no display name, and its
// domain names nobody: only the local part reaches the branch.
const EMAIL_RE = /^([^\s@]+)@[^\s@]+\.[^\s@]+$/

/** One Git ref path component from an arbitrary platform display name. Unicode
 * letters and digits survive (a Feishu display name is routinely CJK, and a
 * branch named `agent` for every one of them defeats the point); everything
 * else — the space, dot, `~^:?*[\` and control characters Git rejects — becomes
 * a separator. */
function userSegment(raw: string | undefined): string {
  const label = (raw ?? '').trim()
  const slug = (EMAIL_RE.exec(label)?.[1] ?? label)
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, MAX_USER_SEGMENT)
    .replace(/-$/, '')
  return slug || ANONYMOUS_USER
}

/** The branch one session checks out, `a10t/<user>/<adjective>-<animal>`: words a reviewer can read, drawn fresh per call so a taken name is simply asked for again; `unique` adds random bytes to end that search. */
export function sessionBranchName(user: string | undefined, unique = false): string {
  const words = uniqueNamesGenerator({ dictionaries: [adjectives, animals], separator: '-', length: 2 })
  // The escape hatch for a repository that keeps colliding: random bytes end the search.
  const suffix = unique ? `-${randomBytes(3).toString('hex')}` : ''
  return `${SESSION_BRANCH_PREFIX}/${userSegment(user)}/${words}${suffix}`
}

/** Every ref that would stop Git creating `branch`: the branch itself and each parent path, since `a10t/u` cannot exist beside `a10t`. */
export function blockingBranchRefs(branch: string): string[] {
  const parts = branch.split('/')
  return parts.map((_, i) => `refs/heads/${parts.slice(0, i + 1).join('/')}`)
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
const NAMESPACES = new Set([SESSION_BRANCH_PREFIX, LEGACY_SESSION_BRANCH_PREFIX])

/** Whether this daemon generated the branch for a session, so it may be deleted with it — the namespace alone is not enough (humans use `dev/<user>/<topic>` too), so the last component must be a word pair plus at most the collision suffix. */
export function isSessionBranch(branch: string | undefined): boolean {
  const [namespace, user, generated, ...rest] = (branch ?? '').split('/')
  if (!NAMESPACES.has(namespace ?? '') || !user || !generated || rest.length > 0) return false
  const [adjective, animal, suffix, ...extra] = generated.split('-')
  if (extra.length > 0 || (suffix !== undefined && !/^[0-9a-f]{6}$/.test(suffix))) return false
  return WORDS.adjective.has(adjective ?? '') && WORDS.animal.has(animal ?? '')
}
