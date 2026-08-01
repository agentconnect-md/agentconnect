/**
 * skills.sh registry search — the discovery half of the Skills library's
 * "Install from skills.sh" path (docs/designs/shared-skills.md §7).
 *
 * `npx skills` (the CLI the daemon installs sources with) is backed by the public
 * skills.sh index, and its own `skills find` reads `GET /api/search`. The CP
 * proxies that one read because skills.sh serves no CORS headers — the console
 * cannot call it from the browser — and because a registry hit has to be
 * normalized into THIS product's source shape (`owner/repo` + a one-skill filter)
 * before it can become a create body.
 *
 * Nothing is persisted and no credential is involved: the index is public, and a
 * hit is only a pair of strings the user may then register as a source.
 *
 * The response is UNTRUSTED input that ends up as `npx skills add <source> -s
 * <name>` arguments on a daemon, so every row is validated here against the same
 * grammars `CreateSkillSourceBody` enforces (dto SkillSourceArg / SkillFilterName).
 * A row that doesn't fit is dropped rather than offered as an un-installable
 * choice.
 */

/** One installable registry hit, already shaped for a skill-source create. */
export interface RegistrySkill {
  /** Registry slug (`<owner>/<repo>/<skill>`) — the https://skills.sh/<id> page. */
  id: string
  /** Skill directory name; becomes the source's `skills` filter entry (`-s`). */
  name: string
  /** `owner/repo` — becomes the source string handed to `npx skills add`. */
  source: string
  /** Install count for ranking, when the index reports one. */
  installs: number | null
}

/** `unreachable` covers every failure mode (offline, timeout, non-200, bad JSON):
 *  discovery is optional, so the route degrades to "no results, index down"
 *  instead of failing the request. */
export type SkillRegistrySearch = { status: 'ok'; skills: RegistrySkill[] } | { status: 'unreachable' }

export type SkillRegistrySearcher = (
  query: string,
  opts?: { owner?: string; limit?: number }
) => Promise<SkillRegistrySearch>

const REGISTRY_BASE = 'https://skills.sh'
const REGISTRY_TIMEOUT_MS = 6000
const DEFAULT_LIMIT = 10
// `owner/repo`, the only source form the index yields — and a valid positional for
// `npx skills add` (no leading "-", no query/fragment, no userinfo).
//
// The owner half uses GitHub's own grammar (alphanumerics + hyphen) rather than a
// loose segment match, because `npx skills add` ALSO accepts a local path: a
// registry row claiming `../repo` or `./repo` would otherwise persist as a source
// that resolves against the agent's workspace instead of fetching a repository.
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const REPO = /^[A-Za-z0-9._-]{1,100}$/
function isOwnerRepo(source: string): boolean {
  const [owner, repo, ...rest] = source.split('/')
  if (rest.length > 0 || !owner || !repo) return false
  if (repo === '.' || repo === '..') return false
  return OWNER.test(owner) && REPO.test(repo)
}
// Mirrors dto SkillFilterName: a `-s` VALUE, so it may not start with "-".
const SKILL_NAME = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/
// Mirrors the slug shape the registry links by; display + link only, never a CLI arg.
const SLUG = /^[A-Za-z0-9._/-]+$/
const MAX_FIELD = 200

function field(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  return s.length > 0 && s.length <= MAX_FIELD ? s : null
}

function normalize(raw: unknown): RegistrySkill | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as { id?: unknown; skillId?: unknown; name?: unknown; source?: unknown; installs?: unknown }
  // Installing needs BOTH halves: the repo to fetch and the skill dir to select.
  // `skillId` is the directory name; `name` is its display form and usually equal.
  const source = field(r.source)
  const name = field(r.skillId) ?? field(r.name)
  if (!source || !name || !isOwnerRepo(source) || !SKILL_NAME.test(name)) return null
  const id = field(r.id)
  return {
    id: id && SLUG.test(id) ? id : `${source}/${name}`,
    name,
    source,
    installs: typeof r.installs === 'number' && Number.isFinite(r.installs) ? Math.max(0, Math.trunc(r.installs)) : null
  }
}

/** Parse a registry search payload into installable hits: invalid rows dropped,
 *  duplicates collapsed, most-installed first. Exported for unit tests. */
export function parseRegistrySearch(body: unknown): RegistrySkill[] {
  const rows = typeof body === 'object' && body !== null ? (body as { skills?: unknown }).skills : undefined
  if (!Array.isArray(rows)) return []
  const seen = new Set<string>()
  const out: RegistrySkill[] = []
  for (const row of rows) {
    const hit = normalize(row)
    if (!hit) continue
    const key = `${hit.source.toLowerCase()}\n${hit.name.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(hit)
  }
  return out.sort((a, b) => (b.installs ?? 0) - (a.installs ?? 0))
}

export const searchSkillRegistry: SkillRegistrySearcher = async (query, opts = {}) => {
  const params = new URLSearchParams({ q: query, limit: String(opts.limit ?? DEFAULT_LIMIT) })
  if (opts.owner) params.set('owner', opts.owner)
  try {
    const res = await fetch(`${REGISTRY_BASE}/api/search?${params.toString()}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS)
    })
    if (!res.ok) return { status: 'unreachable' }
    return { status: 'ok', skills: parseRegistrySearch(await res.json()) }
  } catch {
    return { status: 'unreachable' }
  }
}
