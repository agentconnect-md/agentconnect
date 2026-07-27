/**
 * Skill-source resolution (docs/designs/shared-skills.md §4).
 *
 * The agent's enable-list is a flat string[] of "<sourceName>/<skillName>" or
 * "<sourceName>/*". This turns it into the self-contained {@link AgentSkillEntry}
 * array the daemon installs — one entry per referenced source, carrying the
 * source string + optional ref/subDir and the union of enabled skill names (empty
 * ⇒ install every skill the source exposes). Unknown source names are skipped:
 * the registry is the authority, so an enable-list entry pointing at a deleted
 * source simply drops out rather than failing the whole spec.
 */
import type { AgentSkillEntry } from '@agentconnect.md/protocol'
import type { AgentRecord, SkillSourceRepo } from '../persistence/ports.js'

/** Split "<source>/<skill>" (or "<source>/*"); a bare "<source>" ⇒ all skills. */
export function parseSkillRef(ref: string): { source: string; skill: string | null } {
  const slash = ref.indexOf('/')
  if (slash < 0) return { source: ref, skill: null }
  const source = ref.slice(0, slash)
  const skill = ref.slice(slash + 1)
  return { source, skill: skill === '' || skill === '*' ? null : skill }
}

/**
 * Resolve an agent's `skills` enable-list into installable entries. Groups by
 * source name; a "<source>/*" (or bare source) entry marks the whole source, which
 * wins over any specific "<source>/<skill>" siblings (install everything). Order is
 * deterministic (registry `listForOrg` order intersected with first-seen).
 */
export async function resolveAgentSkillEntries(
  agent: Pick<AgentRecord, 'orgId' | 'skills'>,
  repo?: SkillSourceRepo
): Promise<AgentSkillEntry[]> {
  if (!repo || agent.skills.length === 0) return []

  // Per source name: the set of specific skills, and whether "all" was requested.
  const bySource = new Map<string, { all: boolean; skills: Set<string> }>()
  const order: string[] = []
  for (const raw of agent.skills) {
    const { source, skill } = parseSkillRef(raw)
    let bucket = bySource.get(source)
    if (!bucket) {
      bucket = { all: false, skills: new Set() }
      bySource.set(source, bucket)
      order.push(source)
    }
    if (skill === null) bucket.all = true
    else bucket.skills.add(skill)
  }

  const entries: AgentSkillEntry[] = []
  for (const name of order) {
    const bucket = bySource.get(name)!
    const row = await repo.getByName(agent.orgId, name)
    if (!row) continue // enable-list references a source that no longer exists → drop

    // `skills: []` in an entry means "install every skill the source exposes", so it
    // must never be produced from a NARROWER intent (that would broaden the filter).
    let skills: string[]
    if (bucket.all) {
      // Whole-source request: honor the source's OWN filter. `[]` here is faithful —
      // it means the source itself scopes to all skills.
      skills = [...row.skills]
    } else {
      // Specific picks: intersect with the source's own filter (when it scopes a
      // subset). An empty intersection means the agent enabled only skills the source
      // no longer offers — OMIT the source entirely rather than falling back to all.
      skills = scopeSkills([...bucket.skills], row.skills)
      if (skills.length === 0) continue
    }

    entries.push({
      name: row.name,
      source: row.source,
      ...(row.ref ? { ref: row.ref } : {}),
      ...(row.subDir ? { subDir: row.subDir } : {}),
      skills
    })
  }
  return entries
}

/**
 * Strip URL userinfo from a source string for display outside the source's own
 * visibility (`GET /agents/:id/skill-sources`).
 *
 * `SkillSourceArg` now rejects credential-bearing sources on write, but rows
 * stored before that guard can still hold `https://<token>@host/repo` — and a
 * token is just as often the USERNAME as the password, so the whole userinfo
 * segment goes. Applies only to scheme URLs: the scp-like `git@github.com:o/r`
 * form has no userinfo to strip and must survive intact.
 */
export function redactSourceCredentials(source: string): string {
  return source.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/@]*@/, '$1')
}

/** If the source itself restricts to a subset (`row.skills`), keep only picks
 *  inside it; otherwise pass the picks through unchanged. */
function scopeSkills(picks: string[], sourceFilter: string[]): string[] {
  if (sourceFilter.length === 0) return picks
  const allowed = new Set(sourceFilter)
  return picks.filter((s) => allowed.has(s))
}
