'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  fetchAgentDto,
  fetchAgentSkillSources,
  fetchSkillSourceSkills,
  type AgentSkillSourceDto,
  type SkillSourceSkillsDto
} from '@/lib/api'
import { useConsoleData } from '@/lib/data-context'
import { MOCK_MODE } from '@/lib/data'
import { SkillMark, SkillSourceLine, ToolTile, ToolTileGrid } from '@/components/console/ToolTile'
import { VisibilityValue } from '@/components/console/VisibilityField'
import { Icon, Toggle } from '@/components/ui'

/**
 * The agent's shared-skills enable-list (docs/designs/shared-skills.md). Lists the
 * org's visible skill sources; each can be enabled whole (`<source>/*`) or, when the
 * source's SKILL.md manifest is scannable, expanded to toggle individual skills
 * (`<source>/<skill>`). The agent stores the explicit ref list and the CP resolves
 * it into installable entries.
 *
 * The tiles are the org registry the caller can see, PLUS whatever this agent
 * already enables — `GET /agents/:id/skill-sources` resolves the agent's refs
 * regardless of the source's own sharing, so a source restricted away from the
 * caller still shows its name and repo rather than a bare, unexplained row. A ref
 * whose source is genuinely gone resolves to nothing and is not rendered: it
 * installs nothing (the CP resolver drops it) and there is nothing truthful to say
 * about it.
 */

const sourceOf = (ref: string) => (ref.includes('/') ? ref.slice(0, ref.indexOf('/')) : ref)
const skillOf = (ref: string) => (ref.includes('/') ? ref.slice(ref.indexOf('/') + 1) : '*')

/** The agent's current selection for one source: whole-source vs a specific set. */
function selectionFor(enabled: string[], name: string): { all: boolean; skills: Set<string> } {
  const mine = enabled.filter((r) => sourceOf(r) === name)
  const all = mine.some((r) => skillOf(r) === '*')
  return { all, skills: new Set(mine.map(skillOf).filter((s) => s !== '*')) }
}

export function AgentSkillsCard({ agentId, canEdit }: { agentId: string; canEdit: boolean }) {
  const { updateAgent, skillSources, skillSourcesLoading } = useConsoleData()
  const [enabled, setEnabled] = useState<string[] | null>(null) // saved refs; null ⇒ not loaded
  const [own, setOwn] = useState<AgentSkillSourceDto[] | null>(null) // sources this agent enables
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [manifests, setManifests] = useState<Record<string, SkillSourceSkillsDto | 'loading'>>({})
  const fetched = useRef(false)

  useEffect(() => {
    if (fetched.current) return
    // Demo agents (canEdit false) have no spec to fetch — mock mode seeds a selection
    // so both tile states (whole source vs a picked subset) are visible.
    if (!canEdit) {
      if (MOCK_MODE) setEnabled(['example-ai-kit/*', 'internal-runbooks/safe-deploy'])
      return
    }
    fetched.current = true
    fetchAgentDto(agentId).then(
      (dto) => setEnabled(dto.skills ?? []),
      (e) => setErr(e instanceof Error ? e.message : String(e))
    )
    // Resolving the agent's own refs is best-effort decoration: it only ADDS tiles
    // for sources missing from the registry list, so a failure degrades to the
    // registry view rather than blocking the toggles.
    fetchAgentSkillSources(agentId).then(
      (rows) => setOwn(rows),
      () => setOwn([])
    )
  }, [agentId, canEdit])

  const save = async (next: string[]) => {
    if (enabled === null || saving) return
    const prev = enabled
    setEnabled(next)
    setSaving(true)
    setErr(null)
    try {
      await updateAgent(agentId, { skills: next })
    } catch (e) {
      setEnabled(prev) // revert so the toggles never lie about what's saved
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const withoutSource = (name: string) => (enabled ?? []).filter((r) => sourceOf(r) !== name)

  // Enable/disable a whole source ("<source>/*").
  const toggleSource = (name: string, on: boolean) => {
    if (!canEdit || enabled === null) return
    void save(on ? [...withoutSource(name), `${name}/*`] : withoutSource(name))
  }

  // Toggle one skill; converts a whole-source selection to an explicit set first,
  // and collapses back to "<source>/*" when every discovered skill ends up selected.
  const toggleSkill = (name: string, skill: string, discovered: string[]) => {
    if (!canEdit || enabled === null) return
    const cur = selectionFor(enabled, name)
    const set = cur.all ? new Set(discovered) : new Set(cur.skills)
    if (set.has(skill)) set.delete(skill)
    else set.add(skill)
    const base = withoutSource(name)
    if (set.size === 0) return void save(base)
    if (discovered.length > 0 && discovered.every((s) => set.has(s))) return void save([...base, `${name}/*`])
    void save([...base, ...[...set].map((s) => `${name}/${s}`)])
  }

  const expand = (id: string) => {
    setExpanded((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    if (!manifests[id]) {
      setManifests((cur) => ({ ...cur, [id]: 'loading' }))
      fetchSkillSourceSkills(id).then(
        (m) => setManifests((cur) => ({ ...cur, [id]: m })),
        () => setManifests((cur) => ({ ...cur, [id]: { resolvable: false, skills: [] } }))
      )
    }
  }

  // Registry rows the caller can see, then the agent's own sources that sharing keeps
  // out of that list. The second group is `registry: false` — the CP still gates
  // ADDING a ref on seeing the source (`enablingUnseenSkillDenied`), so those tiles
  // are off-only and offer no per-skill picker; they exist to say what the agent
  // installs and to let it be turned off, like the MCP card's ineligible names.
  const tiles = useMemo(() => {
    const known = new Set(skillSources.map((s) => s.name))
    return [
      ...skillSources.map((s) => ({ ...s, registry: true })),
      ...(own ?? []).filter((s) => !known.has(s.name)).map((s) => ({ ...s, registry: false }))
    ]
  }, [skillSources, own])

  // Nothing is known yet while either list is in flight; rendering the empty state
  // then would claim the org has no sources when we simply haven't asked.
  const loading = skillSourcesLoading || (canEdit && own === null)

  const interactive = canEdit && enabled !== null && !saving

  return (
    <div className="card overflow-hidden max-desktop:rounded-lg desktop:max-w-[760px]">
      <div className="border-b border-(--border-subtle) px-4 py-3 font-sans text-[14px] font-semibold leading-normal desktop:py-[13px]">
        Skills
      </div>

      {tiles.length === 0 ? (
        <div className="flex items-center gap-2 px-4 py-[13px] font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary) desktop:py-3">
          {loading ? (
            'Loading skill sources…'
          ) : (
            <>
              <Icon name="book-open" size={14} />
              No skill sources in your organization yet.
            </>
          )}
        </div>
      ) : (
        <ToolTileGrid columns={2}>
          {tiles.map((s) => {
            const sel = enabled ? selectionFor(enabled, s.name) : { all: false, skills: new Set<string>() }
            const on = sel.all || sel.skills.size > 0
            const manifest = manifests[s.id]
            const isOpen = expanded.has(s.id)
            return (
              <ToolTile
                key={s.id}
                mark={<SkillMark />}
                name={s.name}
                // What's selected rides as a badge so the second line can stay the repo,
                // matching the registry card's tile.
                badge={
                  on ? (
                    <span className="badge flex-none bg-(--status-info-soft) text-[9.5px] text-(--status-info)">
                      {sel.all ? 'all skills' : `${sel.skills.size} selected`}
                    </span>
                  ) : undefined
                }
                subtitle={<SkillSourceLine source={s.source} subDir={s.subDir} />}
                // Who the source belongs to, worded exactly as its registry tile words it.
                // Only the registry rows carry a share set — the agent-scoped resolution
                // deliberately omits it (seeing an agent isn't seeing the source).
                footer={
                  s.registry ? (
                    <VisibilityValue visibility={s.visibility} sharedWith={s.sharedWith} createdBy={s.createdBy} />
                  ) : undefined
                }
                action={
                  <>
                    {/* Expanding is a secondary move, so the chevron only surfaces on
                        hover/keyboard focus (and stays put once open). Its box is always
                        reserved, so revealing it never shifts the toggle. Touch has no
                        hover, so below the desktop breakpoint it stays visible. */}
                    {s.registry && (
                      <button
                        type="button"
                        className={`iconbtn h-6 w-6 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 max-desktop:opacity-100 ${isOpen ? 'opacity-100' : 'opacity-0'}`}
                        onClick={() => expand(s.id)}
                        aria-label="Show skills"
                        aria-expanded={isOpen}
                        title="Show skills"
                      >
                        <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={13} />
                      </button>
                    )}
                    {/* No picker for an agent-scoped source, but keep its slot so the
                        toggles line up with the registry tiles beside it. */}
                    {!s.registry && <span className="block h-6 w-6" />}
                    <span className="ml-[6px]">
                      <Toggle
                        checked={on}
                        // Off-only for a non-registry source: the CP would reject
                        // re-adding a ref to a source this caller can't see.
                        disabled={!interactive || (!s.registry && !on)}
                        onChange={(next) => toggleSource(s.name, next)}
                      />
                    </span>
                  </>
                }
              >
                {isOpen && s.registry && (
                  <div className="border-t border-(--border-subtle) bg-(--surface-sunken) px-[14px] py-2">
                    {manifest === 'loading' || manifest === undefined ? (
                      <div className="py-1 font-sans text-[12px] text-(--text-tertiary)">Loading skills…</div>
                    ) : !manifest.resolvable || manifest.skills.length === 0 ? (
                      <div className="py-1 font-sans text-[12px] leading-[1.5] text-(--text-tertiary)">
                        {manifest.resolvable
                          ? 'No SKILL.md found in this source.'
                          : 'Can’t list individual skills for this source — enable the whole source above.'}
                      </div>
                    ) : (
                      manifest.skills.map((sk) => {
                        const checked = sel.all || sel.skills.has(sk.name)
                        return (
                          <div key={sk.name} className="flex items-center gap-[11px] py-[7px]">
                            <div className="min-w-0 flex-1">
                              <div className="truncate font-mono text-[12px] font-medium leading-normal text-(--text-primary)">
                                {sk.name}
                              </div>
                              <div className="truncate font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
                                {sk.dirPath}
                              </div>
                            </div>
                            <Toggle
                              checked={checked}
                              disabled={!interactive}
                              onChange={() =>
                                toggleSkill(
                                  s.name,
                                  sk.name,
                                  manifest.skills.map((x) => x.name)
                                )
                              }
                            />
                          </div>
                        )
                      })
                    )}
                  </div>
                )}
              </ToolTile>
            )
          })}
        </ToolTileGrid>
      )}

      {err && (
        <div className="border-t border-(--border-subtle) px-4 py-[11px] font-sans text-[12px] font-normal leading-normal text-(--red-600)">
          {err}
        </div>
      )}
    </div>
  )
}
